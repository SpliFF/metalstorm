#!/usr/bin/env python3
"""Tests for MoveDef passability grading and sill carving (PLAN-maps M8x).

    .venv/bin/python -m unittest tests.test_passability

The defect this module exists to remove is a map whose start positions sit in
different connected components for a movement class — `sundered_arc` shipped
with INFANTRY passing and VEH/HEAVY split 3/5 (M8w FIND 3). Two things are
load-bearing and pinned here:

1. The generator's grading table and `regions_from_map.py`'s must agree. If
   they drift, the generator certifies a map the verifier then rejects, which
   is worse than not checking at all.
2. The carve is strictly submarine and only ever raises. Everything this lane
   ranks arms by — land fraction, island inventory, the relief aim, the
   anisotropy survey — is measured on land, and this is what makes the sill
   free of all of them.
"""
from __future__ import annotations

import math
import re
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import regions_from_map as rfm                          # noqa: E402
from terragen import passability as pa                  # noqa: E402


CELL = 8.0
N = 260
CENTRE = 130.0
HALF = 60.0
PLATEAU = 60.0


def _channel(depth_by_row):
    """Two plateaus split by a smooth E-W channel, per-row depth.

    A cosine profile, not a box: a vertical trench wall is impassable for
    every class *and* stays impassable after a sill is raised against it, so a
    box-channel fixture would test the carve against terrain no erosion
    produces. This profile's steepest cell is about 18 degrees, inside HEAVY's
    24, so the only thing standing between the two plateaus is water depth.
    """
    x = np.arange(N, dtype=np.float64)
    bump = np.where(np.abs(x - CENTRE) <= HALF,
                    0.5 * (1.0 + np.cos(np.pi * (x - CENTRE) / HALF)), 0.0)
    d = np.asarray(depth_by_row, np.float64).reshape(-1, 1)
    return PLATEAU - (PLATEAU + d) * bump[None, :]


def two_islands(depth=40.0):
    h = _channel(np.full(N, float(depth)))
    starts = [(30 * CELL, 130 * CELL), (230 * CELL, 130 * CELL)]
    return h, starts, CELL


def _smoothstep(t):
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def three_plateaus(channels, n=800):
    """A row of plateaus split by `channels` — (centre, half_width, depth)."""
    x = np.arange(n, dtype=np.float64)
    h = np.full(n, PLATEAU)
    for centre, half, depth in channels:
        bump = np.where(np.abs(x - centre) <= half,
                        0.5 * (1.0 + np.cos(np.pi * (x - centre) / half)), 0.0)
        h = np.minimum(h, PLATEAU - (PLATEAU + depth) * bump)
    return np.repeat(h[None, :], n, axis=0)


def trench_with_a_neck(deep=120.0, neck=26.0, z0=90, z1=130, blend=30):
    """One deep trench, with a shallow neck across it — two ways over."""
    z = np.arange(N, dtype=np.float64)
    t = np.minimum(_smoothstep((z - (z0 - blend)) / blend),
                   _smoothstep(((z1 + blend) - z) / blend))
    depth = deep + (neck - deep) * t
    h = _channel(depth)
    starts = [(30 * CELL, 110 * CELL), (230 * CELL, 110 * CELL)]
    return h, starts, CELL


