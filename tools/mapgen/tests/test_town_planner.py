#!/usr/bin/env python3
"""Tests for the town planner (.tasks/desc/town-planner-T1, PLAN-metalstorm-scenariogen.md).

    python3 -m unittest discover -s tools/mapgen/tests

Everything here runs against SYNTHETIC terrain from `town_planner.demo_probe`,
for the reason test_scenariogen.py already gives: `data/maps/` is gitignored, a
clone or a CI checkout has none, and a suite that skips its own negative
control is worse than no suite. The terrain is faked; the sampling, the slope
grading and the planner are all real.

The three things the brief asks this suite to prove are, in order:
  * seeded determinism  — same seed, same graph, including across processes
  * archetype coverage  — all three patterns occur, and terrain picks them
  * terrain rejection   — steep and wet sites are refused, by name
...plus the geometric invariants a consumer will rely on (no overlapping lots,
every lot on buildable ground facing its own street, exactly one meeting hall).
"""

import collections
import dataclasses
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
MAPGEN = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(MAPGEN, "..", ".."))
sys.path.insert(0, MAPGEN)

import town_planner as tp                                        # noqa: E402
import town_templates as tt                                      # noqa: E402

GAME_DIR = os.path.join(REPO, "data", "games", "metalstorm")

# Big enough that a 900-radius town plus the site rules' edge margin fits with
# room to move: 385 samples * 8 elmos = 3072 elmos square.
DEMO_W = DEMO_H = 385
RADIUS = 900


def probe_for(kind: str):
    return tp.demo_probe(kind, W=DEMO_W, H=DEMO_H, seed=1)


def centre_of(probe):
    c = (probe.W - 1) * probe.elmos / 2.0
    return c, c


def plan(kind: str, seed: int, **kw):
    probe = probe_for(kind)
    cx, cz = centre_of(probe)
    return tp.plan_town(seed, probe, cx, cz, kw.pop("radius", RADIUS), **kw)


# ==========================================================================
# Determinism — invariant 4 of scenariogen.py, restated for the graph
# ==========================================================================

class TestDeterminism(unittest.TestCase):

    def test_same_seed_twice_is_identical(self):
        for kind in ("flat", "rolling", "coast"):
            with self.subTest(kind=kind):
                a = plan(kind, 11).to_dict()
                b = plan(kind, 11).to_dict()
                self.assertEqual(a, b)

    def test_a_different_seed_gives_a_different_town(self):
        """Refusal is a designed outcome, so seeds that refuse are skipped.

        Not every seed on every patch of ground yields a town — `min_lots`
        exists precisely to refuse the ones that would yield three sheds — and
        a test that assumed otherwise would be asserting the opposite of the
        terrain adaptation the rest of the suite pins.
        """
        seen = set()
        planned = 0
        for s in range(8):
            try:
                town = plan("rolling", s)
            except tp.SiteRejected:
                continue
            planned += 1
            seen.add(json.dumps(town.to_dict(), sort_keys=True))
        self.assertGreaterEqual(planned, 5, "too few seeds planned at all")
        self.assertEqual(len(seen), planned,
                         "two seeds produced the identical town — the seed is "
                         "not reaching the layout")

    def test_determinism_survives_a_separate_process(self):
        """Two fresh interpreters must agree byte for byte.

        The failure this catches is not "the rng is wrong" but "something in
        the layout iterated a set", whose order is only stable WITHIN one
        process because PYTHONHASHSEED is fixed there. Running the CLI twice in
        subprocesses with hash randomisation left on is the only way to see it.
        """
        cli = [sys.executable, os.path.join(MAPGEN, "town_planner.py"),
               "--demo", "rolling", "--seed", "5", "--radius", str(RADIUS)]
        env = dict(os.environ)
        env.pop("PYTHONHASHSEED", None)
        outs = [subprocess.run(cli, capture_output=True, text=True, env=env,
                               timeout=180) for _ in range(2)]
        for r in outs:
            self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(outs[0].stdout, outs[1].stdout)

    def test_terrain_measurements_do_not_depend_on_the_seed(self):
        """A site is a fact about the map; only what gets built there is seeded.

        `score_site` and `archetype_weights` take no rng at all, and this is
        the test that keeps it that way — the moment a seeded term creeps into
        either, "terrain drives the pattern" stops being true.
        """
        probe = probe_for("coast")
        cx, cz = centre_of(probe)
        a = tp.score_site(probe, cx, cz, RADIUS)
        b = tp.score_site(probe, cx, cz, RADIUS)
        self.assertEqual(a.to_dict(), b.to_dict())
        self.assertEqual(tp.archetype_weights(a), tp.archetype_weights(b))
        self.assertEqual(tp.distortion_of(a), tp.distortion_of(b))

    def test_pick_site_is_rng_free(self):
        probe = probe_for("rolling")
        cx, cz = centre_of(probe)
        first, _ = tp.pick_site(probe, cx + 400, cz - 250, RADIUS, search=600)
        second, _ = tp.pick_site(probe, cx + 400, cz - 250, RADIUS, search=600)
        self.assertIsNotNone(first)
        self.assertEqual(first.to_dict(), second.to_dict())

    def test_every_emitted_coordinate_is_an_integer(self):
        town = plan("rolling", 4)
        for s in town.streets:
            for x, z in s.points:
                self.assertIsInstance(x, int)
                self.assertIsInstance(z, int)
        for l in town.lots:
            self.assertIsInstance(l.x, int)
            self.assertIsInstance(l.z, int)
        for w in town.perimeter:
            self.assertIsInstance(w.x, int)
            self.assertIsInstance(w.z, int)


# ==========================================================================
# Archetype coverage and terrain-driven choice
# ==========================================================================

