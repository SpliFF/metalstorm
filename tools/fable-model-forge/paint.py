"""paint — texture painter for fable_tank.

Paints the full 1024² PBR set from the shared layout zones:
  diffuse  (sRGB)   — armor panels, seams, decals, wear
  orm      (linear) — R=AO, G=roughness, B=metallic
  emissive (sRGB)   — rail glow, capacitor ring, sensors, exhaust heat
  team     (linear) — R channel = team-colour blend mask

Everything is drawn zone-relative so it stays glued to the geometry's
UV projection (layout.py is the single source of truth for both).
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import layout as L

RNG = np.random.default_rng(90210)
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf'
FONT_FALLBACKS = (FONT,
                  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
                  '/System/Library/Fonts/Supplemental/Courier New Bold.ttf')


def font(size):
    """Bold truetype with fallbacks — FONT is a Linux path, absent on macOS."""
    for path in FONT_FALLBACKS:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()

# ── palette (sRGB) ───────────────────────────────────────────────────────
# Warm olive-drab military register (post-nuclear scavenger per
# DESIGN-GUIDE: rust and soot, never clean sci-fi). Was a 5-shade
# desaturated blue-grey, which read as a bland monotone in-engine.
ARMOR      = (106, 103, 84)      # mid olive-drab armor
ARMOR_LT   = (123, 119, 97)
ARMOR_DK   = (86, 84, 68)
LOWER      = (66, 64, 53)       # lower hull / skirt armor
STEEL      = (74, 78, 84)       # mechanical steel (stays cool — bare metal)
STEEL_DK   = (48, 51, 56)
RUBBER     = (36, 38, 42)       # tires / track pads
TRACK_MET  = (58, 60, 64)
GLASS      = (22, 30, 36)
YELLOW     = (198, 158, 44)
BLACKISH   = (28, 29, 32)
TEAMGREY   = (168, 172, 176)    # diffuse under full team mask (preview only)
CYAN       = (86, 226, 255)     # emissive
ORANGE     = (255, 128, 42)
WHITEHOT   = (235, 244, 248)
# Scavenger accents — for mismatched plates, oxide patches, canvas stowage.
OXIDE      = (116, 66, 46)      # rust-red primer / oxidised plate
KHAKI      = (146, 132, 99)     # sun-bleached repaint
CANVAS     = (108, 97, 76)      # tarps / stowage rolls
SOOT       = (38, 36, 33)       # exhaust staining base

AO_BASE, AO_SEAM, AO_DEEP = 232, 150, 95
R_ARMOR, R_STEEL, R_RUBBER, R_GLASS, R_GLOW = 168, 128, 205, 60, 90
M_ARMOR, M_STEEL, M_TRACK, M_GLASS = 28, 195, 170, 0

W = 1024


class Maps:
    def __init__(self):
        self.dif = Image.new('RGB', (W, W), ARMOR)
        self.orm = Image.new('RGB', (W, W), (AO_BASE, R_ARMOR, M_ARMOR))
        self.emi = Image.new('RGB', (W, W), (0, 0, 0))
        self.tea = Image.new('RGB', (W, W), (0, 0, 0))
        self.d = ImageDraw.Draw(self.dif)
        self.o = ImageDraw.Draw(self.orm)
        self.e = ImageDraw.Draw(self.emi)
        self.t = ImageDraw.Draw(self.tea)


def jit(c, amt=4):
    j = int(RNG.integers(-amt, amt + 1))
    return tuple(max(0, min(255, v + j)) for v in c)


def shade(c, f):
    return tuple(max(0, min(255, int(v * f))) for v in c)


def fill(m: Maps, box, dif=None, ao=None, rough=None, metal=None):
    if dif is not None:
        m.d.rectangle(box, fill=dif)
    if ao is not None or rough is not None or metal is not None:
        cur = (AO_BASE, R_ARMOR, M_ARMOR)
        m.o.rectangle(box, fill=(ao if ao is not None else cur[0],
                                 rough if rough is not None else cur[1],
                                 metal if metal is not None else cur[2]))


def _smooth_noise(rng, cells, size):
    """Low-res uniform noise upscaled bilinearly → smooth field in [0,1]."""
    n = rng.random((cells, cells)).astype(np.float32)
    img = Image.fromarray((n * 255).astype(np.uint8), 'L')
    return np.asarray(img.resize((size, size), Image.BILINEAR),
                      dtype=np.float32) / 255.0


def enrich(m: Maps, seed=90210, strength=1.0):
    """Break up flat fills AFTER all painting: multi-scale value mottle +
    a subtle warm/cool drift on the diffuse, and matching roughness
    variation on the ORM. Tone-on-tone (≤ ~±9% at strength 1.0) so large
    quads stay impostor-baker-safe, but enough that hulls stop reading as
    one solid colour in-engine. Deterministic; call once, before
    weathering is applied and before normals are derived."""
    rng = np.random.default_rng(seed)
    size = m.dif.size[0]
    coarse = _smooth_noise(rng, 12, size) - 0.5     # plate-scale blotch
    med    = _smooth_noise(rng, 48, size) - 0.5     # patch-scale
    fine   = _smooth_noise(rng, 192, size) - 0.5    # grain
    value = 1.0 + strength * (0.11 * coarse + 0.055 * med + 0.04 * fine)

    d = np.asarray(m.dif, dtype=np.float32)
    d *= value[..., None]
    # temperature drift: warm patches gain red / lose blue, cool the reverse
    temp = strength * 6.0 * (_smooth_noise(rng, 16, size) - 0.5)
    d[..., 0] += temp
    d[..., 2] -= temp
    m.dif = Image.fromarray(np.clip(d, 0, 255).astype(np.uint8), 'RGB')
    m.d = ImageDraw.Draw(m.dif)

    o = np.asarray(m.orm, dtype=np.float32)
    o[..., 1] += strength * 26.0 * (0.7 * coarse + 0.3 * med)  # roughness
    m.orm = Image.fromarray(np.clip(o, 0, 255).astype(np.uint8), 'RGB')
    m.o = ImageDraw.Draw(m.orm)


def seam_h(m: Maps, x0, x1, y, base, hi=True):
    m.d.line([(x0, y), (x1, y)], fill=shade(base, 0.52), width=2)
    if hi:
        m.d.line([(x0, y + 2), (x1, y + 2)], fill=shade(base, 1.22), width=1)
    m.o.line([(x0, y), (x1, y)], fill=(AO_SEAM, R_ARMOR, M_ARMOR), width=2)


def seam_v(m: Maps, x, y0, y1, base, hi=True):
    m.d.line([(x, y0), (x, y1)], fill=shade(base, 0.52), width=2)
    if hi:
        m.d.line([(x + 2, y0), (x + 2, y1)], fill=shade(base, 1.22), width=1)
    m.o.line([(x, y0), (x, y1)], fill=(AO_SEAM, R_ARMOR, M_ARMOR), width=2)


BOLT_LOG = []   # weathering.py reads logged bolt positions


def bolts(m: Maps, pts, r=2, base=ARMOR):
    for (x, y) in pts:
        BOLT_LOG.append((x, y))
        m.d.ellipse([x - r, y - r, x + r, y + r], fill=shade(base, 0.62))
        m.d.point((x - 1, y - 1), fill=shade(base, 1.3))
        m.o.ellipse([x - r, y - r, x + r, y + r], fill=(AO_SEAM, R_STEEL, M_STEEL))


def vent_slots(m: Maps, box, n, horizontal=True, glow=None):
    x0, y0, x1, y1 = box
    for i in range(n):
        if horizontal:
            sy0 = y0 + (y1 - y0) * (i + 0.18) / n
            sy1 = y0 + (y1 - y0) * (i + 0.78) / n
            sb = [x0, sy0, x1, sy1]
        else:
            sx0 = x0 + (x1 - x0) * (i + 0.18) / n
            sx1 = x0 + (x1 - x0) * (i + 0.78) / n
            sb = [sx0, y0, sx1, y1]
        m.d.rectangle(sb, fill=BLACKISH)
        m.o.rectangle(sb, fill=(AO_DEEP, R_STEEL, M_STEEL))
        if glow:
            gx0, gy0, gx1, gy1 = sb
            pad = 2
            m.e.rectangle([gx0 + pad, gy0 + pad, gx1 - pad, gy1 - pad], fill=glow)


def wear_edges(m: Maps, box, base, density=40):
    """Sparse chipped-edge highlights along a rect's border."""
    x0, y0, x1, y1 = box
    per = 2 * (x1 - x0) + 2 * (y1 - y0)
    for _ in range(int(density)):
        t = RNG.random() * per
        if t < (x1 - x0):
            x, y = x0 + t, y0 + RNG.random() * 3
        elif t < 2 * (x1 - x0):
            x, y = x0 + (t - (x1 - x0)), y1 - RNG.random() * 3
        elif t < 2 * (x1 - x0) + (y1 - y0):
            x, y = x0 + RNG.random() * 3, y0 + (t - 2 * (x1 - x0))
        else:
            x, y = x1 - RNG.random() * 3, y0 + (t - 2 * (x1 - x0) - (y1 - y0))
        ln = 1 + RNG.random() * 3
        m.d.line([(x, y), (x + ln, y)], fill=shade(base, 1.35), width=1)
        m.o.point((x, y), fill=(AO_BASE, R_STEEL, M_STEEL))


