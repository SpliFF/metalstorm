"""paint_ms_landing_ship — 2048² PBR set for ms_landing_ship (LSV Peltast).

Amphibious-force scheme in the fable_battleship family: haze-grey
topsides over a black boot-top and oxide anti-foul, plated strakes with
draft marks and a bow team flash, tread-plated well deck with lane
markings, painted slot numbers and tie-downs, hazard-striped bulwark
caps + yellow rails, lit aft bridge with port/starboard nav lights,
stack soot, and heavy amphib weathering — scupper rust, waterline
scum, ramp-sill mud, oil in the vehicle lanes.
"""
from __future__ import annotations
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

import ms_landing_ship_layout as L   # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   stencil, jit, shade, BOLT_LOG,
                   GLASS, YELLOW, BLACKISH, TEAMGREY, CYAN,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, RNG)

# DejaVu path in paint.py is Linux-only; fall back to a macOS system font.
FONT = P.FONT
if not os.path.exists(FONT):
    for cand in ('/System/Library/Fonts/Supplemental/Arial Bold.ttf',
                 '/System/Library/Fonts/Supplemental/Arial Narrow Bold.ttf',
                 '/Library/Fonts/Arial Bold.ttf'):
        if os.path.exists(cand):
            FONT = cand
            P.FONT = cand           # stencil() reads paint.FONT at call time
            break

W = 2048
HAZE = (108, 114, 121)          # topside grey (fable_battleship family)
ANTIFOUL = (96, 52, 44)         # oxide red below waterline
BOOT = (28, 30, 33)             # boot-top band
DECKC = (74, 79, 85)            # deck steel
WELLC = (66, 70, 76)            # well deck floor
WALLC = (84, 89, 96)            # well interior walls
WARM = (255, 190, 120)
RED = (255, 62, 40)
GREEN = (60, 220, 90)


