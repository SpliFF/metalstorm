// Browser lifecycle for the MCP (open_client / close_client / list_clients,
// and the openBrowser option on launch_scenario).
//
// WHY THIS EXISTS. Every browser-bound tool in this server — client_eval,
// client_screenshot, browser_test, evaluate_widget_lua — needs a CONNECTED
// admin client, and until now nothing here could produce one. The documented
// loop said "navigate a browser to browserUrl", which in practice meant a human
// with a mouse, or chrome-devtools MCP (a whole second browser stack, spawned
// for its CDP session when all we want is a page that connects). So the sim sat
// at frame -1 and the relay answered "no connected admin client".
//
// Three facts, each learned by getting it wrong first:
//
//   1. KILLING CHROME NEEDS THE PROCESS GROUP. Chrome forks a tree (zygote,
//      gpu, renderers, utility). `kill <pid>` on the parent leaves the rest
//      alive — measured twice: a 7-pid tree still had 10 processes after the
//      parent died, and an abandoned renderer holds the GPU (an earlier session
//      lost five perf runs to exactly this). So we spawn `detached: true`,
//      which makes the child a process-group leader, and signal `-pgid` to take
//      the whole tree down.
//
//   2. EVERY LAUNCH NEEDS ITS OWN PROFILE. Chrome single-instances on
//      --user-data-dir: point a second launch at a live profile and it hands
//      the URL to the RUNNING browser and exits 0. The caller sees a dead pid
//      and no new client, and the room it wanted is never joined. Unique dir
//      per launch, removed on close.
//
//   3. BACKGROUND THROTTLING IS NOT HYPOTHETICAL HERE. A backgrounded or
//      headless page gets its timers clamped and its rAF starved, which shows
//      up as a stalled `frameId` and a sim that will not tick. The three
//      --disable-*backgrounding* flags below are load-bearing, not cargo cult.
//
// Headless is the default: it renders this Babylon client identically (verified
// — 178 meshes, textured terrain, working screenshots) and opens no window on
// the user's machine, which matters when the session is driven remotely.

import { spawn } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/** Where we look for a Chromium-family binary, in order. */
export const CHROME_CANDIDATES = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
];

/**
 * Resolve the browser binary. `SPRING_BROWSER` (or `CHROME_PATH`) wins so a
 * machine with a non-standard install is one env var away, and an env var that
 * points at nothing is an ERROR rather than a silent fall-through to some other
 * browser — a wrong-browser run is far harder to diagnose than a missing one.
 *
 * @returns {{path:string}|{error:string}}
 */
export function resolveBrowserPath(env = {}, exists = existsSync, candidates = CHROME_CANDIDATES) {
    const override = env.SPRING_BROWSER || env.CHROME_PATH;
    if (override) {
        return exists(override)
            ? { path: override }
            : { error: `SPRING_BROWSER/CHROME_PATH points at "${override}", which does not exist` };
    }
    for (const c of candidates) if (exists(c)) return { path: c };
    return {
        error: 'no Chromium-family browser found. Looked in: '
            + candidates.join(', ')
            + '. Set SPRING_BROWSER to the binary you want.',
    };
}

/**
 * The command line. Pure, so the flag policy is testable without spawning.
 */
export function browserFlags({ url, profileDir, headless = true, width = 1280, height = 800 }) {
    const flags = [
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        // No "restore pages?" bubble after we SIGKILL a tree, and no crash
        // reporter racing us on the way down.
        '--disable-session-crashed-bubble',
        '--disable-features=Translate,InfobarScreenshot',
        '--disable-breakpad',
        // (3) above: keep rAF and timers running when the page is not frontmost.
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        `--window-size=${width},${height}`,
    ];
    if (headless) {
        // The old headless was a separate binary with no GPU path; --headless=new
        // is the real browser with no window, which is why WebGL/WebGPU render.
        flags.push('--headless=new');
        flags.push('--use-angle=metal');
        flags.push('--enable-unsafe-webgpu');
    }
    flags.push(url);
    return flags;
}

/** A per-launch profile dir. Collisions would trip fact (2). */
let profileSeq = 0;
export function newProfileDir(base = tmpdir(), pid = process.pid) {
    profileSeq += 1;
    return join(base, `spring-mcp-browser-${pid}-${profileSeq}`);
}

/**
 * In-process registry of browsers WE launched.
 *
 * Deliberately not persisted: a pid outlives this process only as a stale
 * number that could be recycled onto something else, and close_client must
 * never signal a pid it did not create.
 */
export class BrowserRegistry {
    constructor() { this.byPid = new Map(); }

    add(entry) { this.byPid.set(entry.pid, entry); return entry; }
    get(pid) { return this.byPid.get(pid) ?? null; }
    remove(pid) { const e = this.byPid.get(pid); this.byPid.delete(pid); return e ?? null; }

