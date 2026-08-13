#!/usr/bin/env node
// Fixture-replay verify — PLAN-replay.md task 5 (the CI hook).
//
// Records one headless fixture game to a replay file, then re-executes that
// recording and asserts it reproduces its own embedded state-hash track
// frame-for-frame. Where the determinism pair-run (PLAN-headless task 4) asks
// "does the same input produce the same output twice in the same binary?",
// this asks the strictly harder question: "does re-feeding the recorded CAUSE
// STREAM through the sim reproduce the run?" — which additionally covers
// journal completeness (an unrecorded synced input shows up as a divergence),
// record ordering, and the replay container round-trip.
//
//   pass 1: spring-server --headless-run <fixture> --journal-file run.msr
//                         --journal-hash-every N
//   pass 2: spring-server --replay run.msr --verify
//   pass 3: spring-server --replay run.msr --replay-export packed.msr
//           spring-server --replay packed.msr --verify        (--pack only)
//
// TWO TRAPS this script exists to navigate, both documented in PLAN-replay:
//
//  * T2-b — DO NOT gate on the exit code. `spring-server` aborts during static
//    destruction (CWeaponDefHandler, inside __cxa_finalize, AFTER main returns
//    and after "exited cleanly" is logged) in any run that touched weapon
//    defs. That is a pre-existing defect no plan file owns; it makes the
//    process status meaningless here. The verdict is the `replay verify:` log
//    line, which the engine emits before shutdown.
//
//  * T2-c/T3-d — a replay gate over an empty world is vacuous. The recording
//    pass writes a stats dump and the run is rejected up front unless it
//    actually contained units, damage and deaths (lib/fixture-checks.mjs).
//    A hash comparison cannot tell you it compared two empty worlds.
//
// Usage:
//   node replay-verify-run.mjs --server-bin <path-to-spring-server> \
//     [--config fixtures/papertanks-determinism.json] [--out-dir <dir>] \
//     [--hash-every N] [--max-wall-min N] [--port N] [--repo-root <dir>] [--pack]
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { runServer } from './lib/run-server.mjs';
import { recordFixture, RecordingError, tail } from './lib/replay-record.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(HERE, '..', '..');
const DEFAULT_CONFIG = path.join(HERE, 'fixtures', 'papertanks-determinism.json');

// The engine's own verdict lines (server_main.cpp, "Replay verification
// verdict"). Matching the PASS line is not enough on its own — a run that
// never reached the verdict at all would then read as "no FAIL seen".
const PASS_RE = /replay verify: PASS — (\d+)\/(\d+) state hashes matched, (\d+) records fed/;
const FAIL_RE = /replay verify: FAIL — .*/;

function fail(msg, detail) {
    console.error(`REPLAY VERIFY FAIL: ${msg}`);
    if (detail) console.error(detail);
    process.exit(1);
}

// Reads the engine's verdict out of a replay run's output. Returns
// { verdict: 'pass'|'fail'|'absent', line }.
export function readVerdict(output) {
    const passLine = output.match(PASS_RE);
    if (passLine) return { verdict: 'pass', line: passLine[0], matched: Number(passLine[1]), checked: Number(passLine[2]), fed: Number(passLine[3]) };
    const failLine = output.match(FAIL_RE);
    if (failLine) return { verdict: 'fail', line: failLine[0] };
    return { verdict: 'absent', line: null };
}

async function verifyReplay({ serverBin, replayPath, port, dbPath, maxWallMin, repoRoot, label }) {
    const result = await runServer({
        serverBin,
        cwd: repoRoot,
        args: [
            '--replay', replayPath,
            '--verify',
            '--port', String(port),
            '--db', dbPath,
            '--max-wall-min', String(maxWallMin),
        ],
    });
    const v = readVerdict(`${result.stdout}\n${result.stderr}`);
    if (v.verdict === 'absent') {
        fail(`${label}: the run produced no \`replay verify:\` verdict at all ` +
             `(exit=${result.exitCode} signal=${result.signal}) — the re-execution did not reach its end`,
             tail(result));
    }
    if (v.verdict === 'fail') fail(`${label}: ${v.line}`, tail(result));
    // A verdict that checked nothing is a pass by vacuity — the engine refuses
    // `--verify` with no track at start-up, but a track with one point would
    // slip through, so say the number out loud and require more than one.
    if (v.checked < 2)
        fail(`${label}: PASS over only ${v.checked} reference point(s) — not a determinism gate`, v.line);
    console.log(`  ${label}: ${v.line}`);
    return v;
}

async function main() {
    const { values } = parseArgs({
        options: {
            'server-bin': { type: 'string' },
            config: { type: 'string', default: DEFAULT_CONFIG },
            'out-dir': { type: 'string', default: path.join(DEFAULT_REPO_ROOT, 'build', 'replay-verify') },
            'hash-every': { type: 'string', default: '300' },
            'max-wall-min': { type: 'string', default: '5' },
            port: { type: 'string', default: '19207' },
            'repo-root': { type: 'string', default: DEFAULT_REPO_ROOT },
            pack: { type: 'boolean', default: false },
        },
    });

    if (!values['server-bin']) {
        console.error('--server-bin is required');
        process.exit(2);
    }

    const serverBin = path.resolve(values['server-bin']);
    const outDir = path.resolve(values['out-dir']);
    const port = parseInt(values.port, 10);
    const maxWallMin = parseInt(values['max-wall-min'], 10);
    const repoRoot = path.resolve(values['repo-root']);
    const hashEvery = parseInt(values['hash-every'], 10);

    console.log(`replay-verify: ${values.config} via ${serverBin}`);

    // --- Pass 1: record (shared with the spectate gate) -------------------
    // Includes the non-vacuity check the whole gate rests on (T2-c / T3-d).
    let replayPath;
    try {
        ({ replayPath } = await recordFixture({
            serverBin, configFile: path.resolve(values.config), outDir,
            port, maxWallMin, repoRoot, hashEvery,
        }));
    } catch (e) {
        if (e instanceof RecordingError) fail(e.message, e.detail);
        throw e;
    }

    // --- Pass 2: re-execute and verify against the embedded track ---------
    await verifyReplay({
        serverBin, replayPath, port: port + 1, maxWallMin, repoRoot,
        dbPath: path.join(outDir, 'db-verify.sqlite'),
        label: 'recording',
    });

    // --- Pass 3 (optional): the same check through the .msr packer --------
    if (values.pack) {
        const packedPath = path.join(outDir, 'packed.msr');
        const pack = await runServer({
            serverBin, cwd: repoRoot,
            args: ['--replay', replayPath, '--replay-export', packedPath],
        });
        let packedSize = 0;
        try {
            packedSize = (await stat(packedPath)).size;
        } catch {
            fail('--replay-export produced no output file', tail(pack));
        }
        const rawSize = (await stat(replayPath)).size;
        console.log(`  packed: ${rawSize} -> ${packedSize} bytes`);
        await verifyReplay({
            serverBin, replayPath: packedPath, port: port + 2, maxWallMin, repoRoot,
            dbPath: path.join(outDir, 'db-packed.sqlite'),
            label: 'packed',
        });
    }

    console.log('OK: the recorded cause stream re-executes to its own hash track.');
}

// Only run when invoked directly, so `readVerdict` can be unit-tested.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        console.error(err.message ?? err);
        process.exit(1);
    });
}
