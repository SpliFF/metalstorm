"""paint_ms_ships_s2 — 2048² PBR set for ms_ships_s2 (Destroyer, 35 m).

Order register, seagoing scheme: uniform haze-grey topsides over plated
strakes and frame lines, black boot-top astride the waterline (Y=0) over
oxide anti-foul, hull number stencil 'D-214' on both bows with draft
marks and anchor-chain runs, chipped paint on the fo'c'sle, tread-plate
deck, stacked sloped-armour casemate with bolted splinter plates,
armoured wheelhouse with emissive amber slit windows, and a heavily
soot-stained RAKED FUNNEL with a dark cap grille and an Order band —
plus the soot fan that trails aft of it across the casemate roof and
quarterdeck. Team colour only on two small hull ID panels.
"""
from __future__ import annotations
import numpy as np

import ms_ships_s2_layout as L        # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges,
                   shade, jit, BOLT_LOG, YELLOW, BLACKISH,
                   AO_BASE, AO_DEEP, R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS)

W = 2048
HAZE = (143, 149, 155)         # Order haze-grey topsides
CASEC = (152, 158, 163)        # casemate armour (one step lighter)
DECKC = (100, 105, 109)           # deck steel
ANTIFOUL = (99, 53, 45)        # oxide red below the waterline
BOOT = (28, 30, 34)            # boot-top band
STENCIL = (214, 218, 220)
WARM = (255, 186, 112)
TEAMBASE = (120, 124, 128)     # hull-matched base for team panels
HULLNO = 'D-214'


# ── hull ────────────────────────────────────────────────────────────────

def paint_hull(m):
    zone = L.S_HULL_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=HAZE, ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR)
    u, v = PL.zone_fns(zone)

    # uniform strake seams + frame verticals (Order = regular spacing)
    for wy in (-1.1, 0.75, 1.85):
        seam_h(m, x0 + 3, x1 - 3, int(v(wy)), HAZE, hi=False)
    for wz in np.arange(-16.0, 17.5, 2.9):
        seam_v(m, int(u(wz)), int(v(4.3)), int(v(-2.2)), HAZE, hi=False)

    # sheer line: the fo'c'sle deck edge, and the break at z = -6
    m.d.line([(u(-17.4), v(4.30)), (u(-6.1), v(3.30))],
             fill=shade(HAZE, 0.68), width=3)
    m.d.line([(u(-6.05), v(3.30)), (u(-6.05), v(2.55))],
             fill=shade(HAZE, 0.62), width=3)
    m.d.line([(u(-6.0), v(2.55)), (u(17.4), v(2.80))],
             fill=shade(HAZE, 0.68), width=3)
    # knuckle line
    m.d.line([(u(-16.0), v(0.95)), (u(17.4), v(0.72))],
             fill=shade(HAZE, 0.74), width=2)

    # boot-top astride Y=0, anti-foul below
    m.d.rectangle([x0, v(L.WATERLINE[1]), x1, v(L.WATERLINE[0])], fill=BOOT)
    m.o.rectangle([x0, v(L.WATERLINE[1]), x1, v(L.WATERLINE[0])],
                  fill=(AO_BASE - 15, 200, 30))
    m.d.rectangle([x0, v(L.WATERLINE[0]), x1, y1], fill=ANTIFOUL)
    m.o.rectangle([x0, v(L.WATERLINE[0]), x1, y1],
                  fill=(AO_BASE - 20, 215, 20))

    # hull number stencil on the bow + small team ID panel abaft it
    fh = PL.font(78)
    m.d.text((u(-15.4) + 3, v(2.9) + 3), HULLNO, font=fh,
             fill=shade(HAZE, 0.5))
    m.d.text((u(-15.4), v(2.9)), HULLNO, font=fh, fill=STENCIL)
    PL.team_panel(m, PL.nbox(u(-9.4), v(2.05), u(-7.7), v(1.15)),
                  outline=shade(HAZE, 0.55), base=TEAMBASE)
    PL.team_panel(m, PL.nbox(u(12.0), v(2.05), u(13.7), v(1.15)),
                  outline=shade(HAZE, 0.55), base=TEAMBASE)
    # pennant repeat aft
    fa = PL.font(42)
    m.d.text((u(9.0), v(2.20)), HULLNO, font=fa, fill=shade(HAZE, 1.25))

    # scuppers + freeing ports along the deck edge (rust anchors)
    for wz in np.arange(-14.0, 17.0, 2.9):
        edge = 3.25 if wz > -6.0 else 3.95
        m.d.rectangle([u(wz) - 6, int(v(edge - 0.28)), u(wz) + 6,
                       int(v(edge - 0.46))], fill=(40, 42, 45))

    # anchor-chain runs from the hawse down the bow
    for (wz, wy) in ((-16.4, 3.55), (-15.9, 3.35)):
        m.d.ellipse([u(wz) - 11, v(wy) - 11, u(wz) + 11, v(wy) + 11],
                    fill=(34, 36, 39))
        for i in range(14):
            cy = v(wy) + 6 + i * 7
            m.d.rectangle([u(wz) - 4, cy, u(wz) + 4, cy + 4],
                          fill=(74, 62, 52))

    # draft marks at bow and stern
    fdm = PL.font(15)
    for wz in (-14.6, 15.6):
        for i, wy in enumerate((-1.6, -1.0, -0.4)):
            m.d.text((u(wz), v(wy) - 8), f'{i + 2}', font=fdm, fill=STENCIL)

    wear_edges(m, (x0, int(v(4.35)), x1, int(v(0.5))), HAZE, 60)

    # belly: anti-foul with keel/bilge-keel lines
    r = L.S_BELLY.rect
    fill(m, r, dif=shade(ANTIFOUL, 0.92), ao=AO_BASE - 25, rough=220,
         metal=15)
    for fx in (0.34, 0.5, 0.66):
        seam_v(m, int(r[0] + (r[2] - r[0]) * fx), r[1] + 3, r[3] - 3,
               ANTIFOUL, hi=False)


