#!/usr/bin/env python3
"""Tests for roadside yards — a building that stands ON a road (roads R4).

    cd tools/mapgen && .venv/bin/python -m unittest tests.test_road_frontage

What each one is here for:

  * **the emitter and the reader are the only two ends of `mapdata/roads.lua`,
    and the last vertex is where they part.** The `links` reader was written
    against the emitter's own output and still dropped the final point of every
    polyline — the row ends `} }` and the point list's own closing brace is the
    first of the two. A two-point link then read as one point and vanished
    entirely, with no error: a map whose roads simply were not there. So the
    round trip is asserted on the emitter's real output, and on the VERTEX
    COUNT rather than on "some links parsed".
  * **the yard is between the road and the shed, and that is the whole
    primitive.** `town_stager._anchor_for` and `road_frontage._yard_anchor` are
    the same arithmetic with opposite signs, so nothing but a measurement can
    tell which one a placement used — and a depot with its yard behind it is a
    depot facing away from its own road.
  * **nothing stands on the carriageway.** A building blocks, so a yard on the
    deck severs the route the road exists to provide, and it does it silently:
    legal scenario, legal map, convoy never arrives.
  * **the required frontage class is honoured by REFUSING, not by relaxing.** A
    fuel stop asks for a highway; on a map of tracks it must be absent from the
    scenario and present in the refusals, because "no yard" and "a yard on a
    goat track" are the two outcomes this knob exists to separate.
  * **a map with no road graph is an ordinary map.** Every pre-R2 map and every
    hand-authored one publishes no `mapdata/roads.lua`, and that must produce a
    scenario without yards rather than an exception.
"""
import math
import os
import sys
import tempfile
import unittest

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
from test_scenariogen import WIDE_ELMOS, wide_flat_map   # noqa: E402

GAME_DIR = os.path.join(REPO, "data", "games", "metalstorm")


def write_roads(map_dir: str, links: list[dict]) -> None:
    """A `mapdata/roads.lua` in the shape `terragen.package.emit_roads_lua` writes.

    Hand-built rather than generated here so a link can be given a class and a
    geometry the test needs; `test_reader_agrees_with_the_emitter` below is what
    holds this shape to the real emitter's.
    """
    out = ["return {", "    links = {"]
    for ln in links:
        verts = ", ".join(f"{{{int(x)}, {int(z)}}}" for x, z in ln["points"])
        out.append(f'        {{ class = {ln["road_class"]}, '
                   f'name = "{ln["name"]}", width = {int(ln["width"])}, '
                   f'a = 0, b = 1, points = {{ {verts} }} }},')
    out += ["    },", "    junctions = {", "    },", "    crossings = {",
            "    },", "}"]
    with open(os.path.join(map_dir, "mapdata", "roads.lua"), "w") as f:
        f.write("\n".join(out) + "\n")


def straight_link(z: int, road_class: int = 0, name: str = "highway",
                  width: int = 77, elmos: int = WIDE_ELMOS) -> dict:
    """One link running west to east across the map at depth `z`."""
    return {"road_class": road_class, "name": name, "width": width,
            "points": [(200.0, float(z)), (elmos / 2.0, float(z)),
                       (elmos - 200.0, float(z))]}


class ReaderAgreesWithEmitter(unittest.TestCase):
    def test_every_vertex_survives_the_round_trip(self):
        """The emitter's own output, read back, vertex for vertex.

        Asserting the COUNT is the point: the defect this catches leaves a
        perfectly well-formed link one vertex short, which is invisible in
        every other assertion one would naturally write.
        """
        import numpy as np
        from terragen import package as pkg
        from terragen import roads as rd

        line = np.array([[100.0, 100.0], [400.0, 300.0], [900.0, 320.0],
                         [1500.0, 700.0]])
        net = rd.RoadNetwork()
        net.links.append(rd.RoadLink(polyline=line, road_class=rd.ROAD_HIGHWAY,
                                     a=0, b=1))
        net.junctions = [(400.0, 300.0)]
        text = pkg.emit_roads_lua(net, cellsize=8.0, decimate=200.0)

        with tempfile.TemporaryDirectory() as t:
            os.makedirs(os.path.join(t, "mapdata"))
            with open(os.path.join(t, "mapdata", "roads.lua"), "w") as f:
                f.write(text)
            got = sg.read_road_links(t)

        self.assertEqual(len(got), 1)
        emitted = text.split("points = {")[1].split("} }")[0].count("{")
        self.assertEqual(len(got[0]["points"]), emitted,
                         "the reader dropped a vertex the emitter wrote")
        self.assertEqual(got[0]["road_class"], rd.ROAD_HIGHWAY)
        self.assertGreater(got[0]["width"], 0.0)

    def test_a_map_with_no_roads_file_reads_as_no_roads(self):
        """Absent is not an error — every pre-R2 map is in this state."""
        with tempfile.TemporaryDirectory() as t:
            os.makedirs(os.path.join(t, "mapdata"))
            self.assertEqual(sg.read_road_links(t), [])


