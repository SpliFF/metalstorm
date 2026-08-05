"""paint_ms_command_post — 1024^2 PBR set for ms_command_post.

"CP-01" staging-post command building: weathered concrete pad with a
marked approach lane to the lit doorway, corrugated prefab walls with a
warm lit window band + doorway glow, rooftop command module with a
strongly lit vision band, sandbag skirt (staggered tan/olive bags),
galvanized antenna mast with cyan array + red beacon, genset with soot
and oil, and a fully team-masked flag cloth. Military family: same
concrete/panel language as ms_garrison; team mask on the flag, gate
banner and roof code. NO team colour baked in diffuse.
"""
from __future__ import annotations
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

import ms_command_post_layout as L      # sets meshlib.ATLAS = 1024
import paint as P
if not os.path.exists(P.FONT):
    P.FONT = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, stencil, BOLT_LOG,
                   ARMOR, ARMOR_DK, STEEL_DK, GLASS, YELLOW, BLACKISH,
                   TEAMGREY, CYAN,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, RNG)

W = 1024
CONCRETE = (143, 140, 132)
PANEL = (117, 124, 130)      # corrugated prefab wall panel
ROOF = (90, 96, 103)
GALV = (160, 164, 169)
SAND = (150, 134, 100)       # sandbag tan
SAND_OL = (116, 110, 82)     # olive bag variant
WARM = (255, 205, 135)       # lit windows / doorway
AMBER = (255, 176, 60)
OLIVE = (88, 94, 78)         # equipment boxes


def corrugate(m, rect, base, step=8, shade_f=0.88):
    x0, y0, x1, y1 = rect
    for gx in range(int(x0) + step // 2, int(x1), step):
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)], fill=shade(base, shade_f),
                 width=1)


def window_band(m, zone, w0, w1, wy0=1.85, wy1=2.5, lit=0.5, step=0.9):
    """Lit window strip in wall-zone world coords (u axis value w0..w1)."""
    ax = zone.axes[0]
    _, vy0 = zone.uv((0, wy1, 0) if ax != 'y' else (0, wy1, 0))
    _, vy1 = zone.uv((0, wy0, 0))
    y0, y1 = vy0 * W, vy1 * W
    lo, hi = min(w0, w1), max(w0, w1)
    for wpos in np.arange(lo + 0.25, hi - 0.5, step):
        pnt = [0.0, 0.0, 0.0]
        pnt['xyz'.index(ax.strip('-'))] = wpos
        u0, _ = zone.uv(tuple(pnt))
        pnt['xyz'.index(ax.strip('-'))] = wpos + 0.58
        u1, _ = zone.uv(tuple(pnt))
        wx0, wx1 = sorted((u0 * W, u1 * W))
        m.d.rectangle([wx0, y0, wx1, y1], fill=GLASS, outline=STEEL_DK,
                      width=2)
        m.o.rectangle([wx0, y0, wx1, y1], fill=(AO_BASE - 14, R_GLASS, 0))
        if RNG.random() < lit:
            m.e.rectangle([wx0 + 2, y0 + 2, wx1 - 2, y1 - 2],
                          fill=shade(WARM, 0.55))


