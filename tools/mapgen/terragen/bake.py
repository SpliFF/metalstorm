"""Albedo bake (1 texel/elmo), splat textures, minimap.

The whole-map albedo is material colour only — NO lighting/hillshade — since
relief shading comes from the real-time sun + mesh normals; an unlit bake also
vector-quantizes far better (dxt1.cluster_tiles). Strips keep peak memory
bounded at ~150 MB regardless of map size; unique tiles land in a disk-backed
memmap.

Biome material language: every biome gets a base colour + tonal variation
driven by two noise scales (macro patchiness ~600 elmos, grain ~6 elmos) plus
rule-based overlays that carry most of the realism:
  - slope rock exposure (steep ground shows rock colour in any biome)
  - wetness darkening near water + in wetland
  - riverbed / lakebed tint by depth
  - roads (sharp-edged gravel with soft shoulders, from the road distance field)
  - shoreline sand band
"""
from __future__ import annotations

import numpy as np

from . import biomes as bio
from . import noise as tn

# Base material colours (linear-ish sRGB uint8) per biome id.
BIOME_COLOR = {
    bio.GRASSLAND: (106, 122, 66),
    bio.FOREST: (74, 92, 52),
    bio.DESERT: (188, 162, 116),
    bio.TUNDRA: (142, 134, 112),
    bio.SNOW: (232, 236, 240),
    bio.ROCK: (118, 110, 102),
    bio.WETLAND: (88, 102, 64),
    bio.WATER: (60, 70, 60),      # dry fallback; real waterbed handled below
}
ROCK_COLOR = np.array((118, 110, 102), dtype=np.float32)
ROAD_COLOR = np.array((92, 84, 74), dtype=np.float32)
SAND_COLOR = np.array((178, 160, 128), dtype=np.float32)
BED_SHALLOW = np.array((110, 108, 88), dtype=np.float32)   # wet gravel
BED_DEEP = np.array((52, 64, 58), dtype=np.float32)        # dark silt


