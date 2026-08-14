#!/usr/bin/env python3
"""road_frontage.py — buildings that stand ON a road, and what parks in the yard.

Roads lane R4 (PLAN-metalstorm-roads.md), the placement primitive the brief
asks for: *"a building declares a yard rectangle + required frontage class;
the placer positions building+yard flush to a network edge (yard between road
and building), never floating in a field."*

WHY THIS IS A SEPARATE PLACER AND NOT A `place_sites` FLAG.
Everything else `scenariogen` stages is placed against a REGION — a ring search
outward from the region anchor, terrain-checked, dodging whatever is already
there (`_clear_spot`). That relation is "somewhere in this region", and it is
the right one for a headframe on a seam or a relic in a wilderness. A depot's
relation is to a ROAD: it exists because the road is there, its doors face the
carriageway, and the ground between the two is a yard rather than a field. No
amount of ring-searching produces that, because the ring search has never known
where a road is. The map has published its road graph since R2
(`mapdata/roads.lua` links) and its fords since R3b; `scenariogen.read_road_links`
is the reader, and this module is what the scenario layer does with it.

THE GEOMETRY IS THE TOWN PLANNER'S, DELIBERATELY.
A roadside parcel IS a `town_planner.Lot`: a slice of way, offset back by a
setback, oriented to the carriageway, carrying the cardinal the building faces.
That is the same object `_carve_lots` produces for a street, so the frontage
arithmetic (`town_stager._lot_frame`, `_lot_projection`, `_extent_of`) is
shared rather than re-derived. Two frontage conventions in one tree is how a
yard ends up 90 degrees out from a street with nothing to report it — R3b's
finding 3, one layer down.

WHAT IS NOT SHARED, AND THE SIGN IS THE WHOLE OF IT.
`town_stager._anchor_for` puts a building's NEAR face on the frontage line: a
house fronts the street, and its yard is what is left BEHIND it. A depot is the
other way round — the yard is between the road and the shed, because that is
where the lorries stand — so `_yard_anchor` below pushes the building to the
BACK of its parcel and the yard is the strip it leaves in front. Same
arithmetic, opposite sign, and the two are named so a reader can see they are a
pair.

THE ACCEPTANCE RULE (the shape R3b's `crossing_is_fordable` established).
A frontage building BLOCKS (`CFeature::Block`'s unit twin — every building in
this game occupies its yardmap), so a placer that stands one on the deck severs
the route the road exists to provide, and it does it silently: the scenario is
legal, the map is legal, and a convoy simply never gets through. `_clears_deck`
is therefore a hard gate on the building rect AND on every parked vehicle, and
a parcel that cannot satisfy it is refused with a reason rather than nudged.
"""
from __future__ import annotations

import math

import town_planner as tp
import town_stager as tstage

# Elmos between the carriageway EDGE and the parcel's frontage line — the verge
# a road keeps clear of itself. Matches the town archetypes' `setback` band
# (48-64 in town_templates.STREET_ARCHETYPES) at the low end: a rural depot
# hugs its road more tightly than a town house hugs its street.
SHOULDER = 40.0

# Extra clearance demanded around the carriageway when testing a rectangle
# against it, on top of half the link's own width. A road drawn 48 elmos wide
# is driven wider than 48 — the pathfinder's units are as wide as their
# footprints — and a shed built exactly on the edge reads as an obstruction.
DECK_MARGIN = 24.0

# How far along a link the placer steps looking for a parcel. Coarse on
# purpose: this is a rural road, and stations every half-lot would offer a
# hundred near-identical candidates whose only difference is which one the
# terrain check happens to pass.
STATION_PITCH = 320.0

# A parcel is never carved on the last stretch of a link, both ends: a link
# terminates at a junction or a town gate, and a depot planted across one is
# the same defect as one planted on the deck, one step removed.
END_KEEPOUT = 240.0

# Rows of parked vehicles are laid out from the yard's road edge inward. The
# gap is on top of the pair's combined body radii (scenariogen.UNIT_SPAWN_GAP
# is 16 for the same reason); a lorry park is tight, not scattered.
PARK_GAP = 12.0


class FrontageRefused(Exception):
    """This link cannot carry this yard, and the message says which rule refused.

    Raised rather than returned for the same reason `StagingRejected` is: every
    refusal here means "try another station, another link, or ship without it",
    and a yard quietly missing is exactly what the acceptance rule above exists
    to prevent being invisible.
    """


