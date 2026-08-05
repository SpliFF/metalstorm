"""paint_ms_train_wreck — 2048² PBR set for ms_train_wreck.

Wreck read: oxide-red boxcar steel gone to rust and soot, dark
underframe, scorched ballast with a gouged rut where the car left the
rails, grey timber sleepers, rust-brown rails, weathered wood crates,
torn plate with burnt edges.  No team colour, no emissive (a wreck
doesn't glow) — maps ship black.  Cells that land on large quads stay
tone-on-tone (impostor baker flat-shades from the UV centroid).
"""
from __future__ import annotations
import numpy as np

import ms_train_wreck_layout as L      # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, bolts, wear_edges, jit, shade, BOLT_LOG,
                   STEEL, STEEL_DK, BLACKISH,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_STEEL, M_STEEL, RNG)
import paintlib as PL

OXIDE    = (116, 74, 58)     # boxcar oxide red, well faded
OXIDE_DK = (88, 56, 44)
RUST     = (122, 82, 50)
DIRT     = (122, 114, 100)
GRAVEL   = (112, 108, 100)
TIMBER   = (96, 88, 74)
WOOD     = (146, 116, 80)
WOOD_DK  = (106, 82, 56)
DKSTEEL  = (70, 68, 66)
RAILC    = (110, 88, 66)


def _plated(m, rect, base, cols, rows, rough=170, metal=120):
    """Low-contrast mismatched plate grid with seams + bolts."""
    x0, y0, x1, y1 = rect
    fill(m, rect, dif=base, ao=AO_BASE - 5, rough=rough, metal=metal)
    for i in range(cols):
        for j in range(rows):
            px0 = x0 + (x1 - x0) * i / cols
            px1 = x0 + (x1 - x0) * (i + 1) / cols
            py0 = y0 + (y1 - y0) * j / rows
            py1 = y0 + (y1 - y0) * (j + 1) / rows
            m.d.rectangle([px0, py0, px1, py1],
                          fill=jit(shade(base, RNG.uniform(0.9, 1.1)), 4))
            m.d.rectangle([px0, py0, px1, py1], outline=shade(base, 0.72))
            m.o.rectangle([px0, py0, px1, py1],
                          outline=(AO_SEAM, rough, metal))
            bolts(m, [(px0 + 8, py0 + 8), (px1 - 8, py0 + 8),
                      (px0 + 8, py1 - 8), (px1 - 8, py1 - 8)], r=3,
                  base=base)
    wear_edges(m, rect, base, 60)


def paint_hull(m):
    _plated(m, L.HULL_S, OXIDE, 8, 3)
    # scorch bloom mid-cell + streaking rust (drawn dark, weather adds more)
    x0, y0, x1, y1 = L.HULL_S
    for (fx, fy, r) in ((0.34, 0.55, 90), (0.42, 0.4, 60), (0.7, 0.65, 70)):
        cx, cy = x0 + (x1 - x0) * fx, y0 + (y1 - y0) * fy
        m.d.ellipse([cx - r, cy - r * 0.7, cx + r, cy + r * 0.7],
                    fill=jit(shade(OXIDE, 0.62), 6))
    _plated(m, L.HULL_E, shade(OXIDE, 0.94), 3, 2)
    # deck: steel planks, tone-on-tone
    x0, y0, x1, y1 = L.HULL_T
    fill(m, L.HULL_T, dif=shade(OXIDE, 0.82), ao=AO_BASE - 8, rough=190,
         metal=110)
    for i in range(10):
        py = y0 + (y1 - y0) * i / 10
        m.d.rectangle([x0, py, x1, py + (y1 - y0) / 10],
                      fill=jit(shade(OXIDE, 0.76 + 0.08 * (i % 3)), 4))
        m.d.line([(x0, py), (x1, py)], fill=shade(OXIDE, 0.6), width=2)
        m.o.line([(x0, py), (x1, py)], fill=(AO_SEAM, 190, 110), width=2)
    wear_edges(m, L.HULL_T, OXIDE, 40)


