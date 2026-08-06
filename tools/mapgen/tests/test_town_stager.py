#!/usr/bin/env python3
"""Tests for the town stager (.tasks/desc/town-planner-T2).

    python3 -m unittest discover -s tools/mapgen/tests

Same substrate as `test_town_planner.py` and for the same reason: synthetic
terrain from `demo_probe`, because `data/maps/` is gitignored and a suite that
cannot run in a clone is not a suite. The terrain is faked; the slope grading,
the real `ms_defs` footprints read out of the shipped def files, and the placer
are all real.

The brief asks this suite to prove two things, and they are the two classes at
the top: seeded determinism, and a PLACEMENT VALIDITY SPEC — no footprint
overlap, everything reachable from a street. `validate_staging` is that spec;
most of what follows either runs it over a sweep or pins one specific way of
violating it that was actually observed and fixed.

THE ROSTER PROBLEM, AND WHY THESE TESTS DO NOT NAME THE BRIEFED DEFS.
`ms_shanty_block`, `ms_meeting_hall`, `ms_market_stalls`, `ms_water_works`,
`ms_grain_silo` and `ms_watchtower` are not readable from this clone —
model-integration's M2 landed them behind its own manual land gate — and the
M3 featuredefs are not either. Asserting on those names would produce a suite
that is green only on a tree nobody has. So the tests assert on ROLES, TIERS
and GEOMETRY, which are stable across the roster swap, and the two places
where content identity genuinely matters (`resolve_*` filtering, the landmark
channel) are driven with explicit synthetic rosters. When M2/M3 land, this file
should go green unchanged; that is the design, and `test_briefed_roster_wins_
when_it_is_available` is the tripwire that says so.
"""

import json
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
import town_stager as ts                                         # noqa: E402
import town_templates as tt                                      # noqa: E402

GAME_DIR = os.path.join(REPO, "data", "games", "metalstorm")
DEMO_W = DEMO_H = 385
RADIUS = 900

# The feature roster M3 landed on its own branch. Used to drive the landmark
# channel, which has no content in this clone and would otherwise be untested
# code that first runs in front of a player.
M3_FEATURES = [row["def"] for row in tt.LANDMARKS]

_FACTS = None


def facts():
    global _FACTS
    if _FACTS is None:
        _FACTS = ms_defs.load(GAME_DIR)
    return _FACTS


_PROBES: dict = {}
_SWEEPS: dict = {}


def probe_for(kind: str):
    """Cached: a demo probe is a pure function of (kind, size, seed).

    Rebuilding one per call cost this suite more than every placement test in
    it put together — the heightmap synthesis is the expensive part, not the
    staging. Cached rather than made a fixture so the helpers below stay
    callable from a single test in isolation.
    """
    if kind not in _PROBES:
        _PROBES[kind] = tp.demo_probe(kind, W=DEMO_W, H=DEMO_H, seed=1)
    return _PROBES[kind]


def plan(kind: str, seed: int, **kw):
    probe = probe_for(kind)
    c = (probe.W - 1) * probe.elmos / 2.0
    return tp.plan_town(seed, probe, c, c, kw.pop("radius", RADIUS),
                        search=RADIUS, **kw)


def stage(kind: str, seed: int, features=(), **kw):
    """Plan and stage in one go. Returns (town, staged, probe)."""
    probe = probe_for(kind)
    town = plan(kind, seed, **kw)
    return town, ts.stage_town(town, facts(), features=features,
                               probe=probe), probe


def sweep(seeds=range(1, 9), kinds=("flat", "rolling", "valley", "coast"),
          features=()):
    """Every archetype on every terrain. Sites that refuse are skipped.

    Cached on its arguments, because a dozen tests want the same sweep and
    planning it once per test took two minutes. Determinism is what makes the
    cache sound — the same arguments provably produce the same towns, which is
    the first thing this file asserts — and no test mutates what it is handed.
    """
    key = (tuple(seeds), tuple(kinds), tuple(features))
    if key not in _SWEEPS:
        out = []
        for kind in kinds:
            probe = probe_for(kind)
            for arch in tp.ARCHETYPES:
                for seed in seeds:
                    try:
                        town = plan(kind, seed, archetype=arch)
                    except tp.SiteRejected:
                        continue
                    staged = ts.stage_town(town, facts(), features=features,
                                           probe=probe)
                    out.append((kind, arch, seed, town, staged, probe))
        _SWEEPS[key] = out
    return _SWEEPS[key]


