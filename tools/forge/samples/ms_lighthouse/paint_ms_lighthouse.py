"""paint_ms_lighthouse — 2048² PBR set for ms_lighthouse.

Weathered-whitewash civilian estate read: wet basalt rock plinth, whitewashed
masonry tower with one faded terracotta stripe band (its own atlas cell, so
the impostor baker flat-shades it cleanly), corrugated keeper hut, galvanised
ladder/railing trim, glazed lamp room with softly lit panes, STRONG warm
emissive lamp lenses on the rotating `light` piece, and a small red aux
beacon. Team colour ONLY in the mask: door panel + one stripe segment.
"""
from __future__ import annotations
import numpy as np

import ms_lighthouse_layout as L   # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   shade, BOLT_LOG, TEAMGREY, STEEL, STEEL_DK, BLACKISH,
                   AO_BASE, AO_DEEP, R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS)

W = 2048
ROCK    = (104, 100, 92)
WHITE   = (226, 220, 206)
STRIPE  = (172, 106, 92)     # faded terracotta
HUTWALL = (188, 182, 168)
GALV    = (162, 166, 172)
GLASSC  = (70, 84, 92)
LAMP    = (255, 196, 96)     # warm lamp emissive
REDL    = (208, 46, 34)


def masonry(m, rect, base, courses=14):
    x0, y0, x1, y1 = rect
    fill(m, rect, dif=base, ao=AO_BASE - 2, rough=R_ARMOR + 22, metal=0)
    step = max(8, (y1 - y0) // courses)
    for gy in range(int(y0) + step, int(y1), step):
        m.d.line([(x0 + 2, gy), (x1 - 2, gy)], fill=shade(base, 0.90), width=2)


def paint_rock(m):
    fill(m, L.R_ROCK_T.rect, dif=ROCK, ao=AO_BASE - 6, rough=R_ARMOR + 30, metal=0)
    x0, y0, x1, y1 = L.R_ROCK_T.rect
    rng = np.random.default_rng(90210)
    for _ in range(70):   # tonal boulder facets, low contrast
        cx, cy = rng.uniform(x0 + 8, x1 - 8), rng.uniform(y0 + 8, y1 - 8)
        r = rng.uniform(10, 42)
        m.d.ellipse([cx - r, cy - r * 0.7, cx + r, cy + r * 0.7],
                    fill=shade(ROCK, rng.uniform(0.88, 1.10)))
    fill(m, L.R_ROCK_S.rect, dif=shade(ROCK, 0.86), ao=AO_BASE - 12,
         rough=R_ARMOR + 30, metal=0)
    x0, y0, x1, y1 = L.R_ROCK_S.rect
    for gx in range(int(x0) + 40, int(x1), 64):   # strata hint
        m.d.line([(gx, y0 + 4), (gx - 18, y1 - 4)], fill=shade(ROCK, 0.78), width=3)
    # dark tide/wet band at the very bottom
    m.d.rectangle([x0, y1 - 44, x1, y1], fill=shade(ROCK, 0.62))


def paint_hut(m):
    # side walls: corrugated iron
    x0, y0, x1, y1 = L.R_HUT_S.rect
    fill(m, (x0, y0, x1, y1), dif=HUTWALL, ao=AO_BASE - 4, rough=R_ARMOR + 8,
         metal=M_ARMOR)
    for gx in range(int(x0) + 10, int(x1), 20):
        m.d.line([(gx, y0 + 4), (gx, y1 - 4)], fill=shade(HUTWALL, 0.90), width=3)
    wear_edges(m, (x0, y0, x1, y1), HUTWALL, density=20)
    # front/back: door + small window + TEAM door panel
    x0, y0, x1, y1 = L.R_HUT_F.rect
    fill(m, (x0, y0, x1, y1), dif=HUTWALL, ao=AO_BASE - 4, rough=R_ARMOR + 8,
         metal=M_ARMOR)
    for gx in range(int(x0) + 10, int(x1), 20):
        m.d.line([(gx, y0 + 4), (gx, y1 - 4)], fill=shade(HUTWALL, 0.92), width=3)
    dx0, dy0, dx1, dy1 = x0 + 70, y0 + 96, x0 + 190, y1 - 8
    m.d.rectangle([dx0, dy0, dx1, dy1], fill=shade(HUTWALL, 0.7),
                  outline=shade(HUTWALL, 0.5), width=3)
    m.o.rectangle([dx0, dy0, dx1, dy1], fill=(AO_BASE - 16, R_ARMOR, M_ARMOR))
    PL.team_panel(m, (dx0 + 14, dy0 + 16, dx1 - 14, dy0 + 88),
                  outline=shade(HUTWALL, 0.6))         # team door panel
    m.d.rectangle([dx1 - 22, (dy0 + dy1) // 2 - 5, dx1 - 10,
                   (dy0 + dy1) // 2 + 5], fill=STEEL_DK)
    PL.glass_rect(m, (x0 + 280, y0 + 90, x0 + 400, y0 + 190),
                  outline=shade(HUTWALL, 0.55))
    bolts(m, [(x0 + 30, y0 + 30), (x1 - 30, y0 + 30), (x0 + 30, y1 - 24),
              (x1 - 30, y1 - 24)], r=4, base=HUTWALL)
    # roof slab
    fill(m, L.R_HUT_T.rect, dif=shade(HUTWALL, 0.80), ao=AO_BASE - 8,
         rough=R_ARMOR + 14, metal=M_ARMOR)
    x0, y0, x1, y1 = L.R_HUT_T.rect
    for gy in range(int(y0) + 14, int(y1), 26):
        m.d.line([(x0 + 4, gy), (x1 - 4, gy)], fill=shade(HUTWALL, 0.70), width=3)


def paint_tower(m):
    masonry(m, L.R_TOW_LO, WHITE, courses=16)
    masonry(m, L.R_TOW_UP, WHITE, courses=8)
    # stripe band: faded terracotta with whitewash showing through
    masonry(m, L.R_TOW_MID, STRIPE, courses=4)
    x0, y0, x1, y1 = L.R_TOW_MID
    rng = np.random.default_rng(90210)
    for _ in range(48):   # faded patches where the paint has let go
        cx, cy = rng.uniform(x0, x1), rng.uniform(y0 + 6, y1 - 6)
        r = rng.uniform(6, 26)
        m.d.ellipse([cx - r, cy - r * 0.5, cx + r, cy + r * 0.5],
                    fill=shade(STRIPE, rng.uniform(1.12, 1.28)))
    # TEAM stripe segment: one octagon facet (v slice 3/8..4/8 of the wrap)
    fy0 = y0 + (y1 - y0) * 3 // 8
    fy1 = y0 + (y1 - y0) * 4 // 8
    PL.team_panel(m, (x0 + 4, fy0 + 4, x1 - 4, fy1 - 4))
    # grime seams down the lower tower
    x0, y0, x1, y1 = L.R_TOW_LO
    for gx in range(int(x0) + 128, int(x1), 128):
        m.d.line([(gx, y0 + 8), (gx, y1 - 4)], fill=shade(WHITE, 0.93), width=2)


def paint_top(m):
    # gallery drum rim + walkable top
    fill(m, L.R_GALL, dif=shade(WHITE, 0.84), ao=AO_BASE - 8,
         rough=R_ARMOR + 10, metal=M_ARMOR)
    x0, y0, x1, y1 = L.R_GALL
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, shade(WHITE, 0.84))
    fill(m, L.R_GALL_T.rect, dif=(96, 98, 102), ao=AO_BASE - 10,
         rough=R_STEEL + 10, metal=M_STEEL - 30)
    x0, y0, x1, y1 = L.R_GALL_T.rect
    for gy in range(int(y0) + 20, int(y1), 40):   # deck plating
        m.d.line([(x0 + 4, gy), (x1 - 4, gy)], fill=(84, 86, 90), width=2)
    # lamp-room glazing: dark glass + galvanised mullions, softly lit panes
    x0, y0, x1, y1 = L.R_GLASS
    fill(m, (x0, y0, x1, y1), dif=GLASSC, ao=AO_BASE, rough=R_GLASS,
         metal=M_GLASS)
    npanes = 8
    for i in range(npanes + 1):
        gx = x0 + (x1 - x0) * i // npanes
        m.d.line([(gx, y0), (gx, y1)], fill=GALV, width=8)
    m.d.rectangle([x0, y0, x1, y0 + 12], fill=GALV)
    m.d.rectangle([x0, y1 - 12, x1, y1], fill=GALV)
    m.e.rectangle([x0 + 6, y0 + 16, x1 - 6, y1 - 16], fill=(120, 84, 36))
    # roof cone: oxidised copper-grey
    fill(m, L.R_ROOF, dif=(96, 108, 104), ao=AO_BASE - 4, rough=R_ARMOR + 6,
         metal=M_STEEL - 40)
    x0, y0, x1, y1 = L.R_ROOF
    for gx in range(int(x0) + 40, int(x1), 80):
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)], fill=(84, 94, 90), width=3)
    # trim wrap (ladder, railing, finial)
    fill(m, L.R_TRIMR, dif=GALV, ao=AO_BASE - 6, rough=R_STEEL, metal=M_STEEL)
    # dark underside cell
    fill(m, L.R_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 16,
         metal=M_ARMOR)