def _clears_deck(rect, link, extra: float = 0.0) -> bool:
    """Is `rect` clear of this link's carriageway, everywhere along it?

    Tested against the polyline the map published rather than against the
    parcel's own local frame, because a link BENDS: a parcel carved on the
    outside of a curve is square to its own station and can still clip the
    deck two vertices along.
    """
    half = link["width"] / 2.0 + DECK_MARGIN + extra
    x0, z0, x1, z1 = rect
    pts = link["points"]
    for i in range(len(pts) - 1):
        ax, az = pts[i]
        bx, bz = pts[i + 1]
        # Sample the segment at the clearance pitch — a rectangle is convex and
        # the deck is a fat polyline, so a sample every `half` cannot skip it.
        seg = math.hypot(bx - ax, bz - az)
        n = max(1, int(seg / max(half, 1.0)))
        for k in range(n + 1):
            t = k / n
            px, pz = ax + (bx - ax) * t, az + (bz - az) * t
            if (x0 - half <= px <= x1 + half) and (z0 - half <= pz <= z1 + half):
                return False
    return True


def _yard_anchor(lot, hx: float, hz: float) -> tuple[float, float, float]:
    """Put the building's FAR face on the parcel's back edge. Returns (x, z, yard).

    The mirror of `town_stager._anchor_for`, and the docstring there explains
    the arithmetic; the only difference is the direction the leftover depth
    ends up on. A town house is pushed TOWARD the street so its face lands on
    the frontage line and the yard falls behind it. A depot is pushed AWAY, so
    the leftover depth falls in FRONT — between the shed and the road, which is
    where a yard is.

    `yard` is that depth, in elmos. Negative means the building is deeper than
    its parcel and there is no yard at all; the caller refuses rather than
    letting a shed sit on its own apron.
    """
    _along, away = tstage._lot_frame(lot)
    _reach_u, reach_v = tstage._lot_projection(lot, hx, hz)
    push = lot.depth / 2.0 - reach_v
    return (lot.x + away[0] * push, lot.z + away[1] * push, push * 2.0)


def carve_parcels(link: dict, spec: dict, facts, pitch: float = STATION_PITCH,
                  phase: float = 0.0) -> list:
    """Every parcel this link could hold for `spec`, in along-link order.

    A parcel is a `town_planner.Lot` so that everything downstream of it — the
    frontage frame, the box projection, the facing — is the town planner's code
    rather than a second copy of it. `width` is the frontage the yard occupies
    along the road and `depth` reaches from the frontage line back past the
    building; `side` and `facing` are the planner's own conventions
    (`_carve_lots`: away-angle = heading + pi/2 * side, and the building faces
    back across it).
    """
    f = facts[spec["def"]]
    hx, hz = tstage._extent_of("south", f.footprint_x, f.footprint_z)
    # Depth is the yard plus the deepest the box can reach at any parcel angle
    # — the box is axis-aligned and the parcel is not, so `_lot_projection`'s
    # worst case (0.707 * (hx + hz), at 45 degrees) is what must fit.
    depth = spec["yard_depth"] + 2.0 * 0.7072 * (hx + hz)
    width = max(spec.get("frontage", 0.0), 2.0 * 0.7072 * (hx + hz))
    pts = link["points"]
    total = tp.polyline_length(pts)
    out = []
    d = END_KEEPOUT + phase * pitch
    while d <= total - END_KEEPOUT:
        px, pz, heading = tp.point_at(pts, d)
        for side in (1, -1):
            ang = heading + (math.pi / 2.0) * side
            off = link["width"] / 2.0 + SHOULDER + depth / 2.0
            out.append(tp.Lot(
                key=f"frontage_{int(d)}_{'r' if side > 0 else 'l'}",
                street=link["name"], x=int(round(px + math.cos(ang) * off)),
                z=int(round(pz + math.sin(ang) * off)),
                width=int(round(width)), depth=int(round(depth)),
                heading=heading, facing=tp._facing_of(ang + math.pi),
                role="frontage", defname=spec["def"], side=side))
        d += pitch
    return out


