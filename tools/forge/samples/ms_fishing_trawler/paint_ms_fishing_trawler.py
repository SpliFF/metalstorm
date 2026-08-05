"""paint_ms_fishing_trawler — 2048 PBR set for ms_fishing_trawler.

Civilian daily-life register: faded teal-blue topsides over a black
boot-top and oxide anti-foul, hand-painted name at the bow, timber
deck planking, off-white wheelhouse with warm lit windows, tan cork
floats, dark tarred net grid, stacked pale fish crates, and heavy
working weathering — rust streaks under fittings, gull streaks along
the sheer line, soot at the stack. NO team colour.
"""
from __future__ import annotations
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

import ms_fishing_trawler_layout as L    # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, jit, shade,
                   BOLT_LOG, GLASS, BLACKISH, AO_BASE, AO_DEEP,
                   R_STEEL, M_STEEL, R_GLASS, M_GLASS)
import paintlib as PL

FONT = P.FONT
if not os.path.exists(FONT):
    for cand in ('/System/Library/Fonts/Supplemental/Arial Bold.ttf',
                 '/Library/Fonts/Arial Bold.ttf'):
        if os.path.exists(cand):
            FONT = cand
            P.FONT = cand
            break

W = 2048
TEAL = (52, 88, 96)              # faded working topside paint
BOOT = (30, 32, 34)
ANTIFOUL = (110, 58, 46)
TIMBER = (122, 104, 78)          # deck planking
TIMBER_D = (102, 86, 64)
WHITE = (196, 192, 182)          # wheelhouse off-white
NETC = (52, 48, 42)              # tarred net
CORK = (196, 128, 52)            # floats
CRATE = (168, 160, 142)
WARM = (255, 190, 120)


def paint_hull(m):
    zone = L.S_HULL_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=TEAL, ao=AO_BASE - 6, rough=205, metal=60)
    u, v = PL.zone_fns(zone)

    # plank/plate seams + frame verticals (tone-on-tone)
    for wy in (0.9, 1.6, 2.2):
        seam_h(m, x0 + 3, x1 - 3, int(v(wy)), TEAL, hi=False)
    for wz in np.arange(-8.0, 9.0, 2.2):
        seam_v(m, int(u(wz)), int(v(2.55)), int(v(0.4)), TEAL, hi=False)
    # boot-top + anti-foul below the waterline
    m.d.rectangle([x0, v(L.WATERLINE[1]), x1, v(L.WATERLINE[0])], fill=BOOT)
    m.o.rectangle([x0, v(L.WATERLINE[1]), x1, v(L.WATERLINE[0])],
                  fill=(AO_BASE - 15, 205, 30))
    m.d.rectangle([x0, v(L.WATERLINE[0]), x1, y1], fill=ANTIFOUL)
    m.o.rectangle([x0, v(L.WATERLINE[0]), x1, y1],
                  fill=(AO_BASE - 20, 220, 20))
    # rubbing strake at the sheer
    m.d.rectangle([x0, v(2.42), x1, v(2.28)], fill=shade(TEAL, 0.6))
    # hand-painted name at the bow, white on the teal
    fh = ImageFont.truetype(FONT, 40)
    m.d.text((u(-7.6) + 2, v(2.05) + 2), 'MARIBEL', font=fh,
             fill=shade(TEAL, 0.5))
    m.d.text((u(-7.6), v(2.05)), 'MARIBEL', font=fh, fill=(214, 210, 198))
    # scuppers along the working deck edge
    for wz in np.arange(0.0, 8.5, 1.8):
        m.d.rectangle([u(wz) - 5, int(v(1.42)), u(wz) + 5, int(v(1.30))],
                      fill=(34, 36, 38))
    wear_edges(m, (x0, int(v(2.6)), x1, int(v(0.4))), TEAL, 60)

    # belly
    r = L.S_BELLY.rect
    fill(m, r, dif=shade(ANTIFOUL, 0.9), ao=AO_BASE - 25, rough=225, metal=15)
    for fx in (0.33, 0.66):
        seam_v(m, int(r[0] + (r[2] - r[0]) * fx), r[1] + 3, r[3] - 3,
               ANTIFOUL, hi=False)

    # bow / stern caps: continue the scheme
    for zone in (L.S_BOW, L.S_STERN):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=TEAL, ao=AO_BASE - 8, rough=205,
             metal=60)
        wl0 = zone.uv((0, L.WATERLINE[0], 0))[1] * W
        wl1 = zone.uv((0, L.WATERLINE[1], 0))[1] * W
        m.d.rectangle([x0, wl1, x1, wl0], fill=BOOT)
        m.d.rectangle([x0, wl0, x1, y1], fill=ANTIFOUL)
        wear_edges(m, (x0, y0, x1, y1), TEAL, 45)
    # home-port mark on the transom
    zone = L.S_STERN
    x0, y0, x1, y1 = zone.rect
    f = ImageFont.truetype(FONT, 26)
    tw = m.d.textlength('MARIBEL', font=f)
    m.d.text(((x0 + x1) / 2 - tw / 2, y0 + 30), 'MARIBEL', font=f,
             fill=(210, 206, 194))


