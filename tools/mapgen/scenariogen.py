#!/usr/bin/env python3
"""scenariogen.py — generate a complete, playable Metalstorm scenario from a
map and a seed (PLAN-metalstorm-scenariogen.md §4, tasks 2/3/5/6).

Metalstorm wars do not start with one builder unit. A scenario lands an army
that already exists at a start location and sends it out to take control of
ground that is already occupied — so what this tool emits is: a pre-deployed
roster per playable side, clusters of existing buildings (towns / outposts /
bases / extraction sites) owned by neutral or hostile factions, and exactly one
terminal objective the war can be won on.

    scenariogen.py <map-dir> --seed 7 [--out FILE] [knobs...]

`<map-dir>` is a PROCESSED map directory (data/maps/<id>), not the source
package. Anchoring on it rather than on __file__ is deliberate and copied from
regions_from_map.py: `data/` is gitignored, so this tool is routinely run from a
worktree that has no map data of its own while pointing at the real one.

WHAT THIS FILE DOES NOT DO. It never reimplements slope, water or reachability
grading — `regions_from_map.py` owns the passability mask, the flood fill and
`verify_starts`, and this module imports them. The single most expensive bug in
this area (Meridian Basin: two armies in different connected components, a war
that could not be fought) was caused by grading connectivity on the region
GRAPH instead of on the mask, so the mask is the arbiter here too.

FIVE INVARIANTS. A generated scenario that violates any of these is a bug, not
a variation, and the generator refuses to write the file rather than shipping it:

  1. Pure Lua table literal. `ScenarioDiscovery::LoadOne` parses the emitted
     file with a bare `lua_State` — no VFS, no `Spring.*`, no `require`, no
     computed globals at file scope (ScenarioDiscovery.h:33-37). A scenario
     needing any of those does not fail loudly; it silently vanishes from the
     lobby.
  2. Exactly one objective with `victory = true`. It is the only terminal
     condition game_gameover.lua watches, and `DefaultForMap` skips a
     non-terminal scenario outright (ScenarioDiscovery.cpp:310).
  3. Every playable side resolves to a team with staged `units`, so
     `ScenarioSide.staged` is true for all of them (endtoend D19: a room slot
     picks a SIDE, and a side with no army is how a lobby-created war put the
     AI on an empty team). Sides are numbered consecutively from 0 precisely so
     the engine materialises no unoccupied gap teams between them.
  4. Determinism. Same seed + same map + same generator version ⇒ byte-identical
     output. Every rule that makes that true is listed at RULES OF DETERMINISM
     below; each one is a real failure mode, not advice.
  5. The war is winnable ON THAT MAP: both sides' spawns and the victory
     region are mutually reachable on the passability mask, for EVERY movement
     class the emitted roster contains — not just the default VEH. A roster
     carrying HEAVY units graded only on VEH reproduces the Meridian failure
     one class down.

  ...plus the placement rule that has already cost one debugging session:
     nothing spawns inside a building's blocked yardmap. A unit on a
     structure's exact centre is trapped permanently — GiveOrderToUnit
     "succeeds" and the unit never moves (see the `civilians` block comment in
     scenarios/meridian_basin.lua). Clearance is computed from each def's real
     footprint via ms_defs, mirroring civilians/spawn.lua's
     footprintClearRadius, and asserted before emit.

RULES OF DETERMINISM
  * One `random.Random(seed)` threaded explicitly through every choice. The
    module-level `random` is never touched.
  * Only `rnd.random()` is used as the entropy primitive — weighted picks and
    integer draws are derived from it here, so the output cannot shift if
    CPython changes how `choice`/`choices`/`shuffle` consume the stream.
  * Nothing that reaches output iterates a dict or a set. Region order is the
    graph file's order; every derived collection is explicitly sorted.
  * All coordinates are integral elmos, formatted with `%d`.
  * No timestamps, hostnames or absolute paths appear in the emitted file.
"""

from __future__ import annotations

import argparse
import math
import os
import re
import sys
from collections import deque

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ms_defs                                            # noqa: E402
from regions_from_map import (                            # noqa: E402
    DEFAULT_CLASS,
    ELMOS_PER_SQUARE,
    MOVE_CLASSES,
    _nearest_passable_component,
    components,
    passable_mask,
    read_heightmap,
    read_map_row,
    read_mapinfo,
    verify_starts,
)
from scenario_templates import (                          # noqa: E402
    ARMY_ROSTERS,
    CLUSTER_TEMPLATES,
    HOSTILE_FACTION,
    HOSTILE_SLATE_KINDS,
    PLAYABLE_FACTIONS,
    SCENARIO_SUFFIXES,
)

# Bumped whenever the emitted output changes for an unchanged (map, seed).
# Part of the scenario id, so a bump cannot silently collide with an older row.
GENERATOR_VERSION = 1

SCHEMA_VERSION = 1          # game_scenario.lua's SUPPORTED_VERSION
GAME_SPEED = 30             # sim frames per second

# game_scenario.lua:75. A `victory = true` control objective ENDS THE WAR, so it
# is sized against the map, not against a tactical reward.
DEFAULT_VICTORY_HOLD_FRAMES = 5400

# §7 gate 3. The loader's own contestability check measures straight-line
# distance and therefore UNDERSTATES travel time (real routes detour around
# terrain), so merely matching its arithmetic would leave a scenario that passes
# the check and still decides before contact — endtoend D20, "an unopposed
# three-unit patrol won the war 45 s after arriving".
CONTEST_MARGIN = 1.5

# Inflation applied to a footprint rectangle when testing it against an
# already-placed one, so two buildings never share a wall.
FOOTPRINT_GAP = 32

# Slack added on top of two units' combined body radii when spacing spawn
# points. Spring refuses to create a unit whose footprint is already occupied
# and reports it only by returning nil, so an under-spaced pair loses one of the
# two silently — the staged war is simply one unit short of the file.
UNIT_SPAWN_GAP = 16


class Rejected(Exception):
    """A scenario that cannot satisfy an invariant. Never written to disk.

    Carries an actionable message: which gate failed, on which map, and — for
    the reachability gate — which labelled points landed in which component.
    """


# ==========================================================================
# The map's region graph
# ==========================================================================

_REGION_RE = re.compile(
    r'key\s*=\s*"(?P<key>[^"]+)"\s*,\s*'
    r'name\s*=\s*"(?P<name>[^"]*)"\s*,\s*'
    r'polygon\s*=\s*\{(?P<poly>.*?)\}\s*,\s*'
    r'value\s*=\s*(?P<value>-?[0-9.]+)\s*,\s*'
    r'tags\s*=\s*\{(?P<tags>[^}]*)\}\s*,\s*'
    r'neighbors\s*=\s*\{(?P<nbrs>[^}]*)\}',
    re.DOTALL)


