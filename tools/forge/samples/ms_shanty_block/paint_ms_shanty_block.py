"""paint_ms_shanty_block — 2048^2 PBR set for ms_shanty_block.

Civilian shanty block: packed-earth pad with worn paths, three storey
wall bands of mismatched corrugated scrap panels (paintlib
panel_patchwork), painted doors with warm spill, sparse lit windows
(warm emissive), patched corrugated roofs with a tarp repair, timber
stairs, galvanized/rusty pipe cell, water drums, laundry cloth cell.
NO team colour anywhere (map prop).
"""
from __future__ import annotations
import os
import numpy as np
from PIL import ImageFilter, ImageFont

import ms_shanty_block_layout as L      # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
if not os.path.exists(P.FONT):
    P.FONT = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'

import paintlib as PL
from paint import (Maps, fill, seam_h, bolts, wear_edges, jit, shade,
                   stencil, BOLT_LOG, GLASS, STEEL_DK, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, RNG)

W = 2048
EARTH = (138, 122, 101)
# civilian scrap palette — tone-on-tone (impostor baker floods
# high-contrast large-quad cells)
PANELS = [(136, 129, 117), (146, 124, 102), (121, 127, 122), (140, 135, 113),
          (127, 112, 98), (116, 121, 130), (150, 140, 120)]
ROOFS = [(122, 117, 110), (131, 113, 95), (113, 117, 122), (126, 126, 113)]
TARP = (104, 112, 124)                  # sun-bleached tarp repair (muted)
TIMBER = (112, 90, 66)
GALV = (150, 152, 155)
WARM = (255, 205, 135)
DRUM_COLS = [(96, 108, 118), (128, 84, 66), (108, 112, 100)]
CLOTH_COLS = [(168, 158, 140), (120, 130, 150), (150, 120, 110),
              (140, 145, 125), (170, 165, 155)]


def corrugate(m, rect, base, step=7, f=0.9):
    x0, y0, x1, y1 = rect
    for gx in range(int(x0) + step // 2, int(x1), step):
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)], fill=shade(base, f), width=1)


def paint_pad(m):
    z = L.C_PAD
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=EARTH, ao=AO_BASE - 6, rough=R_ARMOR + 40,
         metal=0)
    u, v = PL.zone_fns(z)
    # tonal dirt patches
    for _ in range(26):
        bx = x0 + RNG.random() * (x1 - x0 - 90)
        by = y0 + RNG.random() * (y1 - y0 - 60)
        m.d.polygon([(bx, by + 12), (bx + 66, by), (bx + 88, by + 30),
                     (bx + 20, by + 44)], fill=jit(shade(EARTH, 0.93), 5))
    # worn footpaths: stair base -> yard -> drum corner
    path = [(u(-7.5), v(2.2)), (u(-3.0), v(1.0)), (u(0.4), v(0.4)),
            (u(3.6), v(1.6)), (u(5.4), v(2.0)), (u(5.6), v(6.4))]
    for a, b in zip(path, path[1:]):
        m.d.line([a, b], fill=shade(EARTH, 1.08), width=26)
    for a, b in zip(path, path[1:]):
        m.d.line([a, b], fill=shade(EARTH, 1.14), width=12)
    # laundry-yard trampled circle + drum drip stains
    m.d.ellipse([u(1.0), v(6.2), u(6.6), v(8.0)], fill=shade(EARTH, 1.06))
    m.d.ellipse([u(4.5), v(1.4), u(6.6), v(2.4)], fill=shade(EARTH, 0.8))


def windows_and_doors(m, zone, wy0, wy1, xs, lit=0.4, doors=()):
    """Sparse windows (world-u positions) + door slabs on a wall band."""
    u, v = PL.zone_fns(zone)
    y0, y1 = v(wy1), v(wy0)
    for wx in xs:
        b = PL.nbox(u(wx), y0, u(wx + 0.55), y1)
        m.d.rectangle(b, fill=GLASS, outline=(58, 54, 48), width=2)
        m.o.rectangle(b, fill=(AO_BASE - 14, R_GLASS, 0))
        if RNG.random() < lit:
            m.e.rectangle([b[0] + 2, b[1] + 2, b[2] - 2, b[3] - 2],
                          fill=shade(WARM, 0.6))
        # crooked shutter plank on some
        if RNG.random() < 0.4:
            m.d.rectangle([b[0] - 3, (b[1] + b[3]) / 2 - 3, b[2] + 3,
                           (b[1] + b[3]) / 2 + 3], fill=shade(TIMBER, 0.9))
    for dx, base_y in doors:
        db = PL.nbox(u(dx), v(base_y + 2.0), u(dx + 0.95), v(base_y + 0.02))
        m.d.rectangle(db, fill=(70, 62, 52), outline=(50, 45, 38), width=3)
        m.o.rectangle(db, fill=(AO_BASE - 18, R_ARMOR + 20, 0))
        for i in range(1, 4):
            sy = db[1] + (db[3] - db[1]) * i / 4
            m.d.line([(db[0] + 2, sy), (db[2] - 2, sy)],
                     fill=shade((70, 62, 52), 0.75), width=2)
        # warm spill over the lintel (bare bulb)
        m.e.rectangle([db[0] + 4, db[1] - 8, db[2] - 4, db[1] - 3],
                      fill=shade(WARM, 0.75))


