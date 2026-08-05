"""paint_ms_meeting_hall — 2048^2 PBR set for ms_meeting_hall.

The parley hall: the one cared-for building in town. Painted timber
clapboard (warm cream over sage trim, straighter lines than the
shanties, a couple of mismatched replacement boards for the salvage
read), corrugated oxide-red iron roof (tone-on-tone: big quads feed
the impostor baker), tall lit windows with warm emissive on every
wall, twin plank doors with a lamp, noticeboard with pinned papers,
timber porch, brass bell. NO team colour anywhere.
"""
from __future__ import annotations
import os
import numpy as np
from PIL import ImageFilter, ImageFont

import ms_meeting_hall_layout as L      # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
if not os.path.exists(P.FONT):
    P.FONT = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, jit, shade,
                   stencil, BOLT_LOG, GLASS, STEEL_DK, BLACKISH,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, RNG)
import paintlib as PL

W = 2048
CREAM   = (196, 186, 162)     # cared-for painted boards
CREAM_D = (172, 162, 138)
SAGE    = (110, 118, 96)      # trim / wainscot
TIMBER  = (128, 104, 76)      # bare wood (porch, boards)
TIMBER_D= (104, 84, 60)
ROOFRED = (128, 78, 62)       # oxide-red corrugated iron
WARM    = (255, 205, 135)
BRASS   = (168, 138, 74)
PAPER   = (214, 208, 188)


def clapboard(m, rect, base, step=10):
    """Horizontal painted-board lines, low contrast (straight = cared-for)."""
    x0, y0, x1, y1 = rect
    for gy in range(int(y0) + step, int(y1), step):
        m.d.line([(x0 + 2, gy), (x1 - 2, gy)], fill=shade(base, 0.90), width=1)


def tall_window(m, z, wx, wy0=0.9, wy1=3.3, ww=0.9, lit=True):
    """Tall lit window in wall-zone world coords (u axis value at wx)."""
    ax = z.axes[0]

    def U(wu):
        pnt = [0.0, 0.0, 0.0]
        pnt['xyz'.index(ax)] = wu
        return z.uv(tuple(pnt))[0] * W
    _, v0 = z.uv((0, wy1, 0))
    _, v1 = z.uv((0, wy0, 0))
    bx = sorted((U(wx - ww / 2), U(wx + ww / 2)))
    box = [bx[0], v0 * W, bx[1], v1 * W]
    # frame
    m.d.rectangle([box[0] - 4, box[1] - 4, box[2] + 4, box[3] + 4],
                  fill=SAGE)
    PL.glass_rect(m, box, outline=shade(SAGE, 0.7))
    # muntin cross
    cy = (box[1] + box[3]) / 2
    cx = (box[0] + box[2]) / 2
    m.d.line([(box[0], cy), (box[2], cy)], fill=shade(SAGE, 0.8), width=3)
    m.d.line([(cx, box[1]), (cx, box[3])], fill=shade(SAGE, 0.8), width=3)
    if lit:
        m.e.rectangle([box[0] + 2, box[1] + 2, box[2] - 2, box[3] - 2],
                      fill=shade(WARM, 0.6))
    return box