def read_region_graph(map_dir: str) -> list[dict]:
    """Parse `<map-dir>/mapdata/regions.lua` into ordered region dicts.

    Regex rather than a Lua parser, for the reason `read_mapinfo` gives: the
    shape is fixed (regions_from_map.py's `to_lua` writes every generated
    graph, and the one hand-authored graph uses the identical layout), and the
    tool that would evaluate it is the sim, which is not running here.

    This reads the file the SIM will read, rather than re-deriving the graph in
    memory. The scenario's region keys have to match whatever the map actually
    ships, and a re-derivation with different `--target-regions` would produce
    keys no map on disk has — which the loader rejects hard at GameStart
    (game_scenario.lua's slate region validation) or, worse, which silently
    address nothing.
    """
    path = os.path.join(map_dir, "mapdata", "regions.lua")
    if not os.path.exists(path):
        raise Rejected(
            f"{os.path.basename(map_dir)} ships no mapdata/regions.lua, so "
            f"game_regions.lua falls back to the fixed 2048-elmo grid and the "
            f"named region keys a scenario needs do not exist. Run "
            f"tools/mapgen/regions_from_map.py on it first.")
    with open(path, encoding="utf-8") as fh:
        text = fh.read()

    out = []
    for m in _REGION_RE.finditer(text):
        verts = [(int(float(x)), int(float(z))) for x, z in
                 re.findall(r"x\s*=\s*(-?[0-9.]+)\s*,\s*z\s*=\s*(-?[0-9.]+)",
                            m.group("poly"))]
        if not verts:
            continue
        out.append({
            "key": m.group("key"),
            "name": m.group("name"),
            "polygon": verts,
            "value": float(m.group("value")),
            "tags": re.findall(r'"([^"]*)"', m.group("tags")),
            "neighbors": re.findall(r'"([^"]*)"', m.group("nbrs")),
        })
    if not out:
        raise Rejected(f"{path}: no regions parsed")
    return out


def region_centre(region: dict) -> tuple[float, float]:
    """The polygon's VERTEX AVERAGE — the exact quantity the sim publishes.

    game_regions.lua:226-231 computes `region_<key>_x/z` this way, and
    game_scenario.lua's contestability check measures against those very
    rulesParams. Any other notion of "centre" here would make this generator's
    arithmetic disagree with the loader's, which is the difference between a
    gate and a guess.
    """
    n = len(region["polygon"])
    return (sum(v[0] for v in region["polygon"]) / n,
            sum(v[1] for v in region["polygon"]) / n)


def hop_distances(regions: list[dict], source: str) -> dict[str, int]:
    """Region-graph hop counts from `source`. Unreachable keys are absent."""
    nbrs = {r["key"]: r["neighbors"] for r in regions}
    dist = {source: 0}
    q = deque([source])
    while q:
        k = q.popleft()
        for n in nbrs.get(k, ()):
            if n not in dist and n in nbrs:
                dist[n] = dist[k] + 1
                q.append(n)
    return dist


# ==========================================================================
# Seeded choice — see RULES OF DETERMINISM
# ==========================================================================

def _pick_weighted(rnd, items: list[tuple]) -> tuple:
    """One of `items` (each `(value, weight, ...)`), odds proportional to weight.

    Built on `rnd.random()` alone rather than `random.choices` so the emitted
    file cannot shift if CPython changes how a helper consumes the stream.
    """
    total = sum(max(0.0, float(it[1])) for it in items)
    if total <= 0:
        return items[0]
    r = rnd.random() * total
    acc = 0.0
    for it in items:
        acc += max(0.0, float(it[1]))
        if r < acc:
            return it
    return items[-1]


def _pick_int(rnd, lo: int, hi: int) -> int:
    """A uniform integer in [lo, hi], from `rnd.random()`."""
    if hi <= lo:
        return lo
    return lo + min(hi - lo, int(rnd.random() * (hi - lo + 1)))


# ==========================================================================
# Terrain: masks, components, and where a thing may stand
# ==========================================================================

class Terrain:
    """Passability masks and connected components, one set per movement class.

    Every grading decision in this file goes through here, and every mask comes
    from `regions_from_map.passable_mask` — this class holds them, it does not
    compute them.
    """

    def __init__(self, hs, W, H, classes: list[str]):
        self.W, self.H = W, H
        self.heights = hs
        self.masks: dict[str, bytearray] = {}
        self.comps: dict[str, list[int]] = {}
        for c in sorted(classes):
            deg, depth = MOVE_CLASSES[c]
            ok = passable_mask(hs, W, H, deg, depth)
            comp, _ = components(ok, W, H)
            self.masks[c], self.comps[c] = ok, comp

    @property
    def classes(self) -> list[str]:
        return sorted(self.masks)

    def strictest(self) -> str:
        """The class with the least passable ground — the binding constraint.

        Ordered by max slope ascending (HEAVY 24 deg < VEH 32 < INFANTRY 45),
        so this is "the fussiest thing we are about to stage".
        """
        return min(self.classes, key=lambda c: MOVE_CLASSES[c][0])

    def sample_of(self, x: float, z: float) -> tuple[int, int]:
        sx = max(0, min(self.W - 1, int(round(x / ELMOS_PER_SQUARE))))
        sz = max(0, min(self.H - 1, int(round(z / ELMOS_PER_SQUARE))))
        return sx, sz

    def passable(self, x: float, z: float, mclass: str) -> bool:
        sx, sz = self.sample_of(x, z)
        return bool(self.masks[mclass][sz * self.W + sx])

    def component_at(self, x: float, z: float, mclass: str) -> int:
        """Component id of the passable sample nearest (x, z), or -1.

        Delegates to regions_from_map's own outward search: a point placed on
        ground the engine accepts is not always a sample this grading calls
        passable (a start pad can sit one sample from a cliff edge).
        """
        return _nearest_passable_component(
            self.masks[mclass], self.comps[mclass], self.W, self.H, x, z)

    def footprint_clear(self, x: float, z: float, fx: int, fz: int,
                        mclass: str) -> bool:
        """Is every sample under an `fx`x`fz` footprint centred on (x,z) passable?

        Buildability has no separate grade in this substrate, so vehicle-passable
        ground stands in for buildable ground — a structure on a cliff face or
        in deep water is what this rejects.
        """
        half_x = fx * ms_defs.FOOTPRINT_SCALE * 4
        half_z = fz * ms_defs.FOOTPRINT_SCALE * 4
        for dz in (-half_z, 0, half_z):
            for dx in (-half_x, 0, half_x):
                if not self.passable(x + dx, z + dz, mclass):
                    return False
        return True


def load_terrain(map_dir: str, classes: list[str]) -> tuple[Terrain, str]:
    """Heightmap + passability masks for `map_dir`.

    The map's DECLARED start positions are deliberately not used. §7 gate 1
    grades the coordinates this generator actually stages armies at, which are
    offset from any start pad; verifying the declared positions instead would
    grade something the scenario does not ship.

    Dimensions come from the `maps` DB row rather than being inferred: a sample
    count alone cannot distinguish WxH from HxW on a rectangular map, and
    guessing the transpose reads every row at the wrong stride (wanderlust2.1
    graded as 3.6% vehicle-passable when it is almost entirely drivable).
    """
    map_id = os.path.basename(map_dir.rstrip("/"))
    repo_root = os.path.abspath(os.path.join(map_dir, "..", "..", ".."))
    info = read_mapinfo(map_dir)
    row = read_map_row(map_id, repo_root)
    dims = (int(row[1]) + 1, int(row[2]) + 1) if row and row[1] and row[2] else None
    hs, W, H = read_heightmap(map_dir, info["minheight"], info["maxheight"], dims)
    return Terrain(hs, W, H, classes), map_id


