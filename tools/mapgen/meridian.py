#!/usr/bin/env python3
"""Meridian Basin map generator — PLAN-metalstorm-beta-map.md task 2.

Reads the single source-of-truth layout graph (meridian_layout.json) and
deterministically builds:
  - content/maps/meridian_basin/maps/meridian_basin.smf  (heightmap, typemap,
    tile index, metalmap, minimap — all binary, Spring SMF layout)
  - content/maps/meridian_basin/maps/meridian_basin.smt  (DXT1 tile set)
  - content/maps/meridian_basin/mapdata/regions.lua       (region graph,
    PLAN-metalstorm-regions.md §1.1 schema)

The heightmap and regions.lua are both derived from the same per-region
target-elevation table below, so slope bands are guaranteed by construction
(E1) rather than sculpted by eye. Everything is a pure function of the
layout JSON plus the constants in this file — no OS-provided randomness is
used, so re-running with the same inputs reproduces byte-identical output
(verified by `--selftest`, which runs generation twice and hashes both).

Usage:
    python3 tools/mapgen/meridian.py [--out DIR] [--selftest]
"""
import argparse
import hashlib
import json
import math
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
LAYOUT_PATH = os.path.join(HERE, "meridian_layout.json")

SQUARE_SIZE = 8
MAP_SIZE = 16384
MAPX = MAP_SIZE // SQUARE_SIZE          # 2048 squares
MAPY = MAP_SIZE // SQUARE_SIZE
HM_W = MAPX + 1                          # 2049 heightmap vertices/row
HM_H = MAPY + 1
TILES_X = MAPX // 4                      # 512 (each tile = 4 squares = 32 elmos)
TILES_Z = MAPY // 4
HALF_X = MAPX // 2                       # 1024 (typemap/metalmap resolution)
HALF_Z = MAPY // 2

# Control grid: 32-elmo spacing (4 heightmap vertices), upsampled bilinearly.
CTRL_STEP_VERTS = 4
CTRL_W = (HM_W - 1) // CTRL_STEP_VERTS + 1  # 513
CTRL_H = (HM_H - 1) // CTRL_STEP_VERTS + 1

# Half-width (elmos) of the smoothstep blend zone straddling each region
# boundary, blended per-boundary as avg(marginA, marginB). Ridge regions
# get a wide margin so their ramp fills most of their row depth (keeping
# the target slope band dominant across their area); ford/basin regions
# get a narrow margin so they keep a flat crossing deck even squeezed
# between two tall ridges on opposite sides (see the hand-tune notes in
# docs/maps-native.md).
DEFAULT_MARGIN = 550.0
RIDGE_MARGIN = 900.0
FORD_MARGIN = 250.0
# A region's OWN plateau/flat-core size is governed by how far its
# NEIGHBOURS reach into it, not by its own margin — a region that is the
# sole nonzero-weight contributor at a point gets that point's full
# elevation regardless of its own weight magnitude. So to shrink a ridge
# region's flat crest (and land its dominant band on the ramp instead),
# widen the *neighbouring* unchecked regions' margins (valley/civilian
# rows, deep water) rather than the ridge's own. Ford/corridor regions
# (west_pass/east_pass) are E1-checked and already land correctly with
# FORD_MARGIN — leave them alone; widen meridian_basin instead (also
# unchecked) to eat into hollow_overlook_n/gulch_overlook_s from the south.
VALLEY_MARGIN = 900.0

MARGIN_OVERRIDE = {
    "west_scarp_n": 750.0, "west_scarp_s": 750.0,
    "hollow_overlook_n": RIDGE_MARGIN, "gulch_overlook_s": RIDGE_MARGIN,
    "east_bluffs_n": RIDGE_MARGIN, "east_bluffs_s": RIDGE_MARGIN,
    "west_pass": FORD_MARGIN, "east_pass": FORD_MARGIN,
    "meridian_basin": 700.0, "west_narrows": 900.0,
    "still_mere": 500.0, "heron_ait": FORD_MARGIN,
    "ash_habitat": VALLEY_MARGIN, "granary_vale": VALLEY_MARGIN, "north_market": VALLEY_MARGIN,
    "shale_habitat": VALLEY_MARGIN, "sorghum_vale": VALLEY_MARGIN, "south_market": VALLEY_MARGIN,
}

MIN_HEIGHT = -80.0
MAX_HEIGHT = 1400.0

# ============================================================
# Per-region target elevation (elmos, world Y=0 is water level).
# Hand-tuned so that the bbox-boundary blend (MARGIN wide) lands each
# ridge/pass region's dominant slope in its intended moveinfo.tdf band:
#   flat <=24, veh 24-32, infantry 32-45, cliff >45 (see meridian_layout.json
#   slope_bands). Home/valley rows are close in elevation (near-flat);
#   ridge rows (C/E) sit far above the river row (D) so the boundary ramp
#   lands in the infantry/veh band by construction.
# ============================================================
ELEVATION = {
    # Row A / G — home plateaus (flat, gentle)
    "cinder_forge": 140, "northgate": 140, "northwatch": 140,
    "slag_forge": 140, "southgate": 140, "southwatch": 140,
    # Row B / F — valley / civilian transit spine (flat, slightly lower)
    "ash_habitat": 110, "granary_vale": 110, "north_market": 110,
    "shale_habitat": 110, "sorghum_vale": 110, "south_market": 110,
    # Row C / E — ridge corridors
    "west_scarp_n": 1230, "west_scarp_s": 1230,           # infantry-only (32-45deg)
    "hollow_overlook_n": 950, "gulch_overlook_s": 950,    # veh/heavy_restricted (24-32deg)
    "east_bluffs_n": 950, "east_bluffs_s": 950,           # veh/heavy_restricted (24-32deg)
    # Row D — river / contested band
    "west_narrows": -34,      # deep channel (>30 depth)
    "west_pass": -6,          # ford deck (<=12 depth), flat
    "meridian_basin": -4,     # basin ford, widest crossing, flat
    "east_pass": -6,          # ford deck, flat
    "still_mere": -25,        # graded lake, mid-depth (20-30 band)
    "heron_ait": 18,          # buildable island, just above water
}

