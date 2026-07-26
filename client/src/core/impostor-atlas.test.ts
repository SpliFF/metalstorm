import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    YAW_BINS, PITCH_BINS, FRAMES, CELL_PX, PITCH_DEGREES,
    DEFAULT_GRID, isDirectional, atlasRows,
    selectColumn, selectPitchRow, packCellIndex, selectCellIndex, cellUvRect,
    type AtlasGrid,
} from './impostor-atlas.js';

const G8x3: AtlasGrid = { yawBins: 8, pitchBins: 3, frames: 1 };

// The world unit→camera direction (horizontal) that the baker's column `col`
// corresponds to, once the model is placed at wire heading `h`. Derived in the
// module header: model forward (−Z) → world (−sin h, −cos h) under
// RotationYawPitchRoll(h), and the baker's per-column model-frame cam dir is
// (−sin θ, −cos θ) with θ = col·2π/yawBins. This is the SAME transform
// entity-renderer/squad-render-backend use to place the real 3D model, so a
// column selected from it shows the face a model would show — the top
// correctness risk the plan flags, pinned here on both sides.
function viewYawForColumn(col: number, heading: number, yawBins: number): number {
    const theta = (col * 2 * Math.PI) / yawBins;
    const a = theta + heading;
    return Math.atan2(-Math.sin(a), -Math.cos(a)); // atan2(V.x, V.z), V = unit→camera
}

describe('impostor-atlas constants mirror impostor_convention.py', () => {
    it('YAW_BINS/PITCH_BINS/FRAMES/CELL/PITCH_DEGREES match the Python source', () => {
        const py = readFileSync(fileURLToPath(new URL(
            '../../../tools/fable-model-forge/impostor_convention.py', import.meta.url)), 'utf8');
        const intOf = (name: string) => {
            const m = py.match(new RegExp(`^${name}\\s*=\\s*(\\d+)`, 'm'));
            expect(m, `${name} not found in impostor_convention.py`).toBeTruthy();
            return Number(m![1]);
        };
        expect(intOf('YAW_BINS')).toBe(YAW_BINS);
        expect(intOf('PITCH_BINS')).toBe(PITCH_BINS);
        expect(intOf('FRAMES')).toBe(FRAMES);
        expect(intOf('CELL')).toBe(CELL_PX);

        const pd = py.match(/PITCH_DEGREES\s*=\s*\[([^\]]+)\]/);
        expect(pd, 'PITCH_DEGREES not found').toBeTruthy();
        const degs = pd![1].split(',').map((s) => Number(s.trim()));
        expect(degs).toEqual(PITCH_DEGREES);
    });
});

describe('selectColumn — relative-yaw column math', () => {
    it('col0 = front, col2 = right, col4 = back, col6 = left (baker anchors)', () => {
        // Camera placed at each anchor for a unit facing heading 0.
        expect(selectColumn(viewYawForColumn(0, 0, 8), 0, 8)).toBe(0);
        expect(selectColumn(viewYawForColumn(2, 0, 8), 0, 8)).toBe(2);
        expect(selectColumn(viewYawForColumn(4, 0, 8), 0, 8)).toBe(4);
        expect(selectColumn(viewYawForColumn(6, 0, 8), 0, 8)).toBe(6);
    });

    it('agrees with the bake convention for every column at several headings', () => {
        for (const h of [0, 0.7, Math.PI / 2, Math.PI, -1.2, 2.9, -Math.PI]) {
            for (let c = 0; c < 8; c++) {
                expect(selectColumn(viewYawForColumn(c, h, 8), h, 8)).toBe(c);
            }
        }
    });

    it('is heading-relative: rotating the unit rotates the selected column', () => {
        // Fixed camera direction, unit rotates a quarter turn → column shifts by 2.
        const viewYaw = 0.3;
        const c0 = selectColumn(viewYaw, 0, 8);
        const c1 = selectColumn(viewYaw, Math.PI / 2, 8);
        expect(((c0 - c1) % 8 + 8) % 8).toBe(2);
    });

    it('wraps around the ±π seam without a discontinuity', () => {
        // Two view yaws either side of the wrap must land on the same column
        // when they're within the same 45° bin.
        expect(selectColumn(Math.PI - 0.001, 0, 8)).toBe(selectColumn(-Math.PI + 0.001, 0, 8));
        // negative and >2π headings normalise
        expect(selectColumn(viewYawForColumn(3, -Math.PI * 3, 8), -Math.PI * 3, 8)).toBe(3);
    });

    it('collapses to column 0 for a non-directional (yawBins=1) atlas', () => {
        expect(selectColumn(1.234, 0.5, 1)).toBe(0);
    });
});

