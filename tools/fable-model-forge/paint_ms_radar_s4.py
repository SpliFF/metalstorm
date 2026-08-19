"""paint_ms_radar_s4 — 1024² PBR set for ms_radar_s4.

Same field-hardware language as ms_radar_s1 / ms_comms_relay, scaled to a
theatre installation: weathered battered concrete bunker with hazard
corners, a stencilled team ID numeral on the front batter, an ARMOR-grey
blast door, sandbagged revetment, canvas-over-frame geodesic radome
panels (one obvious replacement panel of a different shade), galvanised
lattice mast and guy lines, and a slotted search-array bar.
Emissive = amber lamps only.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import ms_radar_s4_layout as L      # sets meshlib.ATLAS = 1024
import meshlib as M
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024
import paintlib as PL

from paint import font
from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, STEEL, STEEL_DK,
                   YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS)

W = 1024
CONCRETE = (146, 144, 138)
CONC_DK = (124, 122, 116)
GALV = (166, 170, 175)
CABLE = (94, 98, 104)
CANVAS = (196, 190, 174)          # radome panel canvas
CANVAS_2 = (186, 181, 166)
CANVAS_3 = (203, 197, 181)
PATCH = (150, 122, 96)            # the mismatched replacement panel
SAND = (172, 158, 126)
AMBER = (255, 176, 60)
RNG = np.random.default_rng(90210)


# ── plinth ───────────────────────────────────────────────────────────────

def paint_plinth(m):
    x0, y0, x1, y1 = L.R_PL_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE, rough=R_ARMOR + 22, metal=0)
    for f in (0.25, 0.5, 0.75):
        m.d.line([(x0 + (x1-x0)*f, y0+2), (x0 + (x1-x0)*f, y1-2)],
                 fill=shade(CONCRETE, 0.88), width=2)
        m.d.line([(x0+2, y0 + (y1-y0)*f), (x1-2, y0 + (y1-y0)*f)],
                 fill=shade(CONCRETE, 0.88), width=2)
    cw = 44
    for cx, cy in ((x0, y0), (x1-cw, y0), (x0, y1-cw), (x1-cw, y1-cw)):
        for i in range(0, cw, 14):
            m.d.polygon([(cx+i, cy), (cx+i+7, cy), (cx, cy+i+7), (cx, cy+i)],
                        fill=YELLOW if (i//14) % 2 == 0 else BLACKISH)
    bolts(m, [(x0+22, y0+22), (x1-22, y0+22), (x0+22, y1-22), (x1-22, y1-22)],
          r=4, base=CONCRETE)
    # guy-anchor plates on the deck
    u, v = PL.zone_fns(L.R_PL_TOP)
    for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        gx = min(max(L.MAST_X + sx * L.GUY_R, -2.85), 2.85)
        gz = min(max(L.MAST_Z + sz * L.GUY_R, -2.85), 2.85)
        ax, ay = u(gx), v(gz)
        m.d.rectangle([ax-14, ay-14, ax+14, ay+14], fill=STEEL)
        m.o.rectangle([ax-14, ay-14, ax+14, ay+14], fill=(AO_BASE-8, R_STEEL, M_STEEL))
        bolts(m, [(ax-8, ay-8), (ax+8, ay-8), (ax-8, ay+8), (ax+8, ay+8)],
              r=3, base=STEEL)

    # ── front batter: concrete, form-board lines, team ID numeral ──
    for zi, z in enumerate((L.R_PL_F, L.R_PL_S)):
        x0, y0, x1, y1 = z.rect
        fill(m, (x0, y0, x1, y1), dif=CONC_DK, ao=AO_BASE - 6,
             rough=R_ARMOR + 22, metal=0)
        for k in range(1, 5):                      # form-board shutter lines
            yy = y0 + (y1 - y0) * k / 5
            m.d.line([(x0+2, yy), (x1-2, yy)], fill=shade(CONC_DK, 0.90), width=2)
        for k in range(1, 8):
            xx = x0 + (x1 - x0) * k / 8
            m.d.line([(xx, y0+2), (xx, y1-2)], fill=shade(CONC_DK, 0.93), width=1)
        wear_edges(m, z.rect, CONC_DK, density=14)
        if zi == 1:
            # patch-plate dressing bolted onto the side batter
            PL.panel_patchwork(m, (x0 + 150, y0 + 26, x0 + 330, y1 - 20),
                               [shade(ARMOR, 0.94), ARMOR_DK, shade(STEEL, 0.86),
                                shade(ARMOR, 1.04)], cols=3, rows=2, seed=90210)

    # stencilled team ID panel + numeral on the front batter
    z = L.R_PL_F
    u, v = PL.zone_fns(z)
    box = PL.nbox(u(1.20), v(1.42), u(2.75), v(0.28))
    PL.team_panel(m, box, outline=CONC_DK, width=3)
    f = PL.font(int((box[3] - box[1]) * 0.86))
    tx, ty = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    m.d.text((tx, ty), 'S4', font=f, fill=shade(TEAMGREY, 0.55), anchor='mm')
    m.t.text((tx, ty), 'S4', font=f, fill=(90, 0, 0), anchor='mm')


def paint_door(m):
    z = L.R_DOOR
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 8, rough=R_ARMOR, metal=M_ARMOR)
    m.d.rectangle([x0+10, y0+10, x1-10, y1-10], outline=shade(ARMOR, 0.58), width=4)
    seam_v(m, y0+16, y1-16, (x0+x1)//2, ARMOR)     # twin leaf
    for hy in (y0 + 46, (y0+y1)//2, y1 - 46):      # hinges + dogs
        m.d.rectangle([x0+14, hy-7, x0+38, hy+7], fill=STEEL_DK)
        m.d.rectangle([x1-38, hy-7, x1-14, hy+7], fill=STEEL_DK)
    m.d.ellipse([(x0+x1)//2 - 16, (y0+y1)//2 - 16,
                 (x0+x1)//2 + 16, (y0+y1)//2 + 16], outline=STEEL_DK, width=5)
    PL.hazard_band(m, (x0+10, y1-30, x1-10, y1-12))
    bolts(m, [(x0+18, y0+18), (x1-18, y0+18), (x0+18, y1-18), (x1-18, y1-18)],
          base=ARMOR)
    wear_edges(m, z.rect, ARMOR, density=20)

    # sandbags
    z = L.R_BAG
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=SAND, ao=AO_BASE - 12, rough=R_ARMOR + 40, metal=0)
    for r in range(6):
        yy = y0 + (y1 - y0) * (r + 0.5) / 6
        m.d.line([(x0+2, yy), (x1-2, yy)], fill=shade(SAND, 0.82), width=3)
    for c in range(9):
        xx = x0 + (x1 - x0) * (c + 0.5) / 9
        m.d.line([(xx, y0+2), (xx, y1-2)], fill=shade(SAND, 0.86), width=2)


def paint_dome(m):
    """Twelve canvas panel cells; each facet maps to one whole cell so the
    cell border reads as a bolted panel seam. Cell 11 = replacement panel."""
    ox, oy = L.DOME_CELL_ORIGIN
    c = L.DOME_CELL
    tones = [CANVAS, CANVAS_2, CANVAS_3]
    for idx in range(L.DOME_COLS * L.DOME_ROWS):
        col, row = idx % L.DOME_COLS, idx // L.DOME_COLS
        x0, y0 = ox + col * c, oy + row * c
        x1, y1 = x0 + c, y0 + c
        base = PATCH if idx == L.DOME_REPAIR_CELL else jit(tones[idx % 3], 4)
        fill(m, (x0, y0, x1, y1), dif=base, ao=AO_BASE - 4,
             rough=R_ARMOR + 34, metal=0)
        # frame seam: a darker border ring = the panel edge / bolted flange
        m.d.rectangle([x0, y0, x1-1, y1-1], outline=shade(base, 0.70), width=6)
        m.o.rectangle([x0, y0, x1-1, y1-1],
                      fill=None, outline=(AO_SEAM, R_ARMOR + 34, 0), width=6)
        # a light stiffener cross, tone-on-tone (baker-safe)
        m.d.line([(x0+10, y0+c//2), (x1-10, y0+c//2)], fill=shade(base, 0.93), width=3)
        m.d.line([(x0+c//2, y0+10), (x0+c//2, y1-10)], fill=shade(base, 0.93), width=3)
        bolts(m, [(x0+14, y0+14), (x1-14, y0+14), (x0+14, y1-14), (x1-14, y1-14)],
              r=3, base=base)
        if idx == L.DOME_REPAIR_CELL:              # crude field repair
            m.d.line([(x0+18, y1-24), (x1-18, y0+30)], fill=shade(PATCH, 0.62), width=5)
    # skirt band: darker canvas over a steel kerb
    fill(m, L.R_SKIRT, dif=shade(CANVAS, 0.76), ao=AO_BASE - 12,
         rough=R_ARMOR + 30, metal=0)
    x0, y0, x1, y1 = L.R_SKIRT
    for k in range(1, 6):
        yy = y0 + (y1 - y0) * k / 6
        m.d.line([(x0+2, yy), (x1-2, yy)], fill=shade(CANVAS, 0.62), width=3)


def paint_details(m):
    fill(m, L.R_MAST, dif=GALV, ao=AO_BASE - 4, rough=R_STEEL - 10, metal=M_STEEL)
    x0, y0, x1, y1 = L.R_MAST
    for gy in range(int(y0)+14, int(y1), 22):
        m.d.line([(x0+2, gy), (x1-2, gy)], fill=shade(GALV, 0.90), width=2)
    fill(m, L.R_TRIM, dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL, metal=M_STEEL)
    fill(m, L.R_GUY, dif=CABLE, ao=AO_BASE - 10, rough=R_STEEL + 14, metal=M_STEEL - 40)
    fill(m, L.R_COLLAR, dif=STEEL, ao=AO_BASE - 6, rough=R_STEEL, metal=M_STEEL)
    x0, y0, x1, y1 = L.R_COLLAR
    for gx in range(int(x0)+18, int(x1), 30):
        m.d.line([(gx, y0+2), (gx, y1-2)], fill=shade(STEEL, 0.86), width=2)
    fill(m, L.R_VENT, dif=shade(ARMOR, 0.88), ao=AO_BASE - 8, rough=R_STEEL + 20,
         metal=M_ARMOR)
    x0, y0, x1, y1 = L.R_VENT
    for gy in range(int(y0)+16, int(y1), 20):
        m.d.line([(x0+2, gy), (x1-2, gy)], fill=shade(ARMOR, 0.72), width=3)
    fill(m, L.R_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 16, metal=M_ARMOR)
    # crow's nest deck
    z = L.R_NEST
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ARMOR, 0.92), ao=AO_BASE - 8,
         rough=R_STEEL + 16, metal=M_ARMOR)
    for k in range(1, 6):
        m.d.line([(x0 + (x1-x0)*k/6, y0+2), (x0 + (x1-x0)*k/6, y1-2)],
                 fill=shade(ARMOR, 0.80), width=3)
    bolts(m, [(x0+12, y0+12), (x1-12, y0+12), (x0+12, y1-12), (x1-12, y1-12)],
          base=ARMOR)
    # trench cover
    z = L.R_CONC
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CONCRETE, 0.92), ao=AO_BASE - 10,
         rough=R_ARMOR + 24, metal=0)
    for k in range(1, 8):
        m.d.line([(x0 + (x1-x0)*k/8, y0+2), (x0 + (x1-x0)*k/8, y1-2)],
                 fill=shade(CONCRETE, 0.78), width=3)
    # amber lamps — the model's only emissive
    z = L.R_LIGHT
    fill(m, z.rect, dif=AMBER, ao=AO_BASE, rough=R_GLASS, metal=M_GLASS)
    x0, y0, x1, y1 = z.rect
    m.e.rectangle([x0+2, y0+2, x1-2, y1-2], fill=shade(AMBER, 0.82))


def paint_bar(m):
    # slotted front face
    z = L.R_BAR_F
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 6, rough=R_ARMOR, metal=M_ARMOR)
    u, v = PL.zone_fns(z)
    n = 26
    sx0, sx1 = u(L.BAR_X0 + 0.12), u(L.BAR_X1 - 0.12)
    for i in range(n):
        a = sx0 + (sx1 - sx0) * (i + 0.18) / n
        b = sx0 + (sx1 - sx0) * (i + 0.82) / n
        m.d.rectangle([a, y0 + 34, b, y1 - 34], fill=shade(ARMOR, 0.70))
        m.o.rectangle([a, y0 + 34, b, y1 - 34], fill=(AO_SEAM, R_ARMOR + 18, M_ARMOR))
    m.d.rectangle([x0+2, y0+2, x1-2, y1-2], outline=shade(ARMOR, 0.60), width=4)
    wear_edges(m, z.rect, ARMOR, density=22)
    # back face
    z = L.R_BAR_B
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ARMOR, 0.86), ao=AO_BASE - 10,
         rough=R_ARMOR + 12, metal=M_ARMOR)
    for k in range(1, 12):
        xx = x0 + (x1-x0)*k/12
        m.d.line([(xx, y0+6), (xx, y1-6)], fill=shade(ARMOR, 0.72), width=3)
    # top / underside / ends
    for z, tone in ((L.R_BAR_T, 0.96), (L.R_BAR_U, 0.80), (L.R_BAR_E, 0.90)):
        x0, y0, x1, y1 = z.rect
        fill(m, (x0, y0, x1, y1), dif=shade(ARMOR, tone), ao=AO_BASE - 8,
             rough=R_ARMOR + 8, metal=M_ARMOR)
        seam_h(m, x0+2, x1-2, (y0+y1)//2, ARMOR)
    # reflector spine: galvanised mesh read
    z = L.R_SPINE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(GALV, 0.86), ao=AO_BASE - 12,
         rough=R_STEEL + 8, metal=M_STEEL)
    for k in range(1, 16):
        xx = x0 + (x1-x0)*k/16
        m.d.line([(xx, y0+2), (xx, y1-2)], fill=shade(GALV, 0.74), width=2)
    for k in range(1, 4):
        yy = y0 + (y1-y0)*k/4
        m.d.line([(x0+2, yy), (x1-2, yy)], fill=shade(GALV, 0.74), width=2)
    # counterweight: scrap-plate block
    z = L.R_CW
    PL.panel_patchwork(m, z.rect, [ARMOR_DK, shade(STEEL, 0.78),
                                   shade(ARMOR, 0.88)], cols=2, rows=2, seed=90210)
    x0, y0, x1, y1 = z.rect
    PL.hazard_band(m, (x0+6, y1-26, x1-6, y1-8))


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_plinth(m)
    paint_door(m)
    paint_dome(m)
    paint_details(m)
    paint_bar(m)

    wx = PL.standard_weather(
        m, L,
        ground_rects=(L.R_PL_F.rect, L.R_PL_S.rect, L.R_BAG.rect),
        side_zones=(L.R_DOOR, L.R_BAR_F, L.R_BAR_B),
        seed=53, mud=0.42, grime=0.5, rust_fraction=0.45)
    wx.mud_band(L.R_PL_TOP.rect, 0.25, fade=None, spatter=True)
    for k in range(4):
        wx.rust_streak(L.R_PL_F.rect[0] + 40 + k * 90, L.R_PL_F.rect[1] + 8,
                       34, width=2.6, strength=0.32)
    wx.rust_streak(L.R_MAST[0] + 60, L.R_MAST[1] + 14, 30, width=2.0, strength=0.28)
    wx.rust_streak(L.R_BAR_B.rect[0] + 240, L.R_BAR_B.rect[1] + 10, 30,
                   width=2.2, strength=0.26)
    ox, oy = L.DOME_CELL_ORIGIN
    for idx in (3, 6, 11):
        col, row = idx % L.DOME_COLS, idx // L.DOME_COLS
        wx.rust_streak(ox + col * L.DOME_CELL + 30,
                       oy + row * L.DOME_CELL + 14, 40, width=2.4, strength=0.30)

    from normals import HeightMap
    hm = HeightMap()
    x0, y0, x1, y1 = L.R_PL_TOP.rect
    for f in (0.25, 0.5, 0.75):
        hm.line((x0 + (x1-x0)*f, y0+2), (x0 + (x1-x0)*f, y1-2), -0.5, width=2)
        hm.line((x0+2, y0 + (y1-y0)*f), (x1-2, y0 + (y1-y0)*f), -0.5, width=2)
    ox, oy = L.DOME_CELL_ORIGIN
    for idx in range(L.DOME_COLS * L.DOME_ROWS):
        col, row = idx % L.DOME_COLS, idx // L.DOME_COLS
        cx0, cy0 = ox + col * L.DOME_CELL, oy + row * L.DOME_CELL
        c = L.DOME_CELL
        for a, b in (((cx0, cy0), (cx0+c, cy0)), ((cx0, cy0), (cx0, cy0+c)),
                     ((cx0+c, cy0), (cx0+c, cy0+c)), ((cx0, cy0+c), (cx0+c, cy0+c))):
            hm.line(a, b, 0.6, width=5)

    PL.finish(m, L, 'ms_radar_s4', hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
