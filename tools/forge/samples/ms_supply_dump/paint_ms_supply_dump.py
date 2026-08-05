"""paint_ms_supply_dump — 1024² PBR set for ms_supply_dump.

Staging-post read: rutted dirt/gravel pad with tyre tracks and fuel
stains, plank-and-batten wood crates with steel corner brackets + team
patch, olive ammo boxes with latches, ribbed steel drums with a team
band and rust streaks, black rubber fuel bladders with seam ribs +
hazard patch, weathered pallets, galvanised pipes, hazard-chevron
concrete barriers, and an olive canvas tarp with webbing straps, field
patches and a team corner stripe.  No emissive — a dump doesn't glow
(map ships black per the export contract).
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import ms_supply_dump_layout as L      # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges,
                   jit, shade, BOLT_LOG,
                   STEEL, STEEL_DK, YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_RUBBER,
                   M_ARMOR, M_STEEL, RNG)

W = 1024
DIRT    = (126, 118, 104)
DIRT_DK = (104, 96, 84)
WOOD    = (148, 118, 80)
WOOD_DK = (108, 84, 56)
OLIVE   = (94, 98, 72)
OLIVE_DK = (72, 76, 56)
DRUMC   = (96, 102, 106)
RUBBER  = (52, 50, 48)
CANVAS  = (118, 112, 84)
GALV    = (152, 156, 160)
CONC    = (140, 138, 130)


def paint_pad(m):
    x0, y0, x1, y1 = L.PAD_T
    fill(m, (x0, y0, x1, y1), dif=DIRT, ao=AO_BASE - 6, rough=215, metal=0)
    # gravel speckle
    for _ in range(900):
        px = RNG.uniform(x0, x1 - 2)
        py = RNG.uniform(y0, y1 - 2)
        c = jit(shade(DIRT, RNG.uniform(0.82, 1.16)), 6)
        m.d.rectangle([px, py, px + RNG.uniform(1, 3), py + RNG.uniform(1, 3)],
                      fill=c)
    # tyre ruts: two passes curving through the yard
    for (fx0, fx1, wob) in ((0.22, 0.34, 14), (0.58, 0.70, 22)):
        pts_a, pts_b = [], []
        for t in np.linspace(0, 1, 12):
            wx = x0 + (x1 - x0) * (fx0 + (fx1 - fx0) * t)
            wx += np.sin(t * 5.2) * wob
            wy = y0 + (y1 - y0) * t
            pts_a.append((wx, wy))
            pts_b.append((wx + 26, wy))
        for pts in (pts_a, pts_b):
            m.d.line(pts, fill=shade(DIRT_DK, 0.96), width=9)
            m.o.line(pts, fill=(AO_BASE - 22, 228, 0), width=9)
    # packed patches under the prop clusters
    for _ in range(26):
        px = RNG.uniform(x0, x1 - 40)
        py = RNG.uniform(y0, y1 - 40)
        rw, rh = RNG.uniform(14, 44), RNG.uniform(10, 34)
        m.d.ellipse([px, py, px + rw, py + rh],
                    fill=jit(shade(DIRT, RNG.uniform(0.88, 1.06)), 4))
    wear_edges(m, (x0, y0, x1, y1), DIRT, 40)
    # pad edge band
    fill(m, L.PAD_S, dif=shade(DIRT_DK, 0.9), ao=AO_BASE - 18, rough=225,
         metal=0)


def paint_crates(m):
    # ── wood crate side ──
    x0, y0, x1, y1 = L.CRATE_S
    fill(m, (x0, y0, x1, y1), dif=WOOD, ao=AO_BASE - 4, rough=205, metal=12)
    n_planks = 5
    for i in range(n_planks):
        py0 = y0 + (y1 - y0) * i / n_planks
        py1 = y0 + (y1 - y0) * (i + 1) / n_planks
        m.d.rectangle([x0, py0, x1, py1],
                      fill=jit(shade(WOOD, 0.88 + 0.07 * (i % 3)), 5))
        m.d.line([(x0, py1), (x1, py1)], fill=WOOD_DK, width=2)
        m.o.line([(x0, py1), (x1, py1)], fill=(AO_SEAM, 205, 12), width=2)
        # grain streaks
        for _ in range(6):
            gx = RNG.uniform(x0 + 4, x1 - 30)
            gy = RNG.uniform(py0 + 2, py1 - 2)
            m.d.line([(gx, gy), (gx + RNG.uniform(10, 26), gy)],
                     fill=shade(WOOD, RNG.uniform(0.8, 1.12)), width=1)
    # end battens + steel corner brackets
    for bx in (x0 + 8, x1 - 26):
        m.d.rectangle([bx, y0 + 2, bx + 18, y1 - 2], fill=jit(WOOD_DK, 5))
        m.o.rectangle([bx, y0 + 2, bx + 18, y1 - 2], fill=(AO_BASE - 14, 205, 12))
    for (cx, cy) in ((x0 + 6, y0 + 6), (x1 - 20, y0 + 6),
                     (x0 + 6, y1 - 20), (x1 - 20, y1 - 20)):
        m.d.rectangle([cx, cy, cx + 14, cy + 14], fill=STEEL_DK)
        m.o.rectangle([cx, cy, cx + 14, cy + 14], fill=(AO_BASE - 8, R_STEEL, M_STEEL))
    bolts(m, [(x0 + 13, y0 + 13), (x1 - 13, y0 + 13),
              (x0 + 13, y1 - 13), (x1 - 13, y1 - 13)], r=2, base=WOOD)
    # team quartermaster patch (mask, punched by weathering later)
    m.d.rectangle([x0 + 118, y0 + 46, x0 + 150, y0 + 78], fill=TEAMGREY)
    m.t.rectangle([x0 + 118, y0 + 46, x0 + 150, y0 + 78], fill=(255, 0, 0))
    m.d.rectangle([x0 + 118, y0 + 46, x0 + 150, y0 + 78],
                  outline=shade(WOOD_DK, 0.8))
    # mirror-safe stencil bar (no glyphs)
    m.d.rectangle([x0 + 40, y0 + 54, x0 + 104, y0 + 70], fill=jit(WOOD_DK, 4))
    m.d.rectangle([x0 + 40, y0 + 74, x0 + 84, y0 + 84], fill=jit(WOOD_DK, 4))
    wear_edges(m, (x0, y0, x1, y1), WOOD, 44)

    # ── wood crate top ──
    x0, y0, x1, y1 = L.CRATE_T
    fill(m, (x0, y0, x1, y1), dif=shade(WOOD, 0.94), ao=AO_BASE - 6,
         rough=210, metal=12)
    for i in range(4):
        px = x0 + (x1 - x0) * i / 4
        m.d.rectangle([px, y0, px + (x1 - x0) / 4, y1],
                      fill=jit(shade(WOOD, 0.86 + 0.08 * (i % 2)), 5))
        m.d.line([(px, y0), (px, y1)], fill=WOOD_DK, width=2)
        m.o.line([(px, y0), (px, y1)], fill=(AO_SEAM, 210, 12), width=2)
    # two steel straps across
    for fy in (0.3, 0.72):
        sy = y0 + (y1 - y0) * fy
        m.d.rectangle([x0, sy - 4, x1, sy + 4], fill=STEEL_DK)
        m.d.line([(x0, sy - 4), (x1, sy - 4)], fill=shade(STEEL, 1.15))
        m.o.rectangle([x0, sy - 4, x1, sy + 4], fill=(AO_BASE - 8, R_STEEL, M_STEEL))
    wear_edges(m, (x0, y0, x1, y1), WOOD, 30)

    # ── ammo box side ──
    x0, y0, x1, y1 = L.AMMO_S
    fill(m, (x0, y0, x1, y1), dif=OLIVE, ao=AO_BASE - 4, rough=175, metal=70)
    m.d.line([(x0, y0 + (y1 - y0) * 0.3), (x1, y0 + (y1 - y0) * 0.3)],
             fill=OLIVE_DK, width=3)                    # lid seam
    m.o.line([(x0, y0 + (y1 - y0) * 0.3), (x1, y0 + (y1 - y0) * 0.3)],
             fill=(AO_SEAM, 175, 70), width=3)
    for fx in (0.26, 0.74):                             # latches
        lx = x0 + (x1 - x0) * fx
        m.d.rectangle([lx - 8, y0 + (y1 - y0) * 0.22, lx + 8,
                       y0 + (y1 - y0) * 0.52], fill=STEEL_DK)
        m.o.rectangle([lx - 8, y0 + (y1 - y0) * 0.22, lx + 8,
                       y0 + (y1 - y0) * 0.52], fill=(AO_BASE - 10, R_STEEL, M_STEEL))
    # hazard ticks bottom-left + team square
    for i in range(3):
        m.d.polygon([(x0 + 10 + i * 16, y1 - 8), (x0 + 18 + i * 16, y1 - 8),
                     (x0 + 12 + i * 16, y1 - 22), (x0 + 4 + i * 16, y1 - 22)],
                    fill=YELLOW if i % 2 == 0 else BLACKISH)
    m.d.rectangle([x1 - 40, y0 + 14, x1 - 14, y0 + 40], fill=TEAMGREY)
    m.t.rectangle([x1 - 40, y0 + 14, x1 - 14, y0 + 40], fill=(255, 0, 0))
    m.d.rectangle([x0 + 36, y0 + 16, x0 + 110, y0 + 30], fill=jit(OLIVE_DK, 4))
    bolts(m, [(x0 + 8, y0 + 8), (x1 - 8, y0 + 8)], r=2, base=OLIVE)
    wear_edges(m, (x0, y0, x1, y1), OLIVE, 36)

    # ── ammo box top ──
    x0, y0, x1, y1 = L.AMMO_T
    fill(m, (x0, y0, x1, y1), dif=shade(OLIVE, 0.95), ao=AO_BASE - 5,
         rough=180, metal=70)
    for fy in (0.33, 0.66):
        seam_h(m, x0 + 4, x1 - 4, int(y0 + (y1 - y0) * fy), OLIVE)
    m.d.rectangle([x0 + (x1 - x0) // 2 - 30, y0 + 20,
                   x0 + (x1 - x0) // 2 + 30, y0 + 44], fill=jit(OLIVE_DK, 4))
    wear_edges(m, (x0, y0, x1, y1), OLIVE, 24)


def paint_drums(m):
    # side wrap: v = height (v0 top), u = around
    x0, y0, x1, y1 = L.DRUM_W
    fill(m, (x0, y0, x1, y1), dif=DRUMC, ao=AO_BASE - 5, rough=150, metal=160)
    # vertical shading facets around the circumference
    for i in range(6):
        fx = x0 + (x1 - x0) * i / 6
        m.d.rectangle([fx, y0, fx + (x1 - x0) / 6, y1],
                      fill=jit(shade(DRUMC, 0.9 + 0.05 * (i % 3)), 3))
    # rolling ribs at 1/3 and 2/3 height
    for fy in (0.33, 0.66):
        ry = y0 + (y1 - y0) * fy
        m.d.rectangle([x0, ry - 3, x1, ry + 3], fill=shade(DRUMC, 1.18))
        m.d.line([(x0, ry + 4), (x1, ry + 4)], fill=shade(DRUMC, 0.6))
        m.o.rectangle([x0, ry - 3, x1, ry + 3], fill=(AO_BASE - 12, 140, 170))
    # team band between the ribs (fuel-type flash)
    by0 = y0 + (y1 - y0) * 0.42
    by1 = y0 + (y1 - y0) * 0.56
    m.d.rectangle([x0, by0, x1, by1], fill=TEAMGREY)
    m.t.rectangle([x0, by0, x1, by1], fill=(255, 0, 0))
    m.d.line([(x0, by0), (x1, by0)], fill=shade(DRUMC, 0.6))
    m.d.line([(x0, by1), (x1, by1)], fill=shade(DRUMC, 0.6))
    # small hazard diamond
    dx, dy = x0 + 40, y0 + (y1 - y0) * 0.82
    m.d.polygon([(dx, dy - 12), (dx + 12, dy), (dx, dy + 12), (dx - 12, dy)],
                fill=YELLOW)
    m.d.rectangle([x0, y1 - 10, x1, y1], fill=shade(DRUMC, 0.72))
    wear_edges(m, (x0, y0, x1, y1), DRUMC, 40)

    # lid
    x0, y0, x1, y1 = L.DRUM_T
    fill(m, (x0, y0, x1, y1), dif=shade(DRUMC, 0.94), ao=AO_BASE - 8,
         rough=150, metal=150)
    m.d.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2],
                  outline=shade(DRUMC, 0.62), width=4)
    m.o.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2],
                  outline=(AO_SEAM, 150, 150), width=4)
    cy = (y0 + y1) / 2
    for fx, r in ((0.36, 12), (0.64, 8)):               # bungs
        bx = x0 + (x1 - x0) * fx
        m.d.ellipse([bx - r, cy - r, bx + r, cy + r], fill=STEEL_DK)
        m.d.ellipse([bx - r + 3, cy - r + 3, bx + r - 3, cy + r - 3],
                    outline=shade(STEEL, 1.1))
        m.o.ellipse([bx - r, cy - r, bx + r, cy + r],
                    fill=(AO_BASE - 14, R_STEEL, M_STEEL))
    wear_edges(m, (x0, y0, x1, y1), DRUMC, 24)


def paint_pallets(m):
    x0, y0, x1, y1 = L.PALLET_S
    fill(m, (x0, y0, x1, y1), dif=shade(WOOD, 0.8), ao=AO_BASE - 16,
         rough=215, metal=8)
    for i in range(9):                                   # slat / gap rhythm
        sx = x0 + (x1 - x0) * i / 9
        if i % 2:
            m.d.rectangle([sx, y0, sx + (x1 - x0) / 9, y1], fill=BLACKISH)
            m.o.rectangle([sx, y0, sx + (x1 - x0) / 9, y1],
                          fill=(AO_DEEP, 215, 8))
        else:
            m.d.rectangle([sx, y0, sx + (x1 - x0) / 9, y1],
                          fill=jit(shade(WOOD, 0.72 + 0.1 * (i % 4)), 6))
    x0, y0, x1, y1 = L.PALLET_T
    fill(m, (x0, y0, x1, y1), dif=shade(WOOD, 0.85), ao=AO_BASE - 10,
         rough=215, metal=8)
    for i in range(7):
        py = y0 + (y1 - y0) * i / 7
        m.d.rectangle([x0, py, x1, py + (y1 - y0) / 7],
                      fill=jit(shade(WOOD, 0.74 + 0.09 * (i % 3)), 6))
        if i:
            m.d.line([(x0, py), (x1, py)], fill=BLACKISH, width=3)
            m.o.line([(x0, py), (x1, py)], fill=(AO_DEEP, 215, 8), width=3)
    wear_edges(m, (x0, y0, x1, y1), WOOD, 40)


def paint_tarp(m):
    x0, y0, x1, y1 = L.TARP_TOP
    fill(m, (x0, y0, x1, y1), dif=CANVAS, ao=AO_BASE - 4, rough=228, metal=0)
    # fold shading: soft wandering streaks along x (drape direction)
    for fy in np.linspace(0.06, 0.94, 14):
        yy = y0 + (y1 - y0) * fy
        pts = []
        for t in np.linspace(0, 1, 10):
            pts.append((x0 + (x1 - x0) * t,
                        yy + np.sin(t * 6.3 + fy * 12) * 6))
        m.d.line(pts, fill=jit(shade(CANVAS, 0.9 if int(fy * 14) % 2 else 1.08), 3),
                 width=3)
    # webbing straps with buckles (run across the drape)
    for fx in (0.3, 0.68):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 5, y0, sx + 5, y1], fill=shade(OLIVE_DK, 0.85))
        m.o.rectangle([sx - 5, y0, sx + 5, y1], fill=(AO_BASE - 12, 220, 10))
        for fy in (0.2, 0.5, 0.8):
            by = y0 + (y1 - y0) * fy
            m.d.rectangle([sx - 7, by - 5, sx + 7, by + 5], fill=STEEL_DK)
            m.o.rectangle([sx - 7, by - 5, sx + 7, by + 5],
                          fill=(AO_BASE - 8, R_STEEL, M_STEEL))
    # field patches
    for (fx, fy, pw, phh) in ((0.14, 0.32, 44, 34), (0.52, 0.7, 36, 30),
                              (0.82, 0.18, 30, 26)):
        px = x0 + (x1 - x0) * fx
        py = y0 + (y1 - y0) * fy
        m.d.rectangle([px, py, px + pw, py + phh], fill=jit(shade(CANVAS, 0.86), 5))
        m.d.rectangle([px, py, px + pw, py + phh], outline=shade(CANVAS, 0.7))
    # team corner stripe (quartermaster flash)
    m.d.rectangle([x1 - 26, y0, x1 - 6, y1], fill=TEAMGREY)
    m.t.rectangle([x1 - 26, y0, x1 - 6, y1], fill=(255, 0, 0))
    m.d.rectangle([x1 - 26, y0, x1 - 6, y1], outline=shade(CANVAS, 0.7))
    # hem shadow border
    m.d.rectangle([x0 + 1, y0 + 1, x1 - 1, y1 - 1],
                  outline=shade(CANVAS, 0.72), width=3)
    wear_edges(m, (x0, y0, x1, y1), CANVAS, 36)
    # underside
    x0, y0, x1, y1 = L.TARP_UND
    fill(m, (x0, y0, x1, y1), dif=shade(CANVAS, 0.6), ao=AO_BASE - 40,
         rough=235, metal=0)


def paint_bladders(m):
    x0, y0, x1, y1 = L.BLAD_S
    fill(m, (x0, y0, x1, y1), dif=RUBBER, ao=AO_BASE - 10, rough=190, metal=8)
    for i in range(9):                                   # heat-welded seams
        sx = x0 + (x1 - x0) * (i + 0.5) / 9
        m.d.line([(sx, y0 + 4), (sx, y1 - 4)], fill=shade(RUBBER, 1.35), width=2)
        m.o.line([(sx, y0 + 4), (sx, y1 - 4)], fill=(AO_BASE - 4, 175, 8), width=2)
    # hazard panel
    m.d.rectangle([x0 + 24, y0 + 24, x0 + 92, y0 + 62], fill=jit(YELLOW, 8))
    m.d.rectangle([x0 + 34, y0 + 32, x0 + 82, y0 + 54], fill=BLACKISH)
    m.d.rectangle([x0, y1 - 12, x1, y1], fill=shade(RUBBER, 0.8))
    x0, y0, x1, y1 = L.BLAD_T
    fill(m, (x0, y0, x1, y1), dif=shade(RUBBER, 1.08), ao=AO_BASE - 6,
         rough=185, metal=8)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for rr in (44, 70, 96):                              # bulge creases
        m.d.ellipse([cx - rr, cy - rr * 0.55, cx + rr, cy + rr * 0.55],
                    outline=shade(RUBBER, 1.22), width=2)
    m.d.ellipse([cx - 14, cy - 14, cx + 14, cy + 14], fill=STEEL_DK)   # filler
    m.d.ellipse([cx - 9, cy - 9, cx + 9, cy + 9], outline=shade(STEEL, 1.15),
                width=2)
    m.o.ellipse([cx - 14, cy - 14, cx + 14, cy + 14],
                fill=(AO_BASE - 10, R_STEEL, M_STEEL))


def paint_pipes_conc(m):
    x0, y0, x1, y1 = L.PIPE_W
    fill(m, (x0, y0, x1, y1), dif=GALV, ao=AO_BASE - 4, rough=125, metal=190)
    for fx in (0.06, 0.94):                              # end flanges
        fxp = x0 + (x1 - x0) * fx
        m.d.rectangle([fxp - 6, y0, fxp + 6, y1], fill=shade(GALV, 0.7))
        m.o.rectangle([fxp - 6, y0, fxp + 6, y1], fill=(AO_BASE - 14, 140, 190))
    for _ in range(20):                                  # length streaks
        gy = RNG.uniform(y0 + 4, y1 - 4)
        gx = RNG.uniform(x0 + 10, x1 - 70)
        m.d.line([(gx, gy), (gx + RNG.uniform(20, 60), gy)],
                 fill=jit(shade(GALV, RNG.uniform(0.88, 1.08)), 4))
    wear_edges(m, (x0, y0, x1, y1), GALV, 24)

    x0, y0, x1, y1 = L.CONC_S
    fill(m, (x0, y0, x1, y1), dif=CONC, ao=AO_BASE - 5, rough=195, metal=0)
    # hazard chevron band across the lower third
    bz = y1 - (y1 - y0) // 3
    step = 24
    for i in range(int((x1 - x0) / step) + 2):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * step, bz), (x0 + (i + 1) * step, bz),
                     (x0 + (i + 1) * step - 12, y1), (x0 + i * step - 12, y1)],
                    fill=c)
    for fx in (0.25, 0.75):                              # lifting holes
        hx = x0 + (x1 - x0) * fx
        m.d.ellipse([hx - 9, y0 + 18, hx + 9, y0 + 34], fill=BLACKISH)
        m.o.ellipse([hx - 9, y0 + 18, hx + 9, y0 + 34], fill=(AO_DEEP, 195, 0))
    wear_edges(m, (x0, y0, x1, y1), CONC, 50)
    x0, y0, x1, y1 = L.CONC_T
    fill(m, (x0, y0, x1, y1), dif=shade(CONC, 0.94), ao=AO_BASE - 6,
         rough=200, metal=0)
    seam_v(m, (x0 + x1) // 2, y0 + 2, y1 - 2, CONC)

    fill(m, L.DARK, dif=BLACKISH, ao=AO_DEEP, rough=210, metal=30)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_pad(m)
    paint_crates(m)
    paint_drums(m)
    paint_pallets(m)
    paint_tarp(m)
    paint_bladders(m)
    paint_pipes_conc(m)

    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=90210)
    wx.crevice_grime(m.dif, 0.35)
    # ground-contact mud on everything that stands in the dirt
    for rect, s in ((L.CRATE_S, 0.4), (L.AMMO_S, 0.35), (L.DRUM_W, 0.5),
                    (L.BLAD_S, 0.45), (L.CONC_S, 0.4), (L.PALLET_S, 0.55)):
        x0, y0, x1, y1 = rect
        wx.mud_band((x0, y0, x1, y1), s, fade='down', dust=0.2)
    # yard dirt + oil where the fuel lives (pad UV = world map:
    # u=(x+4.9)/9.8, v=(z+4.9)/9.8 across the 384px cell)
    px0, py0, px1, py1 = L.PAD_T

    def pad_rect(wx0, wz0, wx1, wz1):
        sx = (px1 - px0) / 9.8
        return (px0 + (wx0 + 4.9) * sx, py0 + (wz0 + 4.9) * sx,
                px0 + (wx1 + 4.9) * sx, py0 + (wz1 + 4.9) * sx)

    wx.mud_band((px0, py0, px1, py1), 0.22, fade=None, spatter=True)
    wx.oily(pad_rect(2.8, 2.9, 4.7, 4.6), 0.55)         # drum cluster 1
    wx.oily(pad_rect(0.5, 3.1, 3.1, 4.6), 0.4)          # drum cluster 2
    wx.oily(pad_rect(2.3, -0.9, 4.5, 2.1), 0.35)        # bladders
    wx.oily((L.DRUM_T[0] + 20, L.DRUM_T[1] + 20,
             L.DRUM_T[2] - 20, L.DRUM_T[3] - 20), 0.3)
    # drum rust: streaks off the ribs + bottom blotches
    x0, y0, x1, y1 = L.DRUM_W
    for fx in np.linspace(0.08, 0.92, 7):
        wx.rust_streak(x0 + (x1 - x0) * fx, y0 + (y1 - y0) * 0.33,
                       18 + int(fx * 20), width=2.2, strength=0.35)
    wx.plate_bottom_rust((x0, y0, x1, y1), n=7, strength=0.55)
    wx.plate_bottom_rust(L.AMMO_S, n=4, strength=0.35)
    wx.plate_bottom_rust(L.CONC_S, n=4, strength=0.3)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.45)
    wx.apply(m)

    from normals import HeightMap
    hm = HeightMap()
    # plank grooves
    x0, y0, x1, y1 = L.CRATE_S
    for i in range(1, 5):
        gy = y0 + (y1 - y0) * i / 5
        hm.line((x0 + 2, gy), (x1 - 2, gy), -0.5, width=2)
    x0, y0, x1, y1 = L.CRATE_T
    for i in range(1, 4):
        gx = x0 + (x1 - x0) * i / 4
        hm.line((gx, y0 + 2), (gx, y1 - 2), -0.5, width=2)
    x0, y0, x1, y1 = L.PALLET_T
    for i in range(1, 7):
        gy = y0 + (y1 - y0) * i / 7
        hm.line((x0 + 2, gy), (x1 - 2, gy), -0.6, width=3)
    # drum ribs raised
    x0, y0, x1, y1 = L.DRUM_W
    for fy in (0.33, 0.66):
        hm.line((x0 + 2, y0 + (y1 - y0) * fy), (x1 - 2, y0 + (y1 - y0) * fy),
                0.55, width=4)
    # tarp straps + soft fold ridges
    x0, y0, x1, y1 = L.TARP_TOP
    for fx in (0.3, 0.68):
        hm.line((x0 + (x1 - x0) * fx, y0 + 2), (x0 + (x1 - x0) * fx, y1 - 2),
                0.35, width=6)
    for fy in np.linspace(0.1, 0.9, 7):
        hm.line((x0 + 4, y0 + (y1 - y0) * fy), (x1 - 4, y0 + (y1 - y0) * fy),
                0.2, width=5)
    # bladder seams
    x0, y0, x1, y1 = L.BLAD_S
    for i in range(9):
        sx = x0 + (x1 - x0) * (i + 0.5) / 9
        hm.line((sx, y0 + 4), (sx, y1 - 4), 0.3, width=2)
    hm.crevices_from(m.dif, 0.5)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=3.6).save('out/ms_supply_dump_normals.png')

    # no emissive — supply dumps don't glow (map stays black)
    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.5))
    m.dif.save('out/ms_supply_dump_diffuse.png')
    m.orm.save('out/ms_supply_dump_orm.png')
    m.emi.save('out/ms_supply_dump_emissive.png')
    m.tea.save('out/ms_supply_dump_team.png')
    print('[paint_ms_supply_dump] full 1024 texture set written to out/')


if __name__ == '__main__':
    paint_all()