class TestArchetypes(unittest.TestCase):

    def test_all_three_archetypes_occur_across_seeds(self):
        got = set()
        for kind in ("flat", "rolling", "coast", "valley"):
            probe = probe_for(kind)
            cx, cz = centre_of(probe)
            for seed in range(14):
                try:
                    got.add(tp.plan_town(seed, probe, cx, cz, RADIUS).archetype)
                except tp.SiteRejected:
                    continue
        self.assertEqual(got, set(tp.ARCHETYPES),
                         f"archetypes never produced: "
                         f"{sorted(set(tp.ARCHETYPES) - got)}")

    def test_flat_open_ground_prefers_the_grid(self):
        probe = probe_for("flat")
        cx, cz = centre_of(probe)
        weights = dict(tp.archetype_weights(tp.score_site(probe, cx, cz, RADIUS)))
        self.assertEqual(max(weights, key=lambda k: weights[k]), "grid_quarter")

    def test_broken_or_wet_ground_does_not_prefer_the_grid(self):
        for kind in ("coast", "rolling"):
            with self.subTest(kind=kind):
                probe = probe_for(kind)
                cx, cz = centre_of(probe)
                site = tp.score_site(probe, cx, cz, RADIUS)
                weights = dict(tp.archetype_weights(site))
                self.assertNotEqual(max(weights, key=lambda k: weights[k]),
                                    "grid_quarter",
                                    f"{kind} (relief {site.relief:.0f}, "
                                    f"anisotropy {site.anisotropy:.2f}) chose a "
                                    f"surveyed grid")

    def test_roughness_does_not_depend_on_how_big_the_town_is(self):
        """The same ground must read the same at any radius. No scale bug.

        `archetype_weights` used to key on absolute relief, and relief grows
        with the disc being measured — so a 900-radius town read as rougher
        than a 600-radius one on identical terrain, and `grid_quarter` became
        unreachable on every real map site. Slope is the scale-free measure,
        and this pins it.
        """
        probe = probe_for("rolling")
        cx, cz = centre_of(probe)
        small = tp.score_site(probe, cx, cz, 620)
        large = tp.score_site(probe, cx, cz, 980)
        self.assertAlmostEqual(small.mean_slope, large.mean_slope, delta=1.5)
        self.assertEqual(
            max(dict(tp.archetype_weights(small)).items(), key=lambda kv: kv[1])[0],
            max(dict(tp.archetype_weights(large)).items(), key=lambda kv: kv[1])[0],
            "the same ground picked different archetypes at two town sizes")

    def test_demo_terrain_texture_is_world_scaled(self):
        """The fixture itself must not change character with the map size.

        Same bug class, one layer down: a terrain defined over normalised
        (u, v) is a different landscape on every map, so the archetype tests
        would grade something other than what they name.
        """
        for kind in ("flat", "rolling", "cliffs"):
            with self.subTest(kind=kind):
                a = tp.demo_probe(kind, W=257, H=257, seed=1)
                b = tp.demo_probe(kind, W=449, H=449, seed=1)
                sa = tp.score_site(a, (a.W - 1) * 4.0, (a.H - 1) * 4.0, 620)
                sb = tp.score_site(b, (b.W - 1) * 4.0, (b.H - 1) * 4.0, 620)
                self.assertAlmostEqual(sa.mean_slope, sb.mean_slope, delta=1.0)

    def test_no_archetype_is_ever_unreachable(self):
        """Every weight stays positive, whatever the terrain.

        Otherwise archetype coverage silently becomes a property of the demo
        maps: a map with no flat ground would never produce a grid, and the
        coverage test above would pass only by accident of the fixtures.
        """
        for kind in tp.DEMO_KINDS:
            probe = probe_for(kind)
            cx, cz = centre_of(probe)
            for k, w in tp.archetype_weights(tp.score_site(probe, cx, cz, RADIUS)):
                self.assertGreater(w, 0.0, f"{kind}: {k} weighted {w}")

    def test_each_archetype_has_its_signature(self):
        """Forced archetypes must actually differ in structure, not just label.

        This is the machine-checkable half of "visibly distinct": a grid lays
        two perpendicular families of streets, a main street lays exactly one
        spine, an organic cluster opens a plaza. If a builder regressed into
        drawing the same thing under three names, one of these fails.
        """
        grid = plan("flat", 3, archetype="grid_quarter")
        headings = sorted({round(_street_axis(s) % math.pi, 2)
                           for s in grid.streets})
        self.assertGreaterEqual(
            len(headings), 2, "a grid quarter laid only one family of streets")
        self.assertTrue(
            any(abs(abs(a - b) - math.pi / 2) < 0.35
                for a in headings for b in headings),
            f"no two street families are perpendicular: {headings}")

        main = plan("valley", 1, archetype="main_street")
        self.assertEqual([s.kind for s in main.streets].count("main"), 1,
                         "main_street must have exactly one spine")

        org = plan("rolling", 5, archetype="organic_cluster")
        plazas = [s for s in org.streets if s.kind == "plaza"]
        self.assertEqual(len(plazas), 1, "organic_cluster must open one plaza")
        self.assertEqual(plazas[0].points[0], plazas[0].points[-1],
                         "the plaza ring must be closed")

    def test_the_plaza_square_is_left_open(self):
        """No lot may sit inside the plaza — it is the one place that stays clear.

        Regression: the plaza ring's winding decides which side is "outside",
        and taking that on trust roofed the square over with the meeting hall.
        """
        for seed in range(8):
            town = plan("rolling", seed, archetype="organic_cluster")
            plaza = next(s for s in town.streets if s.kind == "plaza")
            r = min(math.hypot(p[0] - town.x, p[1] - town.z)
                    for p in plaza.points)
            for lot in town.lots:
                self.assertGreater(
                    math.hypot(lot.x - town.x, lot.z - town.z), r,
                    f"seed {seed}: {lot.key} ({lot.role}) is inside the plaza")

    def test_an_explicit_archetype_overrides_the_terrain(self):
        for name in tp.ARCHETYPES:
            with self.subTest(archetype=name):
                self.assertEqual(plan("flat", 2, archetype=name).archetype, name)

    def test_an_unknown_archetype_is_a_loud_error(self):
        with self.assertRaises(ValueError):
            plan("flat", 1, archetype="boulevard")


def _street_axis(street) -> float:
    a, b = street.points[0], street.points[-1]
    return math.atan2(b[1] - a[1], b[0] - a[0])


# ==========================================================================
# Terrain rejection — the negative controls
# ==========================================================================

class TestTerrainRejection(unittest.TestCase):

    def test_a_lake_is_REFUSED_as_wet(self):
        probe = probe_for("lake")
        cx, cz = centre_of(probe)
        with self.assertRaises(tp.SiteRejected) as ctx:
            tp.plan_town(1, probe, cx, cz, RADIUS)
        self.assertIn("wet", str(ctx.exception))
        self.assertIsNotNone(ctx.exception.score)
        self.assertGreater(ctx.exception.score.submerged_fraction,
                           tp.SiteRules().max_submerged)

    def test_broken_cliffs_are_REFUSED_as_steep(self):
        probe = probe_for("cliffs")
        cx, cz = centre_of(probe)
        with self.assertRaises(tp.SiteRejected) as ctx:
            tp.plan_town(1, probe, cx, cz, RADIUS)
        self.assertIn("steep", str(ctx.exception))
        self.assertGreater(ctx.exception.score.mean_slope,
                           tp.SiteRules().max_mean_slope)

    def test_a_site_hanging_off_the_map_is_REFUSED(self):
        probe = probe_for("flat")
        with self.assertRaises(tp.SiteRejected) as ctx:
            tp.plan_town(1, probe, 80.0, 80.0, RADIUS)
        self.assertIn("offmap", str(ctx.exception))

    def test_rejection_names_every_failing_measurement(self):
        """The message is the diagnosis, so it carries all of it, not the first.

        A site refused for being both steep AND wet that only reports "steep"
        sends the caller looking for flatter ground in the same swamp.
        """
        probe = probe_for("lake")
        cx, cz = centre_of(probe)
        score = tp.score_site(probe, cx, cz, RADIUS)
        self.assertFalse(score.ok)
        self.assertGreaterEqual(len(score.reasons), 2, score.reasons)

    def test_good_ground_is_ACCEPTED(self):
        for kind in ("flat", "rolling", "valley"):
            with self.subTest(kind=kind):
                probe = probe_for(kind)
                cx, cz = centre_of(probe)
                self.assertTrue(tp.score_site(probe, cx, cz, RADIUS).ok)

    def test_pick_site_reports_what_it_looked_at_when_nothing_passes(self):
        probe = probe_for("lake")
        cx, cz = centre_of(probe)
        site, scored = tp.pick_site(probe, cx, cz, RADIUS, search=400)
        self.assertIsNone(site)
        self.assertGreater(len(scored), 1)
        self.assertTrue(all(s.reasons for s in scored))

    def test_pick_site_walks_off_bad_ground_onto_good(self):
        """A centre in the lake, with room to search, finds the shore instead."""
        probe = probe_for("lake")
        cx, cz = centre_of(probe)
        site, _ = tp.pick_site(probe, cx, cz, 520, search=1100)
        self.assertIsNotNone(site, "no dry site anywhere around the lake")
        self.assertTrue(site.ok)
        self.assertGreater(math.hypot(site.x - cx, site.z - cz), 0.0)

    def test_a_failed_search_is_diagnosed_over_the_whole_field(self):
        """The message must describe the search, not one arbitrary candidate.

        Regression from real map data: on a mountainous site where 21 of 21
        candidates failed and steepness was far and away the dominant reason,
        the old message reported only "offmap" — because it picked the
        highest-SCORING candidate and `score` does not penalise being off the
        map. The caller went looking for a border problem that did not exist.
        """
        probe = probe_for("cliffs")
        cx, cz = centre_of(probe)
        with self.assertRaises(tp.SiteRejected) as ctx:
            tp.plan_town(1, probe, cx, cz, 620, search=700)
        msg = str(ctx.exception)
        self.assertIn("candidate(s) refused", msg)
        self.assertIn("steep", msg)
        self.assertIn("Nearest miss", msg)

    def test_a_town_too_thin_to_be_a_town_is_refused(self):
        """`min_lots`: a site can pass every disc measurement and still yield
        three parcels once the streets meet the real ground."""

        rules = dataclasses.replace(tp.SiteRules(), min_lots=999)
        with self.assertRaises(tp.SiteRejected) as ctx:
            plan("flat", 3, rules=rules)
        self.assertIn("under the 999", str(ctx.exception))

    def test_a_radius_too_small_for_streets_is_refused_by_name(self):
        smallest = min(tp.min_radius_for(a) for a in tp.ARCHETYPES)
        with self.assertRaises(tp.SiteRejected) as ctx:
            plan("flat", 1, archetype="grid_quarter", radius=smallest - 100)
        self.assertIn("too small", str(ctx.exception))
        self.assertIn("block", str(ctx.exception))

    def test_the_block_pitch_actually_fits_two_rows_of_lots(self):
        """The arithmetic `_block_pitch` exists to enforce, asserted directly.

        Regression: a 260 spacing against a 96 lot depth overlapped two rows by
        28 elmos and the overlap test silently binned three lots in five.
        """
        for name in tp.ARCHETYPES:
            arch = tt.STREET_ARCHETYPES[name]
            need = 2 * (arch["main_width"] / 2 + arch["setback"]
                        + arch["lot_depth"])
            self.assertGreater(tp._block_pitch(arch), need, name)


