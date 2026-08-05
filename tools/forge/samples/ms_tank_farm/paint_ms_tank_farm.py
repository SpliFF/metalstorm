"""paint_ms_tank_farm — 2048² PBR set for ms_tank_farm.

Fuel-depot read at unit-consistent texel density: three pale plated
storage tanks with course seams, hazard base band, level gauge and big
FUEL ident, sloped roof with radial ribs, steel wind-girder walkway,
stained bund concrete with form-tie rows, pipework with flange collars,
red valve handwheels, tread/rail spiral-stair ribbons, DANGER-FLAMMABLE
placards, safety-yellow post tops. Weathering: rust streaks off the
girder and shell courses, plate-bottom rust, oil pools under the header
and export line, crevice grime. Team mask: shell crown band + cabinet
door patch (R channel, never baked into diffuse).
"""
from __future__ import annotations
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

import ms_tank_farm_layout as T   # sets meshlib.ATLAS = 2048
import meshlib
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
meshlib.ATLAS = 2048              # paint.py imports layout; keep zone math 2048

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   stencil, jit, shade, BOLT_LOG,
                   ARMOR, STEEL, STEEL_DK, YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, M_ARMOR, M_STEEL, FONT, RNG)

if not os.path.exists(FONT):      # macOS fallback (checker.py precedent)
    P.FONT = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'

W = 2048
SHELL    = (152, 150, 144)        # pale tank plate (fable_factory silo kin)
ROOFC    = (118, 121, 118)
SKIRTC   = (99, 97, 93)
CONCRETE = (148, 146, 140)
BUNDC    = (137, 135, 129)
PIPEC    = (104, 108, 112)
GIRDC    = (90, 94, 100)
VALVE_R  = (152, 52, 40)          # painted valve red
CABC     = (82, 90, 84)


def _font(size):
    return ImageFont.truetype(P.FONT, size)


# ── tanks ────────────────────────────────────────────────────────────────

