"""paint_ms_market_stalls — 1024² PBR set for ms_market_stalls.

Civilian market read: trampled dirt plaza, weathered grey-brown timber
posts and beams, plank crates and counters with produce spill, patched
canvas back walls, four faded mismatched awning canvases (terracotta
stripe / washed teal / bleached mustard stripe / patched off-white),
sack-and-cloth hanging goods, and warm amber string-light bulbs — the
ONLY emissive.  No team mask anywhere (map prop, --no-team).
"""
from __future__ import annotations
import numpy as np
from PIL import ImageFilter

import ms_market_stalls_layout as L      # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024

from paint import (Maps, fill, bolts, wear_edges, jit, shade, BOLT_LOG,
                   STEEL_DK, BLACKISH, AO_BASE, AO_SEAM, AO_DEEP, RNG)
import paintlib as PL

DIRT     = (122, 112, 96)
DIRT_DK  = (100, 90, 78)
TIMBER   = (128, 108, 84)
TIMBER_DK = (92, 76, 58)
WOOD     = (150, 122, 84)
WOOD_DK  = (110, 88, 60)
CANVAS   = (168, 158, 132)
TERRA    = (172, 96, 74)
TEAL     = (96, 134, 128)
MUSTARD  = (176, 148, 82)
OFFWHITE = (188, 182, 164)
SACK     = (146, 126, 92)
CLOTH    = (134, 96, 88)
BULB     = (255, 196, 110)


def planks(m, rect, base, n, horiz=True):
    x0, y0, x1, y1 = rect
    for i in range(n):
        if horiz:
            py0 = y0 + (y1 - y0) * i / n
            py1 = y0 + (y1 - y0) * (i + 1) / n
            m.d.rectangle([x0, py0, x1, py1],
                          fill=jit(shade(base, 0.85 + 0.09 * (i % 3)), 5))
            m.d.line([(x0, py1), (x1, py1)], fill=shade(base, 0.6), width=2)
            m.o.line([(x0, py1), (x1, py1)], fill=(AO_SEAM, 210, 10), width=2)
        else:
            px0 = x0 + (x1 - x0) * i / n
            px1 = x0 + (x1 - x0) * (i + 1) / n
            m.d.rectangle([px0, y0, px1, y1],
                          fill=jit(shade(base, 0.85 + 0.09 * (i % 3)), 5))
            m.d.line([(px1, y0), (px1, y1)], fill=shade(base, 0.6), width=2)
            m.o.line([(px1, y0), (px1, y1)], fill=(AO_SEAM, 210, 10), width=2)


def paint_pad(m):
    x0, y0, x1, y1 = L.PAD_T
    fill(m, (x0, y0, x1, y1), dif=DIRT, ao=AO_BASE - 6, rough=220, metal=0)
    for _ in range(700):
        px = RNG.uniform(x0, x1 - 3)
        py = RNG.uniform(y0, y1 - 3)
        m.d.rectangle([px, py, px + RNG.uniform(1, 3), py + RNG.uniform(1, 3)],
                      fill=jit(shade(DIRT, RNG.uniform(0.84, 1.14)), 6))
    # trampled paths between the stalls (cross through the middle)
    for (fx, w) in ((0.5, 40), (0.28, 22), (0.72, 22)):
        cxp = x0 + (x1 - x0) * fx
        m.d.rectangle([cxp - w, y0, cxp + w, y1],
                      fill=shade(DIRT_DK, 1.02))
        m.d.rectangle([x0, cxp - w, x1, cxp + w],
                      fill=shade(DIRT_DK, 1.04))
    for _ in range(24):                          # packed patches
        px = RNG.uniform(x0, x1 - 40)
        py = RNG.uniform(y0, y1 - 30)
        m.d.ellipse([px, py, px + RNG.uniform(16, 44), py + RNG.uniform(12, 30)],
                    fill=jit(shade(DIRT, RNG.uniform(0.9, 1.06)), 4))
    wear_edges(m, (x0, y0, x1, y1), DIRT, 40)
    fill(m, L.PAD_S, dif=shade(DIRT_DK, 0.9), ao=AO_BASE - 18, rough=225, metal=0)