class TestGradingAgreesWithTheVerifier(unittest.TestCase):
    def test_the_move_class_tables_are_the_same(self):
        self.assertEqual(set(pa.MOVE_CLASSES), set(rfm.MOVE_CLASSES))
        for name, mc in pa.MOVE_CLASSES.items():
            slope, depth = rfm.MOVE_CLASSES[name]
            self.assertEqual((mc.max_slope_deg, mc.max_water_depth),
                             (float(slope), float(depth)), name)

    def test_the_masks_are_the_same(self):
        """Same surface, same class -> same per-sample verdict."""
        rng = np.random.default_rng(11)
        h = np.cumsum(rng.normal(0, 3.0, (40, 40)), axis=0) - 20.0
        flat = [float(v) for v in h.ravel()]
        for name, mc in pa.MOVE_CLASSES.items():
            mine = pa.passable(h, pa.ELMOS_PER_SQUARE, mc)
            theirs = np.frombuffer(bytes(rfm.passable_mask(
                flat, 40, 40, mc.max_slope_deg, mc.max_water_depth)),
                dtype=np.uint8).reshape(40, 40).astype(bool)
            self.assertTrue((mine == theirs).all(), name)

    def test_strictest_is_a_subset_of_every_class_it_covers(self):
        """The property that lets one carve answer every class."""
        rng = np.random.default_rng(3)
        h = np.cumsum(rng.normal(0, 2.5, (60, 60)), axis=1) - 15.0
        ref = pa.strictest(pa.DEFAULT_CLASSES)
        sub = pa.passable(h, pa.ELMOS_PER_SQUARE, ref)
        for name in pa.DEFAULT_CLASSES:
            sup = pa.passable(h, pa.ELMOS_PER_SQUARE, pa.MOVE_CLASSES[name])
            self.assertTrue((sub & ~sup).sum() == 0, name)


class TestTheSillLeavesTheStraitNavigable(unittest.TestCase):
    """A sill is bounded on both sides — see `sill_depth_for`."""

    def test_the_default_clears_a_ships_draft_and_a_tanks_wade(self):
        d = pa.sill_depth_for(pa.ARMOUR_CLASSES)
        self.assertEqual(d, 16.0)
        self.assertGreater(d, pa.SHALLOWEST_DRAFT)          # ships still float
        self.assertLess(d, min(pa.MOVE_CLASSES[c].max_water_depth
                               for c in pa.ARMOUR_CLASSES))  # armour still fords

    def test_the_shipped_draft_matches_moveinfo(self):
        """SHIP minwaterdepth, read off the game data rather than assumed."""
        path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(
                os.path.dirname(os.path.abspath(__file__))))),
            "data", "games", "metalstorm", "gamedata", "moveinfo.tdf")
        if not os.path.exists(path):
            self.skipTest("data/games/metalstorm is gitignored runtime content")
        with open(path, encoding="utf-8") as f:
            text = f.read()
        block = text.split("name=SHIP;", 1)[1].split("}", 1)[0]
        got = float(re.search(r"minwaterdepth\s*=\s*([0-9.]+)", block).group(1))
        self.assertEqual(got, pa.SHALLOWEST_DRAFT)

    def test_a_carved_sill_stays_deep_enough_to_sail(self):
        h, starts, cell = two_islands()
        out, _, _ = pa.connect_starts(h, cell, starts)
        moved = out > h + 1e-6
        self.assertLess(float(out[moved].max()), -pa.SHALLOWEST_DRAFT)


class TestConnectivityReading(unittest.TestCase):
    def test_a_deep_channel_splits_the_starts(self):
        h, starts, cell = two_islands()
        for name in pa.DEFAULT_CLASSES:
            r = pa.read_connectivity(h, cell, starts, name)
            self.assertFalse(r.ok, name)
            self.assertEqual(len(r.groups), 2, name)

    def test_a_wadeable_channel_does_not(self):
        h, starts, cell = two_islands(depth=8.0)
        for name in pa.DEFAULT_CLASSES:
            self.assertTrue(pa.read_connectivity(h, cell, starts, name).ok,
                            name)