def paint_pad(m):
    z = L.C_PAD
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE, rough=R_ARMOR + 24,
         metal=0)

    def X(wx):
        return z.uv((wx, 0, 0))[0] * W

    def Z(wz):
        return z.uv((0, 0, wz))[1] * W
    # expansion joints every ~3 m
    for w in np.arange(-4.5, 5.0, 3.0):
        m.d.line([(X(w), y0 + 2), (X(w), y1 - 2)], fill=shade(CONCRETE, 0.85),
                 width=2)
    for w in np.arange(-2.0, 3.0, 2.0):
        m.d.line([(x0 + 2, Z(w)), (x1 - 2, Z(w))], fill=shade(CONCRETE, 0.85),
                 width=2)
    # tonal patches
    for _ in range(10):
        bx = x0 + RNG.random() * (x1 - x0 - 70)
        by = y0 + RNG.random() * (y1 - y0 - 40)
        m.d.polygon([(bx, by + 8), (bx + 52, by), (bx + 66, by + 24),
                     (bx + 14, by + 32)], fill=jit(shade(CONCRETE, 0.94), 3))
    # approach lane to the door gap (door at x -1.6, front edge)
    m.d.line([(X(L.GAP_X0 + 0.15), Z(-4.15)), (X(L.GAP_X0 + 0.15), Z(-2.7))],
             fill=YELLOW, width=3)
    m.d.line([(X(L.GAP_X1 - 0.15), Z(-4.15)), (X(L.GAP_X1 - 0.15), Z(-2.7))],
             fill=YELLOW, width=3)
    cx = X(L.DOOR_X)
    for i in range(3):
        yy = Z(-3.9) + i * 16
        m.d.polygon([(cx - 12, yy + 8), (cx, yy), (cx + 12, yy + 8),
                     (cx + 12, yy + 13), (cx, yy + 5), (cx - 12, yy + 13)],
                    fill=YELLOW)
    # genset service square + pad code
    m.d.rectangle([X(-6.05), Z(2.0), X(-4.4), Z(3.6)], outline=YELLOW, width=3)
    f = ImageFont.truetype(P.FONT, 40)
    m.d.text((X(3.2), Z(-3.9)), 'CP-01', font=f, fill=shade(CONCRETE, 0.72))
    # pad skirt sides + hazard lip at the front edge
    x0, y0, x1, y1 = L.C_PADS.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CONCRETE, 0.92), ao=AO_BASE - 12,
         rough=R_ARMOR + 26, metal=0)
    for i in range(int((x1 - x0) / 14) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 14, y0 + 2), (x0 + i * 14 + 14, y0 + 2),
                     (x0 + i * 14 + 7, y0 + 10), (x0 + i * 14 - 7, y0 + 10)],
                    fill=c)


