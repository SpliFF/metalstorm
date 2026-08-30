// The ordering and verdict rules for capture_sequence / step_sim /
// order_and_film, pinned.
//
// Like capture-subject.test.js these encode failures rather than style: a
// settle shrunk to nothing by applying slow motion too early, a "film" that is
// one pose photographed N times, an onset poll that misses a 180° turn because
// it only watched translation.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_SEQUENCE_FRAMES,
    DEFAULT_STRIDE_FRAMES,
    GAME_SPEED,
    HEADING_UNITS_PER_TURN,
    MAX_SEQUENCE_FRAMES,
    buildSequenceHarnessCall,
    describeSequencePlan,
    extForMime,
    formatSequenceMeta,
    frameFileName,
    motionBetween,
    motionOnset,
    planSequence,
    resolveSequenceShape,
    sanitiseName,
    realtimeBudgetError,
    estimateBurstMs,
    REALTIME_BURST_BUDGET_MS,
    sequenceRelayTimeoutMs,
    stepTimeoutMs,
    summariseShots,
    totalTurnDegrees,
    validateSequenceArgs,
} from './capture-sequence.js';
import { planCapture } from './capture-subject.js';

const LOS_ON = { known: true, teams: [true, true], allOn: true, anyOn: true };
const LOS_OFF = { known: true, teams: [false, false], allOn: false, anyOn: false };
const ops = (steps) => steps.map((s) => s.op);
const deg = (d) => Math.round(d * (HEADING_UNITS_PER_TURN / 360));

// ── argument validation ────────────────────────────────────────────────

test('a sequence needs exactly one subject', () => {
    assert.match(validateSequenceArgs({}), /needs a subject/);
    assert.match(validateSequenceArgs({ def: 'ms_tanks_s2', unitId: 7 }), /ONE subject/);
    assert.equal(validateSequenceArgs({ def: 'ms_tanks_s2' }), null);
});

test('one frame is a capture_subject, and the error says so', () => {
    assert.match(validateSequenceArgs({ unitId: 1, frames: 1 }), /capture_subject/);
    assert.equal(validateSequenceArgs({ unitId: 1, frames: 2 }), null);
});

test('a bad mode names both modes rather than just refusing', () => {
    const err = validateSequenceArgs({ unitId: 1, mode: 'burst' });
    assert.match(err, /step/);
    assert.match(err, /realtime/);
});

test('realtime mode refuses a stopped sim — there is no interval to pace by', () => {
    assert.match(validateSequenceArgs({ unitId: 1, mode: 'realtime', simSpeed: 0 }),
        /positive simSpeed/);
});

test('simSpeed is held to the speed verb\'s own range', () => {
    assert.match(validateSequenceArgs({ unitId: 1, simSpeed: 0.001 }), /0\.05/);
    assert.match(validateSequenceArgs({ unitId: 1, simSpeed: 500 }), /100/);
});

// ── shape ──────────────────────────────────────────────────────────────

test('shape defaults to a stepped burst and clamps the extremes', () => {
    const s = resolveSequenceShape({});
    assert.equal(s.mode, 'step');
    assert.equal(s.frames, DEFAULT_SEQUENCE_FRAMES);
    assert.equal(s.stride, DEFAULT_STRIDE_FRAMES);
    assert.equal(s.simSpeed, undefined);   // stepping does not need slow motion
    assert.equal(resolveSequenceShape({ frames: 9999 }).frames, MAX_SEQUENCE_FRAMES);
    assert.equal(resolveSequenceShape({ frames: 1 }).frames, 2);
    assert.equal(resolveSequenceShape({ everyNthSimFrame: 0 }).stride, 1);
});

test('realtime mode slows the sim by default — that is its whole mechanism', () => {
    assert.equal(resolveSequenceShape({ mode: 'realtime' }).simSpeed, 0.1);
    assert.equal(resolveSequenceShape({ mode: 'realtime', simSpeed: 0.25 }).simSpeed, 0.25);
});

// ── the plan ───────────────────────────────────────────────────────────

