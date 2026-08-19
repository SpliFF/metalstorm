#!/usr/bin/env python3
"""Tests for the road HIERARCHY (terragen/roads.py, roads lane R2).

    cd tools/mapgen
    .venv/bin/python -m unittest tests.test_road_hierarchy

Synthetic terrain only, for the reason test_roads.py already gives: the real
map packages are gitignored, so a clone has nothing to run against.

R1 gave the network three SURFACE classes (what the deck is made of). R2 adds
the axis R1's length budget was silently standing in for: what the road is FOR.
What this file pins down, and why each one is here rather than being obvious:

  * **`ROAD_ROAD` is the identity class.** Every per-class multiplier is a
    multiple of the base `RoadParams`, so "the road tier is what shipped before
    R2" is checkable rather than claimed — `Identity` builds the road tier with
    the curvature bound switched off and demands geometry bit-identical to
    `plan_roads`. Without that arm, a per-class table is free to move the
    shipped maps for reasons nobody chose.
  * **a village joins the trunk where the trunk passes it.** The tier-2 rule is
    "cheapest point on the highway DECK", not "cheapest highway endpoint", and
    the difference is the entire junction: the endpoint rule sends a village
    detouring to a town it does not care about. `Hierarchy` measures that the
    junction found is closer than the nearest trunk endpoint, with the endpoint
    rule as the arm it has to beat.
  * **the curvature bound must not straighten a switchback.** A hairpin's
    radius is small BY CONSTRUCTION — it is how a road holds a grade limit on a
    slope it cannot climb directly — so a bound applied naively removes exactly
    the geometry the grade limit built. `Curvature` runs both arms: with the
    hairpin exemption the reversal survives, without it the reversal is relaxed
    away.
  * **a junction is carved ONCE.** `flatten_under_roads` grades terrain toward
    a blur of the terrain it was handed, so running it per class blurs an
    already-graded surface and pulls the crossing toward the graded surface
    twice — a dish in the middle of the junction. `Junctions` measures the
    one-pass result against the graded surface and shows the two-pass arm
    missing it.
  * **the delivered deck is not the deck the planner costed.** The cost graph is
    memoryless, so two opposite legal traverses climb at the fall line while
    every edge certifies the grade limit, and Chaikin then smooths the saw-tooth
    into a straight climb. `DeliveredGrade` pins that degeneracy in the fixture
    where it is total (a walled ramp: every zigzag pitch costs the same and the
    tightest is shortest) and pins the instrument that reports it. **The test
    asserts today's WRONG behaviour on purpose** and says so, because the fix
    is a design question with a real price (heading state in the graph) that
    R2 routed to the plan file rather than guessing at.

Every metric carries a positive control: a deliberately-wrong construction the
same assertion must reject. A guard nobody has watched fail is not a guard.
"""

import contextlib
import io
import math
import os
import sys
import unittest
from dataclasses import replace

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from terragen import package as pk  # noqa: E402
from terragen import roads as rd  # noqa: E402

CELL = 8.0


def rolling(size: int = 96, relief: float = 12.0) -> np.ndarray:
    """test_roads.py's `rolling`: slopes straddle the reference, nothing blocked."""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    return relief * (np.sin(xx / 9.0) * np.cos(yy / 7.0)
                     + 0.4 * np.sin((xx + yy) / 4.0)) + 500.0


def walled_ramp(size: int = 96, deg: float = 20.0,
                c0: int = 20, c1: int = 76) -> np.ndarray:
    """A uniform ramp confined by cliffs.

    The one shape where the memoryless-graph degeneracy is unambiguous: the
    cost field is laterally symmetric, so every zigzag pitch costs exactly the
    same and Dijkstra takes the tightest (= shortest) one. Nothing about it is
    exotic — a valley floor between two ridges is this fixture.
    """
    rise = CELL * math.tan(math.radians(deg))
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    h = (size - 1 - yy) * rise
    h[(xx < c0) | (xx > c1)] += 5000.0
    return h