def paint_walls(m):
    # shared language: corrugated panels + wainscot + window band
    for zone, is_front in ((L.C_WALL_F, True), (L.C_WALL_R, False),
                           (L.C_WALL_S, False)):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=PANEL, ao=AO_BASE - 4,
             rough=R_ARMOR + 10, metal=M_ARMOR + 20)
        corrugate(m, (x0, y0, x1, y1), PANEL)
        # structural pilasters
        for fx in np.linspace(0.06, 0.94, 5):
            sx = x0 + (x1 - x0) * fx
            m.d.rectangle([sx - 3, y0 + 3, sx + 3, y1 - 3],
                          fill=shade(PANEL, 0.7))
            m.o.rectangle([sx - 3, y0 + 3, sx + 3, y1 - 3],
                          fill=(AO_SEAM, R_ARMOR, M_ARMOR))
        # dark wainscot (bottom ~0.8 m)
        _, wv = zone.uv((0, 0.85, 0))
        wy = int(wv * W)
        m.d.rectangle([x0, wy, x1, y1], fill=shade(PANEL, 0.62))
        m.o.rectangle([x0, wy, x1, y1], fill=(AO_BASE - 22, R_ARMOR + 16,
                                              M_ARMOR))
        seam_h(m, x0, x1, wy, PANEL)
        # eave trim
        m.d.rectangle([x0, y0 + 2, x1, y0 + 10], fill=shade(PANEL, 0.75))
        wear_edges(m, (x0, wy, x1, y1), shade(PANEL, 0.62), 40)
    # window bands (front band drawn after the door below)
    window_band(m, L.C_WALL_S, -2.9, 3.3, lit=0.45)
    window_band(m, L.C_WALL_R, -3.4, 5.0, lit=0.35)
    window_band(m, L.C_WALL_F, 0.2, 5.0, lit=0.55)

    # ── front wall: doorway + glow + banner ──
    z = L.C_WALL_F
    du0, dv0 = z.uv((L.DOOR_X + L.DOOR_W / 2, L.PAD_TOP + L.DOOR_H, 0))
    du1, dv1 = z.uv((L.DOOR_X - L.DOOR_W / 2, L.PAD_TOP + 0.02, 0))
    db = [du0 * W, dv0 * W, du1 * W, dv1 * W]
    # warm spill halo painted around the doorway on the emissive map
    m.e.rectangle([db[0] - 7, db[1] - 7, db[2] + 7, db[3]],
                  fill=shade(WARM, 0.30))
    m.d.rectangle([db[0] - 7, db[1] - 7, db[2] + 7, db[3]],
                  fill=shade(PANEL, 1.06))
    # door leaf: dark steel, horizontal ribs, lit slit window
    m.d.rectangle(db, fill=(56, 60, 66), outline=shade(PANEL, 0.5), width=3)
    m.o.rectangle(db, fill=(AO_BASE - 20, R_STEEL, M_STEEL - 40))
    for i in range(1, 5):
        sy = db[1] + (db[3] - db[1]) * i / 5
        m.d.line([(db[0] + 3, sy), (db[2] - 3, sy)],
                 fill=shade((56, 60, 66), 0.7), width=2)
    m.d.rectangle([db[0] + 6, db[1] + 8, db[2] - 6, db[1] + 16], fill=GLASS)
    m.e.rectangle([db[0] + 7, db[1] + 9, db[2] - 7, db[1] + 15],
                  fill=shade(WARM, 0.8))
    # doorway lamp above (under the canopy)
    m.e.rectangle([db[0] + 4, db[1] - 13, db[2] - 4, db[1] - 8], fill=WARM)
    m.d.rectangle([db[0] + 4, db[1] - 13, db[2] - 4, db[1] - 8],
                  fill=(70, 66, 58))
    stencil(m, (db[2] + 8, db[1] - 4), 'HQ', 15, shade(PANEL, 1.32),
            bridge=False)
    # team banner strip along the eave, right of the door
    x0, y0, x1, y1 = z.rect
    bu0, _ = z.uv((4.9, 0, 0))
    bu1, _ = z.uv((0.6, 0, 0))
    bb = [min(bu0, bu1) * W, y0 + 12, max(bu0, bu1) * W, y0 + 30]
    m.t.rectangle(bb, fill=(255, 0, 0))
    m.d.rectangle(bb, fill=TEAMGREY)
    stencil(m, (bb[0] + 6, bb[1] + 1), 'COMMAND 01', 14, shade(ARMOR_DK, 0.55),
            bridge=False)
    bolts(m, [(x, y) for x in range(int(x0) + 30, int(x1) - 10, 120)
              for y in (y0 + 16, y1 - 14)], base=PANEL)

    # rear wall extras: conduit + code
    z = L.C_WALL_R
    x0, y0, x1, y1 = z.rect
    cy = int(y0 + (y1 - y0) * 0.52)
    m.d.line([(x0 + 8, cy), (x1 - 8, cy)], fill=shade(GALV, 0.8), width=4)
    m.o.line([(x0 + 8, cy), (x1 - 8, cy)], fill=(AO_SEAM, R_STEEL, M_STEEL)),
    f = ImageFont.truetype(P.FONT, 40)
    m.d.text((x0 + 40 + 2, y1 - 84 + 2), 'CP-01', font=f,
             fill=shade(PANEL, 0.55))
    m.d.text((x0 + 40, y1 - 84), 'CP-01', font=f, fill=(198, 202, 206))