def paint_deck(m):
    zone = L.S_DECK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=TIMBER, ao=AO_BASE - 10, rough=225,
         metal=15)
    u, v = PL.zone_fns(zone)
    # planking runs fore-aft: longitudinal seams + butt joints
    for wx in np.arange(-2.4, 2.5, 0.35):
        m.d.line([(x0 + 2, v(wx)), (x1 - 2, v(wx))],
                 fill=jit(TIMBER_D, 6), width=2)
    rng = np.random.default_rng(90210)
    for wz in np.arange(-8.5, 9.0, 1.1):
        wx = float(rng.uniform(-2.3, 2.3))
        m.d.line([(u(wz), v(wx) - 6), (u(wz), v(wx) + 6)],
                 fill=shade(TIMBER_D, 0.85), width=2)
    # fo'c'sle break line + hatch coaming on the working deck
    m.d.rectangle([u(-1.55), y0 + 4, u(-1.4), y1 - 4],
                  fill=shade(TIMBER_D, 0.7))
    m.d.rectangle(PL.nbox(u(-0.4), v(-0.9), u(1.4), v(0.9)),
                  outline=shade(TIMBER_D, 0.6), width=6, fill=(84, 78, 66))
    wear_edges(m, (x0, y0, x1, y1), TIMBER, 70)


def paint_wheelhouse(m):
    # sides + front: off-white, warm window band
    for zone in (L.S_WH_S, L.S_WH_F):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=WHITE, ao=AO_BASE - 4, rough=195,
             metal=30)
        wy0 = zone.uv((0, L.WH_WIN_Y[1], 0))[1] * W
        wy1 = zone.uv((0, L.WH_WIN_Y[0], 0))[1] * W
        m.d.rectangle([x0 + 12, wy0, x1 - 12, wy1], fill=(150, 152, 150))
        m.o.rectangle([x0 + 12, wy0, x1 - 12, wy1],
                      fill=(AO_BASE, R_GLASS, M_GLASS))
        for i in range(5):
            gx = x0 + 12 + (x1 - x0 - 24) * i / 5
            m.d.rectangle([gx - 3, wy0, gx + 3, wy1], fill=shade(WHITE, 0.88))
        # warm-lit panes (the crew is home)
        for i in (1, 3):
            gx0 = x0 + 12 + (x1 - x0 - 24) * i / 5 + 4
            gx1 = x0 + 12 + (x1 - x0 - 24) * (i + 1) / 5 - 4
            m.e.rectangle([gx0, wy0 + 3, gx1, wy1 - 3], fill=WARM)
        # teal wainscot below the windows
        m.d.rectangle([x0, y1 - 40, x1, y1], fill=shade(TEAL, 1.1))
        wear_edges(m, (x0, y0, x1, y1), WHITE, 35)
    # door on the aft face
    zone = L.S_WH_F
    x0, y0, x1, y1 = zone.rect
    m.d.rectangle([x0 + (x1 - x0) * 0.68, y1 - 120, x0 + (x1 - x0) * 0.86,
                   y1 - 10], fill=(96, 84, 66), outline=shade(WHITE, 0.6),
                  width=2)
    # roof
    zone = L.S_WH_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(WHITE, 0.88), ao=AO_BASE - 8,
         rough=205, metal=25)
    bolts(m, [(x0 + 12, y0 + 12), (x1 - 12, y0 + 12), (x0 + 12, y1 - 12),
              (x1 - 12, y1 - 12)], base=WHITE)