def stencil(m: Maps, xy, text, size, color, bridge=True, angle=0):
    f = font(size)
    tmp = Image.new('L', (size * len(text), int(size * 1.4)), 0)
    td = ImageDraw.Draw(tmp)
    td.text((2, 2), text, font=f, fill=255)
    if bridge:  # stencil bridge cuts
        bb = tmp.getbbox()
        if bb:
            for fx in (0.32, 0.62):
                y = bb[1] + (bb[3] - bb[1]) * fx
                td.line([(0, y), (tmp.width, y)], fill=0, width=max(2, size // 14))
    if angle:
        tmp = tmp.rotate(angle, expand=True)
    m.dif.paste(Image.new('RGB', tmp.size, color), (int(xy[0]), int(xy[1])), tmp)


# ── zone painters ────────────────────────────────────────────────────────

def paint_dark(m):
    r = L.Z_DARK.rect
    fill(m, r, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)


def paint_hull_top(m):
    x0, y0, x1, y1 = L.Z_HULL_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    # subtle two-tone camo blocks (large, angular)
    for _ in range(7):
        bx = x0 + RNG.random() * (x1 - x0 - 90)
        by = y0 + RNG.random() * (y1 - y0 - 60)
        m.d.polygon([(bx, by + 10), (bx + 80, by), (bx + 95, by + 42),
                     (bx + 18, by + 55)], fill=jit(ARMOR_DK, 3))
    # deck panels: longitudinal seams (u axis is x/width, v is z/length)
    zs = [-3.5, -2.2, -1.0, 0.3, 1.6, 2.6, 3.6]
    for wz in zs:
        _, v = L.Z_HULL_TOP.uv((0, 0, wz))
        seam_h(m, x0 + 4, x1 - 4, int(v * W), ARMOR)
    for wx in (-1.05, -0.35, 0.35, 1.05):
        u, _ = L.Z_HULL_TOP.uv((wx, 0, 0))
        seam_v(m, int(u * W), y0 + 4, y1 - 4, ARMOR)
    # turret ring (radii mapped through the zone's anisotropic u/v scales)
    cu, cv = L.Z_HULL_TOP.uv((0, 0, L.TURRET_OFF[2]))
    cx, cy = cu * W, cv * W
    ring = 1.16
    rx = abs(L.Z_HULL_TOP.uv((ring, 0, 0))[0] - L.Z_HULL_TOP.uv((0, 0, 0))[0]) * W
    ry = abs(L.Z_HULL_TOP.uv((0, 0, L.TURRET_OFF[2] + ring))[1] - cv) * W
    m.d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry],
                fill=STEEL_DK, outline=shade(STEEL_DK, 0.6), width=3)
    m.o.ellipse([cx - rx, cy - ry, cx + rx, cy + ry],
                fill=(AO_DEEP + 20, R_STEEL, M_STEEL))
    for i in range(14):
        a = 2 * np.pi * i / 14
        bolts(m, [(cx + np.cos(a) * (rx - 5), cy + np.sin(a) * (ry - 4))],
              r=2, base=STEEL)
    # front deck grip strips
    for wz in (-2.0, -1.75):
        _, v = L.Z_HULL_TOP.uv((0, 0, wz))
        m.d.rectangle([x0 + 30, v * W - 2, x1 - 30, v * W + 2], fill=shade(ARMOR, 0.7))
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 60)


