"""Prop & ground-stamp placement subsystem.

One declarative model for everything the generator drops onto a finished
heightfield: vegetation, boulders and scree/sand patches today; wreckage,
dwellings, rail lines and bridges tomorrow.

Concepts
--------
- ``PlacementContext``: read-only bundle of the terrain fields a layer may
  consult (height/slope/biomes/moisture) plus shared exclusion masks.
- ``Layer``: one placement rule = WHERE (a suitability field in [0,1]) +
  HOW (a sampler) + WHAT (an emit target).
- Emit targets:
    * ``FeatureEmit`` -> featureplacer ``objectlist`` entries (real sim
      features: trees, boulders, later wreckage/dwellings). Weighted choice
      between several feature-def names per placement.
    * ``StampEmit``   -> soft ground patches rasterized into named grid-res
      fields. The albedo baker composites them into the baked ground texture
      and ``make_splat_distr`` routes them to a detail channel — i.e. baked
      decals with zero runtime cost. (A future runtime-decal target for
      dynamic content would slot in beside these two.)
- Samplers:
    * ``scatter``     — stratified-jitter, one candidate per stratum cell,
      accepted with probability = suitability (approximate blue noise,
      deterministic; the engine behind vegetation scatter).
    * ``clusters``    — sparse seed points accepted by suitability, then a
      hashed ring of members around each seed (talus fans, boulder fields,
      debris rings around wrecks).
    * ``along_paths`` — walk the ctx.paths polylines (road network, later
      rail) at a fixed spacing with hashed dropout and lateral offset;
      placements carry the local path heading (fences, roadside debris,
      later rail sleepers / power poles). The lateral offset clears the
      polyline's OWN deck (R4d) and is then tested against every other deck
      within reach, because a normal offset cannot know the road comes back
      on itself (R5) — see `_DeckIndex`.
- ``TemplateEmit`` composes a *site* into many features: a template of
  (name, dx, dz) elements rotated by the site's hashed rotation, with
  per-element jitter and dropout — ruin circles, wall lines, later
  dwelling compounds. Sites come from whichever sampler the layer uses.

Everything is deterministic: all randomness comes from vegetation._hash01
(seeded integer hashing) keyed on layer name — no RNG order dependence.
"""
from __future__ import annotations

import zlib
from dataclasses import dataclass, field as dc_field
from typing import Callable

import numpy as np

from .vegetation import _hash01


# ---------------------------------------------------------------------------
# Context
# ---------------------------------------------------------------------------

@dataclass
class PlacementContext:
    height: np.ndarray        # (H, W) elmos, grid res
    slope_deg: np.ndarray
    biome_ids: np.ndarray
    moisture: np.ndarray
    cellsize: float
    seed: int
    exclusion: np.ndarray     # bool (H, W): no features here (roads, pads, water…)
    water_level: float = 0.0
    paths: list | None = None # list of (N,2) world-coord polylines (roads…)
    # Deck HALF-width per entry of `paths`, same order. Optional: without it
    # an along_paths layer keeps its plain centreline offset (pre-R2 behaviour).
    path_halfwidths: list[float] | None = None

    @property
    def map_w(self) -> float:
        return (self.height.shape[1] - 1) * self.cellsize

    @property
    def map_h(self) -> float:
        return (self.height.shape[0] - 1) * self.cellsize

    def sample(self, arr: np.ndarray, x: np.ndarray, z: np.ndarray) -> np.ndarray:
        """Bilinear world-coord sample of a grid-res field."""
        H, W = arr.shape
        cx = np.clip(x / self.cellsize, 0, W - 1.001)
        cz = np.clip(z / self.cellsize, 0, H - 1.001)
        c0 = cx.astype(np.int64); r0 = cz.astype(np.int64)
        fx = cx - c0; fz = cz - r0
        c1 = np.minimum(c0 + 1, W - 1); r1 = np.minimum(r0 + 1, H - 1)
        a = arr[r0, c0] * (1 - fx) + arr[r0, c1] * fx
        b = arr[r1, c0] * (1 - fx) + arr[r1, c1] * fx
        return a * (1 - fz) + b * fz

    def excluded_at(self, x: np.ndarray, z: np.ndarray) -> np.ndarray:
        return self.sample(self.exclusion.astype(np.float32), x, z) > 0.25


