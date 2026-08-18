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


if __name__ == "__main__":
    unittest.main()
