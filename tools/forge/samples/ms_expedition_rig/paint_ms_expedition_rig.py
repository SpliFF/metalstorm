"""paint_ms_expedition_rig — 1024² PBR set for ms_expedition_rig.

Expedition-truck read: sun-faded olive-drab cab and bed over a black
frame, hazard-striped bull/rear bars, heavy wheel mud (this thing lives
off-road), equipment-orange drill/crane steel, canvas parley canopy,
off-white survey dish with a team wedge, galvanised telescoping mast.
Team colour: door roundels, bed stripe, dish wedge, envoy pennant.
Emissive (functional lights only): headlights, cab light bar, dish feed
head, mast tip beacon.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import ms_expedition_rig_layout as L      # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, BOLT_LOG,
                   STEEL, STEEL_DK, RUBBER, YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_RUBBER, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, RNG)

W = 1024
OLIVE     = (109, 106, 86)      # sun-faded expedition olive
OLIVE_LT  = (122, 119, 98)
OLIVE_DK  = (90, 88, 71)
FRAME     = (44, 45, 47)
GLASS     = (26, 34, 40)
CANVAS    = (172, 158, 124)     # parley canopy
CANVAS_DK = (150, 137, 106)
DISHC     = (212, 210, 202)
EQORANGE  = (191, 101, 38)      # drill/crane equipment steel
GALV      = (163, 168, 173)
AMBER     = (255, 176, 60)
HEADLAMP  = (255, 238, 196)
CYAN_GLOW = (120, 235, 255)


def px(z, p):
    u, v = z.uv(p)
    return u * W, v * W


def hazard_strip(m, x0, y0, x1, y1, step=18):
    for i in range(int((x1 - x0) / step) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * step, y0), (x0 + (i + 1) * step, y0),
                     (x0 + (i + 1) * step - 8, y1), (x0 + i * step - 8, y1)],
                    fill=c)


# ── chassis zones ────────────────────────────────────────────────────────

def paint_cab(m):
    z = L.CAB_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=OLIVE, ao=AO_BASE - 2, rough=R_ARMOR,
         metal=M_ARMOR)
    # window band (upper) with pillar break at the door line
    _, wy0 = px(z, (0, 2.5, 0))
    _, wy1 = px(z, (0, 2.08, 0))
    du, _ = px(z, (0, 0, -2.35))
    m.d.rectangle([x0 + 8, wy0, du - 6, wy1], fill=GLASS)
    m.d.rectangle([du + 6, wy0, x1 - 8, wy1], fill=GLASS)
    m.o.rectangle([x0 + 8, wy0, x1 - 8, wy1], fill=(AO_BASE, R_GLASS, M_GLASS))
    # door seam + handle + hinge bolts
    seam_v(m, int(du), int(wy1) + 4, y1 - 8, OLIVE)
    m.d.rectangle([du + 12, wy1 + 18, du + 40, wy1 + 26], fill=STEEL_DK)
    bolts(m, [(du - 10, wy1 + 12), (du - 10, y1 - 20)], base=OLIVE)
    # team roundel on the door
    cx, cy = du + 52, (wy1 + y1) / 2
    m.t.ellipse([cx - 24, cy - 24, cx + 24, cy + 24], fill=(255, 0, 0))
    m.d.ellipse([cx - 24, cy - 24, cx + 24, cy + 24], fill=TEAMGREY,
                outline=shade(OLIVE, 0.55), width=2)
    # lower rocker band
    _, ry = px(z, (0, 0.95, 0))
    m.d.rectangle([x0, ry, x1, y1], fill=OLIVE_DK)
    seam_h(m, x0 + 2, x1 - 2, int(ry), OLIVE)
    wear_edges(m, (x0, y0, x1, y1), OLIVE, 40)

    z = L.CAB_FRONT
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=OLIVE, ao=AO_BASE - 2, rough=R_ARMOR,
         metal=M_ARMOR)
    _, wy0 = px(z, (0, 2.52, 0))
    _, wy1 = px(z, (0, 2.05, 0))
    m.d.rectangle([x0 + 16, wy0, x1 - 16, wy1], fill=GLASS)
    m.o.rectangle([x0 + 16, wy0, x1 - 16, wy1], fill=(AO_BASE, R_GLASS, M_GLASS))
    m.d.line([((x0 + x1) / 2, wy0), ((x0 + x1) / 2, wy1)],
             fill=shade(OLIVE, 0.7), width=3)          # split windshield
    # grille + intake slats
    _, gy0 = px(z, (0, 1.62, 0))
    _, gy1 = px(z, (0, 1.18, 0))
    gb = [x0 + (x1 - x0) * 0.3, gy0, x0 + (x1 - x0) * 0.7, gy1]
    m.d.rectangle(gb, fill=STEEL_DK)
    vent_slots(m, [gb[0] + 4, gb[1] + 4, gb[2] - 4, gb[3] - 4], 4)
    # headlights (emissive)
    for fx in (0.16, 0.84):
        hx = x0 + (x1 - x0) * fx
        hb = [hx - 16, gy0 + 6, hx + 16, gy0 + 26]
        m.d.rectangle(hb, fill=HEADLAMP)
        m.e.rectangle(hb, fill=shade(HEADLAMP, 0.85))
        m.o.rectangle(hb, fill=(AO_BASE, R_GLASS, M_GLASS))
    seam_h(m, x0 + 4, x1 - 4, int(px(z, (0, 0.95, 0))[1]), OLIVE)
    bolts(m, [(x0 + 14, y0 + 12), (x1 - 14, y0 + 12),
              (x0 + 14, gy1 + 14), (x1 - 14, gy1 + 14)], base=OLIVE)
    wear_edges(m, (x0, y0, x1, y1), OLIVE, 30)

    z = L.CAB_ROOF
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(OLIVE, 0.96), ao=AO_BASE,
         rough=R_ARMOR + 8, metal=M_ARMOR)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, OLIVE)
    # roof hatch
    m.d.rectangle([x0 + 30, y0 + 24, x0 + 90, y0 + 74],
                  fill=OLIVE_DK, outline=shade(OLIVE, 0.6), width=2)
    bolts(m, [(x0 + 36, y0 + 30), (x0 + 84, y0 + 30), (x0 + 36, y0 + 68),
              (x0 + 84, y0 + 68)], base=OLIVE_DK)
    wear_edges(m, (x0, y0, x1, y1), OLIVE, 30)


def paint_bed(m):
    z = L.BED_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=OLIVE_DK, ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR)
    # stake-pocket seams + drop-side latch line
    for wz in (-0.7, 0.5, 1.7, 2.9):
        u, _ = px(z, (0, 0, wz))
        seam_v(m, int(u), y0 + 4, y1 - 4, OLIVE_DK)
    _, ly = px(z, (0, 0.72, 0))
    seam_h(m, x0 + 2, x1 - 2, int(ly), OLIVE_DK)
    # team identification stripe along the top rail
    m.t.rectangle([x0 + 4, y0 + 6, x1 - 4, y0 + 20], fill=(255, 0, 0))
    m.d.rectangle([x0 + 4, y0 + 6, x1 - 4, y0 + 20], fill=TEAMGREY)
    bolts(m, [(x0 + 20 + i * (x1 - x0 - 40) / 5, y1 - 14) for i in range(6)],
          base=OLIVE_DK)
    wear_edges(m, (x0, y0, x1, y1), OLIVE_DK, 45)

    z = L.BED_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(OLIVE_DK, 0.92), ao=AO_BASE - 8,
         rough=R_ARMOR + 14, metal=M_ARMOR)
    # treadplate hint: sparse diagonal dashes
    for _ in range(240):
        tx = x0 + RNG.random() * (x1 - x0 - 8)
        ty = y0 + RNG.random() * (y1 - y0 - 8)
        m.d.line([(tx, ty + 4), (tx + 6, ty)], fill=jit(shade(OLIVE_DK, 1.14), 4),
                 width=1)
    # plank seams + tie-down rings
    for wx in (-0.85, 0.0, 0.85):
        u, _ = px(z, (wx, 0, 0))
        seam_v(m, int(u), y0 + 3, y1 - 3, OLIVE_DK)
    ring_pts = []
    for wz in (-1.2, 0.1, 1.4, 2.7):
        _, v = px(z, (0, 0, wz))
        ring_pts += [(x0 + 16, v), (x1 - 16, v)]
    bolts(m, ring_pts, r=4, base=OLIVE_DK)
    # module-socket plate at the mount point
    su, sv = px(z, (0, 0, 1.0))
    m.d.rectangle([su - 60, sv - 50, su + 60, sv + 50], fill=STEEL_DK)
    m.o.rectangle([su - 60, sv - 50, su + 60, sv + 50],
                  fill=(AO_SEAM, R_STEEL, M_STEEL))
    bolts(m, [(su - 50, sv - 40), (su + 50, sv - 40), (su - 50, sv + 40),
              (su + 50, sv + 40)], r=4, base=STEEL_DK)

    z = L.BED_END
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=OLIVE_DK, ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, OLIVE_DK)
    bolts(m, [(x0 + 16, y0 + 12), (x1 - 16, y0 + 12)], base=OLIVE_DK)


def paint_running_gear(m):
    # tires: dark rubber, radial lug tread
    z = L.WHEELZ
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=RUBBER, ao=AO_BASE - 30, rough=R_RUBBER,
         metal=0)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rr = (x1 - x0) / 2
    for i in range(16):
        a = 2 * np.pi * i / 16
        m.d.line([(cx + np.cos(a) * rr * 0.62, cy + np.sin(a) * rr * 0.62),
                  (cx + np.cos(a) * rr, cy + np.sin(a) * rr)],
                 fill=shade(RUBBER, 1.45), width=5)
    m.o.ellipse([cx - rr * 0.6, cy - rr * 0.6, cx + rr * 0.6, cy + rr * 0.6],
                fill=(AO_DEEP, R_RUBBER, 0))
    # hubs: olive rim, lug ring, dust cap
    z = L.HUBZ
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=RUBBER, ao=AO_BASE - 30, rough=R_RUBBER,
         metal=0)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rr = (x1 - x0) / 2
    m.d.ellipse([cx - rr * 0.62, cy - rr * 0.62, cx + rr * 0.62, cy + rr * 0.62],
                fill=OLIVE_DK)
    m.o.ellipse([cx - rr * 0.62, cy - rr * 0.62, cx + rr * 0.62, cy + rr * 0.62],
                fill=(AO_BASE - 10, R_STEEL, M_STEEL))
    for i in range(8):
        a = 2 * np.pi * i / 8 + 0.2
        bolts(m, [(cx + np.cos(a) * rr * 0.42, cy + np.sin(a) * rr * 0.42)],
              r=4, base=OLIVE_DK)
    m.d.ellipse([cx - rr * 0.16, cy - rr * 0.16, cx + rr * 0.16, cy + rr * 0.16],
                fill=STEEL_DK)


def paint_fittings(m):
    # hazard bars (bull/rear)
    z = L.BULLZ
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)
    hazard_strip(m, x0, y0 + 8, x1, y1 - 8)
    m.o.rectangle([x0, y0 + 8, x1, y1 - 8], fill=(AO_BASE - 6, R_ARMOR + 10, 40))
    # fuel tanks: steel with strap lines + filler
    z = L.TANKZ
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 6, rough=R_STEEL - 20,
         metal=M_STEEL)
    for f in (0.28, 0.72):
        seam_v(m, int(x0 + (x1 - x0) * f), y0 + 3, y1 - 3, STEEL)
    m.d.ellipse([x1 - 40, y0 + 12, x1 - 20, y0 + 32], fill=STEEL_DK)
    wear_edges(m, (x0, y0, x1, y1), STEEL, 30)
    # generic dark hardware + amber glow cell
    fill(m, L.DARKZ.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 16,
         metal=40)
    z = L.GLOWZ
    fill(m, z.rect, dif=AMBER, ao=AO_BASE, rough=R_GLASS, metal=M_GLASS)
    x0, y0, x1, y1 = z.rect
    m.e.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2], fill=shade(AMBER, 0.8))
    # exhaust wrap: dark steel, heat-browned then sooty toward the tip
    x0, y0, x1, y1 = L.EXHW
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 10, rough=R_STEEL + 20,
         metal=M_STEEL - 40)
    m.d.rectangle([x0 + (x1 - x0) * 2 // 3, y0, x1, y1],
                  fill=(74, 56, 48))


# ── module zones ─────────────────────────────────────────────────────────

def paint_modules(m):
    # skid/platform bases: dark grey, bolt rows, hazard corners
    z = L.MODBASE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=FRAME, ao=AO_BASE - 14, rough=R_ARMOR + 10,
         metal=M_ARMOR + 20)
    for f in (1 / 3, 2 / 3):
        seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * f), FRAME)
    bolts(m, [(x0 + 12 + i * (x1 - x0 - 24) / 7, y0 + 10) for i in range(8)]
          + [(x0 + 12 + i * (x1 - x0 - 24) / 7, y1 - 10) for i in range(8)],
          base=FRAME)
    cw = 34
    for cx, cy in ((x0, y0), (x1 - cw, y0), (x0, y1 - cw), (x1 - cw, y1 - cw)):
        for i in range(0, cw, 12):
            m.d.polygon([(cx + i, cy), (cx + i + 6, cy), (cx, cy + i + 6),
                         (cx, cy + i)],
                        fill=YELLOW if (i // 12) % 2 == 0 else BLACKISH)
    # equipment housings: olive, vents, hazard diamond, team square
    z = L.MODSIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(OLIVE, 0.94), ao=AO_BASE - 4,
         rough=R_ARMOR, metal=M_ARMOR)
    seam_h(m, x0 + 2, x1 - 2, y0 + (y1 - y0) // 2, OLIVE)
    vent_slots(m, (x0 + 16, y1 - 56, x0 + 76, y1 - 16), 3)
    dx, dy = x1 - 44, y0 + 34
    m.d.polygon([(dx, dy - 16), (dx + 16, dy), (dx, dy + 16), (dx - 16, dy)],
                fill=YELLOW)
    m.t.rectangle([x0 + 12, y0 + 10, x0 + 40, y0 + 34], fill=(255, 0, 0))
    m.d.rectangle([x0 + 12, y0 + 10, x0 + 40, y0 + 34], fill=TEAMGREY)
    bolts(m, [(x0 + 10, y1 - 10), (x1 - 10, y1 - 10), (x1 - 10, y0 + 10)],
          base=OLIVE)
    wear_edges(m, (x0, y0, x1, y1), OLIVE, 30)
    # parley canopy: canvas with seam grid + stitched edge
    z = L.CANOPY
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=CANVAS, ao=AO_BASE, rough=R_RUBBER + 20,
         metal=0)
    for f in (0.25, 0.5, 0.75):
        m.d.line([(x0 + 3, y0 + (y1 - y0) * f), (x1 - 3, y0 + (y1 - y0) * f)],
                 fill=CANVAS_DK, width=3)
        m.d.line([(x0 + (x1 - x0) * f, y0 + 3), (x0 + (x1 - x0) * f, y1 - 3)],
                 fill=CANVAS_DK, width=2)
    m.d.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2], outline=CANVAS_DK, width=4)
    for _ in range(140):                       # canvas weave noise
        tx = x0 + RNG.random() * (x1 - x0 - 4)
        ty = y0 + RNG.random() * (y1 - y0 - 2)
        m.d.point((tx, ty), fill=jit(CANVAS, 9))
    # crates / racks / table: scuffed olive boxes with strap lines
    z = L.CRATEZ
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(OLIVE, 0.88), ao=AO_BASE - 8,
         rough=R_ARMOR + 12, metal=M_ARMOR)
    for f in (0.33, 0.66):
        seam_v(m, int(x0 + (x1 - x0) * f), y0 + 3, y1 - 3, OLIVE_DK)
    m.d.rectangle([x0 + 8, y0 + (y1 - y0) // 2 - 4, x1 - 8,
                   y0 + (y1 - y0) // 2 + 4], fill=STEEL_DK)
    bolts(m, [(x0 + 18, y0 + 16), (x1 - 18, y0 + 16), (x0 + 18, y1 - 16),
              (x1 - 18, y1 - 16)], base=OLIVE_DK)
    wear_edges(m, (x0, y0, x1, y1), OLIVE_DK, 40)
    # pennant: full team read with a dark fly-edge border
    z = L.FLAGZ
    x0, y0, x1, y1 = z.rect
    m.t.rectangle([x0, y0, x1, y1], fill=(255, 0, 0))
    fill(m, (x0, y0, x1, y1), dif=TEAMGREY, ao=AO_BASE, rough=R_RUBBER, metal=0)
    m.d.rectangle([x0, y0, x0 + 14, y1], fill=shade(TEAMGREY, 0.75))
    m.t.rectangle([x0, y0, x0 + 14, y1], fill=(200, 0, 0))
    # survey dish: off-white ribs + team wedge (front), ribbed shell (back)
    z = L.DISH_F
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=DISHC, ao=AO_BASE, rough=R_ARMOR + 6,
         metal=M_ARMOR)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for f in (0.44, 0.3, 0.16):
        rr = (x1 - x0) * f
        m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                    outline=shade(DISHC, 0.82), width=3)
    m.d.polygon([(cx, cy), (cx + (x1 - x0) * 0.44, cy - 36),
                 (cx + (x1 - x0) * 0.44, cy + 36)], fill=TEAMGREY)
    m.t.polygon([(cx, cy), (cx + (x1 - x0) * 0.44, cy - 36),
                 (cx + (x1 - x0) * 0.44, cy + 36)], fill=(255, 0, 0))
    m.e.ellipse([cx - 7, cy - 7, cx + 7, cy + 7], fill=shade(CYAN_GLOW, 0.5))
    z = L.DISH_B
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(DISHC, 0.72), ao=AO_BASE - 8,
         rough=R_ARMOR + 10, metal=M_ARMOR)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for f in (0.42, 0.26):
        rr = (x1 - x0) * f
        m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                    outline=shade(DISHC, 0.6), width=4)


def paint_wraps(m):
    # telescoping mast: galvanised with collar bands per segment
    x0, y0, x1, y1 = L.MASTW
    fill(m, (x0, y0, x1, y1), dif=GALV, ao=AO_BASE - 4, rough=R_STEEL - 10,
         metal=M_STEEL)
    for gy in range(int(y0) + 14, int(y1), 22):
        m.d.line([(x0 + 2, gy), (x1 - 2, gy)], fill=shade(GALV, 0.88), width=2)
    for f in (0.33, 0.66):                     # telescope collars
        gx = x0 + (x1 - x0) * f
        m.d.rectangle([gx - 5, y0, gx + 5, y1], fill=shade(GALV, 0.7))
    # small steel (posts, yoke, cable, staff)
    fill(m, L.TRIMW, dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)
    x0, y0, x1, y1 = L.TRIMW
    for gy in range(int(y0) + 18, int(y1), 30):
        m.d.line([(x0 + 2, gy), (x1 - 2, gy)], fill=shade(STEEL_DK, 1.2),
                 width=1)
    # equipment orange (drill derrick + string, crane post + boom)
    x0, y0, x1, y1 = L.DRILLW
    fill(m, (x0, y0, x1, y1), dif=EQORANGE, ao=AO_BASE - 4, rough=R_ARMOR + 4,
         metal=M_ARMOR + 30)
    band = (x1 - x0) // 5
    m.d.rectangle([x1 - band, y0, x1, y1], fill=BLACKISH)   # tip band (u=1)
    for gx in range(int(x0) + 20, int(x1) - band, 34):
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)], fill=shade(EQORANGE, 0.8),
                 width=2)
    wear_edges(m, (x0, y0, x1 - band, y1), EQORANGE, 50)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_cab(m)
    paint_bed(m)
    paint_running_gear(m)
    paint_fittings(m)
    paint_modules(m)
    paint_wraps(m)

    # ── weathering: an expedition rig lives in the dirt ──────────────────
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=90210)
    wx.crevice_grime(m.dif, 0.4)
    wx.mud_band(L.WHEELZ.rect, 0.6, fade=None, spatter=True)
    wx.mud_band(L.HUBZ.rect, 0.5, fade=None, spatter=True)
    wx.mud_band(L.CAB_SIDE.rect, 0.5, fade='down', spatter=True, dust=0.3)
    wx.mud_band(L.CAB_FRONT.rect, 0.45, fade='down', spatter=True, dust=0.25)
    wx.mud_band(L.BED_SIDE.rect, 0.55, fade='down', spatter=True, dust=0.3)
    wx.mud_band(L.BED_END.rect, 0.5, fade='down')
    wx.mud_band(L.TANKZ.rect, 0.45, fade='down')
    wx.mud_band(L.BULLZ.rect, 0.4, fade='down', spatter=True)
    wx.mud_band(L.MODSIDE.rect, 0.3, fade='down', dust=0.25)
    wx.mud_band(L.CRATEZ.rect, 0.25, fade='down', dust=0.2)
    for z in (L.BED_SIDE, L.TANKZ, L.MODSIDE):
        wx.plate_bottom_rust(z.rect, n=5, strength=0.45)
    wx.rust_streak(L.BED_SIDE.rect[0] + 320, L.BED_SIDE.rect[1] + 24, 60,
                   width=2.5, strength=0.35)
    wx.rust_streak(L.CAB_SIDE.rect[0] + 60, L.CAB_SIDE.rect[1] + 150, 40,
                   width=2.0, strength=0.3)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.4)
    wx.oily(((L.DRILLW[0] + L.DRILLW[2]) // 2 - 40, L.DRILLW[3] - 60,
             (L.DRILLW[0] + L.DRILLW[2]) // 2 + 40, L.DRILLW[3]), 0.5)
    wx.oily((L.HUBZ.rect[0] + 60, L.HUBZ.rect[1] + 60,
             L.HUBZ.rect[2] - 60, L.HUBZ.rect[3] - 60), 0.35)
    x0, y0, x1, y1 = L.EXHW
    wx.soot_patch((x0 + (x1 - x0) * 2 // 3, y0, x1, y1), 0.8, fade='right')
    wx.apply(m)

    # ── normal map: authored features + auto detail ──────────────────────
    from normals import HeightMap
    hm = HeightMap()
    z = L.BED_TOP
    x0, y0, x1, y1 = z.rect
    for wx_ in (-0.85, 0.0, 0.85):
        u = z.uv((wx_, 0, 0))[0] * W
        hm.line((u, y0 + 3), (u, y1 - 3), -0.5, width=2)
    z = L.CANOPY
    x0, y0, x1, y1 = z.rect
    for f in (0.25, 0.5, 0.75):
        hm.line((x0 + 3, y0 + (y1 - y0) * f), (x1 - 3, y0 + (y1 - y0) * f),
                0.35, width=3)
    hm.crevices_from(m.dif, 0.5)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.0).save('out/ms_expedition_rig_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.5))
    m.dif.save('out/ms_expedition_rig_diffuse.png')
    m.orm.save('out/ms_expedition_rig_orm.png')
    m.emi.save('out/ms_expedition_rig_emissive.png')
    m.tea.save('out/ms_expedition_rig_team.png')
    print('[paint_ms_expedition_rig] full 1024 texture set written to out/')


if __name__ == '__main__':
    paint_all()
