"""paint_ms_pontoon_wharf — 2048² PBR set for ms_pontoon_wharf.

Working-harbour read at unit-consistent texel density: steel deck
plates with anti-slip strips and a hazard-striped berth edge, marine
pontoon hulls with boot-top waterline + antifoul below and algae grime
at the water, galvanized walkway grating, yellow/black pedestal crane
with a lit cab, rubber fenders, staged crates.  Weathering: rust
streaks off cleats/scuppers, waterline growth, oil around the crane
pedestal, dirt punched through the team mask.  Team mask (R channel):
crane cab band + deck end chevrons + berth ID square — never baked
into diffuse.
"""
from __future__ import annotations
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

import ms_pontoon_wharf_layout as L    # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

# font: first existing candidate (repo default path is Linux-only)
for _f in ('/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf',
           '/System/Library/Fonts/Supplemental/Arial Narrow Bold.ttf',
           '/System/Library/Fonts/Supplemental/Arial Bold.ttf'):
    if os.path.exists(_f):
        P.FONT = _f
        break

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   stencil, jit, shade, BOLT_LOG,
                   STEEL, STEEL_DK, YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP, R_STEEL, M_STEEL, RNG)

W = 2048
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   '..', '..', 'out')
STEM = 'ms_pontoon_wharf'

DECKC = (82, 88, 94)         # deck plate steel
FASCIA = (66, 71, 77)        # deck slab sides
HULLG = (99, 104, 110)       # pontoon freeboard grey
BOOT = (24, 26, 29)          # boot-top waterline band
ANTIFOUL = (104, 56, 46)     # below-waterline red-brown
GALV = (142, 148, 152)       # galvanized rails/walkway
RUBBER = (33, 35, 38)
CRATEC = (128, 112, 82)      # civilian tan crate
WARM = (255, 190, 120)


def font(size):
    return ImageFont.truetype(P.FONT, size)


# deck px helpers
def du(z):
    x0, _, x1, _ = L.W_DECK.rect
    return x0 + (x1 - x0) * (z + 15.3) / 30.6


def dv(x):
    _, y0, _, y1 = L.W_DECK.rect
    return y0 + (y1 - y0) * (x + 3.35) / 6.7


def hazard_row(m, x0, y0, x1, y1, step=26):
    for i in range(int((x1 - x0) / step) + 2):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * step, y0), (x0 + (i + 1) * step, y0),
                     (x0 + (i + 1) * step - 12, y1), (x0 + i * step - 12, y1)],
                    fill=c)