describe('selectPitchRow — pitch binning', () => {
    it('bins camera elevation to the nearest of 15° / 45° / 80°', () => {
        const r = (deg: number) => selectPitchRow((deg * Math.PI) / 180, 3);
        expect(r(0)).toBe(0);      // level → 15° row
        expect(r(15)).toBe(0);
        expect(r(29)).toBe(0);     // nearer 15 than 45
        expect(r(31)).toBe(1);     // nearer 45
        expect(r(45)).toBe(1);
        expect(r(62)).toBe(1);     // nearer 45 than 80
        expect(r(64)).toBe(2);     // nearer 80
        expect(r(80)).toBe(2);
        expect(r(90)).toBe(2);     // straight-down clamps to steepest
    });

    it('clamps a below-horizon (negative) elevation to the shallow row', () => {
        expect(selectPitchRow(-0.5, 3)).toBe(0);
    });

    it('is row 0 for a single-pitch atlas', () => {
        expect(selectPitchRow(1.0, 1)).toBe(0);
    });
});

describe('packCellIndex / cellUvRect — per-cell mapping', () => {
    it('packs (col, pitch, frame) as row*yawBins + col with frames stacking down', () => {
        expect(packCellIndex(0, 0, 0, G8x3)).toBe(0);
        expect(packCellIndex(3, 0, 0, G8x3)).toBe(3);
        expect(packCellIndex(0, 1, 0, G8x3)).toBe(8);    // row 1
        expect(packCellIndex(5, 2, 0, G8x3)).toBe(21);   // row 2, col 5
        // frame 1 (fx-offload X2) → row = 1*3 + pitch, stacked below the pitch rows
        expect(packCellIndex(0, 0, 1, G8x3)).toBe(3 * 8);
    });

    it('cellUvRect tiles the atlas into yawBins × (pitchBins*frames) cells', () => {
        expect(atlasRows(G8x3)).toBe(3);
        const c00 = cellUvRect(0, 0, G8x3);
        expect(c00).toEqual({ u0: 0, v0: 0, du: 1 / 8, dv: 1 / 3 });
        const c = cellUvRect(3, 2, G8x3);
        expect(c.u0).toBeCloseTo(3 / 8);
        expect(c.v0).toBeCloseTo(2 / 3);
        expect(c.du).toBeCloseTo(1 / 8);
        expect(c.dv).toBeCloseTo(1 / 3);
    });

    it('selectCellIndex combines column + pitch row into one packed index', () => {
        // Camera dead in front, level-ish → col0, pitch ~0 → row0 → cell 0.
        const front = viewYawForColumn(0, 0, 8);
        const vx = Math.sin(front), vz = Math.cos(front);
        expect(selectCellIndex(vx, 0.001, vz, 0, G8x3)).toBe(0);
        // Same camera, but 45° elevation → row1 → cell 8.
        const d = Math.hypot(vx, vz);
        const vy = d * Math.tan((45 * Math.PI) / 180);
        expect(selectCellIndex(vx, vy, vz, 0, G8x3)).toBe(8);
    });
});

describe('grid helpers', () => {
    it('DEFAULT_GRID is a non-directional 1×1×1', () => {
        expect(isDirectional(DEFAULT_GRID)).toBe(false);
        expect(isDirectional(G8x3)).toBe(true);
    });
});