def paint_tanks(m):
    # shell wrap: u around all 10 facets, v down (top of rect = shell top)
    x0, y0, x1, y1 = T.TANKW
    fill(m, (x0, y0, x1, y1), dif=SHELL, ao=AO_BASE - 6, rough=165,
         metal=120)
    fw = (x1 - x0) / 10.0
    # per-facet tonal plates + vertical weld seams at facet edges
    for i in range(10):
        fx0 = x0 + fw * i
        m.d.rectangle([fx0 + 1, y0, fx0 + fw - 1, y1],
                      fill=jit(shade(SHELL, 1.0 - 0.03 * (i % 3)), 2))
        seam_v(m, int(fx0), y0 + 2, y1 - 2, SHELL, hi=False)
    # horizontal course seams (three plate courses)
    for fy in (0.27, 0.52, 0.77):
        seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * fy), SHELL)
    # team crown band just under the shell top edge
    m.t.rectangle([x0, y0 + 10, x1, y0 + 44], fill=(255, 0, 0))
    m.d.rectangle([x0, y0 + 10, x1, y0 + 44], fill=TEAMGREY)
    m.d.rectangle([x0, y0 + 44, x1, y0 + 50], fill=shade(SHELL, 0.62))
    # hazard band above the base course
    hb0, hb1 = y1 - 92, y1 - 64
    m.d.rectangle([x0, hb0, x1, hb1], fill=YELLOW)
    for i in range(int((x1 - x0) / 28) + 1):
        m.d.polygon([(x0 + i * 28, hb1), (x0 + i * 28 + 14, hb0),
                     (x0 + i * 28 + 28, hb0), (x0 + i * 28 + 14, hb1)],
                    fill=BLACKISH)
    # big product ident on two facets (reads once per tank silhouette)
    f = _font(110)
    for ux in (x0 + fw * 1.1, x0 + fw * 6.1):
        m.d.text((ux + 4, y0 + 190 + 4), 'FUEL', font=f,
                 fill=shade(SHELL, 0.55))
        m.d.text((ux, y0 + 190), 'FUEL', font=f, fill=(196, 74, 40))
    f2 = _font(44)
    m.d.text((x0 + fw * 3.55, y0 + 236), '07', font=f2,
             fill=shade(SHELL, 0.5))
    # level gauge: dark channel + green fill mark on one facet
    gx = x0 + fw * 8.4
    m.d.rectangle([gx, y0 + 90, gx + 22, y1 - 100], fill=(40, 44, 48))
    m.o.rectangle([gx, y0 + 90, gx + 22, y1 - 100],
                  fill=(AO_SEAM, R_STEEL, M_STEEL))
    m.d.rectangle([gx + 4, y0 + (y1 - y0) * 0.55, gx + 18, y1 - 104],
                  fill=(90, 170, 90))
    # NO SMOKING stencil low on a facet
    stencil(m, (x0 + fw * 4.2, y1 - 150), 'NO SMOKING', 26,
            shade(SHELL, 0.5), bridge=False)
    wear_edges(m, (x0, y0, x1, y1), SHELL, 70)

    # roof slope wrap: darker, radial rib per facet edge
    x0, y0, x1, y1 = T.ROOFW
    fill(m, (x0, y0, x1, y1), dif=ROOFC, ao=AO_BASE - 10, rough=185,
         metal=110)
    fw = (x1 - x0) / 10.0
    for i in range(10):
        sx = int(x0 + fw * i)
        m.d.line([(sx, y0 + 2), (sx, y1 - 2)], fill=shade(ROOFC, 0.7),
                 width=3)
    m.d.rectangle([x0, y1 - 8, x1, y1], fill=shade(ROOFC, 0.62))  # drip edge

    # roof cap plate: ring seams, centre manway + bolt circle
    r = T.TANK_TOP.rect
    fill(m, r, dif=shade(ROOFC, 1.04), ao=AO_BASE - 8, rough=185, metal=110)
    ccx, ccy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    for rr in (150, 100):
        m.d.ellipse([ccx - rr, ccy - rr, ccx + rr, ccy + rr],
                    outline=shade(ROOFC, 0.75), width=3)
    m.d.ellipse([ccx - 34, ccy - 34, ccx + 34, ccy + 34], fill=STEEL_DK)
    m.d.ellipse([ccx - 26, ccy - 26, ccx + 26, ccy + 26],
                fill=shade(STEEL_DK, 1.25))
    bolts(m, [(ccx + np.cos(a) * 44, ccy + np.sin(a) * 44)
              for a in np.linspace(0.3, 2 * np.pi + 0.3, 8, endpoint=False)],
          base=ROOFC)
    wear_edges(m, r, ROOFC, 30)

    # foundation skirt: stained concrete ring
    x0, y0, x1, y1 = T.SKIRTW
    fill(m, (x0, y0, x1, y1), dif=SKIRTC, ao=AO_BASE - 20, rough=205,
         metal=10)
    for fx in np.linspace(0.1, 0.9, 5):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 2, y1 - 2, SKIRTC, hi=False)
    m.d.rectangle([x0, y0, x1, y0 + 6], fill=shade(SKIRTC, 0.7))

    # wind girder: steel walkway band with support ticks + toe line
    x0, y0, x1, y1 = T.GIRDW
    fill(m, (x0, y0, x1, y1), dif=GIRDC, ao=AO_BASE - 14, rough=160,
         metal=170)
    m.d.rectangle([x0, y0, x1, y0 + 10], fill=YELLOW)   # painted toe rail
    for gx in range(int(x0) + 24, int(x1), 48):
        m.d.line([(gx, y0 + 12), (gx, y1 - 2)], fill=shade(GIRDC, 0.68),
                 width=3)
    wear_edges(m, (x0, y0, x1, y1), GIRDC, 30)


# ── site concrete ────────────────────────────────────────────────────────

def _pad_px(x, z):
    """World (x,z) -> PADT pixels."""
    r = T.PADT.rect
    u = r[0] + (x + 16.2) / 32.4 * (r[2] - r[0])
    v = r[1] + (z + 8.4) / 16.8 * (r[3] - r[1])
    return u, v


