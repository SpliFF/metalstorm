"""Settlement (town) placement: score the map, pick separated sites.

Scoring favours flat buildable ground, fresh-water proximity, and hospitable
biomes; penalises high altitude and map edges. Site selection is greedy
best-score with a minimum separation — Euclidean, and a distance rather than
a bounding box, which is not what it used to be (see `pick_sites`) —
deterministic, no RNG.

The caller owns whether that separation is global. `pick_sites` enforces it
only over the sites *it* returns, so a generator that calls it once per island
gets a per-island constraint; `archipelago.py`'s start pads carry an
accumulated `forbidden` field across calls for that reason, and its towns
deliberately do not (roads never island-hop, so a town's separation is a
per-island layout knob).
"""
from __future__ import annotations

import math
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

    Separation is EUCLIDEAN — `min_separation` is a distance, so the taken
    site's exclusion is a disc of that radius.

    It used to be an axis-aligned **box** of half-width `min_separation`,
    which delivers a *Chebyshev* constraint: a candidate 3 600 elmos away on
    a diagonal sits only 2 546 elmos away on each axis, so the box rejected
    it. The delivered separation was therefore between `min_separation` and
    `min_separation * sqrt(2)` depending on heading, and each pick sterilised
    `4 * sep^2` of ground where the constraint asks for `pi * sep^2` — 27 %
    more than it is entitled to. **That over-constraint, on its own, was the
    whole of M8q's start-pad failure**: the D-infinity arc has *more*
    buildable ground than the D8 arc at every slope threshold and still fit
    only 7 of 8 pads at `--landmass 0.26`, because its flats had moved onto
    diagonals. With the disc the same surface fits 8 (PLAN-maps M9b).

    Returns world-coordinate (x, z) tuples, best site first. Deterministic.
    """
    p = params or SettleParams()
    s = score.copy()
    if forbidden is not None:
        s[forbidden] = 0.0
    H, W = s.shape
    sep = max(float(p.min_separation), 0.0)
    # ceil, not trunc: the window has to *contain* the disc it tests, or an
    # on-axis cell inside the separation radius survives the sweep
    rad = max(1, int(math.ceil(sep / cellsize)))

    sites: list[tuple[float, float]] = []
    for _ in range(count):
        i = int(np.argmax(s))
        if s.flat[i] <= 0.0:
            break
        r, c = divmod(i, W)
        sites.append((c * cellsize, r * cellsize))
        r0, r1 = max(0, r - rad), min(H, r + rad + 1)
        c0, c1 = max(0, c - rad), min(W, c + rad + 1)
        rr, cc = np.ogrid[r0:r1, c0:c1]
        d2 = ((rr - r) * cellsize) ** 2 + ((cc - c) * cellsize) ** 2
        # strict: a site exactly `min_separation` away satisfies the minimum
        np.copyto(s[r0:r1, c0:c1], 0.0, where=(d2 < sep * sep))
        # ...and the cell just taken always goes, whatever the separation is:
        # a strict test excludes nothing at all at sep == 0 and the same cell
        # would be handed back for every remaining site
        s[r, c] = 0.0
    return sites
