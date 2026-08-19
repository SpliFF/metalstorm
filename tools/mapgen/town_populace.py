#!/usr/bin/env python3
"""town_populace.py — the people, and the traffic, in a staged town.

`town_planner.py` draws the streets, `town_stager.py` puts buildings in the
lots, and this module puts somebody on the pavement. It is the last of the four
and the only one whose entire roster ships today: `ms_civilians`, `ms_militia`,
`ms_civtruck` and `ms_civbus` are all in `data/games/metalstorm/units/`, so a
populated town is visible in the client now, with nothing waiting on
model-integration.

    populate_town(town, staged, facts) -> Populace
    validate_populace(pop, town, staged, probe) -> [problems]

A `Populace` is emitted on a DIFFERENT WIRE from the buildings, and that is not
a detail. `StagedTown.scenario_units()` produces `units` entries, which
`game_scenario.lua` spawns and then leaves alone; a `Populace` produces
`civilians.units` entries, which route through `GG.Civilians.Spawn` and land in
the civilian REGISTRY — the source of truth `civilians/routines.lua` wanders,
`civilians/estate.lua` counts as a district's population, and
`game_scenario.lua`'s `populateCiviliansInArea` resolves protect/escort
objectives against. A town's buildings must NOT go down that wire (the registry
would enroll immobile structures in a per-tick CMD_MOVE they can never satisfy —
scenariogen's own emit comment says so), and a town's people must not go down
the other one (they would be scenery the objective layer cannot see). Two lists,
two wires, on purpose.

THE FINDING THIS MODULE IS BUILT AROUND: A STREET TOWN CANNOT PASS THE SCATTER
GENERATOR'S OWN CLEARANCE GATE, AND THE GATE IS WRONG, NOT THE TOWN.
`scenariogen.gate_no_unit_in_a_footprint` asks whether a spawn point is at least
`UnitFacts.clear_radius` from a building's CENTRE — a circle of the footprint's
half-DIAGONAL plus 40 elmos, applied at every angle. That is the right test for
`place_cluster`, which scatters buildings on rings and knows nothing about which
way any of them faces. It is not a test a town can pass:

    ms_habitat is 12x12 squares = 192 elmos across, half-diagonal 135.8,
    so clear_radius = 175.8.
    A `grid_quarter` lot is 190 deep with a 34-elmo setback and a 56-elmo
    lane, so from a habitat's centre the carriageway EDGE is 130 elmos away
    and its CENTRELINE is 158.

Every point on the street outside that house is inside the circle, and the whole
of "civilians in streets" is therefore refused — while the house's actual
blocked yardmap ends 96 elmos out and the road is 34 elmos clear of it. So this
module grades against the RECTANGLE, which `town_stager` already computes and
which is exact, and `scenariogen` runs the town's civilians through a rect gate
of their own rather than through the circle. The circle still guards everything
`place_cluster` places, unchanged.

...WHICH IS ALSO WHY THERE IS A LADDER AND NOT AN OFFSET. T2's finding one level
up is that a lot is rotated and a building is not, so on a diagonal street the
frontage LINE itself lies inside the building's axis-aligned rectangle — at 45
degrees a 192-elmo building reaches 40 elmos past each corner of its own
210-elmo parcel. There is no fixed "stand this far in front of the door" that
works on every street angle. Every siting rule below is therefore a ladder that
walks outward, or along, until the point clears the real rectangles, and reports
by name when it never does.

DETERMINISM. Same town, same staging, same seed => byte-identical output.
One `random.Random` threaded explicitly; only `rnd.random()` as the entropy
primitive; nothing that reaches output iterates a dict or a set; every
collection derived from one is explicitly sorted. Same rules as
`scenariogen.py`'s, for the same reason.

The rng is seeded off `town.seed` through `POPULACE_SALT` rather than shared
with the stager's: a populace drawn from the stager's own stream would shift
every building in town the day a fourth populace kind is added, and T2's and
T3's measured placements would all move for a reason unrelated to them.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ms_defs                                             # noqa: E402
import town_planner as tp                                  # noqa: E402
import town_stager as ts                                   # noqa: E402
from town_templates import (MAX_POPULACE, POPULACE, POPULACE_ORDER,   # noqa: E402
                            STREET_ARCHETYPES, populace_options)

POPULACE_VERSION = 1

# Mixed into the town's seed so this module's draws are independent of the
# stager's. Arbitrary, fixed forever: changing it re-rolls every populated town
# in every generated scenario.
POPULACE_SALT = 0x70_9C_1A_5E

# Elmos of daylight between a civilian's own footprint box and any building,
# wall piece or emplacement. Small on purpose — this is a pedestrian standing
# beside a wall, not a structure needing a build square — but not zero: the
# engine refuses a unit whose ground is occupied and says so only by returning
# nil (`game_scenario.lua` stageUnits' `skipped` list).
CIVILIAN_GAP = 12

# ...and between two civilians. Mirrors `scenariogen.UNIT_SPAWN_GAP` exactly,
# because `gate_no_two_units_share_a_spot` is applied to these points alongside
# the armies' and a looser value here would only be caught there, as a hard
# rejection of the whole scenario.
UNIT_SPAWN_GAP = 16

# How far out from the frontage line the shoulder ladder is allowed to walk,
# as a fraction of (setback + half the carriageway). 1.0 is the centreline of
# the road; a pedestrian standing there is legitimate ("civilians in streets")
# and is the last rung rather than the first.
FRONTAGE_RUNGS = (0.0, 0.34, 0.68, 1.0)

# ...and how far along the frontage it may slide, as a fraction of the lot's
# half-width. Signed pairs so a group displaced by its neighbour goes to
# whichever side is free, and in a fixed order so the choice is not rng.
ALONG_RUNGS = (0.0, 0.34, -0.34, 0.62, -0.62)

# The yard ladder: fractions of the lot's half-depth measured back from the
# rear boundary, i.e. rung 0 is against the back fence and the last rung is the
# lot centre (where the building is, and where the ladder therefore fails).
YARD_RUNGS = (0.06, 0.22, 0.38, 0.54)

# A gateway militiaman stands this far inside the line, laddered.
GATEWAY_INSETS = (90.0, 140.0, 190.0, 240.0)
GATEWAY_SIDESTEPS = (0.0, 0.32, -0.32)

# Where along a through-street a vehicle stands, as a fraction of its length.
# Never 0.0 or 1.0: a street's ends are where its last lots are and where a
# gateway is cut, both of which are already crowded.
TRAFFIC_RUNGS = (0.38, 0.62, 0.24, 0.76, 0.5)


class PopulaceRejected(Exception):
    """The town cannot be populated at all. Not raised for a single kind."""


# ==========================================================================
# One civilian
# ==========================================================================

@dataclass
class Resident:
    """One civilian entry, and the ground it needs.

    `registry_role` is `GG.Civilians.Register`'s role and NOT this module's
    `kind`: five kinds resolve to two roles, because the registry's vocabulary
    is about what the gadgets do with a unit (wander it, count it as a
    district's population, resolve an objective against it) and `kind` is about
    what it reads as in the town.
    """
    key: str
    kind: str                  # town_templates.POPULACE_ORDER
    defname: str
    x: int
    z: int
    facing: str
    registry_role: str         # ambient | garrison
    half_x: float
    half_z: float
    body_radius: float
    lot: str | None = None
    street: str | None = None
    spot: str = ""             # which siting rule found the ground
    rung: int = 0              # which rung of that rule's ladder placed it

    def rect(self, pad: float = 0.0):
        return (self.x - self.half_x - pad, self.z - self.half_z - pad,
                self.x + self.half_x + pad, self.z + self.half_z + pad)

    def to_dict(self) -> dict:
        r = self.rect()
        return {"key": self.key, "kind": self.kind, "def": self.defname,
                "x": self.x, "z": self.z, "facing": self.facing,
                "role": self.registry_role, "lot": self.lot,
                "street": self.street, "spot": self.spot, "rung": self.rung,
                "rect": [int(math.floor(r[0])), int(math.floor(r[1])),
                         int(math.ceil(r[2])), int(math.ceil(r[3]))]}


@dataclass
class Populace:
    """A town's people, plus every kind it could not seat and why.

    `gaps` and `dropped` are first-class output on the same principle as
    `StagedTown`'s: a town with no militia because it has no wall and a town
    with no militia because every gateway was blocked are different facts, and
    a populace reporting neither reads as complete.
    """
    town: str
    seed: int
    residents: tuple = ()
    dropped: tuple = ()        # (what, kind, why)
    gaps: tuple = ()
    populace_version: int = POPULACE_VERSION

    def of_kind(self, kind: str) -> list:
        return [r for r in self.residents if r.kind == kind]

    def kind_counts(self) -> list[tuple[str, int]]:
        return [(k, len(self.of_kind(k))) for k in POPULACE_ORDER]

    def def_counts(self) -> list[tuple[str, int]]:
        names = sorted({r.defname for r in self.residents})
        pairs = [(n, sum(1 for r in self.residents if r.defname == n))
                 for n in names]
        return sorted(pairs, key=lambda kv: (-kv[1], kv[0]))

    def head_count(self) -> int:
        """Placements, not bodies. `ms_civilians` renders twelve to a group."""
        return len(self.residents)

    # -- emission ----------------------------------------------------------

    def scenario_civilians(self) -> list[dict]:
        """`civilians.units` entries, in `game_scenario.lua`'s own shape.

        `town` is this lane's addition to that schema and is what makes the
        estate's district machinery work at all: `estate.threatenedDistricts`
        groups the population by `info.districtId` and has, until now, always
        returned nothing because no spawn path ever set one (its own header
        says so). The loader threads this straight through to
        `GG.Civilians.Register`.
        """
        return [{"def": r.defname, "x": r.x, "z": r.z, "facing": r.facing,
                 "role": r.registry_role, "town": self.town}
                for r in self.residents]

    def to_dict(self) -> dict:
        return {
            "populace_version": self.populace_version,
            "town": self.town,
            "seed": self.seed,
            "residents": [r.to_dict() for r in self.residents],
            "dropped": [{"what": d[0], "kind": d[1], "why": d[2]}
                        for d in self.dropped],
            "gaps": list(self.gaps),
            "kind_counts": [[k, n] for k, n in self.kind_counts()],
            "def_counts": [[n, c] for n, c in self.def_counts()],
        }

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent, sort_keys=False)

    def to_lua(self) -> str:
        return "return " + tp._lua_value(self.to_dict(), 0) + "\n"


# ==========================================================================
# The ground a civilian has to fit on
# ==========================================================================

class _Ground:
    """Everything already standing, plus the terrain, plus the tests.

    Deliberately a much smaller object than `town_stager._Site`: a pedestrian
    is not a building. It does not ask `off_the_carriageway` (one whole kind
    wants the carriageway) and it grades passability rather than buildability
    (a civilian walks on ground no crane could stand on).
    """

    def __init__(self, town, staged, probe, rules=None):
        self.town, self.probe = town, probe
        self.rules = rules or tp.SiteRules()
        self.blocked = tp._Bucket(192.0)
        for p in staged.placements:
            self.blocked.add(p.x, p.z, p)
        self.people: list[Resident] = []
        self.bodies = tp._Bucket(192.0)

    # -- the three hard constraints ---------------------------------------

    def on_walkable_ground(self, x, z) -> bool:
        """Passable, dry and in bounds — at the centre and at four corners.

        `max_street_slope`, not `max_lot_slope`: this is somebody standing on
        the road the planner already routed, and re-grading it at the standard a
        BUILDING PAD has to meet would refuse civilians on exactly the streets
        the town was distorted to keep.
        """
        if self.probe is None:
            return True
        for px, pz in ((x, z), (x - 8, z - 8), (x + 8, z - 8),
                       (x + 8, z + 8), (x - 8, z + 8)):
            if not self.probe.buildable(px, pz, self.rules.max_street_slope):
                return False
        return True

    def clear_of_buildings(self, x, z, hx, hz) -> bool:
        """The RECTANGLE test, not the circle. See this module's header."""
        r = (x - hx - CIVILIAN_GAP, z - hz - CIVILIAN_GAP,
             x + hx + CIVILIAN_GAP, z + hz + CIVILIAN_GAP)
        reach = math.hypot(hx, hz) + CIVILIAN_GAP + 260.0
        for p in self.blocked.near(x, z, reach):
            if ts._rects_overlap(r, p.rect()):
                return False
        return True

    def clear_of_people(self, x, z, body: float) -> bool:
        """Combined body radii plus the gap — `gate_no_two_units_share_a_spot`.

        Circles here and rectangles above, and the difference is real: a
        building's blocked ground IS a rectangle (the engine derives it by
        swapping the footprint sizes, so it is axis-aligned whatever the facing
        — Unit.cpp:224-225), while two mobile units contend over the radius the
        pathfinder gives each of them.
        """
        reach = body + 260.0
        for other in self.bodies.near(x, z, reach):
            need = body + other.body_radius + UNIT_SPAWN_GAP
            if math.hypot(x - other.x, z - other.z) < need:
                return False
        return True

    def accepts(self, x, z, f) -> bool:
        hx, hz = _half_extents(f)
        return (self.on_walkable_ground(x, z)
                and self.clear_of_buildings(x, z, hx, hz)
                and self.clear_of_people(x, z, f.body_radius))

    def add(self, r: Resident) -> None:
        self.people.append(r)
        self.bodies.add(r.x, r.z, r)


def _half_extents(f) -> tuple[float, float]:
    """A def's own footprint half-extents in elmos.

    `xsize = footprintx * FOOTPRINT_SCALE` and a square is 8 elmos, so the
    half-width is `footprintx * FOOTPRINT_SCALE * 4` — the same arithmetic
    `scenariogen.Building.rect` and `civilians/spawn.lua`'s
    footprintClearRadius both do, spelled once.
    """
    return (f.footprint_x * ms_defs.FOOTPRINT_SCALE * 4.0,
            f.footprint_z * ms_defs.FOOTPRINT_SCALE * 4.0)


def _weighted_def(rnd, options: list[tuple[str, float]]) -> str:
    """One def from a weighted list, on `rnd.random()` alone.

    Not `rnd.choices`: the RULES OF DETERMINISM forbid any primitive whose
    consumption of the stream CPython is free to change between versions.
    """
    total = sum(w for _d, w in options)
    if total <= 0:
        return options[0][0]
    roll = rnd.random() * total
    acc = 0.0
    for name, w in options:
        acc += w
        if roll < acc:
            return name
    return options[-1][0]


# ==========================================================================
# The four siting rules
# ==========================================================================

def _street_of(town, key):
    for s in town.streets:
        if s.key == key:
            return s
    return None


def _shoulder_reach(town, lot) -> float:
    """How far past the frontage line the shoulder ladder may walk.

    The setback (frontage line to carriageway edge) plus half the carriageway,
    i.e. rung 1.0 stands on the centreline. Read off the lot's OWN street, not
    off the archetype's `lane_width`, because a main street is 88 elmos wide and
    a lane 52 and a pedestrian on the wrong one of those is 18 elmos out.
    """
    arch = STREET_ARCHETYPES[town.archetype]
    street = _street_of(town, lot.street)
    width = street.width if street is not None else arch["lane_width"]
    return arch["setback"] + width / 2.0


def _frontage_candidates(town, lot, along_rungs=ALONG_RUNGS):
    """Points on the shoulder in front of a lot, nearest the house first.

    Yields (x, z, facing, spot, rung). The facing is the lot's own — a resident
    faces the street the way the building behind them does, so a row reads as a
    row.
    """
    along, away = ts._lot_frame(lot)
    reach = _shoulder_reach(town, lot)
    base_x = lot.x - away[0] * (lot.depth / 2.0)
    base_z = lot.z - away[1] * (lot.depth / 2.0)
    for i, out in enumerate(FRONTAGE_RUNGS):
        for side in along_rungs:
            d = side * (lot.width / 2.0)
            yield (base_x - away[0] * (out * reach) + along[0] * d,
                   base_z - away[1] * (out * reach) + along[1] * d,
                   lot.facing, "shoulder", i)


def _kerb_candidates(town, lot):
    """The shoulder, but at the ENDS of the frontage — where you park.

    Same ground as `_frontage_candidates`, walked in the opposite order: the
    far ends of the frontage first and the middle (the doorway) last. A lorry
    outside the market belongs at the kerb beside it, not across its entrance.
    """
    return _frontage_candidates(
        town, lot, along_rungs=(-0.62, 0.62, -0.34, 0.34, 0.0))


def _yard_candidates(town, lot):
    """Points BEHIND the building, in the depth the frontage rule leaves over.

    `town_stager._anchor_for` puts the building's near face on the frontage
    line, so whatever depth the building does not use is all at the back.
    MEASURED: on this content there is often none of it — `LOT_ROLES`' own
    `lot_size` values are derived from the footprints they have to hold, so a
    192-elmo habitat in a 190-deep parcel leaves a yard of exactly nothing, and
    on a diagonal street the building's axis-aligned rectangle overruns the
    parcel's back boundary as well as its front. Hence the kerb fallback.
    """
    along, away = ts._lot_frame(lot)
    facing = ts.FACING_ORDER[(ts.FACING_INDEX[lot.facing] + 2) % 4]
    for i, back in enumerate(YARD_RUNGS):
        d0 = lot.depth / 2.0 - back * lot.depth
        for side in ALONG_RUNGS:
            d = side * (lot.width / 2.0)
            yield (lot.x + away[0] * d0 + along[0] * d,
                   lot.z + away[1] * d0 + along[1] * d,
                   facing, "yard", i)


def _parking_candidates(town, lot):
    """The yard if this lot has one, the kerb beside it if not."""
    yield from _yard_candidates(town, lot)
    yield from _kerb_candidates(town, lot)


def _carriageway_candidates(town, street):
    """Points ON a street's centreline, facing along it.

    The one siting rule in this toolchain that wants the carriageway. Every
    other placement — building, wall piece, emplacement, decoration slot — is
    refused there by construction, which is exactly why a vehicle standing on
    it reads as traffic rather than as clutter.
    """
    total = street.length()
    for i, frac in enumerate(TRAFFIC_RUNGS):
        x, z, heading = tp.point_at(street.points, total * frac)
        yield (x, z, tp._facing_of(heading), "carriageway", i)


def _gateway_candidates(town, gap):
    """Points inside a hole in the wall, facing OUT through it.

    Stepped in toward the town centre rather than sat in the opening: a unit
    standing in the gateway is standing on the road the gateway exists to let
    through, and `civilians/routines.lua` never moves a `garrison` civilian, so
    it would block that road for the whole match.
    """
    cx, cz = town.x, town.z
    dx, dz = cx - gap.x, cz - gap.z
    d = math.hypot(dx, dz) or 1.0
    inx, inz = dx / d, dz / d
    facing = tp._facing_of(math.atan2(-inz, -inx))
    for i, inset in enumerate(GATEWAY_INSETS):
        for side in GATEWAY_SIDESTEPS:
            off = side * max(gap.width, 120)
            yield (gap.x + inx * inset - inz * off,
                   gap.z + inz * inset + inx * off,
                   facing, "gateway", i)


# ==========================================================================
# Populating
# ==========================================================================

def populate_town(town, staged, facts, seed: int | None = None,
                  probe=None, rules=None, options=None) -> Populace:
    """Put people, guards and traffic into an already-staged town.

    `staged` is what the civilians must fit AROUND, so this runs after
    `town_stager.stage_town` and never before it. Nothing here moves a building:
    a kind that cannot find ground is dropped by name, because a town that
    quietly shoved its meeting hall aside to fit a lorry in would be a worse
    town than one with no lorry.
    """
    import random
    seed = town.seed ^ POPULACE_SALT if seed is None else seed
    rnd = random.Random(seed)
    options = populace_options(facts) if options is None else options

    ground = _Ground(town, staged, probe, rules)
    gaps: list[str] = []
    dropped: list[tuple[str, str, str]] = []

    for kind in POPULACE_ORDER:
        spec = POPULACE[kind]
        if kind not in options:
            gaps.append(f"{kind} ({spec['label']}): this game ships none of "
                        + ", ".join(d for d, _w in spec["defs"]))
            continue
        _PLACERS[spec["where"]](rnd, kind, spec, options[kind], town, staged,
                                facts, ground, dropped, gaps)

    residents = list(ground.people)
    if len(residents) > MAX_POPULACE:
        # Drawn last, dropped first. POPULACE_ORDER puts the kinds with the
        # fewest legal positions ahead of the ones that can go anywhere, so the
        # tail of this list is `residents` — the most numerous kind and the one
        # whose individual members carry the least meaning.
        for r in residents[MAX_POPULACE:]:
            dropped.append((r.key, r.kind,
                            f"over the {MAX_POPULACE}-civilian ceiling for one "
                            f"town (town_templates.MAX_POPULACE)"))
        residents = residents[:MAX_POPULACE]

    return Populace(town=town.key, seed=seed, residents=tuple(residents),
                    dropped=tuple(dropped), gaps=tuple(gaps))


def _seat(ground, rnd, key, kind, spec, options, facts, candidates,
          lot=None, street=None) -> Resident | None:
    """Walk one ladder and take the first rung that holds. None if none does."""
    defname = _weighted_def(rnd, options)
    f = facts[defname]
    hx, hz = _half_extents(f)
    for x, z, facing, spot, rung in candidates:
        ix, iz = int(round(x)), int(round(z))
        # Rounded BEFORE the test, never after. The fourth occurrence of this
        # bug class in this toolchain (T1's `_grow_lots`, T1's `_build_decor`,
        # T2's meeting hall): the emitted position is integral, so a point that
        # clears at 2731.868 and fails at 2732 is a civilian inside a wall.
        if not ground.accepts(ix, iz, f):
            continue
        r = Resident(key=key, kind=kind, defname=defname, x=ix, z=iz,
                     facing=facing, registry_role=spec["registry_role"],
                     half_x=hx, half_z=hz, body_radius=f.body_radius,
                     lot=lot, street=street, spot=spot, rung=rung)
        ground.add(r)
        return r
    return None


def _place_frontage(rnd, kind, spec, options, town, staged, facts, ground,
                    dropped, gaps):
    """Residents and market crowds, on the shoulder of the lots they belong to.

    Iterates the STAGED placements rather than the planner's lots, because a lot
    whose building was dropped has nobody living in it — a group of civilians
    standing on the pavement outside an empty parcel is the tell of a populace
    generated against the plan instead of against the town.
    """
    lots = {l.key: l for l in town.lots}
    wanted = spec["lot_roles"]
    for p in staged.of_category("building"):
        if p.role not in wanted or p.lot is None:
            continue
        lot = lots.get(p.lot)
        if lot is None:
            continue
        copies = 1
        if spec.get("extra"):
            copies += tp._pick_int(rnd, *spec["extra"])
        for n in range(copies):
            if rnd.random() > spec["odds"]:
                continue
            key = f"{kind}-{lot.key}-{n}"
            if _seat(ground, rnd, key, kind, spec, options, facts,
                     _frontage_candidates(town, lot), lot=lot.key,
                     street=lot.street) is None:
                dropped.append((key, kind,
                                f"no clear ground on {lot.key}'s frontage: "
                                f"every rung out to the carriageway centreline "
                                f"was inside a footprint or another civilian"))


def _place_parking(rnd, kind, spec, options, town, staged, facts, ground,
                   dropped, gaps):
    """Parked vehicles: in the yard of the building that owns them, or at its kerb."""
    lots = {l.key: l for l in town.lots}
    wanted = spec["lot_roles"]
    for p in staged.of_category("building"):
        if p.role not in wanted or p.lot is None:
            continue
        if rnd.random() > spec["odds"]:
            continue
        lot = lots.get(p.lot)
        if lot is None:
            continue
        key = f"{kind}-{lot.key}"
        if _seat(ground, rnd, key, kind, spec, options, facts,
                 _parking_candidates(town, lot), lot=lot.key,
                 street=lot.street) is None:
            dropped.append((key, kind,
                            f"{lot.key} has neither a yard nor a free kerb: "
                            f"the building fills the parcel and the shoulder "
                            f"either side of it is already taken"))


def _place_carriageway(rnd, kind, spec, options, town, staged, facts, ground,
                       dropped, gaps):
    """Traffic, standing on the through-streets."""
    kinds = spec["street_kinds"]
    eligible = [s for s in town.streets if s.kind in kinds]
    placed = 0
    for street in eligible:
        if placed >= spec["max"]:
            break
        if rnd.random() > spec["odds"]:
            continue
        key = f"{kind}-{street.key}"
        if _seat(ground, rnd, key, kind, spec, options, facts,
                 _carriageway_candidates(town, street),
                 street=street.key) is None:
            dropped.append((key, kind,
                            f"nowhere on {street.key} to stand a vehicle: "
                            f"every sampled point was inside a footprint that "
                            f"overhangs the carriageway"))
        else:
            placed += 1
    if not eligible:
        gaps.append(f"{kind} ({spec['label']}): this town has no "
                    + "/".join(kinds) + " street to put traffic on")


def _place_gateway(rnd, kind, spec, options, town, staged, facts, ground,
                   dropped, gaps):
    """Militia, inside the gateways of a town that built a wall."""
    if town.defense not in spec["tiers"]:
        return
    gateways = town.gateways()
    if not gateways:
        gaps.append(f"{kind} ({spec['label']}): {town.key} is "
                    f"{town.defense} but its line has no gateway to man")
        return
    for gap in gateways[:spec["max"]]:
        if rnd.random() > spec["odds"]:
            continue
        key = f"{kind}-{gap.key}"
        if _seat(ground, rnd, key, kind, spec, options, facts,
                 _gateway_candidates(town, gap), street=gap.street) is None:
            dropped.append((key, kind,
                            f"nowhere to post a guard inside {gap.key}: the "
                            f"ground behind the opening is taken or unwalkable"))


_PLACERS = {
    "frontage": _place_frontage,
    "parking": _place_parking,
    "carriageway": _place_carriageway,
    "gateway": _place_gateway,
}

assert sorted(_PLACERS) == sorted({POPULACE[k]["where"] for k in POPULACE}), (
    "every POPULACE `where` needs a placer, and every placer a user: "
    + repr(sorted(_PLACERS)))


# ==========================================================================
# The spec
# ==========================================================================

def validate_populace(pop: Populace, town, staged, probe=None,
                      rules=None) -> list[str]:
    """Problems with a populace, in prose. Empty means it is sound.

    FIVE INVARIANTS, each one a real failure mode rather than a tidiness rule:

      1. Nobody stands inside a building, a wall piece or an emplacement. The
         engine refuses the unit and reports it by returning nil from
         `Spring.CreateUnit` — no error anywhere — so the town is quietly short
         of the file that describes it.
      2. No two civilians are closer than their combined body radii. Same
         silent failure, one unit lost per collision; measured once already at
         41 elmos against a combined 45 (`scenariogen.gate_no_two_units_share_
         a_spot`).
      3. Everyone is on walkable, dry, in-bounds ground.
      4. Everyone is inside their own town — a civilian outside the hull is not
         a resident, it is a stray the objective layer will still count as this
         district's population.
      5. Every key is unique. `civilians.units` is a flat list and a duplicate
         key means two entries the debug dump cannot tell apart.

    Returned rather than raised, so a caller reports every problem at once.
    """
    rules = rules or tp.SiteRules()
    problems: list[str] = []

    blocked = tp._Bucket(192.0)
    for p in staged.placements:
        blocked.add(p.x, p.z, p)

    for r in pop.residents:
        rect = r.rect()
        reach = math.hypot(r.half_x, r.half_z) + 260.0
        for p in blocked.near(r.x, r.z, reach):
            if ts._rects_overlap(rect, p.rect()):
                problems.append(
                    f"{r.key} ({r.defname}) at ({r.x}, {r.z}) overlaps "
                    f"{p.key} ({p.defname}) — the engine would refuse it and "
                    f"say so only by returning nil")
                break

    for i, a in enumerate(pop.residents):
        for b in pop.residents[i + 1:]:
            need = a.body_radius + b.body_radius + UNIT_SPAWN_GAP
            d = math.hypot(a.x - b.x, a.z - b.z)
            if d < need:
                problems.append(
                    f"{a.key} and {b.key} are {d:.0f} elmos apart but need "
                    f"{need:.0f} — one of the two would not spawn")

    if probe is not None:
        for r in pop.residents:
            if not probe.in_bounds(r.x, r.z):
                problems.append(f"{r.key} at ({r.x}, {r.z}) is off the map")
            elif probe.submerged(r.x, r.z):
                problems.append(f"{r.key} at ({r.x}, {r.z}) is under water")
            elif not probe.passable(r.x, r.z):
                problems.append(
                    f"{r.key} at ({r.x}, {r.z}) is on ground its own movement "
                    f"class cannot cross")

    # WHICH BOUNDARY. `hull` is the LOTS' boundary and `wall_line` is the
    # simplified polygon the wall is built on, which `_simplify_hull` extends
    # OUTWARD past it — so on a walled town the two are different polygons and
    # the ground between them is real town. Found by this spec: a gateway
    # militiaman on valley/seed 1 stood inside his own wall and outside the
    # hull, and the hull test called him a stray. A walled town's extent is its
    # wall.
    boundary = list(town.wall_line) if town.wall_line else list(town.hull)
    if boundary:
        for r in pop.residents:
            if not tp._point_in_polygon(r.x, r.z, boundary):
                problems.append(
                    f"{r.key} at ({r.x}, {r.z}) is outside {town.key}'s own "
                    f"boundary — it would be counted as this district's "
                    f"population from wherever it ended up")

    seen: dict[str, int] = {}
    for r in pop.residents:
        seen[r.key] = seen.get(r.key, 0) + 1
    for key in sorted(k for k, n in seen.items() if n > 1):
        problems.append(f"duplicate civilian key {key!r} ({seen[key]} entries)")

    return problems


# ==========================================================================
# CLI — populate one town on a map dir or on synthetic terrain
# ==========================================================================

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
                    help="data/games/metalstorm (default: the repo's own)")
    ap.add_argument("--json", action="store_true",
                    help="dump the populace as JSON instead of a summary")
    ap.add_argument("--lua", action="store_true",
                    help="dump the populace as a pure Lua literal")
    ap.add_argument("--check", action="store_true",
                    help="run validate_populace and report (exit 1 on problems)")
    args = ap.parse_args(argv)

    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.abspath(os.path.join(here, "..", ".."))
    game_dir = args.game_dir or os.path.join(repo, "data", "games", "metalstorm")

    if args.demo or not args.map_dir:
        probe = tp.demo_probe(args.demo or "rolling", W=385, H=385, seed=1)
    else:
        import scenariogen
        terrain, _mclass = scenariogen.load_terrain(
            args.map_dir, ["VEH_MEDIUM", "INFANTRY"])
        probe = tp.SiteProbe.from_terrain(terrain)
    x = (probe.W - 1) * probe.elmos / 2.0
    z = (probe.H - 1) * probe.elmos / 2.0

    facts, warn = ts._load_facts(game_dir)
    if warn:
        print(warn, file=sys.stderr)

    try:
        town = tp.plan_town(args.seed, probe, x, z, radius=args.radius,
                            search=args.radius, archetype=args.archetype,
                            defense=args.defense)
    except tp.SiteRejected as e:
        print(f"REJECTED — {e}", file=sys.stderr)
        return 2

    staged = ts.stage_town(town, facts, probe=probe)
    pop = populate_town(town, staged, facts, probe=probe)

    if args.json:
        print(pop.to_json())
        return 0
    if args.lua:
        sys.stdout.write(pop.to_lua())
        return 0

    print(f"{town.key} ({town.name}) — {town.archetype}, {town.defense}, "
          f"{len(staged.of_category('building'))} building(s)")
    print(f"  {pop.head_count()} civilian placement(s):")
    for kind, n in pop.kind_counts():
        if n:
            print(f"    {kind:10s} {n}")
    for name, n in pop.def_counts():
        print(f"    {name:16s} x{n}")
    for g in pop.gaps:
        print(f"  gap: {g}")
    for what, kind, why in pop.dropped:
        print(f"  dropped {what} ({kind}): {why}")

    if args.check:
        problems = validate_populace(pop, town, staged, probe)
        if problems:
            print(f"  {len(problems)} PROBLEM(S):")
            for p in problems:
                print(f"    {p}")
            return 1
        print("  populace spec: clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
