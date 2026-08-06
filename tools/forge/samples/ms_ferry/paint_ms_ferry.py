"""paint_ms_ferry — 2048 PBR set for ms_ferry (double-ended vehicle ferry).

Civilian estate register: chalky once-white topsides over a dark
boot-top and oxide anti-foul, rust-streaked plating, dark steel vehicle
deck with FADED lane paint (low contrast — big deck quads flat-shade in
the impostor baker), hand-painted name, cream pilot house with warm lit
windows, faded safety-yellow gantry and kerbs, life-ring and drum
clutter. No team colour.
"""
from __future__ import annotations
import os
import numpy as np

import ms_ferry_layout as L   # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL
from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, stencil,
                   jit, shade, BOLT_LOG, GLASS, YELLOW, BLACKISH,
                   AO_BASE, AO_DEEP, R_STEEL, R_GLASS, M_STEEL, M_GLASS)
from PIL import ImageFont

FONT = P.FONT
if not os.path.exists(FONT):
    for cand in ('/System/Library/Fonts/Supplemental/Arial Bold.ttf',
                 '/Library/Fonts/Arial Bold.ttf'):
        if os.path.exists(cand):
            FONT = cand
            P.FONT = cand
            break

W = 2048
TOPSIDE = (176, 172, 160)       # chalky old white
BOOT = (32, 34, 37)
ANTIFOUL = (99, 56, 46)
DECKC = (72, 74, 76)
KERB = (150, 128, 52)           # faded safety yellow
CREAM = (196, 188, 168)
LANE = (148, 146, 132)          # faded lane paint (low contrast on purpose)
WARM = (255, 190, 120)


def paint_hull(m):
    zone = L.S_HULL
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=TOPSIDE, ao=AO_BASE - 6, rough=205,
         metal=60)
    u, v = PL.zone_fns(zone)
    for wy in (0.9, 1.4):
        seam_h(m, x0 + 3, x1 - 3, int(v(wy)), TOPSIDE, hi=False)
    for wz in np.arange(-14.0, 15.0, 3.2):
        seam_v(m, int(u(wz)), int(v(1.75)), int(v(0.4)), TOPSIDE, hi=False)
    # boot-top band about the waterline + anti-foul below
    m.d.rectangle([x0, v(L.WATERLINE[1]), x1, v(L.WATERLINE[0])], fill=BOOT)
    m.o.rectangle([x0, v(L.WATERLINE[1]), x1, v(L.WATERLINE[0])],
                  fill=(AO_BASE - 15, 200, 30))
    m.d.rectangle([x0, v(L.WATERLINE[0]), x1, y1], fill=ANTIFOUL)
    m.o.rectangle([x0, v(L.WATERLINE[0]), x1, y1], fill=(AO_BASE - 20, 215, 20))
    # hand-painted name amidships
    fh = ImageFont.truetype(FONT, 40)
    m.d.text((u(-2.8) + 2, v(1.55) + 2), 'IRONBARK CROSSING', font=fh,
             fill=shade(TOPSIDE, 0.55))
    m.d.text((u(-2.8), v(1.55)), 'IRONBARK CROSSING', font=fh,
             fill=(84, 74, 60))
    wear_edges(m, (x0, y0, x1, int(v(0.4))), TOPSIDE, 60)

    # belly
    r = L.S_BELLY.rect
    fill(m, r, dif=shade(ANTIFOUL, 0.92), ao=AO_BASE - 25, rough=220,
         metal=15)

    # ends: same scheme as sides
    zone = L.S_END
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=TOPSIDE, ao=AO_BASE - 8, rough=205,
         metal=60)
    u, v = PL.zone_fns(zone)
    m.d.rectangle([x0, v(L.WATERLINE[1]), x1, v(L.WATERLINE[0])], fill=BOOT)
    m.d.rectangle([x0, v(L.WATERLINE[0]), x1, y1], fill=ANTIFOUL)
    wear_edges(m, (x0, y0, x1, y1), TOPSIDE, 50)


def paint_deck(m):
    zone = L.S_DECK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=DECKC, ao=AO_BASE - 10, rough=200, metal=90)
    u, v = PL.zone_fns(zone)
    # transverse tread strips (tone-on-tone)
    for wz in np.arange(-15.0, 15.5, 1.4):
        m.d.line([(u(wz), y0 + 2), (u(wz), y1 - 2)],
                 fill=shade(DECKC, 0.90), width=2)
    # faded lane edge lines (two lanes) + dashed centreline
    for wx in (-2.95, -0.25, 0.25, 2.95):
        m.d.line([(x0 + 4, v(wx)), (x1 - 4, v(wx))], fill=LANE, width=3)
    for wz in np.arange(-14.5, 14.5, 2.2):
        m.d.rectangle([u(wz), v(-0.06), u(wz + 1.0), v(0.06)],
                      fill=shade(LANE, 1.06))
    # faded hazard chevrons at both ramp sills
    PL.hazard_band(m, PL.nbox(u(-15.6), y0 + 4, u(-14.6), y1 - 4))
    PL.hazard_band(m, PL.nbox(u(14.6), y0 + 4, u(15.6), y1 - 4))
    # slot numbers by each link
    fs = ImageFont.truetype(FONT, 34)
    for i, (lx, _, lz) in enumerate(L.LINKS):
        m.d.text((u(lz - 0.3), v(lx + 0.9)), f'{i + 1}', font=fs,
                 fill=shade(LANE, 1.05))
    # tie-down crosses
    for (lx, _, lz) in L.LINKS:
        for (ddx, ddz) in ((-1.0, -2.0), (1.0, -2.0), (-1.0, 2.0), (1.0, 2.0)):
            cx, cy = u(lz + ddz), v(lx + ddx)
            m.d.line([(cx - 5, cy), (cx + 5, cy)], fill=(40, 42, 44), width=3)
            m.d.line([(cx, cy - 5), (cx, cy + 5)], fill=(40, 42, 44), width=3)
    wear_edges(m, (x0, y0, x1, y1), DECKC, 70)


