"""paint_ms_tank_wreck — 1024² PBR set for ms_tank_wreck.

Fire-scorched read: the tank's olive drab burnt down to charred
grey-brown, soot flaring up from the open turret ring, hatches and
exhausts, big bare-rust blooms where the paint cooked off, ash-dark
track runs, kinked barrel heat-blued at the bend.  NO team colour
(mask ships black), NO emissive — a dead tank doesn't glow.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import ms_tank_wreck_layout as L       # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024
import paintlib as PL

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges,
                   jit, shade, BOLT_LOG,
                   STEEL, STEEL_DK, YELLOW, BLACKISH,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, M_ARMOR, M_STEEL, RNG)

W = 1024
BURNT   = (104, 98, 82)     # cooked olive drab
BURNT_DK = (80, 75, 64)
CHAR    = (48, 44, 39)      # charred metal
RUST    = (136, 80, 48)     # bare rust bloom
RUST_DK = (98, 58, 36)
TRACKC  = (70, 67, 62)      # ash-dark track steel
STEEL_BARE = (120, 118, 112)


def scorched_fill(m, rect, base=BURNT, rough=205, metal=90, ao=AO_BASE - 8):
    """Base coat + mottle: cooked paint with char blotches + rust freckle."""
    x0, y0, x1, y1 = rect
    fill(m, rect, dif=base, ao=ao, rough=rough, metal=metal)
    for _ in range(int((x1 - x0) * (y1 - y0) / 900)):
        px = RNG.uniform(x0, x1 - 6)
        py = RNG.uniform(y0, y1 - 6)
        r = RNG.uniform(3, 14)
        pick = RNG.uniform(0, 1)
        c = CHAR if pick < 0.45 else (RUST_DK if pick < 0.7 else
                                      jit(shade(base, RNG.uniform(0.8, 1.15)), 6))
        m.d.ellipse([px, py, px + r, py + r * 0.7], fill=jit(c, 5))
    wear_edges(m, rect, base, 60)


def panel_lines(m, rect, nx, ny, base=BURNT):
    x0, y0, x1, y1 = rect
    for i in range(1, nx):
        seam_v(m, int(x0 + (x1 - x0) * i / nx), y0 + 2, y1 - 2, base)
    for j in range(1, ny):
        seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * j / ny), base)


def paint_hull(m):
    # top deck: panels, scorch fan from the open turret ring area
    r = L.Z_HULL_TOP.rect
    scorched_fill(m, r)
    panel_lines(m, r, 2, 4)
    x0, y0, x1, y1 = r
    bolts(m, [(x0 + 14, y0 + 14), (x1 - 14, y0 + 14),
              (x0 + 14, y1 - 14), (x1 - 14, y1 - 14),
              ((x0 + x1) // 2, y0 + 12), ((x0 + x1) // 2, y1 - 12)],
          r=3, base=BURNT)
    # torn turret-ring opening: charred ellipse w/ ragged rust lip (deck
    # centre, where the turret used to sit — window z≈0.3 → v≈0.53)
    cx = (x0 + x1) / 2
    cy = y0 + (y1 - y0) * 0.53
    for rr, c in ((86, RUST_DK), (78, CHAR), (62, BLACKISH)):
        m.d.ellipse([cx - rr, cy - rr * 0.92, cx + rr, cy + rr * 0.92],
                    fill=jit(c, 4))
    m.o.ellipse([cx - 62, cy - 57, cx + 62, cy + 57], fill=(AO_DEEP, 220, 60))
    for a in np.linspace(0, 2 * np.pi, 14, endpoint=False):
        ex = cx + np.cos(a) * RNG.uniform(80, 96)
        ey = cy + np.sin(a) * RNG.uniform(72, 88)
        m.d.ellipse([ex - 5, ey - 4, ex + 5, ey + 4], fill=jit(RUST, 8))

    # glacis / rear / sides: scorch base + panels
    scorched_fill(m, L.Z_GLACIS.rect)
    panel_lines(m, L.Z_GLACIS.rect, 3, 1)
    scorched_fill(m, L.Z_HULL_REAR.rect, base=shade(BURNT, 0.9))
    panel_lines(m, L.Z_HULL_REAR.rect, 3, 1)
    scorched_fill(m, L.Z_HULL_SIDE.rect, base=shade(BURNT, 0.95))
    panel_lines(m, L.Z_HULL_SIDE.rect, 5, 1)
    # dark under-hull
    fill(m, L.Z_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=225, metal=40)


def paint_tracks(m):
    r = L.Z_TRACK_SIDE.rect
    fill(m, r, dif=TRACKC, ao=AO_BASE - 14, rough=195, metal=150)
    x0, y0, x1, y1 = r
    # road-wheel discs, ash-grey with rusted rims
    for fx in np.linspace(0.14, 0.86, 6):
        wx_, wy = x0 + (x1 - x0) * fx, (y0 + y1) / 2 + 14
        m.d.ellipse([wx_ - 26, wy - 26, wx_ + 26, wy + 26],
                    fill=jit(shade(TRACKC, 1.18), 5))
        m.d.ellipse([wx_ - 26, wy - 26, wx_ + 26, wy + 26],
                    outline=jit(RUST_DK, 6), width=3)
        m.d.ellipse([wx_ - 8, wy - 8, wx_ + 8, wy + 8], fill=CHAR)
        m.o.ellipse([wx_ - 26, wy - 26, wx_ + 26, wy + 26],
                    fill=(AO_BASE - 20, 180, 160))
    wear_edges(m, r, TRACKC, 44)
    # tread wrap: link rhythm
    x0, y0, x1, y1 = L.TRACK_WRAP
    fill(m, L.TRACK_WRAP, dif=shade(TRACKC, 0.92), ao=AO_BASE - 18,
         rough=205, metal=140)
    n = 40
    for i in range(n):
        sx = x0 + (x1 - x0) * i / n
        m.d.rectangle([sx, y0, sx + 2, y1], fill=CHAR)
        m.o.rectangle([sx, y0, sx + 2, y1], fill=(AO_SEAM, 205, 140))
        if i % 2:
            m.d.rectangle([sx + 4, y0 + 8, sx + (x1 - x0) / n - 2, y1 - 8],
                          fill=jit(shade(TRACKC, 1.1), 4))
    # wheel wrap + cap for the loose road wheel
    fill(m, L.WHEEL_WRAP, dif=shade(TRACKC, 1.05), ao=AO_BASE - 12,
         rough=200, metal=150)
    x0, y0, x1, y1 = L.WHEEL_WRAP
    for fx in (0.25, 0.5, 0.75):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 2, y1 - 2, TRACKC)
    x0, y0, x1, y1 = L.HUB_CAP
    fill(m, L.HUB_CAP, dif=jit(shade(TRACKC, 1.15), 4), ao=AO_BASE - 10,
         rough=190, metal=160)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    m.d.ellipse([cx - 24, cy - 24, cx + 24, cy + 24], outline=RUST_DK, width=3)
    m.d.ellipse([cx - 7, cy - 7, cx + 7, cy + 7], fill=CHAR)


def paint_turret(m):
    scorched_fill(m, L.Z_TURRET_TOP.rect, base=shade(BURNT, 0.92))
    panel_lines(m, L.Z_TURRET_TOP.rect, 2, 3)
    x0, y0, x1, y1 = L.Z_TURRET_TOP.rect
    # blown commander hatch: charred hole
    hx, hy = x0 + (x1 - x0) * 0.36, y0 + (y1 - y0) * 0.62
    m.d.ellipse([hx - 26, hy - 26, hx + 26, hy + 26], fill=BLACKISH)
    m.d.ellipse([hx - 30, hy - 30, hx + 30, hy + 30], outline=jit(RUST_DK, 5),
                width=4)
    m.o.ellipse([hx - 26, hy - 26, hx + 26, hy + 26], fill=(AO_DEEP, 220, 60))
    scorched_fill(m, L.Z_TURRET_SIDE.rect, base=shade(BURNT, 0.88))
    panel_lines(m, L.Z_TURRET_SIDE.rect, 3, 1)
    scorched_fill(m, L.Z_TURRET_FRONT.rect, base=shade(BURNT, 0.85))
    scorched_fill(m, L.Z_TURRET_REAR.rect, base=shade(BURNT, 0.9))
    bolts(m, [(x0 + 12, y0 + 12), (x1 - 12, y0 + 12),
              (x0 + 12, y1 - 12), (x1 - 12, y1 - 12)], r=3, base=BURNT)


def paint_barrel(m):
    # wrap: cooked steel, heat-blued band near the kink (u ≈ mid-tube)
    x0, y0, x1, y1 = L.BARREL_WRAP
    fill(m, L.BARREL_WRAP, dif=shade(CHAR, 1.25), ao=AO_BASE - 10,
         rough=170, metal=170)
    for _ in range(30):                            # streaks along the tube
        gy = RNG.uniform(y0 + 4, y1 - 4)
        gx = RNG.uniform(x0 + 8, x1 - 90)
        m.d.line([(gx, gy), (gx + RNG.uniform(30, 80), gy)],
                 fill=jit(shade(CHAR, RNG.uniform(1.0, 1.7)), 6))
    # heat-blue/rust band where the barrel bent (~55% along)
    bx = x0 + (x1 - x0) * 0.55
    m.d.rectangle([bx - 24, y0, bx + 24, y1], fill=jit((78, 70, 92), 6))
    m.d.rectangle([bx - 40, y0, bx - 24, y1], fill=jit(RUST_DK, 6))
    m.d.rectangle([bx + 24, y0, bx + 40, y1], fill=jit(RUST, 6))
    # collar rings
    for fx in (0.06, 0.32):
        rx = x0 + (x1 - x0) * fx
        m.d.rectangle([rx - 5, y0, rx + 5, y1], fill=shade(CHAR, 0.8))
        m.o.rectangle([rx - 5, y0, rx + 5, y1], fill=(AO_SEAM, 170, 170))
    fill(m, L.Z_TUBE_CAP.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=120)
    x0, y0, x1, y1 = L.Z_TUBE_CAP.rect
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    m.d.ellipse([cx - 12, cy - 12, cx + 12, cy + 12], outline=CHAR, width=3)
    # breech block
    scorched_fill(m, L.Z_BREECH.rect, base=shade(CHAR, 1.15), metal=140,
                  rough=180)
    bolts(m, [(L.Z_BREECH.rect[0] + 10, L.Z_BREECH.rect[1] + 10),
              (L.Z_BREECH.rect[2] - 10, L.Z_BREECH.rect[3] - 10)],
          r=2, base=CHAR)


def paint_details(m):
    # shut hatch cell
    r = L.Z_HATCH.rect
    scorched_fill(m, r, base=shade(BURNT, 0.9))
    x0, y0, x1, y1 = r
    m.d.ellipse([(x0 + x1) / 2 - 8, (y0 + y1) / 2 - 8,
                 (x0 + x1) / 2 + 8, (y0 + y1) / 2 + 8], fill=CHAR)
    bolts(m, [(x0 + 8, y0 + 8), (x1 - 8, y0 + 8),
              (x0 + 8, y1 - 8), (x1 - 8, y1 - 8)], r=2, base=BURNT)
    # intake grille: charred slats
    x0, y0, x1, y1 = L.Z_INTAKE.rect
    fill(m, L.Z_INTAKE.rect, dif=CHAR, ao=AO_BASE - 16, rough=210, metal=80)
    for i in range(8):
        sy = y0 + (y1 - y0) * i / 8
        m.d.rectangle([x0 + 4, sy + 3, x1 - 4, sy + (y1 - y0) / 8 - 3],
                      fill=jit(BLACKISH, 4))
        m.o.rectangle([x0 + 4, sy + 3, x1 - 4, sy + (y1 - y0) / 8 - 3],
                      fill=(AO_DEEP, 210, 80))
    # exhaust ends: burnt-out dark + rust halo
    x0, y0, x1, y1 = L.Z_EXHAUST.rect
    fill(m, L.Z_EXHAUST.rect, dif=jit(RUST_DK, 5), ao=AO_BASE - 12,
         rough=200, metal=110)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    m.d.ellipse([cx - 22, cy - 22, cx + 22, cy + 22], fill=BLACKISH)
    m.o.ellipse([cx - 22, cy - 22, cx + 22, cy + 22], fill=(AO_DEEP, 200, 110))
    # debris plate cells: torn bare-metal plate
    fill(m, L.PLATE_S, dif=jit(shade(STEEL_BARE, 0.8), 5), ao=AO_BASE - 14,
         rough=185, metal=170)
    x0, y0, x1, y1 = L.PLATE_T
    fill(m, L.PLATE_T, dif=jit(STEEL_BARE, 4), ao=AO_BASE - 8,
         rough=180, metal=180)
    for _ in range(26):                            # scorch + rust mottling
        px = RNG.uniform(x0, x1 - 10)
        py = RNG.uniform(y0, y1 - 8)
        c = CHAR if RNG.uniform(0, 1) < 0.5 else jit(RUST, 8)
        m.d.ellipse([px, py, px + RNG.uniform(4, 14), py + RNG.uniform(3, 9)],
                    fill=jit(c, 5))
    m.d.rectangle([x0, y0, x1 - 1, y1 - 1], outline=RUST_DK, width=2)
    wear_edges(m, L.PLATE_T, STEEL_BARE, 70)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    # safety flood: any face whose UVs stray outside a painted cell reads
    # as charred metal, not the Maps() default background
    fill(m, (0, 0, W, W), dif=CHAR, ao=AO_BASE - 12, rough=210, metal=90)
    paint_hull(m)
    paint_tracks(m)
    paint_turret(m)
    paint_barrel(m)
    paint_details(m)

    # weathering: heavy soot + rust — this is the whole point of the model
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=90210)
    wx.crevice_grime(m.dif, 0.5)
    # soot fans: turret ring on deck, hatches, exhausts, turret top/side
    x0, y0, x1, y1 = L.Z_HULL_TOP.rect
    cx, cy = (x0 + x1) / 2, y0 + (y1 - y0) * 0.53
    wx.soot_patch((max(0, cx - 150), max(0, cy - 110),
                   min(W, cx + 150), min(W, cy + 100)), 0.85)
    wx.soot_patch((x0, y1 - 90, x1, y1), 0.5)              # engine deck aft
    wx.soot_patch(L.Z_HULL_REAR.rect, 0.6, fade='down')
    wx.soot_patch(L.Z_TURRET_TOP.rect, 0.55)
    wx.soot_patch(L.Z_TURRET_SIDE.rect, 0.5, fade='down')
    wx.soot_patch(L.Z_TURRET_FRONT.rect, 0.45)
    wx.soot_patch(L.Z_EXHAUST.rect, 0.7)
    wx.soot_patch(L.Z_GLACIS.rect, 0.35, fade='down')
    # bare-rust blooms on sides + glacis
    for (rect, count) in ((L.Z_HULL_SIDE.rect, 7), (L.Z_GLACIS.rect, 4),
                          (L.Z_TURRET_SIDE.rect, 4), (L.Z_HULL_TOP.rect, 6)):
        rx0, ry0, rx1, ry1 = rect
        for _ in range(count):
            wx.rust_blotch(RNG.uniform(rx0 + 20, rx1 - 20),
                           RNG.uniform(ry0 + 15, ry1 - 15),
                           RNG.uniform(14, 34), strength=0.8)
    for fx in np.linspace(0.1, 0.9, 6):                    # side streaks
        rx0, ry0, rx1, ry1 = L.Z_HULL_SIDE.rect
        wx.rust_streak(rx0 + (rx1 - rx0) * fx, ry0 + 10, 60,
                       width=2.6, strength=0.5)
    wx.plate_bottom_rust(L.Z_HULL_SIDE.rect, n=8, strength=0.7)
    wx.plate_bottom_rust(L.Z_TRACK_SIDE.rect, n=8, strength=0.8)
    # ground-contact mud on track + lower hull
    wx.mud_band(L.Z_TRACK_SIDE.rect, 0.6, fade='down', dust=0.25)
    wx.mud_band(L.Z_HULL_SIDE.rect, 0.35, fade='down', dust=0.2)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.7)

    from normals import HeightMap
    hm = HeightMap()
    # panel grooves on deck + sides
    x0, y0, x1, y1 = L.Z_HULL_TOP.rect
    for j in range(1, 4):
        hm.line((x0 + 2, y0 + (y1 - y0) * j / 4), (x1 - 2, y0 + (y1 - y0) * j / 4),
                -0.5, width=2)
    x0, y0, x1, y1 = L.TRACK_WRAP
    for i in range(40):                                    # track links
        sx = x0 + (x1 - x0) * i / 40
        hm.line((sx, y0 + 2), (sx, y1 - 2), -0.6, width=2)

    # NO team, NO emissive: masks stay black.
    PL.finish(m, L, 'ms_tank_wreck', hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
