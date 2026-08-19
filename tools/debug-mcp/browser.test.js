import test from 'node:test';
import assert from 'node:assert/strict';
import {
    resolveBrowserPath, browserFlags, BrowserRegistry, launchBrowser,
    closeBrowser, describeClose, CHROME_CANDIDATES,
} from './browser.js';

// --- resolveBrowserPath ---------------------------------------------------

test('resolveBrowserPath: env override wins over the candidate list', () => {
    const r = resolveBrowserPath({ SPRING_BROWSER: '/opt/my-chrome' }, p => true);
    assert.deepEqual(r, { path: '/opt/my-chrome' });
});

test('resolveBrowserPath: a bad override is an ERROR, never a fall-through', () => {
    // Falling back here would silently drive a different browser than the one
    // the user named — the hardest kind of wrong to diagnose.
    const r = resolveBrowserPath({ CHROME_PATH: '/nope' }, p => p !== '/nope');
    assert.match(r.error, /\/nope.*does not exist/);
    assert.equal(r.path, undefined);
});

test('resolveBrowserPath: falls back through the candidates in order', () => {
    const r = resolveBrowserPath({}, p => p === CHROME_CANDIDATES[1]);
    assert.equal(r.path, CHROME_CANDIDATES[1]);
});

test('resolveBrowserPath: nothing installed names what it looked for', () => {
    const r = resolveBrowserPath({}, () => false);
    assert.match(r.error, /no Chromium-family browser found/);
    assert.match(r.error, /SPRING_BROWSER/);
});

// --- browserFlags ---------------------------------------------------------

test('browserFlags: headless carries the GPU-capable new-headless flags', () => {
    const f = browserFlags({ url: 'http://x/', profileDir: '/tmp/p', headless: true });
    assert.ok(f.includes('--headless=new'));
    assert.ok(f.includes('--enable-unsafe-webgpu'));
    assert.equal(f.at(-1), 'http://x/', 'url must be last');
});

test('browserFlags: headed omits every headless flag', () => {
    const f = browserFlags({ url: 'http://x/', profileDir: '/tmp/p', headless: false });
    assert.ok(!f.some(x => x.startsWith('--headless')));
    assert.ok(!f.includes('--use-angle=metal'));
});

test('browserFlags: throttling defences are present in BOTH modes', () => {
    // A throttled page stalls rAF, which reads as "the sim will not tick".
    for (const headless of [true, false]) {
        const f = browserFlags({ url: 'http://x/', profileDir: '/tmp/p', headless });
        assert.ok(f.includes('--disable-background-timer-throttling'), `headless=${headless}`);
        assert.ok(f.includes('--disable-renderer-backgrounding'), `headless=${headless}`);
        assert.ok(f.includes('--disable-backgrounding-occluded-windows'), `headless=${headless}`);
    }
});

test('browserFlags: the profile dir is always passed', () => {
    const f = browserFlags({ url: 'http://x/', profileDir: '/tmp/unique-1' });
    assert.ok(f.includes('--user-data-dir=/tmp/unique-1'));
});

// --- launchBrowser --------------------------------------------------------

function fakeSpawn(pid = 4242) {
    const calls = [];
    const fn = (path, args, opts) => { calls.push({ path, args, opts }); return { pid, unref() {} }; };
    return { fn, calls };
}

test('launchBrowser: spawns detached so the whole tree can be signalled', () => {
    const { fn, calls } = fakeSpawn();
    const r = launchBrowser({ url: 'http://x/', roomId: 7 }, {
        spawn: fn,
        resolveBrowserPath: () => ({ path: '/bin/chrome' }),
        newProfileDir: () => '/tmp/spring-mcp-browser-1-1',
    });
    assert.equal(r.error, undefined);
    assert.equal(calls[0].opts.detached, true, 'detached:true makes the child a group leader');
    assert.equal(calls[0].opts.stdio, 'ignore');
    assert.equal(r.entry.pid, 4242);
    assert.equal(r.entry.roomId, 7);
    assert.equal(r.entry.headless, true, 'headless is the default');
});

test('launchBrowser: a unresolvable browser errors instead of spawning', () => {
    const { fn, calls } = fakeSpawn();
    const r = launchBrowser({ url: 'http://x/' }, {
        spawn: fn,
        resolveBrowserPath: () => ({ error: 'nope' }),
    });
    assert.equal(r.error, 'nope');
    assert.equal(calls.length, 0);
});

