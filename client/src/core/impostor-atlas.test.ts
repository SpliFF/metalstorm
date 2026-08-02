import { describe, it, expect } from 'vitest';
import {
    DEFAULT_ATLAS_LAYOUT,
    SINGLE_CELL_LAYOUT,
    PITCH_BIN_DEGREES,
    normalizeAtlasLayout,
    atlasCellCount,
    atlasRowCount,
    quantizeYawBin,
    pitchBinCentres,
    selectPitchRow,
    atlasCellIndex,
    selectAtlasCell,
    atlasCellUv,
    cardTiltsWithPitch,
} from './impostor-atlas.js';

// PLAN-metalstorm-impostors.md "Atlas format (v2)". The baker and the runtime
// must agree on this grid or you get a silent wrong-frame bug, so the
// convention is pinned here: columns = camera azimuth relative to the
// instance's forward axis, rows = camera elevation, frames stack downward.

const deg = (d: number): number => (d * Math.PI) / 180;

describe('normalizeAtlasLayout', () => {
    it('defaults a missing/garbage layout to a single cell (legacy atlas)', () => {
        expect(normalizeAtlasLayout(null)).toEqual(SINGLE_CELL_LAYOUT);
        expect(normalizeAtlasLayout({ yawBins: 0, pitchBins: -3 })).toEqual(SINGLE_CELL_LAYOUT);
        expect(normalizeAtlasLayout({ yawBins: NaN })).toEqual(SINGLE_CELL_LAYOUT);
    });

    it('floors fractional bin counts', () => {
        expect(normalizeAtlasLayout({ yawBins: 8.9, pitchBins: 3.2, frames: 1 }))
            .toEqual({ yawBins: 8, pitchBins: 3, frames: 1 });
    });
});

describe('atlas geometry', () => {
    it('counts cells and rows for the v2 default', () => {
        expect(atlasCellCount(DEFAULT_ATLAS_LAYOUT)).toBe(24);
        expect(atlasRowCount(DEFAULT_ATLAS_LAYOUT)).toBe(3);
    });

    it('stacks flipbook frames as further row groups', () => {
        const layout = { yawBins: 8, pitchBins: 3, frames: 4 };
        expect(atlasRowCount(layout)).toBe(12);
        expect(atlasCellCount(layout)).toBe(96);
    });
});

describe('quantizeYawBin', () => {
    it('matches quantizeHeading for the 8-bin case', () => {
        expect(quantizeYawBin(0, 8)).toBe(0);
        expect(quantizeYawBin(Math.PI / 4, 8)).toBe(1);
        expect(quantizeYawBin(Math.PI, 8)).toBe(4);
        expect(quantizeYawBin(-Math.PI / 4, 8)).toBe(7);
        expect(quantizeYawBin(2 * Math.PI + 0.001, 8)).toBe(0);
    });

    it('rounds to the nearest bin rather than flooring', () => {
        expect(quantizeYawBin(Math.PI / 8 + 0.01, 8)).toBe(1);
        expect(quantizeYawBin(Math.PI / 8 - 0.01, 8)).toBe(0);
    });

    it('collapses to bin 0 for a single-column atlas', () => {
        expect(quantizeYawBin(3.1, 1)).toBe(0);
    });

    it('generalises to other grid widths', () => {
        expect(quantizeYawBin(Math.PI / 2, 4)).toBe(1);
        expect(quantizeYawBin(deg(30), 16)).toBe(1);
    });
});