def paint_fittings(m):
    # sponsons: topside white above, black rub band, anti-foul low
    zone = L.S_SPON
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(TOPSIDE, 0.95), ao=AO_BASE - 10,
         rough=210, metal=50)
    u, v = PL.zone_fns(zone)
    m.d.rectangle([x0, v(0.55), x1, v(-0.05)], fill=BOOT)
    m.d.rectangle([x0, v(-0.05), x1, y1], fill=ANTIFOUL)
    for wz in np.arange(-10.0, 11.0, 3.0):
        seam_v(m, int(u(wz)), y0 + 3, int(v(0.55)), TOPSIDE, hi=False)
    wear_edges(m, (x0, y0, x1, y1), TOPSIDE, 55)

    # gantry: faded safety yellow, grimy
    x0, y0, x1, y1 = L.S_GANTRY
    fill(m, (x0, y0, x1, y1), dif=KERB, ao=AO_BASE - 10, rough=185, metal=110)
    for fy in np.linspace(0.15, 0.85, 4):
        yy = int(y0 + (y1 - y0) * fy)
        m.d.rectangle([x0, yy - 4, x1, yy + 4], fill=shade(KERB, 0.72))

    # posts/mast/bollards: worn steel
    x0, y0, x1, y1 = L.S_POST
    fill(m, (x0, y0, x1, y1), dif=(96, 98, 102), ao=AO_BASE - 10, rough=160,
         metal=170)

    # kerbs + generic trim
    r = L.S_TRIM.rect
    fill(m, r, dif=shade(KERB, 0.9), ao=AO_BASE - 12, rough=180, metal=110)
    m.d.rectangle([r[0], r[1] + (r[3] - r[1]) // 2 - 3, r[2],
                   r[1] + (r[3] - r[1]) // 2 + 3], fill=shade(KERB, 0.7))
    fill(m, L.S_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)
    # beacon glow cell
    r = L.S_DARK.rect
    m.e.rectangle([r[0] + 18, r[1] + 18, r[2] - 18, r[3] - 18],
                  fill=(255, 150, 60))

    # life ring: white with faded orange quadrants
    r = L.S_RING.rect
    fill(m, r, dif=(214, 208, 196), ao=AO_BASE - 5, rough=205, metal=15)
    cx, cy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    rr = (r[2] - r[0]) * 0.46
    for a0 in (315, 135):
        m.d.pieslice([cx - rr, cy - rr, cx + rr, cy + rr], a0, a0 + 90,
                     fill=(198, 110, 52))
    m.d.ellipse([cx - rr * 0.42, cy - rr * 0.42, cx + rr * 0.42,
                 cy + rr * 0.42], fill=BOOT)

    # drums: mixed rusty civilian colours
    r = L.S_DRUM.rect
    fill(m, r, dif=(94, 86, 70), ao=AO_BASE - 12, rough=200, metal=60)
    third = (r[3] - r[1]) // 3
    m.d.rectangle([r[0], r[1] + third, r[2], r[1] + third + 8],
                  fill=(70, 62, 50))
    m.d.rectangle([r[0], r[3] - third - 8, r[2], r[3] - third],
                  fill=(70, 62, 50))


def paint_ramps(m):
    # outboard face: plate + faded hazard lip
    zone = L.S_RAMP_OUT
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(TOPSIDE, 0.9), ao=AO_BASE - 8,
         rough=205, metal=70)
    for fy in (0.33, 0.67):
        seam_h(m, x0 + 3, x1 - 3, int(y0 + (y1 - y0) * fy), TOPSIDE,
               hi=False)
    PL.hazard_band(m, PL.nbox(x0 + 4, y0 + 4, x1 - 4, y0 + 24))
    bolts(m, [(x0 + 14 + i * ((x1 - x0 - 28) / 9), y1 - 14)
              for i in range(10)], base=TOPSIDE)
    wear_edges(m, (x0, y0, x1, y1), TOPSIDE, 70)

    # deck face: treads + hazard lip + wear lanes
    zone = L.S_RAMP_IN
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=DECKC, ao=AO_BASE - 12, rough=205, metal=90)
    for fy in np.linspace(0.10, 0.92, 10):
        yy = y0 + (y1 - y0) * fy
        m.d.line([(x0 + 6, yy), (x1 - 6, yy)], fill=shade(DECKC, 0.86),
                 width=3)
    PL.hazard_band(m, PL.nbox(x0 + 4, y0 + 4, x1 - 4, y0 + 24))
    for fx in (0.3, 0.7):
        lx = x0 + (x1 - x0) * fx
        m.d.rectangle([lx - 24, y0 + 28, lx + 24, y1 - 6],
                      fill=shade(DECKC, 1.08))
    wear_edges(m, (x0, y0, x1, y1), DECKC, 75)


