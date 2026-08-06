"""paint_ms_cargo_tramp — 2048² PBR set for ms_cargo_tramp.

Civilian tramp freighter: patched rust-streaked hull (mismatched plate
patchwork over a tired ochre-grey), black boot-top at the waterline,
oxide anti-foul below, rust-stained working deck, orange-leaded
coamings, wood crates / steel drums / olive tarp cargo, soot-streaked
buff funnel, grubby off-white deckhouse with a lit bridge window pair,
laundry colours on the line. NO team colour.
"""
from __future__ import annotations
import os
import numpy as np
from PIL import ImageFont

import ms_cargo_tramp_layout as L    # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, stencil,
                   jit, shade, BOLT_LOG, GLASS, YELLOW, BLACKISH,
                   AO_BASE, AO_SEAM, AO_DEEP, R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS)

# macOS font fallback (same trick as the landing-ship sample)
FONT = P.FONT
if not os.path.exists(FONT):
    for cand in ('/System/Library/Fonts/Supplemental/Arial Bold.ttf',
                 '/Library/Fonts/Arial Bold.ttf'):
        if os.path.exists(cand):
            FONT = cand
            P.FONT = cand
            break

W = 2048
STEM = 'ms_cargo_tramp'
HULL = (99, 92, 80)            # tired ochre-grey topsides
HULLPAL = [(99, 92, 80), (108, 99, 84), (90, 86, 78), (112, 94, 74),
           (84, 78, 72), (104, 96, 86)]
ANTIFOUL = (98, 54, 44)
BOOT = (30, 32, 35)
DECKC = (82, 78, 70)
COAMC = (142, 84, 46)          # red-lead coaming
CRATEW = (118, 96, 66)
DRUMC = (74, 84, 92)
TARPC = (88, 94, 72)
HOUSE = (158, 150, 132)        # grubby off-white
FUNBUFF = (146, 116, 78)
WARM = (255, 190, 120)


def paint_hull(m):
    zone = L.S_HULL_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=HULL, ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR)
    u, v = PL.zone_fns(zone)

    # patched plating above the boot-top (tone-on-tone scrap patchwork)
    PL.panel_patchwork(m, PL.nbox(x0 + 2, y0 + 2, x1 - 2, int(v(0.65))),
                       HULLPAL, cols=12, rows=3)
    for wy in (2.2, 3.4):
        seam_h(m, x0 + 3, x1 - 3, int(v(wy)), HULL, hi=False)
    # boot-top + anti-foul
    m.d.rectangle([x0, v(L.WATERLINE[1]), x1, v(L.WATERLINE[0])], fill=BOOT)
    m.o.rectangle([x0, v(L.WATERLINE[1]), x1, v(L.WATERLINE[0])],
                  fill=(AO_BASE - 15, 200, 30))
    m.d.rectangle([x0, v(L.WATERLINE[0]), x1, y1], fill=ANTIFOUL)
    m.o.rectangle([x0, v(L.WATERLINE[0]), x1, y1], fill=(AO_BASE - 20, 215, 20))
    # name at the bow, hand-painted read
    fh = ImageFont.truetype(FONT, 40)
    m.d.text((u(-25.5) + 2, v(4.9) + 2), 'MARY CELESTE II', font=fh,
             fill=shade(HULL, 0.5))
    m.d.text((u(-25.5), v(4.9)), 'MARY CELESTE II', font=fh,
             fill=(196, 190, 176))
    # draft marks at the stern
    fdm = ImageFont.truetype(FONT, 12)
    for i, wy in enumerate((-1.6, -0.8, 0.0)):
        m.d.text((u(25.8), v(wy) - 6), f'{i + 2}', font=fdm,
                 fill=(206, 200, 190))
    wear_edges(m, (x0, y0, x1, int(v(-0.4))), HULL, 60)

    # belly
    r = L.S_BELLY.rect
    fill(m, r, dif=shade(ANTIFOUL, 0.9), ao=AO_BASE - 25, rough=220, metal=15)