def yard_span(lot, bx: float, bz: float, hx: float, hz: float
              ) -> tuple[float, float]:
    """The apron, as a (v_lo, v_hi) band in the PARCEL's own depth axis.

    `v` is measured from the parcel centre along the away-from-road unit, so
    `-depth/2` is the frontage line and `v_hi` is the building's near face —
    computed from the BUILDING rather than from the parcel, so a shed that had
    to be pushed back for terrain gets a bigger yard rather than a wrong one.

    Kept in parcel coordinates because that is the frame the yard is true in: a
    parcel on a diagonal road has an axis-aligned bounding box half again its
    own area, and parking lorries in THAT would put half of them on the road.
    `yard_rect` below is the AABB, and it is for overlap tests only.
    """
    _along, away = tstage._lot_frame(lot)
    _reach_u, reach_v = tstage._lot_projection(lot, hx, hz)
    v_b = (bx - lot.x) * away[0] + (bz - lot.z) * away[1]
    return (-lot.depth / 2.0, v_b - reach_v)


def yard_corners(lot, v_lo: float, v_hi: float) -> list[tuple[float, float]]:
    """The apron's four world corners, parcel-oriented."""
    along, away = tstage._lot_frame(lot)
    half = lot.width / 2.0
    return [(lot.x + along[0] * u + away[0] * v,
             lot.z + along[1] * u + away[1] * v)
            for u, v in ((-half, v_lo), (half, v_lo), (half, v_hi), (-half, v_hi))]


def yard_rect(lot, v_lo: float, v_hi: float):
    """AABB of the apron — for overlap tests against other staged rectangles."""
    cs = yard_corners(lot, v_lo, v_hi)
    xs = [c[0] for c in cs]; zs = [c[1] for c in cs]
    return (min(xs), min(zs), max(xs), max(zs))


def park_vehicles(lot, v_lo: float, v_hi: float, defnames: list[str], facts,
                  rows: int, per_row: int) -> list[tuple[str, float, float]]:
    """Rows of parked vehicles across the yard, nearest the road first.

    Laid out in the PARCEL's frame for the reason `yard_span` gives, and filled
    from the road end because that is how a yard fills: the gate row is the one
    a player sees from the carriageway, so it is the row that must exist even
    when the apron only has depth for one.

    Returns (defname, x, z) in world coords. The caller is what tests them
    against the terrain, the deck and everything already staged — emitting a
    candidate list rather than a filtered one keeps every rejection reason in
    one place.
    """
    along, away = tstage._lot_frame(lot)
    depth = v_hi - v_lo
    out = []
    pitch = 2.0 * max(facts[d].body_radius for d in defnames) + PARK_GAP
    for r in range(rows):
        v = v_lo + pitch * (r + 0.5)
        if v + pitch / 2.0 > v_lo + depth:
            break
        for c in range(per_row):
            u = (c - (per_row - 1) / 2.0) * pitch
            if abs(u) + pitch / 2.0 > lot.width / 2.0:
                continue
            name = defnames[(r * per_row + c) % len(defnames)]
            out.append((name,
                        lot.x + along[0] * u + away[0] * v,
                        lot.z + along[1] * u + away[1] * v))
    return out


# ==========================================================================
# The placer
# ==========================================================================

def _rects_overlap(a, b) -> bool:
    """Touching does not count — `scenariogen._rects_overlap`, exactly."""
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def _rect(x: float, z: float, hx: float, hz: float, pad: float = 0.0):
    return (x - hx - pad, z - hz - pad, x + hx + pad, z + hz + pad)


def stage_frontage(rnd, terrain, facts, links: list[dict], specs: list[dict],
                   *, mclass: str, occupied_rects: list, occupied_units: list,
                   footprint_gap: float, unit_gap: float,
                   budget: int) -> tuple[list[dict], list[str]]:
    """Up to `budget` roadside yards, each on a link its spec will accept.

    Returns `(entries, refusals)`. An entry is in `scenariogen`'s `units`
    shape — the same dict `place_sites` returns, on `team = 'neutral'` — with
    the parked vehicles carried on it as `parked` and the ground it takes as
    `rects`, because the war-fightability gate downstream tests rectangles and
    a yard full of lorries is exactly the kind of thing that quietly seals a
    pass.

    Refusals are collected rather than raised: "this map's roads will not carry
    a depot" is an ordinary outcome (a map whose links are all mountain tracks),
    and the summary reporting it is how the difference between that and "the
    placer is broken" stays visible.
    """
    entries: list[dict] = []
    refusals: list[str] = []
    rects = list(occupied_rects)
    units = list(occupied_units)

    for spec in specs:
        if len(entries) >= budget:
            break
        if spec["def"] not in facts:
            refusals.append(f"{spec['def']}: not in this game's roster")
            continue
        f = facts[spec["def"]]
        usable = [ln for ln in links if ln["road_class"] in spec["classes"]]
        if not usable:
            refusals.append(
                f"{spec['def']}: no link of class "
                f"{sorted(spec['classes'])} on this map")
            continue
        placed = None
        # The LAST rule that refused, carried out of the loop. "No parcel
        # cleared" on its own is the shape of report that trains a reader to
        # ignore it — whether every candidate was under water or every one was
        # already built on is the difference between a map fact and a bug.
        why = "no parcel was tried at all"
        for link in usable:
            phase = rnd.random()
            for lot in carve_parcels(link, spec, facts, phase=phase):
                try:
                    placed = _try_parcel(terrain, facts, spec, link, lot, f,
                                         mclass, rects, units,
                                         footprint_gap, unit_gap)
                except FrontageRefused as e:
                    why = str(e)
                    continue
                break
            if placed is not None:
                break
        if placed is None:
            refusals.append(f"{spec['def']}: no parcel on any of "
                            f"{len(usable)} candidate link(s) cleared — "
                            f"last: {why}")
            continue
        entries.append(placed)
        rects.extend(placed["rects"])
        units.append((placed["x"], placed["z"], f))
        units.extend((p["x"], p["z"], facts[p["def"]])
                     for p in placed["parked"])
    return entries, refusals


