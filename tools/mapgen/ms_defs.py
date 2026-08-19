#!/usr/bin/env python3
"""ms_defs.py — the few unit-def facts the scenario generator has to know,
read out of Metalstorm's own def files rather than copied into Python.

Why read them rather than tabulate them: all three facts here are load-bearing
for a *correctness gate*, and a stale copy silently disarms the gate rather
than failing it.

  * `footprint`  → the yardmap-clearance radius. A garrison unit spawned inside
                   a building's blocked footprint is trapped permanently
                   (GiveOrderToUnit "succeeds" and the unit never moves — see
                   the `civilians` block comment in scenarios/meridian_basin.lua).
                   Shrink `ms_habitat` in content and a hardcoded 96 would start
                   over-clearing; grow it and the trap comes back.
  * `movementclass` → which passability mask a staged roster must be verified
                   against. Grading a roster containing HEAVY units on VEH only
                   reproduces the Meridian failure one class down
                   (regions_from_map.py's module docstring).
  * `speed`      → the contestability arithmetic, which must mirror
                   game_scenario.lua's checkVictoryIsContestable exactly. That
                   function reads `UnitDefs[].speed`, which UnitDef.cpp:424-425
                   derives as `maxVelocity * GAME_SPEED` — elmos/SECOND.

Deliberately NOT a Lua interpreter, for the same reason `read_mapinfo` in
regions_from_map.py is a regex: we need a handful of scalars out of files whose
shape is fixed by a shared builder, not arbitrary evaluation. Every value this
module can fail to find raises rather than defaulting — a silent 0 footprint is
exactly the bug the module exists to prevent. `verify()` (and the test that
calls it) asserts every def the templates name actually resolved.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

GAME_SPEED = 30            # Sim frames per second (rts/Sim/Misc/GlobalConstants.h)
FOOTPRINT_SCALE = 2        # SPRING_FOOTPRINT_SCALE — UnitDef.cpp:653, xsize = footprintX * 2

# civilians/spawn.lua's SCATTER_MARGIN: extra clearance on top of the corner
# radius, covering the spawned unit's own footprint plus a pathfinding margin.
SCATTER_MARGIN = 40


@dataclass(frozen=True)
class UnitFacts:
    name: str
    footprint_x: int           # in build squares, i.e. the def's `footprintx`
    footprint_z: int
    speed: float               # elmos/sec, matching UnitDefs[].speed
    movementclass: str | None  # None for buildings and aircraft
    building: bool

    @property
    def clear_radius(self) -> float:
        """The radius that clears this building's footprint at EVERY angle.

        Mirrors civilians/spawn.lua's footprintClearRadius: a footprint is a
        rectangle, so its corner (half-diagonal) reaches farther than its edges,
        and an axis-only check still lands on a diagonal corner of the blocked
        yardmap. halfX = xsize * 4 = footprintx * FOOTPRINT_SCALE * 4.
        """
        return self.body_radius + SCATTER_MARGIN

    @property
    def body_radius(self) -> float:
        """Half-diagonal of this def's own footprint, in elmos.

        Distinct from `clear_radius` (which adds the scatter margin a *third
        party* needs to stand clear of a building): this is how much room the
        unit itself occupies. Two spawn points closer than the sum of their body
        radii are asking the engine to put two units in one place — and
        `Spring.CreateUnit` answers by returning nil for the second one, with no
        error anywhere. Measured: an ms_civilians and an ms_militia generated 41
        elmos apart against a combined body radius of 45, and exactly one of the
        two was missing from the staged war.
        """
        half_x = self.footprint_x * FOOTPRINT_SCALE * 4
        half_z = self.footprint_z * FOOTPRINT_SCALE * 4
        return (half_x * half_x + half_z * half_z) ** 0.5


def _strip_comments(text: str) -> str:
    """Drop `--` line comments so a commented-out `footprintx = 99` cannot win.

    Long-bracket comments (`--[[ ]]`) do not occur in units/*.lua; string
    literals in these files never contain `--`.
    """
    return re.sub(r"--[^\n]*", "", text)


def _num(body: str, key: str, default=None):
    m = re.search(rf"\b{key}\s*=\s*(-?[0-9.]+)", body)
    if m is None:
        return default
    v = float(m.group(1))
    return v


def _str(body: str, key: str, default=None):
    m = re.search(rf"\b{key}\s*=\s*'([^']*)'", body)
    return m.group(1) if m else default


def _split_top_level_entries(body: str) -> dict[str, str]:
    """`name = { ... },` entries of a returned table, keyed by name.

    Brace-counted rather than regexed, because every def body contains nested
    tables (`customparams`, `weapons`, `scales`).
    """
    out = {}
    for m in re.finditer(r"^\s{4}(\w+)\s*=\s*\w*\{", body, re.MULTILINE):
        name = m.group(1)
        i = body.index("{", m.start())
        depth = 0
        for j in range(i, len(body)):
            if body[j] == "{":
                depth += 1
            elif body[j] == "}":
                depth -= 1
                if depth == 0:
                    out[name] = body[i:j + 1]
                    break
    return out


def _read_buildings(path: str) -> dict[str, UnitFacts]:
    """buildings_civilian.lua / buildings_military.lua — literal footprints."""
    with open(path, encoding="utf-8") as fh:
        text = _strip_comments(fh.read())
    out = {}
    for name, body in _split_top_level_entries(text).items():
        fx, fz = _num(body, "footprintx"), _num(body, "footprintz")
        if fx is None or fz is None:
            raise ValueError(f"{path}: {name} has no footprintx/footprintz")
        out[name] = UnitFacts(name, int(fx), int(fz), 0.0, None, True)
    return out


def _braced(text: str, start: int) -> str:
    """The `{...}` block beginning at or after `start`, brace-counted."""
    i = text.index("{", start)
    depth = 0
    for j in range(i, len(text)):
        if text[j] == "{":
            depth += 1
        elif text[j] == "}":
            depth -= 1
            if depth == 0:
                return text[i:j + 1]
    raise ValueError("unbalanced braces")


def _scale_bodies(text: str) -> dict[int, str]:
    """`[1]..[4] = { ... }` entries of the `scales` table, keyed by scale.

    Restricted to depth 1 INSIDE `scales`, because a scale body's own
    `weapons = { [1] = {...}, [2] = {...} }` uses the identical `[N] = {`
    spelling. Matching those too silently overwrote the real scale bodies with
    weapon tables — which read `ms_tanks_s3` as VEH when tanks.lua overrides it
    to HEAVY, i.e. it disarmed the movement-class half of the reachability gate.
    """
    if "scales" not in text:
        return {}
    scales = _braced(text, text.index("scales"))
    out: dict[int, str] = {}
    depth = 0
    i = 0
    while i < len(scales):
        ch = scales[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        elif depth == 1 and ch == "[":
            m = re.match(r"\[(\d)\]\s*=\s*\{", scales[i:])
            if m:
                # m ends just past the opening brace, so that brace is the last
                # character of the match; skip the whole balanced body so the
                # nested `weapons = { [1] = ... }` inside it is never scanned.
                bstart = i + m.end() - 1
                body = _braced(scales, bstart)
                out[int(m.group(1))] = body
                i = bstart + len(body)
                continue
        i += 1
    return out


def _read_scaled_class(path: str) -> dict[str, UnitFacts]:
    """A units/<class>.lua built through `_builder.lua`'s 4-scale generator.

    The builder's own formulas (units/_builder.lua:40-49):
        maxvelocity = canmove==false and 0 or (baseSpeed or 2.0) * (1 - 0.15*(s-1))
        footprint   = (baseFootprint or 2) + (s - 1)
    plus per-scale `override = { movementclass = ... }`, which is how the
    heavier tanks/artillery/mechs become HEAVY. Missing that override is the
    difference between verifying a roster on VEH and verifying it on HEAVY.
    """
    with open(path, encoding="utf-8") as fh:
        text = _strip_comments(fh.read())
    cls = _str(text, "class")
    if cls is None:
        return {}
    # Spec-level defaults, read before the `scales` sub-table so a per-scale
    # key of the same name cannot be mistaken for the spec's.
    head = text[:text.index("scales")] if "scales" in text else text
    base_speed = _num(head, "baseSpeed", 2.0)
    base_footprint = _num(head, "baseFootprint", 2)
    base_mclass = _str(head, "movementclass")
    canmove = not re.search(r"\bcanmove\s*=\s*false", head)

    scale_bodies = _scale_bodies(text)

    out = {}
    for s in (1, 2, 3, 4):
        body = scale_bodies.get(s, "")
        name = f"ms_{cls}_s{s}"
        maxvel = 0.0 if not canmove else (
            _num(body, "maxvelocity") or base_speed * (1 - 0.15 * (s - 1)))
        fp = _num(body, "footprint") or (base_footprint + (s - 1))
        # A per-scale override wins over the spec default (tanks s3/s4 → HEAVY).
        mclass = _str(body, "movementclass") or base_mclass
        out[name] = UnitFacts(name, int(fp), int(fp), maxvel * GAME_SPEED,
                              None if not canmove else mclass, not canmove)
    return out


def _read_flat_class(path: str, prefix: str = "ms_") -> dict[str, UnitFacts]:
    """units/civilians.lua and units/civvehicles.lua — plain literal defs.

    `prefix` is how a top-level entry is told from a stray local. It defaults
    to the roster's own `ms_` namespace; `fable_airship.lua` is read with its
    own name because the one carrier a generated war stages is a `fable_*`
    showcase def rather than a scale-class member (see _CARRIER_FILES).
    """
    with open(path, encoding="utf-8") as fh:
        text = _strip_comments(fh.read())
    out = {}
    for name, body in _split_top_level_entries(text).items():
        if not name.startswith(prefix):
            continue
        fx = _num(body, "footprintx", 2)
        fz = _num(body, "footprintz", 2)
        maxvel = _num(body, "maxvelocity", 0.0)
        mclass = _str(body, "movementclass")
        canmove = not re.search(r"\bcanmove\s*=\s*false", body)
        out[name] = UnitFacts(name, int(fx), int(fz), maxvel * GAME_SPEED,
                              mclass if canmove else None, not canmove)
    return out


def _read_customparam(path: str, key: str) -> dict[str, str]:
    """defname -> the value of `customparams.<key>`, for defs that declare it.

    Used for `site_kind` (units/buildings_sites.lua), which is how a generated
    scenario's site layer says WHICH resource a placed building is without the
    generator restating a def→kind table that content already owns.

    Same regex-not-interpreter reasoning as the rest of this module. The lookup
    is per-entry rather than file-wide so a `site_kind` in one def's comment
    block cannot be attributed to its neighbour.
    """
    with open(path, encoding="utf-8") as fh:
        text = _strip_comments(fh.read())
    out = {}
    for name, body in _split_top_level_entries(text).items():
        v = _str(body, key)
        if v is not None:
            out[name] = v
    return out


# Def families the generator may place, and how each file is shaped.
#
# `buildings_sites.lua` / `buildings_support.lua` wrap every entry in a local
# `site{...}` / `building{...}` helper that sets canmove/maxvelocity OUTSIDE the
# entry body, so they are read as buildings (footprint literal, speed 0) rather
# than through _read_flat_class, which would look for a `canmove` the body does
# not contain and grade them as mobile units with speed 0.
_BUILDING_FILES = ("buildings_civilian.lua", "buildings_military.lua",
                   "buildings_support.lua", "buildings_sites.lua")
_SCALED_FILES = ("staticdefense.lua", "soldiers.lua", "tanks.lua",
                 "artillery.lua", "engineers.lua", "mechs.lua", "radar.lua")
# The §M1 one-off vehicles: plain literal defs, same shape as civvehicles.lua.
# transports.lua is deliberately absent — ms_landing_ship is movementclass SHIP
# and the generator has no water placement, so offering it would only let a
# template name a def that can never be sited.
_FLAT_FILES = ("civilians.lua", "civvehicles.lua", "irregulars.lua",
               "logistics.lua", "recon_vehicles.lua", "command_vehicles.lua")
# The carrier. Read despite being a `fable_*` showcase def and despite being
# air, because since PLAN-metalstorm-transports.md §3.2 a generated war STAGES
# one per side: a side's transports are part of its declared staged force, so
# being transport-less at GameStart is a choice a scenario makes rather than an
# accident. It is the only lift a land map can hold — ms_landing_ship is
# movementclass SHIP and the generator has no water placement — which is why
# transports.lua is still absent from this list.
#
# Being in the catalog is the point, not a side effect: it puts the carrier
# under the same gates as every other staged def (nothing spawns inside a
# yardmap, no two units share a spot, --coverage really does stage one of
# everything) instead of smuggling it past them.
_CARRIER_FILES = (("fable_airship.lua", "fable_airship"),)


def load(game_dir: str) -> dict[str, UnitFacts]:
    """Every def the scenario generator may emit, keyed by def name.

    `game_dir` is data/games/metalstorm. Only the def families the generator
    places are read — the wz_* baseline models and the naval classes are not
    scenario-generator content. The one exception is `fable_airship`, which a
    generated war now stages per side as that side's carrier
    (PLAN-metalstorm-transports.md §3.2); see _CARRIER_FILES.
    """
    units = os.path.join(game_dir, "units")
    facts: dict[str, UnitFacts] = {}
    for f in _BUILDING_FILES:
        facts.update(_read_buildings(os.path.join(units, f)))
    for f in _SCALED_FILES:
        facts.update(_read_scaled_class(os.path.join(units, f)))
    for f in _FLAT_FILES:
        facts.update(_read_flat_class(os.path.join(units, f)))
    for f, prefix in _CARRIER_FILES:
        facts.update(_read_flat_class(os.path.join(units, f), prefix=prefix))
    return facts


def site_kinds(game_dir: str) -> dict[str, str]:
    """defname -> `customparams.site_kind` for units/buildings_sites.lua.

    The site defs carry their own kind ('grain', 'oil', 'timber', …); the
    generator labels against that rather than against the def name, so renaming
    a def does not silently unname every site in every generated scenario.
    """
    return _read_customparam(
        os.path.join(game_dir, "units", "buildings_sites.lua"), "site_kind")


def feature_chain_pitch(game_dir: str, kind: str = "bridge") -> float:
    """Segment spacing for a chained feature family, in elmos.

    `features/bridges.lua` publishes the measured tile length as
    `customparams.chain_pitch` so nothing downstream restates it —
    game_scenario.lua's `featureChainPitch` reads it at stage time, and the map
    generator needs the same number at PLAN time to size a chain of spans
    (terragen/bridges.py).

    Read off the file rather than per-def, because that is where the value is:
    both spans get it from the shared `span()` posture helper, which is not
    inside either def's own table. So this asserts the file speaks with one
    voice instead of pretending to read one entry — two different pitches in one
    family would mean a chain sized for the wrong span, which is the failure
    §M3 spent a live boot on.

    Raises rather than defaulting: a silent 24.0 here would be exactly the
    hardcoded copy the def exists to prevent.
    """
    path = os.path.join(game_dir, "features", f"{kind}s.lua")
    with open(path, encoding="utf-8") as fh:
        text = _strip_comments(fh.read())
    found = {m.group(1) for m in
             re.finditer(r"chain_pitch\s*=\s*'([^']*)'", text)}
    if not found:
        raise ValueError(f"{path} declares no customparams.chain_pitch")
    if len(found) > 1:
        raise ValueError(f"{path} declares {len(found)} different chain "
                         f"pitches ({sorted(found)}) — a chain sized against "
                         f"one would be wrong for the other")
    return float(found.pop())


def feature_deck_top(game_dir: str, defname: str, kind: str = "bridge") -> float:
    """How far a chained span's trafficable surface sits above its own y = 0.

    The number that decided roads R3c (PLAN-maps.md §2j), read from the def
    rather than from the forge layout script that authored the mesh: a feature's
    y is clamped UP to the ground every tick (`CFeature::UpdatePosition`,
    Feature.cpp:570) and can never be pushed down, so a unit driving on the
    terrain under a span is exactly this far below the deck — and an earthwork
    raises the span with the ground, leaving the gap unchanged.

    **BOTH SHIPPED SPANS NOW RETURN 0.0, AND THAT IS THE ANSWER, NOT A HOLE.**
    §2j option A (2026-08-19) re-authored `ms_road_bridge` and `ms_rail_bridge`
    with their origin ON the deck rather than at the pier base, which is what
    closed that gap at source: the deck IS y = 0, so the offset to it is
    nothing. A caller adding this to a span's y is still correct — it is now
    adding zero — and a caller that treats 0 as "missing" is the bug this
    function's raise-don't-default contract exists to prevent.

    Read PER DEF, unlike `feature_chain_pitch`: the pitch is a family fact set
    in the shared `span()` posture (and one family cannot hold two), while a
    deck height is a per-mesh fact that happened to differ (road 1.5, rail 3.8
    before A) and could differ again the moment a third span is authored
    against a different origin convention. A file-wide read here would either
    raise on a correct file or attribute one span's deck to the other.

    Raises rather than defaulting, for the same reason the pitch does: a silent
    constant here is the hardcoded copy the def exists to prevent.
    """
    path = os.path.join(game_dir, "features", f"{kind}s.lua")
    tops = _read_customparam(path, "deck_top")
    if defname not in tops:
        raise ValueError(f"{path} declares no customparams.deck_top for "
                         f"{defname} (declared for: {sorted(tops) or 'nothing'})")
    return float(tops[defname])


def verify(facts: dict[str, UnitFacts], required: list[str]) -> list[str]:
    """Problems with `required` — an unknown def, or one whose facts are unusable.

    Returned rather than raised so a caller can report every gap at once.
    A mobile def with speed 0 would divide by zero in the contestability
    arithmetic; a building with a 0 footprint would clear nothing.
    """
    problems = []
    for name in required:
        f = facts.get(name)
        if f is None:
            problems.append(f'unknown unit def "{name}" — '
                            f'not in data/games/metalstorm/units/')
            continue
        if f.building and (f.footprint_x <= 0 or f.footprint_z <= 0):
            problems.append(f'"{name}" is a building with a zero footprint')
        if not f.building and f.speed <= 0:
            problems.append(f'"{name}" is mobile but has speed 0')
    return problems