def paint_timber(m):
    # posts: vertical grain, silvered old timber
    x0, y0, x1, y1 = L.POST_S
    fill(m, (x0, y0, x1, y1), dif=TIMBER, ao=AO_BASE - 4, rough=215, metal=0)
    for _ in range(22):
        gx = RNG.uniform(x0 + 2, x1 - 2)
        gy = RNG.uniform(y0, y1 - 60)
        m.d.line([(gx, gy), (gx + RNG.uniform(-2, 2), gy + RNG.uniform(24, 56))],
                 fill=jit(shade(TIMBER, RNG.uniform(0.72, 1.1)), 6), width=1)
    m.d.rectangle([x0, y1 - 26, x1, y1], fill=shade(TIMBER_DK, 0.85))  # ground stain
    wear_edges(m, (x0, y0, x1, y1), TIMBER, 30)
    fill(m, L.POST_T, dif=shade(TIMBER_DK, 0.9), ao=AO_BASE - 10, rough=220, metal=0)
    xt0, yt0, xt1, yt1 = L.POST_T
    for r in (6, 12, 18):
        m.d.ellipse([(xt0 + xt1) / 2 - r, (yt0 + yt1) / 2 - r,
                     (xt0 + xt1) / 2 + r, (yt0 + yt1) / 2 + r],
                    outline=shade(TIMBER_DK, 0.7))
    # beams
    x0, y0, x1, y1 = L.BEAM_S
    fill(m, (x0, y0, x1, y1), dif=shade(TIMBER, 0.94), ao=AO_BASE - 5,
         rough=215, metal=0)
    for _ in range(14):
        gy = RNG.uniform(y0 + 2, y1 - 2)
        gx = RNG.uniform(x0, x1 - 20)
        m.d.line([(gx, gy), (gx + RNG.uniform(12, 24), gy)],
                 fill=jit(shade(TIMBER, RNG.uniform(0.75, 1.08)), 5), width=1)
    bolts(m, [(x0 + 10, y0 + 12), (x1 - 10, y0 + 12),
              (x0 + 10, y1 - 12), (x1 - 10, y1 - 12)], r=2, base=TIMBER)
    wear_edges(m, (x0, y0, x1, y1), TIMBER, 24)


def paint_crates_counter(m):
    # crate side + top (plank + batten, market produce boxes)
    x0, y0, x1, y1 = L.CRATE_S
    fill(m, (x0, y0, x1, y1), dif=WOOD, ao=AO_BASE - 4, rough=205, metal=6)
    planks(m, (x0, y0, x1, y1), WOOD, 4)
    for bx in (x0 + 6, x1 - 22):
        m.d.rectangle([bx, y0 + 2, bx + 16, y1 - 2], fill=jit(WOOD_DK, 5))
        m.o.rectangle([bx, y0 + 2, bx + 16, y1 - 2], fill=(AO_BASE - 12, 205, 6))
    # hand-painted market mark (mirror-safe blocks, no glyphs)
    m.d.rectangle([x0 + 52, y0 + 40, x0 + 128, y0 + 66],
                  fill=jit(shade(TERRA, 0.85), 6))
    m.d.rectangle([x0 + 52, y0 + 76, x0 + 100, y0 + 92],
                  fill=jit(shade(TERRA, 0.7), 6))
    wear_edges(m, (x0, y0, x1, y1), WOOD, 40)
    x0, y0, x1, y1 = L.CRATE_T
    fill(m, (x0, y0, x1, y1), dif=shade(WOOD, 0.92), ao=AO_BASE - 6,
         rough=210, metal=6)
    planks(m, (x0, y0, x1, y1), WOOD, 4, horiz=False)
    # produce fill hint in the middle (greens/roots)
    for _ in range(46):
        px = RNG.uniform(x0 + 24, x1 - 30)
        py = RNG.uniform(y0 + 24, y1 - 30)
        r = RNG.uniform(4, 9)
        c = [(96, 118, 62), (150, 106, 52), (168, 132, 60)][int(RNG.uniform(0, 3))]
        m.d.ellipse([px, py, px + r, py + r], fill=jit(c, 10))
    wear_edges(m, (x0, y0, x1, y1), WOOD, 26)

    # counter front / top
    x0, y0, x1, y1 = L.COUNT_S
    fill(m, (x0, y0, x1, y1), dif=shade(WOOD, 0.86), ao=AO_BASE - 6,
         rough=210, metal=4)
    planks(m, (x0, y0, x1, y1), shade(WOOD, 0.9), 5)
    # draped cloth skirt band along the bottom
    m.d.rectangle([x0, y1 - 34, x1, y1], fill=jit(shade(CLOTH, 0.95), 6))
    m.d.line([(x0, y1 - 34), (x1, y1 - 34)], fill=shade(CLOTH, 0.7), width=2)
    wear_edges(m, (x0, y0, x1, y1), WOOD, 36)
    x0, y0, x1, y1 = L.COUNT_T
    fill(m, (x0, y0, x1, y1), dif=shade(WOOD, 0.96), ao=AO_BASE - 4,
         rough=205, metal=4)
    planks(m, (x0, y0, x1, y1), shade(WOOD, 1.0), 6)
    # spill of goods along the back edge
    for _ in range(40):
        px = RNG.uniform(x0 + 10, x1 - 16)
        py = RNG.uniform(y0 + 8, y0 + 52)
        r = RNG.uniform(4, 10)
        c = [(96, 118, 62), (172, 88, 58), (176, 148, 82),
             (146, 126, 92)][int(RNG.uniform(0, 4))]
        m.d.ellipse([px, py, px + r, py + r * 0.8], fill=jit(c, 12))
    wear_edges(m, (x0, y0, x1, y1), WOOD, 24)


