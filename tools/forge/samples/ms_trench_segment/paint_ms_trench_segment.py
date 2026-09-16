"""paint_ms_trench_segment — 1024² PBR set for the 8 m field trench.

Civil/field register: raw spoil earth with strata and stone, sawn timber
revetment boards with knots and nail rows, weathered duckboards, hessian
sandbags, one rusted corrugated sheet. NO team surface (the model ships
--no-team) and no emissive — a trench has neither. Finished through
paintlib.finish, so paint.enrich's mottle breaks up the big earth fills (the
blandness fix) and all five maps including normals are written.
"""
from __future__ import annotations
import numpy as np

import ms_trench_segment_layout as L
from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, jit, shade,
                   BOLT_LOG, AO_BASE, AO_DEEP)
import paintlib as PL

RNG = np.random.default_rng(90210)
W = 1024
STEM = 'ms_trench_segment'

EARTH_C = (99, 80, 57)        # freshly turned spoil
EARTH_T = (112, 94, 68)       # trodden crest
TIMB_A  = (124, 101, 68)      # sawn board, light
TIMB_B  = (104, 84, 56)       # sawn board, weathered
BOARD_C = (96, 82, 62)        # duckboard slats
SAND_C  = (137, 121, 92)      # sandbag hessian
IRON_C  = (109, 79, 58)       # rusted corrugated iron


def uv_px(zone, a, b):
    p = [0.0, 0.0, 0.0]
    p['xyz'.index(zone.axes[0])] = a
    p['xyz'.index(zone.axes[1])] = b
    u, v = zone.uv(p)
    return u * W, v * W


def paint_earth(m):
    for zone in (L.EARTH_F, L.EARTH_Z):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=EARTH_C, ao=AO_BASE - 12, rough=238,
             metal=4)
        for fy in (0.28, 0.52, 0.78):          # strata in the cut spoil
            yy = y0 + (y1 - y0) * fy
            m.d.line([(x0, yy), (x1, yy)], fill=jit(shade(EARTH_C, 0.87), 4),
                     width=3)
        for _ in range(320):                   # stone + clod speckle
            sx, sy = RNG.uniform(x0, x1 - 4), RNG.uniform(y0, y1 - 4)
            s = RNG.uniform(1, 4.0)
            m.d.ellipse([sx, sy, sx + s, sy + s],
                        fill=jit(shade(EARTH_C, RNG.uniform(0.68, 1.28)), 7))
        m.d.rectangle([x0, y1 - 10, x1, y1], fill=shade(EARTH_C, 0.7))
    x0, y0, x1, y1 = L.EARTH_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=EARTH_T, ao=AO_BASE - 8, rough=232, metal=4)
    for _ in range(180):
        sx, sy = RNG.uniform(x0, x1 - 3), RNG.uniform(y0, y1 - 3)
        s = RNG.uniform(1, 3)
        m.d.ellipse([sx, sy, sx + s, sy + s],
                    fill=jit(shade(EARTH_T, RNG.uniform(0.74, 1.22)), 6))


def paint_planks(m):
    """Revetment face: horizontal sawn boards, nailed to the posts."""
    zone = L.PLANK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=TIMB_B, ao=AO_BASE - 10, rough=228, metal=0)
    rows = 7
    for i in range(rows):
        ya = y0 + (y1 - y0) * i / rows
        yb = y0 + (y1 - y0) * (i + 1) / rows
        tone = TIMB_A if i % 2 else TIMB_B
        m.d.rectangle([x0, ya, x1, yb - 2], fill=jit(tone, 6))
        seam_h(m, x0, x1, int(yb) - 2, tone, hi=False)
        for _ in range(9):                     # grain
            gx = RNG.uniform(x0, x1 - 40)
            m.d.line([(gx, ya + 4), (gx + RNG.uniform(20, 70), ya + 4)],
                     fill=shade(tone, 0.86))
        for _ in range(2):                     # knots
            kx, ky = RNG.uniform(x0, x1 - 6), RNG.uniform(ya + 3, yb - 6)
            m.d.ellipse([kx, ky, kx + 5, ky + 4], fill=shade(tone, 0.62))
        # nail heads where the boards cross the posts
        bolts(m, [(x0 + (x1 - x0) * f, (ya + yb) / 2)
                  for f in (0.06, 0.28, 0.5, 0.72, 0.94)], r=2,
              base=shade(tone, 0.8))
    wear_edges(m, (x0, y0, x1, y1), TIMB_B, 40)