# Regions whose bbox overlaps another (first-declared wins per
# PLAN-metalstorm-regions.md's documented overlap rule). Maps the
# lower-priority key to the higher-priority key that suppresses it.
OVERLAP_SUPPRESSED_BY = {"still_mere": "heron_ait"}


def load_layout():
    with open(LAYOUT_PATH) as f:
        return json.load(f)


def region_bbox_list(layout):
    return [(r["key"], r["bbox"], ELEVATION[r["key"]],
              MARGIN_OVERRIDE.get(r["key"], DEFAULT_MARGIN))
             for r in layout["regions"]]


def bbox_weight(x, z, bbox, margin):
    """1.0 deep inside the bbox, 0.0 more than `margin` outside it,
    LINEARLY blended across a 2*margin-wide zone straddling the edge.
    A cubic smoothstep was tried first but its derivative tapers to zero
    at both ends of the transition, wasting most of the ramp width on
    sub-target slope (only the ramp's midpoint reaches the intended
    degree) — a linear ramp holds close to the target slope across
    nearly the whole transition, which is what E1 (dominant-band-by-area)
    needs. The corner kink this introduces is a cosmetic hand-tune item,
    not a correctness one."""
    dx = max(bbox["x0"] - x, 0.0, x - bbox["x1"])
    dz = max(bbox["z0"] - z, 0.0, z - bbox["z1"])
    if dx > 0.0 or dz > 0.0:
        dist = math.sqrt(dx * dx + dz * dz)  # positive = outside
    else:
        dist = -min(x - bbox["x0"], bbox["x1"] - x, z - bbox["z0"], bbox["z1"] - z)  # negative = inside
    # dist <= -margin -> weight 1; dist >= margin -> weight 0
    t = (margin - dist) / (2.0 * margin)
    return max(0.0, min(1.0, t))


def make_height_fn(regions):
    def height_at(x, z):
        weights = {}
        for key, bbox, _elev, margin in regions:
            w = bbox_weight(x, z, bbox, margin)
            if w > 0.0:
                weights[key] = w
        # First-declared-wins overlap suppression (heron_ait over still_mere).
        for loser, winner in OVERLAP_SUPPRESSED_BY.items():
            if loser in weights and winner in weights:
                weights[loser] *= (1.0 - weights[winner])
        total = sum(weights.values())
        if total <= 0.0:
            return 0.0
        elev = {k: e for k, _b, e, _m in regions}
        return sum(w * elev[k] for k, w in weights.items()) / total
    return height_at


def build_control_grid(regions):
    height_at = make_height_fn(regions)
    grid = [[0.0] * CTRL_W for _ in range(CTRL_H)]
    for cz in range(CTRL_H):
        z = min(cz * CTRL_STEP_VERTS * SQUARE_SIZE, MAP_SIZE)
        row = grid[cz]
        for cx in range(CTRL_W):
            x = min(cx * CTRL_STEP_VERTS * SQUARE_SIZE, MAP_SIZE)
            row[cx] = height_at(x, z)
    return grid


def upsample_heightmap(grid):
    """Bilinear upsample the CTRL_W x CTRL_H control grid to HM_W x HM_H."""
    hm = [0.0] * (HM_W * HM_H)
    step = CTRL_STEP_VERTS
    for vz in range(HM_H):
        cz0 = vz // step
        cz1 = min(cz0 + 1, CTRL_H - 1)
        fz = (vz - cz0 * step) / step
        row0 = grid[cz0]
        row1 = grid[cz1]
        base = vz * HM_W
        for vx in range(HM_W):
            cx0 = vx // step
            cx1 = min(cx0 + 1, CTRL_W - 1)
            fx = (vx - cx0 * step) / step
            h00 = row0[cx0]; h10 = row0[cx1]
            h01 = row1[cx0]; h11 = row1[cx1]
            h0 = h00 + (h10 - h00) * fx
            h1 = h01 + (h11 - h01) * fx
            hm[base + vx] = h0 + (h1 - h0) * fz
    return hm


def slope_deg_at(hm, vx, vz):
    """Approximate slope angle (degrees) via central differences, matching
    the same formula the C++ E1 validator uses on the decoded heightmap."""
    x0 = max(vx - 1, 0); x1 = min(vx + 1, HM_W - 1)
    z0 = max(vz - 1, 0); z1 = min(vz + 1, HM_H - 1)
    dhdx = (hm[vz * HM_W + x1] - hm[vz * HM_W + x0]) / ((x1 - x0) * SQUARE_SIZE or 1)
    dhdz = (hm[z1 * HM_W + vx] - hm[z0 * HM_W + vx]) / ((z1 - z0) * SQUARE_SIZE or 1)
    grad = math.sqrt(dhdx * dhdx + dhdz * dhdz)
    return math.degrees(math.atan(grad))