def paint_deck(m):
    zone = L.S_DECK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=DECKC, ao=AO_BASE - 10, rough=200, metal=95)
    u, v = PL.zone_fns(zone)
    for wz in np.arange(-17.0, 17.5, 1.35):        # transverse tread strips
        m.d.line([(u(wz), y0 + 2), (u(wz), y1 - 2)],
                 fill=shade(DECKC, 0.88), width=2)
    for wx in (-2.85, 2.85):                       # walkway edge lines
        m.d.line([(x0 + 2, v(wx)), (x1 - 2, v(wx))],
                 fill=shade(DECKC, 0.74), width=3)
    # fo'c'sle break + casemate footprint outlines
    for wz in (L.C1_Z0, L.C1_Z1, -6.05):
        m.d.rectangle([u(wz) - 3, v(-3.3), u(wz) + 3, v(3.3)],
                      fill=shade(DECKC, 0.66))
    # cable/chain lockers + capstan discs forward, hatch ring aft
    for wz in (-15.3, -12.9):
        for wx in (-1.0, 1.0):
            m.d.ellipse([u(wz) - 16, v(wx) - 16, u(wz) + 16, v(wx) + 16],
                        fill=shade(DECKC, 1.14))
    # depth-charge rail lanes on the quarterdeck
    for wx in (-1.35, 1.35):
        m.d.rectangle([u(12.4), v(wx) - 9, u(17.0), v(wx) + 9],
                      fill=shade(DECKC, 0.8))
    wear_edges(m, (x0, y0, x1, y1), DECKC, 80)


# ── casemate ────────────────────────────────────────────────────────────

