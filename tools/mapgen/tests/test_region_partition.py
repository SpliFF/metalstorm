#!/usr/bin/env python3
"""The region partition is per (rectangle, component) — M-track M9k.

    .venv/bin/python -m unittest tests.test_region_partition

M9j's FIND: `build_regions` partitioned the map into a 4x4 grid and emitted an
edge wherever two cells shared a passable border in the same component. Each
edge was locally sound and the graph was globally wrong — one rectangle spans
several components, so A-B (over component 5) chained to B-C (over component 9)
read as a route from A to C across an armour split. Measured population before
the fix: 15 start pairs on sundered_arc, 16 on meridian_basin, 28 of 28 on each
8-island map. On every archipelago we ship, the graph the strategic AI drives
claimed every start reached every other.

What is pinned here:

1. **A region belongs to one component, and an edge never leaves it** — so a
   walk cannot cross a split, by construction rather than by measurement.
2. **A rectangle holding two real components is subdivided**, and a start in
   the minority pocket gets a region of its OWN component (attributing it to
   the dominant one is how the false claim was reachable in the first place).
3. **Leaves stay a disjoint cover.** `regions/partition.lua` resolves a point
   by first-declared-wins over bounding-box candidates, so two regions sharing
   ground would make `at(x, z)` a coin toss.
4. **Keys stay unique.** `name_for` draws from a 30x24 vocabulary and the split
   raises a 16-rectangle map to ~110 regions, so collisions are now the norm —
   and `validateGraph` rejects the WHOLE graph on a duplicate key, which drops
   the sim silently back to the 2048-elmo grid provider.
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import regions_from_map as rfm                           # noqa: E402
from terragen import reachability as reach               # noqa: E402

E = rfm.ELMOS_PER_SQUARE

# The real floors are sized for 2049-sample maps (a region below ~1024 elmos a
# side is not ground an army manoeuvres in). A 128-sample fixture would never
# subdivide under them, so the tests scale the floors down rather than scaling
# the fixture up — the behaviour under test is the rule, not the threshold.
SMALL = dict(MIN_REGION_SAMPLES=8, MIN_SPLIT_COMP_SAMPLES=64)


def _walled_map(W=128, wall=(40, 48)):
    """A fully passable square cut by one impassable north-south wall.

    The wall sits INSIDE base cell 1 (x 32..64 of a 4x4 grid), which is the
    exact geometry of the defect: one rectangle, two components.
    """
    hs = [0.0] * (W * W)
    ok = bytearray(W * W)
    for z in range(W):
        for x in range(W):
            if not (wall[0] <= x < wall[1]):
                ok[z * W + x] = 1
    comp, _sizes = rfm.components(ok, W, W)
    return hs, ok, comp, W


def _build(hs, ok, comp, W, starts, target=20, seed=7):
    return rfm.build_regions(hs, ok, comp, W, W, target, starts, seed)


class ARegionBelongsToOneComponent(unittest.TestCase):
    def setUp(self):
        self.hs, self.ok, self.comp, self.W = _walled_map()
        self.starts = [(10 * E, 10 * E), (100 * E, 10 * E),
                       (10 * E, 100 * E), (100 * E, 100 * E)]

    def _regions(self):
        with mock.patch.multiple(rfm, **SMALL):
            return _build(self.hs, self.ok, self.comp, self.W, self.starts)

    def test_no_edge_joins_two_components(self):
        regions, *_ = self._regions()
        by_key = {r["key"]: r for r in regions}
        for r in regions:
            for n in r["neighbors"]:
                self.assertEqual(r["_c"]["comp"], by_key[n]["_c"]["comp"],
                                 f"{r['key']} -> {n} crosses a component")

    def test_a_walk_cannot_leave_its_component(self):
        """The structural form of the claim `verify_graph` used to only count."""
        regions, *_ = self._regions()
        by_key = {r["key"]: r for r in regions}
        for r in regions:
            seen, stack = {r["key"]}, [r["key"]]
            while stack:
                for n in by_key[stack.pop()]["neighbors"]:
                    if n not in seen:
                        seen.add(n)
                        stack.append(n)
            comps = {by_key[k]["_c"]["comp"] for k in seen}
            self.assertEqual(len(comps), 1, f"{r['key']} reaches {comps}")

    def test_the_verifier_agrees_with_the_mask_on_every_start_pair(self):
        regions, _cols, _rows, cw, ch = self._regions()
        passed, msg, ids = rfm.verify_starts(
            self.ok, self.comp, self.W, self.W, self.starts, reach.SPLIT)
        self.assertTrue(passed, msg)
        gpassed, gmsg, crossed = rfm.verify_graph(
            regions, ids, self.starts, cw, ch, reach.SPLIT)
        self.assertTrue(gpassed, gmsg)
        self.assertEqual(crossed, 0, gmsg)

    def test_same_component_starts_are_still_connected(self):
        """The other side of the gate: dropping a real route is still a FAIL."""
        starts = [(10 * E, 10 * E), (10 * E, 100 * E)]
        with mock.patch.multiple(rfm, **SMALL):
            regions, _cols, _rows, cw, ch = _build(
                self.hs, self.ok, self.comp, self.W, starts)
        passed, msg, ids = rfm.verify_starts(
            self.ok, self.comp, self.W, self.W, starts, reach.CONNECTED)
        self.assertTrue(passed, msg)
        gpassed, gmsg, _crossed = rfm.verify_graph(
            regions, ids, starts, cw, ch, reach.CONNECTED)
        self.assertTrue(gpassed, gmsg)


class ARectangleHoldingTwoComponentsIsSubdivided(unittest.TestCase):
    def setUp(self):
        self.hs, self.ok, self.comp, self.W = _walled_map()
        self.starts = [(10 * E, 10 * E), (100 * E, 10 * E)]

    def test_the_split_rectangle_becomes_regions_of_one_component_each(self):
        with mock.patch.multiple(rfm, **SMALL):
            regions, *_ = _build(self.hs, self.ok, self.comp,
                                 self.W, self.starts)
        # base cell 1 spans x 32..64 and both components; every region inside
        # it must now be narrower than the rectangle it came from.
        inside = [r for r in regions
                  if r["_c"]["x0"] >= 32 and r["_c"]["x1"] <= 64]
        self.assertTrue(inside)
        self.assertTrue(all(r["_c"]["x1"] - r["_c"]["x0"] < 32 for r in inside),
                        [(r["key"], r["_c"]["x0"], r["_c"]["x1"]) for r in inside])
        self.assertEqual(len({r["_c"]["comp"] for r in inside}), 2)

    def test_a_start_lands_in_a_region_of_its_own_component(self):
        """The step the false claim was reachable through.

        A start in a minority pocket used to be attributed to the rectangle's
        dominant component — after which the graph honestly reported it as
        connected to ground it cannot drive to.
        """
        with mock.patch.multiple(rfm, **SMALL):
            regions, *_ = _build(self.hs, self.ok, self.comp,
                                 self.W, self.starts)
        for sx, sz in self.starts:
            home = rfm.region_at(regions, sx, sz)
            self.assertIsNotNone(home, (sx, sz))
            want = rfm._nearest_passable_component(
                self.ok, self.comp, self.W, self.W, sx, sz)
            self.assertEqual(home["_c"]["comp"], want, home["key"])
            self.assertIn("home", home["tags"])

    def test_an_unsplit_map_keeps_the_plain_grid(self):
        hs = [0.0] * (64 * 64)
        ok = bytearray(b"\x01" * (64 * 64))
        comp, _ = rfm.components(ok, 64, 64)
        with mock.patch.multiple(rfm, **SMALL):
            regions, cols, rows, _cw, _ch = rfm.build_regions(
                hs, ok, comp, 64, 64, 20, [(8 * E, 8 * E)], 3)
        self.assertEqual(len(regions), cols * rows)
        impure, orphan, notable, _total = rfm.partition_purity(regions)
        self.assertEqual((impure, orphan, notable), (0, 0, 0))


class ThePartitionIsAWellFormedCover(unittest.TestCase):
    def setUp(self):
        self.hs, self.ok, self.comp, self.W = _walled_map()
        self.starts = [(10 * E, 10 * E), (100 * E, 10 * E)]
        with mock.patch.multiple(rfm, **SMALL):
            self.regions, *_ = _build(self.hs, self.ok, self.comp,
                                      self.W, self.starts)

    def test_no_two_regions_overlap(self):
        rects = [r["_c"] for r in self.regions]
        for i, a in enumerate(rects):
            for b in rects[i + 1:]:
                overlap = (a["x0"] < b["x1"] and b["x0"] < a["x1"] and
                           a["z0"] < b["z1"] and b["z0"] < a["z1"])
                self.assertFalse(overlap, (a["x0"], a["z0"], b["x0"], b["z0"]))

    def test_keys_are_unique(self):
        keys = [r["key"] for r in self.regions]
        self.assertEqual(len(keys), len(set(keys)))

    def test_keys_stay_unique_when_the_vocabulary_runs_out(self):
        """~110 regions against a name vocabulary that collides constantly.

        The suffixing loop this pins used to read `seen[new_key]` right after
        renaming, which raised KeyError on the second collision — reached the
        moment the component split raised the region count, and never before.
        """
        with mock.patch.object(rfm, "name_for",
                               side_effect=lambda i, s: ("ash_row", "Ash Row")):
            with mock.patch.multiple(rfm, **SMALL):
                regions, *_ = _build(self.hs, self.ok, self.comp,
                                     self.W, self.starts)
        keys = [r["key"] for r in regions]
        self.assertGreater(len(keys), 8)
        self.assertEqual(len(keys), len(set(keys)))
        self.assertEqual(keys[0], "ash_row")
        self.assertEqual(keys[1], "ash_row_2")

    def test_every_polygon_is_inside_the_map(self):
        mw, mh = rfm.map_extent(self.W, self.W)
        doc = rfm.to_json(self.regions, self.W, self.W, 1.0, 1.0)
        for r in doc["regions"]:
            for pt in r["polygon"]:
                self.assertTrue(0 <= pt["x"] <= mw and 0 <= pt["z"] <= mh, pt)

    def test_neighbors_are_symmetric(self):
        by_key = {r["key"]: r for r in self.regions}
        for r in self.regions:
            for n in r["neighbors"]:
                self.assertIn(r["key"], by_key[n]["neighbors"])


if __name__ == "__main__":
    unittest.main()
