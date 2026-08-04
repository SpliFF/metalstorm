"""Vegetation & rock placement: density fields -> deterministic scatter.

Density is derived from biome weights, slope, and moisture; placement uses
seeded stratified jitter (one candidate per grid stratum, accepted with
probability = local density), which approximates blue noise without RNG
order-dependence — fully deterministic for a given seed and inputs.

Output is a list of (species, x, z, rotation, scale) tuples; the packaging
layer converts these to featureplacer config entries.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage

from . import biomes as bio


@dataclass
class Species:
    name: str                      # feature def name (e.g. "tree_oak_1")
    stratum: float = 64.0          # candidate grid pitch, world units
    scale_range: tuple[float, float] = (0.85, 1.25)
    max_slope_deg: float = 26.0
    # per-biome density multiplier in [0,1]
    biome_density: dict[int, float] = field(default_factory=dict)
    moisture_bonus: float = 0.0    # extra density * moisture
    cluster_freq: float = 1.0 / 900.0  # clumping noise frequency (1/world units)
    cluster_strength: float = 0.6  # 0 = uniform, 1 = fully clumped


TEMPERATE_SPECIES = [
    Species(
        "tree_conifer", stratum=44.0,
        biome_density={bio.FOREST: 0.85, bio.GRASSLAND: 0.06, bio.TUNDRA: 0.10},
        moisture_bonus=0.25, cluster_strength=0.7, max_slope_deg=30.0,
    ),
    Species(
        "tree_broadleaf", stratum=52.0,
        biome_density={bio.FOREST: 0.55, bio.GRASSLAND: 0.10, bio.WETLAND: 0.30},
        moisture_bonus=0.35, cluster_strength=0.65, max_slope_deg=24.0,
    ),
    Species(
        "bush_scrub", stratum=38.0,
        biome_density={bio.GRASSLAND: 0.18, bio.FOREST: 0.20, bio.DESERT: 0.06,
                       bio.TUNDRA: 0.08, bio.WETLAND: 0.25},
        cluster_strength=0.5, max_slope_deg=32.0,
    ),
    Species(
        "rock_boulder", stratum=96.0, scale_range=(0.6, 1.8),
        biome_density={bio.ROCK: 0.45, bio.TUNDRA: 0.12, bio.DESERT: 0.10,
                       bio.GRASSLAND: 0.03, bio.SNOW: 0.10},
        cluster_strength=0.45, max_slope_deg=40.0,
    ),
]


def _hash01(ix: np.ndarray, iz: np.ndarray, seed: int, salt: int) -> np.ndarray:
    """Deterministic per-cell hash -> float in [0,1). Vectorized integer mix."""
    mix = (seed * 0x165667B19E3779F9 + salt * 0x27D4EB2F165667C5) & 0xFFFFFFFFFFFFFFFF
    with np.errstate(over="ignore"):
        h = (ix.astype(np.uint64) * np.uint64(0x9E3779B97F4A7C15)
             ^ iz.astype(np.uint64) * np.uint64(0xC2B2AE3D27D4EB4F)
             ^ np.uint64(mix))
    h ^= h >> np.uint64(29)
    h *= np.uint64(0xBF58476D1CE4E5B9)
    h ^= h >> np.uint64(32)
    return (h & np.uint64(0xFFFFFFFF)).astype(np.float64) / float(0x100000000)


def scatter(
    species: Species,
    seed: int,
    map_size_x: float,
    map_size_z: float,
    density_at,               # callable (x_arr, z_arr) -> density [0,1]
    slope_at,                 # callable (x_arr, z_arr) -> slope degrees
) -> np.ndarray:
    """Stratified-jitter scatter. Returns (N, 4): x, z, rotation, scale."""
    nx = int(map_size_x / species.stratum)
    nz = int(map_size_z / species.stratum)
    iz, ix = np.mgrid[0:nz, 0:nx]
    ix = ix.ravel()
    iz = iz.ravel()

    jx = _hash01(ix, iz, seed, 1)
    jz = _hash01(ix, iz, seed, 2)
    accept_roll = _hash01(ix, iz, seed, 3)
    rot = _hash01(ix, iz, seed, 4) * 2.0 * np.pi
    scale_t = _hash01(ix, iz, seed, 5)

    x = (ix + jx) * species.stratum
    z = (iz + jz) * species.stratum

    d = density_at(x, z)
    s = slope_at(x, z)
    ok = (accept_roll < d) & (s <= species.max_slope_deg)

    lo, hi = species.scale_range
    scale = lo + (hi - lo) * scale_t
    return np.stack([x[ok], z[ok], rot[ok], scale[ok]], axis=1)


def build_density_field(
    species: Species,
    biome_ids: np.ndarray,
    moisture: np.ndarray,
    cellsize: float,
    seed: int,
    exclusion: np.ndarray | None = None,
) -> np.ndarray:
    """Per-cell density [0,1] for a species: biome base + moisture bonus,
    modulated by clumping noise, zeroed in exclusion zones (roads, towns,
    start areas, water)."""
    from . import noise as tn

    d = np.zeros(biome_ids.shape, dtype=np.float32)
    for bid, base in species.biome_density.items():
        d[biome_ids == bid] = base
    d += species.moisture_bonus * moisture.astype(np.float32) * (d > 0)

    if species.cluster_strength > 0:
        import zlib

        H, W = biome_ids.shape
        n = tn.SimplexNoise(seed * 31 + zlib.crc32(species.name.encode()) % 1000)
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float64)
        clump = tn.fbm(n, xx * cellsize * species.cluster_freq,
                       yy * cellsize * species.cluster_freq, octaves=3)
        clump = np.clip(0.5 + 0.5 * clump / 0.7, 0.0, 1.0).astype(np.float32)
        # remap so cluster_strength=1 gates density fully by clumps
        d *= (1.0 - species.cluster_strength) + species.cluster_strength * (clump ** 1.5) * 2.0
        d = np.clip(d, 0.0, 1.0)

    if exclusion is not None:
        d[exclusion] = 0.0
    return d


def make_samplers(field: np.ndarray, slope_deg: np.ndarray, cellsize: float):
    """Bilinear samplers over grid fields for scatter()'s callables."""
    H, W = field.shape

    def sample(arr, x, z):
        cx = np.clip(x / cellsize, 0, W - 1.001)
        cz = np.clip(z / cellsize, 0, H - 1.001)
        c0 = cx.astype(np.int64); r0 = cz.astype(np.int64)
        fx = cx - c0; fz = cz - r0
        a = arr[r0, c0] * (1 - fx) + arr[r0, np.minimum(c0 + 1, W - 1)] * fx
        b = arr[np.minimum(r0 + 1, H - 1), c0] * (1 - fx) + \
            arr[np.minimum(r0 + 1, H - 1), np.minimum(c0 + 1, W - 1)] * fx
        return a * (1 - fz) + b * fz

    return (lambda x, z: sample(field, x, z)), (lambda x, z: sample(slope_deg, x, z))
