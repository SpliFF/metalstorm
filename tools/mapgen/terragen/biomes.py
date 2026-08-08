"""Biome fields: temperature, moisture, and classification masks.

Biomes are derived Whittaker-style from two continuous fields:

  temperature — map "latitude" gradient (configurable axis/range) minus an
                altitude lapse rate, plus low-frequency noise variation
  moisture    — rainfall noise + proximity-to-water bonus, with an optional
                prevailing-wind rain-shadow pass (upwind mountains dry out
                downwind cells)

The rain-shadow pass has two models, selected by `ClimateParams.orographic`:

  "sweep" (default) — mapgen4's downwind advection: an air parcel enters the
                      map saturated, picks moisture up over water, and drops it
                      as rain wherever its humidity exceeds the local capacity
                      (1 - normalised elevation) or the ground rises under it.
                      Humidity is a *budget*, so a coastal range genuinely
                      starves everything behind it, and the leeward dryness is
                      proportional to how much rain the windward slope took.
  "ridge"           — the original approximation: a running maximum along the
                      wind axis, so a cell is dry in proportion to how far it
                      sits below the highest terrain upwind of it. Cheap, but
                      it has no budget: a second ridge dries the lee as hard as
                      the first, and a cell one metre below a distant peak is
                      as dry as one behind a wall. Kept for A/B only.

The sweep's contribution is applied **mean-preserving over land**: rainfall
redistributes moisture, it does not destroy it, so `rain_shadow` sets how much
wetter the windward side is than the lee and leaves the map's overall moisture
where `base_moisture` put it. (The "ridge" model only ever subtracted, which
made `rain_shadow` a global drying knob as well as a contrast knob.)

Classification returns an integer biome id per cell plus per-biome soft
weights for texture blending. The biome set is intentionally game-oriented
(splat layers + feature palettes hang off it), not climatologically pure.
"""
from __future__ import annotations

from dataclasses import dataclass, replace

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
    rain_shadow: float = 0.35     # windward-to-lee moisture contrast
    # Orographic model: "sweep" = mapgen4 advection, "ridge" = running-max
    # approximation (pre-2026-08-08 behaviour, kept for A/B).
    orographic: str = "sweep"
    # mapgen4 wind-sweep constants. `raininess` is how eagerly the parcel
    # sheds moisture it cannot hold, `evaporation` how fast open water tops it
    # back up. mapgen4's third constant, the [0.2, 0.6, 0.2] across-wind
    # kernel, is NOT here: measured at zero and dropped, see
    # `orographic_rainfall`.
    raininess: float = 0.9
    evaporation: float = 0.5
    # Post-sweep smoothing, world units. Measured ladder 2026-08-08 (see
    # PLAN-maps M8k): the raw rainfall field is streaky across the wind
    # (skerry across-wind |d/dz| is 92x its 1600-elmo value), and blurring
    # past ~200 smears the shadow back over the ridge that cast it. 100 is
    # the joint optimum on both shipped maps. NOT used by the "ridge" model,
    # which keeps its own 800 so it stays a bit-exact A/B control.
    rain_blur: float = 100.0


# ---------------------------------------------------------------------------
# Climate presets (PLAN-maps M8n)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ClimatePreset:
    """A named climate *shift*, applied on top of a map's own baseline.

    Deltas rather than absolute settings, for two reasons. A map's authored
    `ClimateParams` carries decisions that are not about climate at all (its
    wind axis, its `base_moisture` re-basing, its seed), and an absolute
    preset would silently discard them; and a delta of zero is an exact
    identity, which is what makes `temperate` a usable bit-for-bit control.

    Every field here moves a *driver* of the climate fields. None of them
    touches `classify`'s thresholds, and that is deliberate — see
    `apply_climate_preset`.
    """
    name: str
    d_temperature: float = 0.0     # added to both lat_hot and lat_cold
    d_altitude_lapse: float = 0.0  # added to altitude_lapse
    d_moisture: float = 0.0        # added to base_moisture
    water_bonus_scale: float = 1.0  # multiplies water_bonus
    rain_shadow_scale: float = 1.0  # multiplies rain_shadow
    note: str = ""


