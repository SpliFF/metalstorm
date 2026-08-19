#!/usr/bin/env python3
"""Tests for the town populace (.tasks/desc/town-planner-T4).

    python3 -m unittest discover -s tools/mapgen/tests

Same substrate as `test_town_planner.py` and `test_town_stager.py`, for the same
reason: synthetic terrain from `demo_probe`, because `data/maps/` is gitignored
and a suite that cannot run in a clone is not a suite. The terrain is faked; the
slope grading, the real `ms_defs` footprints read out of the shipped def files,
the planner, the stager and the placer are all real.

THIS SUITE CAN NAME ITS DEFS, AND IT IS THE ONLY ONE OF THE FOUR THAT CAN.
`test_town_stager`'s header explains at length why it asserts on roles rather
than def names — the briefed M2/M3 content is not readable from this clone. The
populace roster has no such problem: `ms_civilians`, `ms_militia`, `ms_civtruck`
and `ms_civbus` are all in data/games/metalstorm/units/ today. So where the
stager suite must say "the unique role", this one can say `ms_militia` and mean
it.

Two things the brief asks this step to prove, and they are the two big classes
below: seeded determinism, and a POPULACE VALIDITY SPEC — nobody inside a
footprint, nobody on top of anybody else, nobody off the map or outside their
own town. `validate_populace` is that spec; most of what follows either runs it
over a sweep or pins one specific way of violating it that was actually observed
and fixed.
"""

import dataclasses
import math
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
MAPGEN = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(MAPGEN, "..", ".."))
sys.path.insert(0, MAPGEN)

import ms_defs                                                   # noqa: E402
import town_planner as tp                                        # noqa: E402
import town_populace as tpop                                     # noqa: E402
import town_stager as ts                                         # noqa: E402
import town_templates as tt                                      # noqa: E402

GAME_DIR = os.path.join(REPO, "data", "games", "metalstorm")
DEMO_W = DEMO_H = 385
RADIUS = 900

_FACTS = None
_PROBES: dict = {}
_SWEEPS: dict = {}


def facts():
    global _FACTS
    if _FACTS is None:
        _FACTS = ms_defs.load(GAME_DIR)
    return _FACTS


def probe_for(kind: str):
    if kind not in _PROBES:
        _PROBES[kind] = tp.demo_probe(kind, W=DEMO_W, H=DEMO_H, seed=1)
    return _PROBES[kind]


def town_of(kind: str, seed: int, **kw):
    """Plan, stage and populate in one go. Returns (town, staged, pop, probe)."""
    probe = probe_for(kind)
    c = (probe.W - 1) * probe.elmos / 2.0
    town = tp.plan_town(seed, probe, c, c, kw.pop("radius", RADIUS),
                        search=RADIUS, **kw)
    staged = ts.stage_town(town, facts(), probe=probe)
    return town, staged, tpop.populate_town(town, staged, facts(),
                                            probe=probe), probe


def sweep(seeds=range(1, 9), kinds=("flat", "rolling", "valley", "coast")):
    """Every archetype on every terrain. Sites that refuse are skipped.

    Cached on its arguments, because a dozen tests want the same sweep.
    Determinism is what makes the cache sound — it is the first thing this file
    asserts — and no test mutates what it is handed.
    """
    key = (tuple(seeds), tuple(kinds))
    if key not in _SWEEPS:
        out = []
        for kind in kinds:
            for seed in seeds:
                try:
                    out.append(town_of(kind, seed))
                except tp.SiteRejected:
                    continue
        _SWEEPS[key] = out
    return _SWEEPS[key]


class PopulaceCase(unittest.TestCase):
    def setUp(self):
        if not os.path.isdir(GAME_DIR):
            self.skipTest(f"no game content at {GAME_DIR}")


# ==========================================================================

