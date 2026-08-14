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
from . import roads as rd

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

# --- road surface classes (roads lane R1) ------------------------------------
# Indexed by terragen.roads.SURF_*; index 0 (SURF_NONE) is never sampled but
# keeps the LUT aligned to the typemap value, which is the same number.
ROAD_SURFACE_COLOR = np.array([
    (92, 84, 74),      # 0 unclassified — the pre-R1 single road colour
    (62, 61, 63),      # 1 bitumen: weathered seal, grey with a blue cast
    (132, 112, 84),    # 2 dirt: graded earth/gravel
    (82, 68, 52),      # 3 mud: soaked, much darker than the dirt it came from
], dtype=np.float32)

# per class: (rut depth as an albedo darkening, rut lateral wander amplitude
# as a fraction of the rut offset, slab-patch amplitude, pothole amplitude)
ROAD_SURFACE_STYLE = np.array([
    (0.00, 0.00, 0.00, 0.00),
    (0.04, 0.06, 0.09, 1.70),   # bitumen: barely rutted, patched and potholed
    (0.16, 0.22, 0.05, 0.30),   # dirt: clear wheel pair, wanders
    (0.34, 0.30, 0.03, 0.15),   # mud: deep dark ruts that wander hard
], dtype=np.float32)
SAND_COLOR = np.array((178, 160, 128), dtype=np.float32)
BED_SHALLOW = np.array((110, 108, 88), dtype=np.float32)   # wet gravel
BED_DEEP = np.array((52, 64, 58), dtype=np.float32)        # dark silt

