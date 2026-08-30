// capture_sequence / step_sim / order_and_film — the server-side half of the
// "film a manoeuvre" primitives (ai-visual-debug V2).
//
// V1 (`capture_subject`) removed the camera-vs-shutter race for a POSE. The
// defects this file exists for are not poses: a tank's turn arc, a turret slew
// mid-motion, a walk clip mid-stride, a tracer in flight beside a hull. None
// of them is capturable at speed 1 with multi-second relay latency, and a hard
// pause deletes the very thing under inspection.
//
// Three ordering facts on top of V1's three, each of which changes what comes
// back:
//
//  1. **Slow motion goes on AFTER the settle, not before.** The settle exists
//     to let a spawn/reveal reach the browser, and it is measured in WALL
//     milliseconds. At 0.1× a 600 ms settle is under two sim frames — i.e. no
//     settle at all. Slow first, and you photograph the empty ground V1's
//     finding 1 warned about, for a completely different reason.
//
//  2. **`simSpeed` and `pause` are contradictory, so asking for one drops the
//     other.** Slow motion exists to keep the subject MOVING through the
//     capture; pausing is how you stop it. `capture_subject({simSpeed})`
//     therefore does not pause unless the caller says `pause:true` outright,
//     and says so in the plan rather than silently ignoring one of them.
//
//  3. **Step mode's spacing is exact; realtime mode's is nominal.** In step
//     mode the sim is stopped and advanced by `sim_step` between shots, so the
//     interval is what was asked for however long the camera took — that is
//     what makes the frames measurable evidence. In realtime mode the burst is
//     paced by a wall clock against a running sim, and the delivered spacing is
//     reported rather than assumed.
//
// Everything here is pure — server.js executes the plan.

import { planCapture } from './capture-subject.js';

/** Sim frames per game-second. Matches GAME_SPEED on the server. */
export const GAME_SPEED = 30;

/** Spring stores heading as a 16-bit angle: 65536 units to a full turn. */
export const HEADING_UNITS_PER_TURN = 65536;

export const DEFAULT_SEQUENCE_FRAMES = 6;
export const DEFAULT_STRIDE_FRAMES = 3;
export const MAX_SEQUENCE_FRAMES = 60;

/** `sim_step`'s own ceiling (rts/Server/SimStep.h). Mirrored so a bad request
 *  is refused here with an explanation instead of silently clamped there. */
export const MAX_STEP_FRAMES = 3000;

/** How long to wait for `sim_step` to actually land, per frame requested, plus
 *  a floor. Stepping is paced by the CURRENT speed factor — the tick loop
 *  still sleeps its interval per frame — so N frames at 0.1× is N/3 seconds. */
export function stepTimeoutMs(frames, simSpeed = 1) {
    const spd = Number.isFinite(simSpeed) && simSpeed > 0 ? simSpeed : 1;
    return Math.min(60000, 1500 + Math.ceil((frames / (GAME_SPEED * spd)) * 1000 * 2));
}

/** Relay budget for a realtime burst: the browser sleeps the whole sequence
 *  inside one evaluation, so the timeout has to cover it. */
export function sequenceRelayTimeoutMs(frames, stride, simSpeed) {
    const spd = Number.isFinite(simSpeed) && simSpeed > 0 ? simSpeed : 1;
    const spanMs = (frames * stride) / (GAME_SPEED * spd) * 1000;
    return Math.min(300000, Math.max(45000, Math.ceil(spanMs * 1.5) + 20000));
}

// ── Argument validation ────────────────────────────────────────────────

const SUBJECT_KEYS = ['unitId', 'unitIds', 'def', 'position', 'area'];

export function validateSequenceArgs(args = {}) {
    const given = SUBJECT_KEYS.filter((k) => args[k] !== undefined && args[k] !== null);
    if (given.length === 0) {
        return 'capture_sequence needs a subject: unitId, unitIds, def, position {x,z} or area {x1,z1,x2,z2}.';
    }
    if (given.length > 1) {
        return `capture_sequence takes ONE subject; got ${given.join(' + ')}.`;
    }
    if (args.frames !== undefined
        && (!Number.isFinite(args.frames) || args.frames < 2)) {
        return 'frames must be a number ≥ 2 — one shot is a capture_subject, not a sequence.';
    }
    if (args.everyNthSimFrame !== undefined
        && (!Number.isFinite(args.everyNthSimFrame) || args.everyNthSimFrame < 1)) {
        return 'everyNthSimFrame must be a whole number ≥ 1.';
    }
    if (args.mode !== undefined && args.mode !== 'step' && args.mode !== 'realtime') {
        return `mode must be "step" (exact spacing, stepped sim) or "realtime" (slow-mo burst); got "${args.mode}".`;
    }
    if (args.mode === 'realtime' && args.simSpeed !== undefined
        && (!Number.isFinite(args.simSpeed) || args.simSpeed <= 0)) {
        return 'realtime mode needs a positive simSpeed — a stopped sim has no wall-clock interval to pace by.';
    }
    if (args.simSpeed !== undefined
        && (!Number.isFinite(args.simSpeed) || args.simSpeed < 0.05 || args.simSpeed > 100)) {
        return 'simSpeed must be between 0.05 and 100 (the `speed` verb\'s own range).';
    }
    return null;
}

