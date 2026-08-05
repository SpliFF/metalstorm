"""paint_ms_monolith_spire — 2048^2 PBR set for ms_monolith_spire.

Ancient-tech register: monolithic, segmented, seamless — no bolts, no
patches, no team colour. Dark basalt-alloy slabs with tone-on-tone
segment banding (low-contrast on the big flank quads per the baker
note), emissive CYAN tracery lines and stud emitters (cyan is the
ancient-tech reserve), radially scorched base apron.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import ms_monolith_spire_layout as L   # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, shade, AO_BASE, AO_DEEP, R_ARMOR, M_ARMOR,
                   R_GLASS, M_GLASS, BLACKISH)

W = 2048
ALLOY    = (58, 62, 66)      # dark seamless basalt-alloy
ALLOY_LT = (70, 75, 79)
ALLOY_DK = (46, 50, 54)
SCORCH   = (30, 28, 26)
CYAN     = (60, 235, 255)
CYAN_DIM = (24, 92, 104)     # tone-on-tone tracery in diffuse


def y_to_v(y):
    """world y (0..20) -> atlas v inside the flank zones."""
    return (20.0 - y) / 20.0 * W


def paint_apron(m):
    z = L.R_APRON
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ALLOY_DK, ao=AO_BASE, rough=R_ARMOR + 12,
         metal=M_ARMOR + 30)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    # radial scorch: concentric soot rings fading outward
    for rr, k in ((0.46, 0.55), (0.36, 0.42), (0.27, 0.30), (0.19, 0.18)):
        r = (x1 - x0) * rr
        col = tuple(int(a * (1 - k) + b * k) for a, b in zip(ALLOY_DK, SCORCH))
        m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col)
    # soot streaks radiating from the spire footprint
    rng = np.random.default_rng(90210)
    for a in rng.uniform(0, 2 * np.pi, 26):
        r0 = (x1 - x0) * 0.14
        r1 = (x1 - x0) * rng.uniform(0.26, 0.46)
        m.d.line([(cx + r0 * np.cos(a), cy + r0 * np.sin(a)),
                  (cx + r1 * np.cos(a), cy + r1 * np.sin(a))],
                 fill=SCORCH, width=int(rng.uniform(4, 12)))
    # faint inscribed cyan groove ring (dim in diffuse, thin emissive)
    r = (x1 - x0) * 0.235
    m.d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=CYAN_DIM, width=5)
    m.e.ellipse([cx - r, cy - r, cx + r, cy + r], outline=shade(CYAN, 0.45),
                width=3)
    # apron side band
    fill(m, L.R_APRON_S.rect, dif=shade(ALLOY_DK, 0.9), ao=AO_BASE - 10,
         rough=R_ARMOR + 14, metal=M_ARMOR + 30)


def paint_flanks(m):
    for z in (L.R_SEG_X, L.R_SEG_Z):
        x0, y0, x1, y1 = z.rect
        fill(m, (x0, y0, x1, y1), dif=ALLOY, ao=AO_BASE - 2, rough=R_ARMOR,
             metal=M_ARMOR + 40)
        # tone-on-tone segment banding (low contrast: large-quad cells)
        for (_, _, sy0, sy1, _w) in L.SEGS:
            va, vb = y_to_v(sy1), y_to_v(sy0)
            m.d.rectangle([x0 + 2, va, x1 - 2, va + 8], fill=shade(ALLOY, 0.86))
            m.d.rectangle([x0 + 2, vb - 8, x1 - 2, vb], fill=shade(ALLOY, 1.10))
        # subtle vertical panel tones, +-10%
        third = (x1 - x0) / 3
        m.d.rectangle([x0 + third, y0 + 2, x0 + 2 * third, y1 - 2],
                      fill=None, outline=shade(ALLOY, 0.90), width=3)
        # cyan tracery: two thin vertical lines per flank, dim diffuse +
        # bright emissive, running the full monolith height
        v_top, v_bot = y_to_v(19.0), y_to_v(0.8)
        for fx in (0.42, 0.58):
            lx = x0 + (x1 - x0) * fx
            m.d.line([(lx, v_top), (lx, v_bot)], fill=CYAN_DIM, width=4)
            m.e.line([(lx, v_top), (lx, v_bot)], fill=shade(CYAN, 0.75), width=3)
        # tracery cross-links at segment shoulders
        for (_, _, _sy0, sy1, _w) in L.SEGS:
            vv = y_to_v(sy1) + 20
            la, lb = x0 + (x1 - x0) * 0.42, x0 + (x1 - x0) * 0.58
            m.d.line([(la, vv), (lb, vv)], fill=CYAN_DIM, width=4)
            m.e.line([(la, vv), (lb, vv)], fill=shade(CYAN, 0.6), width=2)
        # scorch licking up the lowest 1.2 m
        m.d.rectangle([x0 + 2, y_to_v(0.5), x1 - 2, y_to_v(0.0)], fill=SCORCH)


def paint_details(m):
    # segment top shoulders: slightly lighter, seamless
    x0, y0, x1, y1 = L.R_SHELF.rect
    fill(m, (x0, y0, x1, y1), dif=ALLOY_LT, ao=AO_BASE - 4, rough=R_ARMOR + 4,
         metal=M_ARMOR + 40)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    m.d.ellipse([cx - 90, cy - 90, cx + 90, cy + 90], outline=CYAN_DIM, width=5)
    # ring bar wrap: dark alloy with a cyan running light band
    x0, y0, x1, y1 = L.R_RING
    fill(m, (x0, y0, x1, y1), dif=ALLOY_DK, ao=AO_BASE - 4, rough=R_ARMOR - 8,
         metal=M_ARMOR + 60)
    my = (y0 + y1) // 2
    m.d.line([(x0 + 2, my), (x1 - 2, my)], fill=CYAN_DIM, width=6)
    m.e.line([(x0 + 2, my), (x1 - 2, my)], fill=shade(CYAN, 0.7), width=4)
    # stud emitters: cyan lens face
    x0, y0, x1, y1 = L.R_STUD
    fill(m, (x0, y0, x1, y1), dif=shade(CYAN, 0.35), ao=AO_BASE,
         rough=R_GLASS, metal=M_GLASS)
    m.e.rectangle([x0 + 6, y0 + 6, x1 - 6, y1 - 6], fill=shade(CYAN, 0.9))
    # spike tip: dark with emissive apex band
    x0, y0, x1, y1 = L.R_TIP
    fill(m, (x0, y0, x1, y1), dif=ALLOY_DK, ao=AO_BASE - 2, rough=R_ARMOR,
         metal=M_ARMOR + 40)
    m.d.rectangle([x0 + 2, y0 + 2, x1 - 2, y0 + 22], fill=CYAN_DIM)
    m.e.rectangle([x0 + 2, y0 + 2, x1 - 2, y0 + 22], fill=shade(CYAN, 0.85))
    fill(m, L.R_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 16,
         metal=M_ARMOR)


def paint_all():
    m = Maps()
    paint_apron(m)
    paint_flanks(m)
    paint_details(m)

    # ancient tech is seamless: grime only, no rust/patch weathering
    from weathering import Weather
    wx = Weather(seed=47)
    wx.crevice_grime(m.dif, 0.25)
    wx.mud_band(L.R_APRON_S.rect, 0.35, fade='down')
    wx.apply(m)

    from normals import HeightMap
    hm = HeightMap()
    for z in (L.R_SEG_X, L.R_SEG_Z):
        x0, y0, x1, y1 = z.rect
        for (_, _, sy0, sy1, _w) in L.SEGS:
            hm.line((x0 + 2, y_to_v(sy1)), (x1 - 2, y_to_v(sy1)), -0.6, width=3)
    hm.crevices_from(m.dif, 0.4)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.0).save('out/ms_monolith_spire_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save('out/ms_monolith_spire_diffuse.png')
    m.orm.save('out/ms_monolith_spire_orm.png')
    m.emi.save('out/ms_monolith_spire_emissive.png')
    m.tea.save('out/ms_monolith_spire_team.png')
    print('[paint_ms_monolith_spire] full 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