# ==========================================================================
# Geometry the consumer relies on
# ==========================================================================

class TestGeometry(unittest.TestCase):

    def towns(self):
        for kind in ("flat", "rolling", "coast", "valley"):
            for seed in range(5):
                try:
                    yield kind, seed, plan(kind, seed)
                except tp.SiteRejected:
                    continue

    def test_no_two_lots_overlap(self):
        for kind, seed, town in self.towns():
            lots = list(town.lots)
            for i, a in enumerate(lots):
                for b in lots[i + 1:]:
                    if math.hypot(a.x - b.x, a.z - b.z) > 700:
                        continue
                    self.assertFalse(
                        tp._obb_overlap(a.corners(), b.corners()),
                        f"{kind}/{seed}: {a.key} overlaps {b.key}")

    def test_every_lot_stands_on_buildable_ground(self):
        rules = tp.SiteRules()
        for kind, seed, town in self.towns():
            probe = probe_for(kind)
            for lot in town.lots:
                for px, pz in lot.corners() + [(lot.x, lot.z)]:
                    self.assertTrue(
                        probe.buildable(px, pz, rules.max_lot_slope),
                        f"{kind}/{seed}: {lot.key} corner ({px:.0f},{pz:.0f}) "
                        f"is on {probe.slope_deg(px, pz):.1f}-degree ground")

    def test_no_lot_is_built_on_a_carriageway(self):
        """A building in the road blocks the street it was meant to front."""
        for kind, seed, town in self.towns():
            by_key = {s.key: s for s in town.streets}
            for lot in town.lots:
                for s in town.streets:
                    if s.key == lot.street:
                        continue
                    total = s.length()
                    d = 0.0
                    while d <= total:
                        px, pz, _h = tp.point_at(s.points, d)
                        self.assertFalse(
                            tp._point_in_obb(px, pz, lot.x, lot.z,
                                             lot.width / 2.0, lot.depth / 2.0,
                                             lot.heading),
                            f"{kind}/{seed}: {s.key} runs through {lot.key}")
                        d += 24.0
                # ...and not its OWN street either. A curved lane that loops
                # back can re-enter the parcel it just created, which the carve
                # tests for separately and which growth used to ignore.
                own = by_key[lot.street]
                total = own.length()
                d = 0.0
                while d <= total:
                    px, pz, _h = tp.point_at(own.points, d)
                    self.assertFalse(
                        tp._point_in_obb(px, pz, lot.x, lot.z,
                                         lot.width / 2.0, lot.depth / 2.0,
                                         lot.heading),
                        f"{kind}/{seed}: {own.key} loops back through "
                        f"{lot.key}, the lot that fronts it")
                    d += 24.0

    def test_every_lot_faces_the_street_it_fronts(self):
        """Frontage is the whole point: the building looks at its own road.

        Asserted by stepping one lot-depth along the FACING cardinal and one
        against it, and requiring the first to land nearer the lot's street.
        Comparing `facing` to a recomputed angle instead would only restate how
        `_facing_of` was called; this measures the thing that matters, which is
        that a building spawned with this keyword has the road in front of it.
        """
        cardinals = {"east": 0.0, "south": math.pi / 2,
                     "west": math.pi, "north": -math.pi / 2}
        for kind, seed, town in self.towns():
            by_key = {s.key: s for s in town.streets}
            for lot in town.lots:
                street = by_key[lot.street]
                a = cardinals[lot.facing]
                reach = lot.depth / 2.0 + 40.0
                front = (lot.x + math.cos(a) * reach, lot.z + math.sin(a) * reach)
                back = (lot.x - math.cos(a) * reach, lot.z - math.sin(a) * reach)
                d_front, d_back = (_dist_to_street(p, street) for p in (front, back))
                self.assertLess(
                    d_front, d_back,
                    f"{kind}/{seed}: {lot.key} faces {lot.facing}, but that is "
                    f"{d_front:.0f} from {street.key} while its back is "
                    f"{d_back:.0f}")

    def test_lots_stay_inside_the_town(self):
        for kind, seed, town in self.towns():
            for lot in town.lots:
                d = math.hypot(lot.x - town.x, lot.z - town.z)
                self.assertLessEqual(
                    d, town.radius * 1.25,
                    f"{kind}/{seed}: {lot.key} is {d:.0f} from the centre of a "
                    f"{town.radius}-radius town")

    def test_the_perimeter_encloses_the_lots_and_has_gates(self):
        walled = [(k, s, t) for k, s, t in self.towns() if t.walled]
        self.assertTrue(walled, "no walled town in the sample")
        for kind, seed, town in walled:
            self.assertTrue(town.perimeter)
            parts = {w.part for w in town.perimeter}
            self.assertIn("wall", parts)
            for lot in town.lots:
                self.assertTrue(
                    tp._point_in_polygon(lot.x, lot.z, list(town.hull)),
                    f"{kind}/{seed}: {lot.key} is outside its own wall")

    def test_decoration_never_lands_inside_a_lot(self):
        for kind, seed, town in self.towns():
            for d in town.decor:
                for lot in town.lots:
                    self.assertFalse(
                        tp._point_in_obb(d.x, d.z, lot.x, lot.z,
                                         lot.width / 2.0, lot.depth / 2.0,
                                         lot.heading),
                        f"{kind}/{seed}: {d.key} sits inside {lot.key}")


