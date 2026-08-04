#!/usr/bin/env python3
"""Tests for the Metalstorm scenario generator (PLAN-metalstorm-scenariogen.md §10).

    python3 -m unittest discover -s tools/mapgen/tests

Most of these run against SYNTHETIC maps built in a temp dir, on purpose: the
real `data/maps/` is gitignored, so a clone or a CI checkout has none, and a
suite that silently skips its own negative control is worse than no suite. The
synthetic maps are real heightmaps run through the real `passable_mask` — the
only thing faked is the terrain, never the grading.

The tests against the shipped maps (including the meridian_basin negative
control, which is the specific failure this generator exists to refuse) run
whenever map data IS reachable, and say so loudly when it is not.
"""

import math
import os
import re
import struct
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
MAPGEN = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(MAPGEN, "..", ".."))
sys.path.insert(0, MAPGEN)

import ms_defs                                                  # noqa: E402
import scenariogen as sg                                        # noqa: E402
from scenario_templates import ARMY_ROSTERS, CLUSTER_TEMPLATES  # noqa: E402

GAME_DIR = os.path.join(REPO, "data", "games", "metalstorm")


def find_maps_dir():
    """`data/maps/` if this checkout (or the main one beside it) has one.

    Map data is gitignored, so a taskherd clone has none of its own while the
    checkout it was cloned from does — the same situation regions_from_map.py's
    "anchor on the MAP dir" comment describes.
    """
    for cand in (os.path.join(REPO, "data", "maps"),
                 os.environ.get("MS_MAPS_DIR", "")):
        if cand and os.path.isdir(cand):
            return cand
    try:
        origin = subprocess.run(
            ["git", "-C", REPO, "remote", "get-url", "origin"],
            capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        return None
    if origin and os.path.isdir(os.path.join(origin, "data", "maps")):
        return os.path.join(origin, "data", "maps")
    return None


MAPS_DIR = find_maps_dir()


# ==========================================================================
# Synthetic map fixtures
# ==========================================================================

SAMPLES = 129                      # (mapx + 1); 128 * 8 = 1024 elmos square
ELMOS = (SAMPLES - 1) * 8


def write_map(root: str, name: str, heights, regions) -> str:
    """A processed-map directory the generator can read: mapinfo + heightmap + graph.

    Heights are metres; the heightmap is uint16 LE quantised over
    [minheight, maxheight], which is the format read_heightmap expects. No DB
    row is written — the generator does not need one (it grades the coordinates
    it chooses, not the map's declared start positions), and its absence proves
    that.
    """
    d = os.path.join(root, "data", "maps", name)
    os.makedirs(os.path.join(d, "mapdata"), exist_ok=True)
    lo, hi = -50.0, 500.0
    with open(os.path.join(d, "mapinfo.lua"), "w") as f:
        f.write(f"return {{ minheight = {lo}, maxheight = {hi} }}\n")
    with open(os.path.join(d, "heightmap.bin"), "wb") as f:
        for h in heights:
            q = int(round((min(max(h, lo), hi) - lo) / (hi - lo) * 65535))
            f.write(struct.pack("<H", max(0, min(65535, q))))
    with open(os.path.join(d, "mapdata", "regions.lua"), "w") as f:
        f.write("return {\n    version = 1,\n    regions = {\n")
        for r in regions:
            poly = ", ".join(f"{{x={x}, z={z}}}" for x, z in r["polygon"])
            tags = ", ".join(f'"{t}"' for t in r["tags"])
            nbrs = ", ".join(f'"{n}"' for n in sorted(r["neighbors"]))
            f.write(f'        {{\n            key = "{r["key"]}",\n'
                    f'            name = "{r["name"]}",\n'
                    f"            polygon = {{ {poly} }},\n"
                    f"            value = {r['value']},\n"
                    f"            tags = {{ {tags} }},\n"
                    f"            neighbors = {{ {nbrs} }},\n        }},\n")
        f.write("    },\n}\n")
    return d


def grid_regions(cols: int, rows: int, home_cells, wall_between=None):
    """A `cols` x `rows` lattice of rectangular regions, 4-connected."""
    out = []
    cw, ch = ELMOS // cols, ELMOS // rows
    for rz in range(rows):
        for cx in range(cols):
            i = rz * cols + cx
            key = f"r{cx}_{rz}"
            nbrs = []
            for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, nz = cx + dx, rz + dz
                if 0 <= nx < cols and 0 <= nz < rows:
                    if wall_between and wall_between(cx, rz, nx, nz):
                        continue
                    nbrs.append(f"r{nx}_{nz}")
            tags = ["plain", "buildzone"]
            if (cx, rz) in home_cells:
                tags.append("home")
            if cx == cols // 2:
                tags.append("chokepoint")
            out.append({
                "key": key, "name": f"Cell {cx} {rz}",
                "polygon": [(cx * cw, rz * ch), ((cx + 1) * cw, rz * ch),
                            ((cx + 1) * cw, (rz + 1) * ch), (cx * cw, (rz + 1) * ch)],
                "value": 1.0 + 0.1 * i, "tags": tags, "neighbors": nbrs,
            })
    return out


def flat_map(root, name="synth_flat"):
    """Entirely drivable ground: every gate should pass."""
    heights = [10.0] * (SAMPLES * SAMPLES)
    return write_map(root, name, heights,
                     grid_regions(4, 4, {(0, 0), (3, 3)}))


def walled_map(root, name="synth_walled"):
    """A cliff wall splitting the map, with a home region on each side.

    THE NEGATIVE CONTROL, and the reason it is synthetic as well as real: it
    proves the reachability gate can FAIL. A gate only ever exercised on maps
    that pass is a rubber stamp — this project has already shipped one of those
    once, in region verification.

    The wall is a full-height ridge four samples wide. Even INFANTRY (45 deg,
    the most permissive class) cannot climb it: a 500 m step over 8 elmos is a
    ~89 deg slope.
    """
    heights = [10.0] * (SAMPLES * SAMPLES)
    mid = SAMPLES // 2
    for z in range(SAMPLES):
        for x in range(mid - 2, mid + 2):
            heights[z * SAMPLES + x] = 500.0
    regions = grid_regions(
        4, 4, {(0, 0), (3, 3)},
        # The GRAPH still claims the two halves connect. That is the point: the
        # mask must be the arbiter, because a graph walk reported Meridian
        # Basin as fine — the exact map whose armies cannot meet.
        wall_between=None)
    return write_map(root, name, heights, regions)


class SyntheticMap:
    def __init__(self, builder, name):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = builder(self._tmp.name, name)

    def __enter__(self):
        return self.path

    def __exit__(self, *a):
        self._tmp.cleanup()


# ==========================================================================

class TestUnitDefFacts(unittest.TestCase):
    """ms_defs reads the real content, and every template def resolves."""

    def setUp(self):
        if not os.path.isdir(GAME_DIR):
            self.skipTest(f"no game content at {GAME_DIR}")
        self.facts = ms_defs.load(GAME_DIR)

    def test_every_def_the_templates_name_exists(self):
        named = sorted(
            {d for tpl in CLUSTER_TEMPLATES.values()
             for d, _w, _lo, _hi in tpl["buildings"] + tpl["garrison"]} |
            {d for roster in ARMY_ROSTERS.values() for d, _c, _s in roster})
        self.assertEqual(ms_defs.verify(self.facts, named), [],
                         "templates name defs the shipped content does not have")

    def test_footprints_match_the_content(self):
        # ms_habitat is the def the 2026-07-26 trapped-civilian bug was found
        # on, and its 12x12 footprint is why: 12 * 2 * 4 = 96 elmos per axis.
        h = self.facts["ms_habitat"]
        self.assertEqual((h.footprint_x, h.footprint_z), (12, 12))
        self.assertAlmostEqual(h.clear_radius,
                               math.hypot(96, 96) + ms_defs.SCATTER_MARGIN, places=3)

    def test_per_scale_movementclass_overrides_are_read(self):
        # units/tanks.lua overrides s3 and s4 to HEAVY. Reading these as VEH
        # (which a naive scan does, because a scale body's own
        # `weapons = { [1] = ... }` uses the same spelling) would grade a HEAVY
        # roster on the VEH mask — the Meridian failure one class down.
        self.assertEqual(self.facts["ms_tanks_s2"].movementclass, "VEH")
        self.assertEqual(self.facts["ms_tanks_s3"].movementclass, "HEAVY")
        self.assertEqual(self.facts["ms_tanks_s4"].movementclass, "HEAVY")
        self.assertEqual(self.facts["ms_soldiers_s1"].movementclass, "INFANTRY")

    def test_speed_is_elmos_per_second(self):
        # UnitDef.cpp derives `speed` as maxVelocity * GAME_SPEED, and
        # game_scenario.lua's contestability check divides by speed/30. Getting
        # this factor wrong silently changes every notBefore the generator emits.
        self.assertAlmostEqual(self.facts["ms_tanks_s1"].speed, 2.6 * 30, places=3)


class TestGeneratorOnSyntheticMaps(unittest.TestCase):

    def setUp(self):
        if not os.path.isdir(GAME_DIR):
            self.skipTest(f"no game content at {GAME_DIR}")

    def test_generates_a_scenario_on_open_ground(self):
        with SyntheticMap(flat_map, "synth_flat") as d:
            lua, meta = sg.generate(d, seed=11, game_dir=GAME_DIR)
        self.assertEqual(count_victory_flags(lua), 1,
                         "exactly one terminal objective, or the war cannot end")
        self.assertEqual(meta["sides"], 2)
        self.assertGreater(meta["buildings"], 0, "no cluster buildings placed")
        self.assertIn("HEAVY", meta["classes"])

    def test_same_seed_twice_is_byte_identical(self):
        """Invariant 4. Two runs, two fresh interpreter states, same bytes."""
        with SyntheticMap(flat_map, "synth_flat") as d:
            a, _ = sg.generate(d, seed=11, game_dir=GAME_DIR)
            b, _ = sg.generate(d, seed=11, game_dir=GAME_DIR)
        self.assertEqual(a, b)
        self.assertEqual(a.encode(), b.encode())

    def test_a_different_seed_gives_a_different_scenario(self):
        """Guards the inverse: a generator that ignored its seed would also be
        'deterministic', and would pass the test above."""
        with SyntheticMap(flat_map, "synth_flat") as d:
            a, ma = sg.generate(d, seed=11, game_dir=GAME_DIR)
            b, mb = sg.generate(d, seed=12, game_dir=GAME_DIR)
        self.assertNotEqual(a, b)
        self.assertNotEqual(ma["id"], mb["id"])

    def test_determinism_survives_a_separate_process(self):
        """PYTHONHASHSEED randomises str hashing per process, so anything that
        reached output through set/dict ordering would differ here and nowhere
        else. This is the test that actually catches rule 3."""
        with SyntheticMap(flat_map, "synth_flat") as d:
            outs = []
            for hs in ("0", "1", "12345"):
                env = dict(os.environ, PYTHONHASHSEED=hs)
                r = subprocess.run(
                    [sys.executable, os.path.join(MAPGEN, "scenariogen.py"), d,
                     "--seed", "11", "--game-dir", GAME_DIR, "--stdout"],
                    capture_output=True, env=env, timeout=600)
                self.assertEqual(r.returncode, 0, r.stderr.decode())
                outs.append(r.stdout)
        self.assertEqual(outs[0], outs[1])
        self.assertEqual(outs[1], outs[2])

    def test_stdout_carries_only_the_scenario(self):
        """`--stdout > out.lua` must produce a loadable scenario, not a report
        with a scenario glued to the end of it. The human summary goes to
        stderr for exactly this reason."""
        with SyntheticMap(flat_map, "synth_flat") as d:
            expected, _ = sg.generate(d, seed=11, game_dir=GAME_DIR)
            r = subprocess.run(
                [sys.executable, os.path.join(MAPGEN, "scenariogen.py"), d,
                 "--seed", "11", "--game-dir", GAME_DIR, "--stdout"],
                capture_output=True, timeout=600)
        self.assertEqual(r.returncode, 0, r.stderr.decode())
        self.assertEqual(r.stdout.decode(), expected,
                         "--stdout emitted something other than the scenario")
        self.assertIn(b"cluster(s)", r.stderr,
                      "the summary should still be reported, on stderr")

    def test_a_map_split_by_a_cliff_is_REJECTED(self):
        """Invariant 5, proved to be capable of failing.

        The region graph in this fixture still declares the two halves adjacent,
        so a generator that verified connectivity on the graph would sail
        through. Only the passability mask sees the wall.
        """
        with SyntheticMap(walled_map, "synth_walled") as d:
            with self.assertRaises(sg.Rejected) as cm:
                sg.generate(d, seed=11, game_dir=GAME_DIR)
        msg = str(cm.exception)
        self.assertIn("disconnected components", msg)
        self.assertIn("landing zone", msg, "the message must name what is stranded")

    def test_no_unit_spawns_inside_a_building_footprint(self):
        """The 2026-07-26 bug, as a regression test.

        Re-derived from the emitted file rather than from the generator's
        in-memory state, and expanded through the loader's own `count`/`spacing`
        grid — a unit entry is up to `count` positions, and it is the corner
        instances, not the anchor, that land on a neighbouring structure.
        """
        with SyntheticMap(flat_map, "synth_flat") as d:
            lua, _ = sg.generate(d, seed=11, game_dir=GAME_DIR)
        facts = ms_defs.load(GAME_DIR)
        entries = parse_units(lua)
        buildings = [e for e in entries if facts[e["def"]].building]
        self.assertTrue(buildings, "fixture placed no buildings to collide with")

        offenders = []
        for e in entries:
            f = facts[e["def"]]
            if f.building:
                continue
            for dx, dz in sg.grid_offsets(e.get("count", 1), e.get("spacing", 150)):
                x, z = e["x"] + dx, e["z"] + dz
                for b in buildings:
                    bf = facts[b["def"]]
                    dist = math.hypot(x - b["x"], z - b["z"])
                    if dist < bf.clear_radius:
                        offenders.append(
                            f'{e["def"]} at ({x:.0f},{z:.0f}) is {dist:.0f} elmos '
                            f'from {b["def"]} (clear radius {bf.clear_radius:.0f})')
        self.assertEqual(offenders, [], "units trapped in a blocked yardmap:\n" +
                         "\n".join(offenders))

    def test_buildings_do_not_overlap_each_other(self):
        with SyntheticMap(flat_map, "synth_flat") as d:
            lua, _ = sg.generate(d, seed=11, game_dir=GAME_DIR)
        facts = ms_defs.load(GAME_DIR)
        bs = [e for e in parse_units(lua) if facts[e["def"]].building]

        def rect(e):
            f = facts[e["def"]]
            hx = f.footprint_x * ms_defs.FOOTPRINT_SCALE * 4
            hz = f.footprint_z * ms_defs.FOOTPRINT_SCALE * 4
            return (e["x"] - hx, e["z"] - hz, e["x"] + hx, e["z"] + hz)

        for i, a in enumerate(bs):
            for b in bs[i + 1:]:
                ra, rb = rect(a), rect(b)
                self.assertTrue(
                    ra[2] <= rb[0] or rb[2] <= ra[0] or
                    ra[3] <= rb[1] or rb[3] <= ra[1],
                    f'{a["def"]}@({a["x"]},{a["z"]}) overlaps '
                    f'{b["def"]}@({b["x"]},{b["z"]})')

    def test_every_playable_side_is_staged_an_army(self):
        """Invariant 3 (endtoend D19), read off the emitted file."""
        with SyntheticMap(flat_map, "synth_flat") as d:
            lua, meta = sg.generate(d, seed=11, game_dir=GAME_DIR)
        entries = parse_units(lua)
        facts = ms_defs.load(GAME_DIR)
        for team in range(meta["sides"]):
            mobile = [e for e in entries
                      if e.get("team") == team and not facts[e["def"]].building]
            self.assertTrue(mobile, f"side {team} has no mobile units")
            self.assertTrue(any(e.get("orders") for e in mobile),
                            f"side {team}'s army has no opening orders — it is "
                            f"scenery, not an army (war_units_unordered)")

    def test_neutral_clusters_use_the_string_team(self):
        """Gaia's id is playerTeamCount, so it is not knowable at authoring
        time; a generated file that hard-coded a number would put its neutral
        towns on whichever player team landed on that index."""
        with SyntheticMap(flat_map, "synth_flat") as d:
            lua, _ = sg.generate(d, seed=11, game_dir=GAME_DIR,
                                 hostility="neutral")
        self.assertIn("team = 'neutral'", lua)
        for e in parse_units(lua):
            if e.get("team") == "neutral":
                break
        else:
            self.fail("no neutral-owned entries emitted")

    def test_victory_timing_beats_the_loaders_own_check(self):
        """§7 gate 3, recomputed here the way game_scenario.lua does it."""
        with SyntheticMap(flat_map, "synth_flat") as d:
            _lua, meta = sg.generate(d, seed=11, game_dir=GAME_DIR)
        earliest = meta["not_before"] + meta["hold_frames"]
        self.assertGreaterEqual(earliest, meta["worst_frames"],
                                "the loader would publish war_victory_unreachable = 1")
        self.assertGreaterEqual(earliest, meta["worst_frames"] * sg.CONTEST_MARGIN,
                                "no margin over a straight-line estimate that "
                                "understates real travel time (endtoend D20)")
        self.assertGreaterEqual(meta["hold_frames"], sg.DEFAULT_VICTORY_HOLD_FRAMES)


class TestGoldenFixture(unittest.TestCase):
    """tests/fixtures/generated_scenario.lua must still be what the generator emits.

    That fixture is the input to tests/test_scenario_discovery.cpp, which runs it
    through the very `lua_State` the lobby uses. It is generated from the
    SYNTHETIC map rather than a shipped one so it reproduces in any checkout,
    including a clone whose gitignored data/maps/ is absent.

    This is the plan's golden-file test (§10): it pins byte-identity for a fixed
    (map, seed, generator-version) and is the thing that fails when the emitted
    format drifts away from what the C++ side is asserting about.
    """

    FIXTURE = os.path.join(REPO, "tests", "fixtures", "generated_scenario.lua")

    def setUp(self):
        if not os.path.isdir(GAME_DIR):
            self.skipTest(f"no game content at {GAME_DIR}")

    def test_fixture_matches_a_fresh_generation(self):
        with SyntheticMap(flat_map, "synth_flat") as d:
            lua, _ = sg.generate(d, seed=11, game_dir=GAME_DIR)
        with open(self.FIXTURE, encoding="utf-8") as f:
            on_disk = f.read()
        self.assertEqual(
            on_disk, lua,
            "tests/fixtures/generated_scenario.lua is stale. Regenerate it:\n"
            "  python3 tools/mapgen/tests/regen_fixture.py\n"
            "and re-check what tests/test_scenario_discovery.cpp asserts about it.")


class TestEmittedFileIsPureLua(unittest.TestCase):
    """Invariant 1, checked with a real Lua interpreter where one exists.

    The authoritative check is the C++ one — tests/test_scenario_discovery.cpp
    runs a generated fixture through the very `lua_State` the lobby uses. This
    is the fast local echo of it.
    """

    def setUp(self):
        if not os.path.isdir(GAME_DIR):
            self.skipTest(f"no game content at {GAME_DIR}")
        import shutil
        self.lua = shutil.which("lua") or shutil.which("lua5.4")
        if not self.lua:
            self.skipTest("no `lua` interpreter on PATH")

    def test_loads_in_a_bare_interpreter_and_has_the_expected_shape(self):
        with SyntheticMap(flat_map, "synth_flat") as d:
            lua, meta = sg.generate(d, seed=11, game_dir=GAME_DIR)
        with tempfile.NamedTemporaryFile("w", suffix=".lua", delete=False) as f:
            f.write(lua)
            path = f.name
        try:
            probe = f'''
                local scn = dofile({path!r})
                assert(type(scn) == 'table', 'did not return a table')
                assert(scn.version == 1, 'wrong schema version')
                assert(type(scn.world) == 'table' and scn.world.map ~= nil)
                local victories = 0
                for _, o in ipairs(scn.objectives or {{}}) do
                    if o.victory == true then victories = victories + 1 end
                end
                assert(victories == 1, 'expected exactly 1 victory objective, got ' .. victories)
                local staged = {{}}
                for _, u in ipairs(scn.units or {{}}) do
                    if type(u.team) == 'number' then staged[u.team] = true end
                end
                for _, s in ipairs(scn.sides or {{}}) do
                    assert(type(s.faction) == 'string' and s.faction ~= '')
                    assert(not s.faction:find('[,:]'), 'faction key breaks war_sides encoding')
                end
                print('ok ' .. victories)
            '''
            r = subprocess.run([self.lua, "-e", probe],
                               capture_output=True, text=True, timeout=60)
            self.assertEqual(r.returncode, 0,
                             f"generated Lua failed to load: {r.stderr}")
        finally:
            os.unlink(path)

    def test_no_vfs_require_or_sim_globals_at_file_scope(self):
        """The lobby's parser has none of these. A scenario that uses one does
        not fail loudly — it silently disappears from the lobby's list."""
        with SyntheticMap(flat_map, "synth_flat") as d:
            lua, _ = sg.generate(d, seed=11, game_dir=GAME_DIR)
        code = code_only(lua)
        for forbidden in ("VFS.", "require", "Spring.", "GG.", "gadget"):
            self.assertNotIn(forbidden, code,
                             f"emitted scenario references {forbidden}")


class TestShippedMaps(unittest.TestCase):
    """The acceptance matrix, against real map data when it is reachable."""

    TARGETS = ["scorched_crossing_v2.4", "wanderlust2.1",
               "techno_lands_final_2.60_wide"]

    def setUp(self):
        if MAPS_DIR is None:
            self.skipTest("no data/maps/ reachable (it is gitignored); "
                          "set MS_MAPS_DIR to run the shipped-map matrix")
        if not os.path.isdir(GAME_DIR):
            self.skipTest(f"no game content at {GAME_DIR}")

    def test_each_target_map_generates_across_several_seeds(self):
        for name in self.TARGETS:
            d = os.path.join(MAPS_DIR, name)
            if not os.path.isdir(d):
                self.fail(f"target map {name} is missing from {MAPS_DIR}")
            for seed in (1, 7, 42):
                with self.subTest(map=name, seed=seed):
                    lua, meta = sg.generate(d, seed=seed, game_dir=GAME_DIR)
                    self.assertEqual(count_victory_flags(lua), 1)
                    self.assertEqual(meta["map_id"], name)
                    self.assertGreater(meta["buildings"], 0)
                    # Invariant 5 is about the armour class specifically.
                    self.assertIn("HEAVY", meta["classes"])

    def test_meridian_basin_is_REJECTED(self):
        """The known-bad map, and the reason every gate here exists.

        Its start positions sit in different connected components for every
        movement class except INFANTRY, so its two armies can never meet. A
        generator that accepted it would be shipping the exact defect that made
        the hand-authored scenario unplayable.
        """
        d = os.path.join(MAPS_DIR, "meridian_basin")
        if not os.path.isdir(d):
            self.skipTest("meridian_basin not present")
        with self.assertRaises(sg.Rejected) as cm:
            sg.generate(d, seed=7, game_dir=GAME_DIR)
        msg = str(cm.exception)
        self.assertIn("disconnected components", msg)
        self.assertIn("component", msg)
        self.assertRegex(msg, r"(HEAVY|VEH)",
                         "the message must name the movement class that fails")

    def test_the_cli_exits_nonzero_on_a_rejection(self):
        """So `--verify` is usable as a CI gate, mirroring
        regions_from_map.py's own --verify exit code."""
        d = os.path.join(MAPS_DIR, "meridian_basin")
        if not os.path.isdir(d):
            self.skipTest("meridian_basin not present")
        r = subprocess.run(
            [sys.executable, os.path.join(MAPGEN, "scenariogen.py"), d,
             "--seed", "7", "--game-dir", GAME_DIR, "--verify"],
            capture_output=True, text=True, timeout=1200)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("REJECTED", r.stderr)


# ==========================================================================

def code_only(lua: str) -> str:
    """The emitted file with `--` comments stripped.

    Every structural assertion below runs on this, not on the raw text: the
    generated file DOCUMENTS the invariants it satisfies, so a comment
    explaining `victory = true` would otherwise be counted as a second victory
    objective and the test would fail on its own prose.
    """
    return "\n".join(ln.split("--")[0] for ln in lua.splitlines())


def count_victory_flags(lua: str) -> int:
    return len(re.findall(r"\bvictory\s*=\s*true\b", code_only(lua)))


def parse_units(lua: str) -> list[dict]:
    """The `units` entries of an emitted scenario, back out of the text.

    Reading the emitted FILE rather than the generator's in-memory structures is
    the point: the placement invariants have to hold for what actually ships,
    and an emit bug that dropped a coordinate would otherwise pass every test.
    """
    body = lua.split("units = {", 1)[1]
    body = body.split("\n    },", 1)[0]
    out = []
    for m in re.finditer(
            r"\{\s*def\s*=\s*'([^']+)'\s*,\s*team\s*=\s*("
            r"\d+|'[a-z]+')\s*,\s*x\s*=\s*(-?\d+)\s*,\s*z\s*=\s*(-?\d+)"
            r"(?P<rest>[^}]*)", body):
        rest = m.group("rest")
        team = m.group(2)
        e = {"def": m.group(1),
             "team": int(team) if team.isdigit() else team.strip("'"),
             "x": int(m.group(3)), "z": int(m.group(4))}
        c = re.search(r"count\s*=\s*(\d+)", rest)
        s = re.search(r"spacing\s*=\s*(\d+)", rest)
        if c:
            e["count"] = int(c.group(1))
        if s:
            e["spacing"] = int(s.group(1))
        e["orders"] = "orders" in rest or "orders" in body[m.end():m.end() + 40]
        out.append(e)
    return out


if __name__ == "__main__":
    unittest.main()