# ---------------------------------------------------------------------------
# Emit targets
# ---------------------------------------------------------------------------

@dataclass
class FeatureEmit:
    """Placements become featureplacer objectlist entries (sim features)."""
    names: list[tuple[str, float]]          # (feature def name, weight)
    scale_range: tuple[float, float] = (0.85, 1.2)  # recorded; the Spring
    # featureplacer format carries no per-placement scale — size variety comes
    # from multiple feature defs (different models), scale is kept for future
    # emitters that do support it.


@dataclass
class StampEmit:
    """Placements become soft discs in a named grid-res ground field."""
    stamp: str                              # field id: 'scree', 'sand', …
    radius_range: tuple[float, float] = (60.0, 140.0)   # world elmos
    strength: float = 1.0                   # peak field value per stamp


@dataclass
class TemplateEmit:
    """Each placement is a SITE expanded into a composed arrangement.

    elements: (feature def name, dx, dz, keep_prob) in site-local coords,
    rotated by the site's rotation. Each element gets hashed jitter and an
    independent dropout roll — a ruin ring loses different pillars at every
    site. Elements landing on excluded/steep ground are dropped silently.
    """
    elements: list[tuple[str, float, float, float]]
    jitter: float = 4.0                     # per-element positional jitter (elmos)
    align_elements: bool = True             # elements face the site centre


def ring_template(name: str, n: int, radius: float, keep: float,
                  phase: float = 0.0) -> list[tuple[str, float, float, float]]:
    """n elements of `name` evenly spaced on a circle — ruin colonnades."""
    out = []
    for i in range(n):
        a = phase + 2.0 * np.pi * i / n
        out.append((name, radius * np.cos(a), radius * np.sin(a), keep))
    return out


# ---------------------------------------------------------------------------
# Layer
# ---------------------------------------------------------------------------

@dataclass
class Layer:
    name: str                               # unique; keys the hash stream
    emit: FeatureEmit | StampEmit
    suitability: Callable[[PlacementContext], np.ndarray]  # -> (H,W) [0,1]
    sampler: str = "scatter"                # 'scatter' | 'clusters'
    stratum: float = 64.0                   # scatter: candidate pitch (elmos)
    max_slope_deg: float = 40.0
    respect_exclusion: bool = True          # stamps often only avoid water
    # clusters sampler:
    cluster_stratum: float = 1024.0         # seed-candidate pitch
    cluster_radius: float = 140.0           # member spread around a seed
    cluster_members: tuple[int, int] = (3, 9)
    # along_paths sampler:
    path_spacing: float = 160.0             # station pitch along the polyline
    path_offset: float = 30.0               # lateral distance from centreline
    path_offset_jitter: float = 6.0
    path_both_sides: bool = True            # hashed side pick vs always +offset
    # A lateral offset is measured from the CENTRELINE, but a road's deck is
    # per class since R2 (a highway is 1.6x the base width), so one constant
    # offset is on the verge of a track and on the CARRIAGEWAY of a highway —
    # which is what put 457 of meridian_basin's 474 highway fences on the deck.
    # When ctx.path_halfwidths is supplied the offset is raised, per polyline,
    # to clear that polyline's own deck edge by the jitter plus this margin;
    # a road narrow enough that path_offset already clears it is untouched.
    #
    # The margin is DERIVED from what the bake paints, not tuned by eye: the
    # albedo's deck edge is ragged by up to 2.6 elmos and then fades over 3
    # more (bake.py `ragged` / the /3.0 ramp), and a log fence is ~8 elmos long
    # about its own origin — so anything under ~10 leaves a prop standing on
    # tarmac even when its ORIGIN clears the geometric half-width. 2.0 was the
    # first value here and it cleared the deck while still reading as on-road
    # at ground level.
    path_min_clearance: float = 10.0
    # ...and that raise is still LOCAL: it clears the deck of the polyline the
    # station stepped off, which is the only deck a normal offset can know
    # about. `path_global_clearance` adds the other half — the position is
    # tested against EVERY nearby deck, so a hairpin's inner side is refused
    # even though it is correctly offset from its own segment. Off, it is the
    # R4d sampler exactly, which is how the hairpin defect is reproduced in
    # tests/test_roadside_offset.py.
    path_global_clearance: bool = True


