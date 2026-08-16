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

    ⚠ `MS_MAPS_DIR` is checked FIRST, and the order is the whole point. A lane
    clone that has generated even one map has a `data/maps` of its own — it
    just holds the terragen maps and not the external ones this matrix targets
    — so a local-first order made the override unreachable in exactly the case
    it exists for, and the matrix failed with "scorched_crossing_v2.4 is
    missing" however the variable was set.
    """
    for cand in (os.environ.get("MS_MAPS_DIR", ""),
                 os.path.join(REPO, "data", "maps")):
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


def grid_regions(cols: int, rows: int, home_cells, wall_between=None,
                 elmos: int = ELMOS):
    """A `cols` x `rows` lattice of rectangular regions, 4-connected."""
    out = []
    cw, ch = elmos // cols, elmos // rows
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


# A town needs roughly 1500 elmos of ground across (`scenariogen.TOWN_RADII`
# bottoms out at 648, and a town is two radii wide), so `flat_map`'s 1024-elmo
# square with its 256-elmo cells cannot hold one at any radius — every region
# refuses with "offmap". That is correct behaviour and it is also why the town
# path needs a bigger synthetic map of its own: without one the golden fixture
# carries no `towns` and no `civilians` block, and test_scenario_discovery.cpp —
# the ONLY place a generated file's Lua purity is actually proved against the
# lobby's bare lua_State — would never see either.
WIDE_SAMPLES = 513                 # 512 * 8 = 4096 elmos square
WIDE_ELMOS = (WIDE_SAMPLES - 1) * 8


def wide_flat_map(root, name="synth_wide"):
    """Four times `flat_map` across: big enough that a region can hold a town."""
    heights = [10.0] * (WIDE_SAMPLES * WIDE_SAMPLES)
    return write_map(root, name, heights,
                     grid_regions(3, 3, {(0, 0), (2, 2)}, elmos=WIDE_ELMOS))


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


RIVER_HALF_WIDTH = 12          # samples of channel either side of the centreline
RIVER_RAMP = 8                 # samples of bank ramp; sets the bank's slope
RIVER_DROP = 20.0              # metres from bank crest to riverbed


def river_map(root, name="synth_river"):
    """Drivable ground split by ONE crossable river running along Z.

    The bridge fixture. A river is the only terrain a span belongs over (§M3:
    `floating = true` holds a chain level on water, while over dry ground the
    engine's unconditional ground clamp steps every segment with the terrain),
    so a generator that places bridges needs a map with water on it to be tested
    against at all — and `flat_map` deliberately has none.

    The channel is FORDABLE and its banks are gentle, so the two sides stay in
    one component and the reachability gate still passes: this fixture tests the
    bridge finder, not the negative control (`walled_map` is that). Both numbers
    are graded against MOVE_CLASSES, not guessed —

      * depth: the bed sits 10 m under water, inside HEAVY's 30-elmo limit;
      * slope: RIVER_DROP over RIVER_RAMP samples is 2.5 m per 8 elmos = 17.4
        deg, inside HEAVY's 24. A first draft cut the bank at 36.9 deg and the
        reachability gate correctly refused the whole map — the same gate the
        bridge exists to serve.
    """
    heights = [10.0] * (SAMPLES * SAMPLES)
    mid = SAMPLES // 2
    for z in range(SAMPLES):
        for x in range(mid - RIVER_HALF_WIDTH, mid + RIVER_HALF_WIDTH + 1):
            t = min(1.0, (RIVER_HALF_WIDTH - abs(x - mid)) / RIVER_RAMP)
            heights[z * SAMPLES + x] = 10.0 - RIVER_DROP * t
    return write_map(root, name, heights,
                     grid_regions(4, 4, {(0, 0), (3, 3)}))


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


class TestPlannedTowns(unittest.TestCase):
    """The `town` cluster kind goes through the town planner (T4).

    Everything here is measured on `wide_flat_map`, because `flat_map`'s
    1024-elmo square cannot hold a town at any radius — which is itself the
    first thing asserted, since "the planner quietly did nothing" and "this map
    has no room" are the same output with different meanings.
    """

    def setUp(self):
        if not os.path.isdir(GAME_DIR):
            self.skipTest(f"no game content at {GAME_DIR}")

    def wide(self, seed=11):
        with SyntheticMap(wide_flat_map, "synth_wide") as d:
            return sg.generate(d, seed=seed, game_dir=GAME_DIR)

    def test_a_map_with_room_gets_planned_towns(self):
        _lua, meta = self.wide()
        self.assertTrue(meta["towns"], "no town planned on a 4 km flat map")
        for t in meta["towns"]:
            self.assertGreaterEqual(t["lots"], 5)
            self.assertGreaterEqual(t["buildings"], 1)
            self.assertGreater(t["civilians"], 0)

    def test_a_map_with_no_room_falls_back_and_says_why(self):
        """The scatter is the FALLBACK, not a failure — but a silent one would
        be indistinguishable from a broken toolchain."""
        with SyntheticMap(flat_map, "synth_flat") as d:
            _lua, meta = sg.generate(d, seed=11, game_dir=GAME_DIR)
        self.assertEqual([], meta["towns"])
        self.assertTrue(meta["town_refusals"])
        for key, why in meta["town_refusals"]:
            self.assertTrue(key and why)
        # ...and the map still gets its towns, as scattered clusters.
        self.assertTrue(any(k == "town" for k, _r, _o in meta["clusters"]))

    def test_a_towns_key_is_its_regions_key(self):
        """The whole reason a town needs no second namespace."""
        _lua, meta = self.wide()
        for t in meta["towns"]:
            self.assertEqual(t["key"], t["region"])
        cluster_regions = {r for k, r, _o in meta["clusters"] if k == "town"}
        for t in meta["towns"]:
            self.assertIn(t["key"], cluster_regions)

    def test_every_town_has_exactly_one_meeting_hall(self):
        """`unique` is a contract the parley venue rests on."""
        _lua, meta = self.wide()
        for t in meta["towns"]:
            self.assertIsNotNone(t["hall"], f"{t['key']} has no parley venue")
        lua = self.wide()[0]
        self.assertEqual(len(meta["towns"]), lua.count("            hall = {"))

    def test_the_hall_is_a_unit_the_scenario_actually_stages(self):
        """The gadget resolves the venue by looking for that def at that spot;
        a hall the `units` block never staged resolves to nothing, and the town
        then negotiates exactly as if its hall had been destroyed."""
        lua, meta = self.wide()
        units = parse_units(lua)
        for t in meta["towns"]:
            hall = t["hall"]
            self.assertTrue(
                any(u["def"] == hall["def"] and u["x"] == hall["x"]
                    and u["z"] == hall["z"] for u in units),
                f"{t['key']}'s hall is not in the units block")

    def test_a_planned_town_is_always_the_estates_however_hostile_the_knob(self):
        with SyntheticMap(wide_flat_map, "synth_wide") as d:
            _lua, meta = sg.generate(d, seed=11, hostility="hostile",
                                     game_dir=GAME_DIR)
        town_keys = {t["key"] for t in meta["towns"]}
        self.assertTrue(town_keys)
        for kind, key, owner in meta["clusters"]:
            if key in town_keys:
                self.assertEqual("neutral", owner)

    def test_the_town_region_is_named_after_the_town_and_given_no_team(self):
        lua, meta = self.wide()
        for t in meta["towns"]:
            self.assertIn(
                f"{{ key = '{t['key']}', name = '{t['name']}', "
                f"x = {t['x']}, z = {t['z']} }},", lua)
        # ...and never with a team, which would silently reassign the region.
        for line in lua.splitlines():
            if "name = '" in line and "key = '" in line:
                self.assertNotIn("team =", line)

    def test_civilians_go_on_the_civilians_wire_and_buildings_do_not(self):
        """Two wires, and swapping either way is a real bug: a building in the
        civilians block is enrolled in a CMD_MOVE it can never satisfy, and a
        civilian in `units` is invisible to the registry every objective and the
        estate read."""
        lua, meta = self.wide()
        civ_block = lua.split("civilians = {")[1].split("objectives = {")[0]
        buildings = {"ms_habitat", "ms_depot", "ms_transit_hub"}
        for name in buildings:
            self.assertNotIn(f"def = '{name}'", civ_block)
        people = {"ms_civilians", "ms_militia", "ms_civtruck", "ms_civbus"}
        self.assertTrue(any(f"def = '{n}'" in civ_block for n in people))

        # Scoped to the PLANNED towns. `place_cluster`'s own town/mine clusters
        # legitimately put ms_civilians in `units` — that path predates the
        # registry and is the metalstorm-scenario lane's, untouched here. What
        # must not happen is a PLANNED town's residents going down that wire,
        # where the estate and every objective query are blind to them.
        #
        # NEUTRAL entries only, and that qualifier is load-bearing rather than a
        # loophole. A town's residents are Gaia's — `populate_town` has no other
        # owner to give them — so "a resident leaked onto the `units` wire" is
        # always a NEUTRAL civilian def standing in the town. A HOSTILE one is a
        # different animal with a different owner: §M4 relic guardians are
        # ms_militia on a hostile team, and `_rank_regions` deliberately lets a
        # relic share an already-occupied region ("a township WITH a grain silo
        # is the normal arrangement"), so a guard band squatting in a town's
        # outskirts is that lane's intended output, not this lane's leak.
        # Matching on the def name alone cannot tell the two apart — militia
        # serve both roles — so it is the team that decides.
        for t in meta["towns"]:
            for e in parse_units(lua):
                if e["def"] not in people or e["team"] != "neutral":
                    continue
                d = math.hypot(e["x"] - t["x"], e["z"] - t["z"])
                self.assertGreater(
                    d, t["radius"],
                    f"a civilian was staged through `units` inside {t['key']}")

    def test_every_civilian_names_a_declared_town(self):
        """The loader rejects one that does not; catching it here is cheaper
        than at GameStart."""
        lua, meta = self.wide()
        declared = {t["key"] for t in meta["towns"]}
        found = 0
        for m in re.finditer(r"town = '([^']+)' \}", lua):
            found += 1
            self.assertIn(m.group(1), declared)
        self.assertEqual(found, meta["civilians"])

    def test_town_buildings_carry_a_real_facing(self):
        """A town's buildings FRONT THEIR STREET. All-south would mean the
        planner's facings were dropped somewhere between the stager and emit —
        and the engine derives the blocked footprint from the facing, so the
        clearance gates would then be grading the wrong rectangles."""
        lua, meta = self.wide()
        if not meta["towns"]:
            self.skipTest("no town planned")
        facings = {u["facing"] for u in parse_units(lua)
                   if u.get("team") == "neutral"}
        self.assertGreater(len(facings), 1, facings)

    def test_towns_differ_across_seeds(self):
        shapes = []
        for seed in (11, 12, 13):
            _lua, meta = self.wide(seed)
            shapes.append(tuple((t["archetype"], t["defense"], t["lots"],
                                 t["civilians"]) for t in meta["towns"]))
        self.assertEqual(len(set(shapes)), len(shapes),
                         "three seeds produced the same towns")

    def test_the_same_seed_reproduces_the_same_towns(self):
        a, ma = self.wide()
        b, mb = self.wide()
        self.assertEqual(a, b)
        self.assertEqual(ma["towns"], mb["towns"])


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
        with SyntheticMap(wide_flat_map, "synth_wide") as d:
            lua, _ = sg.generate(d, seed=11, game_dir=GAME_DIR)
        with open(self.FIXTURE, encoding="utf-8") as f:
            on_disk = f.read()
        self.assertEqual(
            on_disk, lua,
            "tests/fixtures/generated_scenario.lua is stale. Regenerate it:\n"
            "  python3 tools/mapgen/tests/regen_fixture.py\n"
            "and re-check what tests/test_scenario_discovery.cpp asserts about it.")

    def test_the_fixture_carries_a_planned_town(self):
        """...so the C++ purity test actually sees the blocks a town adds.

        The fixture moved off `flat_map` (1024 elmos, no region big enough for a
        town) onto `wide_flat_map` for exactly this: `towns` and `civilians` are
        new syntax, and test_scenario_discovery.cpp running the file through the
        lobby's bare `lua_State` is the ONLY place their purity is proved. A
        fixture with no town would leave that unproved and look fine.
        """
        with open(self.FIXTURE, encoding="utf-8") as f:
            on_disk = f.read()
        self.assertIn("    towns = {", on_disk)
        self.assertIn("    civilians = {", on_disk)
        self.assertIn("role = 'ambient'", on_disk)
        self.assertIn("hall = {", on_disk)


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
        f = re.search(r"facing\s*=\s*'([a-z]+)'", rest)
        # A planned town's buildings FRONT THEIR STREET, so `facing` stopped
        # being the constant 'south' every scattered cluster emits — and the
        # engine derives the blocked footprint from it (Unit.cpp:224-225), so a
        # test grading placement has to be able to see it.
        e["facing"] = f.group(1) if f else None
        if c:
            e["count"] = int(c.group(1))
        if s:
            e["spacing"] = int(s.group(1))
        e["orders"] = "orders" in rest or "orders" in body[m.end():m.end() + 40]
        out.append(e)
    return out


def parse_features(lua: str) -> list[dict]:
    """The `world.features` entries, back out of the emitted text.

    Same reasoning as `parse_units`: what ships is the file, so the file is what
    the invariants are asserted against.
    """
    if "features = {" not in lua:
        return []
    body = lua.split("features = {", 1)[1].split("\n        },", 1)[0]
    out = []
    for m in re.finditer(r"\{\s*def\s*=\s*'([^']+)'\s*,\s*x\s*=\s*(-?\d+)\s*,"
                         r"\s*z\s*=\s*(-?\d+)(?P<rest>[^}]*)", body):
        rest = m.group("rest")
        e = {"def": m.group(1), "x": int(m.group(2)), "z": int(m.group(3))}
        for key, pat in (("y", r"\by\s*=\s*(-?\d+)"),
                         ("chain", r"\bchain\s*=\s*(\d+)"),
                         ("heading", r"\bheading\s*=\s*(-?\d+)")):
            hit = re.search(pat, rest)
            if hit:
                e[key] = int(hit.group(1))
        nm = re.search(r"name\s*=\s*'([^']*)'", rest)
        fc = re.search(r"facing\s*=\s*'([^']*)'", rest)
        if nm:
            e["name"] = nm.group(1)
        if fc:
            e["facing"] = fc.group(1)
        out.append(e)
    return out


def landmark_names(lua: str) -> list[str]:
    """Every ENTRY `name = '...'` in the emitted file, in file order.

    A `name` on a `units` or `world.features` entry is what game_scenario.lua
    turns into a landmark_<name>_x/_z rulesParam, so this is exactly the set the
    command language will be able to address. Anchored on the same line as a
    `def = ` to exclude the scenario's own top-level display name, which is a
    title and not a place you can send anything to.
    """
    return [m.group(1) for ln in code_only(lua).splitlines()
            if "def =" in ln
            for m in [re.search(r"name\s*=\s*'([^']*)'", ln)] if m]


# ==========================================================================
# §M4 — named sites, relics, wreck fields and crossings
# ==========================================================================

class TestNamedSites(unittest.TestCase):
    """Every generated war ships named, addressable ground."""

    def setUp(self):
        if not os.path.isdir(GAME_DIR):
            self.skipTest(f"no game content at {GAME_DIR}")

    def test_sites_are_named_gaia_buildings_from_the_shipped_site_defs(self):
        from scenario_templates import SITE_TEMPLATES
        with SyntheticMap(flat_map, "sites") as d:
            lua, meta = sg.generate(d, seed=5, game_dir=GAME_DIR, sites=3)
        self.assertEqual(len(meta["sites"]), 3,
                         "asked for three sites and did not get three")
        units = parse_units(lua)
        for defname, key, name in meta["sites"]:
            self.assertIn(defname, SITE_TEMPLATES)
            entry = next(u for u in units if u["def"] == defname)
            # Gaia, not a player team: a site nobody owns is the thing both
            # sides can take, which is the whole point of placing one.
            self.assertEqual(entry["team"], "neutral")
            self.assertIn(name, landmark_names(lua))

    def test_a_site_name_is_its_region_name_so_a_player_can_say_it(self):
        with SyntheticMap(flat_map, "sitename") as d:
            lua, meta = sg.generate(d, seed=5, game_dir=GAME_DIR, sites=3)
            regions = {r["key"]: r["name"] for r in sg.read_region_graph(d)}
        for _defname, key, name in meta["sites"]:
            self.assertTrue(
                name.startswith(regions[key]),
                f"site name {name!r} does not start with its region's name "
                f"{regions[key]!r} — the name a player has actually seen")

    def test_landmark_names_are_unique(self):
        # The name IS the rulesParam key (landmark_<name>_x), so a duplicate
        # would silently overwrite the other's position and one landmark would
        # vanish from the client's index. game_scenario.lua rejects the file
        # outright; the generator must never emit one.
        with SyntheticMap(flat_map, "lmuniq") as d:
            lua, meta = sg.generate(d, seed=3, game_dir=GAME_DIR, sites=6,
                                    relics=3)
        names = landmark_names(lua)
        self.assertEqual(sorted(names), sorted(set(names)))
        self.assertEqual(sorted(names), meta["landmarks"])

    def test_a_landmark_name_never_ends_in_the_coordinate_suffix(self):
        # `landmark_<name>_x` is parsed with a greedy name capture anchored at
        # end-of-string, so a name ending in _x or _z splits at the wrong
        # underscore and loses a coordinate.
        with SyntheticMap(flat_map, "lmsuffix") as d:
            lua, _ = sg.generate(d, seed=9, game_dir=GAME_DIR, sites=6)
        for name in landmark_names(lua):
            self.assertFalse(name.endswith("_x") or name.endswith("_z"), name)

    def test_relics_are_features_with_a_guardian_band(self):
        with SyntheticMap(flat_map, "relic") as d:
            lua, meta = sg.generate(d, seed=5, game_dir=GAME_DIR, relics=1)
        self.assertEqual(len(meta["relics"]), 1)
        defname, _key, name, guards = meta["relics"][0]
        feats = {f["def"]: f for f in parse_features(lua)}
        self.assertIn(defname, feats, "the relic is not in world.features")
        self.assertEqual(feats[defname].get("name"), name)
        self.assertGreater(guards, 0, "an unguarded prize is not a prize")

    def test_a_neutral_war_has_no_guardians_to_be_hostile_with(self):
        with SyntheticMap(flat_map, "relicneutral") as d:
            _lua, meta = sg.generate(d, seed=5, game_dir=GAME_DIR, relics=1,
                                     hostility="neutral")
        for _def, _key, _name, guards in meta["relics"]:
            self.assertEqual(guards, 0)


class TestWreckField(unittest.TestCase):
    def setUp(self):
        if not os.path.isdir(GAME_DIR):
            self.skipTest(f"no game content at {GAME_DIR}")

    def test_wrecks_land_on_the_contested_region_and_do_not_overlap(self):
        with SyntheticMap(flat_map, "wrecks") as d:
            lua, meta = sg.generate(d, seed=5, game_dir=GAME_DIR, wrecks=5)
        self.assertEqual(len(meta["wrecks"]), 5)
        fdefs = sg.load_feature_facts(GAME_DIR)
        placed = [f for f in parse_features(lua) if f["def"] in fdefs
                  and f["def"].endswith("_wreck")]
        self.assertEqual(len(placed), 5)
        for i, a in enumerate(placed):
            ahx, ahz = sg.feature_half_extent(fdefs, a["def"])
            for b in placed[i + 1:]:
                bhx, bhz = sg.feature_half_extent(fdefs, b["def"])
                self.assertFalse(
                    abs(a["x"] - b["x"]) < ahx + bhx and
                    abs(a["z"] - b["z"]) < ahz + bhz,
                    f"{a} and {b} overlap — a wreck blocks ground, so two "
                    f"overlapping ones are one wreck and a hole in the map")

    def test_the_blocking_gate_can_actually_fail(self):
        # A gate never seen to fail is a rubber stamp. Here the mask is stamped
        # by hand with a wall of "wrecks" straight down the map, which is what
        # a badly-placed field across a chokepoint amounts to.
        with SyntheticMap(flat_map, "wreckgate") as d:
            terrain, _map_id = sg.load_terrain(d, ["VEH"])
        span = (terrain.W - 1) * 8
        mid = span // 2
        wall = [(mid - 40, z, mid + 40, z + 200) for z in range(0, span, 200)]
        points = [("west", 200, mid), ("east", span - 200, mid)]
        sg.gate_reachability(terrain, points, "synth")     # passes bare
        with self.assertRaises(sg.Rejected) as caught:
            sg.gate_blocking_features_leave_the_war_fightable(
                terrain, wall, points, "synth")
        self.assertIn("unfightable", str(caught.exception))

    def test_no_wrecks_requested_means_no_gate_and_no_features(self):
        with SyntheticMap(flat_map, "nowrecks") as d:
            _lua, meta = sg.generate(d, seed=5, game_dir=GAME_DIR, wrecks=0,
                                     relics=0)
        self.assertEqual(meta["wrecks"], [])


class TestCrossings(unittest.TestCase):
    def setUp(self):
        if not os.path.isdir(GAME_DIR):
            self.skipTest(f"no game content at {GAME_DIR}")

    def test_a_river_map_gets_a_chained_span_at_the_waterline(self):
        with SyntheticMap(river_map, "river") as d:
            lua, meta = sg.generate(d, seed=5, game_dir=GAME_DIR, bridges=1)
        self.assertEqual(len(meta["crossings"]), 1,
                         "a map with a river and no bridge is the whole bug")
        _key, name, spans, width = meta["crossings"][0]
        span = next(f for f in parse_features(lua)
                    if f["def"] == "ms_road_bridge")
        self.assertEqual(span.get("name"), name)
        self.assertEqual(span.get("chain"), spans)
        # y = 0 is the waterline and it is load-bearing: without it the chain
        # settles into a staircase down the riverbed (§M3 measured
        # -31/-34.5/-45.9/-57.6 for four spans laid without one).
        self.assertEqual(span.get("y"), 0)
        # A deck that covers the gap but overhangs the banks is worse than one
        # that stops short: `floating` beats gravity only in water, so a dry
        # segment clamps to the terrain and the chain kinks upward. The deck is
        # therefore sized by FLOOR over the water and must not exceed it.
        self.assertLessEqual(spans * 24, width + 24)
        self.assertGreaterEqual(spans, sg.MIN_BRIDGE_SPANS)

    def test_every_span_of_the_chain_sits_over_water(self):
        # THE invariant, and the one a live boot had to teach: the first
        # version sized the deck to reach the drivable banks and produced
        # spans at y = 0.00 / 15.7 / 97.8 / 203.5 / 230.1 / 250.7 / 252.0 —
        # a ramp into the sky. Asserted with the loader's own chaining
        # arithmetic (game_scenario.lua stageFeatures: segment i sits at
        # (i - (count-1)/2) * pitch from the centre), not with a restatement
        # of it.
        with SyntheticMap(river_map, "riverafloat") as d:
            lua, _meta = sg.generate(d, seed=5, game_dir=GAME_DIR, bridges=1)
            terrain, _mid = sg.load_terrain(d, ["VEH"])
        span = next(f for f in parse_features(lua)
                    if f["def"] == "ms_road_bridge")
        n = span["chain"]
        for i in range(n):
            step = (i - (n - 1) / 2.0) * 24.0
            # river_map's channel runs along Z, so the chain runs along X.
            x, z = span["x"] + step, span["z"]
            self.assertTrue(terrain.is_water(x, z),
                            f"segment {i} of {n} at ({x:.0f},{z:.0f}) is on "
                            f"dry ground (h={terrain.height_at(x, z):.1f}) — "
                            f"it will clamp to the terrain and kink the deck")

    def test_the_span_lies_across_the_river_not_along_it(self):
        with SyntheticMap(river_map, "riveraxis") as d:
            lua, _meta = sg.generate(d, seed=5, game_dir=GAME_DIR, bridges=1)
        span = next(f for f in parse_features(lua)
                    if f["def"] == "ms_road_bridge")
        # river_map's channel runs along Z, so the crossing runs along X.
        # game_scenario.lua's headingToDir maps 'east' to +X.
        self.assertEqual(span.get("facing"), "east")

    def test_a_map_with_no_water_gets_no_bridge_rather_than_a_bad_one(self):
        with SyntheticMap(flat_map, "nowater") as d:
            lua, meta = sg.generate(d, seed=5, game_dir=GAME_DIR, bridges=1)
        self.assertEqual(meta["crossings"], [])
        self.assertNotIn("ms_road_bridge",
                         [f["def"] for f in parse_features(lua)])


class TestFeatureDefsAreReal(unittest.TestCase):
    def setUp(self):
        if not os.path.isdir(GAME_DIR):
            self.skipTest(f"no game content at {GAME_DIR}")

    def test_every_featuredef_the_templates_name_is_shipped(self):
        from scenario_templates import (ANCIENT_SITES, BRIDGE_SPANS,
                                        WRECK_FIELD)
        fdefs = sg.load_feature_facts(GAME_DIR)
        named = sorted(set(ANCIENT_SITES) | {d for d, _w in WRECK_FIELD} |
                       set(BRIDGE_SPANS.values()))
        self.assertEqual(sg.verify_feature_defs(fdefs, named, GAME_DIR), [])

    def test_feature_extents_come_from_content_not_from_a_copy(self):
        # The half-extent must be the engine's own arithmetic on the def's
        # footprint (xsize = footprint * SPRING_FOOTPRINT_SCALE, 4 elmos per
        # xsize unit) — the first draft used the models' metre dimensions and
        # packed five wrecks into 180 elmos.
        fdefs = sg.load_feature_facts(GAME_DIR)
        self.assertEqual(fdefs["ms_tank_wreck"], (4, 5))
        self.assertEqual(sg.feature_half_extent(fdefs, "ms_tank_wreck"),
                         (32, 40))


if __name__ == "__main__":
    unittest.main()
