#!/usr/bin/env node
// Churn arm — PLAN-long-uptime.md **T4-1** ("ladder 2"), the arm every headless
// soak so far could not run.
//
// The ladders in task 4/4b measure a world with NO CLIENTS. Two of §1's growth
// rows are unreachable that way, and not by a little: `StateStreamer::
// BroadcastRulesParams` returns at `GetClientCount() == 0` *before* the
// interning block, so S1's key dictionary is never written; and a standing
// order is refused with a 401 unless `session->team >= 0`, so S6's container is
// never filled. Both read 0 at all 192 samples of the last ladder, and the
// growth report calls that `no-signal` — correctly, because a container nothing
// touched is not a container shown to be bounded.
//
// So this runs the same fixture twice:
//
//   churn arm   — N scripted wire sessions connecting, issuing a move order and
//                 a standing order, disconnecting, and doing it again for the
//                 length of the window (client/wire/run-wire-churn.mjs)
//   control arm — the same binary, the same fixture, the same `--player`
//                 roster, nobody connecting
//
// The pair is the evidence. The churn arm alone would show two counters with
// numbers in them and could not say the clients put them there; the control is
// what makes "0 → non-zero" attributable, and it fails the gate if a surface
// moves with nobody watching.
//
// Both arms run as a **persistent war** (`--session-kind persistent`). A
// skirmish with a `--player` roster holds GameStart until every rostered human
// connects (GameStartCoordinator.h), which the control arm never does — the two
// arms would then not be the same run at all, and the control would measure a
// server sitting in set-up.
//
// Usage:
//   node soak-churn-run.mjs --server-bin build/release/spring-server \
//     [--fixture fixtures/churn-ladder.json] [--out-dir build/soak-churn] \
//     [--sessions 2] [--window-min 3] [--port 19300] [--repo-root <dir>]
//     [--skip-control]
import { parseArgs } from 'node:util';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { loadJson, writeJson } from './lib/config.mjs';
import { runServer } from './lib/run-server.mjs';
import {
    checkChurnWindow, checkClientSurfaces, compareChurnToControl, surfaceReading,
    CLIENT_SURFACES,
} from './lib/churn-checks.mjs';
import { censusChurn, formatCensus } from './lib/key-census.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(HERE, '..', '..');
const DEFAULT_FIXTURE = path.join(HERE, 'fixtures', 'churn-ladder.json');

/** Teams the churn accounts are seated on. The fixture's AI slots hold 0 and 4
 *  (compact and union); these are the second seat of each faction's team block
 *  in `meridian_basin_soak`, so a churn account fights beside an AI rather than
 *  displacing one. A seat is not optional — an unseated session is admitted as
 *  a spectator and its standing order is refused with a 401. */
const CHURN_TEAMS = [1, 5, 2, 6, 3, 7];
/** StandingOrderType.DefendArea — the cheapest order to state, and the one
 *  whose params are just a position and a radius. */
const ORDER_DEFEND_AREA = 0;

function fail(msg, detail) {
    console.error(`SOAK CHURN FAIL: ${msg}`);
    if (detail) console.error(detail);
    process.exit(1);
}

/** Spawn the churn driver against a server that may not exist yet. Resolves
 *  with its parsed JSON verdict; exit 2 is the harness saying it could not run
 *  (no addon, no server at all) and is reported separately from exit 1. */