@dataclass
class PlacementResult:
    features: list[tuple[str, float, float, float, float]] = dc_field(default_factory=list)
    stamps: dict[str, np.ndarray] = dc_field(default_factory=dict)

    def merged_features(self) -> list[tuple[str, float, float, float, float]]:
        return self.features


# ---------------------------------------------------------------------------
# Samplers — each returns (x, z, rot, scale_t, pick_t) column arrays
# ---------------------------------------------------------------------------

def _sample_scatter(layer: Layer, ctx: PlacementContext, suit: np.ndarray, lseed: int):
    nx = max(1, int(ctx.map_w / layer.stratum))
    nz = max(1, int(ctx.map_h / layer.stratum))
    iz, ix = np.mgrid[0:nz, 0:nx]
    ix = ix.ravel(); iz = iz.ravel()

    x = (ix + _hash01(ix, iz, lseed, 1)) * layer.stratum
    z = (iz + _hash01(ix, iz, lseed, 2)) * layer.stratum
    roll = _hash01(ix, iz, lseed, 3)
    rot = _hash01(ix, iz, lseed, 4) * 2.0 * np.pi
    scale_t = _hash01(ix, iz, lseed, 5)
    pick_t = _hash01(ix, iz, lseed, 6)

    ok = roll < ctx.sample(suit, x, z)
    ok &= ctx.sample(ctx.slope_deg, x, z) <= layer.max_slope_deg
    if layer.respect_exclusion:
        ok &= ~ctx.excluded_at(x, z)
    return x[ok], z[ok], rot[ok], scale_t[ok], pick_t[ok]


def _sample_clusters(layer: Layer, ctx: PlacementContext, suit: np.ndarray, lseed: int):
    nx = max(1, int(ctx.map_w / layer.cluster_stratum))
    nz = max(1, int(ctx.map_h / layer.cluster_stratum))
    iz, ix = np.mgrid[0:nz, 0:nx]
    ix = ix.ravel(); iz = iz.ravel()

    sx = (ix + _hash01(ix, iz, lseed, 11)) * layer.cluster_stratum
    sz = (iz + _hash01(ix, iz, lseed, 12)) * layer.cluster_stratum
    ok = _hash01(ix, iz, lseed, 13) < ctx.sample(suit, sx, sz)
    sx = sx[ok]; sz = sz[ok]
    six = ix[ok]; siz = iz[ok]
    if sx.size == 0:
        e = np.empty(0)
        return e, e, e, e, e

    lo, hi = layer.cluster_members
    counts = (lo + _hash01(six, siz, lseed, 14) * (hi - lo + 1)).astype(np.int64)
    m = int(counts.max())
    # (Nseeds, m) member lattice; member j of seed k hashed on (seed cell, j)
    mj = np.arange(m)[None, :]
    kx = six[:, None] * np.int64(1000) + mj      # unique int keys per member
    kz = siz[:, None] * np.int64(1000) + mj
    r = layer.cluster_radius * np.sqrt(_hash01(kx, kz, lseed, 15))
    th = _hash01(kx, kz, lseed, 16) * 2.0 * np.pi
    x = sx[:, None] + r * np.cos(th)
    z = sz[:, None] + r * np.sin(th)
    rot = _hash01(kx, kz, lseed, 17) * 2.0 * np.pi
    scale_t = _hash01(kx, kz, lseed, 18)
    pick_t = _hash01(kx, kz, lseed, 19)
    live = mj < counts[:, None]

    x = x.ravel(); z = z.ravel(); rot = rot.ravel()
    scale_t = scale_t.ravel(); pick_t = pick_t.ravel(); live = live.ravel()
    live &= (x >= 0) & (z >= 0) & (x < ctx.map_w) & (z < ctx.map_h)
    live &= ctx.sample(ctx.slope_deg, x, z) <= layer.max_slope_deg
    live &= ctx.sample(suit, x, z) > 0.05
    if layer.respect_exclusion:
        live &= ~ctx.excluded_at(x, z)
    return x[live], z[live], rot[live], scale_t[live], pick_t[live]