class AlbedoBaker:
    """Samples map-scale fields (heightmap grid res) and synthesizes albedo
    texels at 1 texel/elmo, one row-strip at a time."""

    def __init__(
        self,
        height: np.ndarray,          # (H, W) elmos, grid res (8 elmo)
        slope_deg: np.ndarray,
        biome_ids: np.ndarray,
        moisture: np.ndarray,
        road_dist: np.ndarray,       # world units to road centreline
        water_level: float,
        cellsize: float,
        seed: int,
        road_width: float = 44.0,
    ):
        self.h = height.astype(np.float32)
        self.slope = slope_deg.astype(np.float32)
        self.biome = biome_ids
        self.moist = moisture.astype(np.float32)
        self.rdist = road_dist.astype(np.float32)
        self.wl = water_level
        self.cs = cellsize
        self.seed = seed
        self.road_w = road_width
        self.gh, self.gw = height.shape
        self.map_w = int((self.gw - 1) * cellsize)
        self.map_h = int((self.gh - 1) * cellsize)
        self.noise = tn.SimplexNoise(seed * 13 + 5)

        # Per-biome colour lookup table indexed by biome id
        maxid = int(biome_ids.max()) + 1
        self.lut = np.zeros((maxid, 3), dtype=np.float32)
        for bid, c in BIOME_COLOR.items():
            if bid < maxid:
                self.lut[bid] = c

    def _bilinear(self, arr: np.ndarray, x: np.ndarray, z: np.ndarray) -> np.ndarray:
        cx = np.clip(x / self.cs, 0, self.gw - 1.001)
        cz = np.clip(z / self.cs, 0, self.gh - 1.001)
        c0 = cx.astype(np.int32); r0 = cz.astype(np.int32)
        fx = (cx - c0).astype(np.float32); fz = (cz - r0).astype(np.float32)
        c1 = np.minimum(c0 + 1, self.gw - 1); r1 = np.minimum(r0 + 1, self.gh - 1)
        a = arr[r0, c0] * (1 - fx) + arr[r0, c1] * fx
        b = arr[r1, c0] * (1 - fx) + arr[r1, c1] * fx
        return a * (1 - fz) + b * fz

    def _nearest(self, arr: np.ndarray, x: np.ndarray, z: np.ndarray) -> np.ndarray:
        c = np.clip(np.round(x / self.cs), 0, self.gw - 1).astype(np.int32)
        r = np.clip(np.round(z / self.cs), 0, self.gh - 1).astype(np.int32)
        return arr[r, c]

    def bake_strip(self, z0_texel: int, rows: int, texel: float = 1.0) -> np.ndarray:
        """Bake `rows` albedo rows starting at texel row z0_texel.
        Returns (rows, map_w/texel, 3) uint8."""
        w = int(self.map_w / texel)
        zs = (np.arange(z0_texel, z0_texel + rows, dtype=np.float64) + 0.5) * texel
        xs = (np.arange(w, dtype=np.float64) + 0.5) * texel
        X, Z = np.meshgrid(xs, zs)

        h = self._bilinear(self.h, X, Z)
        slope = self._bilinear(self.slope, X, Z)
        moist = self._bilinear(self.moist, X, Z)
        rdist = self._bilinear(self.rdist, X, Z)
        bid = self._nearest(self.biome, X, Z)

        col = self.lut[bid].copy()          # (rows, w, 3)

        # --- tonal variation: macro patchiness + fine grain ---
        macro = tn.fbm(self.noise, X / 620.0, Z / 620.0, octaves=3).astype(np.float32)
        grain = tn.fbm(self.noise, X / 6.5 + 91.0, Z / 6.5 - 47.0, octaves=2).astype(np.float32)
        tone = 1.0 + 0.10 * macro + 0.07 * grain
        col *= tone[..., None]

        # hue drift on vegetation (yellower when dry, greener when wet)
        veg = (bid == bio.GRASSLAND) | (bid == bio.FOREST) | (bid == bio.WETLAND)
        dryness = np.clip(0.55 - moist, 0.0, 0.55) / 0.55
        col[..., 0] += np.where(veg, 26.0 * dryness * (0.6 + 0.4 * macro), 0.0)
        col[..., 1] -= np.where(veg, 8.0 * dryness, 0.0)

        # --- slope rock exposure (any biome) ---
        rockmix = np.clip((slope - 22.0) / 14.0, 0.0, 1.0).astype(np.float32)
        rockmix *= np.where(bid == bio.SNOW, 0.6, 1.0)  # snow clings longer
        rock_tone = ROCK_COLOR * (1.0 + 0.12 * macro + 0.08 * grain)[..., None]
        col = col * (1 - rockmix[..., None]) + rock_tone * rockmix[..., None]

        # --- wetness + waterbed ---
        depth = np.clip(self.wl - h, 0.0, None)
        under = depth > 0.0
        bedmix = np.clip(depth / 22.0, 0.0, 1.0)[..., None].astype(np.float32)
        bed = BED_SHALLOW * (1 - bedmix) + BED_DEEP * bedmix
        bed *= (1.0 + 0.08 * grain)[..., None]
        col = np.where(under[..., None], bed, col)

        # shoreline: sand band just above water, wet-darkening
        shore = np.clip((h - self.wl) / 6.0, 0.0, 1.0)
        sandmix = ((1.0 - shore) * (slope < 14.0) * (~under)).astype(np.float32)
        col = col * (1 - 0.7 * sandmix[..., None]) + SAND_COLOR * (0.7 * sandmix[..., None])
        wet = np.clip((4.0 - (h - self.wl)) / 8.0, 0.0, 0.35).astype(np.float32)
        col *= (1.0 - np.where(~under, wet, 0.0))[..., None]

        # --- roads: sharp deck, soft shoulder ---
        half = self.road_w * 0.5
        deck = np.clip((half - rdist) / 3.0, 0.0, 1.0).astype(np.float32)       # sharp edge
        shoulder = np.clip((half * 2.2 - rdist) / (half * 2.2), 0.0, 1.0) ** 2
        shoulder = (shoulder * 0.35 * (deck < 0.5)).astype(np.float32)
        road_tone = ROAD_COLOR * (1.0 + 0.10 * grain)[..., None]
        col = col * (1 - deck[..., None]) + road_tone * deck[..., None]
        col *= (1.0 - shoulder)[..., None]  # worn verge

        return np.clip(col, 0, 255).astype(np.uint8)


def bake_tiles(baker: AlbedoBaker, memmap_path: str, texel: float = 1.0):
    """Bake the whole map into 32x32 SMT tiles stored in a disk memmap.
    Returns (tiles memmap (N,32,32,3) uint8, tiles_x, tiles_z)."""
    tile_px = 32
    w = int(baker.map_w / texel)
    hpx = int(baker.map_h / texel)
    tiles_x = w // tile_px
    tiles_z = hpx // tile_px
    tiles = np.lib.format.open_memmap(
        memmap_path, mode="w+", dtype=np.uint8, shape=(tiles_x * tiles_z, tile_px, tile_px, 3)
    )
    rows_per_strip = 8 * tile_px  # 8 tile rows per strip
    for z0 in range(0, hpx, rows_per_strip):
        rows = min(rows_per_strip, hpx - z0)
        strip = baker.bake_strip(z0, rows, texel)
        trow0 = z0 // tile_px
        n_trows = rows // tile_px
        t = (
            strip[: n_trows * tile_px]
            .reshape(n_trows, tile_px, tiles_x, tile_px, 3)
            .transpose(0, 2, 1, 3, 4)
        )
        tiles[trow0 * tiles_x : (trow0 + n_trows) * tiles_x] = t.reshape(
            n_trows * tiles_x, tile_px, tile_px, 3
        )
    return tiles, tiles_x, tiles_z