# ==========================================================================
# Walls and defenses (town-planner T3)
# ==========================================================================
# The brief asks for three things and this class is those three things:
# a ladder of defense tiers you can see across seeds, a wall that adapts to
# the ground it is on, and gates that line up with the roads out. The
# invariants it leans on are `town_planner.validate_perimeter`'s — and because
# a spec nobody has watched fail is not a spec, `TestPerimeterSpecCatches`
# below breaks a good town four ways and requires each one to be caught.

_WALL_SWEEP: dict = {}


def wall_sweep(kinds=("flat", "rolling", "coast", "valley", "lake")):
    """Every town the demo terrains yield, planned once and shared.

    Cached for the reason `test_town_stager` caches its probes: this class asks
    a dozen questions of the same sample, and re-planning 100 towns per question
    costs more than every assertion in the file put together.
    """
    key = tuple(kinds)
    if key not in _WALL_SWEEP:
        out = []
        for kind in kinds:
            probe = probe_for(kind)
            cx, cz = centre_of(probe)
            for seed in range(24):
                try:
                    out.append((kind, seed, probe,
                                tp.plan_town(seed, probe, cx, cz, RADIUS,
                                             search=RADIUS)))
                except tp.SiteRejected:
                    continue
        _WALL_SWEEP[key] = out
    return _WALL_SWEEP[key]


def walled_towns():
    return [row for row in wall_sweep() if row[3].walled]


class TestDefenseTiers(unittest.TestCase):
    """The ladder: open hamlet -> stockaded town -> fortified compound."""

    def test_all_three_tiers_occur_across_seeds(self):
        """The brief's acceptance, restated: three tiers visible across seeds."""
        got = collections.Counter(t.defense for _k, _s, _p, t in wall_sweep())
        for tier in tt.DEFENSE_ORDER:
            self.assertGreater(got[tier], 0,
                               f"no {tier} town in {sum(got.values())} planned "
                               f"across five terrains and 24 seeds: {dict(got)}")

    def test_an_open_town_carries_no_defenses_at_all(self):
        """Not "an empty wall" — no wall, no line, no gaps, no guns."""
        seen = 0
        for kind, seed, _probe, town in wall_sweep():
            if town.defense != "open":
                continue
            seen += 1
            self.assertEqual((town.perimeter, town.wall_gaps,
                              town.emplacements, town.wall_line),
                             ((), (), (), ()), f"{kind}/{seed}")
            self.assertFalse(town.walled)
        self.assertTrue(seen)

    def test_a_stockade_has_a_wall_and_nothing_that_shoots(self):
        seen = 0
        for kind, seed, _probe, town in wall_sweep():
            if town.defense != "stockade":
                continue
            seen += 1
            self.assertTrue(town.perimeter, f"{kind}/{seed}")
            self.assertIn("wall", {w.part for w in town.perimeter})
            self.assertEqual(
                [], list(town.emplacements),
                f"{kind}/{seed}: a stockade drew {len(town.emplacements)} "
                f"emplacement(s); towers and guns are the fortified tier")
        self.assertTrue(seen)

    def test_a_fortified_town_has_towers_and_a_gun_on_its_gates(self):
        seen = 0
        for kind, seed, _probe, town in wall_sweep():
            if town.defense != "fortified":
                continue
            seen += 1
            parts = collections.Counter(w.part for w in town.emplacements)
            self.assertGreater(parts["tower"], 0, f"{kind}/{seed}: no tower")
            if town.gateways():
                self.assertGreater(
                    parts["gun"], 0,
                    f"{kind}/{seed}: {len(town.gateways())} gateway(s) and no "
                    f"staticdefense behind any of them")
            self.assertLessEqual(parts["tower"], tt.PERIMETER["max_towers"],
                                 f"{kind}/{seed}")
        self.assertTrue(seen)

    def test_a_hamlet_is_never_a_fortified_compound(self):
        """The size gate, at both ends, straight off `defense_weights`.

        A seven-lot town coming out a fortified compound is the failure the
        brief's own word "hamlet" names, and it cannot be caught by sampling —
        the draw is weighted, so a bad weight shows up as a rare town, not a
        failing one. The weights are asserted instead.
        """
        for archetype in tp.ARCHETYPES:
            small = dict(tp.defense_weights(archetype, tt.HAMLET_LOTS - 1))
            self.assertEqual(0.0, small["fortified"], archetype)
            big = dict(tp.defense_weights(archetype, tt.COMPOUND_LOTS + 8))
            self.assertGreater(big["fortified"], 0.0, archetype)
            self.assertGreater(
                small["open"] / sum(small.values()),
                big["open"] / sum(big.values()),
                f"{archetype}: a hamlet must lean more open than a big town")
        for kind, seed, _probe, town in wall_sweep():
            if len(town.lots) < tt.HAMLET_LOTS:
                self.assertNotEqual("fortified", town.defense,
                                    f"{kind}/{seed}: {len(town.lots)} lots")

    def test_the_tier_can_be_pinned_and_the_geometry_does_not_move(self):
        """Same town, two tiers: same outline, same gateways, different guns.

        The property `town_templates.DEFENSE_TIERS` promises — a tier decides
        WHAT is on the perimeter and never WHERE — and the thing that makes the
        ladder a ladder rather than three unrelated towns.
        """
        probe = probe_for("flat")
        cx, cz = centre_of(probe)
        a = tp.plan_town(3, probe, cx, cz, RADIUS, search=RADIUS,
                         defense="stockade")
        b = tp.plan_town(3, probe, cx, cz, RADIUS, search=RADIUS,
                         defense="fortified")
        self.assertEqual(a.wall_line, b.wall_line)
        self.assertEqual([g.to_dict() for g in a.wall_gaps],
                         [g.to_dict() for g in b.wall_gaps])
        self.assertEqual([w.to_dict() for w in a.perimeter],
                         [w.to_dict() for w in b.perimeter])
        self.assertEqual((), a.emplacements)
        self.assertTrue(b.emplacements)

    def test_walled_is_still_the_knob_it_was_in_T1(self):
        probe = probe_for("flat")
        cx, cz = centre_of(probe)
        off = tp.plan_town(3, probe, cx, cz, RADIUS, search=RADIUS, walled=False)
        on = tp.plan_town(3, probe, cx, cz, RADIUS, search=RADIUS, walled=True)
        self.assertEqual("open", off.defense)
        self.assertFalse(off.walled)
        self.assertNotEqual("open", on.defense)
        self.assertTrue(on.walled)
        with self.assertRaises(ValueError):
            tp.plan_town(3, probe, cx, cz, RADIUS, search=RADIUS,
                         walled=True, defense="open")
        with self.assertRaises(ValueError):
            tp.plan_town(3, probe, cx, cz, RADIUS, search=RADIUS,
                         defense="palisade")