# ---------------------------------------------------------------------------
# Global deck clearance (roads R5)
# ---------------------------------------------------------------------------

def _point_segment_dist(px, pz, ax, az, bx, bz):
    """Distance from one point to each of N segments (a -> b)."""
    vx = bx - ax; vz = bz - az
    wx = px - ax; wz = pz - az
    vv = vx * vx + vz * vz
    t = np.where(vv > 1e-12, (wx * vx + wz * vz) / np.maximum(vv, 1e-12), 0.0)
    t = np.clip(t, 0.0, 1.0)
    dx = wx - t * vx; dz = wz - t * vz
    return np.hypot(dx, dz)


class _DeckIndex:
    """'Is this point clear of EVERY deck?' — a uniform-grid segment index.

    Raising a roadside offset to clear the deck is a LOCAL computation (roads
    R4d): it knows the half-width of the polyline it stepped off and nothing
    else. Where a road doubles back on itself — a hairpin, a switchback, a
    tight loop — or simply runs close to a neighbour, the normal of one segment
    points into the carriageway of a DIFFERENT vertex range, or of a different
    polyline entirely, and no per-polyline offset can see that (§2l FIND 2).

    Answering it exactly is all-pairs, candidates x segments: on a full-res
    16 k map that is ~1e4 stations against ~2e4 segments. So the segments are
    bucketed on a uniform grid whose cell is the largest required radius, and
    each segment is inserted into its own cell's 3x3 neighbourhood at build
    time. A query then reads ONE bucket and is guaranteed to have seen every
    segment that could be within its radius — one `searchsorted` per candidate
    instead of a scan over the network.

    `radii[i]` is the clearance required around polyline i (its deck
    half-width plus the margin). A polyline with radius <= 0 is not indexed —
    that is the 'no half-width supplied' case, which keeps pre-R4d behaviour.
    """

    _SPAN = 1 << 20   # cell coordinates are shifted into [0, 2^21) to key on

    def __init__(self, polylines, radii):
        self.cell = max(1.0, float(max(radii)) if len(radii) else 1.0)
        ax, az, bx, bz, rr = [], [], [], [], []
        keys, gids = [], []
        base = 0
        for poly, r in zip(polylines, radii):
            p = np.asarray(poly, dtype=np.float64)
            if p.shape[0] < 2 or r <= 0.0:
                continue
            a = p[:-1]; b = p[1:]
            n = a.shape[0]
            ax.append(a[:, 0]); az.append(a[:, 1])
            bx.append(b[:, 0]); bz.append(b[:, 1])
            rr.append(np.full(n, float(r)))
            # densify at <= half a cell so no cell the segment crosses is missed
            seglen = np.hypot(b[:, 0] - a[:, 0], b[:, 1] - a[:, 1])
            steps = np.maximum(2, np.ceil(seglen / (self.cell * 0.5)).astype(np.int64) + 1)
            si = np.repeat(np.arange(n), steps)
            starts = np.concatenate([[0], np.cumsum(steps)[:-1]])
            k = np.arange(int(steps.sum())) - np.repeat(starts, steps)
            t = k / np.maximum(np.repeat(steps, steps) - 1, 1)
            px = a[si, 0] + (b[si, 0] - a[si, 0]) * t
            pz = a[si, 1] + (b[si, 1] - a[si, 1]) * t
            cx = np.floor(px / self.cell).astype(np.int64)
            cz = np.floor(pz / self.cell).astype(np.int64)
            # 3x3 dilation at INSERT time, so a query is a single bucket read
            for ox in (-1, 0, 1):
                for oz in (-1, 0, 1):
                    keys.append(self._key(cx + ox, cz + oz))
                    gids.append(si + base)
            base += n
        if not ax:
            self.keys = np.empty(0, dtype=np.int64)
            self.gids = np.empty(0, dtype=np.int64)
            self.ax = self.az = self.bx = self.bz = self.r = np.empty(0)
            return
        self.ax = np.concatenate(ax); self.az = np.concatenate(az)
        self.bx = np.concatenate(bx); self.bz = np.concatenate(bz)
        self.r = np.concatenate(rr)
        key = np.concatenate(keys); gid = np.concatenate(gids)
        pair = np.unique(np.stack([key, gid], axis=1), axis=0)
        self.keys = np.ascontiguousarray(pair[:, 0])
        self.gids = np.ascontiguousarray(pair[:, 1])

    @classmethod
    def _key(cls, cx, cz):
        return (cx + cls._SPAN) * (cls._SPAN * 2) + (cz + cls._SPAN)

    def clear(self, x, z, tol=1e-6):
        """Bool per point: no indexed deck is closer than its own radius."""
        out = np.ones(x.shape, dtype=bool)
        if self.keys.size == 0 or x.size == 0:
            return out
        cx = np.floor(x / self.cell).astype(np.int64)
        cz = np.floor(z / self.cell).astype(np.int64)
        qk = self._key(cx, cz)
        lo = np.searchsorted(self.keys, qk, side="left")
        hi = np.searchsorted(self.keys, qk, side="right")
        for i in range(x.size):
            if hi[i] <= lo[i]:
                continue
            g = self.gids[lo[i]:hi[i]]
            d = _point_segment_dist(x[i], z[i], self.ax[g], self.az[g],
                                    self.bx[g], self.bz[g])
            if np.any(d < self.r[g] - tol):
                out[i] = False
        return out