def paint_running_gear(m):
    # wheel tread wrap
    fill(m, L.WHEEL_W, dif=DKSTEEL, ao=AO_BASE - 10, rough=140, metal=180)
    x0, y0, x1, y1 = L.WHEEL_W
    for i in range(8):
        fx = x0 + (x1 - x0) * i / 8
        m.d.rectangle([fx, y0, fx + (x1 - x0) / 8, y1],
                      fill=jit(shade(DKSTEEL, 0.92 + 0.06 * (i % 2)), 3))
    m.d.rectangle([x0, y0, x1, y0 + 10], fill=shade(DKSTEEL, 1.25))
    # hub face: rim ring + plate + lugs
    x0, y0, x1, y1 = L.HUB
    fill(m, L.HUB, dif=shade(DKSTEEL, 1.05), ao=AO_BASE - 8, rough=150,
         metal=180)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rr = (x1 - x0) * 0.46
    m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                outline=shade(DKSTEEL, 1.3), width=5)
    m.d.ellipse([cx - rr * 0.45, cy - rr * 0.45, cx + rr * 0.45,
                 cy + rr * 0.45], fill=shade(DKSTEEL, 0.8))
    bolts(m, [(cx + rr * 0.68 * np.cos(t), cy + rr * 0.68 * np.sin(t))
              for t in np.linspace(0, 2 * np.pi, 8, endpoint=False)],
          r=4, base=DKSTEEL)
    # coupler + underframe darks
    fill(m, L.COUP, dif=shade(STEEL_DK, 0.95), ao=AO_BASE - 12, rough=165,
         metal=160)
    wear_edges(m, L.COUP, STEEL_DK, 30)
    fill(m, L.UNDER, dif=shade(DKSTEEL, 0.8), ao=AO_BASE - 20, rough=185,
         metal=140)
    fill(m, L.DARK, dif=BLACKISH, ao=AO_DEEP, rough=210, metal=30)


def paint_track(m):
    # rails: rusted flanks, worn head band along the top edge
    x0, y0, x1, y1 = L.RAIL_S
    fill(m, L.RAIL_S, dif=RAILC, ao=AO_BASE - 6, rough=170, metal=140)
    m.d.rectangle([x0, y0, x1, y0 + (y1 - y0) * 0.28],
                  fill=shade(RAILC, 1.16))
    for _ in range(24):
        gx = RNG.uniform(x0, x1 - 60)
        gy = RNG.uniform(y0 + (y1 - y0) * 0.3, y1 - 3)
        m.d.line([(gx, gy), (gx + RNG.uniform(20, 60), gy)],
                 fill=jit(shade(RAILC, RNG.uniform(0.85, 1.1)), 4))
    # sleepers: grey split timber
    x0, y0, x1, y1 = L.SLEEP_T
    fill(m, L.SLEEP_T, dif=TIMBER, ao=AO_BASE - 8, rough=215, metal=10)
    for _ in range(30):
        gx = RNG.uniform(x0, x1 - 80)
        gy = RNG.uniform(y0 + 3, y1 - 3)
        m.d.line([(gx, gy), (gx + RNG.uniform(30, 80), gy)],
                 fill=jit(shade(TIMBER, RNG.uniform(0.8, 1.12)), 5))
    wear_edges(m, L.SLEEP_T, TIMBER, 30)
    # ballast top: gravel speckle + dragged gouge toward the car
    x0, y0, x1, y1 = L.BAL_T
    fill(m, L.BAL_T, dif=GRAVEL, ao=AO_BASE - 6, rough=220, metal=0)
    for _ in range(2600):
        px = RNG.uniform(x0, x1 - 3)
        py = RNG.uniform(y0, y1 - 3)
        c = jit(shade(GRAVEL, RNG.uniform(0.84, 1.14)), 6)
        m.d.rectangle([px, py, px + RNG.uniform(1.5, 4), py + RNG.uniform(1.5, 4)],
                      fill=c)
    # gouge: dark diagonal drag ruts (u=x, v=z window is the scatter area)
    for off in (-14, 8, 30):
        pts = [(x0 + (x1 - x0) * (0.45 + 0.4 * t) + off,
                y0 + (y1 - y0) * (0.35 + 0.45 * t)) for t in
               np.linspace(0, 1, 8)]
        m.d.line(pts, fill=shade(DIRT, 0.7), width=12)
        m.o.line(pts, fill=(AO_BASE - 26, 230, 0), width=12)
    wear_edges(m, L.BAL_T, GRAVEL, 60)
    fill(m, L.BAL_S, dif=shade(GRAVEL, 0.86), ao=AO_BASE - 16, rough=228,
         metal=0)