describe('selectPitchRow', () => {
    it('uses the authored 15/45/80 split for the canonical 3-row atlas', () => {
        expect(pitchBinCentres(3)).toEqual([...PITCH_BIN_DEGREES]);
        expect(selectPitchRow(deg(10), 3)).toBe(0);
        expect(selectPitchRow(deg(40), 3)).toBe(1);
        expect(selectPitchRow(deg(85), 3)).toBe(2);
    });

    it('clamps a camera below the horizon to the lowest row', () => {
        expect(selectPitchRow(deg(-40), 3)).toBe(0);
    });

    it('clamps a straight-overhead camera to the top row', () => {
        expect(selectPitchRow(deg(120), 3)).toBe(2);
    });

    it('collapses to row 0 for a single-row atlas', () => {
        expect(selectPitchRow(deg(80), 1)).toBe(0);
    });

    it('spreads evenly for non-canonical row counts', () => {
        expect(pitchBinCentres(2)).toEqual([22.5, 67.5]);
        expect(selectPitchRow(deg(10), 2)).toBe(0);
        expect(selectPitchRow(deg(80), 2)).toBe(1);
    });

    it("prefers the baker's own arc when the sidecar reports one", () => {
        // bake_impostors.py bakes 18/42/68, not the hand-authored 15/45/80.
        const baked = [18, 42, 68];
        expect(pitchBinCentres(3, baked)).toEqual(baked);
        // 55deg is nearer 45 than 80 either way, but 75deg flips: nearest of
        // {15,45,80} is 80 (row 2), nearest of {18,42,68} is 68 (row 2) —
        // 56deg is the discriminating case (row 1 vs row 2).
        expect(selectPitchRow(deg(56), 3)).toBe(1);
        expect(selectPitchRow(deg(56), 3, baked)).toBe(2);
    });

    it('carries the baked arc through normalizeAtlasLayout and cell select', () => {
        const layout = normalizeAtlasLayout({ yawBins: 8, pitchBins: 3, frames: 1, pitchDegrees: [18, 42, 68] });
        expect(layout.pitchDegrees).toEqual([18, 42, 68]);
        // Camera 56deg up, dead in front: row 2 under the baked arc.
        const d = 100;
        const cell = selectAtlasCell(0, d * Math.tan(deg(56)), d, 0, layout);
        expect(Math.floor(cell / 8)).toBe(2);
    });

    it('ignores a pitchDegrees array that does not match the row count', () => {
        expect(normalizeAtlasLayout({ yawBins: 8, pitchBins: 3, frames: 1, pitchDegrees: [10, 20] })
            .pitchDegrees).toBeUndefined();
    });
});

describe('atlasCellIndex', () => {
    it('lays cells out row-major with frames stacked below', () => {
        const layout = { yawBins: 8, pitchBins: 3, frames: 2 };
        expect(atlasCellIndex(0, 0, 0, layout)).toBe(0);
        expect(atlasCellIndex(3, 0, 0, layout)).toBe(3);
        expect(atlasCellIndex(0, 1, 0, layout)).toBe(8);
        expect(atlasCellIndex(0, 0, 1, layout)).toBe(24);
        expect(atlasCellIndex(7, 2, 1, layout)).toBe(47);
    });

    it('clamps out-of-range inputs instead of producing a wild index', () => {
        expect(atlasCellIndex(99, 99, 99, DEFAULT_ATLAS_LAYOUT)).toBe(23);
        expect(atlasCellIndex(-5, -5, -5, DEFAULT_ATLAS_LAYOUT)).toBe(0);
    });
});