test('launchBrowser: a spawn that yields no pid is an error, not a fake success', () => {
    const r = launchBrowser({ url: 'http://x/' }, {
        spawn: () => ({}),
        resolveBrowserPath: () => ({ path: '/bin/chrome' }),
        newProfileDir: () => '/tmp/spring-mcp-browser-1-2',
    });
    assert.match(r.error, /no pid/);
});

// --- registry -------------------------------------------------------------

test('BrowserRegistry: forRoom selects only that room, list re-probes liveness', () => {
    const reg = new BrowserRegistry();
    reg.add({ pid: 1, roomId: 10 });
    reg.add({ pid: 2, roomId: 11 });
    reg.add({ pid: 3, roomId: 10 });
    assert.deepEqual(reg.forRoom(10).map(e => e.pid), [1, 3]);

    const listed = reg.list(pid => pid !== 2);
    assert.deepEqual(listed.map(e => e.pid), [3, 2, 1], 'newest pid first');
    assert.equal(listed.find(e => e.pid === 2).alive, false);
});

test('BrowserRegistry: remove returns the entry and forgets it', () => {
    const reg = new BrowserRegistry();
    reg.add({ pid: 9, roomId: 1 });
    assert.equal(reg.remove(9).pid, 9);
    assert.equal(reg.get(9), null);
    assert.equal(reg.remove(9), null);
});

// --- closeBrowser ---------------------------------------------------------

function closeHarness({ diesAfterMs = 0, ignoresTerm = false, survivesKill = false }) {
    const signals = [];
    let clock = 0;
    let dead = false;
    return {
        signals,
        opts: {
            timeoutMs: 1000, pollMs: 100,
            kill: (pid, sig) => {
                signals.push([pid, sig]);
                if (sig === 'SIGTERM' && !ignoresTerm) dead = true;
                if (sig === 'SIGKILL' && !survivesKill) dead = true;
            },
            isAlive: () => !dead && clock >= diesAfterMs ? true : !dead,
            sleep: async ms => { clock += ms; },
            now: () => clock,
            rm: () => {},
        },
    };
}

test('closeBrowser: signals the process GROUP, not the bare pid', async () => {
    const h = closeHarness({});
    const r = await closeBrowser({ pid: 555, profileDir: '/tmp/spring-mcp-browser-x' }, h.opts);
    assert.deepEqual(h.signals[0], [-555, 'SIGTERM'], 'negative pid = whole group');
    assert.equal(r.outcome, 'exited');
    assert.equal(r.escalated, false);
});

test('closeBrowser: escalates to SIGKILL when SIGTERM is ignored', async () => {
    const h = closeHarness({ ignoresTerm: true });
    const r = await closeBrowser({ pid: 777, profileDir: '/tmp/spring-mcp-browser-y' }, h.opts);
    assert.deepEqual(h.signals.at(-1), [-777, 'SIGKILL']);
    assert.equal(r.outcome, 'killed_after_timeout');
    assert.equal(r.escalated, true);
});

test('closeBrowser: a survivor is reported, not papered over', async () => {
    const h = closeHarness({ ignoresTerm: true, survivesKill: true });
    const r = await closeBrowser({ pid: 888, profileDir: '/tmp/spring-mcp-browser-z' }, h.opts);
    assert.equal(r.outcome, 'kill_failed');
    assert.match(describeClose(r), /survived SIGKILL/);
});

test('closeBrowser: an already-dead browser is a no-op, and signals nothing', async () => {
    const signals = [];
    const r = await closeBrowser({ pid: 5, profileDir: '/tmp/spring-mcp-browser-q' }, {
        isAlive: () => false,
        kill: (p, s) => signals.push([p, s]),
        rm: () => {},
    });
    assert.equal(r.outcome, 'already_exited');
    assert.deepEqual(signals, [], 'never signal a pid that is already gone');
});

test('closeBrowser: only removes profile dirs it owns', async () => {
    const removed = [];
    await closeBrowser({ pid: 5, profileDir: '/Users/me/Library/Chrome' }, {
        isAlive: () => false, kill: () => {}, rm: p => removed.push(p),
    });
    assert.deepEqual(removed, [], 'a foreign profile dir is never rm -rf’d');

    await closeBrowser({ pid: 6, profileDir: '/tmp/spring-mcp-browser-7-1' }, {
        isAlive: () => false, kill: () => {}, rm: p => removed.push(p),
    });
    assert.deepEqual(removed, ['/tmp/spring-mcp-browser-7-1']);
});