# ==========================================================================
# Determinism
# ==========================================================================

class TestDeterminism(unittest.TestCase):

    def test_same_seed_twice_is_identical(self):
        for kind in ("flat", "rolling", "coast"):
            with self.subTest(kind=kind):
                _t, a, _p = stage(kind, 11, features=M3_FEATURES)
                _t, b, _p = stage(kind, 11, features=M3_FEATURES)
                self.assertEqual(a.to_dict(), b.to_dict())

    def test_a_different_seed_stages_a_different_town(self):
        seen = set()
        staged = 0
        for s in range(2, 12):
            try:
                town = plan("rolling", s)
            except tp.SiteRejected:
                continue
            out = ts.stage_town(town, facts(), features=M3_FEATURES,
                                probe=probe_for("rolling"))
            staged += 1
            seen.add(json.dumps(out.to_dict(), sort_keys=True))
        self.assertGreaterEqual(staged, 5, "too few seeds staged at all")
        self.assertEqual(len(seen), staged,
                         "two seeds staged the identical town — the seed is "
                         "not reaching the placement")

    def test_determinism_survives_a_separate_process(self):
        """Two fresh interpreters must agree byte for byte.

        Catches "something reaching output iterated a dict or a set", which is
        only stable within one process. The stager builds several dicts on the
        way (`_stage_buildings`' by-role grouping, `role_options`) and every one
        of them is drained through an explicit ordered list before it can reach
        a placement; this is what keeps that true.
        """
        cli = [sys.executable, os.path.join(MAPGEN, "town_stager.py"),
               "--demo", "rolling", "--seed", "5", "--radius", str(RADIUS),
               "--quiet"]
        env = dict(os.environ)
        env.pop("PYTHONHASHSEED", None)
        outs = [subprocess.run(cli, capture_output=True, text=True, env=env,
                               timeout=300) for _ in range(2)]
        for r in outs:
            self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(outs[0].stdout, outs[1].stdout)
        self.assertIn("placements", outs[0].stdout)

    def test_staging_does_not_depend_on_the_planner_rng_being_reused(self):
        """One graph staged twice is the same town, however it was reached.

        `stage_town` seeds itself from `town.seed`, so staging is a pure
        function of (graph, roster, seed). If it ever picked up ambient rng
        state instead, this is where it shows: the second call runs with a
        different module-level `random` state than the first.
        """
        import random
        town = plan("rolling", 6)
        a = ts.stage_town(town, facts(), probe=probe_for("rolling")).to_dict()
        random.random()
        random.random()
        b = ts.stage_town(town, facts(), probe=probe_for("rolling")).to_dict()
        self.assertEqual(a, b)


# ==========================================================================
# The placement validity spec — the brief's own words
# ==========================================================================

