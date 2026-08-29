// The ordering rules for capture_subject, pinned.
//
// These are not style tests. Each one encodes a failure that has actually
// eaten a fire: a spawn that never streamed because the sim was paused first,
// a capture that un-paused a sim somebody else had frozen, a fogged subject
// that came back as a black PNG with no explanation.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_STREAM_SETTLE_MS,
    buildHarnessCall,
    describePlan,
    formatCaptureMeta,
    parseLosStatus,
    parseSpawnIds,
    planCapture,
    validateCaptureArgs,
} from './capture-subject.js';

const LOS_OFF = { known: true, teams: [false, false], allOn: false, anyOn: false };
const LOS_ON = { known: true, teams: [true, true], allOn: true, anyOn: true };
const LOS_UNKNOWN = { known: false, teams: [], allOn: false, anyOn: false };

const ops = (steps) => steps.map((s) => s.op);

// ── parseLosStatus ───────────────────────────────────────────────────────

test('parseLosStatus reads the legacy per-team text form', () => {
    const r = parseLosStatus('ally0=on ally1=off');
    assert.equal(r.known, true);
    assert.deepEqual(r.teams, [true, false]);
    assert.equal(r.allOn, false);
    assert.equal(r.anyOn, true);
});

test('parseLosStatus reads the json form', () => {
    const r = parseLosStatus('{"globalLos":[true,true]}');
    assert.deepEqual(r.teams, [true, true]);
    assert.equal(r.allOn, true);
});

test('parseLosStatus reports UNKNOWN rather than guessing "off"', () => {
    // Guessing off here would make the restore step turn LOS off in a game
    // that had it on — a silent, lasting change to somebody else's session.
    for (const junk of ['error: LosHandler not initialised', '', null, undefined]) {
        assert.equal(parseLosStatus(junk).known, false, String(junk));
    }
});

// ── parseSpawnIds ────────────────────────────────────────────────────────

test('parseSpawnIds handles the json and legacy spawn replies', () => {
    assert.deepEqual(parseSpawnIds({ ids: [4, 5] }), [4, 5]);
    assert.deepEqual(parseSpawnIds({ unitIds: [9] }), [9]);
    assert.deepEqual(parseSpawnIds({ units: [{ id: 11 }, { id: 12 }] }), [11, 12]);
    assert.deepEqual(parseSpawnIds('spawned 1 unit(s): 42'), [42]);
    assert.deepEqual(parseSpawnIds('spawned 3 unit(s): 42, 43, 44'), [42, 43, 44]);
});

test('parseSpawnIds never invents an id from an unparseable reply', () => {
    assert.deepEqual(parseSpawnIds('error: unknown unit def'), []);
    assert.deepEqual(parseSpawnIds({}), []);
    assert.deepEqual(parseSpawnIds(null), []);
});

// ── validateCaptureArgs ──────────────────────────────────────────────────

test('a subject is required, and only one is allowed', () => {
    assert.match(validateCaptureArgs({}), /needs a subject/);
    assert.match(validateCaptureArgs({ unitId: 1, def: 'x' }), /ONE subject/);
    assert.equal(validateCaptureArgs({ unitId: 1 }), null);
    assert.equal(validateCaptureArgs({ area: { x1: 0, z1: 0, x2: 1, z2: 1 } }), null);
});

test('position and area must be numeric', () => {
    assert.match(validateCaptureArgs({ position: { x: 1 } }), /numeric x and z/);
    assert.match(validateCaptureArgs({ area: { x1: 0, z1: 0, x2: 1 } }), /numeric z2/);
});

test('spawn requires a def to spawn and somewhere to put it', () => {
    assert.match(validateCaptureArgs({ unitId: 1, spawn: { x: 0, z: 0 } }), /needs `def`/);
    assert.match(validateCaptureArgs({ def: 'a', spawn: { x: 0 } }), /numeric x and z/);
    assert.equal(validateCaptureArgs({ def: 'a', spawn: { x: 10, z: 20 } }), null);
});

test('unitIds must be a non-empty array', () => {
    assert.match(validateCaptureArgs({ unitIds: [] }), /non-empty array/);
});