def hazard_strip(m, x0, y0, x1, y1, step=18):
    """Diagonal yellow/black chevron band in pixel rect."""
    for i in range(int((x1 - x0) / step) + 2):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * step, y0), (x0 + (i + 1) * step, y0),
                     (x0 + i * step + step // 2, y1),
                     (x0 + i * step - step // 2, y1)], fill=c)
    m.o.rectangle([x0, y0, x1, y1], fill=(AO_BASE - 10, 185, 40))


def paint_hull(m):
    zone = L.S_HULL_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=HAZE, ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR)

    def py(wy):
        return zone.uv((0, wy, 0))[1] * W

    def pz(wz):
        return zone.uv((0, 0, wz))[0] * W

    # plated strakes + frame verticals
    for wy in (2.2, 3.0, 3.8):
        seam_h(m, x0 + 3, x1 - 3, int(py(wy)), HAZE, hi=False)
    for wz in np.arange(-15.0, 17.0, 3.5):
        seam_v(m, int(pz(wz)), int(py(4.4)), int(py(1.55)), HAZE, hi=False)
    # boot-top + anti-foul
    m.d.rectangle([x0, py(L.WATERLINE[1]), x1, py(L.WATERLINE[0])], fill=BOOT)
    m.o.rectangle([x0, py(L.WATERLINE[1]), x1, py(L.WATERLINE[0])],
                  fill=(AO_BASE - 15, 200, 30))
    m.d.rectangle([x0, py(L.WATERLINE[0]), x1, y1], fill=ANTIFOUL)
    m.o.rectangle([x0, py(L.WATERLINE[0]), x1, y1],
                  fill=(AO_BASE - 20, 215, 20))
    # bow team flash (geometric, mirror-safe)
    fu0, fu1 = pz(-16.4), pz(-13.2)
    m.t.polygon([(fu0, py(4.55)), (fu1, py(4.55)), (fu1 - 14, py(3.0)),
                 (fu0 - 14, py(3.0))], fill=(255, 0, 0))
    m.d.polygon([(fu0, py(4.55)), (fu1, py(4.55)), (fu1 - 14, py(3.0)),
                 (fu0 - 14, py(3.0))], fill=TEAMGREY)
    # hull number at the bow
    fh = ImageFont.truetype(FONT, 46)
    m.d.text((pz(-12.4) + 2, py(3.6) + 2), 'L-92', font=fh,
             fill=shade(HAZE, 0.5))
    m.d.text((pz(-12.4), py(3.6)), 'L-92', font=fh, fill=(212, 216, 220))
    # scuppers under the cap
    for wz in np.arange(-13.0, 16.0, 4.0):
        m.d.rectangle([pz(wz) - 5, int(py(4.25)), pz(wz) + 5, int(py(4.1))],
                      fill=(40, 42, 46))
    # draft marks bow + stern
    fdm = ImageFont.truetype(FONT, 12)
    for wz in (-15.2, 16.4):
        for i, wy in enumerate((0.7, 1.2, 1.7)):
            m.d.text((pz(wz), py(wy) - 6), f'{i + 1}', font=fdm,
                     fill=(210, 214, 218))
    wear_edges(m, (x0, int(py(4.7)), x1, int(py(1.55))), HAZE, 55)

    # belly: anti-foul flat
    r = L.S_BELLY.rect
    fill(m, r, dif=shade(ANTIFOUL, 0.92), ao=AO_BASE - 25, rough=220,
         metal=15)
    for fx in (0.25, 0.5, 0.75):
        seam_v(m, int(r[0] + (r[2] - r[0]) * fx), r[1] + 3, r[3] - 3,
               ANTIFOUL, hi=False)


def paint_well(m):
    # floor: tread plate + vehicle lanes
    zone = L.S_WELL_FLOOR
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=WELLC, ao=AO_BASE - 12, rough=200, metal=95)

    def pz(wz):
        return zone.uv((0, 0, wz))[0] * W

    def px(wx):
        return zone.uv((wx, 0, 0))[1] * W

    for wz in np.arange(-16.0, 17.0, 1.2):          # transverse tread strips
        m.d.line([(pz(wz), y0 + 2), (pz(wz), y1 - 2)],
                 fill=shade(WELLC, 0.86), width=2)
    for wx in (-2.9, 2.9):                           # deck-edge gutters
        m.d.line([(x0 + 2, px(wx)), (x1 - 2, px(wx))],
                 fill=shade(WELLC, 0.7), width=3)
    # centre guide lane (yellow dashes between the rails)
    for wz in np.arange(-13.0, 10.0, 1.6):
        m.d.rectangle([pz(wz), px(-0.14), pz(wz + 0.8), px(0.14)],
                      fill=jit(YELLOW, 8))
    # slot numbers + tie-down crosses
    fs = ImageFont.truetype(FONT, 40)
    for i, (_, _, lz) in enumerate(L.LINKS):
        m.d.text((pz(lz - 0.4), px(2.0) - 20), f'{i + 1}', font=fs,
                 fill=(200, 204, 208))
        for (dx, dz) in ((-2.3, -1.8), (2.3, -1.8), (-2.3, 1.8), (2.3, 1.8)):
            cx, cy = pz(lz + dz), px(dx)
            m.d.line([(cx - 5, cy), (cx + 5, cy)], fill=(36, 38, 42), width=3)
            m.d.line([(cx, cy - 5), (cx, cy + 5)], fill=(36, 38, 42), width=3)
    # ramp sill chevrons at the bow end of the floor
    hazard_strip(m, int(pz(-16.6)), y0 + 4, int(pz(-15.2)), y1 - 4)
    wear_edges(m, (x0, y0, x1, y1), WELLC, 80)

    # inboard walls: frames + hazard top edge + floodlight courses
    zone = L.S_WELL_WALL
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=WALLC, ao=AO_BASE - 14, rough=185,
         metal=110)
    for wz in np.arange(-15.0, 17.0, 2.6):
        u = zone.uv((0, 0, wz))[0] * W
        seam_v(m, int(u), y0 + 3, y1 - 3, WALLC, hi=False)
    hazard_strip(m, x0, y0, x1, y0 + 16)
    yv = zone.uv((0, 2.2, 0))[1] * W
    for wz in np.arange(-12.0, 15.0, 5.2):           # freeing ports
        u = zone.uv((0, 0, wz))[0] * W
        m.d.rectangle([u - 14, yv - 8, u + 14, yv + 8], fill=(38, 40, 44))
        m.o.rectangle([u - 14, yv - 8, u + 14, yv + 8],
                      fill=(AO_DEEP, R_STEEL, M_STEEL))
    wear_edges(m, (x0, y0, x1, y1), WALLC, 45)

    # bulwark caps: grey with yellow safety edging
    zone = L.S_RIM
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=DECKC, ao=AO_BASE - 8, rough=190,
         metal=100)
    m.d.rectangle([x0, y0 + 2, x1, y0 + 8], fill=jit(YELLOW, 6))
    m.d.rectangle([x0, y1 - 8, x1, y1 - 2], fill=jit(YELLOW, 6))
    for wz in np.arange(-14.0, 17.0, 3.5):
        u = zone.uv((0, 0, wz))[0] * W
        seam_v(m, int(u), y0 + 2, y1 - 2, DECKC, hi=False)

    # cradle rails/beams + hazard rails + trims
    r = L.S_CRADLE.rect
    fill(m, r, dif=(58, 62, 68), ao=AO_BASE - 15, rough=170, metal=150)
    m.d.rectangle([r[0], r[1] + (r[3] - r[1]) // 2 - 3, r[2],
                   r[1] + (r[3] - r[1]) // 2 + 3], fill=shade((58, 62, 68), 0.7))
    x0, y0, x1, y1 = L.S_RAIL
    fill(m, (x0, y0, x1, y1), dif=jit(YELLOW, 4), ao=AO_BASE - 8, rough=175,
         metal=120)
    for fy in np.linspace(0.12, 0.88, 5):            # black bands along runs
        yy = int(y0 + (y1 - y0) * fy)
        m.d.rectangle([x0, yy - 5, x1, yy + 5], fill=BLACKISH)
    r = L.S_TRIM.rect
    fill(m, r, dif=(52, 55, 60), ao=AO_BASE - 15, rough=165, metal=150)
    fill(m, L.S_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)
    r = L.S_MAST
    fill(m, r, dif=(96, 100, 106), ao=AO_BASE - 10, rough=150, metal=170)
    # floodlight housings: lit face
    r = L.S_LIGHT.rect
    fill(m, r, dif=(46, 48, 52), ao=AO_BASE - 12, rough=140, metal=160)
    m.e.rectangle([r[0] + 20, r[1] + 20, r[2] - 20, r[3] - 20], fill=WARM)


def paint_ends(m):
    # bow face around the ramp mouth
    zone = L.S_BOW
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=HAZE, ao=AO_BASE - 8)
    wl0 = zone.uv((0, L.WATERLINE[0], 0))[1] * W
    wl1 = zone.uv((0, L.WATERLINE[1], 0))[1] * W
    m.d.rectangle([x0, wl1, x1, wl0], fill=BOOT)
    m.d.rectangle([x0, wl0, x1, y1], fill=ANTIFOUL)
    # ramp seal gasket border around the mouth
    mu0 = zone.uv((2.55, 0, 0))[0] * W
    mu1 = zone.uv((-2.55, 0, 0))[0] * W
    mv = zone.uv((0, 1.95, 0))[1] * W
    m.d.rectangle([mu0 - 6, y0, mu0 + 6, mv], fill=(38, 40, 44))
    m.d.rectangle([mu1 - 6, y0, mu1 + 6, mv], fill=(38, 40, 44))
    m.d.rectangle([mu0, mv - 6, mu1, mv + 6], fill=(38, 40, 44))
    wear_edges(m, (x0, y0, x1, y1), HAZE, 40)

    # stern transom: name + team stripe + docking light
    zone = L.S_STERN
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=HAZE, ao=AO_BASE - 8)
    wl0 = zone.uv((0, L.WATERLINE[0], 0))[1] * W
    wl1 = zone.uv((0, L.WATERLINE[1], 0))[1] * W
    m.d.rectangle([x0, wl1, x1, wl0], fill=BOOT)
    m.d.rectangle([x0, wl0, x1, y1], fill=ANTIFOUL)
    m.t.rectangle([x0 + 12, y0 + 26, x1 - 12, y0 + 52], fill=(255, 0, 0))
    m.d.rectangle([x0 + 12, y0 + 26, x1 - 12, y0 + 52], fill=TEAMGREY)
    f = ImageFont.truetype(FONT, 34)
    tw = m.d.textlength('PELTAST', font=f)
    m.d.text(((x0 + x1) / 2 - tw / 2 + 2, y0 + 64 + 2), 'PELTAST', font=f,
             fill=shade(HAZE, 0.5))
    m.d.text(((x0 + x1) / 2 - tw / 2, y0 + 64), 'PELTAST', font=f,
             fill=(212, 216, 220))
    m.e.ellipse([(x0 + x1) / 2 - 5, y0 + 8, (x0 + x1) / 2 + 5, y0 + 18],
                fill=(235, 240, 245))
    bolts(m, [(x0 + 16, y0 + 14), (x1 - 16, y0 + 14)], base=HAZE)