def paint_light(m):
    # housing: dark steel with rivet band
    fill(m, L.R_HOUS.rect, dif=STEEL_DK, ao=AO_BASE - 6, rough=R_STEEL,
         metal=M_STEEL)
    x0, y0, x1, y1 = L.R_HOUS.rect
    bolts(m, [(x0 + 24, y0 + 24), (x1 - 24, y0 + 24), (x0 + 24, y1 - 24),
              (x1 - 24, y1 - 24)], r=4, base=STEEL_DK)
    # lens: strong warm emissive with a fresnel ring read
    x0, y0, x1, y1 = L.R_LENS.rect
    fill(m, (x0, y0, x1, y1), dif=(255, 214, 140), ao=AO_BASE,
         rough=R_GLASS, metal=M_GLASS)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for f in (0.42, 0.28, 0.14):
        rr = (x1 - x0) * f
        m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                    outline=(232, 178, 96), width=4)
    m.e.rectangle([x0 + 4, y0 + 4, x1 - 4, y1 - 4], fill=LAMP)
    # red aux beacon
    fill(m, L.R_RED.rect, dif=REDL, ao=AO_BASE, rough=R_GLASS, metal=M_GLASS)
    x0, y0, x1, y1 = L.R_RED.rect
    m.e.rectangle([x0 + 3, y0 + 3, x1 - 3, y1 - 3], fill=(200, 40, 30))


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_rock(m)
    paint_hut(m)
    paint_tower(m)
    paint_top(m)
    paint_light(m)

    wx = PL.standard_weather(
        m, L, ground_rects=(L.R_ROCK_S.rect,),
        side_zones=(L.R_HUT_S, L.R_HUT_F), seed=41, mud=0.4, grime=0.5)
    # salt/rust streaks down the whitewash under the gallery + ladder line
    x0, y0, x1, y1 = L.R_TOW_UP
    for gx in (x0 + 260, x0 + 760):
        wx.rust_streak(gx, y0 + 16, 60, width=1.6, strength=0.14)
    x0, y0, x1, y1 = L.R_TOW_LO
    wx.rust_streak(x0 + 460, y0 + 40, 80, width=1.5, strength=0.12)
    PL.finish(m, L, 'ms_lighthouse', wx=wx)


if __name__ == '__main__':
    paint_all()