def paint_deck(m):
    zone = L.S_DECK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=DECKC, ao=AO_BASE - 10, rough=200, metal=90)
    u, v = PL.zone_fns(zone)
    for wz in np.arange(-26.0, 27.0, 2.4):       # deck plate seams
        seam_v(m, int(u(wz)), y0 + 2, y1 - 2, DECKC, hi=False)
    for wx in (-3.6, 3.6):                       # side walkway gutters
        m.d.line([(x0 + 2, v(wx)), (x1 - 2, v(wx))],
                 fill=shade(DECKC, 0.75), width=3)
    # hold surrounds: worn dark rectangles + rust
    for (z0, z1) in L.HOLDS:
        m.d.rectangle([u(z0 - 0.4), v(-3.0), u(z1 + 0.4), v(3.0)],
                      fill=shade(DECKC, 0.9))
    wear_edges(m, (x0, y0, x1, y1), DECKC, 85)

    # bow + stern faces
    for zone2, base in ((L.S_BOW, HULL), (L.S_STERN, HULL)):
        rx0, ry0, rx1, ry1 = zone2.rect
        fill(m, (rx0, ry0, rx1, ry1), dif=base, ao=AO_BASE - 8)
        wl0 = zone2.uv((0, L.WATERLINE[0], 0))[1] * W
        wl1 = zone2.uv((0, L.WATERLINE[1], 0))[1] * W
        m.d.rectangle([rx0, wl1, rx1, wl0], fill=BOOT)
        m.d.rectangle([rx0, wl0, rx1, ry1], fill=ANTIFOUL)
        wear_edges(m, (rx0, ry0, rx1, int(wl1)), base, 45)
    # stern name
    f = ImageFont.truetype(FONT, 26)
    rx0, ry0, rx1, ry1 = L.S_STERN.rect
    tw = m.d.textlength('MARY C II', font=f)
    m.d.text(((rx0 + rx1) / 2 - tw / 2, ry0 + 40), 'MARY C II', font=f,
             fill=(196, 190, 176))