/** Normalise the burst shape, clamping to what can actually be delivered. */
export function resolveSequenceShape(args = {}) {
    const frames = Math.max(2, Math.min(MAX_SEQUENCE_FRAMES,
        Math.floor(Number.isFinite(args.frames) ? args.frames : DEFAULT_SEQUENCE_FRAMES)));
    const stride = Math.max(1, Math.min(MAX_STEP_FRAMES,
        Math.floor(Number.isFinite(args.everyNthSimFrame)
            ? args.everyNthSimFrame : DEFAULT_STRIDE_FRAMES)));
    const mode = args.mode === 'realtime' ? 'realtime' : 'step';
    // Slow motion is the realtime mode's whole mechanism, so it gets a default
    // there. Step mode does not need it (the sim is stopped between shots) and
    // only honours an explicit request — usually because the caller wants the
    // *client's* wall-clock-driven animation to crawl too.
    const simSpeed = Number.isFinite(args.simSpeed) ? args.simSpeed
        : mode === 'realtime' ? 0.1 : undefined;
    return { frames, stride, mode, simSpeed };
}

/**
 * The ordered plan for a sequence.
 *
 * Delegates the spawn / reveal / settle / speed / pause ordering to
 * `planCapture` — it is the same ordering and duplicating it is how the two
 * drift — and adds the per-shot loop on top.
 */
export function planSequence(args = {}, state = {}) {
    const shape = resolveSequenceShape(args);
    const base = planCapture({
        ...args,
        simSpeed: shape.simSpeed,
        // Step mode films from a STOP: pause is the mechanism, not a side
        // effect. Realtime mode must not pause — that is the still life.
        pause: shape.mode === 'step',
    }, state);
    const notes = [...base.notes];
    if (shape.mode === 'step') {
        notes.push(`step mode: ${shape.frames} shots, sim_step ${shape.stride}`
            + ' between each — spacing is EXACT regardless of camera latency');
    } else {
        notes.push(`realtime mode: one browser-side burst of ${shape.frames} shots`
            + ` ~${(shape.stride / (GAME_SPEED * (shape.simSpeed ?? 1)) * 1000).toFixed(0)} ms apart`
            + ' — spacing is nominal; the delivered sim-frame deltas are reported');
    }
    return { ...base, notes, ...shape };
}

// ── Motion onset (order_and_film) ──────────────────────────────────────

/**
 * Did the unit start moving between these two samples?
 *
 * The gap `order_and_film` closes is the one between "order given" and "camera
 * ready": a MOVE order takes a beat to become motion (pathing, spin-up, the
 * command queue), and a burst that starts on the ack photographs a stationary
 * hull, while one that starts on a fixed sleep has already missed the interesting
 * part. So: poll, and start on the first sample that is actually moving.
 *
 * BOTH translation and rotation count, and rotation is not the afterthought —
 * a tank executing a 180° course change on the spot barely translates at all,
 * and heading is the only channel that shows the turn. `unit_state` carries no
 * velocity, so both rates are differences between consecutive samples.
 *
 * `a` and `b` are `unit_state` replies plus the frame they were read at:
 * `{frame, pos:{x,z}, heading}`.
 */
export function motionBetween(a, b) {
    const df = (b?.frame ?? 0) - (a?.frame ?? 0);
    if (!(df > 0)) return { frames: 0, speed: 0, turnRateDegPerSec: 0, moving: false };
    const dtSec = df / GAME_SPEED;
    const dx = (b.pos?.x ?? 0) - (a.pos?.x ?? 0);
    const dz = (b.pos?.z ?? 0) - (a.pos?.z ?? 0);
    const speed = Math.hypot(dx, dz) / dtSec;
    // Heading is modular: a turn through the wrap point is a small delta, not
    // a 359° one. Reduce into (−half, +half] before scaling to degrees.
    const half = HEADING_UNITS_PER_TURN / 2;
    let dh = ((b.heading ?? 0) - (a.heading ?? 0)) % HEADING_UNITS_PER_TURN;
    if (dh > half) dh -= HEADING_UNITS_PER_TURN;
    if (dh <= -half) dh += HEADING_UNITS_PER_TURN;
    const turnRateDegPerSec = Math.abs(dh) * (360 / HEADING_UNITS_PER_TURN) / dtSec;
    return { frames: df, speed, turnRateDegPerSec, moving: false };
}