def paint_deck(m):
    zone = L.W_DECK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=DECKC, ao=AO_BASE - 8, rough=178, metal=145)
    # plate seams: across the wharf every ~2.45 m, three longitudinals
    for wz in np.arange(-12.85, 14.9, 2.45):
        seam_v(m, int(du(wz)), y0 + 2, y1 - 2, DECKC, hi=False)
    for wx in (-1.7, 0.0, 1.7):
        seam_h(m, x0 + 2, x1 - 2, int(dv(wx)), DECKC, hi=False)
    # anti-slip strips flanking the vehicle lane
    for wx in (-1.15, 1.15):
        m.d.rectangle([x0 + 8, dv(wx) - 4, x1 - 8, dv(wx) + 4],
                      fill=shade(DECKC, 0.78))
        m.o.rectangle([x0 + 8, dv(wx) - 4, x1 - 8, dv(wx) + 4],
                      fill=(AO_BASE - 15, 205, 120))
    # floating-section gaps (0.3 m of black water shadow)
    for gz in (-5.0, 5.0):
        g0, g1 = du(gz - 0.15), du(gz + 0.15)
        m.d.rectangle([g0, y0, g1, y1], fill=(14, 16, 18))
        m.o.rectangle([g0, y0, g1, y1], fill=(AO_DEEP - 40, 210, 20))
    # berth edge (-X = v top): yellow/black hazard + rub wear
    hazard_row(m, x0, y0 + 2, x1, y0 + 34)
    m.d.rectangle([x0, y0, x1, y0 + 3], fill=BLACKISH)
    # far edge: solid safety line
    m.d.rectangle([x0 + 4, y1 - 14, x1 - 4, y1 - 8], fill=(200, 202, 200))
    # cleat pads (bolted doubler plates under each cleat)
    for cz in L.CLEATS:
        cxp, cyp = du(cz), dv(L.CLEAT_X)
        pad = [cxp - 26, cyp - 20, cxp + 26, cyp + 20]
        m.d.rectangle(pad, fill=STEEL_DK, outline=shade(DECKC, 0.6), width=2)
        m.o.rectangle(pad, fill=(AO_BASE - 20, 150, 190))
        bolts(m, [(pad[0] + 7, pad[1] + 7), (pad[2] - 7, pad[1] + 7),
                  (pad[0] + 7, pad[3] - 7), (pad[2] - 7, pad[3] - 7)],
              base=STEEL_DK)
    # crane slew keep-clear ring + pedestal doubler
    ccx, ccy = du(L.PED_XZ[1]), dv(L.PED_XZ[0])
    rr = du(L.PED_XZ[1] + 6.8) - ccx
    ry = dv(L.PED_XZ[0] + 1.0) - ccy
    m.d.ellipse([ccx - rr, ccy - rr * ry / ry - 68, ccx + rr, ccy + 68],
                outline=YELLOW, width=5)
    m.d.ellipse([ccx - 62, ccy - 60, ccx + 62, ccy + 60], fill=(70, 75, 81))
    bolts(m, [(ccx + np.cos(a) * 52, ccy + np.sin(a) * 50)
              for a in np.linspace(0, 2 * np.pi, 10, endpoint=False)],
          base=(70, 75, 81))
    # vehicle lane: dashed centreline from the walkway junction seaward
    for wz in np.arange(-13.0, 14.2, 2.0):
        m.d.rectangle([du(wz), dv(-0.06), du(wz + 1.0), dv(0.06)],
                      fill=(196, 186, 120))
    # wharf ID + team markings (deck top is a single projection: text-safe)
    f = font(72)
    m.d.text((du(-13.4) + 3, dv(1.6) + 3), 'PW-07', font=f,
             fill=shade(DECKC, 0.55))
    m.d.text((du(-13.4), dv(1.6)), 'PW-07', font=f, fill=(198, 202, 206))
    for gz, s in ((-14.6, 1), (14.6, -1)):
        cx = du(gz)
        tri = [(cx, dv(-2.6)), (cx + s * 46, dv(-1.6)), (cx, dv(-0.6))]
        m.t.polygon(tri, fill=(255, 0, 0))
        m.d.polygon(tri, fill=TEAMGREY, outline=shade(DECKC, 0.55))
    tb = [du(11.4), dv(2.15), du(13.6), dv(3.0)]
    m.t.rectangle(tb, fill=(255, 0, 0))
    m.d.rectangle(tb, fill=TEAMGREY)
    # berth guide lights on the hazard edge (emissive)
    for gz in (-14.0, 14.0):
        m.e.ellipse([du(gz) - 5, y0 + 8, du(gz) + 5, y0 + 18],
                    fill=(120, 255, 170))
    wear_edges(m, (x0, y0, x1, y1), DECKC, 70)


def paint_walkway(m):
    zone = L.W_WALK
    x0, y0, x1, y1 = zone.rect

    def wu(z):
        return x0 + (x1 - x0) * (z - 14.7) / 10.6

    fill(m, (x0, y0, x1, y1), dif=GALV, ao=AO_BASE - 6, rough=165, metal=170)
    # diamond grating cross-hatch
    for gx in range(int(x0), int(x1), 16):
        m.d.line([(gx, y0), (gx + 24, y1)], fill=shade(GALV, 0.78), width=2)
        m.d.line([(gx + 24, y0), (gx, y1)], fill=shade(GALV, 0.78), width=2)
    # edge kick-plates
    for ey in (y0 + 6, y1 - 6):
        m.d.rectangle([x0, ey - 5, x1, ey + 5], fill=shade(GALV, 0.62))
    # ramp: tread bars + hazard end row
    r0 = wu(L.RAMP_Z[0])
    for wz in np.arange(L.RAMP_Z[0] + 0.15, L.RAMP_Z[1] - 0.1, 0.22):
        m.d.rectangle([wu(wz) - 2, y0 + 8, wu(wz) + 2, y1 - 8],
                      fill=shade(GALV, 0.7))
        m.o.rectangle([wu(wz) - 2, y0 + 8, wu(wz) + 2, y1 - 8],
                      fill=(AO_BASE - 12, 200, 130))
    m.d.rectangle([r0 - 3, y0 + 4, r0 + 3, y1 - 4], fill=BLACKISH)
    hazard_row(m, int(wu(L.RAMP_Z[1] - 0.5)), y0 + 4,
               int(wu(L.RAMP_Z[1])) + 8, y1 - 4, step=18)
    seam_v(m, int(wu(L.WALK_Z[0] + 0.02)), y0 + 2, y1 - 2, GALV, hi=False)
    wear_edges(m, (x0, y0, x1, y1), GALV, 40)


