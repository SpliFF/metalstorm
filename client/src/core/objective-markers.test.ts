/**
 * objective-markers.test.ts — what gets a mark on the ground, and where.
 *
 * The rendering half is a screenshot's job. This is the half a screenshot
 * cannot check: which objectives are eligible for a marker, which are
 * deliberately excluded, and what happens to the ones the wire places only
 * partially. Every exclusion below is one a player would agree with, so each
 * case says whose complaint it answers.
 *
 * The fixtures are the shapes `game_objectives.lua`'s `publish()` actually
 * writes for `crossing_standoff` — including the U2 change that made `region`
 * and `x`/`z`/`r` non-exclusive.
 */

import { describe, it, expect } from 'vitest';
import { deriveObjectiveMarkers, markersFingerprint } from './objective-markers.js';

function params(entries: Record<string, number | string>): Map<string, number | string> {
    return new Map(Object.entries(entries));
}

/** crossing_standoff's board, as the wire carries it post-U2. */
const BOARD = {
    objective_count: 4,

    // The scripted victory objective: a region key AND the region's circle.
    objective_1_type: 'control',
    objective_1_state: 'active',
    objective_1_team: -1,
    objective_1_victory: 1,
    objective_1_progress: 0.42,
    objective_1_region: 'raven_basin',
    objective_1_x: 4480,
    objective_1_z: 4480,
    objective_1_r: 900,

    // A protect objective on our own team: a covering circle over its targets.
    objective_2_type: 'protect',
    objective_2_state: 'active',
    objective_2_team: 0,
    objective_2_expire: 3000,
    objective_2_x: 993,
    objective_2_z: 4694,
    objective_2_r: 420,

    // An escort with its authored extract area.
    objective_3_type: 'escort',
    objective_3_state: 'active',
    objective_3_team: 0,
    objective_3_x: 7100,
    objective_3_z: 2200,
    objective_3_r: 400,

    // A kill: a moving unit, so a position and NO radius.
    objective_4_type: 'kill',
    objective_4_state: 'active',
    objective_4_team: 0,
    objective_4_x: 6000,
    objective_4_z: 6000,

    region_raven_basin_name: 'Raven Basin',
    region_raven_basin_x: 4470,
    region_raven_basin_z: 4490,
};

