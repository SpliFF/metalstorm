"""paint_ms_barricade_corner — 1024² PBR set for the 90° corner.

Same scrap-plate + earthwork language as the wall segment it tiles with
(both split out of the ms_barricade_set kit sheet): salvage plate tones with
lap seams and bolt rows on both arm faces, packed-earth berms and junction
mound, a steel corner post with a team band under the watch platform (mask R
only). Emissive black — no lights on a scrap corner. Finished through
paintlib.finish (paint.enrich mottle + all five maps incl. normals).
"""
from __future__ import annotations
import numpy as np

import ms_barricade_corner_layout as L
from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, jit, shade,
                   BOLT_LOG, TEAMGREY, BLACKISH, AO_BASE, AO_DEEP)
import paintlib as PL

RNG = np.random.default_rng(90210)
W = 1024
STEM = 'ms_barricade_corner'

PLATE_A = (106, 103, 96)
PLATE_B = (92, 89, 83)
PLATE_R = (112, 88, 64)
EARTH_C = (99, 80, 57)
EARTH_T = (112, 94, 68)
STEEL_D = (66, 68, 71)
CONC    = (128, 126, 120)      # corner post: concrete-and-steel


def uv_px(zone, a, b):
    p = [0.0, 0.0, 0.0]
    p['xyz'.index(zone.axes[0])] = a
    p['xyz'.index(zone.axes[1])] = b
    u, v = zone.uv(p)
    return u * W, v * W


def paint_arm_face(m, zone, plates):
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=PLATE_B, ao=AO_BASE - 8, rough=185, metal=110)
    for (c, w, top, _off) in plates:
        px0, py1 = uv_px(zone, c - w / 2, 0.62)
        px1, py0 = uv_px(zone, c + w / 2, top)
        tone = [PLATE_A, PLATE_B, PLATE_R][int(RNG.integers(0, 3))]
        m.d.rectangle([px0, py0, px1, py1], fill=jit(tone, 5))
        m.o.rectangle([px0, py0, px1, py1],
                      fill=(AO_BASE - 6, 190 if tone is PLATE_R else 175,
                            60 if tone is PLATE_R else 130))
        m.d.rectangle([px0, py0, px1, py1], outline=shade(tone, 0.55), width=2)
        _, pym = uv_px(zone, c, top * 0.52)
        seam_h(m, px0 + 3, px1 - 3, int(pym), tone)
        n = max(3, int(w / 0.45))
        bolts(m, [(px0 + (px1 - px0) * (i + 0.5) / n, py0 + 7)
                  for i in range(n)], r=2, base=tone)
        bolts(m, [(px0 + (px1 - px0) * (i + 0.5) / n, pym + 7)
                  for i in range(n)], r=2, base=tone)
        if RNG.random() < 0.6:
            qx = px0 + (px1 - px0) * RNG.uniform(0.15, 0.55)
            qy_ = py0 + (py1 - py0) * RNG.uniform(0.2, 0.55)
            qw, qh = (px1 - px0) * 0.28, (py1 - py0) * 0.2
            m.d.rectangle([qx, qy_, qx + qw, qy_ + qh],
                          fill=jit(shade(tone, 1.12), 4),
                          outline=shade(tone, 0.5))
            bolts(m, [(qx + 4, qy_ + 4), (qx + qw - 4, qy_ + 4)], r=2, base=tone)
    _, gb = uv_px(zone, 0, 0.95)
    m.d.rectangle([x0, gb, x1, y1], fill=shade(EARTH_C, 0.8))
    m.o.rectangle([x0, gb, x1, y1], fill=(AO_DEEP + 30, 230, 15))
    wear_edges(m, (x0, y0, x1, y1), PLATE_B, 45)


def paint_plate_tops(m):
    for zone in (L.WALL_TOP, L.WALLZ_TOP):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=shade(PLATE_B, 0.9), ao=AO_BASE - 10,
             rough=190, metal=110)
        for fx in np.linspace(0.1, 0.9, 8):
            seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 2, y1 - 2, PLATE_B,
                   hi=False)
        wear_edges(m, (x0, y0, x1, y1), PLATE_B, 30)


