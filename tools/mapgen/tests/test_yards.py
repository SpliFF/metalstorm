#!/usr/bin/env python3
"""Tests for yard PADS — prepared ground beside a road (roads R4b).

    cd tools/mapgen && .venv/bin/python -m unittest tests.test_yards

R4 stood a depot on a road; R4b prepares the ground under it, which is the half
a scenario-time placer structurally cannot do (terragen/yards.py's header). What
each test is here for:

  * **the pad publishes ONE axis and it is the away normal.** A tangent leaves
    the side of the road ambiguous, and a yard on the wrong side of its own road
    is R4's finding 1 (`_yard_anchor`'s sign) reappearing across a file boundary
    — where no measurement in either file would catch it. So the heading is
    round-tripped through the real emitter and the real reader, on BOTH sides of
    the road, because a sign error reads as correct on one side.
  * **a pad is never on the carriageway.** Same acceptance rule as R4 and the
    same reason: a building blocks, so a yard on the deck severs the route the
    road exists to provide, silently. Asserted as a positive AND a negative,
    since a check that refuses everything passes the negative alone.
  * **the carve is what earns the tarmac.** A pad is ordinary deck so that the
    flatten grades it and the bake surfaces it; if the carve does not reach the
    mask, the pad is a published rectangle of grass and every other test here
    still passes.
  * **a pad takes the surface of the road it serves.** The class window has to
    REACH the carriageway: a pad is off the deck by construction, so
    `carve_plaza_classes`' "commonest class inside" rule would hand every pad on
    every map the dirt fallback — a bitumen highway with a gravel service yard,
    everywhere, with nothing to report it.
  * **the default pad fits what the scenario layer actually asks for.** A pad
    too small for everything on `ROAD_FRONTAGE` is tarmac nothing can use, and
    it would show up as "the placer ignored the pads" rather than as a size bug.
  * **a map with no pads is an ordinary map**, and every shipped map is in that
    state until the packages are regenerated.
"""
import os
import sys
import tempfile
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MAPGEN = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(MAPGEN, "..", ".."))
sys.path.insert(0, MAPGEN)
sys.path.insert(0, HERE)

import ms_defs                                     # noqa: E402
import road_frontage as rf                         # noqa: E402
import scenariogen as sg                           # noqa: E402
import town_stager as tstage                       # noqa: E402
from scenario_templates import ROAD_FRONTAGE       # noqa: E402
from terragen import package as pkg                # noqa: E402
from terragen import roads as rd                   # noqa: E402
from terragen import yards as yd                   # noqa: E402
from test_scenariogen import WIDE_ELMOS, wide_flat_map   # noqa: E402

GAME_DIR = os.path.join(REPO, "data", "games", "metalstorm")

CELL = 16.0
RP = rd.RoadParams(road_width=44.0)


def flat_net(elmos: float = 3200.0, height: float = 60.0):
    """A flat map with one straight highway and one diagonal road on it.

    Straight AND diagonal on purpose: every pad frame in this module is built
    from a tangent, and an axis-aligned road is the one case where a wrong frame
    still lands the pad in the right place.
    """
    n = int(elmos / CELL)
    h = np.full((n, n), height)
    hw = np.array([[200.0, elmos / 2.0], [elmos - 200.0, elmos / 2.0]])
    road = np.array([[300.0, 400.0], [elmos - 600.0, 900.0]])
    net = rd.RoadNetwork(links=[rd.RoadLink(hw, rd.ROAD_HIGHWAY, 0, 1),
                                rd.RoadLink(road, rd.ROAD_ROAD, 2, 3)],
                         junctions=[])
    raster = rd.rasterize_network(net, h.shape, CELL, RP)
    return h, net, raster


