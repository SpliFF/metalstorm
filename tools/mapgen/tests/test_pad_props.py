#!/usr/bin/env python3
"""Tests for LAYBYS — dressing a pad no yard was built on (roads R4c).

    cd tools/mapgen && .venv/bin/python -m unittest tests.test_pad_props

R4b prepared the ground and R4 put buildings on some of it; this is what stands
on the rest. What each test is here for:

  * **the pull-in stays clear.** The one rule here that is not a taste call: a
    layby is somewhere you pull off the road, so the half of the tarmac nearest
    the carriageway must hold nothing. Dressing that fills the whole pad is a
    decorated obstacle, and it looks *better* in a screenshot than the correct
    version does — which is exactly why it needs a measurement rather than an
    eye. Asserted against the published POLYLINE as well as in the pad's frame,
    because a flipped frame flips every parcel-local reading with it (R4b
    finding 4).
  * **a pad a yard took is never dressed.** The two placers stage from the same
    list, so without the exclusion a fence lands inside a depot's yard — and the
    overlap tests would hide most of it, leaving the visible failure rare and
    seed-dependent.
  * **nothing stands on the carriageway**, same acceptance rule as R4/R4b, and
    on the fixture that can actually violate it: R4b finding 2 — a pad is offset
    from its OWN link by half a width plus setback plus its depth, so the only
    way a prop reaches a deck is a DIFFERENT link's, i.e. a crossing.
  * **a prop stands on the tarmac.** The whole point of dressing a *pad* rather
    than a verge; measured in the pad's own frame, since a prop inside a
    diagonal pad's AABB can be standing in the field.
  * **the fence runs ALONG the road.** `ms_barricade_set` is a 208 x 48 elmo
    run and `_extent_of`'s swap decides which way it lies; a fence across the
    pull-in is a barrier, and every other assertion here passes with it.
  * **a kind with no content is reported by name.** This game ships no roadside
    sign; the alternative to saying so is a supply dump standing in for one on
    every layby on the map.
  * **a map with no pads draws no randomness**, which is the whole of
    GENERATOR_VERSION 6's claim that such a map is unchanged from v5.
"""
import math
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
import town_planner as tp                          # noqa: E402
import town_stager as tstage                       # noqa: E402
from scenario_templates import PAD_DRESSING        # noqa: E402
from terragen import package as pkg                # noqa: E402
from terragen import roads as rd                   # noqa: E402
from terragen import yards as yd                   # noqa: E402
from test_scenariogen import WIDE_ELMOS, wide_flat_map   # noqa: E402
from test_yards import CELL, RP, flat_net          # noqa: E402

GAME_DIR = os.path.join(REPO, "data", "games", "metalstorm")


class OpenGround:
    """A terrain that accepts everything — so the only rules left are this
    module's own. A stub rather than a real heightmap on purpose: with real
    terrain in the loop a dropped prop has two possible explanations, and the
    rules under test here are the geometric ones."""

    def footprint_clear(self, x, z, fx, fz, mclass):
        return True

    def passable(self, x, z, mclass):
        return True


class ClosedGround(OpenGround):
    def footprint_clear(self, x, z, fx, fz, mclass):
        return False

    def passable(self, x, z, mclass):
        return False


class Always:
    """An `rnd` that keeps every kind, so a test measures the layout rather than
    the odds. `random()` is the only method the placer uses."""

    def __init__(self):
        self.draws = 0

    def random(self):
        self.draws += 1
        return 0.0


def published(net, pads):
    """`(pad rows, link rows)` as the SCENARIO layer sees them.

    Through the real emitter and the real reader rather than hand-built dicts:
    the pad's away normal only exists as an integer heading in that file, and a
    hand-built row would test this module against a convention nothing else
    shares.
    """
    text = pkg.emit_roads_lua(net, CELL, RP, crossings=[], yards=pads)
    with tempfile.TemporaryDirectory() as t:
        os.makedirs(os.path.join(t, "mapdata"))
        with open(os.path.join(t, "mapdata", "roads.lua"), "w") as f:
            f.write(text)
        return sg.read_road_yards(t), sg.read_road_links(t)