def paint_casemate(m):
    zone = L.S_CASE_S
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=CASEC, ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR)
    u, v = PL.zone_fns(zone)
    # armour plate joints, uniformly spaced (Order)
    for wz in np.arange(-4.4, 7.4, 2.1):
        seam_v(m, int(u(wz)), int(v(5.85)), int(v(2.6)), CASEC, hi=False)
        bolts(m, [(u(wz) + 10, v(5.4)), (u(wz) + 10, v(4.6)),
                  (u(wz) + 10, v(3.4))], base=CASEC)
    seam_h(m, int(u(-5.0)), int(u(7.0)), int(v(4.42)), CASEC, hi=False)
    # access hatch + door on the tier-1 flank
    m.d.rectangle([u(-0.3), v(4.15), u(0.6), v(2.75)], fill=shade(CASEC, 0.6),
                  outline=shade(CASEC, 0.42), width=3)
    m.d.rectangle([u(3.4), v(4.10), u(4.1), v(2.85)], fill=shade(CASEC, 0.66),
                  outline=shade(CASEC, 0.45), width=2)
    # pennant number repeated on the casemate
    ft = PL.font(46)
    m.d.text((u(1.1) + 2, v(5.55) + 2), '214', font=ft, fill=shade(CASEC, 0.5))
    m.d.text((u(1.1), v(5.55)), '214', font=ft, fill=STENCIL)
    # barbette ring band (z ≈ -11) + bandstand (z ≈ 7.8) share this zone
    m.d.rectangle([u(-12.6), v(3.44), u(-9.4), v(3.30)],
                  fill=shade(CASEC, 0.72))
    wear_edges(m, (x0, y0, x1, y1), CASEC, 50)

    # roof (tier-1 walkway + tier-2 roof)
    zone = L.S_CASE_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CASEC, 0.9), ao=AO_BASE - 8,
         rough=195, metal=100)
    u, v = PL.zone_fns(zone)
    for wz in np.arange(-4.0, 7.0, 2.1):
        seam_v(m, int(u(wz)), y0 + 2, y1 - 2, CASEC, hi=False)
    for wx in (-2.35, 2.35):
        m.d.line([(x0 + 2, v(wx)), (x1 - 2, v(wx))],
                 fill=shade(CASEC, 0.78), width=2)
    # funnel base collar footprint + ready-use locker outlines
    m.d.ellipse([u(1.3), v(-1.1), u(3.4), v(1.1)], fill=shade(CASEC, 0.66))
    wear_edges(m, (x0, y0, x1, y1), CASEC, 45)

    # ends
    zone = L.S_CASE_END
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=CASEC, ao=AO_BASE - 8, rough=R_ARMOR,
         metal=M_ARMOR)
    u, v = PL.zone_fns(zone)
    seam_h(m, x0 + 3, x1 - 3, int(v(4.42)), CASEC, hi=False)
    m.d.rectangle([u(-0.45), v(4.15), u(0.45), v(2.72)],
                  fill=shade(CASEC, 0.6), outline=shade(CASEC, 0.42), width=3)
    bolts(m, [(x0 + 20, y0 + 18), (x1 - 20, y0 + 18),
              (x0 + 20, y1 - 18), (x1 - 20, y1 - 18)], base=CASEC)
    wear_edges(m, (x0, y0, x1, y1), CASEC, 45)


# ── wheelhouse ──────────────────────────────────────────────────────────