def paint_crates_plate(m):
    # crate side: planks + battens
    x0, y0, x1, y1 = L.CRATE_S
    fill(m, L.CRATE_S, dif=WOOD, ao=AO_BASE - 4, rough=205, metal=12)
    for i in range(5):
        py0 = y0 + (y1 - y0) * i / 5
        py1 = y0 + (y1 - y0) * (i + 1) / 5
        m.d.rectangle([x0, py0, x1, py1],
                      fill=jit(shade(WOOD, 0.88 + 0.07 * (i % 3)), 5))
        m.d.line([(x0, py1), (x1, py1)], fill=WOOD_DK, width=2)
        m.o.line([(x0, py1), (x1, py1)], fill=(AO_SEAM, 205, 12), width=2)
    for bx in (x0 + 8, x1 - 24):
        m.d.rectangle([bx, y0 + 2, bx + 16, y1 - 2], fill=jit(WOOD_DK, 5))
    bolts(m, [(x0 + 14, y0 + 12), (x1 - 14, y0 + 12),
              (x0 + 14, y1 - 12), (x1 - 14, y1 - 12)], r=3, base=WOOD)
    wear_edges(m, L.CRATE_S, WOOD, 40)
    # crate top: planks the other way, tone-on-tone (large-quad cell)
    x0, y0, x1, y1 = L.CRATE_T
    fill(m, L.CRATE_T, dif=shade(WOOD, 0.94), ao=AO_BASE - 6, rough=210,
         metal=12)
    for i in range(4):
        px = x0 + (x1 - x0) * i / 4
        m.d.rectangle([px, y0, px + (x1 - x0) / 4, y1],
                      fill=jit(shade(WOOD, 0.9 + 0.06 * (i % 2)), 4))
        m.d.line([(px, y0), (px, y1)], fill=shade(WOOD_DK, 1.1), width=2)
    wear_edges(m, L.CRATE_T, WOOD, 30)
    # torn plate: oxide steel, burnt edge border
    x0, y0, x1, y1 = L.PLATE
    fill(m, L.PLATE, dif=shade(OXIDE, 0.9), ao=AO_BASE - 8, rough=180,
         metal=130)
    m.d.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2],
                  outline=jit(shade(OXIDE, 0.5), 6), width=8)
    for _ in range(14):
        px = RNG.uniform(x0 + 10, x1 - 30)
        py = RNG.uniform(y0 + 10, y1 - 30)
        m.d.ellipse([px, py, px + RNG.uniform(8, 26), py + RNG.uniform(6, 20)],
                    fill=jit(shade(RUST, RNG.uniform(0.8, 1.05)), 6))
    wear_edges(m, L.PLATE, OXIDE, 50)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_hull(m)
    paint_running_gear(m)
    paint_track(m)
    paint_crates_plate(m)

    wx = PL.standard_weather(
        m, L,
        ground_rects=(L.WHEEL_W, L.UNDER, L.SLEEP_T, L.BAL_S),
        side_zones=(), seed=90210, mud=0.45, grime=0.5, rust_fraction=0.6)
    # heavy rust on the dead car
    x0, y0, x1, y1 = L.HULL_S
    for fx in np.linspace(0.06, 0.94, 11):
        wx.rust_streak(x0 + (x1 - x0) * fx, y0 + (y1 - y0) * RNG.uniform(0.05, 0.3),
                       int((y1 - y0) * RNG.uniform(0.25, 0.7)), width=3.0,
                       strength=0.5)
    wx.plate_bottom_rust(L.HULL_S, n=9, strength=0.6)
    wx.plate_bottom_rust(L.HULL_E, n=5, strength=0.5)
    for rect in (L.WHEEL_W, L.HUB, L.COUP, L.RAIL_S):
        x0, y0, x1, y1 = rect
        for _ in range(5):
            wx.rust_blotch(RNG.uniform(x0 + 12, x1 - 12),
                           RNG.uniform(y0 + 12, y1 - 12),
                           RNG.uniform(8, 22), strength=0.6)
    # scorch: burnt zones on hull, deck, plate, and the ballast around
    wx.soot_patch((L.HULL_S[0] + 220, L.HULL_S[1] + 40,
                   L.HULL_S[0] + 560, L.HULL_S[3] - 20), strength=0.8)
    wx.soot_patch((L.HULL_T[0] + 60, L.HULL_T[1] + 20,
                   L.HULL_T[0] + 340, L.HULL_T[3] - 20), strength=0.6)
    wx.soot_patch(L.PLATE, strength=0.55)
    bx0, by0, bx1, by1 = L.BAL_T
    wx.soot_patch((bx0 + (bx1 - bx0) * 0.5, by0 + (by1 - by0) * 0.45,
                   bx0 + (bx1 - bx0) * 0.95, by0 + (by1 - by0) * 0.9),
                  strength=0.7)
    wx.oily((L.UNDER[0] + 10, L.UNDER[1] + 10, L.UNDER[2] - 10,
             L.UNDER[3] - 10), 0.5)

    from normals import HeightMap
    hm = HeightMap()
    x0, y0, x1, y1 = L.HULL_T
    for i in range(1, 10):
        gy = y0 + (y1 - y0) * i / 10
        hm.line((x0 + 2, gy), (x1 - 2, gy), -0.45, width=2)
    x0, y0, x1, y1 = L.CRATE_S
    for i in range(1, 5):
        gy = y0 + (y1 - y0) * i / 5
        hm.line((x0 + 2, gy), (x1 - 2, gy), -0.5, width=2)
    x0, y0, x1, y1 = L.WHEEL_W
    hm.line((x0 + 2, y0 + 8), (x1 - 2, y0 + 8), 0.5, width=3)

    # no team (map prop), no emissive (wrecks don't glow)
    PL.finish(m, L, 'ms_train_wreck', hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