def stage(rows, links, facts, *, rnd=None, terrain=None, budget=8,
          taken=(), occupied_rects=(), occupied_units=()):
    return rf.stage_pad_dressing(
        rnd or Always(), terrain or OpenGround(), facts, links, rows,
        PAD_DRESSING, mclass="VEH", occupied_rects=list(occupied_rects),
        occupied_units=list(occupied_units), footprint_gap=8.0, unit_gap=16.0,
        budget=budget, taken=set(taken))


def to_road(link, px, pz):
    return min(tp._point_seg_dist(px, pz, a, b)
               for a, b in zip(link["points"][:-1], link["points"][1:]))


class TheLayoutRule(unittest.TestCase):
    """The pull-in, the tarmac and the fence, on a map that published pads."""

    @classmethod
    def setUpClass(cls):
        cls.facts = ms_defs.load(GAME_DIR)
        h, cls.net, raster = flat_net()
        pads, _r = yd.plan_yard_pads(cls.net, h, raster, CELL, 0.0,
                                     road_params=RP)
        cls.rows, cls.links = published(cls.net, pads)
        assert cls.rows and cls.links

    def setUp(self):
        self.entries, self.notes = stage(self.rows, self.links, self.facts)
        self.by_key = {r["key"]: r for r in self.rows}

    def test_a_prepared_map_gets_its_spare_pads_dressed(self):
        self.assertTrue(self.entries, f"nothing was dressed; {self.notes}")
        for e in self.entries:
            self.assertTrue(e["props"], "an entry carries no props")

    def test_every_prop_stands_behind_the_pull_in(self):
        """Measured twice: in the pad's frame, and as a distance to the road.

        The second is the one a flipped frame cannot survive — flip the away
        normal and the parcel, the band and the prop all flip together, so every
        pad-local reading stays self-consistent and only the real carriageway
        can tell the two apart (R4b finding 4).
        """
        for e in self.entries:
            pad = self.by_key[e["pad"]]
            link = rf._pad_link(pad, self.links)
            ax, az = rf._away_of(pad)
            depth = 2.0 * pad["half_away"]
            near = to_road(link, pad["x"] - ax * pad["half_away"],
                           pad["z"] - az * pad["half_away"])
            for p in e["props"]:
                v = (p["x"] - pad["x"]) * ax + (p["z"] - pad["z"]) * az
                self.assertGreaterEqual(
                    v, -depth / 2.0 + rf.PULLIN_FRACTION * depth,
                    f"{p['def']} stands in {e['pad']}'s pull-in")
                self.assertGreater(
                    to_road(link, p["x"], p["z"]),
                    near + rf.PULLIN_FRACTION * depth - 1.0,
                    f"{p['def']} is nearer the carriageway than the pull-in "
                    f"band it must stand behind")

    def test_every_prop_stands_on_the_tarmac(self):
        """In the pad's own frame — a prop inside a diagonal pad's AABB can be
        standing in the field beside it."""
        for e in self.entries:
            pad = self.by_key[e["pad"]]
            ax, az = rf._away_of(pad)
            ux, uz = -az, ax                    # the along-road unit
            for p in e["props"]:
                f = self.facts[p["def"]]
                hx, hz = tstage._extent_of(p["facing"], f.footprint_x,
                                           f.footprint_z)
                lot = rf.pad_lot(pad)
                reach_u, reach_v = tstage._lot_projection(lot, hx, hz)
                du = abs((p["x"] - pad["x"]) * ux + (p["z"] - pad["z"]) * uz)
                dv = abs((p["x"] - pad["x"]) * ax + (p["z"] - pad["z"]) * az)
                self.assertLessEqual(du + reach_u, pad["half_along"] + 1.0,
                                     f"{p['def']} overhangs {e['pad']} along "
                                     f"the road")
                self.assertLessEqual(dv + reach_v, pad["half_away"] + 1.0,
                                     f"{p['def']} overhangs the back of "
                                     f"{e['pad']}")

    def test_the_fence_runs_along_the_road_not_across_it(self):
        """`ms_barricade_set` is a 208 x 48 run, and `_extent_of`'s swap is the
        only thing deciding which way it lies. Across the pull-in it is a
        barrier, and every other assertion in this file passes with it."""
        seen = 0
        for e in self.entries:
            pad = self.by_key[e["pad"]]
            ax, az = rf._away_of(pad)
            ux, uz = -az, ax
            for p in e["props"]:
                if p["kind"] != "fence":
                    continue
                seen += 1
                f = self.facts[p["def"]]
                hx, hz = tstage._extent_of(p["facing"], f.footprint_x,
                                           f.footprint_z)
                # The run's long axis in world terms, projected onto the road.
                long_x, long_z = (2.0 * hx, 0.0) if hx >= hz else (0.0, 2.0 * hz)
                along = abs(long_x * ux + long_z * uz)
                across = abs(long_x * ax + long_z * az)
                self.assertGreater(along, across,
                                   f"the fence on {e['pad']} lies across the "
                                   f"road rather than along it")
        self.assertTrue(seen, "no fence was staged — this test proves nothing")

    def test_a_prop_too_big_for_its_pad_is_left_off_it(self):
        """The containment rule, on a pad that can actually violate it.

        Every pad this generator plans is 560 elmos of frontage and every prop
        fits inside one with room over, so containment is unfalsifiable on
        generated input alone — the same shape of inertness R4b found in its
        first deck test. A published row with a narrow pad is a row the reader
        accepts (the pad's size is the MAP's to choose), and on it the 208-elmo
        fence does not fit.
        """
        row = dict(self.rows[0])
        row["half_along"] = 90.0
        row["key"] = "pad_narrow"
        entries, _n = stage([row], self.links, self.facts)
        staged = {p["def"] for e in entries for p in e["props"]}
        self.assertNotIn("ms_barricade_set", staged,
                         "a 208-elmo fence was staged on 180 elmos of pad")
        # ...and the positive control: on the pad's REAL width it is staged, so
        # the assertion above is about the width and not about the fence.
        wide, _n = stage([self.rows[0]], self.links, self.facts)
        self.assertIn("ms_barricade_set",
                      {p["def"] for e in wide for p in e["props"]})

    def test_a_prop_that_would_reach_into_the_pull_in_is_dropped(self):
        """The pull-in rule as a RULE, not as a consequence of the layout.

        On a default 600-elmo pad `_band_v` puts every band behind the pull-in
        by construction, so the guard refuses nothing and deleting it changes no
        placement — an assertion about positions measures the layout, not the
        rule. A SHALLOW published pad is where the two part: the back band's own
        item is then deeper than the space behind the pull-in, and the guard is
        the only thing keeping the tarmac a lorry stops on clear. Built by
        moving a real row in toward its own road so the reader still accepts it,
        which is what a map publishing a shallow pad would look like.
        """
        row = dict(self.rows[0])
        ax, az = rf._away_of(row)
        shrink = row["half_away"] - 60.0
        row.update(key="pad_shallow", half_away=60.0,
                   x=row["x"] - ax * shrink, z=row["z"] - az * shrink)
        rf._pad_link(row, self.links)          # still a row the reader accepts
        entries, _n = stage([row], self.links, self.facts)
        depth = 2.0 * row["half_away"]
        for e in entries:
            for p in e["props"]:
                v = (p["x"] - row["x"]) * ax + (p["z"] - row["z"]) * az
                f = self.facts[p["def"]]
                hx, hz = tstage._extent_of(p["facing"], f.footprint_x,
                                           f.footprint_z)
                _ru, reach_v = tstage._lot_projection(rf.pad_lot(row), hx, hz)
                self.assertGreaterEqual(
                    v - reach_v, -depth / 2.0 + rf.PULLIN_FRACTION * depth - 1.0,
                    f"{p['def']} reaches into a shallow pad's pull-in")
        # ...and the fixture really does offer something that would: the fence
        # is staged on the same pad at its real depth and dropped at this one.
        self.assertNotIn("ms_barricade_set",
                         {p["def"] for e in entries for p in e["props"]})
        deep, _n = stage([self.rows[0]], self.links, self.facts)
        self.assertIn("ms_barricade_set",
                      {p["def"] for e in deep for p in e["props"]})

    def test_a_pad_a_yard_took_is_not_dressed(self):
        """Without the exclusion a fence lands inside a depot's yard."""
        first = self.entries[0]["pad"]
        entries, _n = stage(self.rows, self.links, self.facts, taken=[first])
        self.assertNotIn(first, [e["pad"] for e in entries])
        self.assertTrue(entries, "excluding one pad emptied the whole layer")

    def test_ground_that_is_already_taken_takes_no_props(self):
        """The overlap rule, as a positive and a negative in one test: a rect
        over the whole map drops everything, and the note says a pad stayed
        empty rather than the layer silently reporting nothing."""
        whole_map = [(-1e6, -1e6, 1e6, 1e6)]
        entries, notes = stage(self.rows, self.links, self.facts,
                               occupied_rects=whole_map)
        self.assertEqual(entries, [])
        self.assertTrue(any("stayed empty" in n for n in notes), notes)

    def test_unbuildable_ground_takes_no_props(self):
        entries, notes = stage(self.rows, self.links, self.facts,
                               terrain=ClosedGround())
        self.assertEqual(entries, [])
        self.assertTrue(any("stayed empty" in n for n in notes), notes)

    def test_the_budget_bounds_how_many_laybys_are_dressed(self):
        entries, _n = stage(self.rows, self.links, self.facts, budget=1)
        self.assertEqual(len(entries), 1)
        self.assertGreater(len(self.entries), 1,
                           "the unbudgeted run dressed one pad anyway, so the "
                           "budget assertion above is vacuous")

    def test_a_kind_with_no_content_is_reported_by_name(self):
        """This game ships no roadside sign. The alternative to saying so is a
        supply dump standing in for one on every layby on the map."""
        rows, gaps = rf.resolve_dressing(PAD_DRESSING, self.facts)
        self.assertIn("sign", gaps)
        self.assertNotIn("sign", [r["kind"] for r in rows])
        self.assertTrue(any("sign" in n for n in self.notes),
                        f"the gap never reached the report: {self.notes}")
        # ...and the positive: every other kind DOES resolve, or the gap report
        # is just describing an empty table.
        self.assertGreaterEqual(len(rows), 3, rows)
        for r in rows:
            self.assertIn(r["defname"], self.facts)

    def test_a_pad_naming_a_link_that_is_not_its_own_is_refused_by_name(self):
        row = dict(self.rows[0])
        row["link"] = 99
        _e, notes = stage([row], self.links, self.facts)
        self.assertTrue(any(row["key"] in n and "link" in n for n in notes),
                        notes)


