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
    * ``scatter``  — stratified-jitter, one candidate per stratum cell,
      accepted with probability = suitability (approximate blue noise,
      deterministic; the engine behind vegetation scatter).
    * ``clusters`` — sparse seed points accepted by suitability, then a
      hashed ring of members around each seed (talus fans, boulder fields,
      debris rings around wrecks).
  Line/network layers (roads, rail, bridge slots) are the planned third
  family: they take a polyline from roads.plan_roads instead of a
  suitability field and emit along-path placements.

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


_SAMPLERS = {"scatter": _sample_scatter, "clusters": _sample_clusters}


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

def run(ctx: PlacementContext, layers: list[Layer],
        progress=lambda *_: None) -> PlacementResult:
    """Evaluate all layers. Deterministic for a given (seed, layer set)."""
    out = PlacementResult()
    for layer in layers:
        lseed = (ctx.seed * 131 + zlib.crc32(layer.name.encode())) & 0x7FFFFFFF
        suit = np.clip(layer.suitability(ctx), 0.0, 1.0).astype(np.float32)
        x, z, rot, scale_t, pick_t = _SAMPLERS[layer.sampler](layer, ctx, suit, lseed)

        if isinstance(layer.emit, FeatureEmit):
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
            progress(f"placement[{layer.name}]: {x.size} features")
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