test('slow motion is applied AFTER the settle, never before', () => {
    // A 600 ms wall settle at 0.1x is under two sim frames — i.e. no settle.
    const plan = planCapture(
        { def: 'ms_tanks_s2', spawn: { x: 100, z: 100 }, simSpeed: 0.1 },
        { simPaused: false, los: LOS_OFF, cheatsOn: false, simSpeed: 1 });
    const order = ops(plan.pre);
    assert.deepEqual(order, ['cheats', 'spawn', 'los', 'settle', 'speed']);
    assert.ok(order.indexOf('settle') < order.indexOf('speed'));
});

test('asking for slow motion drops the default pause, and says which won', () => {
    const plan = planCapture({ unitId: 4, simSpeed: 0.1 },
        { simPaused: false, los: LOS_ON, simSpeed: 1 });
    assert.ok(!ops(plan.pre).includes('pause'));
    assert.match(plan.notes.join(' '), /not paused/i);
    assert.match(plan.notes.join(' '), /pause:true/);
});

test('an explicit pause:true still wins over simSpeed', () => {
    const plan = planCapture({ unitId: 4, simSpeed: 0.1, pause: true },
        { simPaused: false, los: LOS_ON, simSpeed: 1 });
    assert.ok(ops(plan.pre).includes('pause'));
});

test('the speed we found is the speed we restore', () => {
    const plan = planCapture({ unitId: 4, simSpeed: 0.1 },
        { simPaused: false, los: LOS_ON, simSpeed: 2 });
    const restore = plan.post.find((s) => s.op === 'speed');
    assert.equal(restore.value, 2);
});

test('an unreadable prior speed is restored to 1x, loudly', () => {
    const plan = planCapture({ unitId: 4, simSpeed: 0.1 },
        { simPaused: false, los: LOS_ON });
    assert.equal(plan.post.find((s) => s.op === 'speed').value, 1);
    assert.match(plan.notes.join(' '), /could not be read/);
});

test('a speed that is already what we want is left alone', () => {
    const plan = planCapture({ unitId: 4, simSpeed: 0.1 },
        { simPaused: false, los: LOS_ON, simSpeed: 0.1 });
    assert.ok(!ops(plan.pre).includes('speed'));
    assert.ok(!ops(plan.post).includes('speed'));
    assert.match(plan.notes.join(' '), /already 0\.1/);
});

test('step mode pauses (that IS the mechanism); realtime mode must not', () => {
    const stepped = planSequence({ unitId: 4 },
        { simPaused: false, los: LOS_ON, simSpeed: 1 });
    assert.ok(ops(stepped.pre).includes('pause'));
    assert.ok(stepped.post.some((s) => s.op === 'pause' && s.paused === false));

    const live = planSequence({ unitId: 4, mode: 'realtime' },
        { simPaused: false, los: LOS_ON, simSpeed: 1 });
    assert.ok(!ops(live.pre).includes('pause'));
    assert.ok(ops(live.pre).includes('speed'));
});

test('a sim that was already paused is left paused after a stepped sequence', () => {
    const plan = planSequence({ unitId: 4 },
        { simPaused: true, los: LOS_ON, simSpeed: 1 });
    assert.ok(!plan.post.some((s) => s.op === 'pause'));
    assert.match(plan.notes.join(' '), /already paused/);
});

test('the plan line names the per-shot loop, not just the setup', () => {
    const plan = planSequence({ unitId: 4, frames: 8, everyNthSimFrame: 5 },
        { simPaused: false, los: LOS_OFF, simSpeed: 1 });
    const line = describeSequencePlan(plan);
    assert.match(line, /8× \(capture → sim_step 5\)/);
    assert.match(line, /los on/);
    assert.match(line, /pause sim/);
    assert.match(line, /resume sim/);
});

test('the realtime plan line reports the interval it will actually sleep', () => {
    const plan = planSequence({ unitId: 4, mode: 'realtime', everyNthSimFrame: 3, simSpeed: 0.1 },
        { simPaused: false, los: LOS_ON, simSpeed: 1 });
    // 3 frames / (30 Hz x 0.1) = 1 second.
    assert.match(plan.notes.join(' '), /1000 ms apart/);
});

// ── timeouts ───────────────────────────────────────────────────────────