def paint_pad(m):
    r = T.PADT.rect
    x0, y0, x1, y1 = r
    fill(m, r, dif=CONCRETE, ao=AO_BASE - 4, rough=205, metal=8)
    # expansion joints
    for fx in np.linspace(0.1, 0.9, 9):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 2, y1 - 2, CONCRETE,
               hi=False)
    for fy in np.linspace(0.2, 0.8, 4):
        seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * fy), CONCRETE,
               hi=False)
    # tonal patches
    for _ in range(16):
        bx = x0 + RNG.random() * (x1 - x0 - 110)
        by = y0 + RNG.random() * (y1 - y0 - 50)
        m.d.polygon([(bx, by + 10), (bx + 80, by), (bx + 104, by + 34),
                     (bx + 22, by + 46)], fill=jit(shade(CONCRETE, 0.94), 3))
    # tank ring shadows on the pad (AO only — flat-shade cheat)
    for (tx, tz) in T.TANKS:
        cu, cv = _pad_px(tx, tz)
        rr = 4.35 / 32.4 * (x1 - x0)
        rz = 4.35 / 16.8 * (y1 - y0)
        m.o.ellipse([cu - rr, cv - rz, cu + rr, cv + rz],
                    fill=(AO_BASE - 40, 205, 8))
    # export-line lane: yellow edge lines + chevrons toward the flange
    lu0, lv0 = _pad_px(-1.5, -4.0)
    lu1, lv1 = _pad_px(1.5, -8.35)
    m.d.rectangle([lu0, lv1, lu1, lv0], outline=YELLOW, width=5)
    ccx = (lu0 + lu1) / 2
    for i in range(3):
        yy = lv1 + 20 + i * 26
        m.d.polygon([(ccx - 34, yy + 14), (ccx, yy), (ccx + 34, yy + 14),
                     (ccx + 34, yy + 24), (ccx, yy + 10), (ccx - 34, yy + 24)],
                    fill=YELLOW)
    # site code near the apron
    f = _font(64)
    nu, nv = _pad_px(11.0, -7.6)
    m.d.text((nu, nv), 'TF-07', font=f, fill=shade(CONCRETE, 0.7))
    # hazard edging along the pad front lip (apron side)
    eu0, ev0 = _pad_px(-16.2, -8.4)
    eu1, ev1 = _pad_px(16.2, -8.0)
    for i in range(int((eu1 - eu0) / 20) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(eu0 + i * 20, ev0), (eu0 + i * 20 + 20, ev0),
                     (eu0 + i * 20 + 10, ev1), (eu0 + i * 20 - 10, ev1)],
                    fill=c)
    # pad side skirt
    r = T.PADS.rect
    x0, y0, x1, y1 = r
    fill(m, r, dif=shade(CONCRETE, 0.9), ao=AO_BASE - 14, rough=210, metal=5)
    seam_h(m, x0, x1, y0 + (y1 - y0) // 3, CONCRETE, hi=False)


def paint_bund(m):
    # sloped outer/inner faces (shared rect for both orientations)
    r = T.BUND_OX.rect
    x0, y0, x1, y1 = r
    fill(m, r, dif=BUNDC, ao=AO_BASE - 10, rough=208, metal=6)
    # form joints + tie holes in two rows
    for fx in np.linspace(0.06, 0.94, 12):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 2, y1 - 2, BUNDC, hi=False)
    for fy in (0.35, 0.7):
        yy = y0 + (y1 - y0) * fy
        for fx in np.linspace(0.09, 0.91, 11):
            xx = x0 + (x1 - x0) * fx
            m.d.ellipse([xx - 3, yy - 3, xx + 3, yy + 3],
                        fill=shade(BUNDC, 0.72))
    # weathered crown line
    m.d.rectangle([x0, y0, x1, y0 + 8], fill=shade(BUNDC, 0.85))
    wear_edges(m, r, BUNDC, 60)
    # coping: pale concrete + yellow safety edge striping
    r = T.BUND_TOP.rect
    x0, y0, x1, y1 = r
    fill(m, r, dif=shade(BUNDC, 1.06), ao=AO_BASE - 6, rough=205, metal=6)
    for fx in np.linspace(0.05, 0.95, 14):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 2, y1 - 2, BUNDC, hi=False)
    m.d.rectangle([x0, y0, x1, y0 + 7], fill=YELLOW)
    m.d.rectangle([x0, y1 - 7, x1, y1], fill=YELLOW)
    wear_edges(m, r, BUNDC, 40)