class TestSillCarving(unittest.TestCase):
    def setUp(self):
        self.h, self.starts, self.cell = two_islands()

    def test_it_joins_the_starts_for_armour(self):
        out, crossings, after = pa.connect_starts(
            self.h, self.cell, self.starts)
        self.assertEqual(len(crossings), 1)
        for r in after:
            if r.cls in pa.ARMOUR_CLASSES:
                self.assertTrue(r.ok, r.describe())

    def test_the_ford_is_too_deep_to_wade_and_that_is_the_trade(self):
        """A 16-elmo sill is 4 elmos past INFANTRY's wade depth, by design.

        Infantry (12) and ships (12 minimum) cannot both use one crossing, so
        the sill serves armour and shipping. On real terrain infantry is the
        loosest class on slope and passes on a route of its own — it does on
        `sundered_arc` — but this fixture has no second route, so here the
        trade is visible.
        """
        out, _, after = pa.connect_starts(self.h, self.cell, self.starts)
        inf = [r for r in after if r.cls == "INFANTRY"][0]
        self.assertFalse(inf.ok, inf.describe())

    def test_it_only_ever_raises_and_never_reaches_the_surface(self):
        out, _, _ = pa.connect_starts(self.h, self.cell, self.starts)
        self.assertTrue((out >= self.h - 1e-9).all())
        moved = out > self.h + 1e-6
        self.assertTrue(moved.any())
        # every cell it touched was under water and stayed under water
        self.assertTrue((self.h[moved] < 0.0).all())
        self.assertTrue((out[moved] < 0.0).all())

    def test_the_statistics_the_lane_ranks_arms_by_do_not_move(self):
        out, _, _ = pa.connect_starts(self.h, self.cell, self.starts)
        self.assertEqual(float((out > 0).mean()), float((self.h > 0).mean()))
        self.assertEqual(out.max(), self.h.max())

    def test_the_sill_floor_is_the_requested_depth(self):
        out, _, _ = pa.connect_starts(self.h, self.cell, self.starts,
                                      sill_depth=10.0)
        moved = out > self.h + 1e-6
        self.assertAlmostEqual(float(out[moved].max()), -10.0, places=6)

    def test_it_is_a_no_op_when_the_map_already_passes(self):
        h, starts, cell = two_islands(depth=8.0)
        out, crossings, after = pa.connect_starts(h, cell, starts)
        self.assertEqual(crossings, [])
        self.assertTrue((out == h).all())
        self.assertTrue(all(r.ok for r in after))

    def test_an_unreachable_split_is_reported_not_crashed(self):
        """A channel deeper than `max_lift` leaves the map as it found it."""
        h, starts, cell = two_islands(depth=400.0)
        said = []
        out, crossings, after = pa.connect_starts(
            h, cell, starts, max_lift=40.0, log=said.append)
        self.assertEqual(crossings, [])
        self.assertTrue((out == h).all())
        self.assertFalse(all(r.ok for r in after))
        self.assertTrue(any("no route" in m for m in said), said)


class TestMoreThanTwoGroups(unittest.TestCase):
    """Three plateaus in a row, one channel per gap."""

    STARTS = [(30 * CELL, 400 * CELL), (495 * CELL, 400 * CELL),
              (740 * CELL, 400 * CELL)]

    def test_it_carves_one_sill_per_gap(self):
        h = three_plateaus([(250, 180, 40.0), (620, 60, 40.0)])
        out, crossings, after = pa.connect_starts(h, CELL, self.STARTS)
        self.assertEqual(len(crossings), 2)
        for r in after:
            if r.cls in pa.ARMOUR_CLASSES:
                self.assertTrue(r.ok, r.describe())

    def test_an_unreachable_pair_does_not_end_the_loop(self):
        """The regression: one hopeless pair used to abandon the whole map."""
        h = three_plateaus([(250, 180, 300.0), (620, 60, 40.0)])
        said = []
        out, crossings, after = pa.connect_starts(
            h, CELL, self.STARTS, max_lift=60.0, log=said.append)
        self.assertEqual(len(crossings), 1)
        self.assertTrue(any("no route" in m for m in said), said)
        veh = [r for r in after if r.cls == "VEH"][0]
        # starts 1 and 2 joined; start 0 is still behind the 300-elmo trench
        self.assertEqual(sorted(len(v) for v in veh.groups.values()), [1, 2])


