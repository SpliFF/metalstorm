/**
 * EntityState — parses Tier 2 binary entity state updates.
 *
 * Wire format (struct-of-arrays, little-endian):
 *
 *   Header (4 bytes):
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
 */

export const FIELD_ENTITY_IDS = 1 << 0;
export const FIELD_POSITION_X = 1 << 1;
export const FIELD_POSITION_Y = 1 << 2;
export const FIELD_POSITION_Z = 1 << 3;
export const FIELD_HEADING    = 1 << 4;
export const FIELD_HEALTH     = 1 << 5;
export const FIELD_DEF_ID     = 1 << 6;
export const FIELD_TEAM       = 1 << 7;

/** Parsed entity state snapshot — typed arrays are zero-copy views into the buffer. */
export interface EntityStateSnapshot {
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
}

/**
 * Parse a Tier 2 binary entity state buffer (after stripping the envelope byte).
 * Returns typed array views into the underlying ArrayBuffer — no copies.
 */
export function parseEntityState(data: Uint8Array): EntityStateSnapshot | null {
    if (data.byteLength < 4) return null;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const count = view.getUint16(0, true);
    const fieldMask = view.getUint16(2, true);

    let offset = 4;
    const result: EntityStateSnapshot = {
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
    };

    if (fieldMask & FIELD_ENTITY_IDS) {
        result.entityIds = new Uint32Array(data.buffer, data.byteOffset + offset, count);
        offset += count * 4;
    }
    if (fieldMask & FIELD_POSITION_X) {
        result.positionsX = new Float32Array(data.buffer, data.byteOffset + offset, count);
        offset += count * 4;
    }
    if (fieldMask & FIELD_POSITION_Y) {
        result.positionsY = new Float32Array(data.buffer, data.byteOffset + offset, count);
        offset += count * 4;
    }
    if (fieldMask & FIELD_POSITION_Z) {
        result.positionsZ = new Float32Array(data.buffer, data.byteOffset + offset, count);
        offset += count * 4;
    }
    if (fieldMask & FIELD_HEADING) {
        result.headings = new Uint16Array(data.buffer, data.byteOffset + offset, count);
        offset += count * 2;
    }
    if (fieldMask & FIELD_HEALTH) {
        result.health = new Uint16Array(data.buffer, data.byteOffset + offset, count);
        offset += count * 2;
    }
    if (fieldMask & FIELD_DEF_ID) {
        result.defIds = new Uint16Array(data.buffer, data.byteOffset + offset, count);
        offset += count * 2;
    }
    if (fieldMask & FIELD_TEAM) {
        result.teams = new Uint8Array(data.buffer, data.byteOffset + offset, count);
        offset += count;
    }

    return result;
}
