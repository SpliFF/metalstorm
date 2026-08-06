#!/usr/bin/env python3
"""town_planner.py — deterministic street-and-lot planner for Metalstorm towns.

Part of the scenario-generation toolchain (tools/mapgen), alongside
`scenariogen.py`, `scenario_templates.py` and `ms_defs.py`. It answers one
question: given a patch of real map terrain and a seed, what does a town that
grew HERE look like — where do its streets run, which way do its buildings
face, where is the market, and where does the wall have a gate.

    python3 tools/mapgen/town_planner.py --seed 7 --demo rolling --out town.json
    python3 tools/mapgen/town_planner.py data/maps/<id> --seed 7 --region <key>

WHAT THIS MODULE OWNS, AND WHAT IT DOES NOT.
It owns geometry: sites, streets, lots, frontage, the perimeter, decoration
slots. It owns NO content decisions — a lot carries a *role*, and turning a
role into a unit def is `town_templates.resolve_roles` against the shipped
content (see that file's header for why the briefed roster is not the shipped
one). It also places nothing: the output is a graph, and the step that stages
units from it is the one that must re-check yardmap clearance against
`ms_defs`, because a lot is a parcel and this module cannot know whether the
building assigned to it fits.

It never recomputes passability. Slope and water come from the same heightmap
convention `regions_from_map.passable_mask` uses (steepest of the four axis
neighbours; water is height below 0), and `SiteProbe.from_terrain` wraps
`scenariogen.Terrain` so a planner run and a scenario run grade the same ground
the same way.

ROADS v1 — WHAT WAS VERIFIED, 2026-08-06.
The brief said: check what path/decal/splat machinery exists, and if roads
cannot be drawn today, ship cleared strips instead of a new renderer. Measured
on this tree:

  * `tools/mapgen/terragen/roads.py` DOES draw roads — least-cost planning,
    Chaikin smoothing, cut-and-fill flattening, a full-res road mask, and
    polylines. It runs at MAP-BAKE time (numpy/scipy, writes the heightmap and
    the splat inputs before the map is packaged).
  * The client has the consuming half: `client/src/core/terrain-splat-plugin.ts`
    and `client/src/protocol/spring-web/map-decals.ts` (detail/specular/splat
    texture set, delivered with the map).
  * BUT the wire carries terrain ONE WAY, ONCE: `schemas/protocol.fbs:1763`
    ships `heightmap: [uint16]` inside the map-data message and there is no
    heightmap-delta or decal-add message anywhere in the schema. The engine
    Lua API does expose `Spring.LevelHeightMap`/`SetHeightMapFunc`
    (rts/Lua/LuaSyncedCtrl.cpp:325-331), so a gadget can deform terrain
    server-side, but this port has no way to tell a connected client about it.

Therefore a SCENARIO, which is a `.lua` staged into an already-baked map, still
cannot draw a road. v1 is exactly what the brief specified: every street
carries a cleared/flattened strip (`terrain_ops()`) plus street-edge decoration
slots, and no renderer is added. The two consumers that unblock later are (a)
terragen, which can bake these strips into a map it is generating anyway, and
(b) the `roads` lane, which owns the surface and network work — see
PLAN-metalstorm-roads.md. Handing them a polyline-plus-width is the same shape
`terragen/roads.py` already produces, on purpose.

DETERMINISM — the same rules as scenariogen.py, for the same reasons.
  * One `random.Random(seed)` threaded explicitly; the module-level `random`
    is never touched.
  * `rnd.random()` is the only entropy primitive, so output cannot shift if
    CPython changes how `choice`/`shuffle` consume the stream.
  * Nothing that reaches output iterates a dict or a set.
  * Terrain-derived quantities (the contour heading a street follows, the
    archetype weights) are computed with NO rng at all, so "which way the
    land runs" is a fact about the map and not about the seed.
  * All emitted coordinates are integral elmos.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from regions_from_map import ELMOS_PER_SQUARE, name_for   # noqa: E402
from town_templates import (                              # noqa: E402
    ARCHETYPES,
    DECOR,
    LOT_ROLES,
    PERIMETER,
    ROLE_ORDER,
    SCARCE_SHARE,
    STREET_ARCHETYPES,
    STREET_NAMES,
    STREET_SUFFIXES,
)

# Bumped whenever the emitted graph changes for an unchanged (terrain, seed).
# Consumers that cache a dump keyed by seed need to see this move.
#
#   2  (town-planner T2) three changes, each found by staging real buildings
#      into T1's parcels and looking at the result:
#      * a grid with no terrain axis to follow now spends its free choice of
#        heading NEAR A CARDINAL instead of uniformly over the half-circle,
#        because the engine builds on four facings and a grid at 45 degrees
#        gives every building in the town a corner to its street
#      * plaza frontage is stepped at a third of a lot instead of a whole one:
#        every radial in the archetype joins the ring, and at the coarse phase
#        60 of 60 candidates landed on a radial and were refused, so the square
#        had frontage on paper and no lots in fact
#      * decoration slots are rounded to integral elmos BEFORE the test that
#        keeps them out of lots, not after
PLANNER_VERSION = 2

WATER_LEVEL = 0.0          # Spring's default; `passable_mask` uses the same

# A town narrower than about two blocks is a cluster, not a town — see
# `_block_pitch`. The widest archetype's pitch is ~600 elmos, so this is the
# radius at which the smallest archetype still gets three parallel streets.
# scenario_templates.CLUSTER_TEMPLATES['town'] uses 420, which is the radius
# of the SCATTER placement this planner replaces; it is too tight for streets
# and `plan_town` says so by name rather than quietly emitting a hamlet.
DEFAULT_RADIUS = 760


class SiteRejected(Exception):
    """This ground cannot hold a town. Carries the failing measurements.

    Raised rather than returned because every caller so far wants to try the
    next candidate site, and a silently-degraded town on a cliff face is the
    failure mode this whole module exists to make impossible.
    """

    def __init__(self, message: str, score: "SiteScore | None" = None):
        super().__init__(message)
        self.score = score


# ==========================================================================
# Seeded primitives
# ==========================================================================
# Behaviourally identical to scenariogen.py's `_pick_weighted` / `_pick_int`.
# Deliberately duplicated rather than imported: scenariogen is the module that
# will import THIS one once towns reach emitted scenarios, and a shared import
# in the other direction would close the cycle. Twelve lines is cheaper than a
# fourth module, and the contract (rnd.random() only) is the thing that must
# match, not the code.

def _pick_weighted(rnd, items: list[tuple]) -> tuple:
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
    if hi <= lo:
        return lo
    return lo + min(hi - lo, int(rnd.random() * (hi - lo + 1)))


def _jitter(rnd, amount: float) -> float:
    """Symmetric noise in [-amount, +amount]."""
    return (rnd.random() * 2.0 - 1.0) * amount


def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else (hi if v > hi else v)


# ==========================================================================
# Terrain sampling
# ==========================================================================

class SiteProbe:
    """Read-only terrain queries, in ELMO coordinates.

    Wraps a heightmap in exactly the convention `regions_from_map` reads it in:
    `heights[z * W + x]` in metres, sample spacing `ELMOS_PER_SQUARE`, water at
    or below `WATER_LEVEL`. `mask` — when supplied — is one of
    `scenariogen.Terrain.masks`, i.e. a real per-movement-class passability
    mask; the planner then refuses to route a street across ground the engine's
    own grading calls impassable, rather than re-deriving that judgement.
    """

    __slots__ = ("heights", "W", "H", "elmos", "mask", "water_level")

    def __init__(self, heights, W: int, H: int, elmos: int = ELMOS_PER_SQUARE,
                 mask=None, water_level: float = WATER_LEVEL):
        self.heights, self.W, self.H = heights, W, H
        self.elmos, self.mask, self.water_level = elmos, mask, water_level

    @classmethod
    def from_terrain(cls, terrain, mclass: str | None = None) -> "SiteProbe":
        """A probe over a `scenariogen.Terrain`, sharing its mask.

        `mclass` defaults to the terrain's STRICTEST class — a town's streets
        should be usable by the heaviest thing the scenario stages, and grading
        them on INFANTRY would lay a main street up a 40-degree bank.
        """
        mclass = mclass or terrain.strictest()
        return cls(terrain.heights, terrain.W, terrain.H, ELMOS_PER_SQUARE,
                   terrain.masks[mclass])

    # -- raw samples --------------------------------------------------------

    def sample_of(self, x: float, z: float) -> tuple[int, int]:
        sx = int(round(x / self.elmos))
        sz = int(round(z / self.elmos))
        return (max(0, min(self.W - 1, sx)), max(0, min(self.H - 1, sz)))

    def in_bounds(self, x: float, z: float) -> bool:
        return 0 <= x <= (self.W - 1) * self.elmos and \
               0 <= z <= (self.H - 1) * self.elmos

    def height(self, x: float, z: float) -> float:
        sx, sz = self.sample_of(x, z)
        return self.heights[sz * self.W + sx]

    def slope_deg(self, x: float, z: float) -> float:
        """Steepest of the four axis neighbours, in degrees.

        The same measure `passable_mask` grades on, so a street this module
        calls buildable is a street that module calls passable.
        """
        sx, sz = self.sample_of(x, z)
        i = sz * self.W + sx
        h = self.heights[i]
        steep = 0.0
        if sx > 0:
            steep = max(steep, abs(h - self.heights[i - 1]))
        if sx < self.W - 1:
            steep = max(steep, abs(h - self.heights[i + 1]))
        if sz > 0:
            steep = max(steep, abs(h - self.heights[i - self.W]))
        if sz < self.H - 1:
            steep = max(steep, abs(h - self.heights[i + self.W]))
        return math.degrees(math.atan2(steep, self.elmos))

    def submerged(self, x: float, z: float) -> bool:
        return self.height(x, z) < self.water_level

    def passable(self, x: float, z: float) -> bool:
        if self.mask is None:
            return True
        sx, sz = self.sample_of(x, z)
        return bool(self.mask[sz * self.W + sx])

    def buildable(self, x: float, z: float, max_slope: float) -> bool:
        return (self.in_bounds(x, z) and not self.submerged(x, z)
                and self.passable(x, z) and self.slope_deg(x, z) <= max_slope)


# ==========================================================================
# Site analysis
# ==========================================================================

@dataclass(frozen=True)
class SiteRules:
    """Thresholds a patch of ground must clear to hold a town.

    Every one of these is a REFUSAL, not a preference — preferences live in
    `SiteScore.score`. Split that way because the brief asks for two different
    things: rank candidate sites (score), and refuse steep or wet ones (these).

    CALIBRATED AGAINST scenariogen, NOT AGAINST INTUITION. `Terrain.
    footprint_clear` grades buildable ground as VEH-passable ground — 32
    degrees — on the stated grounds that this substrate has no separate
    buildability grade. A town wants flatter ground than a lone bunker, so
    these sit well inside that, but the first cut sat FAR inside it (11-degree
    lots, 15-degree ground) and the result was measurable: swept across every
    region of four shipped maps, sites that passed the disc test then produced
    one to six lots, because real map noise failed the per-lot corner check
    almost everywhere. A "town" of two buildings is a refusal wearing a
    success's clothes. Widened until real terrain yields real towns while
    `demo_probe("cliffs")` and `demo_probe("lake")` are still refused, which is
    what the negative controls in the test suite pin.
    """
    max_build_slope: float = 22.0      # a sample steeper than this is not buildable
    max_lot_slope: float = 18.0        # ...and a LOT may not contain one this steep
    # 32 metres across a ~200-elmo parcel is roughly 9 degrees, i.e. the cap
    # that matches `max_lot_slope` rather than quietly overriding it. At 26 it
    # did override it: on 5-degree rolling ground the relief test, not the
    # slope test, was what threw lots away, and the town thinned out for a
    # reason none of the messages named.
    max_lot_relief: float = 32.0       # metres of fall across a single lot
    max_street_slope: float = 26.0     # a carriageway may climb harder than a lot
    min_buildable: float = 0.55        # fraction of the site disc
    min_core_buildable: float = 0.75   # ...of the inner third, which must be solid
    max_mean_slope: float = 16.0       # degrees, averaged over the disc
    max_p90_slope: float = 34.0        # the steep tail, not just the average
    max_submerged: float = 0.12        # fraction of the disc under water
    edge_margin: float = 240.0         # elmos of map border the disc must clear
    # A site can clear every measurement above and still, once streets are
    # walked and lots carved, hold three buildings. That is not a town with
    # streets, it is the scatter `scenariogen.place_cluster` already does — so
    # it is refused by name and the caller tries the next region, rather than
    # shipping a "town" the player would read as three sheds.
    min_lots: int = 5


@dataclass(frozen=True)
class SiteScore:
    """What the terrain under a candidate town centre measures.

    Purely a function of the heightmap — no rng reaches any field here, so two
    seeds looking at one patch of ground agree about what that ground is, and
    only disagree about what to build on it.
    """
    x: int
    z: int
    radius: int
    buildable_fraction: float
    core_buildable_fraction: float
    submerged_fraction: float
    mean_slope: float
    p90_slope: float
    relief: float
    water_adjacency: float
    water_point: tuple[int, int] | None
    contour_heading: float             # radians; the direction of least climb
    anisotropy: float                  # 0 = flat/undirected, 1 = a strong axis
    score: float
    reasons: tuple[str, ...] = ()

    @property
    def ok(self) -> bool:
        return not self.reasons

    def to_dict(self) -> dict:
        return {
            "x": self.x, "z": self.z, "radius": self.radius,
            "buildable_fraction": round(self.buildable_fraction, 4),
            "core_buildable_fraction": round(self.core_buildable_fraction, 4),
            "submerged_fraction": round(self.submerged_fraction, 4),
            "mean_slope": round(self.mean_slope, 3),
            "p90_slope": round(self.p90_slope, 3),
            "relief": round(self.relief, 3),
            "water_adjacency": round(self.water_adjacency, 4),
            "water_point": list(self.water_point) if self.water_point else None,
            "contour_heading": round(self.contour_heading, 5),
            "anisotropy": round(self.anisotropy, 4),
            "score": round(self.score, 4),
            "reasons": list(self.reasons),
        }


def score_site(probe: SiteProbe, x: float, z: float, radius: int,
               rules: SiteRules | None = None) -> SiteScore:
    """Measure the disc of radius `radius` around (x, z). Never raises.

    Sampling is on a fixed stride derived from the radius rather than on every
    heightmap sample: a 420-elmo town disc is ~110x110 samples, and the
    generator scores dozens of candidate sites per map. The stride is a
    function of the radius alone, so it is not a source of seed-dependence.
    """
    rules = rules or SiteRules()
    stride = max(probe.elmos, int(radius / 9) // probe.elmos * probe.elmos or probe.elmos)
    r2 = float(radius * radius)
    core_r2 = (radius / 3.0) ** 2

    n = core_n = 0
    buildable = core_buildable = submerged = 0
    slopes: list[float] = []
    hmin, hmax = float("inf"), float("-inf")
    # Plane-fit accumulators (least squares of h over x, z), used only for the
    # contour heading — the axis a street should follow to avoid climbing.
    sx = sz = sh = sxx = szz = sxz = sxh = szh = 0.0

    zz = -radius
    while zz <= radius:
        xx = -radius
        while xx <= radius:
            d2 = xx * xx + zz * zz
            if d2 > r2:
                xx += stride
                continue
            px, pz = x + xx, z + zz
            n += 1
            h = probe.height(px, pz)
            s = probe.slope_deg(px, pz)
            slopes.append(s)
            hmin, hmax = min(hmin, h), max(hmax, h)
            wet = h < probe.water_level
            if wet:
                submerged += 1
            ok = (not wet) and probe.passable(px, pz) and s <= rules.max_build_slope
            if ok:
                buildable += 1
            if d2 <= core_r2:
                core_n += 1
                if ok:
                    core_buildable += 1
            # Normalised to the disc so the fit is scale-free and the
            # accumulators cannot overflow into float noise on a big radius.
            u, v = xx / float(radius), zz / float(radius)
            sx += u
            sz += v
            sh += h
            sxx += u * u
            szz += v * v
            sxz += u * v
            sxh += u * h
            szh += v * h
            xx += stride
        zz += stride

    if n == 0:                       # a zero radius; degenerate but not a crash
        return SiteScore(int(x), int(z), radius, 0.0, 0.0, 1.0, 90.0, 90.0,
                         0.0, 0.0, None, 0.0, 0.0, -99.0, ("empty",))

    slopes.sort()
    mean_slope = sum(slopes) / n
    p90 = slopes[min(n - 1, int(n * 0.9))]
    frac_b = buildable / float(n)
    frac_core = core_buildable / float(core_n) if core_n else 0.0
    frac_w = submerged / float(n)
    relief = (hmax - hmin) if hmax > hmin else 0.0

    heading, aniso = _contour_axis(n, sx, sz, sh, sxx, szz, sxz, sxh, szh, radius)
    adj, wpt = _water_adjacency(probe, x, z, radius)

    # Ranking, not gating. Water NEARBY is a positive (a town wants a river);
    # water UNDER the town is `frac_w`, which the rules refuse outright.
    score = (2.0 * frac_b
             + 1.0 * frac_core
             - mean_slope / 18.0
             - 3.0 * frac_w
             + 0.45 * adj
             - _clamp(relief / 90.0, 0.0, 1.0))

    reasons: list[str] = []
    if not probe.in_bounds(x - radius - rules.edge_margin, z - radius - rules.edge_margin) or \
       not probe.in_bounds(x + radius + rules.edge_margin, z + radius + rules.edge_margin):
        reasons.append("offmap")
    if frac_w > rules.max_submerged:
        reasons.append(f"wet: {frac_w:.0%} of the site is under water "
                       f"(max {rules.max_submerged:.0%})")
    if mean_slope > rules.max_mean_slope:
        reasons.append(f"steep: mean slope {mean_slope:.1f} deg "
                       f"(max {rules.max_mean_slope:.1f})")
    if p90 > rules.max_p90_slope:
        reasons.append(f"steep: 90th-percentile slope {p90:.1f} deg "
                       f"(max {rules.max_p90_slope:.1f})")
    if frac_b < rules.min_buildable:
        reasons.append(f"unbuildable: only {frac_b:.0%} of the site is "
                       f"buildable (min {rules.min_buildable:.0%})")
    if frac_core < rules.min_core_buildable:
        reasons.append(f"unbuildable core: {frac_core:.0%} of the town centre "
                       f"is buildable (min {rules.min_core_buildable:.0%})")

    return SiteScore(int(round(x)), int(round(z)), int(radius), frac_b, frac_core,
                     frac_w, mean_slope, p90, relief, adj, wpt, heading, aniso,
                     score, tuple(reasons))


def _contour_axis(n, sx, sz, sh, sxx, szz, sxz, sxh, szh, radius):
    """Least-squares plane over the disc → (contour heading, anisotropy).

    The gradient of the fitted plane points straight uphill; a street that
    wants to avoid climbing runs perpendicular to it. That is the whole reason
    this is a plane fit and not a slope average: a slope average says HOW steep
    the site is, and the town needs to know WHICH WAY.

    Anisotropy is the fitted plane's own tilt, normalised so that 8 degrees —
    a valley floor or a shoulder, not a cliff — reads as a fully directional
    site. Near-zero means the ground has no opinion, and the caller then takes
    a seeded axis instead of pretending the terrain chose one.
    """
    # Centre the accumulators, then solve the 2x2 normal equations.
    mx, mz, mh = sx / n, sz / n, sh / n
    cxx = sxx - n * mx * mx
    czz = szz - n * mz * mz
    cxz = sxz - n * mx * mz
    cxh = sxh - n * mx * mh
    czh = szh - n * mz * mh
    det = cxx * czz - cxz * cxz
    if abs(det) < 1e-9:
        return 0.0, 0.0
    # gu, gv are metres of rise per NORMALISED unit; divide by radius for
    # metres per elmo, which is what an angle can be taken of.
    gu = (cxh * czz - czh * cxz) / det
    gv = (czh * cxx - cxh * cxz) / det
    gx, gz = gu / radius, gv / radius
    mag = math.hypot(gx, gz)
    if mag < 1e-7:
        return 0.0, 0.0
    plane_deg = math.degrees(math.atan(mag))
    # Perpendicular to the uphill gradient, folded into [0, pi): a street axis
    # is undirected, and leaving it in [0, 2pi) would make two identical
    # layouts compare unequal.
    heading = math.atan2(gx, -gz) % math.pi
    return heading, _clamp(plane_deg / 8.0, 0.0, 1.0)


def _water_adjacency(probe: SiteProbe, x: float, z: float, radius: int):
    """How much water sits just OUTSIDE the town, and the nearest wet point.

    Measured on an annulus from the site edge out to 2x the radius, on a
    16-spoke fixed sampling — deliberately coarse and rng-free. A town scores
    for being near a river; it is refused for standing in one, and those are
    two different measurements on purpose.
    """
    best = None
    hits = total = 0
    for spoke in range(16):
        ang = spoke * math.tau / 16.0
        cs, sn = math.cos(ang), math.sin(ang)
        step = max(probe.elmos, radius // 8)
        d = radius
        while d <= radius * 2:
            px, pz = x + cs * d, z + sn * d
            total += 1
            if probe.in_bounds(px, pz) and probe.height(px, pz) < probe.water_level:
                hits += 1
                if best is None or d < best[0]:
                    best = (d, int(round(px)), int(round(pz)))
            d += step
    if total == 0:
        return 0.0, None
    return hits / float(total), (best[1], best[2]) if best else None


def pick_site(probe: SiteProbe, x: float, z: float, radius: int,
              search: float = 0.0, stride: float = 0.0,
              rules: SiteRules | None = None
              ) -> tuple[SiteScore | None, list[SiteScore]]:
    """Best acceptable site within `search` elmos of (x, z), plus the rejects.

    Rng-free by construction — the offsets are a fixed lattice and the winner
    is the best score with a coordinate tie-break. Where a town STANDS is a
    property of the map; only what gets built there is seeded.

    Returns `(site or None, all_scored)`. The second element is what a caller
    reports when nothing passed: "here are the six places I looked and why each
    was refused" beats "no site".
    """
    rules = rules or SiteRules()
    search = search if search > 0 else radius * 1.2
    stride = stride if stride > 0 else max(probe.elmos * 4, radius / 3.0)

    offsets: list[tuple[float, float]] = [(0.0, 0.0)]
    steps = int(search / stride)
    for iz in range(-steps, steps + 1):
        for ix in range(-steps, steps + 1):
            if ix == 0 and iz == 0:
                continue
            ox, oz = ix * stride, iz * stride
            if math.hypot(ox, oz) <= search:
                offsets.append((ox, oz))

    scored = [score_site(probe, x + ox, z + oz, radius, rules) for ox, oz in offsets]
    passing = [s for s in scored if s.ok]
    if not passing:
        return None, scored
    passing.sort(key=lambda s: (-s.score, s.x, s.z))
    return passing[0], scored


# ==========================================================================
# Geometry
# ==========================================================================

def _seg_len(a, b) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def polyline_length(pts) -> float:
    return sum(_seg_len(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def point_at(pts, s: float) -> tuple[float, float, float]:
    """(x, z, heading) at arclength `s` along a polyline. Clamped at both ends."""
    if len(pts) < 2:
        return pts[0][0], pts[0][1], 0.0
    acc = 0.0
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        seg = _seg_len(a, b)
        if seg <= 1e-9:
            continue
        if acc + seg >= s or i == len(pts) - 2:
            t = _clamp((s - acc) / seg, 0.0, 1.0)
            return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t,
                    math.atan2(b[1] - a[1], b[0] - a[0]))
        acc += seg
    a, b = pts[-2], pts[-1]
    return b[0], b[1], math.atan2(b[1] - a[1], b[0] - a[0])


def _longest_buildable_run(pts, probe: SiteProbe, max_slope: float,
                           min_len: float) -> list:
    """The longest contiguous stretch of `pts` that stands on usable ground.

    This is how the planner ADAPTS rather than fails: a grid avenue that runs
    into a bluff keeps the half of itself that is on the flat and drops the
    rest, so the town frays at the terrain instead of refusing to exist.
    Returns [] when nothing survives at usable length.
    """
    best: list = []
    run: list = []
    for p in pts:
        if probe.buildable(p[0], p[1], max_slope):
            run.append(p)
        else:
            if polyline_length(run) > polyline_length(best):
                best = run
            run = []
    if polyline_length(run) > polyline_length(best):
        best = run
    return best if len(best) >= 2 and polyline_length(best) >= min_len else []


def _obb_corners(cx, cz, half_w, half_d, heading):
    """Four corners of an oriented box: `half_w` along the heading, `half_d` across."""
    ch, sh = math.cos(heading), math.sin(heading)
    ux, uz = ch * half_w, sh * half_w
    vx, vz = -sh * half_d, ch * half_d
    return [(cx - ux - vx, cz - uz - vz), (cx + ux - vx, cz + uz - vz),
            (cx + ux + vx, cz + uz + vz), (cx - ux + vx, cz - uz + vz)]


def _obb_overlap(a_corners, b_corners) -> bool:
    """Separating-axis test on two convex quads. Touching does not count."""
    for quad in (a_corners, b_corners):
        for i in range(4):
            ax, az = quad[i]
            bx, bz = quad[(i + 1) % 4]
            nx, nz = -(bz - az), (bx - ax)
            mag = math.hypot(nx, nz)
            if mag < 1e-9:
                continue
            nx, nz = nx / mag, nz / mag
            a_lo = min(nx * p[0] + nz * p[1] for p in a_corners)
            a_hi = max(nx * p[0] + nz * p[1] for p in a_corners)
            b_lo = min(nx * p[0] + nz * p[1] for p in b_corners)
            b_hi = max(nx * p[0] + nz * p[1] for p in b_corners)
            if a_hi <= b_lo or b_hi <= a_lo:
                return False
    return True


def _point_in_obb(px, pz, cx, cz, half_w, half_d, heading) -> bool:
    dx, dz = px - cx, pz - cz
    ch, sh = math.cos(heading), math.sin(heading)
    return abs(dx * ch + dz * sh) <= half_w and abs(-dx * sh + dz * ch) <= half_d


def _convex_hull(points) -> list:
    """Monotone chain. Input is deduplicated and sorted, so the hull is stable."""
    pts = sorted(set((round(p[0], 3), round(p[1], 3)) for p in points))
    if len(pts) <= 2:
        return list(pts)

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper: list = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def _facing_of(heading: float) -> str:
    """Spring's facing keyword for a heading, where +z is south.

    `Spring.CreateUnit` takes these strings straight (game_scenario.lua:308),
    and the quadrant boundaries are at the diagonals so a lot fronting a
    45-degree street picks a side rather than flickering between two.
    """
    a = heading % math.tau
    if a < math.pi / 4 or a >= 7 * math.pi / 4:
        return "east"
    if a < 3 * math.pi / 4:
        return "south"
    if a < 5 * math.pi / 4:
        return "west"
    return "north"


class _Bucket:
    """Uniform spatial hash, so lot-vs-street tests stay linear in town size.

    Buckets are read in insertion order and nothing derived from them reaches
    output unsorted — this is a lookup structure, not a source of ordering.
    """

    __slots__ = ("cell", "grid")

    def __init__(self, cell: float = 128.0):
        self.cell = cell
        self.grid: dict[tuple[int, int], list] = {}

    def add(self, x, z, payload):
        self.grid.setdefault((int(x // self.cell), int(z // self.cell)),
                             []).append(payload)

    def near(self, x, z, reach: float):
        cx, cz = int(x // self.cell), int(z // self.cell)
        span = int(reach // self.cell) + 1
        out = []
        for dz in range(-span, span + 1):
            for dx in range(-span, span + 1):
                out.extend(self.grid.get((cx + dx, cz + dz), ()))
        return out


# ==========================================================================
# Street construction
# ==========================================================================

@dataclass(frozen=True)
class Street:
    key: str
    name: str
    kind: str                     # main | street | lane | ring | plaza
    width: int
    points: tuple

    def length(self) -> float:
        return polyline_length(self.points)

    def to_dict(self) -> dict:
        return {"key": self.key, "name": self.name, "kind": self.kind,
                "width": self.width,
                "points": [[int(p[0]), int(p[1])] for p in self.points],
                "length": int(round(self.length()))}


def _flat_walk(rnd, probe: SiteProbe, x: float, z: float, heading: float,
               step: float, max_steps: int, wander: float, jitter: float,
               max_slope: float, bound: tuple[float, float, float],
               max_deviation: float = 1.2) -> list:
    """Walk from (x, z) choosing, each step, the flattest way forward.

    This is the whole terrain-adaptation mechanism for the two non-grid
    archetypes: `wander` is how far the street may swing per step, so a lane
    with wander 0.55 rad curls around a knoll a grid avenue would climb. The
    walk stops at impassable ground rather than tunnelling through it, and
    `max_deviation` keeps it from spiralling back into the town it left.

    `bound` is (cx, cz, radius) — the town disc the street must stay inside.
    """
    cx, cz, radius = bound
    out = [(x, z)]
    base = heading
    for _ in range(max_steps):
        best = None
        # Two sweeps: the nominal fan first, and — only if nothing in it was
        # usable — a wider one before giving up. Without the second sweep a
        # spine stopped dead at the first knoll it could not step over, and
        # across four shipped maps that capped real towns at two or three
        # lots. Going AROUND an obstacle is the behaviour "adapts to terrain"
        # is asking for; stopping at one is just refusing quietly.
        for spread in (wander, wander * 2.4):
            for i in range(7):
                frac = (i / 6.0 - 0.5) * 2.0            # -1 .. +1
                h = heading + frac * spread
                if abs(((h - base + math.pi) % math.tau) - math.pi) > max_deviation:
                    continue
                nx, nz = x + math.cos(h) * step, z + math.sin(h) * step
                if not probe.buildable(nx, nz, max_slope):
                    continue
                if math.hypot(nx - cx, nz - cz) > radius:
                    continue
                cost = (probe.slope_deg(nx, nz)
                        + abs(frac) * 2.5            # prefer carrying straight on
                        + abs(probe.height(nx, nz) - probe.height(x, z)) * 0.8
                        + rnd.random() * jitter)
                if best is None or cost < best[0]:
                    best = (cost, nx, nz, h)
            if best is not None:
                break
        if best is None:
            break
        _, x, z, heading = best
        out.append((x, z))
    return out


def _block_pitch(arch) -> float:
    """Distance between parallel streets that two rows of lots actually fit in.

    The template's `spacing` is a FLOOR, not the answer. A block has to hold,
    back to back: half a carriageway, a setback and a full lot depth — twice —
    plus a rear gap so the two rows do not share a boundary. Measured before
    this existed: a 260 spacing against a 96 lot depth put every lot from one
    street 28 elmos inside the lot behind it, and the overlap test then threw
    away three lots in five. The town was not "sparse", it was mis-specified.
    """
    lot_side = arch["main_width"] / 2.0 + arch["setback"] + arch["lot_depth"]
    return max(float(arch["spacing"]), 2.0 * lot_side + 60.0)


def min_radius_for(archetype: str) -> int:
    """Smallest town radius that archetype can lay out as streets, not a row.

    One block pitch across the middle plus a lot depth at each edge — i.e. the
    radius at which a grid gets three parallel streets rather than one.
    """
    arch = STREET_ARCHETYPES[archetype]
    return int(_block_pitch(arch) * 0.5 + arch["lot_depth"] + arch["frontage"])


def _street_name(rnd, index: int) -> str:
    head = STREET_NAMES[_pick_int(rnd, 0, len(STREET_NAMES) - 1)]
    tail = STREET_SUFFIXES[_pick_int(rnd, 0, len(STREET_SUFFIXES) - 1)]
    return f"{head} {tail}"


def _mk(streets, rnd, kind, width, pts) -> None:
    if len(pts) < 2:
        return
    key = f"st_{len(streets):02d}"
    streets.append(Street(key, _street_name(rnd, len(streets)), kind, int(width),
                          tuple((int(round(p[0])), int(round(p[1])))
                                for p in pts)))


def _build_grid_quarter(rnd, probe, site, arch, distortion, rules) -> list:
    """Two sheared families of parallel lines. Flat ground, surveyed.

    Distortion enters as SHEAR rather than as wander: a surveyed quarter laid
    out on ground that is not quite flat comes out as a parallelogram, not as
    a set of wiggles, and shearing keeps the blocks convex so lots still carve
    cleanly out of them.
    """
    cx, cz, R = float(site.x), float(site.z), float(site.radius)
    # WHERE THE GRID POINTS WHEN THE GROUND DOES NOT SAY.
    # With a real axis under it the grid follows the contour, and a town laid
    # out along the lie of the land is the whole point of the archetype. With
    # no axis (`anisotropy <= 0.12` — flat, open, undirected ground) the first
    # cut drew a uniform angle over the half-circle, which is defensible right
    # up until you look at one: a surveyed quarter has no reason to prefer 40
    # degrees, but the ENGINE does. `Spring.CreateUnit` builds on four cardinal
    # facings only (see town_stager's header), so on a grid at 45 degrees every
    # single building in the town presents a CORNER to its street instead of a
    # face — and because a grid shares one heading pair across all its streets,
    # that is not a few awkward lots, it is the entire town. Rendered, seed 3
    # on flat ground came out as buildings loose in the blocks with roads
    # threading between them; nobody would call it a street.
    #
    # So the free choice is spent near a cardinal instead of uniformly. The
    # offset keeps towns from being identically axis-aligned rectangles, and
    # at +/-14 degrees a building still reads as facing its street. This is
    # narrowing an arbitrary choice, not overriding a terrain-driven one — when
    # the ground HAS an axis the contour still wins, corners and all.
    if site.anisotropy > 0.12:
        theta = site.contour_heading
    else:
        theta = (math.pi / 2.0) * float(_pick_int(rnd, 0, 1)) + _jitter(rnd, 0.245)
    spacing = _block_pitch(arch)
    shear = math.tan(arch["max_shear"] * distortion) * (1.0 if rnd.random() < 0.5 else -1.0)
    nudge = min(spacing * 0.06, 30.0) * distortion
    lines = max(1, int(R / spacing))
    step = 56.0

    streets: list = []
    for axis in (0, 1):
        ang = theta + (math.pi / 2.0 if axis else 0.0)
        ux, uz = math.cos(ang), math.sin(ang)
        nx, nz = -uz, ux
        k = shear if axis == 0 else -shear
        for line in range(-lines, lines + 1):
            offset = line * spacing + _jitter(rnd, min(spacing * 0.05, 18.0) * distortion)
            pts = []
            t = -R
            while t <= R:
                o = offset + k * t
                px, pz = cx + ux * t + nx * o, cz + uz * t + nz * o
                if nudge > 0.0:
                    # Slide the point across the street to the flatter of three
                    # candidates. Capped at a tenth of a block so the grid stays
                    # legible as a grid.
                    best = None
                    for d in (-nudge, 0.0, nudge):
                        qx, qz = px + nx * d, pz + nz * d
                        c = probe.slope_deg(qx, qz)
                        if best is None or c < best[0]:
                            best = (c, qx, qz)
                    px, pz = best[1], best[2]
                if math.hypot(px - cx, pz - cz) <= R:
                    pts.append((px, pz))
                t += step
            run = _longest_buildable_run(pts, probe, rules.max_street_slope,
                                         arch["frontage"] * 1.6)
            if not run:
                continue
            central = (line == 0)
            kind = "main" if (central and axis == 0) else ("street" if axis == 0
                                                           else "lane")
            width = arch["main_width"] if kind == "main" else arch["lane_width"]
            _mk(streets, rnd, kind, width, run)
    return streets


def _build_main_street(rnd, probe, site, arch, distortion, rules) -> list:
    """One spine along the contour, side lanes hanging off it.

    The spine is walked in both directions from the centre rather than drawn as
    a line, because the point of this archetype is that the road came first: it
    follows the land, and the town is what accreted along it.
    """
    cx, cz, R = float(site.x), float(site.z), float(site.radius)
    theta = site.contour_heading if site.anisotropy > 0.10 else rnd.random() * math.pi
    step = 58.0
    reach = int((R * 0.98) / step)
    wander = arch["wander"] * (0.4 + 0.6 * distortion)

    fwd = _flat_walk(rnd, probe, cx, cz, theta, step, reach, wander,
                     arch["jitter"], rules.max_street_slope, (cx, cz, R))
    back = _flat_walk(rnd, probe, cx, cz, theta + math.pi, step, reach, wander,
                      arch["jitter"], rules.max_street_slope, (cx, cz, R))
    spine = list(reversed(back[1:])) + fwd
    spine = _longest_buildable_run(spine, probe, rules.max_street_slope,
                                   arch["frontage"] * 2.5)
    if len(spine) < 2:
        raise SiteRejected(
            f"main_street: no spine survives the terrain at "
            f"({site.x}, {site.z}) — the contour axis runs into ground steeper "
            f"than {rules.max_street_slope:.0f} deg within one block", site)

    streets: list = []
    _mk(streets, rnd, "main", arch["main_width"], spine)

    total = polyline_length(spine)
    lo, hi = arch["side_lane_len"]
    side = 1
    s = arch["spacing"] * 0.75
    while s < total - arch["spacing"] * 0.4:
        px, pz, h = point_at(spine, s)
        # Alternate sides, but let the seed skip one: a perfectly alternating
        # comb reads as a fish bone, not as a town.
        if rnd.random() > 0.18:
            ang = h + (math.pi / 2.0) * side
            length = _pick_int(rnd, lo, hi)
            lane = _flat_walk(rnd, probe,
                              px + math.cos(ang) * (arch["main_width"] / 2.0),
                              pz + math.sin(ang) * (arch["main_width"] / 2.0),
                              ang, 44.0, max(2, int(length / 44.0)),
                              arch["wander"] * distortion, arch["jitter"],
                              rules.max_street_slope, (cx, cz, R))
            run = _longest_buildable_run(lane, probe, rules.max_street_slope,
                                         arch["frontage"] * 0.9)
            if run:
                _mk(streets, rnd, "lane", arch["lane_width"], run)
        side = -side
        s += arch["spacing"] * (0.8 + 0.4 * rnd.random())

    # A back lane: the spine offset by one block depth, trimmed to whatever
    # ground it finds. It is what turns a ribbon of frontage into two.
    if rnd.random() < arch["back_lane_odds"]:
        bside = 1 if rnd.random() < 0.5 else -1
        off = _block_pitch(arch)
        pts = []
        s = 0.0
        while s <= total:
            px, pz, h = point_at(spine, s)
            ang = h + (math.pi / 2.0) * bside
            pts.append((px + math.cos(ang) * off, pz + math.sin(ang) * off))
            s += 56.0
        run = _longest_buildable_run(pts, probe, rules.max_street_slope,
                                     arch["frontage"] * 1.6)
        if run:
            _mk(streets, rnd, "street", arch["lane_width"], run)
    return streets


def _build_organic_cluster(rnd, probe, site, arch, distortion, rules) -> list:
    """A plaza, radials that wander, and part-rings that only join what they can.

    Nothing here is drawn to a survey. The radials are walks, the rings are
    arcs that get trimmed wherever the ground refuses them, and a ring that
    survives only between two of the five radials is a correct outcome, not a
    degraded one.
    """
    cx, cz, R = float(site.x), float(site.z), float(site.radius)
    plaza_r = arch["plaza_radius"]
    streets: list = []

    # The plaza itself, as a closed octagonal ring — lots front it exactly as
    # they front any other street, which is what makes it a place.
    plaza = []
    for i in range(9):
        a = i * math.tau / 8.0
        plaza.append((cx + math.cos(a) * plaza_r, cz + math.sin(a) * plaza_r))
    _mk(streets, rnd, "plaza", arch["main_width"], plaza)

    n_rad = _pick_int(rnd, *arch["radials"])
    base = rnd.random() * math.tau
    spread = math.tau / n_rad
    angles: list[float] = []
    for i in range(n_rad):
        angles.append(base + i * spread + _jitter(rnd, spread * 0.30))
    angles.sort()

    radial_keys: list[tuple[float, str]] = []
    for ang in angles:
        start = (cx + math.cos(ang) * plaza_r, cz + math.sin(ang) * plaza_r)
        walk = _flat_walk(rnd, probe, start[0], start[1], ang, 50.0,
                          int((R - plaza_r) / 50.0) + 1,
                          arch["wander"] * (0.5 + 0.5 * distortion),
                          arch["jitter"], rules.max_street_slope, (cx, cz, R))
        run = _longest_buildable_run(walk, probe, rules.max_street_slope,
                                     arch["frontage"] * 0.9)
        if not run:
            continue
        _mk(streets, rnd, "street", arch["lane_width"], run)
        radial_keys.append((polyline_length(run), streets[-1].key))

    if not radial_keys:
        raise SiteRejected(
            f"organic_cluster: no radial leaves the plaza at "
            f"({site.x}, {site.z}) — the ground around the centre is steeper "
            f"than {rules.max_street_slope:.0f} deg in every direction", site)

    # The two longest radials become the main streets. Promotion by length,
    # tie-broken on key, so this is not a dict-order decision.
    radial_keys.sort(key=lambda t: (-t[0], t[1]))
    promote = {k for _l, k in radial_keys[:2]}
    for i, s in enumerate(streets):
        if s.key in promote:
            streets[i] = Street(s.key, s.name, "main", arch["main_width"], s.points)

    for _ring in range(_pick_int(rnd, *arch["rings"])):
        frac = 0.45 + rnd.random() * 0.40
        r = plaza_r + (R - plaza_r) * frac
        a0 = angles[_pick_int(rnd, 0, len(angles) - 1)]
        span = spread * _pick_int(rnd, 2, max(2, len(angles) - 1))
        pts = []
        a = a0
        while a <= a0 + span:
            pts.append((cx + math.cos(a) * r, cz + math.sin(a) * r))
            a += max(0.06, 48.0 / max(r, 1.0))
        run = _longest_buildable_run(pts, probe, rules.max_street_slope,
                                     arch["frontage"] * 1.1)
        if run:
            _mk(streets, rnd, "ring", arch["lane_width"], run)
    return streets


_BUILDERS = {
    "grid_quarter": _build_grid_quarter,
    "main_street": _build_main_street,
    "organic_cluster": _build_organic_cluster,
}


def archetype_weights(site: SiteScore) -> list[tuple[str, float]]:
    """Relative odds of each street archetype on this ground. No rng.

    Terrain picks the shape, the seed only breaks the tie — which is the
    brief's "pattern choice driven by terrain" read literally. Every weight is
    floored well above zero so no archetype becomes unreachable: a map with no
    flat ground anywhere would otherwise never produce a grid, and the
    archetype-coverage guarantee would silently become terrain-dependent.

    Roughness is read off MEAN SLOPE, not off absolute relief, and that is a
    correctness point rather than a taste one: relief grows with the town's
    own radius, so keying on it made a 900-radius town "more organic" than a
    600-radius town on identical ground. Swept over four shipped maps, that
    scale bug alone made `grid_quarter` unreachable on every real site — a
    1520-elmo disc has 60 metres of relief on ground a surveyor would call
    flat. Slope is scale-free and says what was actually meant.

    Returned as a sorted list of pairs, never a dict, because it feeds a
    weighted draw and dict order must not reach output.
    """
    flat = site.buildable_fraction
    rough = _clamp(site.mean_slope / 10.0, 0.0, 1.0)
    aniso = site.anisotropy
    wet = site.water_adjacency

    grid = 0.40 + 2.4 * max(0.0, flat - 0.60) - 1.4 * rough - 0.9 * aniso
    main = 0.55 + 1.9 * aniso + 0.7 * wet + 0.5 * (1.0 - rough) * aniso
    org = 0.45 + 1.9 * rough + 1.3 * max(0.0, 0.78 - flat) + 0.8 * wet

    out = [("grid_quarter", grid), ("main_street", main),
           ("organic_cluster", org)]
    return [(k, max(0.10, w)) for k, w in sorted(out)]


def choose_archetype(rnd, site: SiteScore) -> str:
    return _pick_weighted(rnd, [(k, w) for k, w in archetype_weights(site)])[0]


def distortion_of(site: SiteScore) -> float:
    """How hard the terrain pushes the pattern out of shape, 0..1. No rng.

    Slope-driven for the same scale-free reason as `archetype_weights`: a big
    town on gentle ground is not a distorted town.
    """
    return _clamp(0.12
                  + _clamp(site.mean_slope / 9.0, 0.0, 1.0) * 0.62
                  + (1.0 - site.buildable_fraction) * 0.55
                  + _clamp(site.p90_slope / 60.0, 0.0, 1.0) * 0.25, 0.0, 1.0)


# ==========================================================================
# Lots
# ==========================================================================

@dataclass
class Lot:
    key: str
    street: str
    x: int
    z: int
    width: int                 # frontage, along the street
    depth: int                 # back from the street
    heading: float             # radians, along the street
    facing: str                # cardinal the BUILDING faces: towards the street
    role: str = "bulk"
    defname: str | None = None
    dist_to_centre: float = 0.0
    height: float = 0.0
    side: int = 1

    def corners(self):
        return _obb_corners(self.x, self.z, self.width / 2.0, self.depth / 2.0,
                            self.heading)

    def to_dict(self) -> dict:
        return {"key": self.key, "street": self.street, "x": self.x, "z": self.z,
                "width": self.width, "depth": self.depth,
                "heading": round(self.heading, 5), "facing": self.facing,
                "role": self.role, "def": self.defname,
                "corners": [[int(round(c[0])), int(round(c[1]))]
                            for c in self.corners()]}


def _street_bucket(streets) -> _Bucket:
    """Every carriageway sampled into a spatial hash, with its clearance.

    Built once and shared by lot carving AND lot growth. Keeping growth out of
    it was a real bug: a meeting hall grown to its template frontage reached
    across a cross-street the carve had carefully avoided, and the road then
    ran through the building.
    """
    bucket = _Bucket(160.0)
    for s in streets:
        clear = s.width / 2.0 + 10.0
        total = s.length()
        d = 0.0
        while d <= total:
            px, pz, _h = point_at(s.points, d)
            bucket.add(px, pz, (px, pz, clear, s.key))
            d += 24.0
    return bucket


def _carve_lots(rnd, probe, site, streets, arch, rules) -> list:
    """Lots along every street, both sides, terrain-checked one at a time.

    Frontage-first: a lot is a slice of STREET, offset back by the setback,
    oriented to the carriageway. That ordering is what gives the towns their
    look — buildings sit square to the road that made them, and a street that
    curves takes its buildings around with it.
    """
    lot_bucket = _Bucket(160.0)
    street_bucket = _street_bucket(streets)

    lots: list = []
    cx, cz, R = float(site.x), float(site.z), float(site.radius)
    fw, fd = float(arch["frontage"]), float(arch["lot_depth"])

    for s in streets:
        total = s.length()
        if total < fw:
            continue
        # THE PLAZA IS STEPPED FINELY, AND EVERYTHING ELSE IS NOT.
        # A lot is a slice of street taken at a fixed interval from an
        # arbitrary starting phase, which is right for a street — the phase is
        # invisible and the rhythm is even. It is wrong for the plaza, because
        # the plaza is the one street with other streets JOINING it: every
        # radial in the archetype leaves from this ring, and a candidate lot
        # whose phase drops it on a radial is refused by the carriageway test.
        #
        # Measured: across 12 organic towns, 60 of 60 plaza candidates were
        # refused, every one of them for hitting a radial — the plaza had
        # frontage on paper and NO lots in fact, which is why an organic town
        # rendered as a roundabout with buildings a street away from it rather
        # than as a square with a market on it. The gaps between radials are
        # wide enough (about 340 elmos of arc against a 190-elmo lot at six
        # radials); the coarse phase simply never landed in one.
        #
        # Stepping at a third of the frontage gives each gap three chances to
        # be found. It cannot produce overlapping lots — `_lot_fits` still
        # rejects a candidate that touches one already taken — so the finer
        # step buys placement, not density.
        step = fw / 3.0 if s.kind == "plaza" else fw
        d = fw * 0.5
        while d <= total - fw * 0.5:
            px, pz, h = point_at(s.points, d)
            # The plaza is a closed ring, and lots may only front it from
            # OUTSIDE. Which of +1/-1 that is depends on the ring's winding, so
            # it is measured rather than assumed: taking the sign on trust put
            # the meeting hall in the middle of the square, roofing over the
            # one open space the archetype exists to create.
            if s.kind == "plaza":
                out = h + math.pi / 2.0
                away = (math.hypot(px + math.cos(out) * 16.0 - cx,
                                   pz + math.sin(out) * 16.0 - cz)
                        > math.hypot(px - cx, pz - cz))
                sides = (1,) if away else (-1,)
            else:
                sides = (1, -1)
            for side in sides:
                ang = h + (math.pi / 2.0) * side
                back = s.width / 2.0 + arch["setback"] + fd / 2.0
                lx = px + math.cos(ang) * back
                lz = pz + math.sin(ang) * back
                if math.hypot(lx - cx, lz - cz) > R * 1.04:
                    continue
                lot = Lot(key=f"lot_{len(lots):03d}", street=s.key,
                          x=int(round(lx)), z=int(round(lz)),
                          width=int(fw), depth=int(fd), heading=h,
                          facing=_facing_of(ang + math.pi), side=side)
                if not _lot_fits(lot, probe, rules, lot_bucket, street_bucket,
                                 s.key):
                    continue
                lot.dist_to_centre = math.hypot(lx - cx, lz - cz)
                lot.height = probe.height(lx, lz)
                lots.append(lot)
                lot_bucket.add(lot.x, lot.z, lot)
            d += step
    return lots


def _lot_fits(lot: Lot, probe, rules, lot_bucket, street_bucket,
              own_street: str) -> bool:
    """Every reason a carved parcel is not actually a parcel.

    Order matters only for speed — the terrain tests are cheap and reject most
    candidates, so they run before the geometric ones.
    """
    corners = lot.corners()
    probes = corners + [(lot.x, lot.z)]
    heights = []
    for px, pz in probes:
        if not probe.buildable(px, pz, rules.max_lot_slope):
            return False
        heights.append(probe.height(px, pz))
    # A lot that straddles a step is not flat ground with a slope, it is two
    # terraces — and a building dropped on it floats over one of them.
    if max(heights) - min(heights) > rules.max_lot_relief:
        return False

    reach = math.hypot(lot.width, lot.depth) / 2.0
    for other in lot_bucket.near(lot.x, lot.z, reach + 120.0):
        if _obb_overlap(corners, other.corners()):
            return False
    return not _hits_a_carriageway(lot.x, lot.z, lot.width, lot.depth,
                                   lot.heading, own_street, street_bucket, reach)


def _hits_a_carriageway(cx, cz, w, d, heading, own_street, street_bucket,
                        reach) -> bool:
    """Does any road run through this parcel?

    Two different tests, because the street a lot FRONTS is not a hazard to it
    — the lot is offset from that one by the setback, and applying the
    clearance margin there would reject every lot in the town. Its own street
    counts only if the road actually re-enters the parcel, which a curved lane
    looping back on itself really does.
    """
    for px, pz, clear, skey in street_bucket.near(cx, cz, reach + 80.0):
        if skey == own_street:
            if _point_in_obb(px, pz, cx, cz, w / 2.0, d / 2.0, heading):
                return True
            continue
        if _point_in_obb(px, pz, cx, cz, w / 2.0 + clear, d / 2.0 + clear,
                         heading):
            return True
    return False


def _assign_roles(rnd, site, streets, lots, hull) -> None:
    """Turn a field of identical parcels into a town with a centre.

    Scarce roles draw first (ROLE_ORDER), each against the siting preferences
    in LOT_ROLES[...]["wants"], each preference normalised across the lots so
    "central" and "low" can be added together at all. The meeting hall is
    `unique = True` and therefore assigned exactly once — that is a contract
    the scenario layer points objectives at, not a flavour knob.
    """
    if not lots:
        return
    kinds = {s.key: s.kind for s in streets}
    cx, cz = float(site.x), float(site.z)

    hull_d = {}
    for lot in lots:
        best = 1e9
        for i in range(len(hull)):
            a, b = hull[i], hull[(i + 1) % len(hull)]
            best = min(best, _point_seg_dist(lot.x, lot.z, a, b))
        hull_d[lot.key] = best

    wx = site.water_point
    raw = {
        "central": {l.key: -l.dist_to_centre for l in lots},
        "edge": {l.key: l.dist_to_centre for l in lots},
        "low": {l.key: -l.height for l in lots},
        "corner": {l.key: -hull_d[l.key] for l in lots},
        "main": {l.key: (1.0 if kinds.get(l.street) == "main" else 0.0)
                 for l in lots},
        "plaza": {l.key: (1.0 if kinds.get(l.street) == "plaza" else 0.0)
                  for l in lots},
        "water": {l.key: (-math.hypot(l.x - wx[0], l.z - wx[1]) if wx else 0.0)
                  for l in lots},
    }
    norm = {}
    for want in sorted(raw):
        vals = raw[want]
        lo = min(vals.values())
        hi = max(vals.values())
        span = (hi - lo) or 1.0
        norm[want] = {k: (v - lo) / span for k, v in vals.items()}

    # A seeded nudge per lot, drawn once and reused for every role, so the
    # ordering is jittered but self-consistent — drawing per role would let the
    # market and the hall disagree about which lot is "the good one".
    nudge = {l.key: rnd.random() for l in sorted(lots, key=lambda l: l.key)}

    # One budget for every non-dwelling role together, so a town's character
    # scales with its size: a five-lot hamlet gets a meeting hall and nothing
    # else, a twenty-lot town gets the market, the silo and the watchtower.
    # The per-role `cap` is a ceiling within this, not an entitlement.
    budget = max(1, int(round(len(lots) * SCARCE_SHARE)))

    scarce = [r for r in ROLE_ORDER if r != "bulk"]

    taken: set[str] = set()
    by_key = {l.key: l for l in lots}
    for idx, role in enumerate(ROLE_ORDER):
        spec = LOT_ROLES[role]
        if role == "bulk":
            for l in lots:
                if l.key not in taken:
                    l.role = "bulk"
            break
        wants = spec["wants"]
        if spec.get("unique"):
            # The meeting hall is drawn FIRST and is never budgeted away — the
            # `unique = True` contract is exactly one per town, and a town too
            # small to afford one is a town this planner should have refused.
            want_n = 1
        else:
            # Hold back one slot for each role still to come, so the budget is
            # SPREAD rather than eaten by whoever draws first. Without this the
            # markets took the whole allowance every time and no town on any
            # shipped map ever got a water works or a grain silo — 0 in 103.
            later = len(scarce) - idx - 1
            left = budget - len(taken)
            reserve = min(later, max(0, left - 1))
            cap = min(spec.get("cap", 1), max(0, left - reserve))
            want_n = _pick_int(rnd, 1 if cap >= 1 else 0, cap)
        if want_n <= 0:
            continue

        weights = [1.0, 0.6, 0.35, 0.2]
        ranked = []
        for l in sorted(lots, key=lambda l: l.key):
            if l.key in taken:
                continue
            v = 0.0
            for i, want in enumerate(wants):
                v += norm[want][l.key] * weights[min(i, len(weights) - 1)]
            v += nudge[l.key] * 0.18
            ranked.append((-v, l.key))
        ranked.sort()
        for _v, key in ranked[:want_n]:
            by_key[key].role = role
            taken.add(key)


def _point_seg_dist(px, pz, a, b) -> float:
    ax, az = a
    bx, bz = b
    vx, vz = bx - ax, bz - az
    m2 = vx * vx + vz * vz
    if m2 < 1e-9:
        return math.hypot(px - ax, pz - az)
    t = _clamp(((px - ax) * vx + (pz - az) * vz) / m2, 0.0, 1.0)
    return math.hypot(px - (ax + vx * t), pz - (az + vz * t))


def _grow_lots(lots, probe, rules, streets) -> None:
    """Give the scarce roles the frontage their template asks for, if it exists.

    A meeting hall on a shanty-sized parcel is not the parley venue the brief
    describes, so the lot is grown to LOT_ROLES[...]["lot_size"] — but only
    when the enlarged box still stands on buildable ground and still clears its
    neighbours. Growth failing is fine and silent: the role keeps the parcel it
    has, and whoever stages the building deals with the smaller footprint.
    """
    bucket = _Bucket(160.0)
    for l in lots:
        bucket.add(l.x, l.z, l)
    streets_b = _street_bucket(streets)
    for lot in sorted(lots, key=lambda l: l.key):
        spec = LOT_ROLES.get(lot.role)
        if not spec:
            continue
        want_w, want_d = spec["lot_size"]
        if want_w <= lot.width and want_d <= lot.depth:
            continue
        # Try the full parcel first, then progressively less of it. A hall that
        # can only take half the extra frontage should take half, not none —
        # on a grid the block leaves ~60 elmos of slack and an all-or-nothing
        # growth therefore never fired at all.
        for frac in (1.0, 0.66, 0.33):
            w = max(float(lot.width), lot.width + (want_w - lot.width) * frac)
            d = max(float(lot.depth), lot.depth + (want_d - lot.depth) * frac)
            # Growing back from the street, not around the centre: the frontage
            # line must stay put or the building steps into the carriageway.
            shift = (d - lot.depth) / 2.0
            ang = lot.heading + (math.pi / 2.0) * lot.side
            nx = lot.x + math.cos(ang) * shift
            nz = lot.z + math.sin(ang) * shift
            # Snap to the integral box that will actually be STORED, before
            # testing it. Testing the float box and storing the rounded one
            # left neighbouring lots overlapping by a hundredth of an elmo —
            # geometrically nothing, but the overlap invariant is either true
            # or it is not, and a consumer asserting it would fail.
            nx, nz = float(round(nx)), float(round(nz))
            w, d = float(int(w)), float(int(d))
            grown = _obb_corners(nx, nz, w / 2.0, d / 2.0, lot.heading)
            if any(not probe.buildable(c[0], c[1], rules.max_lot_slope)
                   for c in grown):
                continue
            reach = math.hypot(w, d) / 2.0
            if any(_obb_overlap(grown, other.corners())
                   for other in bucket.near(nx, nz, reach + 140.0)
                   if other.key != lot.key):
                continue
            # The same carriageway test the carve applied. Growth used to skip
            # it, and a widened hall then reached across the cross-street.
            if _hits_a_carriageway(nx, nz, w, d, lot.heading, lot.street,
                                   streets_b, reach):
                continue
            lot.x, lot.z = int(nx), int(nz)
            lot.width, lot.depth = int(w), int(d)
            break


# ==========================================================================
# Perimeter and decoration
# ==========================================================================

@dataclass(frozen=True)
class WallPiece:
    key: str
    part: str                  # wall | corner | gate | tower
    x: int
    z: int
    heading: float
    span: int

    def to_dict(self) -> dict:
        return {"key": self.key, "part": self.part, "x": self.x, "z": self.z,
                "heading": round(self.heading, 5), "span": self.span}


def _build_perimeter(rnd, site, streets, hull) -> list:
    """Wall spans, corner posts, towers, and a gate wherever a street leaves.

    Gates are derived, not decorated: the perimeter is cut where a street
    actually crosses it, so a walled town is never sealed against its own road
    network. A town whose streets all die inside the hull simply gets no gate,
    which is the correct answer for a dead-end hamlet.
    """
    if len(hull) < 3:
        return []
    span = PERIMETER["span"]

    # Where does each street cross the hull? Sampled along the polyline rather
    # than solved analytically: the hull is convex, the streets are dense
    # polylines, and a sampled crossing is accurate to half a sample.
    exits: list[tuple[float, float]] = []
    for s in sorted(streets, key=lambda s: s.key):
        prev_in = None
        total = s.length()
        d = 0.0
        while d <= total:
            px, pz, _h = point_at(s.points, d)
            inside = _point_in_polygon(px, pz, hull)
            if prev_in is not None and inside != prev_in:
                exits.append((px, pz))
            prev_in = inside
            d += 20.0

    pieces: list = []
    idx = 0
    for i in range(len(hull)):
        a, b = hull[i], hull[(i + 1) % len(hull)]
        seg = _seg_len(a, b)
        heading = math.atan2(b[1] - a[1], b[0] - a[0])
        n = max(1, int(round(seg / span)))
        step = seg / n
        for j in range(n):
            t = (j + 0.5) * step
            px = a[0] + (b[0] - a[0]) * (t / seg)
            pz = a[1] + (b[1] - a[1]) * (t / seg)
            part = "wall"
            if any(math.hypot(px - ex, pz - ez) <= PERIMETER["gate_width"]
                   for ex, ez in exits):
                part = "gate"
            elif j == 0:
                part = "corner"
            elif (j % PERIMETER["tower_every"]) == 0:
                part = "tower"
            pieces.append(WallPiece(f"wall_{idx:03d}", part, int(round(px)),
                                    int(round(pz)), heading, int(round(step))))
            idx += 1
    return pieces


def _point_in_polygon(px, pz, poly) -> bool:
    inside = False
    n = len(poly)
    for i in range(n):
        ax, az = poly[i]
        bx, bz = poly[(i + 1) % n]
        if (az > pz) != (bz > pz):
            x_at = ax + (pz - az) * (bx - ax) / ((bz - az) or 1e-9)
            if px < x_at:
                inside = not inside
    return inside


@dataclass(frozen=True)
class DecorSlot:
    key: str
    kind: str
    x: int
    z: int
    heading: float
    street: str

    def to_dict(self) -> dict:
        return {"key": self.key, "kind": self.kind, "x": self.x, "z": self.z,
                "heading": round(self.heading, 5), "street": self.street}


def _build_decor(rnd, probe, rules, streets, lots) -> list:
    """Clutter slots along the street edges, skipping anything already claimed.

    Emitted as slots with a KIND ("crate", "tarp", ...), never as defs: whether
    a crate ends up a feature, a supply-dump prop, or nothing is the consuming
    step's decision, and this module has no business naming content.
    """
    bucket = _Bucket(160.0)
    for l in lots:
        bucket.add(l.x, l.z, l)
    out: list = []
    for s in sorted(streets, key=lambda s: s.key):
        total = s.length()
        d = DECOR["every"] * 0.5
        while d <= total:
            px, pz, h = point_at(s.points, d)
            for side in (1, -1):
                if rnd.random() > DECOR["odds"]:
                    continue
                ang = h + (math.pi / 2.0) * side
                off = s.width / 2.0 + DECOR["offset"]
                # Round FIRST, then test — the integral point is the one that
                # will be stored, so it is the one the invariant is about.
                # `_grow_lots` learned this the same way and says so in its own
                # comment; this function was written without it and the bug sat
                # latent until a change upstream shifted the rng stream enough
                # to land a slot on a lot's edge. It was a real miss, not a
                # rounding curiosity: the float point sat 105.227 elmos across a
                # parcel whose half-width is 105.0 — outside, correctly kept —
                # and rounding pulled it to exactly 105.0, which `_point_in_obb`
                # counts as inside. A crate in the middle of somebody's house.
                qx = float(round(px + math.cos(ang) * off))
                qz = float(round(pz + math.sin(ang) * off))
                if not probe.buildable(qx, qz, rules.max_street_slope):
                    continue
                if any(_point_in_obb(qx, qz, l.x, l.z, l.width / 2.0,
                                     l.depth / 2.0, l.heading)
                       for l in bucket.near(qx, qz, 200.0)):
                    continue
                kind = DECOR["kinds"][_pick_int(rnd, 0, len(DECOR["kinds"]) - 1)]
                out.append(DecorSlot(f"dec_{len(out):03d}", kind,
                                     int(qx), int(qz), h, s.key))
            d += DECOR["every"]
    return out


# ==========================================================================
# The graph
# ==========================================================================

@dataclass(frozen=True)
class TownGraph:
    key: str
    name: str
    seed: int
    archetype: str
    x: int
    z: int
    radius: int
    distortion: float
    site: SiteScore
    streets: tuple
    lots: tuple
    perimeter: tuple
    decor: tuple
    walled: bool
    planner_version: int = PLANNER_VERSION
    hull: tuple = ()

    def role_counts(self) -> list[tuple[str, int]]:
        return [(r, sum(1 for l in self.lots if l.role == r))
                for r in ROLE_ORDER]

    def terrain_ops(self) -> list[dict]:
        """ROADS v1 — the cleared/flattened strips a street implies.

        See this module's header for why this is a strip list and not a road:
        the wire ships the heightmap once (schemas/protocol.fbs:1763) and
        carries no delta, so a scenario cannot draw one. `flatten` is advisory
        and marks the strips worth cut-and-filling if the consumer is terragen
        (which bakes before packaging); `clear` is unconditional and means
        "no features, no clutter, no vegetation here".
        """
        ops = []
        for s in self.streets:
            ops.append({
                "op": "clear_strip",
                "street": s.key,
                "kind": s.kind,
                "width": s.width,
                "clear_width": int(s.width + 24),
                "flatten": s.kind in ("main", "plaza"),
                "points": [[int(p[0]), int(p[1])] for p in s.points],
            })
        return ops

    def to_dict(self) -> dict:
        """A JSON-able dump. Key order is fixed; nothing is a set."""
        return {
            "planner_version": self.planner_version,
            "key": self.key,
            "name": self.name,
            "seed": self.seed,
            "archetype": self.archetype,
            "x": self.x, "z": self.z, "radius": self.radius,
            "walled": self.walled,
            "distortion": round(self.distortion, 4),
            "site": self.site.to_dict(),
            "hull": [[int(round(p[0])), int(round(p[1]))] for p in self.hull],
            "streets": [s.to_dict() for s in self.streets],
            "lots": [l.to_dict() for l in self.lots],
            "perimeter": [w.to_dict() for w in self.perimeter],
            "decor": [d.to_dict() for d in self.decor],
            "terrain_ops": self.terrain_ops(),
            "role_counts": [[r, n] for r, n in self.role_counts()],
        }

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent, sort_keys=False)

    def to_lua(self) -> str:
        """The same dump as a PURE Lua table literal.

        Pure in scenariogen's sense (its invariant 1): no `require`, no
        `Spring.*`, no computed globals — so a consumer can read it with a bare
        `lua_State`, exactly as ScenarioDiscovery reads a scenario.
        """
        return "return " + _lua_value(self.to_dict(), 0) + "\n"


def _lua_value(v, depth: int) -> str:
    pad = "    " * (depth + 1)
    close = "    " * depth
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return "nil"
    if isinstance(v, int):
        return "%d" % v
    if isinstance(v, float):
        return ("%.5f" % v).rstrip("0").rstrip(".") or "0"
    if isinstance(v, str):
        return "'" + v.replace("\\", "\\\\").replace("'", "\\'") + "'"
    if isinstance(v, (list, tuple)):
        if not v:
            return "{}"
        inner = ",\n".join(pad + _lua_value(e, depth + 1) for e in v)
        return "{\n" + inner + ",\n" + close + "}"
    if isinstance(v, dict):
        if not v:
            return "{}"
        rows = []
        for k in v:                     # insertion order of to_dict(), fixed
            rows.append(f"{pad}{k} = " + _lua_value(v[k], depth + 1))
        return "{\n" + ",\n".join(rows) + ",\n" + close + "}"
    raise TypeError(f"not representable in a pure Lua literal: {type(v)}")


def plan_town(seed: int, probe: SiteProbe, x: float, z: float,
              radius: int = DEFAULT_RADIUS, index: int = 0,
              rules: SiteRules | None = None,
              archetype: str | None = None,
              search: float = 0.0,
              walled: bool | None = None) -> TownGraph:
    """Plan one town centred on (x, z). Raises `SiteRejected` on bad ground.

    `search` > 0 lets the centre migrate to the best nearby site (rng-free,
    `pick_site`); 0 pins it where the caller asked and refuses if that exact
    spot fails. Region-driven callers want the search; a test asserting "this
    cliff is refused" wants the pin.

    `archetype` overrides the terrain-and-seed choice. It exists for tests and
    for a scenario author who wants a specific look; the generator itself
    should not pass it, or the terrain adaptation the brief asks for stops
    being adaptation.
    """
    import random
    rnd = random.Random(seed)
    rules = rules or SiteRules()

    if search > 0:
        site, scored = pick_site(probe, x, z, radius, search, 0.0, rules)
        if site is None:
            raise SiteRejected(_why_no_site(x, z, radius, search, scored),
                               _closest_to_passing(scored))
    else:
        site = score_site(probe, x, z, radius, rules)
        if not site.ok:
            raise SiteRejected(
                f"({int(x)}, {int(z)}) cannot hold a town: "
                + "; ".join(site.reasons), site)

    distortion = distortion_of(site)
    archetype = archetype or choose_archetype(rnd, site)
    if archetype not in STREET_ARCHETYPES:
        raise ValueError(f"unknown archetype {archetype!r}; "
                         f"known: {', '.join(ARCHETYPES)}")
    arch = STREET_ARCHETYPES[archetype]

    # Refused by name rather than degraded. A radius under one block pitch can
    # only ever produce a single street with lots down one side, which is not
    # what any caller asking for a town wants and is exactly what the existing
    # `scenariogen.place_cluster` scatter already does better.
    if radius < min_radius_for(archetype):
        raise SiteRejected(
            f"radius {radius} is too small for a {archetype}: one block is "
            f"{_block_pitch(arch):.0f} elmos wide (two rows of "
            f"{arch['lot_depth']}-elmo lots plus carriageway), so a town needs "
            f"at least {min_radius_for(archetype)}. Use "
            f"scenariogen.place_cluster for anything smaller.", site)

    streets = _BUILDERS[archetype](rnd, probe, site, arch, distortion, rules)
    if not streets:
        raise SiteRejected(
            f"{archetype} at ({site.x}, {site.z}): no street survived the "
            f"terrain — every candidate line ran into ground steeper than "
            f"{rules.max_street_slope:.0f} degrees or under water", site)

    lots = _carve_lots(rnd, probe, site, streets, arch, rules)
    if len(lots) < rules.min_lots:
        raise SiteRejected(
            f"{archetype} at ({site.x}, {site.z}): {len(streets)} street(s) "
            f"yielded only {len(lots)} lot(s), under the {rules.min_lots} a "
            f"town needs — the frontage is mostly on ground steeper than "
            f"{rules.max_lot_slope:.0f} degrees or under water", site)

    hull_pts = []
    for l in lots:
        hull_pts.extend(l.corners())
    hull = _expand_hull(_convex_hull(hull_pts), PERIMETER["margin"])

    _assign_roles(rnd, site, streets, lots, hull or [(site.x, site.z)])
    _grow_lots(lots, probe, rules, streets)

    if walled is None:
        walled = rnd.random() < arch.get("walled_odds", 0.4)
    perimeter = tuple(_build_perimeter(rnd, site, streets, hull)) if walled else ()
    decor = tuple(_build_decor(rnd, probe, rules, streets, lots))

    key, name = name_for(index, seed)
    return TownGraph(
        key=key, name=name, seed=seed, archetype=archetype,
        x=site.x, z=site.z, radius=site.radius, distortion=distortion,
        site=site, streets=tuple(streets), lots=tuple(lots),
        perimeter=perimeter, decor=decor, walled=bool(walled),
        hull=tuple((int(round(p[0])), int(round(p[1]))) for p in hull))


def _closest_to_passing(scored: list) -> SiteScore | None:
    """The candidate that failed for the fewest reasons, best score breaking ties.

    NOT the highest-scoring one. `score` is a ranking of usable sites and does
    not penalise being off the map at all, so "best score" routinely picked a
    site whose only complaint was `offmap` out of a field where every other
    candidate was refused for being a mountainside — and the caller then went
    looking for a border problem that did not exist.
    """
    if not scored:
        return None
    return min(scored, key=lambda s: (len(s.reasons), -s.score, s.x, s.z))


def _why_no_site(x, z, radius, search, scored: list) -> str:
    """A diagnosis over the WHOLE search, not over one candidate.

    Reports what the search as a body ran into, then the nearest miss. On a
    mountainous map "18 of 21 candidates were too steep" is the finding; the
    one candidate that merely clipped the map border is noise.
    """
    if not scored:
        return f"no ground scored within {int(search)} elmos of ({int(x)}, {int(z)})"
    tally: dict[str, int] = {}
    for s in scored:
        for reason in s.reasons:
            head = reason.split(":")[0]
            tally[head] = tally.get(head, 0) + 1
    summary = ", ".join(f"{tally[k]}x {k}"
                        for k in sorted(tally, key=lambda k: (-tally[k], k)))
    best = _closest_to_passing(scored)
    return (f"no town site within {int(search)} elmos of ({int(x)}, {int(z)}) "
            f"at radius {int(radius)}; {len(scored)} candidate(s) refused "
            f"[{summary}]. Nearest miss ({best.x}, {best.z}): "
            + "; ".join(best.reasons))


def _expand_hull(hull, margin: float):
    """Push each hull vertex out from the centroid. Convex in, convex out."""
    if len(hull) < 3:
        return hull
    cx = sum(p[0] for p in hull) / len(hull)
    cz = sum(p[1] for p in hull) / len(hull)
    out = []
    for px, pz in hull:
        dx, dz = px - cx, pz - cz
        m = math.hypot(dx, dz) or 1.0
        out.append((px + dx / m * margin, pz + dz / m * margin))
    return out


def assign_defs(town: TownGraph, available) -> TownGraph:
    """Fill every lot's `defname` from the content `available` actually ships.

    Separate from `plan_town` on purpose: planning must not need map content
    loaded, and the same graph must survive the M2 defs landing (see
    town_templates.resolve_roles). Mutates the lots in place and returns the
    town, because `Lot` is the one mutable node in the graph.
    """
    from town_templates import resolve_roles
    mapping = resolve_roles(available)
    for lot in town.lots:
        lot.defname = mapping.get(lot.role)
    return town


# ==========================================================================
# Demo terrain (CLI and tests — data/maps is gitignored)
# ==========================================================================

def demo_probe(kind: str = "rolling", W: int = 257, H: int = 257,
               seed: int = 1) -> SiteProbe:
    """Synthetic terrain, so this module runs in a checkout with no map data.

    `data/maps/` is gitignored (regions_from_map.py's "anchor on the MAP dir"
    note), so a clone has none — and a planner that can only be demonstrated
    against content the clone does not have cannot be demonstrated. These are
    real heightmaps run through the real sampling; only the terrain is faked.

    Wavelengths are in ELMOS, not in fractions of the map. That distinction is
    load-bearing now that `archetype_weights` reads roughness off slope: a
    normalised fixture is a different terrain at every map size, so "rolling"
    measured as 1-degree ground on a 3072-elmo map and the archetype tests
    silently graded a different landscape than the one they named. The three
    TEXTURE kinds (flat/rolling/cliffs) are therefore world-scaled; the three
    LANDFORM kinds (valley/coast/lake) are map-scaled, because a valley that
    does not span its map is not a valley.
    """
    import random
    rnd = random.Random(seed)
    ph = [rnd.random() * math.tau for _ in range(6)]
    span_x = (W - 1) * ELMOS_PER_SQUARE
    span_z = (H - 1) * ELMOS_PER_SQUARE
    hs = []
    for zi in range(H):
        for xi in range(W):
            x, z = xi * ELMOS_PER_SQUARE, zi * ELMOS_PER_SQUARE
            u, v = x / span_x, z / span_z
            if kind == "flat":
                h = (40.0 + math.sin(x / 940.0 + ph[0]) * 1.1
                     + math.cos(z / 1120.0 + ph[1]) * 1.0)
            elif kind == "rolling":
                h = (46.0 + math.sin(x / 150.0 + ph[0]) * 17.0
                     + math.cos(z / 170.0 + ph[1]) * 15.0
                     + math.sin((x + z) / 95.0 + ph[2]) * 5.0)
            elif kind == "cliffs":
                h = (60.0 + math.sin(x / 70.0 + ph[0]) * 55.0
                     + math.cos(z / 82.0 + ph[1]) * 50.0)
            elif kind == "valley":
                h = (40.0 + (v - 0.5) ** 2 * 320.0
                     + math.sin(x / 380.0 + ph[2]) * 3.0)
            elif kind == "coast":
                h = (-25.0 + u * 130.0 + math.sin(z / 420.0 + ph[3]) * 8.0
                     + math.cos(x / 260.0 + ph[4]) * 4.0)
            elif kind == "lake":
                h = -30.0 + math.hypot(u - 0.5, v - 0.5) * 260.0
            else:
                raise ValueError(f"unknown demo terrain {kind!r}")
            hs.append(h)
    return SiteProbe(hs, W, H)


DEMO_KINDS = ["cliffs", "coast", "flat", "lake", "rolling", "valley"]


# ==========================================================================
# CLI
# ==========================================================================

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Plan a Metalstorm town's streets and lots from terrain.")
    ap.add_argument("map_dir", nargs="?",
                    help="processed map dir (data/maps/<id>); omit with --demo")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--demo", choices=DEMO_KINDS,
                    help="synthetic terrain instead of a map (data/maps is gitignored)")
    ap.add_argument("--demo-seed", type=int, default=1,
                    help="seed for the DEMO TERRAIN, held apart from --seed so "
                         "several towns can be planned on one synthetic map")
    ap.add_argument("--x", type=float, help="town centre X in elmos")
    ap.add_argument("--z", type=float, help="town centre Z in elmos")
    ap.add_argument("--region", help="place at this region's centre (map_dir only)")
    ap.add_argument("--radius", type=int, default=DEFAULT_RADIUS)
    ap.add_argument("--archetype", choices=ARCHETYPES,
                    help="override the terrain-driven choice")
    ap.add_argument("--search", type=float, default=0.0,
                    help="let the centre migrate up to this many elmos")
    ap.add_argument("--walled", dest="walled", action="store_true", default=None)
    ap.add_argument("--no-walled", dest="walled", action="store_false")
    ap.add_argument("--lua", action="store_true", help="emit a Lua table, not JSON")
    ap.add_argument("--out", help="write here instead of stdout")
    args = ap.parse_args(argv)

    if args.demo:
        # Sized FROM the radius, not fixed: `SiteRules.edge_margin` refuses a
        # town whose disc comes within 240 elmos of the border, so a demo map
        # smaller than the town being asked for rejects every seed with
        # "offmap" and looks like a planner bug rather than a fixture one.
        span = (args.radius + SiteRules().edge_margin) * 2.0 + 400.0
        n = int(span / ELMOS_PER_SQUARE) + 1
        probe = demo_probe(args.demo, W=n, H=n, seed=args.demo_seed)
        cx = args.x if args.x is not None else (probe.W - 1) * probe.elmos / 2.0
        cz = args.z if args.z is not None else (probe.H - 1) * probe.elmos / 2.0
        available = None
    elif args.map_dir:
        # Imported here, not at module scope: scenariogen will import this
        # module once towns reach emitted scenarios, and a top-level import
        # would close that cycle.
        import ms_defs
        import scenariogen as sg
        terrain, map_id = sg.load_terrain(args.map_dir, ["VEH"])
        probe = SiteProbe.from_terrain(terrain, "VEH")
        if args.region:
            regions = sg.read_region_graph(args.map_dir)
            match = [r for r in regions if r["key"] == args.region]
            if not match:
                print(f"no region {args.region!r} in {map_id}; have: "
                      + ", ".join(sorted(r["key"] for r in regions)),
                      file=sys.stderr)
                return 2
            cx, cz = sg.region_centre(match[0])
        else:
            cx = args.x if args.x is not None else (probe.W - 1) * probe.elmos / 2.0
            cz = args.z if args.z is not None else (probe.H - 1) * probe.elmos / 2.0
        repo_root = os.path.abspath(os.path.join(args.map_dir, "..", "..", ".."))
        game_dir = os.path.join(repo_root, "data", "games", "metalstorm")
        available = ms_defs.load(game_dir) if os.path.isdir(game_dir) else None
    else:
        ap.error("give a map dir or --demo")
        return 2

    try:
        town = plan_town(args.seed, probe, cx, cz, args.radius,
                         archetype=args.archetype, search=args.search,
                         walled=args.walled)
    except SiteRejected as exc:
        print(f"REJECTED: {exc}", file=sys.stderr)
        return 1

    if available is not None:
        assign_defs(town, available)

    text = town.to_lua() if args.lua else town.to_json() + "\n"
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
        counts = ", ".join(f"{r}={n}" for r, n in town.role_counts() if n)
        print(f"{town.name} [{town.archetype}] seed {town.seed}: "
              f"{len(town.streets)} streets, {len(town.lots)} lots ({counts}), "
              f"{len(town.perimeter)} wall pieces, {len(town.decor)} decor "
              f"-> {args.out}", file=sys.stderr)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
