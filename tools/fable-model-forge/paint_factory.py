"""paint_factory — 2048² PBR set for fable_factory.

Industrial read at unit-consistent texel density: corrugated siding with
a dark wainscot and faction team band, sawtooth roof with rib panels and
stack-rust streaks, segmented hazard gate with interior glow, lit office
windows, stained concrete pad with lane markings, yellow/black crane,
silo hazard bands, transformer yard warnings. Weathering: rust streaks
off every sill/flange, soot at stacks and fan, oil on the apron.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

import factory_layout as L        # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   stencil, jit, shade, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, LOWER, STEEL, STEEL_DK,
                   TRACK_MET, GLASS, YELLOW, BLACKISH, TEAMGREY, CYAN,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, FONT, RNG)

W = 2048
CONCRETE = (148, 146, 140)
SIDING = ARMOR
WAINSCOT = (58, 62, 68)
ROOFC = (84, 90, 97)
WARM = (255, 190, 120)


def corrugate(m, rect, base, step=10, shade_f=0.82):
    """Vertical corrugation ribs — the siding signature."""
    x0, y0, x1, y1 = rect
    for gx in range(int(x0) + step // 2, int(x1), step):
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)], fill=shade(base, shade_f),
                 width=2)


def rust_sills(wx, rect, ys, n=8):
    x0, y0, x1, y1 = rect
    for sy in ys:
        for i in range(n):
            sx = x0 + (x1 - x0) * (i + 0.5 + 0.3 * (i % 2)) / n
            wx.rust_streak(sx, sy, 24 + (i * 7) % 30, width=2.4,
                           strength=0.35)


def paint_walls(m):
    for zone, has_band in ((L.F_SIDE, True), (L.F_FRONT, True),
                           (L.F_REAR, True)):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=SIDING, ao=AO_BASE - 6, rough=R_ARMOR,
             metal=M_ARMOR)
        corrugate(m, (x0, y0, x1, y1), SIDING)
        # structural pilasters every ~4.6 m
        for fx in np.linspace(0.08, 0.92, 5):
            sx = x0 + (x1 - x0) * fx
            m.d.rectangle([sx - 4, y0 + 4, sx + 4, y1 - 4],
                          fill=shade(SIDING, 0.68))
            m.o.rectangle([sx - 4, y0 + 4, sx + 4, y1 - 4],
                          fill=(AO_SEAM, R_ARMOR, M_ARMOR))
        # dark wainscot (bottom ~2.2 m of wall)
        wy = int(y1 - (y1 - y0) * 0.21)
        m.d.rectangle([x0, wy, x1, y1], fill=WAINSCOT)
        m.o.rectangle([x0, wy, x1, y1], fill=(AO_BASE - 25, R_ARMOR, M_ARMOR))
        seam_h(m, x0, x1, wy, SIDING)
        # faction team band along the eave
        if has_band:
            m.t.rectangle([x0 + 4, y0 + 8, x1 - 4, y0 + 40], fill=(255, 0, 0))
            m.d.rectangle([x0 + 4, y0 + 8, x1 - 4, y0 + 40], fill=TEAMGREY)
        wear_edges(m, (x0, wy, x1, y1), WAINSCOT, 55)
    # plant code on the rear wall (single projection: no mirroring)
    zone = L.F_REAR
    x0, y0, x1, y1 = zone.rect
    f = ImageFont.truetype(FONT, 96)
    m.d.text((x0 + 96 + 3, y0 + 128 + 3), 'PLANT 07', font=f,
             fill=shade(SIDING, 0.55))
    m.d.text((x0 + 96, y0 + 128), 'PLANT 07', font=f, fill=(200, 204, 208))
    # painted personnel door + signage on the front wall
    zone = L.F_FRONT
    x0, y0, x1, y1 = zone.rect
    du, dv = zone.uv((6.0, 3.6, 0))
    du2, dv2 = zone.uv((4.6, 1.3, 0))
    m.d.rectangle([du * W, dv * W, du2 * W, dv2 * W], fill=(52, 56, 62),
                  outline=shade(SIDING, 0.5), width=3)
    m.o.rectangle([du * W, dv * W, du2 * W, dv2 * W],
                  fill=(AO_BASE - 25, R_ARMOR, M_ARMOR))
    m.e.rectangle([du * W + 6, dv * W - 14, du * W + 26, dv * W - 6],
                  fill=WARM)  # doorway lamp
    stencil(m, (du * W, dv * W - 40), 'CREW', 16, shade(SIDING, 1.3),
            bridge=False)


def paint_roof(m):
    zone = L.F_ROOF_S
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ROOFC, ao=AO_BASE - 10, rough=185,
         metal=120)
    corrugate(m, (x0, y0, x1, y1), ROOFC, step=12, shade_f=0.85)
    # panel seams + walk strip
    for fy in np.linspace(0.2, 0.8, 3):
        seam_h(m, x0 + 3, x1 - 3, int(y0 + (y1 - y0) * fy), ROOFC, hi=False)
    m.d.rectangle([x0 + 40, y0 + 10, x0 + 110, y1 - 10],
                  fill=shade(ROOFC, 1.12))
    # plant code sized to ONE sawtooth slope band (z 1.0..5.6 -> tooth 3)
    f = ImageFont.truetype(FONT, 42)
    tw = m.d.textlength('PLANT 07', font=f)
    ty = y0 + (y1 - y0) * ((3.3 + 8.6) / 20.2) - 21
    m.d.text(((x0 + x1) / 2 - tw / 2 + 2, ty + 2), 'PLANT 07', font=f,
             fill=shade(ROOFC, 0.6))
    m.d.text(((x0 + x1) / 2 - tw / 2, ty), 'PLANT 07', font=f,
             fill=(198, 202, 206))
    m.t.rectangle([x1 - 90, y0 + 8, x1 - 10, y1 - 8], fill=(255, 0, 0))
    m.d.rectangle([x1 - 90, y0 + 8, x1 - 10, y1 - 8], fill=TEAMGREY)
    wear_edges(m, (x0, y0, x1, y1), ROOFC, 45)
    # skylight glazing: mullion grid over dark teal glass, a few lit panes
    zone = L.F_SKY
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(56, 74, 84), ao=AO_BASE, rough=70,
         metal=0)
    # sky reflection gradient
    grad = Image.new('L', (1, y1 - y0), 0)
    for gy in range(y1 - y0):
        grad.putpixel((0, gy), int(70 * (1 - gy / max(1, y1 - y0 - 1))))
    m.dif.paste(Image.new('RGB', (x1 - x0, y1 - y0), (96, 118, 128)),
                (x0, y0), grad.resize((x1 - x0, y1 - y0)))
    n = 14
    for i in range(n + 1):
        gx = x0 + (x1 - x0) * i / n
        m.d.rectangle([gx - 4, y0, gx + 4, y1], fill=shade(SIDING, 0.8))
        m.o.rectangle([gx - 4, y0, gx + 4, y1], fill=(AO_BASE, R_STEEL, M_STEEL))
    m.d.rectangle([x0, y0, x1, y0 + 8], fill=shade(SIDING, 0.8))
    m.d.rectangle([x0, y1 - 8, x1, y1], fill=shade(SIDING, 0.8))
    for i in (4, 10):
        gx0 = x0 + (x1 - x0) * i / n + 5
        gx1 = x0 + (x1 - x0) * (i + 1) / n - 5
        m.e.rectangle([gx0, y0 + 12, gx1, y1 - 12], fill=(110, 76, 38))


def paint_pad(m):
    zone = L.F_PAD
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE - 4, rough=205,
         metal=8)
    # expansion joints
    for fx in np.linspace(0.125, 0.875, 7):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 2, y1 - 2, CONCRETE, hi=False)
    for fy in np.linspace(0.16, 0.84, 5):
        seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * fy), CONCRETE, hi=False)
    # tonal patches
    for _ in range(14):
        bx = x0 + RNG.random() * (x1 - x0 - 120)
        by = y0 + RNG.random() * (y1 - y0 - 60)
        m.d.polygon([(bx, by + 12), (bx + 90, by), (bx + 118, by + 40),
                     (bx + 26, by + 54)], fill=jit(shade(CONCRETE, 0.94), 3))
    # approach lane to the gate (door at world x -2, front edge)
    lu0, lv0 = zone.uv((-6.6, 0, -12.2))
    lu1, lv1 = zone.uv((2.6, 0, -6.0))
    m.d.rectangle([lu0 * W, lv0 * W, lu1 * W, lv1 * W],
                  outline=YELLOW, width=6)
    cx = (lu0 + lu1) / 2 * W
    for i in range(3):
        yy = lv0 * W + 26 + i * 34
        m.d.polygon([(cx - 60, yy + 18), (cx, yy), (cx + 60, yy + 18),
                     (cx + 60, yy + 30), (cx, yy + 12), (cx - 60, yy + 30)],
                    fill=YELLOW)
    # pad numeral + hazard edging at the front lip
    nu, nv = zone.uv((10.5, 0, -9.5))
    f = ImageFont.truetype(FONT, 72)
    m.d.text((nu * W, nv * W), '07', font=f, fill=shade(CONCRETE, 0.7))
    # tire tracks arcing to the gate
    for dx in (-26, 26):
        for t in range(40):
            a = t / 39
            tx = (lu0 + lu1) / 2 * W + dx + a * 8 * np.sin(a * 3)
            ty = lv1 * W + a * (y1 - lv1 * W - 20)
            m.d.ellipse([tx - 5, ty - 3, tx + 5, ty + 3],
                        fill=jit(shade(CONCRETE, 0.8), 4))
    zone = L.F_PADS
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CONCRETE, 0.92), ao=AO_BASE - 12,
         rough=210, metal=5)
    seam_h(m, x0, x1, y0 + (y1 - y0) // 3, CONCRETE, hi=False)
    for i in range(int((x1 - x0) / 18) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 18, y0 + 2), (x0 + i * 18 + 18, y0 + 2),
                     (x0 + i * 18 + 9, y0 + 12), (x0 + i * 18 - 9, y0 + 12)],
                    fill=c)


def paint_door(m):
    zone = L.F_DOOR
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(SIDING, 0.9), ao=AO_BASE - 8)
    # gate leaf: horizontal segments
    gu0, gv0 = zone.uv((2.2, 8.0, 0))
    gu1, gv1 = zone.uv((-6.2, 1.35, 0))
    gb = [gu0 * W, gv0 * W, gu1 * W, gv1 * W]
    m.d.rectangle(gb, fill=(70, 75, 82), outline=shade(SIDING, 0.5), width=4)
    m.o.rectangle(gb, fill=(AO_BASE - 18, R_ARMOR, M_ARMOR))
    n = 7
    for i in range(1, n):
        sy = gb[1] + (gb[3] - gb[1]) * i / n
        m.d.line([(gb[0] + 4, sy), (gb[2] - 4, sy)], fill=shade(SIDING, 0.55),
                 width=3)
        m.d.line([(gb[0] + 4, sy + 3), (gb[2] - 4, sy + 3)],
                 fill=shade(SIDING, 1.15), width=1)
    # faction chevron on the gate
    ccx = (gb[0] + gb[2]) / 2
    cy0 = gb[1] + (gb[3] - gb[1]) * 0.22
    chw = (gb[2] - gb[0]) * 0.26
    chh = (gb[3] - gb[1]) * 0.3
    poly = [(ccx - chw, cy0 + chh), (ccx, cy0), (ccx + chw, cy0 + chh),
            (ccx + chw, cy0 + chh + 18), (ccx, cy0 + 18),
            (ccx - chw, cy0 + chh + 18)]
    m.t.polygon(poly, fill=(255, 0, 0))
    m.d.polygon(poly, fill=TEAMGREY, outline=shade(SIDING, 0.5))
    # hazard border + interior glow slit under the gate
    for i in range(int((gb[2] - gb[0]) / 16) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(gb[0] + i * 16, gb[3] - 14), (gb[0] + i * 16 + 16, gb[3] - 14),
                     (gb[0] + i * 16 + 8, gb[3] - 2), (gb[0] + i * 16 - 8, gb[3] - 2)],
                    fill=c)
    m.e.rectangle([gb[0] + 8, gb[3] - 5, gb[2] - 8, gb[3]], fill=WARM)
    stencil(m, (gb[0] + 10, gb[1] - 22), 'BAY 01', 16, shade(SIDING, 1.3),
            bridge=False)
    bolts(m, [(x0 + 10, y0 + 10), (x1 - 10, y0 + 10), (x0 + 10, y1 - 10),
              (x1 - 10, y1 - 10)], base=SIDING)
    wear_edges(m, gb, (70, 75, 82), 60)


def paint_office(m):
    zone = L.F_OFFICE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(SIDING, 1.08), ao=AO_BASE - 4)
    corrugate(m, (x0, y0, x1, y1), shade(SIDING, 1.08), step=14, shade_f=0.88)
    # two window rows, some lit warm
    for r, wy in enumerate((0.28, 0.58)):
        for i in range(5):
            wx0 = x0 + 30 + i * (x1 - x0 - 60) / 5
            wx1 = wx0 + (x1 - x0 - 60) / 5 - 18
            wy0 = y0 + (y1 - y0) * wy
            wy1 = wy0 + 40
            m.d.rectangle([wx0, wy0, wx1, wy1], fill=GLASS,
                          outline=STEEL_DK, width=3)
            m.o.rectangle([wx0, wy0, wx1, wy1], fill=(AO_BASE, R_GLASS, M_GLASS))
            if (i + r) % 3 == 0:
                m.e.rectangle([wx0 + 3, wy0 + 3, wx1 - 3, wy1 - 3],
                              fill=(150, 105, 55))
    # wainscot + door
    wy = int(y1 - (y1 - y0) * 0.18)
    m.d.rectangle([x0, wy, x1, y1], fill=WAINSCOT)
    seam_h(m, x0, x1, wy, SIDING)
    m.d.rectangle([x0 + 60, wy - 66, x0 + 104, y1 - 6], fill=(52, 56, 62),
                  outline=STEEL_DK, width=3)
    wear_edges(m, (x0, wy, x1, y1), WAINSCOT, 30)
    zone = L.F_OFF_ROOF
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ROOFC, 1.05), ao=AO_BASE - 8,
         rough=200)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, ROOFC, hi=False)
    m.d.rectangle([x0 + 20, y0 + 20, x0 + 80, y0 + 60],
                  fill=shade(ROOFC, 0.85))


def paint_industrials(m):
    # stacks: banded steel, hazard collar, soot crown, warning light
    x0, y0, x1, y1 = L.F_STACK
    fill(m, (x0, y0, x1, y1), dif=(96, 99, 104), ao=AO_BASE - 12, rough=175,
         metal=140)
    for fy in (0.18, 0.45, 0.72):
        sy = y0 + (y1 - y0) * fy
        m.d.rectangle([x0, sy - 3, x1, sy + 3], fill=shade((96, 99, 104), 0.7))
    m.d.rectangle([x0, y0 + 8, x1, y0 + 26], fill=(150, 60, 40))  # crown ring
    for i in range(int((x1 - x0) / 16) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 16, y1 - 24), (x0 + i * 16 + 16, y1 - 24),
                     (x0 + i * 16 + 8, y1 - 10), (x0 + i * 16 - 8, y1 - 10)],
                    fill=c)
    m.e.ellipse([x0 + 30, y0 + 34, x0 + 42, y0 + 46], fill=(255, 60, 40))
    m.e.ellipse([x0 + 160, y0 + 34, x0 + 172, y0 + 46], fill=(255, 60, 40))
    r = L.F_STACK_TOP.rect
    fill(m, r, dif=BLACKISH, ao=AO_DEEP, rough=210, metal=60)
    scx, scy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    m.e.ellipse([scx - 30, scy - 30, scx + 30, scy + 30], fill=(140, 46, 10))
    m.d.ellipse([scx - 16, scy - 16, scx + 16, scy + 16], fill=(14, 13, 13))
    # silos: pale tanks, hazard band, level gauge, big ident
    x0, y0, x1, y1 = L.F_TANK
    fill(m, (x0, y0, x1, y1), dif=(150, 152, 148), ao=AO_BASE - 6, rough=160,
         metal=120)
    for fy in (0.3, 0.62):
        sy = y0 + (y1 - y0) * fy
        m.d.rectangle([x0, sy - 3, x1, sy + 3], fill=shade((150, 152, 148), 0.75))
    m.d.rectangle([x0, y0 + 30, x1, y0 + 52], fill=YELLOW)
    m.d.rectangle([x0, y0 + 52, x1, y0 + 60], fill=BLACKISH)
    stencil(m, (x0 + 24, y0 + (y1 - y0) * 0.5), 'FUEL-B', 26,
            shade(ARMOR, 0.45), bridge=False)
    m.d.rectangle([x0 + 12, y0 + 70, x0 + 26, y1 - 30], fill=(40, 44, 48))
    m.d.rectangle([x0 + 14, y0 + (y1 - y0) * 0.55, x0 + 24, y1 - 32],
                  fill=(90, 170, 90))
    m.t.rectangle([x1 - 70, y0 + 70, x1 - 12, y0 + 120], fill=(255, 0, 0))
    m.d.rectangle([x1 - 70, y0 + 70, x1 - 12, y0 + 120], fill=TEAMGREY)
    r = L.F_TANK_TOP.rect
    fill(m, r, dif=(150, 152, 148), ao=AO_BASE - 8, rough=160, metal=120)
    ccx, ccy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    m.d.ellipse([ccx - 14, ccy - 14, ccx + 14, ccy + 14], fill=STEEL_DK)
    bolts(m, [(ccx + np.cos(a) * 40, ccy + np.sin(a) * 40)
              for a in np.linspace(0.2, 2 * np.pi + 0.2, 8, endpoint=False)],
          base=(150, 152, 148))
    # horizontal tank wrap
    x0, y0, x1, y1 = L.F_HTANK
    fill(m, (x0, y0, x1, y1), dif=(128, 122, 112), ao=AO_BASE - 10, rough=170,
         metal=130)
    m.d.rectangle([x0, (y0 + y1) // 2 - 4, x1, (y0 + y1) // 2 + 4],
                  fill=shade((128, 122, 112), 0.7))
    stencil(m, (x0 + 20, y0 + 20), 'H2O-IND', 18, shade(ARMOR, 0.5),
            bridge=False)
    # pipes: steel with flange shading
    x0, y0, x1, y1 = L.F_PIPE
    fill(m, (x0, y0, x1, y1), dif=(104, 108, 112), ao=AO_BASE - 14,
         rough=150, metal=170)
    for fx in np.linspace(0.1, 0.9, 6):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 3, y0, sx + 3, y1], fill=shade((104, 108, 112), 0.72))
    # crane: yellow/black beam + hook cell
    x0, y0, x1, y1 = L.F_CRANE.rect
    fill(m, (x0, y0, x1, y1), dif=YELLOW, ao=AO_BASE - 6, rough=150, metal=60)
    for i in range(int((x1 - x0) / 26) + 1):
        m.d.polygon([(x0 + i * 26, y0), (x0 + i * 26 + 13, y0),
                     (x0 + i * 26 - 10, y1), (x0 + i * 26 - 23, y1)],
                    fill=BLACKISH)
    x0, y0, x1, y1 = L.F_HOOK.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 15, rough=140,
         metal=190)
    m.d.rectangle([x0 + 10, y0 + 10, x1 - 10, y0 + 34], fill=YELLOW)
    # vents / louvers
    x0, y0, x1, y1 = L.F_VENT.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 20)
    vent_slots(m, [x0 + 8, y0 + 10, x1 - 8, y1 - 10], 5)
    # floodlights: housing + hot lens
    x0, y0, x1, y1 = L.F_LIGHT.rect
    fill(m, (x0, y0, x1, y1), dif=(60, 63, 68), ao=AO_BASE - 10, rough=140,
         metal=160)
    m.d.rectangle([x0 + 24, y0 + 40, x1 - 24, y1 - 40], fill=(230, 235, 238))
    m.e.rectangle([x0 + 26, y0 + 42, x1 - 26, y1 - 42], fill=(255, 244, 210))
    # dish + fan
    r = L.F_DISH.rect
    fill(m, r, dif=(168, 172, 176), ao=AO_BASE - 4, rough=150, metal=110)
    ccx, ccy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    m.d.ellipse([ccx - 60, ccy - 60, ccx + 60, ccy + 60],
                outline=shade((168, 172, 176), 0.7), width=4)
    m.e.ellipse([ccx - 5, ccy - 5, ccx + 5, ccy + 5], fill=(255, 60, 40))
    x0, y0, x1, y1 = L.F_FAN.rect
    fill(m, (x0, y0, x1, y1), dif=(38, 40, 44), ao=AO_BASE - 20, rough=170,
         metal=150)
    ccx, ccy = (x0 + x1) / 2, (y0 + y1) / 2
    rr = (x1 - x0) / 2 - 8
    for a in np.linspace(0, 2 * np.pi, 6, endpoint=False):
        m.d.polygon([(ccx + np.cos(a) * 14, ccy + np.sin(a) * 14),
                     (ccx + np.cos(a + 0.5) * rr, ccy + np.sin(a + 0.5) * rr),
                     (ccx + np.cos(a + 0.95) * rr, ccy + np.sin(a + 0.95) * rr)],
                    fill=(88, 92, 98))
    m.d.ellipse([ccx - 16, ccy - 16, ccx + 16, ccy + 16], fill=STEEL_DK)
    x0, y0, x1, y1 = L.F_FANH
    fill(m, (x0, y0, x1, y1), dif=(70, 74, 80), ao=AO_BASE - 15, rough=160,
         metal=160)
    for fx in (0.3, 0.7):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 2, y0, sx + 2, y1], fill=BLACKISH)
    # rails / trim / ladders
    for zone in (L.F_RAIL, L.F_TRIM, L.F_LADDER):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=(52, 55, 60), ao=AO_BASE - 15,
             rough=165, metal=150)
    x0, y0, x1, y1 = L.F_LADDER.rect
    m.d.rectangle([x0, y0, x1, y0 + 40], fill=YELLOW)  # safety top
    # crates + transformer yard
    x0, y0, x1, y1 = L.F_CRATE.rect
    fill(m, (x0, y0, x1, y1), dif=(96, 88, 72), ao=AO_BASE - 8, rough=200,
         metal=20)
    m.d.rectangle([x0, y0, x1 - 1, y1 - 1], outline=shade((96, 88, 72), 0.6),
                  width=4)
    seam_h(m, x0 + 4, x1 - 4, (y0 + y1) // 2, (96, 88, 72), hi=False)
    stencil(m, (x0 + 20, y0 + 30), 'MS-SUP', 18, shade((96, 88, 72), 1.35),
            bridge=False)
    x0, y0, x1, y1 = L.F_TRAFO.rect
    fill(m, (x0, y0, x1, y1), dif=(70, 78, 72), ao=AO_BASE - 12, rough=170,
         metal=140)
    for fx in np.linspace(0.15, 0.85, 5):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 3, y0 + 8, sx + 3, y1 - 8],
                      fill=shade((70, 78, 72), 0.75))
    # warning sign
    m.d.polygon([(x0 + 40, y1 - 24), (x0 + 64, y1 - 64), (x0 + 88, y1 - 24)],
                fill=YELLOW)
    m.d.line([(x0 + 64, y1 - 54), (x0 + 64, y1 - 36)], fill=BLACKISH, width=4)
    fill(m, L.F_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_walls(m)
    paint_roof(m)
    paint_pad(m)
    paint_door(m)
    paint_office(m)
    paint_industrials(m)

    # ── weathering ──
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=61)
    wx.crevice_grime(m.dif, 0.45)
    # walls: dust low, rust streaks from eave/team band and wainscot line
    for zone in (L.F_SIDE, L.F_FRONT, L.F_REAR):
        x0, y0, x1, y1 = zone.rect
        wx.mud_band(zone.rect, 0.42, fade='down', dust=0.3)
        rust_sills(wx, zone.rect, (y0 + 44, int(y1 - (y1 - y0) * 0.21)), n=9)
        wx.plate_bottom_rust(zone.rect, n=8, strength=0.55)
    wx.mud_band(L.F_OFFICE.rect, 0.3, fade='down', dust=0.25)
    rust_sills(wx, L.F_OFFICE.rect,
               (L.F_OFFICE.rect[1] + int(
                   (L.F_OFFICE.rect[3] - L.F_OFFICE.rect[1]) * 0.36),), n=6)
    # roof: dust + rust wash running down-slope from the stacks
    wx.mud_band(L.F_ROOF_S.rect, 0.3, fade=None, spatter=False)
    x0, y0, x1, y1 = L.F_ROOF_S.rect
    for fx in (0.3, 0.5, 0.75):
        wx.rust_streak(x0 + (x1 - x0) * fx, y0 + 30, 60, width=4.0,
                       strength=0.4)
    # pad: oil pools near the gate lane, dust at the edges
    wx.mud_band(L.F_PAD.rect, 0.22, fade=None, spatter=True)
    wx.oily((L.F_PAD.rect[0] + 320, L.F_PAD.rect[1] + 160,
             L.F_PAD.rect[0] + 620, L.F_PAD.rect[3] - 30), 0.5)
    wx.mud_band(L.F_PADS.rect, 0.5, fade='down')
    # industrial soot + rust
    sx0, sy0, sx1, sy1 = L.F_STACK
    wx.soot_patch((sx0, sy0, sx1, sy0 + (sy1 - sy0) // 4), 0.8)
    wx.soot_patch(L.F_STACK_TOP.rect, 0.85)
    wx.soot_patch(L.F_FANH, 0.4)
    wx.soot_patch(L.F_FAN.rect, 0.35)
    tx0, ty0, tx1, ty1 = L.F_TANK
    for fx in (0.2, 0.5, 0.8):
        wx.rust_streak(tx0 + (tx1 - tx0) * fx, ty0 + 60, 70, width=3.0,
                       strength=0.45)
    wx.plate_bottom_rust(L.F_TANK, n=8, strength=0.6)
    wx.oily(L.F_PIPE, 0.3)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.5)
    wx.apply(m)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    # corrugation ribs on walls + roof (the big scale cue)
    for zone, step in ((L.F_SIDE, 10), (L.F_FRONT, 10), (L.F_REAR, 10),
                       (L.F_OFFICE, 14)):
        x0, y0, x1, y1 = zone.rect
        for gx in range(int(x0) + step // 2, int(x1), step):
            hm.line((gx, y0 + 2), (gx, y1 - 2), 0.4, width=2)
    x0, y0, x1, y1 = L.F_ROOF_S.rect
    for gx in range(int(x0) + 6, int(x1), 12):
        hm.line((gx, y0 + 2), (gx, y1 - 2), 0.35, width=2)
    # pad expansion joints recessed
    zone = L.F_PAD
    x0, y0, x1, y1 = zone.rect
    for fx in np.linspace(0.125, 0.875, 7):
        hm.line((x0 + (x1 - x0) * fx, y0 + 2), (x0 + (x1 - x0) * fx, y1 - 2),
                -0.5, width=3)
    for fy in np.linspace(0.16, 0.84, 5):
        hm.line((x0 + 2, y0 + (y1 - y0) * fy), (x1 - 2, y0 + (y1 - y0) * fy),
                -0.5, width=3)
    # gate slats + skylight mullions
    hm.crevices_from(m.dif, 0.6)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.6).save('out/fable_factory_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save('out/fable_factory_diffuse.png')
    m.orm.save('out/fable_factory_orm.png')
    m.emi.save('out/fable_factory_emissive.png')
    m.tea.save('out/fable_factory_team.png')
    print('[paint_factory] full 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
