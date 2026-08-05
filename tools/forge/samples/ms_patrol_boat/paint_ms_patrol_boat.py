"""paint_ms_patrol_boat — 2048 PBR set for ms_patrol_boat (PB Vigil).

Order-register patrol scheme: crisp haze-grey topsides over black
boot-top and oxide anti-foul, numbered bow (P-17), team-colour hull
flash forward and wheelhouse roof panel (team mask only), lit
wheelhouse window band, nav beacon emissive, tread-lane deck, drum
and crate stowage aft, light disciplined weathering (this is the
tidy faction — restrained rust, waterline scum, stack-free).
"""
from __future__ import annotations
import numpy as np

import ms_patrol_boat_layout as L   # sets meshlib.ATLAS = 2048
import paint as Pnt
Pnt.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, jit, shade,
                   BOLT_LOG, YELLOW, BLACKISH, AO_BASE, AO_DEEP,
                   R_ARMOR, M_ARMOR)
import paintlib as PL

W = 2048
HAZE = (112, 118, 125)          # topside grey (crisp Order finish)
ANTIFOUL = (96, 52, 44)         # oxide red below the waterline
BOOT = (26, 28, 31)             # boot-top band
DECKC = (78, 83, 89)            # deck steel
WHC = (120, 126, 133)           # wheelhouse
DRUMC = (74, 96, 74)            # od-green drums
CRATEC = (104, 96, 78)          # canvas/timber crates
TARPC = (86, 92, 84)            # lashed tarp


def paint_hull(m):
    zone = L.S_HULL_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=HAZE, ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR)
    u, v = PL.zone_fns(zone)

    # plated strakes + frame seams (tone-on-tone, crisp)
    for wy in (0.6, 1.1):
        seam_h(m, x0 + 3, x1 - 3, int(v(wy)), HAZE, hi=False)
    for wz in np.arange(-8.5, 10.0, 2.6):
        seam_v(m, int(u(wz)), int(v(1.65)), int(v(0.4)), HAZE, hi=False)
    # boot-top + anti-foul
    m.d.rectangle([x0, v(L.WATERLINE[1]), x1, v(L.WATERLINE[0])], fill=BOOT)
    m.o.rectangle([x0, v(L.WATERLINE[1]), x1, v(L.WATERLINE[0])],
                  fill=(AO_BASE - 15, 200, 30))
    m.d.rectangle([x0, v(L.WATERLINE[0]), x1, y1], fill=ANTIFOUL)
    m.o.rectangle([x0, v(L.WATERLINE[0]), x1, y1],
                  fill=(AO_BASE - 20, 215, 20))
    # bow team flash (raked parallelogram, mirror-safe)
    fu0, fu1 = u(-9.2), u(-6.8)
    m.t.polygon([(fu0, v(1.62)), (fu1, v(1.62)), (fu1 - 16, v(0.55)),
                 (fu0 - 16, v(0.55))], fill=(255, 0, 0))
    m.d.polygon([(fu0, v(1.62)), (fu1, v(1.62)), (fu1 - 16, v(0.55)),
                 (fu0 - 16, v(0.55))], fill=Pnt.TEAMGREY)
    # hull number
    fh = PL.font(52)
    m.d.text((u(-6.2) + 2, v(1.35) + 2), 'P-17', font=fh,
             fill=shade(HAZE, 0.5))
    m.d.text((u(-6.2), v(1.35)), 'P-17', font=fh, fill=(214, 218, 222))
    # rub strake shadow along the sheer
    m.d.rectangle([x0, v(1.30), x1, v(1.22)], fill=shade(HAZE, 0.8))
    wear_edges(m, (x0, int(v(1.72)), x1, int(v(0.4))), HAZE, 35)

    # belly: anti-foul
    r = L.S_BELLY.rect
    fill(m, r, dif=shade(ANTIFOUL, 0.92), ao=AO_BASE - 25, rough=220,
         metal=15)
    for fx in (0.33, 0.66):
        seam_v(m, int(r[0] + (r[2] - r[0]) * fx), r[1] + 3, r[3] - 3,
               ANTIFOUL, hi=False)