def _deck_index_for(layer: "Layer", ctx: "PlacementContext"):
    """The index a path layer measures against, or None when it has no decks."""
    if not layer.path_global_clearance or ctx.path_halfwidths is None \
            or not ctx.paths:
        return None
    hw = ctx.path_halfwidths
    radii = [(hw[i] + layer.path_min_clearance) if i < len(hw) else 0.0
             for i in range(len(ctx.paths))]
    if not any(r > 0.0 for r in radii):
        return None
    return _DeckIndex(ctx.paths, radii)


# Populated by the last `along_paths` run that had deck half-widths to measure
# against: how many stations the global test moved to the other side, and how
# many it gave up on. A generator prints these — a rule that never fires on real
# content should say so out loud rather than be assumed to be working.
_LAST_PATH_STATS: dict = {}


def _sample_along_paths(layer: Layer, ctx: PlacementContext, suit: np.ndarray, lseed: int):
    """Stations along ctx.paths polylines. Placement rotation = local path
    heading (featureplacer convention: rotation about +Y from +X toward +Z),
    so fences and roadside props align with the way."""
    e = np.empty(0)
    if not ctx.paths:
        return e, e, e, e, e
    deck = _deck_index_for(layer, ctx)
    n_total = n_flipped = n_dropped = 0
    xs, zs, rots, sc, pk = [], [], [], [], []
    for pi, poly in enumerate(ctx.paths):
        p = np.asarray(poly, dtype=np.float64)
        if p.shape[0] < 2:
            continue
        seg = np.diff(p, axis=0)
        seglen = np.hypot(seg[:, 0], seg[:, 1])
        cum = np.concatenate([[0.0], np.cumsum(seglen)])
        total = cum[-1]
        if total < layer.path_spacing:
            continue
        n = int(total / layer.path_spacing)
        si = np.arange(n)
        pkey = np.full(n, pi, dtype=np.int64)
        phase = _hash01(pkey, si, lseed, 21) * layer.path_spacing
        s = si * layer.path_spacing + phase
        idx = np.clip(np.searchsorted(cum, s, side="right") - 1, 0, len(seglen) - 1)
        t = (s - cum[idx]) / np.maximum(seglen[idx], 1e-6)
        pos = p[idx] + seg[idx] * t[:, None]
        tang = seg[idx] / np.maximum(seglen[idx], 1e-6)[:, None]
        nrm = np.stack([-tang[:, 1], tang[:, 0]], axis=1)
        side = np.where(_hash01(pkey, si, lseed, 22) < 0.5, -1.0, 1.0) \
            if layer.path_both_sides else np.ones(n)
        base_off = layer.path_offset
        if ctx.path_halfwidths is not None and pi < len(ctx.path_halfwidths):
            base_off = max(base_off, ctx.path_halfwidths[pi]
                           + layer.path_offset_jitter + layer.path_min_clearance)
        off = base_off + (
            _hash01(pkey, si, lseed, 23) * 2.0 - 1.0) * layer.path_offset_jitter
        lat = nrm * (side * off)[:, None]
        pos_a = pos + lat
        heading = np.arctan2(tang[:, 1], tang[:, 0])
        keep = np.ones(n, dtype=bool)
        if deck is not None:
            # `base_off` clears THIS polyline's deck and can do no more. Where
            # the road comes back on itself the hashed side points into another
            # stretch of deck, so the mirrored side is tried before the station
            # is given up — on a hairpin that is the outside of the bend, which
            # is exactly where the fence belongs (roads R5).
            ok_a = deck.clear(pos_a[:, 0], pos_a[:, 1])
            if layer.path_both_sides:
                pos_b = pos - lat
                ok_b = deck.clear(pos_b[:, 0], pos_b[:, 1])
            else:
                # a one-sided layer has a reason to be on that side; it can be
                # dropped but it must not be mirrored
                pos_b = pos_a
                ok_b = ok_a
            flip = ~ok_a & ok_b
            pos_a = np.where(flip[:, None], pos_b, pos_a)
            keep = ok_a | ok_b
            n_flipped += int(flip.sum()); n_dropped += int((~keep).sum())
        n_total += n
        pos = pos_a[keep]
        heading = heading[keep]
        xs.append(pos[:, 0]); zs.append(pos[:, 1]); rots.append(heading)
        sc.append(_hash01(pkey, si, lseed, 24)[keep])
        pk.append(_hash01(pkey, si, lseed, 25)[keep])
    if deck is not None:
        _LAST_PATH_STATS[layer.name] = {"stations": n_total,
                                        "flipped": n_flipped,
                                        "dropped": n_dropped}
    if not xs:
        return e, e, e, e, e
    x = np.concatenate(xs); z = np.concatenate(zs); rot = np.concatenate(rots)
    scale_t = np.concatenate(sc); pick_t = np.concatenate(pk)
    ok = (x >= 0) & (z >= 0) & (x < ctx.map_w) & (z < ctx.map_h)
    ok &= _hash01((x * 8.0).astype(np.int64), (z * 8.0).astype(np.int64),
                  lseed, 26) < ctx.sample(suit, x, z)
    ok &= ctx.sample(ctx.slope_deg, x, z) <= layer.max_slope_deg
    if layer.respect_exclusion:
        ok &= ~ctx.excluded_at(x, z)
    return x[ok], z[ok], rot[ok], scale_t[ok], pick_t[ok]


