/**
 * PresentationClock — the client-side timing spine (PLAN-latency.md L0).
 *
 * Everything the player sees is in the past: the freshest server frame the
 * client holds already crossed the network, and we deliberately render
 * *further* behind it to absorb jitter. This clock turns the stream of
 * frame-stamped snapshots (`base_frame` on envelope 0x02/0x03) into a smooth
 * **presentation cursor** `P` that the renderer interpolates to.
 *
 *   E — estimated current server frame (the simulation's leading edge).
 *   D — display delay, in sim frames (`D = D_jitter + D_lookahead`).
 *   P — presentation cursor = E − D. The world is rendered interpolated to P.
 *
 * The cursor is driven by the received-frame stream (self-referencing, so it
 * is robust to clock-offset error) and consumes the synced `ServerClock` for
 * the one-way-latency bias (RTT/2) and absolute-time mapping. Per the
 * resolved design decision, all delays are expressed in **frames** because
 * `GAME_SPEED` is fixed but the wall-clock tick interval varies with
 * `speedFactor`; a pause (`speedFactor → 0`) freezes `P` while the wall clock
 * keeps running.
 *
 * Why a phase-locked loop rather than `frame = f(wall_time)` directly: we
 * never receive a server *timestamp* per snapshot, only a frame number. So we
 * advance the cursor by wall-dt·framesPerMs each render tick and continuously
 * nudge it toward the target implied by the newest received frame. This keeps
 * `P` landing between the snapshots actually in hand (the precondition for
 * interpolating instead of extrapolating) regardless of absolute clock error.
 *
 * `base_frame` is monotonic and unique per packet, so it doubles as the
 * unreliable-channel sequence number: gaps in the ~3-frame stride are loss,
 * a frame ≤ the newest seen is a reorder. Those stats feed the debug overlay.
 */

import type { ServerClock } from './clock';

/** Sim frames per game-second (resolved design decision: GAME_SPEED = 30). */
const GAME_SPEED = 30;

/** Normal send cadence of entity-state packets, in sim frames (every 3 ticks
 *  → ~10 Hz). Used for loss detection and to floor the jitter buffer depth. */
const SNAPSHOT_STRIDE_FRAMES = 3;

/** Hard-snap threshold: if the cursor target diverges by more than this many
 *  frames (~0.5 s) the cursor jumps instead of easing — a large divergence
 *  means a stall/teleport, not jitter, and easing would smear it. */
const SNAP_FRAMES = 15;

/** Per-observation correction gain for the phase-locked loop. Small so the
 *  cursor eases toward the target over several snapshots without visible
 *  rubber-banding. */
const CORRECTION_GAIN = 0.1;

/** Floor / ceiling for the auto-adapted display delay D, in frames. */
const DELAY_FLOOR_FRAMES = 4;   // ~133 ms — at least one snapshot interval + slack
const DELAY_CEIL_FRAMES = 30;   // ~1 s — runaway guard

export interface PresentationClockStats {
    /** Estimated current server frame (leading edge). */
    E: number;
    /** Presentation cursor frame (E − D). */
    P: number;
    /** Display delay D in frames, and in ms at the current speed. */
    displayDelayFrames: number;
    displayDelayMs: number;
    /** Newest base_frame observed on the wire. */
    newestFrame: number;
    /** Sim-speed multiplier (0 when paused). */
    speedFactor: number;
    /** Synced-clock telemetry (the measured values that now feed rendering). */
    rttMs: number;
    offsetMs: number;
    clockSamples: number;
    /** Smoothed snapshot-arrival jitter, ms (|actual − expected| interval). */
    arrivalJitterMs: number;
    /** Stream health (base_frame doubles as the sequence number). */
    reorderCount: number;
    lossCount: number;
    /** Cursor corrections: how often it hard-snapped and the last magnitude. */
    correctionCount: number;
    lastCorrectionFrames: number;
    /** True once the first frame-stamped snapshot has anchored the cursor. */
    anchored: boolean;
}

export class PresentationClock {
    private clock: ServerClock | null = null;

    private speedFactor = 1;
    /** Sim frames per wall-millisecond at the current speed. 0 when paused. */
    private framesPerMs = GAME_SPEED / 1000;