def paint_wheelhouse(m):
    for zone, nslits in ((L.S_WH_S, 4), (L.S_WH_F, 3)):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=shade(CASEC, 1.05), ao=AO_BASE - 4,
             rough=R_ARMOR, metal=M_ARMOR)
        u, v = PL.zone_fns(zone)
        sv = v(L.WH_SLIT_Y)
        span = x1 - x0
        for i in range(nslits):
            sx0 = x0 + span * (0.13 + 0.74 * i / nslits) + 7
            sx1 = x0 + span * (0.13 + 0.74 * (i + 0.62) / nslits)
            m.d.rectangle([sx0, sv - 6, sx1, sv + 6], fill=(30, 32, 34))
            m.o.rectangle([sx0, sv - 6, sx1, sv + 6],
                          fill=(AO_BASE, R_GLASS, M_GLASS))
            m.e.rectangle([sx0 + 2, sv - 3, sx1 - 2, sv + 3], fill=WARM)
        seam_h(m, x0 + 3, x1 - 3, int(v(6.15)), CASEC, hi=False)
        bolts(m, [(x0 + 14, y1 - 16), (x1 - 14, y1 - 16),
                  (x0 + 14, y0 + 16), (x1 - 14, y0 + 16)], base=CASEC)
        wear_edges(m, (x0, y0, x1, y1), CASEC, 38)
    # armoured door on the aft face of the side strip
    x0, y0, x1, y1 = L.S_WH_S.rect
    u, v = PL.zone_fns(L.S_WH_S)
    m.d.rectangle([u(-0.30), v(7.05), u(0.25), v(5.95)], fill=(52, 56, 54),
                  outline=shade(CASEC, 0.58), width=2)

    zone = L.S_WH_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(DECKC, 1.06), ao=AO_BASE - 6,
         rough=195, metal=90)
    u, v = PL.zone_fns(zone)
    m.d.rectangle([u(-0.55), v(-1.1), u(0.55), v(0.0)], fill=(52, 56, 54))
    for wx in (-2.3, 2.3):     # bridge-wing gratings
        m.d.rectangle([u(wx) - 22, v(-2.8), u(wx) + 22, v(-1.0)],
                      fill=shade(DECKC, 0.86))
    bolts(m, [(x0 + 14, y0 + 14), (x1 - 14, y0 + 14), (x0 + 14, y1 - 14),
              (x1 - 14, y1 - 14)], base=DECKC)


# ── main gunhouse + flak ────────────────────────────────────────────────

