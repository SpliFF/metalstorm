import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    checkSpectatorArm, checkControlArm, compareArms, SPECTATOR_PLAYER_NUM_BASE,
} from '../lib/replay-spectate-checks.mjs';

// PLAN-replay §7.11 T2-a-1. These rules are what the gate means, so they are
// asserted without a server — and the case that matters most is the LAST one:
// on 2026-08-14 the replay server's sim-affecting-verb gate was measured inert,
// and the re-execution's hash track still PASSED 30/30 with a live client's
// PlayerCommand walking into it. A gate that folded "the verb was refused" into
// "the verdict passed" would have reported that server as healthy.

const PASS_LINE = 'replay verify: PASS — 30/30 state hashes matched, 1799 records fed';
const PASS = { verdict: 'pass', line: PASS_LINE, matched: 30, checked: 30, fed: 1799 };

const ADMIT = "replay: admitting client 1 as spectator 'probe' "
    + '(playerNum 200, reserved range; not in the sim roster)';
const ATTACH = 'replay: spectator playerNum 200 attached to the playback controls '
    + '(1 watching, controller is 200)';
const REFUSED = 'replay: client 1 sent sim-affecting verb 3 — refused '
    + '(a replay server accepts spectators, not players)';

function serverLog(lines) {
    return ['replay: run.msr — 1799 records', ...lines, PASS_LINE, 'exited cleanly'].join('\n');
}

function client(over = {}) {
    return {
        auth: { ok: true, status: 0, message: '', playerId: 7, playerNum: 200, team: -1, role: 'spectator' },
        sentByPayload: { 1: 1, 2: 1, 3: 1 },
        commandPayloadType: 3,
        writeErrors: [],
        failures: [],
        ...over,
    };
}

test('the happy arm: admitted as a reserved-range spectator, its order refused', () => {
    const r = checkSpectatorArm({
        client: client(),
        serverOutput: serverLog([ADMIT, ATTACH, REFUSED]),
        verdict: PASS,
        expectRefusedTags: [3],
    });
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
    assert.equal(r.facts.playerNum, 200);
    assert.equal(r.facts.admittedBeforeVerdict, true);
    assert.deepEqual(r.facts.refusedVerbs, [3]);
});

test('a seated identity fails: role, team and player number are each pinned', () => {
    const r = checkSpectatorArm({
        client: client({ auth: { ok: true, status: 0, message: '', playerNum: 2, team: 0, role: 'player' } }),
        serverOutput: serverLog([REFUSED]),
        verdict: PASS,
        expectRefusedTags: [3],
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes("role is 'player'")));
    assert.ok(r.problems.some((p) => p.includes('team is 0')));
    assert.ok(r.problems.some((p) => p.includes(`below the reserved base ${SPECTATOR_PLAYER_NUM_BASE}`)));
});

test('a player number the recording could also hand out is refused', () => {
    const r = checkSpectatorArm({
        client: client({ auth: { ok: true, playerNum: SPECTATOR_PLAYER_NUM_BASE - 1, team: -1, role: 'spectator' } }),
        serverOutput: serverLog([ATTACH, REFUSED]),
        verdict: PASS,
        expectRefusedTags: [3],
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('can collide with a recorded one')));
});

test('a spectator that never got in is VACUOUS, not passing', () => {
    // The `--verify` race: the re-execution finished before the client attached.
    const r = checkSpectatorArm({
        client: client(),
        serverOutput: serverLog([]),
        verdict: PASS,
        expectRefusedTags: [3],
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('VACUOUS')));
});

test('an admission logged AFTER the verdict was not attached during the run', () => {
    const out = ['replay: run.msr — 1799 records', PASS_LINE, ADMIT, ATTACH, REFUSED].join('\n');
    const r = checkSpectatorArm({
        client: client(), serverOutput: out, verdict: PASS, expectRefusedTags: [3],
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('admitted AFTER the verify verdict')));
});

test('the server and the AuthResponse must name the same player number', () => {
    const admit201 = ADMIT.replace('playerNum 200', 'playerNum 201');
    const r = checkSpectatorArm({
        client: client(), serverOutput: serverLog([admit201, ATTACH, REFUSED]),
        verdict: PASS, expectRefusedTags: [3],
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('admitted playerNum 201')));
});

test('divergence signals fail the arm even when the verdict line says PASS', () => {
    for (const sig of ['replay aborted: roster divergence at GameStart',
                       'replay: 3 record(s) were fed LATE — the replay\'s frame progression',
                       'replay: ended with 4 record(s) unfed']) {
        const r = checkSpectatorArm({
            client: client(), serverOutput: serverLog([ADMIT, ATTACH, REFUSED, sig]),
            verdict: PASS, expectRefusedTags: [3],
        });
        assert.equal(r.ok, false, sig);
    }
});

test('a harness write failure is a failure of the arm, not a silent send', () => {
    const r = checkSpectatorArm({
        client: client({ writeErrors: ['TypeError: stream closed'] }),
        serverOutput: serverLog([ADMIT, ATTACH, REFUSED]),
        verdict: PASS, expectRefusedTags: [3],
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('write failed')));
});

test('an inert refusal gate fails the arm even though the hash track PASSES', () => {
    // Measured, not hypothetical: this is the state of the tree from 2026-08-05
    // to 2026-08-14. `--verify` reported 30/30 with the spectator's order
    // reaching the sim, so the refusal is asserted independently of the verdict.
    const r = checkSpectatorArm({
        client: client(),
        serverOutput: serverLog([ADMIT, ATTACH]),   // no refusal line
        verdict: PASS,
        expectRefusedTags: [3],
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('did not refuse ClientPayload 3')));
    assert.equal(r.facts.verdict, 'pass');          // the verdict was no help
});

test('the control must be clean of every spectator line', () => {
    assert.equal(checkControlArm({ serverOutput: serverLog([]), verdict: PASS }).ok, true);

    const dirty = checkControlArm({ serverOutput: serverLog([ADMIT]), verdict: PASS });
    assert.equal(dirty.ok, false);
    assert.ok(dirty.problems.some((p) => p.includes('admitted a spectator')));

    const talkedTo = checkControlArm({ serverOutput: serverLog([REFUSED]), verdict: PASS });
    assert.equal(talkedTo.ok, false);
});

test('the pair is compared as a triple, not as two passes', () => {
    const a = { checked: 30, matched: 30, fed: 1799 };
    assert.equal(compareArms(a, a).ok, true);

    const fewer = compareArms(a, { checked: 30, matched: 30, fed: 1798 });
    assert.equal(fewer.ok, false);
    assert.ok(fewer.problems[0].includes('watching a replay changed its re-execution'));
});

test('a missing verdict is not a pass', () => {
    const r = checkSpectatorArm({
        client: client(), serverOutput: serverLog([ADMIT, ATTACH, REFUSED]).replace(PASS_LINE, ''),
        verdict: { verdict: 'absent', line: null }, expectRefusedTags: [3],
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('verify verdict is absent')));
});
