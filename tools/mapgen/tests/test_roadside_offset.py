#!/usr/bin/env python3
"""Roadside placements clear the deck of the road they flank (roads R4d).

    cd tools/mapgen
    .venv/bin/python -m unittest tests.test_roadside_offset

The `along_paths` sampler offsets from the CENTRELINE, and until R2 every road
on every map was one width (44 elmos, half-width 22), so the fence layer's
constant `path_offset = 30` sat 8 elmos past the deck edge. R2 made the deck
per class — a highway is `width_mult` 1.6, i.e. 70 wide, half-width 35.2 — and
the constant did not move, so a highway fence is planted 5 elmos INSIDE its own
carriageway. Measured on the shipped packages before this fix: 457 of 474
highway-side fences on `meridian_basin` and 160 of 176 on `skerry_reach` stand
on the deck, against 13/390 and 21/406 for the road tier (those are bend and
neighbouring-link geometry, not the offset, and this fix does not claim them).

The three arms below are the whole claim:
  * `HighwayFencesClearTheDeck` — with per-polyline half-widths, nothing lands
    on a highway deck, and the same run WITHOUT them (the shipped behaviour)
    puts the majority on it. The negative control is the point: an assertion
    that only passes is compatible with the sampler emitting nothing at all.
  * `EveryClassClearsWhatTheBakePAINTS` — the geometric half-width is not the
    edge a player sees: `bake.py` ragged-edges the deck by up to 2.6 elmos and
    fades it over 3 more, so a fence whose origin clears 35.2 by 2 still stands
    on tarmac (measured live: with a 2-elmo margin, 219 of 851 shipped fences
    were still on a road-type typemap cell). The margin is 10 and every class
    is checked against the PAINTED edge, not the mask edge. The track tier —
    half-width 13.2, so `path_offset` 30 already clears everything — is the
    untouched arm that keeps the fix from redressing what was already right.
  * `TheClearanceSurvivesJitter` — the raised offset is the deck edge plus the
    FULL jitter amplitude plus the margin, so the sampler's own ±jitter cannot
    put a placement back on the deck. Checked against the minimum emitted
    offset, not the mean.

R5 adds the case R4d found and did not fix (§2l FIND 2). The raise above is a
purely LOCAL computation — it clears the deck of the polyline the station
stepped off. Where a road doubles back on itself the normal points into the
carriageway of a different vertex range of the SAME polyline, or of a
neighbouring one, and the local raise cannot see it. `TheHairpinIsCleared` and
`ANeighbouringDeckIsADeckToo` run against a fabricated switchback and a pair of
parallel roads — fabricated deliberately, because a rule the producer already
satisfies is inert and a test against shipped geometry would prove nothing.
Both carry the pre-fix arm (`path_global_clearance=False`, which is the R4d
sampler verbatim) checked to REPRODUCE the defect.
"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from terragen import placement as pl  # noqa: E402
from terragen import roads as rd  # noqa: E402


CELL = 32.0
N = 129  # 4096-elmo synthetic map


def flat_ctx(halfwidths=None, polylines=None):
    """A flat, feature-friendly map with one or more straight roads on it."""
    h = np.full((N, N), 50.0, dtype=np.float32)
    slope = np.zeros((N, N), dtype=np.float32)
    biomes = np.zeros((N, N), dtype=np.int32)
    moist = np.full((N, N), 0.5, dtype=np.float32)
    excl = np.zeros((N, N), dtype=bool)
    if polylines is None:
        polylines = [straight_line(2048.0)]
    return pl.PlacementContext(h, slope, biomes, moist, CELL, seed=7,
                               exclusion=excl, paths=polylines,
                               path_halfwidths=halfwidths)


def straight_line(z, x0=200.0, x1=3900.0, step=50.0):
    n = int((x1 - x0) / step) + 1
    return np.stack([x0 + step * np.arange(n), np.full(n, z)], axis=1)


def fence_layer(**kw):
    """The shipped road_fences layer, verbatim (meridian2.py / archipelago.py)."""
    opts = dict(sampler="along_paths", path_spacing=22.0, path_offset=30.0,
                path_offset_jitter=4.0, max_slope_deg=18.0,
                respect_exclusion=False)
    opts.update(kw)
    return pl.Layer("road_fences", pl.FeatureEmit([("log_fence", 1.0)], (0.95, 1.1)),
                    suitability=lambda c: np.ones_like(c.height), **opts)


def offsets_from(features, z_centre):
    return np.abs(np.array([f[2] for f in features], dtype=np.float64) - z_centre)


def hairpin(z0=1800.0, gap=60.0, x0=600.0, x1=3400.0, step=50.0):
    """One polyline that runs out, turns 180 degrees, and runs back.

    `gap` is the distance between the two branches' centrelines. At 60 with a
    highway deck (half-width 35.2) the two carriageways OVERLAP, so there is no
    clear ground between them at all and every inner-side station has to move
    to the outside of its own branch or be given up."""
    n = int((x1 - x0) / step) + 1
    xs = x0 + step * np.arange(n)
    r = gap * 0.5
    th = np.linspace(-np.pi / 2, np.pi / 2, 13)
    return np.concatenate([
        np.stack([xs, np.full(n, z0)], axis=1),
        np.stack([x1 + r * np.cos(th), z0 + r + r * np.sin(th)], axis=1),
        np.stack([xs[::-1], np.full(n, z0 + gap)], axis=1),
    ], axis=0)


def dist_to_polyline(px, pz, poly):
    """Exact point-to-polyline distance, computed here rather than imported —
    the production index is what is under test."""
    p = np.asarray(poly, dtype=np.float64)
    a, b = p[:-1], p[1:]
    v = b - a
    w = np.stack([px - a[:, 0], pz - a[:, 1]], axis=1)
    vv = (v * v).sum(axis=1)
    t = np.clip((w * v).sum(axis=1) / np.maximum(vv, 1e-12), 0.0, 1.0)
    d = w - v * t[:, None]
    return float(np.hypot(d[:, 0], d[:, 1]).min())


def closest_to_any(features, polys):
    return [min(dist_to_polyline(f[1], f[2], q) for q in polys) for f in features]


class HighwayFencesClearTheDeck(unittest.TestCase):
    """A highway's fences stand off the carriageway — and did not before."""

    @classmethod
    def setUpClass(cls):
        rp = rd.RoadParams(road_width=44.0)
        cls.half = rd.class_width(rd.ROAD_HIGHWAY, rp) * 0.5
        cls.fixed = pl.run(flat_ctx(halfwidths=[cls.half]), [fence_layer()]).features
        cls.shipped = pl.run(flat_ctx(halfwidths=None), [fence_layer()]).features

    def test_the_highway_deck_is_35_elmos_wide(self):
        """The premise, from the road table rather than from this file.

        44 x the 1.6 highway multiplier is 70.4, so the deck half-width is
        35.2 — `roads.lua` publishes the rounded 70, and 30 is inside either
        reading."""
        self.assertAlmostEqual(self.half, 35.2, places=6)

    def test_nothing_lands_on_the_deck(self):
        self.assertTrue(self.fixed, "sampler emitted nothing — arm is vacuous")
        on_deck = (offsets_from(self.fixed, 2048.0) < self.half).sum()
        self.assertEqual(int(on_deck), 0,
                         f"{on_deck} of {len(self.fixed)} fences on the deck")

    def test_the_unfixed_sampler_puts_the_majority_on_the_deck(self):
        """The negative control: the defect reproduces without the half-widths."""
        self.assertEqual(len(self.shipped), len(self.fixed),
                         "the fix must move placements, not drop them")
        on_deck = int((offsets_from(self.shipped, 2048.0) < self.half).sum())
        self.assertGreater(on_deck, len(self.shipped) * 0.5,
                           "pre-fix arm should reproduce the shipped defect")


