"""paint_ms_river_monitor — 2048² PBR set for ms_river_monitor.

Order-register river scheme: uniform river-grey panels with plated
strakes, black boot-top astride the waterline over oxide anti-foul,
hull number stencil 'M-31' + team-colour hull ID panels both sides of
the bow, tread-lane deck, sloped casemate with uniform bolted plates,
armoured wheelhouse with emissive amber slit windows, soot-stained
stub funnel, turret with mantlet shadow and turret number, riverine
weathering — waterline scum, scupper rust, funnel soot.
"""
from __future__ import annotations
import numpy as np

import ms_river_monitor_layout as L   # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, stencil,
                   shade, jit, BOLT_LOG, YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_DEEP, R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS)

W = 2048
RIVER = (99, 106, 100)          # river-grey/green topsides (Order uniform)
ANTIFOUL = (92, 50, 42)         # oxide red below waterline
BOOT = (26, 28, 31)             # boot-top band
DECKC = (70, 75, 73)            # deck steel
CASEC = (92, 98, 93)            # casemate armour
WARM = (255, 186, 112)


def paint_hull(m):
    zone = L.S_HULL_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=RIVER, ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR)
    u, v = PL.zone_fns(zone)

    # uniform plated strakes + frame verticals (Order: regular spacing)
    for wy in (0.9, 1.5):
        seam_h(m, x0 + 3, x1 - 3, int(v(wy)), RIVER, hi=False)
    for wz in np.arange(-15.0, 17.0, 3.2):
        seam_v(m, int(u(wz)), int(v(2.0)), int(v(0.45)), RIVER, hi=False)
    # boot-top astride the waterline + anti-foul below
    m.d.rectangle([x0, v(L.WATERLINE[1]), x1, v(L.WATERLINE[0])], fill=BOOT)
    m.o.rectangle([x0, v(L.WATERLINE[1]), x1, v(L.WATERLINE[0])],
                  fill=(AO_BASE - 15, 200, 30))
    m.d.rectangle([x0, v(L.WATERLINE[0]), x1, y1], fill=ANTIFOUL)
    m.o.rectangle([x0, v(L.WATERLINE[0]), x1, y1],
                  fill=(AO_BASE - 20, 215, 20))
    # team-colour hull ID panel at the bow (both sides via shared zone)
    PL.team_panel(m, PL.nbox(u(-15.6), v(1.95), u(-12.6), v(0.95)),
                  outline=shade(RIVER, 0.55))
    # hull number stencil aft of the panel
    fh = PL.font(52)
    m.d.text((u(-12.0) + 2, v(1.9) + 2), 'M-31', font=fh,
             fill=shade(RIVER, 0.5))
    m.d.text((u(-12.0), v(1.9)), 'M-31', font=fh, fill=(210, 214, 210))
    # scuppers under the deck edge
    for wz in np.arange(-12.0, 16.0, 4.0):
        m.d.rectangle([u(wz) - 5, int(v(1.5)), u(wz) + 5, int(v(1.35))],
                      fill=(38, 40, 42))
    # draft marks at bow + stern
    fdm = PL.font(12)
    for wz in (-13.8, 16.2):
        for i, wy in enumerate((-0.9, -0.4, 0.1)):
            m.d.text((u(wz), v(wy) - 6), f'{i + 1}', font=fdm,
                     fill=(206, 210, 208))
    wear_edges(m, (x0, int(v(2.05)), x1, int(v(0.45))), RIVER, 50)

    # belly: anti-foul flat
    r = L.S_BELLY.rect
    fill(m, r, dif=shade(ANTIFOUL, 0.92), ao=AO_BASE - 25, rough=220,
         metal=15)
    for fx in (0.3, 0.6):
        seam_v(m, int(r[0] + (r[2] - r[0]) * fx), r[1] + 3, r[3] - 3,
               ANTIFOUL, hi=False)