# ==========================================================================
# Placement
# ==========================================================================

def grid_offsets(count: int, spacing: int) -> list[tuple[float, float]]:
    """Exactly game_scenario.lua's `gridOffsets` (:107-121), in Python.

    The loader spreads `count` copies of a `units` entry over this grid, so an
    entry is not one point but up to `count` of them. Checking only the entry's
    anchor against building footprints would miss the corner instances — which
    is precisely how a unit ends up inside a blocked yardmap.
    """
    count = max(1, count)
    cols = math.ceil(math.sqrt(count))
    out = []
    for i in range(count):
        row, col = divmod(i, cols)
        out.append(((col - (cols - 1) / 2) * spacing,
                    (row - (cols - 1) / 2) * spacing))
    return out


class Building:
    __slots__ = ("defname", "x", "z", "facing", "facts")

    def __init__(self, defname, x, z, facing, facts):
        self.defname, self.x, self.z = defname, int(x), int(z)
        self.facing, self.facts = facing, facts

    def rect(self, pad: float = 0.0):
        hx = self.facts.footprint_x * ms_defs.FOOTPRINT_SCALE * 4 + pad
        hz = self.facts.footprint_z * ms_defs.FOOTPRINT_SCALE * 4 + pad
        return (self.x - hx, self.z - hz, self.x + hx, self.z + hz)

    def clears(self, x: float, z: float) -> bool:
        """Is (x, z) outside this building's blocked yardmap at every angle?"""
        return math.hypot(x - self.x, z - self.z) >= self.facts.clear_radius


def _too_close(ax: float, az: float, a_facts, others) -> bool:
    """Would a unit at (ax, az) overlap an already-placed one?

    `others` is a list of (x, z, facts). Compared on body radii rather than a
    flat distance so a 6x6 Bastion and a 2x2 civilian group get the clearance
    each actually needs.
    """
    for ox, oz, of in others:
        need = a_facts.body_radius + of.body_radius + UNIT_SPAWN_GAP
        if math.hypot(ax - ox, az - oz) < need:
            return True
    return False


def _rects_overlap(a, b) -> bool:
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def region_anchor(terrain: Terrain, region: dict,
                  want_comp: dict[str, int] | None = None) -> tuple[int, int] | None:
    """A point inside `region` passable for every graded movement class.

    With `want_comp`, additionally restricted to the given component per class —
    used once the reachability gate has established which component the war is
    being fought in, so later placements cannot wander into a pocket.

    Called with `want_comp = None` for the sides' own landing zones, on purpose:
    constraining those would turn "these two armies are in different components"
    into "this region has no ground", hiding the one diagnosis that matters
    behind a vaguer one. The gate reports it instead, by name.

    Scans outward from the polygon centroid on a fixed stride, so the answer is
    a function of the terrain alone — no RNG, so two runs on one seed cannot
    disagree about where a region "is".
    """
    cx, cz = region_centre(region)
    xs = [v[0] for v in region["polygon"]]
    zs = [v[1] for v in region["polygon"]]
    x0, x1, z0, z1 = min(xs), max(xs), min(zs), max(zs)
    step = ELMOS_PER_SQUARE * 4
    reach = int(max(x1 - x0, z1 - z0) / 2) + step

    for r in range(0, reach + step, step):
        ring = [(0, 0)] if r == 0 else (
            [(dx, dz) for dx in (-r, 0, r) for dz in (-r, 0, r)
             if abs(dx) == r or abs(dz) == r])
        for dx, dz in sorted(ring):
            x, z = cx + dx, cz + dz
            if not (x0 <= x <= x1 and z0 <= z <= z1):
                continue
            if not all(terrain.passable(x, z, c) for c in terrain.classes):
                continue
            if want_comp is not None and any(
                    terrain.component_at(x, z, c) != want_comp[c]
                    for c in terrain.classes if c in want_comp):
                continue
            return int(x), int(z)
    return None


def place_cluster(rnd, terrain: Terrain, facts, region: dict, kind: str,
                  anchor: tuple[int, int], placed: list[Building],
                  placed_units: list[tuple[int, int, object]]
                  ) -> tuple[list[Building], list[dict]]:
    """One town / outpost / base / extraction site: buildings then garrison.

    The two halves have opposite placement rules and that is the whole point of
    the yardmap trap — buildings must not overlap EACH OTHER, and garrison units
    must not overlap ANY building. A unit spawned on a structure's centre is
    trapped inside its blocked yardmap for the rest of the match.
    """
    tpl = CLUSTER_TEMPLATES[kind]
    ax, az = anchor
    # A cluster belongs INSIDE its region. The template radius is a maximum, not
    # a target: on a map whose regions are smaller than that, an unclamped
    # radius spills a town across its neighbours — and, when the neighbour is a
    # landing zone, drops buildings on top of an army's spawn grid.
    xs = [v[0] for v in region["polygon"]]
    zs = [v[1] for v in region["polygon"]]
    radius = max(120, min(tpl["radius"],
                          int(0.40 * min(max(xs) - min(xs), max(zs) - min(zs)))))

    # --- how many of each building, from the template's weights -------------
    wanted: list[str] = []
    for defname, _w, lo, _hi in tpl["buildings"]:
        wanted.extend([defname] * lo)
    extra = _pick_int(rnd, 1, 3)
    caps = {d: hi for d, _w, _lo, hi in tpl["buildings"]}
    for _ in range(extra):
        cand = [b for b in tpl["buildings"]
                if wanted.count(b[0]) < caps[b[0]]]
        if not cand:
            break
        wanted.append(_pick_weighted(rnd, cand)[0])

    buildings: list[Building] = []
    for defname in wanted:
        f = facts[defname]
        spot = None
        # Rings outward from the anchor; 12 seeded angles each. Rejecting and
        # widening beats jittering in place, which packs everything at the
        # centre and then fails every overlap test.
        for ring in range(0, 6):
            rad = (radius * ring) / 5.0
            for _ in range(12):
                ang = rnd.random() * math.tau
                x = ax + math.cos(ang) * rad
                z = az + math.sin(ang) * rad
                if not terrain.footprint_clear(x, z, f.footprint_x,
                                               f.footprint_z, DEFAULT_CLASS):
                    continue
                cand = Building(defname, x, z, "south", f)
                if any(_rects_overlap(cand.rect(FOOTPRINT_GAP), b.rect())
                       for b in buildings + placed):
                    continue
                # A building must not be dropped ON an already-placed unit
                # either. The yardmap trap is symmetric, and clusters are laid
                # out one after another: without this, a town's habitat lands on
                # the garrison a neighbouring outpost placed two steps earlier,
                # and that garrison is trapped for the whole match. Checking
                # only building-vs-building missed exactly this case.
                if any(not cand.clears(ux, uz) for ux, uz, _uf in placed_units):
                    continue
                spot = cand
                break
            if spot:
                break
        if spot:
            buildings.append(spot)

    # --- garrison, strictly OUTSIDE every building's clear radius ------------
    garrison: list[dict] = []
    local_units: list[tuple[int, int, object]] = []
    if buildings:
        # One ring wide enough to clear the biggest footprint in the cluster
        # from the cluster's own centre, then verified against every building
        # individually — a ring sized off the max is necessary, not sufficient,
        # because a building placed out at `radius` moves the constraint.
        ring_r = max(b.facts.clear_radius for b in buildings) + 60
        for defname, _w, lo, hi in tpl["garrison"]:
            n = _pick_int(rnd, lo, hi)
            for _ in range(n):
                f = facts[defname]
                mclass = f.movementclass or DEFAULT_CLASS
                spot = None
                for widen in range(8):
                    rad = ring_r + widen * 70
                    for _ in range(10):
                        ang = rnd.random() * math.tau
                        x = ax + math.cos(ang) * rad
                        z = az + math.sin(ang) * rad
                        if not terrain.passable(x, z, mclass):
                            continue
                        if not all(b.clears(x, z) for b in buildings + placed):
                            continue
                        if _too_close(x, z, f, placed_units + local_units):
                            continue
                        spot = (int(x), int(z))
                        break
                    if spot:
                        break
                if spot:
                    garrison.append({"def": defname, "x": spot[0],
                                     "z": spot[1], "facing": "south"})
                    local_units.append((spot[0], spot[1], f))
    return buildings, garrison