# What the albedo bake paints past the mask edge: `ragged` (<=2.6 elmos of
# thresholded noise on an unsealed edge) plus the 3-elmo /3.0 fade ramp.
PAINTED_OVERHANG = 5.6


class EveryClassClearsWhatTheBakePaints(unittest.TestCase):
    """The edge that matters is the painted one, and every class clears it."""

    def test_each_class_clears_its_painted_edge(self):
        rp = rd.RoadParams(road_width=44.0)
        for road_class in (rd.ROAD_HIGHWAY, rd.ROAD_ROAD, rd.ROAD_TRACK):
            half = rd.class_width(road_class, rp) * 0.5
            feats = pl.run(flat_ctx(halfwidths=[half]), [fence_layer()]).features
            closest = offsets_from(feats, 2048.0).min()
            self.assertGreater(closest, half + PAINTED_OVERHANG,
                               f"class {road_class}: closest {closest:.1f} vs "
                               f"painted edge {half + PAINTED_OVERHANG:.1f}")

    def test_the_road_tier_did_not_clear_it_under_the_first_margin(self):
        """The negative control for the margin itself, not for the wiring.

        The 2-elmo margin this file shipped first put the road tier's closest
        fence INSIDE the paint, which is why the ground-level screenshot still
        read as on-road after the deck measurement said it was fixed."""
        rp = rd.RoadParams(road_width=44.0)
        half = rd.class_width(rd.ROAD_ROAD, rp) * 0.5
        feats = pl.run(flat_ctx(halfwidths=[half]),
                       [fence_layer(path_min_clearance=2.0)]).features
        self.assertLess(offsets_from(feats, 2048.0).min(), half + PAINTED_OVERHANG)

    def test_a_track_is_untouched(self):
        """half 13.2 + 4 + 10 is still under 30, so the track tier does not move."""
        rp = rd.RoadParams(road_width=44.0)
        half = rd.class_width(rd.ROAD_TRACK, rp) * 0.5
        with_hw = pl.run(flat_ctx(halfwidths=[half]), [fence_layer()]).features
        without = pl.run(flat_ctx(halfwidths=None), [fence_layer()]).features
        self.assertTrue(with_hw)
        self.assertEqual(with_hw, without)


