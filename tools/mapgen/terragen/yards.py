"""Roadside yard PADS — the tarmac a depot stands on, planned at generation
time (roads R4b).

R4 landed the placement primitive: `tools/mapgen/road_frontage.py` carves a
parcel off a published link and stands a building on it with its yard between
the shed and the carriageway. Two halves of that brief it could not do, and
neither was a matter of cost:

  * **The driveway and parking MARKINGS.** `road_frontage` is a *scenario-time*
    placer. By the time `scenariogen` opens a map, the splat distribution, the
    ground albedo and the SMF typemap are already baked and packaged — R2's
    `emit_roads_lua` header spells out why that seam runs one way only. A
    scenario-time placer therefore cannot mark its own tarmac: it can put a
    depot on a road, but the depot stands on grass.
  * **A standalone lot with no building.** A highway rest stop as its own
    primitive. `road_frontage` has nothing to anchor a building-less lot with,
    because a footprint is what owns clearance in the scenario layer — no
    building, no rect, no reason for the ground to be different.

Both are the same missing object: a piece of *prepared ground* beside a road,
planned where the road is planned and baked with everything else. That is a
yard pad, and this module plans them off the same link graph R2 publishes.

**A PAD IS ORDINARY DECK, and that is the whole trick** — the same answer
`carve_junction_aprons` gives, for the same reason. R1 established there is no
fifth detail channel available to roads (the distr texture is RGBA and all four
are spoken for), so a yard treatment that wanted its own splat layer could not
have one. Carving the pad into the road raster instead makes it inherit the deck
albedo recipe, the rock detail channel, the surface class of the road it serves,
the shoulder fade, and the typemap value that gives it `receiveTracks` and a
per-move-class speed. The "splat markings" half of the brief is then one carve
rather than a new layer: the pad IS road surface, just road surface that no route
runs along.

**The "flat pad" half is a SECOND carve, because the road grader does not make
anything flat.** `flatten_network` blends toward a blur of the terrain, which
cuts highs and fills dips and does nothing whatever to a uniform slope — the
blur of a ramp is the same ramp. Measured on a 3.2-degree ramp, a carved pad came
out of the grader holding 31.2 of its 31.5 elmos of relief. That is the right
behaviour for a road, which follows its hillside, and the wrong one for a yard.
`level_yard_pads` is the plateau, and it runs AFTER the flatten for the reason
its own docstring gives.

**What this module does NOT do — place anything.** Same division as
`terragen/bridges.py`: the map publishes (`mapdata/roads.lua` `yards`), the
scenario stages. A pad carries no building, which is exactly what makes it the
building-less lot primitive the brief asked for: an empty pad beside a highway
is a rest stop, and it costs the sim nothing because it is terrain.

**The gate a pad must pass is the deck it must not touch.** A yard on the
carriageway severs the route the road exists to provide — R4's acceptance rule,
one layer down and stronger here: at generation time the *rasterized* deck is in
hand, including the plazas and junction aprons that widen it, so the test is
against the cells the deck actually occupies rather than against a polyline plus
a margin.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, replace

import numpy as np

from . import roads as rd
from .bridges import heading_dir, heading_short


@dataclass(frozen=True)
class YardParams:
    """Pad geometry and the rules that refuse one.

    The default extents are sized off the largest yard the scenario layer asks
    for (`scenario_templates.ROAD_FRONTAGE`'s fuel stop: 480 of frontage and a
    parcel 532 deep once the building's own reach is added) with room over. They
    are stated here rather than imported because a pad is a fact about the MAP:
    the map offers prepared ground of a published size and the scenario fits its
    lot inside it or refuses — see `road_frontage.parcels_from_pads`. A pad too
    small for everything on the roster would be tarmac nothing can use, which is
    why `tests/test_yards.py` checks the defaults against those templates.
    """
    half_along: float = 280.0     # half the frontage, along the carriageway
    half_away: float = 300.0      # half the depth, back from the frontage line
    # Elmos between the carriageway EDGE and the pad's near edge. Mirrors
    # `road_frontage.SHOULDER`, and it does not have to: the scenario derives its
    # parcel from the pad's PUBLISHED geometry, so this number is the truth about
    # where the tarmac starts rather than a constant two layers have to agree on.
    setback: float = 40.0
    pitch: float = 640.0          # stations stepped along a link looking for room
    end_keepout: float = 240.0    # never on the last stretch: that end is a junction
    junction_keepout: float = 360.0
    max_pads: int = 6
    per_link: int = 2
    classes: tuple[int, ...] = (rd.ROAD_HIGHWAY, rd.ROAD_ROAD, rd.ROAD_TRACK)
    # Pre-flatten relief the pad's own ground may hold, as a grade across the
    # pad's diagonal. Coarse on purpose: the flatten pass grades a pad the way it
    # grades a road, so this rejects cliffs and hillsides rather than deciding
    # the delivered surface. What the delivered surface actually came out at is
    # measured afterwards by `report_pad_relief`, the way the road's delivered
    # grade is (roads R2 finding).
    max_relief_deg: float = 9.0
    freeboard: float = 4.0        # elmos of dry margin above the waterline
    # A pad whose delivered relief exceeds this is reported loudly. Not a
    # publication gate: the scenario tests the shipped heightmap under every
    # footprint it stands (`terrain.footprint_clear`) and is the only layer that
    # can refuse with a building in hand.
    warn_relief_deg: float = 6.0


@dataclass(frozen=True)
class YardPad:
    """A rectangle of prepared ground beside one link.

    `heading` is the Spring heading whose `bridges.heading_dir` is the AWAY
    normal — from the carriageway toward the pad. The away normal rather than
    the along tangent because it is the one that cannot be misread: a tangent
    leaves the side of the road ambiguous, and a pad on the wrong side of its
    own road is R4's finding 1 (`_yard_anchor`'s sign) reappearing across a file
    boundary. One convention per file, the same 16-bit heading the crossings in
    this file use, and `tests/test_yards.py` round-trips it.
    """
    link: int                   # index into net.links
    road_class: int
    x: float                    # pad CENTRE, world
    z: float
    heading: int                # Spring heading short; heading_dir() == away normal
    half_along: float
    half_away: float
    relief: float = 0.0         # pre-flatten height spread over the pad, elmos
    station: float = 0.0        # arclength along the link, for reporting

    @property
    def away(self) -> tuple[float, float]:
        return heading_dir(self.heading)

    @property
    def along(self) -> tuple[float, float]:
        ax, az = self.away
        return (-az, ax)

    def corners(self) -> list[tuple[float, float]]:
        """The pad's four world corners, pad-oriented (not an AABB)."""
        ux, uz = self.along
        vx, vz = self.away
        return [(self.x + ux * u + vx * v, self.z + uz * u + vz * v)
                for u, v in ((-self.half_along, -self.half_away),
                             (self.half_along, -self.half_away),
                             (self.half_along, self.half_away),
                             (-self.half_along, self.half_away))]

    def rect(self) -> tuple[float, float, float, float]:
        """AABB of the pad — for overlap tests only, per `Lot`'s own warning."""
        cs = self.corners()
        xs = [c[0] for c in cs]
        zs = [c[1] for c in cs]
        return (min(xs), min(zs), max(xs), max(zs))