    /** Live entries, newest first. `alive` is re-probed, never cached. */
    list(isAlive = defaultIsAlive) {
        return [...this.byPid.values()]
            .map(e => ({ ...e, alive: isAlive(e.pid) }))
            .sort((a, b) => b.pid - a.pid);
    }

    forRoom(roomId) {
        return [...this.byPid.values()].filter(e => e.roomId === roomId);
    }
}

export function defaultIsAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (err) { return err.code === 'EPERM'; }  // EPERM = alive, just not ours
}

/**
 * Launch a browser at `url`. Returns the registry entry (not yet registered).
 * `deps` is injectable for tests.
 */
export function launchBrowser(opts, deps = {}) {
    const {
        url, roomId = null, headless = true, width = 1280, height = 800,
        env = process.env,
    } = opts;
    const spawnFn = deps.spawn ?? spawn;
    const resolved = deps.resolveBrowserPath
        ? deps.resolveBrowserPath(env)
        : resolveBrowserPath(env);
    if (resolved.error) return { error: resolved.error };

    const profileDir = deps.newProfileDir ? deps.newProfileDir() : newProfileDir();
    const flags = browserFlags({ url, profileDir, headless, width, height });

    let child;
    try {
        child = spawnFn(resolved.path, flags, {
            // (1) above: own process group, so we can signal the whole tree.
            detached: true,
            stdio: 'ignore',
        });
    } catch (err) {
        return { error: `failed to spawn ${resolved.path}: ${err.message}` };
    }
    if (!child || !child.pid) return { error: `spawn returned no pid for ${resolved.path}` };

    // Do not hold the MCP's event loop open on the browser.
    if (typeof child.unref === 'function') child.unref();

    return {
        entry: {
            pid: child.pid,
            roomId,
            url,
            headless,
            profileDir,
            browserPath: resolved.path,
            startedAt: new Date().toISOString(),
        },
    };
}

/**
 * Take a browser down: SIGTERM the process GROUP, poll, then SIGKILL it.
 *
 * Signals go to `-pid` (the group). A bare pid here is the bug described in
 * fact (1) and it leaves GPU-holding renderers behind.
 */
export async function closeBrowser(entry, {
    timeoutMs = 5000, pollMs = 100,
    kill = process.kill.bind(process),
    isAlive = defaultIsAlive,
    sleep = ms => new Promise(r => setTimeout(r, ms)),
    now = () => Date.now(),
    rm = p => rmSync(p, { recursive: true, force: true }),
} = {}) {
    const pid = entry.pid;
    if (!isAlive(pid)) {
        cleanProfile(entry, rm);
        return { pid, outcome: 'already_exited', escalated: false, waitedMs: 0 };
    }

    const started = now();
    let escalated = false;
    try { kill(-pid, 'SIGTERM'); }
    catch (err) {
        // ESRCH between the isAlive probe and here is a race, not a failure.
        if (err.code !== 'ESRCH') {
            try { kill(pid, 'SIGTERM'); } catch { /* fall through to escalation */ }
        }
    }

    while (now() - started < timeoutMs) {
        if (!isAlive(pid)) {
            cleanProfile(entry, rm);
            return { pid, outcome: 'exited', escalated, waitedMs: now() - started };
        }
        await sleep(pollMs);
    }

    escalated = true;
    try { kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    // SIGKILL is not instant; give the group a moment to be reaped.
    for (let i = 0; i < 10 && isAlive(pid); i++) await sleep(pollMs);

    const stillAlive = isAlive(pid);
    cleanProfile(entry, rm);
    return {
        pid,
        outcome: stillAlive ? 'kill_failed' : 'killed_after_timeout',
        escalated,
        waitedMs: now() - started,
    };
}

/** Profile dirs are per-launch scratch; leaving them behind fills /tmp. */
function cleanProfile(entry, rm) {
    if (!entry?.profileDir) return;
    if (!/spring-mcp-browser-/.test(entry.profileDir)) return;  // never rm someone else's dir
    try { rm(entry.profileDir); } catch { /* best effort */ }
}

/**
 * Human-readable one-liner for a close result — the same "read the report, not
 * just the boolean" discipline end_game uses.
 */
export function describeClose(r) {
    switch (r.outcome) {
        case 'already_exited': return `browser ${r.pid} was already gone`;
        case 'exited': return `browser ${r.pid} exited on SIGTERM after ${r.waitedMs} ms`;
        case 'killed_after_timeout':
            return `browser ${r.pid} ignored SIGTERM and was SIGKILLed after ${r.waitedMs} ms`;
        case 'kill_failed':
            return `browser ${r.pid} survived SIGKILL — inspect it by hand (ps -p ${r.pid})`;
        default: return `browser ${r.pid}: ${r.outcome}`;
    }
}