class TestDeterminism(PopulaceCase):
    """Same town, same staging, same seed => byte-identical populace."""

    def test_the_same_inputs_produce_the_same_people(self):
        town, staged, _pop, probe = town_of("rolling", 3)
        a = tpop.populate_town(town, staged, facts(), probe=probe)
        b = tpop.populate_town(town, staged, facts(), probe=probe)
        self.assertEqual(a.to_json(), b.to_json())

    def test_a_different_seed_produces_different_people(self):
        town, staged, _pop, probe = town_of("rolling", 3)
        a = tpop.populate_town(town, staged, facts(), seed=1, probe=probe)
        b = tpop.populate_town(town, staged, facts(), seed=2, probe=probe)
        self.assertNotEqual(a.to_json(), b.to_json())

    def test_the_populace_seed_is_independent_of_the_stager_stream(self):
        """A populace draw must not move a single building.

        The reason `POPULACE_SALT` exists. Sharing the stager's rng would mean
        that adding a fifth populace kind re-rolled every building in every town
        in every generated scenario — T2's and T3's measured placements would
        all move for a reason unrelated to them.
        """
        town, staged, _pop, probe = town_of("rolling", 5)
        before = staged.to_json()
        tpop.populate_town(town, staged, facts(), probe=probe)
        self.assertEqual(before, staged.to_json())

    def test_nothing_that_reaches_output_iterates_a_dict(self):
        """The determinism rule, checked on the emitted text rather than by eye."""
        _t, _s, pop, _p = town_of("flat", 4)
        kinds = [k for k, _n in pop.kind_counts()]
        self.assertEqual(kinds, tt.POPULACE_ORDER)
        names = [n for n, _c in pop.def_counts()]
        self.assertEqual(names, sorted(names, key=lambda n: (
            -dict(pop.def_counts())[n], n)))


# ==========================================================================

class TestThePopulaceSpec(PopulaceCase):
    """`validate_populace` over a sweep, plus each way of breaking it."""

    def test_every_town_in_the_sweep_is_clean(self):
        towns = sweep()
        self.assertGreater(len(towns), 20, "sweep planned too few towns to mean much")
        problems = []
        for town, staged, pop, probe in towns:
            for p in tpop.validate_populace(pop, town, staged, probe):
                problems.append(f"{town.key}: {p}")
        self.assertEqual([], problems)

    def test_it_catches_a_civilian_standing_in_a_building(self):
        town, staged, pop, probe = town_of("flat", 2)
        victim = staged.of_category("building")[0]
        moved = dataclasses.replace(pop.residents[0], x=victim.x, z=victim.z)
        broken = dataclasses.replace(pop, residents=(moved,) + pop.residents[1:])
        problems = tpop.validate_populace(broken, town, staged, probe)
        self.assertTrue(any("overlaps" in p for p in problems), problems)

    def test_it_catches_two_civilians_on_one_patch_of_ground(self):
        town, staged, pop, probe = town_of("flat", 2)
        a = pop.residents[0]
        clone = dataclasses.replace(pop.residents[1], x=a.x + 4, z=a.z + 4)
        broken = dataclasses.replace(
            pop, residents=(a, clone) + pop.residents[2:])
        problems = tpop.validate_populace(broken, town, staged, probe)
        self.assertTrue(any("would not spawn" in p for p in problems), problems)

    def test_it_catches_a_civilian_off_the_map(self):
        town, staged, pop, probe = town_of("flat", 2)
        strayed = dataclasses.replace(pop.residents[0], x=-500, z=-500)
        broken = dataclasses.replace(pop, residents=(strayed,))
        problems = tpop.validate_populace(broken, town, staged, probe)
        self.assertTrue(any("off the map" in p for p in problems), problems)

    def test_it_catches_a_civilian_outside_its_own_town(self):
        town, staged, pop, probe = town_of("flat", 2)
        far = dataclasses.replace(pop.residents[0],
                                  x=town.x + 4000, z=town.z + 4000)
        broken = dataclasses.replace(pop, residents=(far,))
        problems = tpop.validate_populace(broken, town, staged, probe)
        self.assertTrue(any("outside" in p for p in problems), problems)

    def test_it_catches_a_duplicate_key(self):
        town, staged, pop, probe = town_of("flat", 2)
        a = pop.residents[0]
        twin = dataclasses.replace(pop.residents[1], key=a.key)
        broken = dataclasses.replace(pop, residents=(a, twin))
        problems = tpop.validate_populace(broken, town, staged, probe)
        self.assertTrue(any("duplicate" in p for p in problems), problems)

    def test_a_walled_towns_boundary_is_its_WALL_and_not_its_hull(self):
        """Found by this spec, on valley/seed 1, and fixed here.

        `_simplify_hull` extends the lots' hull OUTWARD to build the wall line,
        so on a walled town the two are different polygons and the ground
        between them — where a gateway militiaman stands — is real town. The
        hull test called him a stray.
        """
        walled = [t for t in sweep() if t[0].wall_line]
        if not walled:
            self.skipTest("no walled town in the sweep")
        for town, staged, pop, probe in walled:
            hull = list(town.hull)
            outside_hull = [r for r in pop.residents
                            if not tp._point_in_polygon(r.x, r.z, hull)]
            # Whether any town actually has one is terrain-dependent; what must
            # hold is that everybody is inside the WALL either way.
            for r in outside_hull:
                self.assertTrue(
                    tp._point_in_polygon(r.x, r.z, list(town.wall_line)),
                    f"{r.key} is outside {town.key}'s wall, not merely its hull")
            self.assertEqual([], tpop.validate_populace(pop, town, staged, probe))