# ── pipework, valves, kit ────────────────────────────────────────────────

def paint_pipes(m):
    # parametric pipe wrap: u along each segment, v around
    x0, y0, x1, y1 = T.PIPEW
    fill(m, (x0, y0, x1, y1), dif=PIPEC, ao=AO_BASE - 14, rough=150,
         metal=175)
    # flange collars at both segment ends + a mid weld line
    for fx in (0.03, 0.97):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 7, y0, sx + 7, y1], fill=shade(PIPEC, 0.66))
        m.o.rectangle([sx - 7, y0, sx + 7, y1],
                      fill=(AO_SEAM, R_STEEL, M_STEEL))
    m.d.line([(x0 + (x1 - x0) * 0.5, y0), (x0 + (x1 - x0) * 0.5, y1)],
             fill=shade(PIPEC, 0.78), width=2)
    # product colour ring code (fuel = red-brown band near u0)
    m.d.rectangle([x0 + (x1 - x0) * 0.12, y0, x0 + (x1 - x0) * 0.15, y1],
                  fill=(150, 60, 40))
    # top-of-pipe sheen along v centreline
    m.d.line([(x0, (y0 + y1) / 2), (x1, (y0 + y1) / 2)],
             fill=shade(PIPEC, 1.14), width=2)

    # valve handwheels: painted red rim + spoked top cap
    x0, y0, x1, y1 = T.WHEELW
    fill(m, (x0, y0, x1, y1), dif=VALVE_R, ao=AO_BASE - 10, rough=140,
         metal=90)
    m.d.rectangle([x0, y0, x1, y0 + 8], fill=shade(VALVE_R, 1.2))
    x0, y0, x1, y1 = T.WHEELC
    fill(m, (x0, y0, x1, y1), dif=VALVE_R, ao=AO_BASE - 8, rough=140,
         metal=90)
    ccx, ccy = (x0 + x1) / 2, (y0 + y1) / 2
    rr = (x1 - x0) / 2 - 6
    m.d.ellipse([ccx - rr, ccy - rr, ccx + rr, ccy + rr],
                outline=shade(VALVE_R, 0.7), width=4)
    for a in np.linspace(0, np.pi, 3, endpoint=False):   # 6 spokes
        m.d.line([(ccx - np.cos(a) * rr, ccy - np.sin(a) * rr),
                  (ccx + np.cos(a) * rr, ccy + np.sin(a) * rr)],
                 fill=shade(VALVE_R, 0.62), width=5)
    m.d.ellipse([ccx - 10, ccy - 10, ccx + 10, ccy + 10], fill=STEEL_DK)


