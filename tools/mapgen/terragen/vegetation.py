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


# ---------------------------------------------------------------------------
# Climate-scoped palettes (PLAN-maps M8o)
# ---------------------------------------------------------------------------
#
# `TEMPERATE_SPECIES` is not a general table, and its name always said so.
# M8n's climate presets move what the ground IS — an `arctic` archipelago is
# 58.9 % snow and 0.0 % forest — and the shared table has an opinion about
# forest only, so the same generator that scatters 17 798 features on the
# temperate map scattered 1 716 on the arctic one (9.6 %), with
# `tree_broadleaf` and `deadwood` warning "suitability covers 0.0000 % of the
# map". Feature totals before -> after these palettes (--fast, land only,
# archipelago / meridian2; the parenthesised figure is the share of the same
# generator's temperate total AFTER):
#
#   temperate  17 798 / 55 662  ->  unchanged      (1.00 / 1.00, by identity)
#   arctic      1 716 / 12 678  ->   5 284 / 32 290 (0.30 / 0.58)
#   arid        4 782 / 18 042  ->   7 082 / 31 809 (0.40 / 0.57)
#   tropical   21 209 / 73 177  ->  20 436 / 73 315 (1.15 / 1.32)
#
# and no layer on any climate warns any more. The point is NOT that every
# climate reaches the temperate total — a desert and an icecap are supposed
# to be sparser, and they are. It is that nothing is at zero and the mix is
# the climate's own.
#
# The tropical row is the one the defect report missed: it does not starve,
# it is simply wrong — a jungle made of ridge conifers, because FOREST is
# FOREST to a single table. On meridian, tropical went from 32 907 conifers
# vs 17 686 broadleaf to 5 387 vs 31 338, at a near-identical total.
# Density and composition are the same bug.
#
# The `temperate` entry is `TEMPERATE_SPECIES` *itself*, not a copy: the
# shipped maps must stay bit-identical, and identity by object is the
# cheapest thing to assert. Same contract as `settle.biome_score_for`.

# Props that are not scattered by a Species layer — placed by the
# generators' own hand-written layers (deadwood, fences, ruins, boulder
# fields). Climate-independent: a ruined colonnade is a cultural artifact,
# not a biome one, and the generators place them off road distance and
# slope rather than off the biome map.
PROP_NAMES = (
    "rock_boulder_large", "fallen_log", "tree_stump",
    "standing_stone", "ruin_pillar", "ruin_wall", "log_fence",
)


@dataclass(frozen=True)
class ClimatePalette:
    """Everything a climate needs the vegetation system to know.

    `wooded` is the biome set that stands in for FOREST in the layers that
    key off woodland rather than off a species — today just `deadwood`,
    whose fallen logs and stumps belong wherever the palette's trees are.
    On an arctic map that is TUNDRA (the treeline band), which is why the
    hard-coded `[bio.FOREST]` starved it to zero.
    """
    name: str
    species: list[Species]
    wooded: tuple[int, ...] = (bio.FOREST,)

    @property
    def feature_names(self) -> tuple[str, ...]:
        """Every feature def a map on this climate can reference."""
        return tuple(sp.name for sp in self.species) + PROP_NAMES