# ==========================================================================

class TestWhereEachKindGoes(PopulaceCase):
    """The four siting rules, each doing the thing its name claims."""

    def test_traffic_stands_on_a_through_street_and_nothing_else_does(self):
        """The one placement in this toolchain that WANTS the carriageway."""
        found = False
        for town, staged, pop, _probe in sweep():
            streets = {s.key: s for s in town.streets}
            for r in pop.of_kind("traffic"):
                found = True
                self.assertEqual("carriageway", r.spot)
                street = streets[r.street]
                self.assertIn(street.kind, tt.POPULACE["traffic"]["street_kinds"])
                # ...and it really is on the line, not merely attributed to it.
                d = min(math.hypot(r.x - px, r.z - pz)
                        for px, pz in street.points)
                self.assertLess(d, street.length())
        self.assertTrue(found, "no traffic anywhere in the sweep")

    def test_residents_stand_between_their_building_and_the_road(self):
        for town, staged, pop, _probe in sweep():
            lots = {l.key: l for l in town.lots}
            for r in pop.of_kind("residents"):
                self.assertEqual("shoulder", r.spot)
                lot = lots[r.lot]
                reach = tpop._shoulder_reach(town, lot)
                # Measured along the lot's own away-from-street axis: a resident
                # is in front of the frontage line and no further out than the
                # carriageway's centreline.
                _along, away = ts._lot_frame(lot)
                depth = ((r.x - lot.x) * away[0] + (r.z - lot.z) * away[1])
                self.assertLessEqual(depth, -lot.depth / 2.0 + 1)
                self.assertGreaterEqual(depth, -lot.depth / 2.0 - reach - 1)

    def test_a_market_lot_gets_a_crowd_and_not_one_person(self):
        crowded = 0
        for town, staged, pop, _probe in sweep():
            by_lot: dict = {}
            for r in pop.of_kind("market"):
                by_lot[r.lot] = by_lot.get(r.lot, 0) + 1
            if by_lot and max(by_lot.values()) > 1:
                crowded += 1
        self.assertGreater(crowded, 0, "no market lot in the sweep drew a crowd")

    def test_militia_appear_only_on_a_town_that_built_a_wall(self):
        seen_walled = 0
        for town, staged, pop, _probe in sweep():
            militia = pop.of_kind("militia")
            if town.defense == "open":
                self.assertEqual([], militia,
                                 f"{town.key} is open but posted militia")
            elif militia:
                seen_walled += 1
                for r in militia:
                    self.assertEqual("gateway", r.spot)
                    self.assertEqual("ms_militia", r.defname)
        self.assertGreater(seen_walled, 0, "no walled town in the sweep")

    def test_militia_stand_INSIDE_the_gateway_not_in_it(self):
        """A `garrison` civilian is never moved, so one left in the opening
        would block the road the gateway exists to let through for the whole
        match."""
        for town, staged, pop, _probe in sweep():
            gates = {g.key: g for g in town.gateways()}
            for r in pop.of_kind("militia"):
                gap = next(g for k, g in gates.items() if k in r.key)
                self.assertGreaterEqual(
                    math.hypot(r.x - gap.x, r.z - gap.z),
                    tpop.GATEWAY_INSETS[0] - 1)

    def test_parked_vehicles_belong_to_a_utility_or_poi_lot(self):
        for town, staged, pop, _probe in sweep():
            roles = {p.lot: p.role for p in staged.of_category("building")}
            for r in pop.of_kind("parked"):
                self.assertIn(roles[r.lot], tt.POPULACE["parked"]["lot_roles"])
                self.assertIn(r.spot, ("yard", "shoulder"))


# ==========================================================================