test('the names a caller plausibly reaches for are corrected, not ignored', () => {
    // spawn_unit calls this field `defName`; the schema's near-miss check
    // cannot see that far, so silently ignoring it would report "needs a
    // subject" — a message that blames the caller for the wrong thing.
    assert.match(validateCaptureArgs({ defName: 'ms_subs_s1' }), /no argument "defName" — use "def"/);
    assert.match(validateCaptureArgs({ pos: { x: 1, z: 2 } }), /use "position"/);
    assert.match(validateCaptureArgs({ ids: [1, 2] }), /use "unitIds"/);
    assert.match(validateCaptureArgs({ x: 100, z: 200 }), /position:\{x,z\}/);
    // …but an alias alongside the real field is not an error.
    assert.equal(validateCaptureArgs({ def: 'a', defName: 'a' }), null);
});

// ── planCapture: the ordering contract ───────────────────────────────────

test('pause is ALWAYS the last thing before the capture', () => {
    const plan = planCapture(
        { def: 'ms_subs_s1', spawn: { x: 100, z: 100 } },
        { simPaused: false, los: LOS_OFF, cheatsOn: false });
    assert.equal(plan.pre.at(-1).op, 'pause');
});

test('a spawn settles BEFORE the pause — a paused sim streams no fresh spawns', () => {
    const plan = planCapture(
        { def: 'ms_subs_s1', spawn: { x: 100, z: 100 } },
        { simPaused: false, los: LOS_OFF, cheatsOn: true });
    assert.deepEqual(ops(plan.pre), ['spawn', 'los', 'settle', 'pause']);
    const i = ops(plan.pre);
    assert.ok(i.indexOf('spawn') < i.indexOf('settle'));
    assert.ok(i.indexOf('settle') < i.indexOf('pause'));
});

test('a LOS reveal settles before the pause for the same reason', () => {
    const plan = planCapture({ unitId: 7 }, { simPaused: false, los: LOS_OFF });
    assert.deepEqual(ops(plan.pre), ['los', 'settle', 'pause']);
    assert.equal(plan.pre.find((s) => s.op === 'settle').ms, DEFAULT_STREAM_SETTLE_MS);
});

test('nothing world-changing means no settle dwell is spent', () => {
    const plan = planCapture({ unitId: 7, reveal: false },
        { simPaused: false, los: LOS_OFF });
    assert.deepEqual(ops(plan.pre), ['pause']);
});

test('spawning enables cheats only when they were off, and turns them back off', () => {
    const on = planCapture({ def: 'x', spawn: { x: 0, z: 0 } },
        { simPaused: false, los: LOS_ON, cheatsOn: true });
    assert.ok(!ops(on.pre).includes('cheats'));
    assert.ok(!ops(on.post).includes('cheats'));

    const off = planCapture({ def: 'x', spawn: { x: 0, z: 0 } },
        { simPaused: false, los: LOS_ON, cheatsOn: false });
    assert.equal(off.pre[0].op, 'cheats');
    assert.equal(off.pre[0].enable, true);
    assert.ok(off.post.some((s) => s.op === 'cheats' && s.enable === false));
});

// ── planCapture: restore discipline ──────────────────────────────────────

test('a sim that was ALREADY paused is never resumed by us', () => {
    const plan = planCapture({ unitId: 7 }, { simPaused: true, los: LOS_ON });
    assert.ok(!ops(plan.pre).includes('pause'));
    assert.ok(!ops(plan.post).includes('pause'));
    assert.match(plan.notes.join(' '), /already paused/);
});

test('LOS that was already on is never turned off by us', () => {
    const plan = planCapture({ unitId: 7 }, { simPaused: false, los: LOS_ON });
    assert.ok(!ops(plan.pre).includes('los'));
    assert.ok(!ops(plan.post).includes('los'));
    assert.match(plan.notes.join(' '), /already on/);
});

test('an unreadable LOS state is left alone, loudly', () => {
    const plan = planCapture({ unitId: 7 }, { simPaused: false, los: LOS_UNKNOWN });
    assert.ok(!ops(plan.pre).includes('los'));
    assert.match(plan.notes.join(' '), /could not be read/);
});

test('reveal:false never touches LOS even when the map is fogged', () => {
    const plan = planCapture({ unitId: 7, reveal: false },
        { simPaused: false, los: LOS_OFF });
    assert.ok(!ops(plan.pre).includes('los'));
});

test('pause:false never touches the sim', () => {
    const plan = planCapture({ unitId: 7, pause: false },
        { simPaused: false, los: LOS_ON });
    assert.deepEqual(plan.pre, []);
    assert.deepEqual(plan.post, []);
});