test('a step timeout scales with the frames asked for and the speed set', () => {
    assert.ok(stepTimeoutMs(3, 1) < stepTimeoutMs(300, 1));
    // Stepping is paced by the CURRENT speed, so slow motion needs longer.
    assert.ok(stepTimeoutMs(30, 0.1) > stepTimeoutMs(30, 1));
    assert.ok(stepTimeoutMs(100000, 0.05) <= 60000);
});

test('a realtime burst gets a relay budget covering the whole sequence', () => {
    // 12 shots, 3 frames apart, at 0.1x is 12 s of wall time.
    assert.ok(sequenceRelayTimeoutMs(12, 3, 0.1) >= 32000);
    assert.ok(sequenceRelayTimeoutMs(2, 3, 1) >= 45000);   // floor
    assert.ok(sequenceRelayTimeoutMs(60, 30, 0.05) <= 300000);
});

// ── motion onset ───────────────────────────────────────────────────────

const at = (frame, x, z, heading) => ({ frame, pos: { x, z }, heading });

test('translation onset is measured in elmos per GAME second', () => {
    // 10 elmos over 3 frames = 100 elmo/s.
    const m = motionBetween(at(0, 0, 0, 0), at(3, 10, 0, 0));
    assert.equal(m.frames, 3);
    assert.ok(Math.abs(m.speed - 100) < 1e-6);
    assert.equal(m.turnRateDegPerSec, 0);
});

test('a tank turning ON THE SPOT counts as moving — heading is the only channel', () => {
    // 30° of turn over 3 frames, no translation at all.
    const o = motionOnset(at(0, 0, 0, 0), at(3, 0, 0, deg(30)));
    assert.ok(Math.abs(o.speed) < 1e-6);
    assert.ok(Math.abs(o.turnRateDegPerSec - 300) < 1);
    assert.equal(o.moving, true, 'a 180° course change must not read as stationary');
});

test('a heading that wraps is a small turn, not a 359° one', () => {
    const m = motionBetween(at(0, 0, 0, deg(-10)), at(GAME_SPEED, 0, 0, deg(10)));
    assert.ok(Math.abs(m.turnRateDegPerSec - 20) < 1);
});

test('a stationary unit is not moving, and neither is a zero-length interval', () => {
    assert.equal(motionOnset(at(0, 0, 0, 0), at(3, 0, 0, 0)).moving, false);
    assert.equal(motionOnset(at(5, 0, 0, 0), at(5, 99, 99, 0)).moving, false);
    assert.equal(motionOnset(at(5, 0, 0, 0), at(5, 99, 99, 0)).frames, 0);
});

test('onset thresholds are overridable and reported back', () => {
    const slow = at(3, 1, 0, 0);   // 1 elmo over 3 frames = 10 elmo/s
    assert.equal(motionOnset(at(0, 0, 0, 0), slow).moving, true);
    const strict = motionOnset(at(0, 0, 0, 0), slow, { speedThreshold: 1000, turnThreshold: 1000 });
    assert.equal(strict.moving, false);
    assert.equal(strict.speedThreshold, 1000);
});

test('a 180° course change totals 180°, whichever way it wrapped', () => {
    const samples = [
        at(0, 0, 0, deg(0)), at(30, 0, 0, deg(60)),
        at(60, 0, 0, deg(120)), at(90, 0, 0, deg(180)),
    ];
    assert.ok(Math.abs(totalTurnDegrees(samples) - 180) < 2);
});

// ── output naming ──────────────────────────────────────────────────────

test('frame files sort lexicographically in capture order', () => {
    const names = [frameFileName(0, 100), frameFileName(9, 127), frameFileName(10, 130)];
    assert.deepEqual([...names].sort(), names);
    assert.equal(frameFileName(2, 55, 'png'), 'f002-frame55.png');
});

test('a sequence name never escapes its directory', () => {
    assert.equal(sanitiseName('../../etc/passwd'), 'etc-passwd');
    assert.equal(sanitiseName('  M1 Turn Arc!  '), 'm1-turn-arc');
    assert.equal(sanitiseName('shot.jpg'), 'shot-jpg');
    assert.equal(sanitiseName(''), 'sequence');
    assert.equal(sanitiseName(undefined, 'seq'), 'seq');
});