class TestPlacementSpec(unittest.TestCase):

    def test_the_spec_is_green_on_every_archetype_and_terrain(self):
        """The headline. If this fails, a town has a defect a player would see."""
        checked = 0
        for kind, arch, seed, town, staged, probe in sweep(
                features=M3_FEATURES):
            problems = ts.validate_staging(staged, town, probe)
            self.assertEqual(problems, [],
                             f"{kind}/{arch}/{seed}: " + "; ".join(problems))
            checked += 1
        self.assertGreater(checked, 40,
                           "the sweep barely staged anything — the spec passed "
                           "vacuously")

    def test_no_two_placements_block_the_same_ground(self):
        """The brief asks for this by name: "no overlaps (assert in tests)".

        Asserted directly here rather than only through `validate_staging`, on
        the AXIS-ALIGNED rectangles — see town_stager's header for why the
        parcels prove nothing about the buildings standing in them.
        """
        for kind, arch, seed, town, staged, _probe in sweep(
                features=M3_FEATURES):
            ps = list(staged.placements)
            for i, a in enumerate(ps):
                for b in ps[i + 1:]:
                    self.assertFalse(
                        ts._rects_overlap(a.rect(), b.rect()),
                        f"{kind}/{arch}/{seed}: {a.defname} {a.rect()} "
                        f"overlaps {b.defname} {b.rect()}")

    def test_neighbours_keep_the_town_gap(self):
        """Not merely non-overlapping — a whole build square apart.

        `TOWN_GAP` is what `_unreachable`'s raster floods through, so an
        overlap test alone would let two buildings touch and quietly seal an
        alley the spec then reports as unreachable somewhere else entirely.
        """
        for _kind, _arch, _seed, _town, staged, _probe in sweep(
                seeds=range(1, 5)):
            ps = list(staged.placements)
            for i, a in enumerate(ps):
                for b in ps[i + 1:]:
                    self.assertFalse(
                        ts._rects_overlap(a.rect(ts.TOWN_GAP / 2.0),
                                          b.rect(ts.TOWN_GAP / 2.0)),
                        f"{a.defname} and {b.defname} are closer than "
                        f"{ts.TOWN_GAP} elmos")

    def test_everything_is_reachable_from_a_street(self):
        """The other half of the brief's spec, asserted on its own.

        A raster flood fill from the carriageways: what this is looking for is
        ENCLOSURE, a building ringed by other buildings, which is a property of
        the ground between the boxes and not of the boxes.
        """
        for kind, arch, seed, town, staged, _probe in sweep(
                features=M3_FEATURES):
            stranded = ts._unreachable(staged, town)
            self.assertEqual(stranded, [],
                             f"{kind}/{arch}/{seed}: " + "; ".join(stranded))

    def test_nothing_stands_on_a_carriageway(self):
        for kind, arch, seed, town, staged, _probe in sweep(
                seeds=range(1, 6)):
            for p in staged.placements:
                for s in town.streets:
                    d = 0.0
                    total = s.length()
                    while d <= total:
                        px, pz, _h = tp.point_at(s.points, d)
                        self.assertFalse(
                            ts._point_in_rect(px, pz, p.rect(s.width / 2.0)),
                            f"{kind}/{arch}/{seed}: {p.defname} at "
                            f"({p.x},{p.z}) stands on {s.key}")
                        d += ts.STREET_STRIDE

    def test_every_building_stands_on_buildable_ground(self):
        """Re-graded on the BUILDING's corners, not the parcel's.

        The planner already checked the parcel. On a diagonal street the
        building reaches into ground the parcel never covered, which is exactly
        the case this catches and the parcel check cannot.
        """
        rules = tp.SiteRules()
        for kind, arch, seed, _town, staged, probe in sweep(
                seeds=range(1, 6)):
            for p in staged.of_category("building"):
                for cx, cz in ((p.x - p.half_x, p.z - p.half_z),
                               (p.x + p.half_x, p.z - p.half_z),
                               (p.x + p.half_x, p.z + p.half_z),
                               (p.x - p.half_x, p.z + p.half_z)):
                    self.assertTrue(
                        probe.buildable(cx, cz, rules.max_lot_slope),
                        f"{kind}/{arch}/{seed}: {p.defname} has a corner on "
                        f"unbuildable ground at ({int(cx)},{int(cz)})")

    def test_every_placement_still_clears_once_rounded_to_integral_elmos(self):
        """The rounding regression, pinned. Placements are re-played in order.

        A rung that tests a float box and stores the rounded one is the bug
        this codebase has hit three times (`_grow_lots`, `_build_decor`, and
        `_place_building`). It is not a rounding curiosity: `SiteProbe` samples
        every 8 elmos, so a tenth of an elmo can move a corner into the next
        sample and flip `buildable`. Observed on pools_of_ilys — a meeting hall
        cleared at x=2731.868 and failed at x=2732, and because the re-check
        ran after the unique role's fallback the whole town was refused.

        Re-playing is the only honest way to assert it: each placement must be
        acceptable against exactly the placements that preceded it.
        """
        rules = tp.SiteRules()
        for kind, arch, seed, town, staged, probe in sweep(seeds=range(1, 5)):
            site = ts._Site(town, probe, rules)
            for p in staged.placements:
                self.assertIsInstance(p.x, int)
                self.assertIsInstance(p.z, int)
                if p.channel != "unit":
                    continue
                self.assertTrue(
                    site.accepts(p.x, p.z, p.half_x, p.half_z),
                    f"{kind}/{arch}/{seed}: {p.defname} at ({p.x},{p.z}) was "
                    f"staged but does not clear on its integral coordinates")
                site.add(p)

    def test_the_meeting_hall_re_sites_rather_than_being_lost(self):
        """`unique` survives its own parcel being unusable.

        Driven by blocking the parcel the planner chose before staging starts,
        which is what a hostile patch of ground does in practice. The hall must
        end up somewhere else and the town must still stage — the alternative,
        observed on real maps before the fallback existed, is `stage_town`
        refusing an otherwise perfectly good town.
        """
        import random
        town = plan("flat", 3)
        probe = probe_for("flat")
        target = [l for l in town.lots if l.role == "unique"]
        self.assertEqual(len(target), 1)
        target = target[0]

        site = ts._Site(town, probe, tp.SiteRules())
        blocker = ts.Placement(
            key="blocker", channel="unit", category="building", role="bulk",
            tier="common", defname="ms_habitat", x=target.x, z=target.z,
            facing=target.facing, half_x=140.0, half_z=140.0)
        site.add(blocker)

        placements, dropped = [], []
        ts._stage_buildings(random.Random(town.seed), town, site, facts(),
                            tt.role_options(facts()), placements, dropped)
        halls = [p for p in placements if p.role == "unique"]
        self.assertEqual(len(halls), 1, "the hall was lost, not re-sited")
        self.assertNotEqual(halls[0].lot, target.key)
        self.assertTrue(any("re-sited" in why for _l, _r, why in dropped),
                        f"the re-siting was not reported: {dropped}")

    def test_the_spec_actually_catches_an_overlap(self):
        """A negative control. A spec that cannot fail is not a spec.

        Two buildings are forced onto the same ground and the checker must say
        so — otherwise every green run above proves only that the checker runs.
        """
        town, staged, probe = stage("flat", 3)
        ps = list(staged.placements)
        self.assertGreaterEqual(len(ps), 2)
        moved = ps[1]
        broken = ts.StagedTown(
            key=staged.key, name=staged.name, seed=staged.seed,
            archetype=staged.archetype, x=staged.x, z=staged.z,
            radius=staged.radius,
            placements=tuple(ps[:1] + [ts.Placement(
                key=moved.key, channel=moved.channel, category=moved.category,
                role=moved.role, tier=moved.tier, defname=moved.defname,
                x=ps[0].x + 4, z=ps[0].z + 4, facing=moved.facing,
                half_x=moved.half_x, half_z=moved.half_z)] + ps[2:]))
        problems = ts.validate_staging(broken, town, probe)
        self.assertTrue(any("overlapping ground" in p for p in problems),
                        f"the overlap was not reported: {problems}")


