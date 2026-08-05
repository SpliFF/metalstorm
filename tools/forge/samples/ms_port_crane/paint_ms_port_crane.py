"""paint_ms_port_crane — 2048² PBR set for ms_port_crane (resource site).

Working-harbour read: faded safety-orange crane steel (boom girder, portal
legs, machinery house), galvanised tie rods and trim, dark mechanical
steel (bogies, trolley, hook), rust-brown rails, hazard chevrons at the
jib tip and on the bogie faces. Emissive: warm operator-cab window band +
amber apex beacon — functional lights only. No team colour (map prop).
Weathering: salt-air rust streaks off the boom seams and cab roof, grime
at bogie/rail contact, oily sheave housings.
Large-quad swatch cells stay tone-on-tone (impostor baker flat-shades).
"""
from __future__ import annotations
import numpy as np

import ms_port_crane_layout as L     # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, jit, shade,
                   BOLT_LOG, YELLOW, BLACKISH,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, RNG)
import paintlib as PL
from paintlib import zone_fns, hazard_band, glass_rect

W = 2048
STEM = 'ms_port_crane'

ORANGE   = (176, 104, 48)      # faded safety-orange crane steel
ORANGE_D = (146, 86, 40)
GALV     = (160, 164, 170)     # galvanised rods/trim
STEEL    = (88, 92, 98)        # mechanical steel
STEEL_DK = (58, 61, 66)
RAILBRN  = (96, 74, 58)        # rust-brown rail steel
CABGRN   = (86, 96, 92)        # cab body (weathered drab)
LAMP     = (255, 196, 120)     # warm window glow


def paint_boom(m):
    z = L.R_BOOM_S
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ORANGE, ao=AO_BASE - 4,
         rough=R_ARMOR + 6, metal=M_ARMOR + 30)
    u, v = zone_fns(z)
    # web stiffener seams every ~1.8 m + rivet row
    for wz in np.arange(-12.5, 5.0, 1.8):
        seam_v(m, int(u(wz)), y0 + 3, y1 - 3, ORANGE, hi=False)
    bolts(m, [(u(wz), (y0 + y1) / 2) for wz in np.arange(-12.2, 4.8, 0.9)],
          r=3, base=ORANGE)
    # hazard chevrons at the waterside tip
    hazard_band(m, (u(-13.2), y0 + 2, u(-11.6), y1 - 2), step=18)
    # painted-over patch plates (tone-on-tone)
    for _ in range(8):
        px = x0 + RNG.random() * (x1 - x0 - 120)
        py = y0 + RNG.random() * (y1 - y0 - 50)
        m.d.rectangle([px, py, px + 90 + RNG.random() * 40, py + 34],
                      fill=jit(shade(ORANGE, RNG.uniform(0.9, 1.05)), 3))
    wear_edges(m, (x0, y0, x1, y1), ORANGE, 50)

    # boom top/bottom: slightly darker, walkway strip on top
    x0, y0, x1, y1 = L.R_BOOM_T.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ORANGE, 0.92), ao=AO_BASE - 6,
         rough=R_ARMOR + 10, metal=M_ARMOR + 30)
    for fy in np.linspace(0.25, 0.75, 3):
        m.d.line([(x0 + 3, y0 + (y1 - y0) * fy), (x1 - 3, y0 + (y1 - y0) * fy)],
                 fill=shade(ORANGE, 0.82), width=2)
    wear_edges(m, (x0, y0, x1, y1), shade(ORANGE, 0.92), 40)


def paint_wraps(m):
    # portal legs: orange with panel seams along length
    x0, y0, x1, y1 = L.R_LEG
    fill(m, (x0, y0, x1, y1), dif=ORANGE, ao=AO_BASE - 5,
         rough=R_ARMOR + 6, metal=M_ARMOR + 30)
    for fu in (0.2, 0.45, 0.7):
        gx = x0 + (x1 - x0) * fu
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)], fill=shade(ORANGE, 0.8),
                 width=3)
    wear_edges(m, (x0, y0, x1, y1), ORANGE, 40)
    # tie rods / apex: galvanised
    x0, y0, x1, y1 = L.R_TIE
    fill(m, (x0, y0, x1, y1), dif=GALV, ao=AO_BASE - 5,
         rough=R_STEEL - 6, metal=M_STEEL)
    m.d.line([(x0, (y0 + y1) / 2), (x1, (y0 + y1) / 2)],
             fill=shade(GALV, 1.12), width=2)
    # sill beams / braces / cab hangers: darker orange
    x0, y0, x1, y1 = L.R_SILL
    fill(m, (x0, y0, x1, y1), dif=ORANGE_D, ao=AO_BASE - 7,
         rough=R_ARMOR + 8, metal=M_ARMOR + 30)
    wear_edges(m, (x0, y0, x1, y1), ORANGE_D, 30)
    # hoist cables: near-black twisted steel
    x0, y0, x1, y1 = L.R_CABLE
    fill(m, (x0, y0, x1, y1), dif=(48, 48, 50), ao=AO_BASE - 16,
         rough=R_STEEL + 16, metal=M_STEEL - 20)