def make_minimap(baker: AlbedoBaker, hillshade: np.ndarray) -> np.ndarray:
    """1024x1024x3 minimap: downsampled albedo * hillshade (the minimap DOES
    want baked relief for legibility)."""
    from PIL import Image

    # bake a coarse albedo (4 elmo/texel is plenty for 1024 final)
    texel = max(1.0, baker.map_w / 4096.0)
    w = int(baker.map_w / texel)
    strips = [baker.bake_strip(z0, min(256, int(baker.map_h / texel) - z0), texel)
              for z0 in range(0, int(baker.map_h / texel), 256)]
    alb = np.vstack(strips)
    img = Image.fromarray(alb).resize((1024, 1024), Image.LANCZOS)
    shade = Image.fromarray(
        np.clip(hillshade * 255, 0, 255).astype(np.uint8)
    ).resize((1024, 1024), Image.BILINEAR)
    out = np.asarray(img, dtype=np.float32) * (
        0.45 + 0.55 * np.asarray(shade, dtype=np.float32)[..., None] / 255.0
    )
    return np.clip(out, 0, 255).astype(np.uint8)


def hillshade(height: np.ndarray, cellsize: float, az_deg: float = 315.0, alt_deg: float = 45.0) -> np.ndarray:
    gy, gx = np.gradient(height, cellsize)
    az, alt = np.radians(az_deg), np.radians(alt_deg)
    norm = np.sqrt(gx * gx + gy * gy + 1)
    return np.clip((np.sin(alt) + np.cos(alt) * (np.cos(az) * -gy + np.sin(az) * -gx)) / norm, 0, 1)


# ---------------------------------------------------------------------------
# Splat detail textures (procedural, greyscale, Recoil splatDetailTex model)
# ---------------------------------------------------------------------------

def make_splat_detail(seed: int, size: int = 1024) -> np.ndarray:
    """RGBA: 4 tiling greyscale detail layers centred on 0.5 (signed on GPU).
    R=grass blades, G=rock granulation, B=sand/dirt ripple, A=snow/soft."""
    n = tn.SimplexNoise(seed * 17 + 3)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)

    def wrap_fbm(x, y, freq, octaves):
        # tileable via 4-corner blend
        u = x / size; v = y / size
        a = tn.fbm(n, x / freq, y / freq, octaves=octaves)
        b = tn.fbm(n, (x - size) / freq, y / freq, octaves=octaves)
        c = tn.fbm(n, x / freq, (y - size) / freq, octaves=octaves)
        d = tn.fbm(n, (x - size) / freq, (y - size) / freq, octaves=octaves)
        return (a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v)

    grass = wrap_fbm(xx, yy, 9.0, 4) * 0.9 + wrap_fbm(xx * 3 + 31, yy * 0.33, 5.0, 2) * 0.4
    rock = np.abs(wrap_fbm(xx + 71, yy - 13, 34.0, 5)) * -1.3 + 0.35
    sand = np.sin(xx / 9.0 + wrap_fbm(xx, yy, 60.0, 3) * 14.0) * 0.35 + wrap_fbm(xx - 5, yy + 44, 7.0, 3) * 0.3
    snow = wrap_fbm(xx + 200, yy + 200, 16.0, 4) * 0.5

    out = np.stack([grass, rock, sand, snow], axis=-1)
    out = np.clip(0.5 + 0.5 * out / (np.abs(out).std() * 3.5), 0.0, 1.0)
    return (out * 255).astype(np.uint8)


def make_splat_distr(
    biome_ids: np.ndarray, slope_deg: np.ndarray, height: np.ndarray,
    water_level: float, size: int = 1024,
) -> np.ndarray:
    """RGBA weights choosing the 4 detail layers (grass/rock/sand/snow) from
    biome + slope, downsampled + blurred to `size`."""
    from scipy import ndimage

    grass = np.isin(biome_ids, [bio.GRASSLAND, bio.FOREST, bio.WETLAND]).astype(np.float32)
    rockb = (biome_ids == bio.ROCK).astype(np.float32)
    rockb = np.maximum(rockb, np.clip((slope_deg - 22.0) / 14.0, 0, 1))
    sand = np.isin(biome_ids, [bio.DESERT]).astype(np.float32)
    sand = np.maximum(sand, (height < water_level + 4.0) & (height > water_level - 6.0))
    snow = np.isin(biome_ids, [bio.SNOW, bio.TUNDRA]).astype(np.float32)
    snow[biome_ids == bio.TUNDRA] = 0.4

    w = np.stack([grass, rockb, sand, snow], axis=-1)
    total = w.sum(axis=-1, keepdims=True)
    w = np.divide(w, total, out=np.zeros_like(w), where=total > 0)

    zoom = size / biome_ids.shape[0]
    w4 = np.stack(
        [ndimage.zoom(ndimage.gaussian_filter(w[..., i], 1.5), zoom, order=1) for i in range(4)],
        axis=-1,
    )
    return np.clip(w4 * 255, 0, 255).astype(np.uint8)
