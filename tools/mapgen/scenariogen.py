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

TOWNS ARE PLANNED, NOT SCATTERED (generator version 2). `place_cluster` below
scatters buildings on rings around a region anchor, which is the right shape for
an outpost or an extraction site and the wrong one for a town. A `town` cluster
therefore goes through `plan_township`, which chains the town-planner toolchain
in the same directory:

    town_planner.py    streets, lots with frontage, a wall and its gateways
    town_stager.py     real buildings standing in those lots
    town_populace.py   the people, the traffic and the militia on the gates

`town_planner.SiteProbe.from_terrain` takes the `Terrain` built here, so a
planner run and a scenario run grade identical ground identically. The scatter
remains the FALLBACK, and it is not a degradation: most regions on most maps
have no kilometre and a half of ground that will take lots, and a ring of four
sheds is the right answer there. Every refusal is recorded by region and reason
in `meta['town_refusals']`.

A planned town takes its REGION'S KEY as its own, which is what makes it
addressable: the region key is what `GG.Regions.KeyAt` returns, what a parley
proposal's `terms.regionKey` carries, what an objective is scoped to, and what
`region_<key>_name` publishes to the client's named-entity index. A town with a
key of its own would need every one of those to learn a second namespace.

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
import road_frontage as rf                                # noqa: E402
import town_planner as tp                                 # noqa: E402
import town_populace as tpop                              # noqa: E402
import town_stager as tstage                              # noqa: E402
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
    ANCIENT_DRAW_ORDER,
    ANCIENT_GUARDIANS,
    ANCIENT_SITES,
    ARMY_ROSTERS,
    BRIDGE_NOUN,
    BRIDGE_SPANS,
    CLUSTER_TEMPLATES,
    HOSTILE_FACTION,
    HOSTILE_SLATE_KINDS,
    MAX_BRIDGE_SPANS,
    MAX_ROAD_FRONTAGE,
    PLAYABLE_FACTIONS,
    ROAD_FRONTAGE,
    SCENARIO_SUFFIXES,
    SITE_DRAW_ORDER,
    SITE_TEMPLATES,
    WRECK_FIELD,
)

# Bumped whenever the emitted output changes for an unchanged (map, seed).
# Part of the scenario id, so a bump cannot silently collide with an older row.
#
# 2 (§M4): named resource sites, ancient-tech relics, wreck fields and bridge
# spans, plus the two §M1 wheeled natives in the standard roster. Every one of
# those draws from the seeded stream, so v1 and v2 disagree about every
# placement on the same (map, seed) — which is exactly what the version is for.
# 3 (town-planner T4): towns are PLANNED (town_planner/town_stager/
# town_populace) rather than scattered, and carry a populace, a `towns` block
# and a `civilians` block. Every generated scenario's output changes.
# 4 (roads R4): roadside yards. A scenario generated on a map that publishes a
# road graph now carries depots/workshops/fuel stops standing on its links with
# vehicles parked on their aprons, and every one of them draws from the seeded
# stream — so v3 and v4 disagree about every placement after the relics on such
# a map, and agree exactly on a map with no mapdata/roads.lua.
GENERATOR_VERSION = 4

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

# --- planned towns (town-planner T4) ---------------------------------------
# A `town` cluster is no longer a ring of scattered buildings: it is a street
# graph with lots, a wall, buildings that front the streets and a population
# living on them. `place_cluster` remains the fallback and is untouched — see
# `plan_township` for the four reasons a region gets the scatter instead.
#
# RADIUS. `CLUSTER_TEMPLATES['town']['radius']` is 420, which is BELOW
# `town_planner.min_radius_for` for every archetype (648-714): a street town
# needs roughly double a scatter cluster's radius, because one block pitch is
# two rows of ~190-elmo lots plus a carriageway. T1 flagged this as the scenario
# layer's call; the call is to plan at the planner's own default and keep
# `place_cluster` (at its own 420) for the regions that refuse.
# ...and it is a LADDER, not a number. `plan_town` draws its archetype from the
# terrain first and only then refuses a radius under that archetype's own
# minimum (714 / 686 / 648), so a single radius makes the town's size a property
# of the dice. Walked down until one plans: a big town where the ground allows a
# big town, a small one where it does not, and a refusal only when even the
# smallest archetype's minimum has nowhere to sit.
#
# MEASURED, and the reason the ladder exists at all: at a fixed 760, three of
# three candidate regions on scorched_crossing and two of three on wanderlust2
# refused, and the whole map fell back to scatter — on maps that visibly have
# room for a town, just not a 1520-elmo-wide one.
TOWN_RADII = (tp.DEFAULT_RADIUS, 714, 686, 648)

# How far the town centre may migrate from the region anchor while looking for
# ground that will hold a town. Bounded well inside a region rather than left
# open, because a town that wanders into the NEXT region breaks the identity the
# whole `towns` block rests on: one town per region, addressed by the region's
# own key. Checked afterwards against the polygon regardless — this only keeps
# the search cheap.
TOWN_SEARCH = 900.0


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


_CROSSING_RE = re.compile(
    r'\{\s*def\s*=\s*"(?P<def>[^"]+)"\s*,\s*'
    r'x\s*=\s*(?P<x>-?[0-9.]+)\s*,\s*z\s*=\s*(?P<z>-?[0-9.]+)\s*,\s*'
    r'heading\s*=\s*(?P<heading>-?[0-9]+)\s*,\s*'
    r'spans\s*=\s*(?P<spans>[0-9]+)\s*,\s*'
    r'class\s*=\s*(?P<class>[0-9]+)\s*,\s*'
    r'width\s*=\s*(?P<width>-?[0-9.]+)\s*,\s*'
    r'depth\s*=\s*(?P<depth>-?[0-9.]+)\s*\}')


_LINK_RE = re.compile(
    r'\{\s*class\s*=\s*(?P<class>[0-9]+)\s*,\s*'
    r'name\s*=\s*"(?P<name>[^"]+)"\s*,\s*'
    r'width\s*=\s*(?P<width>-?[0-9.]+)\s*,\s*'
    r'a\s*=\s*(?P<a>-?[0-9]+)\s*,\s*b\s*=\s*(?P<b>-?[0-9]+)\s*,\s*'
    # The point list's LAST brace belongs to the point, not to the row. A
    # `(?P<points>.*?)\}\s*\}` reads `{ {1,2}, {3,4} }` as `{1,2}, {3` and drops
    # the final vertex of every link silently — a legal-looking polyline one
    # segment short, which for a two-point link is no link at all.
    r'points\s*=\s*\{(?P<points>.*?\})\s*\}')
_POINT_RE = re.compile(r'\{\s*(-?[0-9.]+)\s*,\s*(-?[0-9.]+)\s*\}')


def read_road_links(map_dir: str) -> list[dict]:
    """The road network the MAP published, from `mapdata/roads.lua` (roads R2).

    The sibling of `read_road_crossings`, and here for the same reason: R4 wants
    to stand a depot's yard ON a road, and until this reader existed nothing in
    the scenario layer knew where a road was — `place_sites` rings outward from
    a region anchor and puts industry in the middle of a field.

    Reads only the `links` block, and stops at `junctions`: the file's three
    blocks are all lists of braced rows and a regex let loose over the whole
    text would happily read a crossing as a malformed link.

    Same regex-not-interpreter reasoning and the same empty-vs-absent
    distinction as the crossings reader — a map generated before R2 carries no
    `mapdata/roads.lua` at all, which returns [] here exactly as a map whose
    generator planned no roads does, and every caller must treat "no roads" as
    an ordinary map rather than an error.
    """
    path = os.path.join(map_dir, "mapdata", "roads.lua")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    head = text.find("links")
    if head < 0:
        return []
    tail = text.find("junctions", head)
    block = text[head:tail if tail > 0 else len(text)]
    out = []
    for m in _LINK_RE.finditer(block):
        pts = [(float(x), float(z)) for x, z in _POINT_RE.findall(m.group("points"))]
        if len(pts) < 2:
            continue
        out.append({"road_class": int(m.group("class")), "name": m.group("name"),
                    "width": float(m.group("width")), "a": int(m.group("a")),
                    "b": int(m.group("b")), "points": pts})
    return out