def paint_roofs(m):
    # hall roof: sheet seams + walk strip + team-masked roof code
    z = L.C_ROOF
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ROOF, ao=AO_BASE - 4, rough=R_ARMOR + 14,
         metal=M_ARMOR + 30)
    for fx in np.linspace(0.15, 0.85, 5):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 3, y1 - 3, ROOF, hi=False)
    m.d.rectangle([x0 + 12, y0 + 12, x0 + 46, y1 - 12],
                  fill=shade(ROOF, 1.10))
    f = ImageFont.truetype(P.FONT, 44)
    m.d.text((x0 + (x1 - x0) * 0.12, y0 + (y1 - y0) * 0.6), 'CP-01', font=f,
             fill=shade(ROOF, 0.6))
    m.t.text((x0 + (x1 - x0) * 0.12, y0 + (y1 - y0) * 0.6), 'CP-01', font=f,
             fill=(255, 0, 0))
    wear_edges(m, (x0, y0, x1, y1), ROOF, 35)
    # command module walls: armored band + strongly lit vision band
    for z in (L.C_UP_S, L.C_UP_F):
        x0, y0, x1, y1 = z.rect
        fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 2, rough=R_ARMOR,
             metal=M_ARMOR)
        vy0 = y0 + (y1 - y0) * 0.22
        vy1 = y0 + (y1 - y0) * 0.5
        m.d.rectangle([x0 + 8, vy0, x1 - 8, vy1], fill=(26, 34, 40))
        m.o.rectangle([x0 + 8, vy0, x1 - 8, vy1], fill=(AO_BASE - 14,
                                                        R_GLASS, 0))
        npanes = 7
        for i in range(npanes):
            px0 = x0 + 12 + (x1 - x0 - 24) * i / npanes
            px1 = x0 + 12 + (x1 - x0 - 24) * (i + 0.84) / npanes
            if RNG.random() < 0.75:
                m.e.rectangle([px0, vy0 + 4, px1, vy1 - 4],
                              fill=shade(WARM, 0.5))
        seam_h(m, x0 + 4, x1 - 4, int(y0 + (y1 - y0) * 0.62), ARMOR)
        bolts(m, [(x, y1 - 10) for x in range(int(x0) + 16, int(x1), 70)],
              base=ARMOR)
    z = L.C_UP_R
    fill(m, z.rect, dif=shade(ARMOR, 0.95), ao=AO_BASE - 4,
         rough=R_ARMOR + 8, metal=M_ARMOR)
    x0, y0, x1, y1 = z.rect
    seam_v(m, (x0 + x1) // 2, y0 + 3, y1 - 3, ARMOR, hi=False)
    bolts(m, [(x, y) for x in (x0 + 14, x1 - 14) for y in (y0 + 14, y1 - 14)],
          base=ARMOR)
    # canopy: dark steel slab with a warm strip on the front edge cell
    z = L.C_CANOPY
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL - 30)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, STEEL_DK, hi=False)
    m.e.rectangle([x0 + 3, y1 - 6, x1 - 3, y1 - 2], fill=shade(WARM, 0.4))


def paint_sandbags(m):
    """Staggered bag rows; same pattern for wall band + top band."""
    for zone, rows in ((L.C_SAND.rect, 3), (L.C_SAND_T.rect, 2)):
        x0, y0, x1, y1 = zone
        fill(m, (x0, y0, x1, y1), dif=SAND, ao=AO_BASE - 10,
             rough=R_ARMOR + 40, metal=0)
        rh = (y1 - y0) / rows
        bag_w = 18
        for r in range(rows):
            off = (r % 2) * bag_w // 2
            by0 = y0 + r * rh
            for bx in range(int(x0) - off, int(x1), bag_w):
                col = SAND_OL if RNG.random() < 0.28 else jit(SAND, 7)
                m.d.ellipse([bx + 1, by0 + 1, bx + bag_w - 1, by0 + rh - 1],
                            fill=col, outline=shade(col, 0.72), width=1)
                m.o.ellipse([bx + 1, by0 + 1, bx + bag_w - 1, by0 + rh - 1],
                            fill=(AO_BASE - 6, R_ARMOR + 44, 0))
                # crease between bags collects shadow
                m.o.ellipse([bx + 5, by0 + int(rh * 0.55), bx + bag_w - 5,
                             by0 + int(rh) - 1], fill=(AO_SEAM, R_ARMOR + 44, 0))


def paint_flag(m):
    """Cloth: fully team-masked field, symmetric dark emblem (same zone
    projects both faces -> any text would mirror), stitch hem, fray."""
    z = L.C_FLAG
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=TEAMGREY, ao=AO_BASE - 4,
         rough=R_ARMOR + 36, metal=0)
    m.t.rectangle([x0, y0, x1, y1], fill=(255, 0, 0))
    # cloth fold shading (vertical waves)
    for i, fx in enumerate(np.linspace(0.12, 0.9, 6)):
        sx = x0 + (x1 - x0) * fx
        m.d.line([(sx, y0 + 2), (sx, y1 - 2)],
                 fill=shade(TEAMGREY, 0.88 if i % 2 else 1.08), width=4)
    # symmetric emblem: dark roundel + chevron (mask cut so it stays dark)
    ccx, ccy = (x0 + x1) / 2, (y0 + y1) / 2
    m.d.ellipse([ccx - 30, ccy - 30, ccx + 30, ccy + 30], fill=(40, 44, 48))
    m.t.ellipse([ccx - 30, ccy - 30, ccx + 30, ccy + 30], fill=(0, 0, 0))
    chev = [(ccx - 16, ccy + 12), (ccx, ccy - 14), (ccx + 16, ccy + 12),
            (ccx + 16, ccy + 20), (ccx, ccy - 5), (ccx - 16, ccy + 20)]
    m.d.polygon(chev, fill=TEAMGREY)
    m.t.polygon(chev, fill=(255, 0, 0))
    # hoist hem + fly-edge fray
    m.d.rectangle([x0, y0, x0 + 8, y1], fill=shade(TEAMGREY, 0.8))
    for fy in np.linspace(0.08, 0.92, 7):
        ny = y0 + (y1 - y0) * fy
        m.d.polygon([(x1 - 8, ny - 4), (x1, ny), (x1 - 8, ny + 4)],
                    fill=(40, 44, 48))
        m.t.polygon([(x1 - 8, ny - 4), (x1, ny), (x1 - 8, ny + 4)],
                    fill=(0, 0, 0))


