"""backends/none — procedural placeholder backend. No network, no model,
fully deterministic from `seed`, so layout work never blocks on a backend
decision (PLAN-beta.md "Honest advice: who should make the art").

Per asset_class:
  emblem          flat geometric badge (steel disc + tint ring + diamond),
                  built from one shape list shared with the .svg writer
                  (see post/svg_trace.write_geometric_svg).
  lobby_background vertical gradient horizon + silhouette shapes.
  biome           two-octave seamless value noise through a colour gradient.
  overlay         seamless value noise thresholded into an alpha mask.
  fx_atlas        cols x rows sprite grid, one soft blob/ring per named frame.
  water_normal    seamless integer-frequency sine field (exactly periodic)
                  as a greyscale height map for post/pbr to Sobel-bake.
"""
from __future__ import annotations
import io
import zlib
import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


# ── seamless noise: bilinear-upsample a small random grid using wrapped
# indices, so the field is exactly periodic in both axes before any blur. ──
def _upsample_wrap(field: np.ndarray, w: int, h: int) -> np.ndarray:
    g = field.shape[0]
    xs = np.linspace(0, g, w, endpoint=False)
    ys = np.linspace(0, g, h, endpoint=False)
    x0 = np.floor(xs).astype(int) % g
    x1 = (x0 + 1) % g
    tx = xs - np.floor(xs)
    y0 = np.floor(ys).astype(int) % g
    y1 = (y0 + 1) % g
    ty = ys - np.floor(ys)
    f00 = field[y0][:, x0]
    f01 = field[y0][:, x1]
    f10 = field[y1][:, x0]
    f11 = field[y1][:, x1]
    top = f00 * (1 - tx)[None, :] + f01 * tx[None, :]
    bot = f10 * (1 - tx)[None, :] + f11 * tx[None, :]
    return top * (1 - ty)[:, None] + bot * ty[:, None]


def seamless_noise(rng: np.random.Generator, w: int, h: int, grid: int = 8,
                    octaves: int = 4, persistence: float = 0.5) -> np.ndarray:
    total = np.zeros((h, w), dtype=np.float64)
    amp, amp_sum, g = 1.0, 0.0, grid
    for _ in range(octaves):
        total += _upsample_wrap(rng.random((g, g)), w, h) * amp
        amp_sum += amp
        amp *= persistence
        g = min(g * 2, min(w, h))
    return total / amp_sum


def gradient_lut(colors_hex: list[str]):
    stops = np.array([hex_to_rgb(c) for c in colors_hex], dtype=np.float64)
    n = len(stops)

    def lut(t: np.ndarray) -> np.ndarray:
        tt = np.clip(t, 0, 1) * (n - 1)
        i0 = np.floor(tt).astype(int)
        i1 = np.clip(i0 + 1, 0, n - 1)
        f = (tt - i0)[..., None]
        return stops[i0] * (1 - f) + stops[i1] * f

    return lut


# ── per-class generators ─────────────────────────────────────────────────
def _gen_biome(rng, w, h, colors: list[str]) -> Image.Image:
    macro = seamless_noise(rng, w, h, grid=6, octaves=4)
    fine = seamless_noise(rng, w, h, grid=24, octaves=2)
    t = np.clip(macro * 0.75 + fine * 0.25, 0, 1)
    rgb = gradient_lut(colors)(t)
    grain = (rng.random((h, w)) - 0.5) * 10
    rgb = np.clip(rgb + grain[..., None], 0, 255)
    return Image.fromarray(rgb.astype(np.uint8), 'RGB')


def _gen_overlay(rng, w, h, tint: str) -> Image.Image:
    n = seamless_noise(rng, w, h, grid=10, octaves=4)
    alpha = np.clip((n - 0.35) * 1.8, 0, 1) ** 1.5
    alpha_u8 = np.clip(alpha * 210, 0, 255).astype(np.uint8)
    rgb = np.tile(np.array(hex_to_rgb(tint), dtype=np.uint8), (h, w, 1))
    return Image.fromarray(np.dstack([rgb, alpha_u8]), 'RGBA')