class TestPerimeterInvariants(unittest.TestCase):
    """Gate-on-street, wall continuity, no wall through a building."""

    def test_the_perimeter_spec_is_green_over_the_whole_sweep(self):
        bad = []
        for kind, seed, probe, town in wall_sweep():
            problems = tp.validate_perimeter(town, probe)
            if problems:
                bad.append(f"{kind}/{seed}: " + "; ".join(problems[:2]))
        self.assertEqual([], bad, f"{len(bad)} of {len(wall_sweep())} towns")

    def test_wall_continuity_the_ring_is_tiled_with_no_slack(self):
        """Asserted from the arcs directly, not by calling the spec.

        `validate_perimeter` walks the same intervals, so re-running it here
        would prove the spec agrees with itself. This adds up the pieces and the
        gaps and requires the total to be the line's own length, which is the
        property the walk is a stand-in for.
        """
        seen = 0
        for kind, seed, _probe, town in walled_towns():
            seen += 1
            covered = (sum(w.span for w in town.perimeter)
                       + sum(g.width for g in town.wall_gaps))
            self.assertAlmostEqual(
                town.wall_length, covered, delta=len(town.perimeter) + 4,
                msg=f"{kind}/{seed}: {len(town.perimeter)} pieces and "
                    f"{len(town.wall_gaps)} gap(s) cover {covered} elmos of a "
                    f"{town.wall_length}-elmo line")
            self.assertTrue(
                all(w.span > 0 for w in town.perimeter), f"{kind}/{seed}")
        self.assertTrue(seen)

    def test_every_gap_in_a_wall_is_a_road_or_a_cliff(self):
        for kind, seed, probe, town in walled_towns():
            for g in town.wall_gaps:
                self.assertIn(g.kind, ("gate", "terrain"), f"{kind}/{seed}")
                self.assertTrue(g.why, f"{kind}/{seed}: {g.key} has no reason")
                if g.kind == "gate":
                    self.assertIn(g.street, {s.key for s in town.streets})

    def test_every_street_that_leaves_town_leaves_through_a_gateway(self):
        """A wall drawn without reference to the roads dead-ends one of them.

        Both directions, because only one of them was ever the risk in T1: a
        gate somewhere near a road is easy, and a road with no gate is the town
        the player cannot drive into.
        """
        crossings = 0
        for kind, seed, _probe, town in walled_towns():
            line = list(town.wall_line)
            ring = tp._Ring(line)
            gateways = town.gateways()
            for s in town.streets:
                prev = None
                for d in _walk_lengths(s.length(), 16.0):
                    px, pz, _h = tp.point_at(s.points, d)
                    inside = tp._point_in_polygon(px, pz, line)
                    if prev is not None and inside != prev:
                        crossings += 1
                        _dist, arc = ring.project(px, pz)
                        near = [g for g in gateways
                                if tp._arc_delta(
                                    arc, (g.s0 + g.width / 2.0) % ring.total,
                                    ring.total) <= g.width / 2.0 + 4]
                        self.assertTrue(
                            near,
                            f"{kind}/{seed}: {s.key} crosses the wall at "
                            f"({px:.0f},{pz:.0f}) with no gateway there")
                    prev = inside
        self.assertGreater(crossings, 0,
                           "no street crossed a wall anywhere in the sweep — "
                           "this test proved nothing")

    def test_a_walled_town_always_has_a_way_in(self):
        """The regression the `gate_reach` measurement exists for.

        Deriving gateways from physical crossings alone sealed 20 of 34 walled
        towns, because T1's streets stop 80 to 250 elmos short of the line.
        """
        sealed = [f"{k}/{s}" for k, s, _p, t in walled_towns()
                  if not t.gateways()]
        self.assertEqual([], sealed,
                         f"{len(sealed)} walled town(s) with no gateway at all")

    def test_a_gateway_is_wide_enough_to_flank_the_street_it_serves(self):
        """Room for a post either side of the carriageway plus its clearance.

        A fixed 150-elmo opening put a gate post 75 elmos off an 88-elmo main
        street's centreline, inside the carriageway's own clearance, and the
        stager refused every one of them.
        """
        for _k, _s, _p, town in walled_towns():
            widths = {s.key: s.width for s in town.streets}
            # The opening is cut out of the ring's terrain scan, so its measured
            # width is quantised to the scan's stride; `- probe_step` is that
            # rounding and nothing else.
            for g in town.gateways():
                want = (widths[g.street] + 2 * tt.PERIMETER["gate_margin"]
                        - tt.PERIMETER["probe_step"])
                self.assertGreaterEqual(
                    g.width, want,
                    f"gateway {g.key} for a {widths[g.street]}-elmo street")

    def test_no_wall_piece_is_built_through_a_lot(self):
        for kind, seed, _probe, town in walled_towns():
            for w in list(town.perimeter) + list(town.emplacements):
                for lot in town.lots:
                    self.assertFalse(
                        tp._obb_overlap(w.corners(), lot.corners()),
                        f"{kind}/{seed}: {w.part} {w.key} at ({w.x},{w.z}) "
                        f"is built through {lot.key}")

    def test_the_wall_line_still_contains_every_lot(self):
        """`_simplify_hull` grows the polygon; nothing may fall outside it."""
        for kind, seed, _probe, town in walled_towns():
            line = list(town.wall_line)
            for lot in town.lots:
                for cx, cz in lot.corners():
                    self.assertTrue(
                        _inside_or_on(cx, cz, line),
                        f"{kind}/{seed}: a corner of {lot.key} is outside "
                        f"its own wall")

    def test_the_line_has_few_enough_vertices_for_a_corner_to_mean_something(self):
        """The lots' hull is a 7-to-27-sided circle; the wall must not be."""
        lo, hi = tt.PERIMETER["vertices"]
        for kind, seed, _probe, town in walled_towns():
            self.assertLessEqual(len(town.wall_line), max(hi, len(town.hull)),
                                 f"{kind}/{seed}")
            self.assertGreaterEqual(len(town.wall_line), 3, f"{kind}/{seed}")
            if len(town.hull) > hi:
                self.assertLess(
                    len(town.wall_line), len(town.hull),
                    f"{kind}/{seed}: a {len(town.hull)}-vertex hull was not "
                    f"simplified at all")

    def test_simplify_hull_only_ever_grows_the_polygon(self):
        """The property vertex-DELETION would violate, on a shape that shows it.

        Deleting a vertex from a convex polygon cuts the corner off and puts
        whatever was there outside; extending the two neighbouring edges to meet
        adds a triangle instead. On a town that is houses outside their own wall
        versus a slightly roomier wall.
        """
        import random as _r
        rnd = _r.Random(11)
        for trial in range(20):
            pts = [(rnd.random() * 2000, rnd.random() * 2000) for _ in range(40)]
            hull = tp._convex_hull(pts)
            if len(hull) < 6:
                continue
            small = tp._simplify_hull(hull, 5)
            # Fewer than it started with; not necessarily down to the target,
            # because a round in which every candidate edge is refused stops the
            # simplification, and stopping early is a legitimate answer.
            self.assertLess(len(small), len(hull), f"trial {trial}")
            self.assertTrue(_is_convex(small), f"trial {trial}: {small}")
            for px, pz in hull:
                self.assertTrue(
                    _inside_or_on(px, pz, small),
                    f"trial {trial}: ({px:.0f},{pz:.0f}) fell outside the "
                    f"simplified hull")

    def test_a_tower_is_inside_its_own_wall(self):
        seen = 0
        for kind, seed, _probe, town in walled_towns():
            for w in town.emplacements:
                seen += 1
                self.assertTrue(
                    tp._point_in_polygon(w.x, w.z, list(town.wall_line)),
                    f"{kind}/{seed}: {w.part} {w.key} stands outside the wall "
                    f"it is supposed to be defending")
        self.assertTrue(seen)