class TheDeckIsNeverDressed(unittest.TestCase):
    """R4b finding 2, one layer further in — and the answer is different.

    A prop stands inside a pad, and `terragen.yards` already refuses any pad
    that covers a carriageway, so **no pad this generator plans can put a prop
    on a deck**: the rule is unreachable from generated input, which is what
    made R4b's first deck test inert. It is kept anyway because the pad rows are
    READ FROM A FILE this layer does not own — a hand-edited `mapdata/roads.lua`,
    a map from another generator, or a future planner that publishes pads
    without re-testing them — and a prop on a carriageway severs the route
    silently. So the fixture below FABRICATES the violation (a published row
    slid along its own link until it straddles the crossing road, which
    `_pad_link` accepts because the distance to its own link is unchanged) and
    checks both that the rule refuses it and that the fixture really can produce
    it.
    """

    def setUp(self):
        self.facts = ms_defs.load(GAME_DIR)
        elmos = 3200.0
        n = int(elmos / CELL)
        h = np.full((n, n), 60.0)
        ew = np.array([[200.0, 1600.0], [3000.0, 1600.0]])
        ns = np.array([[1600.0, 200.0], [1600.0, 3000.0]])
        self.net = rd.RoadNetwork(
            links=[rd.RoadLink(ew, rd.ROAD_HIGHWAY, 0, 1),
                   rd.RoadLink(ns, rd.ROAD_HIGHWAY, 2, 3)],
            junctions=[(1600.0, 1600.0)])
        raster = rd.rasterize_network(self.net, h.shape, CELL, RP)
        # No junction keepout and a pitch that stations a pad right beside the
        # crossing: the deck test is then the only rule that can refuse a prop.
        p = yd.YardParams(pitch=340.0, junction_keepout=0.0, max_pads=40,
                          per_link=20)
        pads, _r = yd.plan_yard_pads(self.net, h, raster, CELL, 0.0, params=p,
                                     road_params=RP)
        self.rows, self.links = published(self.net, pads)
        self.assertTrue(self.rows)

    def test_no_prop_stands_on_any_carriageway(self):
        entries, _n = stage(self.rows, self.links, self.facts, budget=99)
        self.assertTrue(entries)
        checked = 0
        for e in entries:
            for p in e["props"]:
                f = self.facts[p["def"]]
                hx, hz = tstage._extent_of(p["facing"], f.footprint_x,
                                           f.footprint_z)
                rect = rf._rect(float(p["x"]), float(p["z"]), hx, hz)
                for link in self.links:
                    checked += 1
                    self.assertTrue(
                        rf._clears_deck(rect, link),
                        f"{p['def']} on {e['pad']} stands on a carriageway")
        self.assertTrue(checked)

    def _straddling_row(self) -> dict:
        """A published pad row slid ALONG its own link until it lies across the
        other road. Sliding along the link leaves its distance to that link
        unchanged, so `_pad_link` still recognises it — which is what makes this
        a row the reader would accept from a file rather than a nonsense one."""
        row = next(dict(r) for r in self.rows if r["link"] == 1)
        row["z"] = 1600.0                      # the crossing's own z
        row["key"] = "pad_straddle"
        return row

    def test_a_prop_that_would_stand_on_the_crossing_road_is_dropped(self):
        row = self._straddling_row()
        # The fixture is violable: the back band at u = 0 is ON the other deck.
        lot = rf.pad_lot(row)
        _along, away = tstage._lot_frame(lot)
        x = lot.x + away[0] * (lot.depth / 2.0 - rf.EDGE_INSET)
        z = lot.z + away[1] * (lot.depth / 2.0 - rf.EDGE_INSET)
        ew = self.links[0]
        self.assertFalse(rf._clears_deck(rf._rect(x, z, 104.0, 24.0), ew),
                         "the fabricated pad does not reach the other road, so "
                         "this test cannot exercise the rule it exists for")
        self.assertIsNotNone(rf._pad_link(row, self.links),
                             "the reader would have refused this row for its "
                             "link geometry, so the deck rule is not what is "
                             "under test")
        entries, _n = stage([row], self.links, self.facts)
        for e in entries:
            for p in e["props"]:
                f = self.facts[p["def"]]
                hx, hz = tstage._extent_of(p["facing"], f.footprint_x,
                                           f.footprint_z)
                rect = rf._rect(float(p["x"]), float(p["z"]), hx, hz)
                self.assertTrue(rf._clears_deck(rect, ew),
                                f"{p['def']} stands on the crossing road")