# ==========================================================================
# Buildings front their streets
# ==========================================================================

class TestFrontage(unittest.TestCase):

    def test_a_building_faces_its_own_lot_s_street(self):
        for kind, arch, seed, town, staged, _probe in sweep(
                seeds=range(1, 6)):
            lots = {l.key: l for l in town.lots}
            for p in staged.of_category("building"):
                self.assertEqual(
                    p.facing, lots[p.lot].facing,
                    f"{kind}/{arch}/{seed}: {p.defname} faces {p.facing} but "
                    f"its lot fronts {lots[p.lot].facing}")

    def test_a_building_sits_on_the_street_side_of_its_parcel(self):
        """The anchor-sign regression, pinned.

        `_anchor_for` puts the building's near face ON the parcel's frontage
        line, which means that whenever the box is deeper than half its parcel
        the CENTRE moves AWAY from the street. Clamping that at zero (the first
        cut did) left buildings on their parcel centres, 38 elmos inside a
        40-elmo carriageway; the ladder then shoved them backwards until they
        cleared and the town rendered as scatter with roads through it.

        So the invariant is not "the centre is nearer the street than the
        parcel centre" — on a diagonal it is provably further. It is that the
        building's near FACE is within a lot depth of the frontage line, i.e.
        it is on this street rather than adrift in the block behind it.
        """
        for kind, arch, seed, town, staged, _probe in sweep(
                seeds=range(1, 6)):
            lots = {l.key: l for l in town.lots}
            for p in staged.of_category("building"):
                if p.fit == "inset":
                    continue          # the rung that is allowed to step back
                lot = lots[p.lot]
                _along, away = ts._lot_frame(lot)
                _u, reach_v = ts._lot_projection(lot, p.half_x, p.half_z)
                # Signed distance from the parcel's frontage line to the
                # building's near face, positive = away from the street.
                to_centre = ((p.x - lot.x) * away[0] + (p.z - lot.z) * away[1])
                near_face = to_centre - reach_v + lot.depth / 2.0
                self.assertLess(
                    abs(near_face), 2.0,
                    f"{kind}/{arch}/{seed}: {p.defname} ({p.fit}) sits "
                    f"{near_face:.0f} elmos off its frontage line")

    def test_the_footprint_swap_matches_the_engine(self):
        """`_extent_of` is Unit.cpp:224-225, and this is the assertion of that.

        Also pins the invariant the module leans on everywhere else: whatever
        the facing, the extent ACROSS it comes from footprintx and the extent
        ALONG it from footprintz.
        """
        fx, fz = 10, 14                       # ms_transit_hub, deliberately not square
        for facing in ts.FACING_ORDER:
            hx, hz = ts._extent_of(facing, fx, fz)
            i = ts.FACING_INDEX[facing]
            self.assertEqual(hx * 2, (fz if i & 1 else fx) * ts.SQUARE_ELMOS,
                             f"{facing}: x extent")
            self.assertEqual(hz * 2, (fx if i & 1 else fz) * ts.SQUARE_ELMOS,
                             f"{facing}: z extent")
            # across-the-facing is always footprintx
            across = hz if i & 1 else hx
            along = hx if i & 1 else hz
            self.assertEqual(across * 2, fx * ts.SQUARE_ELMOS)
            self.assertEqual(along * 2, fz * ts.SQUARE_ELMOS)

    def test_a_build_square_is_sixteen_elmos(self):
        """The arithmetic town_templates' lot sizes were measured against.

        ms_habitat is footprint 12 and blocks 192 elmos. If `SQUARE_ELMOS` ever
        drifts from `ms_defs`, every lot size in `town_templates` silently stops
        matching the content it was derived from.
        """
        self.assertEqual(ts.SQUARE_ELMOS, 16)
        f = facts()["ms_habitat"]
        hx, hz = ts._extent_of("south", f.footprint_x, f.footprint_z)
        self.assertEqual(hx * 2, 192)
        self.assertEqual(hz * 2, 192)
        # ...and it is the same number `ms_defs.body_radius` is built on.
        self.assertAlmostEqual(f.body_radius, math.hypot(hx, hz), places=6)


