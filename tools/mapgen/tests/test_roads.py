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
  * **the reuse discount actually merges branches.** It measures ~nothing on
    either shipped map (their settlements are chains, so there is no trunk to
    share). That is a content fact, and it is only a *content* fact if the
    mechanism is known to work — `test_road_discount_merges_branches` uses a Y
    of three sites on flat ground, where reuse must produce a shared trunk, and
    checks the same fixture does not share it with the discount off.

Every metric carries a positive control: a deliberately-wrong construction that
the same assertion must reject. A guard nobody has watched fail is not a guard.
"""

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


def eight_connected_reference(h, water, slope, p):
    """The cost graph exactly as it was written before segment masks."""
    H, W = h.shape
    n = H * W
    idx = np.arange(n).reshape(H, W)
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
        w = water[sr0:sr1, sc0:sc1].ravel() | water[r0:r1, c0:c1].ravel()
        cost = length * (1.0 + p.slope_cost * (s / p.slope_ref_deg) ** 2)
        cost = np.where(w, length * p.water_penalty, cost)
        cost = np.where(s > p.max_slope_deg, np.inf, cost)
        cost = np.where(w & (s > p.max_slope_deg), length * p.water_penalty, cost)
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
        h = ridged(64)
        p = rd.RoadParams(plan_step=2, mask_k=1, max_bridge_cells=0)
        hh, water, slope = rd._plan_grid(h, 300.0, CELL, p)
        want = eight_connected_reference(hh, water, slope, p)
        got = rd._edge_costs(hh, water, slope, CELL, p)
        self.assertEqual(want.nnz, got.nnz)
        self.assertTrue(np.array_equal(want.indptr, got.indptr))
        self.assertTrue(np.array_equal(want.indices, got.indices))
        np.testing.assert_array_equal(want.data, got.data)
        # and the graph is not trivially everything-or-nothing
        self.assertGreater(want.nnz, 0)
        self.assertLess(want.nnz, 8 * hh.size)

    def test_long_edges_cannot_cross_a_wall(self):
        """A one-cell ridge is invisible to an endpoint-only cost rule."""
        size = 48
        h = flat(size, 100.0)
        h[:, size // 2] = 4000.0          # a single impassable column
        p = rd.RoadParams(plan_step=1, mask_k=4, max_slope_deg=28.0,
                          max_bridge_cells=0)
        hh, water, slope = rd._plan_grid(h, -1.0, CELL, p)
        H, W = hh.shape
        g = rd._edge_costs(hh, water, slope, CELL, p).tocoo()
        crossings = ((g.row % W < W // 2 - 1) & (g.col % W > W // 2 + 1)).sum()
        self.assertEqual(crossings, 0, "a mask edge stepped over the wall")

        # positive control: cost the same mask on endpoints only and it leaks
        leaked = 0
        for dr, dc in rd.mask_offsets(4):
            for r in range(H):
                for c in range(W):
                    r2, c2 = r + dr, c + dc
                    if not (0 <= r2 < H and 0 <= c2 < W):
                        continue
                    s = max(slope[r, c], slope[r2, c2])
                    if s <= p.max_slope_deg and c < W // 2 - 1 and c2 > W // 2 + 1:
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

    def test_slope_exponent_steepens_the_penalty(self):
        p2 = rd.RoadParams(plan_step=1, mask_k=1, slope_exp=2.0, max_bridge_cells=0)
        p25 = rd.RoadParams(plan_step=1, mask_k=1, slope_exp=2.5, max_bridge_cells=0)
        h = rolling(40)                     # slopes straddle slope_ref_deg
        hh, water, slope = rd._plan_grid(h, -1.0, CELL, p2)
        self.assertLess(slope.min(), p2.slope_ref_deg)
        self.assertGreater(slope.max(), p2.slope_ref_deg)
        a = rd._edge_costs(hh, water, slope, CELL, p2)
        b = rd._edge_costs(hh, water, slope, CELL, p25)
        self.assertEqual(a.nnz, b.nnz, "the exponent must not change what is passable")
        # above the reference slope the steeper exponent costs more, below less:
        # 2.5 is a contrast knob, not a global multiplier
        self.assertGreater(b.data.max(), a.data.max())
        self.assertLess(b.data.min(), a.data.min())


if __name__ == "__main__":
    unittest.main()
