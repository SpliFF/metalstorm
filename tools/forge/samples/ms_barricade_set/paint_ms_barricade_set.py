"""paint_ms_barricade_set — 1024² PBR set for the barricade kit.

Scrap-plate + earthwork language: mixed salvage plate tones with weld
seams and bolt rows, packed-earth berms with strata and stone speckle,
sandbag rows, hazard chevrons on the gate leaf + lintel (spec), team
mask patches on the wall plate / pylons / leaf (R channel — never baked
into diffuse). Emissive stays black: the spec calls out no lights.
Weathering: base mud, plate-bottom rust, bolt streaks, hinge grease.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import ms_barricade_set_layout as L
from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, jit,
                   shade, BOLT_LOG, YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP, R_ARMOR, R_STEEL, M_STEEL)

RNG = np.random.default_rng(90210)
W = 1024
STEM = 'ms_barricade_set'

PLATE_A = (106, 103, 96)      # salvage steel, light
PLATE_B = (92, 89, 83)        # salvage steel, mid
PLATE_R = (112, 88, 64)       # rust-toned salvage plate
EARTH_C = (99, 80, 57)        # packed earth
EARTH_T = (112, 94, 68)       # trodden crest
SAND_C  = (137, 121, 92)      # sandbag hessian
STEEL_D = (66, 68, 71)        # trim / posts / braces
CONC    = (128, 126, 120)     # pylon concrete-and-steel


def uv_px(zone, a, b):
    """(a, b) along the zone's axes → atlas px."""
    p = [0.0, 0.0, 0.0]
    p['xyz'.index(zone.axes[0])] = a
    p['xyz'.index(zone.axes[1])] = b
    u, v = zone.uv(p)
    return u * W, v * W


def hazard_band(m, box, step=30):
    """Centre-symmetric hazard chevrons (mirror-safe: shared front/back
    zones flip in X; a ^-pattern maps onto itself). Drawn on a temp
    image so stripes never bleed into neighbouring zones."""
    x0, y0, x1, y1 = (int(v) for v in box)
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        return
    tmp = Image.new('RGB', (w, h), tuple(YELLOW))
    td = ImageDraw.Draw(tmp)
    cx = w / 2
    for i in range(-1, int(cx / step) + 2):
        if i % 2 == 0:
            continue
        for s in (-1, 1):  # left half slopes /, right half mirrors
            xa = cx + s * i * step
            td.polygon([(xa, y1 - y0), (xa + s * step, y1 - y0),
                        (xa + s * (step + h), 0), (xa + s * h, 0)],
                       fill=BLACKISH)
    m.dif.paste(tmp, (x0, y0))
    m.o.rectangle([x0, y0, x1, y1], fill=(AO_BASE - 6, 150, 60))


def paint_wall_face(m, zone, plates, team_rect=None):
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=PLATE_B, ao=AO_BASE - 8, rough=185,
         metal=110)
    for (c, w, top, _off) in plates:
        px0, py1 = uv_px(zone, c - w / 2, 0.62)
        px1, py0 = uv_px(zone, c + w / 2, top)
        tone = [PLATE_A, PLATE_B, PLATE_R][int(RNG.integers(0, 3))]
        m.d.rectangle([px0, py0, px1, py1], fill=jit(tone, 5))
        m.o.rectangle([px0, py0, px1, py1],
                      fill=(AO_BASE - 6, 190 if tone is PLATE_R else 175,
                            60 if tone is PLATE_R else 130))
        m.d.rectangle([px0, py0, px1, py1], outline=shade(tone, 0.55),
                      width=2)
        # horizontal lap seam + bolt rows top / mid
        _, pym = uv_px(zone, c, top * 0.52)
        seam_h(m, px0 + 3, px1 - 3, int(pym), tone)
        n = max(3, int(w / 0.45))
        bolts(m, [(px0 + (px1 - px0) * (i + 0.5) / n, py0 + 7)
                  for i in range(n)], r=2, base=tone)
        bolts(m, [(px0 + (px1 - px0) * (i + 0.5) / n, pym + 7)
                  for i in range(n)], r=2, base=tone)
        # patch plate on some panels
        if RNG.random() < 0.6:
            qx = px0 + (px1 - px0) * RNG.uniform(0.15, 0.55)
            qy_ = py0 + (py1 - py0) * RNG.uniform(0.2, 0.55)
            qw, qh = (px1 - px0) * 0.28, (py1 - py0) * 0.2
            m.d.rectangle([qx, qy_, qx + qw, qy_ + qh],
                          fill=jit(shade(tone, 1.12), 4),
                          outline=shade(tone, 0.5))
            bolts(m, [(qx + 4, qy_ + 4), (qx + qw - 4, qy_ + 4),
                      (qx + 4, qy_ + qh - 4), (qx + qw - 4, qy_ + qh - 4)],
                  r=2, base=tone)
    # berm-line grime base
    _, gb = uv_px(zone, 0, 0.95)
    m.d.rectangle([x0, gb, x1, y1], fill=shade(EARTH_C, 0.8))
    m.o.rectangle([x0, gb, x1, y1], fill=(AO_DEEP + 30, 230, 15))
    if team_rect is not None:
        (a0, b0, a1, b1) = team_rect
        tx0, ty1 = uv_px(zone, a0, b0)
        tx1, ty0 = uv_px(zone, a1, b1)
        m.t.rectangle([tx0, ty0, tx1, ty1], fill=(255, 0, 0))
        m.d.rectangle([tx0, ty0, tx1, ty1], fill=TEAMGREY,
                      outline=shade(PLATE_B, 0.5))
    wear_edges(m, (x0, y0, x1, y1), PLATE_B, 45)


