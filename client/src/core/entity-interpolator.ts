/**
 * EntityInterpolator — frame-keyed jitter buffer (PLAN-latency.md L0).
 *
 * The server sends frame-stamped state at ~10 Hz (envelope 0x02/0x03, header
 * `base_frame`). This module holds a small ring of recent samples per entity
 * and, given the presentation cursor `P` (a fractional server frame from
 * `PresentationClock`), interpolates strictly **by server frame** — not by
 * arrival wall-time. Interpolating by arrival time conflated network jitter
 * into motion; keying on the sim frame removes it entirely.
 *
 * Buffer policy (the jitter buffer):
 *   - Hold the last few samples per entity (older ones fall off the ring,
 *     which discards samples below the cursor).
 *   - Interpolate between the two samples bracketing `P`.
 *   - If `P` runs past the newest sample (the next snapshot is late or the
 *     unit stopped emitting deltas), **bounded extrapolate-then-hold**: carry
 *     the last velocity for ≤ EXTRAP_MAX_FRAMES, then freeze at the newest
 *     pose. Bounded so a lost packet can't fling a unit off into space.
 *   - Teleport guard: never lerp across a large position jump (LOS regain,
 *     radar→LOS handoff) — snap to the fresher sample instead.
 */

/** A single frame-stamped pose sample. */
interface PoseSample {
    frame: number;
    x: number;
    y: number;
    z: number;
    heading: number;  // u16, 0–65535 → 0°–360°
    pitch: number;    // radians
    roll: number;     // radians
}

/** Max samples retained per entity (~0.8 s at 10 Hz — comfortably more than
 *  the display delay D, so the bracketing pair is always in hand). */
const MAX_SAMPLES = 8;

/** Bounded extrapolation horizon, in sim frames, when the cursor outruns the
 *  newest sample. Past this the pose holds. (PLAN-latency L0: "≤ 2 frames".) */
const EXTRAP_MAX_FRAMES = 2;

/** Position jump (elmos) beyond which we treat consecutive samples as a
 *  teleport and refuse to interpolate across the gap. */
const TELEPORT_THRESHOLD_SQ = 200 * 200;

/** Interpolated pose returned to the renderer. */
export interface InterpolatedPose {
    x: number;
    y: number;
    z: number;
    heading: number;
    pitch: number;
    roll: number;
}

export class EntityInterpolator {
    private entities = new Map<number, PoseSample[]>();

    /**
     * Feed a frame-stamped pose sample for an entity. Call on each inbound
     * snapshot that carries this entity. Samples are kept sorted ascending by
     * frame; reordered (late) packets slot into place; duplicates replace.
     */
    pushState(
        entityId: number,
        frame: number,
        x: number, y: number, z: number,
        heading: number,
        pitch: number = 0,
        roll: number = 0,
    ): void {
        const sample: PoseSample = { frame, x, y, z, heading, pitch, roll };
        let buf = this.entities.get(entityId);
        if (!buf) {
            buf = [sample];
            this.entities.set(entityId, buf);
            return;
        }

        const last = buf[buf.length - 1];
        if (frame > last.frame) {
            // Common case: monotonic append.
            buf.push(sample);
        } else if (frame === last.frame) {
            // Duplicate frame — replace (newest serializer wins).
            buf[buf.length - 1] = sample;
        } else {
            // Reordered/late packet — insert in frame order (or replace).
            let i = buf.length - 1;
            while (i >= 0 && buf[i].frame > frame) i--;
            if (i >= 0 && buf[i].frame === frame) {
                buf[i] = sample;
            } else {
                buf.splice(i + 1, 0, sample);
            }
        }

        // Evict oldest beyond the cap (this is the "discard stale" path).
        while (buf.length > MAX_SAMPLES) buf.shift();
    }

    /**
     * Interpolate an entity's pose at the presentation cursor frame.
     * Returns null if the entity is unknown.
     */
    getInterpolated(entityId: number, cursorFrame: number): InterpolatedPose | null {
        const buf = this.entities.get(entityId);
        if (!buf || buf.length === 0) return null;

        if (buf.length === 1) return poseOf(buf[0]);

        const oldest = buf[0];
        const newest = buf[buf.length - 1];

        // Behind the buffer: clamp to the oldest held sample.
        if (cursorFrame <= oldest.frame) return poseOf(oldest);

        // Ahead of the buffer: bounded extrapolate-then-hold.
        if (cursorFrame >= newest.frame) {
            const prev = buf[buf.length - 2];
            const df = newest.frame - prev.frame;
            // Don't extrapolate across a teleport — just hold the newest pose.
            if (df <= 0 || sqDist(prev, newest) > TELEPORT_THRESHOLD_SQ) {
                return poseOf(newest);
            }
            const extra = Math.min(cursorFrame - newest.frame, EXTRAP_MAX_FRAMES);
            const k = extra / df;
            return {
                x: newest.x + (newest.x - prev.x) * k,
                y: newest.y + (newest.y - prev.y) * k,
                z: newest.z + (newest.z - prev.z) * k,
                // Hold rotation at the newest sample — extrapolating angles
                // across a late packet looks worse than a brief freeze.
                heading: newest.heading,
                pitch: newest.pitch,
                roll: newest.roll,
            };
        }

        // Interpolate within the buffer: find the bracketing pair.
        let lo = buf[0];
        let hi = buf[1];
        for (let i = 1; i < buf.length; i++) {
            if (buf[i].frame > cursorFrame) {
                lo = buf[i - 1];
                hi = buf[i];
                break;
            }
        }

        // Teleport guard: snap to the fresher sample rather than lerp across.
        if (sqDist(lo, hi) > TELEPORT_THRESHOLD_SQ) return poseOf(hi);

        const span = hi.frame - lo.frame;
        const t = span > 0 ? (cursorFrame - lo.frame) / span : 0;
        return {
            x: lo.x + (hi.x - lo.x) * t,
            y: lo.y + (hi.y - lo.y) * t,
            z: lo.z + (hi.z - lo.z) * t,
            heading: lerpAngle(lo.heading, hi.heading, t),
            pitch: lo.pitch + (hi.pitch - lo.pitch) * t,
            roll:  lo.roll  + (hi.roll  - lo.roll)  * t,
        };
    }

    /** Remove an entity from interpolation tracking. */
    remove(entityId: number): void {
        this.entities.delete(entityId);
    }

    /** Clear all tracked entities. */
    clear(): void {
        this.entities.clear();
    }

    /** Number of tracked entities. */
    get size(): number {
        return this.entities.size;
    }
}

function poseOf(s: PoseSample): InterpolatedPose {
    return { x: s.x, y: s.y, z: s.z, heading: s.heading, pitch: s.pitch, roll: s.roll };
}

function sqDist(a: PoseSample, b: PoseSample): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
}

/** Lerp between two u16 heading values (0–65535), taking shortest path. */
function lerpAngle(a: number, b: number, t: number): number {
    let diff = b - a;
    // Wrap around the 0–65535 range
    if (diff > 32768) diff -= 65536;
    if (diff < -32768) diff += 65536;
    let result = a + diff * t;
    if (result < 0) result += 65536;
    if (result >= 65536) result -= 65536;
    return result;
}
