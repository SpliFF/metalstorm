import { describe, it, expect } from 'vitest';
import { atlasSpecFor, type ImpostorManifestEntry } from './feature-renderer.js';
import type { MapFeatureDefInfo } from './map-data.js';
import {
    AZIMUTH_PHASE_COL0_BACK, AZIMUTH_PHASE_COL0_FRONT,
} from './impostor-atlas.js';

// The manifest -> AtlasLayout seam. An atlas declares the arc and azimuth phase
// it was baked on (user decision 2026-08-03, option (b)); if either is dropped
// here the runtime silently selects cells against a DIFFERENT convention than
// the pixels were rendered for — the exact class of bug that shipped once
// already. So these cases pin the carry-through, not just the happy path.

const def = { modelUrl: 'https://host/data/maps/m/objects3d/tree_conifer.glb' } as MapFeatureDefInfo;
const extents = { width: 40, height: 60 };

const specFor = (entry: ImpostorManifestEntry) => {
    const spec = atlasSpecFor(def, entry, extents);
    if (!spec) throw new Error('expected an atlas spec');
    return spec;
};

describe('atlasSpecFor', () => {
    it('has no atlas when the manifest has no entry for the type', () => {
        expect(atlasSpecFor(def, null, extents)).toBeNull();
    });

    it('carries a declared azimuth phase through as radians', () => {
        expect(specFor({ yawBins: 8, pitchBins: 3, azimuthPhaseDegrees: 180 })
            .layout.azimuthPhase).toBeCloseTo(AZIMUTH_PHASE_COL0_FRONT, 12);
    });

    it('defaults an undeclared phase to back-anchored (today’s behaviour)', () => {
        expect(specFor({ yawBins: 8, pitchBins: 3 }).layout.azimuthPhase)
            .toBe(AZIMUTH_PHASE_COL0_BACK);
    });

    it('reads the baker’s `pitchDegrees` spelling, not just the older `pitches`', () => {
        // bake_impostors.py writes `pitchDegrees`; only `pitches` used to be
        // read, so a sidecar-derived manifest lost its arc and fell back to a
        // different one than the atlas was baked on.
        expect(specFor({ pitchBins: 3, pitchDegrees: [18, 42, 68] }).layout.pitchDegrees)
            .toEqual([18, 42, 68]);
        expect(specFor({ pitchBins: 3, pitches: [15, 45, 80] }).layout.pitchDegrees)
            .toEqual([15, 45, 80]);
    });

    it('still accepts the baker’s cols/rows spelling of the grid', () => {
        const layout = specFor({ cols: 8, rows: 3 }).layout;
        expect(layout.yawBins).toBe(8);
        expect(layout.pitchBins).toBe(3);
    });

    it('falls back to the model extents and derives the atlas url from the stem', () => {
        const spec = specFor({});
        expect(spec.width).toBe(40);
        expect(spec.height).toBe(60);
        expect(spec.diffuseUrl).toBe(
            'https://host/data/maps/m/objects3d/tree_conifer_impostor.ktx2');
    });
});