@dataclass(frozen=True)
class YardRefusal:
    """Why one candidate station carries no pad. Shaped like `bridges.Refusal`:
    a lane that only ever reports what it placed cannot tell "this map's roads
    have nowhere for a yard" from "the planner is broken"."""
    link: int
    road_class: int
    station: float
    reason: str

    def describe(self) -> str:
        return (f"{rd.ROAD_CLASS_NAMES.get(self.road_class, '?')} link "
                f"{self.link} at {self.station:.0f} elmos: {self.reason}")


def _stations(polyline: np.ndarray, pitch: float, keepout: float
              ) -> list[tuple[float, float, float, float]]:
    """(arclength, x, z, tangent) every `pitch` elmos, ends kept clear.

    Re-sampled by arclength rather than walked vertex-by-vertex because a
    smoothed polyline's vertex density is whatever Chaikin happened to produce
    (`roads.resample_by_arclength`'s own note), and the tangent is taken from the
    re-sampled neighbours so it is a tangent over `pitch` of road rather than
    over one smoother artefact.
    """
    pts = rd.resample_by_arclength(np.asarray(polyline, dtype=float), pitch)
    if len(pts) < 3:
        return []
    total = float(np.hypot(*np.diff(pts, axis=0).T).sum())
    out = []
    for i in range(1, len(pts) - 1):
        d = pitch * i
        if d < keepout or d > total - keepout:
            continue
        tx = pts[i + 1][0] - pts[i - 1][0]
        tz = pts[i + 1][1] - pts[i - 1][1]
        n = math.hypot(tx, tz)
        if n < 1e-6:
            continue
        out.append((d, float(pts[i][0]), float(pts[i][1]),
                    math.atan2(tz / n, tx / n)))
    return out


