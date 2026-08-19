#!/usr/bin/env python3
"""town_stager.py — turns a planned town graph into things that can be spawned.

The second half of the town planner (`town_planner.py` is the first). The
planner owns GEOMETRY and emits a graph of parcels; this module owns CONTENT
and emits placements — a def name, a position, a facing, and the axis-aligned
patch of ground it will actually block:

    python3 tools/mapgen/town_stager.py --seed 7 --demo rolling --out town.json
    python3 tools/mapgen/town_stager.py --seed 7 --demo rolling --check

`town_planner` says "a 210x190 parcel at 30 degrees, role `bulk`, fronting Kiln
Row". This module says "`ms_shanty_block` at (4102, 2996) facing south, blocking
x 4006..4198, z 2900..3092" — and then proves that no other building blocks any
of the same ground and that a civilian could walk from Kiln Row to its door.

WHY THIS IS A SEPARATE MODULE FROM THE PLANNER, AND NOT A FUNCTION IN IT.
The planner must run with no game content loaded — it is graded against
terrain, and `town_planner`'s tests plan towns on synthetic heightmaps in a
checkout with no `data/maps` and no `ms_defs`. Staging is the opposite: it is
almost entirely a question about what the game ships. Keeping the two apart is
what lets one town graph be planned once and staged differently as content
lands, which is not hypothetical — see the roster note below.

THE FINDING THIS MODULE EXISTS TO GET RIGHT: A LOT IS ROTATED, A BUILDING IS NOT.
`Spring.CreateUnit` takes a FACING, not a heading — one of four cardinals
(game_scenario.lua:308) — and the engine derives the blocked footprint from it
by swapping the two sizes, not by rotating them:

    xsize = ((buildFacing & 1) == 0) ? def->xsize : def->zsize;   Unit.cpp:224
    zsize = ((buildFacing & 1) == 1) ? def->xsize : def->zsize;   Unit.cpp:225

So the ground a building blocks is ALWAYS an axis-aligned rectangle. A lot, by
contrast, is an oriented box square to its street — that orientation is the
whole reason the planner's towns read as streets rather than as scatter. On any
street that does not happen to run north-south or east-west, the two disagree,
and the disagreement grows to its worst at 45 degrees, where a 192-elmo
building inscribed in its own 210-elmo parcel pokes 40 elmos out of each corner
and into its neighbour's.

Consequences, all of them load-bearing here:
  * Overlap MUST be tested on the axis-aligned rectangles. Testing the parcels
    (which the planner already guarantees do not overlap) proves nothing about
    the buildings, and testing the rotated building box tests a shape the
    engine will never create.
  * A parcel that comfortably holds a building on a north-south street may not
    hold the same building on a diagonal one. The placement ladder below
    therefore relaxes lot containment before it relaxes anything else — the
    parcel is the planner's opinion about where a building belongs, and the
    three hard constraints (no overlap, off the carriageway, on buildable
    ground) are the ones that decide whether it may be there.
  * One useful invariant survives the swap and the module leans on it: the
    extent ACROSS the facing direction is always `footprintx`, and the extent
    ALONG it is always `footprintz`. Check it on facing=east: xsize becomes
    def->zsize, and east's own axis is x, so depth-towards-the-street is
    footprintz there too. A def's `footprintx` is its FRONTAGE and its
    `footprintz` is its DEPTH, under every facing. `_extent_of` is that.

THE ROSTER IS NOT THE ROSTER YET, AND THIS MODULE IS BUILT FOR THAT.
Verified in this clone 2026-08-06: `ms_shanty_block`, `ms_meeting_hall`,
`ms_market_stalls`, `ms_water_works`, `ms_grain_silo` and `ms_watchtower` have
no unit def — model-integration's M2 landed them on its own branch, behind a
manual land gate, so they are not readable from here. The eight featuredefs
M3 landed (three wrecks, two bridges, three relics) are equally not here.
Nothing in this module names a def directly: content comes from
`town_templates.role_options` / `resolve_props` / `resolve_landmarks`, each of
which filters to what the caller's roster actually contains, so the same town
graph and the same seed stage stand-ins today and the briefed roster the day
M2/M3 land. `StagedTown.gaps` reports every role and kind that had no content,
by name, so a degraded town is legible rather than silent.

DETERMINISM — the same rules as `town_planner` and `scenariogen`, unchanged.
One explicit `random.Random`; `rnd.random()` the only primitive; nothing that
reaches output iterates a dict or a set; all emitted coordinates integral.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ms_defs                                              # noqa: E402
import town_planner as tp                                   # noqa: E402
from town_templates import (                                # noqa: E402
    DECOR,
    EMPLACEMENT_PARTS,
    LANDMARK_MAX,
    LANDMARK_ODDS,
    LINE_PARTS,
    LOT_ROLES,
    PERIMETER,
    PROPS,
    ROLE_ORDER,
    resolve_landmarks,
    resolve_perimeter,
    resolve_props,
    role_options,
)

# Bumped whenever the emitted staging changes for an unchanged (graph, seed,
# roster). Separate from `town_planner.PLANNER_VERSION`: a consumer caching a
# staged town needs to see either move, and the two move for different reasons.
#
#   2  (town-planner T3) the town's defenses stage. A walled graph now yields
#      wall/corner/gate/anchor units along its line and tower/gun units behind
#      it, in two new categories; wall pieces clear each other at zero gap
#      because a wall that leaves an alley between its own segments is a fence.
STAGER_VERSION = 2

# Elmos across one build square. `ms_defs.FOOTPRINT_SCALE` (2) converts a def's
# `footprintx` to Spring's `xsize`, and `xsize * 4` is the half-extent in elmos
# (ms_defs.UnitFacts.body_radius) — so a whole square is 2 * 4 * 2 = 16 elmos,
# and ms_habitat's footprint of 12 is the 192 elmos town_templates measured.
SQUARE_ELMOS = ms_defs.FOOTPRINT_SCALE * 8

# Model metres to elmos, for the landmark clearances only. See LANDMARKS in
# town_templates for the derivation and for why it is derived and not read.
METRES_TO_ELMOS = 8

# Building-to-building clearance, in elmos. ONE BUILD SQUARE, and deliberately
# NOT `scenariogen.FOOTPRINT_GAP` (32), which is the wrong constant here.
#
# MEASURED, and the measurement is the argument. `place_cluster` scatters
# buildings on rings and 32 elmos is the room that keeps a scattered cluster
# legible and walkable. A town is the opposite thing: a street is buildings
# standing shoulder to shoulder along it, and terraces that touch are what a
# town looks like. At 32 the arithmetic simply does not close — the widest
# archetype offers 210 elmos of frontage per lot and `ms_habitat` blocks 192 of
# it, so two neighbours on one row need 224 and every archetype is short:
#
#     grid_quarter    frontage 210, need 224 — short 14
#     main_street     frontage 200, need 224 — short 24
#     organic_cluster frontage 190, need 224 — short 34
#
# Swept over 134 towns at 32, 19% of all lots were dropped for "no def fits"
# and the drops were 356 dwellings — every other house on a row, which reads as
# a town with its teeth knocked out. At one build square the arithmetic closes
# (192 + 16 = 208 <= 210) and the same sweep drops far fewer.
#
# The floor is not zero: adjacent yardmaps are legal in Spring, but a town with
# no gap at all has no alleys, and `_unreachable`'s raster (REACH_CELL, half
# this) would have nothing to flood through between two rows backing onto each
# other. One square is the smallest gap that is still a gap.
TOWN_GAP = 16

# How close a building may come to a carriageway EDGE. The archetypes' setback
# is 30-34 elmos, so this is slack within the setback rather than a new
# constraint — it exists so that a placement relaxed off its parcel cannot
# drift onto the road that parcel fronts.
STREET_CLEARANCE = 8

# Street centreline sampling for the carriageway tests. Tighter than the
# planner's 24 because the question here is harder: the planner asks whether a
# 200-elmo parcel clears a road, this module asks whether a building does, and
# a sample stride comparable to the gap it is checking will step over a corner.
STREET_STRIDE = 12

# Clearance between two pieces of the SAME WALL. Zero, and the zero is the
# point: `town_planner` tiles the line arc-for-arc so that consecutive pieces
# abut exactly, and a wall that holds its own segments TOWN_GAP apart is not a
# wall, it is a picket fence with a 16-elmo hole every 110 elmos. Touching is
# legal — `_rects_overlap` treats a shared edge as clear, matching
# `scenariogen._rects_overlap` — so abutting segments pass the same overlap test
# everything else does, with no exception carved into the spec for them.
#
# It applies to wall-against-anything, not just wall-against-wall: a wall
# running along the back of a terrace is what a walled town looks like, and the
# alley TOWN_GAP buys between two houses buys nothing between a house and the
# boundary. The town's own `PERIMETER["margin"]` (150 elmos from the outermost
# lot) is what actually keeps them apart, and it is the planner's to set.
WALL_GAP = 0

# Elmos of slack on the wall's own stamp pitch. See `_stamp_pitch`.
WALL_STAMP_SLACK = 2.0

# Reachability raster cell, in elmos. Half of TOWN_GAP on purpose: at a cell
# equal to the gap, the one-cell-wide alley the gap guarantees can fall
# entirely inside two neighbouring blocked cells, and the flood fill then
# reports a perfectly walkable alley as sealed — a false failure, which in a
# spec is worse than a missed one because it trains the reader to ignore it.
REACH_CELL = 8

FACING_ORDER = ["south", "east", "north", "west"]     # Spring's 0..3
FACING_INDEX = {name: i for i, name in enumerate(FACING_ORDER)}

# Unit vector pointing the way a building FACES, +z being south (town_planner
# ._facing_of, and Spring's own convention).
FACING_VECTOR = {"south": (0.0, 1.0), "east": (1.0, 0.0),
                 "north": (0.0, -1.0), "west": (-1.0, 0.0)}


class StagingRejected(Exception):
    """This graph cannot be staged as a town, and the message says why.

    Raised — not returned — for the same reason `SiteRejected` is: every
    failure here means the caller should try another site or another seed, and
    a town quietly missing the one building the scenario layer points its
    objectives at is the outcome this module exists to prevent.
    """


# ==========================================================================
# Geometry: the axis-aligned world the engine actually builds in
# ==========================================================================

def _extent_of(facing: str, fx: int, fz: int) -> tuple[float, float]:
    """Half-extents in elmos of the ground a building blocks, axis-aligned.

    The engine's swap (Unit.cpp:224-225) in two lines. Note the invariant the
    module header draws out: whichever cardinal is passed, the half-extent
    ACROSS the facing direction comes from `fx` and the one ALONG it from `fz`.
    """
    if FACING_INDEX[facing] & 1:                  # east / west
        return (fz * SQUARE_ELMOS / 2.0, fx * SQUARE_ELMOS / 2.0)
    return (fx * SQUARE_ELMOS / 2.0, fz * SQUARE_ELMOS / 2.0)


def _rect(x: float, z: float, hx: float, hz: float, pad: float = 0.0):
    return (x - hx - pad, z - hz - pad, x + hx + pad, z + hz + pad)


def _rects_overlap(a, b) -> bool:
    """Touching does not count, matching `scenariogen._rects_overlap` exactly."""
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def _point_in_rect(px, pz, r) -> bool:
    return r[0] <= px <= r[2] and r[1] <= pz <= r[3]


def _lot_frame(lot):
    """The lot's local axes: (along-street unit, away-from-street unit).

    `town_planner._carve_lots` puts a lot at `street point + (cos ang, sin ang)
    * back` for `ang = heading + pi/2 * side`, so the away-from-street unit is
    that same `ang` and the lot's own OBB is built on `heading`. Recovering it
    here rather than storing it keeps `Lot` the planner's dataclass.
    """
    h = lot.heading
    along = (math.cos(h), math.sin(h))
    ang = h + (math.pi / 2.0) * lot.side
    away = (math.cos(ang), math.sin(ang))
    return along, away


def _lot_projection(lot, hx: float, hz: float) -> tuple[float, float]:
    """How far an axis-aligned box of half-extents (hx, hz) reaches in lot axes.

    The support function of a rectangle on the lot's two local axes: a box at
    angle `h` to the parcel occupies `hx|cos h| + hz|sin h|` of the parcel's
    frontage and `hx|sin h| + hz|cos h|` of its depth. At h = 0 that is (hx, hz)
    and at 45 degrees it is (0.707(hx+hz), 0.707(hx+hz)) for both — which is
    the diagonal-street cost the module header describes, in one line.
    """
    c, s = abs(math.cos(lot.heading)), abs(math.sin(lot.heading))
    return (hx * c + hz * s, hx * s + hz * c)


# ==========================================================================
# Placements
# ==========================================================================

@dataclass
class Placement:
    """One thing to spawn, and the ground it takes.

    `channel` is the wire it stages on and the two are NOT interchangeable:
    `unit` entries go through `world.units` / `Spring.CreateUnit`, `feature`
    entries through `world.features` / `Spring.CreateFeature` (model-integration
    §M3). A consumer whose game has no feature channel must drop the feature
    placements, not spawn them as units.
    """
    key: str
    channel: str               # unit | feature
    category: str              # building | wall | defense | prop | landmark
    role: str                  # lot role, wall part, decoration kind, or
                               # landmark siting
    tier: str                  # common | uncommon | unique
    defname: str
    x: int
    z: int
    facing: str
    half_x: float
    half_z: float
    lot: str | None = None
    street: str | None = None
    fit: str = "anchored"      # which rung of the placement ladder placed it

    def rect(self, pad: float = 0.0):
        return _rect(self.x, self.z, self.half_x, self.half_z, pad)

    def to_dict(self) -> dict:
        r = self.rect()
        return {"key": self.key, "channel": self.channel,
                "category": self.category, "role": self.role, "tier": self.tier,
                "def": self.defname, "x": self.x, "z": self.z,
                "facing": self.facing, "lot": self.lot, "street": self.street,
                "fit": self.fit,
                "rect": [int(math.floor(r[0])), int(math.floor(r[1])),
                         int(math.ceil(r[2])), int(math.ceil(r[3]))]}


@dataclass
class StagedTown:
    """Everything a consumer needs to build this town, plus what it could not.

    `gaps` and `dropped` are first-class output, not diagnostics. A town missing
    its market because the def does not exist and a town missing its market
    because every candidate parcel was on a slope are different problems with
    different owners, and a staging that reports neither reads as complete.

    `dropped` is (what, kind, why): `what` is a lot key or a wall-piece key,
    and `kind` is a lot ROLE (`ROLE_ORDER`) or a perimeter PART (`LINE_PARTS` /
    `EMPLACEMENT_PARTS`). The two vocabularies are disjoint on purpose, so an
    entry says which sort of thing was lost without a fourth field.
    """
    key: str
    name: str
    seed: int
    archetype: str
    x: int
    z: int
    radius: int
    placements: tuple = ()
    dropped: tuple = ()
    gaps: tuple = ()
    stager_version: int = STAGER_VERSION
    planner_version: int = tp.PLANNER_VERSION

    def of_category(self, category: str) -> list:
        return [p for p in self.placements if p.category == category]

    def units(self) -> list:
        return [p for p in self.placements if p.channel == "unit"]

    def features(self) -> list:
        return [p for p in self.placements if p.channel == "feature"]

    def def_counts(self) -> list[tuple[str, int]]:
        """def -> how many, ordered by count then name. Never a dict iteration."""
        names = sorted({p.defname for p in self.placements})
        pairs = [(n, sum(1 for p in self.placements if p.defname == n))
                 for n in names]
        return sorted(pairs, key=lambda kv: (-kv[1], kv[0]))

    def tier_counts(self) -> list[tuple[str, int]]:
        from town_templates import TIERS
        return [(t, sum(1 for p in self.placements if p.tier == t))
                for t in TIERS]

    # -- emission ----------------------------------------------------------

    def scenario_units(self, team: str = "neutral") -> list[dict]:
        """`units` entries, in `game_scenario.lua`'s own shape.

        `'neutral'` is the loader's keyword, not a description: `stageUnits`
        resolves exactly that string to the Gaia team (game_scenario.lua:281)
        and a team it does not recognise is SKIPPED with a warning, not
        rejected. So a town emitted as `team = 'gaia'` would load, log one line,
        and stage nothing — the failure mode that keyword exists to avoid.

        Deliberately NOT written into a scenario here. `scenariogen.py` is the
        metalstorm-scenario lane's file and towns reaching emitted scenarios is
        a wiring decision with a fixture and a GENERATOR_VERSION attached to it
        (town-planner T4 owns it). This is the seam that makes that a small
        change when it is made: the entries are ready, the caller places them.
        """
        return [{"def": p.defname, "team": team, "x": p.x, "z": p.z,
                 "facing": p.facing} for p in self.units()]

    def scenario_features(self) -> list[dict]:
        """`world.features` entries (model-integration §M3's section).

        `y` is deliberately absent: §M3 measured that a feature's y is a SPAWN
        height and the engine settles it onto the terrain regardless, so naming
        one here would be a number with no meaning that a later reader would
        take for a considered choice.
        """
        return [{"def": p.defname, "x": p.x, "z": p.z, "facing": p.facing}
                for p in self.features()]

    def to_dict(self) -> dict:
        return {
            "stager_version": self.stager_version,
            "planner_version": self.planner_version,
            "key": self.key,
            "name": self.name,
            "seed": self.seed,
            "archetype": self.archetype,
            "x": self.x, "z": self.z, "radius": self.radius,
            "placements": [p.to_dict() for p in self.placements],
            "dropped": [{"lot": d[0], "role": d[1], "why": d[2]}
                        for d in self.dropped],
            "gaps": list(self.gaps),
            "def_counts": [[n, c] for n, c in self.def_counts()],
            "tier_counts": [[t, c] for t, c in self.tier_counts()],
        }

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent, sort_keys=False)

    def to_lua(self) -> str:
        """The same dump as a pure Lua literal — `town_planner.to_lua`'s rules."""
        return "return " + tp._lua_value(self.to_dict(), 0) + "\n"


# ==========================================================================
# The world a placement must fit into
# ==========================================================================

class _Site:
    """Streets, terrain and everything already placed, with the tests over them.

    One object rather than six parameters threaded through the ladder, because
    every rung asks the same three questions in the same order and a rung that
    forgot one is exactly the bug class this module is about.
    """

    def __init__(self, town, probe, rules):
        self.town, self.probe, self.rules = town, probe, rules
        self.placed: list[Placement] = []
        self.bucket = tp._Bucket(192.0)
        self.streets = tp._Bucket(192.0)
        for s in town.streets:
            clear = s.width / 2.0 + STREET_CLEARANCE
            total = s.length()
            d = 0.0
            while d <= total:
                px, pz, _h = tp.point_at(s.points, d)
                self.streets.add(px, pz, (px, pz, clear))
                d += STREET_STRIDE
            # The far end of a polyline is not on the stride unless the length
            # divides by it, and a street's last few metres are exactly where a
            # lot at the end of a row sits.
            px, pz, _h = tp.point_at(s.points, total)
            self.streets.add(px, pz, (px, pz, clear))

    # -- the three hard constraints ---------------------------------------

    def on_buildable_ground(self, x, z, hx, hz, slope=None) -> bool:
        """Corners and centre, on the planner's own buildability grade.

        `max_lot_slope` by default and not `max_street_slope`: this is where a
        building stands, and the planner already refused to carve a parcel whose
        corners failed this test. Re-running it on the BUILDING's corners is the
        point — the building is not the parcel and on a diagonal street it
        reaches into ground the parcel never covered.

        `slope` overrides it for the one thing in a town that is not a building
        standing on a pad: a WALL, which follows the land the way a road does
        and which `town_planner._build_perimeter` therefore graded at
        `max_street_slope`. Re-grading it here at the lot standard would reject
        wall the planner deliberately kept, and the town would lose the
        stretches of its boundary that ran over the roughest ground — exactly
        the stretches a wall is for.
        """
        if slope is None:
            slope = self.rules.max_lot_slope
        for px, pz in ((x - hx, z - hz), (x + hx, z - hz), (x + hx, z + hz),
                       (x - hx, z + hz), (x, z)):
            if not self.probe.buildable(px, pz, slope):
                return False
        return True

    def clear_of_placements(self, x, z, hx, hz, gap=TOWN_GAP) -> bool:
        r = _rect(x, z, hx, hz, gap)
        reach = math.hypot(hx, hz) + gap + 260.0
        for other in self.bucket.near(x, z, reach):
            if _rects_overlap(r, other.rect()):
                return False
        return True

    def off_the_carriageway(self, x, z, hx, hz) -> bool:
        """No street centreline sample inside the footprint plus that street's width.

        Every street, including the one the lot fronts. The planner exempts a
        lot's own street (a parcel is offset from it by the setback and applying
        the margin there would reject every lot in town); a BUILDING has no such
        excuse — it is inside the setback or it is on the road.
        """
        reach = math.hypot(hx, hz) + 200.0
        for px, pz, clear in self.streets.near(x, z, reach):
            if _point_in_rect(px, pz, _rect(x, z, hx, hz, clear)):
                return False
        return True

    def accepts(self, x, z, hx, hz, gap=TOWN_GAP, slope=None) -> bool:
        return (self.on_buildable_ground(x, z, hx, hz, slope)
                and self.off_the_carriageway(x, z, hx, hz)
                and self.clear_of_placements(x, z, hx, hz, gap))

    def add(self, p: Placement) -> None:
        self.placed.append(p)
        self.bucket.add(p.x, p.z, p)


# ==========================================================================
# Placing one building in one lot
# ==========================================================================

def _anchor_for(lot, hx: float, hz: float) -> tuple[float, float, float]:
    """Put the building's near face ON the parcel's frontage line. Returns (x, z, yard).

    Buildings FRONT THE STREET — the brief's own word, and the thing that makes
    a row read as a street rather than as a line of sheds. The frontage line is
    the parcel's street-side edge, one setback back from the carriageway, and
    this lands the box's leading face exactly there whatever its size:

        push = lot.depth/2 - reach_v          (in lot-local depth units)

    THE SIGN OF `push` IS THE WHOLE POINT, AND CLAMPING IT AT ZERO WAS A BUG.
    When the building is deeper than half its parcel — which on a 45-degree
    street is EVERY building, because `_lot_projection` costs a 192-elmo box
    136 elmos of parcel depth against the 100 it has — `push` goes negative and
    the building must move AWAY from the street to keep its face on the line.
    The first cut clamped at zero, so those buildings sat on their parcel
    centres, which put them 38 elmos inside a 40-elmo-wide carriageway; the
    ladder then shoved them backwards in coarse steps until they cleared, and
    the result rendered as scatter with roads through it rather than as a town.
    An unclamped push is not a relaxation — it is what fronting a street means.

    `yard` is what is left behind the building inside the parcel, which is
    where `_yard_spot` goes looking for somewhere to put a wreck. Negative
    means the building overhangs its own back boundary and this parcel has no
    yard at all.
    """
    _along, away = _lot_frame(lot)
    _reach_u, reach_v = _lot_projection(lot, hx, hz)
    push = lot.depth / 2.0 - reach_v
    return (lot.x - away[0] * push, lot.z - away[1] * push, push * 2.0)


def _place_building(site: _Site, lot, defname: str, facts) -> tuple | None:
    """Try to stand `defname` in `lot`. Returns (x, z, hx, hz, fit) or None.

    THE LADDER. Each rung gives up something a town would rather keep, in the
    order a town would rather give it up, and every rung re-checks all three
    hard constraints — there is no rung on which a building may overlap another
    building, stand on a road, or float on a cliff.

      anchored  on its parcel's frontage line, and contained by the parcel.
                What a town looks like when the geometry cooperates.
      free      on its parcel's frontage line, but NOT contained by the parcel.
                Geometrically identical to `anchored` — same position, same
                test, same guarantees — and reported separately only because it
                is worth knowing how often it happens. This is the rung the
                diagonal streets live on: a 45-degree parcel cannot contain the
                axis-aligned box the engine will build (`_lot_projection`), so
                insisting on containment there would not produce a tidier town,
                it would produce an empty one. The building still fronts the
                street, which is the property that matters.
      shifted   slid ALONG the frontage line. The rhythm of the row goes, the
                row itself stays.
      inset     stepped back OFF the frontage line, away from the road. The
                last rung before dropping the lot, because a building that is
                no longer on the frontage is no longer part of the street.

    Rungs are tried in order and the first that clears wins, so a town is as
    anchored as its ground allows and no more relaxed than it must be. The
    order of the last two is deliberate and was measured: relaxing depth before
    frontage rendered as scatter with roads running through it.
    """
    f = facts[defname]
    hx, hz = _extent_of(lot.facing, f.footprint_x, f.footprint_z)
    along, away = _lot_frame(lot)
    reach_u, reach_v = _lot_projection(lot, hx, hz)
    ax, az, _yard = _anchor_for(lot, hx, hz)
    contained = (reach_u <= lot.width / 2.0 and reach_v <= lot.depth / 2.0)

    def try_at(x, z, fit):
        """Test the INTEGRAL box, because that is the one that will exist.

        Every rung goes through here. Testing the float box and storing the
        rounded one is a bug this codebase has now hit three times — T1 fixed
        it in `_grow_lots`, then again in `_build_decor`, and this module had
        it too: a candidate cleared at 2731.868 and failed at 2732, because
        `SiteProbe` samples every 8 elmos and a tenth of an elmo is enough to
        land the corner in the next sample. The first cut caught that with a
        re-check AFTER the ladder had finished, which turned a recoverable
        near-miss into a dropped lot — and for the meeting hall, whose role is
        `unique`, into a whole town refused, because the re-check ran past the
        point where the fallback could still fire. Rounding here means every
        later rung is still available.
        """
        x, z = float(round(x)), float(round(z))
        return (x, z, hx, hz, fit) if site.accepts(x, z, hx, hz) else None

    # anchored: on the frontage line, where the parcel put it.
    got = try_at(ax, az, "anchored" if contained else "free")
    if got:
        return got

    # shifted: slide ALONG the frontage. Tried before any move off the line,
    # because sliding keeps the building on the street and stepping back does
    # not — a row with uneven spacing still reads as a row, a row with uneven
    # DEPTH reads as scatter. Nearest offsets first, alternating sides, so a
    # building moves the least distance that works and neighbours do not all
    # drift the same way.
    slack = max(lot.width / 2.0 - reach_u, 0.0)
    steps = [d for d in (slack * 0.45, slack * 0.9, 60.0, 110.0) if d > 1.0]
    for d in steps:
        for sign in (1, -1):
            got = try_at(ax + along[0] * d * sign, az + along[1] * d * sign,
                         "shifted")
            if got:
                return got

    # inset: only now step back off the frontage line, away from the road.
    # Bounded at ~one lot depth: past that a building is not on this street
    # any more, it is loose in the block behind it, and dropping the lot is the
    # more honest outcome than pretending the parcel was ever satisfied.
    for step in range(1, 5):
        d = step * 34.0
        got = try_at(ax + away[0] * d, az + away[1] * d, "inset")
        if got:
            return got
    return None


def _weighted_defs(rnd, options: list[tuple[str, float]], used) -> list[str]:
    """The role's defs in a seeded preference order, `distinct` respected.

    Returns an ORDER, not a pick, because the caller needs somewhere to go when
    its first choice does not fit the parcel: a market that cannot stand here
    should try the transit hub before it gives the lot up, and it should try it
    in an order this seed chose rather than in table order.
    """
    pool = list(options)
    out: list[str] = []
    while pool:
        # A def already standing in this town is pushed to the back rather than
        # removed: `distinct` is a preference ("the two utility lots should be
        # the water works and the grain silo"), and a town with three utility
        # lots and two utility defs still has to put something in the third.
        fresh = [(d, w) for d, w in pool if d not in used]
        pick = tp._pick_weighted(rnd, fresh or pool)
        out.append(pick[0])
        pool = [it for it in pool if it[0] != pick[0]]
    return out


# ==========================================================================
# Staging
# ==========================================================================

def stage_town(town, facts, seed: int | None = None, features=(),
               probe=None, rules=None) -> StagedTown:
    """Fill a planned town with buildings, props and the occasional landmark.

    `facts` is `ms_defs.load(game_dir)` — the unit roster. `features` is the
    FEATURE roster, a separate channel with a separate loader that does not
    exist in this clone yet (model-integration §M3); pass any container
    supporting `in`, or nothing for a game without features.

    `probe` re-grades the ground under each building. It defaults to the one
    thing that is always available — a probe is not stored on the graph — so
    callers that have the terrain should pass it and callers that do not still
    get every other check. Without it the ground test is skipped and
    `StagedTown.gaps` says so, because a staging that silently stopped checking
    terrain is worse than one that admits it.
    """
    if probe is None:
        site_probe = _NullProbe()
    else:
        site_probe = probe
    rules = rules or tp.SiteRules()
    rnd = random.Random(town.seed if seed is None else seed)

    site = _Site(town, site_probe, rules)
    gaps: list[str] = []
    dropped: list[tuple[str, str, str]] = []
    placements: list[Placement] = []

    if probe is None:
        gaps.append("terrain: no probe supplied — buildings were not re-graded "
                    "against the ground they stand on")

    options = role_options(facts)
    for role in ROLE_ORDER:
        if role not in options:
            gaps.append(f"role {role}: no def in the roster "
                        f"({', '.join(LOT_ROLES[role]['defs'])}) is available")

    _stage_buildings(rnd, town, site, facts, options, placements, dropped)
    _stage_perimeter(rnd, town, site, facts, placements, gaps, dropped)
    _stage_props(rnd, town, site, facts, placements, gaps)
    _stage_landmarks(rnd, town, site, features, placements, gaps)

    staged = StagedTown(
        key=town.key, name=town.name, seed=town.seed, archetype=town.archetype,
        x=town.x, z=town.z, radius=town.radius,
        placements=tuple(placements), dropped=tuple(dropped), gaps=tuple(gaps))

    # The one contract this module refuses to ship broken. `unique` means
    # exactly one meeting hall per town — the scenario layer points parley and
    # objectives at it (T4), so a town with none is not a variation, and a town
    # with two is not a richer town.
    if "unique" in options:
        halls = [p for p in placements if p.role == "unique"]
        if len(halls) != 1:
            raise StagingRejected(
                f"{town.key}: staged {len(halls)} meeting halls, must be "
                f"exactly 1 — the parley venue is a contract, not a flavour "
                f"knob. Lots: {len(town.lots)}, dropped: {len(dropped)}")
    return staged


class _NullProbe:
    """Answers "yes, buildable" to everything. See `stage_town`'s `probe`."""

    def buildable(self, x, z, max_slope) -> bool:                # noqa: D102
        return True

    def height(self, x, z) -> float:                             # noqa: D102
        return 0.0


def _stage_buildings(rnd, town, site, facts, options, placements, dropped):
    """Every lot, scarce roles first, each building fronting its own street.

    ORDER IS THE WHOLE DESIGN HERE. Lots are visited in ROLE_ORDER, which is
    the order the planner assigned the roles in, so the meeting hall picks its
    ground before the market and the market before the dwellings. Within a role
    lots go by key, which is carve order, which is stable.

    Doing it the other way round — one pass over lots in key order — was the
    first cut and it was visibly wrong on a plaza: a dwelling carved early took
    a corner the hall then had to relax off its own parcel to avoid, and the
    town's one landmark ended up askew to the square it was supposed to face.
    """
    by_role: dict[str, list] = {}
    for lot in sorted(town.lots, key=lambda l: l.key):
        by_role.setdefault(lot.role, []).append(lot)

    used: list[str] = []
    consumed: list[str] = []          # lot keys a re-sited role took over
    for role in ROLE_ORDER:
        if role not in options:
            for lot in by_role.get(role, ()):
                dropped.append((lot.key, role, "no def available for this role"))
            continue
        tier = LOT_ROLES[role].get("tier", "common")
        distinct = LOT_ROLES[role].get("distinct", False)
        unique = LOT_ROLES[role].get("unique", False)
        for lot in by_role.get(role, ()):
            if lot.key in consumed:
                continue
            order = _weighted_defs(rnd, options[role], used if distinct else [])
            spot = None
            for defname in order:
                spot = _place_building(site, lot, defname, facts)
                if spot:
                    break
            if not spot and unique:
                # THE MEETING HALL MAY LEAVE ITS OWN PARCEL. Every other role
                # takes the drop, because a town with one fewer dwelling is
                # still a town; a town with no parley venue is a broken
                # contract the scenario layer cannot work around (T4 points
                # objectives at it), and `stage_town` would refuse the whole
                # town rather than ship it.
                #
                # Measured before it existed: swept over 134 towns, EIGHT lost
                # their hall this way and were rejected outright. The hall is
                # the biggest building in the roster and the planner gives it
                # the best-scoring parcel, which on a plaza or a bent main
                # street is routinely also the most awkward shape.
                #
                # Fallback order is the planner's own ranking, re-used rather
                # than re-derived: nearest the centre first, so a re-sited hall
                # stays a central building. The parcel it takes is consumed, so
                # its original owner is skipped rather than double-booked.
                fallback = sorted(
                    (l for l in town.lots
                     if l.key != lot.key and l.key not in consumed),
                    key=lambda l: (l.dist_to_centre, l.key))
                for alt in fallback:
                    for defname in order:
                        spot = _place_building(site, alt, defname, facts)
                        if spot:
                            break
                    if spot:
                        dropped.append((
                            lot.key, role,
                            f"re-sited to {alt.key}: the planner's first "
                            f"choice of parcel could not hold "
                            f"{order[0]}, and this role is unique"))
                        consumed.append(alt.key)
                        lot = alt
                        break
            if not spot:
                dropped.append((
                    lot.key, role,
                    f"no def in {', '.join(order)} fits: the parcel is "
                    f"{lot.width}x{lot.depth} and every candidate overlapped a "
                    f"neighbour, a carriageway or unbuildable ground"))
                continue
            x, z, hx, hz, fit = spot
            p = Placement(
                key=f"bld_{len(placements):03d}", channel="unit",
                category="building", role=role, tier=tier, defname=defname,
                x=int(round(x)), z=int(round(z)), facing=lot.facing,
                half_x=hx, half_z=hz, lot=lot.key, street=lot.street, fit=fit)
            # A backstop, not a filter. `_place_building.try_at` already tests
            # the integral box on every rung, so this can no longer fire —
            # which is the point of asserting it. It used to be the filter, and
            # as a filter it silently converted a near-miss into a dropped lot
            # AFTER the unique role's fallback had already been skipped past.
            assert site.accepts(p.x, p.z, hx, hz), (
                f"{p.defname} at ({p.x},{p.z}) cleared during placement but "
                f"not on re-test — a rung is not rounding before it tests")
            placements.append(p)
            site.add(p)
            used.append(defname)


def _wall_facing(town, x: float, z: float, heading: float) -> str:
    """The cardinal a wall piece at (x, z) lying along `heading` should take.

    A wall piece lies ALONG the line, so the def's FRONTAGE has to run that way
    — which means it faces ACROSS the line, outward. `_extent_of`'s invariant
    (footprintx is frontage under every cardinal, footprintz is depth) is what
    makes that a choice of facing rather than a choice of extents. Outward is
    decided from the town centre, which is exact for a convex line.
    """
    out = heading + math.pi / 2.0
    if math.cos(out) * (x - town.x) + math.sin(out) * (z - town.z) < 0:
        out += math.pi
    return tp._facing_of(out)


def _stamp_pitch(hx: float, hz: float, heading: float) -> float:
    """Least distance ALONG `heading` at which two of these boxes clear.

    THE T2 FINDING, ONE LEVEL UP, AND IT IS WHY A WALL IS NOT A ROW OF UNITS
    SPACED BY ITS OWN WIDTH. `Spring.CreateUnit` takes a facing, so the ground a
    wall segment blocks is an AXIS-ALIGNED rectangle (Unit.cpp:224-225) — but
    the line it is tiling runs at whatever angle the town's boundary runs at.
    Two axis-aligned boxes stepped `2*hx` apart along a line at 8 degrees
    advance only `2*hx*cos(8) = 0.99 * 2*hx` in x and `0.14 * 2*hx` in z, so
    they overlap in BOTH axes and the second one is refused. Measured: a
    96x16-elmo segment chain lost 101 of its pieces to exactly this.

    Two axis-aligned boxes clear if they are separated on EITHER axis, so the
    pitch is the smaller of the two distances that achieve it. At 0 degrees that
    is `2*hx` (edge to edge, the obvious answer); at 8 degrees it is `2*hx/cos`,
    barely more; near 45 degrees the `2*hz/sin` term takes over and the chain
    packs much tighter than its own width, which is correct — a diagonal chain
    of axis-aligned boxes really does interleave.

    `WALL_STAMP_SLACK` is not a fudge for the algebra, which is exact: it is
    because the stamps are then ROUNDED to integral elmos. At the exact pitch
    the two boxes touch, `_rects_overlap` calls touching clear — and a stamp
    that rounds half an elmo the wrong way closes the contact into an overlap.
    Two elmos is one whole elmo of rounding at each end.
    """
    c, s = abs(math.cos(heading)), abs(math.sin(heading))
    by_x = (2.0 * hx) / c if c > 1e-6 else float("inf")
    by_z = (2.0 * hz) / s if s > 1e-6 else float("inf")
    return min(by_x, by_z) + WALL_STAMP_SLACK


def _stage_perimeter(rnd, town, site, facts, placements, gaps, dropped):
    """The town's defenses: the wall line, then the towers and guns behind it.

    Runs AFTER the buildings and before the dressing, and the order is a
    priority: a town is its buildings, and where the two want the same ground
    the wall is the one that gives it up. It should almost never come to that —
    the line stands `PERIMETER["margin"]` outside the outermost lot corner and
    `town_planner.validate_perimeter` proves no piece is built through a lot —
    but a building relaxed off its own parcel onto the `inset` rung of
    `_place_building`'s ladder can reach past the lot the line was measured
    against, and when it does the house wins and the loss is reported.

    THE ARC IS THE PLANNER'S, THE TILING IS THIS MODULE'S.
    `town_planner` divides the line into pieces of `PERIMETER["span"]` and says
    what each one is — wall, the corner at a vertex, the post beside a gateway,
    the anchor where the ground gives out. It cannot say how many UNITS that
    takes, because that is a fact about a def, and the planner may not read one.
    So a piece is an ARC to be covered here, and this module lays as many copies
    of the kit along it as the def's own frontage needs. A kit half the width of
    a span gets two; a kit wider than its arc gets one and overflows, which is
    reported rather than papered over.

    Structural pieces are laid before plain wall, because their positions are
    the ones that mean something: a corner post belongs at the vertex and a gate
    post beside the gateway, while a stretch of wall only has to be continuous.
    When an oversized kit makes the two fight, the wall is what shuffles.

    WHAT THIS STAGES TODAY, AND WHAT IT DOES NOT.
    `resolve_perimeter` filters to shipped content, and in this clone the line
    parts resolve to nothing while `tower` and `gun` resolve to real
    staticdefense — see `town_templates.PERIMETER`'s header for why a stockade
    gets no stand-in rather than a stand-in made of gun turrets. So a fortified
    town stages its towers and its gate guns today and its wall the day M2
    lands, from the same graph, with no change here.
    """
    if not town.perimeter and not town.emplacements:
        return
    mapping = resolve_perimeter(facts)
    present = {w.part for w in list(town.perimeter) + list(town.emplacements)}
    missing = [p for p in LINE_PARTS + EMPLACEMENT_PARTS
               if p in present and p not in mapping]
    if missing:
        gaps.append(
            "perimeter parts with no content: " + ", ".join(missing)
            + " — the `" + PERIMETER["defs"][missing[0]][0] + "` kit is not in "
            "this game and has no honest stand-in; see town_templates.PERIMETER")

    def emit(part, x, z, facing, hx, hz, defname, street, category):
        p = Placement(
            key=f"{'def' if category == 'defense' else 'wal'}_"
                f"{len([q for q in placements if q.category == category]):03d}",
            channel="unit", category=category, role=part,
            tier="uncommon" if category == "defense" else "common",
            defname=defname, x=int(round(x)), z=int(round(z)), facing=facing,
            half_x=hx, half_z=hz, street=street)
        placements.append(p)
        site.add(p)

    # -- the line ---------------------------------------------------------
    if town.wall_line and "wall" in mapping:
        ring = tp._Ring(town.wall_line)
        order = sorted(
            town.perimeter,
            key=lambda w: (w.part == "wall", LINE_PARTS.index(w.part), w.s))
        for w in order:
            defname = mapping.get(w.part)
            if not defname:
                continue
            f = facts[defname]
            covered = _tile_arc(town, site, ring, w, defname, f, emit)
            if covered < w.span * 0.75:
                dropped.append((
                    w.key, w.part,
                    f"{defname} covered {int(covered)} of the {w.span} elmos "
                    f"of line this piece owns at ({w.x},{w.z}) — the rest "
                    f"overlapped something already staged, a carriageway, or "
                    f"ground the kit cannot stand on"))
        defname = mapping["wall"]
        wide = facts[defname].footprint_x * SQUARE_ELMOS
        if wide > PERIMETER["span"]:
            # ACTIONABLE, not decorative: the tiling above lays one stamp when
            # the kit will not fit twice, and a kit wider than the arc it was
            # given overflows into its neighbours, which then shuffle or go
            # short. The fix is one number in `town_templates` the day the kit's
            # real footprint is readable, so the number is named here.
            gaps.append(
                f"wall fit: {defname} is {int(wide)} elmos across and "
                f"`PERIMETER['span']` cuts the line into {PERIMETER['span']}-"
                f"elmo pieces — raise the span to at least the kit's width or "
                f"the wall will keep overlapping itself at every join")

    # -- the emplacements behind it ---------------------------------------
    for w in town.emplacements:
        defname = mapping.get(w.part)
        if not defname:
            continue
        f = facts[defname]
        # A short ladder along the inward normal, and it is not optional: the
        # planner sites an emplacement at a fixed inset from a line whose
        # THICKNESS it assumed, and the kit that actually stages there can be
        # four times as wide (an `ms_barricade_set` of 6x1 blocks 96 elmos, not
        # the nominal 24). Without the ladder a fortified town lost 41 of its 88
        # watchtowers to its own wall. Inward first, because the room is inside.
        # A TOWER AND A GUN NUDGE IN DIFFERENT DIRECTIONS, because they are
        # refused by different things.
        #
        # A tower is refused by the WALL in front of it or the HOUSE behind it,
        # and the room is along the line's normal — alternating, because those
        # two are opposite ways and a ladder that only went one way fixed one of
        # them and made the other worse.
        #
        # A gun is refused by the ROAD it is covering, and the normal is very
        # nearly the road's own direction: measured, a gun beside a gateway was
        # refused at all six rungs because every rung walked it further up and
        # down the carriageway it was standing in. Across the street is the only
        # direction that helps, and `WallPiece.heading` for a gun is the
        # street's heading precisely so this can be that.
        if w.part == "gun":
            nx, nz = -math.sin(w.heading), math.cos(w.heading)
            rungs = (0.0, 40.0, -40.0, 80.0, -80.0, 120.0, -120.0)
        else:
            nx, nz = _inward(town, w.x, w.z)
            rungs = (0.0, 32.0, -32.0, 64.0, -64.0, 96.0)
        placed = False
        for d in rungs:
            x, z = w.x + nx * d, w.z + nz * d
            facing = _wall_facing(town, x, z, w.heading)
            hx, hz = _extent_of(facing, f.footprint_x, f.footprint_z)
            if site.accepts(round(x), round(z), hx, hz):
                emit(w.part, round(x), round(z), facing, hx, hz, defname,
                     w.street, "defense")
                placed = True
                break
        if not placed:
            dropped.append((w.key, w.part,
                            f"{defname} does not fit at ({w.x},{w.z}) or "
                            f"anywhere on the line's normal through it: it "
                            f"overlaps something already staged, a "
                            f"carriageway, or ground it cannot stand on"))


def _inward(town, x: float, z: float) -> tuple[float, float]:
    """Unit vector from (x, z) towards the town centre. Exact for a convex line."""
    dx, dz = town.x - x, town.z - z
    m = math.hypot(dx, dz) or 1.0
    return (dx / m, dz / m)


def _tile_arc(town, site, ring, w, defname, f, emit) -> float:
    """Lay as many copies of `defname` along one piece's arc as it takes.

    Returns how many elmos of the arc were actually covered, so the caller can
    say a piece went down short rather than reporting a wall as complete.

    Each stamp gets a short slide ladder along the line before it is given up.
    A wall that shuffles ten elmos along its own boundary is invisible; a wall
    with a stamp missing is a hole someone can walk through, and the two are not
    close in cost. The slide is the same idea as `_place_building`'s `shifted`
    rung, for the same reason: keep the thing on the line it belongs to.
    """
    a = w.s - w.span / 2.0
    facing = _wall_facing(town, w.x, w.z, w.heading)
    hx, hz = _extent_of(facing, f.footprint_x, f.footprint_z)
    # ONLY `wall` TILES. A corner, a gate post and a cliff anchor are POSTS —
    # one thing, at one place that means something. Tiling them was measured and
    # it was wrong twice over: the pitch is computed from the piece's bisector
    # heading while the stamps are laid across a bend where the real heading
    # differs by the corner angle, so they collided; and 98 of 212 corners were
    # then reported short. A corner is not 80 elmos of wall, it is the post at
    # the vertex.
    n = 1
    if w.part == "wall":
        n = max(1, int(w.span // _stamp_pitch(hx, hz, w.heading)))
    step = w.span / n
    covered = 0.0
    for j in range(n):
        s = a + (j + 0.5) * step
        for slide in (0.0, step * 0.18, -step * 0.18, step * 0.36, -step * 0.36):
            # A single stamp keeps the piece's OWN heading, which for a corner
            # is the bisector `town_planner` computed at the vertex and not
            # either edge's direction; only a piece that takes several stamps
            # reads the line locally, because only then does it span enough of
            # it for the local direction to be the truer one.
            if n == 1 and slide == 0.0:
                x, z, h = float(w.x), float(w.z), w.heading
            else:
                x, z, h = ring.at(s + slide)
            fac = _wall_facing(town, x, z, h)
            ex, ez = _extent_of(fac, f.footprint_x, f.footprint_z)
            if site.accepts(round(x), round(z), ex, ez,
                            gap=WALL_GAP, slope=site.rules.max_street_slope):
                emit(w.part, round(x), round(z), fac, ex, ez, defname,
                     w.street, "wall")
                covered += step
                break
    return covered


def _stage_props(rnd, town, site, facts, placements, gaps):
    """Street-edge clutter, for the decoration kinds that have content.

    The planner already decided WHERE the street edge has room and how often
    (`DECOR`); this decides what, and mostly the answer is nothing — see
    `town_templates.PROPS` for the honest state of that table. `PROPS["odds"]`
    thins what is left, because the one def that does resolve is a supply dump
    and a dump at every slot the planner offered would read as a depot with a
    town attached.
    """
    mapping = resolve_props(facts)
    missing = [k for k in DECOR["kinds"] if k not in mapping]
    if missing:
        gaps.append("decor kinds with no content: " + ", ".join(missing)
                    + " — no crate, drum, tarp or cart exists in this game; "
                      "see town_templates.PROPS")
    if not mapping:
        return
    for slot in town.decor:
        defname = mapping.get(slot.kind)
        if not defname:
            continue
        if rnd.random() > PROPS["odds"]:
            continue
        f = facts[defname]
        facing = tp._facing_of(slot.heading)
        hx, hz = _extent_of(facing, f.footprint_x, f.footprint_z)
        if not site.accepts(slot.x, slot.z, hx, hz):
            continue
        p = Placement(
            key=f"prp_{len([q for q in placements if q.category == 'prop']):03d}",
            channel="unit", category="prop", role=slot.kind, tier="common",
            defname=defname, x=slot.x, z=slot.z, facing=facing,
            half_x=hx, half_z=hz, street=slot.street)
        placements.append(p)
        site.add(p)


def _stage_landmarks(rnd, town, site, features, placements, gaps):
    """The occasional unique decoration — a wreck in a yard, a relic at the edge.

    Low probability by design: `LANDMARK_ODDS` decides whether this town gets
    ANY, and only then how many. A surprise in every town is a fixture, and a
    player who has seen three towns should not yet know that towns come with a
    wreck.
    """
    roster = resolve_landmarks(features)
    if not roster:
        if features:
            gaps.append("landmarks: no feature in the roster is available")
        else:
            gaps.append("landmarks: no feature roster supplied — the M3 "
                        "featuredefs are not readable from this clone, so "
                        "towns stage without unique decorations")
        return
    if rnd.random() >= LANDMARK_ODDS:
        return
    want = 1 + (1 if rnd.random() < 0.3 else 0)
    want = min(want, LANDMARK_MAX)

    for _ in range(want):
        row = tp._pick_weighted(rnd, [(r, r["weight"]) for r in roster])[0]
        hx = row["metres"][0] * METRES_TO_ELMOS / 2.0
        hz = row["metres"][1] * METRES_TO_ELMOS / 2.0
        spot = (_yard_spot(rnd, town, site, placements, hx, hz)
                if row["where"] == "yard"
                else _edge_spot(rnd, town, site, hx, hz))
        if not spot:
            continue
        x, z = spot
        p = Placement(
            key=f"lmk_{len([q for q in placements if q.category == 'landmark']):03d}",
            channel="feature", category="landmark", role=row["where"],
            tier="unique", defname=row["def"], x=int(round(x)), z=int(round(z)),
            facing=FACING_ORDER[tp._pick_int(rnd, 0, 3)],
            half_x=hx, half_z=hz)
        placements.append(p)
        site.add(p)


def _yard_spot(rnd, town, site, placements, hx, hz):
    """Behind somebody's building, inside their parcel. Ordered by seed.

    Only lots that actually got a building are candidates — the yard is defined
    as the part of the parcel the building did not use, so a parcel with no
    building has no yard, it has a gap.
    """
    lots = {l.key: l for l in town.lots}
    built = [p for p in placements if p.category == "building" and p.lot]
    order = sorted(built, key=lambda p: p.key)
    if not order:
        return None
    start = tp._pick_int(rnd, 0, len(order) - 1)
    for i in range(len(order)):
        p = order[(start + i) % len(order)]
        lot = lots.get(p.lot)
        if lot is None:
            continue
        _along, away = _lot_frame(lot)
        # Walk out from the building's back face towards the parcel's back
        # edge, stopping at the first clear stand. Small steps: a yard is not
        # big and the difference between "behind the house" and "in the next
        # street" is about forty elmos.
        base = math.hypot(p.half_x, p.half_z) + math.hypot(hx, hz) * 0.5
        for step in range(0, 4):
            d = base + step * 26.0
            x, z = p.x + away[0] * d, p.z + away[1] * d
            if math.hypot(x - town.x, z - town.z) > town.radius * 1.1:
                break
            if site.accepts(x, z, hx, hz):
                return (x, z)
    return None


def _edge_spot(rnd, town, site, hx, hz):
    """Outside the built-up ground, inside the town's hull. On the outskirts.

    Ring sampling rather than hull-vertex sampling: a hull vertex is by
    definition the most extreme lot corner in some direction, so putting relics
    there lines them up with the buildings that made the hull. A ring finds the
    space BETWEEN the outermost lots and the town boundary, which is where an
    outskirts thing belongs.
    """
    if not town.lots:
        return None
    inner = max(math.hypot(l.x - town.x, l.z - town.z) for l in town.lots)
    lo = inner + 90.0
    hi = max(lo + 40.0, town.radius * 1.02)
    hull = list(town.hull)
    for _ in range(28):
        ang = rnd.random() * math.tau
        rad = lo + rnd.random() * (hi - lo)
        x = town.x + math.cos(ang) * rad
        z = town.z + math.sin(ang) * rad
        if hull and not tp._point_in_polygon(x, z, hull):
            continue
        if site.accepts(x, z, hx, hz):
            return (x, z)
    return None


# ==========================================================================
# The placement validity spec
# ==========================================================================

def validate_staging(staged: StagedTown, town, probe=None,
                     rules=None) -> list[str]:
    """Every way a staged town can be wrong, as a list of prose problems.

    Returned rather than raised so a sweep over a hundred towns can report all
    of them, and so the CLI's `--check` can print a census instead of stopping
    at the first. An empty list is the spec passing.

    The five checks are the five promises this module makes:
      1. no two things block the same ground
      2. nothing stands on a carriageway
      3. everything stands on ground the planner would call buildable
      4. everything can be reached on foot from a street
      5. a walled town's gateways are open — you can walk OUT of it

    5 is T3's, and it is not implied by 4. The wall is the first thing this
    module stages that is deliberately a barrier, and a ring of barriers whose
    every gateway happened to be plugged would satisfy 4 perfectly: every
    building inside is reachable from the streets inside, and the town is
    sealed. So the gateways are probed from the outside, explicitly.
    """
    rules = rules or tp.SiteRules()
    problems: list[str] = []
    ps = list(staged.placements)

    # 1. Overlap. Every pair, on the AXIS-ALIGNED rectangles the engine will
    # actually block — see the module header for why the parcels prove nothing.
    for i, a in enumerate(ps):
        for b in ps[i + 1:]:
            if _rects_overlap(a.rect(), b.rect()):
                problems.append(
                    f"{a.key} ({a.defname} at {a.x},{a.z}) and {b.key} "
                    f"({b.defname} at {b.x},{b.z}) block overlapping ground: "
                    f"{[int(v) for v in a.rect()]} vs {[int(v) for v in b.rect()]}")

    # 2. Carriageways.
    for p in ps:
        for s in town.streets:
            total = s.length()
            d = 0.0
            hit = None
            while d <= total:
                px, pz, _h = tp.point_at(s.points, d)
                if _point_in_rect(px, pz, p.rect(s.width / 2.0)):
                    hit = (px, pz)
                    break
                d += STREET_STRIDE
            if hit:
                problems.append(
                    f"{p.key} ({p.defname} at {p.x},{p.z}) stands on "
                    f"{s.name} ({s.key}, {s.width} elmos wide) — the "
                    f"carriageway passes through ({int(hit[0])},{int(hit[1])})")
                break

    # 3. Ground.
    if probe is not None:
        for p in ps:
            bad = [(px, pz) for px, pz in
                   ((p.x - p.half_x, p.z - p.half_z), (p.x + p.half_x, p.z - p.half_z),
                    (p.x + p.half_x, p.z + p.half_z), (p.x - p.half_x, p.z + p.half_z))
                   if not probe.buildable(px, pz, rules.max_lot_slope)]
            if bad:
                problems.append(
                    f"{p.key} ({p.defname} at {p.x},{p.z}) has {len(bad)} "
                    f"corner(s) on ground steeper than "
                    f"{rules.max_lot_slope:.0f} degrees, under water or off the "
                    f"map — first at ({int(bad[0][0])},{int(bad[0][1])})")

    # 4 and 5. Reachability, and the way out through the gateways.
    problems.extend(_unreachable(staged, town, _gateway_probes(town)))
    return problems


def _gateway_probes(town) -> list[tuple[float, float, str]]:
    """A stand just OUTSIDE each gateway, which must be walkable from inside.

    Pushed along the LINE'S OWN OUTWARD NORMAL at the gap, not radially out
    from the town centre. For a convex line the two agree on which SIDE is
    outside, which is why the radial push was written first — but they do not
    agree on the DIRECTION, and the gap between them is a false alarm rather
    than a rounding error. Where the boundary runs oblique to the radius (the
    common case anywhere but the middle of an edge), a radial push travels
    partly ALONG the wall as well as across it, and lands the stand beside the
    neighbouring wall segment instead of in the open ground the gate opens
    onto. Measured on valley/grid_quarter seed 8: the gap_000 stand came to
    rest 2 elmos off `wal_006`'s footprint and inside its reach padding, and
    this spec reported a gateway "built over" that a player could walk through
    perfectly well. The normal crosses the line squarely, so what it samples is
    the ground the gate actually faces.

    An unwalled town has no gateways, so the ring lookup is never reached
    without a `wall_line` to build it from; the radial push is kept as the
    fallback for a walled town whose line went missing rather than raising.
    """
    out = []
    ring = tp._Ring(town.wall_line) if town.wall_line else None
    reach = PERIMETER["thickness"] + 3 * REACH_CELL
    for g in town.gateways():
        if ring is not None:
            # The normal at the HOLE, found by projecting the gap's own
            # midpoint back onto the ring. Not `(g.s0 + g.s1) / 2`: those two
            # are stored modulo the ring length, so a gap straddling s = 0 has
            # s1 < s0 and their mean points at the far side of the town. The
            # midpoint (g.x, g.z) was taken before that wrap and is exact.
            _dist, s = ring.project(float(g.x), float(g.z))
            _rx, _rz, heading = ring.at(s)
            ix, iz = ring.inward(g.x, g.z, heading)
            ox, oz = -ix, -iz
        else:
            dx, dz = g.x - town.x, g.z - town.z
            m = math.hypot(dx, dz) or 1.0
            ox, oz = dx / m, dz / m
        out.append((g.x + ox * reach, g.z + oz * reach,
                    f"gateway {g.key} ({g.street})"))
    return out


def _unreachable(staged: StagedTown, town, probes=()) -> list[str]:
    """Which placements no one could walk to from a street.

    A raster flood fill, not a graph walk. The failure this is looking for is
    ENCLOSURE — a building ringed by other buildings, or a row that closed
    across the only way into a yard — and enclosure is a property of the ground
    between the boxes, which is precisely what a graph over the boxes does not
    have. `REACH_CELL` is half the clearance the placer guarantees, so the alley
    the gap leaves always contains at least one cell centre.

    Only `unit` placements are barriers. A feature's blocking is a per-def
    choice (§M3 ships wrecks blocking and bridges not) and this module cannot
    read featuredefs, so treating landmarks as walls would invent a constraint;
    they are still CHECKED for reachability, because a relic no one can walk to
    is as useless as a building no one can.
    """
    ps = list(staged.placements)
    if not ps:
        return []                  # nothing staged is nothing to be walled in by
    pad = 260.0
    x0 = min(p.rect()[0] for p in ps) - pad
    z0 = min(p.rect()[1] for p in ps) - pad
    x1 = max(p.rect()[2] for p in ps) + pad
    z1 = max(p.rect()[3] for p in ps) + pad
    for s in town.streets:
        for px, pz in s.points:
            x0, z0 = min(x0, px - pad), min(z0, pz - pad)
            x1, z1 = max(x1, px + pad), max(z1, pz + pad)
    for px, pz, _label in probes:
        x0, z0 = min(x0, px - pad), min(z0, pz - pad)
        x1, z1 = max(x1, px + pad), max(z1, pz + pad)

    cols = int((x1 - x0) / REACH_CELL) + 1
    rows = int((z1 - z0) / REACH_CELL) + 1
    blocked = bytearray(cols * rows)

    def cell_of(x, z):
        return (int((x - x0) / REACH_CELL), int((z - z0) / REACH_CELL))

    for p in ps:
        if p.channel != "unit":
            continue
        r = p.rect()
        cx0, cz0 = cell_of(r[0], r[1])
        cx1, cz1 = cell_of(r[2], r[3])
        for cz in range(max(0, cz0), min(rows - 1, cz1) + 1):
            base = cz * cols
            for cx in range(max(0, cx0), min(cols - 1, cx1) + 1):
                blocked[base + cx] = 1

    seen = bytearray(cols * rows)
    stack = []
    for s in town.streets:
        total = s.length()
        d = 0.0
        while d <= total:
            px, pz, _h = tp.point_at(s.points, d)
            cx, cz = cell_of(px, pz)
            if 0 <= cx < cols and 0 <= cz < rows:
                i = cz * cols + cx
                if not blocked[i] and not seen[i]:
                    seen[i] = 1
                    stack.append(i)
            d += REACH_CELL
    if not stack:
        return ["no street cell is walkable — every carriageway sample is "
                "inside a staged footprint"]

    while stack:
        i = stack.pop()
        cz, cx = divmod(i, cols)
        for nx, nz in ((cx - 1, cz), (cx + 1, cz), (cx, cz - 1), (cx, cz + 1)):
            if 0 <= nx < cols and 0 <= nz < rows:
                j = nz * cols + nx
                if not blocked[j] and not seen[j]:
                    seen[j] = 1
                    stack.append(j)

    out = []
    for p in ps:
        r = p.rect()
        cx0, cz0 = cell_of(r[0] - REACH_CELL, r[1] - REACH_CELL)
        cx1, cz1 = cell_of(r[2] + REACH_CELL, r[3] + REACH_CELL)
        touched = False
        for cz in range(max(0, cz0), min(rows - 1, cz1) + 1):
            base = cz * cols
            for cx in range(max(0, cx0), min(cols - 1, cx1) + 1):
                if seen[base + cx]:
                    touched = True
                    break
            if touched:
                break
        if not touched:
            out.append(
                f"{p.key} ({p.defname} at {p.x},{p.z}) cannot be reached from "
                f"any street — it is walled in by other placements")

    # The way out. Same flood, asked the opposite question: a town whose
    # gateways are all plugged is internally perfect and externally sealed.
    for px, pz, label in probes:
        cx, cz = cell_of(px, pz)
        if not (0 <= cx < cols and 0 <= cz < rows):
            continue
        i = cz * cols + cx
        if blocked[i]:
            out.append(f"{label}: the stand just outside the gateway at "
                       f"({int(px)},{int(pz)}) is inside a staged footprint — "
                       f"the gateway is built over")
        elif not seen[i]:
            out.append(f"{label}: ({int(px)},{int(pz)}) is outside the wall "
                       f"and cannot be walked to from any street in town — "
                       f"the gateway is sealed")
    return out


# ==========================================================================
# CLI
# ==========================================================================

def _load_facts(game_dir: str | None):
    if not game_dir:
        return {}, "no --game-dir: staged with an EMPTY roster"
    return ms_defs.load(game_dir), None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("map_dir", nargs="?", default=None,
                    help="a processed map directory, data/maps/<id>")
    ap.add_argument("--demo", default=None,
                    help="synthetic terrain instead of a map dir "
                         "(flat/rolling/cliffs/valley/coast/lake)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--radius", type=int, default=tp.DEFAULT_RADIUS)
    ap.add_argument("--archetype", default=None, choices=tp.ARCHETYPES)
    ap.add_argument("--defense", default=None, choices=tp.DEFENSE_ORDER,
                    help="pin the defense tier instead of drawing it")
    ap.add_argument("--game-dir", default=None,
                    help="data/games/metalstorm (default: derived, or the "
                         "repo's own when --demo is used)")
    ap.add_argument("--out", default=None, help="write JSON here")
    ap.add_argument("--lua", default=None, help="write a pure Lua literal here")
    ap.add_argument("--check", action="store_true",
                    help="run the placement validity spec and report")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.abspath(os.path.join(here, "..", ".."))

    if args.demo or not args.map_dir:
        probe = tp.demo_probe(args.demo or "rolling", W=385, H=385, seed=1)
        c = (probe.W - 1) * probe.elmos / 2.0
        cx, cz = c, c
        game_dir = args.game_dir or os.path.join(repo, "data", "games",
                                                 "metalstorm")
    else:
        import scenariogen
        terrain, _mclass = scenariogen.load_terrain(
            args.map_dir, ["VEH_MEDIUM", "INFANTRY"])
        probe = tp.SiteProbe.from_terrain(terrain)
        cx = (probe.W - 1) * probe.elmos / 2.0
        cz = (probe.H - 1) * probe.elmos / 2.0
        game_dir = args.game_dir or os.path.join(repo, "data", "games",
                                                 "metalstorm")

    facts, warn = _load_facts(game_dir)
    if warn and not args.quiet:
        print(warn, file=sys.stderr)

    try:
        town = tp.plan_town(args.seed, probe, cx, cz, args.radius,
                            archetype=args.archetype, defense=args.defense,
                            search=args.radius)
    except tp.SiteRejected as e:
        print(f"no town: {e}", file=sys.stderr)
        return 2
    try:
        staged = stage_town(town, facts, probe=probe)
    except StagingRejected as e:
        print(f"not staged: {e}", file=sys.stderr)
        return 3

    if args.out:
        with open(args.out, "w") as fh:
            fh.write(staged.to_json())
    if args.lua:
        with open(args.lua, "w") as fh:
            fh.write(staged.to_lua())
    if not args.out and not args.lua and not args.check:
        print(staged.to_json())

    if not args.quiet:
        print(f"{staged.name} ({staged.key}) — {staged.archetype}, "
              f"{town.defense_label}, {len(town.lots)} lots", file=sys.stderr)
        print(f"  staged {len(staged.units())} units, "
              f"{len(staged.features())} features, "
              f"dropped {len(staged.dropped)}", file=sys.stderr)
        if town.walled:
            print(f"  wall: {len(staged.of_category('wall'))} unit(s) on "
                  f"{len(town.perimeter)} planned piece(s), "
                  f"{len(staged.of_category('defense'))} emplacement(s), "
                  f"{len(town.gateways())} gateway(s)", file=sys.stderr)
        for name, n in staged.def_counts():
            print(f"    {n:3d}  {name}", file=sys.stderr)
        for g in staged.gaps:
            print(f"  gap: {g}", file=sys.stderr)

    if args.check:
        problems = (tp.validate_perimeter(town, probe)
                    + validate_staging(staged, town, probe))
        if problems:
            print(f"PLACEMENT SPEC FAILED ({len(problems)}):", file=sys.stderr)
            for p in problems:
                print(f"  {p}", file=sys.stderr)
            return 1
        print("placement + perimeter specs: OK", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