def paint_canvas(m):
    # back wall: patched neutral canvas
    x0, y0, x1, y1 = L.BACK_C
    fill(m, (x0, y0, x1, y1), dif=CANVAS, ao=AO_BASE - 6, rough=230, metal=0)
    for fy in np.linspace(0.1, 0.9, 8):
        yy = y0 + (y1 - y0) * fy
        pts = [(x0 + (x1 - x0) * t, yy + np.sin(t * 7 + fy * 9) * 5)
               for t in np.linspace(0, 1, 9)]
        m.d.line(pts, fill=jit(shade(CANVAS, 0.9 if int(fy * 8) % 2 else 1.07), 4),
                 width=3)
    for (fx, fy, pw, ph) in ((0.2, 0.3, 34, 28), (0.62, 0.62, 40, 30),
                             (0.75, 0.18, 26, 24)):
        px, py = x0 + (x1 - x0) * fx, y0 + (y1 - y0) * fy
        m.d.rectangle([px, py, px + pw, py + ph], fill=jit(shade(CANVAS, 0.84), 6))
        m.d.rectangle([px, py, px + pw, py + ph], outline=shade(CANVAS, 0.66))
    m.d.rectangle([x0 + 1, y0 + 1, x1 - 1, y1 - 1],
                  outline=shade(CANVAS, 0.7), width=3)
    wear_edges(m, (x0, y0, x1, y1), CANVAS, 30)

    # four awning canvases
    def awn(rect, base, stripe=None, patch=False):
        ax0, ay0, ax1, ay1 = rect
        fill(m, rect, dif=base, ao=AO_BASE - 4, rough=232, metal=0)
        if stripe:
            nst = 7
            for i in range(nst):
                if i % 2:
                    sx0 = ax0 + (ax1 - ax0) * i / nst
                    sx1 = ax0 + (ax1 - ax0) * (i + 1) / nst
                    m.d.rectangle([sx0, ay0, sx1, ay1], fill=jit(stripe, 5))
        # drape shading along v (back->front)
        for fy in np.linspace(0.08, 0.92, 9):
            yy = ay0 + (ay1 - ay0) * fy
            m.d.line([(ax0 + 2, yy), (ax1 - 2, yy)],
                     fill=jit(shade(base, 0.92 if int(fy * 9) % 2 else 1.05), 4),
                     width=2)
        if patch:
            for (fx, fy, pw, ph) in ((0.3, 0.4, 40, 32), (0.68, 0.7, 34, 28)):
                px, py = ax0 + (ax1 - ax0) * fx, ay0 + (ay1 - ay0) * fy
                m.d.rectangle([px, py, px + pw, py + ph],
                              fill=jit(shade(base, 0.78), 8))
                m.d.rectangle([px, py, px + pw, py + ph],
                              outline=shade(base, 0.6))
        # sun-bleach toward the front hem, hem shadow line
        m.d.rectangle([ax0, ay1 - 26, ax1, ay1 - 20], fill=shade(base, 0.7))
        wear_edges(m, rect, base, 44)

    awn(L.AWN_A, TERRA, stripe=shade(OFFWHITE, 0.95))
    awn(L.AWN_B, TEAL, patch=True)
    awn(L.AWN_C, MUSTARD, stripe=shade(TERRA, 0.9))
    awn(L.AWN_D, OFFWHITE, patch=True)
    fill(m, L.AWN_U, dif=shade(CANVAS, 0.58), ao=AO_BASE - 42, rough=235, metal=0)