def paint_earth(m):
    for zone in (L.EARTH, L.EARTH_Z):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=EARTH_C, ao=AO_BASE - 12, rough=235,
             metal=5)
        for fy in (0.3, 0.55, 0.8):
            yy = y0 + (y1 - y0) * fy
            m.d.line([(x0, yy), (x1, yy)], fill=jit(shade(EARTH_C, 0.88), 4),
                     width=3)
        for _ in range(260):
            sx, sy = RNG.uniform(x0, x1 - 3), RNG.uniform(y0, y1 - 3)
            s = RNG.uniform(1, 3.5)
            m.d.ellipse([sx, sy, sx + s, sy + s],
                        fill=jit(shade(EARTH_C, RNG.uniform(0.7, 1.25)), 6))
        m.d.rectangle([x0, y1 - 10, x1, y1], fill=shade(EARTH_C, 0.72))
    for zone in (L.EARTH_TOP, L.EARTH_TOP_Z):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=EARTH_T, ao=AO_BASE - 8, rough=230,
             metal=5)
        for _ in range(140):
            sx, sy = RNG.uniform(x0, x1 - 3), RNG.uniform(y0, y1 - 3)
            s = RNG.uniform(1, 3)
            m.d.ellipse([sx, sy, sx + s, sy + s],
                        fill=jit(shade(EARTH_T, RNG.uniform(0.75, 1.2)), 6))


def paint_post(m):
    for zone, tone in ((L.PYLON, CONC), (L.PYLON_Z, shade(CONC, 0.95))):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=tone, ao=AO_BASE - 6, rough=205, metal=45)
        for wy in (1.5, 2.4):
            _, py = uv_px(zone, 0, wy)
            seam_h(m, x0 + 2, x1 - 2, int(py), CONC)
        _, ty0 = uv_px(zone, 0, L.TEAM_BAND[1])
        _, ty1 = uv_px(zone, 0, L.TEAM_BAND[0])
        PL.team_panel(m, (x0, ty0, x1, ty1), outline=shade(CONC, 0.55),
                      base=shade(TEAMGREY, 0.72))
        wear_edges(m, (x0, y0, x1, y1), CONC, 32)
    bolts(m, [(L.PYLON.rect[0] + (L.PYLON.rect[2] - L.PYLON.rect[0])
               * (i + 0.5) / 6, uv_px(L.PYLON, 0, 3.1)[1])
              for i in range(6)], r=2, base=CONC)


def paint_cells(m):
    x0, y0, x1, y1 = L.TOPS.rect            # post cap / platform deck
    fill(m, (x0, y0, x1, y1), dif=shade(STEEL_D, 1.08), ao=AO_BASE - 8,
         rough=185, metal=140)
    bolts(m, [(x0 + 10, y0 + 10), (x1 - 10, y0 + 10), (x0 + 10, y1 - 10),
              (x1 - 10, y1 - 10)], r=3, base=STEEL_D)
    m.d.rectangle([x0 + 3, y0 + 3, x1 - 3, y1 - 3],
                  outline=shade(STEEL_D, 0.6), width=2)
    fill(m, L.TRIM.rect, dif=STEEL_D, ao=AO_BASE - 12, rough=165, metal=155)
    fill(m, L.DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=210, metal=40)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    fill(m, (0, 0, W, W), dif=PLATE_B, ao=AO_BASE - 10, rough=190, metal=100)
    paint_arm_face(m, L.WALL_F, L.ARM_PLATES)
    paint_arm_face(m, L.WALLZ_F, L.ARM_PLATES_Z)
    paint_plate_tops(m)
    paint_earth(m)
    paint_post(m)
    paint_cells(m)

    wx = PL.standard_weather(m, L, ground_rects=(L.EARTH.rect, L.EARTH_Z.rect),
                             side_zones=(L.WALL_F, L.WALLZ_F), seed=90210,
                             mud=0.55, grime=0.45, rust_fraction=0.55)
    for zone in (L.EARTH_TOP, L.EARTH_TOP_Z):
        wx.mud_band(zone.rect, 0.3, fade=None, spatter=False)
    for zone in (L.WALL_F, L.WALLZ_F):
        wx.plate_bottom_rust(zone.rect, n=9, band=8, strength=0.65)
        zx0, zy0, zx1, _ = zone.rect
        for fx in np.linspace(0.12, 0.88, 7):
            wx.rust_streak(zx0 + (zx1 - zx0) * fx, zy0 + 26,
                           int(RNG.uniform(18, 40)), width=2.4, strength=0.4)
    wx.mud_band(L.PYLON.rect, 0.4, fade='down')
    wx.mud_band(L.PYLON_Z.rect, 0.4, fade='down')

    from normals import HeightMap
    hm = HeightMap()
    for zone, plates in ((L.WALL_F, L.ARM_PLATES), (L.WALLZ_F, L.ARM_PLATES_Z)):
        for (c, w, top, _off) in plates:
            px0, py1 = uv_px(zone, c - w / 2, 0.66)
            px1, py0 = uv_px(zone, c + w / 2, top)
            hm.rect((px0, py0, px1, py1), 0.35)

    PL.finish(m, L, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