class PlannedPads(unittest.TestCase):
    def setUp(self):
        self.h, self.net, self.raster = flat_net()
        self.pads, self.refusals = yd.plan_yard_pads(
            self.net, self.h, self.raster, CELL, 0.0, road_params=RP)

    def test_a_flat_map_with_roads_carries_pads(self):
        self.assertTrue(self.pads, f"no pad planned; {len(self.refusals)} refused")
        self.assertLessEqual(len(self.pads), yd.YardParams().max_pads)

    def test_no_pad_covers_the_carriageway(self):
        """The acceptance rule, on a fixture that can actually violate it.

        **The first version of this test was INERT and passed with the deck check
        removed.** A pad is offset from its own link by half a width plus the
        setback plus its own depth, so it can never reach the deck it was planned
        against — the only way a pad lands on a carriageway is by landing on a
        DIFFERENT link's, or on a junction apron. So the fixture here is a
        CROSSING: two roads meeting at right angles, where a pad stepped along one
        falls on the other. Deleting the deck test now produces pads on the deck,
        which is what makes the assertion mean anything.
        """
        elmos = 3200.0
        n = int(elmos / CELL)
        h = np.full((n, n), 60.0)
        ew = np.array([[200.0, 1600.0], [3000.0, 1600.0]])
        ns = np.array([[1600.0, 200.0], [1600.0, 3000.0]])
        net = rd.RoadNetwork(links=[rd.RoadLink(ew, rd.ROAD_HIGHWAY, 0, 1),
                                   rd.RoadLink(ns, rd.ROAD_HIGHWAY, 2, 3)],
                            junctions=[(1600.0, 1600.0)])
        raster = rd.rasterize_network(net, h.shape, CELL, RP)
        # A pitch that steps a station right beside the crossing, and no junction
        # keepout, so the deck test is the only rule left that can refuse it.
        p = yd.YardParams(pitch=340.0, junction_keepout=0.0, max_pads=40,
                          per_link=20)
        pads, refusals = yd.plan_yard_pads(net, h, raster, CELL, 0.0, params=p,
                                           road_params=RP)
        self.assertTrue(pads)
        self.assertTrue(any("carriageway" in r.reason for r in refusals),
                        "no candidate was ever refused for covering a road — "
                        "this fixture cannot exercise the rule it exists for")
        for pad in pads:
            rows, cols, u, v = yd._pad_window(pad, h.shape, CELL)
            inside = yd._sdf(u, v, pad.half_along, pad.half_away) <= 0.0
            self.assertFalse(raster.mask[rows, cols][inside].any(),
                             f"pad on link {pad.link} at ({pad.x:.0f}, "
                             f"{pad.z:.0f}) covers the deck")
        # ...and the positive control for the mask itself: a pad ON the crossing
        # must read as covering the deck, or the assertion above is vacuous for a
        # different reason.
        on_deck = yd.YardPad(link=0, road_class=rd.ROAD_HIGHWAY,
                             x=1600.0, z=1600.0, heading=0,
                             half_along=280.0, half_away=300.0)
        rows, cols, u, v = yd._pad_window(on_deck, h.shape, CELL)
        inside = yd._sdf(u, v, on_deck.half_along, on_deck.half_away) <= 0.0
        self.assertTrue(raster.mask[rows, cols][inside].any(),
                        "the deck test cannot see a pad standing on the road")

    def test_pads_appear_on_both_sides_of_a_road(self):
        """A planner that only ever uses one verge cannot show a sign error.

        Not a cosmetic preference: every other assertion about the away normal
        in this file is only as strong as the set of pads it has to test.
        """
        sides = set()
        for pad in self.pads:
            link = self.net.links[pad.link]
            a, b = link.polyline[0], link.polyline[-1]
            tx, tz = b[0] - a[0], b[1] - a[1]
            ax, az = pad.away
            sides.add(1 if (tx * az - tz * ax) > 0 else -1)
        self.assertEqual(sides, {1, -1},
                         f"every pad is on one side of its road: {sides}")

    def test_a_wet_pad_is_refused_by_name(self):
        """Freeboard is not an aesthetic rule — `package.py` zeroes the typemap
        under every submerged cell (roads R3: a ford is not a road), so a pad
        planned below the waterline would ship with tarmac in the albedo and NO
        terrain type under it: the one combination that looks right and drives
        wrong."""
        h, net, raster = flat_net(height=1.0)      # below freeboard everywhere
        pads, refusals = yd.plan_yard_pads(net, h, raster, CELL, 0.0,
                                           road_params=RP)
        self.assertEqual(pads, [], "a pad was planned in the water")
        self.assertTrue(any("wet" in r.reason for r in refusals), refusals)
        self.assertTrue(all(r.describe() for r in refusals))

    def test_a_cliff_is_refused_by_name(self):
        h, net, raster = flat_net()
        # A saw-tooth over the whole map: relief across any pad is far past the
        # limit, but nothing is under water and nothing is on the deck, so this
        # isolates the relief rule from the other two.
        zz = np.arange(h.shape[0])[:, None]
        h = h + (zz % 2) * 400.0
        pads, refusals = yd.plan_yard_pads(net, h, raster, CELL, 0.0,
                                           road_params=RP)
        self.assertEqual(pads, [], "a pad was planned on a saw-tooth")
        self.assertTrue(any("relief" in r.reason for r in refusals), refusals)

    def test_a_map_with_no_roads_plans_no_pads_and_does_not_raise(self):
        h = np.full((100, 100), 60.0)
        net = rd.RoadNetwork()
        raster = rd.rasterize_network(net, h.shape, CELL, RP)
        pads, refusals = yd.plan_yard_pads(net, h, raster, CELL, 0.0,
                                           road_params=RP)
        self.assertEqual((pads, refusals), ([], []))

    def test_the_frontage_class_filter_excludes_a_class(self):
        p = yd.YardParams(classes=(rd.ROAD_HIGHWAY,))
        pads, _r = yd.plan_yard_pads(self.net, self.h, self.raster, CELL, 0.0,
                                     params=p, road_params=RP)
        self.assertTrue(pads)
        self.assertEqual({pad.road_class for pad in pads}, {rd.ROAD_HIGHWAY})