def paint_deck(m):
    zone = L.S_DECK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=DECKC, ao=AO_BASE - 10, rough=200, metal=95)
    u, v = PL.zone_fns(zone)
    for wz in np.arange(-16.0, 17.0, 1.4):          # transverse tread strips
        m.d.line([(u(wz), y0 + 2), (u(wz), y1 - 2)],
                 fill=shade(DECKC, 0.87), width=2)
    for wx in (-2.9, 2.9):                          # walkway edge lines
        m.d.line([(x0 + 2, v(wx)), (x1 - 2, v(wx))],
                 fill=shade(DECKC, 0.72), width=3)
    # safety yellow at the casemate base corners
    for wz in (L.CASE_Z0, L.CASE_Z1):
        m.d.rectangle([u(wz) - 4, v(-3.1), u(wz) + 4, v(3.1)],
                      fill=jit(YELLOW, 8))
    wear_edges(m, (x0, y0, x1, y1), DECKC, 70)


def paint_casemate(m):
    # sloped sides: uniform bolted plates, freeing ports along the base
    zone = L.S_CASE_S
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=CASEC, ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR)
    u, v = PL.zone_fns(zone)
    for wz in np.arange(-7.5, 9.0, 2.6):
        seam_v(m, int(u(wz)), y0 + 3, y1 - 3, CASEC, hi=False)
        bolts(m, [(u(wz) + 8, v(3.0)), (u(wz) + 8, v(2.0))], base=CASEC)
    seam_h(m, x0 + 3, x1 - 3, int(v(2.35)), CASEC, hi=False)
    # turret number amidships
    ft = PL.font(40)
    m.d.text((u(-1.0) + 2, v(3.1) + 2), '31', font=ft, fill=shade(CASEC, 0.5))
    m.d.text((u(-1.0), v(3.1)), '31', font=ft, fill=(208, 212, 208))
    wear_edges(m, (x0, y0, x1, y1), CASEC, 45)

    # roof: plating + walk lanes
    zone = L.S_CASE_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CASEC, 0.94), ao=AO_BASE - 8,
         rough=195, metal=100)
    u, v = PL.zone_fns(zone)
    for wz in np.arange(-6.0, 8.0, 2.6):
        seam_v(m, int(u(wz)), y0 + 2, y1 - 2, CASEC, hi=False)
    for wx in (-1.8, 1.8):
        m.d.line([(x0 + 2, v(wx)), (x1 - 2, v(wx))],
                 fill=shade(CASEC, 0.8), width=2)
    wear_edges(m, (x0, y0, x1, y1), CASEC, 40)

    # ends: plate + bolts
    zone = L.S_CASE_END
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=CASEC, ao=AO_BASE - 8, rough=R_ARMOR,
         metal=M_ARMOR)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, CASEC, hi=False)
    bolts(m, [(x0 + 18, y0 + 16), (x1 - 18, y0 + 16),
              (x0 + 18, y1 - 16), (x1 - 18, y1 - 16)], base=CASEC)
    wear_edges(m, (x0, y0, x1, y1), CASEC, 40)


def paint_wheelhouse(m):
    # sides + front: armour with EMISSIVE SLIT WINDOWS (narrow, amber)
    for zone, nslits in ((L.S_WH_S, 4), (L.S_WH_F, 3)):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=shade(CASEC, 1.04), ao=AO_BASE - 4,
             rough=R_ARMOR, metal=M_ARMOR)
        # slit strip at WH_SLIT_Y
        sv = zone.uv((0, L.WH_SLIT_Y, 0))[1] * W
        span = x1 - x0
        for i in range(nslits):
            sx0 = x0 + span * (0.14 + 0.72 * i / nslits) + 6
            sx1 = x0 + span * (0.14 + 0.72 * (i + 0.6) / nslits)
            m.d.rectangle([sx0, sv - 5, sx1, sv + 5], fill=(30, 32, 34))
            m.o.rectangle([sx0, sv - 5, sx1, sv + 5],
                          fill=(AO_BASE, R_GLASS, M_GLASS))
            m.e.rectangle([sx0 + 1, sv - 3, sx1 - 1, sv + 3], fill=WARM)
        seam_h(m, x0 + 3, x1 - 3, int(y0 + (y1 - y0) * 0.72), CASEC,
               hi=False)
        bolts(m, [(x0 + 12, y1 - 14), (x1 - 12, y1 - 14)], base=CASEC)
        wear_edges(m, (x0, y0, x1, y1), CASEC, 35)
    # door on the side zone (aft end)
    x0, y0, x1, y1 = L.S_WH_S.rect
    m.d.rectangle([x1 - 52, y1 - 78, x1 - 22, y1 - 10], fill=(48, 52, 50),
                  outline=shade(CASEC, 0.6), width=2)

    # roof
    zone = L.S_WH_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(DECKC, 1.02), ao=AO_BASE - 6,
         rough=195, metal=90)
    m.d.rectangle([(x0 + x1) / 2 - 16, (y0 + y1) / 2 - 16,
                   (x0 + x1) / 2 + 16, (y0 + y1) / 2 + 16], fill=(50, 54, 52))
    bolts(m, [(x0 + 12, y0 + 12), (x1 - 12, y0 + 12), (x0 + 12, y1 - 12),
              (x1 - 12, y1 - 12)], base=DECKC)