# ==========================================================================
# Rarity: what a town is mostly made of
# ==========================================================================

class TestRarity(unittest.TestCase):

    def test_exactly_one_meeting_hall_per_town(self):
        """`unique` means exactly one. The scenario layer points parley at it.

        `stage_town` refuses the whole town rather than ship a second one or
        none, so this asserting 1 is asserting that the refusal never had to
        fire — and the sweep is wide enough that it would have.
        """
        towns = 0
        for kind, arch, seed, _town, staged, _probe in sweep(
                seeds=range(1, 9)):
            halls = [p for p in staged.placements if p.role == "unique"]
            self.assertEqual(len(halls), 1,
                             f"{kind}/{arch}/{seed}: {len(halls)} meeting halls")
            self.assertEqual(halls[0].tier, "unique")
            towns += 1
        self.assertGreater(towns, 40)

    def test_a_town_is_mostly_dwellings(self):
        """Rarity tiers, measured. "Occasional" is a proportion, not a count.

        The planner's SCARCE_SHARE budget is what enforces it; this is the
        assertion that the budget survives contact with real footprints — a
        scarce role whose building does not fit is dropped, and if the bulk
        rows dropped harder than the scarce ones the town would come out as a
        civic centre with three houses.
        """
        common = uncommon = 0
        for _k, _a, _s, _town, staged, _p in sweep(seeds=range(1, 9)):
            for p in staged.of_category("building"):
                if p.tier == "common":
                    common += 1
                elif p.tier == "uncommon":
                    uncommon += 1
        self.assertGreater(common, uncommon,
                           f"{uncommon} special buildings against {common} "
                           f"dwellings — that is a regional capital, not a town")
        self.assertGreater(common, 2 * uncommon,
                           "dwellings should outnumber special buildings at "
                           "least two to one across a sweep")

    def test_every_placement_carries_a_tier(self):
        for _k, _a, _s, _town, staged, _p in sweep(seeds=range(1, 4),
                                                   features=M3_FEATURES):
            for p in staged.placements:
                self.assertIn(p.tier, tt.TIERS, f"{p.defname}: {p.tier!r}")

    def test_distinct_roles_prefer_two_different_buildings(self):
        """The water works and the grain silo are two promises, not one twice.

        Driven with a synthetic roster because the real one has a single
        utility def in this clone — the behaviour under test is `distinct`,
        which needs two candidates to have anything to say.
        """
        rnd_defs = []
        import random
        rnd = random.Random(4)
        for _ in range(200):
            order = ts._weighted_defs(rnd, [("a", 1.0), ("b", 1.0)], ["a"])
            rnd_defs.append(order[0])
        self.assertGreater(
            rnd_defs.count("b"), 190,
            "a def already standing in this town should almost never be the "
            "first choice for the next lot of the same distinct role")
        # ...but it is a preference, not a ban: with every candidate used, the
        # role must still produce an order rather than nothing.
        order = ts._weighted_defs(rnd, [("a", 1.0), ("b", 1.0)], ["a", "b"])
        self.assertEqual(sorted(order), ["a", "b"])