def paint_gear(m):
    # net cell: tarred twine grid over near-black (tone-on-tone for baker)
    x0, y0, x1, y1 = L.S_NET.rect
    fill(m, (x0, y0, x1, y1), dif=NETC, ao=AO_BASE - 18, rough=235, metal=10)
    for gx in range(x0, x1, 14):
        m.d.line([(gx, y0), (gx + 26, y1)], fill=shade(NETC, 1.18), width=2)
        m.d.line([(gx, y0), (gx - 26, y1)], fill=shade(NETC, 1.14), width=2)
    m.d.rectangle([x0, y0, x1, y0 + 10], fill=shade(CORK, 0.8))  # headrope
    # floats: cork orange, weathered
    r = L.S_FLOAT.rect
    fill(m, r, dif=CORK, ao=AO_BASE - 6, rough=215, metal=10)
    m.d.rectangle([r[0], r[1] + (r[3] - r[1]) // 2 - 4, r[2],
                   r[1] + (r[3] - r[1]) // 2 + 4], fill=shade(CORK, 0.75))
    # crates: pale fish boxes with stencil + slats
    x0, y0, x1, y1 = L.S_CRATE.rect
    fill(m, (x0, y0, x1, y1), dif=CRATE, ao=AO_BASE - 6, rough=220, metal=15)
    for fy in (0.3, 0.55, 0.8):
        m.d.line([(x0 + 4, y0 + (y1 - y0) * fy), (x1 - 4, y0 + (y1 - y0) * fy)],
                 fill=shade(CRATE, 0.8), width=3)
    f = ImageFont.truetype(FONT, 22)
    m.d.text((x0 + 24, y0 + 22), 'FISK', font=f, fill=(90, 96, 104))
    # winch drum: rusty steel with rope wraps
    x0, y0, x1, y1 = L.S_WINCH
    fill(m, (x0, y0, x1, y1), dif=(96, 88, 78), ao=AO_BASE - 10, rough=190,
         metal=140)
    for fx in np.linspace(0.15, 0.85, 8):
        sx = int(x0 + (x1 - x0) * fx)
        m.d.line([(sx, y0 + 8), (sx, y1 - 8)], fill=(120, 106, 84), width=4)
    # rails / gantry legs: worked steel, chipped paint
    x0, y0, x1, y1 = L.S_RAIL
    fill(m, (x0, y0, x1, y1), dif=(88, 92, 96), ao=AO_BASE - 8, rough=180,
         metal=150)
    # boom spar: painted timber-brown
    x0, y0, x1, y1 = L.S_BOOM
    fill(m, (x0, y0, x1, y1), dif=(110, 92, 66), ao=AO_BASE - 8, rough=210,
         metal=30)
    # masts/posts + trims + dark cell
    x0, y0, x1, y1 = L.S_MAST
    fill(m, (x0, y0, x1, y1), dif=(120, 112, 98), ao=AO_BASE - 8, rough=195,
         metal=80)
    fill(m, L.S_TRIM.rect, dif=(70, 72, 74), ao=AO_BASE - 12, rough=180,
         metal=120)
    fill(m, L.S_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=210, metal=40)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_hull(m)
    paint_deck(m)
    paint_wheelhouse(m)
    paint_gear(m)

    # ── working-boat weathering ──
    wx = PL.standard_weather(m, L, ground_rects=(),
                             side_zones=(L.S_HULL_SIDE,), seed=90210,
                             mud=0.30, grime=0.5)
    zone = L.S_HULL_SIDE
    u, v = PL.zone_fns(zone)
    # rust streaks under scuppers and bollard positions
    for wz in np.arange(0.0, 8.5, 1.8):
        wx.rust_streak(u(wz), v(1.42), 40 + (int(wz * 10) % 3) * 14,
                       width=3.0, strength=0.55)
    for wz in (-7.6, -5.0, -2.6):
        wx.rust_streak(u(wz), v(2.3), 30, width=2.5, strength=0.4)
    # gull streaks: chalky white runs from the sheer line (drawn, not rust)
    rngg = np.random.default_rng(90210)
    for wz in rngg.uniform(-8.0, 8.5, 14):
        gx = u(float(wz))
        gl = int(rngg.uniform(16, 46))
        m.d.line([(gx, v(2.55)), (gx + rngg.uniform(-3, 3), v(2.55) + gl)],
                 fill=(206, 204, 196), width=2)
    for gz in ((-3.9, -2.0), (0.4, 1.4)):     # roof + rail favourites
        pass
    # gull streaks on the wheelhouse roof edge
    r = L.S_WH_TOP.rect
    for fx in (0.2, 0.45, 0.8):
        gx = r[0] + (r[2] - r[0]) * fx
        m.d.line([(gx, r[1] + 6), (gx + 4, r[1] + 30)],
                 fill=(208, 206, 198), width=3)
    # waterline scum + stack soot
    wx.mud_band((zone.rect[0], int(v(0.55)), zone.rect[2],
                 int(v(-0.25))), 0.55, fade=None, spatter=True)
    sx0, sy0, sx1, sy1 = L.S_WINCH
    wx.soot_patch((sx0, sy0, sx0 + (sx1 - sx0) // 4, sy1), 0.5)
    wx.mud_band(L.S_DECK.rect, 0.30, fade=None, spatter=True)
    wx.mud_band(L.S_WH_S.rect, 0.18, fade='down', spatter=False)

    # ── normals extras: plank lines + hull strakes ──
    from normals import HeightMap
    hm = HeightMap()
    for wy in (0.9, 1.6, 2.2):
        hm.line((zone.rect[0] + 2, v(wy)), (zone.rect[2] - 2, v(wy)), -0.4,
                width=2)
    dz = L.S_DECK
    du, dv = PL.zone_fns(dz)
    for wxp in np.arange(-2.4, 2.5, 0.35):
        hm.line((dz.rect[0] + 2, dv(wxp)), (dz.rect[2] - 2, dv(wxp)), -0.3,
                width=2)
    PL.finish(m, L, 'ms_fishing_trawler', hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