class TheCarveIsWhatMakesItTarmac(unittest.TestCase):
    def test_a_carved_pad_is_deck(self):
        h, net, raster = flat_net()
        pads, _r = yd.plan_yard_pads(net, h, raster, CELL, 0.0, road_params=RP)
        before = int(raster.mask.sum())
        yd.carve_yard_pads(raster, pads, CELL, RP)
        after = int(raster.mask.sum())
        # Each pad is 4 * half_along * half_away of ground; allow the rounded
        # corners the SDF gives it.
        want = sum(4.0 * p.half_along * p.half_away for p in pads) / (CELL * CELL)
        self.assertGreater(after - before, 0.8 * want,
                           "the carve did not reach the mask")
        for pad in pads:
            rows, cols, u, v = yd._pad_window(pad, h.shape, CELL)
            core = yd._sdf(u, v, pad.half_along - 100.0, pad.half_away - 100.0)
            self.assertTrue(raster.mask[rows, cols][core <= 0.0].all(),
                            "the middle of a carved pad is not deck")
            self.assertLessEqual(
                float(raster.dist[rows, cols][core <= 0.0].max()),
                RP.road_width * 0.5,
                "a carved pad's own middle reads as off-deck")

    def test_the_road_grader_does_not_flatten_a_pad_but_the_plateau_does(self):
        """The finding that cost this milestone a second carve, pinned.

        `flatten_network` blends toward a BLUR, so on a uniform slope it is the
        identity — the blur of a ramp is the same ramp. A pad on a ramp therefore
        comes out of the grader as sloped as it went in, which is right for a road
        and wrong for a yard. Both halves are asserted here because the wrong half
        is what a reader assumes: dropping `level_yard_pads` leaves a published,
        correctly-sized, correctly-surfaced pad on a hillside, and nothing else in
        this file notices.
        """
        n = 200
        h = np.fromfunction(lambda r, c: 60.0 + c * 0.9, (n, n))
        elmos = n * CELL
        hw = np.array([[200.0, elmos / 2.0], [elmos - 200.0, elmos / 2.0]])
        net = rd.RoadNetwork(links=[rd.RoadLink(hw, rd.ROAD_HIGHWAY, 0, 1)])
        raster = rd.rasterize_network(net, h.shape, CELL, RP)
        pads, _r = yd.plan_yard_pads(net, h, raster, CELL, 0.0, road_params=RP)
        self.assertTrue(pads)
        rough = [yd.pad_relief(h, pad, CELL) for pad in pads]
        yd.carve_yard_pads(raster, pads, CELL, RP)
        graded = rd.flatten_network(h, raster, CELL, RP)
        for pad, r0 in zip(pads, rough):
            self.assertGreater(r0, 10.0, "the fixture slope is too gentle")
            self.assertGreater(yd.pad_relief(graded, pad, CELL), 0.8 * r0,
                               "the road grader flattened a pad — if it really "
                               "does, level_yard_pads is unnecessary and this "
                               "test is the wrong shape")
        levelled = yd.level_yard_pads(graded, pads, CELL)
        for pad, r0 in zip(pads, rough):
            r1 = yd.pad_relief(levelled, pad, CELL)
            self.assertLess(r1, 1.0,
                            f"the plateau left {r1:.2f} of {r0:.1f} elmos "
                            f"of relief on a pad")

    def test_the_plateau_touches_nothing_past_the_verge(self):
        """A yard is cut into the ground beside a road, not into the road.

        The fade is `setback` wide, which is the strip between the pad and the
        carriageway, so the deck keeps the delivered grade
        `report_delivered_grades` measured. A plateau that reached the deck would
        put a step in a road nothing here would ever look at again.
        """
        n = 200
        h = np.fromfunction(lambda r, c: 60.0 + c * 0.9, (n, n))
        elmos = n * CELL
        hw = np.array([[200.0, elmos / 2.0], [elmos - 200.0, elmos / 2.0]])
        net = rd.RoadNetwork(links=[rd.RoadLink(hw, rd.ROAD_HIGHWAY, 0, 1)])
        raster = rd.rasterize_network(net, h.shape, CELL, RP)
        pads, _r = yd.plan_yard_pads(net, h, raster, CELL, 0.0, road_params=RP)
        levelled = yd.level_yard_pads(h, pads, CELL)
        p = yd.YardParams()
        for pad in pads:
            far = yd._pad_window(
                yd.YardPad(**{**{k: getattr(pad, k) for k in
                                ("link", "road_class", "x", "z", "heading")},
                              "half_along": pad.half_along + p.setback + 4 * CELL,
                              "half_away": pad.half_away + p.setback + 4 * CELL}),
                h.shape, CELL)
            rows, cols, u, v = far
            outside = yd._sdf(u, v, pad.half_along + p.setback + 2 * CELL,
                              pad.half_away + p.setback + 2 * CELL) <= 0.0
            edge = outside & ~(yd._sdf(u, v, pad.half_along + p.setback,
                                       pad.half_away + p.setback) <= 0.0)
            self.assertTrue(edge.any())
            moved = np.abs(levelled[rows, cols][edge] - h[rows, cols][edge])
            self.assertLess(float(moved.max()), 1e-6,
                            "the plateau reached past the verge")

    def test_a_pad_takes_the_surface_of_the_road_it_serves(self):
        """The class window reaches the carriageway; sampling inside cannot.

        The negative is the whole test: `carve_plaza_classes`' rule applied to a
        pad reads "no class arrives" on every map, and its dirt fallback then
        looks like a deliberate choice rather than a window that never touched
        the road.
        """
        h, net, raster = flat_net()
        pads, _r = yd.plan_yard_pads(net, h, raster, CELL, 0.0, road_params=RP)
        pads = [p for p in pads if p.road_class == rd.ROAD_HIGHWAY]
        self.assertTrue(pads)
        surf = np.where(raster.mask, np.uint8(rd.SURF_BITUMEN),
                        np.uint8(rd.SURF_NONE)).astype(np.uint8)
        yd.carve_yard_pads(raster, pads, CELL, RP)
        yd.carve_yard_pad_classes(surf, pads, CELL, RP)
        for pad in pads:
            rows, cols, u, v = yd._pad_window(pad, h.shape, CELL)
            core = yd._sdf(u, v, pad.half_along - 100.0, pad.half_away - 100.0)
            got = set(np.unique(surf[rows, cols][core <= 0.0]).tolist())
            self.assertEqual(got, {rd.SURF_BITUMEN},
                             f"a highway's pad was surfaced {got}, not bitumen")

    def test_a_pad_reaches_the_baked_SPLAT_distribution(self):
        """The markings claim, asserted through the real bake rather than the
        raster it is derived from.

        Everything else in this class checks `road_class`, which is one step short
        of the thing the brief asks for: the driveway is only "marked" if the
        splat distribution hands the pad the aggregate detail layer. `bake.make_
        splat_distr` is the function that decides, and it decides off exactly the
        raster `carve_yard_pad_classes` writes — so this is the assertion that the
        two really are the same array and not two arrays that happen to agree.
        """
        from terragen import bake as bk
        from terragen import biomes as bio

        h, net, raster = flat_net()
        pads, _r = yd.plan_yard_pads(net, h, raster, CELL, 0.0, road_params=RP)
        pads = pads[:1]
        surf = np.where(raster.mask, np.uint8(rd.SURF_BITUMEN),
                        np.uint8(rd.SURF_NONE)).astype(np.uint8)
        yd.carve_yard_pads(raster, pads, CELL, RP)
        yd.carve_yard_pad_classes(surf, pads, CELL, RP)
        n = h.shape[0]
        biomes = np.full(h.shape, bio.GRASSLAND, dtype=np.uint8)
        slope = np.zeros(h.shape)
        size = 256
        distr = bk.make_splat_distr(biomes, slope, h, 0.0, size=size,
                                    road_class=surf)
        pad = pads[0]
        zoom = size / n
        r = int(pad.z / CELL * zoom)
        c = int(pad.x / CELL * zoom)
        weights = distr[r, c]
        self.assertEqual(int(np.argmax(weights)), 1,
                         f"the pad's splat weights are {weights.tolist()} — "
                         f"the rock/aggregate channel is not dominant, so the "
                         f"tarmac keeps the grass detail of the field")
        # ...and the control: a cell well away from any deck or pad keeps grass.
        far = distr[int(200 / CELL * zoom), int(200 / CELL * zoom)]
        self.assertEqual(int(np.argmax(far)), 0,
                         f"open grassland reads as aggregate too ({far.tolist()})"
                         f" — the assertion above proves nothing")

    def test_a_pad_carries_a_shoulder_blend(self):
        """`blend` is zero where no class claimed a cell, and the flatten fade is
        measured off it — a pad left at zero fades over 0 elmos and reads as a
        cut edge rather than as graded ground."""
        h, net, raster = flat_net()
        pads, _r = yd.plan_yard_pads(net, h, raster, CELL, 0.0, road_params=RP)
        yd.carve_yard_pads(raster, pads, CELL, RP)
        for pad in pads:
            rows, cols, u, v = yd._pad_window(pad, h.shape, CELL)
            core = yd._sdf(u, v, pad.half_along - 100.0, pad.half_away - 100.0)
            self.assertGreater(float(raster.blend[rows, cols][core <= 0.0].min()),
                               0.0, "a pad has no shoulder to fade over")