    /** E — estimated current server frame (float). */
    private estFrame = 0;
    private anchored = false;
    private lastTickMs = 0;

    /** Manual override for D (frames); null = auto-adapt. */
    private manualDelayFrames: number | null = null;

    // Stream tracking (base_frame as sequence number).
    private newestFrame = 0;
    private lastRecvMs = 0;
    private arrivalJitterMs = 0;
    /** Ring of recent signed arrival deviations (actual − expected interval,
     *  ms) for the overlay's jitter histogram. */
    private arrivalDevs: number[] = [];
    private reorderCount = 0;
    private lossCount = 0;
    private correctionCount = 0;
    private lastCorrectionFrames = 0;

    /** Attach the synced server clock (created per game connection). */
    setServerClock(clock: ServerClock | null): void {
        this.clock = clock;
    }

    /** Update the sim-speed multiplier (from GameInfo). Paused → 0 freezes the
     *  cursor: `tick()` stops advancing and `observeFrame()` stops receiving
     *  new frames, so `P` holds. `framesPerMs` is recomputed from the live
     *  speed; D sizing uses the nominal rate so the buffer depth doesn't
     *  collapse during a pause. */
    setSpeedFactor(sf: number): void {
        if (!Number.isFinite(sf) || sf < 0) return;
        this.speedFactor = sf;
        this.framesPerMs = (GAME_SPEED * sf) / 1000;
    }

    /** Override the display delay D (frames). Pass null to auto-adapt. */
    setManualDelayFrames(frames: number | null): void {
        this.manualDelayFrames =
            frames == null ? null : Math.max(0, frames);
    }

    /**
     * Feed the newest server frame seen on an inbound snapshot. Anchors /
     * corrects the cursor and updates stream-health stats. Call once per
     * received 0x02/0x03 packet, before pushing the per-entity samples.
     */
    observeFrame(baseFrame: number, recvMs: number = performance.now()): void {
        // One-way latency in frames: the server has advanced ~RTT/2 worth of
        // frames since it stamped this snapshot, so the true leading edge is
        // baseFrame + oneWayFrames. Uses the live rate (0 during pause).
        const oneWayMs = this.clock?.getOneWayLatency() ?? 0;
        const oneWayFrames = oneWayMs * this.framesPerMs;
        const targetE = baseFrame + oneWayFrames;

        if (baseFrame <= this.newestFrame && this.anchored) {
            // Reordered or duplicate/late packet. Its per-entity samples are
            // still useful (the caller pushes them; the interpolator slots
            // them in by frame), but we must not pull the cursor backward
            // toward an old leading edge — nor disturb the in-order arrival
            // baseline (lastRecvMs) used for jitter measurement.
            if (baseFrame < this.newestFrame) this.reorderCount++;
            return;
        }

        // Loss detection: the stride between consecutive packets is normally
        // SNAPSHOT_STRIDE_FRAMES. A larger gap means we dropped packet(s).
        if (this.anchored) {
            const deltaFrames = baseFrame - this.newestFrame;
            const missed = Math.round(deltaFrames / SNAPSHOT_STRIDE_FRAMES) - 1;
            if (missed > 0 && missed < 1000) this.lossCount += missed;

            // Arrival jitter: deviation of the actual inter-packet wall gap
            // from the expected gap (frames / rate). Smoothed for the overlay
            // and to size the jitter buffer. Skipped when paused (rate 0).
            if (this.framesPerMs > 0 && this.lastRecvMs > 0) {
                const expectedMs = deltaFrames / this.framesPerMs;
                const actualMs = recvMs - this.lastRecvMs;
                const signedDev = actualMs - expectedMs;
                const dev = Math.abs(signedDev);
                if (Number.isFinite(dev) && dev < 2000) {
                    this.arrivalJitterMs = this.arrivalJitterMs * 0.8 + dev * 0.2;
                    this.arrivalDevs.push(signedDev);
                    if (this.arrivalDevs.length > 120) this.arrivalDevs.shift();
                }
            }
        }

        this.newestFrame = Math.max(this.newestFrame, baseFrame);
        this.lastRecvMs = recvMs;

        if (!this.anchored) {
            this.estFrame = targetE;
            this.anchored = true;
            this.lastTickMs = recvMs;
            return;
        }

        // Phase-locked correction toward the target leading edge.
        const err = targetE - this.estFrame;
        if (Math.abs(err) > SNAP_FRAMES) {
            this.estFrame = targetE;
            this.lastCorrectionFrames = err;
            this.correctionCount++;
        } else {
            this.estFrame += err * CORRECTION_GAIN;
            this.lastCorrectionFrames = err * CORRECTION_GAIN;
        }
    }

