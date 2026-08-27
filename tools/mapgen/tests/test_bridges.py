#!/usr/bin/env python3
"""Tests for road water crossings — where a bridge belongs (roads R3b).

    cd tools/mapgen && .venv/bin/python -m unittest tests.test_bridges

What each one is here for:

  * **the heading convention is pinned against the gadget that consumes it.**
    A chain is laid along the feature's local -Z, so a heading that is 90 deg
    out builds the bridge ACROSS the river instead of over it — and nothing
    reports that, because every span is still a legal feature at a legal
    position. `HeadingContract` reads `FEATURE_FACING_HEADINGS` and the
    `headingToDir` formula out of `game_scenario.lua` itself, so this cannot
    pass by agreeing with a copy of the convention.
  * **the pitch is the def's.** `ms_defs.feature_chain_pitch` reads
    `customparams.chain_pitch` out of features/bridges.lua, which is where the
    measured 24.0 lives. A generator that hardcoded it would size chains for a
    span the content no longer ships.
  * **the chain stays over water**, asked of the same centred arithmetic
    `stageFeatures` uses rather than of the span count that produced it. §M4
    lost a live boot to a chain sized to reach the banks.
  * **a wet stretch of road is refused out loud.** Too short, too long, too
    deep — each one is a different fact about the map, and a refusal that reads
    as "no crossing here" hides which.
  * **the map's emitter and the scenario's reader agree.** They are in two
    modules, they are the only two ends of this file, and a format drift
    between them degrades silently to "this map has no fords".
"""
import os
import re
import sys
import tempfile
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MAPGEN = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(MAPGEN, "..", ".."))
sys.path.insert(0, MAPGEN)

import ms_defs                              # noqa: E402
import scenariogen as sg                    # noqa: E402
from terragen import bridges as br          # noqa: E402
from terragen import package as pkg         # noqa: E402
from terragen import roads as rd            # noqa: E402

GAME_DIR = os.path.join(REPO, "data", "games", "metalstorm")
GADGET = os.path.join(GAME_DIR, "luarules", "gadgets", "game_scenario.lua")

CELL = 32.0


class FakeNet:
    """The two attributes `find_crossings` reads off a RoadNetwork."""

    def __init__(self, links):
        self.links = links


def link(polyline, road_class=rd.ROAD_HIGHWAY):
    return rd.RoadLink(np.asarray(polyline, dtype=np.float64), road_class, 0, 1)


def straight(x0, z0, x1, z1, n=200):
    t = np.linspace(0.0, 1.0, n)
    return np.stack([x0 + (x1 - x0) * t, z0 + (z1 - z0) * t], axis=1)


def channel_map(shape=(96, 96), depth=-8.0, x0=1200.0, x1=1600.0, land=40.0):
    """Dry ground with one N-S water channel between world x0 and x1."""
    h = np.full(shape, land, dtype=np.float64)
    xs = np.arange(shape[1]) * CELL
    h[:, (xs >= x0) & (xs <= x1)] = depth
    return h


class HeadingContract(unittest.TestCase):
    """heading_short/heading_dir must be game_scenario.lua's convention."""

    def setUp(self):
        with open(GADGET, encoding="utf-8") as fh:
            self.lua = fh.read()

    def test_cardinals_match_the_gadgets_table(self):
        block = re.search(r"FEATURE_FACING_HEADINGS\s*=\s*\{(.*?)\}",
                          self.lua, re.DOTALL).group(1)
        table = {m.group(1): int(m.group(2)) for m in
                 re.finditer(r"(\w+)\s*=\s*(-?\d+)", block)}
        self.assertEqual(len(table), 4, "expected four cardinals")
        # north is -Z, east is +X: the diagram SpringMath.inl draws and the
        # gadget's own comment restates.
        want = {"north": (0.0, -1.0), "east": (1.0, 0.0),
                "south": (0.0, 1.0), "west": (-1.0, 0.0)}
        for name, heading in table.items():
            dx, dz = br.heading_dir(heading % 65536)
            self.assertAlmostEqual(dx, want[name][0], places=3, msg=name)
            self.assertAlmostEqual(dz, want[name][1], places=3, msg=name)
            # South is 32767, not 32768: GetHeadingFromFacing saturates at the
            # top of the signed 16-bit range. One heading unit is 0.0055 deg,
            # so the round trip is allowed that much and no more.
            delta = (br.heading_short(*want[name]) - heading) % 65536
            self.assertIn(min(delta, 65536 - delta), (0, 1), msg=name)

    def test_heading_to_dir_matches_the_gadgets_formula(self):
        """The gadget computes sin/-cos on the raw short; so must we."""
        self.assertRegex(self.lua,
                         r"return\s+math\.sin\(theta\)\s*,\s*-math\.cos\(theta\)")
        for short in (0, 4096, 16384, 30000, 49152, 65535):
            theta = short * (2.0 * np.pi / 65536.0)
            self.assertAlmostEqual(br.heading_dir(short)[0], np.sin(theta), places=6)
            self.assertAlmostEqual(br.heading_dir(short)[1], -np.cos(theta), places=6)

    def test_round_trips_an_arbitrary_tangent(self):
        for ang in np.linspace(0, 2 * np.pi, 37):
            dx, dz = float(np.cos(ang)), float(np.sin(ang))
            bx, bz = br.heading_dir(br.heading_short(dx, dz))
            self.assertGreater(bx * dx + bz * dz, 0.9999)