class TheClearanceSurvivesJitter(unittest.TestCase):
    """The raised offset absorbs the sampler's own ±jitter, not just the mean."""

    def test_the_closest_placement_clears_the_edge_by_the_margin(self):
        rp = rd.RoadParams(road_width=44.0)
        half = rd.class_width(rd.ROAD_HIGHWAY, rp) * 0.5
        layer = fence_layer()
        feats = pl.run(flat_ctx(halfwidths=[half]), [layer]).features
        offs = offsets_from(feats, 2048.0)
        self.assertGreaterEqual(offs.min(), half + layer.path_min_clearance - 1e-6)
        # and the jitter is genuinely exercised — otherwise the bound is
        # satisfied by a sampler that never jitters inward at all.
        self.assertGreater(offs.max() - offs.min(), layer.path_offset_jitter)

    def test_a_zero_margin_layer_only_just_clears(self):
        """The margin is the dial, and it is the thing keeping equality off."""
        rp = rd.RoadParams(road_width=44.0)
        half = rd.class_width(rd.ROAD_HIGHWAY, rp) * 0.5
        feats = pl.run(flat_ctx(halfwidths=[half]),
                       [fence_layer(path_min_clearance=0.0)]).features
        closest = offsets_from(feats, 2048.0).min()
        self.assertGreaterEqual(closest, half - 1e-6)
        self.assertLess(closest, half + 1.0)


class MixedNetworksAreResolvedPerPolyline(unittest.TestCase):
    """Two classes in one network get two different offsets, not one maximum."""

    def test_each_polyline_uses_its_own_deck(self):
        rp = rd.RoadParams(road_width=44.0)
        highway = rd.class_width(rd.ROAD_HIGHWAY, rp) * 0.5
        road = rd.class_width(rd.ROAD_ROAD, rp) * 0.5
        lines = [straight_line(1024.0), straight_line(3072.0)]
        ctx = flat_ctx(halfwidths=[highway, road], polylines=lines)
        feats = pl.run(ctx, [fence_layer()]).features
        near_hw = offsets_from([f for f in feats if f[2] < 2048.0], 1024.0)
        near_rd = offsets_from([f for f in feats if f[2] > 2048.0], 3072.0)
        self.assertTrue(len(near_hw) and len(near_rd))
        self.assertEqual(int((near_hw < highway).sum()), 0)
        # the road tier gets its OWN raise (22 + 4 + 10), not the highway's
        # 49.2, which is what a single network-wide maximum would do.
        self.assertLess(near_rd.max(), 45.0)


