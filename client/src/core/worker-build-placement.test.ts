import { describe, it, expect } from 'vitest';
import { snapToBuildGrid } from './worker-build-placement.js';

/**
 * snapToBuildGrid is a byte-identical port of Recoil's CGameHelper::Pos2BuildPos:
 * a 16-elmo grid with a parity offset keyed on bit 1 of the footprint (engine
 * checks `xsize & 2`, NOT `xsize & 1`). ZK's mex_spot_finder.AdjustCoordinates
 * produces the same grid, so this must stay exact — mismatches silently drop
 * mex builds (metalSpotsByPos[x][z] lookup misses).
 */
describe('snapToBuildGrid (Pos2BuildPos parity)', () => {
    it('snaps even-parity footprints (xsize & 2 == 0) to the 16k grid', () => {
        // xsize=4 → 4 & 2 == 0 → floor((x+8)/16)*16
        expect(snapToBuildGrid(100, 100, 4, 4)).toEqual([96, 96]);
        expect(snapToBuildGrid(0, 0, 8, 8)).toEqual([0, 0]);
        expect(snapToBuildGrid(8, 8, 4, 4)).toEqual([16, 16]);   // +8 rounds up
        expect(snapToBuildGrid(7, 7, 4, 4)).toEqual([0, 0]);     // just under
    });

    it('snaps odd-parity footprints (xsize & 2 != 0) to the 16k+8 grid', () => {
        // xsize=6 → 6 & 2 == 2 → floor(x/16)*16 + 8
        expect(snapToBuildGrid(100, 100, 6, 6)).toEqual([104, 104]);
        expect(snapToBuildGrid(0, 0, 2, 2)).toEqual([8, 8]);
        expect(snapToBuildGrid(24, 24, 3, 3)).toEqual([24, 24]); // 1*16+8
        expect(snapToBuildGrid(15, 15, 2, 2)).toEqual([8, 8]);
    });

    it('keys the offset on bit 1 of the footprint, not bit 0', () => {
        // xsize 4 and 5 differ in bit 0 but share bit 1 (both clear) → same grid.
        expect(snapToBuildGrid(100, 100, 4, 4)).toEqual(snapToBuildGrid(100, 100, 5, 5));
        // xsize 6 and 7 share bit 1 (both set) → same grid.
        expect(snapToBuildGrid(100, 100, 6, 6)).toEqual(snapToBuildGrid(100, 100, 7, 7));
        // 4 (bit1 clear) vs 6 (bit1 set) differ.
        expect(snapToBuildGrid(100, 100, 4, 4)).not.toEqual(snapToBuildGrid(100, 100, 6, 6));
    });

    it('applies X and Z parity independently', () => {
        // xsize=4 (even) → X on 16k grid; zsize=6 (odd) → Z on 16k+8 grid.
        expect(snapToBuildGrid(100, 100, 4, 6)).toEqual([96, 104]);
    });

    it('handles negative coordinates (floor toward -inf)', () => {
        expect(snapToBuildGrid(-10, -10, 4, 4)).toEqual([-16, -16]);
        expect(snapToBuildGrid(-10, -10, 6, 6)).toEqual([-8, -8]);
    });
});