def paint_goods_lights(m):
    # goods bundle 1: sacks / produce nets
    x0, y0, x1, y1 = L.GOODS
    fill(m, (x0, y0, x1, y1), dif=SACK, ao=AO_BASE - 8, rough=225, metal=0)
    for _ in range(26):
        px = RNG.uniform(x0 + 4, x1 - 16)
        py = RNG.uniform(y0 + 4, y1 - 16)
        r = RNG.uniform(6, 14)
        m.d.ellipse([px, py, px + r, py + r],
                    fill=jit(shade(SACK, RNG.uniform(0.8, 1.1)), 8))
    m.d.rectangle([x0, y0, x1, y0 + 10], fill=shade(SACK, 0.6))   # tied neck
    wear_edges(m, (x0, y0, x1, y1), SACK, 24)
    # goods bundle 2: hung cloth rolls
    x0, y0, x1, y1 = L.GOODS2
    fill(m, (x0, y0, x1, y1), dif=CLOTH, ao=AO_BASE - 8, rough=228, metal=0)
    for i in range(5):
        sx = x0 + (x1 - x0) * i / 5
        c = [CLOTH, TEAL, MUSTARD, shade(CLOTH, 0.8), OFFWHITE][i]
        m.d.rectangle([sx, y0, sx + (x1 - x0) / 5, y1], fill=jit(shade(c, 0.9), 6))
        m.d.line([(sx, y0), (sx, y1)], fill=BLACKISH, width=1)
    m.d.rectangle([x0, y0, x1, y0 + 8], fill=shade(TIMBER_DK, 0.8))
    wear_edges(m, (x0, y0, x1, y1), CLOTH, 22)

    # string-light bulb: warm amber, EMISSIVE (the only glow on the model)
    x0, y0, x1, y1 = L.LIGHT
    fill(m, (x0, y0, x1, y1), dif=BULB, ao=AO_BASE, rough=90, metal=0)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    r = (x1 - x0) * 0.34
    m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 214, 140))
    m.e.ellipse([cx - r * 1.3, cy - r * 1.3, cx + r * 1.3, cy + r * 1.3],
                fill=(210, 140, 52))
    m.e.ellipse([cx - r * 0.7, cy - r * 0.7, cx + r * 0.7, cy + r * 0.7],
                fill=(255, 200, 110))

    # wire / cord: near-black, no emissive
    fill(m, L.WIRE, dif=(48, 44, 40), ao=AO_BASE - 20, rough=200, metal=20)

    fill(m, L.DARK, dif=BLACKISH, ao=AO_DEEP, rough=215, metal=0)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_pad(m)
    paint_timber(m)
    paint_crates_counter(m)
    paint_canvas(m)
    paint_goods_lights(m)

    wx = PL.standard_weather(
        m, L, seed=90210,
        ground_rects=(L.PAD_S,),
        side_zones=(), mud=0.4, grime=0.5, rust_fraction=0.35)
    # ground-contact mud on everything standing in the dirt
    for rect, s in ((L.POST_S, 0.5), (L.CRATE_S, 0.4), (L.COUNT_S, 0.35)):
        x0, y0, x1, y1 = rect
        wx.mud_band((x0, y0, x1, y1), s, fade='down', dust=0.2)
    wx.mud_band(L.PAD_T, 0.2, fade=None, spatter=True)
    # canvas grime streaks off the awning ridges
    for rect in (L.AWN_A, L.AWN_B, L.AWN_C, L.AWN_D):
        x0, y0, x1, y1 = rect
        for fx in np.linspace(0.15, 0.85, 4):
            wx.rust_streak(x0 + (x1 - x0) * fx, y0 + 8, 22, width=2.0,
                           strength=0.18)

    from normals import HeightMap
    hm = HeightMap()
    for rect, n, horiz in ((L.CRATE_S, 4, True), (L.CRATE_T, 4, False),
                           (L.COUNT_S, 5, True), (L.COUNT_T, 6, True)):
        x0, y0, x1, y1 = rect
        for i in range(1, n):
            if horiz:
                gy = y0 + (y1 - y0) * i / n
                hm.line((x0 + 2, gy), (x1 - 2, gy), -0.5, width=2)
            else:
                gx = x0 + (x1 - x0) * i / n
                hm.line((gx, y0 + 2), (gx, y1 - 2), -0.5, width=2)
    # awning drape ridges
    for rect in (L.AWN_A, L.AWN_B, L.AWN_C, L.AWN_D):
        x0, y0, x1, y1 = rect
        for fy in np.linspace(0.15, 0.85, 5):
            hm.line((x0 + 4, y0 + (y1 - y0) * fy), (x1 - 4, y0 + (y1 - y0) * fy),
                    0.22, width=5)

    PL.finish(m, L, 'ms_market_stalls', hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