    /**
     * Advance the cursor by wall-clock time. Call once per render frame
     * (before reading P). Frozen when paused (framesPerMs 0) or before the
     * first snapshot anchors the clock.
     */
    tick(nowMs: number = performance.now()): void {
        if (!this.anchored) return;
        const dt = Math.min(Math.max(nowMs - this.lastTickMs, 0), 250);
        this.lastTickMs = nowMs;
        this.estFrame += dt * this.framesPerMs;
    }

    /** Estimated current server frame (leading edge). */
    get E(): number {
        return this.estFrame;
    }

    /** Presentation cursor frame: E − D. The renderer interpolates to this. */
    get P(): number {
        return this.estFrame - this.displayDelayFrames;
    }

    get isAnchored(): boolean {
        return this.anchored;
    }

    /**
     * Display delay D in frames. Auto-adapts to one-way latency + arrival
     * jitter so the cursor sits behind the newest held sample by at least one
     * snapshot interval (the interpolate-don't-extrapolate precondition),
     * floored and ceiled. Sized at the nominal rate so it is speed- and
     * pause-invariant. A manual override wins when set.
     */
    get displayDelayFrames(): number {
        if (this.manualDelayFrames != null) return this.manualDelayFrames;
        const oneWayMs = this.clock?.getOneWayLatency() ?? 0;
        // Convert latency + jitter to frames at the nominal sim rate.
        const nominalFpms = GAME_SPEED / 1000;
        const oneWayFrames = oneWayMs * nominalFpms;
        const jitterFrames = this.arrivalJitterMs * nominalFpms * 2; // ~2σ margin
        const adaptive = oneWayFrames + jitterFrames + SNAPSHOT_STRIDE_FRAMES;
        return Math.min(DELAY_CEIL_FRAMES, Math.max(DELAY_FLOOR_FRAMES, adaptive));
    }

    /** Newest base_frame observed (the freshest leading-edge sample in hand). */
    get newestObservedFrame(): number {
        return this.newestFrame;
    }

    /** Convert a frame count to wall-ms at the current speed (0 when paused). */
    frameToMs(frames: number): number {
        return this.framesPerMs > 0 ? frames / this.framesPerMs : 0;
    }

    /** Convert wall-ms to a frame count at the current speed. */
    msToFrames(ms: number): number {
        return ms * this.framesPerMs;
    }

    /** Recent signed arrival deviations (ms) for the jitter histogram. */
    getArrivalDeviations(): readonly number[] {
        return this.arrivalDevs;
    }

    /** Snapshot of clock state for the debug overlay. */
    getStats(): PresentationClockStats {
        const d = this.displayDelayFrames;
        return {
            E: this.estFrame,
            P: this.P,
            displayDelayFrames: d,
            displayDelayMs: this.frameToMs(d),
            newestFrame: this.newestFrame,
            speedFactor: this.speedFactor,
            rttMs: this.clock?.getRtt() ?? 0,
            offsetMs: this.clock?.getOffset() ?? 0,
            clockSamples: this.clock?.getSampleCount() ?? 0,
            arrivalJitterMs: this.arrivalJitterMs,
            reorderCount: this.reorderCount,
            lossCount: this.lossCount,
            correctionCount: this.correctionCount,
            lastCorrectionFrames: this.lastCorrectionFrames,
            anchored: this.anchored,
        };
    }

    /** Reset for a new game (keeps the attached ServerClock). */
    reset(): void {
        this.estFrame = 0;
        this.anchored = false;
        this.lastTickMs = 0;
        this.newestFrame = 0;
        this.lastRecvMs = 0;
        this.arrivalJitterMs = 0;
        this.arrivalDevs = [];
        this.reorderCount = 0;
        this.lossCount = 0;
        this.correctionCount = 0;
        this.lastCorrectionFrames = 0;
    }
}