def _pad_window(pad: YardPad, shape, cellsize: float):
    """(row slice, col slice, inside mask) for the cells the pad covers.

    Rounded corners, and deliberately: the mask is derived from the same
    rectangle SDF the distance carve uses, so `mask` and `dist` cannot disagree
    about where the pad ends. A square-cornered mask against an SDF distance
    puts four wedges of "deck" outside the deck fade — cells the albedo bake
    paints as tarmac and the flatten never grades.
    """
    H, W = shape
    reach = math.hypot(pad.half_along, pad.half_away) + 2.0 * cellsize
    c = pad.x / cellsize
    r = pad.z / cellsize
    rc = int(math.ceil(reach / cellsize)) + 2
    c0 = max(0, int(c) - rc); c1 = min(W, int(c) + rc + 1)
    r0 = max(0, int(r) - rc); r1 = min(H, int(r) + rc + 1)
    if c0 >= c1 or r0 >= r1:
        return None
    zz, xx = np.mgrid[r0:r1, c0:c1]
    dx = xx * cellsize - pad.x
    dz = zz * cellsize - pad.z
    ux, uz = pad.along
    vx, vz = pad.away
    u = np.abs(dx * ux + dz * uz)
    v = np.abs(dx * vx + dz * vz)
    return slice(r0, r1), slice(c0, c1), u, v


def _sdf(u, v, half_along: float, half_away: float):
    """Distance to the rectangle of the given half-extents, 0 inside."""
    du = np.maximum(u - half_along, 0.0)
    dv = np.maximum(v - half_away, 0.0)
    return np.hypot(du, dv)