def paint_walls(m):
    for zone, cols in ((L.C_W1X, 12), (L.C_W2X, 10), (L.C_W3X, 9)):
        x0, y0, x1, y1 = zone.rect
        PL.panel_patchwork(m, (x0, y0, x1, y1), PANELS, cols=cols, rows=3,
                           bolt_every=3, seed=90210 + cols)
        corrugate(m, (x0, y0, x1, y1), PANELS[0], step=8)
        # baseboard grime band
        m.d.rectangle([x0, y1 - 18, x1, y1], fill=shade(PANELS[4], 0.7))
        wear_edges(m, (x0, y0, x1, y1), PANELS[1], 60)
    # storey 1: doors + windows
    windows_and_doors(m, L.C_W1X, 1.5, 2.1,
                      xs=(-6.6, -4.6, -2.2, 0.6, 2.6, 4.8, 6.6),
                      lit=0.45, doors=((-1.2, L.PAD_TOP), (3.8, L.PAD_TOP)))
    # storey 2 windows
    windows_and_doors(m, L.C_W2X, 3.7, 4.3,
                      xs=(-6.2, -3.8, -1.0, 1.8, 4.2, 6.2), lit=0.35,
                      doors=((-7.9, 2.65),))    # stair-landing door
    # storey 3 windows
    windows_and_doors(m, L.C_W3X, 5.7, 6.3, xs=(1.9, 3.4, 4.6), lit=0.4)
    # hand-painted sign on storey 1
    u, v = PL.zone_fns(L.C_W1X)
    f = ImageFont.truetype(P.FONT, 34)
    m.d.text((u(-6.0), v(2.65)), 'AGUA', font=f, fill=(174, 168, 150))


def paint_roofs(m):
    z = L.C_ROOF
    x0, y0, x1, y1 = z.rect
    PL.panel_patchwork(m, (x0, y0, x1, y1), ROOFS, cols=7, rows=6,
                       bolt_every=4, seed=90211)
    corrugate(m, (x0, y0, x1, y1), ROOFS[0], step=9, f=0.92)
    u, v = PL.zone_fns(z)
    # tarp repair lashed over one roof area (E roof, west)
    tb = PL.nbox(u(-6.4), v(-3.8), u(-3.4), v(-1.4))
    m.d.rectangle(tb, fill=jit(TARP, 4), outline=shade(TARP, 0.7), width=3)
    m.o.rectangle(tb, fill=(AO_BASE - 4, R_ARMOR + 30, 0))
    for fx in np.linspace(0.12, 0.88, 4):       # lashing lines
        sx = tb[0] + (tb[2] - tb[0]) * fx
        m.d.line([(sx, tb[1] - 8), (sx, tb[3] + 8)],
                 fill=shade(TARP, 0.55), width=2)
    # patch plates + rust blooms
    for _ in range(9):
        bx = x0 + RNG.random() * (x1 - x0 - 80)
        by = y0 + RNG.random() * (y1 - y0 - 60)
        col = jit(ROOFS[int(RNG.random() * len(ROOFS))], 8)
        m.d.rectangle([bx, by, bx + 60, by + 44], fill=col,
                      outline=shade(col, 0.6), width=2)
        bolts(m, [(bx + 6, by + 6), (bx + 54, by + 38)], base=col)


def paint_stairs(m):
    for z, base in ((L.C_TREAD, TIMBER), (L.C_SIDE, shade(TIMBER, 0.85))):
        x0, y0, x1, y1 = z.rect
        fill(m, (x0, y0, x1, y1), dif=base, ao=AO_BASE - 8,
             rough=R_ARMOR + 34, metal=0)
        # plank lines
        for gy in range(int(y0) + 8, int(y1), 16):
            m.d.line([(x0 + 2, gy), (x1 - 2, gy)], fill=shade(base, 0.82),
                     width=2)
        wear_edges(m, (x0, y0, x1, y1), base, 30)


