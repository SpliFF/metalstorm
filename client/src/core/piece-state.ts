/**
 * PieceState — parses binary per-unit piece transform snapshots
 * (envelope byte 0x05).
 *
 * Wire format, little-endian:
 *
 *   Header (6 bytes):
 *     u32 frame
 *     u16 unit_count
 *
 *   Per-unit block (variable):
 *     u32 unit_id
 *     u8  piece_count
 *     [u8 piece_idx, f32 px, f32 py, f32 pz, f32 rx, f32 ry, f32 rz]
 *       × piece_count
 *
 * `pos` is the absolute piece position in its parent's frame (rest
 * pose has it equal to the piece's offset from its parent), and
 * `rot` is Euler XYZ in radians (rest = 0,0,0). Pieces matching their
 * rest pose are not present — the renderer leaves them at rest.
 */

export interface PiecePose {
    pieceIdx: number;
    px: number; py: number; pz: number;
    rx: number; ry: number; rz: number;
}

export interface UnitPieceSnapshot {
    unitId: number;
    pieces: PiecePose[];
}

export interface PieceStateSnapshot {
    frame: number;
    units: UnitPieceSnapshot[];
}

export function parsePieceState(input: Uint8Array): PieceStateSnapshot | null {
    if (input.byteLength < 6) return null;

    // Align into a fresh buffer so DataView reads at any offset are safe.
    const data = new Uint8Array(input.length);
    data.set(input);
    const view = new DataView(data.buffer, 0, data.byteLength);

    const frame = view.getUint32(0, true);
    const unitCount = view.getUint16(4, true);
    let offset = 6;

    const units: UnitPieceSnapshot[] = [];
    units.length = unitCount;

    for (let u = 0; u < unitCount; u++) {
        if (offset + 5 > data.byteLength) return null;
        const unitId = view.getUint32(offset, true); offset += 4;
        const pieceCount = view.getUint8(offset);    offset += 1;

        const pieces: PiecePose[] = new Array(pieceCount);
        for (let p = 0; p < pieceCount; p++) {
            // 1 (idx) + 6*4 (floats) = 25 bytes per piece
            if (offset + 25 > data.byteLength) return null;
            const pieceIdx = view.getUint8(offset); offset += 1;
            const px = view.getFloat32(offset, true); offset += 4;
            const py = view.getFloat32(offset, true); offset += 4;
            const pz = view.getFloat32(offset, true); offset += 4;
            const rx = view.getFloat32(offset, true); offset += 4;
            const ry = view.getFloat32(offset, true); offset += 4;
            const rz = view.getFloat32(offset, true); offset += 4;
            pieces[p] = { pieceIdx, px, py, pz, rx, ry, rz };
        }

        units[u] = { unitId, pieces };
    }

    return { frame, units };
}