def paint_turret(m):
    for zone in (L.S_TUR_S, L.S_TUR_F):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=shade(CASEC, 0.97), ao=AO_BASE - 6,
             rough=R_ARMOR, metal=M_ARMOR)
        seam_h(m, x0 + 3, x1 - 3, int(y0 + (y1 - y0) * 0.42), CASEC,
               hi=False)
        wear_edges(m, (x0, y0, x1, y1), CASEC, 60)
    x0, y0, x1, y1 = L.S_TUR_S.rect
    ft = PL.font(50)
    m.d.text(((x0 + x1) / 2 - 24 + 2, y0 + 34 + 2), 'A', font=ft,
             fill=shade(CASEC, 0.5))
    m.d.text(((x0 + x1) / 2 - 24, y0 + 34), 'A', font=ft, fill=STENCIL)
    bolts(m, [(x0 + 18 + i * 36, y1 - 16) for i in range(9)], base=CASEC)
    zone = L.S_TUR_T
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CASEC, 0.9), ao=AO_BASE - 8,
         rough=200, metal=95)
    m.d.rectangle([(x0 + x1) * 0.58 - 16, (y0 + y1) / 2 + 18,
                   (x0 + x1) * 0.58 + 16, (y0 + y1) / 2 + 50],
                  fill=(52, 56, 54))
    wear_edges(m, (x0, y0, x1, y1), CASEC, 50)

    # flak tub
    zone = L.S_FLAK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CASEC, 0.86), ao=AO_BASE - 8,
         rough=R_ARMOR, metal=M_ARMOR)
    u, v = PL.zone_fns(zone)
    seam_h(m, x0 + 3, x1 - 3, int(v(0.55)), CASEC, hi=False)
    bolts(m, [(x0 + 20 + i * 40, int(v(0.2))) for i in range(8)], base=CASEC)
    PL.hazard_band(m, (x0, int(v(0.92)), x1, int(v(0.80))))
    wear_edges(m, (x0, y0, x1, y1), CASEC, 55)

    # gun tubes: gunmetal wrap, dark muzzle third
    x0, y0, x1, y1 = L.S_BARREL
    fill(m, (x0, y0, x1, y1), dif=(60, 63, 66), ao=AO_BASE - 10, rough=150,
         metal=190)
    m.d.rectangle([x0, y0, x0 + (x1 - x0) // 5, y1], fill=BLACKISH)
    m.d.rectangle([x1 - (x1 - x0) // 6, y0, x1, y1], fill=(46, 44, 42))


# ── funnel, mast, fittings ──────────────────────────────────────────────

def paint_fittings(m):
    # ── THE FUNNEL: haze grey, Order band, dark cap grille, sooted top ──
    x0, y0, x1, y1 = L.S_FUNNEL
    fill(m, (x0, y0, x1, y1), dif=shade(HAZE, 0.94), ao=AO_BASE - 8,
         rough=178, metal=150)
    span = x1 - x0
    # u runs base(u=0 at zmax..) -> for limb, u spans the whole rect along
    # the limb: left edge = base, right edge = top.
    m.d.rectangle([x0 + int(span * 0.42), y0, x0 + int(span * 0.60), y1],
                  fill=(36, 38, 41))                    # Order black band
    m.d.rectangle([x0 + int(span * 0.60), y0, x0 + int(span * 0.66), y1],
                  fill=(196, 200, 202))                 # white sub-band
    m.d.rectangle([x1 - int(span * 0.18), y0, x1, y1], fill=(41, 39, 38))
    # grille slats around the cap
    for i in range(10):
        yy = y0 + (y1 - y0) * i / 10
        m.d.rectangle([x1 - int(span * 0.16), yy, x1, yy + (y1 - y0) / 22],
                      fill=(20, 19, 18))
    # steam / rivet lines up the barrel of the funnel
    for f in (0.16, 0.30, 0.78):
        m.d.rectangle([x0 + int(span * f), y0, x0 + int(span * f) + 3, y1],
                      fill=shade(HAZE, 0.72))

    # mast / posts / rails steel
    fill(m, L.S_MAST, dif=(104, 109, 112), ao=AO_BASE - 10, rough=150,
         metal=170)
    # depth-charge drums: dark olive with a warning ring
    x0, y0, x1, y1 = L.S_DC
    fill(m, (x0, y0, x1, y1), dif=(72, 76, 62), ao=AO_BASE - 8, rough=195,
         metal=90)
    m.d.rectangle([x0 + (x1 - x0) // 3, y0, x0 + (x1 - x0) // 2, y1],
                  fill=(178, 128, 42))
    # trim + dark caps
    fill(m, L.S_TRIM.rect, dif=(94, 99, 103), ao=AO_BASE - 12, rough=170,
         metal=150)
    fill(m, L.S_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=205, metal=40)
    # hatch coamings (huge-window cell -> flat, per preamble §7)
    r = L.S_HATCH.rect
    fill(m, r, dif=(66, 70, 73), ao=AO_BASE - 10, rough=185, metal=110)

    # nav radar bar
    zone = L.S_RADAR
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(142, 146, 148), ao=AO_BASE - 5, rough=150,
         metal=130)
    for i in range(10):
        sx = x0 + (x1 - x0) * i / 10
        m.d.rectangle([sx, y0 + 10, sx + (x1 - x0) / 20, y1 - 10],
                      fill=(110, 114, 116))
    m.e.ellipse([(x0 + x1) / 2 - 5, y0 + 4, (x0 + x1) / 2 + 5, y0 + 14],
                fill=(255, 74, 48))

    # bow + stern caps: haze over boot-top over anti-foul
    for zone in (L.S_BOW, L.S_STERN):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=HAZE, ao=AO_BASE - 8, rough=R_ARMOR,
             metal=M_ARMOR)
        u, v = PL.zone_fns(zone)
        m.d.rectangle([x0, v(L.WATERLINE[1]), x1, v(L.WATERLINE[0])],
                      fill=BOOT)
        m.d.rectangle([x0, v(L.WATERLINE[0]), x1, y1], fill=ANTIFOUL)
        wear_edges(m, (x0, y0, x1, y1), HAZE, 45)
    # stern name stencil
    x0, y0, x1, y1 = L.S_STERN.rect
    f = PL.font(30)
    tw = m.d.textlength(HULLNO, font=f)
    m.d.text(((x0 + x1) / 2 - tw / 2, y0 + 26), HULLNO, font=f, fill=STENCIL)


# ── assembly ────────────────────────────────────────────────────────────

def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_hull(m)
    paint_deck(m)
    paint_casemate(m)
    paint_wheelhouse(m)
    paint_turret(m)
    paint_fittings(m)

    # ── weathering ──
    wx = PL.standard_weather(m, L, ground_rects=(), side_zones=(),
                             seed=90210, grime=0.30)
    zh = L.S_HULL_SIDE
    uh, vh = PL.zone_fns(zh)
    hx0, hy0, hx1, hy1 = zh.rect

    # scupper rust streaks every ~2.9 m, from the deck edge down
    for wz in np.arange(-14.0, 17.0, 2.9):
        edge = 3.15 if wz > -6.0 else 3.85
        wx.rust_streak(uh(wz), vh(edge - 0.5), 34 + (int(wz) % 4) * 9,
                       width=3.2, strength=0.55)
    # rust under the anchor hawses + chipped paint on the fo'c'sle
    for wz in (-16.4, -15.9):
        wx.rust_streak(uh(wz), vh(3.3), 60, width=4.0, strength=0.7)
    wx.plate_bottom_rust((hx0, int(vh(4.3)), hx1, int(vh(0.5))), n=10,
                         strength=0.45)
    # salt / scum band straddling the waterline
    wx.mud_band((hx0, int(vh(0.75)), hx1, int(vh(-0.5))), 0.62, fade=None,
                spatter=True)
    wx.mud_band(zh.rect, 0.10, fade='down', spatter=False)
    wx.mud_band(L.S_CASE_S.rect, 0.10, fade='down', spatter=False)
    wx.mud_band(L.S_DECK.rect, 0.16, fade=None, spatter=True)

    # ── soot: funnel wrap heaviest at the cap, then the FAN AFT of it ──
    fx0, fy0, fx1, fy1 = L.S_FUNNEL
    wx.soot_patch((fx0, fy0, fx1, fy1), 0.55, fade='right')
    wx.soot_patch((fx1 - (fx1 - fx0) // 3, fy0, fx1, fy1), 0.9)
    # fan across the casemate roof aft of the funnel
    zt = L.S_CASE_TOP
    ut, vt = PL.zone_fns(zt)
    wx.soot_patch((int(ut(2.6)), zt.rect[1], int(ut(7.4)), zt.rect[3]), 0.50)
    # and along the quarterdeck / after hull sides
    zd = L.S_DECK
    ud, vd = PL.zone_fns(zd)
    wx.soot_patch((int(ud(6.0)), zd.rect[1], int(ud(13.0)), zd.rect[3]), 0.36)
    wx.soot_patch((int(uh(3.0)), int(vh(3.0)), int(uh(11.0)), int(vh(1.6))),
                  0.26)
    # casemate flank soot smudge abaft the funnel
    zc = L.S_CASE_S
    uc, vc = PL.zone_fns(zc)
    wx.soot_patch((int(uc(2.8)), int(vc(6.0)), int(uc(7.0)), int(vc(3.6))),
                  0.30)
    # oil sheen on the quarterdeck rail lanes
    wx.oily((int(ud(12.0)), zd.rect[1] + 20, int(ud(17.0)),
             zd.rect[3] - 20), 0.4)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    for wy in (-1.1, 0.75, 1.85):
        hm.line((hx0 + 2, vh(wy)), (hx1 - 2, vh(wy)), -0.4, width=2)
    for wz in np.arange(-16.0, 17.5, 2.9):
        hm.line((uh(wz), vh(4.3)), (uh(wz), vh(-2.2)), 0.32, width=2)
    for wz in np.arange(-17.0, 17.5, 1.35):
        hm.line((ud(wz), zd.rect[1] + 2), (ud(wz), zd.rect[3] - 2), 0.3,
                width=2)
    for wz in np.arange(-4.4, 7.4, 2.1):
        hm.line((uc(wz), vc(5.85)), (uc(wz), vc(2.6)), 0.34, width=2)

    PL.finish(m, L, 'ms_ships_s2', hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