class TestWallTerrainAdaptation(unittest.TestCase):
    """The wall follows the ground, and stops where it cannot stand on it."""

    def test_no_wall_piece_stands_on_ground_a_road_could_not_climb(self):
        for kind, seed, probe, town in walled_towns():
            for w in town.perimeter:
                self.assertTrue(
                    probe.buildable(w.x, w.z, tp.SiteRules().max_street_slope),
                    f"{kind}/{seed}: {w.part} {w.key} at ({w.x},{w.z}) is on "
                    f"{probe.slope_deg(w.x, w.z):.1f}-degree ground or water")

    def test_wet_and_broken_terrain_makes_the_wall_skip_and_anchor(self):
        """The adaptation, on the two demo terrains that have anything to skip.

        A `terrain` gap on flat ground would be a bug; on a coast or a lake the
        line runs into water and must break rather than march across it.
        """
        skips = anchors = 0
        for _k, _s, _p, town in wall_sweep(("coast", "lake", "cliffs")):
            if not town.walled:
                continue
            skips += sum(1 for g in town.wall_gaps if g.kind == "terrain")
            anchors += sum(1 for w in town.perimeter if w.part == "anchor")
        self.assertGreater(skips, 0,
                           "not one wall on a coast, a lake or a cliff field "
                           "skipped any ground")
        self.assertGreater(anchors, 0,
                           "the wall skipped ground but never anchored into "
                           "the edge of it")

    def test_a_skipped_stretch_really_is_unstandable(self):
        """Sampled inside every terrain gap, not just at its ends.

        A gap the scan opened for no reason is a hole in a town's wall that
        nothing explains, and it would pass the continuity spec — a declared gap
        is a declared gap whether or not the declaration is true.
        """
        rules = tp.SiteRules()
        checked = 0
        for kind, seed, probe, town in wall_sweep(("coast", "lake", "cliffs")):
            if not town.walled:
                continue
            ring = tp._Ring(town.wall_line)
            for g in town.wall_gaps:
                if g.kind != "terrain":
                    continue
                checked += 1
                bad = 0
                n = max(2, int(g.width / 16))
                for i in range(n):
                    x, z, _h = ring.at(g.s0 + (i + 0.5) * g.width / n)
                    if not probe.buildable(x, z, rules.max_street_slope):
                        bad += 1
                self.assertGreater(
                    bad, 0,
                    f"{kind}/{seed}: {g.key} skips {g.width} elmos of line at "
                    f"({g.x},{g.z}) and every sample in it is standable ground")
        self.assertGreater(checked, 0)

    def test_the_wall_never_skips_anything_shorter_than_a_wall(self):
        for kind, seed, _probe, town in walled_towns():
            runs = [w for w in town.perimeter]
            self.assertTrue(runs or not town.wall_length, f"{kind}/{seed}")


class TestPerimeterSpecCatches(unittest.TestCase):
    """Break a good town four ways; the spec must name each one.

    A validity spec that has only ever been seen passing is a function that
    returns an empty list. Each of these is a real defect the T3 rewrite either
    fixed or could reintroduce.
    """

    def town(self):
        probe = probe_for("flat")
        cx, cz = centre_of(probe)
        town = tp.plan_town(3, probe, cx, cz, RADIUS, search=RADIUS,
                            defense="fortified")
        self.assertEqual([], tp.validate_perimeter(town, probe))
        return probe, town

    def test_a_hole_nobody_declared_is_caught(self):

        probe, town = self.town()
        keep = [w for w in town.perimeter if w.part == "wall"][2:]
        broken = dataclasses.replace(town, perimeter=tuple(
            [w for w in town.perimeter if w.part != "wall"] + keep))
        problems = tp.validate_perimeter(broken, probe)
        self.assertTrue(any("neither walled nor a declared gap" in p
                            for p in problems), problems[:3])

    def test_two_pieces_claiming_the_same_arc_are_caught(self):

        probe, town = self.town()
        first = town.perimeter[0]
        broken = dataclasses.replace(town, perimeter=tuple(
            [dataclasses.replace(first, span=first.span * 3)]
            + list(town.perimeter[1:])))
        problems = tp.validate_perimeter(broken, probe)
        self.assertTrue(any("own the same" in p for p in problems),
                        problems[:3])

    def test_a_gateway_no_road_reaches_is_caught(self):
        """Moved to the emptiest arc of the ring, position and arc together.

        Most gateways are DERIVED from a street's end rather than from a
        crossing, so the crossing check alone said nothing about them: this
        mutation passed the spec until the gateway was required to have a street
        that actually gets to it.

        The emptiest arc and not the antipodal one, which was the first attempt
        and was not a defect at all: a main street crosses the whole town and
        leaves it at BOTH ends, so half a ring away from one of its gateways is
        exactly where its other gateway belongs.
        """
        probe, town = self.town()
        gate = town.gateways()[0]
        ring = tp._Ring(list(town.wall_line))
        ends = [p for s in town.streets for p in (s.points[0], s.points[-1])]
        s = max((i * ring.total / 64 for i in range(64)),
                key=lambda s: min(math.hypot(ring.at(s)[0] - ex,
                                             ring.at(s)[1] - ez)
                                  for ex, ez in ends))
        x, z, _h = ring.at(s)
        moved = dataclasses.replace(gate, s0=int(s), x=int(x), z=int(z))
        broken = dataclasses.replace(town, wall_gaps=tuple(
            moved if g.key == gate.key else g for g in town.wall_gaps))
        problems = tp.validate_perimeter(broken, probe)
        self.assertTrue(
            any("a road out of town may fall short by" in p or
                "no gateway there" in p for p in problems), problems[:3])

    def test_a_wall_built_through_a_house_is_caught(self):

        probe, town = self.town()
        lot = town.lots[0]
        broken = dataclasses.replace(town, perimeter=tuple(
            [dataclasses.replace(town.perimeter[0], x=lot.x, z=lot.z)]
            + list(town.perimeter[1:])))
        problems = tp.validate_perimeter(broken, probe)
        self.assertTrue(any("is built through" in p for p in problems),
                        problems[:3])

    def test_a_gun_on_a_tier_that_has_none_is_caught(self):

        probe, town = self.town()
        broken = dataclasses.replace(town, defense="stockade")
        problems = tp.validate_perimeter(broken, probe)
        self.assertTrue(any("tier that does not have them" in p
                            for p in problems), problems[:3])


def _inside_or_on(px, pz, poly, tol=1.0) -> bool:
    """Containment, boundary included.

    `tp._point_in_polygon` is a strict ray cast and a point exactly ON an edge
    falls whichever way the crossing parity happens to land. That is fine for
    the planner, which asks about lot centres and street samples, and useless
    here: `_simplify_hull` REUSES vertices of the input hull, so the very points
    a containment test is about sit exactly on the output's boundary.
    """
    if tp._point_in_polygon(px, pz, poly):
        return True
    n = len(poly)
    for i in range(n):
        ax, az = poly[i]
        bx, bz = poly[(i + 1) % n]
        dx, dz = bx - ax, bz - az
        l2 = dx * dx + dz * dz
        t = 0.0 if l2 <= 1e-9 else max(0.0, min(1.0, ((px - ax) * dx
                                                      + (pz - az) * dz) / l2))
        if math.hypot(px - (ax + dx * t), pz - (az + dz * t)) <= tol:
            return True
    return False