HIGHWAY_HALF = rd.class_width(rd.ROAD_HIGHWAY, rd.RoadParams(road_width=44.0)) * 0.5


class TheHairpinIsCleared(unittest.TestCase):
    """A road that comes back on itself, which no per-polyline offset can see.

    The switchback is fabricated on purpose. R4d measured a real one on
    `meridian_basin` at (10 422, 3 212) and could not turn it into an assertion,
    because a shipped map is a sample of one and a rule the producer already
    satisfies is inert — it would pass whether or not the code under it worked.
    A 60-elmo gap between the branches of a highway (deck half-width 35.2) is
    tighter than anything the planner has produced, and that is the point."""

    GAP = 60.0

    @classmethod
    def setUpClass(cls):
        cls.line = hairpin(gap=cls.GAP)
        ctx = lambda: flat_ctx(halfwidths=[HIGHWAY_HALF], polylines=[cls.line])
        cls.before = pl.run(ctx(), [fence_layer(path_global_clearance=False)]).features
        cls.after = pl.run(ctx(), [fence_layer()]).features
        cls.stats = dict(pl._LAST_PATH_STATS.get("road_fences", {}))

    def test_the_branches_are_closer_than_two_decks(self):
        """The premise: at this gap the two carriageways overlap outright."""
        self.assertLess(self.GAP, 2.0 * HIGHWAY_HALF)

    def test_the_r4d_sampler_reproduces_the_defect(self):
        """Every one of these is correctly offset from its OWN segment."""
        self.assertTrue(self.before, "pre-fix arm emitted nothing — vacuous")
        bad = sum(1 for d in closest_to_any(self.before, [self.line])
                  if d < HIGHWAY_HALF)
        self.assertGreater(bad, 0,
                           "the fabricated hairpin does not reproduce the "
                           "defect, so the arm below proves nothing")
        # and it is not a stray one or two: the whole inner side is on tarmac
        self.assertGreater(bad, len(self.before) * 0.25)

    def test_nothing_survives_on_a_deck(self):
        self.assertTrue(self.after, "the fix emptied the layer")
        worst = min(closest_to_any(self.after, [self.line]))
        self.assertGreaterEqual(
            worst, HIGHWAY_HALF + fence_layer().path_min_clearance - 1e-6,
            f"closest surviving fence is {worst:.1f} from a centreline")

    def test_it_clears_the_edge_the_bake_PAINTS(self):
        """The R4d lesson, applied to the global test: the geometric edge is
        not the edge a player sees."""
        worst = min(closest_to_any(self.after, [self.line]))
        self.assertGreater(worst, HIGHWAY_HALF + PAINTED_OVERHANG)

    def test_the_fix_moves_stations_rather_than_deleting_them(self):
        """A hairpin has two good verges — the outsides. Most inner-side
        stations mirror onto them; a fence run that merely got shorter would
        be a worse map, not a fixed one."""
        self.assertGreater(len(self.after), len(self.before) * 0.6)
        self.assertGreater(self.stats["flipped"], self.stats["dropped"])

    def test_the_rule_reports_that_it_fired(self):
        self.assertGreater(self.stats["flipped"], 0)