function runChurnDriver({ clientRoot, url, users, durationMs, waitMs, holdMs, gapMs }) {
    const args = [
        'wire/run-wire-churn.mjs',
        '--url', url,
        '--users', users.map((u) => `${u.user}:${u.pass}`).join(','),
        '--duration-ms', String(durationMs),
        '--wait-for-server', String(waitMs),
        '--hold-ms', String(holdMs),
        '--gap-ms', String(gapMs),
        '--standing-order-type', String(ORDER_DEFEND_AREA),
        '--quiet', '--json',
    ];
    return new Promise((resolve) => {
        const child = spawn(process.execPath, args, {
            cwd: clientRoot, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', (err) => resolve({ exitCode: 2, json: null, stdout, stderr: `${stderr}\nspawn: ${err.message}` }));
        child.on('close', (exitCode) => {
            let json = null;
            const line = stdout.split('\n').reverse().find((l) => l.trim().startsWith('{'));
            if (line) { try { json = JSON.parse(line); } catch { /* reported by the caller */ } }
            resolve({ exitCode, json, stdout, stderr });
        });
    });
}

/** One headless arm: the server, plus the churn driver when this arm has one.
 *  The driver is started FIRST (`--wait-for-server`) for the reason the replay
 *  spectate gate documents — node + vite + the native addon cost seconds, and
 *  spending them inside the window would shorten the churn rather than the
 *  start-up. */
async function churnArm({
    serverBin, configPath, dumpPath, dbPath, port, windowMin, repoRoot, clientRoot,
    users, churnDriver, label,
}) {
    const driver = churnDriver
        ? runChurnDriver({
            clientRoot, url: `http://127.0.0.1:${port}`, users,
            // The driver must finish INSIDE the server's wall ceiling: a driver
            // still connecting while the server tears down produces refused
            // handshakes that are the harness racing itself, not a defect.
            durationMs: Math.max(10_000, windowMin * 60_000 - 25_000),
            waitMs: 90_000, holdMs: 4_000, gapMs: 500,
        })
        : null;

    const args = [
        '--headless-run', configPath,
        '--port', String(port),
        '--db', dbPath,
        '--max-wall-min', String(windowMin),
        // Persistent, so GameStart fires at set-up in BOTH arms (see header).
        '--session-kind', 'persistent',
    ];
    for (const u of users) args.push('--player', `${u.user}:${u.team}:${u.startPos}`);

    const server = await runServer({ serverBin, cwd: repoRoot, args });
    const driverResult = driver ? await driver : null;

    let dump = null;
    try { dump = JSON.parse(await readFile(dumpPath, 'utf8')); } catch { /* reported by the caller */ }
    console.log(`  ${label}: exit=${server.exitCode} dump=${dump ? `${dump.snapshots?.length ?? 0} snapshots, frame ${dump.frame}` : 'MISSING'}`);
    return { server, dump, driverResult };
}

async function main() {
    const { values } = parseArgs({
        options: {
            'server-bin': { type: 'string' },
            fixture: { type: 'string', default: DEFAULT_FIXTURE },
            'out-dir': { type: 'string', default: path.join(DEFAULT_REPO_ROOT, 'build', 'soak-churn') },
            sessions: { type: 'string', default: '2' },
            'window-min': { type: 'string', default: '3' },
            port: { type: 'string', default: '19300' },
            'repo-root': { type: 'string', default: DEFAULT_REPO_ROOT },
            'min-cycles': { type: 'string', default: '2' },
            'skip-control': { type: 'boolean', default: false },
        },
    });

    if (!values['server-bin']) {
        console.error('--server-bin is required');
        process.exit(2);
    }

    const serverBin = path.resolve(values['server-bin']);
    const outDir = path.resolve(values['out-dir']);
    const repoRoot = path.resolve(values['repo-root']);
    const clientRoot = path.join(repoRoot, 'client');
    const port = parseInt(values.port, 10);
    const windowMin = parseInt(values['window-min'], 10);
    const sessions = parseInt(values.sessions, 10);
    const minCycles = parseInt(values['min-cycles'], 10);

    if (sessions > CHURN_TEAMS.length) {
        console.error(`--sessions ${sessions} exceeds the ${CHURN_TEAMS.length} seats this fixture has`);
        process.exit(2);
    }

    const users = Array.from({ length: sessions }, (_, i) => ({
        user: `churn_soak_${i}`, pass: 'devpass',
        team: CHURN_TEAMS[i], startPos: i,
    }));

    await mkdir(outDir, { recursive: true });
    console.log(`soak-churn: ${values.fixture} via ${serverBin}`);
    console.log(`  ${sessions} churn session(s) on team(s) ${users.map((u) => u.team).join(',')}, `
        + `${windowMin}-minute window`);

    // Both arms take the SAME config with only the dump path differing. A
    // second fixture file would be a second thing to keep in step, and the
    // pair's whole claim is that nothing but the clients differed.
    const template = await loadJson(path.resolve(values.fixture));
    const arms = [];
    for (const [name, churn] of [['churn', true], ['control', false]]) {
        if (name === 'control' && values['skip-control']) continue;
        const configPath = path.join(outDir, `${name}-config.json`);
        const dumpPath = path.join(outDir, `${name}-dump.json`);
        const dbPath = path.join(outDir, `${name}-db.sqlite`);
        const config = structuredClone(template);
        config.headless = { ...(config.headless ?? {}), statsDump: dumpPath };
        await writeJson(configPath, config);
        // A re-run into an existing out-dir must not read the PREVIOUS run's
        // dump back as this one's result (run-paths.mjs's rule, and the reason
        // it exists).
        for (const stale of [dumpPath, dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
            await rm(stale, { force: true });
        }
        arms.push({ name, churn, configPath, dumpPath, dbPath });
    }

    const results = {};
    for (const [i, arm] of arms.entries()) {
        results[arm.name] = await churnArm({
            serverBin, configPath: arm.configPath, dumpPath: arm.dumpPath,
            dbPath: arm.dbPath, port: port + i, windowMin, repoRoot, clientRoot,
            users, churnDriver: arm.churn, label: `${arm.name} arm`,
        });
        await writeFile(path.join(outDir, `${arm.name}-server.log`),
            `${results[arm.name].server.stdout}\n--- stderr ---\n${results[arm.name].server.stderr}`);
        if (results[arm.name].driverResult) {
            await writeFile(path.join(outDir, `${arm.name}-client.log`),
                `${results[arm.name].driverResult.stdout}\n--- stderr ---\n${results[arm.name].driverResult.stderr}`);
        }
    }

    // --- Part 1: did the churn happen at all? -----------------------------
    const dr = results.churn.driverResult;
    if (dr?.exitCode === 2) {
        fail('the churn driver could not run — either the environment (no native '
            + 'addon: `npm install` in client/) or a server that never answered',
            dr.stderr.split('\n').slice(-15).join('\n'));
    }
    if (!dr?.json) {
        fail(`the churn driver produced no JSON verdict (exit ${dr?.exitCode})`,
            dr ? `${dr.stdout}\n${dr.stderr}`.split('\n').slice(-20).join('\n') : null);
    }
    const window = checkChurnWindow(dr.json, { minCycles, minDistinctSeats: sessions });
    console.log(`  churn: ${window.facts.cyclesAuthed} cycle(s) authed `
        + `(${window.facts.seatedCycles} seated, ${window.facts.distinctSeated} distinct account(s)), `
        + `${window.facts.ordersSent} standing order(s) sent, `
        + `server errors ${JSON.stringify(window.facts.serverErrorsByCode)}`);
    if (!window.ok) fail('the churn window did not hold:\n  - ' + window.problems.join('\n  - '));

    // --- Part 2: did S1/S6 move? ------------------------------------------
    const surfaces = checkClientSurfaces(results.churn.dump);
    for (const s of CLIENT_SURFACES) {
        const r = surfaces.readings[s.key] ?? { samples: 0, peak: 0, final: 0 };
        console.log(`  ${s.row} ${s.key}: peak=${r.peak} final=${r.final} over ${r.samples} sample(s)`);
    }
    if (!surfaces.ok) fail('the client-driven surfaces did not move:\n  - ' + surfaces.problems.join('\n  - '));

    // --- Part 2b: WHICH keys did it mint? (T4-1e) --------------------------
    // Reported, never gated. The census answers a question about the SHAPE of
    // S1's population; whether that population is bounded is T4-1a's ruling on
    // the peak envelope, and a window this short observes at most one
    // reclamation (§15's `one-cycle`). Gating here would gate on the same coin.
    const census = censusChurn(dr.json.keyDictionaryCycles ?? []);
    await writeJson(path.join(outDir, 'key-census.json'), census);
    console.log('  S1 key census (T4-1e):');
    console.log(formatCensus(census));

    // --- Part 3: the matched control --------------------------------------
    if (values['skip-control']) {
        console.log('  control: SKIPPED (--skip-control) — the readings above are not attributable');
        console.log('OK (unattributed): the churn window ran and both surfaces moved.');
        return;
    }
    if (!results.control.dump) {
        fail('the control arm produced no stats dump — the pair cannot be compared',
            results.control.server.stderr.split('\n').slice(-20).join('\n'));
    }
    for (const s of CLIENT_SURFACES) {
        const r = surfaceReading(results.control.dump, s.key);
        console.log(`  control ${s.row} ${s.key}: peak=${r.peak} over ${r.samples} sample(s)`);
    }
    const pair = compareChurnToControl(results.churn.dump, results.control.dump);
    if (!pair.ok) fail('the pair does not attribute the movement to the clients:\n  - '
        + pair.problems.join('\n  - '));

    const summary = CLIENT_SURFACES
        .map((s) => `${s.key} ${pair.deltas[s.key].controlPeak} → ${pair.deltas[s.key].churnPeak}`)
        .join(', ');
    console.log(`OK: ${window.facts.cyclesAuthed} churn cycle(s) drove the client-only growth `
        + `surfaces off zero, and the matched control did not: ${summary}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        console.error(err.stack ?? err.message ?? err);
        process.exit(1);
    });
}