def paint_turret(m):
    for zone in (L.S_TUR_S, L.S_TUR_F):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=shade(CASEC, 0.98), ao=AO_BASE - 6,
             rough=R_ARMOR, metal=M_ARMOR)
        seam_h(m, x0 + 3, x1 - 3, int(y0 + (y1 - y0) * 0.45), CASEC,
               hi=False)
        wear_edges(m, (x0, y0, x1, y1), CASEC, 55)
    # turret number on the sides
    x0, y0, x1, y1 = L.S_TUR_S.rect
    ft = PL.font(44)
    m.d.text(((x0 + x1) / 2 - 20 + 2, y0 + 30 + 2), '31', font=ft,
             fill=shade(CASEC, 0.5))
    m.d.text(((x0 + x1) / 2 - 20, y0 + 30), '31', font=ft,
             fill=(208, 212, 208))
    bolts(m, [(x0 + 16 + i * 34, y1 - 14) for i in range(8)], base=CASEC)
    # roof
    zone = L.S_TUR_T
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CASEC, 0.92), ao=AO_BASE - 8,
         rough=200, metal=95)
    m.d.rectangle([(x0 + x1) * 0.62 - 14, (y0 + y1) / 2 - 40,
                   (x0 + x1) * 0.62 + 14, (y0 + y1) / 2 - 12],
                  fill=(50, 54, 52))
    wear_edges(m, (x0, y0, x1, y1), CASEC, 45)

    # barrels: gunmetal wrap, dark muzzle third
    x0, y0, x1, y1 = L.S_BARREL
    fill(m, (x0, y0, x1, y1), dif=(58, 61, 64), ao=AO_BASE - 10, rough=150,
         metal=190)
    m.d.rectangle([x0, y0, x1, y0 + (y1 - y0) // 5], fill=BLACKISH)


def paint_fittings(m):
    # funnel: river-grey wrap with soot mouth + Order band
    x0, y0, x1, y1 = L.S_FUNNEL
    fill(m, (x0, y0, x1, y1), dif=(72, 76, 74), ao=AO_BASE - 8, rough=175,
         metal=150)
    m.d.rectangle([x0, y0, x0 + 30, y1], fill=BLACKISH)   # cap end (u=top)
    m.d.rectangle([x0 + 44, y0, x0 + 66, y1], fill=(180, 184, 180))
    # mast/bollard steel
    fill(m, L.S_MAST, dif=(94, 98, 96), ao=AO_BASE - 10, rough=150, metal=170)
    # trims + dark
    fill(m, L.S_TRIM.rect, dif=(52, 55, 54), ao=AO_BASE - 15, rough=165,
         metal=150)
    fill(m, L.S_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)
    # hatch coamings
    r = L.S_HATCH.rect
    fill(m, r, dif=(60, 64, 62), ao=AO_BASE - 10, rough=185, metal=110)
    m.d.rectangle([r[0] + 14, r[1] + 14, r[2] - 14, r[3] - 14],
                  fill=shade((60, 64, 62), 0.82))
    PL.hazard_band(m, (r[0], r[3] - 12, r[2], r[3]))
    # life-raft canisters
    x0, y0, x1, y1 = L.S_RAFT
    fill(m, (x0, y0, x1, y1), dif=(224, 220, 210), ao=AO_BASE - 4, rough=200,
         metal=20)
    for fx in (0.2, 0.8):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 7, y0, sx + 7, y1], fill=(206, 104, 38))
    # radar bar
    zone = L.S_RADAR
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(136, 140, 138), ao=AO_BASE - 5, rough=150,
         metal=130)
    for i in range(8):
        sx = x0 + (x1 - x0) * i / 8
        m.d.rectangle([sx, y0 + 8, sx + (x1 - x0) / 16, y1 - 8],
                      fill=(106, 110, 108))
    m.e.ellipse([(x0 + x1) / 2 - 4, y0 + 4, (x0 + x1) / 2 + 4, y0 + 12],
                fill=(255, 70, 46))

    # bow + stern caps
    for zone in (L.S_BOW, L.S_STERN):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=RIVER, ao=AO_BASE - 8, rough=R_ARMOR,
             metal=M_ARMOR)
        wl0 = zone.uv((0, L.WATERLINE[0], 0))[1] * W
        wl1 = zone.uv((0, L.WATERLINE[1], 0))[1] * W
        m.d.rectangle([x0, wl1, x1, wl0], fill=BOOT)
        m.d.rectangle([x0, wl0, x1, y1], fill=ANTIFOUL)
        wear_edges(m, (x0, y0, x1, y1), RIVER, 40)
    # stern name stencil
    x0, y0, x1, y1 = L.S_STERN.rect
    f = PL.font(26)
    tw = m.d.textlength('M-31', font=f)
    m.d.text(((x0 + x1) / 2 - tw / 2, y0 + 22), 'M-31', font=f,
             fill=(206, 210, 208))


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_hull(m)
    paint_deck(m)
    paint_casemate(m)
    paint_wheelhouse(m)
    paint_turret(m)
    paint_fittings(m)

    # ── riverine weathering ──
    wx = PL.standard_weather(m, L, ground_rects=(), side_zones=(),
                             seed=90210, grime=0.45)
    zone = L.S_HULL_SIDE
    u, v = PL.zone_fns(zone)
    x0, y0, x1, y1 = zone.rect
    for wz in np.arange(-12.0, 16.0, 4.0):      # scupper rust streaks
        wx.rust_streak(u(wz), v(1.45), 30 + (int(wz) % 3) * 10, width=3.0,
                       strength=0.5)
    wx.plate_bottom_rust((x0, int(v(2.05)), x1, int(v(0.4))), n=8,
                         strength=0.45)
    # waterline scum band (river tannin line)
    wx.mud_band((x0, int(v(0.55)), x1, int(v(-0.35))), 0.65, fade=None,
                spatter=True)
    wx.mud_band(L.S_CASE_S.rect, 0.25, fade='down', spatter=False)
    wx.mud_band(L.S_DECK.rect, 0.3, fade=None, spatter=True)
    sx0, sy0, sx1, sy1 = L.S_FUNNEL
    wx.soot_patch((sx0, sy0, sx0 + (sx1 - sx0) // 3, sy1), 0.8)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    for wy in (0.9, 1.5):
        hm.line((x0 + 2, v(wy)), (x1 - 2, v(wy)), -0.4, width=2)
    for wz in np.arange(-15.0, 17.0, 3.2):
        hm.line((u(wz), v(2.0)), (u(wz), v(0.45)), 0.3, width=2)
    zd = L.S_DECK
    ud, vd = PL.zone_fns(zd)
    for wz in np.arange(-16.0, 17.0, 1.4):
        hm.line((ud(wz), zd.rect[1] + 2), (ud(wz), zd.rect[3] - 2), 0.3,
                width=2)

    PL.finish(m, L, 'ms_river_monitor', hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