# ==========================================================================
# Content resolution — the part that changes when M2/M3 land
# ==========================================================================

class TestContent(unittest.TestCase):

    def test_role_options_filters_to_what_ships(self):
        opts = tt.role_options(facts())
        self.assertTrue(opts, "no role resolved against the shipped roster")
        for role, picks in sorted(opts.items()):
            for defname, weight in picks:
                self.assertIn(defname, facts(),
                              f"{role} offered {defname}, which does not exist")
                self.assertGreater(weight, 0.0)

    def test_briefed_roster_wins_when_it_is_available(self):
        """The tripwire for the M2 landing. Roles must prefer the briefed defs.

        Today `ms_shanty_block` is not readable from this clone, so the bulk
        role falls back to `ms_habitat`. The day M2 lands, the same call must
        return the shanty block WITHOUT anyone editing this lane — and if a
        future edit reverses that preference, this fails.
        """
        pretend = {"ms_shanty_block": 1, "ms_habitat": 1, "ms_meeting_hall": 1,
                   "ms_market_stalls": 1, "ms_water_works": 1,
                   "ms_grain_silo": 1, "ms_watchtower": 1}
        opts = tt.role_options(pretend)
        self.assertEqual(opts["unique"], [("ms_meeting_hall", 1.0)])
        self.assertEqual([d for d, _w in opts["defense"]], ["ms_watchtower"])
        self.assertEqual(sorted(d for d, _w in opts["utility"]),
                         ["ms_grain_silo", "ms_water_works"])
        bulk = dict(opts["bulk"])
        self.assertGreater(bulk["ms_shanty_block"], bulk["ms_habitat"],
                           "a shanty town should be mostly shanty blocks")

    def test_a_role_with_no_content_is_omitted_not_defaulted(self):
        """Silence is the bug this prevents: a habitat standing in for a hall
        while the objective layer believes the parley venue exists."""
        self.assertEqual(tt.role_options({}), {})
        self.assertEqual(tt.resolve_props({}), {})
        self.assertEqual(tt.resolve_landmarks({}), [])

    def test_missing_content_is_reported_by_name(self):
        _town, staged, _probe = stage("rolling", 7)
        joined = " ".join(staged.gaps)
        self.assertIn("decor kinds with no content", joined)
        for kind in ("drum", "tarp", "cart"):
            self.assertIn(kind, joined)
        self.assertIn("landmarks", joined)

    def test_no_probe_is_admitted_rather_than_silently_skipped(self):
        town = plan("rolling", 7)
        staged = ts.stage_town(town, facts())
        self.assertTrue(any("no probe supplied" in g for g in staged.gaps),
                        "staging without terrain did not say so")

    def test_props_only_appear_for_kinds_with_content(self):
        seen = set()
        for _k, _a, _s, _town, staged, _p in sweep(seeds=range(1, 9)):
            for p in staged.of_category("prop"):
                seen.add(p.role)
        mapped = set(tt.resolve_props(facts()))
        self.assertTrue(seen <= mapped,
                        f"props staged for kinds with no content: "
                        f"{sorted(seen - mapped)}")