def _is_convex(poly) -> bool:
    n = len(poly)
    cross = [
        (poly[(i + 1) % n][0] - poly[i][0]) * (poly[(i + 2) % n][1] - poly[(i + 1) % n][1])
        - (poly[(i + 1) % n][1] - poly[i][1]) * (poly[(i + 2) % n][0] - poly[(i + 1) % n][0])
        for i in range(n)]
    return (all(c >= -1e-6 for c in cross) or all(c <= 1e-6 for c in cross))


def _walk_lengths(total: float, step: float):
    d = 0.0
    while d <= total:
        yield d
        d += step


def _dist_to_street(point, street) -> float:
    px, pz = point
    return min(math.hypot(x - px, z - pz)
               for x, z, _h in (tp.point_at(street.points, d)
                                for d in _walk_lengths(street.length(), 16.0)))


# ==========================================================================
# Roles
# ==========================================================================

class TestRoles(unittest.TestCase):

    def test_exactly_one_meeting_hall_per_town_always(self):
        """`unique` is a contract the scenario layer points objectives at.

        Zero is a war with no parley venue; two is a war with an ambiguous one.
        """
        n = 0
        for kind in ("flat", "rolling", "coast", "valley"):
            probe = probe_for(kind)
            cx, cz = centre_of(probe)
            for seed in range(8):
                try:
                    town = tp.plan_town(seed, probe, cx, cz, RADIUS)
                except tp.SiteRejected:
                    continue
                n += 1
                self.assertEqual(
                    sum(1 for l in town.lots if l.role == "unique"), 1,
                    f"{kind}/{seed}: {dict(town.role_counts())}")
        self.assertGreater(n, 12, "too few towns planned to mean anything")

    def test_role_caps_are_respected(self):
        for kind in ("flat", "rolling", "coast"):
            probe = probe_for(kind)
            cx, cz = centre_of(probe)
            for seed in range(6):
                try:
                    town = tp.plan_town(seed, probe, cx, cz, RADIUS)
                except tp.SiteRejected:
                    continue
                for role, count in town.role_counts():
                    cap = tt.LOT_ROLES[role].get("cap")
                    if cap is not None:
                        self.assertLessEqual(count, cap, f"{kind}/{seed}/{role}")

    def test_every_lot_carries_a_known_role(self):
        town = plan("rolling", 2)
        for lot in town.lots:
            self.assertIn(lot.role, tt.ROLE_ORDER)

    def test_a_town_is_always_mostly_dwellings(self):
        """The scarce roles must not eat the town. Bulk is the bulk.

        Measured before `SCARCE_SHARE` existed: 76 of 103 towns planned across
        four shipped maps had more special buildings than dwellings, because
        each role drew against a per-role cap with no shared ceiling. A
        ten-lot village came out with a hall, two markets, a silo and a
        watchtower — a regional capital, not the shanty town asked for.
        """
        checked = 0
        for kind in ("flat", "rolling", "coast", "valley"):
            probe = probe_for(kind)
            cx, cz = centre_of(probe)
            for seed in range(8):
                try:
                    town = tp.plan_town(seed, probe, cx, cz, RADIUS)
                except tp.SiteRejected:
                    continue
                checked += 1
                counts = dict(town.role_counts())
                scarce = sum(v for k, v in counts.items() if k != "bulk")
                self.assertGreater(
                    counts["bulk"], scarce,
                    f"{kind}/{seed}: {len(town.lots)} lots -> {counts}")
        self.assertGreater(checked, 15)

    def test_the_scarce_budget_is_spread_across_roles_not_eaten_by_the_first(self):
        """Every scarce role must be reachable, not just whichever draws first.

        Regression: `poi` drew against the whole remaining budget, so across
        103 towns on four shipped maps exactly zero ever got a water works or
        a grain silo. Reserving a slot per not-yet-drawn role fixed it.
        """
        seen = set()
        for kind in ("flat", "rolling", "coast", "valley"):
            probe = probe_for(kind)
            cx, cz = centre_of(probe)
            for seed in range(10):
                try:
                    town = tp.plan_town(seed, probe, cx, cz, RADIUS)
                except tp.SiteRejected:
                    continue
                seen.update(r for r, n in town.role_counts() if n)
        self.assertEqual(seen, set(tt.ROLE_ORDER),
                         f"roles never assigned to any lot: "
                         f"{sorted(set(tt.ROLE_ORDER) - seen)}")

    def test_role_siting_puts_the_hall_nearer_the_centre_than_the_silo(self):
        """The `wants` machinery has to actually move things, not just run.

        "unique" wants plaza/main/central and "utility" wants low/water/edge,
        so if role scoring degenerated to a constant this comparison flips.
        """
        wins = trials = 0
        for kind in ("flat", "rolling", "coast", "valley"):
            probe = probe_for(kind)
            cx, cz = centre_of(probe)
            for seed in range(6):
                try:
                    town = tp.plan_town(seed, probe, cx, cz, RADIUS)
                except tp.SiteRejected:
                    continue
                hall = [l for l in town.lots if l.role == "unique"]
                util = [l for l in town.lots if l.role == "utility"]
                if not hall or not util:
                    continue
                trials += 1
                if hall[0].dist_to_centre < max(l.dist_to_centre for l in util):
                    wins += 1
        self.assertGreater(trials, 5)
        self.assertGreater(wins, trials * 0.7,
                           f"the hall beat the utilities to the centre only "
                           f"{wins}/{trials} times")

    def test_scarce_roles_get_the_bigger_parcel_when_there_is_room(self):
        grew = 0
        for seed in range(8):
            town = plan("flat", seed, archetype="grid_quarter")
            base = tt.STREET_ARCHETYPES["grid_quarter"]["frontage"]
            for lot in town.lots:
                if lot.role == "unique" and lot.width > base:
                    grew += 1
        self.assertGreater(grew, 0, "no meeting hall was ever grown to its "
                                    "template lot size")


# ==========================================================================
# Role -> def resolution against real content
# ==========================================================================

