/**
 * EntityState — parses Tier 2 binary entity state updates.
 *
 * Wire format (struct-of-arrays, little-endian):
 *
 *   Header (8 bytes):
 *     u32 base_frame      sim frame this snapshot was built on. The
 *                         presentation clock interpolates by this, not by
 *                         arrival wall-time (PLAN-latency.md L0). Monotonic +
 *                         unique per packet, so it doubles as the unreliable-
 *                         channel sequence number (reorder/loss detection).
 *     u16 entity_count
 *     u16 field_mask
 *
 *   Per-field arrays (contiguous, present only if corresponding bit set):
 *     Bit 0: entity_ids    → u32[count]
 *     Bit 1: positions_x   → f32[count]
 *     Bit 2: positions_y   → f32[count]
 *     Bit 3: positions_z   → f32[count]
 *     Bit 4: headings      → u16[count]    (0–65535 → 0°–360°)
 *     Bit 5: health        → u16[count]    (0–65535 → 0%–100%)
 *     Bit 6: def_id        → u16[count]
 *     Bit 7: team          → u8[count]
 *     Bit 8: state_bits    → u8[count]     packed unit-state flags:
 *                                            bits 0-1: fireState (0..2)
 *                                            bits 2-3: moveState (0..2)
 *                                            bit 4:    repeatOrders
 *                                            bit 5:    isCloaked
 *                                            bit 6:    isStunned
 *                                            bit 7:    alwaysVisible
 *                                                      (force-render override)
 *     Bit 9: los_state     → u8[count]     Spring losStatus low nibble:
 *                                            bit 0: LOS_INLOS
 *                                            bit 1: LOS_INRADAR
 *                                            bit 2: LOS_PREVLOS (ghost)
 *                                            bit 3: LOS_CONTRADAR
 *                                            bits 4-7: reserved
 *     Bit 10: build_progress → u8[count]   buildProgress * 255
 *                                            (255 = construction complete)
 */

export const FIELD_ENTITY_IDS = 1 << 0;
export const FIELD_POSITION_X = 1 << 1;
export const FIELD_POSITION_Y = 1 << 2;
export const FIELD_POSITION_Z = 1 << 3;
export const FIELD_HEADING    = 1 << 4;
export const FIELD_HEALTH     = 1 << 5;
export const FIELD_DEF_ID     = 1 << 6;
export const FIELD_TEAM       = 1 << 7;
export const FIELD_STATE_BITS = 1 << 8;
export const FIELD_LOS_STATE  = 1 << 9;
export const FIELD_BUILD_PROGRESS = 1 << 10;
export const FIELD_PITCH      = 1 << 11;
export const FIELD_ROLL       = 1 << 12;

/**
 * Bit 15 is a FLAG, not a field — it carries no per-entity array.
 *
 * The sim has recycled one or more unit ids since the last flagged message
 * (PLAN-long-uptime S5 task 6), so an id this client is still holding may now
 * name a different unit. Everything the client derives from a unit id and
 * keeps across snapshots — selection, squad membership, clip/aim poses,
 * PREVLOS ghosts — is an association with the *old* occupant and has to go.
 *
 * The server flags every message from the recycle up to and including the
 * next full snapshot (the lane is unreliable and newest-wins, so one flagged
 * message is not a delivery), and the client acts on the first FULL snapshot
 * it sees the flag on — that snapshot repopulates the world in the same step,
 * so the flush leaves no gap.
 */
export const FLAG_ID_RECYCLED = 1 << 15;

/** Parsed entity state snapshot — typed arrays are zero-copy views into the buffer. */
export interface EntityStateSnapshot {
    /** Sim frame this snapshot was built on (header `base_frame`). The
     *  presentation clock interpolates by this. Monotonic + unique per
     *  packet → also the sequence number for reorder/loss detection. */
    baseFrame: number;
    count: number;
    fieldMask: number;
    entityIds:  Uint32Array  | null;
    positionsX: Float32Array | null;
    positionsY: Float32Array | null;
    positionsZ: Float32Array | null;
    headings:   Uint16Array  | null;
    health:     Uint16Array  | null;
    defIds:     Uint16Array  | null;
    teams:      Uint8Array   | null;
    stateBits:  Uint8Array   | null;
    losStates:  Uint8Array   | null;
    buildProgress: Uint8Array | null;
    /** Signed pitch quanta — null if the server didn't send them.
     *  Decode: angle (rad) = pitch[i] * (π/2) / 127. */
    pitch:       Int8Array   | null;
    /** Signed roll quanta — null if the server didn't send them.
     *  Decode: angle (rad) = roll[i] * (π/2) / 127. */
    roll:        Int8Array   | null;
}

/**
 * Parse a Tier 2 binary entity state buffer (after stripping the envelope byte).
 * Returns typed array views into the underlying ArrayBuffer — no copies.
 */
export function parseEntityState(input: Uint8Array): EntityStateSnapshot | null {
    if (input.byteLength < 8) return null;

    // Copy to an aligned buffer so typed array views work correctly
    const data = new Uint8Array(input.length);
    data.set(input);

    const view = new DataView(data.buffer, 0, data.byteLength);
    const baseFrame = view.getUint32(0, true);
    const count = view.getUint16(4, true);
    const fieldMask = view.getUint16(6, true);

    let offset = 8;
    const result: EntityStateSnapshot = {
        baseFrame,
        count,
        fieldMask,
        entityIds: null,
        positionsX: null,
        positionsY: null,
        positionsZ: null,
        headings: null,
        health: null,
        defIds: null,
        teams: null,
        stateBits: null,
        losStates: null,
        buildProgress: null,
        pitch: null,
        roll: null,
    };

    if (fieldMask & FIELD_ENTITY_IDS) {
        result.entityIds = new Uint32Array(data.buffer, offset, count);
        offset += count * 4;
    }
    if (fieldMask & FIELD_POSITION_X) {
        result.positionsX = new Float32Array(data.buffer, offset, count);
        offset += count * 4;
    }
    if (fieldMask & FIELD_POSITION_Y) {
        result.positionsY = new Float32Array(data.buffer, offset, count);
        offset += count * 4;
    }
    if (fieldMask & FIELD_POSITION_Z) {
        result.positionsZ = new Float32Array(data.buffer, offset, count);
        offset += count * 4;
    }
    if (fieldMask & FIELD_HEADING) {
        result.headings = new Uint16Array(data.buffer, offset, count);
        offset += count * 2;
    }
    if (fieldMask & FIELD_HEALTH) {
        result.health = new Uint16Array(data.buffer, offset, count);
        offset += count * 2;
    }
    if (fieldMask & FIELD_DEF_ID) {
        result.defIds = new Uint16Array(data.buffer, offset, count);
        offset += count * 2;
    }
    if (fieldMask & FIELD_TEAM) {
        result.teams = new Uint8Array(data.buffer, offset, count);
        offset += count;
    }
    if (fieldMask & FIELD_STATE_BITS) {
        result.stateBits = new Uint8Array(data.buffer, offset, count);
        offset += count;
    }
    if (fieldMask & FIELD_LOS_STATE) {
        result.losStates = new Uint8Array(data.buffer, offset, count);
        offset += count;
    }
    if (fieldMask & FIELD_BUILD_PROGRESS) {
        result.buildProgress = new Uint8Array(data.buffer, offset, count);
        offset += count;
    }
    if (fieldMask & FIELD_PITCH) {
        result.pitch = new Int8Array(data.buffer, offset, count);
        offset += count;
    }
    if (fieldMask & FIELD_ROLL) {
        result.roll = new Int8Array(data.buffer, offset, count);
        offset += count;
    }

    return result;
}