class ThePublishedPad(unittest.TestCase):
    """The emitter and the reader, which are the only two ends of the file."""

    def setUp(self):
        self.h, self.net, self.raster = flat_net()
        self.pads, _r = yd.plan_yard_pads(self.net, self.h, self.raster, CELL,
                                          0.0, road_params=RP)
        self.assertTrue(self.pads)
        self.text = pkg.emit_roads_lua(self.net, CELL, RP, crossings=[],
                                       yards=self.pads)

    def _read(self, text: str) -> list[dict]:
        with tempfile.TemporaryDirectory() as t:
            os.makedirs(os.path.join(t, "mapdata"))
            with open(os.path.join(t, "mapdata", "roads.lua"), "w") as f:
                f.write(text)
            return sg.read_road_yards(t)

    def test_every_pad_survives_the_round_trip(self):
        got = self._read(self.text)
        self.assertEqual(len(got), len(self.pads),
                         "the reader lost a pad the emitter wrote")
        for pad, row in zip(self.pads, got):
            self.assertEqual(row["road_class"], pad.road_class)
            self.assertEqual(row["heading"], pad.heading)
            self.assertEqual(row["link"], pad.link)
            self.assertAlmostEqual(row["x"], round(pad.x), places=0)
            self.assertAlmostEqual(row["z"], round(pad.z), places=0)
            self.assertEqual(row["half_along"], pad.half_along)
            self.assertEqual(row["half_away"], pad.half_away)

    def test_the_away_normal_survives_the_round_trip(self):
        """The one convention in the file, checked against the planner's frame.

        A quarter-turn error here is R3b's finding 3 and it is invisible from
        either side alone: the reader's answer is a perfectly good unit vector
        and the emitter's heading is a perfectly good integer.
        """
        for pad, row in zip(self.pads, self._read(self.text)):
            ax, az = rf._away_of(row)
            self.assertAlmostEqual(ax * pad.away[0] + az * pad.away[1], 1.0,
                                   places=3,
                                   msg="the reader's away normal is not the "
                                       "planner's")

    def test_neither_reader_reads_the_other_block(self):
        """Three lists of braced rows in one file, so the bound IS the contract.

        Asserted from both ends: the pads must not absorb the ford below them and
        the fords must not absorb the pads above them. A regex let loose over the
        whole file reads one kind of row as a malformed row of the other, and
        both readers would then be quietly wrong on every generated map.
        """
        from terragen import bridges as br
        crossing = br.Crossing(link=0, road_class=0, x=100.0, z=200.0,
                               heading=0, spans=4, length=96.0, width=90.0,
                               max_depth=3.0, bend_deg=1.0)
        text = pkg.emit_roads_lua(self.net, CELL, RP, crossings=[crossing],
                                  yards=self.pads)
        with tempfile.TemporaryDirectory() as t:
            os.makedirs(os.path.join(t, "mapdata"))
            with open(os.path.join(t, "mapdata", "roads.lua"), "w") as f:
                f.write(text)
            self.assertEqual(len(sg.read_road_yards(t)), len(self.pads))
            fords = sg.read_road_crossings(t)
            self.assertEqual(len(fords), 1)
            self.assertEqual(fords[0]["spans"], 4)
            self.assertEqual(len(sg.read_road_links(t)), len(self.net.links))

    def test_the_key_is_always_emitted_so_absent_and_empty_differ(self):
        text = pkg.emit_roads_lua(self.net, CELL, RP, crossings=[], yards=[])
        self.assertIn("yards = {", text)
        self.assertEqual(self._read(text), [])

    def test_a_file_from_before_r4b_reads_as_no_pads(self):
        """Every shipped map is in this state until the packages are regenerated."""
        text = "\n".join(["return {", "    links = {", "    },",
                          "    junctions = {", "    },",
                          "    crossings = {", "    },", "}"])
        self.assertEqual(self._read(text), [])

    def test_a_map_with_no_roads_file_reads_as_no_pads(self):
        with tempfile.TemporaryDirectory() as t:
            os.makedirs(os.path.join(t, "mapdata"))
            self.assertEqual(sg.read_road_yards(t), [])


