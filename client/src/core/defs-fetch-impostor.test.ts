import { describe, it, expect } from 'vitest';
import { toImpostorInfo } from './defs-fetch.js';
import { selectAtlasCell, cardTiltsWithPitch } from './impostor-atlas.js';
import { cardLift, layoutOf } from './impostor-renderer.js';

// The unit-def seam: LuaDefsSerializer.inl's `impostor` block -> AtlasLayout.
//
// This is where the top correctness risk in PLAN-metalstorm-impostors.md lands
// for units. Two bakers ship in this repo whose atlases disagree by 180deg on
// what column 0 shows AND on the elevation arc, so each atlas DECLARES its own
// (user decision 2026-08-03, option (b)). A field quietly dropped in transit
// here does not fail loudly — it silently renders the wrong view, which is
// exactly what happened once already on the map-feature manifest (`pitches` vs
// `pitchDegrees`, fixed in M7). So pin the whole block.

/** What LuaDefsSerializer.inl emits for the four `infantry_v2` sheets. */
const INFANTRY_V2_BLOCK = {
    diffuse_uri: '/api/games/data/metalstorm/models/ms_soldiers_s1_impostor.ktx2',
    team_mask_uri: '/api/games/data/metalstorm/models/ms_soldiers_s1_impostor_team.ktx2',
    walk_frames: 1,
    idle_frames: 1,
    width: 12,
    height: 12,
    centre_y: 3.8457,
    yaw_bins: 8,
    pitch_bins: 3,
    frames: 1,
    azimuth_phase_degrees: 180,
    pitch_degrees: [15, 45, 80],
};

describe('toImpostorInfo — unit atlas metadata seam', () => {
    it('carries the infantry_v2 grid, arc and phase through verbatim', () => {
        const info = toImpostorInfo(INFANTRY_V2_BLOCK)!;
        expect(info.layout).toEqual({
            yawBins: 8,
            pitchBins: 3,
            frames: 1,
            pitchDegrees: [15, 45, 80],
            azimuthPhase: Math.PI,      // 180 degrees, normalised to radians
        });
        expect(info.centreY).toBeCloseTo(3.8457, 6);
        expect(info.width).toBe(12);
        expect(info.height).toBe(12);
    });

    it('reads column 0 of an infantry_v2 sheet as the unit FRONT view', () => {
        // The 180deg phase is the whole point of the option-(b) decision: the
        // default (phase 0) would make column 0 the BACK, so a sheet baked
        // front-first would render every unit turned around.
        const layout = layoutOf(toImpostorInfo(INFANTRY_V2_BLOCK));
        // Camera in FRONT of a unit facing +Z (heading 0): a -Z-forward model
        // at heading 0 faces -Z, so "in front" is -Z of it.
        const front = selectAtlasCell(0, 0, -100, 0, layout);
        expect(front % layout.yawBins).toBe(0);
        // ...and directly behind it lands half a ring away.
        const back = selectAtlasCell(0, 0, 100, 0, layout);
        expect(back % layout.yawBins).toBe(layout.yawBins / 2);
    });

    it('selects the elevation row against the sheet\'s OWN arc', () => {
        // 15/45/80, not the vegetation bake's 18/42/68. A camera 30deg up is
        // nearer 15 than 45 on this arc; on 18/42/68 it would be nearer 42.
        const layout = layoutOf(toImpostorInfo(INFANTRY_V2_BLOCK));
        const upAt = (deg: number) => {
            const r = (deg * Math.PI) / 180;
            return Math.floor(
                selectAtlasCell(0, Math.sin(r) * 100, -Math.cos(r) * 100, 0, layout)
                / layout.yawBins);
        };
        expect(upAt(5)).toBe(0);
        expect(upAt(29)).toBe(0);    // 29 is 14 from 15, 16 from 45
        expect(upAt(50)).toBe(1);
        expect(upAt(85)).toBe(2);
    });

    it('tilts the card, because the sheet has real elevation rows', () => {
        expect(cardTiltsWithPitch(layoutOf(toImpostorInfo(INFANTRY_V2_BLOCK)))).toBe(true);
    });

    it('uses the declared ground anchor, not half the card height', () => {
        expect(cardLift(toImpostorInfo(INFANTRY_V2_BLOCK))).toBeCloseTo(3.8457, 6);
    });

    it('leaves a legacy single-view block rendering exactly as before', () => {
        // A def (or a whole non-metalstorm game) that declares no grid must
        // keep the whole-quad mapping, an upright card and a half-height lift.
        const info = toImpostorInfo({
            diffuse_uri: 'x.ktx2', walk_frames: 1, idle_frames: 1,
            width: 10, height: 10,
        })!;
        expect(info.layout).toEqual({
            yawBins: 1, pitchBins: 1, frames: 1, azimuthPhase: 0,
        });
        expect(info.centreY).toBeUndefined();
        expect(cardLift(info)).toBe(5);
        expect(cardTiltsWithPitch(layoutOf(info))).toBe(false);
        expect(selectAtlasCell(1, 2, 3, 0.7, layoutOf(info))).toBe(0);
    });

    it('drops an arc whose length disagrees with pitch_bins', () => {
        // Better to fall back than to index a 3-row sheet against 2 elevations.
        const info = toImpostorInfo({
            ...INFANTRY_V2_BLOCK, pitch_degrees: [15, 80],
        })!;
        expect(info.layout!.pitchDegrees).toBeUndefined();
        expect(info.layout!.pitchBins).toBe(3);
    });

    it('defaults the phase to 0 (column 0 = back) when unset', () => {
        const { azimuth_phase_degrees: _unused, ...noPhase } = INFANTRY_V2_BLOCK;
        expect(toImpostorInfo(noPhase)!.layout!.azimuthPhase).toBe(0);
    });

    it('returns undefined for a def with no impostor block', () => {
        expect(toImpostorInfo(undefined)).toBeUndefined();
        expect(toImpostorInfo(null)).toBeUndefined();
    });
});