def paint_props(m):
    # pipe/pole/ladder wrap: galvanized with rust bands
    x0, y0, x1, y1 = L.C_MAST
    fill(m, (x0, y0, x1, y1), dif=GALV, ao=AO_BASE - 4, rough=R_STEEL - 10,
         metal=M_STEEL - 20)
    for fx in (0.22, 0.5, 0.78):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 3, y0, sx + 3, y1], fill=(122, 96, 74))
    # water drums: mismatched colours, water stain ring at the top
    z = L.C_DRUM
    x0, y0, x1, y1 = z.rect
    third = (x1 - x0) / 3
    for i in range(3):
        b = (x0 + i * third, y0, x0 + (i + 1) * third, y1)
        col = DRUM_COLS[i]
        fill(m, b, dif=col, ao=AO_BASE - 6, rough=R_ARMOR + 20,
             metal=M_ARMOR + 30)
        for fy in (0.18, 0.5, 0.82):            # rolling hoops
            hy = b[1] + (b[3] - b[1]) * fy
            m.d.line([(b[0] + 2, hy), (b[2] - 2, hy)],
                     fill=shade(col, 0.72), width=4)
        m.d.rectangle([b[0] + 2, b[1], b[2] - 2, b[1] + 10],
                      fill=shade(col, 1.18))    # wet rim
    # laundry cloth: distinct faded garments per hang position
    z = L.C_CLOTH
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=CLOTH_COLS[0], ao=AO_BASE,
         rough=R_ARMOR + 44, metal=0)
    u, v = PL.zone_fns(z)
    for i, (cx, cw, chh) in enumerate(zip(L.CLOTH_XS, L.CLOTH_W, L.CLOTH_H)):
        b = PL.nbox(u(cx - cw / 2 - 0.05), v(0.05), u(cx + cw / 2 + 0.05),
                    v(-1.0))
        col = CLOTH_COLS[i % len(CLOTH_COLS)]
        m.d.rectangle(b, fill=jit(col, 5))
        # fold shading + peg line
        for fx in (0.3, 0.6, 0.85):
            sx = b[0] + (b[2] - b[0]) * fx
            m.d.line([(sx, b[1] + 3), (sx, b[3] - 3)],
                     fill=shade(col, 0.88), width=3)
        m.d.line([(b[0], b[1] + 3), (b[2], b[1] + 3)],
                 fill=shade(col, 0.7), width=2)
    # dark cell
    fill(m, L.C_DARK.rect, dif=(16, 15, 14), ao=AO_DEEP, rough=R_ARMOR + 20,
         metal=0)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_pad(m)
    paint_walls(m)
    paint_roofs(m)
    paint_stairs(m)
    paint_props(m)

    # weathering: heavy grime low on walls, dust on roofs, soot at chimneys
    wx = PL.standard_weather(
        m, L, ground_rects=(L.C_DRUM.rect,),
        side_zones=(L.C_W1X,), seed=90210, mud=0.6, grime=0.6)
    wx.mud_band(L.C_PAD.rect, 0.3, fade=None, spatter=True)
    wx.mud_band(L.C_W2X.rect, 0.3, fade='down', dust=0.35)
    wx.mud_band(L.C_W3X.rect, 0.25, fade='down', dust=0.3)
    for z in (L.C_W1X, L.C_W2X, L.C_W3X):
        wx.plate_bottom_rust(z.rect, n=10, strength=0.55)
    rx0, ry0, rx1, ry1 = L.C_ROOF.rect
    wx.mud_band(L.C_ROOF.rect, 0.2, fade=None, spatter=False, dust=0.35)
    ru, rv = PL.zone_fns(L.C_ROOF)
    for (cx, by, cz, ty) in L.CHIMNEYS:         # soot rings at pipe exits
        wx.soot_patch((ru(cx - 0.7), rv(cz - 0.7), ru(cx + 0.7),
                       rv(cz + 0.7)), 0.6)
    wx.rust_streak(rx0 + (rx1 - rx0) * 0.62, ry0 + 60, 90, width=3.0,
                   strength=0.4)

    # normals: corrugation ribs on walls + roofs, plank steps on stairs
    hm = NM.HeightMap()
    for z in (L.C_W1X, L.C_W2X, L.C_W3X):
        x0, y0, x1, y1 = z.rect
        for gx in range(int(x0) + 4, int(x1), 8):
            hm.line((gx, y0 + 2), (gx, y1 - 2), 0.35, width=1)
    x0, y0, x1, y1 = L.C_ROOF.rect
    for gx in range(int(x0) + 4, int(x1), 9):
        hm.line((gx, y0 + 2), (gx, y1 - 2), 0.3, width=1)
    x0, y0, x1, y1 = L.C_TREAD.rect
    for gy in range(int(y0) + 8, int(y1), 16):
        hm.line((x0 + 2, gy), (x1 - 2, gy), -0.4, width=2)

    PL.finish(m, L, 'ms_shanty_block', hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
