"""Settlement (town) placement: score the map, pick separated sites.

Scoring favours flat buildable ground, fresh-water proximity, and hospitable
biomes; penalises high altitude and map edges. Site selection is greedy
best-score with a minimum separation (deterministic — no RNG).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import ndimage

from . import biomes as bio


@dataclass
class SettleParams:
    min_separation: float = 2400.0   # world units between towns
    edge_margin: float = 600.0       # keep towns off the map border
    flat_radius: float = 320.0       # radius that must be buildable-flat
    water_range: float = 2000.0      # river/lake proximity scoring range
    max_slope_deg: float = 8.0       # "buildable" threshold for the core
    biome_score: dict[int, float] | None = None  # per-biome desirability


_DEFAULT_BIOME_SCORE = {
    bio.GRASSLAND: 1.0,
    bio.FOREST: 0.75,
    bio.WETLAND: 0.35,
    bio.DESERT: 0.35,
    bio.TUNDRA: 0.30,
    bio.ROCK: 0.0,
    bio.SNOW: 0.0,
    bio.WATER: 0.0,
}

# Desirability is RELATIVE to what the world offers, and the default table is
# a temperate world's opinion: `SNOW: 0.0` means "nobody lives on a mountain
# cap", which is right when snow is 0.7 % of the land and wrong when it is
# most of it. It is also not only a town table — archipelago.py picks its
# START PADS off the same score — so on a climate the table has no opinion
# about, the map loses its start positions, not just its towns. Measured
# (PLAN-maps M8n): the `arctic` preset with the default table fits 3 of the 8
# start pads archipelago requires and the generator exits.
#
# A climate that changes what the ground IS therefore has to bring its own
# habitability opinion. `temperate` returns None -> the default table ->
# bit-identical to what shipped.
_CLIMATE_BIOME_SCORE: dict[str, dict[int, float]] = {
    "arctic": {**_DEFAULT_BIOME_SCORE, bio.SNOW: 0.55, bio.TUNDRA: 0.85},
    "arid": {**_DEFAULT_BIOME_SCORE, bio.DESERT: 0.60},
}


def biome_score_for(climate: str) -> dict[int, float] | None:
    """Per-biome desirability for a `biomes.CLIMATE_PRESETS` name.

    None means "the default temperate table", which is what every caller
    passing no table already gets.
    """
    if climate not in bio.CLIMATE_PRESETS:
        raise ValueError(
            f"unknown climate preset {climate!r}; have "
            f"{sorted(bio.CLIMATE_PRESETS)}")
    return _CLIMATE_BIOME_SCORE.get(climate)


def settlement_score(
    height: np.ndarray,
    slope_deg: np.ndarray,
    biome_ids: np.ndarray,
    water_level: float,
    cellsize: float,
    params: SettleParams | None = None,
) -> np.ndarray:
    p = params or SettleParams()
    H, W = height.shape

    # Flatness: fraction of a disc around the cell that is buildable-flat.
    flat = (slope_deg <= p.max_slope_deg) & (height > water_level)
    r = max(1, int(p.flat_radius / cellsize))
    flat_frac = ndimage.uniform_filter(flat.astype(np.float32), size=2 * r + 1)

    # Water proximity (any water: rivers carved below level, lakes, sea).
    water = height <= water_level
    if water.any():
        wdist = ndimage.distance_transform_edt(~water) * cellsize
        water_score = np.exp(-wdist / p.water_range)
        # but not IN or right at the water
        water_score[wdist < cellsize * 4] *= 0.2
    else:
        water_score = np.zeros_like(flat_frac)

    bscore = np.zeros_like(flat_frac)
    table = p.biome_score or _DEFAULT_BIOME_SCORE
    for bid, s in table.items():
        bscore[biome_ids == bid] = s

    score = flat_frac * (0.55 + 0.45 * water_score) * bscore

    # edge falloff
    m = max(1, int(p.edge_margin / cellsize))
    edge = np.ones((H, W), dtype=np.float32)
    ramp = np.linspace(0.0, 1.0, m, dtype=np.float32)
    edge[:m, :] *= ramp[:, None]
    edge[-m:, :] *= ramp[::-1][:, None]
    edge[:, :m] *= ramp[None, :]
    edge[:, -m:] *= ramp[::-1][None, :]
    return score * edge


def pick_sites(
    score: np.ndarray,
    cellsize: float,
    count: int,
    params: SettleParams | None = None,
    forbidden: np.ndarray | None = None,
) -> list[tuple[float, float]]:
    """Greedy top-score site selection with min separation.

    Returns world-coordinate (x, z) tuples, best site first. Deterministic.
    """
    p = params or SettleParams()
    s = score.copy()
    if forbidden is not None:
        s[forbidden] = 0.0
    H, W = s.shape
    sep_cells = max(1, int(p.min_separation / cellsize))

    sites: list[tuple[float, float]] = []
    for _ in range(count):
        i = int(np.argmax(s))
        if s.flat[i] <= 0.0:
            break
        r, c = divmod(i, W)
        sites.append((c * cellsize, r * cellsize))
        r0, r1 = max(0, r - sep_cells), min(H, r + sep_cells + 1)
        c0, c1 = max(0, c - sep_cells), min(W, c + sep_cells + 1)
        s[r0:r1, c0:c1] = 0.0
    return sites