def _rects_overlap(a, b) -> bool:
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def plan_yard_pads(
    net: rd.RoadNetwork,
    height: np.ndarray,
    raster: rd.RoadRaster,
    cellsize: float,
    water_level: float = 0.0,
    params: YardParams | None = None,
    road_params: rd.RoadParams | None = None,
) -> tuple[list[YardPad], list[YardRefusal]]:
    """Yard pads off `net`, and a refusal for every station that carried none.

    Planned BEFORE the flatten pass, because the pad has to be in the raster when
    `flatten_network` runs or the grader will grade the ground around it and leave
    a hole where the pad is. It is therefore planned against the PRE-flatten
    height, which is why `max_relief_deg` is a coarse "not a cliff" test rather
    than a flatness spec: it bounds how much cut-and-fill `level_yard_pads` will
    have to do afterwards, and the delivered answer is `report_pad_relief`'s.

    Deliberately spread: at most `per_link` pads on one link and `max_pads` on a
    map. These are landmarks on a road — every 640 elmos would be a service
    strip, not a frontier highway (`scenario_templates.MAX_ROAD_FRONTAGE` makes
    the same argument one layer up about the buildings).
    """
    p = params or YardParams()
    rp = road_params or rd.RoadParams()
    pads: list[YardPad] = []
    refusals: list[YardRefusal] = []
    taken: list[tuple[float, float, float, float]] = []
    H, W = height.shape

    # A snapshot: `carve_yard_pads` writes into `raster.mask`, so planning
    # against the live mask would make pad k+1's deck test see pad k as
    # carriageway. Pad-vs-pad is an explicit rectangle test instead, which is
    # also the one that can say so in its refusal.
    deck = raster.mask

    order = sorted(range(len(net.links)),
                   key=lambda i: (net.links[i].road_class, i))
    for li in order:
        if len(pads) >= p.max_pads:
            break
        link = net.links[li]
        if link.road_class not in p.classes:
            continue
        on_link = 0
        half_w = rd.class_width(link.road_class, rp) * 0.5
        for station, sx, sz, tang in _stations(link.polyline, p.pitch,
                                               p.end_keepout):
            if len(pads) >= p.max_pads or on_link >= p.per_link:
                break

            def refuse(reason: str) -> None:
                refusals.append(YardRefusal(li, link.road_class, station, reason))

            if any(math.hypot(sx - jx, sz - jz) < p.junction_keepout
                   for jx, jz in net.junctions):
                refuse("a junction is inside the keepout")
                continue
            # Alternate which side is TRIED first, so a run of pads along one
            # highway does not all end up on the same verge — and so any map
            # with two pads exercises both signs of the away normal. R4's
            # finding 1 is that a frontage sign error reads as correct on one
            # side of the road; a planner that only ever uses one side is a
            # planner whose output cannot show the error.
            first = 1 if len(pads) % 2 == 0 else -1
            for side in (first, -first):
                ang = tang + (math.pi / 2.0) * side
                ax, az = math.cos(ang), math.sin(ang)
                off = half_w + p.setback + p.half_away
                px, pz = sx + ax * off, sz + az * off
                pad = YardPad(link=li, road_class=link.road_class, x=px, z=pz,
                              heading=heading_short(ax, az),
                              half_along=p.half_along, half_away=p.half_away,
                              station=station)
                win = _pad_window(pad, height.shape, cellsize)
                if win is None:
                    refuse("the pad falls outside the map")
                    continue
                rows, cols, u, v = win
                inside = _sdf(u, v, p.half_along, p.half_away) <= 0.0
                if not inside.any():
                    refuse("the pad covers no cell")
                    continue
                # Off the map edge: the AABB is clipped, so a pad hanging over
                # the edge shows up as a footprint smaller than it should be.
                want = (4.0 * p.half_along * p.half_away) / (cellsize * cellsize)
                if inside.sum() < 0.95 * want:
                    refuse("the pad runs off the map edge")
                    continue
                if deck[rows, cols][inside].any():
                    refuse("the pad would cover the carriageway")
                    continue
                hh = height[rows, cols][inside]
                if float(hh.min()) < water_level + p.freeboard:
                    refuse("the pad is wet")
                    continue
                relief = float(hh.max() - hh.min())
                diag = 2.0 * math.hypot(p.half_along, p.half_away)
                if math.degrees(math.atan2(relief, diag)) > p.max_relief_deg:
                    refuse(f"the ground holds {relief:.0f} elmos of relief")
                    continue
                if any(_rects_overlap(pad.rect(), r) for r in taken):
                    refuse("another pad is already here")
                    continue
                pads.append(replace(pad, relief=relief))
                taken.append(pad.rect())
                on_link += 1
                break
    return pads, refusals