def water_depth_at(h):
    return max(0.0, -h)


def slope_band(deg):
    if deg <= 24: return "flat"
    if deg <= 32: return "veh"
    if deg <= 45: return "infantry"
    return "cliff"


def water_band(depth):
    if depth <= 12: return "ford"
    if depth <= 20: return "shallow"
    if depth <= 30: return "deep"
    return "channel"


# ============================================================
# regions.lua emission
# ============================================================

def bbox_polygon(bbox):
    return [
        (bbox["x0"], bbox["z0"]), (bbox["x1"], bbox["z0"]),
        (bbox["x1"], bbox["z1"]), (bbox["x0"], bbox["z1"]),
    ]


def emit_regions_lua(layout, out_path):
    regions = list(layout["regions"])
    # heron_ait must be declared before still_mere (first-declared wins the bbox overlap).
    order = {r["key"]: i for i, r in enumerate(regions)}
    regions.sort(key=lambda r: (0 if r.get("declare_before") else 1, order[r["key"]]))

    lines = []
    lines.append("-- mapdata/regions.lua — GENERATED by tools/mapgen/meridian.py")
    lines.append("-- from tools/mapgen/meridian_layout.json. Do not hand-edit; regenerate.")
    lines.append("-- See PLAN-metalstorm-regions.md §1.1 for the authoring format.")
    lines.append("")
    lines.append("return {")
    lines.append("    version = 1,")
    lines.append("    regions = {")
    for r in regions:
        poly = bbox_polygon(r["bbox"])
        poly_str = ", ".join(f"{{x={x}, z={z}}}" for x, z in poly)
        tags_str = ", ".join(f'"{t}"' for t in r["tags"])
        neighbors_str = ", ".join(f'"{n}"' for n in r["neighbors"])
        lines.append("        {")
        lines.append(f'            key = "{r["key"]}",')
        lines.append(f'            name = "{r["name"]}",')
        lines.append(f"            polygon = {{ {poly_str} }},")
        lines.append(f'            value = {r["value"]},')
        lines.append(f"            tags = {{ {tags_str} }},")
        lines.append(f"            neighbors = {{ {neighbors_str} }},")
        lines.append("        },")
    lines.append("    },")
    lines.append("}")
    lines.append("")
    with open(out_path, "w") as f:
        f.write("\n".join(lines))


# ============================================================
# DXT1 helpers
# ============================================================

def rgb565(r, g, b):
    r = max(1, min(255, int(r)))  # keep >0 so color0 != 0 (lets us force color0>color1)
    g = max(0, min(255, int(g)))
    b = max(0, min(255, int(b)))
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)


def unpack565(c):
    return (((c >> 11) & 31) * 255 + 15) // 31, \
           (((c >> 5) & 63) * 255 + 31) // 63, \
           ((c & 31) * 255 + 15) // 31


def solid_dxt1_block(rgb):
    c0 = rgb565(*rgb)
    c1 = c0 - 1 if c0 > 0 else 0
    return struct.pack("<HHI", c0, c1, 0)


