/**
 * EntityInterpolator — smoothly interpolates entity positions between
 * server snapshots.
 *
 * The server sends state updates at ~10Hz. Without interpolation,
 * entities would visibly teleport every 100ms. This module stores
 * the two most recent positions per entity and lerps between them
 * at the render frame rate (~60Hz).
 *
 * Uses a fixed interpolation delay (one snapshot period) so we
 * always have a "from" and "to" state to interpolate between.
 */

/** Per-entity interpolation state. */
interface EntityLerpState {
    // Previous snapshot values
    prevX: number;
    prevY: number;
    prevZ: number;
    prevHeading: number;
    /** Pitch in radians; default 0 if server didn't send the field. */
    prevPitch: number;
    /** Roll in radians; default 0. */
    prevRoll: number;

    // Current snapshot values (target)
    currX: number;
    currY: number;
    currZ: number;
    currHeading: number;
    currPitch: number;
    currRoll: number;

    // Timestamp when current snapshot was received
    snapshotTime: number;
}

export class EntityInterpolator {
    private entities = new Map<number, EntityLerpState>();

    /** Expected time between snapshots in ms (~100ms at 10Hz). */
    private snapshotInterval = 100;

    /**
     * Feed a new snapshot position for an entity.
     * Call this when a server update arrives.
     */
    pushState(
        entityId: number,
        x: number, y: number, z: number,
        heading: number,
        now: number = performance.now(),
        pitch: number = 0,
        roll: number = 0,
    ): void {
        let state = this.entities.get(entityId);
        if (!state) {
            // First time seeing this entity — no interpolation possible yet
            state = {
                prevX: x, prevY: y, prevZ: z, prevHeading: heading,
                prevPitch: pitch, prevRoll: roll,
                currX: x, currY: y, currZ: z, currHeading: heading,
                currPitch: pitch, currRoll: roll,
                snapshotTime: now,
            };
            this.entities.set(entityId, state);
            return;
        }

        // Shift current → previous
        state.prevX = state.currX;
        state.prevY = state.currY;
        state.prevZ = state.currZ;
        state.prevHeading = state.currHeading;
        state.prevPitch = state.currPitch;
        state.prevRoll = state.currRoll;

        // Set new target
        state.currX = x;
        state.currY = y;
        state.currZ = z;
        state.currHeading = heading;
        state.currPitch = pitch;
        state.currRoll = roll;

        // Update snapshot interval estimate
        const dt = now - state.snapshotTime;
        if (dt > 10 && dt < 500) {
            // Smooth the interval estimate
            this.snapshotInterval = this.snapshotInterval * 0.8 + dt * 0.2;
        }
        state.snapshotTime = now;
    }

    /**
     * Get the interpolated position for an entity at the current time.
     * Returns null if the entity is unknown.
     */
    getInterpolated(
        entityId: number,
        now: number = performance.now()
    ): { x: number; y: number; z: number; heading: number; pitch: number; roll: number } | null {
        const state = this.entities.get(entityId);
        if (!state) return null;

        // t = how far we are between prev and curr (0..1, can overshoot slightly)
        const elapsed = now - state.snapshotTime;
        const t = Math.min(Math.max(elapsed / this.snapshotInterval, 0), 1.2);
        const tc = Math.min(t, 1);

        return {
            x: state.prevX + (state.currX - state.prevX) * t,
            y: state.prevY + (state.currY - state.prevY) * t,
            z: state.prevZ + (state.currZ - state.prevZ) * t,
            heading: lerpAngle(state.prevHeading, state.currHeading, tc),
            pitch: state.prevPitch + (state.currPitch - state.prevPitch) * tc,
            roll:  state.prevRoll  + (state.currRoll  - state.prevRoll)  * tc,
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