# ==========================================================================
# The gates (§7) — each one refuses to write rather than shipping
# ==========================================================================

def gate_reachability(terrain: Terrain, points: list[tuple[str, int, int]],
                      map_id: str) -> dict[str, int]:
    """Every labelled point mutually reachable, on the MASK, for EVERY class.

    Checked against the passability mask, never against the region graph. That
    distinction is the entire lesson of Meridian Basin: regions are coarse
    rectangles and one rectangle routinely spans several disconnected
    components, so a graph walk happily routes two armies "through" a cell they
    each only touch a different pocket of — it reported Meridian as fine, the
    exact map whose start positions provably cannot meet.

    Returns the component id per class, for callers that must place further
    things in the same component.
    """
    want: dict[str, int] = {}
    for mclass in terrain.classes:
        # regions_from_map's own verify_starts stays the arbiter of pass/fail;
        # the labelled grouping below exists only to make the message name
        # WHICH of our points is stranded, which bare indices cannot.
        ok, _msg, _ids = verify_starts(
            terrain.masks[mclass], terrain.comps[mclass], terrain.W, terrain.H,
            [(x, z) for _l, x, z in points])

        groups: dict[int, list[str]] = {}
        for label, x, z in points:
            groups.setdefault(terrain.component_at(x, z, mclass), []).append(label)

        if not ok:
            detail = "; ".join(
                f"component {c}: {', '.join(sorted(labels))}" if c >= 0
                else f"IMPASSABLE GROUND: {', '.join(sorted(labels))}"
                for c, labels in sorted(groups.items()))
            raise Rejected(
                f"{map_id}: the {mclass} movement class cannot cross between "
                f"these positions — they lie in "
                f"{len(groups)} disconnected components of the passability "
                f"mask. {detail}. This war could not be fought: those armies "
                f"can never meet. (This is the exact defect that made "
                f"meridian_basin unplayable.)")
        want[mclass] = next(iter(groups))
    return want


def gate_no_unit_in_a_footprint(unit_points: list[tuple[str, float, float]],
                                buildings: list[Building]) -> None:
    """No spawned unit stands inside any building's blocked yardmap.

    Spawning on a structure's footprint traps the unit permanently:
    GiveOrderToUnit "succeeds" and the unit never moves. Found and fixed
    2026-07-26 at the cost of a debugging session (scenarios/meridian_basin.lua's
    `civilians` comment); a generator that can recreate it must assert against
    it, since nothing downstream will.
    """
    bad = []
    for label, x, z in unit_points:
        for b in buildings:
            if not b.clears(x, z):
                bad.append(f"{label} at ({int(x)},{int(z)}) is "
                           f"{math.hypot(x - b.x, z - b.z):.0f} elmos from "
                           f"{b.defname} at ({b.x},{b.z}), inside its "
                           f"{b.facts.clear_radius:.0f}-elmo blocked footprint")
                break
    if bad:
        raise Rejected("units spawned inside a building's yardmap — they would "
                       "be trapped there for the whole match:\n  " +
                       "\n  ".join(bad))


def gate_no_two_units_share_a_spot(points: list[tuple[str, float, float, object]]) -> None:
    """No two spawn points are closer than their combined body radii.

    Spring refuses to create a unit on ground another unit already occupies, and
    it reports that by returning nil from `Spring.CreateUnit` — no error, no
    warning, nothing in any log. The staged war is just quietly one unit short
    of the file that describes it.

    Found by census rather than by reading code: a headless boot of a generated
    scenario staged 23 of its 24 neutral entries, and the missing one was an
    ms_civilians sitting 41 elmos from an ms_militia whose combined body radii
    are 45.
    """
    bad = []
    for i, (la, ax, az, fa) in enumerate(points):
        for lb, bx, bz, fb in points[i + 1:]:
            need = fa.body_radius + fb.body_radius + UNIT_SPAWN_GAP
            d = math.hypot(ax - bx, az - bz)
            if d < need:
                bad.append(f"{la} at ({int(ax)},{int(az)}) and {lb} at "
                           f"({int(bx)},{int(bz)}) are {d:.0f} elmos apart but "
                           f"need {need:.0f} — one of the two would not spawn")
    if bad:
        raise Rejected("two units staged on the same ground:\n  " +
                       "\n  ".join(bad))


# ==========================================================================
# Generation
# ==========================================================================

def _fnv1a(text: str) -> int:
    h = 0x811C9DC5
    for ch in text.encode("utf-8"):
        h = ((h ^ ch) * 0x01000193) & 0xFFFFFFFF
    return h


def _b36(n: int, width: int = 4) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    for _ in range(width):
        out = digits[n % 36] + out
        n //= 36
    return out


def scenario_id(map_id: str, seed: int, version: int) -> str:
    """`gen_<map-slug>_<hash>` — a file stem, so also a valid `scenario` modoption.

    The stem IS the id: game_scenario.lua does
    `VFS.Include('scenarios/' .. name .. '.lua')` with the value
    ScenarioDiscovery takes from the file stem, so anything a path separator or
    an exotic character would break is unusable here.
    """
    slug = re.sub(r"[^a-z0-9]+", "_", map_id.lower()).strip("_")[:20]
    return f"gen_{slug}_{_b36(_fnv1a(f'{map_id}|{seed}|{version}'))}"