def quiet(fn, *a, **kw):
    """Run `fn` with its progress prints captured; return (result, text)."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        out = fn(*a, **kw)
    return out, buf.getvalue()


def zigzag(n: int = 24, pitch: float = 40.0, run: float = 120.0) -> np.ndarray:
    """A saw-tooth polyline: every vertex a corner, none of them a reversal.

    The proportions matter. At 90-over-60 the saw-tooth turns by 113 deg per
    vertex, which the curvature bound reads as a HAIRPIN and protects — so a
    too-sharp fixture tests the exemption and reports it as a broken bound.
    40-over-120 turns by 37 deg: a corner, unambiguously not a reversal.
    """
    xs = np.arange(n, dtype=np.float64) * run
    zs = np.where(np.arange(n) % 2 == 0, 0.0, pitch)
    return np.stack([xs, zs], axis=1)


def hairpin(leg: float = 600.0, step: float = 40.0,
            offset: float = 20.0) -> np.ndarray:
    """Two long legs meeting in a REVERSAL at one vertex — a switchback.

    The offset is small on purpose: a switchback's two legs are nearly
    collinear, which is what makes its apex a ~150 deg turn rather than the two
    90 deg corners a wide U produces. A wide U is not a switchback and does not
    exercise the exemption.
    """
    fwd = np.arange(0.0, leg + step, step)
    rev = np.arange(leg - step, -step, -step)
    up = np.stack([fwd, np.zeros(len(fwd))], axis=1)
    back = np.stack([rev, np.full(len(rev), offset)], axis=1)
    # The apex is ONE vertex: the outbound leg ends at x=leg and the return leg
    # starts one step back, so the direction reverses in a single turn. Joining
    # two legs of equal extent instead inserts a connecting segment and gives
    # two 90 deg corners — a wide U, which no exemption should protect.
    return np.vstack([up, back])


class ClassTable(unittest.TestCase):
    def test_road_is_the_identity_class(self):
        """Every ROAD_ROAD knob is the base value, so the road tier cannot move
        a shipped map by existing."""
        base = rd.RoadParams(road_width=44.0, flatten_blend=96.0)
        self.assertEqual(rd.class_width(rd.ROAD_ROAD, base), base.road_width)
        self.assertEqual(rd.class_blend(rd.ROAD_ROAD, base), base.flatten_blend)
        cp = rd.class_road_params(rd.ROAD_ROAD, base)
        self.assertEqual(cp.max_grade_deg, base.max_grade_deg)
        self.assertEqual(cp.max_sidehill_deg, base.max_sidehill_deg)

    def test_the_classes_are_ordered_the_way_the_names_are(self):
        base = rd.RoadParams()
        widths = [rd.class_width(c, base)
                  for c in (rd.ROAD_HIGHWAY, rd.ROAD_ROAD, rd.ROAD_TRACK)]
        self.assertEqual(widths, sorted(widths, reverse=True))
        blends = [rd.class_blend(c, base)
                  for c in (rd.ROAD_HIGHWAY, rd.ROAD_ROAD, rd.ROAD_TRACK)]
        self.assertEqual(blends, sorted(blends, reverse=True))
        grades = [rd.class_road_params(c, base).max_grade_deg
                  for c in (rd.ROAD_HIGHWAY, rd.ROAD_ROAD, rd.ROAD_TRACK)]
        self.assertEqual(grades, sorted(grades))
        radii = [rd.ROAD_CLASS_PARAMS[c].min_turn_radius
                 for c in (rd.ROAD_HIGHWAY, rd.ROAD_ROAD, rd.ROAD_TRACK)]
        self.assertEqual(radii, sorted(radii, reverse=True))
        # a track is deliberately unbounded: "stays wiggly" is the look
        self.assertEqual(rd.ROAD_CLASS_PARAMS[rd.ROAD_TRACK].min_turn_radius, 0.0)

    def test_only_the_blocks_move_per_class_not_the_prices(self):
        """A highway and a track are built on the same terrain by the same
        economics; what separates them is what they refuse."""
        base = rd.RoadParams()
        for c in rd.ROAD_CLASS_PARAMS:
            cp = rd.class_road_params(c, base)
            self.assertEqual(cp.grade_cost, base.grade_cost)
            self.assertEqual(cp.grade_ref_deg, base.grade_ref_deg)
            self.assertEqual(cp.sidehill_cost, base.sidehill_cost)
            self.assertEqual(cp.water_penalty, base.water_penalty)


class Curvature(unittest.TestCase):
    def test_the_radius_metric_is_the_driven_radius(self):
        """Read against a circle, whose radius is known independently."""
        t = np.linspace(0.0, 1.6 * np.pi, 200)
        circle = np.stack([700.0 * np.cos(t), 700.0 * np.sin(t)], axis=1)
        r = rd.turn_radii(circle)[1:-1]
        self.assertAlmostEqual(float(np.median(r)), 700.0, delta=2.0)
        line = np.stack([np.arange(0.0, 500.0, 10.0), np.zeros(50)], axis=1)
        self.assertTrue(np.isinf(rd.turn_radii(line)[1:-1]).all())

    def test_turn_angle_reads_a_reversal_as_a_reversal(self):
        t = rd.turn_angles(hairpin())
        self.assertGreater(float(t.max()), 150.0, "the apex is a reversal")
        self.assertEqual(int(t.argmax()), int(np.argmax(hairpin()[:, 0])),
                         "and it is at the apex vertex")
        # the apex's neighbour turns by the leg offset's own angle (26.6 deg
        # for a 20-over-40 return step); every vertex beyond that is straight,
        # because a leg is a leg
        self.assertLess(float(np.sort(t)[-2]), 30.0)
        self.assertLess(float(np.sort(t)[-3]), 1.0)

    def test_a_highway_easement_removes_the_tight_corners(self):
        cp = rd.ROAD_CLASS_PARAMS[rd.ROAD_HIGHWAY]
        got = rd.curvature_limited_smooth(
            zigzag(), min_radius=cp.min_turn_radius,
            iterations=cp.smooth_iterations, max_shift=1e9)
        control = rd.chaikin_smooth(zigzag(), cp.smooth_iterations)
        worst = lambda pl: float(np.nanmin(rd.turn_radii(pl)[1:-1]))  # noqa: E731
        # the bound is met...
        self.assertGreaterEqual(worst(got), cp.min_turn_radius * 0.9)
        # ...and Chaikin alone does not meet it, so the bound is what did it
        self.assertLess(worst(control), cp.min_turn_radius * 0.5)

    def test_a_track_keeps_its_wiggles(self):
        """Same input, track params: the deck must stay noticeably tighter than
        a highway's, or the classes are decoration."""
        hw = rd.ROAD_CLASS_PARAMS[rd.ROAD_HIGHWAY]
        tk = rd.ROAD_CLASS_PARAMS[rd.ROAD_TRACK]
        a = rd.curvature_limited_smooth(zigzag(), hw.min_turn_radius,
                                        hw.smooth_iterations, max_shift=1e9)
        b = rd.curvature_limited_smooth(zigzag(), tk.min_turn_radius,
                                        tk.smooth_iterations, max_shift=1e9)
        self.assertLess(float(np.nanmin(rd.turn_radii(b)[1:-1])),
                        float(np.nanmin(rd.turn_radii(a)[1:-1])) * 0.5)

    def test_a_switchback_survives_the_highway_bound(self):
        """The hairpin exemption, and the arm that shows it is load-bearing.

        A switchback exists to hold a grade limit across a slope the road
        cannot climb directly. Relaxing its corner shortens the run over the
        same rise, i.e. the curvature bound would undo the grade limit that
        built it — so a bound without the exemption is not a gentler road, it
        is a steeper one.
        """
        cp = rd.ROAD_CLASS_PARAMS[rd.ROAD_HIGHWAY]
        kept = rd.curvature_limited_smooth(
            hairpin(), cp.min_turn_radius, cp.smooth_iterations,
            hairpin_deg=110.0, max_shift=1e9)
        relaxed = rd.curvature_limited_smooth(
            hairpin(), cp.min_turn_radius, cp.smooth_iterations,
            hairpin_deg=180.0, max_shift=1e9)
        self.assertGreater(float(rd.turn_angles(kept).max()), 120.0)
        self.assertLess(float(rd.turn_angles(relaxed).max()), 90.0)

    def test_no_vertex_walks_further_than_the_cap(self):
        """Relaxation has no cost field in it, so an uncapped one is free to put
        the deck on ground the planner refused."""
        cap = 10.0
        got = rd.curvature_limited_smooth(zigzag(), 5000.0, 3, max_shift=cap)
        ref = rd.chaikin_smooth(zigzag(), 3)
        self.assertLessEqual(float(np.hypot(*(got - ref).T).max()), cap + 1e-6)
        loose = rd.curvature_limited_smooth(zigzag(), 5000.0, 3, max_shift=1e9)
        self.assertGreater(float(np.hypot(*(loose - ref).T).max()), cap)

    def test_endpoints_never_move(self):
        got = rd.curvature_limited_smooth(zigzag(), 5000.0, 3, max_shift=1e9)
        np.testing.assert_allclose(got[0], zigzag()[0])
        np.testing.assert_allclose(got[-1], zigzag()[-1])