class YardGeometry(unittest.TestCase):
    """The primitive, measured — no terrain, no scenario, just the arithmetic."""

    def setUp(self):
        self.facts = ms_defs.load(GAME_DIR)
        self.spec = dict(ROAD_FRONTAGE[0])
        self.link = straight_link(2000)

    def test_the_yard_is_between_the_road_and_the_shed(self):
        """The apron's centre is nearer the carriageway than the building is.

        The two anchors differ only in sign, so this is the assertion that
        distinguishes them — and it is asserted for BOTH sides of the road,
        because a sign error shows up on one side as a correct-looking yard.
        """
        f = self.facts[self.spec["def"]]
        for lot in rf.carve_parcels(self.link, self.spec, self.facts)[:2]:
            hx, hz = tstage._extent_of(lot.facing, f.footprint_x, f.footprint_z)
            bx, bz, depth = rf._yard_anchor(lot, hx, hz)
            self.assertGreater(depth, 0.0, "no apron at all")
            v_lo, v_hi = rf.yard_span(lot, bx, bz, hx, hz)
            yx0, yz0, yx1, yz1 = rf.yard_rect(lot, v_lo, v_hi)
            yard_c = ((yx0 + yx1) / 2.0, (yz0 + yz1) / 2.0)
            road_z = self.link["points"][0][1]
            self.assertLess(abs(yard_c[1] - road_z), abs(bz - road_z),
                            f"{lot.key}: the yard is behind the building")

    def test_the_building_faces_its_road(self):
        """`facing` points across the apron at the carriageway.

        A cardinal is all `Spring.CreateUnit` takes, so this is the snapped
        tangent — but a snapped tangent that points the wrong way is a depot
        with its doors to the field, which no assertion about the position
        would catch.
        """
        f = self.facts[self.spec["def"]]
        road_z = self.link["points"][0][1]
        for lot in rf.carve_parcels(self.link, self.spec, self.facts)[:2]:
            hx, hz = tstage._extent_of(lot.facing, f.footprint_x, f.footprint_z)
            bx, bz, _ = rf._yard_anchor(lot, hx, hz)
            fv = tstage.FACING_VECTOR[lot.facing]
            self.assertGreater(fv[1] * (road_z - bz), 0.0,
                               f"{lot.key} faces away from its own road")

    def test_the_parked_rows_fill_from_the_gate(self):
        """Row 0 is the row nearest the road, and every vehicle is in the apron.

        A park laid out from the back of the yard reads as a car park behind a
        shed; the row a player sees from the carriageway is the one that must
        exist when the apron only has depth for one.
        """
        f = self.facts[self.spec["def"]]
        lot = rf.carve_parcels(self.link, self.spec, self.facts)[0]
        hx, hz = tstage._extent_of(lot.facing, f.footprint_x, f.footprint_z)
        bx, bz, _ = rf._yard_anchor(lot, hx, hz)
        v_lo, v_hi = rf.yard_span(lot, bx, bz, hx, hz)
        parked = rf.park_vehicles(lot, v_lo, v_hi, self.spec["parked"],
                                  self.facts, self.spec["rows"],
                                  self.spec["per_row"])
        self.assertTrue(parked, "the apron parked nothing at all")
        _along, away = tstage._lot_frame(lot)
        vs = [(px - lot.x) * away[0] + (pz - lot.z) * away[1]
              for _n, px, pz in parked]
        self.assertGreaterEqual(min(vs), v_lo, "a vehicle is outside the apron")
        self.assertLessEqual(max(vs), v_hi, "a vehicle is inside the shed")
        # The gate row, specifically: filling from the back of the apron also
        # puts every vehicle between the shed and the road, so "nearer the road
        # than the shed" passes either way and proves nothing. The first row
        # must sit within one vehicle pitch of the FRONTAGE LINE.
        pitch = 2.0 * max(self.facts[d].body_radius
                          for d in self.spec["parked"]) + rf.PARK_GAP
        self.assertLess(min(vs) - v_lo, pitch,
                        "the apron filled from the back, not from the gate")

    def test_nothing_is_carved_across_the_link_ends(self):
        """A link terminates at a junction or a town gate; both are somebody's.

        Neutralising `END_KEEPOUT` puts a parcel on the last station of every
        link, which is where the next link starts.
        """
        for lot in rf.carve_parcels(self.link, self.spec, self.facts):
            for end in (self.link["points"][0], self.link["points"][-1]):
                self.assertGreater(math.hypot(lot.x - end[0], lot.z - end[1]),
                                   rf.END_KEEPOUT * 0.9, f"{lot.key} on an end")