def _gen_lobby_background(rng, w, h) -> Image.Image:
    stops = ['#d8dcd6', '#8a7f6a', '#6b5a3e', '#3d3a2e']
    yy = np.linspace(0, 1, h)
    row_colors = gradient_lut(stops)(yy)
    rgb = np.tile(row_colors[:, None, :], (1, w, 1))
    noise = seamless_noise(rng, w, h, grid=40, octaves=3)
    rgb = np.clip(rgb + (noise[..., None] - 0.5) * 18, 0, 255)
    img = Image.fromarray(rgb.astype(np.uint8), 'RGB')
    draw = ImageDraw.Draw(img)
    horizon_y = int(h * 0.62)
    dark = hex_to_rgb('#2b2e31')
    for _ in range(6):
        cx = int(rng.integers(0, w))
        bw = int(rng.integers(max(1, int(w * 0.02)), max(2, int(w * 0.05))))
        bh = int(rng.integers(max(1, int(h * 0.03)), max(2, int(h * 0.09))))
        draw.polygon([(cx - bw, horizon_y), (cx + bw, horizon_y),
                      (cx + int(bw * 0.3), horizon_y - bh),
                      (cx - int(bw * 0.3), horizon_y - bh)], fill=dark)
    draw.line([(0, horizon_y), (w, horizon_y)], fill=dark, width=2)
    return img


def _gen_water_height(rng, w, h, amplitude: float) -> Image.Image:
    yy, xx = np.indices((h, w))
    u, v = xx / w, yy / h
    field = np.zeros((h, w))
    for i, (fx, fy) in enumerate([(3, 2), (5, 1), (2, 5), (7, 4)]):
        phase = rng.uniform(0, 2 * np.pi)
        field += (amplitude / (i + 1)) * np.sin(2 * np.pi * (fx * u + fy * v) + phase)
    field += seamless_noise(rng, w, h, grid=16, octaves=3) * amplitude * 0.3
    field = (field - field.min()) / (field.max() - field.min() + 1e-9)
    return Image.fromarray((field * 255).astype(np.uint8), 'L')


def emblem_shapes(tint: str) -> list[dict]:
    """Normalised (0..1 square) shape list shared by the PIL renderer and
    post/svg_trace.write_geometric_svg — one definition, two renderers."""
    return [
        {'type': 'circle', 'cx': .5, 'cy': .5, 'r': .46, 'fill': None, 'stroke': '#d8dcd6', 'width': .02},
        {'type': 'circle', 'cx': .5, 'cy': .5, 'r': .40, 'fill': '#2b2e31', 'stroke': None},
        {'type': 'circle', 'cx': .5, 'cy': .5, 'r': .40, 'fill': None, 'stroke': tint, 'width': .015},
        {'type': 'polygon', 'points': [(.5, .28), (.72, .5), (.5, .72), (.28, .5)], 'fill': tint, 'stroke': None},
        {'type': 'circle', 'cx': .5, 'cy': .18, 'r': .02, 'fill': '#d8dcd6', 'stroke': None},
        {'type': 'circle', 'cx': .82, 'cy': .5, 'r': .02, 'fill': '#d8dcd6', 'stroke': None},
        {'type': 'circle', 'cx': .5, 'cy': .82, 'r': .02, 'fill': '#d8dcd6', 'stroke': None},
        {'type': 'circle', 'cx': .18, 'cy': .5, 'r': .02, 'fill': '#d8dcd6', 'stroke': None},
    ]


def render_shapes(shapes: list[dict], w: int, h: int) -> Image.Image:
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    s = min(w, h)
    for shp in shapes:
        fill = hex_to_rgb(shp['fill']) + (255,) if shp.get('fill') else None
        stroke = hex_to_rgb(shp['stroke']) + (255,) if shp.get('stroke') else None
        width = max(1, int(shp.get('width', 0) * s))
        if shp['type'] == 'circle':
            cx, cy, r = shp['cx'] * w, shp['cy'] * h, shp['r'] * s
            bbox = [cx - r, cy - r, cx + r, cy + r]
            if fill:
                draw.ellipse(bbox, fill=fill)
            if stroke:
                draw.ellipse(bbox, outline=stroke, width=width)
        elif shp['type'] == 'polygon':
            pts = [(px * w, py * h) for px, py in shp['points']]
            draw.polygon(pts, fill=fill, outline=stroke, width=width if stroke else 0)
    return img


