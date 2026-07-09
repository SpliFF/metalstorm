import { describe, it, expect } from 'vitest';
import { snapToBuildGrid, computeBuildPositions } from './worker-build-placement.js';

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

/**
 * computeBuildPositions (G3b) — Spring CGuiHandler build-drag row/rect/hollow.
 * Footprint step = xsize*8 elmos + buildSpacing*16; both ends grid-snapped. All
 * cases use xsize=zsize=4 (32-elmo step at spacing 0), whose snap grid is the
 * 16k grid — so tile centres land on multiples of 32 from the snapped origin.
 */
describe('computeBuildPositions (build-drag rows)', () => {
    it('walks a line along the longer axis (X)', () => {
        expect(computeBuildPositions(0, 0, 100, 0, 4, 4, 0, 'line'))
            .toEqual([[0, 0], [32, 0], [64, 0], [96, 0]]);
    });

    it('walks a line along the longer axis (Z)', () => {
        expect(computeBuildPositions(0, 0, 0, 100, 4, 4, 0, 'line'))
            .toEqual([[0, 0], [0, 32], [0, 64], [0, 96]]);
    });

    it('collapses a zero-length drag to a single tile', () => {
        expect(computeBuildPositions(50, 50, 50, 50, 4, 4, 0, 'line')).toHaveLength(1);
    });

    it('widens the footprint step by buildSpacing (16 elmos/square)', () => {
        // step = 4*8 + 1*16 = 48; 96/48 = 2 → 3 tiles.
        expect(computeBuildPositions(0, 0, 100, 0, 4, 4, 1, 'line'))
            .toEqual([[0, 0], [48, 0], [96, 0]]);
    });

    it('serpent-walks a filled rectangle (rows alternate X direction)', () => {
        expect(computeBuildPositions(0, 0, 96, 32, 4, 4, 0, 'rect')).toEqual([
            [0, 0], [32, 0], [64, 0], [96, 0],     // row z=0 →
            [96, 32], [64, 32], [32, 32], [0, 32], // row z=32 ← (reversed)
        ]);
    });

    it('walks the perimeter only for a hollow rectangle', () => {
        const hollow = computeBuildPositions(0, 0, 64, 64, 4, 4, 0, 'hollow');
        // 3×3 grid → 8 perimeter tiles, centre skipped.
        expect(hollow).toEqual([
            [0, 0], [32, 0], [64, 0],   // top L→R
            [64, 32], [64, 64],         // right ↓
            [32, 64], [0, 64],          // bottom R→L
            [0, 32],                    // left ↑
        ]);
        expect(hollow).not.toContainEqual([32, 32]); // centre excluded
    });

    it('treats a 1-wide hollow rect as a line', () => {
        expect(computeBuildPositions(0, 0, 0, 64, 4, 4, 0, 'hollow'))
            .toEqual([[0, 0], [0, 32], [0, 64]]);
    });

    it('respects drag direction (negative axis)', () => {
        expect(computeBuildPositions(0, 0, -100, 0, 4, 4, 0, 'line'))
            .toEqual([[0, 0], [-32, 0], [-64, 0], [-96, 0]]);
    });
});
