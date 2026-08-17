#!/usr/bin/env node
// Replay spectate gate — PLAN-replay.md §7.11 T2-a-1 (the CI hook).
//
// `replay-verify-run.mjs` proves a recording re-executes to its own hash track
// with NOBODY watching. This proves the other half: a real client, on the real
// wire, admitted to that same re-execution as a spectator — which is the only
// path in the system that exercises the live `Handshake`/`AuthRequest` admission
// code on a replay server, and the only one that can observe the gate refusing
// its sim-affecting verbs. A headless run has no clients, so before this the
// whole surface was covered by a hand-driven browser only.
//
//   arm 1 (spectator): spring-server --replay run.msr --verify   + wire client
//   arm 2 (control):   spring-server --replay run.msr --verify   alone
//
// Both must PASS with the SAME (checked, matched, fed) triple: the pair is what
// says the spectator was the only difference and made none.
//
// WHY --verify AND NOT PLAYBACK. Playback mode ticks in realtime, so the same
// fixture takes 300 s instead of ~10 — and playback checks no hashes, so its
// version of "the spectator changed nothing" would rest on log lines alone.
// The cost is a race, handled rather than ignored: `--verify` is a batch job, so
// the window to attach is the length of the re-execution. The harness is
// therefore started FIRST with `--wait-for-server`, paying node + vite + the
// native addon before the server exists, and an arm whose spectator never got
// in is reported as VACUOUS rather than passing (lib/replay-spectate-checks.mjs).
//
// The two traps replay-verify-run.mjs documents apply here identically: gate on
// the log line and NOT the exit code (T2-b, the static-destruction abort), and
// reject a vacuous fixture up front (T2-c/T3-d, shared with it via
// lib/replay-record.mjs).
//
// Usage:
//   node replay-spectate-run.mjs --server-bin <path-to-spring-server> \
//     [--config fixtures/papertanks-determinism.json] [--out-dir <dir>] \
//     [--hash-every N] [--max-wall-min N] [--port N] [--repo-root <dir>] \
//     [--replay-file <run.msr>]   (skip recording, spectate an existing one)
import { parseArgs } from 'node:util';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { runServer } from './lib/run-server.mjs';
import { recordFixture, RecordingError, tail } from './lib/replay-record.mjs';
import { readVerdict } from './replay-verify-run.mjs';
import {
    checkSpectatorArm, checkControlArm, compareArms,
} from './lib/replay-spectate-checks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(HERE, '..', '..');
const DEFAULT_CONFIG = path.join(HERE, 'fixtures', 'papertanks-determinism.json');

/** CMD_MOVE. Any Synced verb would do; a move order is the one a spectator
 *  would plausibly try, and it is what the browser client sends. */
const CMD_MOVE = 10;
/** ClientPayload::PlayerCommand's tag comes back from the harness (off the
 *  generated schema) — never written down here. */

function fail(msg, detail) {
    console.error(`REPLAY SPECTATE FAIL: ${msg}`);
    if (detail) console.error(detail);
    process.exit(1);
}

/** Spawn the wire client. Resolves with its parsed JSON verdict (or null) and
 *  its own exit status; a harness that could not run at all is exit 2 and is
 *  reported as an infrastructure failure rather than a gate failure. */
function runWireClient({ clientRoot, url, user, pass, waitMs, holdMs, command }) {
    const args = [
        'wire/run-wire-client.mjs',
        '--url', url, '--user', user, '--pass', pass,
        '--wait-for-server', String(waitMs),
        '--hold-ms', String(holdMs),
        '--quiet', '--json',
    ];
    if (command !== null) args.push('--command', String(command), '--squads', '1',
                                   '--params', '4000,0,4000');
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
            if (line) { try { json = JSON.parse(line); } catch { /* reported below */ } }
            resolve({ exitCode, json, stdout, stderr });
        });
    });
}

/** One `--replay --verify` server, optionally with a spectator racing to attach
 *  to it. The client is started BEFORE the server so its start-up cost is not
 *  spent inside the window (see the header). */
async function verifyArm({
    serverBin, replayPath, port, dbPath, maxWallMin, repoRoot, clientRoot,
    spectator, label,
}) {
    const client = spectator
        ? runWireClient({
            clientRoot, url: `http://127.0.0.1:${port}`, user: spectator.user,
            pass: spectator.pass, waitMs: spectator.waitMs,
            holdMs: spectator.holdMs, command: CMD_MOVE,
        })
        : null;

    const server = await runServer({
        serverBin, cwd: repoRoot,
        args: [
            '--replay', replayPath, '--verify',
            '--port', String(port), '--db', dbPath,
            '--max-wall-min', String(maxWallMin),
        ],
    });
    const output = `${server.stdout}\n${server.stderr}`;
    const verdict = readVerdict(output);
    const clientResult = client ? await client : null;
    console.log(`  ${label}: ${verdict.line ?? 'NO VERDICT LINE'}`);
    return { server, output, verdict, clientResult };
}

