"""paint_ms_field_workshop — 1024^2 PBR set for ms_field_workshop.

Field-workshop read at unit texel density: weathered galvanized
corrugated roof with patched sheets and a faction eave band, stained
concrete pad with base plates, crane-travel hatch marking and tire
tracks, yellow/black gantry rails + bridge, steel workbenches with
painted tools, part-heap bins, signal-red engine hoist, drums, crate,
tool locker, welding bottles. Weathering: crevice grime, ground-up mud,
rust streaks off the roof/bins/drums, oil on the pad and trolley, weld
soot at bench 1. Emissive stays black — the spec calls out no lights.
Team mask (R channel): roof eave band, crane bridge square, locker door.
"""
from __future__ import annotations
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

import ms_field_workshop_layout as L    # sets meshlib.ATLAS = 1024
import paint as P
import weathering
import normals as NM

if not os.path.exists(P.FONT):          # macOS fallback (forge runs on both)
    P.FONT = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   stencil, jit, shade, BOLT_LOG,
                   ARMOR, STEEL, STEEL_DK, GLASS, YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, M_ARMOR, M_STEEL, RNG)

W = 1024
OUT = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', '..', 'out'))
STEM = 'ms_field_workshop'

CONCRETE = (146, 144, 138)
GALV = (118, 122, 126)          # weathered galvanized sheet
GALV_NEW = (164, 168, 170)      # replacement sheet
DARKSTEEL = (60, 63, 68)
BENCH_TOP = (108, 104, 98)
BIN_STEEL = (99, 95, 78)
HOIST_RED = (158, 54, 40)
WOOD = (120, 100, 74)
LOCKER_C = (86, 92, 86)


def corrugate(m, rect, base, step=8, shade_f=0.84):
    x0, y0, x1, y1 = rect
    for gx in range(int(x0) + step // 2, int(x1), step):
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)], fill=shade(base, shade_f),
                 width=2)


def hazard_band(m, x0, y0, x1, y1, step=16):
    for i in range(int((x1 - x0) / step) + 2):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * step, y0), (x0 + (i + 1) * step, y0),
                     (x0 + i * step, y1), (x0 + (i - 1) * step, y1)], fill=c)
    m.d.rectangle([0, y0, x0 - 1, y1], fill=None)  # no-op clip guard


# ── roof ─────────────────────────────────────────────────────────────────

def paint_roof(m):
    zone = L.W_ROOF_T
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=GALV, ao=AO_BASE - 8, rough=190, metal=150)
    corrugate(m, (x0, y0, x1, y1), GALV)
    # sheet lap seams down-slope + panel joins
    for fy in np.linspace(0.18, 0.85, 4):
        seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * fy), GALV, hi=False)
    # patched sheets: two rust-toned, one bright replacement
    for (fx, fy, fw, fh, col) in ((0.12, 0.32, 0.14, 0.28, (128, 96, 72)),
                                  (0.68, 0.55, 0.12, 0.3, (122, 104, 84)),
                                  (0.42, 0.62, 0.13, 0.3, GALV_NEW)):
        bx0 = x0 + (x1 - x0) * fx
        by0 = y0 + (y1 - y0) * fy
        bx1 = bx0 + (x1 - x0) * fw
        by1 = by0 + (y1 - y0) * fh
        m.d.rectangle([bx0, by0, bx1, by1], fill=jit(col, 4),
                      outline=shade(GALV, 0.6), width=2)
        corrugate(m, (bx0, by0, bx1, by1), col)
        m.o.rectangle([bx0, by0, bx1, by1], fill=(AO_BASE - 10, 200, 120))
    # faction eave band along the high (front) edge
    m.t.rectangle([x0 + 4, y0 + 6, x1 - 4, y0 + 30], fill=(255, 0, 0))
    m.d.rectangle([x0 + 4, y0 + 6, x1 - 4, y0 + 30], fill=TEAMGREY)
    # kit ident, sized to read from altitude
    f = ImageFont.truetype(P.FONT, 88)
    tw = m.d.textlength('W-07', font=f)
    m.d.text(((x0 + x1) / 2 - tw / 2 + 3, y0 + (y1 - y0) * 0.4 + 3), 'W-07',
             font=f, fill=shade(GALV, 0.6))
    m.d.text(((x0 + x1) / 2 - tw / 2, y0 + (y1 - y0) * 0.4), 'W-07',
             font=f, fill=(198, 202, 206))
    wear_edges(m, (x0, y0, x1, y1), GALV, 55)
    # underside: dark frame, purlin lines across, joist ticks
    zone = L.W_ROOF_U
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(58, 60, 64), ao=AO_BASE - 30, rough=180,
         metal=120)
    for fy in (0.25, 0.5, 0.75):
        sy = int(y0 + (y1 - y0) * fy)
        m.d.rectangle([x0 + 2, sy - 3, x1 - 2, sy + 3],
                      fill=shade((58, 60, 64), 0.7))
    for fx in np.linspace(0.08, 0.92, 7):
        sx = int(x0 + (x1 - x0) * fx)
        m.d.line([(sx, y0 + 2), (sx, y1 - 2)], fill=shade((58, 60, 64), 0.82),
                 width=2)
    # fascia strip: dark steel with a worn yellow edge line
    x0, y0, x1, y1 = L.W_FASCIA.rect
    fill(m, (x0, y0, x1, y1), dif=(70, 74, 80), ao=AO_BASE - 10, rough=175,
         metal=130)
    m.d.rectangle([x0, y0 + 2, x1, y0 + 10], fill=shade(YELLOW, 0.85))
    wear_edges(m, (x0, y0, x1, y1), (70, 74, 80), 30)