def paint_walls(m):
    for z in (L.C_WALL_F, L.C_WALL_R, L.C_WALL_S):
        x0, y0, x1, y1 = z.rect
        fill(m, (x0, y0, x1, y1), dif=CREAM, ao=AO_BASE, rough=R_ARMOR + 34,
             metal=0)
        clapboard(m, (x0, y0, x1, y1), CREAM)
        # a few mismatched replacement boards (salvage-built, but neat)
        for _ in range(5):
            bx = x0 + RNG.random() * (x1 - x0 - 160)
            by = y0 + 10 + int(RNG.random() * ((y1 - y0) / 10 - 3)) * 10
            m.d.rectangle([bx, by + 1, bx + 90 + RNG.random() * 70, by + 9],
                          fill=jit(CREAM_D, 6))
        # sage wainscot band (bottom ~0.7 m of wall)
        _, wv = z.uv((0, 0.72, 0))
        wy = int(wv * W)
        m.d.rectangle([x0, wy, x1, y1], fill=SAGE)
        m.o.rectangle([x0, wy, x1, y1], fill=(AO_BASE - 14, R_ARMOR + 30, 0))
        seam_h(m, x0, x1, wy, CREAM)
        # corner trim boards
        for sx in (x0 + 5, x1 - 5):
            m.d.rectangle([sx - 5, y0 + 2, sx + 5, y1 - 2], fill=SAGE)
        wear_edges(m, (x0, wy, x1, y1), SAGE, 30)

    # tall windows: front (flanking the doors), rear, both gable sides
    for wx in (-7.0, -4.6, 4.6, 7.0):
        tall_window(m, L.C_WALL_F, wx, lit=True)
    for wx in (-6.5, -3.9, -1.3, 1.3, 3.9, 6.5):
        tall_window(m, L.C_WALL_R, wx, lit=RNG.random() < 0.8)
    for wz in (-1.6, 0.6, 2.8, 5.0):
        tall_window(m, L.C_WALL_S, wz, lit=RNG.random() < 0.8)

    # ── front wall: twin plank doors + lamp + sign ──
    z = L.C_WALL_F
    du0, dv0 = z.uv((L.DOOR_X + L.DOOR_W / 2, L.PORCH_FLOOR_Y + L.DOOR_H, 0))
    du1, dv1 = z.uv((L.DOOR_X - L.DOOR_W / 2, L.PORCH_FLOOR_Y + 0.02, 0))
    db = [min(du0, du1) * W, dv0 * W, max(du0, du1) * W, dv1 * W]
    m.d.rectangle([db[0] - 6, db[1] - 6, db[2] + 6, db[3]], fill=SAGE)
    m.d.rectangle(db, fill=TIMBER, outline=shade(SAGE, 0.7), width=3)
    m.o.rectangle(db, fill=(AO_BASE - 16, R_ARMOR + 26, 0))
    cx = (db[0] + db[2]) / 2
    m.d.line([(cx, db[1] + 2), (cx, db[3] - 2)], fill=TIMBER_D, width=4)
    for leaf0, leaf1 in ((db[0], cx), (cx, db[2])):
        for i in range(1, 5):
            sx = leaf0 + (leaf1 - leaf0) * i / 5
            m.d.line([(sx, db[1] + 3), (sx, db[3] - 3)],
                     fill=shade(TIMBER, 0.85), width=1)
        # Z-brace
        m.d.line([(leaf0 + 4, db[3] - 8), (leaf1 - 4, db[1] + 30)],
                 fill=TIMBER_D, width=3)
    # small lit fanlight over the doors + porch lamp glow
    m.d.rectangle([db[0] + 8, db[1] - 20, db[2] - 8, db[1] - 8], fill=GLASS)
    m.e.rectangle([db[0] + 9, db[1] - 19, db[2] - 7, db[1] - 9],
                  fill=shade(WARM, 0.75))
    m.e.rectangle([db[0] - 6, db[1] - 6, db[2] + 6, db[3]],
                  fill=None, outline=shade(WARM, 0.22), width=5)
    # hand-painted sign board above the door
    f = ImageFont.truetype(P.FONT, 30)
    sb = [cx - 120, db[1] - 58, cx + 120, db[1] - 26]
    m.d.rectangle(sb, fill=shade(TIMBER, 1.1), outline=TIMBER_D, width=2)
    m.d.text((sb[0] + 24, sb[1] + 2), 'MEETING HALL', font=f,
             fill=(58, 52, 44))