def paint_ramp(m):
    # seaward face: armour plate, big team chevron, hazard lip
    zone = L.S_RAMP_OUT
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(HAZE, 0.96), ao=AO_BASE - 8)
    for fy in (0.30, 0.62):
        seam_h(m, x0 + 3, x1 - 3, int(y0 + (y1 - y0) * fy), HAZE, hi=False)
    ccx = (x0 + x1) / 2
    cy0 = y0 + (y1 - y0) * 0.30
    ch_w = (x1 - x0) * 0.30
    poly = [(ccx - ch_w, cy0 + 60), (ccx, cy0), (ccx + ch_w, cy0 + 60),
            (ccx + ch_w, cy0 + 82), (ccx, cy0 + 22), (ccx - ch_w, cy0 + 82)]
    m.t.polygon(poly, fill=(255, 0, 0))
    m.d.polygon(poly, fill=TEAMGREY, outline=shade(HAZE, 0.55))
    hazard_strip(m, x0 + 4, y0 + 4, x1 - 4, y0 + 22)      # lip (top when up)
    bolts(m, [(x0 + 14 + i * ((x1 - x0 - 28) / 9), y1 - 16)
              for i in range(10)], base=HAZE)
    wear_edges(m, (x0, y0, x1, y1), HAZE, 70)

    # deck face: treads, edge hazards, wear from tracks
    zone = L.S_RAMP_IN
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=WELLC, ao=AO_BASE - 12, rough=205,
         metal=90)
    for fy in np.linspace(0.08, 0.92, 12):           # herringbone treads
        yy = y0 + (y1 - y0) * fy
        m.d.line([(x0 + 8, yy + 6), ((x0 + x1) / 2, yy - 6)],
                 fill=shade(WELLC, 0.8), width=3)
        m.d.line([((x0 + x1) / 2, yy - 6), (x1 - 8, yy + 6)],
                 fill=shade(WELLC, 0.8), width=3)
    hazard_strip(m, x0 + 4, y0 + 4, x1 - 4, y0 + 22)
    for fx in (0.30, 0.70):                          # track polish lanes
        lx = x0 + (x1 - x0) * fx
        m.d.rectangle([lx - 26, y0 + 26, lx + 26, y1 - 6],
                      fill=shade(WELLC, 1.1))
        m.o.rectangle([lx - 26, y0 + 26, lx + 26, y1 - 6],
                      fill=(AO_BASE - 8, 150, 140))
    wear_edges(m, (x0, y0, x1, y1), WELLC, 80)