# Ground-stamp styles (placement.py StampEmit fields -> bake colour + which
# splat-distr detail channel carries their per-texel grain).
# stamp id -> (colour, tone noise amplitude, splat channel index or None)
STAMP_STYLE = {
    "scree": (np.array((124, 117, 108), dtype=np.float32), 0.10, 1),  # rock granulation
    "sand":  (SAND_COLOR, 0.08, 2),                                   # sand ripple
}


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
        stamps: dict[str, np.ndarray] | None = None,   # placement.py ground stamps
        road_class: np.ndarray | None = None,          # roads.rasterize_roads_classified
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
        # No class raster means a pre-R1 caller: every deck bakes as the one
        # historical road colour with no ruts, byte for byte as before.
        self.rclass = None if road_class is None else road_class.astype(np.uint8)
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

        # Smoothed per-biome weight fields (grid res). Baking blends colours
        # through these instead of nearest-id lookup, so biome edges become
        # gradual, irregular transitions rather than 8-elmo grid staircases.
        from scipy import ndimage
        ids = np.unique(biome_ids)
        self.bio_ids = ids
        fields = np.empty(biome_ids.shape + (ids.size,), dtype=np.float32)
        for i, b_val in enumerate(ids):
            fields[..., i] = ndimage.gaussian_filter(
                (biome_ids == b_val).astype(np.float32), 2.0
            )
        self.bio_fields = fields
        self.bio_lut = self.lut[ids]                      # (nb, 3)
        # per-biome patchiness sign: adjacent-id biomes get opposite signs so
        # one shared noise field pushes their shared boundary both ways
        self.bio_sign = np.where((ids.astype(np.int64) & 1) > 0, 1.0, -1.0).astype(np.float32)
        self.veg_idx = np.flatnonzero(np.isin(ids, [bio.GRASSLAND, bio.FOREST, bio.WETLAND]))
        self.snow_idx = np.flatnonzero(ids == bio.SNOW)

        # ground stamps (scree/sand …): (field, colour, tone amp) per stamp
        self.stamp_list = [
            (fld.astype(np.float32),) + STAMP_STYLE[name][:2]
            for name, fld in (stamps or {}).items()
            if name in STAMP_STYLE
        ]

    def _bilinear(self, arr: np.ndarray, x: np.ndarray, z: np.ndarray) -> np.ndarray:
        cx = np.clip(x / self.cs, 0, self.gw - 1.001)
        cz = np.clip(z / self.cs, 0, self.gh - 1.001)
        c0 = cx.astype(np.int32); r0 = cz.astype(np.int32)
        fx = (cx - c0).astype(np.float32); fz = (cz - r0).astype(np.float32)
        c1 = np.minimum(c0 + 1, self.gw - 1); r1 = np.minimum(r0 + 1, self.gh - 1)
        if arr.ndim == 3:                    # vector field (H, W, K)
            fx = fx[..., None]; fz = fz[..., None]
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

        # --- tonal variation: macro patchiness + mid-scale mottling ---
        # Deliberately NO per-texel grain here: the SMT layer is deduplicated
        # (dxt1.cluster_tiles), so baked high-frequency noise turns into a
        # visibly repeating 32-elmo tile pattern. Per-texel grain is the
        # runtime splat-detail layer's job; the bake stays low-frequency.
        macro = tn.fbm(self.noise, X / 620.0, Z / 620.0, octaves=3).astype(np.float32)
        mid = tn.fbm(self.noise, X / 52.0 + 91.0, Z / 52.0 - 47.0, octaves=2).astype(np.float32)

        # --- biome colour: smoothed weight fields through a warped domain ---
        # Boundaries become irregular, patchy gradients instead of the 8-elmo
        # axis-aligned staircase that nearest-id lookup produced.
        wax = tn.fbm(self.noise, X / 140.0 + 37.0, Z / 140.0 - 11.0, octaves=2)
        waz = tn.fbm(self.noise, X / 140.0 + 177.0, Z / 140.0 + 91.0, octaves=2)
        wbx = tn.fbm(self.noise, X / 26.0 - 63.0, Z / 26.0 + 29.0, octaves=1)
        wbz = tn.fbm(self.noise, X / 26.0 + 7.0, Z / 26.0 - 101.0, octaves=1)
        wx = X + 22.0 * wax + 6.0 * wbx
        wz = Z + 22.0 * waz + 6.0 * wbz
        wgt = self._bilinear(self.bio_fields, wx, wz)     # (rows, w, nb)
        # patchy transition zones: one shared noise field pushes each biome's
        # weight up/down (opposite signs for adjacent ids); only active where
        # weights are mixed (w*(1-w) term), interiors are untouched
        wgt = np.clip(
            wgt + 0.5 * (mid[..., None] * self.bio_sign) * (4.0 * wgt * (1.0 - wgt)),
            0.0, 1.0,
        )
        wgt *= wgt                                        # sharpen the blend band
        wgt /= np.maximum(wgt.sum(axis=-1, keepdims=True), 1e-5)
        col = (wgt @ self.bio_lut).astype(np.float32)     # (rows, w, 3)

        tone = 1.0 + 0.10 * macro + 0.05 * mid
        col *= tone[..., None]

        # hue drift on vegetation (yellower when dry, greener when wet)
        vegw = wgt[..., self.veg_idx].sum(axis=-1) if self.veg_idx.size else np.float32(0)
        dryness = np.clip(0.55 - moist, 0.0, 0.55) / 0.55
        col[..., 0] += 26.0 * vegw * dryness * (0.6 + 0.4 * macro)
        col[..., 1] -= 8.0 * vegw * dryness

        # --- slope rock exposure (any biome) ---
        snoww = wgt[..., self.snow_idx].sum(axis=-1) if self.snow_idx.size else np.float32(0)
        rockmix = np.clip((slope - 22.0) / 14.0, 0.0, 1.0).astype(np.float32)
        rockmix *= 1.0 - 0.4 * snoww                      # snow clings longer
        rock_tone = ROCK_COLOR * (1.0 + 0.12 * macro + 0.06 * mid)[..., None]
        col = col * (1 - rockmix[..., None]) + rock_tone * rockmix[..., None]

        # --- ground stamps (scree, sand, …) — warped sampling for ragged edges ---
        for fld, s_color, s_tone in self.stamp_list:
            sw = np.clip(self._bilinear(fld, wx, wz), 0.0, 1.0).astype(np.float32)
            s_col = s_color * (1.0 + s_tone * mid)[..., None]
            col = col * (1 - sw[..., None]) + s_col * sw[..., None]

        # --- wetness + waterbed ---
        depth = np.clip(self.wl - h, 0.0, None)
        under = depth > 0.0
        bedmix = np.clip(depth / 22.0, 0.0, 1.0)[..., None].astype(np.float32)
        bed = BED_SHALLOW * (1 - bedmix) + BED_DEEP * bedmix
        bed *= (1.0 + 0.06 * mid)[..., None]
        col = np.where(under[..., None], bed, col)

        # shoreline: sand band just above water, wet-darkening
        shore = np.clip((h - self.wl) / 6.0, 0.0, 1.0)
        sandmix = ((1.0 - shore) * (slope < 14.0) * (~under)).astype(np.float32)
        col = col * (1 - 0.7 * sandmix[..., None]) + SAND_COLOR * (0.7 * sandmix[..., None])
        wet = np.clip((4.0 - (h - self.wl)) / 8.0, 0.0, 0.35).astype(np.float32)
        col *= (1.0 - np.where(~under, wet, 0.0))[..., None]

        # --- roads: sharp deck, soft shoulder ---
        half = self.road_w * 0.5
        if self.rclass is None:
            deck = np.clip((half - rdist) / 3.0, 0.0, 1.0).astype(np.float32)   # sharp edge
            road_tone = ROAD_COLOR * (1.0 + 0.08 * mid)[..., None]
        else:
            # Ragged edge: warping the distance field before thresholding makes
            # the deck boundary wander a couple of elmos, which is what an
            # unsealed road's edge does. The seal's edge wanders less, so the
            # amplitude is scaled down on bitumen further below.
            edge = tn.fbm(self.noise, X / 9.0 + 311.0, Z / 9.0 - 137.0,
                          octaves=2).astype(np.float32)
            # class is sampled through the same domain warp the biomes use, so
            # a seal that ends mid-route ends on a ragged line rather than on
            # an 8-elmo grid step
            rcls = self._nearest(self.rclass, wx, wz).astype(np.int64)
            style = ROAD_SURFACE_STYLE[rcls]                 # (rows, w, 4)
            rut_amp = style[..., 0]
            wander_amp = style[..., 1]
            patch_amp = style[..., 2]
            hole_amp = style[..., 3]

            sealed = (rcls == rd.SURF_BITUMEN)
            ragged = 2.6 * (1.0 - 0.7 * sealed)              # seal holds its edge
            deck = np.clip((half - (rdist + ragged * edge)) / 3.0, 0.0, 1.0
                           ).astype(np.float32)

            road_tone = ROAD_SURFACE_COLOR[rcls] * (1.0 + 0.08 * mid)[..., None]

            # Bitumen patchwork: a repaired seal is a mosaic of slabs at
            # slightly different ages. Patch shapes come from a mid-scale
            # field thresholded into blocks; potholes are the same field's
            # sharp tail, kept at ~9 elmos rather than per-texel because the
            # SMT dictionary would turn true per-texel speckle into a visibly
            # repeating tile (see the module docstring).
            patch = tn.fbm(self.noise, X / 34.0 - 211.0, Z / 34.0 + 83.0,
                           octaves=2).astype(np.float32)
            hole = tn.fbm(self.noise, X / 9.0 - 17.0, Z / 9.0 + 233.0,
                          octaves=2).astype(np.float32)
            # tanh rather than a hard threshold: a step turns the seal into
            # cobbles, which is what the first pass looked like. `hole`'s
            # cut is up at the 99.5th percentile of the field so potholes are
            # rare enough to read as damage rather than as gravel.
            slab = np.tanh(2.5 * patch).astype(np.float32)
            holes = np.clip(hole - 0.77, 0.0, 1.0).astype(np.float32)
            road_tone *= (1.0 + patch_amp * slab - hole_amp * holes)[..., None]

            # Baked wheel ruts. `rdist` is UNSIGNED distance to the centreline,
            # so one band at a fixed offset is already the pair of ruts — one
            # on each side — without ever needing a signed lateral coordinate.
            # The wander field is low-frequency along the map, so the pair
            # drifts and, where it drifts far, the ruts of passing traffic
            # overlap the verge exactly as a well-used track's do.
            wander = tn.fbm(self.noise, X / 74.0 + 57.0, Z / 74.0 - 29.0,
                            octaves=2).astype(np.float32)
            rut_off = half * 0.42 * (1.0 + wander_amp * wander)
            rut_w = max(2.5, self.road_w * 0.09)
            band = np.exp(-((rdist - rut_off) / rut_w) ** 2).astype(np.float32)
            road_tone *= (1.0 - rut_amp * band)[..., None]

        shoulder = np.clip((half * 2.2 - rdist) / (half * 2.2), 0.0, 1.0) ** 2
        shoulder = (shoulder * 0.35 * (deck < 0.5)).astype(np.float32)
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
    u = xx / size
    v = yy / size

    def wrap_fbm(freq_x, freq_y, ox, oy, octaves):
        # Seamlessly tiling fbm via 4-corner blend. The blend weights u/v MUST
        # come from the raw tile coords; domain offsets and anisotropic
        # frequency apply inside the noise sample only. (Passing offset/scaled
        # coords as the blend coords pushed u,v outside [0,1] — extrapolation
        # instead of blending — which showed up in-game as structured banding
        # repeating at the splat texscale period.)
        def s(px, py):
            return tn.fbm(n, px / freq_x + ox, py / freq_y + oy, octaves=octaves)
        a = s(xx, yy); b = s(xx - size, yy)
        c = s(xx, yy - size); d = s(xx - size, yy - size)
        return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v

    # R: grass — clumps + fine blade streaks (high freq in x, stretched in y)
    grass = wrap_fbm(9.0, 9.0, 0.0, 0.0, 4) * 0.9 + wrap_fbm(1.7, 15.0, 31.0, 0.0, 2) * 0.4
    # G: rock granulation (inverted ridged)
    rock = np.abs(wrap_fbm(34.0, 34.0, 71.0, -13.0, 5)) * -1.3 + 0.35
    # B: sand/dirt ripple — x-periodic sine (integer cycles per tile) + patches
    ripple_cycles = 18.0  # ~57 px wavelength, exact tile period
    sand = (
        np.sin(2 * np.pi * ripple_cycles * u + wrap_fbm(60.0, 60.0, 0.0, 0.0, 3) * 14.0) * 0.35
        + wrap_fbm(7.0, 7.0, -5.0, 44.0, 3) * 0.3
    )
    # A: snow/soft undulation
    snow = wrap_fbm(16.0, 16.0, 200.0, 200.0, 4) * 0.5

    out = np.stack([grass, rock, sand, snow], axis=-1)
    # zero-mean each channel: signed splat detail must average to 0 so the
    # mip-faded far field matches the near field with no brightness offset
    out -= out.mean(axis=(0, 1))
    out = np.clip(0.5 + 0.5 * out / (out.std(axis=(0, 1)) * 3.0), 0.0, 1.0)
    return (out * 255).astype(np.uint8)