describe('selectAtlasCell', () => {
    it('picks the dead-front column when the camera is in front of the instance', () => {
        // Instance heading 0 = facing +Z; camera on +Z at 15deg elevation.
        const cell = selectAtlasCell(0, 26.79, 100, 0, DEFAULT_ATLAS_LAYOUT);
        expect(cell % 8).toBe(0);
        expect(Math.floor(cell / 8)).toBe(0);
    });

    it('picks the back column when the camera is behind the instance', () => {
        const cell = selectAtlasCell(0, 26.79, -100, 0, DEFAULT_ATLAS_LAYOUT);
        expect(cell % 8).toBe(4);
    });

    it('is relative to the instance heading, not the world axes', () => {
        // Camera due +Z, instance turned to face the camera => front view again.
        const cell = selectAtlasCell(0, 26.79, 100, 0, DEFAULT_ATLAS_LAYOUT);
        // Instance rotated 90deg: the camera now sees its left/right side.
        const turned = selectAtlasCell(0, 26.79, 100, Math.PI / 2, DEFAULT_ATLAS_LAYOUT);
        expect(cell % 8).toBe(0);
        expect(turned % 8).toBe(6);
    });

    it('climbs the pitch rows as the camera rises', () => {
        const low = selectAtlasCell(0, 26, 100, 0, DEFAULT_ATLAS_LAYOUT);
        const mid = selectAtlasCell(0, 100, 100, 0, DEFAULT_ATLAS_LAYOUT);
        const high = selectAtlasCell(0, 600, 100, 0, DEFAULT_ATLAS_LAYOUT);
        expect(Math.floor(low / 8)).toBe(0);
        expect(Math.floor(mid / 8)).toBe(1);
        expect(Math.floor(high / 8)).toBe(2);
    });

    it('reads a straight-overhead camera as the top pitch row', () => {
        expect(Math.floor(selectAtlasCell(0, 500, 0, 0, DEFAULT_ATLAS_LAYOUT) / 8)).toBe(2);
    });

    it('is always cell 0 for a legacy single-view atlas', () => {
        expect(selectAtlasCell(37, 91, -12, 1.3, SINGLE_CELL_LAYOUT)).toBe(0);
    });
});

describe('atlasCellUv', () => {
    it('is the whole texture for a single-cell atlas', () => {
        expect(atlasCellUv(0, SINGLE_CELL_LAYOUT)).toEqual({ su: 1, sv: 1, ou: 0, ov: 0 });
    });

    it('maps cell 0 to the TOP-LEFT of the image (baker convention)', () => {
        const uv = atlasCellUv(0, DEFAULT_ATLAS_LAYOUT);
        expect(uv.su).toBeCloseTo(1 / 8, 6);
        expect(uv.sv).toBeCloseTo(1 / 3, 6);
        expect(uv.ou).toBe(0);
        expect(uv.ov).toBeCloseTo(2 / 3, 6);   // top row in GL's bottom-up V
    });

    it('walks columns left to right and rows top to bottom', () => {
        expect(atlasCellUv(3, DEFAULT_ATLAS_LAYOUT).ou).toBeCloseTo(3 / 8, 6);
        expect(atlasCellUv(8, DEFAULT_ATLAS_LAYOUT).ov).toBeCloseTo(1 / 3, 6);
        expect(atlasCellUv(16, DEFAULT_ATLAS_LAYOUT).ov).toBeCloseTo(0, 6);
    });

    it('flips row order when the atlas is stored bottom-up', () => {
        expect(atlasCellUv(0, DEFAULT_ATLAS_LAYOUT, false).ov).toBe(0);
        expect(atlasCellUv(8, DEFAULT_ATLAS_LAYOUT, false).ov).toBeCloseTo(1 / 3, 6);
    });

    it('clamps an out-of-range cell into the grid', () => {
        expect(atlasCellUv(999, DEFAULT_ATLAS_LAYOUT)).toEqual(atlasCellUv(23, DEFAULT_ATLAS_LAYOUT));
    });
});

// §Card orientation: a card may only tilt with the camera pitch if its atlas
// actually holds elevation rows for the steep view to land on.
describe('card tilt rule', () => {
    it('tilts only when the atlas has more than one elevation row', () => {
        expect(cardTiltsWithPitch(DEFAULT_ATLAS_LAYOUT)).toBe(true);
        expect(cardTiltsWithPitch(SINGLE_CELL_LAYOUT)).toBe(false);
    });

    it('does not tilt a multi-column, single-row sheet', () => {
        // 8 yaw views but one horizon-level elevation: turning is correct,
        // tilting would lay that horizon view flat on the ground.
        expect(cardTiltsWithPitch({ yawBins: 8, pitchBins: 1, frames: 1 })).toBe(false);
    });

    it('ignores flipbook frames — only elevation rows license a tilt', () => {
        expect(cardTiltsWithPitch({ yawBins: 8, pitchBins: 1, frames: 4 })).toBe(false);
        expect(cardTiltsWithPitch({ yawBins: 8, pitchBins: 2, frames: 4 })).toBe(true);
    });
});
