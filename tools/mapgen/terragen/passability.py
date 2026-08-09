"""Movement-class passability: can armour actually drive between the starts?

PLAN-maps.md M8x. This is the generator-side half of the reading
`regions_from_map.py --verify` takes on a *packaged* map, moved back to where
the terrain is still an array so the generator can answer the question and
then fix it before it writes an SMF.

Why it matters: a map whose start positions sit in different connected
components for a movement class is a map that class cannot play. That has
been the running defect of every generated map this lane has shipped —
`skerry_reach` splits 8 starts into 8 components for all three classes, and
`sundered_arc` shipped with INFANTRY passing and VEH/HEAVY split 3/5 (M8w
FIND 3). An archipelago generator produces that by construction: erosion
carves straits, and a strait is exactly a line a vehicle cannot cross.


The grading
-----------

`passable()` mirrors Spring's MoveDef test as `regions_from_map.py` reads it
(`data/games/metalstorm/.../moveinfo.tdf`): a sample is passable for a class
when its steepest axis-neighbour slope is within `max_slope_deg` and, if it
is under water, the depth is within `max_water_depth`. The two tables are
checked against each other in `tests/test_passability.py` — they must not
drift, because the generator would then certify a map the verifier rejects.


The fix, and why it is a sill and not a bridge
----------------------------------------------

`connect_starts()` raises the **seabed** along the shallowest crossing until
it is a wadeable ford, i.e. it builds a sill (a tombolo, geologically) rather
than a land bridge or a `features/bridges.lua` span. Three reasons:

1. A Spring unit drives on the heightmap. A bridge *feature* is scenery — it
   does not make the water under it passable — so the bridge option in the
   queue could never have moved this reading at all.
2. The arc's straits are cut by `arc_uplift`'s cross-strike breaks, which cut
   *below* the waterline by design. The shallowest one on the shipped map has
   a **32.4-elmo** sill against VEH's 20-elmo wade depth: the map misses being
   crossable by 12 elmos of seabed, not by a landform. Raising a sill is the
   smallest edit that answers it, and it stays a strait — the arc still reads
   as a sundered chain, and armour fords it.
3. It is strictly submarine (`sill_depth` is below sea level, and the carve
   only ever *raises*), so the island inventory, the land fraction, the relief
   aim and the anisotropy survey — every statistic this lane ranks arms by —
   are measured on land and cannot move.

...and the depth it stops at is a two-sided constraint, not "as shallow as
possible": `moveinfo.tdf`'s SHIP class has a `minwaterdepth`, so a sill raised
to a comfortable wading depth would make the map's only armour crossing a
naval wall. See `sill_depth_for`.

The search is a minimax: bisect the extra lift `T` for which the two
components join over cells within `max_water_depth + T`, which finds the
crossing whose deepest point is shallowest. Bisection is valid because
connectivity is monotone in `T`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage

# --- Spring MoveDef classes, from data/games/metalstorm/.../moveinfo.tdf ----
# Kept in step with `regions_from_map.MOVE_CLASSES` by a test: the generator
# certifying a map against a looser table than the verifier uses is exactly
# the failure this module exists to prevent.
MOVE_CLASSES: dict[str, "MoveClass"] = {}

ELMOS_PER_SQUARE = 8.0  # Spring: heightmap sample spacing

_STRUCT = ndimage.generate_binary_structure(2, 1)   # 4-connected, as Spring moves


@dataclass(frozen=True)
class MoveClass:
    name: str
    max_slope_deg: float
    max_water_depth: float


for _mc in (MoveClass("INFANTRY", 45.0, 12.0),
            MoveClass("VEH", 32.0, 20.0),
            MoveClass("HEAVY", 24.0, 30.0)):
    MOVE_CLASSES[_mc.name] = _mc

DEFAULT_CLASSES = ("INFANTRY", "VEH", "HEAVY")

# What `connect_starts` aims at. INFANTRY is deliberately not in it: it is the
# loosest class on slope and it already passes on every map this generator has
# written, so including it would only drag the *strictest* wade depth down
# from 20 to 12 and force the route onto the shallow shelf. A sill cut for
# armour is at -10, which infantry wades anyway, and the carve only ever adds
# terrain — so infantry connectivity cannot get worse. It is still reported.
ARMOUR_CLASSES = ("VEH", "HEAVY")

# `moveinfo.tdf` CLASS3 (SHIP) declares `minwaterdepth = 12`, and a sill is a
# two-sided constraint because of it: raise the seabed too far and the strait
# stops being a strait, so the only armour crossing on the map is also a naval
# wall. There is exactly one depth window that serves both — deeper than the
# shallowest floating draft, shallower than the wade depth — and the default
# sill sits in the middle of it (16 elmos, 4 either side). CLASS4 (SUB,
# `minwaterdepth = 20`) cannot be served at all: it wants strictly more water
# than VEH can wade, so a sill blocks submarines by construction.
SHALLOWEST_DRAFT = 12.0


# ---------------------------------------------------------------------------
# Grading
# ---------------------------------------------------------------------------

def slope_rise(h: np.ndarray, cell: float = ELMOS_PER_SQUARE) -> np.ndarray:
    """Steepest axis-neighbour rise, as a ratio (rise / run).

    Deliberately the 4-neighbour max rather than a gradient magnitude: that is
    what `regions_from_map.passable_mask` does, and a gradient reads a
    knife-edge ridge as half as steep as the step a unit has to climb.
    """
    d = np.zeros_like(h, dtype=np.float64)
    if h.shape[1] > 1:
        dx = np.abs(h[:, 1:] - h[:, :-1])
        np.maximum(d[:, 1:], dx, out=d[:, 1:])
        np.maximum(d[:, :-1], dx, out=d[:, :-1])
    if h.shape[0] > 1:
        dz = np.abs(h[1:, :] - h[:-1, :])
        np.maximum(d[1:, :], dz, out=d[1:, :])
        np.maximum(d[:-1, :], dz, out=d[:-1, :])
    return d / cell


def passable(h: np.ndarray, cell: float, mc: MoveClass,
             rise: "np.ndarray | None" = None) -> np.ndarray:
    """Per-sample passability mask for one movement class."""
    if rise is None:
        rise = slope_rise(h, cell)
    return (rise <= math.tan(math.radians(mc.max_slope_deg))) & \
           (h >= -mc.max_water_depth)


def _start_cells(starts, cell: float, shape) -> list[tuple[int, int]]:
    H, W = shape
    out = []
    for sx, sz in starts:
        out.append((int(np.clip(round(sz / cell), 0, H - 1)),
                    int(np.clip(round(sx / cell), 0, W - 1))))
    return out


def _nearest_label(lab: np.ndarray, cz: int, cx: int, radius: int = 24) -> int:
    """Label of the nearest labelled cell, searched outward in diamonds.

    Same widening search `regions_from_map._nearest_passable_component` does,
    and for the same reason: a start pad is flattened ground that can still
    sit one sample from a cliff edge our grading calls impassable.
    """
    H, W = lab.shape
    for r in range(radius):
        for dz in range(-r, r + 1):
            z = cz + dz
            if not (0 <= z < H):
                continue
            span = r - abs(dz)
            for dx in ((-span, span) if span else (0,)):
                x = cx + dx
                if 0 <= x < W and lab[z, x]:
                    return int(lab[z, x])
    return -1


@dataclass
class ConnectivityReading:
    """What `regions_from_map.py --verify` prints, taken on a live array."""
    cls: str
    passable_frac: float
    largest_frac: float
    groups: dict[int, list[int]]      # component label -> start indices
    stranded: list[int] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.stranded and len(self.groups) <= 1

    def describe(self) -> str:
        if self.stranded:
            return (f"{self.cls}: FAIL — starts on impassable ground "
                    f"{self.stranded}")
        if len(self.groups) <= 1:
            return (f"{self.cls}: PASS — all starts in one component "
                    f"({self.passable_frac:.1%} passable, largest component "
                    f"{self.largest_frac:.1%} of it)")
        parts = "; ".join(f"{sorted(v)}" for _, v in sorted(self.groups.items()))
        return (f"{self.cls}: FAIL — {len(self.groups)} components "
                f"{parts} ({self.passable_frac:.1%} passable, largest "
                f"component {self.largest_frac:.1%} of it)")


def read_connectivity(h: np.ndarray, cell: float, starts,
                      cls: "str | MoveClass",
                      rise: "np.ndarray | None" = None) -> ConnectivityReading:
    mc = MOVE_CLASSES[cls] if isinstance(cls, str) else cls
    mask = passable(h, cell, mc, rise)
    lab, _ = ndimage.label(mask, structure=_STRUCT)
    sizes = np.bincount(lab.ravel())
    sizes[0] = 0
    n_pass = int(mask.sum())
    groups: dict[int, list[int]] = {}
    stranded: list[int] = []
    for i, (cz, cx) in enumerate(_start_cells(starts, cell, h.shape)):
        c = _nearest_label(lab, cz, cx)
        if c < 0:
            stranded.append(i)
        else:
            groups.setdefault(c, []).append(i)
    return ConnectivityReading(
        cls=mc.name,
        passable_frac=n_pass / h.size,
        largest_frac=(float(sizes.max()) / n_pass) if n_pass else 0.0,
        groups=groups, stranded=stranded)


def read_all(h: np.ndarray, cell: float, starts,
             classes=DEFAULT_CLASSES) -> list[ConnectivityReading]:
    rise = slope_rise(h, cell)
    return [read_connectivity(h, cell, starts, c, rise) for c in classes]


# ---------------------------------------------------------------------------
# The fix: raise a sill across the shallowest strait
# ---------------------------------------------------------------------------

@dataclass
class Crossing:
    """One carved sill, as a record for the plan file and the log."""
    cls: str                      # the class whose split it was carved for
    joined: tuple[int, int]       # start indices, one from each side
    sill_lift: float              # elmos of extra depth the search had to allow
    deepest_before: float         # deepest point on the chosen route, elmos
    length_elmos: float
    centre: tuple[float, float]   # elmo coords
    cells_raised: int
    max_raise: float


def strictest(classes=DEFAULT_CLASSES) -> MoveClass:
    """The class no real class is stricter than, on both axes at once.

    This is what makes one carve answer every class: `passable(strictest)` is
    a subset of `passable(c)` for every `c` in `classes`, and a connected
    subset stays connected inside a superset. So all starts sharing one
    *strictest* component is a sufficient condition for all of them to pass —
    no per-class carving, and no chance of joining VEH while leaving HEAVY
    split behind a 30-degree ramp.
    """
    return MoveClass(
        name="+".join(classes),
        max_slope_deg=min(MOVE_CLASSES[c].max_slope_deg for c in classes),
        max_water_depth=min(MOVE_CLASSES[c].max_water_depth for c in classes))


def sill_depth_for(classes=ARMOUR_CLASSES) -> float:
    """How deep to leave the ford, in elmos below sea level.

    The middle of the window between the shallowest floating draft and the
    shallowest wade depth among `classes` — 16 elmos for VEH+HEAVY, which is
    4 elmos of margin against a ship grounding and 4 against a tank drowning.
    Falls back to half the wade depth if no such window exists.
    """
    wade = min(MOVE_CLASSES[c].max_water_depth for c in classes)
    if SHALLOWEST_DRAFT < wade:
        return 0.5 * (SHALLOWEST_DRAFT + wade)
    return 0.5 * wade


def _search_mask(h, rise, tan_limit, depth, lift):
    """Cells a route may run through if we allow `lift` more elmos of depth.

    Only the *depth* limit is relaxed, never the slope one, so the route is
    already slope-legal before anything is carved and the carve — which
    flattens what it crosses — can only improve it. Relaxing slope too was
    tried first and is a trap: it lets the route follow the steep inner edge
    of the shallow shelf, and on `sundered_arc` that turned a 1.4 km strait
    crossing into a 20 km ribbon around the coastline, raising 1.1 % of the
    map instead of 0.3 %.
    """
    return (h >= -(depth + lift)) & (rise <= tan_limit)


def _geodesic_path(mask, src, dst, max_steps=6000):
    """Shortest 4-connected path from `src` to `dst` inside `mask`.

    Layered dilation rather than a heap: the frontier is a whole array op, so
    this costs one dilation per step of path length instead of one heap pop
    per cell, which on a 2049^2 grid is the difference between a second and a
    minute.
    """
    dist = np.full(mask.shape, -1, np.int32)
    frontier = src & mask
    if not frontier.any():
        return None
    dist[frontier] = 0
    reached = None
    for step in range(1, max_steps + 1):
        nxt = ndimage.binary_dilation(frontier, _STRUCT) & mask & (dist < 0)
        if not nxt.any():
            return None
        dist[nxt] = step
        hit = nxt & dst
        if hit.any():
            zs, xs = np.nonzero(hit)
            reached = (int(zs[0]), int(xs[0]))
            break
        frontier = nxt
    if reached is None:
        return None
    # walk back down the step numbers
    path = [reached]
    z, x = reached
    H, W = mask.shape
    while dist[z, x] > 0:
        want = dist[z, x] - 1
        for dz, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            nz, nx = z + dz, x + dx
            if 0 <= nz < H and 0 <= nx < W and dist[nz, nx] == want:
                z, x = nz, nx
                break
        else:                                   # pragma: no cover - unreachable
            break
        path.append((z, x))
    return path[::-1]


def _carve_sill(h, cell, path, sill_depth, flat_half_width, taper):
    """Raise the seabed to `-sill_depth` along `path`, tapering to nothing.

    Never lowers: `np.maximum` against the original surface, so a route that
    clips a headland leaves the headland alone.
    """
    corridor = np.zeros(h.shape, bool)
    zs = np.fromiter((p[0] for p in path), int, len(path))
    xs = np.fromiter((p[1] for p in path), int, len(path))
    corridor[zs, xs] = True
    d = ndimage.distance_transform_edt(~corridor) * cell
    t = np.clip((d - flat_half_width) / max(taper, 1e-6), 0.0, 1.0)
    w = 1.0 - t * t * (3.0 - 2.0 * t)           # smoothstep, 1 -> 0
    target = -abs(sill_depth)
    lifted = h * (1.0 - w) + target * w
    out = np.maximum(h, lifted)
    return out, int((out > h + 1e-6).sum()), float((out - h).max())


def connect_starts(h: np.ndarray, cell: float, starts,
                   classes=ARMOUR_CLASSES,
                   report_classes=DEFAULT_CLASSES,
                   sill_depth: "float | None" = None,
                   flat_half_width: float = 140.0,
                   taper: float = 300.0,
                   max_lift: float = 250.0,
                   max_crossings: int = 6,
                   log=None):
    """Carve sills until every start can reach every other, for every class.

    Returns `(h, crossings, readings)` — the modified heightmap, one
    `Crossing` per sill, and the connectivity readings *after* the work.

    `sill_depth` defaults to half the shallowest wade depth among `classes`,
    so one ford serves all of them with margin (6 elmos with INFANTRY in the
    set, 10 without).
    """
    say = log or (lambda _m: None)
    ref = strictest(classes)
    if sill_depth is None:
        sill_depth = sill_depth_for(classes)
    tan_limit = math.tan(math.radians(ref.max_slope_deg))
    crossings: list[Crossing] = []

    for _ in range(max_crossings):
        rise = slope_rise(h, cell)
        r = read_connectivity(h, cell, starts, ref, rise)
        if r.ok or r.stranded:
            break
        lab, _ = ndimage.label(passable(h, cell, ref, rise), structure=_STRUCT)

        # Which two groups to join. Biggest-first alone is not enough once a
        # map has more than two groups: the pair it lands on can be the two
        # ends of the map, and a single unreachable pair used to end the
        # whole loop. Try candidate pairs nearest-first and keep going.
        pairs = sorted(r.groups.items(), key=lambda kv: (-len(kv[1]), kv[0]))
        cands = sorted(
            ((_pair_distance(starts, sa_, sb_), i, j)
             for i, (_, sa_) in enumerate(pairs)
             for j, (_, sb_) in enumerate(pairs) if i < j),
            key=lambda t: (-len(pairs[t[1]][1]) - len(pairs[t[2]][1]), t[0]))

        chosen = None
        for _dist, i, j in cands:
            (la, sa), (lb, sb) = pairs[i], pairs[j]
            src, dst = (lab == la), (lab == lb)
            lo, hi = 0.0, None
            for probe in (4.0, 8.0, 16.0, 32.0, 64.0, 128.0, max_lift):
                probe = min(probe, max_lift)
                if _joined(h, rise, tan_limit, ref.max_water_depth,
                           probe, src, dst):
                    hi = probe
                    break
                lo = probe
                if probe >= max_lift:
                    break
            if hi is None:
                say(f"  connect: no route under a {max_lift:.0f}-elmo sill "
                    f"joins starts {sorted(sa)} and {sorted(sb)}")
                continue
            for _ in range(16):
                mid = 0.5 * (lo + hi)
                if _joined(h, rise, tan_limit, ref.max_water_depth,
                           mid, src, dst):
                    hi = mid
                else:
                    lo = mid
            mask = _search_mask(h, rise, tan_limit, ref.max_water_depth, hi)
            path = _geodesic_path(mask, src, dst)
            if path is None:                    # pragma: no cover - defensive
                say("  connect: bisection found a route but the path walk "
                    "did not")
                continue
            chosen = (sa, sb, hi, path)
            break
        if chosen is None:
            say("  connect: no pair of split groups can be joined — leaving "
                "the map as it is")
            break
        sa, sb, hi, path = chosen
        pz = np.fromiter((p[0] for p in path), int, len(path))
        px = np.fromiter((p[1] for p in path), int, len(path))
        deepest = float(-h[pz, px].min())
        h, raised, max_raise = _carve_sill(h, cell, path, sill_depth,
                                           flat_half_width, taper)
        cx = Crossing(cls=ref.name, joined=(sorted(sa)[0], sorted(sb)[0]),
                      sill_lift=float(hi), deepest_before=deepest,
                      length_elmos=len(path) * cell,
                      centre=(float(px.mean() * cell), float(pz.mean() * cell)),
                      cells_raised=raised, max_raise=max_raise)
        crossings.append(cx)
        say(f"  connect: starts {sorted(sa)} + {sorted(sb)} — sill at "
            f"({cx.centre[0]:.0f},{cx.centre[1]:.0f}), route "
            f"{cx.length_elmos:.0f} elmos, was {deepest:.1f} elmos deep, "
            f"raised {raised} cells by up to {max_raise:.1f}")

    return h, crossings, read_all(h, cell, starts, report_classes)


def _pair_distance(starts, sa, sb) -> float:
    """Closest approach between two groups, measured start to start."""
    best = float("inf")
    for i in sa:
        ax, az = starts[i]
        for j in sb:
            bx, bz = starts[j]
            best = min(best, math.hypot(ax - bx, az - bz))
    return best


def _joined(h, rise, tan_limit, depth, lift, src, dst) -> bool:
    mask = _search_mask(h, rise, tan_limit, depth, lift)
    lab, _ = ndimage.label(mask, structure=_STRUCT)
    a = np.unique(lab[src & mask])
    b = np.unique(lab[dst & mask])
    a = set(int(v) for v in a if v)
    b = set(int(v) for v in b if v)
    return bool(a & b)