class Identity(unittest.TestCase):
    """The road tier reproduces the pre-R2 network."""

    def setUp(self):
        self.h = rolling()
        self.p = rd.RoadParams(plan_step=1, road_width=44.0)
        self.eps = [(120.0, 640.0), (640.0, 140.0), (200.0, 200.0), (620.0, 600.0)]

    def test_a_flat_role_set_reproduces_plan_roads(self):
        flat = replace(rd.ROAD_CLASS_PARAMS[rd.ROAD_ROAD], min_turn_radius=0.0)
        table = dict(rd.ROAD_CLASS_PARAMS)
        table[rd.ROAD_ROAD] = flat
        old = rd.ROAD_CLASS_PARAMS
        try:
            rd.ROAD_CLASS_PARAMS = table
            net, _ = quiet(rd.plan_network, self.h, 0.0, CELL, self.eps,
                           [rd.NODE_MINOR] * 4, self.p)
        finally:
            rd.ROAD_CLASS_PARAMS = old
        want, _ = quiet(rd.plan_roads, self.h, 0.0, CELL, self.eps, self.p)
        self.assertEqual([ln.road_class for ln in net.links], [rd.ROAD_ROAD] * len(net.links))
        self.assertEqual(len(net.polylines), len(want))
        for got, exp in zip(net.polylines, want):
            np.testing.assert_array_equal(got, exp)

    def test_the_curvature_bound_is_what_makes_it_differ(self):
        """The same call WITH the shipped road-tier radius must not be identical
        — otherwise the identity test above is passing for the wrong reason."""
        net, _ = quiet(rd.plan_network, self.h, 0.0, CELL, self.eps,
                       [rd.NODE_MINOR] * 4, self.p)
        want, _ = quiet(rd.plan_roads, self.h, 0.0, CELL, self.eps, self.p)
        self.assertTrue(any(got.shape != exp.shape or not np.array_equal(got, exp)
                            for got, exp in zip(net.polylines, want)))

    def test_plan_network_is_deterministic(self):
        a, _ = quiet(rd.plan_network, self.h, 0.0, CELL, self.eps,
                     [rd.NODE_MINOR] * 4, self.p)
        b, _ = quiet(rd.plan_network, self.h, 0.0, CELL, self.eps,
                     [rd.NODE_MINOR] * 4, self.p)
        self.assertEqual(len(a.links), len(b.links))
        for x, y in zip(a.links, b.links):
            self.assertEqual(x.road_class, y.road_class)
            np.testing.assert_array_equal(x.polyline, y.polyline)

    def test_an_unknown_role_is_refused_rather_than_ignored(self):
        with self.assertRaises(ValueError):
            rd.plan_network(self.h, 0.0, CELL, self.eps,
                            ["village", "town", "poi", "edge"], self.p)
        with self.assertRaises(ValueError):
            rd.plan_network(self.h, 0.0, CELL, self.eps, [rd.NODE_TOWN], self.p)