def paint_wall_tops(m):
    for zone in (L.WALL_TOP, L.WALLZ_TOP):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=shade(PLATE_B, 0.9), ao=AO_BASE - 10,
             rough=190, metal=110)
        for fx in np.linspace(0.1, 0.9, 8):
            seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 2, y1 - 2,
                   PLATE_B, hi=False)
        wear_edges(m, (x0, y0, x1, y1), PLATE_B, 30)


def paint_earth(m):
    for zone in (L.EARTH, L.EARTH_Z):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=EARTH_C, ao=AO_BASE - 12, rough=235,
             metal=5)
        # strata bands
        for fy in (0.3, 0.55, 0.8):
            yy = y0 + (y1 - y0) * fy
            m.d.line([(x0, yy), (x1, yy)], fill=jit(shade(EARTH_C, 0.88), 4),
                     width=3)
        # stone speckle
        for _ in range(260):
            sx = RNG.uniform(x0, x1 - 3)
            sy = RNG.uniform(y0, y1 - 3)
            s = RNG.uniform(1, 3.5)
            m.d.ellipse([sx, sy, sx + s, sy + s],
                        fill=jit(shade(EARTH_C, RNG.uniform(0.7, 1.25)), 6))
        m.d.rectangle([x0, y1 - 10, x1, y1], fill=shade(EARTH_C, 0.72))
    for zone in (L.EARTH_TOP, L.EARTH_TOP_Z):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=EARTH_T, ao=AO_BASE - 8, rough=230,
             metal=5)
        for _ in range(140):
            sx = RNG.uniform(x0, x1 - 3)
            sy = RNG.uniform(y0, y1 - 3)
            s = RNG.uniform(1, 3)
            m.d.ellipse([sx, sy, sx + s, sy + s],
                        fill=jit(shade(EARTH_T, RNG.uniform(0.75, 1.2)), 6))