class TestTheRegistryContract(PopulaceCase):
    """What the emitted entries mean to game_civilians.lua."""

    def test_militia_are_a_garrison_and_everybody_else_is_ambient(self):
        """`ambient` is what routines.lua wanders and estate.lua counts.

        A militiaman registered ambient walks off the gate on the next tick and
        is counted as the population a protect objective is about; both are
        wrong, and neither errors.
        """
        for _t, _s, pop, _p in sweep():
            for r in pop.residents:
                want = "garrison" if r.kind == "militia" else "ambient"
                self.assertEqual(want, r.registry_role, r.key)

    def test_scenario_civilians_carry_their_town_as_the_district(self):
        town, staged, pop, _probe = town_of("rolling", 3)
        entries = pop.scenario_civilians()
        self.assertEqual(len(entries), pop.head_count())
        for e in entries:
            self.assertEqual(town.key, e["town"])
            self.assertIn(e["role"], ("ambient", "garrison"))
            self.assertIn(e["facing"], ts.FACING_ORDER)
            self.assertEqual(sorted(e), ["def", "facing", "role", "town", "x", "z"])

    def test_every_populace_def_actually_ships(self):
        """The claim this suite's header makes, asserted rather than assumed."""
        named = sorted({d for k in tt.POPULACE_ORDER
                        for d, _w in tt.POPULACE[k]["defs"]})
        self.assertEqual([], ms_defs.verify(facts(), named))

    def test_a_game_with_no_civilian_content_reports_the_gap_by_name(self):
        town, staged, _pop, probe = town_of("flat", 2)
        pop = tpop.populate_town(town, staged, facts(), probe=probe,
                                 options={})
        self.assertEqual(0, pop.head_count())
        self.assertEqual(len(tt.POPULACE_ORDER), len(pop.gaps))
        self.assertTrue(any("ms_militia" in g for g in pop.gaps), pop.gaps)


# ==========================================================================

class TestSizeAndVariety(PopulaceCase):
    """"Randomised but INTERESTING" — measured, not asserted by eye."""

    def test_no_town_exceeds_the_population_ceiling(self):
        for _t, _s, pop, _p in sweep():
            self.assertLessEqual(pop.head_count(), tt.MAX_POPULACE)

    def test_the_ceiling_drops_residents_and_says_so(self):
        capped = [p for _t, _s, p, _pr in sweep()
                  if any(k == "residents" for _w, k, why in p.dropped
                         if "ceiling" in why)]
        if not capped:
            self.skipTest("no town in the sweep hit the ceiling")
        for pop in capped:
            self.assertEqual(tt.MAX_POPULACE, pop.head_count())

    def test_towns_differ_from_each_other(self):
        shapes = {tuple(pop.kind_counts()) for _t, _s, pop, _p in sweep()}
        self.assertGreater(len(shapes), 8,
                           "the sweep's towns are all populated alike")

    def test_a_town_is_mostly_people_rather_than_vehicles(self):
        """A town whose streets are half lorries reads as a depot."""
        people = vehicles = 0
        for _t, _s, pop, _p in sweep():
            for r in pop.residents:
                if r.defname in ("ms_civtruck", "ms_civbus"):
                    vehicles += 1
                else:
                    people += 1
        self.assertGreater(people, vehicles)

    def test_both_vehicle_defs_occur_across_the_sweep(self):
        seen = {r.defname for _t, _s, pop, _p in sweep()
                for r in pop.residents}
        self.assertIn("ms_civtruck", seen)
        self.assertIn("ms_civbus", seen)

    def test_every_drop_names_the_kind_and_a_reason(self):
        for _t, _s, pop, _p in sweep():
            for what, kind, why in pop.dropped:
                self.assertIn(kind, tt.POPULACE_ORDER)
                self.assertTrue(what and why)


# ==========================================================================

class TestCLI(PopulaceCase):
    def test_check_mode_runs_and_reports_clean(self):
        r = subprocess.run(
            [sys.executable, os.path.join(MAPGEN, "town_populace.py"),
             "--demo", "rolling", "--seed", "3", "--check",
             "--game-dir", GAME_DIR],
            capture_output=True, text=True, timeout=180)
        self.assertEqual(0, r.returncode, r.stderr)
        self.assertIn("populace spec: clean", r.stdout)

    def test_lua_mode_emits_a_pure_table_literal(self):
        r = subprocess.run(
            [sys.executable, os.path.join(MAPGEN, "town_populace.py"),
             "--demo", "rolling", "--seed", "3", "--lua",
             "--game-dir", GAME_DIR],
            capture_output=True, text=True, timeout=180)
        self.assertEqual(0, r.returncode, r.stderr)
        self.assertTrue(r.stdout.startswith("return {"))
        for banned in ("require", "Spring.", "function"):
            self.assertNotIn(banned, r.stdout)


if __name__ == "__main__":
    unittest.main()