def read_road_crossings(map_dir: str) -> list[dict]:
    """Water crossings the MAP published, from `mapdata/roads.lua` (roads R3b).

    A bridge belongs where a road crosses water, and until R3b nothing here knew
    where the roads were: `find_crossing` below searches a region's heightmap
    for the narrowest gap and then ASSUMES the answer ("that is also where a
    road would naturally run", its own docstring). The generator that planned
    the roads knows, so it says — including the chain's heading, which is the
    road's tangent rather than a cardinal snapped to it.

    Same regex-not-interpreter reasoning as `read_region_graph`, and the same
    empty-vs-absent distinction: a map generated before R3b ships no `crossings`
    key at all, which returns [] here exactly as a map with no fords does. Both
    fall back to the blind search, which is the pre-R3b behaviour.
    """
    path = os.path.join(map_dir, "mapdata", "roads.lua")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    head = text.find("crossings")
    if head < 0:
        return []
    return [{"def": m.group("def"),
             "x": int(float(m.group("x"))), "z": int(float(m.group("z"))),
             "heading": int(m.group("heading")),
             "spans": int(m.group("spans")),
             "road_class": int(m.group("class")),
             "width": float(m.group("width")),
             "depth": float(m.group("depth"))}
            for m in _CROSSING_RE.finditer(text[head:])]


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

    def height_at(self, x: float, z: float) -> float:
        sx, sz = self.sample_of(x, z)
        return self.heights[sz * self.W + sx]

    def is_water(self, x: float, z: float) -> bool:
        """Is (x, z) under water?

        Spring's sea level is 0 and `passable_mask` already grades depth off
        `h < 0` (regions_from_map.py:176), so this is the same predicate that
        decides passability, not a second opinion about where the sea is.
        """
        return self.height_at(x, z) < 0.0

    def water_run(self, x: float, z: float, axis: str,
                  limit: int) -> tuple[float, float] | None:
        """The water span through (x, z) along `axis`, as (start, end) on that axis.

        Walks outward one heightmap sample at a time until dry ground on both
        sides, giving up past `limit` elmos — an unbounded walk on an ocean map
        would return the map width and call it a river.

        Returns None if (x, z) is not water, or if either walk ran off the map
        or past the limit: a "gap" with no far bank is a coastline, and a bridge
        needs two banks.
        """
        if not self.is_water(x, z):
            return None
        step = ELMOS_PER_SQUARE
        ends = []
        for sign in (-1, 1):
            d = 0.0
            while True:
                d += step
                if d > limit:
                    return None
                p = (x if axis == "z" else x + sign * d)
                q = (z + sign * d if axis == "z" else z)
                if not (0 <= p <= (self.W - 1) * ELMOS_PER_SQUARE and
                        0 <= q <= (self.H - 1) * ELMOS_PER_SQUARE):
                    return None
                if not self.is_water(p, q):
                    ends.append(d)
                    break
        lo = (x - ends[0]) if axis == "x" else (z - ends[0])
        hi = (x + ends[1]) if axis == "x" else (z + ends[1])
        return lo, hi

    def blocked_copy(self, rects: list[tuple[float, float, float, float]]) -> "Terrain":
        """This terrain with `rects` (x0, z0, x1, z1) stamped impassable.

        Used to re-grade reachability once BLOCKING features are placed. Spring
        gives a feature a ground-blocking footprint exactly as it does a
        building (CFeature::Block, gated on `collidable`), so a wreck field is
        terrain as far as pathing is concerned, and grading the war on the bare
        heightmap after dropping one is grading a map that no longer exists.

        Components are recomputed rather than patched: removing samples can
        SPLIT a component, which is the entire failure being tested for, and a
        patch that only clears bits would leave the old ids claiming otherwise.
        """
        out = Terrain.__new__(Terrain)
        out.W, out.H = self.W, self.H
        out.heights = self.heights
        out.masks, out.comps = {}, {}
        for c, mask in sorted(self.masks.items()):
            m = bytearray(mask)
            for x0, z0, x1, z1 in rects:
                sx0, sz0 = self.sample_of(x0, z0)
                sx1, sz1 = self.sample_of(x1, z1)
                for sz in range(sz0, sz1 + 1):
                    base = sz * self.W
                    for sx in range(sx0, sx1 + 1):
                        m[base + sx] = 0
            comp, _ = components(m, self.W, self.H)
            out.masks[c], out.comps[c] = m, comp
        return out

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
        """The axis-aligned ground this building blocks, inflated by `pad`.

        THE FACING SWAPS THE SIZES. `Spring.CreateUnit` takes a facing, not a
        heading, and the engine derives the blocked footprint by SWAPPING x and
        z on the east/west facings rather than rotating the rectangle
        (Unit.cpp:224-225) — so a 10x14 transit hub facing east blocks 224 elmos
        across and 160 deep, the reverse of what it blocks facing south.

        This used to ignore `facing` entirely, which was invisible for as long
        as `place_cluster` was the only producer of `Building`: a scattered
        cluster faces every building south, and south is the identity. A PLANNED
        town faces its buildings at their streets, and the very first map with a
        west-facing habitat put a civilian 30 elmos inside a footprint the
        generator's own gate said was clear.
        """
        hx, hz = tstage._extent_of(self.facing, self.facts.footprint_x,
                                   self.facts.footprint_z)
        return (self.x - hx - pad, self.z - hz - pad,
                self.x + hx + pad, self.z + hz + pad)

    def clears(self, x: float, z: float) -> bool:
        """Is (x, z) outside this building's blocked yardmap at every angle?"""
        return math.hypot(x - self.x, z - self.z) >= self.facts.clear_radius

    def clears_rect(self, x: float, z: float, hx: float, hz: float,
                    pad: float) -> bool:
        """The same question asked of the RECTANGLE the engine actually blocks.

        `clears` above is a CIRCLE of the footprint's half-diagonal plus the
        scatter margin, which is the honest test for `place_cluster` — it
        scatters buildings on rings and knows nothing about which way any of
        them faces, so it must clear the worst angle at every angle.

        A planned town knows exactly. The engine derives a building's blocked
        ground by SWAPPING the footprint sizes rather than rotating them
        (Unit.cpp:224-225), so that ground is always an axis-aligned rectangle,
        and this is that rectangle inflated by `pad`.

        The difference is the whole of "civilians in streets". ms_habitat is
        192 elmos across, so `clear_radius` is 175.8, while a `grid_quarter`
        lot puts the carriageway CENTRELINE 158 elmos from the building's
        centre and its near edge 130. Every point on the street outside that
        house fails the circle and passes the rectangle by 34 elmos — and the
        rectangle is the one the engine agrees with.
        """
        bx0, bz0, bx1, bz1 = self.rect(pad)
        return (x + hx <= bx0 or x - hx >= bx1
                or z + hz <= bz0 or z - hz >= bz1)


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
# Named sites, relics and features (§M4)
# ==========================================================================

# How far from a candidate berth the port crane will accept water. The crane's
# jib overhangs its rail deck toward the berth (units/buildings_sites.lua sizes
# the footprint to the deck alone for exactly this reason), so "on the quay"
# means water close by, not water underneath.
PORT_WATER_REACH = 160

# Below this a "gap" is a puddle or a ditch and a 24 m span laid across it looks
# like litter. Above MAX_BRIDGE_SPANS * pitch it is open water — see the note on
# that constant.
MIN_BRIDGE_GAP = 40


def site_name(region: dict, noun: str, taken: set[str]) -> str:
    """`"<region name> <noun>"`, e.g. "Raven Basin Grain Silo".

    The region's own name, not a freshly minted one. Two reasons, and the second
    is the load-bearing one:

      * register — a generated graph's region names come from
        `regions_from_map.name_for()`, which is the vocabulary the client
        overlay and the AI's debug output already use. A site named out of a
        second table would sit in a different world from the ground it stands on.
      * ADDRESSABILITY — this string becomes `landmark_<name>_x/_z`, which is
        how the command language resolves "hold the Raven Basin silos"
        (PLAN-metalstorm-command-language.md §6.5). A player can only say a name
        they have seen, and the region name is the one already on their screen.

    `taken` guards the collision the loader would otherwise reject: the name IS
    the rulesParam key, so two sites sharing one would overwrite each other and
    one would silently vanish from the index.
    """
    base = f"{region['name']} {noun}".strip()
    if base not in taken:
        return base
    for n in range(2, 100):
        cand = f"{base} {n}"
        if cand not in taken:
            return cand
    return f"{base} {len(taken)}"


def _rank_regions(regions: list[dict], barred: set[str], occupied: set[str],
                  prefers: list[str]) -> list[dict]:
    """Candidate regions, best first: empty ground before shared, then by tag fit.

    Two tiers, and the second one is the point. A map has a fixed number of
    regions and the cluster pass gets first refusal on them; on
    scorched_crossing that leaves exactly two of sixteen free, so a placer that
    insists on an empty region silently ships two sites where three were asked
    for and no relic at all. Sharing is also just truer: a township WITH a grain
    silo is the normal arrangement, not a compromise.

    `barred` is off-limits outright (home regions, the victory prize).
    `occupied` already holds something, so it sorts second. Ties break on the
    region key, never on graph order.
    """
    out = []
    for r in regions:
        if r["key"] in barred:
            continue
        tier = 1 if r["key"] in occupied else 0
        rank = next((i for i, t in enumerate(prefers) if t in r["tags"]),
                    len(prefers))
        out.append((tier, rank, -r["value"], r["key"], r))
    out.sort(key=lambda t: t[:4])
    return [t[4] for t in out]


def place_sites(rnd, terrain: Terrain, facts, regions: list[dict],
                want_comp: dict[str, int], count: int, barred: set[str],
                occupied: set[str], placed: list[Building],
                placed_units: list[tuple[int, int, object]],
                names: set[str]) -> list[dict]:
    """`count` named resource sites, one building each.

    A site is not a cluster: it is ONE structure with a name, standing where the
    map says that industry belongs (the headframe on high ground, the crane on a
    berth). Placement rules are the cluster placer's, minus the garrison — the
    yardmap trap is symmetric, so a site must clear every unit already staged
    just as a town's habitat must.

    Returns entries in `units` shape, on `team = 'neutral'` (Gaia at stage
    time), each carrying a `name` the loader publishes as a landmark.
    """
    out: list[dict] = []
    claimed: set[str] = set()
    for defname in SITE_DRAW_ORDER:
        if len(out) >= count:
            break
        tpl = SITE_TEMPLATES[defname]
        f = facts[defname]
        for region in _rank_regions(regions, barred | claimed, occupied,
                                    tpl["prefers"]):
            anchor = region_anchor(terrain, region, want_comp)
            if anchor is None:
                continue
            spot = _clear_spot(rnd, terrain, region, anchor, defname, f,
                               placed, placed_units, tpl["needs_water"])
            if spot is None:
                continue
            name = site_name(region, tpl["noun"], names)
            names.add(name)
            claimed.add(region["key"])
            placed.append(spot)
            out.append({"def": defname, "team": "neutral", "x": spot.x,
                        "z": spot.z, "facing": "south", "name": name,
                        "region": region})
            break
    return out


def _clear_spot(rnd, terrain: Terrain, region: dict, anchor: tuple[int, int],
                defname: str, f, placed: list[Building],
                placed_units: list[tuple[int, int, object]],
                needs_water: bool = False) -> Building | None:
    """One clear, terrain-appropriate spot inside `region` for a single structure.

    Shared by the site layer and the relic layer, and it has to be: both place
    exactly one thing into a region that may ALREADY hold a settlement, so both
    need the ring search rather than the region's anchor. A first version
    probed the anchor alone for relics, and on scorched_crossing that put every
    relic candidate on top of a cluster's garrison — the placement was refused
    every time and the scenario shipped with no relic at all, silently.

    Rings outward from the anchor, 12 seeded angles each. Rejecting and
    widening beats jittering in place, which packs everything at the centre and
    then fails every overlap test.
    """
    ax, az = anchor
    xs = [v[0] for v in region["polygon"]]
    zs = [v[1] for v in region["polygon"]]
    reach = max(120, int(0.40 * min(max(xs) - min(xs), max(zs) - min(zs))))
    for ring in range(0, 6):
        rad = (reach * ring) / 5.0
        for _ in range(12):
            ang = rnd.random() * math.tau
            x = ax + math.cos(ang) * rad
            z = az + math.sin(ang) * rad
            if not terrain.footprint_clear(x, z, f.footprint_x, f.footprint_z,
                                           DEFAULT_CLASS):
                continue
            if needs_water and not _water_within(terrain, x, z,
                                                 PORT_WATER_REACH):
                continue
            cand = Building(defname, x, z, "south", f)
            if any(_rects_overlap(cand.rect(FOOTPRINT_GAP), b.rect())
                   for b in placed):
                continue
            # The yardmap trap is symmetric: a structure dropped ON an
            # already-staged unit traps that unit inside it for the match.
            if any(not cand.clears(ux, uz) for ux, uz, _uf in placed_units):
                continue
            return cand
    return None