def paint_glacis(m):
    x0, y0, x1, y1 = L.Z_GLACIS.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    # angular applique plates
    seam_h(m, x0 + 3, x1 - 3, int(y0 + (y1 - y0) * 0.42), ARMOR_DK)
    seam_v(m, int(x0 + (x1 - x0) * 0.5), y0 + 3, y1 - 3, ARMOR_DK)
    # team chevron (drawn on mask; dark outline on diffuse)
    cxm = (x0 + x1) / 2
    ch_w, ch_h = (x1 - x0) * 0.34, (y1 - y0) * 0.30
    cy0 = y0 + (y1 - y0) * 0.30
    poly = [(cxm - ch_w, cy0 + ch_h), (cxm, cy0), (cxm + ch_w, cy0 + ch_h),
            (cxm + ch_w, cy0 + ch_h + 16), (cxm, cy0 + 16), (cxm - ch_w, cy0 + ch_h + 16)]
    m.t.polygon(poly, fill=(255, 0, 0))
    m.d.polygon(poly, fill=TEAMGREY, outline=shade(ARMOR_DK, 0.5))
    # tow points
    for fx in (0.16, 0.84):
        tx = x0 + (x1 - x0) * fx
        ty = y1 - (y1 - y0) * 0.22
        m.d.rectangle([tx - 9, ty - 6, tx + 9, ty + 6], fill=STEEL_DK)
        m.d.ellipse([tx - 5, ty - 4, tx + 5, ty + 4], fill=BLACKISH)
        m.o.rectangle([tx - 9, ty - 6, tx + 9, ty + 6], fill=(AO_SEAM, R_STEEL, M_STEEL))
    bolts(m, [(x0 + 10 + i * ((x1 - x0 - 20) / 7), y0 + 8) for i in range(8)],
          base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 50)


def paint_hull_rear(m):
    x0, y0, x1, y1 = L.Z_HULL_REAR.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    # engine access grille
    gb = [x0 + (x1 - x0) * 0.24, y0 + (y1 - y0) * 0.16,
          x0 + (x1 - x0) * 0.76, y0 + (y1 - y0) * 0.52]
    m.d.rectangle(gb, fill=STEEL_DK)
    vent_slots(m, [gb[0] + 4, gb[1] + 4, gb[2] - 4, gb[3] - 4], 5)
    # hazard strip along the bottom edge
    hz = [x0, y1 - 14, x1, y1 - 4]
    for i in range(int((x1 - x0) / 16) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 16, hz[1]), (x0 + i * 16 + 16, hz[1]),
                     (x0 + i * 16 + 8, hz[3]), (x0 + i * 16 - 8, hz[3])], fill=c)
    # team ID square + taillights
    m.t.rectangle([x1 - 46, y0 + 12, x1 - 12, y0 + 42], fill=(255, 0, 0))
    m.d.rectangle([x1 - 46, y0 + 12, x1 - 12, y0 + 42], fill=TEAMGREY)
    m.e.rectangle([x0 + 14, y0 + 20, x0 + 40, y0 + 26], fill=(160, 30, 24))
    m.d.rectangle([x0 + 14, y0 + 20, x0 + 40, y0 + 26], fill=(70, 20, 18))
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 40)


def paint_hull_side(m):
    x0, y0, x1, y1 = L.Z_HULL_SIDE.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    # waistline split: upper armor / lower dark
    _, wv = L.Z_HULL_SIDE.uv((0, 1.05, 0))
    wy = int(wv * W)
    m.d.rectangle([x0, wy, x1, y1], fill=LOWER)
    m.o.rectangle([x0, wy, x1, y1], fill=(AO_BASE - 30, R_ARMOR, M_ARMOR))
    seam_h(m, x0, x1, wy, ARMOR)
    # panel seams on upper band
    for wz in (-2.9, -1.4, 0.2, 1.7, 3.1):
        u, _ = L.Z_HULL_SIDE.uv((0, 0, wz))
        seam_v(m, int(u * W), y0 + 3, wy, ARMOR)
    # side intake near engine
    iu0, _ = L.Z_HULL_SIDE.uv((0, 0, 2.1))
    iu1, iv0 = L.Z_HULL_SIDE.uv((0, 1.75, 3.2))
    _, iv1 = L.Z_HULL_SIDE.uv((0, 1.45, 0))
    ib = [iu0 * W, iv0 * W, iu1 * W, iv1 * W]
    m.d.rectangle(ib, fill=STEEL_DK)
    vent_slots(m, [ib[0] + 3, ib[1] + 3, ib[2] - 3, ib[3] - 3], 4)
    wear_edges(m, (x0, y0, x1, wy), ARMOR, 45)