def carve_yard_pads(
    raster: rd.RoadRaster,
    pads: list[YardPad],
    cellsize: float,
    params: rd.RoadParams | None = None,
) -> None:
    """In-place: merge every pad into the road fields as ordinary deck.

    The rectangle twin of `carve_plazas`, and the construction is that
    function's exactly: the distance field is lowered to zero over the pad
    shrunk by half a road width and reaches `road_width/2` at the pad's edge, so
    the albedo bake paints it with the same sharp edge and worn shoulder as the
    ways that meet it and the typemap gives it the deck's surface. Being deck is
    what earns it the splat treatment — see this module's header. What being deck
    does NOT do is make it flat: that is `level_yard_pads`, after the grader.

    Classes are NOT carved here, for the reason `carve_plaza_classes` is split
    out: a generator only has moisture, and therefore a surface classification,
    after the biome step, i.e. long after the mask has to exist.
    """
    p = params or rd.RoadParams()
    half = p.road_width * 0.5
    for pad in pads:
        win = _pad_window(pad, raster.mask.shape, cellsize)
        if win is None:
            continue
        rows, cols, u, v = win
        core = _sdf(u, v, max(pad.half_along - half, 0.0),
                    max(pad.half_away - half, 0.0))
        np.minimum(raster.dist[rows, cols], core, out=raster.dist[rows, cols])
        raster.mask[rows, cols] |= core <= half
        # The shoulder fade is measured off `blend`, which is zero wherever no
        # class claimed the cell — a pad far enough from its road to have its
        # own shoulder would otherwise fade over 0 elmos and read as a cut edge.
        np.maximum(raster.blend[rows, cols],
                   np.where(core <= half, rd.class_blend(pad.road_class, p), 0.0),
                   out=raster.blend[rows, cols])


def carve_yard_pad_classes(
    surf: np.ndarray,
    pads: list[YardPad],
    cellsize: float,
    params: rd.RoadParams | None = None,
) -> None:
    """In-place: give each pad the surface the road it serves already carries.

    Sampled from a window REACHING the carriageway rather than from inside the
    pad, which is the difference from `carve_plaza_classes`: a plaza sits on the
    junction it serves and the arriving classes are inside it, while a pad is by
    construction off the deck, so "the commonest class inside the pad" is always
    "none" and the pad would take the dirt fallback on every map — a bitumen
    highway with a gravel service yard, everywhere, silently.
    """
    p = params or rd.RoadParams()
    for pad in pads:
        reach = pad.half_away * 2.0 + p.road_width
        probe = replace(pad, half_away=reach)
        win = _pad_window(probe, surf.shape, cellsize)
        if win is None:
            continue
        rows, cols, u, v = win
        near = _sdf(u, v, pad.half_along, reach) <= 0.0
        window = surf[rows, cols]
        arriving = window[near & (window != rd.SURF_NONE)]
        cls = (np.uint8(int(np.bincount(arriving,
                                        minlength=rd.SURF_MUD + 1).argmax()))
               if arriving.size else np.uint8(rd.SURF_DIRT))
        pad_win = _pad_window(pad, surf.shape, cellsize)
        rows, cols, u, v = pad_win
        half = p.road_width * 0.5
        core = _sdf(u, v, max(pad.half_along - half, 0.0),
                    max(pad.half_away - half, 0.0))
        window = surf[rows, cols]
        window[core <= half] = cls