_FX_PARAMS = {
    # name: (rgb, radius_frac, irregularity, blur_frac, ring, squash)
    'dot': ('#d8dcd6', .12, .05, .06, False, 1.0),
    'spark': ('#7fd0c8', .10, .10, .04, False, 2.6),
    'fireball': ('#e0561f', .38, .30, .10, False, 1.0),
    'smoke': ('#5a5f63', .42, .45, .16, False, 1.0),
    'dust': ('#6b5a3e', .40, .40, .14, False, 1.1),
    'flash': ('#d8dcd6', .30, .05, .07, False, 1.0),
    'ring': ('#c9a227', .38, .10, .05, True, 1.0),
    'foam': ('#7fd0c8', .34, .35, .09, False, 1.0),
    'smoketrail': ('#5a5f63', .40, .30, .12, False, 2.4),
    'bubbletrail': ('#7fd0c8', .16, .40, .05, False, 2.0),
    'scorch': ('#2b2e31', .44, .25, .08, False, 1.0),
}


def _fx_sprite(name: str, w: int, h: int, rng: np.random.Generator) -> Image.Image:
    rgb_hex, radius_frac, irregularity, blur_frac, ring, squash = \
        _FX_PARAMS.get(name, ('#d8dcd6', .3, .3, .1, False, 1.0))
    rgb = hex_to_rgb(rgb_hex)
    cx, cy = w / 2, h / 2
    r = radius_frac * min(w, h)
    mask = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(mask)
    if ring:
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=255, width=max(2, int(r * 0.35)))
    else:
        jitter = rng.uniform(-irregularity, irregularity, size=12)
        pts = []
        for i in range(12):
            ang = 2 * np.pi * i / 12
            rr = r * (1 + jitter[i])
            pts.append((cx + rr * np.cos(ang) * squash, cy + rr * np.sin(ang)))
        d.polygon(pts, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(max(1.0, blur_frac * min(w, h))))
    alpha = np.asarray(mask, dtype=np.uint8)
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[..., 0], rgba[..., 1], rgba[..., 2] = rgb
    rgba[..., 3] = alpha
    return Image.fromarray(rgba, 'RGBA')


def _gen_fx_atlas(rng, w, h, cols: int, rows: int, frames: dict[str, int]) -> Image.Image:
    cell_w, cell_h = w // cols, h // rows
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    for name, idx in frames.items():
        col, row = idx % cols, idx // cols
        # zlib.crc32, not the builtin hash() — str hashing is salted per
        # process (PYTHONHASHSEED), which broke the "deterministic per seed"
        # guarantee this module advertises (fx_atlas.png differed rerun to
        # rerun with an identical job spec).
        cell_seed = (int(rng.integers(0, 2**31 - 1)) ^ zlib.crc32(name.encode())) & 0xFFFFFFFF
        cell_rng = np.random.default_rng(cell_seed)
        sprite = _fx_sprite(name, cell_w, cell_h, cell_rng)
        img.alpha_composite(sprite, (col * cell_w, row * cell_h))
    return img


def generate(prompt: str, seed: int, size: tuple[int, int], negative: str, *,
             asset_class: str = 'texture', params: dict | None = None) -> bytes:
    del prompt, negative  # the none backend has no model to read prompt text
    params = params or {}
    w, h = size
    rng = np.random.default_rng(seed)

    if asset_class == 'biome':
        img = _gen_biome(rng, w, h, params.get('colors') or ['#3d3a2e', '#6b5a3e', '#8a7f6a'])
    elif asset_class == 'overlay':
        img = _gen_overlay(rng, w, h, params.get('tint', '#6b5a3e'))
    elif asset_class == 'lobby_background':
        img = _gen_lobby_background(rng, w, h)
    elif asset_class == 'water_normal':
        img = _gen_water_height(rng, w, h, params.get('amplitude', 0.5))
    elif asset_class == 'fx_atlas':
        img = _gen_fx_atlas(rng, w, h, params.get('cols', 8), params.get('rows', 8),
                             params.get('frames', {}))
    elif asset_class == 'emblem':
        img = render_shapes(emblem_shapes(params.get('tint', '#7fd0c8')), w, h)
    else:
        img = _gen_biome(rng, w, h, ['#3d3a2e', '#6b5a3e', '#8a7f6a'])

    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()