def paint_cabin(m):
    # sides + fore/aft faces: cream with window band (emissive warm)
    for zone in (L.S_CAB_S, L.S_CAB_F):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=CREAM, ao=AO_BASE - 4, rough=200,
             metal=40)
        wy0 = y0 + (y1 - y0) * 0.16
        wy1 = y0 + (y1 - y0) * 0.50
        PL.glass_rect(m, (x0 + 14, wy0, x1 - 14, wy1),
                      outline=shade(CREAM, 0.6))
        for i in range(1, 6):
            gx = x0 + 14 + (x1 - x0 - 28) * i / 6
            m.d.rectangle([gx - 3, wy0, gx + 3, wy1], fill=shade(CREAM, 0.7))
        for i in (0, 2, 4):
            gx0 = x0 + 14 + (x1 - x0 - 28) * i / 6 + 4
            gx1 = x0 + 14 + (x1 - x0 - 28) * (i + 1) / 6 - 4
            m.e.rectangle([gx0, wy0 + 4, gx1, wy1 - 4], fill=(150, 110, 60))
        # dark band at the base
        m.d.rectangle([x0 + 4, y1 - 14, x1 - 4, y1 - 4],
                      fill=shade(CREAM, 0.65))
        wear_edges(m, (x0, y0, x1, y1), CREAM, 35)
    # FERRY sign on the fore/aft faces
    zone = L.S_CAB_F
    x0, y0, x1, y1 = zone.rect
    f = ImageFont.truetype(FONT, 30)
    tw = m.d.textlength('FERRY', font=f)
    m.d.text(((x0 + x1) / 2 - tw / 2, y1 - 52), 'FERRY', font=f,
             fill=(90, 78, 62))

    # roof
    zone = L.S_CAB_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CREAM, 0.85), ao=AO_BASE - 8,
         rough=205, metal=50)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, CREAM, hi=False)
    bolts(m, [(x0 + 14, y0 + 14), (x1 - 14, y0 + 14), (x0 + 14, y1 - 14),
              (x1 - 14, y1 - 14)], base=CREAM)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_hull(m)
    paint_deck(m)
    paint_fittings(m)
    paint_ramps(m)
    paint_cabin(m)

    # ── civilian ferry weathering ──
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=90210)
    wx.crevice_grime(m.dif, 0.4)
    zone = L.S_HULL
    x0, y0, x1, y1 = zone.rect
    u, v = PL.zone_fns(zone)
    for wz in np.arange(-13.5, 15.0, 3.4):      # scupper rust off the deck edge
        wx.rust_streak(u(wz), v(1.78), 34 + (int(wz) % 3) * 12, width=3.0,
                       strength=0.6)
    wx.plate_bottom_rust((x0, y0, x1, int(v(0.4))), n=10, strength=0.55)
    wx.mud_band((x0, int(v(0.55)), x1, int(v(-0.3))), 0.6, fade=None,
                spatter=True)                    # waterline scum
    wx.mud_band(L.S_DECK.rect, 0.35, fade=None, spatter=True)
    wx.mud_band(L.S_RAMP_IN.rect, 0.5, fade=None, spatter=True)
    wx.mud_band(L.S_RAMP_OUT.rect, 0.45, fade='down', spatter=True)
    wx.mud_band(L.S_SPON.rect, 0.45, fade='down', spatter=True)
    dk = L.S_DECK.rect
    for (fx, fy) in ((0.25, 0.35), (0.5, 0.6), (0.72, 0.4)):   # lane oil
        wx.oily((int(dk[0] + (dk[2] - dk[0]) * fx), dk[1] + 30,
                 int(dk[0] + (dk[2] - dk[0]) * (fx + 0.12)), dk[3] - 30),
                0.4)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.6)

    # ── height → normals ──
    from normals import HeightMap
    hm = HeightMap()
    for wy in (0.9, 1.4):
        hm.line((x0 + 2, v(wy)), (x1 - 2, v(wy)), -0.4, width=2)
    zone = L.S_DECK
    dy0, dy1 = zone.rect[1], zone.rect[3]
    du, dv = PL.zone_fns(zone)
    for wz in np.arange(-15.0, 15.5, 1.4):
        hm.line((du(wz), dy0 + 2), (du(wz), dy1 - 2), 0.3, width=2)
    hm.crevices_from(m.dif, 0.5)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)

    PL.finish(m, L, 'ms_ferry', hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