def paint_house(m):
    for z in (L.R_HOUSE_S, L.R_HOUSE_F):
        x0, y0, x1, y1 = z.rect
        fill(m, (x0, y0, x1, y1), dif=ORANGE, ao=AO_BASE - 5,
             rough=R_ARMOR + 8, metal=M_ARMOR + 30)
        u, v = zone_fns(z)
        # louvre vent panel
        vx0, vx1 = x0 + (x1 - x0) * 0.12, x0 + (x1 - x0) * 0.38
        vy0, vy1 = v(16.1), v(15.0)
        m.d.rectangle([vx0, vy0, vx1, vy1], fill=shade(ORANGE, 0.78))
        for gy in np.arange(vy0 + 6, vy1 - 3, 9):
            m.d.line([(vx0 + 3, gy), (vx1 - 3, gy)],
                     fill=shade(ORANGE, 0.6), width=2)
        # access door on the front/back zone only
        if z is L.R_HOUSE_F:
            dx0, dx1 = x0 + (x1 - x0) * 0.58, x0 + (x1 - x0) * 0.78
            m.d.rectangle([dx0, v(16.2), dx1, v(14.75)], fill=STEEL)
            m.o.rectangle([dx0, v(16.2), dx1, v(14.75)],
                          fill=(AO_BASE - 12, R_STEEL, M_STEEL))
            m.d.rectangle([dx0, v(16.2), dx1, v(14.75)],
                          outline=shade(ORANGE, 0.6), width=3)
        wear_edges(m, (x0, y0, x1, y1), ORANGE, 40)
    # roof
    x0, y0, x1, y1 = L.R_HOUSE_T.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ORANGE, 0.88), ao=AO_BASE - 7,
         rough=R_ARMOR + 14, metal=M_ARMOR + 20)
    m.d.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2],
                  outline=shade(ORANGE, 0.72), width=3)


def paint_cab(m):
    for z in (L.R_CAB_S, L.R_CAB_F):
        x0, y0, x1, y1 = z.rect
        fill(m, (x0, y0, x1, y1), dif=CABGRN, ao=AO_BASE - 5,
             rough=R_ARMOR + 6, metal=M_ARMOR + 40)
        u, v = zone_fns(z)
        wy_hi, wy_lo = L.CAB_WIN_Y
        wx0, wx1 = x0 + (x1 - x0) * 0.1, x1 - (x1 - x0) * 0.1
        # warm lit window band (functional light: occupied cab)
        glass_rect(m, (wx0, v(wy_hi), wx1, v(wy_lo)), outline=CABGRN)
        m.e.rectangle([wx0 + 4, v(wy_hi) + 4, wx1 - 4, v(wy_lo) - 4],
                      fill=LAMP)
        # mullions (diffuse only, over the glow)
        for fu in (1 / 3, 2 / 3):
            gx = wx0 + (wx1 - wx0) * fu
            m.d.line([(gx, v(wy_hi)), (gx, v(wy_lo))],
                     fill=shade(CABGRN, 0.6), width=4)
            m.e.line([(gx, v(wy_hi)), (gx, v(wy_lo))], fill=(0, 0, 0),
                     width=4)
        wear_edges(m, (x0, y0, x1, y1), CABGRN, 30)
    x0, y0, x1, y1 = L.R_CAB_T.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CABGRN, 0.9), ao=AO_BASE - 8,
         rough=R_ARMOR + 10, metal=M_ARMOR + 40)