describe('deriveObjectiveMarkers', () => {
    it('places every active objective the viewer is eligible for', () => {
        const markers = deriveObjectiveMarkers(params(BOARD), { teamId: 0, frame: 100 });
        expect(markers.map((m) => m.id)).toEqual([1, 2, 3, 4]);
    });

    it('draws the objective\'s OWN circle, not the region centroid', () => {
        // The two disagree on purpose in the fixture: `publish()` writes the
        // area from GG.Regions.Area, and `region_*_x/_z` is the statics feed.
        // Taking the region centroid here would put the ring beside the ring
        // the "Go there" button travels to.
        const [raven] = deriveObjectiveMarkers(params(BOARD), { teamId: 0 });
        expect(raven).toMatchObject({ x: 4480, z: 4480, r: 900 });
    });

    it('names the marker with the same title the chip shows', () => {
        const [raven] = deriveObjectiveMarkers(params(BOARD), { teamId: 0 });
        expect(raven.label).toBe('Hold Raven Basin');
    });

    it('hedges a coordinate-placed objective with "near", exactly as the chip does', () => {
        // Measured on screen before this was fixed: the chip read "Protect near
        // Storm Sound" and the ring under it read "Protect your people". Two
        // names for one objective is a worse failure than a hedge, and the
        // marker was the one that was wrong — it handed the shared phrasing
        // module a nameless place.
        const protect = deriveObjectiveMarkers(params(BOARD), { teamId: 0 })
            .find((m) => m.id === 2)!;
        expect(protect.label).toBe('Protect near Raven Basin');
    });

    it('finds the NEAREST named place, not merely the first', () => {
        const twoPlaces = {
            ...BOARD,
            region_storm_sound_name: 'Storm Sound',
            region_storm_sound_x: 900,
            region_storm_sound_z: 4700,
        };
        const protect = deriveObjectiveMarkers(params(twoPlaces), { teamId: 0 })
            .find((m) => m.id === 2)!;   // at (993, 4694)
        expect(protect.label).toBe('Protect near Storm Sound');
    });

    it('reads landmarks as named places too', () => {
        const withLandmark = {
            ...BOARD,
            landmark_iron_bend_name: 'Iron Bend',
            landmark_iron_bend_x: 1000,
            landmark_iron_bend_z: 4700,
        };
        const protect = deriveObjectiveMarkers(params(withLandmark), { teamId: 0 })
            .find((m) => m.id === 2)!;
        expect(protect.label).toBe('Protect near Iron Bend');
    });

    it('gives an objective with no radius r=0 — a beacon, not an invented area', () => {
        const kill = deriveObjectiveMarkers(params(BOARD), { teamId: 0 })
            .find((m) => m.id === 4)!;
        expect(kill.r).toBe(0);
        expect(kill).toMatchObject({ x: 6000, z: 6000 });
    });

    it('falls back to the region centroid when no circle was published', () => {
        // An older gadget: region key, no x/z/r. The centre is real, the radius
        // is not guessed.
        const older = { ...BOARD } as Record<string, number | string>;
        delete older.objective_1_x;
        delete older.objective_1_z;
        delete older.objective_1_r;
        const raven = deriveObjectiveMarkers(params(older), { teamId: 0 })
            .find((m) => m.id === 1)!;
        expect(raven).toMatchObject({ x: 4470, z: 4490, r: 0 });
    });

    it('drops an objective the wire cannot place at all', () => {
        // A kill on a unit nobody has seen: no coordinate ships. There is
        // nothing to draw and nothing to invent.
        const blind = { ...BOARD } as Record<string, number | string>;
        delete blind.objective_4_x;
        delete blind.objective_4_z;
        expect(deriveObjectiveMarkers(params(blind), { teamId: 0 }).map((m) => m.id))
            .toEqual([1, 2, 3]);
    });

    it('drops a resolved objective — the chip still says it, the world stops', () => {
        // The sim retains a resolved objective's params for 30 s so the HUD can
        // report the outcome. A ring is a place to GO, and there is no longer
        // anywhere to go.
        const done = { ...BOARD, objective_3_state: 'complete', objective_3_completed_by: 1 };
        expect(deriveObjectiveMarkers(params(done), { teamId: 0 }).map((m) => m.id))
            .toEqual([1, 2, 4]);
    });

    it('drops an objective the viewer is not eligible for', () => {
        const theirs = { ...BOARD, objective_2_team: 1 };
        expect(deriveObjectiveMarkers(params(theirs), { teamId: 0 }).map((m) => m.id))
            .toEqual([1, 3, 4]);
        // ...and shows it to the team it belongs to.
        expect(deriveObjectiveMarkers(params(theirs), { teamId: 1 }).map((m) => m.id))
            .toEqual([1, 2]);
    });

    it('keeps an open race for both sides', () => {
        for (const teamId of [0, 1]) {
            const ids = deriveObjectiveMarkers(params(BOARD), { teamId }).map((m) => m.id);
            expect(ids).toContain(1);
        }
    });

    it('reports ownership and stakes for the tint', () => {
        const markers = deriveObjectiveMarkers(params(BOARD), { teamId: 0 });
        expect(markers.find((m) => m.id === 1)).toMatchObject({
            team: -1, mine: false, victory: true,
        });
        expect(markers.find((m) => m.id === 2)).toMatchObject({
            team: 0, mine: true, victory: false,
        });
    });

    it('flags urgency from the published expiry and the live frame', () => {
        // objective 2 expires at frame 3000; URGENT_FRAMES is 3600.
        const early = deriveObjectiveMarkers(params(BOARD), { teamId: 0, frame: 1 })
            .find((m) => m.id === 2)!;
        expect(early.urgent).toBe(true);
        const noClock = deriveObjectiveMarkers(params(BOARD), { teamId: 0, frame: 0 })
            .find((m) => m.id === 2)!;
        // Frame 0 is "the scene feed has not answered yet", not "the match just
        // started" — an invented countdown is worse than none.
        expect(noClock.urgent).toBe(false);
    });

    it('returns a stable order so the renderers can diff', () => {
        const shuffled = new Map([...params(BOARD)].reverse());
        expect(deriveObjectiveMarkers(shuffled, { teamId: 0 }).map((m) => m.id))
            .toEqual([1, 2, 3, 4]);
    });

    // ── Coincident objectives: seen on screen, then pinned ──
    //
    // crossing_standoff really does carry three objectives on Raven Basin at
    // once. The live run drew three identical rings and three identical labels
    // in the same spot: z-fighting outlines with the text painted over itself.

    it('collapses objectives sharing one circle to a single marker', () => {
        // The scripted victory objective plus a systemic control objective the
        // generator raised on the same contested region.
        const stacked = {
            ...BOARD,
            objective_count: 5,
            objective_5_type: 'control',
            objective_5_state: 'active',
            objective_5_team: -1,
            objective_5_region: 'raven_basin',
            objective_5_x: 4481,
            objective_5_z: 4479,
            objective_5_r: 900,
        };
        const markers = deriveObjectiveMarkers(params(stacked), { teamId: 0 });
        expect(markers.filter((m) => Math.round(m.x) === 4480 || Math.round(m.x) === 4481))
            .toHaveLength(1);
        // ...and the one kept is the one that ends the war.
        expect(markers.find((m) => m.id === 1)?.victory).toBe(true);
        expect(markers.find((m) => m.id === 5)).toBeUndefined();
    });

    it('keeps the more important of two coincident objectives, not the lower id', () => {
        const stacked = {
            ...BOARD,
            objective_count: 5,
            // A plain control objective on Raven Basin, id 5...
            objective_5_type: 'control', objective_5_state: 'active',
            objective_5_team: -1, objective_5_region: 'raven_basin',
            objective_5_x: 4480, objective_5_z: 4480, objective_5_r: 900,
        };
        // ...and objective 1 stripped of its victory flag but given progress.
        const noVictory = { ...stacked };
        delete (noVictory as Record<string, unknown>).objective_1_victory;
        (noVictory as Record<string, unknown>).objective_1_progress = 0;
        (noVictory as Record<string, unknown>).objective_5_progress = 0.4;
        const markers = deriveObjectiveMarkers(params(noVictory), { teamId: 0 });
        expect(markers.map((m) => m.id)).toContain(5);
        expect(markers.map((m) => m.id)).not.toContain(1);
    });

    it('does NOT collapse objectives that merely share a centre', () => {
        // Same place, different extents is two real answers to "where" — a
        // pickup zone inside a hold circle is not the hold circle.
        const nested = {
            ...BOARD,
            objective_count: 5,
            objective_5_type: 'escort', objective_5_state: 'active',
            objective_5_team: 0,
            objective_5_x: 4480, objective_5_z: 4480, objective_5_r: 300,
        };
        const markers = deriveObjectiveMarkers(params(nested), { teamId: 0 });
        expect(markers.map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);
    });

    it('survives an empty board', () => {
        expect(deriveObjectiveMarkers(params({}), { teamId: 0 })).toEqual([]);
        expect(deriveObjectiveMarkers(params({ objective_count: 0 }), {})).toEqual([]);
    });
});