def _try_parcel(terrain, facts, spec, link, lot, f, mclass, rects, units,
                footprint_gap, unit_gap):
    """One parcel, every rule, in the order that makes a refusal legible.

    Ordered cheapest-and-most-specific first so the reason a link carries no
    yard is the reason a reader would give: the ground, then the road, then
    what is already standing there.
    """
    hx, hz = tstage._extent_of(lot.facing, f.footprint_x, f.footprint_z)
    bx, bz, yard_depth = _yard_anchor(lot, hx, hz)
    bx, bz = float(round(bx)), float(round(bz))
    if yard_depth <= 0.0:
        raise FrontageRefused("the building is deeper than its parcel")
    if not terrain.footprint_clear(bx, bz, f.footprint_x, f.footprint_z, mclass):
        raise FrontageRefused("no buildable ground under the shed")
    brect = _rect(bx, bz, hx, hz)
    if not _clears_deck(brect, link):
        raise FrontageRefused("the shed would stand on the carriageway")
    if any(_rects_overlap(_rect(bx, bz, hx, hz, footprint_gap), r)
           for r in rects):
        raise FrontageRefused("something is already standing here")
    if any(math.hypot(bx - ux, bz - uz) < f.clear_radius
           for ux, uz, _uf in units):
        raise FrontageRefused("a staged unit is inside the shed's yardmap")

    v_lo, v_hi = yard_span(lot, bx, bz, hx, hz)
    # The yard is what a lorry drives on, so it is held to the same passability
    # the war is graded on rather than merely being empty. Corners AND centre:
    # a yard whose middle is a pond has four clear corners.
    _along, away = tstage._lot_frame(lot)
    v_mid = (v_lo + v_hi) / 2.0
    probe = yard_corners(lot, v_lo, v_hi) + [
        (lot.x + away[0] * v_mid, lot.z + away[1] * v_mid)]
    if not all(terrain.passable(px, pz, mclass) for px, pz in probe):
        raise FrontageRefused("the yard is not drivable")

    parked = []
    for name, px, pz in park_vehicles(lot, v_lo, v_hi, spec["parked"], facts,
                                      spec["rows"], spec["per_row"]):
        pf = facts[name]
        prect = _rect(px, pz, pf.body_radius, pf.body_radius)
        if not terrain.passable(px, pz, mclass):
            continue
        if not _clears_deck(prect, link):
            continue
        if _rects_overlap(prect, brect):
            continue
        if any(math.hypot(px - ux, pz - uz) < pf.body_radius + uf.body_radius
               + unit_gap for ux, uz, uf in units):
            continue
        if any(math.hypot(px - q["x"], pz - q["z"])
               < pf.body_radius + facts[q["def"]].body_radius + unit_gap
               for q in parked):
            continue
        parked.append({"def": name, "team": "neutral", "x": int(round(px)),
                       "z": int(round(pz)), "facing": lot.facing})
    if spec.get("min_parked", 0) > len(parked):
        raise FrontageRefused(
            f"only {len(parked)} of {spec['min_parked']} vehicles fit the yard")

    return {"def": spec["def"], "team": "neutral", "x": int(bx), "z": int(bz),
            "facing": lot.facing, "parked": parked,
            "road_class": link["road_class"], "road_name": link["name"],
            "yard": [int(round(c)) for c in yard_rect(lot, v_lo, v_hi)],
            "rects": [brect]}