def paint_tracks_side(m):
    x0, y0, x1, y1 = L.Z_TRACK_SIDE.rect
    fill(m, (x0, y0, x1, y1), dif=LOWER, ao=AO_BASE - 25)
    zone = L.Z_TRACK_SIDE

    def py(wy):
        return zone.uv((0, wy, 0))[1] * W

    def pz(wz):
        return zone.uv((0, 0, wz))[0] * W

    # wheel well band (behind wheels) very dark
    m.d.rectangle([x0, py(0.95), x1, py(0.06)], fill=BLACKISH)
    m.o.rectangle([x0, py(0.95), x1, py(0.06)], fill=(AO_DEEP - 30, R_RUBBER, 30))
    # 7 road wheels
    for i in range(7):
        wz = -2.55 + i * 0.85
        cx, cy = pz(wz), py(0.52)
        r = pz(wz + 0.40) - pz(wz)
        m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=RUBBER)
        r2 = r * 0.68
        m.d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], fill=jit(TRACK_MET, 3))
        m.o.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(AO_DEEP, R_RUBBER, 30))
        m.o.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], fill=(AO_SEAM, R_STEEL, M_TRACK))
        for k in range(6):
            a = k * np.pi / 3 + 0.3
            bolts(m, [(cx + np.cos(a) * r2 * 0.55, cy + np.sin(a) * r2 * 0.55)],
                  r=2, base=TRACK_MET)
        m.d.ellipse([cx - 3, cy - 3, cx + 3, cy + 3], fill=STEEL_DK)
    # skirt armor band (covers y 0.83..1.37 where the skirt plate projects)
    sy0, sy1 = py(1.37), py(0.83)
    m.d.rectangle([x0, sy0, x1, sy1], fill=ARMOR_DK)
    m.o.rectangle([x0, sy0, x1, sy1], fill=(AO_BASE, R_ARMOR, M_ARMOR))
    for i in range(6):
        sx = x0 + (x1 - x0) * (i + 1) / 7.0
        seam_v(m, int(sx), int(sy0) + 2, int(sy1) - 2, ARMOR_DK)
    bolts(m, [(x0 + (x1 - x0) * (i + 0.5) / 7.0, (sy0 + sy1) / 2) for i in range(7)],
          base=ARMOR_DK)
    # team stripe segment on the skirt front
    m.t.rectangle([x0 + 6, sy0 + 3, x0 + 60, sy1 - 3], fill=(255, 0, 0))
    m.d.rectangle([x0 + 6, sy0 + 3, x0 + 60, sy1 - 3], fill=TEAMGREY)
    # fender edge band (y 1.40..1.54)
    fy0, fy1 = py(1.56), py(1.40)
    m.d.rectangle([x0, fy0, x1, fy1], fill=ARMOR)
    seam_h(m, x0, x1, int(fy1), ARMOR)
    wear_edges(m, (x0, int(sy0), x1, int(sy1)), ARMOR_DK, 35)


def paint_track_wrap(m):
    x0, y0, x1, y1 = L.Z_TRACK_WRAP
    fill(m, (x0, y0, x1, y1), dif=TRACK_MET, ao=AO_SEAM, rough=R_RUBBER, metal=M_TRACK)
    n = 64
    for i in range(n):
        lx = x0 + (x1 - x0) * i / n
        lw = (x1 - x0) / n
        m.d.rectangle([lx + 1, y0, lx + lw - 1, y1], fill=jit(TRACK_MET, 5))
        m.d.line([(lx, y0), (lx, y1)], fill=BLACKISH, width=2)
        # grouser bar
        m.d.rectangle([lx + lw * 0.35, y0 + 2, lx + lw * 0.65, y1 - 2], fill=RUBBER)
        m.o.rectangle([lx + lw * 0.35, y0 + 2, lx + lw * 0.65, y1 - 2],
                      fill=(AO_SEAM, R_RUBBER, 60))


def paint_turret_top(m):
    x0, y0, x1, y1 = L.Z_TURRET_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    zone = L.Z_TURRET_TOP
    for _ in range(5):
        bx = x0 + RNG.random() * (x1 - x0 - 80)
        by = y0 + RNG.random() * (y1 - y0 - 50)
        m.d.polygon([(bx, by + 8), (bx + 66, by), (bx + 78, by + 34),
                     (bx + 14, by + 44)], fill=jit(ARMOR_DK, 3))
    # radial panel seams
    for wz in (-0.9, -0.1, 0.7, 1.5):
        _, v = zone.uv((0, 0, wz))
        seam_h(m, x0 + 4, x1 - 4, int(v * W), ARMOR)
    for wx in (-0.65, 0.0, 0.65):
        u, _ = zone.uv((wx, 0, 0))
        seam_v(m, int(u * W), y0 + 4, y1 - 4, ARMOR)
    # commander hatch ring beside the sight drum
    hu, hv = zone.uv((0.52, 0, 0.95))
    hx, hy = hu * W, hv * W
    m.d.ellipse([hx - 30, hy - 24, hx + 30, hy + 24], fill=ARMOR_DK,
                outline=shade(ARMOR, 0.55), width=2)
    bolts(m, [(hx + np.cos(a) * 24, hy + np.sin(a) * 19)
              for a in np.linspace(0, 2 * np.pi, 8, endpoint=False)], base=ARMOR_DK)
    m.d.rectangle([hx - 4, hy - 14, hx + 4, hy + 2], fill=STEEL_DK)
    # front wedge team flash
    fu0, fv0 = zone.uv((-0.30, 0, -1.75))
    fu1, fv1 = zone.uv((0.30, 0, -1.15))
    m.t.polygon([(fu0 * W, fv1 * W), ((fu0 + fu1) / 2 * W, fv0 * W),
                 (fu1 * W, fv1 * W)], fill=(255, 0, 0))
    m.d.polygon([(fu0 * W, fv1 * W), ((fu0 + fu1) / 2 * W, fv0 * W),
                 (fu1 * W, fv1 * W)], fill=TEAMGREY)
    # roof tactical numeral (reads for the top-down RTS camera)
    nu, nv = zone.uv((0.0, 0, 1.35))
    f = font(54)
    tw = m.d.textlength('09', font=f)
    m.d.text((nu * W - tw / 2 + 2, nv * W - 25 + 2), '09', font=f, fill=shade(ARMOR_DK, 0.55))
    m.d.text((nu * W - tw / 2, nv * W - 25), '09', font=f, fill=(196, 200, 204))
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 50)