def paint_hull_strip(m, rect, seams_u=True):
    """Pontoon side/end scheme: freeboard grey, boot-top, antifoul.
    v maps y 1.7 (top) → -0.1 (bottom)."""
    x0, y0, x1, y1 = rect
    h = y1 - y0

    def vy(wy):
        return y0 + h * (1.7 - wy) / 1.8

    fill(m, rect, dif=HULLG, ao=AO_BASE - 10, rough=172, metal=150)
    m.d.rectangle([x0, vy(1.02), x1, vy(0.68)], fill=BOOT)
    m.o.rectangle([x0, vy(1.02), x1, vy(0.68)], fill=(AO_BASE - 15, 195, 60))
    m.d.rectangle([x0, vy(0.68), x1, y1], fill=ANTIFOUL)
    m.o.rectangle([x0, vy(0.68), x1, y1], fill=(AO_BASE - 20, 205, 40))
    # plate weld seams + top rub strake
    if seams_u:
        for fx in np.linspace(0.06, 0.94, 12):
            sx = int(x0 + (x1 - x0) * fx)
            seam_v(m, sx, y0 + 2, int(vy(0.7)), HULLG, hi=False)
    m.d.rectangle([x0, y0 + 2, x1, y0 + 10], fill=shade(HULLG, 0.7))
    bolts(m, [(x0 + (x1 - x0) * fx, y0 + 20)
              for fx in np.linspace(0.04, 0.96, 16)], base=HULLG)
    # draft tick marks
    for fx in (0.1, 0.55):
        tx = x0 + (x1 - x0) * fx
        for wy in (0.6, 0.9, 1.2):
            m.d.rectangle([tx, vy(wy) - 2, tx + 12, vy(wy) + 1],
                          fill=(210, 212, 210))
    wear_edges(m, (x0, y0, x1, int(vy(0.7))), HULLG, 40)


def paint_pontoons(m):
    paint_hull_strip(m, L.W_PONT.rect, seams_u=True)
    paint_hull_strip(m, L.W_PONT_F.rect, seams_u=False)
    # tops / deck undersides: dead dark grey
    fill(m, L.W_PONT_TOP.rect, dif=(48, 52, 57), ao=AO_BASE - 30,
         rough=195, metal=90)
    x0, y0, x1, y1 = L.W_PONT_TOP.rect
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, (48, 52, 57), hi=False)


def paint_fascia(m):
    for rect in (L.W_DECKSIDE.rect, L.W_DECKEND.rect):
        x0, y0, x1, y1 = rect
        fill(m, rect, dif=FASCIA, ao=AO_BASE - 12, rough=180, metal=140)
        # rub strake + scupper slots along the bottom edge
        m.d.rectangle([x0, y0 + 6, x1, y0 + 16], fill=shade(FASCIA, 0.72))
        n = 10 if rect is L.W_DECKSIDE.rect else 4
        for fx in np.linspace(0.08, 0.92, n):
            sx = x0 + (x1 - x0) * fx
            m.d.rectangle([sx - 8, y1 - 18, sx + 8, y1 - 10], fill=BLACKISH)
            m.o.rectangle([sx - 8, y1 - 18, sx + 8, y1 - 10],
                          fill=(AO_DEEP, 200, 60))
        wear_edges(m, rect, FASCIA, 35)


