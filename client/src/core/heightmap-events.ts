/**
 * HeightmapEvents — parses the server's per-tick heightmap deformation
 * patch (envelope byte 0x09).
 *
 * Server-authoritative deformable terrain (PLAN-deformable-terrain T2).
 * Every synced height change — engine craters (CBasicMapDamage) and the
 * Spring.*HeightMap Lua family — funnels through CReadMap::UpdateHeightMapSynced,
 * which records the changed corner-rect. The headless game loop coalesces
 * the per-tick rects into one bounding rect, reads the current corner
 * heights, and broadcasts them here. Terrain has no fog of war, so the
 * patch is not LOS-filtered — every client gets the same heights.
 *
 * Wire format, little-endian (matches Protocol::BuildHeightmapUpdate on
 * the server):
 *
 *   u8  envelope = 0x09   (already stripped by the dispatcher)
 *   u32 frame
 *   u16 x1, z1, x2, z2    // inclusive corner coords (0..mapx / 0..mapy)
 *   int16 heights[(x2-x1+1) * (z2-z1+1)]  // row-major, z outer / x inner;
 *                                         // quantised at 1/16 elmo
 *
 * Heights are int16 at 1/16 elmo (range ±2048 elmo). The client divides
 * by 16 to recover the actual world-Y height (NOT the map's normalised
 * uint16 range — deformation can dig below the authored min height).
 */

export interface HeightmapPatch {
    frame: number;
    /** Inclusive corner-coordinate bounds of the changed region. */
    x1: number;
    z1: number;
    x2: number;
    z2: number;
    /** Actual world-Y heights, row-major (z outer, x inner), already
     *  de-quantised from the int16 1/16-elmo wire encoding. */
    heights: Float32Array;
}

export function parseHeightmapPatch(input: Uint8Array): HeightmapPatch | null {
    // Header: u32 frame + 4×u16 rect = 12 bytes.
    if (input.byteLength < 12) return null;

    // Copy into a fresh buffer so DataView reads at any offset are safe.
    const data = new Uint8Array(input.length);
    data.set(input);
    const view = new DataView(data.buffer, 0, data.byteLength);

    const frame = view.getUint32(0, true);
    const x1 = view.getUint16(4, true);
    const z1 = view.getUint16(6, true);
    const x2 = view.getUint16(8, true);
    const z2 = view.getUint16(10, true);
    if (x2 < x1 || z2 < z1) return null;

    const w = x2 - x1 + 1;
    const h = z2 - z1 + 1;
    const count = w * h;

    let offset = 12;
    if (offset + count * 2 > data.byteLength) return null;

    const heights = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        heights[i] = view.getInt16(offset, true) / 16;
        offset += 2;
    }

    return { frame, x1, z1, x2, z2, heights };
}