def paint_boards(m):
    """Duckboard walkway + step tops: slats across the trench, worn centre."""
    zone = L.BOARD
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=BOARD_C, ao=AO_BASE - 14, rough=240, metal=0)
    for gx in range(x0, x1, 13):
        m.d.line([(gx, y0), (gx, y1)], fill=shade(BOARD_C, 0.78), width=2)
        m.d.line([(gx + 3, y0), (gx + 3, y1)], fill=shade(BOARD_C, 1.1))
    for rail in (0.12, 0.88):                  # bearer rails under the slats
        yy = y0 + (y1 - y0) * rail
        seam_h(m, x0, x1, int(yy), BOARD_C, hi=False)
    m.d.rectangle([x0, y0 + (y1 - y0) * 0.36, x1, y0 + (y1 - y0) * 0.64],
                  fill=None, outline=None)
    for _ in range(200):                       # mud trodden into the middle
        sx = RNG.uniform(x0, x1 - 4)
        sy = RNG.uniform(y0 + (y1 - y0) * 0.3, y0 + (y1 - y0) * 0.7)
        s = RNG.uniform(2, 6)
        m.d.ellipse([sx, sy, sx + s, sy + s * 0.6],
                    fill=jit(shade(EARTH_C, RNG.uniform(0.8, 1.05)), 6))
    wear_edges(m, (x0, y0, x1, y1), BOARD_C, 35)


def paint_sandbags(m):
    for zone, rows in ((L.SAND, 14), (L.SAND_TOP, 16)):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=SAND_C, ao=AO_BASE - 10, rough=242,
             metal=0)
        for gy in range(y0, y1, rows):
            m.d.line([(x0, gy), (x1, gy)], fill=shade(SAND_C, 0.8), width=2)
            off = 18 if (gy // rows) % 2 else 0
            for gx in range(x0 + off, x1, 36):
                m.d.line([(gx, gy), (gx, min(gy + rows, y1))],
                         fill=shade(SAND_C, 0.86))
        for _ in range(120):
            sx, sy = RNG.uniform(x0, x1 - 4), RNG.uniform(y0, y1 - 3)
            m.d.ellipse([sx, sy, sx + 3, sy + 2],
                        fill=jit(shade(SAND_C, RNG.uniform(0.84, 1.14)), 5))


def paint_cells(m):
    x0, y0, x1, y1 = L.TIMBER.rect             # posts / board edges
    fill(m, (x0, y0, x1, y1), dif=TIMB_B, ao=AO_BASE - 12, rough=230, metal=0)
    for gy in range(y0, y1, 9):
        m.d.line([(x0, gy), (x1, gy)], fill=shade(TIMB_B, 0.85))
    x0, y0, x1, y1 = L.CORR                    # corrugated iron sheet
    fill(m, (x0, y0, x1, y1), dif=IRON_C, ao=AO_BASE - 8, rough=215, metal=90)
    for gx in range(x0, x1, 10):
        m.d.line([(gx, y0), (gx, y1)], fill=shade(IRON_C, 0.74), width=2)
        m.d.line([(gx + 4, y0), (gx + 4, y1)], fill=shade(IRON_C, 1.18))
    fill(m, L.DARK.rect, dif=(34, 31, 27), ao=AO_DEEP, rough=235, metal=10)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    fill(m, (0, 0, W, W), dif=EARTH_C, ao=AO_BASE - 12, rough=236, metal=4)
    paint_earth(m)
    paint_planks(m)
    paint_boards(m)
    paint_sandbags(m)
    paint_cells(m)

    # everything here sits in the mud; the boards take the worst of it
    wx = PL.standard_weather(m, L, ground_rects=(L.BOARD.rect, L.EARTH_F.rect,
                                                 L.EARTH_Z.rect),
                             side_zones=(L.PLANK,), seed=90210,
                             mud=0.6, grime=0.5, rust_fraction=0.35)
    wx.mud_band(L.EARTH_TOP.rect, 0.35, fade=None, spatter=False)
    wx.mud_band(L.SAND.rect, 0.5, fade='down', spatter=False)
    wx.mud_band(L.CORR, 0.4, fade='down')
    zx0, zy0, zx1, _ = L.PLANK.rect
    for fx in np.linspace(0.08, 0.92, 9):      # damp streaks down the boards
        wx.rust_streak(zx0 + (zx1 - zx0) * fx, zy0 + 18,
                       int(RNG.uniform(24, 60)), width=2.6, strength=0.3)

    from normals import HeightMap
    hm = HeightMap()
    px0, py0, px1, py1 = L.PLANK.rect
    for i in range(7):                          # boards stand proud
        ya = py0 + (py1 - py0) * i / 7
        hm.rect((px0, ya, px1, py0 + (py1 - py0) * (i + 1) / 7 - 2), 0.28)
    for gx in range(L.BOARD.rect[0], L.BOARD.rect[2], 13):
        hm.line((gx, L.BOARD.rect[1]), (gx, L.BOARD.rect[3]), -0.3, width=2)
    for gx in range(L.CORR[0], L.CORR[2], 10):
        hm.line((gx, L.CORR[1]), (gx, L.CORR[3]), 0.35, width=3)

    PL.finish(m, L, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
