import { describe, it, expect } from 'vitest';
import { parseHeightmapPatch } from './heightmap-events';

// Mirror the server's Protocol::BuildHeightmapUpdate wire encoding so the
// test exercises the exact bytes the client receives (envelope byte already
// stripped by the dispatcher).
function buildPatch(
    frame: number, x1: number, z1: number, x2: number, z2: number,
    heights: number[],
): Uint8Array {
    const w = x2 - x1 + 1, h = z2 - z1 + 1;
    const buf = new Uint8Array(4 + 8 + w * h * 2);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, frame, true);
    dv.setUint16(4, x1, true);
    dv.setUint16(6, z1, true);
    dv.setUint16(8, x2, true);
    dv.setUint16(10, z2, true);
    let o = 12;
    for (const v of heights) {
        // int16 at 1/16 elmo, round-to-nearest like the server.
        let q = v * 16;
        if (q > 32767) q = 32767;
        if (q < -32768) q = -32768;
        dv.setInt16(o, Math.round(q), true);
        o += 2;
    }
    return buf;
}

describe('parseHeightmapPatch', () => {
    it('round-trips rect bounds and de-quantises heights', () => {
        const heights = [10, 20.5, -88.5, 0, 171.5, 40.0625];
        const patch = parseHeightmapPatch(buildPatch(42, 5, 7, 7, 8, heights));
        expect(patch).not.toBeNull();
        expect(patch!.frame).toBe(42);
        expect(patch!.x1).toBe(5);
        expect(patch!.z1).toBe(7);
        expect(patch!.x2).toBe(7);
        expect(patch!.z2).toBe(8);
        expect(patch!.heights.length).toBe(6); // 3 wide × 2 tall
        // 1/16-elmo quantisation is exact for multiples of 0.0625.
        expect(Array.from(patch!.heights)).toEqual(heights);
    });

    it('handles a single-cell patch', () => {
        const patch = parseHeightmapPatch(buildPatch(1, 3, 3, 3, 3, [99.5]));
        expect(patch!.heights.length).toBe(1);
        expect(patch!.heights[0]).toBe(99.5);
    });

    it('rejects a header that is too short', () => {
        expect(parseHeightmapPatch(new Uint8Array(8))).toBeNull();
    });

    it('rejects a truncated height payload', () => {
        // Declares a 3×2 = 6-cell rect but supplies only 2 cells of data.
        const full = buildPatch(1, 0, 0, 2, 1, [1, 2, 3, 4, 5, 6]);
        expect(parseHeightmapPatch(full.subarray(0, 12 + 4))).toBeNull();
    });

    it('rejects an inverted rect', () => {
        const buf = new Uint8Array(12);
        const dv = new DataView(buf.buffer);
        dv.setUint16(4, 10, true); // x1 = 10
        dv.setUint16(8, 5, true);  // x2 = 5  (x2 < x1)
        expect(parseHeightmapPatch(buf)).toBeNull();
    });
});