class APadlessMapIsUnchanged(unittest.TestCase):
    def test_no_pads_means_no_draws_and_no_entries(self):
        """GENERATOR_VERSION 6's claim, as a measurement: a map that publishes
        no pads must consume nothing from the seeded stream, or every placement
        after this point on every shipped map moves for a feature that did not
        run."""
        facts = ms_defs.load(GAME_DIR)
        rnd = Always()
        entries, notes = stage([], [], facts, rnd=rnd)
        self.assertEqual(entries, [])
        self.assertEqual(rnd.draws, 0)
        # The content-gap note is still emitted: it is a fact about this game's
        # roster, not about this map.
        self.assertTrue(any("sign" in n for n in notes), notes)


class StagedThroughGenerate(unittest.TestCase):
    """The whole seam, through `generate`, on a map that published pads."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.map_dir = wide_flat_map(cls.tmp.name, "synth_laybys")
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

    def test_a_spare_pad_is_dressed(self):
        self.assertTrue(self.meta["laybys"],
                        f"no layby dressed; {self.meta['layby_notes']}")

    def test_the_props_reach_the_file(self):
        """On the FILE, not on the meta: a prop that never reached the Lua is a
        prop the game does not have (R3b finding 1)."""
        self.assertIn("LAYBYS", self.lua)
        block = self._block()
        self.assertTrue(any("def = " in ln for ln in block.splitlines()))

    def test_a_dressed_pad_is_never_a_pad_a_yard_took(self):
        built = set(self.meta["frontage_pads"].values())
        dressed = {row[0] for row in self.meta["laybys"]}
        self.assertTrue(built, "no yard stood on a pad, so this proves nothing")
        self.assertEqual(built & dressed, set())

    def test_every_prop_in_the_file_stands_on_the_pad_it_dressed(self):
        """Scoped to the LAYBYS block, per R4b finding 3: `ms_supply_dump` is
        content the town planner stages too, so a file-wide search for its def
        name measures somebody else's building."""
        by_key = {f"pad_{i}": p for i, p in enumerate(self.pads)}
        dressed = {row[0]: row[2] for row in self.meta["laybys"]}
        current = None
        found = 0
        for line in self._block().splitlines():
            # ANY comment line closes the current layby, not just the next
            # marker: the emitted `units` table continues past this section (the
            # relic guardians follow it), and a parser that only ever SETS
            # `current` attributes somebody else's building to the last layby —
            # which is R4b finding 3 wearing a different hat.
            if line.strip().startswith("--"):
                current = (line.split("-- layby ")[1].split(" ")[0]
                           if "-- layby " in line else None)
                continue
            if "def = " not in line or current is None:
                continue
            pad = by_key[current]
            x = float(line.split("x = ")[1].split(",")[0])
            z = float(line.split("z = ")[1].split(",")[0])
            ux, uz = pad.along
            ax, az = pad.away
            du = abs((x - pad.x) * ux + (z - pad.z) * uz)
            dv = abs((x - pad.x) * ax + (z - pad.z) * az)
            self.assertLessEqual(du, pad.half_along,
                                 f"a prop overhangs {current} along the road")
            self.assertLessEqual(dv, pad.half_away,
                                 f"a prop overhangs the back of {current}")
            # ...and the pull-in, which is what makes it a layby.
            self.assertGreaterEqual(
                (x - pad.x) * ax + (z - pad.z) * az,
                -pad.half_away + rf.PULLIN_FRACTION * 2.0 * pad.half_away,
                f"a prop stands in {current}'s pull-in")
            found += 1
        self.assertEqual(found, sum(dressed.values()),
                         "the file and the report disagree about how many "
                         "props were staged")

    def test_the_same_seed_stages_the_same_laybys(self):
        lua2, meta2 = sg.generate(self.map_dir, seed=7, game_dir=GAME_DIR)
        self.assertEqual(meta2["laybys"], self.meta["laybys"])
        self.assertEqual(lua2, self.lua)

    def test_the_content_gap_is_reported_in_the_scenario(self):
        self.assertTrue(any("sign" in n for n in self.meta["layby_notes"]),
                        self.meta["layby_notes"])

    def _block(self) -> str:
        head = self.lua.find("LAYBYS")
        self.assertGreater(head, 0, "the layby section is not in the file")
        return self.lua[head:self.lua.find("\n    },", head)]


if __name__ == "__main__":
    unittest.main()