test('the extension follows the mime type the browser actually returned', () => {
    assert.equal(extForMime('image/png'), 'png');
    assert.equal(extForMime('image/jpeg'), 'jpg');
});

// ── the harness call ───────────────────────────────────────────────────

test('the realtime burst call carries the shape and the reveal truth', () => {
    const call = buildSequenceHarnessCall(
        { def: 'ms_mech', angle: 'side', __revealed: true },
        { frames: 8, stride: 2, simSpeed: 0.1 });
    assert.match(call, /^captureSequence\(/);
    const spec = JSON.parse(call.slice('captureSequence('.length, -1));
    assert.equal(spec.def, 'ms_mech');
    assert.equal(spec.angle, 'side');
    assert.equal(spec.frames, 8);
    assert.equal(spec.everyNthSimFrame, 2);
    assert.equal(spec.simSpeed, 0.1);
    assert.equal(spec.revealed, true);
});

// ── the metadata block ─────────────────────────────────────────────────

const OK_RESULT = {
    ok: true, mode: 'step',
    requested: { frames: 3, everyNthSimFrame: 3, simSpeed: undefined },
    subject: { def: 'ms_tanks_s2', kind: 'def', unitId: 12, metresAcross: 11.5, hasModel: true },
    summary: {
        ok: true, distinctGameFrames: 3, simFramesSpanned: 6,
        frameDeltas: [3, 3], wallMs: 4200, warnings: [], diagnosis: null,
    },
    shots: [{}, {}, {}],
    files: [
        { index: 0, gameFrame: 100, deltaFrames: 0, mean: 90, black: false, path: '/tmp/s/f000.jpg' },
        { index: 1, gameFrame: 103, deltaFrames: 3, mean: 91, black: false, path: '/tmp/s/f001.jpg' },
    ],
    warnings: [],
};

test('the metadata leads with the verdict and carries the file paths', () => {
    const text = formatSequenceMeta(OK_RESULT, { plan: 'los on → pause sim', clientId: 3 });
    assert.match(text.split('\n')[0], /^sequence: OK — 3 frames/);
    assert.match(text, /delivered: 3 distinct server frames spanning 6 sim frames/);
    assert.match(text, /f000\.jpg/);
    assert.match(text, /clientId: 3/);
});

test('a still life leads with UNUSABLE, not with a picture count', () => {
    const text = formatSequenceMeta({
        ...OK_RESULT, ok: false,
        summary: { ...OK_RESULT.summary, ok: false, distinctGameFrames: 1,
                   simFramesSpanned: 0, frameDeltas: [0, 0],
                   diagnosis: 'the sim did not advance between shots' },
    });
    assert.match(text.split('\n')[0], /^sequence: UNUSABLE/);
    assert.match(text, /did not advance/);
});

test('the onset wait is reported, including when it never came', () => {
    const text = formatSequenceMeta({
        ...OK_RESULT,
        onset: { waitedMs: 1200, polls: 4, moving: true, speed: 42.5, turnRateDegPerSec: 88.1 },
        turnDegrees: 179.4,
    });
    assert.match(text, /motion onset: waited 1200 ms \/ 4 poll\(s\)/);
    assert.match(text, /turning 88\.1°\/s/);
    assert.match(text, /turned 179\.4°/);

    const never = formatSequenceMeta({
        ...OK_RESULT,
        onset: { waitedMs: 8000, polls: 20, moving: false, speed: 0, turnRateDegPerSec: 0 },
    });
    assert.match(never, /NEVER started moving; filmed anyway/);
});


// ── the verdict the tool reports from ──────────────────────────────────

const sh = (index, gameFrame, atMs, black = false) => ({
    index, gameFrame, atMs,
    stats: { min: 0, max: 200, mean: black ? 2 : 90 },
    verdict: { black, flat: false, mean: black ? 2 : 90, contrast: 200, reason: null },
});

test('a sequence whose frames advance is OK', () => {
    const s = summariseShots([sh(0, 100, 0), sh(1, 103, 1200), sh(2, 106, 2400)],
        { expectedStride: 3, mode: 'step' });
    assert.equal(s.ok, true);
    assert.equal(s.diagnosis, null);
    assert.deepEqual(s.frameDeltas, [3, 3]);
    assert.equal(s.simFramesSpanned, 6);
    assert.equal(s.wallMs, 2400);
    assert.deepEqual(s.warnings, []);
});

test('N shots of one rendered frame is a still life and must NOT pass', () => {
    const s = summariseShots([sh(0, 77, 0), sh(1, 77, 900), sh(2, 77, 1800)],
        { expectedStride: 3, mode: 'step' });
    assert.equal(s.ok, false);
    assert.equal(s.distinctGameFrames, 1);
    assert.match(s.diagnosis, /same instant/);
    assert.match(s.diagnosis, /step_sim reports/);
});

// The one that would otherwise pass silently: the SERVER stepped exactly as
// asked, and the browser never received a single new snapshot. Spacing looks
// perfect; every image is the same picture.
test('a stepped sim whose client never moved is caught, not congratulated', () => {
    const stepped = [
        { ...sh(0, 100, 0), clientFrame: 99 },
        { ...sh(1, 109, 900), clientFrame: 99 },
        { ...sh(2, 118, 1800), clientFrame: 99 },
    ];
    const s = summariseShots(stepped, { expectedStride: 9, mode: 'step' });
    assert.equal(s.ok, false);
    assert.deepEqual(s.frameDeltas, [9, 9], 'server spacing was exact…');
    assert.match(s.diagnosis, /same instant/, '…and the pictures still never changed');
});

test('a client that follows the steps passes on its own frames', () => {
    const s = summariseShots([
        { ...sh(0, 100, 0), clientFrame: 99 },
        { ...sh(1, 109, 900), clientFrame: 108 },
        { ...sh(2, 118, 1800), clientFrame: 117 },
    ], { expectedStride: 9, mode: 'step' });
    assert.equal(s.ok, true);
    assert.equal(s.distinctGameFrames, 3);
});

test('an all-black sequence fails; a partly black one warns', () => {
    const all = summariseShots([sh(0, 100, 0, true), sh(1, 103, 100, true)]);
    assert.equal(all.ok, false);
    assert.match(all.diagnosis, /black/);
    const some = summariseShots([sh(0, 100, 0), sh(1, 103, 100, true), sh(2, 106, 200)]);
    assert.equal(some.ok, true);
    assert.deepEqual(some.blackFrames, [1]);
    assert.match(some.warnings.join(' '), /1 of 3/);
});

test('uneven spacing is blamed on the mode that produced it', () => {
    assert.match(
        summariseShots([sh(0, 100, 0), sh(1, 112, 1), sh(2, 115, 2)],
            { expectedStride: 3, mode: 'step' }).warnings.join(' '),
        /step did not land/);
    assert.match(
        summariseShots([sh(0, 100, 0), sh(1, 112, 1), sh(2, 115, 2)],
            { expectedStride: 3, mode: 'realtime' }).warnings.join(' '),
        /wall-clock pacing/);
});

test('an empty sequence says so instead of dividing by zero', () => {
    const s = summariseShots([]);
    assert.equal(s.ok, false);
    assert.match(s.diagnosis, /no frames/);
});


// ── the relay ceiling on a realtime burst ──────────────────────────────

test('a burst that fits the relay budget is allowed', () => {
    // 12 shots, 3 frames apart at 0.25x = 400 ms each ≈ 6.0 s.
    assert.ok(estimateBurstMs(12, 3, 0.25) <= REALTIME_BURST_BUDGET_MS);
    assert.equal(realtimeBudgetError(12, 3, 0.25), null);
});

test('a full walk cycle at 0.1x is refused BEFORE the shoot, naming step mode', () => {
    // The case that actually failed live: 12 shots 1 s apart is 12 s inside one
    // relay call, and the reply is abandoned — every frame lost, silently.
    const err = realtimeBudgetError(12, 3, 0.1);
    assert.ok(err, 'a 12 s burst must not be attempted');
    assert.match(err, /8 s/);
    assert.match(err, /mode:"step"/);
    assert.match(err, /every frame lost/);
});

test('the refusal shows the arithmetic, not just a verdict', () => {
    const err = realtimeBudgetError(20, 6, 0.1);
    assert.match(err, /20 shots/);
    assert.match(err, /2000 ms apart/);
});