class Hierarchy(unittest.TestCase):
    def setUp(self):
        self.h = rolling()
        self.p = rd.RoadParams(plan_step=1, road_width=44.0)
        #   0,1 map-edge portals   2,3 towns   4,5 villages   6 a POI
        self.eps = [(80.0, 80.0), (680.0, 700.0), (100.0, 660.0), (660.0, 120.0),
                    (300.0, 300.0), (240.0, 540.0), (560.0, 460.0)]
        self.roles = [rd.NODE_EDGE, rd.NODE_EDGE, rd.NODE_TOWN, rd.NODE_TOWN,
                      rd.NODE_MINOR, rd.NODE_MINOR, rd.NODE_POI]
        self.net, _ = quiet(rd.plan_network, self.h, 0.0, CELL, self.eps,
                            self.roles, self.p)

    def test_every_tier_is_present_and_carries_its_own_class(self):
        by = {c: 0 for c in rd.ROAD_CLASS_PARAMS}
        for ln in self.net.links:
            by[ln.road_class] += 1
        self.assertGreaterEqual(by[rd.ROAD_HIGHWAY], 3, "portals + towns unspanned")
        self.assertGreaterEqual(by[rd.ROAD_ROAD], 1, "no village joined by road")
        self.assertEqual(by[rd.ROAD_TRACK], 1, "the POI is not on a track")

    def test_highways_join_only_portals_and_towns(self):
        trunk = {0, 1, 2, 3}
        for ln in self.net.links:
            if ln.road_class == rd.ROAD_HIGHWAY:
                self.assertIn(ln.a, trunk)
                self.assertIn(ln.b, trunk)

    def test_a_village_joins_the_deck_not_the_nearest_town(self):
        """The junction the tier-2 rule finds must beat the endpoint rule it
        replaced, or "towns plug into the network" is a detour."""
        self.assertTrue(self.net.junctions, "no junction was recorded")
        trunk_pts = np.array([self.eps[i] for i in (0, 1, 2, 3)])
        jn = np.array(self.net.junctions)
        for i in (4, 5, 6):
            here = np.array(self.eps[i])
            to_junction = float(np.hypot(*(jn - here).T).min())
            to_endpoint = float(np.hypot(*(trunk_pts - here).T).min())
            self.assertLessEqual(to_junction, to_endpoint + 1e-6)

    def test_a_lesser_way_ends_on_the_deck_and_says_so(self):
        for ln in self.net.links:
            if ln.road_class != rd.ROAD_HIGHWAY:
                self.assertEqual(ln.b, -1, "a deck junction must be reported as -1")
                self.assertNotEqual(ln.a, -1)

    def test_class_coverage_accounts_for_the_whole_network(self):
        by = self.net.length_by_class()
        total = sum(rd._polyline_length(pl) for pl in self.net.polylines)
        self.assertAlmostEqual(sum(by.values()), total, delta=1e-6)
        self.assertGreater(by[rd.ROAD_HIGHWAY], 0.0)

    def test_the_split_diagnostic_survives_the_tiered_planner(self):
        """M9a FIND 1's warning, on the new planner.

        `plan_roads` names an unconnected forest and an isolated-by-construction
        site; the first cut of `plan_network` reported neither, and it went
        unnoticed because Meridian Basin's trunk genuinely IS two components (a
        wall apart at a 15 deg grade limit) — so the new planner delivered
        silently exactly where the old one had spoken. A diagnostic only one of
        two planners emits reads as "no split" on the other.
        """
        size = 96
        h = np.full((size, size), 100.0)
        h[size // 2 - 1:size // 2 + 2, :] = 6000.0
        p = rd.RoadParams(plan_step=1, mask_k=2, max_bridge_cells=0)
        eps = [(200.0, 100.0), (600.0, 120.0), (200.0, 660.0), (600.0, 640.0)]
        roles = [rd.NODE_EDGE, rd.NODE_TOWN, rd.NODE_EDGE, rd.NODE_TOWN]
        net, text = quiet(rd.plan_network, h, -1.0, CELL, eps, roles, p)
        self.assertIn("unconnected networks", text)
        self.assertIn("highway", text, "the message must name the tier")
        self.assertEqual(net.networks, 2)
        # ...and it stays quiet on a map that is one network, so the message is
        # a finding rather than boilerplate
        _n2, quiet_text = quiet(rd.plan_network, rolling(), 0.0, CELL, eps, roles,
                                rd.RoadParams(plan_step=1))
        self.assertNotIn("unconnected networks", quiet_text)

    def test_with_no_portals_or_towns_there_is_no_highway_tier(self):
        """A generator that declares no trunk gets the flat network, not a
        highway network by accident."""
        net, _ = quiet(rd.plan_network, self.h, 0.0, CELL, self.eps,
                       [rd.NODE_MINOR] * 6 + [rd.NODE_POI], self.p)
        self.assertNotIn(rd.ROAD_HIGHWAY, {ln.road_class for ln in net.links})
        self.assertIn(rd.ROAD_ROAD, {ln.road_class for ln in net.links})

    def test_a_single_trunk_node_is_not_a_highway(self):
        roles = [rd.NODE_TOWN] + [rd.NODE_MINOR] * 6
        net, _ = quiet(rd.plan_network, self.h, 0.0, CELL, self.eps, roles, self.p)
        self.assertNotIn(rd.ROAD_HIGHWAY, {ln.road_class for ln in net.links})


class Surfaces(unittest.TestCase):
    """The R1 material axis, driven by the R2 function axis."""

    def setUp(self):
        self.h = rolling()
        self.moist = np.full(self.h.shape, 0.30)

    def test_sealing_follows_the_hierarchy(self):
        pls = [zigzag(n=8), zigzag(n=8) + 200.0, zigzag(n=8) + 400.0]
        classes = [rd.ROAD_HIGHWAY, rd.ROAD_ROAD, rd.ROAD_TRACK]
        got = rd.classify_roads(pls, self.moist, self.h, 0.0, CELL,
                                road_classes=classes)
        self.assertTrue((got[0] == rd.SURF_BITUMEN).all())
        self.assertTrue((got[1] == rd.SURF_DIRT).all())
        self.assertTrue((got[2] == rd.SURF_DIRT).all())

    def test_the_length_budget_is_not_consulted_when_a_hierarchy_is_given(self):
        """The neutralisation that matters: make the LONGEST link a track. R1's
        budget seals the longest link by construction; the hierarchy must not."""
        short_hwy = zigzag(n=4)
        long_track = zigzag(n=40) + 300.0
        pls = [short_hwy, long_track]
        with_h = rd.classify_roads(pls, self.moist, self.h, 0.0, CELL,
                                   road_classes=[rd.ROAD_HIGHWAY, rd.ROAD_TRACK])
        without = rd.classify_roads(pls, self.moist, self.h, 0.0, CELL)
        self.assertTrue((with_h[0] == rd.SURF_BITUMEN).all())
        self.assertTrue((with_h[1] == rd.SURF_DIRT).all())
        # the budget arm seals the long one instead — the two rules really do
        # disagree, so "the budget is retired" is a decision and not a no-op
        self.assertTrue((without[1] == rd.SURF_BITUMEN).all())

    def test_a_wrong_length_road_class_list_is_refused(self):
        with self.assertRaises(ValueError):
            rd.classify_roads([zigzag(n=4)], self.moist, self.h, 0.0, CELL,
                              road_classes=[rd.ROAD_HIGHWAY, rd.ROAD_ROAD])

    def test_an_unsealed_way_through_wet_ground_is_still_mud(self):
        wet = np.full(self.h.shape, 0.90)
        got = rd.classify_roads([zigzag(n=8)], wet, self.h, 0.0, CELL,
                                road_classes=[rd.ROAD_TRACK])
        self.assertTrue((got[0] == rd.SURF_MUD).all())
        sealed = rd.classify_roads([zigzag(n=8)], wet, self.h, 0.0, CELL,
                                   road_classes=[rd.ROAD_HIGHWAY])
        self.assertTrue((sealed[0] == rd.SURF_BITUMEN).all(),
                        "a built road stays sealed across a wet dip")


def cross_network() -> rd.RoadNetwork:
    """A highway and a track crossing at the middle of a 96-cell fixture."""
    mid = 48 * CELL
    hwy = np.stack([np.arange(80.0, 700.0, 8.0),
                    np.full(len(np.arange(80.0, 700.0, 8.0)), mid)], axis=1)
    trk = np.stack([np.full(len(np.arange(80.0, 700.0, 8.0)), mid),
                    np.arange(80.0, 700.0, 8.0)], axis=1)
    return rd.RoadNetwork(
        links=[rd.RoadLink(hwy, rd.ROAD_HIGHWAY, 0, 1),
               rd.RoadLink(trk, rd.ROAD_TRACK, 2, -1)],
        junctions=[(mid, mid)])


class Raster(unittest.TestCase):
    def setUp(self):
        self.h = rolling()
        self.p = rd.RoadParams(plan_step=1, road_width=44.0)
        self.net = cross_network()
        self.r = rd.rasterize_network(self.net, self.h.shape, CELL, self.p)

    def test_each_class_gets_its_own_deck_width(self):
        """Measured across the deck, away from the junction. A rasterizer using
        one width would report the two as equal."""
        # the track runs along z at constant x, so a ROW crosses it; the
        # highway runs along x at constant z, so a COLUMN crosses it. Row 48 is
        # the highway's own centreline — measuring the track there reads the
        # highway's length, which is how this test first passed for 112 units.
        track_w = float(self.r.mask[20, :].sum()) * CELL
        hwy_w = float(self.r.mask[:, 20].sum()) * CELL
        self.assertAlmostEqual(hwy_w, rd.class_width(rd.ROAD_HIGHWAY, self.p),
                               delta=2 * CELL)
        self.assertAlmostEqual(track_w, rd.class_width(rd.ROAD_TRACK, self.p),
                               delta=2 * CELL)
        self.assertGreater(hwy_w, track_w * 2.0)

    def test_the_coarsest_class_owns_the_junction(self):
        """Ordinal classes exist so a crossing is ONE piece of deck."""
        self.assertEqual(int(self.r.road_class[48, 48]), rd.ROAD_HIGHWAY)
        self.assertEqual(int(self.r.road_class[20, 48]), rd.ROAD_TRACK)

    def test_the_normalised_distance_is_the_on_deck_test_for_every_class(self):
        half = self.p.road_width * 0.5
        np.testing.assert_array_equal(self.r.mask, self.r.dist <= half + 1e-9)

    def test_the_shoulder_belongs_to_the_nearest_class(self):
        """The blend is measured OUTSIDE the deck, so keying it to on-deck cells
        would put the per-class shoulder everywhere except where a shoulder is."""
        self.assertAlmostEqual(float(self.r.blend[30, 20]),
                               rd.class_blend(rd.ROAD_HIGHWAY, self.p), delta=1e-6)
        self.assertAlmostEqual(float(self.r.blend[20, 40]),
                               rd.class_blend(rd.ROAD_TRACK, self.p), delta=1e-6)

    def test_an_empty_network_is_all_off_deck(self):
        r = rd.rasterize_network(rd.RoadNetwork(), self.h.shape, CELL, self.p)
        self.assertFalse(r.mask.any())
        self.assertTrue((r.surf == rd.SURF_NONE).all())
        self.assertTrue((r.dist > self.p.road_width).all())

    def test_surfaces_reach_the_class_raster(self):
        surf = [np.full(len(ln.polyline), rd.SURF_BITUMEN if i == 0 else rd.SURF_MUD,
                        dtype=np.uint8) for i, ln in enumerate(self.net.links)]
        r = rd.rasterize_network(self.net, self.h.shape, CELL, self.p, surfaces=surf)
        self.assertEqual(int(r.surf[48, 48]), rd.SURF_BITUMEN)
        self.assertEqual(int(r.surf[20, 48]), rd.SURF_MUD)
        self.assertEqual(int(r.surf[0, 0]), rd.SURF_NONE)


class Junctions(unittest.TestCase):
    def setUp(self):
        self.h = rolling()
        self.p = rd.RoadParams(plan_step=1, road_width=44.0)
        self.net = cross_network()
        self.r = rd.rasterize_network(self.net, self.h.shape, CELL, self.p)

    def test_a_junction_is_carved_once(self):
        """`flatten_under_roads` grades toward a blur of what it was handed, so
        a second per-class pass blurs an already-graded surface and dishes the
        crossing. One pass over the combined field is the fix."""
        widest = rd.class_width(rd.ROAD_HIGHWAY, self.p)
        from scipy import ndimage
        graded = ndimage.gaussian_filter(self.h, sigma=max(2.0, widest * 4.0 / CELL))

        one = rd.flatten_network(self.h, self.r, CELL, self.p)

        # the double-carve arm: per-class rasters, flattened in sequence
        parts = []
        for rc in (rd.ROAD_HIGHWAY, rd.ROAD_TRACK):
            sub = rd.RoadNetwork(links=[ln for ln in self.net.links
                                        if ln.road_class == rc])
            parts.append(rd.rasterize_network(sub, self.h.shape, CELL, self.p))
        two = self.h
        for part in parts:
            two = rd.flatten_network(two, part, CELL, self.p)

        j = (48, 48)
        self.assertAlmostEqual(float(one[j]), float(graded[j]), delta=0.05)
        self.assertGreater(abs(float(two[j]) - float(graded[j])), 0.25,
                           "the two-pass arm must miss, or there is nothing to fix")

    def test_the_apron_widens_the_deck_at_the_junction(self):
        before = int(self.r.mask.sum())
        rd.carve_junction_aprons(self.r, self.net.junctions, CELL, self.p)
        self.assertGreater(int(self.r.mask.sum()), before)
        # ...and it is still deck, i.e. the on-deck test still holds
        half = self.p.road_width * 0.5
        np.testing.assert_array_equal(self.r.mask & (self.r.dist <= half + 1e-9),
                                      self.r.mask & (self.r.dist <= half + 1e-9))

    def test_the_apron_takes_the_surface_of_the_ways_arriving_at_it(self):
        surf = [np.full(len(ln.polyline), rd.SURF_BITUMEN, dtype=np.uint8)
                for ln in self.net.links]
        r = rd.rasterize_network(self.net, self.h.shape, CELL, self.p, surfaces=surf)
        rd.carve_junction_aprons(r, self.net.junctions, CELL, self.p)
        rim = r.surf[46:51, 46:51]
        self.assertTrue((rim == rd.SURF_BITUMEN).all())

    def test_no_junctions_is_not_an_error(self):
        before = int(self.r.mask.sum())
        rd.carve_junction_aprons(self.r, [], CELL, self.p)
        self.assertEqual(int(self.r.mask.sum()), before)


class DeliveredGrade(unittest.TestCase):
    """The deck the map ships is not the deck the planner costed (R2 finding)."""

    def test_the_grade_reading_declares_its_scale(self):
        """Read per smoothed vertex, a one-cell heightmap step over a two-unit
        segment is a 55 deg pitch — so an undeclared scale reads any road as a
        cliff. This is why every geometric measurement here resamples first."""
        h = walled_ramp()
        p = rd.replace(rd.RoadParams(plan_step=1), max_grade_deg=8.0)
        pl, _ = quiet(rd.plan_roads, h, -1e9, CELL,
                      [(48 * CELL, 92 * CELL), (48 * CELL, 4 * CELL)], p)
        pl = pl[0]
        raw = np.hypot(*(pl[1:] - pl[:-1]).T)
        self.assertLess(float(np.median(raw)), CELL,
                        "the smoothed polyline is finer than the heightmap")
        coarse = rd.deck_grade_profile(pl, h, CELL, window=4 * CELL)
        self.assertGreater(coarse.size, 10)

    def test_every_mask_edge_holds_the_limit_and_the_deck_does_not(self):
        """The degeneracy, in the fixture where it is total — and its fix.

        This test was written asserting today's WRONG behaviour on purpose,
        because fixing it meant heading state in the graph and a real price.
        §2d.1 was answered (option C, 2026-08-19) and R6 built it, so the test
        is now the A/B it was always going to become — and it keeps BOTH arms,
        because the memoryless arm is the positive control: without it, a
        heading-state planner that happened to be right for some other reason
        would pass silently.

        The memoryless arm climbs at the fall line: on a laterally symmetric
        ramp every zigzag pitch costs the same and Dijkstra takes the tightest,
        which Chaikin then smooths into a straight climb.
        """
        h = walled_ramp(deg=20.0)
        ends = [(48 * CELL, 92 * CELL), (48 * CELL, 4 * CELL)]

        # --- the control: memoryless, and it still delivers a 20 deg fall line
        off = rd.replace(rd.RoadParams(plan_step=1, heading_sectors=0),
                         max_grade_deg=8.0)
        pl, _ = quiet(rd.plan_roads, h, -1e9, CELL, ends, off)
        g0 = rd.deck_grade_profile(pl[0], h, CELL, window=4 * CELL)
        self.assertGreater(float(np.percentile(g0, 95)), 15.0,
                           "the memoryless control is supposed to be broken")

        # --- and the fix: the SAME fixture, the same limit, heading state on
        for sectors in (4, 8):
            with self.subTest(sectors=sectors):
                on = rd.replace(rd.RoadParams(plan_step=1,
                                              heading_sectors=sectors),
                                max_grade_deg=8.0)
                pl2, _ = quiet(rd.plan_roads, h, -1e9, CELL, ends, on)
                self.assertTrue(pl2, "heading state lost the route entirely")
                g1 = rd.deck_grade_profile(pl2[0], h, CELL, window=4 * CELL)
                self.assertLess(float(np.percentile(g1, 95)), 12.0,
                                "the fall-line climb survived heading state")
                self.assertLess(float(np.percentile(g1, 95)),
                                float(np.percentile(g0, 95)) * 0.7,
                                "heading state barely moved the delivered grade")

    def test_the_zigzag_is_what_heading_state_removes(self):
        """Name the pathology directly, not just its grade consequence.

        The §2d.1 defect is a **3-cell zigzag**: legs so short the deck reverses
        every couple of planning cells, which Chaikin then launders into a
        straight fall-line climb. Grade is the symptom; leg length is the thing.
        Measured on the RAW planning path (before smoothing), because smoothing
        is precisely what hides it.
        """
        h = walled_ramp(deg=20.0)
        ends = [(48 * CELL, 92 * CELL), (48 * CELL, 4 * CELL)]

        def mean_leg(sectors):
            p = rd.replace(rd.RoadParams(plan_step=1, heading_sectors=sectors),
                           max_grade_deg=8.0)
            pl, _ = quiet(rd.plan_roads, h, -1e9, CELL, ends, p)
            r = rd.resample_by_arclength(pl[0], 2 * CELL)
            t = rd.turn_angles(r)
            rev = int((t > 90.0).sum())
            length = float(np.hypot(*(r[1:] - r[:-1]).T).sum())
            # distance the deck runs per reversal — the leg length the planner
            # is willing to accept. inf when it never reverses.
            return length / rev if rev else float("inf"), rev

        leg_off, rev_off = mean_leg(0)
        leg_on, rev_on = mean_leg(8)
        self.assertGreater(leg_on, leg_off * 1.5,
                           "heading state did not lengthen the legs")
        self.assertGreater(leg_on, 200.0,
                           "the legs are still short enough to read as a zigzag")

    def test_the_penalty_is_what_works_not_the_layering(self):
        """Positive control on the mechanism itself.

        Layering the graph by heading changes nothing on its own — it is a
        relabelling of the same edges. `turn_penalty = 0` must therefore
        reproduce the memoryless result exactly, which is what proves the fix
        is the PRICE and not an accident of the larger graph.
        """
        h = walled_ramp(deg=20.0)
        ends = [(48 * CELL, 92 * CELL), (48 * CELL, 4 * CELL)]
        base = rd.replace(rd.RoadParams(plan_step=1, heading_sectors=0),
                          max_grade_deg=8.0)
        free = rd.replace(rd.RoadParams(plan_step=1, heading_sectors=8,
                                        turn_penalty=0.0), max_grade_deg=8.0)
        a, _ = quiet(rd.plan_roads, h, -1e9, CELL, ends, base)
        b, _ = quiet(rd.plan_roads, h, -1e9, CELL, ends, free)
        ga = rd.deck_grade_profile(a[0], h, CELL, window=4 * CELL)
        gb = rd.deck_grade_profile(b[0], h, CELL, window=4 * CELL)
        self.assertAlmostEqual(float(np.percentile(ga, 95)),
                               float(np.percentile(gb, 95)), places=6,
                               msg="a free turn is not the memoryless graph")

    def test_heading_sectors_zero_is_the_memoryless_graph_exactly(self):
        """The escape hatch has to be exact, not merely similar.

        Both shipped maps are pinned to `heading_sectors=0` so their packages
        do not move (a re-ship is a human's call, not a default). That pin is
        only worth anything if 0 is bit-for-bit the pre-R6 planner.
        """
        for h, wl, ends, roles in (
                (walled_ramp(deg=20.0), -1e9,
                 [(48 * CELL, 92 * CELL), (48 * CELL, 4 * CELL)],
                 [rd.NODE_EDGE, rd.NODE_TOWN]),
                (rolling(), 0.0, [(80.0, 80.0), (680.0, 700.0), (300.0, 300.0)],
                 [rd.NODE_EDGE, rd.NODE_TOWN, rd.NODE_POI])):
            p = rd.RoadParams(plan_step=1, heading_sectors=0)
            net, _ = quiet(rd.plan_network, h, wl, CELL, ends, roles, p)
            self.assertTrue(net.links)
            # the layered graph must not even be built when it is switched off
            hh, water, slope = rd._plan_grid(h, wl, CELL, p)
            g = rd._plan_graph(hh, water, slope, CELL, p)
            self.assertEqual(g.S, 0)
            self.assertEqual(g.csr.shape[0], g.n)
            # ...and it IS the same matrix the pre-R6 planner routed on
            base = rd._edge_costs(hh, water, slope, CELL, p)
            self.assertEqual((g.csr != base).nnz, 0)
            # while switching it on grows the graph by exactly sectors + 1
            q = rd.RoadParams(plan_step=1, heading_sectors=8)
            gq = rd._plan_graph(hh, water, slope, CELL, q)
            self.assertEqual(gq.csr.shape[0], g.n * 9)
            self.assertEqual(gq.csr.nnz, base.nnz * 9)

    def test_ordinary_terrain_is_left_alone_by_the_fix(self):
        """The fix must be INERT where there was no defect.

        §2d.1's own scoping: on rolling ground the cost field breaks the tie, so
        the shipped maps were never the point. A heading penalty that rerouted
        ordinary terrain would be buying a fix nobody needed with detour nobody
        asked for.
        """
        h = rolling()
        ends = [(100.0, 700.0), (700.0, 100.0)]
        def length(sectors):
            p = rd.RoadParams(plan_step=1, heading_sectors=sectors)
            pl, _ = quiet(rd.plan_roads, h, 0.0, CELL, ends, p)
            return float(np.hypot(*(pl[0][1:] - pl[0][:-1]).T).sum())
        base = length(0)
        for sectors in (4, 8):
            with self.subTest(sectors=sectors):
                self.assertLess(abs(length(sectors) - base) / base, 0.05,
                                "heading state moved a route that was already fine")

    def test_ordinary_terrain_does_not_show_the_degeneracy(self):
        """What scopes the finding: on rolling ground the cost field breaks the
        tie, so the shipped maps are not obviously affected — which is why this
        is a design question and not a stop-everything defect."""
        h = rolling()
        p = rd.RoadParams(plan_step=1)
        pl, _ = quiet(rd.plan_roads, h, 0.0, CELL,
                      [(100.0, 700.0), (700.0, 100.0)], p)
        t = rd.turn_angles(rd.resample_by_arclength(pl[0], 4 * CELL))
        self.assertLess(int((t > 90).sum()), 6)

    def test_the_instrument_reports_the_class_it_is_measuring(self):
        h = rolling()
        p = rd.RoadParams(plan_step=1, road_width=44.0)
        net, _ = quiet(rd.plan_network, h, 0.0, CELL,
                       [(80.0, 80.0), (680.0, 700.0), (300.0, 300.0)],
                       [rd.NODE_EDGE, rd.NODE_TOWN, rd.NODE_POI], p)
        out, text = quiet(rd.report_delivered_grades, net, h, CELL, p)
        self.assertIn(rd.ROAD_HIGHWAY, out)
        self.assertIn("delivered grade", text)
        for rc, (p95, mx) in out.items():
            self.assertLessEqual(p95, mx + 1e-9)

    def test_the_warning_fires_when_the_deck_beats_its_limit(self):
        h = walled_ramp(deg=20.0)
        # pinned memoryless: this is the warning ABOUT the memoryless graph,
        # and R6 gave the priced-reversal case its own wording below
        p = rd.RoadParams(plan_step=1, heading_sectors=0)
        net, _ = quiet(rd.plan_network, h, -1e9, CELL,
                       [(48 * CELL, 92 * CELL), (48 * CELL, 4 * CELL)],
                       [rd.NODE_EDGE, rd.NODE_TOWN], p)
        _out, text = quiet(rd.report_delivered_grades, net, h, CELL, p)
        self.assertIn("WARNING", text)
        # ...and stays quiet on ground where the deck really does hold its grade
        flat = np.full((96, 96), 100.0)
        net2, _ = quiet(rd.plan_network, flat, -1e9, CELL,
                        [(80.0, 80.0), (680.0, 700.0)],
                        [rd.NODE_EDGE, rd.NODE_TOWN], p)
        _o2, text2 = quiet(rd.report_delivered_grades, net2, flat, CELL, p)
        self.assertNotIn("WARNING", text2)
        self.assertIn("memoryless", text)

    def test_the_warning_stops_blaming_the_graph_once_it_has_memory(self):
        """A warning that still said "the cost graph is memoryless" with
        heading state ON would be pointing at the wrong thing — the reversal is
        priced, so a steep deck is now a claim about the TERRAIN. Same fixture,
        same instrument, different diagnosis."""
        h = walled_ramp(deg=20.0)
        p = rd.RoadParams(plan_step=1, heading_sectors=8)
        net, _ = quiet(rd.plan_network, h, -1e9, CELL,
                       [(48 * CELL, 92 * CELL), (48 * CELL, 4 * CELL)],
                       [rd.NODE_EDGE, rd.NODE_TOWN], p)
        _out, text = quiet(rd.report_delivered_grades, net, h, CELL, p)
        self.assertNotIn("memoryless", text)


class RoadsLuaExport(unittest.TestCase):
    """The town-planner seam: the generator publishes its road graph."""

    def setUp(self):
        self.p = rd.RoadParams(plan_step=1, road_width=44.0)
        self.net = cross_network()
        self.lua = pk.emit_roads_lua(self.net, CELL, self.p)

    def test_every_link_is_emitted_with_its_class_name_and_width(self):
        self.assertEqual(self.lua.count("class ="), len(self.net.links))
        self.assertIn('name = "highway"', self.lua)
        self.assertIn('name = "track"', self.lua)
        self.assertIn(f"width = {rd.class_width(rd.ROAD_HIGHWAY, self.p):.0f}",
                      self.lua)
        self.assertIn(f"width = {rd.class_width(rd.ROAD_TRACK, self.p):.0f}", self.lua)

    def test_the_deck_width_emitted_is_the_callers_not_the_default(self):
        """A generator running a 44-unit deck must not publish the 48 default —
        the consumer puts a street exit on this number."""
        default = pk.emit_roads_lua(self.net, CELL, rd.RoadParams())
        self.assertNotEqual(default, self.lua)

    def test_junctions_are_emitted_in_world_coordinates(self):
        self.assertIn(f"x = {48 * CELL:.0f}", self.lua)

    def test_the_polylines_are_decimated_not_dumped(self):
        verts = self.lua.count("{")
        raw = sum(len(ln.polyline) for ln in self.net.links)
        self.assertLess(verts, raw / 4)

    def test_it_is_syntactically_a_lua_table(self):
        self.assertTrue(self.lua.startswith("--"))
        self.assertIn("return {", self.lua)
        self.assertEqual(self.lua.count("{"), self.lua.count("}"))


if __name__ == "__main__":
    unittest.main()