def paint_turret_side(m):
    x0, y0, x1, y1 = L.Z_TURRET_SIDE.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    zone = L.Z_TURRET_SIDE
    # lower recessed band (below waist -> dark)
    _, bv = zone.uv((0, 0.30, 0))
    m.d.rectangle([x0, int(bv * W), x1, y1], fill=STEEL_DK)
    m.o.rectangle([x0, int(bv * W), x1, y1], fill=(AO_DEEP, R_STEEL, M_STEEL))
    # team panel (mirror-safe: shared L/R zone would mirror any text,
    # so the emblem is a symmetric double chevron; numerals live on the
    # roof + rear where projection isn't shared)
    pu0, pv0 = zone.uv((0, 0.88, -0.35))
    pu1, pv1 = zone.uv((0, 0.42, 0.72))
    panel = [pu0 * W, pv0 * W, pu1 * W, pv1 * W]
    m.t.rectangle(panel, fill=(255, 0, 0))
    m.d.rectangle(panel, fill=TEAMGREY)
    m.d.rectangle(panel, outline=shade(ARMOR, 0.5), width=2)
    pw, ph = panel[2] - panel[0], panel[3] - panel[1]
    cxp = (panel[0] + panel[2]) / 2
    for k in (0.18, 0.5):
        chev = [(cxp - pw * 0.30, panel[1] + ph * (k + 0.30)),
                (cxp, panel[1] + ph * k),
                (cxp + pw * 0.30, panel[1] + ph * (k + 0.30)),
                (cxp + pw * 0.30, panel[1] + ph * (k + 0.46)),
                (cxp, panel[1] + ph * (k + 0.16)),
                (cxp - pw * 0.30, panel[1] + ph * (k + 0.46))]
        m.t.polygon(chev, fill=(0, 0, 0))
        m.d.polygon(chev, fill=(44, 48, 52))
    # seams
    for wz in (1.1, 1.7):
        u, _ = zone.uv((0, 0, wz))
        seam_v(m, int(u * W), y0 + 3, int(bv * W), ARMOR)
    wear_edges(m, (x0, y0, x1, int(bv * W)), ARMOR, 30)


def paint_turret_front(m):
    x0, y0, x1, y1 = L.Z_TURRET_FRONT.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    seam_v(m, (x0 + x1) // 2, y0 + 3, y1 - 3, ARMOR_DK)
    # twin headlight blocks (emissive)
    for fx in (0.24, 0.76):
        lx = x0 + (x1 - x0) * fx
        ly = y0 + (y1 - y0) * 0.30
        m.d.rectangle([lx - 7, ly - 4, lx + 7, ly + 4], fill=GLASS)
        m.e.rectangle([lx - 5, ly - 2, lx + 5, ly + 2], fill=(190, 205, 215))
        m.o.rectangle([lx - 7, ly - 4, lx + 7, ly + 4], fill=(AO_SEAM, R_GLASS, M_GLASS))
    bolts(m, [(x0 + 8 + i * ((x1 - x0 - 16) / 4), y1 - 8) for i in range(5)],
          base=ARMOR_DK)


def paint_turret_rear(m):
    x0, y0, x1, y1 = L.Z_TURRET_REAR.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    vent_slots(m, [x0 + 10, y0 + 10, x1 - 10, y0 + 34], 2)
    # strapped stowage hint
    m.d.rectangle([x0 + 12, y0 + 42, x1 - 12, y1 - 10], fill=shade(LOWER, 1.1))
    for fx in (0.3, 0.7):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 2, y0 + 42, sx + 2, y1 - 10], fill=STEEL_DK)
    m.o.rectangle([x0 + 12, y0 + 42, x1 - 12, y1 - 10], fill=(AO_BASE - 40, 190, 10))
    f = font(30)
    m.d.text((x0 + 8, y0 + 6), '09', font=f, fill=(188, 192, 196))


def paint_barrel(m):
    x0, y0, x1, y1 = L.Z_BARREL_WRAP
    # u: breech (left) -> muzzle (right); v: facets, 0/8 top .. wrapping
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 15, rough=R_STEEL, metal=M_STEEL)
    zlen = abs(L.TUBE_STATIONS[-1][0] - L.TUBE_STATIONS[0][0])

    def pu(wz):
        return x0 + (x1 - x0) * (abs(wz - L.TUBE_STATIONS[0][0])) / zlen

    # sleeve section: armor colored with cooling ribs
    su1 = pu(-1.90)
    m.d.rectangle([x0, y0, su1, y1], fill=ARMOR_DK)
    m.o.rectangle([x0, y0, su1, y1], fill=(AO_BASE, R_ARMOR, M_ARMOR))
    for i in range(5):
        rx = x0 + (su1 - x0) * (0.35 + i * 0.13)
        m.d.rectangle([rx, y0, rx + 4, y1], fill=STEEL_DK)
        m.o.rectangle([rx, y0, rx + 4, y1], fill=(AO_SEAM, R_STEEL, M_STEEL))
    stencil(m, (x0 + 8, y0 + (y1 - y0) * 0.36), 'VGD-9', 22, shade(ARMOR, 1.25),
            bridge=False)
    # thin tube: darker steel + heat tint near muzzle
    m.d.rectangle([su1, y0, x1, y1], fill=STEEL_DK)
    m.o.rectangle([su1, y0, x1, y1], fill=(AO_BASE - 10, 110, 210))
    hx0 = int(pu(-3.2))
    hw = int(x1 - hx0)
    if hw > 0:
        heat = Image.new('RGB', (hw, y1 - y0), (74, 52, 50))
        grad = Image.new('L', (hw, 1), 0)
        for gx in range(hw):
            grad.putpixel((gx, 0), int(120 * (gx / max(1, hw - 1)) ** 1.6))
        m.dif.paste(heat, (hx0, y0), grad.resize((hw, y1 - y0)))
    # rail glow slits on the +-X facets (v bands 3 and 7)
    for band in (3, 7):
        by0 = y0 + (y1 - y0) * band / 8 + 2
        by1 = y0 + (y1 - y0) * (band + 1) / 8 - 2
        m.e.rectangle([pu(-1.95), by0, pu(-3.98), by1], fill=(30, 80, 92))
    # muzzle end glow ring
    m.e.rectangle([x1 - 6, y0, x1, y1], fill=CYAN)
    m.d.rectangle([x1 - 6, y0, x1, y1], fill=(40, 60, 66))


def paint_rails(m):
    x0, y0, x1, y1 = L.Z_RAIL_SIDE.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 10, rough=110, metal=215)
    # glowing accelerator strip along the middle + top/bottom edge rows
    midy = (y0 + y1) / 2
    m.e.rectangle([x0 + 4, midy - 2, x1 - 4, midy + 2], fill=CYAN)
    m.d.rectangle([x0 + 4, midy - 2, x1 - 4, midy + 2], fill=(46, 70, 76))
    m.e.rectangle([x0, y0, x1, y0 + 4], fill=(26, 70, 80))
    m.e.rectangle([x0, y1 - 4, x1, y1], fill=(26, 70, 80))
    for i in range(6):
        sx = x0 + (x1 - x0) * (i + 0.5) / 6
        m.d.rectangle([sx - 2, y0 + 3, sx + 2, y1 - 3], fill=shade(STEEL_DK, 0.7))
    stencil(m, (x0 + 10, y0 + 4), 'DANGER — RAIL', 13, YELLOW, bridge=False)