_SAMPLERS = {"scatter": _sample_scatter, "clusters": _sample_clusters,
             "along_paths": _sample_along_paths}


# ---------------------------------------------------------------------------
# Stamp rasterization
# ---------------------------------------------------------------------------

def _rasterize_stamp(field: np.ndarray, cx: float, cz: float, radius: float,
                     strength: float, cellsize: float) -> None:
    """Additive soft disc (smoothstep falloff) into a grid-res field."""
    H, W = field.shape
    rc = radius / cellsize
    c = cx / cellsize; r = cz / cellsize
    c0 = max(0, int(c - rc) - 1); c1 = min(W, int(c + rc) + 2)
    r0 = max(0, int(r - rc) - 1); r1 = min(H, int(r + rc) + 2)
    if c0 >= c1 or r0 >= r1:
        return
    zz, xx = np.mgrid[r0:r1, c0:c1]
    d = np.sqrt((xx - c) ** 2 + (zz - r) ** 2) / max(rc, 1e-3)
    t = np.clip(1.0 - d, 0.0, 1.0)
    fall = t * t * (3.0 - 2.0 * t)          # smoothstep
    np.maximum(field[r0:r1, c0:c1], (strength * fall).astype(np.float32),
               out=field[r0:r1, c0:c1])


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

# A layer whose suitability covers less than this fraction of the map is
# reported as starving. Exported because it is a contract, not a log level:
# `tests/test_vegetation_palettes.py` holds every climate palette to the same
# floor, so a palette cannot ship a species the map has no room for.
STARVE_COVERAGE = 0.001