def generate(map_dir: str, seed: int, sides: int = 2, towns: int = 3,
             outposts: int = 2, bases: int = 1, mines: int = 1,
             hostility: str = "mixed", roster: str = "standard",
             version: int = GENERATOR_VERSION, game_dir: str | None = None):
    """Build one scenario. Returns `(lua_source, meta)`. Raises `Rejected`."""
    import random
    rnd = random.Random(seed)

    map_id = os.path.basename(map_dir.rstrip("/"))
    repo_root = os.path.abspath(os.path.join(map_dir, "..", "..", ".."))
    game_dir = game_dir or os.path.join(repo_root, "data", "games", "metalstorm")
    facts = ms_defs.load(game_dir)

    regions = read_region_graph(map_dir)

    # --- which movement classes are actually about to be staged -------------
    roster_defs = [d for d, _c, _s in ARMY_ROSTERS[roster]]
    cluster_defs = sorted({d for tpl in CLUSTER_TEMPLATES.values()
                           for d, _w, _lo, _hi in tpl["buildings"] + tpl["garrison"]})
    problems = ms_defs.verify(facts, sorted(set(roster_defs + cluster_defs)))
    if problems:
        raise Rejected("templates name defs the content does not ship:\n  " +
                       "\n  ".join(problems))

    classes = sorted({facts[d].movementclass for d in roster_defs
                      if facts[d].movementclass} |
                     {facts[d].movementclass for d in cluster_defs
                      if facts[d].movementclass})
    terrain, map_id = load_terrain(map_dir, classes)
    strict = terrain.strictest()

    # --- home regions, one per playable side --------------------------------
    homes = [r for r in regions if "home" in r["tags"]]
    if len(homes) < sides:
        raise Rejected(
            f"{map_id}: {len(homes)} region(s) tagged `home` but {sides} "
            f"playable side(s) requested. `home` is set from the map's real "
            f"start positions (regions_from_map.py build_regions), so this map "
            f"cannot seat that many armies.")

    # Maximally separated in the graph, so the two armies do not start adjacent.
    # Deterministic tie-break on the key pair — never on dict order.
    best, best_pair = -1, None
    for i, a in enumerate(homes):
        d = hop_distances(regions, a["key"])
        for b in homes[i + 1:]:
            hops = d.get(b["key"])
            if hops is None:
                continue        # different graph components: not a usable pair
            pair = tuple(sorted((a["key"], b["key"])))
            if hops > best or (hops == best and pair < best_pair):
                best, best_pair = hops, pair
    if best_pair is None:
        raise Rejected(
            f"{map_id}: no two `home` regions are connected in the region "
            f"graph, so no two sides could ever reach each other.")

    by_key = {r["key"]: r for r in regions}
    side_regions = [by_key[best_pair[0]], by_key[best_pair[1]]]
    for extra in sorted(homes, key=lambda r: r["key"]):
        if len(side_regions) >= sides:
            break
        if extra["key"] not in best_pair:
            side_regions.append(extra)

    # --- landing zones, then INVARIANT 5 ------------------------------------
    # Anchors are chosen without any component constraint, and the gate is what
    # judges them. Filtering them by component first would be a rubber stamp:
    # the gate could then never fail, and the failure it exists to catch would
    # resurface as the far vaguer "this region has no usable ground".
    side_anchors = []
    for r in side_regions:
        a = region_anchor(terrain, r)
        if a is None:
            raise Rejected(
                f"{map_id}: home region '{r['key']}' contains no ground "
                f"passable for all of {', '.join(terrain.classes)} — the "
                f"armies staged there could not move at all.")
        side_anchors.append(a)

    want_comp = gate_reachability(
        terrain,
        [(f"side {i} landing zone ({r['key']})", a[0], a[1])
         for i, (r, a) in enumerate(zip(side_regions, side_anchors))],
        map_id)

    # --- victory region -----------------------------------------------------
    # Highest value, not a home, reachable in the graph from every side, and
    # preferring a chokepoint (`value` already lifts central and choke ground).
    reach = [hop_distances(regions, r["key"]) for r in side_regions]
    victory = None
    for r in sorted(regions, key=lambda r: (-r["value"], r["key"])):
        if "home" in r["tags"] or "island" in r["tags"]:
            continue
        if any(r["key"] not in d for d in reach):
            continue
        if region_anchor(terrain, r, want_comp) is None:
            continue
        if victory is None:
            victory = r
        if "chokepoint" in r["tags"]:
            victory = r
            break
    if victory is None:
        raise Rejected(
            f"{map_id}: no non-home region is both reachable in the region "
            f"graph from every landing zone and reachable on the ground for "
            f"{', '.join(terrain.classes)} — there is no ground both armies "
            f"could contest, so this war has no winnable objective.")
    victory_anchor = region_anchor(terrain, victory, want_comp)
    vx, vz = region_centre(victory)

    # Re-run the gate over the full set. The victory region was filtered to
    # `want_comp` above, so this cannot fail — which is exactly why it is here:
    # it states the invariant over the actual shipped positions rather than
    # trusting that the filter above stayed correct.
    gate_reachability(
        terrain,
        [(f"side {i} landing zone ({r['key']})", a[0], a[1])
         for i, (r, a) in enumerate(zip(side_regions, side_anchors))] +
        [(f"victory objective ({victory['key']})",
          victory_anchor[0], victory_anchor[1])],
        map_id)

    # --- clusters -----------------------------------------------------------
    # Every `home` region, not merely the two this scenario seats sides on.
    # `home` is set from the map's real start positions, and the target maps
    # expose more of them (6, 6, 4) than a 2-side war uses — dropping a
    # fortified NPC base onto an unused start pad would make the map unusable
    # for any launch that did seat someone there.
    home_keys = {r["key"] for r in regions if "home" in r["tags"]}
    hops_from_home = {}
    for r in side_regions:
        for k, d in hop_distances(regions, r["key"]).items():
            hops_from_home[k] = min(hops_from_home.get(k, 99), d)

    def candidates(kind: str, used: set[str]) -> list[dict]:
        tpl = CLUSTER_TEMPLATES[kind]
        out = []
        for r in regions:
            if r["key"] in used or r["key"] in home_keys:
                continue
            if r["key"] == victory["key"]:
                continue       # the prize stays clear, so neither side inherits it
            if "island" in r["tags"] or "water" in r["tags"]:
                continue
            if kind == "base" and hops_from_home.get(r["key"], 0) < 2:
                continue       # §6: a forward base is never next to a landing zone
            rank = next((i for i, t in enumerate(tpl["prefers"])
                         if t in r["tags"]), len(tpl["prefers"]))
            out.append((rank, -r["value"], r["key"], r))
        out.sort(key=lambda t: t[:3])
        return [t[3] for t in out]

    plan = ([("base", i) for i in range(bases)] +
            [("outpost", i) for i in range(outposts)] +
            [("town", i) for i in range(towns)] +
            [("mine", i) for i in range(mines)])

    used: set[str] = set()
    clusters = []
    all_buildings: list[Building] = []
    all_cluster_units: list[tuple[int, int, object]] = []
    for kind, _n in plan:
        for r in candidates(kind, used):
            anchor = region_anchor(terrain, r, want_comp)
            if anchor is None:
                continue
            bs, gs = place_cluster(rnd, terrain, facts, r, kind, anchor,
                                   all_buildings, all_cluster_units)
            if not bs:
                continue
            used.add(r["key"])
            all_buildings.extend(bs)
            all_cluster_units.extend((g["x"], g["z"], facts[g["def"]]) for g in gs)
            clusters.append({"kind": kind, "region": r, "anchor": anchor,
                             "buildings": bs, "garrison": gs})
            break

    # --- who owns them ------------------------------------------------------
    # `neutral` resolves to Gaia at stage time (game_scenario.lua stageUnits),
    # which Simulation.cpp configures as "neutral/environment, its own ally
    # team, no allies" and which exists regardless of roster. Hostile clusters
    # go to an ordinary NPC team: every non-Gaia team is its own ally team, so
    # an NPC team is hostile to both players with no extra configuration.
    hostile_team = sides
    for c in clusters:
        if hostility == "neutral":
            c["owner"] = "neutral"
        elif hostility == "hostile":
            c["owner"] = hostile_team
        else:                       # mixed — towns and mines are civilian ground
            c["owner"] = "neutral" if c["kind"] in ("town", "mine") else hostile_team

    # --- armies -------------------------------------------------------------
    units = []
    force = []          # per side: (centroid_x, centroid_z, min_speed)
    for i, (r, (ax, az)) in enumerate(zip(side_regions, side_anchors)):
        n_total, sum_x, sum_z, speed_min = 0, 0.0, 0.0, math.inf
        # Fan the roster's entries around the landing zone so a `count`-spread
        # entry does not overlap the next entry's.
        roster_entries = ARMY_ROSTERS[roster]
        army_points: list[tuple[int, int, object]] = []
        for j, (defname, count, spacing) in enumerate(roster_entries):
            f = facts[defname]
            spacing = spacing or 150
            offs = grid_offsets(count, spacing)

            def usable(px: float, pz: float) -> bool:
                """Every instance this entry spawns is on clear, drivable ground.

                Tested over the loader's own grid spread, not over the anchor: a
                `count = 6` entry is six positions, and it is the corner ones
                that reach a neighbouring structure. Anything landing inside a
                blocked yardmap is trapped there permanently.
                """
                for dx, dz in offs:
                    x, z = px + dx, pz + dz
                    if f.movementclass and not terrain.passable(x, z, f.movementclass):
                        return False
                    if not all(b.clears(x, z) for b in all_buildings):
                        return False
                    if _too_close(x, z, f, all_cluster_units + army_points):
                        return False
                return True

            # Preferred slot first, then widening rings. Walking outward rather
            # than nudging keeps the army a coherent landing party instead of
            # scattering it across the region.
            ang0 = math.tau * j / len(roster_entries)
            ex, ez = int(ax + math.cos(ang0) * 260), int(az + math.sin(ang0) * 260)
            if not usable(ex, ez):
                found = False
                for step in range(1, 10):
                    rad = 260 + step * 130
                    for k in range(12):
                        ang = ang0 + math.tau * k / 12
                        cx2 = int(ax + math.cos(ang) * rad)
                        cz2 = int(az + math.sin(ang) * rad)
                        if usable(cx2, cz2):
                            ex, ez, found = cx2, cz2, True
                            break
                    if found:
                        break
                if not found:
                    raise Rejected(
                        f"{map_id}: side {i}'s landing zone "
                        f"('{r['key']}') has nowhere to put {count}x "
                        f"{defname} that is both drivable and clear of the "
                        f"buildings placed nearby — the army would spawn "
                        f"trapped inside a structure's footprint.")
            army_points.extend((int(ex + dx), int(ez + dz), f) for dx, dz in offs)
            entry = {"def": defname, "team": i, "x": ex, "z": ez,
                     "facing": "south", "count": count,
                     "spacing": spacing}
            if f.speed > 0:
                # An opening FIGHT toward the prize. Without one, `war_units_
                # unordered` fires: a side whose whole staged force sits on its
                # spawn tile is not an army, it is scenery.
                entry["orders"] = [{"cmd": "FIGHT",
                                    "params": [int(vx), 0, int(vz)]}]
                n_total += count
                sum_x += ex * count
                sum_z += ez * count
                speed_min = min(speed_min, f.speed)
            units.append(entry)
        if n_total == 0:
            raise Rejected(f"{map_id}: side {i} staged no mobile units.")
        force.append((sum_x / n_total, sum_z / n_total, speed_min))

    # --- the victory objective's timing (§7 gate 3) -------------------------
    # Mirrors game_scenario.lua's checkVictoryIsContestable exactly — same
    # straight-line distance, same "slowest staged unit" speed, same
    # `earliest = notBefore + holdFrames` — then requires a x1.5 margin on top,
    # because that estimate understates real travel time.
    worst = 0.0
    for cx, cz, smin in force:
        worst = max(worst, math.hypot(vx - cx, vz - cz) / (smin / GAME_SPEED))
    hold = DEFAULT_VICTORY_HOLD_FRAMES
    not_before = max(0, int(math.ceil(worst * CONTEST_MARGIN)) - hold)
    if not_before + hold < worst:
        raise Rejected(f"{map_id}: victory timing arithmetic is inconsistent "
                       f"({not_before} + {hold} < {worst:.0f}).")

    # --- placement gate (the yardmap trap) ----------------------------------
    spawn_points = []
    for u in units:
        for dx, dz in grid_offsets(u.get("count", 1), u.get("spacing", 150)):
            spawn_points.append((f"{u['def']} (team {u['team']})",
                                 u["x"] + dx, u["z"] + dz, facts[u["def"]]))
    for c in clusters:
        for g in c["garrison"]:
            spawn_points.append((f"{g['def']} in {c['region']['key']}",
                                 g["x"], g["z"], facts[g["def"]]))
    gate_no_unit_in_a_footprint([(l, x, z) for l, x, z, _f in spawn_points],
                                all_buildings)
    gate_no_two_units_share_a_spot(spawn_points)

    # --- name ---------------------------------------------------------------
    # "<the place being fought over> — <a seeded suffix>", the shape the
    # hand-authored scenario uses ('Meridian Basin — Standard War').
    #
    # The head is the victory region's own `name`, which on every generated
    # graph IS regions_from_map.py's `name_for()` output — the same evocative
    # register the AI's debug output and the client overlay already surface, so
    # the scenario is named after a place a player can actually point at rather
    # than after a hash. On a hand-authored graph it is the author's name for
    # that region, which is better still. `name_for` is not called again here:
    # minting a second, unrelated name would decouple the title from the map.
    display = f"{victory['name']} — {SCENARIO_SUFFIXES[seed % len(SCENARIO_SUFFIXES)]}"

    meta = {
        "id": scenario_id(map_id, seed, version),
        "display_name": display,
        "map_id": map_id,
        "seed": seed,
        "version": version,
        "sides": sides,
        "victory_region": victory["key"],
        "hostile_team": hostile_team,
        "clusters": [(c["kind"], c["region"]["key"], c["owner"])
                     for c in clusters],
        "buildings": len(all_buildings),
        "classes": terrain.classes,
        "worst_frames": worst,
        "not_before": not_before,
        "hold_frames": hold,
    }
    return emit_lua(meta, side_regions, side_anchors, victory, units, clusters,
                    hostile_team, sides, not_before, hold), meta