test('restores run in reverse order of application', () => {
    const plan = planCapture({ def: 'x', spawn: { x: 0, z: 0 } },
        { simPaused: false, los: LOS_OFF, cheatsOn: false });
    assert.deepEqual(ops(plan.pre), ['cheats', 'spawn', 'los', 'settle', 'pause']);
    // Unpause first, then drop the reveal, then drop cheats.
    assert.deepEqual(ops(plan.post), ['pause', 'los', 'cheats']);
});

test('describePlan reads as the sequence that actually ran', () => {
    const plan = planCapture({ unitId: 7 }, { simPaused: false, los: LOS_OFF });
    assert.equal(describePlan(plan),
        'los on → wait 600ms for the stream → pause sim → capture → resume sim → los off');
});

// ── buildHarnessCall ─────────────────────────────────────────────────────

test('buildHarnessCall emits a bare harness expression (the relay adds no prefix)', () => {
    const call = buildHarnessCall({ unitId: 42, angle: 'front' });
    assert.match(call, /^captureSubject\(\{/);
    assert.deepEqual(JSON.parse(call.slice('captureSubject('.length, -1)),
        { unitId: 42, angle: 'front', revealed: false });
});

test('buildHarnessCall forwards only the keys the harness understands', () => {
    const spec = JSON.parse(buildHarnessCall({
        def: 'ms_subs_s4', pause: true, reveal: true, roomId: 3, spawn: { x: 1, z: 2 },
    }).slice('captureSubject('.length, -1));
    assert.deepEqual(Object.keys(spec).sort(), ['def', 'revealed']);
});

test('buildHarnessCall clamps maxDim to the wire cap', () => {
    const big = JSON.parse(buildHarnessCall({ unitId: 1, maxDim: 9999 })
        .slice('captureSubject('.length, -1));
    assert.equal(big.maxDim, 2048);
    const small = JSON.parse(buildHarnessCall({ unitId: 1, maxDim: 1 })
        .slice('captureSubject('.length, -1));
    assert.equal(small.maxDim, 64);
});

test('buildHarnessCall tells the harness whether WE revealed LOS', () => {
    const spec = JSON.parse(buildHarnessCall({ unitId: 1, __revealed: true })
        .slice('captureSubject('.length, -1));
    assert.equal(spec.revealed, true);
});

// ── formatCaptureMeta ────────────────────────────────────────────────────

const RESULT = {
    ok: true, diagnosis: null, warnings: [],
    subject: {
        kind: 'unit', unitId: 42, unitIds: [42], def: null,
        sphere: { x: 1000, y: -40, z: 2000, radius: 260 },
        metresAcross: 65, hasModel: true,
    },
    framing: { angle: 'three-quarter', yawDeg: -45, pitchDeg: 30, fill: 0.7, distance: 880 },
    attempts: [{}],
    gameFrame: 1234, frameId: 900, width: 1280, height: 800,
};

test('a usable capture leads with OK and reports the subject size in metres', () => {
    const text = formatCaptureMeta(RESULT, { clientId: 1, plan: 'pause sim → capture' });
    assert.match(text.split('\n')[0], /^capture: OK/);
    assert.match(text, /65\.0 m across/);
    assert.match(text, /model=loaded/);
    assert.match(text, /three-quarter/);
});

test('an unusable capture says so on the FIRST line, before anything else', () => {
    const text = formatCaptureMeta({
        ...RESULT, ok: false, diagnosis: 'every one of 3 framing attempts returned a near-black frame',
    });
    assert.match(text.split('\n')[0], /UNUSABLE/);
    assert.match(text.split('\n')[0], /do not trust the image/);
    assert.match(text, /diagnosis: every one of 3/);
});

test('a fallback-shape subject is called out in the metadata', () => {
    const text = formatCaptureMeta({
        ...RESULT,
        subject: { ...RESULT.subject, hasModel: false },
        warnings: ['procedural FALLBACK shape — this def has no model loaded'],
    });
    assert.match(text, /model=FALLBACK/);
    assert.match(text, /warning: procedural FALLBACK/);
});

test('a retried capture shows the luminance trail', () => {
    const text = formatCaptureMeta({
        ...RESULT,
        attempts: [{ stats: { mean: 0.4 } }, { stats: { mean: 96.2 } }],
    });
    assert.match(text, /attempts: 2 \(luminance 0\.4 → 96\.2\)/);
});

test('plan notes reach the caller', () => {
    const text = formatCaptureMeta(RESULT, { notes: ['sim was already paused — left as found'] });
    assert.match(text, /note: sim was already paused/);
});
