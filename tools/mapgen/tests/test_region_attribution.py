#!/usr/bin/env python3
"""A region's polygon is its own component's ground — M-track M9m.

    .venv/bin/python -m unittest tests.test_region_attribution

M9k made EDGES component-safe and M9l shipped the graph on every generated
map, and the lie that survived both was ATTRIBUTION: a region's polygon was
its leaf RECTANGLE, and on an archipelago a rectangle spans several islands.
Measured on the shipped maps, ~50 % of all passable ground (28 % on
`sundered_arc`) sat inside a region whose component it could not drive out of —
so a unit standing there read as being in a region whose neighbours it cannot
reach, and an order to one of them paths to the shore and stops.

The polygon is now the leaf's own-component footprint, rasterised on a
32-elmo lattice. What is pinned here:

1. **Ground of another component is not inside the polygon.** The whole point:
   what the region claims, its component owns.
2. **Ground no region claims resolves to nothing** — `region_at` returns None,
   the sim's "wilds". A gap is the honest answer; a wrong region is not.
3. **The polygon is a simple ring** — one piece, no hole, no repeated vertex,
   inside the map. `validateGraph` (Lua) and `MapProcessor` (C++) reject a
   self-touching polygon by rejecting the WHOLE graph, which drops the sim
   back to the 2048-elmo grid provider silently.
4. **The region publishes a real centre.** `game_regions.lua` used to derive
   the locate-ping from the polygon's vertex average; the vertex average of a
   coastline is wherever its vertices are dense, which is routinely outside
   the region. The emitter ships a `centre` that is inside the polygon and on
   the region's own passable ground, and the readers (the gadget, and
   `scenariogen.region_centre`, which has to agree with it) prefer it.
5. **A start with no region is a FAIL**, not a silently-wilds army.
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import regions_from_map as rfm                           # noqa: E402
import scenariogen as sg                                 # noqa: E402

E = rfm.ELMOS_PER_SQUARE

# One base cell of the 4x4 grid is 32 samples across, so the floors have to be
# scaled down for a 128-sample fixture exactly as test_region_partition does.
# MIN_REGION_SAMPLES is deliberately LARGE here: it stops the quadtree from
# splitting the pocket out into its own leaf, which is what makes the fixture
# the defect (one leaf, two components) rather than a map that partitions its
# way out of it.
NO_SPLIT = dict(MIN_REGION_SAMPLES=64, MIN_SPLIT_COMP_SAMPLES=4096)

POCKET = 12             # samples: the cut-off corner, [0, POCKET) both axes
MOAT = 4                # samples of impassable ground cutting it off


def _moated_map(W=128):
    """A fully passable map whose top-left corner is cut off by an L of cliff.

    The corner is a second connected component: passable ground the rest of
    the map cannot reach. It sits inside the first 32-sample base cell, so the
    leaf covering it has a dominant component (everything else) and a minority
    one (the corner) — the geometry the clip exists for.

    Cut off at the CORNER rather than moated in the middle on purpose. A
    pocket entirely surrounded by the region's own ground reads as a hole in
    that region's footprint, and a hole cannot be expressed in a single vertex
    ring: it is filled, and its ground stays attributed to the region. That
    residual is measured and reported (0.4-0.9 % of claimed ground on the
    shipped maps, against 28-50 % before the clip) — the shape it cannot fix
    is a lake island, and an archipelago's orphan ground is not that shape.
    """
    hs = [0.0] * (W * W)
    ok = bytearray(b"\x01" * (W * W))
    for z in range(POCKET + MOAT):
        for x in range(POCKET + MOAT):
            if x >= POCKET or z >= POCKET:
                ok[z * W + x] = 0
    comp, _sizes = rfm.components(ok, W, W)
    return hs, ok, comp, W


def _in_pocket():
    mid = POCKET // 2
    return mid * E, mid * E


class APolygonHoldsOnlyItsOwnComponent(unittest.TestCase):
    def setUp(self):
        self.hs, self.ok, self.comp, self.W = _moated_map()
        self.starts = [(60 * E, 60 * E), (100 * E, 100 * E)]
        with mock.patch.multiple(rfm, **NO_SPLIT):
            self.regions, _c, _r, self.cw, self.ch = rfm.build_regions(
                self.hs, self.ok, self.comp, self.W, self.W, 20, self.starts, 3)

    def _pocket_leaf(self):
        """The region whose RECTANGLE covers the pocket — the defect's subject."""
        px, pz = _in_pocket()
        for r in self.regions:
            c = r["_c"]
            if (c["x0"] <= px / E < c["x1"]) and (c["z0"] <= pz / E < c["z1"]):
                return r
        return None

    def test_the_fixture_really_is_one_leaf_holding_two_components(self):
        """Negative control: without this the clip would have nothing to remove."""
        leaf = self._pocket_leaf()
        self.assertIsNotNone(leaf, "no leaf covers the pocket")
        hist = leaf["_c"]["comp_hist"]
        self.assertGreater(len(hist), 1, "fixture leaf holds one component only")
        px, pz = _in_pocket()
        pocket_comp = self.comp[int(pz / E) * self.W + int(px / E)]
        self.assertNotEqual(leaf["_c"]["comp"], pocket_comp)

    def test_pocket_ground_is_inside_no_polygon(self):
        px, pz = _in_pocket()
        self.assertIsNone(rfm.region_at(self.regions, px, pz),
                          "ground of another component is still claimed")

    def test_own_ground_keeps_its_region(self):
        """The other half of the trade: the clip must not empty the map."""
        leaf = self._pocket_leaf()
        c = leaf["_c"]
        found = 0
        for z in range(c["z0"], c["z1"]):
            for x in range(c["x0"], c["x1"]):
                if self.comp[z * self.W + x] != c["comp"]:
                    continue
                if rfm.region_at(self.regions, x * E, z * E) is leaf:
                    found += 1
        own = c["comp_hist"][c["comp"]]
        self.assertGreater(found, 0.9 * own,
                           f"clip kept only {found} of {own} own samples")

    def test_every_polygon_is_a_simple_in_bounds_ring(self):
        mw, mh = rfm.map_extent(self.W, self.W)
        for r in self.regions:
            poly = r["_c"]["_poly"]
            with self.subTest(region=r["key"]):
                self.assertGreaterEqual(len(poly), 4)
                self.assertEqual(len(poly), len(set(poly)), "repeated vertex")
                for x, z in poly:
                    self.assertTrue(0 <= x <= mw and 0 <= z <= mh, "out of bounds")
                self.assertFalse(_self_intersecting(poly), "self-intersecting")

    def test_polygons_do_not_overlap(self):
        """Two regions claiming one point makes `at(x, z)` a coin toss."""
        for x in range(0, self.W, 3):
            for z in range(0, self.W, 3):
                hits = [r["key"] for r in self.regions
                        if rfm.point_in_polygon(x * E, z * E, r["_c"]["_poly"])]
                self.assertLessEqual(len(hits), 1, f"{x},{z} claimed by {hits}")

    def test_the_centre_is_inside_and_on_the_regions_own_ground(self):
        for r in self.regions:
            c = r["_c"]
            cx, cz = c["_centre"]
            with self.subTest(region=r["key"]):
                self.assertTrue(rfm.point_in_polygon(cx, cz, c["_poly"]),
                                "centre outside its own polygon")
                i = int(cz / E) * self.W + int(cx / E)
                self.assertTrue(self.ok[i], "centre on impassable ground")
                self.assertEqual(self.comp[i], c["comp"],
                                 "centre on another component's ground")

    def test_the_emitters_ship_the_centre_and_scenariogen_reads_it_back(self):
        lua = rfm.to_lua(self.regions, self.W, self.W)
        doc = rfm.to_json(self.regions, self.W, self.W, self.cw, self.ch)
        with mock.patch.object(os.path, "exists", return_value=True), \
                mock.patch("builtins.open", mock.mock_open(read_data=lua)):
            parsed = sg.read_region_graph("/nonexistent")
        self.assertEqual(len(parsed), len(self.regions))
        for got, want, rj in zip(parsed, self.regions, doc["regions"]):
            with self.subTest(region=want["key"]):
                self.assertEqual(got["key"], want["key"])
                self.assertEqual(len(got["polygon"]), len(want["_c"]["_poly"]))
                self.assertEqual(sg.region_centre(got), want["_c"]["_centre"])
                self.assertEqual((rj["centre"]["x"], rj["centre"]["z"]),
                                 tuple(float(v) for v in want["_c"]["_centre"]))

    def test_a_start_outside_every_polygon_fails_the_graph_check(self):
        starts = [_in_pocket(), (100 * E, 100 * E)]
        with mock.patch.multiple(rfm, **NO_SPLIT):
            regions, _c, _r, cw, ch = rfm.build_regions(
                self.hs, self.ok, self.comp, self.W, self.W, 20, starts, 3)
        _passed, _msg, ids = rfm.verify_starts(
            self.ok, self.comp, self.W, self.W, starts)
        gpassed, gmsg, _crossed = rfm.verify_graph(regions, ids, starts, cw, ch)
        self.assertFalse(gpassed, gmsg)
        self.assertIn("wilds", gmsg)


def _self_intersecting(poly):
    """The check `regions/partition.lua` and `MapProcessor.cpp` both run."""
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    def crosses(p1, p2, p3, p4):
        d1, d2 = cross(p3, p4, p1), cross(p3, p4, p2)
        d3, d4 = cross(p1, p2, p3), cross(p1, p2, p4)
        return (((d1 > 0 and d2 < 0) or (d1 < 0 and d2 > 0)) and
                ((d3 > 0 and d4 < 0) or (d3 < 0 and d4 > 0)))

    n = len(poly)
    if n < 3:
        return True
    for i in range(n):
        a1, a2 = poly[i], poly[(i + 1) % n]
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue
            if crosses(a1, a2, poly[j], poly[(j + 1) % n]):
                return True
    return False


if __name__ == "__main__":
    unittest.main()