def paint_roof(m):
    """Corrugated iron, tone-on-tone (+-15%): big quads flat-shade in the
    impostor baker, so no bold stripes here."""
    z = L.C_ROOF
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ROOFRED, ao=AO_BASE - 2, rough=R_ARMOR + 8,
         metal=M_ARMOR + 26)
    # sheet seams along x every ~1.5 m, low contrast
    for wx in np.arange(-9.0, 9.5, 1.5):
        u = z.uv((wx, 0, 0))[0] * W
        m.d.line([(u, y0 + 2), (u, y1 - 2)], fill=shade(ROOFRED, 0.9),
                 width=2)
    # ridge line + gentle tonal patches (patched sheets, +-12%)
    _, rv = z.uv((0, 0, L.RIDGE_Z))
    m.d.line([(x0 + 2, rv * W), (x1 - 2, rv * W)], fill=shade(ROOFRED, 1.12),
             width=6)
    for _ in range(8):
        bx = x0 + RNG.random() * (x1 - x0 - 120)
        by = y0 + RNG.random() * (y1 - y0 - 70)
        m.d.rectangle([bx, by, bx + 60 + RNG.random() * 60, by + 40],
                      fill=jit(shade(ROOFRED, 0.92 + RNG.random() * 0.2), 4))
    wear_edges(m, (x0, y0, x1, y1), ROOFRED, 40)


def paint_porch(m):
    # deck planks
    z = L.C_PORCHF
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=TIMBER, ao=AO_BASE - 6, rough=R_ARMOR + 40,
         metal=0)
    for wx in np.arange(-9.0, 9.2, 0.35):
        u = z.uv((wx, 0, 0))[0] * W
        m.d.line([(u, y0 + 2), (u, y1 - 2)], fill=jit(shade(TIMBER, 0.88), 5),
                 width=2)
    # porch roof: same iron as the main roof, slightly darker (shade line)
    z = L.C_PROOF
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ROOFRED, 0.94), ao=AO_BASE - 6,
         rough=R_ARMOR + 8, metal=M_ARMOR + 26)
    for wx in np.arange(-9.0, 9.5, 1.5):
        u = z.uv((wx, 0, 0))[0] * W
        m.d.line([(u, y0 + 2), (u, y1 - 2)], fill=shade(ROOFRED, 0.86),
                 width=2)
    # steps / skirt cell: plain timber
    x0, y0, x1, y1 = L.C_STEP
    fill(m, (x0, y0, x1, y1), dif=TIMBER_D, ao=AO_BASE - 12,
         rough=R_ARMOR + 40, metal=0)
    for gx in range(int(x0) + 12, int(x1), 24):
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)], fill=shade(TIMBER_D, 0.88),
                 width=2)