CLIMATE_PALETTES: dict[str, ClimatePalette] = {
    "temperate": ClimatePalette("temperate", TEMPERATE_SPECIES),

    # Treeline, not forest. Conifers hold the tundra band and thin out onto
    # the snowfields; broadleaf is dropped outright rather than left in the
    # list to warn about a biome that does not exist here. `dead_snag` is
    # what makes a snowfield read as a place trees once stood instead of as
    # empty ground, and it is the only species that prefers SNOW.
    "arctic": ClimatePalette("arctic", [
        Species(
            "tree_conifer", stratum=44.0,
            biome_density={bio.TUNDRA: 0.30, bio.SNOW: 0.04,
                           bio.WETLAND: 0.20},
            moisture_bonus=0.15, cluster_strength=0.78, max_slope_deg=30.0,
        ),
        Species(
            "bush_scrub", stratum=38.0,
            biome_density={bio.TUNDRA: 0.22, bio.SNOW: 0.05,
                           bio.WETLAND: 0.20, bio.ROCK: 0.03},
            cluster_strength=0.5, max_slope_deg=32.0,
        ),
        Species(
            "dead_snag", stratum=88.0, scale_range=(0.8, 1.25),
            biome_density={bio.SNOW: 0.14, bio.TUNDRA: 0.10, bio.ROCK: 0.04},
            cluster_strength=0.55, max_slope_deg=28.0,
        ),
        Species(
            "rock_boulder", stratum=96.0, scale_range=(0.6, 1.8),
            biome_density={bio.ROCK: 0.45, bio.TUNDRA: 0.14, bio.SNOW: 0.14,
                           bio.GRASSLAND: 0.03},
            cluster_strength=0.45, max_slope_deg=40.0,
        ),
    ], wooded=(bio.TUNDRA,)),

    # Desert is 55.6 % of the land on both maps and the temperate table
    # gives it `bush_scrub` 0.06 and `rock_boulder` 0.10 — i.e. bare ground
    # with a pebble on it. Columnar cactus and dry shrub carry the flats;
    # conifer is pulled back to genuine forest and broadleaf becomes an
    # oasis species on WETLAND, where the rivers are.
    "arid": ClimatePalette("arid", [
        Species(
            "tree_conifer", stratum=44.0,
            biome_density={bio.FOREST: 0.70, bio.GRASSLAND: 0.02},
            moisture_bonus=0.25, cluster_strength=0.75, max_slope_deg=30.0,
        ),
        Species(
            "tree_broadleaf", stratum=52.0,
            biome_density={bio.WETLAND: 0.45, bio.FOREST: 0.30,
                           bio.GRASSLAND: 0.03},
            moisture_bonus=0.35, cluster_strength=0.72, max_slope_deg=24.0,
        ),
        Species(
            "cactus_column", stratum=60.0, scale_range=(0.8, 1.35),
            biome_density={bio.DESERT: 0.15, bio.GRASSLAND: 0.03},
            cluster_strength=0.55, max_slope_deg=26.0,
        ),
        Species(
            "desert_shrub", stratum=46.0,
            biome_density={bio.DESERT: 0.20, bio.GRASSLAND: 0.14,
                           bio.ROCK: 0.04},
            cluster_strength=0.45, max_slope_deg=32.0,
        ),
        Species(
            "dead_snag", stratum=140.0, scale_range=(0.75, 1.1),
            biome_density={bio.DESERT: 0.06, bio.GRASSLAND: 0.03},
            cluster_strength=0.5, max_slope_deg=26.0,
        ),
        Species(
            "bush_scrub", stratum=38.0,
            biome_density={bio.GRASSLAND: 0.16, bio.FOREST: 0.20,
                           bio.WETLAND: 0.25, bio.DESERT: 0.05},
            cluster_strength=0.5, max_slope_deg=32.0,
        ),
        Species(
            "rock_boulder", stratum=96.0, scale_range=(0.6, 1.8),
            biome_density={bio.ROCK: 0.45, bio.DESERT: 0.16,
                           bio.GRASSLAND: 0.03},
            cluster_strength=0.45, max_slope_deg=40.0,
        ),
    ]),

    # Closed broadleaf canopy with palms on the wet margins. Conifer drops
    # from 0.85 to 0.12 of FOREST — it is an upland species here, not the
    # thing the jungle is made of.
    "tropical": ClimatePalette("tropical", [
        Species(
            "tree_broadleaf", stratum=46.0,
            biome_density={bio.FOREST: 0.88, bio.GRASSLAND: 0.14,
                           bio.WETLAND: 0.40},
            moisture_bonus=0.35, cluster_strength=0.6, max_slope_deg=26.0,
        ),
        Species(
            "palm", stratum=58.0, scale_range=(0.85, 1.3),
            biome_density={bio.WETLAND: 0.50, bio.FOREST: 0.16,
                           bio.GRASSLAND: 0.10},
            moisture_bonus=0.25, cluster_strength=0.6, max_slope_deg=20.0,
        ),
        Species(
            "tree_conifer", stratum=44.0,
            biome_density={bio.FOREST: 0.12, bio.TUNDRA: 0.10},
            moisture_bonus=0.10, cluster_strength=0.8, max_slope_deg=30.0,
        ),
        Species(
            "bush_scrub", stratum=38.0,
            biome_density={bio.FOREST: 0.24, bio.GRASSLAND: 0.18,
                           bio.WETLAND: 0.30},
            moisture_bonus=0.10, cluster_strength=0.45, max_slope_deg=32.0,
        ),
        Species(
            "rock_boulder", stratum=96.0, scale_range=(0.6, 1.8),
            biome_density={bio.ROCK: 0.45, bio.GRASSLAND: 0.03,
                           bio.TUNDRA: 0.12},
            cluster_strength=0.45, max_slope_deg=40.0,
        ),
    ]),
}


def palette_for(climate: str) -> ClimatePalette:
    """Vegetation palette for a `biomes.CLIMATE_PRESETS` name.

    `temperate` returns the palette whose `species` *is* `TEMPERATE_SPECIES`
    — the shipped maps must not move a byte.
    """
    try:
        return CLIMATE_PALETTES[climate]
    except KeyError:
        raise ValueError(
            f"no vegetation palette for climate {climate!r}; have "
            f"{sorted(CLIMATE_PALETTES)}") from None


def feature_names_for(climate: str) -> tuple[str, ...]:
    """Feature def names a map on this climate needs models and defs for."""
    return palette_for(climate).feature_names


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