/** Default onset thresholds. Deliberately low: the question is "has it started",
 *  not "is it at speed", and starting late loses the acceleration. */
export const DEFAULT_SPEED_THRESHOLD = 2;      // elmos per game-second
export const DEFAULT_TURN_THRESHOLD = 5;       // degrees per game-second

export function motionOnset(a, b, opts = {}) {
    const m = motionBetween(a, b);
    const speedThreshold = Number.isFinite(opts.speedThreshold)
        ? opts.speedThreshold : DEFAULT_SPEED_THRESHOLD;
    const turnThreshold = Number.isFinite(opts.turnThreshold)
        ? opts.turnThreshold : DEFAULT_TURN_THRESHOLD;
    const moving = m.frames > 0
        && (m.speed >= speedThreshold || m.turnRateDegPerSec >= turnThreshold);
    return { ...m, moving, speedThreshold, turnThreshold };
}

/** Total heading change over an ordered list of samples, following the short
 *  way round each step — so a 180° course change reads as 180, not as whatever
 *  the raw endpoints happen to subtract to. */
export function totalTurnDegrees(samples = []) {
    let total = 0;
    for (let i = 1; i < samples.length; i++) {
        const m = motionBetween(samples[i - 1], samples[i]);
        total += m.turnRateDegPerSec * (m.frames / GAME_SPEED);
    }
    return total;
}

// ── Output files ───────────────────────────────────────────────────────

/**
 * A sequence's frames go to DISK, not down the wire.
 *
 * The relay's 4 MB cap is per message; a 12-frame burst returned as 12 MCP
 * image blocks is a reply nobody receives. So every frame is written to a file
 * and the tool answers with paths plus the numbers — and inlines at most a
 * couple of frames for the caller who just wants to glance.
 */
export function sanitiseName(name, fallback = 'sequence') {
    // No dots in the allowed set, deliberately: the frame writer appends its
    // own extension, and letting `.` through is what turns a caller-supplied
    // label into `../../somewhere`. Every disallowed run collapses to one
    // dash, so a traversal attempt reduces to its harmless tail.
    const s = String(name ?? '').trim().toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
    return s || fallback;
}

export function frameFileName(index, gameFrame, ext = 'jpg') {
    const i = String(index).padStart(3, '0');
    return `f${i}-frame${gameFrame}.${ext}`;
}

export function extForMime(mime) {
    return String(mime).includes('png') ? 'png' : 'jpg';
}

// ── Reporting ──────────────────────────────────────────────────────────

/** The plan, as one line, with the two V2 steps named. */
export function describeSequencePlan(plan) {
    const step = (s) => {
        switch (s.op) {
            case 'cheats': return `cheats ${s.enable ? 'on' : 'off'}`;
            case 'spawn':  return `spawn ${s.def}×${s.count} @ ${s.x},${s.z} (team ${s.team})`;
            case 'los':    return `los ${s.enable ? 'on' : 'off'}`;
            case 'settle': return `wait ${s.ms}ms for the stream`;
            case 'speed':  return `speed ${s.value}×`;
            case 'pause':  return s.paused ? 'pause sim' : 'resume sim';
            default:       return s.op;
        }
    };
    const middle = plan.mode === 'step'
        ? `${plan.frames}× (capture → sim_step ${plan.stride})`
        : `burst ${plan.frames} shots (browser-side)`;
    return [...plan.pre.map(step), middle, ...plan.post.map(step)].join(' → ');
}

/**
 * Metadata block for a finished sequence. Leads with the VERDICT for the same
 * reason `capture_subject` does — and here the verdict that matters is not
 * "is it dark" but "did anything MOVE".
 */