def paint_props(m):
    # mast/pole/whip wrap: galvanized with joint bands
    x0, y0, x1, y1 = L.C_MAST
    fill(m, (x0, y0, x1, y1), dif=GALV, ao=AO_BASE - 4, rough=R_STEEL - 20,
         metal=M_STEEL)
    for fx in (0.3, 0.62):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 2, y0, sx + 2, y1], fill=shade(GALV, 0.8))
    # generic equipment cell (genset + comms cabinet): olive, vents, hazard
    x0, y0, x1, y1 = L.C_PROP
    fill(m, (x0, y0, x1, y1), dif=OLIVE, ao=AO_BASE - 8, rough=R_ARMOR + 16,
         metal=M_ARMOR + 30)
    seam_h(m, x0 + 4, x1 - 4, (y0 + y1) // 2 + 8, OLIVE, hi=False)
    vent_slots(m, [x0 + 14, y0 + 12, x0 + 74, y0 + 40], 4)
    m.d.rectangle([x1 - 60, y0 + 12, x1 - 16, y0 + 40], fill=STEEL_DK)
    stencil(m, (x0 + 90, y0 + 16), 'PWR', 16, jit(YELLOW, 6), bridge=False)
    for i in range(4):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + 8 + i * 12, y1 - 4), (x0 + 20 + i * 12, y1 - 4),
                     (x0 + 14 + i * 12, y1 - 12), (x0 + 2 + i * 12, y1 - 12)],
                    fill=c)
    bolts(m, [(x, y) for x in (x0 + 8, x1 - 8) for y in (y0 + 8, y1 - 8)],
          base=OLIVE)
    # AC/vent unit: grille top + louvers
    x0, y0, x1, y1 = L.C_ACV
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 12, rough=R_STEEL,
         metal=M_STEEL - 20)
    vent_slots(m, [x0 + 8, y0 + 8, x1 - 8, y1 - 8], 5)
    # antenna array plate: dark with cyan emitter rows
    x0, y0, x1, y1 = L.C_PANEL
    fill(m, (x0, y0, x1, y1), dif=(38, 44, 52), ao=AO_BASE - 8,
         rough=R_ARMOR - 30, metal=M_STEEL - 40)
    for fy in (0.3, 0.55, 0.8):
        m.d.line([(x0 + 6, y0 + (y1 - y0) * fy), (x1 - 6, y0 + (y1 - y0) * fy)],
                 fill=(30, 60, 70), width=3)
        m.e.line([(x0 + 7, y0 + (y1 - y0) * fy), (x1 - 7, y0 + (y1 - y0) * fy)],
                 fill=shade(CYAN, 0.4), width=2)
    # beacon: amber shell, hot core
    x0, y0, x1, y1 = L.C_LIGHT
    fill(m, (x0, y0, x1, y1), dif=(120, 40, 34), ao=AO_BASE, rough=R_GLASS,
         metal=M_GLASS)
    m.e.rectangle([x0 + 6, y0 + 6, x1 - 6, y1 - 6], fill=(255, 70, 45))
    # dark cell
    fill(m, L.C_DARK.rect, dif=(14, 14, 16), ao=AO_DEEP, rough=R_ARMOR + 20,
         metal=0)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_pad(m)
    paint_walls(m)
    paint_roofs(m)
    paint_sandbags(m)
    paint_flag(m)
    paint_props(m)

    # ── weathering ──
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=90210)
    wx.crevice_grime(m.dif, 0.5)
    # pad: dust + oil at the genset service square
    wx.mud_band(L.C_PAD.rect, 0.22, fade=None, spatter=True)
    px0, py0, px1, py1 = L.C_PAD.rect
    wx.oily((px0 + 8, py0 + int((py1 - py0) * 0.72), px0 + 90, py1 - 8), 0.5)
    wx.mud_band(L.C_PADS.rect, 0.5, fade='down')
    # walls: dust low, rust at plate bottoms + streaks off the window sills
    for z in (L.C_WALL_F, L.C_WALL_R, L.C_WALL_S):
        x0, y0, x1, y1 = z.rect
        wx.mud_band(z.rect, 0.4, fade='down', dust=0.3)
        wx.plate_bottom_rust(z.rect, n=7, strength=0.5)
        _, sv = z.uv((0, 1.85, 0))
        for i in range(7):
            sx = x0 + (x1 - x0) * (i + 0.5 + 0.25 * (i % 2)) / 7
            wx.rust_streak(sx, sv * W + 2, 16 + (i * 5) % 18, width=2.2,
                           strength=0.32)
    # roofs: thin dust, rust wash near the AC unit
    wx.mud_band(L.C_ROOF.rect, 0.18, fade=None, spatter=False, dust=0.3)
    rx0, ry0, rx1, ry1 = L.C_ROOF.rect
    wx.rust_streak(rx0 + (rx1 - rx0) * 0.35, ry0 + 30, 40, width=3.0,
                   strength=0.35)
    for z in (L.C_UP_S, L.C_UP_F):
        wx.mud_band(z.rect, 0.2, fade='down', spatter=False)
    # sandbags: heaviest mud + spatter (they sit on the ground line)
    wx.mud_band(L.C_SAND.rect, 0.65, fade='down')
    wx.mud_band(L.C_SAND_T.rect, 0.3, fade=None)
    # genset: soot at the exhaust cell, oil beneath
    gx0, gy0, gx1, gy1 = L.C_PROP
    wx.soot_patch((gx1 - 64, gy0 + 8, gx1 - 12, gy0 + 44), 0.65)
    wx.oily((gx0 + 8, gy1 - 26, gx0 + 90, gy1 - 4), 0.4)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.5)
    wx.apply(m)

    # ── height -> normal map ──
    from normals import HeightMap
    hm = HeightMap()
    # wall corrugation ribs (the prefab scale cue)
    for z in (L.C_WALL_F, L.C_WALL_R, L.C_WALL_S):
        x0, y0, x1, y1 = z.rect
        for gx in range(int(x0) + 4, int(x1), 8):
            hm.line((gx, y0 + 2), (gx, y1 - 2), 0.35, width=1)
    # pad expansion joints recessed
    z = L.C_PAD
    x0, y0, x1, y1 = z.rect
    for w in np.arange(-4.5, 5.0, 3.0):
        u = z.uv((w, 0, 0))[0] * W
        hm.line((u, y0 + 2), (u, y1 - 2), -0.5, width=2)
    for w in np.arange(-2.0, 3.0, 2.0):
        v = z.uv((0, 0, w))[1] * W
        hm.line((x0 + 2, v), (x1 - 2, v), -0.5, width=2)
    # sandbag bumps: one dome per painted bag position
    for zone, rows in ((L.C_SAND.rect, 3), (L.C_SAND_T.rect, 2)):
        x0, y0, x1, y1 = zone
        rh = (y1 - y0) / rows
        bag_w = 18
        for r in range(rows):
            off = (r % 2) * bag_w // 2
            by = y0 + r * rh + rh / 2
            for bx in range(int(x0) - off, int(x1), bag_w):
                hm.disc(bx + bag_w / 2, by, bag_w * 0.42, 0.55)
    hm.crevices_from(m.dif, 0.5)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.2).save('out/ms_command_post_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save('out/ms_command_post_diffuse.png')
    m.orm.save('out/ms_command_post_orm.png')
    m.emi.save('out/ms_command_post_emissive.png')
    m.tea.save('out/ms_command_post_team.png')
    print('[paint_ms_command_post] full 1024 texture set written to out/')


if __name__ == '__main__':
    paint_all()