def paint_deck(m):
    zone = L.S_DECK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=DECKC, ao=AO_BASE - 10, rough=200,
         metal=95)
    u, v = PL.zone_fns(zone)
    for wz in np.arange(-9.0, 10.0, 1.1):        # transverse tread strips
        m.d.line([(u(wz), y0 + 2), (u(wz), y1 - 2)],
                 fill=shade(DECKC, 0.88), width=2)
    for wx in (-1.9, 1.9):                        # side walk lanes
        m.d.line([(x0 + 2, v(wx)), (x1 - 2, v(wx))],
                 fill=shade(DECKC, 0.75), width=3)
    # safety edging at the gun ring + rack area
    m.d.rectangle([u(-7.0), v(-1.3), u(-4.2), v(-1.15)], fill=jit(YELLOW, 6))
    m.d.rectangle([u(-7.0), v(1.15), u(-4.2), v(1.3)], fill=jit(YELLOW, 6))
    wear_edges(m, (x0, y0, x1, y1), DECKC, 55)

    # transom: name + docking light
    zone = L.S_STERN
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=HAZE, ao=AO_BASE - 8)
    u, v = PL.zone_fns(zone)
    m.d.rectangle(PL.nbox(x0, v(L.WATERLINE[1]), x1, v(L.WATERLINE[0])),
                  fill=BOOT)
    m.d.rectangle(PL.nbox(x0, v(L.WATERLINE[0]), x1, y1), fill=ANTIFOUL)
    f = PL.font(34)
    tw = m.d.textlength('VIGIL', font=f)
    m.d.text(((x0 + x1) / 2 - tw / 2 + 2, y0 + 40 + 2), 'VIGIL', font=f,
             fill=shade(HAZE, 0.5))
    m.d.text(((x0 + x1) / 2 - tw / 2, y0 + 40), 'VIGIL', font=f,
             fill=(214, 218, 222))
    m.e.ellipse([(x0 + x1) / 2 - 5, y0 + 10, (x0 + x1) / 2 + 5, y0 + 20],
                fill=(235, 240, 245))
    bolts(m, [(x0 + 16, y0 + 16), (x1 - 16, y0 + 16)], base=HAZE)


def paint_wheelhouse(m):
    # sides: window band + door
    zone = L.S_WH_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=WHC, ao=AO_BASE - 4)
    u, v = PL.zone_fns(zone)
    wy0, wy1 = v(2.95), v(2.45)
    PL.glass_rect(m, (x0 + 10, min(wy0, wy1), x1 - 10, max(wy0, wy1)),
                  outline=WHC)
    for i in range(1, 4):
        gx = x0 + 10 + (x1 - x0 - 20) * i / 4
        m.d.rectangle([gx - 2, min(wy0, wy1), gx + 2, max(wy0, wy1)],
                      fill=shade(WHC, 0.7))
    m.e.rectangle([x0 + 14, min(wy0, wy1) + 3, x1 - 14, max(wy0, wy1) - 3],
                  fill=(150, 110, 60))
    # door aft
    du = u(1.55)
    m.d.rectangle(PL.nbox(du - 18, v(1.25), du + 18, v(2.35)),
                  fill=(56, 60, 66),
                  outline=shade(WHC, 0.6), width=2)
    wear_edges(m, (x0, y0, x1, y1), WHC, 25)

    # front/back: windscreen band forward
    zone = L.S_WH_FRONT
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=WHC, ao=AO_BASE - 4)
    u, v = PL.zone_fns(zone)
    wy0, wy1 = v(2.98), v(2.42)
    PL.glass_rect(m, (x0 + 12, min(wy0, wy1), x1 - 12, max(wy0, wy1)),
                  outline=WHC)
    m.e.rectangle([x0 + 16, min(wy0, wy1) + 3, x1 - 16, max(wy0, wy1) - 3],
                  fill=(150, 110, 60))
    for i in range(1, 3):
        gx = x0 + 12 + (x1 - x0 - 24) * i / 3
        m.d.rectangle([gx - 2, min(wy0, wy1), gx + 2, max(wy0, wy1)],
                      fill=shade(WHC, 0.7))
    wear_edges(m, (x0, y0, x1, y1), WHC, 25)

    # roof: team panel + walk lanes
    zone = L.S_WH_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(WHC, 0.94), ao=AO_BASE - 8,
         rough=195, metal=90)
    cxm, cym = (x0 + x1) / 2, (y0 + y1) / 2
    PL.team_panel(m, (cxm - 90, cym - 70, cxm + 90, cym + 70), outline=WHC)
    bolts(m, [(x0 + 14, y0 + 14), (x1 - 14, y0 + 14), (x0 + 14, y1 - 14),
              (x1 - 14, y1 - 14)], base=WHC)