def encode_dxt1_block(px):
    """Encode 16 (r,g,b) texels (row-major 4x4) as one DXT1 block.
    Endpoints are the luminance extremes of the block — our texel variation
    is value-dominated (grain/shade around 1-2 base hues), so the luminance
    axis is a good principal axis without a full PCA fit."""
    lmin = lmax = None
    pmin = pmax = px[0]
    for p in px:
        lum = p[0] * 299 + p[1] * 587 + p[2] * 114
        if lmin is None or lum < lmin:
            lmin = lum; pmin = p
        if lmax is None or lum > lmax:
            lmax = lum; pmax = p
    c0 = rgb565(*pmax)
    c1 = rgb565(*pmin)
    if c0 == c1:
        return solid_dxt1_block(pmax)
    if c0 < c1:
        c0, c1 = c1, c0
    e0 = unpack565(c0)
    e1 = unpack565(c1)
    pal = (e0, e1,
           tuple((2 * a + b + 1) // 3 for a, b in zip(e0, e1)),
           tuple((a + 2 * b + 1) // 3 for a, b in zip(e0, e1)))
    bits = 0
    for i in range(15, -1, -1):
        r, g, b = px[i]
        best = 0
        bestd = None
        for pi in range(4):
            pr, pg, pb = pal[pi]
            d = (r - pr) * (r - pr) + (g - pg) * (g - pg) + (b - pb) * (b - pb)
            if bestd is None or d < bestd:
                bestd = d; best = pi
        bits = (bits << 2) | best
    return struct.pack("<HHI", c0, c1, bits)


def downsample_2x(img):
    """Box-filter a square row-major RGB image to half resolution."""
    n = len(img) // 2
    out = []
    for z in range(n):
        r0 = img[z * 2]; r1 = img[z * 2 + 1]
        row = []
        for x in range(n):
            a = r0[x * 2]; b = r0[x * 2 + 1]
            c = r1[x * 2]; d = r1[x * 2 + 1]
            row.append(((a[0] + b[0] + c[0] + d[0] + 2) // 4,
                        (a[1] + b[1] + c[1] + d[1] + 2) // 4,
                        (a[2] + b[2] + c[2] + d[2] + 2) // 4))
        out.append(row)
    return out


def encode_dxt1_image(img):
    """DXT1-encode a square row-major RGB image (side divisible by 4)."""
    n = len(img)
    out = bytearray()
    for bz in range(n // 4):
        for bx in range(n // 4):
            texels = [img[bz * 4 + r][bx * 4 + c]
                      for r in range(4) for c in range(4)]
            out += encode_dxt1_block(texels)
    return bytes(out)


def encode_tile_record(img):
    """One SMT small-tile record from a 32x32 RGB image: real box-filtered
    mip chain mip0(64 blocks) + mip1(16) + mip2(4) + mip3(1) = 680 bytes.
    MapProcessor extracts all 4 levels (mip-chain fix), so the mips must be
    genuine downsamples, not repeats."""
    rec = bytearray()
    for lvl in range(4):
        rec += encode_dxt1_image(img)
        if lvl < 3:
            img = downsample_2x(img)
    assert len(rec) == 680, len(rec)
    return bytes(rec)


# ============================================================
# Tile / minimap palette — the DRY-LAND bands sample the actual shared
# palette atlas (data/games/metalstorm/unittextures/atlas_palette.ktx2,
# built by tools/scripts/make_palette_atlas.py from art/STYLE.md's swatch
# table) row 3 verbatim, hex-for-hex, so terrain reads as the SAME
# material language as buildings/civilian props (PLAN-metalstorm-beta-map.md
# §2 step 2's "texture pass uses the shared palette/atlas art direction").
# Water has no swatch in that atlas (it's a unit/building material sheet) —
# the four water-band colours below are this map's own addition, not a
# re-use of shared art direction; called out here per CLAUDE.md's
# "never deviate from Recoil/shared-direction silently" rule.
# ============================================================

BAND_COLOR = {
    ("flat", None): (0x9C, 0x9A, 0x93),      # atlas row3 col0 "concrete grey" — build zones / passes
    ("veh", None): (0x6B, 0x6F, 0x73),       # atlas row1 col2 "worn steel" — overlook slopes
    ("infantry", None): (0xC6, 0xB3, 0x93),  # atlas row3 col2 "civilian tan" — scarp walls
    ("cliff", None): (0x2B, 0x2B, 0x2C),     # atlas row3 col3 "ground-contact dark" — crests
    (None, "ford"): (92, 132, 150),          # map-specific water blues — no atlas swatch exists for water
    (None, "shallow"): (60, 108, 140),
    (None, "deep"): (34, 78, 112),
    (None, "channel"): (18, 48, 78),
}

# Linear band scale: adjacent indices are the pairs that physically border
# each other (channel..ford depth ladder, ford->flat shoreline, flat->veh->
# infantry->cliff slope ladder), so band-boundary tiles blend index i with
# i+1 and every transition on the map is a two-neighbour lerp.
BAND_SCALE = [
    (None, "channel"), (None, "deep"), (None, "shallow"), (None, "ford"),
    ("flat", None), ("veh", None), ("infantry", None), ("cliff", None),
]
BAND_RGB = [BAND_COLOR[k] for k in BAND_SCALE]
BAND_SCALE_IDX = {k: i for i, k in enumerate(BAND_SCALE)}
N_WATER_BANDS = 4  # BAND_SCALE[0..3] are water


def band_scale_idx(h, deg):
    depth = water_depth_at(h)
    if depth > 0.0:
        return BAND_SCALE_IDX[(None, water_band(depth))]
    return BAND_SCALE_IDX[(slope_band(deg), None)]


# ============================================================
# Texture pass: per-texel grain + boundary dithering + hillshade.
# All stochastic look comes from integer hashing of texel/variant coords —
# no `random`, no OS entropy — so `--selftest` determinism holds.
# ============================================================

# Per-band grain character: (fine_amp, coarse_amp). Fine is per-texel; the
# coarse component samples a bilinear value-noise lattice (8-texel cells for
# water, 4-texel for dry land — see render_tile). Cliff/rock get the
# strongest, coarsest speckle; concrete/flat fine grain; water subtle.
GRAIN = {
    0: (0.020, 0.015),  # channel
    1: (0.020, 0.015),  # deep
    2: (0.025, 0.018),  # shallow
    3: (0.030, 0.022),  # ford
    4: (0.040, 0.028),  # flat concrete — fine grain
    5: (0.048, 0.040),  # worn-steel slopes
    6: (0.055, 0.050),  # civilian-tan scarps
    7: (0.060, 0.085),  # cliff — coarse dark rock speckle
}
# Grain is applied multiplicatively on a value-lifted colour so it stays
# visible on the near-black cliff swatch: out = (c + LIFT) * m - LIFT.
GRAIN_LIFT = 24

# Hillshade: fixed light direction consistent with mapinfo.lua sunDir
# {1, 0.7, 1}. Value-only modulation — hue stays with the palette.
_SUN_LEN = math.sqrt(1.0 + 0.7 * 0.7 + 1.0)
SUN_X, SUN_Y, SUN_Z = 1.0 / _SUN_LEN, 0.7 / _SUN_LEN, 1.0 / _SUN_LEN
SHADE_AMBIENT = 0.72         # multiplier for a fully sun-averted slope
SHADE_DIFFUSE = 0.52         # x dot(N, L)
ELEV_GAIN = 0.08             # higher terrain reads slightly lighter
WATER_SHADE_DAMP = 0.35      # bed relief shows through water, attenuated
SHADE_MIN, SHADE_MAX = 0.70, 1.26
SHADE_LEVELS = 16            # corner-shade quantization (per-texel dither masks steps)

NUM_VARIANTS = 4             # noise-phase variants per band (uniform tiles)
DITHER = 0.5                 # boundary dither amplitude (fraction of blend t)

TILE_T = 32                  # texels per tile edge


def _hash32(a, b, c):
    h = (a * 374761393 + b * 668265263 + c * 2246822519) & 0xFFFFFFFF
    h ^= h >> 13
    h = (h * 1274126177) & 0xFFFFFFFF
    h ^= h >> 16
    return h


def n01(a, b, c):
    return _hash32(a, b, c) / 4294967296.0


def shade_mult(hm, vx, vz):
    """Hillshade multiplier at a heightmap vertex: Lambert against the fixed
    sun direction plus a subtle absolute-elevation lightening, attenuated
    under water. Value-only by construction."""
    x0 = max(vx - 2, 0); x1 = min(vx + 2, HM_W - 1)
    z0 = max(vz - 2, 0); z1 = min(vz + 2, HM_H - 1)
    row = vz * HM_W
    dhdx = (hm[row + x1] - hm[row + x0]) / ((x1 - x0) * SQUARE_SIZE)
    dhdz = (hm[z1 * HM_W + vx] - hm[z0 * HM_W + vx]) / ((z1 - z0) * SQUARE_SIZE)
    inv = 1.0 / math.sqrt(dhdx * dhdx + 1.0 + dhdz * dhdz)
    d = (-dhdx * SUN_X + SUN_Y - dhdz * SUN_Z) * inv
    h = hm[row + vx]
    s = SHADE_AMBIENT + SHADE_DIFFUSE * max(0.0, d) \
        + ELEV_GAIN * (h - MIN_HEIGHT) / (MAX_HEIGHT - MIN_HEIGHT)
    if h < 0.0:
        s = 1.0 + (s - 1.0) * WATER_SHADE_DAMP
    return max(SHADE_MIN, min(SHADE_MAX, s))


def build_band_grid(hm):
    """Band-scale index at every EVEN heightmap vertex (16-elmo spacing) —
    the resolution the tile-corner masks and the minimap sample at. Grid is
    (2*TILES_X+1) x (2*TILES_Z+1), row-major bytes."""
    w2 = TILES_X * 2 + 1
    h2 = TILES_Z * 2 + 1
    grid = bytearray(w2 * h2)
    idx = 0
    for gz in range(h2):
        vz = min(gz * 2, HM_H - 1)
        for gx in range(w2):
            vx = min(gx * 2, HM_W - 1)
            h = hm[vz * HM_W + vx]
            if h < 0.0:
                grid[idx] = BAND_SCALE_IDX[(None, water_band(-h))]
            else:
                grid[idx] = BAND_SCALE_IDX[(slope_band(slope_deg_at(hm, vx, vz)), None)]
            idx += 1
    return grid, w2


def render_tile(bands, shades, variant):
    """Render one 32x32 tile as a 680-byte SMT record.

    `bands` is the 3x3 grid of band-scale indices at the tile's corner /
    edge-midpoint / centre vertices (16-elmo spacing); `shades` the
    quantized hillshade at the 4 corner vertices. Both are sampled at
    vertices shared with the neighbouring tiles, so band blends AND shading
    are continuous across tile edges (no 32-texel mosaic patches).
    Per texel: bilinear band blend + hash dither, band-flavoured grain,
    bilinear corner shade + dither."""
    shade_step = (SHADE_MAX - SHADE_MIN) / (SHADE_LEVELS - 1)
    s00, s10, s01, s11 = (SHADE_MIN + shade_step * q for q in shades)
    seed = variant * 131
    # Coarse value-noise lattices: 4-texel cells for dry land, 8 for water.
    lat4 = [[n01(seed + 17, gx, gz) for gx in range(TILE_T // 4 + 1)]
            for gz in range(TILE_T // 4 + 1)]
    lat8 = [[n01(seed + 29, gx, gz) for gx in range(TILE_T // 8 + 1)]
            for gz in range(TILE_T // 8 + 1)]
    img = []
    for v in range(TILE_T):
        pz = (v + 0.5) / 16.0
        j0 = min(int(pz), 1)
        tz = pz - j0
        row = []
        for u in range(TILE_T):
            px = (u + 0.5) / 16.0
            i0 = min(int(px), 1)
            tx = px - i0
            b00 = bands[j0 * 3 + i0]; b10 = bands[j0 * 3 + i0 + 1]
            b01 = bands[j0 * 3 + 3 + i0]; b11 = bands[j0 * 3 + 3 + i0 + 1]
            f = (b00 + (b10 - b00) * tx) * (1.0 - tz) \
                + (b01 + (b11 - b01) * tx) * tz
            lo = int(f)
            t = f - lo
            if t > 1e-6:
                t += (n01(seed + 43, u, v) - 0.5) * DITHER
                t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
                hi = min(lo + 1, 7)
                c0 = BAND_RGB[lo]; c1 = BAND_RGB[hi]
                r = c0[0] + (c1[0] - c0[0]) * t
                g = c0[1] + (c1[1] - c0[1]) * t
                b = c0[2] + (c1[2] - c0[2]) * t
                dom = lo if t < 0.5 else hi
            else:
                r, g, b = BAND_RGB[lo]
                dom = lo
            fine_amp, coarse_amp = GRAIN[dom]
            if dom < N_WATER_BANDS:
                lat, scale = lat8, 8
            else:
                lat, scale = lat4, 4
            gxf = u / scale; gi = int(gxf); gt = gxf - gi
            gzf = v / scale; gj = int(gzf); gu = gzf - gj
            l0 = lat[gj]; l1 = lat[gj + 1]
            cv = (l0[gi] + (l0[gi + 1] - l0[gi]) * gt) * (1.0 - gu) \
                + (l1[gi] + (l1[gi + 1] - l1[gi]) * gt) * gu
            fn = n01(seed + 57, u, v)
            su = (u + 0.5) / TILE_T
            sv = (v + 0.5) / TILE_T
            s = (s00 + (s10 - s00) * su) * (1.0 - sv) \
                + (s01 + (s11 - s01) * su) * sv \
                + (n01(seed + 71, u, v) - 0.5) * shade_step
            m = s * (1.0 + (fn - 0.5) * 2.0 * fine_amp
                     + (cv - 0.5) * 2.0 * coarse_amp)
            row.append((
                max(0, min(255, int((r + GRAIN_LIFT) * m - GRAIN_LIFT))),
                max(0, min(255, int((g + GRAIN_LIFT) * m - GRAIN_LIFT))),
                max(0, min(255, int((b + GRAIN_LIFT) * m - GRAIN_LIFT))),
            ))
        img.append(row)
    return encode_tile_record(img)


# ============================================================
# SMF / SMT assembly
# ============================================================

def quantize_heightmap(hm):
    scale = 65535.0 / (MAX_HEIGHT - MIN_HEIGHT)
    out = bytearray(len(hm) * 2)
    for i, h in enumerate(hm):
        v = int(round((max(MIN_HEIGHT, min(MAX_HEIGHT, h)) - MIN_HEIGHT) * scale))
        v = max(0, min(65535, v))
        struct.pack_into("<H", out, i * 2, v)
    return bytes(out)


def build_binary(layout):
    regions = region_bbox_list(layout)
    ctrl = build_control_grid(regions)
    hm = upsample_heightmap(ctrl)

    band_grid, bg_w = build_band_grid(hm)

    # Tile index + deduped tile set: each 32-elmo tile gets a descriptor
    # (3x3 corner band samples, quantized hillshade, noise-phase variant);
    # one 680-byte tile record is rendered per UNIQUE descriptor and the
    # tileindex references it. Corner samples are shared with neighbouring
    # tiles, so band blends are continuous across tile edges (no staircase).
    # Non-uniform (boundary) tiles coarsen shade and halve the variant space
    # to bound the unique-tile count (they carry enough per-tile variation
    # already; the SMT must stay within a few MB).
    # Quantized hillshade at every tile-corner vertex (shared between the
    # 4 tiles meeting there, so shading is continuous across tile edges).
    shade_w = TILES_X + 1
    shade_grid = bytearray(shade_w * (TILES_Z + 1))
    si = 0
    for cz in range(TILES_Z + 1):
        vz = min(cz * 4, HM_H - 1)
        for cx in range(shade_w):
            vx = min(cx * 4, HM_W - 1)
            sm = shade_mult(hm, vx, vz)
            shade_grid[si] = int(round((sm - SHADE_MIN)
                                       / (SHADE_MAX - SHADE_MIN)
                                       * (SHADE_LEVELS - 1)))
            si += 1

    tile_index = bytearray(TILES_X * TILES_Z * 4)
    tile_records = []
    record_index = {}
    ti = 0
    for tz in range(TILES_Z):
        for tx in range(TILES_X):
            bands = tuple(band_grid[(tz * 2 + j) * bg_w + tx * 2 + i]
                          for j in range(3) for i in range(3))
            shades = (shade_grid[tz * shade_w + tx],
                      shade_grid[tz * shade_w + tx + 1],
                      shade_grid[(tz + 1) * shade_w + tx],
                      shade_grid[(tz + 1) * shade_w + tx + 1])
            # Bound the unique-tile count (SMT stays within a few MB): full
            # variant diversity only where the tile is flat-band AND
            # flat-shade (plateau interiors, where repetition would show);
            # gradient tiles carry enough variation already.
            uniform = all(b == bands[0] for b in bands)
            flat_shade = shades[0] == shades[1] == shades[2] == shades[3]
            if uniform and flat_shade:
                variant = _hash32(tx, tz, 9176) % NUM_VARIANTS
            else:
                variant = _hash32(tx, tz, 9176) % 2
            if not uniform:
                shades = tuple(q & ~1 for q in shades)
            key = (bands, shades, variant)
            idx = record_index.get(key)
            if idx is None:
                idx = len(tile_records)
                record_index[key] = idx
                tile_records.append(render_tile(bands, shades, variant))
            struct.pack_into("<i", tile_index, ti, idx)
            ti += 4

    # typemap: single terrain type 0 everywhere (movement speed modifiers
    # come from moveinfo.tdf slope/depth thresholds, not the legacy
    # terrainTypes speed table — see mapinfo.lua terrainTypes[0]).
    typemap = bytes(HALF_X * HALF_Z)

    # metalmap: low-density deposits under industrial/buildzone regions.
    metalmap = bytearray(HALF_X * HALF_Z)
    industrial_keys = {r["key"] for r in layout["regions"] if "industrial" in r["tags"]}
    industrial_bboxes = [r["bbox"] for r in layout["regions"] if r["key"] in industrial_keys]
    for mz in range(HALF_Z):
        z = mz * SQUARE_SIZE * 2 + SQUARE_SIZE
        for mx in range(HALF_X):
            x = mx * SQUARE_SIZE * 2 + SQUARE_SIZE
            for bbox in industrial_bboxes:
                if bbox["x0"] <= x <= bbox["x1"] and bbox["z0"] <= z <= bbox["z1"]:
                    metalmap[mz * HALF_X + mx] = 30
                    break

    heightmap_bytes = quantize_heightmap(hm)

    # Minimap: 1024x1024 DXT1 (16 elmos/pixel) with the SAME band blending +
    # hillshade as the terrain tiles (continuous shade, not per-tile
    # quantized), so minimap and terrain agree and ridge/basin relief is
    # legible at a glance. The band grid's 16-elmo spacing matches the
    # minimap pixel grid exactly (offset half a cell).
    mm_px = 1024
    minimap = bytearray()
    row_px = []
    for py in range(mm_px):
        gzf = py + 0.5
        gj = min(int(gzf), TILES_Z * 2 - 1)
        gu = gzf - gj
        vz = min(int((py + 0.5) * 16 / SQUARE_SIZE), HM_H - 1)
        row = []
        for pxi in range(mm_px):
            gxf = pxi + 0.5
            gi = min(int(gxf), TILES_X * 2 - 1)
            gt = gxf - gi
            b00 = band_grid[gj * bg_w + gi]; b10 = band_grid[gj * bg_w + gi + 1]
            b01 = band_grid[(gj + 1) * bg_w + gi]; b11 = band_grid[(gj + 1) * bg_w + gi + 1]
            f = (b00 + (b10 - b00) * gt) * (1.0 - gu) \
                + (b01 + (b11 - b01) * gt) * gu
            lo = int(f)
            t = f - lo
            if t > 1e-6:
                t += (n01(pxi, py, 313) - 0.5) * 0.25
                t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
                hi = min(lo + 1, 7)
                c0 = BAND_RGB[lo]; c1 = BAND_RGB[hi]
                r = c0[0] + (c1[0] - c0[0]) * t
                g = c0[1] + (c1[1] - c0[1]) * t
                b = c0[2] + (c1[2] - c0[2]) * t
            else:
                r, g, b = BAND_RGB[lo]
            vx = min(int((pxi + 0.5) * 16 / SQUARE_SIZE), HM_W - 1)
            m = shade_mult(hm, vx, vz) \
                * (1.0 + (n01(pxi, py, 631) - 0.5) * 0.04)
            row.append((
                max(0, min(255, int((r + GRAIN_LIFT) * m - GRAIN_LIFT))),
                max(0, min(255, int((g + GRAIN_LIFT) * m - GRAIN_LIFT))),
                max(0, min(255, int((b + GRAIN_LIFT) * m - GRAIN_LIFT))),
            ))
        row_px.append(row)
    for by in range(mm_px // 4):
        for bx in range(mm_px // 4):
            texels = [row_px[by * 4 + r][bx * 4 + c]
                      for r in range(4) for c in range(4)]
            minimap += encode_dxt1_block(texels)

    return {
        "hm": hm,
        "heightmap_bytes": heightmap_bytes,
        "typemap": typemap,
        "metalmap": bytes(metalmap),
        "tile_index": bytes(tile_index),
        "minimap": bytes(minimap),
        "tile_records": tile_records,
    }


def write_smf(path, data):
    magic = b"spring map file\0"
    assert len(magic) == 16
    tile_file_name = b"meridian_basin.smt\0"
    num_tiles = len(data["tile_records"])

    tiles_section = struct.pack("<ii", 1, num_tiles)  # numTileFiles, totalTiles
    tiles_section += struct.pack("<i", len(tile_file_name)) + tile_file_name
    tiles_section += data["tile_index"]

    header_size = 76
    heightmap_ptr = header_size
    typemap_ptr = heightmap_ptr + len(data["heightmap_bytes"])
    tiles_ptr = typemap_ptr + len(data["typemap"])
    minimap_ptr = tiles_ptr + len(tiles_section)
    metalmap_ptr = minimap_ptr + len(data["minimap"])
    feature_ptr = metalmap_ptr + len(data["metalmap"])

    header = bytearray(header_size)
    header[0:16] = magic
    struct.pack_into("<i", header, 16, 1)   # version
    struct.pack_into("<i", header, 20, 0)   # mapid
    struct.pack_into("<i", header, 24, MAPX)
    struct.pack_into("<i", header, 28, MAPY)
    struct.pack_into("<i", header, 32, SQUARE_SIZE)
    struct.pack_into("<i", header, 36, SQUARE_SIZE)   # texelPerSquare
    struct.pack_into("<i", header, 40, 32)            # tilesize (elmos/tile)
    struct.pack_into("<f", header, 44, MIN_HEIGHT)
    struct.pack_into("<f", header, 48, MAX_HEIGHT)
    struct.pack_into("<i", header, 52, heightmap_ptr)
    struct.pack_into("<i", header, 56, typemap_ptr)
    struct.pack_into("<i", header, 60, tiles_ptr)
    struct.pack_into("<i", header, 64, minimap_ptr)
    struct.pack_into("<i", header, 68, metalmap_ptr)
    struct.pack_into("<i", header, 72, feature_ptr)

    features_section = struct.pack("<ii", 0, 0)  # numFeatureTypes, numFeatures

    with open(path, "wb") as f:
        f.write(bytes(header))
        f.write(data["heightmap_bytes"])
        f.write(data["typemap"])
        f.write(tiles_section)
        f.write(data["minimap"])
        f.write(data["metalmap"])
        f.write(features_section)


def write_smt(path, tile_records):
    header = bytearray(32)
    header[0:16] = b"spring tilefile\0"
    struct.pack_into("<i", header, 16, 1)          # version
    struct.pack_into("<i", header, 20, len(tile_records))  # numTiles
    with open(path, "wb") as f:
        f.write(bytes(header))
        for rec in tile_records:
            f.write(rec)


# ============================================================
# Self-check (mirrors the E1 slope-consistency rule the C++
# MapProcessor::ExtractRegions validator applies).
# ============================================================

TAG_EXPECTED_BAND = {
    "infantry_only": "infantry",
    "heavy_restricted": "veh",
    "corridor": "flat",
    "choke": "flat",
}

# infantry_only/heavy_restricted are about DRY ridge terrain passability —
# water underfoot isn't meaningful there, so those checks only sample dry
# ground. corridor/choke (ford decks) are the opposite: the deck is
# *meant* to be a shallow-water crossing (see meridian_layout.json
# chokepoints — west_ford_deck/east_ford_deck/basin_ford are all "ford"
# band, land_wade for every class), so excluding wet samples there would
# throw away exactly the flat crossing itself and only count the steep
# dry banks climbing up to the flanking ridges. Those tags check the
# underlying terrain slope regardless of the ford's shallow water on top.
TAGS_DRY_ONLY = {"infantry_only", "heavy_restricted"}


def selfcheck_slope_bands(layout, hm):
    problems = []
    for r in layout["regions"]:
        expected = None
        dry_only = False
        for tag in r["tags"]:
            if tag in TAG_EXPECTED_BAND:
                expected = TAG_EXPECTED_BAND[tag]
                dry_only = tag in TAGS_DRY_ONLY
                break
        if expected is None:
            continue
        bbox = r["bbox"]
        counts = {}
        n = 0
        step = 64
        z = bbox["z0"] + step / 2
        while z < bbox["z1"]:
            x = bbox["x0"] + step / 2
            while x < bbox["x1"]:
                vx = min(int(round(x / SQUARE_SIZE)), HM_W - 1)
                vz = min(int(round(z / SQUARE_SIZE)), HM_H - 1)
                h = hm[vz * HM_W + vx]
                if not dry_only or water_depth_at(h) <= 0.0:
                    deg = slope_deg_at(hm, vx, vz)
                    b = slope_band(deg)
                    counts[b] = counts.get(b, 0) + 1
                n += 1
                x += step
            z += step
        if not counts:
            continue
        dominant = max(counts, key=counts.get)
        frac = counts[dominant] / max(1, sum(counts.values()))
        ok = dominant == expected
        problems.append((r["key"], expected, dominant, frac, ok))
    return problems


# ============================================================
# Top-level
# ============================================================

def generate(out_dir):
    layout = load_layout()
    data = build_binary(layout)

    maps_dir = os.path.join(out_dir, "maps")
    mapdata_dir = os.path.join(out_dir, "mapdata")
    os.makedirs(maps_dir, exist_ok=True)
    os.makedirs(mapdata_dir, exist_ok=True)

    smf_path = os.path.join(maps_dir, "meridian_basin.smf")
    smt_path = os.path.join(maps_dir, "meridian_basin.smt")
    write_smf(smf_path, data)
    write_smt(smt_path, data["tile_records"])
    smt_bytes = 32 + 680 * len(data["tile_records"])
    print(f"tile set: {len(data['tile_records'])} unique tiles "
          f"({smt_bytes / 1e6:.2f} MB SMT)")
    if smt_bytes > 6_000_000:
        print("WARNING: SMT exceeds the ~few-MB budget — coarsen the tile "
              "descriptor quantization (SHADE_LEVELS / NUM_VARIANTS).",
              file=sys.stderr)

    regions_path = os.path.join(mapdata_dir, "regions.lua")
    emit_regions_lua(layout, regions_path)

    problems = selfcheck_slope_bands(layout, data["hm"])
    print("E1 self-check (dominant slope band per tagged region):")
    all_ok = True
    for key, expected, dominant, frac, ok in problems:
        status = "OK" if ok else "MISMATCH"
        if not ok:
            all_ok = False
        print(f"  {key:20s} expected={expected:10s} dominant={dominant:10s} "
              f"({frac*100:4.1f}% of dry samples)  {status}")
    if not all_ok:
        print("WARNING: one or more regions do not have their expected dominant "
              "slope band — hand-tune ELEVATION/MARGIN and regenerate.", file=sys.stderr)

    return smf_path, smt_path, regions_path, all_ok


def hash_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(REPO_ROOT, "content", "maps", "meridian_basin"))
    ap.add_argument("--selftest", action="store_true",
                     help="generate twice into temp dirs and assert identical output hashes")
    args = ap.parse_args()

    if args.selftest:
        import tempfile
        hashes = []
        for i in range(2):
            with tempfile.TemporaryDirectory() as td:
                smf, smt, regions, _ok = generate(td)
                hashes.append((hash_file(smf), hash_file(smt), hash_file(regions)))
        if hashes[0] == hashes[1]:
            print("SELFTEST OK: two independent generator runs produced identical output.")
        else:
            print("SELFTEST FAILED: generator is not deterministic!", file=sys.stderr)
            sys.exit(1)
        return

    smf, smt, regions, ok = generate(args.out)
    print(f"wrote {smf}\nwrote {smt}\nwrote {regions}")
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