class TestAHopelessPairSaysWhichHalfOfTheMaskStoppedIt(unittest.TestCase):
    """Depth and slope have opposite fixes, so the log must not conflate them.

    On `skerry_reach` four starts read "no route under a 250-elmo sill" while
    the deepest cell on the map is 89.7 elmos — the lift was never the
    binding constraint, the seabed slope was (PLAN-maps M8y).
    """

    def test_a_trench_deeper_than_the_lift_is_reported_as_depth(self):
        h, starts, cell = two_islands(depth=400.0)
        said = []
        pa.connect_starts(h, cell, starts, max_lift=40.0, log=said.append)
        msg = [m for m in said if "no route" in m]
        self.assertTrue(msg, said)
        self.assertIn("water deeper than the lift", msg[0])

    def test_a_shallow_but_steep_wall_is_reported_as_slope(self):
        """26 elmos of water — well inside any lift — behind 65-degree walls."""
        h = three_plateaus([(400.0, 8.0, 26.0)], n=800)
        starts = [(100 * CELL, 400 * CELL), (700 * CELL, 400 * CELL)]
        said = []
        _, crossings, _ = pa.connect_starts(h, CELL, starts, log=said.append)
        self.assertEqual(crossings, [])
        msg = [m for m in said if "no route" in m]
        self.assertTrue(msg, said)
        self.assertIn("seabed SLOPE", msg[0])


class TestTheCrossingBudgetComesFromTheMap(unittest.TestCase):
    """Eight plateaus, seven channels — one more than the old constant 6.

    `skerry_reach` is exactly this shape: 8 starts in 8 armour components, so
    a fixed budget of 6 leaves it split and says nothing about it (PLAN-maps
    M8y). The budget is now `components - 1`, because each carve joins two.
    """

    # 110-cell plateaus; the channel walls are ~19 degrees, inside HEAVY's 24,
    # so again the only thing splitting them is 26 elmos of water against a
    # 20-elmo wade depth
    N8 = 900
    CHANNELS = [(110.0 * i, 48.0, 26.0) for i in range(1, 8)]
    STARTS = [((110 * i + 55) * CELL, 450 * CELL) for i in range(8)]

    def test_seven_gaps_get_seven_sills(self):
        h = three_plateaus(self.CHANNELS, n=self.N8)
        self.assertEqual(
            len(pa.read_connectivity(h, CELL, self.STARTS, "VEH").groups), 8)
        out, crossings, after = pa.connect_starts(h, CELL, self.STARTS)
        self.assertEqual(len(crossings), 7)
        for r in after:
            if r.cls in pa.ARMOUR_CLASSES:
                self.assertTrue(r.ok, r.describe())

    def test_an_explicit_cap_is_still_honoured_and_says_so(self):
        h = three_plateaus(self.CHANNELS, n=self.N8)
        said = []
        out, crossings, after = pa.connect_starts(
            h, CELL, self.STARTS, max_crossings=2, log=said.append)
        self.assertEqual(len(crossings), 2)
        self.assertTrue(any("budget spent" in m for m in said), said)
        veh = [r for r in after if r.cls == "VEH"][0]
        self.assertFalse(veh.ok, veh.describe())


class TestTheShallowestCrossingIsTheOneChosen(unittest.TestCase):
    def test_the_search_prefers_the_shallow_strait(self):
        """Two ways across: a shallow neck and a deep trench. Take the neck."""
        h, starts, cell = trench_with_a_neck()
        out, crossings, after = pa.connect_starts(h, cell, starts)
        self.assertEqual(len(crossings), 1)
        c = crossings[0]
        # the neck is 26 elmos deep and the trench 120 — a minimax search
        # takes the neck, and a plain shortest path would not
        self.assertLess(c.deepest_before, 30.0)
        self.assertLess(c.sill_lift, 10.0)
        self.assertTrue(90 * cell - 240 <= c.centre[1] <= 130 * cell + 240,
                        c.centre)
        for r in after:
            if r.cls in pa.ARMOUR_CLASSES:
                self.assertTrue(r.ok, r.describe())


if __name__ == "__main__":
    unittest.main()