# Tuned against archipelago.py's own terrain at --fast, land cells only, and
# quoted in PLAN-maps M8n. The headline number for each is the biome it is
# named for; the mixes are what the splat bake and the vegetation palettes
# then see. Measured land mixes, archipelago / meridian2 at --fast:
#   temperate  forest 63.5 / grassland 50.1   (the shipped maps, unchanged)
#   arid       desert 55.6 / desert 55.6
#   arctic     snow 58.9 tundra 14.6 / snow 41.7 tundra 30.7
#   tropical   forest 79.5 / forest 36.8, desert 0.0 / 1.5
# Meridian is the drier, more continental of the two, which is why the same
# `tropical` shift buys it half as much forest.
CLIMATE_PRESETS: dict[str, ClimatePreset] = {
    "temperate": ClimatePreset(
        "temperate",
        note="identity — the map's own authored climate, unmodified"),
    "arid": ClimatePreset(
        "arid",
        d_temperature=0.24,
        d_altitude_lapse=-0.18,
        d_moisture=-0.26,
        water_bonus_scale=0.30,
        rain_shadow_scale=1.30,
        note="hot and dry: desert flats, grassland on the windward side"),
    "arctic": ClimatePreset(
        "arctic",
        d_temperature=-0.34,
        d_altitude_lapse=-0.20,
        note="frigid: snowfields, with a tundra band on the warm edge"),
    "tropical": ClimatePreset(
        "tropical",
        d_temperature=0.16,
        d_moisture=0.06,
        rain_shadow_scale=0.80,
        note="hot and wet: closed forest, wetland margins, next to no desert"),
}


def apply_climate_preset(params: ClimateParams, name: str) -> ClimateParams:
    """Return `params` shifted by the named preset (`temperate` = identity).

    **Presets move drivers, never thresholds** — and on a real map the
    thresholds could not do the job anyway. `classify`'s cut points
    (hot 0.62 / cold 0.32 / frigid 0.18, dry 0.30 / wet 0.55) are what the
    words "desert" and "tundra" mean to everything downstream: the splat
    bake, the vegetation palettes, the settlement score,
    `placement.biome_suitability`. Measured on archipelago at --fast
    (PLAN-maps M8n): DESERT is `hot AND dry`, and under the temperate climate
    **0.0 %** of the land is hot, so *no* choice of the dry cut point makes
    any desert at all — 0.1 % at dry 0.30 rising to 14.5 % of land merely
    *dry* at 0.50, and still 0.0 % desert. Loosening `hot` as well tops out at
    **3.8 %** desert (hot 0.40 / dry 0.50), whose mean temperature is 0.447 —
    i.e. not hot — while every other biome boundary moves with it. Moving
    `lat_hot` gives **55.6 %** desert, 100 % of it genuinely hot.
    `test_climate.py::TestClimatePresets` pins both halves of that.
    """
    try:
        p = CLIMATE_PRESETS[name]
    except KeyError:
        raise ValueError(
            f"unknown climate preset {name!r}; have "
            f"{sorted(CLIMATE_PRESETS)}") from None
    return replace(
        params,
        lat_hot=_clamp01(params.lat_hot + p.d_temperature),
        lat_cold=_clamp01(params.lat_cold + p.d_temperature),
        altitude_lapse=max(0.0, params.altitude_lapse + p.d_altitude_lapse),
        base_moisture=_clamp01(params.base_moisture + p.d_moisture),
        water_bonus=params.water_bonus * p.water_bonus_scale,
        rain_shadow=params.rain_shadow * p.rain_shadow_scale,
    )


def _clamp01(v: float) -> float:
    return min(1.0, max(0.0, float(v)))


def biome_mix(biome_ids: np.ndarray, land_only: bool = True) -> dict[str, float]:
    """Area fraction per biome name — the number presets are judged on.

    Land-only by default: a map whose water fraction is a hard contract
    (archipelago's `--landmass`) would otherwise report every climate as
    two-thirds water and hide the change that matters.
    """
    ids = biome_ids[biome_ids != WATER] if land_only else biome_ids.ravel()
    total = max(int(ids.size), 1)
    counts = np.bincount(ids.ravel(), minlength=len(BIOME_NAMES))
    return {BIOME_NAMES[b]: float(counts[b]) / total
            for b in sorted(BIOME_NAMES) if counts[b]}


def format_biome_mix(biome_ids: np.ndarray, land_only: bool = True) -> str:
    mix = biome_mix(biome_ids, land_only)
    return "  ".join(f"{k} {100 * v:.1f}%" for k, v in
                     sorted(mix.items(), key=lambda kv: -kv[1]))


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


def _wind_axis(wind_dir: tuple[float, float]) -> tuple[int, bool]:
    """Dominant sweep axis for a wind vector: (array axis, marches forward?)."""
    wx, wz = wind_dir
    if abs(wx) >= abs(wz):
        return 1, wx >= 0
    return 0, wz >= 0