def _water_within(terrain: Terrain, x: float, z: float, reach: float) -> bool:
    """Is there water within `reach` elmos of (x, z), on either axis?

    Deliberately axis-probed rather than radial: a berth is a shoreline, and a
    shoreline is what an axis probe finds. A radial scan of the same budget
    would spend most of its samples inland.
    """
    step = ELMOS_PER_SQUARE
    d = step
    while d <= reach:
        for dx, dz in ((d, 0), (-d, 0), (0, d), (0, -d)):
            if terrain.is_water(x + dx, z + dz):
                return True
        d += step
    return False


def place_relics(rnd, terrain: Terrain, facts, fdefs, regions: list[dict],
                 want_comp: dict[str, int], count: int, barred: set[str],
                 occupied: set[str], placed: list[Building],
                 placed_units: list[tuple[int, int, object]],
                 names: set[str], guardian_team) -> list[dict]:
    """`count` ancient-tech relics — named FEATURES with an optional guard.

    Each returns `{feature, guards, region, name}`: a `world.features` entry, a
    list of `units` entries for the band squatting on it, and the region the
    prize sits in so the caller can hang a tactical objective there.

    The relic itself is placed like a building — it blocks, so it takes ground —
    but it is never stamped into the reachability mask: relics go in the MIDDLE
    of a region by construction (region_anchor scans outward from the centroid),
    where a 20 x 16 m footprint cannot wall anything. Wrecks are the family that
    gets scattered toward chokepoints, and those ARE re-graded.
    """
    out: list[dict] = []
    claimed: set[str] = set()
    for defname in ANCIENT_DRAW_ORDER:
        if len(out) >= count:
            break
        noun = ANCIENT_SITES[defname]["noun"]
        # Relics are prizes, so they want VALUE and quiet ground — no tag
        # preference at all (`prefers = []` collapses _rank_regions to
        # empty-first, then value), because "ancient" is not a terrain type and
        # pretending it prefers highland would just be decoration on a sort key.
        for region in _rank_regions(regions, barred | claimed, occupied, []):
            anchor = region_anchor(terrain, region, want_comp)
            if anchor is None:
                continue
            fx, fz = fdefs[defname]
            # A relic may share a region with a settlement, so it needs the
            # same ring search a site does — and for the same reason. It also
            # blocks (features/ancient.lua sets blocking = true), so the
            # yardmap trap applies to it exactly as to a building: dropping a
            # 20 x 16 m relic onto a militiaman traps him inside it for the
            # match.
            relic_facts = ms_defs.UnitFacts(defname, fx, fz, 0.0, None, True)
            cand = _clear_spot(rnd, terrain, region, anchor, defname,
                               relic_facts, placed, placed_units)
            if cand is None:
                continue
            anchor = (cand.x, cand.z)
            name = site_name(region, noun, names)
            names.add(name)
            claimed.add(region["key"])
            # The relic occupies ground like a building does, so it joins
            # `placed` before its own guards are sited — otherwise the band it
            # is guarding spawns inside it and is trapped there, which is the
            # yardmap trap wearing a different hat.
            placed.append(cand)
            guards = _place_guardians(rnd, terrain, facts, anchor, placed,
                                      placed_units, guardian_team)
            out.append({
                "feature": {"def": defname, "x": anchor[0], "z": anchor[1],
                            "name": name},
                "guards": guards, "region": region, "name": name,
            })
            break
    return out


def _place_guardians(rnd, terrain: Terrain, facts, anchor, placed, placed_units,
                     team) -> list[dict]:
    """The band camped on a relic — the Anarchic archetype's NPC form.

    Placed on a ring outside the relic's own clearance, on the same rules as a
    cluster garrison. Skipped entirely when the scenario declares no hostile
    team (`--hostility neutral`): a guardian with nobody to be hostile to is a
    contradiction, and putting one on Gaia would make the prize guarded by
    people who will not fight for it.
    """
    if team is None:
        return []
    ax, az = anchor
    out: list[dict] = []
    local: list[tuple[int, int, object]] = []
    for defname, _w, lo, hi in ANCIENT_GUARDIANS:
        f = facts[defname]
        mclass = f.movementclass or DEFAULT_CLASS
        for _ in range(_pick_int(rnd, lo, hi)):
            spot = None
            for widen in range(8):
                rad = 180 + widen * 70
                for _ in range(10):
                    ang = rnd.random() * math.tau
                    x, z = ax + math.cos(ang) * rad, az + math.sin(ang) * rad
                    if not terrain.passable(x, z, mclass):
                        continue
                    if not all(b.clears(x, z) for b in placed):
                        continue
                    if _too_close(x, z, f, placed_units + local):
                        continue
                    spot = (int(x), int(z))
                    break
                if spot:
                    break
            if spot:
                out.append({"def": defname, "team": team, "x": spot[0],
                            "z": spot[1], "facing": "south",
                            "orders": [{"cmd": "FIGHT",
                                        "params": [ax, 0, az]}]})
                local.append((spot[0], spot[1], f))
    placed_units.extend(local)
    return out


# The one wreck big enough to be a place rather than a prop. A colossus hulk is
# 18 x 12 m of dead war machine; people navigate by it. Tank and train wrecks
# stay anonymous — naming every piece of debris would fill the command
# language's target list with things nobody would ever say.
NAMED_WRECK = "ms_colossus_wreck"
NAMED_WRECK_NOUN = "Hulk"