def paint_gate_leaf(m):
    zone = L.GATE_LEAF
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=PLATE_A, ao=AO_BASE - 8, rough=180,
         metal=120)
    # three vertical salvage panels
    for (a0, a1, tone) in ((0.05, 1.75, PLATE_A), (1.75, 3.45, PLATE_B),
                           (3.45, 5.15, PLATE_R)):
        px0, py1 = uv_px(zone, a0, 0.15)
        px1, py0 = uv_px(zone, a1, 2.85)
        m.d.rectangle([px0, py0, px1, py1], fill=jit(tone, 4))
        m.o.rectangle([px0, py0, px1, py1],
                      fill=(AO_BASE - 6, 190 if tone is PLATE_R else 175,
                            60 if tone is PLATE_R else 130))
        seam_v(m, int(px1), int(py0) + 2, int(py1) - 2, tone)
    # hazard chevron band across the middle (the spec call-out)
    bx0, by1 = uv_px(zone, 0.15, 1.05)
    bx1, by0 = uv_px(zone, 5.05, 1.95)
    hazard_band(m, (bx0, by0, bx1, by1))
    # bolt rows top and bottom rails
    for wy in (2.7, 0.32):
        pts = []
        for wx in np.linspace(0.35, 4.85, 12):
            px, py = uv_px(zone, wx, wy)
            pts.append((px, py))
        bolts(m, pts, r=2, base=PLATE_B)
    # team squares, symmetric about the leaf centre (mirror-safe)
    for wx in (0.65, 4.55):
        tx0, ty1 = uv_px(zone, wx - 0.32, 2.25)
        tx1, ty0 = uv_px(zone, wx + 0.32, 2.62)
        m.t.rectangle([tx0, ty0, tx1, ty1], fill=(255, 0, 0))
        m.d.rectangle([tx0, ty0, tx1, ty1], fill=TEAMGREY,
                      outline=shade(PLATE_B, 0.5))
    wear_edges(m, (x0, y0, x1, y1), PLATE_A, 50)


def paint_pylons(m):
    zone = L.PYLON
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=CONC, ao=AO_BASE - 6, rough=205, metal=45)
    _, base1 = uv_px(zone, 0, 0.75)
    _, base0 = uv_px(zone, 0, 0.1)
    hazard_band(m, (x0, base1, x1, base0), step=24)
    # panel seams + bolt rows
    for wy in (1.5, 2.4):
        _, py = uv_px(zone, 0, wy)
        seam_h(m, x0 + 2, x1 - 2, int(py), CONC)
    bolts(m, [(x0 + (x1 - x0) * (i + 0.5) / 6,
               uv_px(zone, 0, 3.1)[1]) for i in range(6)], r=2, base=CONC)
    # team band near the top
    _, ty0 = uv_px(zone, 0, 3.35)
    _, ty1 = uv_px(zone, 0, 2.95)
    m.t.rectangle([x0, ty0, x1, ty1], fill=(255, 0, 0))
    m.d.rectangle([x0, ty0, x1, ty1], fill=TEAMGREY,
                  outline=shade(CONC, 0.55))
    wear_edges(m, (x0, y0, x1, y1), CONC, 35)

    zone = L.PYLON_Z
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CONC, 0.95), ao=AO_BASE - 8,
         rough=205, metal=45)
    _, base1 = uv_px(zone, 0, 0.75)
    _, base0 = uv_px(zone, 0, 0.1)
    hazard_band(m, (x0, base1, x1, base0), step=24)
    for wy in (1.5, 2.4):
        _, py = uv_px(zone, 0, wy)
        seam_h(m, x0 + 2, x1 - 2, int(py), CONC)
    _, ty0 = uv_px(zone, 0, 3.35)
    _, ty1 = uv_px(zone, 0, 2.95)
    m.t.rectangle([x0, ty0, x1, ty1], fill=(255, 0, 0))
    m.d.rectangle([x0, ty0, x1, ty1], fill=TEAMGREY,
                  outline=shade(CONC, 0.55))
    wear_edges(m, (x0, y0, x1, y1), CONC, 30)