def paint_cargo(m):
    # coamings: red-lead with chipped top edge
    x0, y0, x1, y1 = L.S_COAM.rect
    fill(m, (x0, y0, x1, y1), dif=COAMC, ao=AO_BASE - 10, rough=195, metal=80)
    seam_h(m, x0 + 2, x1 - 2, y0 + 12, COAMC, hi=False)
    wear_edges(m, (x0, y0, x1, y1), COAMC, 70)
    r = L.S_COAM_TOP.rect
    fill(m, r, dif=shade(COAMC, 0.85), ao=AO_BASE - 12, rough=200, metal=80)

    # crates: weathered wood, tone-on-tone plank hints
    x0, y0, x1, y1 = L.S_CRATE.rect
    fill(m, (x0, y0, x1, y1), dif=CRATEW, ao=AO_BASE - 8, rough=215, metal=10)
    for fy in np.linspace(0.12, 0.88, 6):
        yy = int(y0 + (y1 - y0) * fy)
        m.d.line([(x0 + 2, yy), (x1 - 2, yy)], fill=shade(CRATEW, 0.9),
                 width=2)
    # drums: dulled steel with a rust-red band
    x0, y0, x1, y1 = L.S_DRUM.rect
    fill(m, (x0, y0, x1, y1), dif=DRUMC, ao=AO_BASE - 8, rough=180, metal=150)
    m.d.rectangle([x0, y0 + (y1 - y0) // 2 - 8, x1, y0 + (y1 - y0) // 2 + 8],
                  fill=(120, 66, 44))
    # tarp: faded olive canvas with lashing lines
    x0, y0, x1, y1 = L.S_TARP.rect
    fill(m, (x0, y0, x1, y1), dif=TARPC, ao=AO_BASE - 6, rough=225, metal=5)
    for fx in (0.25, 0.5, 0.75):
        xx = int(x0 + (x1 - x0) * fx)
        m.d.line([(xx, y0 + 2), (xx, y1 - 2)], fill=shade(TARPC, 0.8),
                 width=2)


def paint_super(m):
    # deckhouse sides: window band, rust-streak-prone off-white
    zone = L.S_SUPER_S
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=HOUSE, ao=AO_BASE - 4)
    wy0 = y0 + int((y1 - y0) * 0.16)
    wy1 = y0 + int((y1 - y0) * 0.34)
    for i in range(5):
        gx = x0 + 20 + (x1 - x0 - 40) * i / 5
        PL.glass_rect(m, (int(gx), wy0, int(gx + 34), wy1),
                      outline=shade(HOUSE, 0.6))
    # porthole row on the lower deck
    for i in range(4):
        gx = x0 + 44 + (x1 - x0 - 88) * i / 4
        m.d.ellipse([gx - 9, y1 - 74, gx + 9, y1 - 56], fill=GLASS,
                    outline=shade(HOUSE, 0.55))
    # door aft
    m.d.rectangle([x1 - 56, y1 - 88, x1 - 26, y1 - 10], fill=(64, 60, 54),
                  outline=shade(HOUSE, 0.6), width=2)
    wear_edges(m, (x0, y0, x1, y1), HOUSE, 45)

    # front/back face: bridge windows, two lit warm
    zone = L.S_SUPER_F
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=HOUSE, ao=AO_BASE - 4)
    wy0 = y0 + int((y1 - y0) * 0.14)
    wy1 = y0 + int((y1 - y0) * 0.30)
    for i in range(6):
        gx0 = x0 + 16 + (x1 - x0 - 32) * i / 6 + 3
        gx1 = x0 + 16 + (x1 - x0 - 32) * (i + 1) / 6 - 3
        m.d.rectangle([gx0, wy0, gx1, wy1], fill=GLASS)
        m.o.rectangle([gx0, wy0, gx1, wy1], fill=(AO_BASE, R_GLASS, M_GLASS))
        if i in (1, 4):
            m.e.rectangle([gx0 + 2, wy0 + 2, gx1 - 2, wy1 - 2],
                          fill=(150, 110, 60))
    wear_edges(m, (x0, y0, x1, y1), HOUSE, 40)

    # roof
    zone = L.S_SUPER_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(DECKC, 1.05), ao=AO_BASE - 8,
         rough=195, metal=90)
    bolts(m, [(x0 + 14, y0 + 14), (x1 - 14, y0 + 14), (x0 + 14, y1 - 14),
              (x1 - 14, y1 - 14)], base=DECKC)

    # funnel: buff with a black smoke cap band
    x0, y0, x1, y1 = L.S_FUNNEL
    fill(m, (x0, y0, x1, y1), dif=FUNBUFF, ao=AO_BASE - 8, rough=185,
         metal=110)
    m.d.rectangle([x0, y0, x0 + 60, y1], fill=BLACKISH)   # cap end (u=top)
    # masts/crane/trim/dark cells
    fill(m, L.S_MAST, dif=(104, 98, 88), ao=AO_BASE - 10, rough=160,
         metal=160)
    fill(m, L.S_RAIL, dif=(88, 84, 78), ao=AO_BASE - 10, rough=170,
         metal=150)
    r = L.S_TRIM.rect
    fill(m, r, dif=(64, 62, 58), ao=AO_BASE - 15, rough=170, metal=140)
    fill(m, L.S_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)

    # laundry cloths: three sun-faded garments by u range
    zone = L.S_CLOTH
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(150, 146, 136), ao=AO_BASE, rough=235,
         metal=0)
    u, v = PL.zone_fns(zone)
    for (wx0, wx1, col) in ((-1.7, -0.7, (152, 96, 84)),
                            (-0.5, 0.6, (188, 184, 172)),
                            (0.8, 1.6, (96, 112, 128))):
        m.d.rectangle([u(wx0), y0 + 2, u(wx1), y1 - 2], fill=jit(col, 6))


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_hull(m)
    paint_deck(m)
    paint_cargo(m)
    paint_super(m)

    # ── tramp weathering: heavy rust, soot, waterline scum ──
    wx = PL.standard_weather(m, L, ground_rects=(),
                             side_zones=(L.S_SUPER_S,), seed=90210,
                             grime=0.5)
    zone = L.S_HULL_SIDE
    x0, y0, x1, y1 = zone.rect
    u, v = PL.zone_fns(zone)
    for wz in np.arange(-24.0, 26.0, 3.4):       # scupper rust streaks
        wx.rust_streak(u(wz), v(4.0), 46 + (int(wz) % 4) * 12, width=3.4,
                       strength=0.65)
    wx.plate_bottom_rust((x0, y0, x1, int(v(0.6))), n=14, strength=0.6)
    wx.mud_band((x0, int(v(0.85)), x1, int(v(-0.5))), 0.55, fade=None,
                spatter=True)                    # waterline scum
    wx.mud_band(L.S_DECK.rect, 0.3, fade=None, spatter=True)
    fx0, fy0, fx1, fy1 = L.S_FUNNEL
    wx.soot_patch((fx0, fy0, fx0 + (fx1 - fx0) // 3, fy1), 0.8)
    sx0, sy0, sx1, sy1 = L.S_SUPER_S.rect
    for fxr in (0.2, 0.55, 0.85):                # deckhouse rust weeps
        wx.rust_streak(sx0 + (sx1 - sx0) * fxr, sy0 + 30, 60, width=2.6,
                       strength=0.5)

    # ── height hints → normals ──
    from normals import HeightMap
    hm = HeightMap()
    for wy in (2.2, 3.4):
        hm.line((x0 + 2, v(wy)), (x1 - 2, v(wy)), -0.4, width=2)
    dz = L.S_DECK
    du, dvv = PL.zone_fns(dz)
    for wz in np.arange(-26.0, 27.0, 2.4):
        hm.line((du(wz), dz.rect[1] + 2), (du(wz), dz.rect[3] - 2), 0.3,
                width=2)
    PL.finish(m, L, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
