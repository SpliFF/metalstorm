/**
 * capture-sequence — the pacing, byte-budget and verdict math behind
 * `test.captureSequence()` and the `capture_sequence` MCP tool
 * (ai-visual-debug V2: capture MOTION, not just poses).
 *
 * WHY THIS EXISTS. `capture_subject` (V1) removed the camera-vs-shutter race
 * for a *pose*. It does nothing for a MANOEUVRE — a tank's turn arc, a turret
 * slew, a walk cycle mid-stride — because a manoeuvre is not one moment, it is
 * a sequence of them at a known spacing, and the three obvious ways to get one
 * all fail:
 *
 *   - **Speed 1, shot per relay call.** Each round trip is seconds; the sim
 *     advances an unknown number of frames between shots. The frames are real
 *     but their spacing is noise, so nothing can be measured from them.
 *   - **Hard pause.** Freezes the very thing under inspection. You get one
 *     pose, N times.
 *   - **Slow motion alone.** Narrows the window without closing it. Better,
 *     and still not a controlled interval.
 *
 * So there are two honest modes, and this module serves both:
 *
 *   - **step** — the sim is stopped and advanced by exactly `everyNthSimFrame`
 *     frames between shots (`sim_step`, rts/Server/SimStep.h). Spacing is
 *     EXACT regardless of how long the camera took. This is the mode M1's
 *     turn-arc evidence needs, and it is orchestrated MCP-side (the browser
 *     cannot step the sim without deadlocking the game server's HTTP thread).
 *   - **realtime** — the sim runs, usually slowed, and the burst happens
 *     browser-side inside ONE relay evaluation so the inter-shot interval is
 *     wall-clock-accurate rather than relay-latency-accurate. Spacing is
 *     NOMINAL: it is what we asked the wall clock for, not what the sim did.
 *     `summariseSequence` reports the delivered spacing so the difference is
 *     visible instead of assumed.
 *
 * Everything here is pure and Babylon-free; the rules are unit-tested with no
 * renderer (capture-sequence.test.ts).
 */

import type { LuminanceStats, LuminanceVerdict } from './capture-subject.js';

/** Sim frames per game-second. Matches GAME_SPEED on the server. */
export const GAME_SPEED = 30;

/** Hard cap on frames in one burst. Not a byte limit (that is separate) — a
 *  sanity limit, because a 200-shot burst is a video request wearing a
 *  screenshot tool's clothes. */
export const MAX_SEQUENCE_FRAMES = 60;

/**
 * Base64 budget for ONE relay reply, in characters.
 *
 * The relay's wire cap is 4 MB **per message**, and a browser-side burst
 * returns every frame in a single message. 3.2 MB leaves room for the
 * metadata, the JSON quoting and the data-URL prefixes without needing an
 * exact accounting of any of them. Exceeded → the burst stops early and says
 * so; it never returns a reply the relay will drop, which is the failure mode
 * that looks like "the client hung".
 */
export const SEQUENCE_WIRE_BUDGET_CHARS = 3_200_000;

/**
 * Default longest-edge for a burst of N frames.
 *
 * A sequence is read for MOTION — where the barrel is pointing, which leg is
 * forward — not for texel detail, so trading resolution for frame count is the
 * right trade in a way it would not be for a single `capture_subject`. The
 * ladder keeps a full burst inside the wire budget at the default quality
 * without the early-stop ever firing on a normal scene.
 */
export function sequenceMaxDim(frames: number): number {
    if (!Number.isFinite(frames) || frames <= 2) return 1280;
    if (frames <= 4) return 1024;
    if (frames <= 8) return 800;
    if (frames <= 16) return 640;
    return 512;
}

/** Default JPEG quality for a burst. Lower than a single shot's, same reason. */
export const SEQUENCE_QUALITY = 0.62;

/**
 * Wall-clock milliseconds between two shots that should be `everyNthSimFrame`
 * sim frames apart at `simSpeed`.
 *
 * This is the whole point of wiring slow motion into the capture flow: at
 * speed 1 a 3-frame spacing is 100 ms, which no relay-driven loop can hit and
 * which is far too coarse to read a turn arc from. At 0.1 the same 3 frames
 * are a full second of wall time — a spacing a browser-side loop hits easily
 * and a spacing at which a 2-second manoeuvre becomes 20 seconds of filmable
 * material.
 *
 * Returns 0 for a stopped sim (speed 0): there is no wall-clock interval that
 * corresponds to a sim frame when the sim is not running, which is exactly why
 * `step` mode exists.
 */
export function shotIntervalMs(everyNthSimFrame: number, simSpeed: number): number {
    const n = Math.max(1, Math.floor(everyNthSimFrame));
    if (!Number.isFinite(simSpeed) || simSpeed <= 0) return 0;
    return (n / (GAME_SPEED * simSpeed)) * 1000;
}