def make_splat_distr(
    biome_ids: np.ndarray, slope_deg: np.ndarray, height: np.ndarray,
    water_level: float, size: int = 1024,
    stamps: dict[str, np.ndarray] | None = None,
    road_class: np.ndarray | None = None,
) -> np.ndarray:
    """RGBA weights choosing the 4 detail layers (grass/rock/sand/snow) from
    biome + slope (+ placement ground stamps), downsampled + blurred to `size`.

    Road decks claim the ROCK channel, because the runtime detail layer is
    what supplies per-texel grain and a road's grain is aggregate, not grass —
    without this a dirt track keeps the grass detail of the field it crosses.
    There is no fifth channel to give roads their own detail layer (the format
    is RGBA), so mud, whose surface is smooth rather than granular, is left to
    the biome's own weights instead of being handed a gravel grain."""
    from scipy import ndimage

    grass = np.isin(biome_ids, [bio.GRASSLAND, bio.FOREST, bio.WETLAND]).astype(np.float32)
    rockb = (biome_ids == bio.ROCK).astype(np.float32)
    rockb = np.maximum(rockb, np.clip((slope_deg - 22.0) / 14.0, 0, 1))
    sand = np.isin(biome_ids, [bio.DESERT]).astype(np.float32)
    sand = np.maximum(sand, (height < water_level + 4.0) & (height > water_level - 6.0))
    snow = np.isin(biome_ids, [bio.SNOW, bio.TUNDRA]).astype(np.float32)
    snow[biome_ids == bio.TUNDRA] = 0.4

    # ground stamps carry the matching detail grain (scree -> rock channel, …)
    chans = [grass, rockb, sand, snow]
    for name, fld in (stamps or {}).items():
        style = STAMP_STYLE.get(name)
        if style and style[2] is not None:
            np.maximum(chans[style[2]], fld.astype(np.float32) * 0.9,
                       out=chans[style[2]])
    grass, rockb, sand, snow = chans

    if road_class is not None:
        aggregate = np.isin(road_class, [rd.SURF_BITUMEN, rd.SURF_DIRT])
        grass = np.where(aggregate, 0.0, grass)
        sand = np.where(aggregate, 0.0, sand)
        snow = np.where(aggregate, 0.0, snow)
        rockb = np.where(aggregate, 1.0, rockb)

    w = np.stack([grass, rockb, sand, snow], axis=-1)
    total = w.sum(axis=-1, keepdims=True)
    w = np.divide(w, total, out=np.zeros_like(w), where=total > 0)

    zoom = size / biome_ids.shape[0]
    w4 = np.stack(
        [ndimage.zoom(ndimage.gaussian_filter(w[..., i], 1.5), zoom, order=1) for i in range(4)],
        axis=-1,
    )
    return np.clip(w4 * 255, 0, 255).astype(np.uint8)