def paint_super(m):
    # bridge: window band + door + nav lights (port +x red / stbd green)
    zone = L.S_BRIDGE_S
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(HAZE, 1.05), ao=AO_BASE - 4)
    wy0 = y0 + (y1 - y0) * 0.20
    wy1 = y0 + (y1 - y0) * 0.44
    m.d.rectangle([x0 + 8, wy0, x1 - 8, wy1], fill=GLASS)
    m.o.rectangle([x0 + 8, wy0, x1 - 8, wy1], fill=(AO_BASE, R_GLASS, M_GLASS))
    for i in range(8):
        gx = x0 + 8 + (x1 - x0 - 16) * i / 8
        m.d.rectangle([gx - 2, wy0, gx + 2, wy1], fill=shade(HAZE, 0.7))
    for i in (1, 3, 6):
        gx0 = x0 + 8 + (x1 - x0 - 16) * i / 8 + 3
        gx1 = x0 + 8 + (x1 - x0 - 16) * (i + 1) / 8 - 3
        m.e.rectangle([gx0, wy0 + 3, gx1, wy1 - 3], fill=(150, 110, 60))
    # nav lights on the world ±x sides
    pu = zone.uv((0, 0, L.BRIDGE[2] - 1.6))[0] * W
    m.e.ellipse([pu - 5, wy0 - 12, pu + 5, wy0 - 2], fill=RED)
    m.e.ellipse([pu + 24, wy0 - 12, pu + 34, wy0 - 2], fill=GREEN)
    # door + team band
    dx0 = x0 + (x1 - x0) * 0.72
    m.d.rectangle([dx0, y1 - 74, dx0 + 30, y1 - 10], fill=(50, 54, 60),
                  outline=shade(HAZE, 0.6), width=2)
    m.t.rectangle([x0 + 6, y1 - 18, x1 - 6, y1 - 6], fill=(255, 0, 0))
    m.d.rectangle([x0 + 6, y1 - 18, x1 - 6, y1 - 6], fill=TEAMGREY)
    wear_edges(m, (x0, y0, x1, y1), HAZE, 30)

    # bridge roof: walk lanes, mast plate, hatch
    zone = L.S_BRTOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=DECKC, ao=AO_BASE - 8, rough=195, metal=90)
    for fx in (0.25, 0.75):
        m.d.line([(x0 + (x1 - x0) * fx, y0 + 4), (x0 + (x1 - x0) * fx, y1 - 4)],
                 fill=shade(DECKC, 0.85), width=2)
    hu = zone.uv((0.9, 0, 15.9))
    m.d.rectangle([hu[0] * W - 18, hu[1] * W - 18, hu[0] * W + 18,
                   hu[1] * W + 18], fill=(52, 55, 60))
    bolts(m, [(x0 + 14, y0 + 14), (x1 - 14, y0 + 14), (x0 + 14, y1 - 14),
              (x1 - 14, y1 - 14)], base=DECKC)

    # quarterdeck: plating + walk lanes
    zone = L.S_AFT_DECK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=DECKC, ao=AO_BASE - 8, rough=195, metal=90)
    for wx in (-2.6, 0.0, 2.6):
        v = zone.uv((wx, 0, 0))[1] * W
        m.d.line([(x0 + 2, v), (x1 - 2, v)], fill=shade(DECKC, 0.85), width=2)
    for wz in (12.4, 14.4, 16.4):
        u = zone.uv((0, 0, wz))[0] * W
        seam_v(m, int(u), y0 + 2, y1 - 2, DECKC, hi=False)
    wear_edges(m, (x0, y0, x1, y1), DECKC, 40)

    # radar bar + stacks + rafts
    zone = L.S_RADAR
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(140, 144, 150), ao=AO_BASE - 5, rough=150,
         metal=130)
    for i in range(8):
        sx = x0 + (x1 - x0) * i / 8
        m.d.rectangle([sx, y0 + 10, sx + (x1 - x0) / 16, y1 - 10],
                      fill=(110, 114, 120))
    m.e.ellipse([(x0 + x1) / 2 - 4, y0 + 6, (x0 + x1) / 2 + 4, y0 + 14],
                fill=RED)
    x0, y0, x1, y1 = L.S_STACK
    fill(m, (x0, y0, x1, y1), dif=(62, 66, 72), ao=AO_BASE - 10, rough=170,
         metal=160)
    m.d.rectangle([x0, y0, x0 + 26, y1], fill=BLACKISH)   # cap end (u=top)
    m.t.rectangle([x0 + 40, y0, x0 + 64, y1], fill=(255, 0, 0))
    m.d.rectangle([x0 + 40, y0, x0 + 64, y1], fill=TEAMGREY)
    x0, y0, x1, y1 = L.S_RAFT
    fill(m, (x0, y0, x1, y1), dif=(228, 224, 214), ao=AO_BASE - 4, rough=200,
         metal=20)
    for fx in (0.18, 0.82):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 8, y0, sx + 8, y1], fill=(214, 110, 40))


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_hull(m)
    paint_well(m)
    paint_ends(m)
    paint_ramp(m)
    paint_super(m)

    # ── amphib weathering ──
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=90210)
    wx.crevice_grime(m.dif, 0.42)
    zone = L.S_HULL_SIDE
    x0, y0, x1, y1 = zone.rect

    def py(wy):
        return zone.uv((0, wy, 0))[1] * W

    for wz in np.arange(-13.0, 16.0, 4.0):      # scupper rust
        u = zone.uv((0, 0, wz))[0] * W
        wx.rust_streak(u, py(4.15), 36 + (int(wz) % 3) * 12, width=3.0,
                       strength=0.5)
    wx.plate_bottom_rust((x0, int(py(4.7)), x1, int(py(1.6))), n=10,
                         strength=0.5)
    wx.mud_band((x0, int(py(1.75)), x1, int(py(0.85))), 0.6, fade=None,
                spatter=True)                    # waterline scum
    wx.mud_band(L.S_WELL_FLOOR.rect, 0.4, fade=None, spatter=True)
    wx.mud_band(L.S_WELL_WALL.rect, 0.28, fade='down', spatter=False)
    wx.mud_band(L.S_RAMP_IN.rect, 0.5, fade=None, spatter=True)
    wx.mud_band(L.S_RAMP_OUT.rect, 0.45, fade='down', spatter=True)
    fl = L.S_WELL_FLOOR.rect
    for (fx, fy) in ((0.22, 0.4), (0.45, 0.6), (0.68, 0.35)):   # lane oil
        wx.oily((int(fl[0] + (fl[2] - fl[0]) * fx), fl[1] + 30,
                 int(fl[0] + (fl[2] - fl[0]) * (fx + 0.14)), fl[3] - 30),
                0.45)
    sx0, sy0, sx1, sy1 = L.S_STACK
    wx.soot_patch((sx0, sy0, sx0 + (sx1 - sx0) // 3, sy1), 0.75)
    wx.mud_band(L.S_BRIDGE_S.rect, 0.2, fade='down', spatter=False)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.55)
    wx.apply(m)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    zone = L.S_HULL_SIDE
    x0, y0, x1, y1 = zone.rect
    for wy in (2.2, 3.0, 3.8):
        hm.line((x0 + 2, py(wy)), (x1 - 2, py(wy)), -0.4, width=2)
    for wz in np.arange(-15.0, 17.0, 3.5):
        u = zone.uv((0, 0, wz))[0] * W
        hm.line((u, py(4.4)), (u, py(1.55)), 0.3, width=2)
    zone = L.S_WELL_FLOOR
    x0, y0, x1, y1 = zone.rect
    for wz in np.arange(-16.0, 17.0, 1.2):
        u = zone.uv((0, 0, wz))[0] * W
        hm.line((u, y0 + 2), (u, y1 - 2), 0.3, width=2)
    zone = L.S_RAMP_IN
    x0, y0, x1, y1 = zone.rect
    for fy in np.linspace(0.08, 0.92, 12):
        yy = y0 + (y1 - y0) * fy
        hm.line((x0 + 8, yy + 6), ((x0 + x1) / 2, yy - 6), 0.35, width=3)
        hm.line(((x0 + x1) / 2, yy - 6), (x1 - 8, yy + 6), 0.35, width=3)
    zone = L.S_WELL_WALL
    x0, y0, x1, y1 = zone.rect
    for wz in np.arange(-15.0, 17.0, 2.6):
        u = zone.uv((0, 0, wz))[0] * W
        hm.line((u, y0 + 3), (u, y1 - 3), 0.35, width=2)
    hm.crevices_from(m.dif, 0.55)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.6).save('out/ms_landing_ship_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save('out/ms_landing_ship_diffuse.png')
    m.orm.save('out/ms_landing_ship_orm.png')
    m.emi.save('out/ms_landing_ship_emissive.png')
    m.tea.save('out/ms_landing_ship_team.png')
    print('[paint_ms_landing_ship] full 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