# ==========================================================================
# Emit — a pure Lua table literal (invariant 1)
# ==========================================================================

def _lua_str(s: str) -> str:
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"


def _team_field(owner) -> str:
    return str(owner) if isinstance(owner, int) else _lua_str(owner)


def emit_lua(meta, side_regions, side_anchors, victory, units, clusters,
             hostile_team, sides, not_before, hold) -> str:
    L: list[str] = []
    add = L.append

    add(f"-- scenarios/{meta['id']}.lua — GENERATED by tools/mapgen/scenariogen.py")
    add(f"-- map={meta['map_id']} seed={meta['seed']} "
        f"generator-version={meta['version']}")
    add("--")
    add("-- Do not hand-edit: regenerate with")
    add(f"--   tools/mapgen/scenariogen.py data/maps/{meta['map_id']} "
        f"--seed {meta['seed']}")
    add("-- Generation is deterministic, so the same map and seed reproduce")
    add("-- this file byte for byte.")
    add("--")
    add("-- This file must stay a PURE Lua table literal. ScenarioDiscovery")
    add("-- parses it with a bare lua_State — the lobby binary has no VFS, no")
    add("-- Spring.* and no sim globals — so a `require` or a computed global at")
    add("-- file scope does not fail loudly, it makes the scenario silently")
    add("-- vanish from the lobby's list (ScenarioDiscovery.h:33-37).")
    add("--")
    add(f"-- Verified at generation time against {meta['map_id']}'s own")
    add("-- heightmap: both landing zones and the victory region are mutually")
    add(f"-- reachable on the passability mask for "
        f"{', '.join(meta['classes'])} — every movement class this roster")
    add("-- stages, not just the default VEH.")
    add("")
    add("return {")
    add(f"    version   = {SCHEMA_VERSION},")
    add(f"    name      = {_lua_str(meta['display_name'])},")
    add("    tutorial  = false,")
    add("    ephemeral = true,           -- a generated one-off, not a persistent war")
    add("")
    add("    world = {")
    add(f"        map     = {_lua_str(meta['map_id'])},")
    add("        -- Each side opens owning its own landing zone; everything else,")
    add("        -- the victory region included, starts uncontrolled.")
    add("        regions = {")
    for i, r in enumerate(side_regions):
        add(f"            {{ key = {_lua_str(r['key'])}, team = {i} }},")
    add("        },")
    add("    },")
    add("")
    add("    -- One team per playable side, numbered consecutively from 0 so the")
    add("    -- engine materialises no unoccupied gap teams between them. Every")
    add("    -- side below is staged an army in `units`, which is what makes")
    add("    -- ScenarioDiscovery resolve it with staged == true — a side with no")
    add("    -- army is a room slot that starts with nothing (endtoend D19).")
    add("    sides = {")
    for i in range(sides):
        add(f"        {{ faction = {_lua_str(PLAYABLE_FACTIONS[i % len(PLAYABLE_FACTIONS)])}, "
            f"team = {i} }},")
    if any(c["owner"] == hostile_team for c in clusters):
        add(f"        -- Team {hostile_team} is an NPC faction holding the fortified")
        add("        -- clusters (see `ai` below). Every non-Gaia team is its own")
        add("        -- ally team, so it is hostile to every player with no extra")
        add("        -- configuration.")
        add(f"        {{ faction = {_lua_str(HOSTILE_FACTION)}, team = {hostile_team} }},")
    add("    },")
    add("")

    hostile_clusters = [c for c in clusters if c["owner"] == hostile_team]
    if hostile_clusters:
        home = max(hostile_clusters,
                   key=lambda c: (len(c["buildings"]), c["region"]["key"])
                   )["region"]["key"]
        targets = sorted({c["region"]["key"] for c in hostile_clusters
                          if c["region"]["key"] != home})[:3]
        add("    -- The NPC faction squatting on the fortified ground. Like `sides`,")
        add("    -- this declares what the brain should WANT; the launch decides")
        add("    -- whether an AI is actually there. Without an --ai slot the loader")
        add("    -- warns and these units idle — declared but never silently")
        add("    -- half-alive. `kinds` must come from game_scenario.lua's")
        add("    -- AI_SLATE_KINDS: an unknown kind is a hard validation error.")
        add("    ai = {")
        add("        {")
        add(f"            team    = {hostile_team},")
        add("            profile = 'npc_raider',")
        add("            slate   = {")
        add(f"                kinds   = {{ {', '.join(_lua_str(k) for k in HOSTILE_SLATE_KINDS)} }},")
        add(f"                home    = {_lua_str(home)},")
        if targets:
            add(f"                targets = {{ {', '.join(_lua_str(t) for t in targets)} }},")
        add("                reach   = 2,")
        add("            },")
        add("            -- Deliberately meagre: an NPC has no objective income, so")
        add("            -- without a stipend it spends its opening grant and is")
        add("            -- permanently broke; with a large one it stops being flavour.")
        add("            stipend = { amount = 35, periodSec = 60 },")
        add("        },")
        add("    },")
        add("")

    add("    units = {")
    add("        -- Pre-deployed armies. `count`/`spacing` use the loader's own grid")
    add("        -- spread (game_scenario.lua gridOffsets), which is also the shape")
    add("        -- its count-weighted centroid check understands.")
    add("        --")
    add("        -- Every mobile entry carries an opening FIGHT toward the victory")
    add("        -- region: a staged force with no orders sits on its spawn tile")
    add("        -- forever and cannot contest anything (war_units_unordered).")
    for i in range(sides):
        add(f"        -- side {i} — landing zone {side_regions[i]['key']}")
        for u in units:
            if u["team"] != i:
                continue
            add("        " + _emit_unit(u))
    add("")
    add("        -- Existing settlement and NPC garrisons. `team = 'neutral'`")
    add("        -- resolves to the Gaia team at stage time: the Gaia id is")
    add("        -- playerTeamCount, which depends on the roster and so is NOT")
    add("        -- knowable when this file is written. These are staged through")
    add("        -- `units` rather than the `civilians` block on purpose — that")
    add("        -- block registers everything role='ambient', and routines.tick")
    add("        -- then issues CMD_MOVE at every ambient entry every tick, which")
    add("        -- would enroll immobile buildings in a move loop they can never")
    add("        -- satisfy.")
    for c in clusters:
        tpl = CLUSTER_TEMPLATES[c["kind"]]
        owner = "neutral (Gaia)" if c["owner"] == "neutral" \
            else f"hostile team {c['owner']}"
        add(f"        -- {tpl['label']}: {c['region']['name']} "
            f"({c['region']['key']}) — {owner}")
        for b in c["buildings"]:
            add(f"        {{ def = {_lua_str(b.defname)}, "
                f"team = {_team_field(c['owner'])}, x = {b.x}, z = {b.z}, "
                f"facing = 'south' }},")
        for g in c["garrison"]:
            entry = {"def": g["def"], "team": c["owner"], "x": g["x"],
                     "z": g["z"], "facing": "south"}
            if c["owner"] != "neutral":
                # A defensive FIGHT on the cluster's own centre. Two reasons,
                # and only the second is about gameplay:
                #
                #  * `war_units_unordered` counts any LIVE occupied team whose
                #    staged mobile force carries no orders at all, and the NPC
                #    team is occupied whenever the launch seats its AI slot. An
                #    unordered NPC garrison therefore trips the war-health check
                #    even though the war is fine.
                #  * FIGHT rather than MOVE so they hold the ground they are
                #    garrisoning and engage whatever walks into it, instead of
                #    parading to a waypoint. Neutral (Gaia) residents get no
                #    orders at all — they are population, not a militia, and
                #    they bucket under a string team the check skips anyway.
                entry["orders"] = [{"cmd": "FIGHT",
                                    "params": [c["anchor"][0], 0, c["anchor"][1]]}]
            add("        " + _emit_unit(entry))
    add("    },")
    add("")
    add("    objectives = {")
    add("        -- THE VICTORY OBJECTIVE. `victory = true` is the only terminal")
    add("        -- condition game_gameover.lua watches, and ScenarioDiscovery's")
    add("        -- DefaultForMap refuses a scenario without one. Exactly one.")
    add("        --")
    add("        -- Open race (forTeam nil) so either side may take it, and so it")
    add("        -- cannot be scoped to a team the launch did not supply — an")
    add("        -- objective on a missing team throws \"Bad teamID\" out of the")
    add("        -- Objectives gadget's callin, gadgetHandler removes the gadget,")
    add("        -- and the victory objective can then never progress at all.")
    add("        --")
    add(f"        -- notBefore + holdFrames = {not_before + hold} frames, against a")
    add(f"        -- worst-case approach of {meta['worst_frames']:.0f} frames for the")
    add("        -- slowest staged side. The x1.5 margin is because that estimate")
    add("        -- is straight-line and so understates real travel time; matching")
    add("        -- it exactly would pass the loader's check and still let the war")
    add("        -- be decided before the two armies ever meet.")
    add("        { type = 'control', scope = 'strategic', forTeam = nil,")
    add(f"          region = {_lua_str(victory['key'])}, reward = 300,")
    add("          victory = true,")
    add(f"          notBefore = {not_before}, holdFrames = {hold},")
    add("          expiresAtFrame = nil },")
    if clusters:
        add("")
        add("        -- Tactical prizes on the occupied ground. Open race for the")
        add("        -- same reason as above; no expiry.")
        for c in clusters:
            tpl = CLUSTER_TEMPLATES[c["kind"]]
            add(f"        {{ type = 'control', scope = 'tactical', forTeam = nil, "
                f"region = {_lua_str(c['region']['key'])}, reward = 110, "
                f"expiresAtFrame = nil }},  -- {tpl['label']}")
    add("    },")
    add("}")
    add("")
    return "\n".join(L)