def level_yard_pads(
    height: np.ndarray,
    pads: list[YardPad],
    cellsize: float,
    params: YardParams | None = None,
) -> np.ndarray:
    """Plateau every pad at its own mean height. Returns a new height field.

    **THE FLATTEN PASS DOES NOT MAKE A PAD FLAT, and assuming it did was wrong.**
    `flatten_network` blends the terrain toward a *blur* of itself, which is
    cut-and-fill: it cuts highs and fills dips, and on a uniform slope it does
    nothing at all, because the blur of a ramp is the same ramp. Measured: a pad
    carved on a 3.2-degree ramp came out of the grader holding 31.2 of its
    original 31.5 elmos of relief. A road wants exactly that — a graded road
    follows the hillside — and a yard wants the opposite, which is why a pad
    needs its own carve.

    Runs AFTER `flatten_network`, necessarily: on the deck the grader's weight is
    1, so it replaces the pad's heights outright with the blurred surface and
    would erase a plateau applied before it. A construction pad is cut into
    graded ground, in that order, which is also what it looks like.

    The plateau fades to nothing over `setback` elmos outside the pad — the
    verge, i.e. exactly the strip between the pad and the carriageway — so the
    ramp between the two IS the driveway and the deck's own delivered grade is
    left as `report_delivered_grades` measured it.
    """
    p = params or YardParams()
    out = height
    for pad in pads:
        win = _pad_window(replace(pad, half_along=pad.half_along + p.setback,
                                 half_away=pad.half_away + p.setback),
                          height.shape, cellsize)
        if win is None:
            continue
        rows, cols, u, v = win
        d = _sdf(u, v, pad.half_along, pad.half_away)
        inside = d <= 0.0
        if not inside.any():
            continue
        if out is height:
            out = height.copy()
        level = float(np.mean(out[rows, cols][inside]))
        t = np.clip(d / max(p.setback, 1e-3), 0.0, 1.0)
        w = 1.0 - t * t * (3 - 2 * t)          # smoothstep, 1 on the pad
        window = out[rows, cols]
        out[rows, cols] = window * (1.0 - w) + level * w
    return out


def pad_relief(height: np.ndarray, pad: YardPad, cellsize: float) -> float:
    """Height spread over one pad on the surface it is measured on, in elmos."""
    win = _pad_window(pad, height.shape, cellsize)
    if win is None:
        return 0.0
    rows, cols, u, v = win
    inside = _sdf(u, v, pad.half_along, pad.half_away) <= 0.0
    if not inside.any():
        return 0.0
    hh = height[rows, cols][inside]
    return float(hh.max() - hh.min())


def report_pad_relief(height: np.ndarray, pads: list[YardPad], cellsize: float,
                      params: YardParams | None = None) -> list[float]:
    """Print the DELIVERED relief of every pad, loudly past `warn_relief_deg`.

    The instrument, not a gate — `roads.report_delivered_grades` for pads. The
    planner chose these pads on the ungraded surface and the flatten pass had
    the last word, so this is the only place the number the player stands on is
    ever read. It does not refuse: the scenario layer tests the shipped
    heightmap under every footprint it stands and is the only layer that can
    refuse with a building in hand.
    """
    p = params or YardParams()
    out = []
    for pad in pads:
        relief = pad_relief(height, pad, cellsize)
        diag = 2.0 * math.hypot(pad.half_along, pad.half_away)
        grade = math.degrees(math.atan2(relief, diag))
        out.append(relief)
        note = "  yard pad" if grade <= p.warn_relief_deg else "  yard pad STEEP"
        print(f"{note}: {rd.ROAD_CLASS_NAMES.get(pad.road_class, '?')} link "
              f"{pad.link} at ({pad.x:.0f}, {pad.z:.0f}) — {relief:.1f} elmos "
              f"of relief across {diag:.0f} ({grade:.1f} deg), "
              f"planned at {pad.relief:.1f}")
    return out


def emit_yards_lua(pads: list[YardPad]) -> list[str]:
    """`yards = { ... }` rows for mapdata/roads.lua.

    Every field the scenario layer needs to rebuild the pad's frame, and no
    derived ones: `road_frontage.parcels_from_pads` reconstructs the along axis
    from `heading` rather than reading a second copy of it, because two
    published axes that can disagree is R3b's finding 3 waiting to happen.
    """
    out = []
    for i, pad in enumerate(pads):
        out.append(
            f"        {{ key = \"pad_{i}\", class = {pad.road_class}, "
            f"name = \"{rd.ROAD_CLASS_NAMES[pad.road_class]}\", "
            f"x = {pad.x:.0f}, z = {pad.z:.0f}, "
            f"heading = {pad.heading}, "
            f"half_along = {pad.half_along:.0f}, "
            f"half_away = {pad.half_away:.0f}, link = {pad.link} }},")
    return out