# ── pad ──────────────────────────────────────────────────────────────────

def paint_pad(m):
    zone = L.W_PAD
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE - 4, rough=205,
         metal=8)
    for fx in np.linspace(0.2, 0.8, 4):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 2, y1 - 2, CONCRETE, hi=False)
    for fy in np.linspace(0.25, 0.75, 3):
        seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * fy), CONCRETE,
               hi=False)
    for _ in range(12):
        bx = x0 + RNG.random() * (x1 - x0 - 90)
        by = y0 + RNG.random() * (y1 - y0 - 50)
        m.d.polygon([(bx, by + 10), (bx + 70, by), (bx + 92, by + 32),
                     (bx + 20, by + 44)], fill=jit(shade(CONCRETE, 0.94), 3))
    # crane-travel strip: yellow outline + diagonal hatch
    hu0, hv0 = zone.uv((-4.8, 0, -1.0))
    hu1, hv1 = zone.uv((4.8, 0, 1.0))
    hb = [hu0 * W, hv0 * W, hu1 * W, hv1 * W]
    m.d.rectangle(hb, outline=shade(YELLOW, 0.8), width=4)
    for gx in range(int(hb[0]), int(hb[2]), 26):
        m.d.line([(gx, hb[3] - 3), (gx + (hb[3] - hb[1]), hb[1] + 3)],
                 fill=shade(YELLOW, 0.62), width=3)
    # post + gantry-column base plates (bolts logged for rust)
    plates = [(px, pz, 11) for px in L.POST_XS for pz in L.POST_ZS]
    plates += [(sx * L.GX, sz * L.GZ, 9) for sx in (-1, 1) for sz in (-1, 1)]
    for (px, pz, r) in plates:
        u, v = zone.uv((px, 0, pz))
        cx, cy = u * W, v * W
        m.d.rectangle([cx - r, cy - r, cx + r, cy + r],
                      fill=shade(CONCRETE, 0.62))
        m.o.rectangle([cx - r, cy - r, cx + r, cy + r],
                      fill=(AO_SEAM, R_STEEL, M_STEEL))
        bolts(m, [(cx - r + 3, cy - r + 3), (cx + r - 3, cy - r + 3),
                  (cx - r + 3, cy + r - 3), (cx + r - 3, cy + r - 3)],
              base=CONCRETE)
    # tire tracks arcing in from the open front (-z) toward the crane bay
    tu, tv = zone.uv((0.6, 0, -5.1))
    for dx in (-14, 14):
        for t in range(34):
            if t % 3 == 0:      # dashed tread patches, not a smear
                continue
            a = t / 33
            tx = tu * W + dx + a * 10 * np.sin(a * 2.6)
            ty = tv * W + a * ((hv0 * W) - tv * W + 24)
            m.d.ellipse([tx - 4, ty - 2, tx + 4, ty + 2],
                        fill=jit(shade(CONCRETE, 0.82), 4))
    # kit stencil near the front lip
    su, sv = zone.uv((-3.4, 0, -4.6))
    stencil(m, (su * W, sv * W), 'WKS-3', 22, shade(CONCRETE, 0.68),
            bridge=False)
    wear_edges(m, (x0, y0, x1, y1), CONCRETE, 40)
    # pad side strips: worn chevrons on the front, plain elsewhere
    for zone2 in (L.W_PADS_F, L.W_PADS_S):
        x0, y0, x1, y1 = zone2.rect
        fill(m, (x0, y0, x1, y1), dif=shade(CONCRETE, 0.9), ao=AO_BASE - 14,
             rough=210, metal=5)
    x0, y0, x1, y1 = L.W_PADS_F.rect
    for i in range(int((x1 - x0) / 18) + 1):
        c = shade(YELLOW, 0.8) if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 18, y0 + 4), (x0 + i * 18 + 18, y0 + 4),
                     (x0 + i * 18 + 9, y1 - 4), (x0 + i * 18 - 9, y1 - 4)],
                    fill=c)