class ANeighbouringDeckIsADeckToo(unittest.TestCase):
    """The offending deck can belong to a different polyline entirely."""

    @classmethod
    def setUpClass(cls):
        # three parallel highways 60 apart: the middle one has a deck within
        # reach on BOTH sides, so its stations cannot be mirrored anywhere
        cls.lines = [straight_line(z) for z in (1800.0, 1860.0, 1920.0)]
        hw = [HIGHWAY_HALF] * 3
        cls.before = pl.run(flat_ctx(halfwidths=hw, polylines=cls.lines),
                            [fence_layer(path_global_clearance=False)]).features
        cls.after = pl.run(flat_ctx(halfwidths=hw, polylines=cls.lines),
                           [fence_layer()]).features

    def test_the_r4d_sampler_puts_fences_on_the_neighbour(self):
        on_deck = sum(1 for d in closest_to_any(self.before, self.lines)
                      if d < HIGHWAY_HALF)
        self.assertGreater(on_deck, len(self.before) * 0.5)

    def test_after_the_fix_no_fence_is_on_any_of_the_three(self):
        self.assertTrue(self.after)
        self.assertEqual(
            0, sum(1 for d in closest_to_any(self.after, self.lines)
                   if d < HIGHWAY_HALF + fence_layer().path_min_clearance - 1e-6))

    def test_the_middle_road_is_given_up_on_and_the_outer_two_are_not(self):
        """Both sides blocked is a DROP, not a nudge — R4c's rule for a
        blocked prop, applied here."""
        z = np.array([f[2] for f in self.after])
        self.assertEqual(int(((z > 1830.0) & (z < 1890.0)).sum()), 0)
        self.assertGreater(int((z < 1800.0 - HIGHWAY_HALF).sum()), 0)
        self.assertGreater(int((z > 1920.0 + HIGHWAY_HALF).sum()), 0)


class TheGlobalTestIsInertOnGeometryThatDoesNotNeedIt(unittest.TestCase):
    """It must not redress a road that was already right — including the
    shipped straight-and-gentle case, which is nearly all road on both maps."""

    def test_a_lone_straight_road_is_bit_for_bit_unchanged(self):
        a = pl.run(flat_ctx(halfwidths=[HIGHWAY_HALF]), [fence_layer()]).features
        b = pl.run(flat_ctx(halfwidths=[HIGHWAY_HALF]),
                   [fence_layer(path_global_clearance=False)]).features
        self.assertTrue(a)
        self.assertEqual(a, b)
        self.assertEqual(pl._LAST_PATH_STATS["road_fences"]["dropped"], 0)

    def test_two_roads_far_enough_apart_are_unchanged(self):
        lines = [straight_line(1024.0), straight_line(3072.0)]
        hw = [HIGHWAY_HALF, HIGHWAY_HALF]
        a = pl.run(flat_ctx(halfwidths=hw, polylines=lines), [fence_layer()]).features
        b = pl.run(flat_ctx(halfwidths=hw, polylines=lines),
                   [fence_layer(path_global_clearance=False)]).features
        self.assertEqual(a, b)


class TheIndexCostsWhatItClaims(unittest.TestCase):
    """All-pairs on a full-res network is ~1e4 stations x ~2e4 segments. The
    grid index has to make that a bucket read, and the cheapest way to say so
    in a test is to check that a query touches a bounded number of segments."""

    def test_a_query_reads_a_bucket_not_the_network(self):
        lines = [straight_line(400.0 + 200.0 * i, step=10.0) for i in range(12)]
        radii = [HIGHWAY_HALF + 10.0] * len(lines)
        idx = pl._DeckIndex(lines, radii)
        total_segments = sum(len(np.asarray(q)) - 1 for q in lines)
        keys, counts = np.unique(idx.keys, return_counts=True)
        self.assertGreater(total_segments, 4000)
        # every bucket holds the segments of at most a few roads' worth of
        # neighbourhood, never the whole network
        self.assertLess(int(counts.max()), total_segments // 10)

    def test_it_answers_the_same_as_brute_force(self):
        """The index is an optimisation, so it is checked against the
        definition it optimises."""
        line = hairpin(gap=70.0)
        idx = pl._DeckIndex([line], [HIGHWAY_HALF + 10.0])
        rng = np.random.default_rng(11)
        px = rng.uniform(400.0, 3700.0, 400)
        pz = rng.uniform(1600.0, 2100.0, 400)
        got = idx.clear(px, pz)
        want = np.array([dist_to_polyline(a, b, line) >= HIGHWAY_HALF + 10.0 - 1e-6
                         for a, b in zip(px, pz)])
        self.assertTrue(bool(want.any()) and bool((~want).any()))
        np.testing.assert_array_equal(got, want)


if __name__ == "__main__":
    unittest.main()