/** Clamp a requested frame count into something a burst can actually return. */
export function clampFrames(frames: number | undefined): number {
    const n = Number.isFinite(frames) ? Math.floor(frames as number) : 6;
    return Math.max(2, Math.min(MAX_SEQUENCE_FRAMES, n));
}

/** Clamp a sim-speed request to the server verb's own range. */
export const SIM_SPEED_MIN = 0.05;
export const SIM_SPEED_MAX = 100;

export function clampSimSpeed(speed: number): number {
    if (!Number.isFinite(speed)) return 1;
    return Math.max(SIM_SPEED_MIN, Math.min(SIM_SPEED_MAX, speed));
}

/** One shot of a burst, as the harness records it. */
export interface SequenceShot {
    /** Index in the burst, 0-based. */
    index: number;
    /** Server frame this shot renders. The freshest entity-snapshot frame the
     *  client holds — NOT GameInfo's `gameFrame`, which only updates once a
     *  game-second and would flatten a real burst into one instant. */
    gameFrame: number;
    /** Same value, kept explicitly so the MCP can judge "did the picture
     *  change" separately from "did the server advance". */
    clientFrame?: number;
    /** Renderer frame id (monotonic, client-side). */
    frameId: number;
    /** Wall-clock ms since the burst started. */
    atMs: number;
    dataUrl: string;
    width: number;
    height: number;
    stats?: LuminanceStats;
    verdict?: LuminanceVerdict;
}

export interface SequenceSummary {
    /** false when the burst is not usable as evidence of motion. */
    ok: boolean;
    frames: number;
    /** Distinct server frames across the burst. 1 means every shot is the
     *  same instant — a still life, not a film. */
    distinctGameFrames: number;
    /** Sim frames actually advanced from the first shot to the last. */
    simFramesSpanned: number;
    /** Per-shot sim-frame deltas, in order. */
    frameDeltas: number[];
    /** Wall-clock ms from first shutter to last. */
    wallMs: number;
    /** Shots whose frame came back black. */
    blackFrames: number[];
    /** Non-null means the burst is a diagnosis, not a deliverable. */
    diagnosis: string | null;
    warnings: string[];
}

/**
 * Judge a completed burst.
 *
 * The failure this exists to catch is the quiet one: N perfectly exposed,
 * perfectly framed images of the SAME sim frame. Every individual shot passes
 * V1's luminance check, the reply looks like a film, and it is a still life.
 * That happens whenever the sim did not actually advance — a `sim_step` that
 * never landed, a pause nobody lifted, a presentation cursor that never moved
 * — and it must be loud.
 */
export function summariseSequence(
    shots: readonly SequenceShot[],
    opts: { expectedStride?: number; mode?: 'step' | 'realtime' } = {},
): SequenceSummary {
    const warnings: string[] = [];
    const frames = shots.length;
    if (frames === 0) {
        return {
            ok: false, frames: 0, distinctGameFrames: 0, simFramesSpanned: 0,
            frameDeltas: [], wallMs: 0, blackFrames: [],
            diagnosis: 'the burst captured no frames at all', warnings,
        };
    }

    const gameFrames = shots.map((s) => s.gameFrame);
    const distinct = new Set(gameFrames).size;
    const spanned = gameFrames[frames - 1] - gameFrames[0];
    const deltas: number[] = [];
    for (let i = 1; i < frames; i++) deltas.push(gameFrames[i] - gameFrames[i - 1]);
    const wallMs = shots[frames - 1].atMs - shots[0].atMs;
    const blackFrames = shots
        .map((s, i) => (s.verdict?.black ? i : -1))
        .filter((i) => i >= 0);

    let diagnosis: string | null = null;
    if (distinct <= 1) {
        diagnosis = `every one of ${frames} shots is server frame ${gameFrames[0]}`
            + ' — the sim did not advance between shots, so this is one pose'
            + ' photographed repeatedly, not a manoeuvre. Check that the sim is'
            + ' not paused (pause_sim {paused:false}), that sim_step is landing,'
            + ' and that the client is still receiving entity snapshots.';
    } else if (blackFrames.length === frames) {
        diagnosis = `all ${frames} frames came back black —`
            + ' see the per-shot diagnosis for the candidate causes.';
    }

    if (blackFrames.length > 0 && blackFrames.length < frames) {
        warnings.push(`${blackFrames.length} of ${frames} frames came back black`
            + ` (indices ${blackFrames.join(', ')})`);
    }

    const stride = opts.expectedStride;
    if (stride && stride > 0 && deltas.length) {
        const off = deltas.filter((d) => Math.abs(d - stride) > Math.max(1, stride * 0.5));
        if (off.length) {
            const how = opts.mode === 'step'
                ? 'a step did not land, or another client resumed the sim'
                : 'wall-clock pacing cannot hold an exact sim-frame stride —'
                  + ' use mode:"step" when the spacing has to be measurable';
            warnings.push(`sim-frame spacing is uneven (${deltas.join(', ')} vs the`
                + ` requested ${stride}): ${how}`);
        }
    }

    return {
        ok: diagnosis === null,
        frames, distinctGameFrames: distinct, simFramesSpanned: spanned,
        frameDeltas: deltas, wallMs, blackFrames, diagnosis, warnings,
    };
}