class TheParcelBuiltOnAPad(unittest.TestCase):
    """`road_frontage.parcels_from_pads` — the consumer, measured."""

    def setUp(self):
        self.facts = ms_defs.load(GAME_DIR)
        self.h, self.net, self.raster = flat_net()
        pads, _r = yd.plan_yard_pads(self.net, self.h, self.raster, CELL, 0.0,
                                     road_params=RP)
        text = pkg.emit_roads_lua(self.net, CELL, RP, crossings=[], yards=pads)
        with tempfile.TemporaryDirectory() as t:
            os.makedirs(os.path.join(t, "mapdata"))
            with open(os.path.join(t, "mapdata", "roads.lua"), "w") as f:
                f.write(text)
            self.rows = sg.read_road_yards(t)
            self.links = sg.read_road_links(t)
        self.assertTrue(self.rows and self.links)

    def test_the_lot_frame_is_the_pads_frame(self):
        spec = dict(ROAD_FRONTAGE[0])
        got = rf.parcels_from_pads(self.rows, spec, self.facts)
        self.assertTrue(got, "no published pad fits the depot")
        for pad, lot in got:
            _along, away = tstage._lot_frame(lot)
            ax, az = rf._away_of(pad)
            self.assertAlmostEqual(away[0] * ax + away[1] * az, 1.0, places=3,
                                   msg="the parcel faces a different way from "
                                       "the pad it was built on")

    def test_the_yard_is_between_the_road_and_the_shed_on_a_pad(self):
        """R4's finding 1 again, on the R4b path, and on BOTH sides of the road.

        A pad-built parcel goes through a different constructor from
        `carve_parcels`, so the sign it inherits is a separate fact — and this is
        the assertion that separates a depot fronting its road from one facing
        away with its yard behind it.

        Measured against the PUBLISHED POLYLINE, not in the parcel's own axis.
        Flipping the away normal flips the parcel's frame with it, so every
        parcel-local reading stays self-consistent and only a distance to the real
        road can tell the two apart — the same reason R4 pinned its anchor on both
        sides of the carriageway rather than on the lot.
        """
        import town_planner as tp
        spec = dict(ROAD_FRONTAGE[0])
        f = self.facts[spec["def"]]
        got = rf.parcels_from_pads(self.rows, spec, self.facts)
        self.assertTrue(got)
        seen = set()
        for pad, lot in got:
            hx, hz = tstage._extent_of(lot.facing, f.footprint_x, f.footprint_z)
            bx, bz, depth = rf._yard_anchor(lot, hx, hz)
            self.assertGreater(depth, 0.0, "the shed is deeper than the pad")
            v_lo, v_hi = rf.yard_span(lot, bx, bz, hx, hz)
            _along, away = tstage._lot_frame(lot)
            v_b = (bx - lot.x) * away[0] + (bz - lot.z) * away[1]
            # The apron band is nearer the frontage line (v = -depth/2) than the
            # building is, measured in the parcel's own axis rather than in
            # world z — the road is not axis-aligned for half these pads.
            self.assertLess((v_lo + v_hi) / 2.0, v_b,
                            "the apron is behind the shed")
            # ...and the same claim measured against the road itself.
            link = rf._pad_link(pad, self.links)
            def to_road(px, pz):
                return min(tp._point_seg_dist(px, pz, a, b) for a, b
                           in zip(link["points"][:-1], link["points"][1:]))
            yx0, yz0, yx1, yz1 = rf.yard_rect(lot, v_lo, v_hi)
            apron = ((yx0 + yx1) / 2.0, (yz0 + yz1) / 2.0)
            self.assertLess(to_road(*apron), to_road(bx, bz),
                            "the apron is further from the carriageway than the "
                            "shed is — the yard is behind the building")
            seen.add(tuple(round(c, 3) for c in rf._away_of(pad)))
        self.assertGreaterEqual(len(seen), 2,
                                "only one side of the road was measured")

    def test_a_spec_too_big_for_the_pad_is_left_out_rather_than_half_fitted(self):
        spec = dict(ROAD_FRONTAGE[0])
        spec["yard_depth"] = 100000
        self.assertEqual(rf.parcels_from_pads(self.rows, spec, self.facts), [])

    def test_the_default_pad_fits_every_frontage_spec(self):
        """A pad nothing can use is tarmac with no purpose, and it would read as
        "the placer ignored the pads"."""
        p = yd.YardParams()
        for spec in ROAD_FRONTAGE:
            f = self.facts[spec["def"]]
            hx, hz = tstage._extent_of("south", f.footprint_x, f.footprint_z)
            reach = 2.0 * 0.7072 * (hx + hz)
            self.assertGreaterEqual(2.0 * p.half_away,
                                    spec["yard_depth"] + reach,
                                    f"{spec['def']} does not fit a default pad")
            self.assertGreaterEqual(2.0 * p.half_along,
                                    max(spec["frontage"], reach),
                                    f"{spec['def']}'s frontage exceeds a pad")

    def test_a_pad_naming_a_link_that_is_not_its_own_is_refused(self):
        """The link index is stable only because the emitter emits one row per
        link and the reader drops none. Checking it turns a silent shift — a
        depot squared to the wrong road's polyline — into a refusal."""
        row = dict(self.rows[0])
        row["link"] = 99
        with self.assertRaises(rf.FrontageRefused):
            rf._pad_link(row, self.links)
        moved = dict(self.rows[0])
        moved["x"] = moved["x"] + 5000.0
        with self.assertRaises(rf.FrontageRefused):
            rf._pad_link(moved, self.links)
        # ...and the positive, so a checker that refused everything would fail.
        self.assertIsNotNone(rf._pad_link(self.rows[0], self.links))


