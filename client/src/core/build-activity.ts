/**
 * BuildActivity — parses the server's per-tick "who is nano-spraying
 * whom" snapshot (envelope byte 0x06).
 *
 * Wire format, little-endian (matches BuildActivitySerializer.h on the
 * server):
 *
 *   Header (6 bytes):
 *     u32 frame
 *     u16 builder_count
 *
 *   Per-builder block (variable):
 *     u32 builder_id
 *     u32 target_id        // 0 = no entity target, 0xFFFFFFFE = feature
 *     f32 target_x, target_y, target_z
 *     f32 target_radius
 *     u8  kind             // 0=build 1=repair 2=reclaim 3=resurrect
 *                           //  4=capture 5=terraform
 *     u8  piece_count
 *     u8  pieces[piece_count]
 *     f32 strength         // builder's effective build power, 0..1+
 */

export const KIND_BUILD     = 0;
export const KIND_REPAIR    = 1;
export const KIND_RECLAIM   = 2;
export const KIND_RESURRECT = 3;
export const KIND_CAPTURE   = 4;
export const KIND_TERRAFORM = 5;

export const TARGET_FEATURE = 0xFFFFFFFE;

export interface BuildAction {
    builderId: number;
    /** 0 if no entity target; TARGET_FEATURE if the target is a feature
     *  (use targetX/Y/Z); otherwise the entity id of the target unit. */
    targetId: number;
    targetX: number;
    targetY: number;
    targetZ: number;
    targetRadius: number;
    kind: number;
    pieces: number[];
    strength: number;
}

export interface BuildActivitySnapshot {
    frame: number;
    actions: BuildAction[];
}

export function parseBuildActivity(input: Uint8Array): BuildActivitySnapshot | null {
    if (input.byteLength < 6) return null;

    // Align into a fresh buffer so DataView reads at any offset are safe.
    const data = new Uint8Array(input.length);
    data.set(input);
    const view = new DataView(data.buffer, 0, data.byteLength);

    const frame = view.getUint32(0, true);
    const count = view.getUint16(4, true);
    let offset = 6;

    const actions: BuildAction[] = new Array(count);

    for (let i = 0; i < count; i++) {
        // Fixed header per builder = 4 + 4 + 12 + 4 + 1 + 1 = 26 bytes,
        // followed by piece_count u8s and one trailing f32 strength.
        if (offset + 26 > data.byteLength) return null;

        const builderId = view.getUint32(offset, true); offset += 4;
        const targetId  = view.getUint32(offset, true); offset += 4;
        const targetX   = view.getFloat32(offset, true); offset += 4;
        const targetY   = view.getFloat32(offset, true); offset += 4;
        const targetZ   = view.getFloat32(offset, true); offset += 4;
        const targetRadius = view.getFloat32(offset, true); offset += 4;
        const kind      = view.getUint8(offset);  offset += 1;
        const pieceCount = view.getUint8(offset); offset += 1;

        if (offset + pieceCount + 4 > data.byteLength) return null;

        const pieces: number[] = new Array(pieceCount);
        for (let p = 0; p < pieceCount; p++) {
            pieces[p] = view.getUint8(offset); offset += 1;
        }
        const strength = view.getFloat32(offset, true); offset += 4;

        actions[i] = {
            builderId, targetId,
            targetX, targetY, targetZ,
            targetRadius, kind, pieces, strength,
        };
    }

    return { frame, actions };
}