def _centred_unit(field: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Rescale to [0,1] on the 2nd..98th percentile over `mask`, then subtract
    the mean there — so adding the result redistributes moisture instead of
    removing it. Percentiles rather than min/max because a single saturated
    coastal cell would otherwise set the whole scale."""
    vals = field[mask] if mask.any() else field.ravel()
    lo, hi = float(np.percentile(vals, 2.0)), float(np.percentile(vals, 98.0))
    if hi - lo < 1e-12:
        return np.zeros_like(field)
    u = np.clip((field - lo) / (hi - lo), 0.0, 1.0)
    return u - float(u[mask].mean() if mask.any() else u.mean())


def orographic_rainfall(
    height: np.ndarray, water_level: float, params: ClimateParams, cellsize: float
) -> np.ndarray:
    """mapgen4's downwind moisture sweep. Returns rainfall per cell.

    An air parcel enters the upwind edge, tops back up over open water at rate
    `evaporation`, and rains out what it cannot hold at every step downwind:
    capacity is `1 - normalised elevation`, and a rise in the ground under the
    parcel squeezes out more on top (orographic lift). Rain *leaves* the
    parcel, which is the whole point — humidity is a budget, so a coastal
    range starves everything behind it in proportion to what it took, and a
    second range behind the first has less left to wring out.

    Rainfall over water is zero by construction: capacity there is 1, humidity
    never exceeds 1, and the ground cannot rise below the waterline.

    Two deliberate departures from mapgen4's recipe, both measured
    (PLAN-maps M8k):

    * **The parcel enters in equilibrium with the ground, not saturated.**
      Entering at humidity 1 over a *land* edge means instant excess and an
      instant dump: on meridian_basin, whose upwind edge is land, column 0
      alone took **25.3 %** of the map's entire rainfall budget — an artifact
      of the initial condition, not of the terrain. Over water the parcel
      still starts saturated, which is why skerry_reach (upwind edge is sea)
      read 0.0 % there either way.
    * **mapgen4's [0.2, 0.6, 0.2] across-wind kernel is dropped.** It exists
      because mapgen4 sweeps an irregular Voronoi mesh, where "the cell
      downwind" is a blend of neighbours by construction; a regular grid swept
      along an axis has no such need. Measured against no kernel at all it
      moved across-wind roughness by 0.2 % on meridian and −1.9 % on skerry
      (i.e. the wrong way), contrast by <0.5 %, and on a half-width ridge —
      the one case where across-wind coupling could matter — it feathered the
      shadow edge by 2 rows of 96 that the post-sweep blur then covers anyway.
      Rainfall's across-wind structure comes from the terrain, not from the
      parcel, so blending the parcel across rows buys nothing.
    """
    assert params.wind_dir is not None
    axis, forward = _wind_axis(params.wind_dir)
    span = max(float(height.max()) - water_level, 1.0)
    z = np.clip((height - water_level) / span, 0.0, 1.0)
    water = height <= water_level
    if axis == 0:
        z, water = z.T, water.T
    if not forward:
        z, water = z[:, ::-1], water[:, ::-1]

    rows, cols = z.shape
    # saturated off the sea, otherwise in equilibrium with the ground it
    # enters over (see the docstring — this is worth 25 % of the budget)
    hum = np.where(water[:, 0], 1.0, 1.0 - z[:, 0]).astype(np.float64)
    rain = np.empty((rows, cols), dtype=np.float64)
    prev_z = z[:, 0]
    for j in range(cols):
        zj, wj = z[:, j], water[:, j]
        hum = np.where(wj, hum + params.evaporation * (1.0 - hum), hum)
        excess = np.maximum(0.0, hum - (1.0 - zj))
        lift = np.maximum(0.0, zj - prev_z) * hum
        r = np.minimum(hum, params.raininess * (excess + lift))
        hum -= r
        rain[:, j] = r
        prev_z = zj

    if not forward:
        rain = rain[:, ::-1]
    return rain.T if axis == 0 else rain


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

    if params.wind_dir is not None and params.rain_shadow > 0:
        if params.orographic == "sweep":
            rain = orographic_rainfall(height, water_level, params, cellsize)
            rain = ndimage.gaussian_filter(
                rain, sigma=max(2.0, params.rain_blur / cellsize))
            m += params.rain_shadow * _centred_unit(rain, height > water_level)
        elif params.orographic == "ridge":
            # Pre-2026-08-08 approximation, kept bit-for-bit as the A/B control:
            # a running maximum along the wind axis, so a cell is dry in
            # proportion to how far it sits below the highest terrain upwind.
            # No moisture budget, and it only ever subtracts.
            wx, wz = params.wind_dir
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
            shadow = ndimage.gaussian_filter(shadow, sigma=max(2.0, 800.0 / cellsize))
            m -= params.rain_shadow * shadow
        else:
            raise ValueError(
                f"ClimateParams.orographic must be 'sweep' or 'ridge', "
                f"got {params.orographic!r}"
            )

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