class StagedOnAPreparedMap(unittest.TestCase):
    """The whole seam, through `generate`: a map that published pads gets its
    yards ON them, and the report says so."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.map_dir = wide_flat_map(cls.tmp.name, "synth_pads")
        n = int(WIDE_ELMOS / CELL)
        h = np.full((n, n), 10.0)
        hw = np.array([[400.0, WIDE_ELMOS / 2.0],
                       [WIDE_ELMOS - 400.0, WIDE_ELMOS / 2.0]])
        road = np.array([[400.0, WIDE_ELMOS / 4.0],
                         [WIDE_ELMOS - 400.0, WIDE_ELMOS / 4.0 + 600.0]])
        net = rd.RoadNetwork(links=[rd.RoadLink(hw, rd.ROAD_HIGHWAY, 0, 1),
                                    rd.RoadLink(road, rd.ROAD_ROAD, 2, 3)])
        raster = rd.rasterize_network(net, h.shape, CELL, RP)
        cls.pads, _r = yd.plan_yard_pads(net, h, raster, CELL, -100.0,
                                         road_params=RP)
        with open(os.path.join(cls.map_dir, "mapdata", "roads.lua"), "w") as f:
            f.write(pkg.emit_roads_lua(net, CELL, RP, crossings=[],
                                       yards=cls.pads))
        cls.lua, cls.meta = sg.generate(cls.map_dir, seed=7, game_dir=GAME_DIR)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_the_map_published_pads(self):
        self.assertTrue(self.pads, "the fixture map published no pad at all")

    def test_a_yard_stood_on_a_prepared_pad(self):
        self.assertTrue(self.meta["frontage"],
                        f"no yard staged; {self.meta['frontage_refusals']}")
        self.assertTrue(self.meta["frontage_pads"],
                        "every yard fell back to a carved parcel: "
                        f"{self.meta['frontage_refusals']}")

    def test_a_yard_on_a_pad_stands_inside_that_pad(self):
        """The point of the whole milestone: the building is on the tarmac.

        Measured in the PAD's own frame — a building inside the pad's AABB can
        still be off a diagonal pad's corner.

        **Read out of the ROADSIDE YARDS section, not out of the file.** The
        first version of this test searched the whole Lua for `def = 'ms_depot'`
        and measured a TOWN's depot 2 268 elmos away, because `ms_depot` is
        civilian content that `place_sites` and `town_stager` also stage. A
        def name is not a placement key, and every yard-shaped assertion over the
        emitted file has to be scoped to the block that placer wrote.
        """
        by_key = {f"pad_{i}": p for i, p in enumerate(self.pads)}
        placed = dict(self.meta["frontage_pads"])
        self.assertTrue(placed)
        head = self.lua.find("ROADSIDE YARDS")
        self.assertGreater(head, 0, "the yard section is not in the file")
        block = self.lua[head:self.lua.find("\n    },", head)]
        staged = {}
        for line in block.splitlines():
            for defname in placed:
                if f"def = '{defname}'" in line:
                    xs = line.split("x = ")[1].split(",")[0]
                    zs = line.split("z = ")[1].split(",")[0]
                    staged.setdefault(defname, (float(xs), float(zs)))
        for defname, key in placed.items():
            self.assertIn(defname, staged, f"{defname} never reached the file")
            pad = by_key[key]
            bx, bz = staged[defname]
            ux, uz = pad.along
            ax, az = pad.away
            du = abs((bx - pad.x) * ux + (bz - pad.z) * uz)
            dv = abs((bx - pad.x) * ax + (bz - pad.z) * az)
            self.assertLessEqual(du, pad.half_along,
                                 f"{defname} overhangs its pad along the road")
            self.assertLessEqual(dv, pad.half_away,
                                 f"{defname} overhangs the back of its pad")

    def test_the_same_seed_stages_the_same_yards(self):
        _lua2, meta2 = sg.generate(self.map_dir, seed=7, game_dir=GAME_DIR)
        self.assertEqual(meta2["frontage"], self.meta["frontage"])
        self.assertEqual(meta2["frontage_pads"], self.meta["frontage_pads"])

    def test_a_second_seed_also_uses_the_pads(self):
        _lua2, meta2 = sg.generate(self.map_dir, seed=23, game_dir=GAME_DIR)
        self.assertTrue(meta2["frontage_pads"],
                        f"seed 23 used no pad; {meta2['frontage_refusals']}")


if __name__ == "__main__":
    unittest.main()
