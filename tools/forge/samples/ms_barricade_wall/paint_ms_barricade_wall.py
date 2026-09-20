"""paint_ms_barricade_wall — 1024² PBR set for the 8 m wall segment.

Painter language inherited from the ms_barricade_set kit sheet (the model this
was split out of): mixed salvage plate tones with lap seams and bolt rows,
packed-earth berm with strata + stone speckle, hessian sandbags, one team ID
patch (mask R only — never baked into diffuse). Emissive stays black: a scrap
wall carries no lights. Finished through paintlib.finish, so paint.enrich's
multi-scale mottle runs over the flat fills (the blue-grey blandness fix) and
all five maps including normals are written.
"""
from __future__ import annotations
import numpy as np

import ms_barricade_wall_layout as L
import paint as P
from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, jit, shade,
                   BOLT_LOG, TEAMGREY, AO_BASE, AO_DEEP)
import paintlib as PL

RNG = np.random.default_rng(90210)
W = 1024
STEM = 'ms_barricade_wall'

PLATE_A = (106, 103, 96)      # salvage steel, light
PLATE_B = (92, 89, 83)        # salvage steel, mid
PLATE_R = (112, 88, 64)       # rust-toned salvage plate
EARTH_C = (99, 80, 57)        # packed earth
EARTH_T = (112, 94, 68)       # trodden crest
SAND_C  = (137, 121, 92)      # sandbag hessian
STEEL_D = (66, 68, 71)        # trim / posts / braces


def uv_px(zone, a, b):
    """(a, b) along the zone's axes -> atlas px."""
    p = [0.0, 0.0, 0.0]
    p['xyz'.index(zone.axes[0])] = a
    p['xyz'.index(zone.axes[1])] = b
    u, v = zone.uv(p)
    return u * W, v * W


def paint_wall_face(m):
    zone = L.WALL_F
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=PLATE_B, ao=AO_BASE - 8, rough=185, metal=110)
    for (c, w, top, _off) in L.WALL_PLATES:
        px0, py1 = uv_px(zone, c - w / 2, 0.62)
        px1, py0 = uv_px(zone, c + w / 2, top)
        tone = [PLATE_A, PLATE_B, PLATE_R][int(RNG.integers(0, 3))]
        m.d.rectangle([px0, py0, px1, py1], fill=jit(tone, 5))
        m.o.rectangle([px0, py0, px1, py1],
                      fill=(AO_BASE - 6, 190 if tone is PLATE_R else 175,
                            60 if tone is PLATE_R else 130))
        m.d.rectangle([px0, py0, px1, py1], outline=shade(tone, 0.55), width=2)
        # horizontal lap seam + bolt rows top / mid
        _, pym = uv_px(zone, c, top * 0.52)
        seam_h(m, px0 + 3, px1 - 3, int(pym), tone)
        n = max(3, int(w / 0.45))
        bolts(m, [(px0 + (px1 - px0) * (i + 0.5) / n, py0 + 7)
                  for i in range(n)], r=2, base=tone)
        bolts(m, [(px0 + (px1 - px0) * (i + 0.5) / n, pym + 7)
                  for i in range(n)], r=2, base=tone)
        if RNG.random() < 0.6:          # welded patch plate
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
    # team ID patch — the wall's only team surface
    a0, b0, a1, b1 = L.TEAM_PATCH
    tx0, ty1 = uv_px(zone, a0, b0)
    tx1, ty0 = uv_px(zone, a1, b1)
    PL.team_panel(m, (tx0, ty0, tx1, ty1), outline=shade(PLATE_B, 0.5),
                  base=shade(TEAMGREY, 0.72))
    wear_edges(m, (x0, y0, x1, y1), PLATE_B, 45)


def paint_wall_top(m):
    zone = L.WALL_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(PLATE_B, 0.9), ao=AO_BASE - 10,
         rough=190, metal=110)
    for fx in np.linspace(0.1, 0.9, 8):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 2, y1 - 2, PLATE_B, hi=False)
    wear_edges(m, (x0, y0, x1, y1), PLATE_B, 30)


