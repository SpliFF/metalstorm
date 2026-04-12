/**
 * ProjectileState — parses binary projectile state snapshots.
 *
 * Wire format (struct-of-arrays, little-endian):
 *
 *   Header (4 bytes):
 *     u16 projectile_count
 *     u16 field_mask
 *
 *   Per-field arrays (contiguous, present only if corresponding bit set):
 *     Bit 0: projectile_ids   → u32[count]
 *     Bit 1: weapon_def_ids   → u16[count]
 *     Bit 2: positions_x      → f32[count]
 *     Bit 3: positions_y      → f32[count]
 *     Bit 4: positions_z      → f32[count]
 *     Bit 5: dir_x            → f32[count]
 *     Bit 6: dir_y            → f32[count]
 *     Bit 7: dir_z            → f32[count]
 *     Bit 8: team             → u8[count]
 */

export const PROJ_FIELD_IDS          = 1 << 0;
export const PROJ_FIELD_WEAPON_DEF   = 1 << 1;
export const PROJ_FIELD_POSITION_X   = 1 << 2;
export const PROJ_FIELD_POSITION_Y   = 1 << 3;
export const PROJ_FIELD_POSITION_Z   = 1 << 4;
export const PROJ_FIELD_DIR_X        = 1 << 5;
export const PROJ_FIELD_DIR_Y        = 1 << 6;
export const PROJ_FIELD_DIR_Z        = 1 << 7;
export const PROJ_FIELD_TEAM         = 1 << 8;

/** Parsed projectile state snapshot — typed arrays are views into the buffer. */
export interface ProjectileStateSnapshot {
    count: number;
    fieldMask: number;
    projectileIds: Uint32Array  | null;
    weaponDefIds:  Uint16Array  | null;
    positionsX:    Float32Array | null;
    positionsY:    Float32Array | null;
    positionsZ:    Float32Array | null;
    dirX:          Float32Array | null;
    dirY:          Float32Array | null;
    dirZ:          Float32Array | null;
    teams:         Uint8Array   | null;
}

/**
 * Parse a binary projectile state buffer (after stripping the envelope byte).
 * Returns typed array views into the underlying ArrayBuffer — no copies
 * except the initial alignment copy.
 */
export function parseProjectileState(input: Uint8Array): ProjectileStateSnapshot | null {
    if (input.byteLength < 4) return null;

    // Copy to an aligned buffer so typed array views work correctly
    const data = new Uint8Array(input.length);
    data.set(input);

    const view = new DataView(data.buffer, 0, data.byteLength);
    const count = view.getUint16(0, true);
    const fieldMask = view.getUint16(2, true);

    let offset = 4;
    const result: ProjectileStateSnapshot = {
        count,
        fieldMask,
        projectileIds: null,
        weaponDefIds: null,
        positionsX: null,
        positionsY: null,
        positionsZ: null,
        dirX: null,
        dirY: null,
        dirZ: null,
        teams: null,
    };

    if (fieldMask & PROJ_FIELD_IDS) {
        result.projectileIds = new Uint32Array(data.buffer, offset, count);
        offset += count * 4;
    }
    if (fieldMask & PROJ_FIELD_WEAPON_DEF) {
        result.weaponDefIds = new Uint16Array(data.buffer, offset, count);
        offset += count * 2;
    }
    if (fieldMask & PROJ_FIELD_POSITION_X) {
        result.positionsX = new Float32Array(data.buffer, offset, count);
        offset += count * 4;
    }
    if (fieldMask & PROJ_FIELD_POSITION_Y) {
        result.positionsY = new Float32Array(data.buffer, offset, count);
        offset += count * 4;
    }
    if (fieldMask & PROJ_FIELD_POSITION_Z) {
        result.positionsZ = new Float32Array(data.buffer, offset, count);
        offset += count * 4;
    }
    if (fieldMask & PROJ_FIELD_DIR_X) {
        result.dirX = new Float32Array(data.buffer, offset, count);
        offset += count * 4;
    }
    if (fieldMask & PROJ_FIELD_DIR_Y) {
        result.dirY = new Float32Array(data.buffer, offset, count);
        offset += count * 4;
    }
    if (fieldMask & PROJ_FIELD_DIR_Z) {
        result.dirZ = new Float32Array(data.buffer, offset, count);
        offset += count * 4;
    }
    if (fieldMask & PROJ_FIELD_TEAM) {
        result.teams = new Uint8Array(data.buffer, offset, count);
        offset += count;
    }

    return result;
}