def _emit_unit(u: dict) -> str:
    parts = [f"def = {_lua_str(u['def'])}", f"team = {_team_field(u['team'])}",
             f"x = {u['x']}", f"z = {u['z']}",
             f"facing = {_lua_str(u['facing'])}"]
    if u.get("count", 1) != 1:
        parts.append(f"count = {u['count']}")
        parts.append(f"spacing = {u['spacing']}")
    head = "{ " + ", ".join(parts)
    if not u.get("orders"):
        return head + " },"
    o = u["orders"][0]
    params = ", ".join(str(p) for p in o["params"])
    return (head + ",\n          orders = { { cmd = " + _lua_str(o["cmd"]) +
            f", params = {{ {params} }} }} }} }},")


# ==========================================================================

def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("map_dir", help="a processed map directory, data/maps/<id>")
    ap.add_argument("--seed", type=int, default=None,
                    help="default: derived from the map id, as regions_from_map does")
    ap.add_argument("--sides", type=int, default=2)
    ap.add_argument("--towns", type=int, default=3)
    ap.add_argument("--outposts", type=int, default=2)
    ap.add_argument("--bases", type=int, default=1)
    ap.add_argument("--mines", type=int, default=1)
    ap.add_argument("--hostility", default="mixed",
                    choices=["neutral", "hostile", "mixed"])
    ap.add_argument("--roster", default="standard", choices=sorted(ARMY_ROSTERS))
    ap.add_argument("--game-dir", default=None,
                    help="data/games/metalstorm (default: derived from map-dir)")
    ap.add_argument("--out", default=None,
                    help="output file (default: <game-dir>/scenarios/<id>.lua)")
    ap.add_argument("--stdout", action="store_true",
                    help="write the scenario to stdout instead of a file")
    ap.add_argument("--meta-json", default=None, metavar="FILE",
                    help="also write the generation metadata to FILE as JSON")
    ap.add_argument("--verify", action="store_true",
                    help="generate and check, but write nothing (exit 2 on reject)")
    args = ap.parse_args(argv)

    map_dir = os.path.abspath(args.map_dir.rstrip("/"))
    map_id = os.path.basename(map_dir)
    seed = args.seed if args.seed is not None else sum(ord(c) for c in map_id)

    try:
        lua, meta = generate(
            map_dir, seed, sides=args.sides, towns=args.towns,
            outposts=args.outposts, bases=args.bases, mines=args.mines,
            hostility=args.hostility, roster=args.roster,
            game_dir=args.game_dir)
    except Rejected as e:
        print(f"REJECTED — {e}", file=sys.stderr)
        return 2

    # The human summary goes to stderr under --stdout so that stdout carries
    # ONLY the scenario. Otherwise `scenariogen.py ... --stdout > out.lua`
    # produces a file with a report glued to the front of it, which is not a
    # scenario at all — and, being pure prose ahead of `return {`, one the
    # lobby's parser rejects.
    out_stream = sys.stderr if args.stdout else sys.stdout
    def say(msg):
        print(msg, file=out_stream)

    say(f"{meta['id']}: {meta['display_name']}")
    say(f"  map {meta['map_id']}, seed {meta['seed']}, "
        f"{meta['sides']} playable side(s), classes verified: "
        f"{', '.join(meta['classes'])}")
    say(f"  victory: control {meta['victory_region']} at "
        f"notBefore {meta['not_before']} + hold {meta['hold_frames']} "
        f"(worst approach {meta['worst_frames']:.0f} frames)")
    say(f"  {len(meta['clusters'])} cluster(s), {meta['buildings']} buildings:")
    for kind, key, owner in meta["clusters"]:
        say(f"    {kind:8s} {key:22s} "
            f"{'neutral (Gaia)' if owner == 'neutral' else f'hostile team {owner}'}")

    # --meta-json is how a PROGRAM ingests this run — specifically the lobby's
    # POST /api/admin/scenarios/generate, which shells out to this script and
    # needs the id, the display name and the map back. It cannot read them off
    # stdout: under --stdout that stream carries the scenario and nothing else
    # (see the comment above), and the human summary is prose whose shape is
    # free to change. It cannot re-derive the id either — that would mean a
    # second implementation of scenario_id()'s hash in C++, and two hash
    # implementations that must agree forever is exactly one too many.
    #
    # Written before the --stdout / --verify early returns so every mode emits
    # it: `--verify --meta-json` is a useful "what WOULD this produce" probe.
    if args.meta_json:
        import json
        payload = dict(meta)
        # The knobs, echoed back so a stored scenario records the complete
        # input needed to reproduce itself. `seed`, `map_id` and `version` are
        # already top-level fields of meta.
        payload["params"] = {
            "sides": args.sides, "towns": args.towns,
            "outposts": args.outposts, "bases": args.bases,
            "mines": args.mines, "hostility": args.hostility,
            "roster": args.roster,
        }
        with open(args.meta_json, "w", encoding="utf-8") as f:
            json.dump(payload, f, sort_keys=True, indent=2)

    if args.stdout:
        sys.stdout.write(lua)
        return 0
    if args.verify:
        say("  --verify: nothing written")
        return 0

    game_dir = args.game_dir or os.path.join(
        os.path.abspath(os.path.join(map_dir, "..", "..", "..")),
        "data", "games", "metalstorm")
    out = args.out or os.path.join(game_dir, "scenarios", f"{meta['id']}.lua")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write(lua)
    say(f"  wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