export function formatSequenceMeta(result, ctx = {}) {
    const lines = [];
    const ok = result?.ok !== false;
    lines.push(ok
        ? `sequence: OK — ${result?.shots?.length ?? 0} frames`
        : 'sequence: UNUSABLE — read `diagnosis` below, do not trust these frames');
    const s = result?.summary;
    if (s?.diagnosis) lines.push(`diagnosis: ${s.diagnosis}`);
    for (const w of s?.warnings ?? []) lines.push(`warning: ${w}`);
    for (const w of result?.warnings ?? []) lines.push(`warning: ${w}`);
    for (const n of ctx.notes ?? []) lines.push(`note: ${n}`);

    const subj = result?.subject;
    if (subj) {
        const who = subj.def ? `def ${subj.def}`
            : subj.unitId != null ? `unit ${subj.unitId}`
            : subj.kind;
        lines.push(`subject: ${who} — ${subj.metresAcross?.toFixed(1)} m across`
            + `, model=${subj.hasModel === true ? 'loaded'
                : subj.hasModel === false ? 'FALLBACK' : 'loading'}`);
    }
    if (result?.requested) {
        const r = result.requested;
        lines.push(`requested: ${r.frames} frames, every ${r.everyNthSimFrame} sim frame(s)`
            + `${r.simSpeed !== undefined ? `, sim speed ${r.simSpeed}×` : ''}`
            + `, mode ${result.mode}`);
    }
    if (s) {
        lines.push(`delivered: ${s.distinctGameFrames} distinct server frames spanning`
            + ` ${s.simFramesSpanned} sim frames (${(s.simFramesSpanned / GAME_SPEED).toFixed(2)} game-seconds)`
            + ` over ${(s.wallMs / 1000).toFixed(1)} s wall`
            + `; deltas ${s.frameDeltas.join(', ') || '—'}`);
    }
    if (result?.turnDegrees !== undefined) {
        lines.push(`heading: turned ${result.turnDegrees.toFixed(1)}° across the sequence`);
    }
    if (result?.onset) {
        lines.push(`motion onset: waited ${result.onset.waitedMs} ms /`
            + ` ${result.onset.polls} poll(s) — ${result.onset.moving
                ? `moving at ${result.onset.speed.toFixed(1)} elmo/s,`
                  + ` turning ${result.onset.turnRateDegPerSec.toFixed(1)}°/s`
                : 'NEVER started moving; filmed anyway'}`);
    }
    for (const f of result?.files ?? []) {
        lines.push(`frame ${String(f.index).padStart(2)}: server frame ${f.gameFrame}`
            + ` (+${f.deltaFrames}) lum ${f.mean?.toFixed?.(1) ?? '?'}`
            + `${f.black ? ' BLACK' : ''} → ${f.path}`);
    }
    if (ctx.plan) lines.push(`plan: ${ctx.plan}`);
    if (ctx.clientId !== undefined) lines.push(`clientId: ${ctx.clientId}`);
    return lines.join('\n');
}

/**
 * The `window.test` expression for a realtime burst. Mirrors
 * `buildHarnessCall`, minus the keys the burst decides for itself.
 */
export function buildSequenceHarnessCall(args = {}, shape = {}) {
    const spec = {};
    for (const k of ['unitId', 'unitIds', 'def', 'position', 'area',
                     'angle', 'yawDeg', 'pitchDeg', 'fill', 'maxDim', 'quality',
                     'format', 'luminanceFloor', 'contrastFloor', 'settleMs',
                     'resolveTimeoutMs', 'trackSubject', 'syncPresentation']) {
        if (args[k] !== undefined) spec[k] = args[k];
    }
    spec.frames = shape.frames;
    spec.everyNthSimFrame = shape.stride;
    spec.simSpeed = shape.simSpeed ?? 1;
    spec.revealed = args.__revealed === true;
    return `captureSequence(${JSON.stringify(spec)})`;
}

// ── Verdicts ───────────────────────────────────────────────────────────

/**
 * Judge a completed sequence.
 *
 * The failure this exists to catch is the QUIET one: N perfectly exposed,
 * perfectly framed images of the SAME sim frame. Every shot passes V1's
 * luminance check, the reply looks like a film, and it is a still life. That
 * happens whenever the sim did not actually advance — a `sim_step` that never
 * landed, a pause nobody lifted, a presentation cursor that never moved — and
 * it must be loud, because the images themselves give no hint.
 *
 * (`capture-sequence.ts` carries the same rules for the browser-side burst's
 * own reply. THIS is the one the tool reports from, because it is the only one
 * that can see a step-mode sequence — those shots arrive as N separate relay
 * calls and the browser never holds the set.)
 */