/**
 * Running byte accounting for a browser-side burst.
 *
 * Called after each shot with the data-URL just produced; returns whether the
 * burst may continue. The check is on what has ALREADY been collected plus the
 * next shot's likely size, because discovering the overflow after appending is
 * discovering it too late — the reply is then already over the cap.
 */
export function wireBudgetExceeded(
    collectedChars: number,
    nextEstimateChars: number,
    budget: number = SEQUENCE_WIRE_BUDGET_CHARS,
): boolean {
    return collectedChars + nextEstimateChars > budget;
}

/** Total base64 payload of a set of data URLs, in characters. */
export function payloadChars(dataUrls: readonly string[]): number {
    let n = 0;
    for (const u of dataUrls) n += u.length;
    return n;
}

/** What to capture, how many, and how far apart. */
export interface CaptureSequenceSpec {
    unitId?: number;
    unitIds?: number[];
    def?: string;
    position?: { x: number; z: number; y?: number; radius?: number };
    area?: { x1: number; z1: number; x2: number; z2: number };

    /** Number of shots (2–60). */
    frames?: number;
    /** Sim frames between shots. */
    everyNthSimFrame?: number;
    /** Sim speed the caller has already applied server-side; used to pace the
     *  wall-clock interval. Not applied here — the browser cannot set it. */
    simSpeed?: number;

    angle?: string;
    yawDeg?: number;
    pitchDeg?: number;
    fill?: number;
    maxDim?: number;
    quality?: number;
    format?: 'png' | 'jpeg';

    /** Re-frame on the subject before every shot (default true) — the camera
     *  tracks a moving subject, which is the whole point of filming one. */
    trackSubject?: boolean;
    /** Put the presentation cursor on the newest received frame before each
     *  shot (default true). See PresentationClock.snapToNewest. */
    syncPresentation?: boolean;
    resolveTimeoutMs?: number;
    /** Live-render dwell before the FIRST shot only. */
    settleMs?: number;
    luminanceFloor?: number;
    contrastFloor?: number;
    revealed?: boolean;
}

/**
 * The worker→main relay budget, in ms (`game-processor.ts` ~1237).
 *
 * A `test`-target evaluation that has not answered in 8 s is abandoned with
 * `timeout: main thread did not answer in 8s`, and the reply — every frame of
 * the burst with it — is lost. It is 8 s so that the game server's own 10 s
 * waiter always gets a structured answer, i.e. it is a protocol-timing choice,
 * not a knob a capture tool gets to turn.
 *
 * This is therefore a HARD CEILING on how long a browser-side burst can be, and
 * the reason `realtime` mode cannot film a slow manoeuvre: a full 1.2 s walk
 * cycle at 0.1× is 12 s of wall time, which no single relay call can hold. That
 * span belongs to `step` mode, which pays no wall-clock cost at all.
 */
export const RELAY_MAIN_THREAD_BUDGET_MS = 8000;

/** What a burst is allowed to spend, leaving the relay room to answer. */
export const REALTIME_BURST_BUDGET_MS = 6500;

/** Rough wall cost of one shot: re-frame + presentation snap + encode. */
export const SHOT_OVERHEAD_MS = 150;

/** Estimated wall span of a realtime burst, for the budget check. */
export function estimateBurstMs(
    frames: number, everyNthSimFrame: number, simSpeed: number, settleMs = 250,
): number {
    const n = clampFrames(frames);
    return settleMs + (n - 1) * shotIntervalMs(everyNthSimFrame, simSpeed)
        + n * SHOT_OVERHEAD_MS;
}

/**
 * Refuse a realtime burst that cannot come back — and say what to do instead.
 *
 * A burst that overruns does not degrade, it VANISHES: the relay abandons the
 * call and every frame taken so far goes with it. Refusing up front, with the
 * arithmetic shown, is strictly better than discovering it after the shoot.
 */
export function realtimeBudgetError(
    frames: number, everyNthSimFrame: number, simSpeed: number, settleMs = 250,
): string | null {
    const est = estimateBurstMs(frames, everyNthSimFrame, simSpeed, settleMs);
    if (est <= REALTIME_BURST_BUDGET_MS) return null;
    const interval = shotIntervalMs(everyNthSimFrame, simSpeed);
    return `a realtime burst of ${clampFrames(frames)} shots ${interval.toFixed(0)} ms apart`
        + ` needs ~${(est / 1000).toFixed(1)} s inside ONE relay call, and the`
        + ` worker→main budget is ${RELAY_MAIN_THREAD_BUDGET_MS / 1000} s — the reply`
        + ' would be abandoned and every frame lost. Either shorten the burst'
        + ' (fewer frames, a smaller everyNthSimFrame, or a less extreme simSpeed),'
        + ' or use mode:"step", which advances the sim between shots and so has no'
        + ' wall-clock span at all.';
}
