#!/usr/bin/env python3
"""Tests for the road planner (terragen/roads.py, PLAN-maps.md §2b item 5).

    python3 -m unittest discover -s tools/mapgen/tests

Synthetic terrain only, for the reason test_rivers.py already gives: the real
map packages are gitignored, so a clone has nothing to run against. The cost
graph, the Dijkstra and the topology are the shipping ones.

What this pins down, and why each one is here rather than being obvious:

  * **k=1 is still the old graph.** The segment-mask rewrite is only trustworthy
    as an isolated variable if the degenerate case reproduces what shipped
    before it. `test_mask_k1_matches_eight_connected` rebuilds the pre-change
    8-connected cost expression inline and demands bit equality, so the mask is
    the only thing the map-level A/B was measuring.
  * **a long offset must not step over a wall.** The whole hazard of a k>1 mask
    is that an edge spans cells nobody costed. `test_long_edges_cannot_cross_a_
    wall` builds a one-cell-thick impassable ridge — invisible to an endpoint-
    only cost rule, fatal to a road — and shows the endpoint-only rule crossing
    it while the shipping line integral does not.
  * **the spanning FOREST, not a tree.** The old MST grew one tree and `break`ed
    at the first unreachable endpoint, which dropped every endpoint after it.
    On Meridian Basin that was the map's entire southern half: six sites kept
    their worn junction plazas and lost all their roads. The test builds the
    same shape (two basins split by a wall) and asserts every site is spanned.
  * **`max_bridge_cells` is read at all.** It was declared from the first commit
    and never referenced, so "bridges only where the crossing is narrow" was
    documentation, not behaviour. The test crosses a narrow strait and fails to
    cross a wide sea in the same fixture, so the guard cannot be vacuous.
  * **grade and side-hill are two different slopes** (M9a). The fixture for
    `CostModel` is a constant-slope ramp, the one shape where the distinction
    is unambiguous: every cell has the same terrain slope, so a model that
    prices terrain *cannot* tell a contour traverse from a fall-line climb and
    one that prices grade must. The class also pins the two readings of grade
    that are wrong — per sub-step (which forbids the traverse the mask exists
    for) and endpoint-to-endpoint (which hides a climb and its descent inside
    one edge) — and the units trap, because reading the rise against the
    full-res cell instead of the planning cell reports a 20 deg ramp as 55.
  * **the reuse discount actually merges branches.** It measures ~nothing on
    either shipped map (their settlements are chains, so there is no trunk to
    share). That is a content fact, and it is only a *content* fact if the
    mechanism is known to work — `test_road_discount_merges_branches` uses a Y
    of three sites on flat ground, where reuse must produce a shared trunk, and
    checks the same fixture does not share it with the discount off.

Every metric carries a positive control: a deliberately-wrong construction that
the same assertion must reject. A guard nobody has watched fail is not a guard.
"""

import contextlib
import io
import math
import os
import sys
import unittest

import numpy as np
from scipy.sparse import coo_matrix

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from terragen import roads as rd  # noqa: E402

CELL = 8.0


def flat(size: int = 96, height: float = 100.0) -> np.ndarray:
    return np.full((size, size), height, dtype=np.float64)


def ridged(size: int = 96, seed: int = 3, relief: float = 400.0) -> np.ndarray:
    """Corrugated terrain: real slope structure, no flat plateaus."""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    return relief * (np.sin(xx / 9.0) * np.cos(yy / 7.0)
                     + 0.4 * np.sin((xx + yy) / 4.0)) + 500.0


def rolling(size: int = 96, relief: float = 12.0) -> np.ndarray:
    """Same shape as `ridged`, scaled so slopes straddle `slope_ref_deg`.

    Median 9.3 deg, max 21.0 deg: nothing is impassable at the default 28 deg,
    and both sides of the 10 deg reference slope are represented. `ridged` is
    deliberately near-vertical (80 deg cells) and is only useful where a test
    wants a mostly-impassable field. Anything that has to observe the *cost*
    of a route needs terrain a route can exist on — an impassable fixture
    makes a cost assertion vacuously true.
    """
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    return relief * (np.sin(xx / 9.0) * np.cos(yy / 7.0)
                     + 0.4 * np.sin((xx + yy) / 4.0)) + 500.0