def paint_crane(m):
    # cab sides (shared ±x zone: symmetric graphics only, no text)
    zone = L.W_CRANE
    x0, y0, x1, y1 = zone.rect
    h = y1 - y0

    def cy(wy):
        return y0 + h * (2.9 - wy) / 3.2

    def cz(wz):
        return x0 + (x1 - x0) * (wz + 1.6) / 3.6

    fill(m, (x0, y0, x1, y1), dif=YELLOW, ao=AO_BASE - 6, rough=150, metal=60)
    # black chevron skirt on the lower band
    hazard_row(m, x0, int(cy(0.34)), x1, int(cy(-0.05)), step=30)
    # side window slit (dark) toward the boom end
    wb = [cz(-1.25), cy(1.45), cz(-0.35), cy(0.95)]
    m.d.rectangle(wb, fill=(22, 30, 36), outline=STEEL_DK, width=3)
    m.o.rectangle(wb, fill=(AO_BASE, 60, 0))
    # team band across the cab top edge
    tb = [cz(-1.3), cy(1.62), cz(0.85), cy(1.5)]
    m.t.rectangle(tb, fill=(255, 0, 0))
    m.d.rectangle(tb, fill=TEAMGREY)
    # counterweight block: diagonal hazard + lifting eyes
    cwb = [cz(1.15), cy(1.28), cz(2.0), cy(0.33)]
    m.d.rectangle(cwb, fill=(88, 92, 98))
    for i in range(6):
        sx = cwb[0] + i * 26
        m.d.polygon([(sx, cwb[3]), (sx + 13, cwb[3]),
                     (sx + 30, cwb[1]), (sx + 17, cwb[1])], fill=YELLOW)
    m.o.rectangle(cwb, fill=(AO_BASE - 12, 165, 130))
    bolts(m, [(cwb[0] + 10, cwb[1] + 10), (cwb[2] - 10, cwb[1] + 10)],
          base=(88, 92, 98))
    wear_edges(m, (x0, y0, x1, y1), YELLOW, 55)
    # cab front/rear (shared ±z zone): glazing + warm interior
    zone = L.W_CRANE_F
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=YELLOW, ao=AO_BASE - 6, rough=150, metal=60)
    h = y1 - y0
    gy0, gy1 = y0 + int(h * 0.46), y0 + int(h * 0.62)
    m.d.rectangle([x0 + 24, gy0, x1 - 24, gy1], fill=(22, 30, 36),
                  outline=STEEL_DK, width=3)
    m.e.rectangle([x0 + 30, gy0 + 6, x1 - 60, gy1 - 6], fill=(150, 105, 55))
    hazard_row(m, x0, y0 + int(h * 0.9), x1, y1 - 4, step=24)
    # boom wrap: yellow, black tip band, rust at the pivot end
    x0, y0, x1, y1 = L.W_BOOM
    fill(m, (x0, y0, x1, y1), dif=YELLOW, ao=AO_BASE - 8, rough=155, metal=70)
    m.d.rectangle([x1 - 70, y0, x1, y1], fill=BLACKISH)
    for fx in np.linspace(0.12, 0.8, 5):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 3, y0, sx + 3, y1], fill=shade(YELLOW, 0.62))
        m.o.rectangle([sx - 3, y0, sx + 3, y1], fill=(AO_SEAM, R_STEEL, 90))
    # pedestal wrap: bolted marine steel
    x0, y0, x1, y1 = L.W_PED
    fill(m, (x0, y0, x1, y1), dif=(92, 97, 103), ao=AO_BASE - 12,
         rough=160, metal=165)
    bolts(m, [(x0 + (x1 - x0) * fx, y0 + 10)
              for fx in np.linspace(0.05, 0.95, 12)], base=(92, 97, 103))
    for fx in np.linspace(0.125, 0.875, 4):
        sx = x0 + (x1 - x0) * fx
        seam_v(m, int(sx), y0 + 2, y1 - 2, (92, 97, 103), hi=False)
    # hook block: safety yellow + steel sheave
    zone = L.W_HOOK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=YELLOW, ao=AO_BASE - 10, rough=150,
         metal=110)
    ccx, ccy = (x0 + x1) / 2, (y0 + y1) / 2
    m.d.ellipse([ccx - 34, ccy - 34, ccx + 34, ccy + 34], fill=STEEL_DK)
    m.d.ellipse([ccx - 10, ccy - 10, ccx + 10, ccy + 10], fill=(140, 144, 148))
    m.o.ellipse([ccx - 34, ccy - 34, ccx + 34, ccy + 34],
                fill=(AO_BASE - 18, 130, 200))