# ==========================================================================
# Landmarks — the occasional unique decoration
# ==========================================================================

class TestLandmarks(unittest.TestCase):

    def test_no_feature_roster_means_no_landmarks(self):
        """A clone without the M3 featuredefs stages none, and says so.

        Not "spawns them as units anyway", which is the failure mode that a
        shared `world.units` list would have made easy — the two channels are
        separate all the way down.
        """
        for _k, _a, _s, _town, staged, _p in sweep(seeds=range(1, 5)):
            self.assertEqual(staged.features(), [])
            self.assertEqual(staged.of_category("landmark"), [])

    def test_landmarks_are_occasional(self):
        """Rare enough to surprise. Measured over the sweep, not asserted at 1.

        "Occasional" is the brief's word and a proportion is the only honest
        reading of it: a wreck in every town is set dressing a player stops
        seeing after three towns.
        """
        towns = with_one = 0
        for _k, _a, _s, _town, staged, _p in sweep(seeds=range(1, 9),
                                                   features=M3_FEATURES):
            towns += 1
            if staged.of_category("landmark"):
                with_one += 1
        self.assertGreater(towns, 40)
        share = with_one / float(towns)
        self.assertGreater(share, 0.10, "no town ever surprises")
        self.assertLess(share, 0.60,
                        f"{share:.0%} of towns have a landmark — that is a "
                        f"fixture, not a surprise")

    def test_landmarks_stage_on_the_feature_channel(self):
        found = 0
        for _k, _a, _s, _town, staged, _p in sweep(seeds=range(1, 9),
                                                   features=M3_FEATURES):
            for p in staged.of_category("landmark"):
                self.assertEqual(p.channel, "feature")
                self.assertEqual(p.tier, "unique")
                self.assertIn(p.role, ("yard", "edge"))
                found += 1
            for p in staged.of_category("building"):
                self.assertEqual(p.channel, "unit")
        self.assertGreater(found, 5, "the landmark path never ran")

    def test_both_sitings_occur(self):
        """A yard wreck and an edge relic are different reads, and both must fire.

        `_yard_spot` was the fragile one — it needs a parcel whose building did
        not consume the whole depth, which on a diagonal street is rare.
        """
        where = set()
        for _k, _a, _s, _town, staged, _p in sweep(seeds=range(1, 13),
                                                   features=M3_FEATURES):
            for p in staged.of_category("landmark"):
                where.add(p.role)
        self.assertEqual(where, {"yard", "edge"}, f"only got {sorted(where)}")

    def test_landmark_clearance_arithmetic(self):
        """Pins the metres->elmos derivation so the swap to real featuredefs is safe.

        town_templates' LANDMARKS carries measured glTF bounds in metres
        because a feature has no readable footprint here. When one does, this
        is the number the replacement has to match.
        """
        self.assertEqual(ts.METRES_TO_ELMOS, 8)
        self.assertEqual(ts.SQUARE_ELMOS // 2, ts.METRES_TO_ELMOS)
        tank = [r for r in tt.LANDMARKS if r["def"] == "ms_tank_wreck"][0]
        self.assertEqual(tank["metres"], (9, 11))
        self.assertEqual(tank["metres"][0] * ts.METRES_TO_ELMOS, 72)


# ==========================================================================
# Output
# ==========================================================================

class TestOutput(unittest.TestCase):

    def test_scenario_entries_are_the_loader_s_shape(self):
        _town, staged, _probe = stage("rolling", 7, features=M3_FEATURES)
        for u in staged.scenario_units():
            self.assertEqual(sorted(u), ["def", "facing", "team", "x", "z"])
            self.assertIn(u["facing"], ts.FACING_ORDER)
            self.assertIsInstance(u["x"], int)
            self.assertIn(u["def"], facts())
        for f in staged.scenario_features():
            self.assertEqual(sorted(f), ["def", "facing", "x", "z"])
            self.assertNotIn("y", f,
                             "a feature's y is a spawn height the engine "
                             "overrides — naming one invents a decision")

    def test_units_and_features_partition_the_placements(self):
        _town, staged, _probe = stage("valley", 5, features=M3_FEATURES)
        self.assertEqual(len(staged.units()) + len(staged.features()),
                         len(staged.placements))

    def test_the_dump_is_json_and_pure_lua(self):
        _town, staged, _probe = stage("rolling", 7, features=M3_FEATURES)
        back = json.loads(staged.to_json())
        self.assertEqual(back["key"], staged.key)
        self.assertEqual(back["stager_version"], ts.STAGER_VERSION)
        self.assertEqual(back["planner_version"], tp.PLANNER_VERSION)
        lua = staged.to_lua()
        self.assertTrue(lua.startswith("return {"))
        for banned in ("require", "Spring.", "function", "..", "nil,nil"):
            self.assertNotIn(banned, lua,
                             f"the Lua dump is not pure: contains {banned!r}")

    def test_drops_are_reported_with_a_reason(self):
        """A thinner town must say why it is thinner.

        The two reasons are different problems with different owners — no def
        exists for the role (content), or nothing fit the parcel (geometry) —
        and a staging that reported neither would read as complete.
        """
        saw = 0
        for _k, _a, _s, _town, staged, _p in sweep(seeds=range(1, 9)):
            for lot, role, why in staged.dropped:
                self.assertTrue(lot and role and why)
                self.assertIn(role, tt.ROLE_ORDER)
                self.assertGreater(len(why), 20, f"terse drop reason: {why!r}")
                saw += 1
        self.assertGreater(saw, 0, "nothing was ever dropped — is the sweep "
                                   "staging anything hard?")

    def test_def_and_tier_counts_are_ordered_not_dict_order(self):
        _town, staged, _probe = stage("flat", 3)
        counts = staged.def_counts()
        self.assertEqual(counts, sorted(counts, key=lambda kv: (-kv[1], kv[0])))
        self.assertEqual([t for t, _n in staged.tier_counts()], tt.TIERS)


# ==========================================================================
# CLI
# ==========================================================================

class TestCLI(unittest.TestCase):

    def test_check_mode_reports_a_pass(self):
        cli = [sys.executable, os.path.join(MAPGEN, "town_stager.py"),
               "--demo", "rolling", "--seed", "5", "--radius", str(RADIUS),
               "--check"]
        r = subprocess.run(cli, capture_output=True, text=True, timeout=300)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("placement spec: OK", r.stderr)

    def test_an_impossible_site_exits_non_zero_with_a_reason(self):
        cli = [sys.executable, os.path.join(MAPGEN, "town_stager.py"),
               "--demo", "cliffs", "--seed", "5", "--radius", str(RADIUS)]
        r = subprocess.run(cli, capture_output=True, text=True, timeout=300)
        self.assertEqual(r.returncode, 2)
        self.assertIn("no town", r.stderr)


if __name__ == "__main__":
    unittest.main()