def pre_m9a(**kw):
    """The cost model exactly as it shipped before M9a: terrain slope, walled.

    Kept as a constructible arm rather than a comment because it is how the
    M9a A/B was measured (arc road networks 2 -> 1, and the meridian control
    that says relaxing the wall on its own buys a 41.7 deg road). Every test
    that wants "the old behaviour" builds it here, so there is exactly one
    definition of what the old behaviour was.
    """
    d = dict(grade_cost=0.0, max_grade_deg=float("inf"),
             sidehill_cost=18.0, sidehill_ref_deg=10.0, sidehill_exp=2.5,
             max_sidehill_deg=26.0)
    d.update(kw)
    return rd.RoadParams(**d)


def eight_connected_reference(h, water, slope, cellsize, p):
    """The cost graph written out independently, 8-connected, no masks.

    Independently: this is a second implementation of the shipping cost
    expression (both slopes, both blocks), not a call into it, so k=1 equality
    tests the mask machinery against a reading of the model rather than
    against itself.
    """
    H, W = h.shape
    n = H * W
    idx = np.arange(n).reshape(H, W)
    step = cellsize * p.plan_step
    rows, cols, costs = [], [], []
    for dr, dc in [(-1, -1), (-1, 0), (-1, 1), (0, -1),
                   (0, 1), (1, -1), (1, 0), (1, 1)]:
        r0, r1 = max(dr, 0), H + min(dr, 0)
        c0, c1 = max(dc, 0), W + min(dc, 0)
        sr0, sr1 = max(-dr, 0), H + min(-dr, 0)
        sc0, sc1 = max(-dc, 0), W + min(-dc, 0)
        src = idx[sr0:sr1, sc0:sc1].ravel()
        dst = idx[r0:r1, c0:c1].ravel()
        length = np.hypot(dr, dc)
        s = np.maximum(slope[sr0:sr1, sc0:sc1].ravel(), slope[r0:r1, c0:c1].ravel())
        dh = np.abs(h[r0:r1, c0:c1].ravel() - h[sr0:sr1, sc0:sc1].ravel())
        w = water[sr0:sr1, sc0:sc1].ravel() | water[r0:r1, c0:c1].ravel()
        grade = np.where(~w, np.degrees(np.arctan(dh / (length * step))), 0.0)
        cost = length * (1.0
                         + p.grade_cost * (grade / p.grade_ref_deg) ** p.grade_exp
                         + p.sidehill_cost * (s / p.sidehill_ref_deg) ** p.sidehill_exp)
        cost = np.where(w, length * p.water_penalty, cost)
        blocked = ((grade > p.max_grade_deg) | (s > p.max_sidehill_deg)) & ~w
        cost = np.where(blocked, np.inf, cost)
        keep = np.isfinite(cost)
        rows.append(src[keep]); cols.append(dst[keep]); costs.append(cost[keep])
    return coo_matrix((np.concatenate(costs),
                       (np.concatenate(rows), np.concatenate(cols))),
                      shape=(n, n)).tocsr()


class MaskGeometry(unittest.TestCase):
    def test_offsets_are_primitive_and_counted(self):
        # Non-primitive offsets are exactly a repeat of a shorter one at the
        # same heading and cost, so including them only inflates the edge count.
        for k, want in [(1, 8), (2, 16), (3, 32), (4, 48), (5, 80)]:
            offs = rd.mask_offsets(k)
            self.assertEqual(len(offs), want, f"k={k}")
            for dr, dc in offs:
                self.assertEqual(math.gcd(abs(dr), abs(dc)), 1)
            self.assertEqual(len(set(offs)), len(offs))
        self.assertEqual(sorted(rd.mask_offsets(1)),
                         sorted([(-1, -1), (-1, 0), (-1, 1), (0, -1),
                                 (0, 1), (1, -1), (1, 0), (1, 1)]))

    def test_angular_resolution_of_each_mask(self):
        """PLAN-maps §2b item 5 asks for "k=5 segment masks, 9.5 deg angular
        resolution". Those two do not describe the same mask under any metric,
        and the numbers are pinned here so the next reader does not have to
        re-derive that: k=5 is 11.31 deg worst-gap / 4.50 deg mean. 9.5 deg is
        either k=4's length-weighted gap (9.10) or k=6's worst gap (9.46).
        """
        want = {1: (45.00, 45.00), 2: (26.57, 22.50), 3: (18.43, 11.25),
                4: (14.04, 7.50), 5: (11.31, 4.50), 6: (9.46, 3.75)}
        for k, (max_gap, mean_gap) in want.items():
            ang = sorted(math.degrees(math.atan2(dr, dc)) % 360.0
                         for dr, dc in rd.mask_offsets(k))
            gaps = [(ang[(i + 1) % len(ang)] - ang[i]) % 360.0
                    for i in range(len(ang))]
            self.assertAlmostEqual(max(gaps), max_gap, places=2, msg=f"k={k}")
            self.assertAlmostEqual(360.0 / len(ang), mean_gap, places=2, msg=f"k={k}")

    def test_segment_samples_are_a_connected_bresenham_walk(self):
        for k in (1, 2, 3, 4, 5):
            for dr, dc in rd.mask_offsets(k):
                s = rd._segment_samples(dr, dc)
                self.assertEqual(s[0], (0, 0))
                self.assertEqual(s[-1], (dr, dc))
                self.assertEqual(len(s) - 1, max(abs(dr), abs(dc)))
                for a, b in zip(s[:-1], s[1:]):
                    # every sub-step is a single 8-connected move, so no cell
                    # between the endpoints goes uncosted
                    self.assertLessEqual(max(abs(b[0] - a[0]), abs(b[1] - a[1])), 1)
                    self.assertNotEqual(a, b)
        # transposing the offset transposes the walk: no axis is privileged
        for dr, dc in rd.mask_offsets(4):
            a = rd._segment_samples(dr, dc)
            b = rd._segment_samples(dc, dr)
            self.assertEqual([(q, p) for p, q in a], b)