describe('markersFingerprint', () => {
    it('quantises position so a protect objective does not rebuild on jitter', () => {
        // `publish()` re-derives a protect objective's covering circle from its
        // targets' live positions on every evaluation tick. A garrison shifting
        // a metre must not re-rasterise a label and rebuild a torus.
        //
        // The quantiser is a plain 8-elmo round, so a jitter that happens to
        // straddle a bucket edge DOES rebuild — that is the honest cost of not
        // carrying hysteresis state, and it is bounded by the 400 ms recompute
        // throttle in `gpRefreshObjectiveMarkers` plus the material cache that
        // makes a rebuild geometry-only.
        const a = deriveObjectiveMarkers(params(BOARD), { teamId: 0, frame: 100 });
        const jittered = deriveObjectiveMarkers(
            params({ ...BOARD, objective_2_x: 995, objective_2_z: 4697 }),
            { teamId: 0, frame: 100 });
        expect(markersFingerprint(jittered)).toBe(markersFingerprint(a));
    });

    it('changes when an objective actually moves, resolves or changes hands', () => {
        const base = markersFingerprint(
            deriveObjectiveMarkers(params(BOARD), { teamId: 0, frame: 100 }));
        const moved = markersFingerprint(deriveObjectiveMarkers(
            params({ ...BOARD, objective_2_x: 1500 }), { teamId: 0, frame: 100 }));
        const gone = markersFingerprint(deriveObjectiveMarkers(
            params({ ...BOARD, objective_2_state: 'failed' }), { teamId: 0, frame: 100 }));
        const widened = markersFingerprint(deriveObjectiveMarkers(
            params({ ...BOARD, objective_2_r: 1200 }), { teamId: 0, frame: 100 }));
        expect(new Set([base, moved, gone, widened]).size).toBe(4);
    });
});