def paint_fittings(m):
    # rails/masts: galvanized
    x0, y0, x1, y1 = L.W_RAIL
    fill(m, (x0, y0, x1, y1), dif=GALV, ao=AO_BASE - 8, rough=158, metal=175)
    m.d.rectangle([x0, (y0 + y1) // 2 - 2, x1, (y0 + y1) // 2 + 2],
                  fill=shade(GALV, 0.8))
    # cleats/tie rod/cables: worn dark steel, greasy
    x0, y0, x1, y1 = L.W_CLEAT
    fill(m, (x0, y0, x1, y1), dif=(58, 61, 66), ao=AO_BASE - 18,
         rough=132, metal=200)
    for fx in np.linspace(0.1, 0.9, 6):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 2, y0, sx + 2, y1], fill=shade((58, 61, 66), 0.75))
    # fenders: ribbed rubber (u runs along the fender axis)
    x0, y0, x1, y1 = L.W_FENDER
    fill(m, (x0, y0, x1, y1), dif=RUBBER, ao=AO_BASE - 22, rough=218, metal=0)
    for fx in np.linspace(0.12, 0.88, 5):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 4, y0, sx + 4, y1], fill=shade(RUBBER, 1.5))
        m.o.rectangle([sx - 4, y0, sx + 4, y1], fill=(AO_BASE - 10, 205, 0))
    # crates: strapped supply boxes
    zone = L.W_CRATE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=CRATEC, ao=AO_BASE - 8, rough=200, metal=25)
    m.d.rectangle([x0, y0, x1 - 1, y1 - 1], outline=shade(CRATEC, 0.6),
                  width=5)
    seam_h(m, x0 + 4, x1 - 4, (y0 + y1) // 2, CRATEC, hi=False)
    for fx in (0.3, 0.7):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 4, y0, sx + 4, y1], fill=STEEL_DK)
        m.o.rectangle([sx - 4, y0, sx + 4, y1], fill=(AO_SEAM, 140, 180))
    stencil(m, (x0 + 26, y0 + 44), 'MS-SUP', 30, shade(CRATEC, 0.5),
            bridge=False)
    stencil(m, (x0 + 26, y1 - 90), 'WHARF 07', 22, shade(CRATEC, 0.55),
            bridge=False)
    # beacon-mast lamp wrap: dark housing + red lens band (emissive)
    x0, y0, x1, y1 = L.W_LIGHT
    fill(m, (x0, y0, x1, y1), dif=(46, 49, 54), ao=AO_BASE - 12,
         rough=140, metal=150)
    m.d.rectangle([x0, y0 + 44, x1, y0 + 84], fill=(70, 20, 18))
    m.e.rectangle([x0, y0 + 48, x1, y0 + 80], fill=(255, 62, 40))
    # dark cell
    fill(m, L.W_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=205, metal=40)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_deck(m)
    paint_walkway(m)
    paint_pontoons(m)
    paint_fascia(m)
    paint_crane(m)
    paint_fittings(m)

    # ── weathering ──
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=77)
    wx.crevice_grime(m.dif, 0.5)
    # deck: salt dust + traffic grime, oil at the crane and crate stage
    wx.mud_band(L.W_DECK.rect, 0.26, fade=None, spatter=True)
    wx.oily((int(du(L.PED_XZ[1]) - 90), int(dv(L.PED_XZ[0]) - 80),
             int(du(L.PED_XZ[1]) + 90), int(dv(L.PED_XZ[0]) + 80)), 0.55)
    wx.oily((int(du(11.6)), int(dv(-0.4)), int(du(14.2)), int(dv(2.4))), 0.4)
    # rust blooming around every cleat pad, streaking over the berth edge
    for cz in L.CLEATS:
        wx.rust_blotch(du(cz), dv(L.CLEAT_X), 10, strength=0.6)
    # pontoons: growth band at the waterline, streaks from the deck drains
    px0, py0, px1, py1 = L.W_PONT.rect
    band_y = int(py0 + (py1 - py0) * (1.7 - 1.02) / 1.8)
    wx.mud_band((px0, band_y, px1, py1), 0.75, fade=None, spatter=True)
    for fx in np.linspace(0.05, 0.95, 14):
        wx.rust_streak(px0 + (px1 - px0) * fx, py0 + 12,
                       40 + (int(fx * 100) * 7) % 50, width=3.0, strength=0.45)
    wx.plate_bottom_rust((px0, py0, px1, band_y), n=9, strength=0.55)
    fx0, fy0, fx1, fy1 = L.W_PONT_F.rect
    band_yf = int(fy0 + (fy1 - fy0) * (1.7 - 1.02) / 1.8)
    wx.mud_band((fx0, band_yf, fx1, fy1), 0.7, fade=None)
    wx.rust_streak((fx0 + fx1) / 2, fy0 + 12, 44, width=3.2, strength=0.4)
    # fascias: scupper rust streaks
    for rect in (L.W_DECKSIDE.rect, L.W_DECKEND.rect):
        rx0, ry0, rx1, ry1 = rect
        wx.mud_band(rect, 0.4, fade='down', dust=0.3)
        wx.plate_bottom_rust(rect, n=8, strength=0.6)
    # crane: work wear, greasy hook cable
    wx.mud_band(L.W_CRANE.rect, 0.22, fade='down', spatter=False)
    wx.rust_streak(L.W_BOOM[0] + 30, L.W_BOOM[1] + 8, 30, width=3.0,
                   strength=0.5)
    wx.oily(L.W_CLEAT, 0.5)
    wx.mud_band(L.W_WALK.rect, 0.3, fade=None, spatter=True)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.55)
    wx.apply(m)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    # deck plate seams recessed, anti-slip strips proud, section gaps deep
    dx0, dy0, dx1, dy1 = L.W_DECK.rect
    for wz in np.arange(-12.85, 14.9, 2.45):
        hm.line((du(wz), dy0 + 2), (du(wz), dy1 - 2), -0.4, width=3)
    for wx_ in (-1.15, 1.15):
        hm.line((dx0 + 8, dv(wx_)), (dx1 - 8, dv(wx_)), 0.45, width=8)
    for gz in (-5.0, 5.0):
        hm.rect((du(gz - 0.15), dy0, du(gz + 0.15), dy1), -2.2)
    # walkway grating cross-hatch
    gx0, gy0, gx1, gy1 = L.W_WALK.rect
    for gx in range(int(gx0), int(gx1), 16):
        hm.line((gx, gy0), (gx + 24, gy1), 0.3, width=2)
        hm.line((gx + 24, gy0), (gx, gy1), 0.3, width=2)
    # pontoon weld seams + boot-top ridge
    px0, py0, px1, py1 = L.W_PONT.rect
    for fx in np.linspace(0.06, 0.94, 12):
        hm.line((px0 + (px1 - px0) * fx, py0 + 2),
                (px0 + (px1 - px0) * fx, band_y), -0.35, width=2)
    hm.rect((px0, band_y - 8, px1, band_y), 0.25)
    # fender ribs
    fx0, fy0, fx1, fy1 = L.W_FENDER
    for fx in np.linspace(0.12, 0.88, 5):
        sx = fx0 + (fx1 - fx0) * fx
        hm.rect((sx - 4, fy0, sx + 4, fy1), 0.6)
    hm.crevices_from(m.dif, 0.6)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.6).save(f'{OUT}/{STEM}_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save(f'{OUT}/{STEM}_diffuse.png')
    m.orm.save(f'{OUT}/{STEM}_orm.png')
    m.emi.save(f'{OUT}/{STEM}_emissive.png')
    m.tea.save(f'{OUT}/{STEM}_team.png')
    print(f'[paint_ms_pontoon_wharf] full 2048 texture set written to {OUT}/')


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    paint_all()