def paint_cells(m):
    # rails: rust-brown, polished running-band highlight
    x0, y0, x1, y1 = L.R_RAIL.rect
    fill(m, (x0, y0, x1, y1), dif=RAILBRN, ao=AO_BASE - 10,
         rough=R_STEEL + 12, metal=M_STEEL - 40)
    m.d.rectangle([x0 + 2, y0 + (y1 - y0) * 0.4, x1 - 2,
                   y0 + (y1 - y0) * 0.6], fill=shade(RAILBRN, 1.16))
    # bogies: dark steel + hazard stripe course (tone-restrained)
    x0, y0, x1, y1 = L.R_BOGIE.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 10,
         rough=R_STEEL + 8, metal=M_STEEL - 30)
    hazard_band(m, (x0 + 6, y1 - 26, x1 - 6, y1 - 8), step=16)
    bolts(m, [(x0 + 24 + i * 40, y0 + 24) for i in range(8)], r=4,
          base=STEEL_DK)
    # portal beams: darker orange
    fill(m, L.R_PORTAL.rect, dif=ORANGE_D, ao=AO_BASE - 8,
         rough=R_ARMOR + 8, metal=M_ARMOR + 30)
    wear_edges(m, L.R_PORTAL.rect, ORANGE_D, 30)
    # trolley: mechanical steel with grease darkening
    x0, y0, x1, y1 = L.R_TROLLEY.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 8,
         rough=R_STEEL + 6, metal=M_STEEL - 10)
    bolts(m, [(x0 + 30 + i * 46, (y0 + y1) / 2) for i in range(7)], r=4,
          base=STEEL)
    # hook block: dark steel, worn
    fill(m, L.R_HOOK.rect, dif=STEEL_DK, ao=AO_BASE - 12,
         rough=R_STEEL + 10, metal=M_STEEL)
    wear_edges(m, L.R_HOOK.rect, STEEL_DK, 30)
    # mech (sheave housings): near-black greasy steel
    fill(m, L.R_MECH.rect, dif=(52, 54, 58), ao=AO_DEEP + 20,
         rough=R_STEEL - 30, metal=M_STEEL)
    # dark cell
    fill(m, L.R_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 16,
         metal=M_ARMOR)
    # apex beacon: amber emissive
    x0, y0, x1, y1 = L.R_BEACON.rect
    fill(m, (x0, y0, x1, y1), dif=(120, 62, 30), ao=AO_BASE,
         rough=R_GLASS + 30, metal=40)
    m.e.rectangle([x0 + 8, y0 + 8, x1 - 8, y1 - 8], fill=(255, 140, 40))
    # general steel-grey cell (boom end caps, apex block)
    fill(m, L.R_STEELG.rect, dif=shade(ORANGE, 0.85), ao=AO_BASE - 8,
         rough=R_ARMOR + 10, metal=M_ARMOR + 30)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_boom(m)
    paint_wraps(m)
    paint_house(m)
    paint_cab(m)
    paint_cells(m)

    wx = PL.standard_weather(
        m, L,
        ground_rects=(L.R_RAIL.rect, L.R_BOGIE.rect),
        side_zones=(L.R_HOUSE_S, L.R_HOUSE_F, L.R_CAB_S, L.R_CAB_F),
        seed=41, mud=0.35, grime=0.5, rust_fraction=0.5)
    # salt-air rust streaks off the boom stiffener seams
    bx0, by0, bx1, by1 = L.R_BOOM_S.rect
    for fx in np.linspace(0.06, 0.94, 12):
        wx.rust_streak(bx0 + (bx1 - bx0) * fx, by0 + 6,
                       18 + RNG.random() * 34, width=2.4, strength=0.32)
    wx.plate_bottom_rust(L.R_BOOM_S.rect, n=8, strength=0.45)
    # legs weather at the bogie roots
    wx.mud_band(L.R_LEG, 0.25, fade='left', spatter=False, dust=0.25)
    for _ in range(10):
        lx0, ly0, lx1, ly1 = L.R_LEG
        wx.rust_blotch(lx0 + RNG.random() * (lx1 - lx0),
                       ly0 + 6 + RNG.random() * (ly1 - ly0 - 12),
                       3 + RNG.random() * 5, strength=0.5)
    # greasy sheave/trolley zones
    wx.oily(L.R_MECH.rect, 0.5)
    wx.oily((L.R_TROLLEY.rect[0], L.R_TROLLEY.rect[1],
             L.R_TROLLEY.rect[0] + 120, L.R_TROLLEY.rect[3]), 0.3)
    # cab roof streaks
    wx.plate_bottom_rust(L.R_CAB_S.rect, n=4, strength=0.4)

    PL.finish(m, L, STEM, wx=wx)


if __name__ == '__main__':
    paint_all()
