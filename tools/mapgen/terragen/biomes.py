"""Biome fields: temperature, moisture, and classification masks.

Biomes are derived Whittaker-style from two continuous fields:

  temperature — map "latitude" gradient (configurable axis/range) minus an
                altitude lapse rate, plus low-frequency noise variation
  moisture    — rainfall noise + proximity-to-water bonus, with an optional
                prevailing-wind rain-shadow pass (upwind mountains dry out
                downwind cells)

Classification returns an integer biome id per cell plus per-biome soft
weights for texture blending. The biome set is intentionally game-oriented
(splat layers + feature palettes hang off it), not climatologically pure.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import ndimage

from . import noise as tn

# Biome ids (order matters: higher-priority later for ties)
WATER = 0          # below water level (not really a biome; convenience id)
GRASSLAND = 1
FOREST = 2
DESERT = 3
TUNDRA = 4         # cold flats / alpine meadow
SNOW = 5           # ice caps / high peaks
ROCK = 6           # steep slopes / badlands
WETLAND = 7        # river margins / lake shores

BIOME_NAMES = {
    WATER: "water", GRASSLAND: "grassland", FOREST: "forest", DESERT: "desert",
    TUNDRA: "tundra", SNOW: "snow", ROCK: "rock", WETLAND: "wetland",
}


@dataclass
class ClimateParams:
    seed: int = 1234
    # temperature in [0,1]: 0 = coldest, 1 = hottest
    lat_axis: str = "z"           # temperature gradient along this axis
    lat_hot: float = 0.85         # temperature at the hot edge
    lat_cold: float = 0.15        # temperature at the cold edge
    altitude_lapse: float = 0.55  # temperature drop from min to max elevation
    temp_noise: float = 0.08      # low-freq noise amplitude
    # moisture in [0,1]
    base_moisture: float = 0.45
    moisture_noise: float = 0.35
    water_bonus: float = 0.35     # added near open water (decays with distance)
    water_bonus_range: float = 1500.0  # world units
    wind_dir: tuple[float, float] | None = (1.0, 0.25)  # None = no rain shadow
    rain_shadow: float = 0.35


def temperature_field(
    height: np.ndarray, water_level: float, params: ClimateParams, cellsize: float
) -> np.ndarray:
    H, W = height.shape
    noise = tn.SimplexNoise(params.seed * 7 + 1)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float64)
    lat = (yy / max(H - 1, 1)) if params.lat_axis == "z" else (xx / max(W - 1, 1))
    t = params.lat_cold + (params.lat_hot - params.lat_cold) * lat

    hmax = float(height.max())
    span = max(hmax - water_level, 1.0)
    alt = np.clip((height - water_level) / span, 0.0, None)
    t = t - params.altitude_lapse * alt

    t += params.temp_noise * tn.fbm(noise, xx * cellsize / 6000.0, yy * cellsize / 6000.0, octaves=3)
    return np.clip(t, 0.0, 1.0)


def moisture_field(
    height: np.ndarray, water_level: float, params: ClimateParams, cellsize: float
) -> np.ndarray:
    H, W = height.shape
    noise = tn.SimplexNoise(params.seed * 7 + 2)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float64)

    m = params.base_moisture + params.moisture_noise * tn.fbm(
        noise, xx * cellsize / 5000.0, yy * cellsize / 5000.0, octaves=4
    )

    # Water-proximity bonus (rivers/lakes/sea): distance transform on the
    # water mask, exponential falloff.
    water = height <= water_level
    if water.any():
        dist = ndimage.distance_transform_edt(~water) * cellsize
        m += params.water_bonus * np.exp(-dist / params.water_bonus_range)

    # Rain shadow: sweep along the wind direction accumulating the highest
    # terrain seen so far; cells sitting far below that running ridge line are
    # drier. Cheap 1D scan approximation along the dominant wind axis.
    if params.wind_dir is not None and params.rain_shadow > 0:
        wx, wz = params.wind_dir
        # normalize to a primary axis sweep with per-row shear — keep it
        # simple: sweep along x if |wx|>=|wz| else along z, sign = direction.
        rel = np.clip((height - water_level) / max(height.max() - water_level, 1.0), 0, 1)
        if abs(wx) >= abs(wz):
            arr = rel if wx >= 0 else rel[:, ::-1]
            ridge = np.maximum.accumulate(arr, axis=1)
            shadow = np.clip(ridge - arr, 0.0, 1.0)
            if wx < 0:
                shadow = shadow[:, ::-1]
        else:
            arr = rel if wz >= 0 else rel[::-1, :]
            ridge = np.maximum.accumulate(arr, axis=0)
            shadow = np.clip(ridge - arr, 0.0, 1.0)
            if wz < 0:
                shadow = shadow[::-1, :]
        # soften the shadow edge
        shadow = ndimage.gaussian_filter(shadow, sigma=max(2.0, 800.0 / cellsize))
        m -= params.rain_shadow * shadow

    return np.clip(m, 0.0, 1.0)


def classify(
    height: np.ndarray,
    slope_deg: np.ndarray,
    temperature: np.ndarray,
    moisture: np.ndarray,
    water_level: float,
    river_mask: np.ndarray | None = None,
) -> np.ndarray:
    """Whittaker-ish classification to biome ids (uint8)."""
    b = np.full(height.shape, GRASSLAND, dtype=np.uint8)

    hot = temperature > 0.62
    cold = temperature < 0.32
    frigid = temperature < 0.18
    dry = moisture < 0.30
    wet = moisture > 0.55

    b[hot & dry] = DESERT
    b[wet & ~hot] = FOREST
    b[wet & hot] = FOREST          # warm forest; texture layer may differ later
    b[cold] = TUNDRA
    b[frigid] = SNOW

    # Steep rock overrides climate (cliffs read as rock everywhere)
    b[slope_deg > 38.0] = ROCK
    # Mid-steep in cold zones stays rock too (scree)
    b[(slope_deg > 30.0) & cold] = ROCK

    # Wetland fringe along rivers/lakes on gentle ground
    if river_mask is not None:
        near_water = ndimage.binary_dilation(river_mask, iterations=2)
        b[near_water & (slope_deg < 8.0) & (height > water_level)] = WETLAND

    b[height <= water_level] = WATER
    return b


def biome_weights(biome_ids: np.ndarray, blur_cells: float = 3.0) -> dict[int, np.ndarray]:
    """Soft per-biome weight maps (gaussian-blurred one-hot) for splat blending."""
    out: dict[int, np.ndarray] = {}
    for bid in np.unique(biome_ids):
        mask = (biome_ids == bid).astype(np.float32)
        out[int(bid)] = ndimage.gaussian_filter(mask, sigma=blur_cells)
    # renormalize so weights sum to 1
    total = np.zeros_like(next(iter(out.values())))
    for w in out.values():
        total += w
    total[total <= 0] = 1.0
    for k in out:
        out[k] = out[k] / total
    return out
