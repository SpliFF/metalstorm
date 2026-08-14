#!/usr/bin/env node
/**
 * SG1's exit test — the AI→human→AI guidance loop, closed on a live sim.
 * PLAN-ai-synced-write.md **task 5** acceptance criterion 3.
 *
 * `make test-ai-veto-loop`. What it drives:
 *
 *   1. a paced `--headless-run` of meridian_basin with the strategos on team 0
 *      and ONE rostered human on the same team (`--player`),
 *   2. that human, over the REAL wire (the scripted wire client, WebTransport +
 *      the app's own wire codec), funding the co-commander,
 *   3. the AI planning and charging directives, each tagged with its planner
 *      goal id (`ai.intent` → `guidance_0_intent_<i>_goal_id`),
 *   4. the same human vetoing the goal the AI is pursuing hardest,
 *   5. two further strategic ticks in which the AI must keep working and must
 *      not touch the vetoed goal.
 *
 * Three things about the shape of this arm are not incidental:
 *
 *  • **The human is what makes the loop reachable AND what makes it hard.** With
 *    no `--player` the strategos is a `full_side` and publishes intent lines
 *    happily — but there is no human to veto, and injecting one through
 *    `/api/exec` skips the whole client path (seat, clamps, attributed
 *    playerNum). With a human the AI becomes a `co_commander`, which is
 *    `own_pool_only` and starts at pool 0: it plans directives it cannot pay
 *    for, charges nothing, and therefore publishes NO intent lines at all.
 *    So the funding step is not setup convenience — it is the only state in
 *    which this loop exists. (Recorded in §6 task 5; the acceptance recipe as
 *    written could not have tested the human end.)
 *
 *  • **Pacing is `x8`, not `uncapped`.** The arm has to interleave HTTP polls
 *    and two node+vite client start-ups with the sim; an uncapped run reaches
 *    its stop frame before the first client has loaded.
 *
 *  • **`/api/exec` is the observer, never an actor.** Everything this harness
 *    asserts on is read; the only writes into the game come from the wire
 *    client, because a write over exec would be testing a path no player has.
 *
 * Exit: 0 = the loop closed, 1 = an assertion failed, 2 = the arm could not run
 * (no server, no native addon, a vacuous window). Vacuity is exit 2 on purpose:
 * it is "this proved nothing", which is not a pass.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
    parseSample, pickVetoTarget, vetoLoopVerdict, pushOrderVerdict,
} from './lib/ai-veto-checks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(HERE, '..', '..');
const DEFAULT_CONFIG = path.join(HERE, 'fixtures', 'ai-veto-loop.json');

/** The strategos' tick period (ai.config.lua `tickFrames`) and the acceptance
 *  bar of §4 criterion 3 ("within ≤ 2 strategic ticks"). */
const STRATEGIC_TICK_FRAMES = 150;
const REQUIRED_TICKS = 2;

/** The team the human and the AI share. Both come from the fixture + the
 *  `--player` spec below; kept as one constant so the exec probe, the roster
 *  arg and the rulesParam prefix cannot disagree. */
const TEAM = 0;