def run(ctx: PlacementContext, layers: list[Layer],
        progress=lambda *_: None) -> PlacementResult:
    """Evaluate all layers. Deterministic for a given (seed, layer set)."""
    out = PlacementResult()
    for layer in layers:
        lseed = (ctx.seed * 131 + zlib.crc32(layer.name.encode())) & 0x7FFFFFFF
        suit = np.clip(layer.suitability(ctx), 0.0, 1.0).astype(np.float32)
        cov = float((suit > 0).mean())
        if cov < STARVE_COVERAGE:
            progress(f"placement[{layer.name}]: WARNING suitability covers "
                     f"{cov:.4%} of the map — layer will starve")
        x, z, rot, scale_t, pick_t = _SAMPLERS[layer.sampler](layer, ctx, suit, lseed)

        if isinstance(layer.emit, TemplateEmit):
            em = layer.emit
            placed = 0
            for i in range(x.size):
                srot = float(rot[i])
                cs, sn = np.cos(srot), np.sin(srot)
                for j, (name, dx, dz, keep) in enumerate(em.elements):
                    ii = np.array([i], dtype=np.int64)
                    jj = np.array([j], dtype=np.int64)
                    if _hash01(ii, jj, lseed, 31)[0] >= keep:
                        continue
                    jx = (_hash01(ii, jj, lseed, 32)[0] * 2 - 1) * em.jitter
                    jz = (_hash01(ii, jj, lseed, 33)[0] * 2 - 1) * em.jitter
                    ex = float(x[i]) + dx * cs - dz * sn + jx
                    ez = float(z[i]) + dx * sn + dz * cs + jz
                    exa = np.array([ex]); eza = np.array([ez])
                    if not (0 <= ex < ctx.map_w and 0 <= ez < ctx.map_h):
                        continue
                    if ctx.sample(ctx.slope_deg, exa, eza)[0] > layer.max_slope_deg:
                        continue
                    if layer.respect_exclusion and ctx.excluded_at(exa, eza)[0]:
                        continue
                    if em.align_elements:
                        erot = srot + float(np.arctan2(dz, dx)) + np.pi / 2
                    else:
                        erot = _hash01(ii, jj, lseed, 34)[0] * 2 * np.pi
                    out.features.append((name, ex, ez, float(erot), 1.0))
                    placed += 1
            progress(f"placement[{layer.name}]: {x.size} sites -> {placed} features "
                     f"(suit {cov:.2%})")
        elif isinstance(layer.emit, FeatureEmit):
            names = layer.emit.names
            wsum = sum(w for _, w in names)
            edges = np.cumsum([w / wsum for _, w in names])
            idx = np.searchsorted(edges, pick_t, side="right").clip(0, len(names) - 1)
            lo, hi = layer.emit.scale_range
            sc = lo + (hi - lo) * scale_t
            for i in range(x.size):
                out.features.append(
                    (names[idx[i]][0], float(x[i]), float(z[i]), float(rot[i]), float(sc[i]))
                )
            progress(f"placement[{layer.name}]: {x.size} features (suit {cov:.2%})")
        else:
            st = layer.emit
            fld = out.stamps.setdefault(
                st.stamp, np.zeros(ctx.height.shape, dtype=np.float32))
            lo, hi = st.radius_range
            rad = lo + (hi - lo) * scale_t
            for i in range(x.size):
                _rasterize_stamp(fld, float(x[i]), float(z[i]), float(rad[i]),
                                 st.strength, ctx.cellsize)
            progress(f"placement[{layer.name}]: {x.size} stamps -> '{st.stamp}'")
    return out