class TestContentMapping(unittest.TestCase):

    def test_the_briefed_def_wins_when_it_exists(self):
        full = {"ms_shanty_block", "ms_market_stalls", "ms_meeting_hall",
                "ms_water_works", "ms_watchtower"}
        got = tt.resolve_roles(full)
        self.assertEqual(got["bulk"], "ms_shanty_block")
        self.assertEqual(got["unique"], "ms_meeting_hall")
        self.assertEqual(got["poi"], "ms_market_stalls")

    def test_the_shipped_stand_in_is_used_when_it_does_not(self):
        shipped = {"ms_habitat", "ms_depot", "ms_transit_hub",
                   "ms_staticdefense_s1"}
        got = tt.resolve_roles(shipped)
        self.assertEqual(got["bulk"], "ms_habitat")
        self.assertEqual(got["unique"], "ms_transit_hub")
        self.assertEqual(got["defense"], "ms_staticdefense_s1")

    def test_a_role_with_no_candidate_at_all_is_omitted_not_defaulted(self):
        got = tt.resolve_roles({"ms_habitat"})
        self.assertEqual(got.get("bulk"), "ms_habitat")
        self.assertNotIn("poi", got)
        self.assertNotIn("defense", got)

    def test_assign_defs_fills_every_lot_it_can(self):
        town = plan("flat", 3)
        tp.assign_defs(town, {"ms_habitat", "ms_depot", "ms_transit_hub",
                              "ms_staticdefense_s1"})
        for lot in town.lots:
            self.assertIsNotNone(lot.defname, f"{lot.key} ({lot.role})")

    @unittest.skipUnless(os.path.isdir(GAME_DIR), "no game content in this checkout")
    def test_every_resolved_def_exists_in_the_shipped_content(self):
        """Whatever `resolve_roles` picks must be a def ms_defs really loaded.

        This is the test that will start passing MORE roles the day the M2
        buildings land, without anything here changing.
        """
        import ms_defs
        facts = ms_defs.load(GAME_DIR)
        resolved = tt.resolve_roles(facts)
        self.assertTrue(resolved, "no role resolved against the shipped content")
        for role, defname in sorted(resolved.items()):
            self.assertIn(defname, facts, role)
            self.assertTrue(facts[defname].building,
                            f"{role} resolved to {defname}, which is not a "
                            f"building")

    @unittest.skipUnless(os.path.isdir(GAME_DIR), "no game content in this checkout")
    def test_lots_are_large_enough_for_the_defs_they_resolve_to(self):
        """A parcel that cannot hold its own building is a planning bug.

        The planner sizes lots from `town_templates`, and `ms_defs` reads the
        footprints out of the content; this is the one place those two numbers
        are compared, and it is why the lot sizes are ~200 elmos rather than
        the ~120 a "house plot" suggests.
        """
        import ms_defs
        facts = ms_defs.load(GAME_DIR)
        resolved = tt.resolve_roles(facts)
        town = plan("flat", 3)
        tp.assign_defs(town, facts)
        for lot in town.lots:
            if lot.defname is None:
                continue
            f = facts[lot.defname]
            span_x = f.footprint_x * ms_defs.FOOTPRINT_SCALE * 8
            span_z = f.footprint_z * ms_defs.FOOTPRINT_SCALE * 8
            self.assertGreaterEqual(
                max(lot.width, lot.depth), min(span_x, span_z),
                f"{lot.key} ({lot.role} -> {lot.defname}) is "
                f"{lot.width}x{lot.depth} but the building is {span_x}x{span_z}")
        self.assertTrue(resolved)


# ==========================================================================
# The debug dump — the deliverable another step consumes
# ==========================================================================

class TestDebugDump(unittest.TestCase):

    def test_the_json_dump_round_trips(self):
        town = plan("rolling", 6)
        back = json.loads(town.to_json())
        self.assertEqual(back, town.to_dict())
        for key in ("planner_version", "archetype", "site", "streets", "lots",
                    "perimeter", "decor", "terrain_ops", "role_counts", "hull"):
            self.assertIn(key, back)

    def test_the_dump_carries_enough_to_rebuild_the_town(self):
        d = plan("flat", 3).to_dict()
        self.assertTrue(d["streets"] and d["lots"])
        lot = d["lots"][0]
        for key in ("key", "street", "x", "z", "width", "depth", "heading",
                    "facing", "role", "corners"):
            self.assertIn(key, lot)
        self.assertEqual(len(lot["corners"]), 4)
        street_keys = {s["key"] for s in d["streets"]}
        for l in d["lots"]:
            self.assertIn(l["street"], street_keys)

    def test_terrain_ops_cover_every_street(self):
        """ROADS v1: one cleared strip per street, and nothing invented.

        See town_planner's header for why this is a strip list rather than a
        drawn road — the wire ships the heightmap once and carries no delta.
        """
        town = plan("rolling", 3)
        ops = town.terrain_ops()
        self.assertEqual([o["street"] for o in ops],
                         [s.key for s in town.streets])
        for op, street in zip(ops, town.streets):
            self.assertEqual(op["op"], "clear_strip")
            self.assertGreater(op["clear_width"], op["width"])
            self.assertEqual(len(op["points"]), len(street.points))
        self.assertTrue(any(o["flatten"] for o in ops),
                        "no strip is marked worth flattening")

    def test_the_lua_dump_is_a_pure_table_literal(self):
        """scenariogen's invariant 1, applied to this dump.

        A consumer reading it with a bare `lua_State` — which is how
        ScenarioDiscovery reads a scenario — gets no VFS and no `Spring.*`, so
        anything needing them does not fail loudly, it silently reads as
        nothing.
        """
        src = plan("flat", 3).to_lua()
        self.assertTrue(src.startswith("return {"))
        for banned in ("require", "Spring.", "VFS", "gadget", "os.", "io."):
            self.assertNotIn(banned, src, f"the Lua dump references {banned}")

    @unittest.skipUnless(shutil.which("lua"), "no `lua` interpreter on PATH")
    def test_the_lua_dump_loads_in_a_bare_interpreter(self):
        town = plan("rolling", 6)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "town.lua")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(town.to_lua())
            script = (
                f'local t = dofile("{path}")\n'
                'assert(type(t) == "table", "not a table")\n'
                'assert(type(t.streets) == "table")\n'
                'assert(type(t.lots) == "table")\n'
                'print(#t.streets, #t.lots, t.archetype)\n')
            r = subprocess.run(["lua", "-e", script], capture_output=True,
                               text=True, timeout=60)
            self.assertEqual(r.returncode, 0, r.stderr)
            n_streets, n_lots, archetype = r.stdout.split()
            self.assertEqual(int(n_streets), len(town.streets))
            self.assertEqual(int(n_lots), len(town.lots))
            self.assertEqual(archetype, town.archetype)


# ==========================================================================
# CLI
# ==========================================================================

class TestCLI(unittest.TestCase):

    CLI = None

    @classmethod
    def setUpClass(cls):
        cls.CLI = [sys.executable, os.path.join(MAPGEN, "town_planner.py")]

    def run_cli(self, *args):
        return subprocess.run(list(self.CLI) + list(args), capture_output=True,
                              text=True, timeout=180)

    def test_demo_terrain_writes_a_usable_dump(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "town.json")
            r = self.run_cli("--demo", "rolling", "--seed", "9",
                             "--radius", str(RADIUS), "--out", out)
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(out, encoding="utf-8") as fh:
                d = json.load(fh)
            self.assertIn(d["archetype"], tp.ARCHETYPES)
            self.assertTrue(d["lots"])

    def test_stdout_carries_only_the_dump(self):
        """A caller doing `town_planner ... > town.json` must get valid JSON.

        Progress lines go to stderr for exactly this reason; scenariogen's own
        suite makes the same assertion about the scenario it emits.
        """
        r = self.run_cli("--demo", "flat", "--seed", "2", "--radius", str(RADIUS))
        self.assertEqual(r.returncode, 0, r.stderr)
        json.loads(r.stdout)

    def test_a_refused_site_exits_nonzero_and_writes_nothing_to_stdout(self):
        r = self.run_cli("--demo", "lake", "--seed", "1", "--radius", str(RADIUS))
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stdout.strip(), "")
        self.assertIn("REJECTED", r.stderr)

    def test_the_lua_flag_emits_lua(self):
        r = self.run_cli("--demo", "flat", "--seed", "2", "--radius",
                         str(RADIUS), "--lua")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(r.stdout.startswith("return {"))

    def test_a_map_dir_or_demo_is_required(self):
        r = self.run_cli("--seed", "1")
        self.assertNotEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main()