def paint_cap_ring(m):
    x0, y0, x1, y1 = L.Z_CAP_RING
    fill(m, (x0, y0, x1, y1), dif=(50, 54, 60), ao=AO_BASE - 20, rough=120, metal=200)
    midx = (x0 + x1) / 2
    m.e.rectangle([midx - 5, y0, midx + 5, y1], fill=CYAN)
    m.d.rectangle([midx - 5, y0, midx + 5, y1], fill=(46, 70, 76))
    for fx in (0.2, 0.8):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 3, y0, sx + 3, y1], fill=BLACKISH)
        m.o.rectangle([sx - 3, y0, sx + 3, y1], fill=(AO_SEAM, R_STEEL, M_STEEL))


def paint_breech(m):
    x0, y0, x1, y1 = L.Z_BREECH.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 20, rough=125, metal=200)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, STEEL)
    bolts(m, [(x0 + 10 + i * ((x1 - x0 - 20) / 3), y0 + 10) for i in range(4)],
          base=STEEL)
    m.d.rectangle([x0 + 12, y1 - 26, x0 + 58, y1 - 12], fill=YELLOW)
    m.d.text((x0 + 15, y1 - 25), 'HV', font=font(12),
             fill=BLACKISH)


def paint_brake(m):
    x0, y0, x1, y1 = L.Z_BRAKE.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 20, rough=115, metal=205)
    vent_slots(m, [x0 + 10, y0 + 14, x1 - 10, y1 - 34], 3)
    # hazard band + bore
    for i in range(int((x1 - x0) / 14) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 14, y1 - 24), (x0 + i * 14 + 14, y1 - 24),
                     (x0 + i * 14 + 7, y1 - 10), (x0 + i * 14 - 7, y1 - 10)], fill=c)
    cx, cy = (x0 + x1) / 2, y0 + (y1 - y0) * 0.42
    m.d.ellipse([cx - 16, cy - 16, cx + 16, cy + 16], fill=BLACKISH)
    m.o.ellipse([cx - 16, cy - 16, cx + 16, cy + 16], fill=(AO_DEEP - 40, 220, 0))


def paint_tube_cap(m):
    r = L.Z_TUBE_CAP.rect
    fill(m, r, dif=BLACKISH, ao=AO_DEEP, rough=210, metal=60)
    cx, cy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    m.d.ellipse([cx - 14, cy - 14, cx + 14, cy + 14], fill=(12, 12, 14))