class PitchIsTheDefs(unittest.TestCase):
    def test_reads_the_shipped_chain_pitch(self):
        self.assertEqual(ms_defs.feature_chain_pitch(GAME_DIR), 24.0)

    def test_default_params_agree_with_the_def(self):
        """A drifted default would size chains the stager then lays differently."""
        self.assertEqual(br.CrossingParams().pitch,
                         ms_defs.feature_chain_pitch(GAME_DIR))

    def test_missing_pitch_raises(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "features"))
            with open(os.path.join(d, "features", "bridges.lua"), "w") as fh:
                fh.write("return { ms_road_bridge = { blocking = false } }\n")
            with self.assertRaises(ValueError):
                ms_defs.feature_chain_pitch(d)

    def test_a_commented_pitch_cannot_win(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "features"))
            with open(os.path.join(d, "features", "bridges.lua"), "w") as fh:
                fh.write("-- chain_pitch = '99'\n"
                         "return { a = { customparams = "
                         "{ chain_pitch = '24' } } }\n")
            self.assertEqual(ms_defs.feature_chain_pitch(d), 24.0)


class FindCrossings(unittest.TestCase):
    def test_a_straight_ford_becomes_a_chain(self):
        h = channel_map()
        net = FakeNet([link(straight(400.0, 1500.0, 2400.0, 1500.0))])
        got, refused = br.find_crossings(net, h, CELL)
        self.assertEqual(refused, [])
        self.assertEqual(len(got), 1)
        c = got[0]
        # 400 elmos of water, less a square either side, at a 24 pitch
        self.assertEqual(c.spans, int((c.width) // 24.0))
        self.assertGreaterEqual(c.spans, 13)
        self.assertAlmostEqual(c.x, 1400.0, delta=CELL)
        self.assertAlmostEqual(c.z, 1500.0, delta=1.0)
        # laid along +X
        self.assertAlmostEqual(br.heading_dir(c.heading)[0], 1.0, places=2)
        self.assertAlmostEqual(c.max_depth, 8.0, places=2)

    def test_every_span_centre_is_over_water(self):
        h = channel_map()
        net = FakeNet([link(straight(400.0, 1500.0, 2400.0, 1500.0))])
        (c,), _ = br.find_crossings(net, h, CELL)
        centres = np.asarray(c.span_centres(24.0))
        self.assertTrue((rd.sample_height(h, centres, CELL) <= 0.0).all())

    def test_heading_follows_the_road_not_a_cardinal(self):
        """A diagonal ford gets the road's own tangent."""
        h = channel_map()
        net = FakeNet([link(straight(400.0, 400.0, 2400.0, 2400.0))])
        (c,), _ = br.find_crossings(net, h, CELL)
        dx, dz = br.heading_dir(c.heading)
        self.assertAlmostEqual(dx, np.sqrt(0.5), places=2)
        self.assertAlmostEqual(dz, np.sqrt(0.5), places=2)
        self.assertNotIn(c.heading, (0, 16384, 32768, 49152))

    def test_a_ditch_is_refused_as_a_plank(self):
        h = channel_map(x0=1200.0, x1=1290.0)
        net = FakeNet([link(straight(400.0, 1500.0, 2400.0, 1500.0))])
        got, refused = br.find_crossings(net, h, CELL)
        self.assertEqual(got, [])
        self.assertEqual(len(refused), 1)
        self.assertIn("plank", refused[0].reason)

    def test_open_water_is_refused_as_a_causeway(self):
        h = channel_map(x0=800.0, x1=2000.0)
        net = FakeNet([link(straight(200.0, 1500.0, 2600.0, 1500.0))])
        got, refused = br.find_crossings(net, h, CELL)
        self.assertEqual(got, [])
        self.assertIn("causeway", refused[0].reason)

    def test_water_deeper_than_a_vehicle_wades_is_a_route_defect(self):
        """Not a bridge opportunity: the span is decoration and the ford is
        what units actually cross, so a road into unwadeable water is broken."""
        h = channel_map(depth=-40.0)
        net = FakeNet([link(straight(400.0, 1500.0, 2400.0, 1500.0))])
        got, refused = br.find_crossings(net, h, CELL)
        self.assertEqual(got, [])
        self.assertIn("VEH wades", refused[0].reason)
        self.assertFalse(br.crossing_is_fordable(40.0, 20.0))
        self.assertTrue(br.crossing_is_fordable(11.4, 20.0))

    def test_a_dry_road_produces_nothing_at_all(self):
        h = np.full((96, 96), 40.0)
        net = FakeNet([link(straight(400.0, 1500.0, 2400.0, 1500.0))])
        self.assertEqual(br.find_crossings(net, h, CELL), ([], []))

    def test_a_bend_that_walks_the_chain_ashore_is_refused(self):
        """The chain is straight even when the road is not, so a crossing that
        turns inside the water is refused by the afloat test rather than built
        as a line of spans standing on the bank."""
        # A crescent of water — an annulus around (1500, 1500) — with the road
        # following it round. Every sample of the road is wet and the chord
        # between the run's ends is inside the span window, but the chord cuts
        # across the dry hole in the middle, so a STRAIGHT chain laid on it
        # stands on land.
        shape = (96, 96)
        zz, xx = np.mgrid[0:shape[0], 0:shape[1]] * CELL
        r = np.hypot(xx - 1500.0, zz - 1500.0)
        h = np.full(shape, 40.0)
        h[(r >= 250.0) & (r <= 350.0)] = -6.0
        ang = np.linspace(-np.pi / 3.0, np.pi / 3.0, 200)
        pl = np.stack([1500.0 + 300.0 * np.cos(ang),
                       1500.0 + 300.0 * np.sin(ang)], axis=1)
        net = FakeNet([link(pl)])
        got, refused = br.find_crossings(net, h, CELL)
        self.assertEqual(got, [])
        self.assertEqual(len(refused), 1)
        self.assertIn("leaves the water", refused[0].reason)
        # the road is wet the whole way round, and the arc is longer than the
        # chord the chain would have been laid on
        self.assertGreater(refused[0].length, 600.0)

    def test_two_fords_on_one_road_are_two_crossings(self):
        h = channel_map(x0=1200.0, x1=1600.0)
        xs = np.arange(h.shape[1]) * CELL
        h[:, (xs >= 2200.0) & (xs <= 2600.0)] = -6.0
        net = FakeNet([link(straight(400.0, 1500.0, 2900.0, 1500.0))])
        got, _ = br.find_crossings(net, h, CELL)
        self.assertEqual(len(got), 2)
        self.assertLess(got[0].x, got[1].x)

    def test_is_deterministic(self):
        h = channel_map()
        net = FakeNet([link(straight(400.0, 400.0, 2400.0, 2400.0))])
        self.assertEqual(br.find_crossings(net, h, CELL),
                         br.find_crossings(net, h, CELL))


class FordsArePublished(unittest.TestCase):
    """roads R3d — "no bridge" is two facts, and the map has to say which.

    Before R3d every refusal was the same disappointed print line, so a map
    published where its bridges went and never published where its roads waded
    — the larger set, and the only one a unit has to survive.
    """

    def _survey(self, h, pl):
        return br.find_crossings(FakeNet([link(straight(*pl))]), h, CELL)

    def test_a_causeway_is_a_ford_not_a_defect(self):
        h = channel_map(x0=800.0, x1=2000.0)
        got, refused = self._survey(h, (200.0, 1500.0, 2600.0, 1500.0))
        self.assertEqual(got, [])
        self.assertTrue(refused[0].fordable)
        self.assertEqual(refused[0].road_class, rd.ROAD_HIGHWAY)
        # the road's own tangent survived the refusal
        self.assertAlmostEqual(br.heading_dir(refused[0].heading)[0], 1.0,
                               places=2)

    def test_a_plank_over_a_ditch_is_a_ford_not_a_defect(self):
        h = channel_map(x0=1200.0, x1=1290.0)
        _got, refused = self._survey(h, (400.0, 1500.0, 2400.0, 1500.0))
        self.assertTrue(refused[0].fordable)

    def test_water_deeper_than_the_wade_is_NOT_fordable(self):
        h = channel_map(depth=-40.0)
        _got, refused = self._survey(h, (400.0, 1500.0, 2400.0, 1500.0))
        self.assertFalse(refused[0].fordable)

    def test_the_fords_table_is_the_superset_of_the_crossings_table(self):
        """One road, two wet runs: one bridgeable, one too wide for a chain."""
        h = channel_map(x0=1200.0, x1=1600.0)
        xs = np.arange(h.shape[1]) * CELL
        h[:, (xs >= 2200.0) & (xs <= 3600.0)] = -6.0
        got, refused = self._survey(h, (400.0, 1500.0, 4200.0, 1500.0, 400))
        self.assertEqual(len(got), 1)
        self.assertEqual([r.fordable for r in refused], [True])
        rows = br.emit_fords_lua(got, refused)
        self.assertEqual(len(rows), 2)
        spans = sorted(int(re.search(r"spans = (\d+)", r).group(1))
                       for r in rows)
        self.assertEqual(spans[0], 0)            # the causeway, unbridged
        self.assertEqual(spans[1], got[0].spans)  # the chain, same number

    def test_an_unfordable_run_is_never_published_as_a_ford(self):
        h = channel_map(depth=-40.0)
        got, refused = self._survey(h, (400.0, 1500.0, 2400.0, 1500.0))
        self.assertEqual(br.emit_fords_lua(got, refused), [])

    def test_every_row_carries_the_wade_it_was_graded_against(self):
        h = channel_map(x0=800.0, x1=2000.0)
        got, refused = self._survey(h, (200.0, 1500.0, 2600.0, 1500.0))
        rows = br.emit_fords_lua(got, refused, wade_depth=17.0)
        self.assertIn("wade = 17", rows[0])


class RoadsLuaContract(unittest.TestCase):
    """The map's emitter and scenariogen's reader are the two ends of one file."""

    def _emit(self, crossings):
        net = rd.RoadNetwork(links=[link(straight(0.0, 0.0, 1000.0, 1000.0, 8))])
        return pkg.emit_roads_lua(net, CELL, rd.RoadParams(), crossings=crossings)

    def _read(self, text):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "mapdata"))
            with open(os.path.join(d, "mapdata", "roads.lua"), "w") as fh:
                fh.write(text)
            return sg.read_road_crossings(d)

    def test_round_trips_every_field(self):
        h = channel_map()
        net = FakeNet([link(straight(400.0, 400.0, 2400.0, 2400.0))])
        got, _ = br.find_crossings(net, h, CELL)
        back = self._read(self._emit(got))
        self.assertEqual(len(back), len(got))
        for c, b in zip(got, back):
            self.assertEqual(b["def"], "ms_road_bridge")
            self.assertEqual(b["heading"], c.heading)
            self.assertEqual(b["spans"], c.spans)
            self.assertEqual(b["road_class"], c.road_class)
            self.assertAlmostEqual(b["x"], c.x, delta=1.0)
            self.assertAlmostEqual(b["z"], c.z, delta=1.0)
            self.assertAlmostEqual(b["depth"], c.max_depth, delta=0.1)

    def test_the_key_exists_even_with_no_fords(self):
        """Absent and empty must not read the same to a consumer."""
        self.assertIn("crossings = {", self._emit([]))
        self.assertEqual(self._read(self._emit([])), [])

    def test_a_pre_r3b_roads_lua_reads_as_no_fords(self):
        text = self._emit([])
        # cut the whole block INCLUDING its comment header — the header names
        # the key, and a reader that searches for the name would find it there
        text = text[:text.index("    -- Bridge crossings")] + "}\n"
        self.assertNotIn("crossings", text)
        self.assertEqual(self._read(text), [])

    def test_a_map_with_no_roads_lua_reads_as_no_fords(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(sg.read_road_crossings(d), [])

    def test_the_fords_block_round_trips_through_the_real_file(self):
        """roads R3d, both ends: emit_roads_lua -> read_road_fords."""
        h = channel_map(x0=800.0, x1=2000.0)
        xs = np.arange(h.shape[1]) * CELL
        h[:, (xs >= 2400.0) & (xs <= 2800.0)] = -6.0
        net = FakeNet([link(straight(200.0, 1500.0, 3200.0, 1500.0, 400))])
        got, refused = br.find_crossings(net, h, CELL)
        rn = rd.RoadNetwork(links=list(net.links))
        text = pkg.emit_roads_lua(rn, CELL, rd.RoadParams(), crossings=got,
                                  refusals=refused)
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "mapdata"))
            with open(os.path.join(d, "mapdata", "roads.lua"), "w") as fh:
                fh.write(text)
            fords = sg.read_road_fords(d)
            crossings = sg.read_road_crossings(d)
        self.assertEqual(len(crossings), 1)          # only the narrow run
        self.assertEqual(len(fords), 2)              # both wet runs
        self.assertEqual(sorted(f["spans"] for f in fords),
                         [0, crossings[0]["spans"]])
        for f in fords:
            self.assertLessEqual(f["depth"], f["wade"])
            self.assertGreater(f["length"], 0.0)

    def test_the_fords_key_exists_even_with_no_fords(self):
        self.assertIn("fords = {", self._emit([]))

    def test_a_pre_r3d_roads_lua_reads_as_no_fords(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "mapdata"))
            with open(os.path.join(d, "mapdata", "roads.lua"), "w") as fh:
                fh.write("return {\n    links = {},\n    junctions = {},\n"
                         "    crossings = {},\n}\n")
            self.assertEqual(sg.read_road_fords(d), [])
            self.assertEqual(sg.read_road_crossings(d), [])

    def test_a_map_with_no_roads_lua_reads_as_no_fords_either(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(sg.read_road_fords(d), [])

    def test_the_published_def_is_a_real_featuredef(self):
        facts = sg.load_feature_facts(GAME_DIR)
        h = channel_map()
        net = FakeNet([link(straight(400.0, 1500.0, 2400.0, 1500.0))])
        got, _ = br.find_crossings(net, h, CELL)
        for b in self._read(self._emit(got)):
            self.assertIn(b["def"], facts)


class PublishedCrossingsWin(unittest.TestCase):
    """scenariogen prefers what the map said over what it can guess.

    Uses test_scenariogen's own river fixture rather than a second one: the
    blind search is tested there against that map, and the point here is that
    the SAME map produces a different (published) answer once its roads.lua
    carries a crossing.
    """

    def setUp(self):
        if not os.path.isdir(GAME_DIR):
            self.skipTest(f"no game content at {GAME_DIR}")
        from tests import test_scenariogen as ts
        self.ts = ts

    def _publish(self, map_dir, rows):
        with open(os.path.join(map_dir, "mapdata", "roads.lua"), "w") as fh:
            fh.write("return {\n    links = {},\n    junctions = {},\n"
                     "    crossings = {\n" + "\n".join(rows) + "\n    },\n}\n")

    def _river_span(self, publish_rows=None, name="pubriver"):
        with self.ts.SyntheticMap(self.ts.river_map, name) as d:
            terrain, _ = sg.load_terrain(d, ["VEH"])
            if publish_rows is not None:
                self._publish(d, publish_rows(terrain))
            lua, meta = sg.generate(d, seed=5, game_dir=GAME_DIR, bridges=1)
        return lua, meta, next(f for f in self.ts.parse_features(lua)
                               if f["def"] == "ms_road_bridge")

    def test_without_a_roads_lua_the_blind_search_still_runs(self):
        """The fallback is the pre-R3b behaviour, unchanged."""
        _lua, _meta, span = self._river_span()
        self.assertEqual(span.get("facing"), "east")
        self.assertIsNone(span.get("heading"))

    def test_a_published_crossing_is_used_verbatim(self):
        def rows(terrain):
            # the river runs along Z through the middle; cross it heading east
            mid = self.ts.SAMPLES * 8.0 / 2.0
            return [br.emit_crossings_lua([br.Crossing(
                0, rd.ROAD_HIGHWAY, mid, 512.0, 16384, 3, 96.0, 96.0, 10.0,
                0.0)], indent="        ")[0]]
        _lua, meta, span = self._river_span(rows, "pubriver2")
        self.assertEqual(span.get("heading"), 16384)
        self.assertIsNone(span.get("facing"),
                          "a published crossing carries a heading, not a cardinal")
        self.assertEqual(span.get("chain"), 3)
        self.assertEqual(span.get("z"), 512)
        self.assertEqual(span.get("y"), 0, "still staged at the waterline")
        self.assertEqual(len(meta["crossings"]), 1)

    def test_a_published_crossing_on_dry_ground_is_rejected(self):
        """roads.lua is build output and can be older than the heightmap beside
        it, so WHERE is trusted and WET is checked."""
        def rows(terrain):
            return [br.emit_crossings_lua([br.Crossing(
                0, rd.ROAD_HIGHWAY, 200.0, 512.0, 16384, 3, 96.0, 96.0, 10.0,
                0.0)], indent="        ")[0]]
        _lua, _meta, span = self._river_span(rows, "pubriverdry")
        self.assertEqual(span.get("facing"), "east",
                         "a dry published crossing must fall back to the search")


def _mesh_positions(defname: str) -> list[tuple[float, float, float]]:
    """Every POSITION vertex of a shipped span, straight out of the glTF+bin.

    Read rather than trusted: `deck_top` is the number roads R3c turns on, and
    the only other place it exists is the forge layout script that authored the
    mesh — which is not what the game loads.
    """
    import json
    import struct
    models = os.path.join(GAME_DIR, "models")
    g = json.load(open(os.path.join(models, f"{defname}.gltf"), encoding="utf-8"))
    with open(os.path.join(models, f"{defname}.bin"), "rb") as fh:
        blob = fh.read()
    out = []
    for mesh in g["meshes"]:
        for prim in mesh["primitives"]:
            acc = g["accessors"][prim["attributes"]["POSITION"]]
            bv = g["bufferViews"][acc["bufferView"]]
            off = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
            stride = bv.get("byteStride") or 12
            out += [struct.unpack_from("<3f", blob, off + i * stride)
                    for i in range(acc["count"])]
    return out


def _mesh_units_scale(defname: str) -> float:
    """8.0 for a mesh stamped elmos (world-scale ×8), 1.0 for authored metres."""
    import json
    models = os.path.join(GAME_DIR, "models")
    g = json.load(open(os.path.join(models, f"{defname}.gltf"), encoding="utf-8"))
    ext = g.get("extensions", {}).get("SPRINGRTS_geometry", {})
    return 8.0 if ext.get("units") == "elmos" else 1.0


class DeckTopIsTheDefs(unittest.TestCase):
    """The deck gap is a MODEL constant and the map has to be able to read it.

    `CFeature::UpdatePosition` clamps a feature's y up to the ground and never
    down (Feature.cpp:570), so a span standing on ground `g` decks at
    `g + deck_top` and an earthwork raises both by the same amount — the gap
    survived every terrain lever a generator has (PLAN-maps.md §2j). **§2j
    option A closed it at source on 2026-08-19** by re-authoring both spans
    with y = 0 ON the deck, so `deck_top` is now 0 and `g + deck_top` is `g`.
    These pin the two halves that could drift apart silently: what the def
    SAYS, and what the shipped mesh IS.
    """

    def test_reads_the_shipped_deck_tops(self):
        """Zero for both — the deck is the origin (§2j option A).

        This is the number that moved WITH the mesh. Were it left at the
        pier-base 1.5 / 3.8, every consumer would be adding an offset to a
        model that no longer has one and putting decks 1.5 and 3.8 elmos too
        high; `test_the_declared_deck_is_a_real_surface_in_the_mesh` is what
        catches that, and this is the value it catches it against.
        """
        self.assertEqual(ms_defs.feature_deck_top(GAME_DIR, "ms_road_bridge"), 0.0)
        self.assertEqual(ms_defs.feature_deck_top(GAME_DIR, "ms_rail_bridge"), 0.0)

    def test_zero_is_a_declaration_and_not_an_absence(self):
        """The one thing a shared-constant refactor would get wrong.

        Both spans now say 0, which looks like the case for hoisting the key
        into the shared `span()` posture or dropping it entirely. It is not:
        `feature_deck_top` RAISES on a def that does not declare one, and that
        raise is the only thing separating "this mesh's deck is at its origin"
        from "nobody has measured this mesh". A third span authored against a
        pier-base origin would need a non-zero number here on day one.
        """
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "features"))
            with open(os.path.join(d, "features", "bridges.lua"), "w") as fh:
                fh.write("return {\n"
                         "    declared = { customparams = { deck_top = '0' } },\n"
                         "    silent   = { customparams = { chain_pitch = '24' } },\n"
                         "}\n")
            self.assertEqual(ms_defs.feature_deck_top(d, "declared"), 0.0)
            with self.assertRaises(ValueError):
                ms_defs.feature_deck_top(d, "silent")

    def test_the_spans_may_disagree(self):
        """Why this is per-def and not a shared `span()` posture like the pitch.

        They agree today (0 and 0) only because A moved both origins in the
        same change, and that agreement is the trap: the number is a per-mesh
        fact, it was 1.5 vs 3.8 an hour before this test was written, and one
        shared number would have been 2.3 elmos wrong for one of them,
        silently. The reader must keep telling two spans apart even when the
        shipped pair happen to match.
        """
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "features"))
            with open(os.path.join(d, "features", "bridges.lua"), "w") as fh:
                fh.write("return {\n"
                         "    at_deck = { customparams = { deck_top = '0' } },\n"
                         "    at_pier = { customparams = { deck_top = '3.8' } },\n"
                         "}\n")
            self.assertEqual(ms_defs.feature_deck_top(d, "at_deck"), 0.0)
            self.assertEqual(ms_defs.feature_deck_top(d, "at_pier"), 3.8)

    def test_an_undeclared_def_raises(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "features"))
            with open(os.path.join(d, "features", "bridges.lua"), "w") as fh:
                fh.write("return { ms_road_bridge = { customparams = "
                         "{ chain_pitch = '24' } } }\n")
            with self.assertRaises(ValueError):
                ms_defs.feature_deck_top(d, "ms_road_bridge")

    def test_one_spans_deck_cannot_be_attributed_to_the_other(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "features"))
            with open(os.path.join(d, "features", "bridges.lua"), "w") as fh:
                # Four-space entries: `_split_top_level_entries` anchors on
                # `^\s{4}`, so a def indented any other way is invisible to
                # every reader in ms_defs. Every shipped def file obeys it.
                fh.write("return {\n"
                         "    a = { customparams = { deck_top = '1.5' } },\n"
                         "    b = { customparams = { deck_top = '3.8' } },\n"
                         "}\n")
            self.assertEqual(ms_defs.feature_deck_top(d, "a"), 1.5)
            self.assertEqual(ms_defs.feature_deck_top(d, "b"), 3.8)

    def test_the_origin_is_the_deck_and_the_substructure_is_below_it(self):
        """§2j option A, asked of the shipped mesh rather than of the def.

        The old form of this test asserted the opposite — min y == 0, the
        pier-base origin — precisely so it would FAIL the day A landed. It
        did. This is its replacement, and it fails just as loudly if a
        re-export ever puts the piers back on y = 0 while the defs still say
        the deck is the origin.

        The floors are authored metres; a mesh stamped
        SPRINGRTS_geometry.units == "elmos" carries the world-scale ×8
        (PLAN-world-scale.md §5 Option A), so the expectation scales with
        the stamp rather than assuming either convention.
        """
        for defname, floor in (("ms_road_bridge", -1.5), ("ms_rail_bridge", -3.8)):
            ys = [p[1] for p in _mesh_positions(defname)]
            self.assertAlmostEqual(min(ys), floor * _mesh_units_scale(defname),
                                   places=3, msg=defname)
            self.assertGreater(max(ys), 0.0, msg=defname)

    def test_the_declared_deck_is_a_real_surface_in_the_mesh(self):
        """Not just a plausible number: a full-width run of vertices at that y.

        What this CANNOT tell you: which full-width surface is the deck. The
        rail span's rail-head level (4.15) is 4.0 wide and would pass just as
        well as its deck (3.8) — that choice is a judgement recorded in the def,
        and this only catches a number that is nowhere in the mesh at all.
        """
        for defname, width in (("ms_road_bridge", 8.0), ("ms_rail_bridge", 3.5)):
            top = ms_defs.feature_deck_top(GAME_DIR, defname)
            at = [p for p in _mesh_positions(defname) if abs(p[1] - top) < 1e-3]
            self.assertTrue(at, f"{defname} has no vertex at y = {top}")
            xs = [p[0] for p in at]
            self.assertGreaterEqual(
                max(xs) - min(xs), width,
                f"{defname}'s y = {top} is not a full-width deck surface")


if __name__ == "__main__":
    unittest.main()