def paint_lintel_and_cells(m):
    x0, y0, x1, y1 = L.LINTEL.rect
    hazard_band(m, (x0, y0, x1, y1), step=34)
    wear_edges(m, (x0, y0, x1, y1), YELLOW, 40)
    x0, y0, x1, y1 = L.LINTEL_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_D, ao=AO_BASE - 10, rough=175,
         metal=150)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, STEEL_D, hi=False)
    # pylon caps / platform tops
    x0, y0, x1, y1 = L.TOPS.rect
    fill(m, (x0, y0, x1, y1), dif=shade(STEEL_D, 1.08), ao=AO_BASE - 8,
         rough=185, metal=140)
    bolts(m, [(x0 + 10, y0 + 10), (x1 - 10, y0 + 10), (x0 + 10, y1 - 10),
              (x1 - 10, y1 - 10)], r=3, base=STEEL_D)
    m.d.rectangle([x0 + 3, y0 + 3, x1 - 3, y1 - 3],
                  outline=shade(STEEL_D, 0.6), width=2)
    # sandbags
    x0, y0, x1, y1 = L.SAND.rect
    fill(m, (x0, y0, x1, y1), dif=SAND_C, ao=AO_BASE - 10, rough=240,
         metal=0)
    for gy in range(y0, y1, 14):
        m.d.line([(x0, gy), (x1, gy)], fill=shade(SAND_C, 0.82), width=2)
        off = 16 if (gy // 14) % 2 else 0
        for gx in range(x0 + off, x1, 32):
            m.d.line([(gx, gy), (gx, min(gy + 14, y1))],
                     fill=shade(SAND_C, 0.86))
    for _ in range(80):
        sx = RNG.uniform(x0, x1 - 4)
        sy = RNG.uniform(y0, y1 - 3)
        m.d.ellipse([sx, sy, sx + 3, sy + 2],
                    fill=jit(shade(SAND_C, RNG.uniform(0.85, 1.12)), 5))
    # trim / dark cells
    x0, y0, x1, y1 = L.TRIM.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_D, ao=AO_BASE - 12, rough=165,
         metal=155)
    fill(m, L.DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=210, metal=40)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    fill(m, (0, 0, W, W), dif=PLATE_B, ao=AO_BASE - 10, rough=190, metal=100)
    paint_wall_face(m, L.WALL_F, L.WALL_PLATES,
                    team_rect=(2.45, 2.15, 3.25, 2.6))
    paint_wall_face(m, L.WALLZ_F, L.ARM_PLATES_Z)
    paint_wall_tops(m)
    paint_earth(m)
    paint_gate_leaf(m)
    paint_pylons(m)
    paint_lintel_and_cells(m)

    # ── weathering ──
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=90210)
    wx.crevice_grime(m.dif, 0.45)
    for zone in (L.EARTH, L.EARTH_Z):
        wx.mud_band(zone.rect, 0.7, fade='down')
    for zone in (L.EARTH_TOP, L.EARTH_TOP_Z):
        wx.mud_band(zone.rect, 0.3, fade=None, spatter=False)
    for zone in (L.WALL_F, L.WALLZ_F, L.GATE_LEAF):
        wx.mud_band(zone.rect, 0.5, fade='down')
        wx.plate_bottom_rust(zone.rect, n=9, band=8, strength=0.65)
    wx.mud_band(L.PYLON.rect, 0.4, fade='down')
    wx.mud_band(L.PYLON_Z.rect, 0.4, fade='down')
    wx.mud_band(L.SAND.rect, 0.45, fade='down', spatter=False)
    # streaks off the wall plate top corners
    for zone in (L.WALL_F, L.WALLZ_F):
        zx0, zy0, zx1, _ = zone.rect
        for fx in np.linspace(0.12, 0.88, 7):
            wx.rust_streak(zx0 + (zx1 - zx0) * fx, zy0 + 26,
                           int(RNG.uniform(18, 40)), width=2.4, strength=0.4)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.55)
    wx.oily(L.TRIM.rect, 0.3)          # hinge / brace grease
    wx.apply(m)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    for zone, plates in ((L.WALL_F, L.WALL_PLATES),
                         (L.WALLZ_F, L.ARM_PLATES_Z)):
        for (c, w, top, _off) in plates:
            px0, py1 = uv_px(zone, c - w / 2, 0.66)
            px1, py0 = uv_px(zone, c + w / 2, top)
            hm.rect((px0, py0, px1, py1), 0.35)
    bx0, by1 = uv_px(L.GATE_LEAF, 0.15, 1.05)
    bx1, by0 = uv_px(L.GATE_LEAF, 5.05, 1.95)
    hm.rect((bx0, by0, bx1, by1), 0.22)
    for gy in range(L.SAND.rect[1], L.SAND.rect[3], 14):
        hm.line((L.SAND.rect[0], gy), (L.SAND.rect[2], gy), -0.3, width=2)
    hm.crevices_from(m.dif, 0.55)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.2).save(f'out/{STEM}_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save(f'out/{STEM}_diffuse.png')
    m.orm.save(f'out/{STEM}_orm.png')
    m.emi.save(f'out/{STEM}_emissive.png')
    m.tea.save(f'out/{STEM}_team.png')
    print(f'[paint_ms_barricade_set] 1024 texture set written to out/')


if __name__ == '__main__':
    paint_all()