def paint_earth(m):
    for zone in (L.EARTH, L.EARTH_Z):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=EARTH_C, ao=AO_BASE - 12, rough=235,
             metal=5)
        for fy in (0.3, 0.55, 0.8):        # strata bands
            yy = y0 + (y1 - y0) * fy
            m.d.line([(x0, yy), (x1, yy)], fill=jit(shade(EARTH_C, 0.88), 4),
                     width=3)
        for _ in range(260):               # stone speckle
            sx, sy = RNG.uniform(x0, x1 - 3), RNG.uniform(y0, y1 - 3)
            s = RNG.uniform(1, 3.5)
            m.d.ellipse([sx, sy, sx + s, sy + s],
                        fill=jit(shade(EARTH_C, RNG.uniform(0.7, 1.25)), 6))
        m.d.rectangle([x0, y1 - 10, x1, y1], fill=shade(EARTH_C, 0.72))
    x0, y0, x1, y1 = L.EARTH_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=EARTH_T, ao=AO_BASE - 8, rough=230, metal=5)
    for _ in range(140):
        sx, sy = RNG.uniform(x0, x1 - 3), RNG.uniform(y0, y1 - 3)
        s = RNG.uniform(1, 3)
        m.d.ellipse([sx, sy, sx + s, sy + s],
                    fill=jit(shade(EARTH_T, RNG.uniform(0.75, 1.2)), 6))


def paint_cells(m):
    x0, y0, x1, y1 = L.SAND.rect
    fill(m, (x0, y0, x1, y1), dif=SAND_C, ao=AO_BASE - 10, rough=240, metal=0)
    for gy in range(y0, y1, 14):
        m.d.line([(x0, gy), (x1, gy)], fill=shade(SAND_C, 0.82), width=2)
        off = 16 if (gy // 14) % 2 else 0
        for gx in range(x0 + off, x1, 32):
            m.d.line([(gx, gy), (gx, min(gy + 14, y1))],
                     fill=shade(SAND_C, 0.86))
    for _ in range(80):
        sx, sy = RNG.uniform(x0, x1 - 4), RNG.uniform(y0, y1 - 3)
        m.d.ellipse([sx, sy, sx + 3, sy + 2],
                    fill=jit(shade(SAND_C, RNG.uniform(0.85, 1.12)), 5))
    fill(m, L.TRIM.rect, dif=STEEL_D, ao=AO_BASE - 12, rough=165, metal=155)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    fill(m, (0, 0, W, W), dif=PLATE_B, ao=AO_BASE - 10, rough=190, metal=100)
    paint_wall_face(m)
    paint_wall_top(m)
    paint_earth(m)
    paint_cells(m)

    # ── weathering: earth on the berm, rust off the plate tops, grime low ──
    from weathering import vertical_rects_of
    wx = PL.standard_weather(m, L, ground_rects=(L.EARTH.rect, L.EARTH_Z.rect),
                             side_zones=(L.WALL_F,), seed=90210,
                             mud=0.55, grime=0.45, rust_fraction=0.55)
    wx.mud_band(L.EARTH_TOP.rect, 0.3, fade=None, spatter=False)
    wx.mud_band(L.SAND.rect, 0.45, fade='down', spatter=False)
    wx.plate_bottom_rust(L.WALL_F.rect, n=9, band=8, strength=0.65)
    zx0, zy0, zx1, _ = L.WALL_F.rect
    for fx in np.linspace(0.12, 0.88, 7):
        wx.rust_streak(zx0 + (zx1 - zx0) * fx, zy0 + 26,
                       int(RNG.uniform(18, 40)), width=2.4, strength=0.4)

    # ── height -> normals: plates stand proud of the berm ──
    from normals import HeightMap
    hm = HeightMap()
    for (c, w, top, _off) in L.WALL_PLATES:
        px0, py1 = uv_px(L.WALL_F, c - w / 2, 0.66)
        px1, py0 = uv_px(L.WALL_F, c + w / 2, top)
        hm.rect((px0, py0, px1, py1), 0.35)
    for gy in range(L.SAND.rect[1], L.SAND.rect[3], 14):
        hm.line((L.SAND.rect[0], gy), (L.SAND.rect[2], gy), -0.3, width=2)

    PL.finish(m, L, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