export function summariseShots(shots = [], opts = {}) {
    const warnings = [];
    const frames = shots.length;
    if (frames === 0) {
        return { ok: false, frames: 0, distinctGameFrames: 0, simFramesSpanned: 0,
                 frameDeltas: [], wallMs: 0, blackFrames: [],
                 diagnosis: 'the sequence captured no frames at all', warnings };
    }
    const gameFrames = shots.map((s) => s.gameFrame ?? 0);
    // Spacing is judged on the SERVER frame (exact); "did the picture actually
    // change" is judged on what the CLIENT was showing, because those are two
    // different questions and only the second one catches a stepped sim whose
    // snapshots never reached the browser.
    const shownFrames = shots.map((s) => s.clientFrame ?? s.gameFrame ?? 0);
    const distinct = new Set(shownFrames).size;
    const spanned = gameFrames[frames - 1] - gameFrames[0];
    const frameDeltas = [];
    for (let i = 1; i < frames; i++) frameDeltas.push(gameFrames[i] - gameFrames[i - 1]);
    const wallMs = (shots[frames - 1].atMs ?? 0) - (shots[0].atMs ?? 0);
    const blackFrames = shots.map((s, i) => (s.verdict?.black ? i : -1)).filter((i) => i >= 0);

    let diagnosis = null;
    if (distinct <= 1) {
        diagnosis = `every one of ${frames} shots renders frame ${shownFrames[0]}`
            + ' — the client showed the same instant every time, so this is one pose'
            + ' photographed repeatedly, not a manoeuvre. Check that the sim is not'
            + ' paused by someone else, that sim_step is landing (step_sim reports'
            + ' `from → to`), and that this client is still receiving entity snapshots.';
    } else if (blackFrames.length === frames) {
        diagnosis = `all ${frames} frames came back black — see the per-frame`
            + ' luminance below and capture_subject\'s black-frame causes.';
    }
    if (blackFrames.length > 0 && blackFrames.length < frames) {
        warnings.push(`${blackFrames.length} of ${frames} frames came back black`
            + ` (indices ${blackFrames.join(', ')})`);
    }
    const stride = opts.expectedStride;
    if (stride > 0 && frameDeltas.length) {
        const off = frameDeltas.filter((d) => Math.abs(d - stride) > Math.max(1, stride * 0.5));
        if (off.length) {
            warnings.push(`sim-frame spacing is uneven (${frameDeltas.join(', ')} vs the`
                + ` requested ${stride}): ` + (opts.mode === 'step'
                    ? 'a step did not land, or another client resumed the sim'
                    : 'wall-clock pacing cannot hold an exact sim-frame stride —'
                      + ' use mode:"step" when the spacing has to be measurable'));
        }
    }
    return { ok: diagnosis === null, frames, distinctGameFrames: distinct,
             simFramesSpanned: spanned, frameDeltas, wallMs, blackFrames,
             diagnosis, warnings };
}

// ── The relay's hard ceiling on a realtime burst ───────────────────────
//
// The worker→main relay abandons a `test` evaluation that has not answered in
// 8 s (`client/src/core/game-processor.ts` ~1237; it is 8 s so the game
// server's own 10 s waiter always gets a structured answer). A browser-side
// burst runs entirely inside ONE such evaluation, so that is a hard ceiling on
// its wall span — and it does not degrade, it VANISHES: the reply is dropped
// and every frame taken with it.
//
// This is the whole reason `step` mode exists as the default. A full 1.2 s walk
// cycle at 0.1× is 12 s of wall time; no single relay call can hold it. Step
// mode advances the sim between shots and so has no wall-clock span at all.

export const RELAY_MAIN_THREAD_BUDGET_MS = 8000;
export const REALTIME_BURST_BUDGET_MS = 6500;
export const SHOT_OVERHEAD_MS = 150;

export function estimateBurstMs(frames, stride, simSpeed, settleMs = 250) {
    return settleMs + (frames - 1) * (stride / (GAME_SPEED * (simSpeed || 1))) * 1000
        + frames * SHOT_OVERHEAD_MS;
}

/** Refuse an un-returnable burst up front, with the arithmetic shown and the
 *  alternative named. */
export function realtimeBudgetError(frames, stride, simSpeed, settleMs = 250) {
    const est = estimateBurstMs(frames, stride, simSpeed, settleMs);
    if (est <= REALTIME_BURST_BUDGET_MS) return null;
    const interval = (stride / (GAME_SPEED * (simSpeed || 1))) * 1000;
    return `a realtime burst of ${frames} shots ${interval.toFixed(0)} ms apart needs`
        + ` ~${(est / 1000).toFixed(1)} s inside ONE relay call, and the worker→main`
        + ` budget is ${RELAY_MAIN_THREAD_BUDGET_MS / 1000} s — the reply would be`
        + ' abandoned and every frame lost. Shorten the burst (fewer frames, a'
        + ' smaller everyNthSimFrame, or a less extreme simSpeed), or use'
        + ' mode:"step", which advances the sim between shots and has no'
        + ' wall-clock span at all.';
}