# ── structure: posts, beams, rails ───────────────────────────────────────

def paint_structure(m):
    # posts/braces/columns wrap (u: bottom -> top, v around)
    x0, y0, x1, y1 = L.W_POST
    fill(m, (x0, y0, x1, y1), dif=(100, 104, 108), ao=AO_BASE - 8, rough=165,
         metal=170)
    for fv in (0.33, 0.66):                       # box-column flange lines
        sy = int(y0 + (y1 - y0) * fv)
        m.d.line([(x0, sy), (x1, sy)], fill=shade((100, 104, 108), 0.72),
                 width=2)
    m.d.rectangle([x0, y0, x0 + 18, y1], fill=(72, 70, 66))   # scuffed base
    m.d.rectangle([x1 - 10, y0, x1, y1], fill=shade((100, 104, 108), 0.7))
    bolts(m, [(x0 + 9, y0 + (y1 - y0) * f) for f in (0.2, 0.5, 0.8)],
          base=(100, 104, 108))
    # eave headers / purlins
    x0, y0, x1, y1 = L.W_BEAM.rect
    fill(m, (x0, y0, x1, y1), dif=(88, 92, 98), ao=AO_BASE - 10, rough=170,
         metal=170)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, (88, 92, 98), hi=False)
    bolts(m, [(x0 + 20 + i * (x1 - x0 - 40) / 9, (y0 + y1) // 2)
              for i in range(10)], base=(88, 92, 98))
    # gantry rails: safety yellow with black end stripes + fixing bolts
    x0, y0, x1, y1 = L.W_RAIL.rect
    fill(m, (x0, y0, x1, y1), dif=YELLOW, ao=AO_BASE - 6, rough=150, metal=60)
    for fx in (0.0, 0.92):
        bx = x0 + (x1 - x0) * fx
        for i in range(3):
            m.d.polygon([(bx + i * 12, y0), (bx + i * 12 + 6, y0),
                         (bx + i * 12 - 8, y1), (bx + i * 12 - 14, y1)],
                        fill=BLACKISH)
    bolts(m, [(x0 + 16 + i * (x1 - x0 - 32) / 11, y1 - 10)
              for i in range(12)], base=YELLOW)
    m.d.rectangle([x0, y0 + 2, x1, y0 + 6], fill=shade(YELLOW, 1.15))
    wear_edges(m, (x0, y0, x1, y1), YELLOW, 50)
    # cable wrap: braided dark steel
    x0, y0, x1, y1 = L.W_DARKP
    fill(m, (x0, y0, x1, y1), dif=(40, 42, 46), ao=AO_BASE - 20, rough=140,
         metal=180)
    for fy in np.linspace(0.1, 0.9, 7):
        sy = int(y0 + (y1 - y0) * fy)
        m.d.line([(x0, sy), (x1, sy)], fill=(58, 60, 66), width=1)
    # generic trim + dark cells
    x0, y0, x1, y1 = L.W_TRIM.rect
    fill(m, (x0, y0, x1, y1), dif=(60, 63, 68), ao=AO_BASE - 15, rough=165,
         metal=150)
    wear_edges(m, (x0, y0, x1, y1), (60, 63, 68), 25)
    fill(m, L.W_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)


# ── crane ────────────────────────────────────────────────────────────────

def paint_crane(m):
    zone = L.W_CRANE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=YELLOW, ao=AO_BASE - 6, rough=150, metal=60)
    # black chevrons over the end-truck spans (|z| > 2.9 in the local win)
    for (fz0, fz1) in ((-3.9, -2.9), (2.9, 3.9)):
        u0 = zone.uv((0, 0, fz0))[0] * W
        u1 = zone.uv((0, 0, fz1))[0] * W
        bx0, bx1 = min(u0, u1), max(u0, u1)
        for i in range(int((bx1 - bx0) / 14) + 1):
            if i % 2 == 0:
                m.d.polygon([(bx0 + i * 14, y0), (bx0 + (i + 1) * 14, y0),
                             (bx0 + i * 14, y1), (bx0 + (i - 1) * 14, y1)],
                            fill=BLACKISH)
    # girder seams + rating stencil + team square
    seam_h(m, x0 + 4, x1 - 4, y0 + (y1 - y0) // 2, YELLOW, hi=False)
    stencil(m, ((x0 + x1) / 2 - 46, y0 + 8, ), 'SWL 2T', 18, BLACKISH,
            bridge=False)
    m.t.rectangle([(x0 + x1) / 2 + 58, y0 + 6, (x0 + x1) / 2 + 92, y0 + 26],
                  fill=(255, 0, 0))
    m.d.rectangle([(x0 + x1) / 2 + 58, y0 + 6, (x0 + x1) / 2 + 92, y0 + 26],
                  fill=TEAMGREY)
    bolts(m, [(x0 + 14 + i * (x1 - x0 - 28) / 9, y1 - 8) for i in range(10)],
          base=YELLOW)
    wear_edges(m, (x0, y0, x1, y1), YELLOW, 60)
    # trolley: steel housing, vents, cable drum
    x0, y0, x1, y1 = L.W_TROLLEY.rect
    fill(m, (x0, y0, x1, y1), dif=(84, 88, 94), ao=AO_BASE - 12, rough=155,
         metal=180)
    vent_slots(m, [x0 + 14, y0 + 16, x0 + 64, y0 + 46], 3)
    ccx, ccy = (x0 + x1) / 2 + 20, (y0 + y1) / 2
    m.d.ellipse([ccx - 20, ccy - 20, ccx + 20, ccy + 20], fill=STEEL_DK,
                outline=shade((84, 88, 94), 0.6), width=3)
    m.d.ellipse([ccx - 6, ccy - 6, ccx + 6, ccy + 6], fill=(40, 42, 46))
    bolts(m, [(x0 + 8, y0 + 8), (x1 - 8, y0 + 8), (x0 + 8, y1 - 8),
              (x1 - 8, y1 - 8)], base=(84, 88, 94))
    wear_edges(m, (x0, y0, x1, y1), (84, 88, 94), 30)
    # hook block: yellow with black chevrons; hook itself worn steel
    x0, y0, x1, y1 = L.W_HOOK.rect
    fill(m, (x0, y0, x1, y1), dif=(70, 74, 80), ao=AO_BASE - 12, rough=150,
         metal=185)
    by = y0 + int((y1 - y0) * 0.45)
    m.d.rectangle([x0 + 6, y0 + 6, x1 - 6, by], fill=YELLOW)
    for i in range(int((x1 - x0) / 12) + 1):
        if i % 2 == 0:
            m.d.polygon([(x0 + 6 + i * 12, y0 + 6), (x0 + 6 + (i + 1) * 12, y0 + 6),
                         (x0 + 6 + i * 12, by), (x0 + 6 + (i - 1) * 12, by)],
                        fill=BLACKISH)
    m.d.arc([x0 + 24, by + 8, x1 - 24, y1 - 8], 300, 200,
            fill=(150, 154, 160), width=7)
    wear_edges(m, (x0, y0, x1, y1), (70, 74, 80), 30)


# ── props ────────────────────────────────────────────────────────────────

def paint_bench(m):
    # top: worn steel with painted tools + vice + oil
    x0, y0, x1, y1 = L.W_BENCH_T[0].rect
    fill(m, (x0, y0, x1, y1), dif=BENCH_TOP, ao=AO_BASE - 6, rough=175,
         metal=120)
    seam_v(m, (x0 + x1) // 2, y0 + 2, y1 - 2, BENCH_TOP, hi=False)
    for _ in range(6):    # oil rings/patches
        bx = x0 + RNG.random() * (x1 - x0 - 40)
        by = y0 + RNG.random() * (y1 - y0 - 40)
        m.d.ellipse([bx, by, bx + 26 + RNG.random() * 18, by + 18],
                    fill=jit(shade(BENCH_TOP, 0.72), 5))
    # wrench
    wx, wy = x0 + 40, y0 + 34
    m.d.line([(wx, wy), (wx + 52, wy + 14)], fill=(168, 172, 178), width=5)
    m.d.ellipse([wx - 8, wy - 8, wx + 8, wy + 8], outline=(168, 172, 178),
                width=4)
    m.d.ellipse([wx + 46, wy + 8, wx + 60, wy + 22], outline=(168, 172, 178),
                width=4)
    # hammer
    hx, hy = x0 + 150, y0 + 90
    m.d.line([(hx, hy), (hx + 40, hy - 20)], fill=(130, 104, 74), width=4)
    m.d.rectangle([hx + 36, hy - 30, hx + 52, hy - 12], fill=(92, 96, 102))
    # scattered parts + bolts
    for _ in range(14):
        bx = x0 + 10 + RNG.random() * (x1 - x0 - 20)
        by = y0 + 10 + RNG.random() * (y1 - y0 - 20)
        r = 2 + RNG.random() * 3.5
        m.d.ellipse([bx - r, by - r, bx + r, by + r],
                    fill=jit((150, 152, 158), 12))
    # vice at the far end
    m.d.rectangle([x1 - 46, y0 + 20, x1 - 12, y0 + 58], fill=(52, 54, 58))
    m.d.rectangle([x1 - 46, y0 + 34, x1 - 12, y0 + 42],
                  fill=shade((52, 54, 58), 1.5))
    m.o.rectangle([x1 - 46, y0 + 20, x1 - 12, y0 + 58],
                  fill=(AO_SEAM, R_STEEL, M_STEEL))
    wear_edges(m, (x0, y0, x1, y1), BENCH_TOP, 60)
    # sides/legs: dark frame, mid shelf with stored boxes
    x0, y0, x1, y1 = L.W_BENCH_S.rect
    fill(m, (x0, y0, x1, y1), dif=(66, 68, 72), ao=AO_BASE - 14, rough=170,
         metal=140)
    m.d.rectangle([x0, y0, x1, y0 + 12], fill=shade(BENCH_TOP, 0.85))
    sy = y0 + int((y1 - y0) * 0.55)
    m.d.rectangle([x0 + 4, sy, x1 - 4, sy + 8], fill=(84, 86, 90))
    for i in range(5):
        bx = x0 + 14 + i * (x1 - x0 - 28) / 5
        m.d.rectangle([bx, sy - 22, bx + 24, sy - 2],
                      fill=jit((96, 88, 70), 10))
    wear_edges(m, (x0, y0, x1, y1), (66, 68, 72), 30)


def paint_bins(m):
    # sides: olive-steel bin, rib lines, stencil, hazard corner
    x0, y0, x1, y1 = L.W_BIN_S[0].rect
    fill(m, (x0, y0, x1, y1), dif=BIN_STEEL, ao=AO_BASE - 10, rough=185,
         metal=110)
    for fx in np.linspace(0.2, 0.8, 4):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 4, y1 - 4, BIN_STEEL,
               hi=False)
    m.d.rectangle([x0, y0 + 2, x1, y0 + 10], fill=shade(BIN_STEEL, 0.7))
    stencil(m, (x0 + 24, y0 + 30), 'PARTS', 20, shade(BIN_STEEL, 1.45),
            bridge=False)
    for i in range(4):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x1 - 40 + i * 9, y1 - 4), (x1 - 40 + i * 9 + 9, y1 - 4),
                     (x1 - 40 + i * 9 + 5, y1 - 16), (x1 - 40 + i * 9 - 4, y1 - 16)],
                    fill=c)
    wear_edges(m, (x0, y0, x1, y1), BIN_STEEL, 45)
    # open top: dark interior heaped with parts
    x0, y0, x1, y1 = L.W_BIN_T[0].rect
    fill(m, (x0, y0, x1, y1), dif=(30, 31, 34), ao=AO_DEEP, rough=195,
         metal=70)
    m.d.rectangle([x0, y0, x1 - 1, y1 - 1], outline=shade(BIN_STEEL, 0.85),
                  width=4)
    for _ in range(26):
        bx = x0 + 8 + RNG.random() * (x1 - x0 - 16)
        by = y0 + 8 + RNG.random() * (y1 - y0 - 16)
        r = 3 + RNG.random() * 6
        tone = jit((104, 100, 92), 26) if RNG.random() < 0.6 else \
            jit((124, 84, 56), 20)
        m.d.ellipse([bx - r, by - r, bx + r, by + r], fill=tone)
    for _ in range(6):   # rods
        bx = x0 + 12 + RNG.random() * (x1 - x0 - 40)
        by = y0 + 12 + RNG.random() * (y1 - y0 - 24)
        m.d.line([(bx, by), (bx + 20 + RNG.random() * 14, by + 6)],
                 fill=jit((140, 142, 148), 14), width=3)