class TheDeckIsNeverBuiltOn(unittest.TestCase):
    def test_a_shed_on_the_carriageway_is_refused(self):
        """`_clears_deck` is the acceptance rule, asked of a rectangle ON the road.

        Stated as a positive AND a negative in one test because the negative
        alone passes for a predicate that returns False unconditionally.
        """
        link = straight_link(2000)
        on_deck = (2000.0, 1980.0, 2200.0, 2020.0)
        beside = (2000.0, 2200.0, 2200.0, 2400.0)
        self.assertFalse(rf._clears_deck(on_deck, link))
        self.assertTrue(rf._clears_deck(beside, link))

    def test_a_bend_is_tested_along_its_whole_length(self):
        """A parcel square to its own station can still clip the deck downstream."""
        link = {"road_class": 0, "name": "highway", "width": 60,
                "points": [(0.0, 0.0), (1000.0, 0.0), (1000.0, 1000.0)]}
        clips_the_far_leg = (960.0, 400.0, 1040.0, 500.0)
        self.assertFalse(rf._clears_deck(clips_the_far_leg, link))


class StagedOnASyntheticMap(unittest.TestCase):
    """The whole layer, through `generate`, on a flat map with a road on it."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.map_dir = wide_flat_map(cls.tmp.name, "synth_roads")
        write_roads(cls.map_dir, [straight_link(WIDE_ELMOS // 2),
                                  straight_link(WIDE_ELMOS // 4, road_class=1,
                                                name="road", width=48)])
        cls.lua, cls.meta = sg.generate(cls.map_dir, seed=7, game_dir=GAME_DIR)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_the_map_carries_a_yard_with_vehicles_parked_on_it(self):
        self.assertTrue(self.meta["frontage"],
                        f"no yard staged; refusals: {self.meta['frontage_refusals']}")
        for defname, road, parked in self.meta["frontage"]:
            self.assertIn(defname, ms_defs.load(GAME_DIR))
            self.assertIn(road, ("highway", "road"))
            self.assertGreaterEqual(parked, 1, f"{defname}'s apron is empty")

    def test_every_staged_yard_unit_reaches_the_file(self):
        """The emitter names the keys it writes and drops the rest (R3b find 1).

        Asserted on the FILE, not on the meta, for exactly that reason: a yard
        that never reached the Lua is a yard the game does not have.
        """
        for defname, _road, parked in self.meta["frontage"]:
            self.assertIn(f"def = '{defname}'", self.lua)
        self.assertIn("ROADSIDE YARDS", self.lua)

    def test_the_fuel_stop_asks_for_a_highway_and_is_refused_without_one(self):
        """The frontage class is a requirement, not a preference."""
        with tempfile.TemporaryDirectory() as t:
            d = wide_flat_map(t, "synth_tracks")
            write_roads(d, [straight_link(WIDE_ELMOS // 2, road_class=2,
                                          name="track", width=24)])
            _lua, meta = sg.generate(d, seed=7, game_dir=GAME_DIR)
        staged = {e[0] for e in meta["frontage"]}
        self.assertNotIn("ms_tank_farm", staged)
        self.assertTrue(any("ms_tank_farm" in r
                            for r in meta["frontage_refusals"]),
                        "a spec that could not be placed said nothing")

    def test_a_map_with_no_road_graph_stages_no_yards_and_says_so(self):
        with tempfile.TemporaryDirectory() as t:
            d = wide_flat_map(t, "synth_noroads")
            _lua, meta = sg.generate(d, seed=7, game_dir=GAME_DIR)
        self.assertEqual(meta["frontage"], [])
        self.assertTrue(meta["frontage_refusals"])

    def test_a_second_seed_also_gets_yards(self):
        """The brief's acceptance is "across 2 seeds", and one seed proves less
        than it looks: the station phase is the only seeded input this placer
        has, so a second seed is what shows the layer is not standing on one
        lucky offset."""
        _lua, meta = sg.generate(self.map_dir, seed=23, game_dir=GAME_DIR)
        self.assertTrue(meta["frontage"],
                        f"seed 23 staged none; refusals: {meta['frontage_refusals']}")
        self.assertNotEqual(meta["frontage"], [])

    def test_the_same_seed_stages_the_same_yards(self):
        lua2, meta2 = sg.generate(self.map_dir, seed=7, game_dir=GAME_DIR)
        self.assertEqual(meta2["frontage"], self.meta["frontage"])
        self.assertEqual(lua2, self.lua)


if __name__ == "__main__":
    unittest.main()