# ---------------------------------------------------------------------------
# Suitability helpers (composable building blocks for layer authors)
# ---------------------------------------------------------------------------

def biome_suitability(weights: dict[int, float]) -> Callable[[PlacementContext], np.ndarray]:
    """Per-biome base weight (the vegetation-species model)."""
    def f(ctx: PlacementContext) -> np.ndarray:
        s = np.zeros(ctx.biome_ids.shape, dtype=np.float32)
        for bid, w in weights.items():
            s[ctx.biome_ids == bid] = w
        return s
    return f


def slope_window(inner, lo: float, hi: float, soft: float = 4.0):
    """Multiply a suitability by a soft slope band [lo, hi] degrees.
    lo <= 0 means no lower edge (flat ground fully suitable)."""
    def f(ctx: PlacementContext) -> np.ndarray:
        s = inner(ctx)
        sl = ctx.slope_deg
        band = np.clip((hi - sl) / soft, 0, 1)
        if lo > 0:
            band = band * np.clip((sl - lo) / soft, 0, 1)
        return s * band.astype(np.float32)
    return f


def forest_edge(forest_ids, lo: float = 0.12, hi: float = 0.55,
                sigma_world: float = 90.0):
    """1.0 in the transition band at a forest boundary (smoothed forest
    coverage between lo..hi), 0 in open ground and deep interior — where
    deadwood, stumps and windthrow accumulate. sigma_world is in elmos so
    the band width is resolution-independent (a cell-unit sigma made the
    band 4x thinner at full res than in --fast validation runs)."""
    from scipy import ndimage

    def f(ctx: PlacementContext) -> np.ndarray:
        cover = ndimage.gaussian_filter(
            np.isin(ctx.biome_ids, forest_ids).astype(np.float32),
            max(1.0, sigma_world / ctx.cellsize))
        return ((cover > lo) & (cover < hi)).astype(np.float32)
    return f


def below_cliffs(steep_deg: float = 34.0, reach_cells: int = 6):
    """1.0 near (dilated) steep terrain, 0 elsewhere — talus deposition zones."""
    from scipy import ndimage

    def f(ctx: PlacementContext) -> np.ndarray:
        steep = ctx.slope_deg > steep_deg
        near = ndimage.binary_dilation(steep, iterations=reach_cells)
        # deposition happens on the gentler ground next to the cliff, not on it
        return (near & (ctx.slope_deg < steep_deg)).astype(np.float32)
    return f


def combine(*fns, op=np.maximum):
    def f(ctx: PlacementContext) -> np.ndarray:
        out = fns[0](ctx)
        for g in fns[1:]:
            out = op(out, g(ctx))
        return out
    return f