def paint_fittings(m):
    # gun ring platform + turret
    r = L.S_RING.rect
    fill(m, r, dif=(70, 74, 80), ao=AO_BASE - 10, rough=185, metal=120)
    m.d.ellipse([r[0] + 8, r[1] + 8, r[2] - 8, r[3] - 8],
                outline=jit(YELLOW, 6), width=4)
    r = L.S_TURRET.rect
    fill(m, r, dif=(88, 93, 100), ao=AO_BASE - 8, rough=175, metal=140)
    seam_h(m, r[0] + 4, r[2] - 4, (r[1] + r[3]) // 2, (88, 93, 100),
           hi=False)
    bolts(m, [(r[0] + 20, r[1] + 20), (r[2] - 20, r[1] + 20)],
          base=(88, 93, 100))
    # barrel + mast + rails wraps
    fill(m, L.S_BARREL, dif=(48, 50, 54), ao=AO_BASE - 12, rough=150,
         metal=180)
    fill(m, L.S_MAST, dif=(96, 100, 106), ao=AO_BASE - 10, rough=150,
         metal=170)
    fill(m, L.S_RAIL, dif=(104, 108, 114), ao=AO_BASE - 8, rough=160,
         metal=150)
    # trim (nav box etc.)
    fill(m, L.S_TRIM.rect, dif=(58, 62, 68), ao=AO_BASE - 12, rough=165,
         metal=150)
    fill(m, L.S_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)
    # nav beacon: amber glow
    r = L.S_LIGHT.rect
    fill(m, r, dif=(60, 52, 40), ao=AO_BASE - 8, rough=130, metal=120)
    m.e.rectangle([r[0] + 12, r[1] + 12, r[2] - 12, r[3] - 12],
                  fill=(255, 176, 80))
    # flag cloth: team-coloured pennant
    r = L.S_FLAG.rect
    fill(m, r, dif=Pnt.TEAMGREY, ao=AO_BASE - 4, rough=225, metal=10)
    m.t.rectangle(r, fill=(255, 0, 0))
    m.d.rectangle([r[0], r[1], r[0] + 14, r[3]], fill=(210, 214, 218))
    # rack stowage: crates + tarp, drums
    r = L.S_RACK.rect
    fill(m, r, dif=CRATEC, ao=AO_BASE - 10, rough=215, metal=25)
    m.d.rectangle([r[0], r[1] + (r[3] - r[1]) // 2, r[2], r[3]], fill=TARPC)
    for fx in (0.25, 0.5, 0.75):
        sx = int(r[0] + (r[2] - r[0]) * fx)
        m.d.line([(sx, r[1] + 4), (sx, r[3] - 4)], fill=shade(CRATEC, 0.75),
                 width=3)
    r = L.S_DRUM.rect
    fill(m, r, dif=DRUMC, ao=AO_BASE - 10, rough=190, metal=60)
    m.d.rectangle([r[0], r[1] + 20, r[2], r[1] + 34],
                  fill=shade(DRUMC, 0.78))
    m.d.rectangle([r[0], r[3] - 34, r[2], r[3] - 20],
                  fill=shade(DRUMC, 0.78))


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_hull(m)
    paint_deck(m)
    paint_wheelhouse(m)
    paint_fittings(m)

    # disciplined weathering: waterline scum, light scupper rust, deck wear
    wx = PL.standard_weather(m, L, ground_rects=(),
                             side_zones=(L.S_HULL_SIDE,), seed=90210,
                             mud=0.3, grime=0.4, rust_fraction=0.35)
    zone = L.S_HULL_SIDE
    u, v = PL.zone_fns(zone)
    x0, y0, x1, y1 = zone.rect
    for wz in np.arange(-7.0, 10.0, 4.5):
        wx.rust_streak(u(wz), v(1.55), 26, width=2.5, strength=0.35)
    wx.mud_band((x0, int(v(0.5)), x1, int(v(-0.4))), 0.45, fade=None,
                spatter=True)                     # waterline scum
    wx.mud_band(L.S_DECK.rect, 0.22, fade=None, spatter=False)

    # normals: hull seams + deck treads proud
    from normals import HeightMap
    hm = HeightMap()
    for wy in (0.6, 1.1):
        hm.line((x0 + 2, v(wy)), (x1 - 2, v(wy)), -0.4, width=2)
    for wz in np.arange(-8.5, 10.0, 2.6):
        hm.line((u(wz), v(1.65)), (u(wz), v(0.4)), 0.3, width=2)
    ud, vd = PL.zone_fns(L.S_DECK)
    dr = L.S_DECK.rect
    for wz in np.arange(-9.0, 10.0, 1.1):
        hm.line((ud(wz), dr[1] + 2), (ud(wz), dr[3] - 2), 0.3, width=2)

    PL.finish(m, L, 'ms_patrol_boat', hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