def paint_stair(m):
    x0r, sy0, x1r, sy1 = T.STAIR
    h = sy1 - sy0
    # tread band (top-face ribbon): galvanised steel, yellow nosing per tread
    t0, t1 = sy0 + 4, sy0 + int(h * 0.42)
    fill(m, (x0r, t0, x1r, t1), dif=(96, 100, 106), ao=AO_BASE - 12,
         rough=170, metal=150)
    step = 24
    for gx in range(int(x0r) + 6, int(x1r), step):
        m.d.rectangle([gx, t0, gx + 3, t1], fill=YELLOW)
        m.d.rectangle([gx + 3, t0, gx + 6, t1],
                      fill=shade((96, 100, 106), 0.7))
    # rail band: galvanised pickets + yellow handrail along the top edge
    r0, r1 = sy0 + int(h * 0.5), sy1 - 4
    fill(m, (x0r, r0, x1r, r1), dif=(104, 108, 114), ao=AO_BASE - 12,
         rough=160, metal=160)
    m.d.rectangle([x0r, r0, x1r, r0 + 12], fill=YELLOW)      # handrail
    for gx in range(int(x0r) + 12, int(x1r), 40):            # pickets
        m.d.line([(gx, r0 + 12), (gx, r1)], fill=shade((104, 108, 114), 0.6),
                 width=3)
    # landing plate: chequer ticks + yellow border
    r = T.LAND
    fill(m, r, dif=(64, 68, 74), ao=AO_BASE - 10, rough=165, metal=150)
    for gy in range(r[1] + 10, r[3] - 8, 18):
        for gx in range(r[0] + 10 + (gy // 18 % 2) * 9, r[2] - 8, 18):
            m.d.line([(gx, gy), (gx + 6, gy)], fill=shade((64, 68, 74), 1.25),
                     width=2)
    m.d.rectangle([r[0] + 2, r[1] + 2, r[2] - 2, r[3] - 2], outline=YELLOW,
                  width=4)


def paint_kit(m):
    # roof hatch: steel lid, hinge seam, corner bolts, hazard edge
    r = T.HATCH.rect
    fill(m, r, dif=(96, 99, 104), ao=AO_BASE - 10, rough=150, metal=170)
    x0, y0, x1, y1 = r
    m.d.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2], outline=YELLOW, width=5)
    seam_h(m, x0 + 8, x1 - 8, (y0 + y1) // 2, (96, 99, 104), hi=False)
    bolts(m, [(x0 + 14, y0 + 14), (x1 - 14, y0 + 14), (x0 + 14, y1 - 14),
              (x1 - 14, y1 - 14)], base=(96, 99, 104))
    # vent turbine: galvanised, vertical louvre slots
    x0, y0, x1, y1 = T.VENTW
    fill(m, (x0, y0, x1, y1), dif=(126, 130, 134), ao=AO_BASE - 8,
         rough=140, metal=180)
    vent_slots(m, [x0 + 6, y0 + 14, x1 - 6, y1 - 10], 6, horizontal=False)
    r = T.VENT_TOP.rect
    fill(m, r, dif=(126, 130, 134), ao=AO_BASE - 8, rough=140, metal=180)
    ccx, ccy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    rr = (r[2] - r[0]) / 2 - 8
    for a in np.linspace(0, 2 * np.pi, 8, endpoint=False):   # spinner vanes
        m.d.polygon([(ccx, ccy),
                     (ccx + np.cos(a) * rr, ccy + np.sin(a) * rr),
                     (ccx + np.cos(a + 0.5) * rr, ccy + np.sin(a + 0.5) * rr)],
                    fill=shade((126, 130, 134), 0.82 + 0.12 * (a % 2)))
    m.d.ellipse([ccx - 8, ccy - 8, ccx + 8, ccy + 8], fill=STEEL_DK)
    # control cabinet: door seam, louvres, warning label, team patch
    r = T.CAB.rect
    x0, y0, x1, y1 = r
    fill(m, r, dif=CABC, ao=AO_BASE - 10, rough=170, metal=140)
    seam_v(m, (x0 + x1) // 2, y0 + 8, y1 - 8, CABC)
    vent_slots(m, [x0 + 16, y1 - 44, (x0 + x1) // 2 - 10, y1 - 16], 3)
    m.d.polygon([(x1 - 74, y0 + 60), (x1 - 52, y0 + 24), (x1 - 30, y0 + 60)],
                fill=YELLOW)                     # lightning-warning triangle
    m.d.line([(x1 - 52, y0 + 34), (x1 - 52, y0 + 52)], fill=BLACKISH,
             width=4)
    m.t.rectangle([x0 + 16, y0 + 20, x0 + 70, y0 + 52], fill=(255, 0, 0))
    m.d.rectangle([x0 + 16, y0 + 20, x0 + 70, y0 + 52], fill=TEAMGREY)
    wear_edges(m, r, CABC, 30)
    # post/stem/bollard wrap: dark base, safety-yellow top third
    r = T.TRIM.rect
    x0, y0, x1, y1 = r
    fill(m, r, dif=(56, 59, 64), ao=AO_BASE - 12, rough=165, metal=150)
    yx = x0 + int((x1 - x0) * 0.62)
    m.d.rectangle([yx, y0, x1, y1], fill=YELLOW)
    m.d.rectangle([yx - 5, y0, yx, y1], fill=BLACKISH)
    wear_edges(m, (yx, y0, x1, y1), YELLOW, 40)
    # crossover steps: dark steel, tread-edge lines at each step height
    r = T.STEP.rect
    x0, y0, x1, y1 = r
    fill(m, r, dif=(60, 64, 68), ao=AO_BASE - 12, rough=170, metal=150)
    for fy in (0.18, 0.42, 0.66, 0.9):
        yy = int(y0 + (y1 - y0) * fy)
        m.d.rectangle([x0, yy, x1, yy + 4], fill=YELLOW)
        m.o.line([(x0, yy), (x1, yy)], fill=(AO_SEAM, R_STEEL, M_STEEL),
                 width=2)
    # cap cell: blind-flange plate (shared by export flange + bollard caps)
    r = T.DARK.rect
    fill(m, r, dif=(58, 61, 66), ao=AO_DEEP + 30, rough=180, metal=150)
    ccx, ccy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    rr = (r[2] - r[0]) / 2 - 8
    m.d.ellipse([ccx - rr, ccy - rr, ccx + rr, ccy + rr],
                outline=shade((58, 61, 66), 1.3), width=3)
    m.d.ellipse([ccx - rr * 0.45, ccy - rr * 0.45,
                 ccx + rr * 0.45, ccy + rr * 0.45], fill=BLACKISH)
    bolts(m, [(ccx + np.cos(a) * rr * 0.72, ccy + np.sin(a) * rr * 0.72)
              for a in np.linspace(0.4, 2 * np.pi + 0.4, 6, endpoint=False)],
          base=(58, 61, 66))


def paint_placard(m):
    """UN-style DANGER FLAMMABLE board: red-orange diamond + flame glyph."""
    x0, y0, x1, y1 = T.PLACARD
    fill(m, (x0, y0, x1, y1), dif=(206, 202, 192), ao=AO_BASE - 6,
         rough=180, metal=40)
    m.d.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2],
                  outline=shade((206, 202, 192), 0.7), width=3)
    ccx, ccy = (x0 + x1) / 2, y0 + (y1 - y0) * 0.42
    s = (x1 - x0) * 0.4
    dia = [(ccx, ccy - s), (ccx + s, ccy), (ccx, ccy + s), (ccx - s, ccy)]
    m.d.polygon(dia, fill=(196, 74, 40), outline=BLACKISH)
    # flame glyph (triangle tongues over a base bar)
    fy = ccy - s * 0.32
    for dx, hh in ((-14, 20), (0, 32), (14, 22)):
        m.d.polygon([(ccx + dx - 8, fy), (ccx + dx, fy - hh),
                     (ccx + dx + 8, fy)], fill=BLACKISH)
    m.d.rectangle([ccx - 26, fy, ccx + 26, fy + 8], fill=BLACKISH)
    f = _font(22)
    m.d.text((ccx - 22, ccy + s * 0.1), '3', font=f, fill=BLACKISH)
    f = _font(20)
    m.d.text((x0 + 16, y1 - 54), 'DANGER', font=f, fill=(150, 40, 30))
    m.d.text((x0 + 16, y1 - 30), 'FLAMMABLE', font=f, fill=BLACKISH)
    bolts(m, [(x0 + 10, y0 + 10), (x1 - 10, y0 + 10)],
          base=(206, 202, 192))


# ── assembly ─────────────────────────────────────────────────────────────

def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_tanks(m)
    paint_pad(m)
    paint_bund(m)
    paint_pipes(m)
    paint_stair(m)
    paint_kit(m)
    paint_placard(m)

    # ── weathering ──
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=61)
    wx.crevice_grime(m.dif, 0.42)
    # shell: rust streaks off the girder line + course seams, base rust
    x0, y0, x1, y1 = T.TANKW
    for i in range(9):
        sx = x0 + (x1 - x0) * (i + 0.5 + 0.3 * (i % 2)) / 9
        wx.rust_streak(sx, y0 + 50, 30 + (i * 11) % 40, width=2.6,
                       strength=0.35)
        wx.rust_streak(sx + 20, y0 + (y1 - y0) * 0.52, 26 + (i * 7) % 24,
                       width=2.2, strength=0.3)
    wx.plate_bottom_rust((x0, y0, x1, y1), n=10, strength=0.6)
    wx.mud_band((x0, y0, x1, y1), 0.3, fade='down', dust=0.3)
    # skirt + bund: heavy ground grime, streaks off the coping
    wx.mud_band(T.SKIRTW, 0.6, fade='down')
    wx.mud_band(T.BUND_OX.rect, 0.42, fade='down', dust=0.3)
    bx0, by0, bx1, by1 = T.BUND_OX.rect
    for fx in (0.15, 0.38, 0.63, 0.86):
        wx.rust_streak(bx0 + (bx1 - bx0) * fx, by0 + 12, 40, width=3.0,
                       strength=0.3)
    # pad: oil pools under the header run and export line, dusty edges
    wx.mud_band(T.PADT.rect, 0.2, fade=None, spatter=True)
    hu, hv = _pad_px(-5.5, -4.2)
    hu2, hv2 = _pad_px(5.5, -3.0)
    wx.oily((hu, hv, hu2, hv2), 0.5)
    eu, ev = _pad_px(-1.2, -8.3)
    eu2, ev2 = _pad_px(1.2, -5.2)
    wx.oily((eu, ev2, eu2, ev), 0.45)
    for (tx, tz) in T.TANKS:                     # drips at each outlet
        ou, ov = _pad_px(tx, -3.4)
        wx.oily((ou - 30, ov - 18, ou + 30, ov + 18), 0.4)
    wx.mud_band(T.PADS.rect, 0.5, fade='down')
    # pipes + girder oil sheen, soot on the vent turbine
    wx.oily(T.PIPEW, 0.35)
    wx.oily(T.GIRDW, 0.2)
    wx.soot_patch(T.VENTW, 0.35)
    wx.soot_patch(T.VENT_TOP.rect, 0.3)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(T), fraction=0.5)
    wx.apply(m)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    # shell course seams recessed, facet welds raised
    x0, y0, x1, y1 = T.TANKW
    fw = (x1 - x0) / 10.0
    for i in range(10):
        hm.line((x0 + fw * i, y0 + 2), (x0 + fw * i, y1 - 2), 0.35, width=2)
    for fy in (0.27, 0.52, 0.77):
        hm.line((x0 + 2, y0 + (y1 - y0) * fy), (x1 - 2, y0 + (y1 - y0) * fy),
                -0.5, width=3)
    # girder band raised lip
    hm.rect((T.GIRDW[0], T.GIRDW[1], T.GIRDW[2], T.GIRDW[1] + 10), 0.5)
    # pad + bund joints recessed
    px0, py0, px1, py1 = T.PADT.rect
    for fx in np.linspace(0.1, 0.9, 9):
        hm.line((px0 + (px1 - px0) * fx, py0 + 2),
                (px0 + (px1 - px0) * fx, py1 - 2), -0.5, width=3)
    for fy in np.linspace(0.2, 0.8, 4):
        hm.line((px0 + 2, py0 + (py1 - py0) * fy),
                (px1 - 2, py0 + (py1 - py0) * fy), -0.5, width=3)
    for fx in np.linspace(0.06, 0.94, 12):
        hm.line((bx0 + (bx1 - bx0) * fx, by0 + 2),
                (bx0 + (bx1 - bx0) * fx, by1 - 2), -0.4, width=2)
    hm.crevices_from(m.dif, 0.55)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.4).save('out/ms_tank_farm_normals.png')

    # emissive: none — unmanned fuel site, spec calls out no glow
    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save('out/ms_tank_farm_diffuse.png')
    m.orm.save('out/ms_tank_farm_orm.png')
    m.emi.save('out/ms_tank_farm_emissive.png')
    m.tea.save('out/ms_tank_farm_team.png')
    print('[paint_ms_tank_farm] full 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