def paint_props(m):
    # posts / beams / belfry post wrap: painted sage timber
    x0, y0, x1, y1 = L.C_MAST
    fill(m, (x0, y0, x1, y1), dif=SAGE, ao=AO_BASE - 4, rough=R_ARMOR + 30,
         metal=0)
    m.d.rectangle([x0, y0 + (y1 - y0) * 0.75, x1, y1],
                  fill=shade(SAGE, 0.8))
    # tower shaft: cream boards with sage corner trim, small lit slit
    x0, y0, x1, y1 = L.C_TOWER
    fill(m, (x0, y0, x1, y1), dif=CREAM_D, ao=AO_BASE - 4,
         rough=R_ARMOR + 34, metal=0)
    clapboard(m, (x0, y0, x1, y1), CREAM_D)
    for sx in (x0 + 8, x1 - 8):
        m.d.rectangle([sx - 8, y0 + 2, sx + 8, y1 - 2], fill=SAGE)
    slit = [x0 + (x1 - x0) * 0.42, y0 + (y1 - y0) * 0.30,
            x0 + (x1 - x0) * 0.58, y0 + (y1 - y0) * 0.48]
    PL.glass_rect(m, slit, outline=SAGE)
    m.e.rectangle([slit[0] + 2, slit[1] + 2, slit[2] - 2, slit[3] - 2],
                  fill=shade(WARM, 0.5))
    # belfry cap: darker iron pyramid
    x0, y0, x1, y1 = L.C_TROOF
    fill(m, (x0, y0, x1, y1), dif=shade(ROOFRED, 0.85), ao=AO_BASE - 6,
         rough=R_ARMOR + 6, metal=M_ARMOR + 30)
    seam_v(m, (x0 + x1) // 2, y0 + 3, y1 - 3, ROOFRED, hi=False)
    # bell: worn brass
    x0, y0, x1, y1 = L.C_BELL
    fill(m, (x0, y0, x1, y1), dif=BRASS, ao=AO_BASE - 4, rough=R_STEEL - 30,
         metal=M_STEEL + 20)
    m.d.rectangle([x0, y0 + (y1 - y0) * 0.8, x1, y1],
                  fill=shade(BRASS, 1.14))
    m.d.rectangle([x0, y0, x1, y0 + (y1 - y0) * 0.18],
                  fill=shade(BRASS, 0.78))
    # noticeboard: sage frame, cork field, pinned papers
    x0, y0, x1, y1 = L.C_NOTICE
    fill(m, (x0, y0, x1, y1), dif=SAGE, ao=AO_BASE - 6, rough=R_ARMOR + 30,
         metal=0)
    ib = [x0 + 18, y0 + 18, x1 - 18, y1 - 18]
    m.d.rectangle(ib, fill=(112, 92, 66))
    m.o.rectangle(ib, fill=(AO_BASE - 16, R_ARMOR + 40, 0))
    rng = np.random.default_rng(90210)
    for _ in range(7):
        px = ib[0] + rng.random() * (ib[2] - ib[0] - 52)
        py = ib[1] + rng.random() * (ib[3] - ib[1] - 60)
        m.d.rectangle([px, py, px + 40 + rng.random() * 14,
                       py + 46 + rng.random() * 14],
                      fill=jit(PAPER, 8), outline=(150, 144, 126))
        for i in range(3):
            m.d.line([(px + 5, py + 10 + i * 9), (px + 34, py + 10 + i * 9)],
                     fill=(120, 116, 104), width=1)
    # dark cell
    fill(m, L.C_DARK.rect, dif=(16, 15, 14), ao=AO_DEEP, rough=R_ARMOR + 20,
         metal=0)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_walls(m)
    paint_roof(m)
    paint_porch(m)
    paint_props(m)

    # weathering: light touch — cared-for, but it still lives in the mud
    wx = PL.standard_weather(m, L, ground_rects=(L.C_STEP,),
                             side_zones=(L.C_WALL_F, L.C_WALL_R, L.C_WALL_S),
                             mud=0.3, grime=0.4)
    # soft rust wash on the roof sheets, heavier at the low edges
    rx0, ry0, rx1, ry1 = L.C_ROOF.rect
    for i in range(6):
        wx.rust_streak(rx0 + (rx1 - rx0) * (i + 0.5) / 6, ry0 + 24,
                       30 + (i * 7) % 24, width=2.5, strength=0.25)
    wx.mud_band(L.C_PORCHF.rect, 0.25, fade=None, dust=0.3)

    # normals: clapboard lines + roof corrugation + deck planks
    from normals import HeightMap
    hm = HeightMap()
    for z in (L.C_WALL_F, L.C_WALL_R, L.C_WALL_S):
        x0, y0, x1, y1 = z.rect
        for gy in range(int(y0) + 10, int(y1), 10):
            hm.line((x0 + 2, gy), (x1 - 2, gy), 0.3, width=1)
    z = L.C_ROOF
    x0, y0, x1, y1 = z.rect
    for gx in range(int(x0) + 4, int(x1), 7):
        hm.line((gx, y0 + 2), (gx, y1 - 2), 0.3, width=1)
    z = L.C_PORCHF
    x0, y0, x1, y1 = z.rect
    for gx in range(int(x0) + 5, int(x1), 20):
        hm.line((gx, y0 + 2), (gx, y1 - 2), -0.35, width=1)

    PL.finish(m, L, 'ms_meeting_hall', hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