async function main() {
    const { values } = parseArgs({
        options: {
            'server-bin': { type: 'string' },
            config: { type: 'string', default: DEFAULT_CONFIG },
            'out-dir': { type: 'string', default: path.join(DEFAULT_REPO_ROOT, 'build', 'replay-spectate') },
            'replay-file': { type: 'string' },
            'hash-every': { type: 'string', default: '300' },
            'max-wall-min': { type: 'string', default: '5' },
            port: { type: 'string', default: '19217' },
            'repo-root': { type: 'string', default: DEFAULT_REPO_ROOT },
            'hold-ms': { type: 'string', default: '20000' },
            'wait-ms': { type: 'string', default: '90000' },
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
    const clientRoot = path.join(repoRoot, 'client');
    const hashEvery = parseInt(values['hash-every'], 10);

    console.log(`replay-spectate: ${values.config} via ${serverBin}`);

    // --- Stage the recording (shared with replay-verify-run.mjs) ----------
    let replayPath = values['replay-file'] ? path.resolve(values['replay-file']) : null;
    if (!replayPath) {
        try {
            ({ replayPath } = await recordFixture({
                serverBin, configFile: path.resolve(values.config), outDir,
                port, maxWallMin, repoRoot, hashEvery,
            }));
        } catch (e) {
            if (e instanceof RecordingError) fail(e.message, e.detail);
            throw e;
        }
    } else {
        // recordFixture() creates the out-dir; a given recording still needs
        // one, for the two arms' databases and their logs.
        await mkdir(outDir, { recursive: true });
        console.log(`  recording: given, ${replayPath}`);
    }

    // --- Arm 1: a live spectator on the re-execution ----------------------
    const spec = await verifyArm({
        serverBin, replayPath, port: port + 1, maxWallMin, repoRoot, clientRoot,
        dbPath: path.join(outDir, 'db-spectate.sqlite'),
        spectator: {
            user: 'replay_spectate_probe', pass: 'devpass',
            waitMs: parseInt(values['wait-ms'], 10),
            holdMs: parseInt(values['hold-ms'], 10),
        },
        label: 'spectator arm',
    });
    await writeFile(path.join(outDir, 'spectate-server.log'), spec.output);
    if (spec.clientResult) {
        await writeFile(path.join(outDir, 'spectate-client.log'),
                        `${spec.clientResult.stdout}\n${spec.clientResult.stderr}`);
    }
    // Exit 2 is the harness saying it could not run (bad arguments, no native
    // addon, no server on the port at all); exit 1 is an assertion of its own
    // failing. Both fail the gate — the difference is only who to send the
    // reader to, so both causes are named rather than one being asserted.
    if (spec.clientResult?.exitCode === 2) {
        fail('the wire client could not complete a session — either the environment '
             + '(no native addon: `npm install` in client/) or a server that never '
             + 'answered on the port',
             spec.clientResult.stderr.split('\n').slice(-15).join('\n'));
    }
    if (!spec.clientResult?.json) {
        fail(`the wire client produced no JSON verdict (exit ${spec.clientResult?.exitCode})`,
             spec.clientResult ? tail(spec.clientResult, 20) : null);
    }
    // The verb the arm expects to have been refused, named by the number the
    // GENERATED SCHEMA gave it (the harness reads it off `ClientPayload`), never
    // a constant in this file: a renumbered schema must break the gate, not slip
    // through it. Its absence means the arm never issued the command at all,
    // which would make the refusal assertion vacuous.
    const commandTag = spec.clientResult.json.commandPayloadType;
    if (typeof commandTag !== 'number') {
        fail('the harness reported no command payload type — it never issued the '
             + 'PlayerCommand this gate asserts was refused');
    }
    const sentCount = (spec.clientResult.json.sentByPayload ?? {})[String(commandTag)] ?? 0;
    if (sentCount < 1) {
        fail(`the harness sent no ClientPayload ${commandTag} — the refusal assertion `
             + 'would be vacuous');
    }
    const refusedExpect = [commandTag];
    const specCheck = checkSpectatorArm({
        client: spec.clientResult.json,
        serverOutput: spec.output,
        verdict: spec.verdict,
        expectRefusedTags: refusedExpect,
    });
    console.log(`  spectator: playerNum=${specCheck.facts.playerNum} `
        + `team=${specCheck.facts.team} role=${specCheck.facts.role} `
        + `refused verbs=[${(specCheck.facts.refusedVerbs ?? []).join(',')}]`);
    if (!specCheck.ok) {
        fail('the spectator arm did not hold:\n  - ' + specCheck.problems.join('\n  - '),
             tail(spec.server, 30));
    }

    // --- Arm 2: the matched control, nobody watching ----------------------
    const ctrl = await verifyArm({
        serverBin, replayPath, port: port + 2, maxWallMin, repoRoot, clientRoot,
        dbPath: path.join(outDir, 'db-control.sqlite'),
        spectator: null, label: 'control arm',
    });
    await writeFile(path.join(outDir, 'control-server.log'), ctrl.output);
    const ctrlCheck = checkControlArm({ serverOutput: ctrl.output, verdict: ctrl.verdict });
    if (!ctrlCheck.ok) {
        fail('the control arm did not hold:\n  - ' + ctrlCheck.problems.join('\n  - '),
             tail(ctrl.server, 30));
    }

    // --- The pair ---------------------------------------------------------
    const pair = compareArms(specCheck.facts, ctrlCheck.facts);
    if (!pair.ok) fail('the two arms disagree:\n  - ' + pair.problems.join('\n  - '));

    console.log(`OK: a live client spectated the re-execution `
        + `(playerNum ${specCheck.facts.playerNum}, its ${refusedExpect.length} sim-affecting `
        + `verb(s) refused) and both arms agree: `
        + `${specCheck.facts.matched}/${specCheck.facts.checked} hashes, `
        + `${specCheck.facts.fed} records fed.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        console.error(err.stack ?? err.message ?? err);
        process.exit(1);
    });
}