def paint_props(m):
    # engine hoist: signal red, black feet, rating stencil
    x0, y0, x1, y1 = L.W_HOIST.rect
    fill(m, (x0, y0, x1, y1), dif=HOIST_RED, ao=AO_BASE - 8, rough=160,
         metal=90)
    m.d.rectangle([x0, y1 - 14, x1, y1], fill=BLACKISH)
    stencil(m, (x0 + 20, y0 + 20), '1T', 20, shade(HOIST_RED, 1.6),
            bridge=False)
    wear_edges(m, (x0, y0, x1, y1), HOIST_RED, 40)
    x0, y0, x1, y1 = L.W_HOISTP
    fill(m, (x0, y0, x1, y1), dif=HOIST_RED, ao=AO_BASE - 8, rough=160,
         metal=90)
    m.d.rectangle([x0, y0, x0 + 14, y1], fill=shade(HOIST_RED, 0.6))
    m.d.rectangle([x1 - 8, y0, x1, y1], fill=shade(HOIST_RED, 0.75))
    # drums: banded, stencilled, bunged caps
    x0, y0, x1, y1 = L.W_DRUM
    fill(m, (x0, y0, x1, y1), dif=(92, 88, 70), ao=AO_BASE - 8, rough=170,
         metal=130)
    for fy in (0.3, 0.62):
        sy = int(y0 + (y1 - y0) * fy)
        m.d.rectangle([x0, sy - 4, x1, sy + 4], fill=shade((92, 88, 70), 0.7))
    stencil(m, (x0 + 20, y0 + int((y1 - y0) * 0.42)), 'FUEL', 18,
            shade((92, 88, 70), 1.5), bridge=False)
    r = L.W_DRUM_T.rect
    fill(m, r, dif=(92, 88, 70), ao=AO_BASE - 10, rough=170, metal=130)
    ccx, ccy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    m.d.ellipse([ccx - 10, ccy - 10, ccx + 10, ccy + 10], fill=STEEL_DK)
    m.d.ellipse([ccx + 18, ccy - 4, ccx + 30, ccy + 8], fill=STEEL_DK)
    # crate: wood slats + straps + stencil
    x0, y0, x1, y1 = L.W_CRATE.rect
    fill(m, (x0, y0, x1, y1), dif=WOOD, ao=AO_BASE - 8, rough=200, metal=20)
    for fx in np.linspace(0.2, 0.8, 4):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 3, y1 - 3, WOOD, hi=False)
    for fy in (0.2, 0.8):
        sy = int(y0 + (y1 - y0) * fy)
        m.d.rectangle([x0, sy - 3, x1, sy + 3], fill=(70, 72, 76))
    stencil(m, (x0 + 20, y0 + int((y1 - y0) * 0.4)), 'MS-SUP', 16,
            shade(WOOD, 0.55), bridge=False)
    wear_edges(m, (x0, y0, x1, y1), WOOD, 40)
    # locker: two doors, louvres, handles, team patch
    x0, y0, x1, y1 = L.W_LOCKER.rect
    fill(m, (x0, y0, x1, y1), dif=LOCKER_C, ao=AO_BASE - 8, rough=170,
         metal=120)
    seam_v(m, (x0 + x1) // 2, y0 + 4, y1 - 4, LOCKER_C)
    vent_slots(m, [x0 + 12, y0 + 10, (x0 + x1) // 2 - 8, y0 + 26], 2)
    vent_slots(m, [(x0 + x1) // 2 + 8, y0 + 10, x1 - 12, y0 + 26], 2)
    for dx in (-8, 8):
        m.d.rectangle([(x0 + x1) // 2 + dx - 2, (y0 + y1) // 2 - 6,
                       (x0 + x1) // 2 + dx + 2, (y0 + y1) // 2 + 6],
                      fill=(180, 184, 188))
    m.t.rectangle([x0 + 8, y1 - 26, x0 + 30, y1 - 8], fill=(255, 0, 0))
    m.d.rectangle([x0 + 8, y1 - 26, x0 + 30, y1 - 8], fill=TEAMGREY)
    stencil(m, (x0 + 38, y1 - 28, ), 'TOOLS', 13, shade(LOCKER_C, 1.4),
            bridge=False)
    wear_edges(m, (x0, y0, x1, y1), LOCKER_C, 40)
    # rack: steel frame + boxed stock hints
    x0, y0, x1, y1 = L.W_RACK.rect
    fill(m, (x0, y0, x1, y1), dif=(78, 82, 88), ao=AO_BASE - 12, rough=170,
         metal=160)
    for fy in (0.33, 0.63, 0.92):
        sy = int(y0 + (y1 - y0) * fy)
        m.d.rectangle([x0 + 2, sy - 3, x1 - 2, sy + 3],
                      fill=shade((78, 82, 88), 0.7))
        for i in range(3):
            bx = x0 + 10 + i * (x1 - x0 - 20) / 3
            m.d.rectangle([bx, sy - 24, bx + 26, sy - 5],
                          fill=jit((104, 96, 78), 12))
    wear_edges(m, (x0, y0, x1, y1), (78, 82, 88), 25)
    # gas bottles wrap (u: bottom -> top): grey body, shoulder band, valve
    x0, y0, x1, y1 = L.W_GAS
    fill(m, (x0, y0, x1, y1), dif=(128, 133, 130), ao=AO_BASE - 8, rough=140,
         metal=160)
    m.d.rectangle([x0, y0, x0 + 12, y1], fill=(60, 62, 60))
    m.d.rectangle([x1 - 34, y0, x1 - 20, y1], fill=(212, 214, 210))
    m.d.rectangle([x1 - 10, y0, x1, y1], fill=(48, 50, 52))


# ── assembly ─────────────────────────────────────────────────────────────

def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_roof(m)
    paint_pad(m)
    paint_structure(m)
    paint_crane(m)
    paint_bench(m)
    paint_bins(m)
    paint_props(m)

    # ── weathering ──
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=90210)
    wx.crevice_grime(m.dif, 0.45)
    # pad: dust at the edges, oil under the crane travel + hoist + benches
    wx.mud_band(L.W_PAD.rect, 0.24, fade=None, spatter=True)
    zone = L.W_PAD
    hu0, hv0 = zone.uv((-4.8, 0, -1.4))
    hu1, hv1 = zone.uv((4.8, 0, 1.4))
    wx.oily((hu0 * W, hv0 * W, hu1 * W, hv1 * W), 0.45)
    bu0, bv0 = zone.uv((L.HOIST[0] - 1.0, 0, L.HOIST[1] - 1.6))
    bu1, bv1 = zone.uv((L.HOIST[0] + 1.0, 0, L.HOIST[1] + 0.6))
    wx.oily((bu0 * W, bv0 * W, bu1 * W, bv1 * W), 0.5)
    su, sv = zone.uv((L.BENCH_X + 0.9, 0, L.BENCH_ZC[0]))
    wx.soot_patch((su * W - 24, sv * W - 30, su * W + 24, sv * W + 30), 0.5)
    wx.mud_band(L.W_PADS_F.rect, 0.5, fade='down')
    wx.mud_band(L.W_PADS_S.rect, 0.5, fade='down')
    # roof: dust film + rust streaks running down-slope + eaten lower edge
    wx.mud_band(L.W_ROOF_T.rect, 0.3, fade=None, spatter=False, dust=0.3)
    x0, y0, x1, y1 = L.W_ROOF_T.rect
    for fx in (0.18, 0.36, 0.57, 0.8):
        wx.rust_streak(x0 + (x1 - x0) * fx, y0 + 40 + (fx * 200) % 60,
                       70, width=3.4, strength=0.4)
    wx.plate_bottom_rust(L.W_ROOF_T.rect, n=9, strength=0.5)
    wx.soot_patch((x0, y0, x0 + 90, y0 + 70), 0.25)
    # structure: mud up the post bases (u along limb: left = bottom)
    wx.mud_band(L.W_POST, 0.55, fade='left')
    wx.mud_band(L.W_GAS, 0.4, fade='left')
    wx.mud_band(L.W_HOISTP, 0.3, fade='left')
    # props: standing-water rust + streaks
    wx.plate_bottom_rust(L.W_BIN_S[0].rect, n=7, strength=0.65)
    for fx in (0.25, 0.6, 0.85):
        r = L.W_BIN_S[0].rect
        wx.rust_streak(r[0] + (r[2] - r[0]) * fx, r[1] + 12,
                       30, width=2.6, strength=0.45)
    wx.plate_bottom_rust(L.W_DRUM, n=6, strength=0.6)
    wx.plate_bottom_rust(L.W_LOCKER.rect, n=5, strength=0.5)
    wx.plate_bottom_rust(L.W_BENCH_S.rect, n=5, strength=0.45)
    wx.plate_bottom_rust(L.W_HOIST.rect, n=4, strength=0.4)
    wx.oily(L.W_TROLLEY.rect, 0.35)
    wx.oily(L.W_DARKP, 0.3)
    wx.oily((L.W_BENCH_T[0].rect), 0.25)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.5)
    wx.apply(m)

    # ── height -> normal map ──
    hm = NM.HeightMap()
    x0, y0, x1, y1 = L.W_ROOF_T.rect
    for gx in range(int(x0) + 4, int(x1), 8):       # corrugation ribs
        hm.line((gx, y0 + 2), (gx, y1 - 2), 0.42, width=2)
    for fy in np.linspace(0.18, 0.85, 4):           # lap seams recessed
        hm.line((x0 + 2, y0 + (y1 - y0) * fy), (x1 - 2, y0 + (y1 - y0) * fy),
                -0.3, width=2)
    zone = L.W_PAD
    x0, y0, x1, y1 = zone.rect
    for fx in np.linspace(0.2, 0.8, 4):             # expansion joints
        hm.line((x0 + (x1 - x0) * fx, y0 + 2), (x0 + (x1 - x0) * fx, y1 - 2),
                -0.5, width=3)
    for fy in np.linspace(0.25, 0.75, 3):
        hm.line((x0 + 2, y0 + (y1 - y0) * fy), (x1 - 2, y0 + (y1 - y0) * fy),
                -0.5, width=3)
    hm.crevices_from(m.dif, 0.55)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.4).save(f'{OUT}/{STEM}_normals.png')

    # emissive stays black: the spec declares no lights on this kit
    m.dif.save(f'{OUT}/{STEM}_diffuse.png')
    m.orm.save(f'{OUT}/{STEM}_orm.png')
    m.emi.save(f'{OUT}/{STEM}_emissive.png')
    m.tea.save(f'{OUT}/{STEM}_team.png')
    print(f'[paint_ms_field_workshop] full 1024 texture set written to {OUT}/')


if __name__ == '__main__':
    paint_all()