def paint_details(m):
    # hatch
    x0, y0, x1, y1 = L.Z_HATCH.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    m.d.ellipse([x0 + 8, y0 + 8, x1 - 8, y1 - 8], fill=ARMOR,
                outline=shade(ARMOR_DK, 0.55), width=2)
    bolts(m, [((x0 + x1) / 2 + np.cos(a) * ((x1 - x0) / 2 - 12),
               (y0 + y1) / 2 + np.sin(a) * ((y1 - y0) / 2 - 12))
              for a in np.linspace(0, 2 * np.pi, 10, endpoint=False)], base=ARMOR)
    m.d.rectangle([(x0 + x1) / 2 - 14, (y0 + y1) / 2 - 4,
                   (x0 + x1) / 2 + 14, (y0 + y1) / 2 + 4], fill=STEEL_DK)
    # intake grille
    x0, y0, x1, y1 = L.Z_INTAKE.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 25)
    vent_slots(m, [x0 + 6, y0 + 8, x1 - 6, y1 - 8], 6)
    # exhaust vents (emissive orange heat inside)
    x0, y0, x1, y1 = L.Z_EXHAUST.rect
    fill(m, (x0, y0, x1, y1), dif=(60, 56, 54), ao=AO_BASE - 30, rough=190, metal=160)
    vent_slots(m, [x0 + 8, y0 + 12, x1 - 8, y1 - 12], 3, glow=(120, 44, 12))
    # sensor bar: black visor + cyan core
    x0, y0, x1, y1 = L.Z_SENSOR.rect
    fill(m, (x0, y0, x1, y1), dif=GLASS, ao=AO_BASE, rough=R_GLASS, metal=M_GLASS)
    midy = (y0 + y1) / 2
    m.e.rectangle([x0 + 6, midy - 2, x1 - 6, midy + 2], fill=CYAN)
    for fx in (0.2, 0.5, 0.8):
        lx = x0 + (x1 - x0) * fx
        m.e.ellipse([lx - 3, midy - 8, lx + 3, midy - 2], fill=(120, 200, 220))
    # sensor pod: glass front + housing
    x0, y0, x1, y1 = L.Z_POD.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    m.d.rectangle([x0 + 10, y0 + 14, x1 - 10, y1 - 30], fill=GLASS)
    m.o.rectangle([x0 + 10, y0 + 14, x1 - 10, y1 - 30], fill=(AO_BASE, R_GLASS, M_GLASS))
    m.e.ellipse([(x0 + x1) / 2 - 4, (y0 + y1) / 2 - 10, (x0 + x1) / 2 + 4,
                 (y0 + y1) / 2 - 2], fill=(170, 60, 50))
    # sight drum wrap: housing + slit window
    x0, y0, x1, y1 = L.Z_SIGHT
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 10)
    m.d.rectangle([x0, y0 + 10, x1, y0 + 26], fill=GLASS)
    m.o.rectangle([x0, y0 + 10, x1, y0 + 26], fill=(AO_BASE, R_GLASS, M_GLASS))
    m.e.rectangle([x0 + 2, y0 + 14, x0 + (x1 - x0) // 3, y0 + 22], fill=(60, 160, 180))
    # sight top
    r = L.Z_SIGHT_TOP.rect
    fill(m, r, dif=ARMOR_DK)
    bolts(m, [((r[0] + r[2]) / 2 + np.cos(a) * 18, (r[1] + r[3]) / 2 + np.sin(a) * 18)
              for a in np.linspace(0, 2 * np.pi, 6, endpoint=False)], base=ARMOR_DK)
    # bustle rack: slats + tarp
    x0, y0, x1, y1 = L.Z_BUSTLE.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    vent_slots(m, [x0 + 6, y0 + 8, x1 - 6, y0 + 30], 2)
    m.d.rounded_rectangle([x0 + 14, y0 + 36, x1 - 14, y1 - 8], 8,
                          fill=(84, 78, 66))
    m.o.rectangle([x0 + 14, y0 + 36, x1 - 14, y1 - 8], fill=(AO_BASE - 30, 200, 5))
    for fx in (0.28, 0.55, 0.8):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 2, y0 + 36, sx + 2, y1 - 8], fill=STEEL_DK)
    # smoke launchers: 3 tubes
    x0, y0, x1, y1 = L.Z_SMOKE.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    for fx in (0.25, 0.5, 0.75):
        cx = x0 + (x1 - x0) * fx
        cy = (y0 + y1) / 2
        m.d.ellipse([cx - 9, cy - 9, cx + 9, cy + 9], fill=BLACKISH)
        m.d.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=STEEL_DK)
        m.o.ellipse([cx - 9, cy - 9, cx + 9, cy + 9], fill=(AO_DEEP, R_STEEL, M_STEEL))
    # hub wrap + cap
    x0, y0, x1, y1 = L.Z_HUB
    fill(m, (x0, y0, x1, y1), dif=TRACK_MET, ao=AO_BASE - 30, rough=130, metal=M_TRACK)
    for i in range(8):
        sx = x0 + (x1 - x0) * i / 8
        m.d.line([(sx, y0), (sx, y1)], fill=BLACKISH, width=2)
    r = L.Z_HUB_CAP.rect
    fill(m, r, dif=TRACK_MET, ao=AO_BASE - 20, rough=130, metal=M_TRACK)
    cx, cy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    rr = (r[2] - r[0]) / 2 - 4
    for a in np.linspace(0, 2 * np.pi, 8, endpoint=False):
        m.d.line([(cx + np.cos(a) * rr * 0.25, cy + np.sin(a) * rr * 0.25),
                  (cx + np.cos(a) * rr * 0.9, cy + np.sin(a) * rr * 0.9)],
                 fill=shade(TRACK_MET, 0.6), width=4)
    m.d.ellipse([cx - 8, cy - 8, cx + 8, cy + 8], fill=STEEL_DK)
    bolts(m, [(cx + np.cos(a) * 12, cy + np.sin(a) * 12)
              for a in np.linspace(0.4, 2 * np.pi + 0.4, 6, endpoint=False)],
          base=TRACK_MET)
    # fender top: tread plate
    x0, y0, x1, y1 = L.Z_FENDER.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 8)
    for gx in range(x0 + 6, x1 - 4, 14):
        for gy in range(y0 + 6, y1 - 4, 12):
            off = 4 if ((gy - y0) // 12) % 2 else 0
            m.d.line([(gx + off, gy), (gx + off + 5, gy + 4)],
                     fill=shade(ARMOR_DK, 1.28), width=2)
    seam_h(m, x0, x1, y0 + 2, ARMOR_DK, hi=False)
    # front-tip hazard corners on fender
    for i in range(5):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 10, y0 + 2), (x0 + 10 + i * 10, y0 + 2),
                     (x0 + 4 + i * 10, y0 + 14), (x0 - 6 + i * 10, y0 + 14)], fill=c)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_dark(m)
    paint_hull_top(m)
    paint_glacis(m)
    paint_hull_rear(m)
    paint_hull_side(m)
    paint_tracks_side(m)
    paint_track_wrap(m)
    paint_turret_top(m)
    paint_turret_side(m)
    paint_turret_front(m)
    paint_turret_rear(m)
    paint_barrel(m)
    paint_rails(m)
    paint_cap_ring(m)
    paint_breech(m)
    paint_brake(m)
    paint_tube_cap(m)
    paint_details(m)
    enrich(m)
    # ── weathering pass (gritty: dirt/rust where physics puts them) ──
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=41)
    wx.crevice_grime(m.dif, 0.68)
    # ground-adjacent: running gear heaviest
    wx.mud_band(L.Z_TRACK_SIDE.rect, 1.0, fade='down')
    # skirt: rust line + streaks along its VISIBLE bottom edge (mid-zone)
    tx0, ty0, tx1, ty1 = L.Z_TRACK_SIDE.rect
    skirt_bot = int(L.Z_TRACK_SIDE.uv((0, 0.83, 0))[1] * 1024)
    wx.plate_bottom_rust((tx0, ty0, tx1, skirt_bot), n=10, band=8, strength=0.75)
    for i in range(8):
        sx = tx0 + (tx1 - tx0) * (i + 0.5) / 8.0
        wx.rust_streak(sx, skirt_bot - 4, 16, strength=0.4)
    wx.mud_band(L.Z_TRACK_WRAP, 0.6, fade=None)
    wx.mud_band(L.Z_HUB, 0.45, fade=None)
    wx.mud_band(L.Z_HUB_CAP.rect, 0.45, fade=None)
    wx.mud_band(L.Z_FENDER.rect, 0.5, fade=None)
    # hull: graded up from the ground line + dry dust film
    wx.mud_band(L.Z_HULL_SIDE.rect, 0.75, fade='down', dust=0.4)
    wx.mud_band(L.Z_GLACIS.rect, 0.65, fade='down', dust=0.35)
    # streaks running down the glacis from the tow shackles + sensor bar
    gx0, gy0, gx1, gy1 = L.Z_GLACIS.rect
    for fx in (0.16, 0.5, 0.84):
        wx.rust_streak(gx0 + (gx1 - gx0) * fx, gy0 + (gy1 - gy0) * 0.55,
                       34, width=2.6, strength=0.4)
    wx.mud_band(L.Z_HULL_REAR.rect, 0.5, fade='down', dust=0.25)
    # high surfaces: thin dust only
    wx.mud_band(L.Z_HULL_TOP.rect, 0.2, fade=None, spatter=False)
    wx.mud_band(L.Z_TURRET_TOP.rect, 0.18, fade=None, spatter=False)
    wx.mud_band(L.Z_TURRET_SIDE.rect, 0.24, fade='down', spatter=False)
    wx.mud_band(L.Z_TURRET_FRONT.rect, 0.24, fade='down', spatter=False)
    wx.mud_band(L.Z_TURRET_REAR.rect, 0.26, fade='down', spatter=False)
    wx.mud_band(L.Z_BUSTLE.rect, 0.3, fade=None, spatter=False)
    # rust: water lines at plate bottoms + around bolt heads
    for r in (L.Z_HULL_SIDE.rect, L.Z_GLACIS.rect, L.Z_HULL_REAR.rect,
              L.Z_TRACK_SIDE.rect):
        wx.plate_bottom_rust(r, n=7, strength=0.6)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.62)
    # grease on the running-gear hubs; soot at muzzle + exhausts
    wx.oily(L.Z_HUB_CAP.rect, 0.35)
    bx0, by0, bx1, by1 = L.Z_BARREL_WRAP
    wx.soot_patch((bx0 + (bx1 - bx0) * 0.72, by0, bx1, by1), 0.5, fade='right')
    wx.soot_patch(L.Z_BRAKE.rect, 0.55)
    wx.soot_patch(L.Z_EXHAUST.rect, 0.7)
    wx.apply(m)

    # ── void pass: the wheel-well gaps are EMPTY SPACE. Weathering mud
    # lightened them; re-void them near-black with dead reflectance, then
    # redraw the wheels (weathered) so only the wheels catch light. ──
    zone = L.Z_TRACK_SIDE
    tx0v, ty0v, tx1v, ty1v = zone.rect

    def vpy(wy):
        return zone.uv((0, wy, 0))[1] * W

    def vpz(wz):
        return zone.uv((0, 0, wz))[0] * W

    m.d.rectangle([tx0v, vpy(0.95), tx1v, vpy(0.06)], fill=(11, 12, 14))
    m.o.rectangle([tx0v, vpy(0.95), tx1v, vpy(0.06)], fill=(28, 240, 0))
    for i in range(7):
        wz = -2.55 + i * 0.85
        cx, cy = vpz(wz), vpy(0.52)
        r = vpz(wz + 0.40) - vpz(wz)
        m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(30, 31, 34))
        r2 = r * 0.68
        m.d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], fill=jit((52, 53, 56), 3))
        m.o.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(70, 210, 30))
        m.o.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], fill=(110, 150, 170))
        for k in range(6):
            ang = k * np.pi / 3 + 0.3
            bolts(m, [(cx + np.cos(ang) * r2 * 0.55, cy + np.sin(ang) * r2 * 0.55)],
                  r=2, base=(52, 53, 56))
        m.d.ellipse([cx - 3, cy - 3, cx + 3, cy + 3], fill=(40, 41, 44))
        # dusty lower arc so the wheels still sit in the world
        m.d.arc([cx - r, cy - r, cx + r, cy + r], 30, 150, fill=(74, 62, 48), width=3)

    # ── height → normal map (bump): recessed wells, discrete links ──
    from normals import HeightMap
    hm = HeightMap()
    zone = L.Z_TRACK_SIDE

    def hpy(wy):
        return zone.uv((0, wy, 0))[1] * 1024

    def hpz(wz):
        return zone.uv((0, 0, wz))[0] * 1024

    tx0, ty0, tx1, ty1 = zone.rect
    # wheel well: deep recess between skirt and track run
    # wheel-well gaps read as empty space: cliff-deep recess
    hm.rect((tx0, hpy(0.95), tx1, hpy(0.06)), -3.2)
    for i in range(7):  # road wheels stand proud of the well
        wz = -2.55 + i * 0.85
        cx, cy = hpz(wz), hpy(0.52)
        r = hpz(wz + 0.40) - hpz(wz)
        hm.disc(cx, cy, r, 0.3)
        hm.disc(cx, cy, r * 0.68, 0.5)
        hm.disc(cx, cy, 4, 0.68)
    hm.rect((tx0, hpy(1.37), tx1, hpy(0.83)), 0.22)   # skirt proud
    hm.rect((tx0, hpy(1.56), tx1, hpy(1.40)), 0.3)    # fender edge band
    # track running surface: DISCRETE links with gaps + grousers
    wx0, wy0, wx1, wy1 = L.Z_TRACK_WRAP
    for i in range(64):
        lx = wx0 + (wx1 - wx0) * i / 64
        lw = (wx1 - wx0) / 64
        hm.rect((lx + 1.5, wy0, lx + lw - 1.5, wy1), 0.5)
        hm.rect((lx + lw * 0.35, wy0 + 2, lx + lw * 0.65, wy1 - 2), 0.85)
    # hub cap spokes
    r = L.Z_HUB_CAP.rect
    hcx, hcy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    hrr = (r[2] - r[0]) / 2 - 4
    for a in np.linspace(0, 2 * np.pi, 8, endpoint=False):
        hm.line((hcx + np.cos(a) * hrr * 0.25, hcy + np.sin(a) * hrr * 0.25),
                (hcx + np.cos(a) * hrr * 0.9, hcy + np.sin(a) * hrr * 0.9),
                0.5, width=4)
    hm.disc(hcx, hcy, 8, 0.7)
    # fender tread-plate diamonds
    fx0, fy0, fx1, fy1 = L.Z_FENDER.rect
    for gx in range(fx0 + 6, fx1 - 4, 14):
        for gy in range(fy0 + 6, fy1 - 4, 12):
            off = 4 if ((gy - fy0) // 12) % 2 else 0
            hm.line((gx + off, gy), (gx + off + 5, gy + 4), 0.45, width=2)
    # capacitor ring ridge
    cx0, cy0, cx1, cy1 = L.Z_CAP_RING
    hm.rect(((cx0 + cx1) / 2 - 5, cy0, (cx0 + cx1) / 2 + 5, cy1), 0.5)
    # automatic detail: seams -> grooves, bolts -> domes, weather bumps
    hm.crevices_from(m.dif, 0.6)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=5.0).save('out/fable_tank_normals.png')

    # soften emissive slightly so glow edges aren't razor-hard in mips
    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save('out/fable_tank_diffuse.png')
    m.orm.save('out/fable_tank_orm.png')
    m.emi.save('out/fable_tank_emissive.png')
    m.tea.save('out/fable_tank_team.png')
    print('[paint] full texture set written to out/')


if __name__ == '__main__':
    paint_all()