class CostGraph(unittest.TestCase):
    def test_mask_k1_matches_eight_connected(self):
        # `rolling`, not `ridged`: on `ridged` almost everything is blocked and
        # the few edges that survive sit on ridge crests where both slope and
        # grade are ~0, so the comparison used to hold for any cost expression
        # at all. The fixture has to admit edges whose cost actually varies —
        # asserted below, because that is the part nobody watches fail.
        h = rolling(64)
        for p in (rd.RoadParams(plan_step=2, mask_k=1, max_bridge_cells=0),
                  pre_m9a(plan_step=2, mask_k=1, max_bridge_cells=0)):
            hh, water, slope = rd._plan_grid(h, 495.0, CELL, p)
            want = eight_connected_reference(hh, water, slope, CELL, p)
            got = rd._edge_costs(hh, water, slope, CELL, p)
            self.assertEqual(want.nnz, got.nnz)
            self.assertTrue(np.array_equal(want.indptr, got.indptr))
            self.assertTrue(np.array_equal(want.indices, got.indices))
            np.testing.assert_array_equal(want.data, got.data)
            # and the graph is neither empty nor a constant
            self.assertGreater(want.nnz, 0)
            self.assertGreater(want.data.max() / want.data.min(), 3.0,
                               "fixture costs are too uniform to compare")

    def test_long_edges_cannot_cross_a_wall(self):
        """A one-cell ridge is invisible to an endpoint-only cost rule."""
        size = 48
        h = flat(size, 100.0)
        h[:, size // 2] = 4000.0          # a single impassable column
        p = rd.RoadParams(plan_step=1, mask_k=4, max_bridge_cells=0)
        hh, water, slope = rd._plan_grid(h, -1.0, CELL, p)
        H, W = hh.shape
        g = rd._edge_costs(hh, water, slope, CELL, p).tocoo()
        crossings = ((g.row % W < W // 2 - 1) & (g.col % W > W // 2 + 1)).sum()
        self.assertEqual(crossings, 0, "a mask edge stepped over the wall")

        # positive control: cost the same mask on endpoints only and it leaks.
        # Both endpoints of a span across the wall are on the flat, so every
        # term the model has — grade AND side-hill — reads zero there.
        leaked = 0
        for dr, dc in rd.mask_offsets(4):
            for r in range(H):
                for c in range(W):
                    r2, c2 = r + dr, c + dc
                    if not (0 <= r2 < H and 0 <= c2 < W):
                        continue
                    s = max(slope[r, c], slope[r2, c2])
                    run = np.hypot(dr, dc) * CELL * p.plan_step
                    grade = math.degrees(math.atan(abs(hh[r2, c2] - hh[r, c]) / run))
                    if (s <= p.max_sidehill_deg and grade <= p.max_grade_deg
                            and c < W // 2 - 1 and c2 > W // 2 + 1):
                        leaked += 1
        self.assertGreater(leaked, 0, "control failed to demonstrate the hazard")

    def test_deep_water_blocks_open_sea_but_not_a_strait(self):
        water = np.zeros((80, 80), dtype=bool)
        water[:, 30:34] = True            # 4-cell strait
        water[:, 50:78] = True            # 28-cell sea
        p = rd.RoadParams(max_bridge_cells=12)
        deep = rd._deep_water(water, p)
        self.assertFalse(deep[:, 30:34].any(), "a 4-cell strait was called deep")
        self.assertTrue(deep[:, 58:70].any(), "open sea was not called deep")
        self.assertFalse(deep[~water].any(), "land was marked deep water")
        # the guard is a guard: turning it off admits the sea again
        self.assertFalse(rd._deep_water(water, rd.RoadParams(max_bridge_cells=0)).any())


class CostModel(unittest.TestCase):
    """M9a: the road's own grade, and the hillside it is cut into, are two
    different slopes and the model now says so.

    The fixture for all of these is a constant-slope ramp, which is the one
    shape where the distinction is unambiguous: every cell has the *same*
    terrain slope, so a model that prices terrain cannot tell a contour
    traverse from a fall-line climb, and one that prices grade must.
    """

    @staticmethod
    def ramp(size=64, slope_deg=30.0):
        """Constant-slope hillside falling along +x."""
        yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
        return 2000.0 - xx * CELL * math.tan(math.radians(slope_deg))

    def test_a_traverse_costs_less_than_the_fall_line(self):
        p = rd.RoadParams(plan_step=1, mask_k=1, max_bridge_cells=0,
                          max_sidehill_deg=90.0, max_grade_deg=90.0)
        h = self.ramp(32, 20.0)
        hh, water, slope = rd._plan_grid(h, -1.0, CELL, p)
        g = rd._edge_costs(hh, water, slope, CELL, p).tolil()
        W = hh.shape[1]
        node = 10 * W + 10
        along_contour = g[node, node + W]          # same column, next row
        up_fall_line = g[node, node + 1]           # same row, next column
        # 4.5x, and the whole difference is the grade term: both edges are the
        # same length across the same 20 deg hillside, so the side-hill price
        # they pay is identical
        self.assertGreater(up_fall_line, along_contour * 4.0,
                           "the fall line is not paying for its climb")
        # control: the pre-M9a model prices the hillside, so on a constant
        # slope the two directions cost *exactly* the same and the road has
        # no reason to prefer either
        q = pre_m9a(plan_step=1, mask_k=1, max_bridge_cells=0,
                    max_sidehill_deg=90.0)
        g2 = rd._edge_costs(hh, water, slope, CELL, q).tolil()
        self.assertAlmostEqual(g2[node, node + W], g2[node, node + 1], places=9)

    def test_the_grade_block_refuses_the_climb_and_keeps_the_traverse(self):
        p = rd.RoadParams(plan_step=1, mask_k=1, max_bridge_cells=0,
                          max_sidehill_deg=90.0)   # side-hill deliberately open
        h = self.ramp(32, 30.0)                    # 30 deg: over the 15 deg block
        hh, water, slope = rd._plan_grid(h, -1.0, CELL, p)
        g = rd._edge_costs(hh, water, slope, CELL, p)
        W = hh.shape[1]
        node = 10 * W + 10
        self.assertEqual(g[node, node + 1], 0.0, "an over-grade climb survived")
        self.assertGreater(g[node, node + W], 0.0, "the contour was blocked too")
        # so a road may cross this hillside, but only along it
        lines = rd.plan_roads(h, -1.0, CELL, [(80.0, 80.0), (80.0, 200.0)], p)
        self.assertEqual(len(lines), 1)
        lines = rd.plan_roads(h, -1.0, CELL, [(80.0, 80.0), (200.0, 80.0)], p)
        self.assertEqual(len(lines), 0, "a road climbed a 30 deg fall line")

    def test_a_town_on_steep_ground_is_reachable(self):
        """`sundered_arc`'s defect in miniature.

        A site standing on ground steeper than the old terrain-slope wall was
        not merely expensive to reach — every edge touching its own cell was
        infinite, so it was isolated by construction and the map shipped two
        unconnected road networks. Nothing about that site is unbuildable: it
        is a shelf on a hillside, and a road reaches it along the contour.
        """
        size = 48
        h = flat(size, 100.0)
        yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
        # a 29 deg hillside occupying the right third, with the town on it
        band = xx > size * 2 // 3
        h = np.where(band, 100.0 + (xx - size * 2 // 3) * CELL
                     * math.tan(math.radians(29.0)), 100.0)
        town = ((size - 4) * CELL, size * CELL / 2)
        port = (4 * CELL, size * CELL / 2)
        self.assertEqual(len(rd.plan_roads(h, -1.0, CELL, [port, town],
                                           pre_m9a(plan_step=1, mask_k=2,
                                                   max_bridge_cells=0))), 0,
                         "control: the old wall was supposed to isolate it")
        p = rd.RoadParams(plan_step=1, mask_k=2, max_bridge_cells=0)
        self.assertEqual(len(rd.plan_roads(h, -1.0, CELL, [port, town], p)), 1)

    def test_a_climb_cannot_hide_inside_one_edge(self):
        """The other wrong reading: endpoints only.

        A mask edge is up to 4 planning cells long, so a rule that reads the
        rise between its ends alone sees nothing at all in a climb that comes
        back down inside it. That is not academic — it is how Meridian Basin's
        two halves joined over a pitch measuring p95 21 deg on the delivered
        road, and the fix is summing |dh| along the sub-steps so the climb and
        the descent both count.
        """
        size = 24
        h = flat(size, 100.0)
        h[:, 1::2] = 106.0                 # +6 elmos every other column
        p = rd.RoadParams(plan_step=1, mask_k=2, max_bridge_cells=0)
        hh, water, slope = rd._plan_grid(h, -1.0, CELL, p)
        W = hh.shape[1]
        g = rd._edge_costs(hh, water, slope, CELL, p)
        node = 10 * W + 10
        # 12 elmos of climbing over a 16-elmo run is 37 deg, well past the block
        self.assertEqual(g[node, node + 2], 0.0, "a hidden climb was admitted")
        # control: the endpoints of that edge are level, so an endpoint-only
        # rule reads zero grade and would wave it through — and the side-hill
        # term cannot catch it either, because the bumps are gentle
        self.assertEqual(hh[10, 10], hh[10, 12])
        self.assertLess(slope[10, 10:13].max(), p.max_sidehill_deg)

    def test_grade_is_a_rise_over_the_run_the_planning_grid_walks(self):
        """The units trap: `h` is decimated, so the run is plan_step cells.

        Reading the rise against the full-res cell size would report grades
        `plan_step` times too steep and the block would fire on ground a road
        walks up comfortably.
        """
        h = self.ramp(64, 20.0)
        costs = {}
        for step in (1, 2, 4):
            p = rd.RoadParams(plan_step=step, mask_k=1, max_bridge_cells=0,
                              max_sidehill_deg=90.0, max_grade_deg=90.0)
            hh, water, slope = rd._plan_grid(h, -1.0, CELL, p)
            W = hh.shape[1]
            node = 4 * W + 4
            # cost per unit of planning length, so the only thing that can
            # differ between steps is the grade the model read
            costs[step] = rd._edge_costs(hh, water, slope, CELL, p)[node, node + 1]
        self.assertAlmostEqual(costs[1], costs[2], places=6)
        self.assertAlmostEqual(costs[1], costs[4], places=6)
        # control: the same reading taken against the full-res cell — i.e. the
        # bug — scales the tangent by plan_step, so a 20 deg ramp reads 55 deg
        # at plan_step 4 and the 15 deg block fires on ground a road walks up
        bad = {}
        for step in (1, 4):
            hh = h[::step, ::step]
            bad[step] = math.degrees(math.atan(abs(hh[4, 5] - hh[4, 4]) / CELL))
        self.assertAlmostEqual(math.tan(math.radians(bad[4]))
                               / math.tan(math.radians(bad[1])), 4.0, places=6)
        self.assertGreater(bad[4], rd.RoadParams().max_grade_deg)
        self.assertLess(bad[1], rd.RoadParams().max_grade_deg + 6.0)

    def test_water_is_still_level_deck_under_both_slopes(self):
        """A bridge pays the water toll and neither slope, as before M9a."""
        size = 32
        h = flat(size, 100.0)
        h[:, 12:16] = -50.0                        # a channel with steep banks
        p = rd.RoadParams(plan_step=1, mask_k=1, max_bridge_cells=12)
        hh, water, slope = rd._plan_grid(h, 0.0, CELL, p)
        W = hh.shape[1]
        g = rd._edge_costs(hh, water, slope, CELL, p).tolil()
        # the bank cell -> water cell step has a 150-elmo drop over one cell,
        # far past max_grade_deg, and it must still be crossable
        self.assertGreater(g[10 * W + 11, 10 * W + 12], 0.0,
                           "the grade block walled off a bridge abutment")
        self.assertAlmostEqual(g[10 * W + 12, 10 * W + 13], p.water_penalty,
                               places=9)


class Topology(unittest.TestCase):
    def test_forest_spans_every_component(self):
        # three groups; 0-1-2 and 3-4 mutually reachable, 5 isolated
        inf = np.inf
        pc = np.array([
            [0, 1, 2, inf, inf, inf],
            [1, 0, 1, inf, inf, inf],
            [2, 1, 0, inf, inf, inf],
            [inf, inf, inf, 0, 3, inf],
            [inf, inf, inf, 3, 0, inf],
            [inf, inf, inf, inf, inf, 0.0],
        ])
        edges = rd._mst_forest(pc)
        self.assertEqual(len(edges), 6 - 3, "a spanning forest has k - #components")
        spanned = {i for e in edges for i in e}
        self.assertEqual(spanned, {0, 1, 2, 3, 4})
        for i, j in edges:
            self.assertTrue(np.isfinite(pc[i][j]))

        # positive control: the pre-change single-tree-with-break behaviour
        in_tree, old = {0}, []
        while len(in_tree) < 6:
            best = None
            for i in in_tree:
                for j in range(6):
                    if j in in_tree or not np.isfinite(pc[i][j]):
                        continue
                    if best is None or pc[i][j] < best[0]:
                        best = (pc[i][j], i, j)
            if best is None:
                break
            old.append((best[1], best[2])); in_tree.add(best[2])
        self.assertEqual(len(old), 2, "control did not reproduce the old drop")
        self.assertNotIn(3, {i for e in old for i in e})

    def test_walled_basins_each_get_a_network(self):
        """The Meridian Basin shape: two halves with no passable crossing."""
        size = 96
        h = flat(size, 100.0)
        h[size // 2 - 1:size // 2 + 2, :] = 6000.0
        p = rd.RoadParams(plan_step=1, mask_k=2, max_bridge_cells=0)
        north = [(200.0, 100.0), (600.0, 120.0)]
        south = [(200.0, 660.0), (600.0, 640.0)]
        lines = rd.plan_roads(h, -1.0, CELL, north + south, p)
        self.assertEqual(len(lines), 2, "each basin should get its own link")
        mid = size * CELL / 2
        for line in lines:
            self.assertTrue((line[:, 1] < mid).all() or (line[:, 1] > mid).all(),
                            "a road crossed the impassable divide")

    def test_gabriel_shortcut_needs_to_beat_the_detour(self):
        # four sites in a line: 0-1-2-3. The tree route 0->3 is 3 hops.
        pts = np.array([[0.0, 0.0], [100.0, 0.0], [200.0, 0.0], [300.0, 0.0]])
        pc = np.array([[0., 1., 2., 9.],
                       [1., 0., 1., 2.],
                       [2., 1., 0., 1.],
                       [9., 2., 1., 0.]])
        tree = [(0, 1), (1, 2), (2, 3)]
        # collinear points: 0-2's disc contains 1, so Gabriel keeps only
        # adjacent pairs, all of which are already in the tree
        self.assertEqual(rd._gabriel_extras(pts, pc, tree, 1.5), [])

        # a square: the diagonals' discs each contain two corners, so the
        # Gabriel candidates are the four sides; the tree uses three of them
        pts = np.array([[0.0, 0.0], [100.0, 0.0], [100.0, 100.0], [0.0, 100.0]])
        pc = np.array([[0., 1., 5., 1.],
                       [1., 0., 1., 5.],
                       [5., 1., 0., 1.],
                       [1., 5., 1., 0.]])
        tree = [(0, 1), (1, 2), (2, 3)]
        self.assertEqual(rd._gabriel_extras(pts, pc, tree, 1.5), [(0, 3)])
        # ...and a demanding lambda rejects it: route 0->3 costs 3, direct 1,
        # so a detour factor above 3 has to leave the loop unbuilt
        self.assertEqual(rd._gabriel_extras(pts, pc, tree, 3.5), [])


class Buildable(unittest.TestCase):
    """`unbuildable_mask`: the placer/planner disagreement, as a field.

    M9a FIND 1 was a Sundered Arc town site standing on a planning cell the
    cost field could not take one step away from — `settlement_score` called
    it buildable, the planner called every edge touching it infinite, and
    nothing checked. The map got a second road network out of it. These pin
    that the condition is detectable, that it is *narrower* than "the map has
    two components" (which is legitimate topology), and that the mask lines
    up cell-for-cell with the node `plan_roads` would actually snap a site to.
    """

    def steep_knoll(self, size=96, plan_step=4):
        """Flat ground with one planning cell surrounded by a wall of slope.

        The knoll's own cell is level, so `settlement_score` likes it; every
        way off it crosses ground past `max_sidehill_deg`.
        """
        h = flat(size, 100.0)
        r = c = size // 2
        yy, xx = np.mgrid[0:size, 0:size]
        ring = (np.maximum(np.abs(yy - r), np.abs(xx - c)) <= plan_step * 2)
        core = (np.maximum(np.abs(yy - r), np.abs(xx - c)) <= 1)
        h[ring & ~core] = 100.0 + 4000.0
        return h

    def test_a_cell_the_cost_field_cannot_leave_is_flagged(self):
        p = rd.RoadParams(plan_step=4, mask_k=4, max_bridge_cells=0)
        h = self.steep_knoll()
        bad = rd.unbuildable_mask(h, -1.0, CELL, p)
        size = h.shape[0]
        self.assertTrue(bad[size // 2, size // 2],
                        "the walled knoll must be flagged")
        # ...and it is not flagging the map: ordinary flat ground is fine
        self.assertLess(bad.mean(), 0.2)
        self.assertFalse(bad[4, 4])

        # positive control: without the wall the same cell is buildable
        self.assertFalse(rd.unbuildable_mask(flat(size, 100.0), -1.0, CELL,
                                             p)[size // 2, size // 2])

    def test_two_walled_basins_are_topology_not_a_disagreement(self):
        """The Meridian shape: a real forest, and nothing flagged.

        The mask has to be narrower than "unconnected", or every legitimately
        split map would start rejecting its own sites.
        """
        size = 96
        h = flat(size, 100.0)
        h[size // 2 - 1:size // 2 + 2, :] = 6000.0
        p = rd.RoadParams(plan_step=1, mask_k=2, max_bridge_cells=0)
        bad = rd.unbuildable_mask(h, -1.0, CELL, p)
        for pt in [(200.0, 100.0), (600.0, 120.0), (200.0, 660.0), (600.0, 640.0)]:
            self.assertFalse(bad[int(pt[1] / CELL), int(pt[0] / CELL)],
                             "a site in an ordinary basin was flagged")

    def test_the_mask_agrees_with_the_node_plan_roads_snaps_to(self):
        """Upsampling has to use the planner's own rounding, not floor.

        A mask built with floor is off by half a planning cell over most of
        the grid, so it would forbid one cell and the planner would use its
        neighbour.
        """
        p = rd.RoadParams(plan_step=4, mask_k=4, max_bridge_cells=0)
        h = self.steep_knoll()
        size = h.shape[0]
        bad = rd.unbuildable_mask(h, -1.0, CELL, p)
        hp, water, slope = rd._plan_grid(h, -1.0, CELL, p)
        graph = rd._edge_costs(hp, water, slope, CELL, p,
                               deep=rd._deep_water(water, p))
        deg = np.asarray(graph.getnnz(axis=1)).reshape(hp.shape)
        PW = hp.shape[1]
        rng = np.random.default_rng(5)
        for _ in range(200):
            r = int(rng.integers(0, size)); c = int(rng.integers(0, size))
            x, z = c * CELL, r * CELL
            node = (int(np.clip(round(z / (CELL * p.plan_step)), 0, hp.shape[0] - 1))
                    * PW
                    + int(np.clip(round(x / (CELL * p.plan_step)), 0, PW - 1)))
            self.assertEqual(bool(bad[r, c]), deg.ravel()[node] == 0,
                             f"mask and planner disagree at ({r},{c})")

    def test_plan_roads_names_an_isolated_site(self):
        """The report has to distinguish the two reasons for a forest."""
        p = rd.RoadParams(plan_step=4, mask_k=4, max_bridge_cells=0)
        h = self.steep_knoll(size=128)
        mid = 64 * CELL
        pts = [(80.0, 80.0), (800.0, 100.0), (mid, mid)]
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rd.plan_roads(h, -1.0, CELL, pts, p)
        out = buf.getvalue()
        self.assertIn("unconnected networks", out)
        self.assertIn("isolated BY CONSTRUCTION", out)
        self.assertIn(f"#2 at ({mid:.0f},{mid:.0f})", out)

        # positive control: two basins split by a wall are a forest and must
        # NOT be reported as a disagreement
        size = 96
        h2 = flat(size, 100.0)
        h2[size // 2 - 1:size // 2 + 2, :] = 6000.0
        p2 = rd.RoadParams(plan_step=1, mask_k=2, max_bridge_cells=0)
        buf2 = io.StringIO()
        with contextlib.redirect_stdout(buf2):
            rd.plan_roads(h2, -1.0, CELL,
                          [(200.0, 100.0), (600.0, 120.0),
                           (200.0, 660.0), (600.0, 640.0)], p2)
        self.assertIn("unconnected networks", buf2.getvalue())
        self.assertNotIn("isolated BY CONSTRUCTION", buf2.getvalue())


class Reuse(unittest.TestCase):
    def test_road_discount_merges_branches(self):
        """A Y of three sites on flat ground: reuse must build one trunk.

        This measures ~nothing on either shipped map, whose settlements are
        chains with no trunk to share. That is only a statement about the
        content if the mechanism is known to fire, which is what this pins.
        """
        size = 120
        h = flat(size, 100.0)
        p_off = rd.RoadParams(plan_step=1, mask_k=2, max_bridge_cells=0,
                              road_discount=1.0)
        p_on = rd.RoadParams(plan_step=1, mask_k=2, max_bridge_cells=0,
                             road_discount=0.15)
        # hub at the left, two destinations far right and well apart: the
        # cheapest independent routes are two separate diagonals
        sites = [(80.0, 480.0), (840.0, 160.0), (840.0, 800.0)]

        def shared_cells(p):
            lines = rd.plan_roads(h, -1.0, CELL, sites, p)
            self.assertGreaterEqual(len(lines), 2)
            sets = [set(map(tuple, np.round(l / CELL).astype(int))) for l in lines]
            return len(sets[0] & sets[1])

        off, on = shared_cells(p_off), shared_cells(p_on)
        self.assertGreater(on, off * 2,
                           f"reuse did not merge the branches (off={off} on={on})")
        self.assertGreater(on, 10)


class Contract(unittest.TestCase):
    def test_plan_roads_is_deterministic(self):
        h = rolling(80)
        p = rd.RoadParams(plan_step=2, mask_k=4)
        sites = [(120.0, 120.0), (500.0, 180.0), (300.0, 560.0)]
        a = rd.plan_roads(h, 300.0, CELL, sites, p)
        b = rd.plan_roads(h, 300.0, CELL, sites, p)
        self.assertEqual(len(a), 2, "the fixture must actually route somewhere")
        self.assertEqual(len(a), len(b))
        for x, y in zip(a, b):
            np.testing.assert_array_equal(x, y)

    def test_bigger_mask_never_costs_more(self):
        """A larger mask is a superset of headings, so the optimum cannot rise."""
        from scipy.sparse.csgraph import dijkstra
        h = rolling(80)
        costs = []
        for k in (1, 2, 4):
            p = rd.RoadParams(plan_step=2, mask_k=k, max_bridge_cells=0)
            hh, water, slope = rd._plan_grid(h, 300.0, CELL, p)
            H, W = hh.shape
            g = rd._edge_costs(hh, water, slope, CELL, p)
            d = dijkstra(g, indices=[0])[0][H * W - 1]
            costs.append(d)
        self.assertTrue(np.isfinite(costs[0]), "the fixture is impassable, not cheap")
        for a, b in zip(costs[:-1], costs[1:]):
            self.assertLessEqual(b, a + 1e-9, f"{costs}")
        self.assertLess(costs[-1], costs[0], "a k=4 mask bought nothing at all")

    def test_each_exponent_steepens_its_own_penalty(self):
        h = rolling(40)                     # slopes straddle sidehill_ref_deg
        for key, ref in (("sidehill_exp", "sidehill_ref_deg"),
                         ("grade_exp", "grade_ref_deg")):
            p2 = rd.RoadParams(plan_step=1, mask_k=1, max_bridge_cells=0,
                               **{key: 2.0})
            p25 = rd.RoadParams(plan_step=1, mask_k=1, max_bridge_cells=0,
                                **{key: 2.5})
            hh, water, slope = rd._plan_grid(h, -1.0, CELL, p2)
            self.assertLess(slope.min(), getattr(p2, ref))
            self.assertGreater(slope.max(), getattr(p2, ref))
            a = rd._edge_costs(hh, water, slope, CELL, p2)
            b = rd._edge_costs(hh, water, slope, CELL, p25)
            self.assertEqual(a.nnz, b.nnz,
                             f"{key} must not change what is passable")
            # above the reference the steeper exponent costs more, below less:
            # 2.5 is a contrast knob, not a global multiplier
            self.assertGreater(b.data.max(), a.data.max(), key)
            self.assertLess(b.data.min(), a.data.min(), key)


if __name__ == "__main__":
    unittest.main()