def place_wrecks(rnd, terrain: Terrain, fdefs, region: dict,
                 anchor: tuple[int, int], count: int, placed: list[Building],
                 placed_units: list[tuple[int, int, object]],
                 names: set[str]
                 ) -> tuple[list[dict], list[tuple[float, float, float, float]]]:
    """A wreck field on already-fought-over ground.

    Returns the `world.features` entries and the rectangles they block, so the
    caller can re-grade reachability. Wrecks are pushed OUT from the region's
    anchor (`rad` starts at 200) rather than dropped on it: the anchor is the
    point every other placement in that region routes through, and a colossus
    hull sitting on it is a plug in the middle of the prize.
    """
    ax, az = anchor
    xs = [v[0] for v in region["polygon"]]
    zs = [v[1] for v in region["polygon"]]
    span = int(0.45 * min(max(xs) - min(xs), max(zs) - min(zs)))
    entries: list[dict] = []
    rects: list[tuple[float, float, float, float]] = []
    for _ in range(count):
        defname = _pick_weighted(rnd, WRECK_FIELD)[0]
        half_x, half_z = feature_half_extent(fdefs, defname)
        fx, fz = fdefs[defname]
        for widen in range(6):
            rad = 200 + widen * max(80, span // 4)
            spot = None
            for _ in range(10):
                ang = rnd.random() * math.tau
                x, z = ax + math.cos(ang) * rad, az + math.sin(ang) * rad
                # A wreck on a slope or in the sea is not cover, it is a
                # floating prop; grade the ground it would sit on exactly as a
                # building's is graded.
                if not terrain.footprint_clear(x, z, fx, fz, DEFAULT_CLASS):
                    continue
                rect = (x - half_x, z - half_z, x + half_x, z + half_z)
                if any(_rects_overlap((rect[0] - FOOTPRINT_GAP,
                                       rect[1] - FOOTPRINT_GAP,
                                       rect[2] + FOOTPRINT_GAP,
                                       rect[3] + FOOTPRINT_GAP), b.rect())
                       for b in placed):
                    continue
                if any(_rects_overlap(rect, other) for other in rects):
                    continue
                # Same yardmap trap as a building: a wreck dropped onto a
                # staged unit blocks that unit's squares from under it.
                near = math.hypot(half_x, half_z) + 48
                if any(math.hypot(x - ux, z - uz) < near + uf.body_radius
                       for ux, uz, uf in placed_units):
                    continue
                spot = (int(x), int(z), rect)
                break
            if spot:
                entry = {"def": defname, "x": spot[0], "z": spot[1],
                         "facing": _pick_weighted(
                             rnd, [("north", 1), ("east", 1),
                                   ("south", 1), ("west", 1)])[0]}
                if defname == NAMED_WRECK:
                    entry["name"] = site_name(region, NAMED_WRECK_NOUN, names)
                    names.add(entry["name"])
                entries.append(entry)
                rects.append(spot[2])
                break
    return entries, rects


# How far past the waterline the abutment probe will look for drivable ground.
# A bank is the steepest ground around, so the sample where the water stops is
# almost never the sample a vehicle can stand on; a few squares of ramp is the
# difference between "this crossing exists" and "no map has a crossing".
BANK_SEARCH = 96

# A single 24 m segment is a plank and the gap under it is a ditch.
MIN_BRIDGE_SPANS = 3


def _heading_dir(heading: int) -> tuple[float, float]:
    """game_scenario.lua's `headingToDir` — the chain lays along it.

    Kept here (rather than imported from terragen.bridges) because this module
    reads a heading a MAP wrote and the gadget will consume: the two ends must
    agree with the gadget, not with each other. terragen/bridges.py carries the
    same four lines and tests/test_bridges.py pins both against the gadget.
    """
    theta = heading * (2.0 * math.pi / 65536.0)
    return math.sin(theta), -math.cos(theta)


def chain_is_afloat_at(terrain: Terrain, cx: float, cz: float, heading: int,
                       spans: int, pitch: float) -> bool:
    """`_chain_is_afloat` for an arbitrary heading — a published crossing.

    A map's `mapdata/roads.lua` can be older than the heightmap beside it (the
    packages are build output and are regenerated independently), and a span
    chain on dry ground is the §M3 staircase again. So a published crossing is
    trusted for WHERE, and checked for WET.
    """
    dx, dz = _heading_dir(heading)
    for i in range(spans):
        step = (i - (spans - 1) / 2.0) * pitch
        if not terrain.is_water(cx + dx * step, cz + dz * step):
            return False
    return True


def _chain_is_afloat(terrain: Terrain, cx: float, cz: float, axis: str,
                     spans: int, pitch: float) -> bool:
    """Is every segment of this chain's centre over water?

    The arithmetic mirrors game_scenario.lua's stageFeatures exactly — chaining
    is CENTRED on (x, z) and segment i sits at `(i - (count-1)/2) * pitch` along
    the heading — so this asks the same question the loader will answer with
    real geometry, rather than trusting the floor() above to have got it right.
    Cheap, and it is the difference between a level deck and the staircase the
    first live boot produced.
    """
    for i in range(spans):
        step = (i - (spans - 1) / 2.0) * pitch
        px = cx + (step if axis == "x" else 0.0)
        pz = cz + (step if axis == "z" else 0.0)
        if not terrain.is_water(px, pz):
            return False
    return True


def _bank(terrain: Terrain, x: float, z: float, axis: str, edge: float,
          sign: int) -> float | None:
    """First drivable position outboard of `edge` along `axis`, or None.

    `edge` is the water's edge on that axis; `sign` says which way is outboard.
    Returns the axis coordinate, so the caller can span abutment to abutment
    rather than waterline to waterline.
    """
    d = 0.0
    while d <= BANK_SEARCH:
        pos = edge + sign * d
        px, pz = (pos, z) if axis == "x" else (x, pos)
        if terrain.passable(px, pz, DEFAULT_CLASS):
            return pos
        d += ELMOS_PER_SQUARE
    return None


def find_crossing(terrain: Terrain, region: dict, pitch: float
                  ) -> tuple[int, int, str, int, float] | None:
    """A water gap inside `region` a bridge could actually span.

    Returns `(x, z, facing, spans, width)` — the gap's MIDPOINT, the cardinal
    the chain lays along, and how many 24 m segments cover it.

    Searched on the heightmap, not on region tags. That is the correction §M4
    makes to the earlier "ports/bridges cannot ship" finding: the old blocker
    was that no generated region graph emits a `water` tag, which says nothing
    about whether the map has a river — and every one of these maps does. Water
    is `h < 0`, the same predicate `passable_mask` grades depth with.

    The narrowest gap wins, which is what makes the result read as a crossing:
    a bridge is built where the river is thinnest, and that is also where a road
    would naturally run. Ties break on the scan order (fixed stride from the
    region's own bounding box), so no RNG is consumed here at all — two runs on
    one seed cannot disagree about where a river is.
    """
    xs = [v[0] for v in region["polygon"]]
    zs = [v[1] for v in region["polygon"]]
    x0, x1, z0, z1 = min(xs), max(xs), min(zs), max(zs)
    limit = MAX_BRIDGE_SPANS * pitch / 2.0 + ELMOS_PER_SQUARE
    step = ELMOS_PER_SQUARE * 4

    best = None
    z = z0
    while z <= z1:
        x = x0
        while x <= x1:
            if terrain.is_water(x, z):
                for axis, facing in (("x", "east"), ("z", "north")):
                    run = terrain.water_run(x, z, axis, limit)
                    if run is None:
                        continue
                    lo, hi = run
                    width = hi - lo
                    if width < MIN_BRIDGE_GAP:
                        continue
                    # A crossing has to LEAD somewhere: there must be ground a
                    # vehicle can stand on beyond each bank. The waterline
                    # sample is never that — a bank is the steepest ground
                    # around, routinely over the 32-degree VEH limit — so the
                    # probe walks a few squares out. Measured on
                    # scorched_crossing, testing the waterline itself rejected
                    # 105 otherwise-good crossings and accepted none at all.
                    if (_bank(terrain, x, z, axis, lo, -1) is None or
                            _bank(terrain, x, z, axis, hi, +1) is None):
                        continue

                    # EVERY SPAN CENTRE MUST BE OVER WATER. That is the whole
                    # invariant, and the first live boot is what taught it: a
                    # deck sized to reach the drivable banks put half its chain
                    # over rising ground, and a feature's y is a spawn height
                    # the engine then clamps to the terrain (§M3). `floating`
                    # defeats gravity only IN WATER, so the wet spans held
                    # 0.00 while the dry ones climbed to 15.7, 97.8, 203.5,
                    # 230.1, 250.7 and 252.0 m. That is not a bridge, it is a
                    # ramp into the sky.
                    #
                    # So the deck is sized by FLOOR over the water, never ceil:
                    # segment i sits at (i - (n-1)/2) * pitch from the midpoint,
                    # so the outermost centre is (n-1)/2 * pitch out, and
                    # n = floor(water / pitch) keeps that strictly inside the
                    # water for every n. The deck ends a few metres short of
                    # each bank rather than climbing it — which against these
                    # gorge walls is also what a real crossing looks like.
                    water = (hi - lo) - 2 * ELMOS_PER_SQUARE
                    spans = int(water // pitch)
                    # One 24 m segment alone is a plank, not a crossing, and
                    # the gap it spans is a ditch.
                    if spans < MIN_BRIDGE_SPANS or spans > MAX_BRIDGE_SPANS:
                        continue
                    mid = (lo + hi) / 2.0
                    mx, mz = (mid, z) if axis == "x" else (x, mid)
                    if not _chain_is_afloat(terrain, mx, mz, axis, spans, pitch):
                        continue
                    width = water
                    cand = (width, int(mx), int(mz), facing, spans)
                    if best is None or cand[:1] + cand[1:3] < best[:1] + best[1:3]:
                        best = cand
            x += step
        z += step
    if best is None:
        return None
    width, mx, mz, facing, spans = best
    return mx, mz, facing, spans, width
# Planned towns (town-planner T4)
# ==========================================================================
# `place_cluster` above scatters buildings on rings, which is the right shape
# for an outpost and the wrong one for a town. `town_planner.py` plans a street
# graph on the same terrain (`SiteProbe.from_terrain` takes the `Terrain` built
# here, so the planner and the generator grade identical ground identically),
# `town_stager.py` stands buildings in its lots and a wall on its boundary, and
# `town_populace.py` puts people on its streets. This function is the seam.
#
# ONE TOWN PER REGION, KEYED BY THE REGION. `generate`'s cluster loop already
# gives every cluster its own region (the `used` set), and a town takes that
# region's key as its own. That is what makes a town ADDRESSABLE: the region key
# is what `GG.Regions.KeyAt` returns, what a parley proposal's `terms.regionKey`
# carries, what an objective is scoped to, and what the client's named-entity
# index reads `region_<key>_name` for. A town with a key of its own would need
# every one of those to learn a second namespace; a town that IS its region
# needs none of them to change.
#
# THE FALLBACK IS NOT A FAILURE. Most regions on most maps cannot hold a street
# town — a 760-radius town needs a kilometre and a half of ground that will take
# lots — and `place_cluster` at 420 is the correct answer there, not a
# degradation. The refusal is recorded by name in the meta so a run says which
# regions got which, rather than looking like the planner silently did nothing.

class TownRefused(Exception):
    """This region cannot hold a planned town. Caller falls back to scatter."""


class Township:
    """A planned town, ready to emit: the graph, the staging, and the people."""

    __slots__ = ("region", "town", "staged", "populace", "buildings", "hall")

    def __init__(self, region, town, staged, populace, buildings, hall):
        self.region, self.town, self.staged = region, town, staged
        self.populace, self.buildings, self.hall = populace, buildings, hall

    @property
    def key(self) -> str:
        return self.region["key"]

    def meta(self) -> dict:
        """What the scenario's `towns` block and the run summary both need."""
        return {
            "key": self.key,
            "name": self.town.name,
            "region": self.key,
            "x": self.town.x, "z": self.town.z, "radius": self.town.radius,
            "archetype": self.town.archetype,
            "defense": self.town.defense,
            "lots": len(self.town.lots),
            "buildings": len(self.staged.of_category("building")),
            "gateways": len(self.town.gateways()),
            "civilians": self.populace.head_count(),
            "hall": ({"def": self.hall.defname, "x": self.hall.x,
                      "z": self.hall.z} if self.hall else None),
        }


def plan_township(rnd, terrain: Terrain, facts, region: dict, seed: int,
                  anchor: tuple[int, int], placed: list[Building],
                  placed_units: list[tuple[int, int, object]],
                  want_comp: dict[str, int] | None = None) -> Township:
    """Plan, stage and populate one town in `region`. Raises `TownRefused`.

    `rnd` is threaded in for the determinism rules' sake but is deliberately NOT
    drawn from: a town's own seed is derived from the scenario seed and the
    region KEY, so adding or removing an earlier cluster cannot re-roll a town
    in a region it never touched. Same reason `place_cluster`'s draws are
    ordered by the plan and not by dict iteration.
    """
    probe = tp.SiteProbe.from_terrain(terrain)
    town_seed = (seed ^ _fnv1a(region["key"])) & 0x7FFF_FFFF
    ax, az = anchor

    town = None
    why = ""
    for radius in TOWN_RADII:
        try:
            town = tp.plan_town(town_seed, probe, ax, az, radius=radius,
                                search=TOWN_SEARCH)
            break
        except tp.SiteRejected as e:
            # The FIRST rung's complaint, not the last. The ladder ends at the
            # smallest archetype's minimum, so the last rung's message is
            # routinely "648 is too small for a main_street" — true, and a
            # description of the ladder rather than of the ground.
            why = why or str(e)
    if town is None:
        raise TownRefused(
            f"no site at any radius in {TOWN_RADII}; at {TOWN_RADII[0]}: {why}")

    # The town must stay in the region whose key it is about to take. The
    # search above may migrate the centre up to TOWN_SEARCH, and a town that
    # drifted next door would be addressed by a key that resolves to different
    # ground for every consumer that calls GG.Regions.KeyAt.
    if not tp._point_in_polygon(town.x, town.z,
                                [(v[0], v[1]) for v in region["polygon"]]):
        raise TownRefused(
            f"the only usable ground within {int(TOWN_SEARCH)} elmos of the "
            f"anchor is outside {region['key']}'s own polygon")

    # ...and in the component the war is being fought in. A town in a pocket is
    # scenery nobody can reach, and its meeting hall is a parley venue no army
    # can ever stand at.
    if want_comp is not None and any(
            terrain.component_at(town.x, town.z, c) != want_comp[c]
            for c in terrain.classes if c in want_comp):
        raise TownRefused(
            f"the site is in a disconnected pocket of the passability mask — "
            f"no army could reach it")

    try:
        staged = tstage.stage_town(town, facts, probe=probe)
    except tstage.StagingRejected as e:
        raise TownRefused(f"not staged: {e}") from e

    buildings = [Building(p.defname, p.x, p.z, p.facing, facts[p.defname])
                 for p in staged.units()]
    if not buildings:
        raise TownRefused("staged no buildings at all — the roster this game "
                          "ships expresses none of the town's lot roles")

    # A town must not be dropped onto ground an earlier cluster already took.
    # Checked here rather than inside the planner because the planner grades
    # TERRAIN and knows nothing about the scenario being assembled around it.
    for b in buildings:
        if any(_rects_overlap(b.rect(FOOTPRINT_GAP), o.rect()) for o in placed):
            raise TownRefused("overlaps a cluster placed earlier in this run")
        if any(not b.clears(ux, uz) for ux, uz, _uf in placed_units):
            raise TownRefused("would trap a unit an earlier cluster placed")

    populace = tpop.populate_town(town, staged, facts, probe=probe)

    # THE TOWN'S OWN SPECS, RUN BEFORE IT CAN REACH A FILE. T1's perimeter
    # continuity, T2's placement validity and T4's populace validity are all
    # real checks with real failure modes, and a generated scenario that shipped
    # a town failing one of them would be exactly the "variation" this
    # generator's invariants exist to refuse. Falling back to the scatter is
    # strictly better than emitting a broken town.
    problems = (tp.validate_perimeter(town, probe)
                + tstage.validate_staging(staged, town, probe)
                + tpop.validate_populace(populace, town, staged, probe))
    if problems:
        raise TownRefused(
            f"failed its own spec ({len(problems)} problem(s)): "
            + "; ".join(problems[:2]))

    hall = next((p for p in staged.of_category("building")
                 if p.role == "unique"), None)
    return Township(region, town, staged, populace, buildings, hall)


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


def gate_blocking_features_leave_the_war_fightable(
        terrain: Terrain, rects: list[tuple[float, float, float, float]],
        points: list[tuple[str, int, int]], map_id: str,
        what: str = "the wreck field") -> None:
    """Invariant 5, re-checked with the wreck field ON the map.

    `features/wrecks.lua` sets `blocking = true` — that is what makes a wreck
    cover instead of scenery — and a blocking feature takes ground-blocking
    squares exactly as a building does (CFeature::Block, Feature.cpp:237). So
    the reachability the earlier gate proved was proved about a map that no
    longer exists once a train wreck is lying across the pass.

    This is not hypothetical bookkeeping: ms_train_wreck is 14 x 21 m and
    wrecks are scattered on the CONTESTED region on purpose, which is the same
    ground the map's chokepoints are on. A field that severs the only route
    between two armies is the Meridian defect re-created out of decoration.

    Cheaper than it looks, and deliberately not optimised into a patch: removing
    samples can SPLIT a component, so the components are recomputed from the
    stamped mask rather than edited.
    """
    if not rects:
        return
    try:
        gate_reachability(terrain.blocked_copy(rects), points, map_id)
    except Rejected as e:
        raise Rejected(
            f"{what} makes this war unfightable — {e}\n"
            f"  {len(rects)} blocking rectangle(s) were placed on contested "
            f"ground and at least one of them walls off the route between the "
            f"armies. This layer is decoration; it may not decide the war.")


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


def gate_no_civilian_in_a_town_footprint(
        points: list[tuple[str, float, float, object]],
        buildings: list[Building]) -> None:
    """The rect-based sibling of the gate above, for a planned town's people.

    SAME FAILURE, DIFFERENT TEST, AND THE DIFFERENCE IS THE POINT.
    `gate_no_unit_in_a_footprint` measures against `clear_radius` — the
    footprint's half-DIAGONAL plus 40 elmos, as a circle. That is the only
    honest test available to `place_cluster`, which scatters buildings on rings
    and records no facing for any of them.

    It is also a test no street town can pass. ms_habitat's clear_radius is
    175.8 elmos; a `grid_quarter` lot puts the carriageway's near edge 130 from
    that habitat's centre and its centreline 158. So the circle swallows the
    road, and "civilians in streets" — the brief's own words — is refused
    everywhere, while the engine's actual blocked ground stops 96 elmos out.

    A planned town knows every building's facing and therefore its exact
    axis-aligned blocked rectangle (Unit.cpp:224-225 derives it by swapping the
    footprint sizes, never by rotating them). This gate uses that rectangle,
    inflated by the same margin the town's own placer used, so it is strictly
    more accurate than the circle rather than merely more permissive. The
    circle still guards every point `place_cluster` produces, unchanged.
    """
    bad = []
    for label, x, z, f in points:
        hx = f.footprint_x * ms_defs.FOOTPRINT_SCALE * 4.0
        hz = f.footprint_z * ms_defs.FOOTPRINT_SCALE * 4.0
        for b in buildings:
            if not b.clears_rect(x, z, hx, hz, tpop.CIVILIAN_GAP):
                bad.append(f"{label} at ({int(x)},{int(z)}) is inside the "
                           f"ground {b.defname} at ({b.x},{b.z}) blocks")
                break
    if bad:
        raise Rejected("town civilians spawned inside a building's yardmap — "
                       "they would be trapped there for the whole match:\n  " +
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


def load_feature_facts(game_dir: str) -> dict[str, tuple[int, int]]:
    """defname -> (footprintx, footprintz) for every shipped featuredef.

    Read out of features/*.lua rather than tabulated here, for exactly the
    reason ms_defs gives about unit footprints: the number is load-bearing for a
    correctness gate (a blocking wreck's ground footprint decides whether a
    wreck field can sever a route), and a stale copy disarms the gate instead of
    failing it. Resize a wreck in content and this follows.

    Every .lua under features/ is a def file by the springcontent scan contract
    (features/README.md), so the whole directory is the search space. Comments
    are stripped first so the `-- 8 x 10 m` annotations beside each footprint
    cannot be read as another def.
    """
    feat_dir = os.path.join(game_dir, "features")
    out: dict[str, tuple[int, int]] = {}
    if not os.path.isdir(feat_dir):
        return out
    for fn in sorted(os.listdir(feat_dir)):
        if not fn.endswith(".lua"):
            continue
        with open(os.path.join(feat_dir, fn), encoding="utf-8") as fh:
            text = ms_defs._strip_comments(fh.read())
        for name, body in ms_defs._split_top_level_entries(text).items():
            fx = ms_defs._num(body, "footprintx")
            fz = ms_defs._num(body, "footprintz")
            if fx is not None and fz is not None:
                out[name] = (int(fx), int(fz))
    return out


def verify_feature_defs(facts: dict[str, tuple[int, int]],
                        required: list[str], game_dir: str) -> list[str]:
    """Problems with `required` featuredefs.

    The engine is silent about this failure, which is why it is worth a gate:
    `Spring.CreateFeature` returns nothing for an unknown def and deliberately
    does NOT error ("do not error (featureDefs are dynamic)",
    LuaSyncedCtrl.cpp:4344), so a typo'd wreck name produces a scenario that
    boots clean and is quietly missing the terrain the fight was designed
    around. game_scenario.lua's validate() catches it at GameStart; this catches
    it before the file is ever written.
    """
    if not facts:
        return [f"{os.path.join(game_dir, 'features')} ships no featuredefs, "
                f"so no wreck, span or relic can be placed"]
    return [f'unknown feature def "{n}" — not in '
            f'{os.path.join(game_dir, "features")}'
            for n in required if n not in facts]


def feature_half_extent(facts: dict[str, tuple[int, int]],
                        defname: str) -> tuple[float, float]:
    """Half the ground a feature blocks, in elmos.

    Same arithmetic as ms_defs.UnitFacts.body_radius, and it has to be: the
    engine derives a feature's ground-blocking rectangle from `footprintx/z`
    exactly as it does a building's (xsize = footprint * SPRING_FOOTPRINT_SCALE,
    then 4 elmos per xsize unit). Getting this wrong is not cosmetic — a first
    pass here treated the defs' `-- 8 x 10 m` comment as the extent and packed
    five wrecks into 180 elmos, every one of them inside its neighbour.
    """
    fx, fz = facts[defname]
    return (fx * ms_defs.FOOTPRINT_SCALE * 4, fz * ms_defs.FOOTPRINT_SCALE * 4)


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
             sites: int = 3, relics: int = 1, wrecks: int = 5,
             bridges: int = 1,
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
    # The §M4 layers name content too, and it is verified the same way: a site
    # def or a guardian the game does not ship must fail here, at generation
    # time with a def name in the message, rather than at GameStart with the
    # loader's "unknown unit def" — or worse, as a scenario that boots one
    # building short and says nothing.
    site_defs = sorted(SITE_TEMPLATES)
    guardian_defs = sorted({d for d, _w, _lo, _hi in ANCIENT_GUARDIANS})
    problems = ms_defs.verify(facts, sorted(set(
        roster_defs + cluster_defs + site_defs + guardian_defs)))
    if problems:
        raise Rejected("templates name defs the content does not ship:\n  " +
                       "\n  ".join(problems))
    fdefs = load_feature_facts(game_dir)
    problems = verify_feature_defs(fdefs, sorted(
        set(ANCIENT_SITES) | {d for d, _w in WRECK_FIELD} |
        set(BRIDGE_SPANS.values())), game_dir)
    if problems:
        raise Rejected("templates name featuredefs the content does not "
                       "ship:\n  " + "\n  ".join(problems))

    classes = sorted({facts[d].movementclass for d in roster_defs
                      if facts[d].movementclass} |
                     {facts[d].movementclass for d in cluster_defs + guardian_defs
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
    townships: list[Township] = []
    town_refusals: list[tuple[str, str]] = []
    all_buildings: list[Building] = []
    all_cluster_units: list[tuple[int, int, object]] = []
    for kind, _n in plan:
        for r in candidates(kind, used):
            anchor = region_anchor(terrain, r, want_comp)
            if anchor is None:
                continue

            # A `town` is PLANNED if the ground will take a street town, and
            # scattered if it will not. Tried first and per-region rather than
            # decided once for the map, because the answer is a property of the
            # ground: the same map routinely has a region that holds a
            # nine-street town and another that holds nothing bigger than a ring
            # of four sheds.
            if kind == "town":
                try:
                    ship = plan_township(rnd, terrain, facts, r, seed, anchor,
                                         all_buildings, all_cluster_units,
                                         want_comp)
                except TownRefused as e:
                    town_refusals.append((r["key"], str(e)))
                else:
                    used.add(r["key"])
                    all_buildings.extend(ship.buildings)
                    all_cluster_units.extend(
                        (c.x, c.z, facts[c.defname])
                        for c in ship.populace.residents)
                    townships.append(ship)
                    clusters.append({"kind": kind, "region": r,
                                     "anchor": (ship.town.x, ship.town.z),
                                     "buildings": ship.buildings,
                                     "garrison": [], "township": ship})
                    break

            bs, gs = place_cluster(rnd, terrain, facts, r, kind, anchor,
                                   all_buildings, all_cluster_units)
            if not bs:
                continue
            used.add(r["key"])
            all_buildings.extend(bs)
            all_cluster_units.extend((g["x"], g["z"], facts[g["def"]]) for g in gs)
            clusters.append({"kind": kind, "region": r, "anchor": anchor,
                             "buildings": bs, "garrison": gs,
                             "township": None})
            break

    # --- named sites and ancient-tech relics (§M4) --------------------------
    # Placed AFTER the clusters and BEFORE the armies, which is the only order
    # that works: a site must dodge the towns already standing, and the landing
    # parties must dodge the site. `used` is shared with the cluster pass, so a
    # region holds either a settlement or a site, never both stacked on one
    # anchor.
    hostile_team = sides
    guardian_team = None if hostility == "neutral" else hostile_team
    landmark_names: set[str] = set()
    # Home regions are barred because a site on someone's landing zone is a gift
    # rather than an objective; the victory region is barred because the whole
    # design of the victory picker is that the prize starts clear so neither
    # side inherits it.
    barred = home_keys | {victory["key"]}
    site_entries = place_sites(rnd, terrain, facts, regions, want_comp, sites,
                               barred, used, all_buildings, all_cluster_units,
                               landmark_names)
    site_keys = {s["region"]["key"] for s in site_entries}

    relic_entries = place_relics(rnd, terrain, facts, fdefs, regions, want_comp,
                                 relics, barred | site_keys, used,
                                 all_buildings, all_cluster_units,
                                 landmark_names, guardian_team)
    for r in relic_entries:
        all_cluster_units.extend((g["x"], g["z"], facts[g["def"]])
                                 for g in r["guards"])

    # --- roadside yards (roads R4) ------------------------------------------
    # Placed here for the same reason the sites are: after the settlements, so a
    # depot cannot land on a town, and before the armies, so a landing party
    # cannot spawn inside one. Unlike everything above it, this layer is
    # anchored to the ROAD GRAPH rather than to a region — see road_frontage.py
    # — so a map that publishes no `mapdata/roads.lua` gets no yards and says so
    # rather than falling back to a scatter that would put a depot in a field.
    road_links = read_road_links(map_dir)
    frontage_entries, frontage_refusals = rf.stage_frontage(
        rnd, terrain, facts, road_links, ROAD_FRONTAGE,
        mclass=DEFAULT_CLASS,
        occupied_rects=[b.rect() for b in all_buildings],
        occupied_units=all_cluster_units,
        footprint_gap=FOOTPRINT_GAP, unit_gap=UNIT_SPAWN_GAP,
        budget=MAX_ROAD_FRONTAGE)
    if not road_links:
        frontage_refusals = ["this map publishes no road graph "
                             "(mapdata/roads.lua), so it can carry no yards"]
    frontage_rects: list[tuple] = []
    for e in frontage_entries:
        b = Building(e["def"], e["x"], e["z"], e["facing"], facts[e["def"]])
        all_buildings.append(b)
        frontage_rects.append(b.rect())
        all_cluster_units.append((e["x"], e["z"], facts[e["def"]]))
        all_cluster_units.extend((p["x"], p["z"], facts[p["def"]])
                                 for p in e["parked"])

    # --- who owns them ------------------------------------------------------
    # `neutral` resolves to Gaia at stage time (game_scenario.lua stageUnits),
    # which Simulation.cpp configures as "neutral/environment, its own ally
    # team, no allies" and which exists regardless of roster. Hostile clusters
    # go to an ordinary NPC team: every non-Gaia team is its own ally team, so
    # an NPC team is hostile to both players with no extra configuration.
    for c in clusters:
        if c.get("township") is not None:
            # A PLANNED town is always the estate's, whatever `--hostility`
            # asks for, and that is not the knob being ignored — it is what
            # "occupied" means in this game. Who holds the ground is a REGION
            # CONTROL question (game_regions.lua, and the tactical objective
            # emitted on this very region below); who owns the housing is not.
            # Handing a town's buildings to the marauders would also take its
            # meeting hall off the civilian estate, and the hall is the estate's
            # parley venue — the town would stop being somewhere you can
            # negotiate with the people who live in it, which is the one thing
            # a town is for.
            c["owner"] = "neutral"
        elif hostility == "neutral":
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

    # --- features: the wreck field and the crossing (§M4) --------------------
    # LAST, because both must dodge everything already on the board and neither
    # is dodged by anything: a wreck is history, and the armies arrived after it.
    #
    # The field goes on the ground the war is ABOUT — the victory region — which
    # is also the ground most likely to be a chokepoint, so the gate below is
    # not ceremonial.
    army_points = [(u["x"] + dx, u["z"] + dz, facts[u["def"]])
                   for u in units
                   for dx, dz in grid_offsets(u.get("count", 1),
                                              u.get("spacing", 150))]
    wreck_entries, wreck_rects = place_wrecks(
        rnd, terrain, fdefs, victory, victory_anchor, wrecks, all_buildings,
        all_cluster_units + army_points, landmark_names)

    # R4: the roadside yards go through the same gate and in the same call. A
    # depot IS a blocking rectangle, and it is a blocking rectangle standing
    # ON a route by construction — `road_frontage._clears_deck` keeps it off
    # the carriageway, but "off the deck" is a local test and "the armies can
    # still reach each other" is a global one, and only this gate asks the
    # second question.
    gate_blocking_features_leave_the_war_fightable(
        terrain, wreck_rects + frontage_rects,
        [(f"side {i} landing zone ({r['key']})", a[0], a[1])
         for i, (r, a) in enumerate(zip(side_regions, side_anchors))] +
        [(f"victory objective ({victory['key']})",
          victory_anchor[0], victory_anchor[1])],
        map_id, what="the wreck field and the roadside yards")

    # Bridges. Searched over the victory region first (a crossing IS a
    # chokepoint, which is why the victory picker prefers one) and then over
    # every other non-home region, narrowest gap wins. A map with no river gets
    # no bridge and says so in the summary — silence would read as "there was
    # nowhere sensible", which is exactly what a missing feature should never
    # be indistinguishable from.
    #
    # ROADS R3b: if the map published its own road crossings
    # (`mapdata/roads.lua`, terragen/bridges.py) those win, in the same region
    # order. A published crossing is a place the map's own road goes under
    # water, carrying the road's tangent as the chain heading — where the blind
    # search below can only offer a cardinal facing and a gap that may have no
    # road anywhere near it. The blind search stays as the fallback for maps
    # with no road graph (hand-authored maps, and every map generated before
    # R3b).
    crossings: list[dict] = []
    if bridges > 0:
        span_def = BRIDGE_SPANS["road"]
        pitch = 24.0
        search = [victory] + [r for r in regions
                              if r["key"] != victory["key"]
                              and r["key"] not in home_keys]
        published = read_road_crossings(map_dir)
        # The y below is the waterline. §M3 measured a chain laid at y = 0 over
        # water staying dead level (0/0/0/0) thanks to `floating = true`, where
        # the same chain without a y settled into a staircase down the seabed
        # (-31/-34.5/-45.9/-57.6). It is also why the map does not place these
        # itself: no map feature format carries a y (terragen/bridges.py).
        # Published crossings first, ACROSS the whole search order — a real ford
        # in the third region beats a guessed gap in the first, which a
        # per-region preference would not give (the blind search would fill the
        # quota before the published crossing was ever reached).
        for region in search:
            if len(crossings) >= bridges:
                break
            poly = [(v[0], v[1]) for v in region["polygon"]]
            here = [c for c in published
                    if tp._point_in_polygon(c["x"], c["z"], poly)
                    and chain_is_afloat_at(terrain, c["x"], c["z"],
                                           c["heading"], c["spans"], pitch)]
            # Widest first: the biggest ford is the crossing a player reads as
            # THE crossing, and it is also the one that most needs explaining.
            here.sort(key=lambda c: (-c["width"], c["x"], c["z"]))
            if here:
                c = here[0]
                name = site_name(region, BRIDGE_NOUN, landmark_names)
                landmark_names.add(name)
                crossings.append({"def": c["def"], "x": c["x"], "z": c["z"],
                                  "heading": c["heading"], "chain": c["spans"],
                                  "y": 0, "name": name, "region": region,
                                  "width": c["width"]})
        for region in search:
            if len(crossings) >= bridges:
                break
            found = find_crossing(terrain, region, pitch)
            if found is None:
                continue
            cx, cz, facing, spans, width = found
            name = site_name(region, BRIDGE_NOUN, landmark_names)
            landmark_names.add(name)
            crossings.append({"def": span_def, "x": cx, "z": cz,
                              "facing": facing, "chain": spans,
                              "y": 0,
                              "name": name, "region": region, "width": width})
    # Emitted crossings-first, then relics, then the wreck field — placement
    # order is not emit order, and the file is read by people. `region` and
    # `width` are generator bookkeeping and are stripped here rather than in the
    # emitter, so nothing downstream has to know they were ever there.
    feature_entries = (
        [{k: v for k, v in c.items() if k not in ("region", "width")}
         for c in crossings] +
        [r["feature"] for r in relic_entries] +
        wreck_entries)

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
    for r in relic_entries:
        for g in r["guards"]:
            spawn_points.append((f"{g['def']} guarding {r['name']}",
                                 g["x"], g["z"], facts[g["def"]]))
    gate_no_unit_in_a_footprint([(l, x, z) for l, x, z, _f in spawn_points],
                                all_buildings)

    # A town's own people are graded on the rectangle, not the circle — see
    # gate_no_civilian_in_a_town_footprint for the measurement that makes the
    # circle unusable on a street. They join the shared spot-collision gate
    # below on equal terms, because THAT failure (two units on one patch of
    # ground, one of them silently never created) does not care how the ground
    # was chosen.
    town_points = [(f"{c.defname} in {ship.key} ({c.key})",
                    c.x, c.z, facts[c.defname])
                   for ship in townships for c in ship.populace.residents]
    gate_no_civilian_in_a_town_footprint(town_points, all_buildings)
    gate_no_two_units_share_a_spot(spawn_points + town_points)

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
        "towns": [ship.meta() for ship in townships],
        # Why each region that WANTED a planned town did not get one. Reported
        # rather than swallowed: "3 towns, 0 planned" with no reason reads as a
        # broken toolchain, and "every candidate region's flat ground is under
        # 1500 elmos across" reads as a map.
        "town_refusals": town_refusals,
        "civilians": sum(ship.populace.head_count() for ship in townships),
        "buildings": len(all_buildings),
        "classes": terrain.classes,
        "worst_frames": worst,
        "not_before": not_before,
        "hold_frames": hold,
        # §M4. `landmarks` is the list the command language will be able to
        # address once this scenario is staged — the whole point of naming
        # anything — so it belongs in the metadata a caller (or a reviewer)
        # reads back, not only in the file.
        "sites": [(s["def"], s["region"]["key"], s["name"])
                  for s in site_entries],
        "relics": [(r["feature"]["def"], r["region"]["key"], r["name"],
                    len(r["guards"])) for r in relic_entries],
        "wrecks": [w["def"] for w in wreck_entries],
        # R4. Reported as (def, road class name, parked count) because those are
        # the three things that can be wrong about a yard and are invisible in
        # the file: the wrong building, the wrong standard of road, or an apron
        # nothing could be parked on.
        "frontage": [(e["def"], e["road_name"], len(e["parked"]))
                     for e in frontage_entries],
        "frontage_refusals": frontage_refusals,
        "crossings": [(c["region"]["key"], c["name"], c["chain"],
                       round(c["width"])) for c in crossings],
        "landmarks": sorted(landmark_names),
    }
    return emit_lua(meta, side_regions, side_anchors, victory, units, clusters,
                    site_entries, relic_entries, feature_entries, crossings,
                    hostile_team, sides, not_before, hold, townships,
                    frontage_entries), meta


# ==========================================================================
# Emit — a pure Lua table literal (invariant 1)
# ==========================================================================

def _lua_str(s: str) -> str:
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"


def _team_field(owner) -> str:
    return str(owner) if isinstance(owner, int) else _lua_str(owner)


def emit_lua(meta, side_regions, side_anchors, victory, units, clusters,
             site_entries, relic_entries, feature_entries, crossings,
             hostile_team, sides, not_before, hold, townships=(),
             frontage_entries=()) -> str:
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
    if townships:
        add("")
        add("            -- A region with a town in it is NAMED AFTER THE TOWN, and its")
        add("            -- published centre moves to the town's centre. `name` is")
        add("            -- game_regions.lua's `region_<key>_name` rulesParam — the path")
        add("            -- the client's named-entity index reads to build the command")
        add("            -- composer's Target picker, so this is what makes a town")
        add("            -- addressable by name in a typed or spoken order, and what a")
        add("            -- parley proposal's `terms.regionKey` resolves to.")
        add("            --")
        add("            -- One place, one name, one key. A region is kilometres of")
        add("            -- ground and the town is the only part of it a player can")
        add("            -- point at: leaving the region's own name in place would give")
        add("            -- that ground two names, and leaving its centroid in place")
        add("            -- would send \"attack <town>\" to a spot out in the fields.")
        add("            -- `team` is deliberately absent — naming a place says nothing")
        add("            -- about who holds it, and the tactical objective on this same")
        add("            -- region below is what makes that a question.")
        for ship in townships:
            add(f"            {{ key = {_lua_str(ship.key)}, "
                f"name = {_lua_str(ship.town.name)}, "
                f"x = {ship.town.x}, z = {ship.town.z} }},")
    add("        },")
    if feature_entries:
        add("")
        add("        -- PLACED HISTORY (PLAN-metalstorm-model-integration §M3/§M4).")
        add("        -- Features, not units: the loader calls Spring.CreateFeature for")
        add("        -- these and stages them BEFORE units, so a wreck owns its squares")
        add("        -- before anything is put down near it.")
        add("        --")
        add("        -- A `name` here is published at GameStart as")
        add("        -- landmark_<name>_x/_z, which is how the command language")
        add("        -- addresses it (\"hold the crossing\").")
        add("        features = {")
        if crossings:
            add("            -- THE CROSSING. Chained road spans over the narrowest")
            add("            -- water gap on the contested ground; `chain` is centred on")
            add("            -- (x, z) and the 24 m pitch comes from the def's own")
            add("            -- customParams.chain_pitch, never restated here.")
            add("            --")
            add("            -- y = 0 is the waterline, and it is load-bearing:")
            add("            -- CFeature::UpdatePosition applies gravity then clamps to")
            add("            -- the ground, so spans over a channel settle into a")
            add("            -- staircase down the seabed unless they are spawned at the")
            add("            -- waterline AND float (features/bridges.lua floating=true).")
            add("            -- EVERY SEGMENT CENTRE IS OVER WATER, which is why the deck")
            add("            -- stops short of the banks rather than climbing them: a dry")
            add("            -- segment clamps to the terrain and kinks the deck upward.")
            for c in crossings:
                add(f"            -- {c['region']['name']}: a {round(c['width'])}-elmo gap, "
                    f"{c['chain']} spans")
                add("            " + _emit_feature(
                    {k: v for k, v in c.items() if k not in ("region", "width")}))
        if relic_entries:
            add("")
            add("            -- ANCIENT-TECH RELICS. Placed history a faction is squatting")
            add("            -- on (the guardian bands are in `units` below). They block")
            add("            -- and they do NOT animate: FeatureRenderer thin-instances one")
            add("            -- mesh per def, so the spire's authored ring orbit goes")
            add("            -- unplayed — recorded in the def's static_clip_unplayed.")
            for r in relic_entries:
                add("            " + _emit_feature(r["feature"]))
        wreck_entries = [f for f in feature_entries
                         if f["def"].endswith("_wreck")]
        if wreck_entries:
            add("")
            add("            -- THE WRECK FIELD, on the ground the war is about. These")
            add("            -- BLOCK (features/wrecks.lua), so the generator stamps every")
            add("            -- one into the passability mask and re-runs the reachability")
            add("            -- gate: a field that walls off the crossing it decorates is")
            add("            -- the Meridian defect re-created out of scenery.")
            for f in wreck_entries:
                add("            " + _emit_feature(f))
        add("        },")
    add("    },")
    add("")

    if townships:
        add("    -- ======================================================================")
        add("    -- TOWNS (town-planner T4). Street-and-lot settlements planned on this")
        add("    -- map's own heightmap rather than scattered on rings: streets, lots")
        add("    -- with frontage, a wall where the town built one, and the people who")
        add("    -- live there. A town's buildings are in `units` and its population is")
        add("    -- in `civilians` — two different wires, on purpose (see both blocks).")
        add("    --")
        add("    -- This block is what makes a town a PLACE the rest of the game can")
        add("    -- reason about: game_scenario.lua hands it to GG.Towns, which")
        add("    -- publishes each town's statics, binds its civilians into a district")
        add("    -- the estate can count, and resolves `hall` to the live unit that is")
        add("    -- this town's PARLEY VENUE. `key` is the region key, so a town needs")
        add("    -- no second namespace: it is addressed exactly as its region is.")
        add("    towns = {")
        for ship in townships:
            m = ship.meta()
            add(f"        -- {m['name']}: {m['archetype']}, {m['defense']}, "
                f"{m['lots']} lot(s), {m['gateways']} gateway(s), "
                f"{m['civilians']} civilian entr(y/ies)")
            add("        {")
            add(f"            key       = {_lua_str(m['key'])},")
            add(f"            name      = {_lua_str(m['name'])},")
            add(f"            region    = {_lua_str(m['region'])},")
            add(f"            x = {m['x']}, z = {m['z']}, radius = {m['radius']},")
            add(f"            archetype = {_lua_str(m['archetype'])}, "
                f"defense = {_lua_str(m['defense'])},")
            if m["hall"]:
                add("            -- The meeting hall: exactly one per town, and the venue a")
                add("            -- parley addressed to the civilian estate about this")
                add("            -- district is held at. GG.Towns resolves it to a live")
                add("            -- unitID by looking for this def at this position once the")
                add("            -- units below are staged; destroy it and the estate has")
                add("            -- nowhere left to negotiate about this town.")
                add(f"            hall = {{ def = {_lua_str(m['hall']['def'])}, "
                    f"x = {m['hall']['x']}, z = {m['hall']['z']} }},")
            else:
                add("            -- No hall: this game ships no def for the `unique` lot")
                add("            -- role, so this town has no parley venue.")
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
        ship = c.get("township")
        if ship is not None:
            m = ship.meta()
            add(f"        -- {m['name']} ({m['key']}) — {owner}. A PLANNED town: "
                f"{m['buildings']} building(s)")
            add(f"        -- on {len(ship.town.streets)} street(s), "
                f"{m['defense']} defense. `facing` is load-bearing here and not")
            add("        -- decoration: a town's buildings FRONT THEIR STREET, which is")
            add("        -- what makes a row read as a row, and the engine derives the")
            add("        -- blocked footprint from it by swapping the sizes.")
        else:
            add(f"        -- {tpl['label']}: {c['region']['name']} "
                f"({c['region']['key']}) — {owner}")
        for b in c["buildings"]:
            add(f"        {{ def = {_lua_str(b.defname)}, "
                f"team = {_team_field(c['owner'])}, x = {b.x}, z = {b.z}, "
                f"facing = {_lua_str(b.facing)} }},")
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

    if site_entries:
        add("")
        add("        -- NAMED RESOURCE SITES (§M4, worldbuilding decision 1). One")
        add("        -- capturable structure each, on Gaia, named after the region it")
        add("        -- stands in — which is the name a player has already seen on the")
        add("        -- overlay, and the name the loader publishes as")
        add("        -- landmark_<name>_x/_z for the command language to resolve.")
        add("        --")
        add("        -- They pay NOTHING: income in Metalstorm is Authority")
        add("        -- (worldbuilding decision 3), so a site is worth holding because")
        add("        -- it anchors an objective and because it is somewhere the story")
        add("        -- can point at, not because it produces.")
        for s in site_entries:
            add(f"        -- {s['name']} ({s['region']['key']})")
            add("        " + _emit_unit(s))

    if frontage_entries:
        add("")
        add("        -- ROADSIDE YARDS (roads R4). A depot, workshop or fuel stop set")
        add("        -- back from a road the MAP planned (mapdata/roads.lua links), with")
        add("        -- its apron between it and the carriageway and the yard's vehicles")
        add("        -- parked on that apron. The building faces the road: `facing` here")
        add("        -- is the road's own tangent snapped to the nearest cardinal, which")
        add("        -- is all Spring.CreateUnit accepts (four facings, not a heading).")
        add("        --")
        add("        -- The parked vehicles are ordinary Gaia units, not decoration:")
        add("        -- nothing in this game can park a wreck that is still driveable,")
        add("        -- and a civilian lorry standing in a yard is what a yard looks")
        add("        -- like. They carry no orders, so they stay where they are staged.")
        for e in frontage_entries:
            add(f"        -- {e['def']} on the {e['road_name']} "
                f"({len(e['parked'])} parked)")
            add("        " + _emit_unit(e))
            for pk in e["parked"]:
                add("        " + _emit_unit(pk))

    if relic_entries:
        add("")
        add("        -- ANCIENT-TECH GUARDIANS (§M4, worldbuilding directive 4). The")
        add("        -- relic itself is a FEATURE (see world.features above); what can")
        add("        -- be fought is the band squatting on it. Anarchic archetype —")
        add("        -- gun trucks and militia, not line armour.")
        for r in relic_entries:
            if not r["guards"]:
                continue
            add(f"        -- guarding {r['name']} ({r['region']['key']})")
            for g in r["guards"]:
                add("        " + _emit_unit(g))
    add("    },")
    add("")

    if townships:
        add("    -- ======================================================================")
        add("    -- THE POPULATION. A DIFFERENT WIRE FROM `units` ABOVE, DELIBERATELY.")
        add("    -- These entries route through GG.Civilians.Spawn and land in the")
        add("    -- civilian REGISTRY, which is the source of truth for who is a")
        add("    -- civilian and what they are: civilians/routines.lua wanders the")
        add("    -- `ambient` ones, civilians/estate.lua counts them as their district's")
        add("    -- population, and game_scenario.lua's own populateCiviliansInArea")
        add("    -- resolves protect/escort objectives against them. A unit staged")
        add("    -- through `units` is invisible to all three.")
        add("    --")
        add("    -- The reverse is just as load-bearing and is why a town's BUILDINGS")
        add("    -- are not here: the registry would enroll immobile structures in a")
        add("    -- per-tick CMD_MOVE they can never satisfy.")
        add("    --")
        add("    -- `town` is what binds a civilian to a district. estate.lua groups the")
        add("    -- population by `info.districtId` and — until this generator emitted")
        add("    -- one — always found none, because no spawn path had ever set it; its")
        add("    -- own header says the mechanism was real and saw nothing.")
        add("    --")
        add("    -- `role`: `ambient` is the population, `garrison` is the militia on the")
        add("    -- gates. routines.lua only moves `ambient`, so a garrison holds its")
        add("    -- post instead of strolling off the gateway it was put on, and the")
        add("    -- estate does not count armed volunteers as the civilians a protect")
        add("    -- objective is about.")
        add("    civilians = {")
        add("        units = {")
        for ship in townships:
            m = ship.meta()
            counts = ", ".join(f"{n} {k}" for k, n in
                               ship.populace.kind_counts() if n)
            add(f"            -- {m['name']} ({m['key']}): {counts or 'nobody'}")
            for c in ship.populace.residents:
                add(f"            {{ def = {_lua_str(c.defname)}, "
                    f"x = {c.x}, z = {c.z}, "
                    f"facing = {_lua_str(c.facing)}, "
                    f"role = {_lua_str(c.registry_role)}, "
                    f"town = {_lua_str(ship.key)} }},")
            for what, kind, why in ship.populace.dropped:
                add(f"            -- dropped {what} ({kind}): {why}")
            for gap in ship.populace.gaps:
                add(f"            -- gap: {gap}")
        add("        },")
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
    # ONE tactical control objective per region, richest claim first. A site
    # may share a region with a town (see _rank_regions), and two `control`
    # objectives on one region are not two prizes — they are the same ground
    # scored twice, which reads to a player as a bug and to the objectives
    # gadget as two independent holds of the same thing.
    tactical: dict[str, tuple[int, int, str]] = {}
    for order, (reward, items, label) in enumerate((
            (200, [(r["region"]["key"], r["name"]) for r in relic_entries],
             "ancient-tech prize"),
            (130, [(s["region"]["key"], s["name"]) for s in site_entries],
             "resource site"),
            (110, [(c["region"]["key"], CLUSTER_TEMPLATES[c["kind"]]["label"])
                   for c in clusters], "settlement"))):
        for key, why in items:
            if key not in tactical:
                tactical[key] = (reward, order, why)
    if tactical:
        add("")
        add("        -- Tactical prizes on the occupied ground: settlements, the named")
        add("        -- resource sites, and the ancient-tech caches. Open race for the")
        add("        -- same reason as above; no expiry.")
        add("        --")
        add("        -- A resource site pays NO income (worldbuilding decision 3), so")
        add("        -- its objective is the entire mechanical reason to take it — the")
        add("        -- silo is worth holding because the region it stands in scores.")
        for key in sorted(tactical):
            reward, _order, why = tactical[key]
            add(f"        {{ type = 'control', scope = 'tactical', forTeam = nil, "
                f"region = {_lua_str(key)}, reward = {reward}, "
                f"expiresAtFrame = nil }},  -- {why}")
    add("    },")
    add("}")
    add("")
    return "\n".join(L)


def _emit_feature(f: dict) -> str:
    """One `world.features` entry. Keys the loader reads, in a fixed order.

    `region` and `width` are generator bookkeeping and never reach the file —
    the caller strips them, and this function would emit them verbatim if it
    did not, producing keys game_scenario.lua's validate() has no opinion about
    and the lobby's bare lua_State would happily parse into nothing.
    """
    parts = [f"def = {_lua_str(f['def'])}", f"x = {f['x']}", f"z = {f['z']}"]
    if f.get("y") is not None:
        parts.append(f"y = {f['y']}")
    if f.get("facing"):
        parts.append(f"facing = {_lua_str(f['facing'])}")
    # A raw heading, for a chain laid along something that is not a cardinal —
    # a road's own tangent (roads R3b). game_scenario.lua's featureHeading takes
    # either; this emitter silently DROPPED any key it did not name, so the
    # first published crossing arrived heading-less and pointed north.
    if f.get("heading") is not None:
        parts.append(f"heading = {int(f['heading'])}")
    if f.get("chain", 1) != 1:
        parts.append(f"chain = {f['chain']}")
    if f.get("name"):
        parts.append(f"name = {_lua_str(f['name'])}")
    return "{ " + ", ".join(parts) + " },"


def _emit_unit(u: dict) -> str:
    parts = [f"def = {_lua_str(u['def'])}", f"team = {_team_field(u['team'])}",
             f"x = {u['x']}", f"z = {u['z']}",
             f"facing = {_lua_str(u['facing'])}"]
    if u.get("name"):
        parts.append(f"name = {_lua_str(u['name'])}")
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
    ap.add_argument("--sites", type=int, default=3,
                    help="named resource sites (silo/derrick/pit/yard/...)")
    ap.add_argument("--relics", type=int, default=1,
                    help="ancient-tech prize sites, each with a guardian band")
    ap.add_argument("--wrecks", type=int, default=5,
                    help="wrecks scattered on the contested region")
    ap.add_argument("--bridges", type=int, default=1,
                    help="chained road spans over water gaps, where one fits")
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
            sites=args.sites, relics=args.relics, wrecks=args.wrecks,
            bridges=args.bridges,
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
    for defname, key, name in meta["sites"]:
        say(f"    site     {key:22s} {name} ({defname})")
    for defname, key, name, guards in meta["relics"]:
        say(f"    relic    {key:22s} {name} ({defname}, {guards} guardian(s))")
    if meta["wrecks"]:
        say(f"    wrecks   {len(meta['wrecks'])} on {meta['victory_region']}: "
            f"{', '.join(sorted(meta['wrecks']))}")
    # A map with no river gets no bridge, and that is a legitimate outcome — but
    # it is said out loud, because "no crossing in the file" and "the placer
    # found nowhere sensible" must not look identical from the outside.
    if meta["crossings"]:
        for key, name, spans, width in meta["crossings"]:
            say(f"    crossing {key:22s} {name} — {spans} spans over a "
                f"{width}-elmo gap")
    else:
        say("    crossing none — no water gap on this map fits a span "
            "(bridges belong over water; over dry ground the engine's ground "
            "clamp steps every segment)")
    # R4. Same rule as the crossing above: a map whose roads cannot carry a
    # yard is a legitimate outcome, and the refusal says which rule refused so
    # "this map has no highway" cannot read as "the placer is broken".
    for defname, road, parked in meta["frontage"]:
        say(f"    yard     {road:22s} {defname} ({parked} parked)")
    for why in meta["frontage_refusals"]:
        say(f"    yard refused: {why}")
    say(f"  {len(meta['landmarks'])} landmark(s) the command language can "
        f"address: {', '.join(meta['landmarks'])}")
    if meta["towns"]:
        say(f"  {len(meta['towns'])} planned town(s), "
            f"{meta['civilians']} civilian entries:")
        for t in meta["towns"]:
            say(f"    {t['name']:20s} {t['key']:22s} {t['archetype']:16s} "
                f"{t['defense']:9s} {t['lots']:2d} lots, "
                f"{t['buildings']:2d} buildings, {t['civilians']:2d} civilians, "
                f"hall {'yes' if t['hall'] else 'NO'}")
    for key, why in meta["town_refusals"]:
        say(f"    town refused in {key}: {why}")

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
            "mines": args.mines, "sites": args.sites, "relics": args.relics,
            "wrecks": args.wrecks, "bridges": args.bridges,
            "hostility": args.hostility, "roster": args.roster,
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