function fail(msg, detail, code = 1) {
    console.error(`AI VETO LOOP ${code === 2 ? 'CANNOT RUN' : 'FAIL'}: ${msg}`);
    if (detail) console.error(detail);
    process.exitCode = code;
    return code;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST /api/exec on the game server. Loopback is trusted by the route in any
 *  non-SPRING_PROD build, so no token is needed — and this arm never runs
 *  against a prod binary, where the route is compiled out entirely. */
async function exec(port, code, timeoutMs = 8000) {
    const ctl = AbortSignal.timeout(timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/api/exec`, {
        method: 'POST', signal: ctl,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'LuaRules', code }),
    });
    const j = await res.json();
    if (!j.success) throw new Error(`exec failed: ${j.output}`);
    return j.output;
}

/**
 * One reading of the published guidance state, packed flat.
 *
 * `SetTeamRulesParam`, not game rules params: the guidance store is
 * team-private (`publishIntent`), which is also why the panel reads it through
 * the team-scoped accessor. Values come back through the exec bridge's
 * pretty-printer, so the probe formats integers itself (`%d`) rather than
 * letting `406.0` reach a parser (docs/debugging-console.md).
 */
const SAMPLE_LUA = `
local t = ${TEAM}
local p = 'guidance_' .. t .. '_'
local n = tonumber(Spring.GetTeamRulesParam(t, p .. 'intent_count')) or 0
local ids = {}
for i = 0, n - 1 do
    ids[#ids + 1] = tostring(Spring.GetTeamRulesParam(t, p .. 'intent_' .. i .. '_goal_id') or '')
end
local vetoes = tostring(Spring.GetTeamRulesParam(t, p .. 'veto_keys') or '')
return string.format('%d', Spring.GetGameFrame()) .. '|' .. table.concat(ids, ',') .. '|' .. vetoes
`.trim().replace(/\n/g, ' ');

async function sample(port) {
    // The bridge quote-wraps strings; strip one layer before parsing.
    const raw = await exec(port, SAMPLE_LUA);
    return parseSample(String(raw).replace(/^"|"$/g, ''));
}

/** Spawn the scripted wire client for one seated session. */
function runWireClient({ clientRoot, url, user, pass, holdMs, wireCommands, waitMs }) {
    const args = [
        'wire/run-wire-client.mjs',
        '--url', url, '--user', user, '--pass', pass,
        '--hold-ms', String(holdMs), '--wait-for-server', String(waitMs),
        '--quiet', '--json',
    ];
    for (const { cmd, fields } of wireCommands ?? []) {
        args.push('--wire-command', cmd);
        for (const [k, v] of Object.entries(fields ?? {})) {
            args.push('--wire-field', `${k}=${v}`);
        }
    }
    return new Promise((resolve) => {
        const child = spawn(process.execPath, args, {
            cwd: clientRoot, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', (e) => resolve({ exitCode: 2, json: null, stdout, stderr: `${stderr}\n${e.message}` }));
        child.on('close', (exitCode) => {
            let json = null;
            const line = stdout.split('\n').reverse().find((l) => l.trim().startsWith('{'));
            if (line) { try { json = JSON.parse(line); } catch { /* reported by the caller */ } }
            resolve({ exitCode, json, stdout, stderr });
        });
    });
}

/** Goal ids the planner logged as veto-excluded — `vetoed=<a,b>` on the
 *  strategos tick line (main.lua). This is the AI's own statement that it
 *  consulted the human's veto, and it is what stops the arm from passing on a
 *  goal that merely fell out of favour. */
export function plannerVetoReports(log) {
    const out = new Set();
    for (const m of String(log ?? '').matchAll(/\bvetoed=([^\s]+)/g)) {
        for (const id of m[1].split(',')) if (id) out.add(id);
    }
    return [...out];
}

/** Lua errors, as CLuaHandle logs them. Criterion 3 asks for zero across the
 *  run; the two shapes are a call-in runtime error and a load/parse error, and
 *  both are ERROR-level lines naming the handle. */
export function luaErrorLines(log) {
    return String(log ?? '').split('\n').filter((l) =>
        /runtime error in callin|parse error:/.test(l));
}

async function main() {
    const { values } = parseArgs({
        options: {
            'server-bin': { type: 'string' },
            config: { type: 'string', default: DEFAULT_CONFIG },
            'out-dir': { type: 'string', default: path.join(DEFAULT_REPO_ROOT, 'build', 'ai-veto-loop') },
            'repo-root': { type: 'string', default: DEFAULT_REPO_ROOT },
            port: { type: 'string', default: '19311' },
            user: { type: 'string', default: 'veto_probe' },
            pass: { type: 'string', default: 'devpass' },
            'max-wall-min': { type: 'string', default: '10' },
            // How long to wait for the first tagged intent line. Generous: it
            // takes a scenario load, a funding drip and a charged directive.
            'intent-timeout-ms': { type: 'string', default: '180000' },
            'fund-amount': { type: 'string', default: '40' },
            // A rate cap as well as a one-shot: the one-shot buys the first
            // directives, the drip keeps the co-commander solvent for the whole
            // post-veto window (an AI that goes broke mid-window makes the
            // "kept working" check vacuous rather than false).
            'fund-rate-cap': { type: 'string', default: '30' },
        },
    });

    if (!values['server-bin']) return fail('--server-bin is required', null, 2);
    const port = Number.parseInt(values.port, 10);
    const outDir = path.resolve(values['out-dir']);
    const repoRoot = path.resolve(values['repo-root']);
    const clientRoot = path.join(repoRoot, 'client');
    const url = `http://127.0.0.1:${port}`;
    await mkdir(outDir, { recursive: true });

    console.log(`ai-veto-loop: ${values.config} via ${values['server-bin']} on :${port}`);

    // ── The server. Roster of one human on the AI's team; the journal attached
    // so task 5(b)'s push order is readable off /api/journal.
    const server = spawn(values['server-bin'], [
        '--headless-run', path.resolve(values.config),
        '--player', `${values.user}:${TEAM}:0`,
        '--journal-audit',
        '--port', String(port),
        '--db', path.join(outDir, 'db.sqlite'),
        '--max-wall-min', values['max-wall-min'],
    ], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let serverLog = '';
    server.stdout.on('data', (d) => { serverLog += d; });
    server.stderr.on('data', (d) => { serverLog += d; });
    let serverExit = null;
    server.on('close', (code, signal) => { serverExit = { code, signal }; });

    const finish = async (code, msg, detail) => {
        await writeFile(path.join(outDir, 'server.log'), serverLog);
        if (serverExit === null) server.kill('SIGTERM');
        if (msg) fail(msg, detail, code);
        else console.log('ai-veto-loop: PASS');
        process.exit(code);
    };

    // The sim loop line is the gate: /api/exec answers only once the sim thread
    // is draining, and a request sent during map/def load times out in a way
    // that reads exactly like a hung server.
    const simUp = Date.now() + 300_000;
    while (!/entering sim loop/.test(serverLog)) {
        if (serverExit) return finish(2, `the server exited before entering the sim loop `
            + `(code ${serverExit.code}, signal ${serverExit.signal})`, serverLog.slice(-2000));
        if (Date.now() > simUp) return finish(2, 'the server never entered its sim loop', serverLog.slice(-2000));
        await sleep(1000);
    }

    // ── The human joins. Two jobs at once: a rostered player is what fires
    // GameStart on a skirmish, and the funding is what makes the co-commander
    // able to charge a directive at all.
    const join = await runWireClient({
        clientRoot, url, user: values.user, pass: values.pass,
        holdMs: 4000, waitMs: 60_000,
        wireCommands: [{
            cmd: 'guidance.fund',
            fields: { amount: values['fund-amount'], rateCap: values['fund-rate-cap'] },
        }],
    });
    await writeFile(path.join(outDir, 'client-join.log'), `${join.stdout}\n${join.stderr}`);
    if (join.exitCode === 2) {
        return finish(2, 'the wire client could not run — either the native addon '
            + '(`npm install` in client/) or a server that never answered',
            join.stderr.split('\n').slice(-15).join('\n'));
    }
    if (!join.json?.auth?.ok) {
        return finish(1, `the human was not admitted: ${join.json?.auth?.message ?? 'no verdict'}`);
    }
    if (join.json.auth.team !== TEAM || join.json.auth.role !== 'player') {
        return finish(1, `the human landed on team ${join.json.auth.team} as `
            + `'${join.json.auth.role}' — the veto is validated against the sender's `
            + `team, so anything but a seated player on team ${TEAM} makes this arm vacuous`);
    }
    const playerNum = join.json.auth.playerNum;
    console.log(`  human: playerNum=${playerNum} team=${join.json.auth.team} `
        + `role=${join.json.auth.role}; funded ${values['fund-amount']} `
        + `+${values['fund-rate-cap']}/min`);

    // ── Wait for a tagged intent line. This is the AI→synced write path
    // arriving: a goal id here means the actuator's `ai.intent` reached the
    // gadget and was consumed onto the directive it annotates.
    const before = [];
    const intentDeadline = Date.now() + Number.parseInt(values['intent-timeout-ms'], 10);
    let target = null;
    while (Date.now() < intentDeadline) {
        if (serverExit) break;
        try {
            const s = await sample(port);
            before.push(s);
            // Two samples carrying the id, so the pick is of a goal the AI is
            // pursuing rather than one it touched once on its way past.
            const t = pickVetoTarget(before);
            if (t && t.samples >= 2) { target = t; break; }
        } catch (e) {
            if (serverExit) break;
            console.log(`  (exec: ${e.message})`);
        }
        await sleep(2000);
    }
    if (!target) {
        const pool = await exec(port, `return string.format('%d', GG.Authority.PoolOf({player=0}) or -1)`)
            .catch((e) => `unreadable (${e.message})`);
        // Two very different causes, and the samples separate them: NO intent
        // lines means the AI never charged a directive (funding), while intent
        // lines carrying empty goal ids means it charged them untagged — the
        // actuator's `ai.intent` never arrived, which is the write path itself.
        const lines = before.reduce((m, s) => Math.max(m, s.goalIds.length), 0);
        const cause = lines === 0
            ? 'the AI published no intent line at all — it charged no directive, so '
              + 'RecordIntent never fired (a co-commander with an empty pool plans '
              + 'directives it cannot pay for; check the funding arm above)'
            : `the AI published ${lines} intent line(s) and every goal id is empty — the `
              + 'directives were charged UNTAGGED, so the ai.intent LuaMsg never reached '
              + 'the gadget in the frame its directive charged (actuators.lua _issueTagged '
              + '→ engine drain → game_ai_guidance)';
        return finish(2, 'no planner goal id was ever published, so there was nothing to veto',
            `${cause}\nAI own pool: ${pool}\nlast samples: `
            + `${JSON.stringify(before.slice(-3))}`);
    }
    console.log(`  target: '${target.id}' (still directed at ${target.samples} samples, `
        + `frame ${before[before.length - 1].frame})`);

    // ── The veto, over the wire, exactly as the panel sends it.
    const veto = await runWireClient({
        clientRoot, url, user: values.user, pass: values.pass,
        holdMs: 3000, waitMs: 30_000,
        wireCommands: [{ cmd: 'guidance.veto', fields: { goalId: target.id } }],
    });
    await writeFile(path.join(outDir, 'client-veto.log'), `${veto.stdout}\n${veto.stderr}`);
    if (veto.exitCode === 2) {
        return finish(2, 'the veto client could not run', veto.stderr.split('\n').slice(-15).join('\n'));
    }
    if (!veto.json?.auth?.ok) {
        return finish(1, `the veto session was refused: ${veto.json?.auth?.message ?? 'no verdict'}`);
    }
    const sentWire = veto.json.wireSent?.[0]?.wire ?? '';
    if (!sentWire.includes(target.id)) {
        return finish(1, `the veto client did not put the goal id on the wire `
            + `(sent '${sentWire}') — the assertion below would be about the wrong goal`);
    }
    console.log(`  veto sent: '${sentWire}'`);
    const atVeto = await sample(port);

    // ── Two strategic ticks, plus a margin for the tick that was already in
    // flight when the veto landed.
    const after = [];
    const windowFrames = STRATEGIC_TICK_FRAMES * (REQUIRED_TICKS + 1);
    const windowDeadline = Date.now() + 240_000;
    for (;;) {
        if (serverExit) break;
        if (Date.now() > windowDeadline) break;
        try {
            const s = await sample(port);
            after.push(s);
            if (s.frame - atVeto.frame >= windowFrames) break;
        } catch (e) {
            if (serverExit) break;
            console.log(`  (exec: ${e.message})`);
        }
        await sleep(1500);
    }

    // ── The journal, for task 5(b). Head+tail of the ring; the tail is the
    // window that contains this run's tagged directives.
    let journal = null;
    try {
        const res = await fetch(`${url}/api/journal`, { signal: AbortSignal.timeout(8000) });
        journal = await res.json();
    } catch (e) {
        console.log(`  (journal: ${e.message})`);
    }
    if (journal) await writeFile(path.join(outDir, 'journal.json'), JSON.stringify(journal, null, 2));

    const loop = vetoLoopVerdict({
        vetoedGoalId: target.id, vetoFrame: atVeto.frame, before, after,
        strategicTickFrames: STRATEGIC_TICK_FRAMES, requiredTicks: REQUIRED_TICKS,
        plannerVetoReports: plannerVetoReports(serverLog),
    });
    // Head and tail as SEPARATE blocks: the ring's middle is not published, so
    // the last head row and the first tail row are not adjacent in the stream.
    const order = pushOrderVerdict([journal?.head ?? [], journal?.tail ?? []]);
    const luaErrors = luaErrorLines(serverLog);

    await writeFile(path.join(outDir, 'verdict.json'),
        JSON.stringify({ loop, order, luaErrors, target, playerNum }, null, 2));

    console.log(`  loop: ${loop.status.toUpperCase()} — directed before=${loop.facts.directedBefore}, `
        + `published=${loop.facts.publishedInVetoKeys}, `
        + `planner reported the exclusion=${loop.facts.plannerReportedExclusion}, `
        + `fresh goals after=[${loop.facts.freshGoalsAfter.join(' ')}], `
        + `ticks observed=${loop.facts.ticksObserved}`);
    console.log(`  push order: ${order.status.toUpperCase()} — `
        + `${order.facts.orderedPairs} intent→directive pair(s) of `
        + `${order.facts.tagRecords} tag(s), verbs=[${order.facts.verbs.join(' ')}]`);
    console.log(`  lua errors: ${luaErrors.length}`);

    if (loop.status === 'vacuous' || order.status === 'vacuous') {
        return finish(2, 'the window proved nothing',
            [...loop.problems, ...order.problems].map((p) => `  - ${p}`).join('\n'));
    }
    const problems = [...loop.problems, ...order.problems,
        ...luaErrors.map((l) => `Lua error during the run: ${l.trim()}`)];
    if (problems.length) {
        return finish(1, 'the loop did not close', problems.map((p) => `  - ${p}`).join('\n'));
    }
    return finish(0);
}

await main();
