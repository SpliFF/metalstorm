"""paint_ms_barricade_gate — 1024² PBR set for the 8 m gateway.

Kit-sheet language carried over to the split model: concrete-and-steel pylons
with hazard chevrons at the base, a full hazard lintel, a three-panel salvage
leaf with a chevron band and team squares (mask R only), hessian sandbag toes.
Emissive black — the gateway carries no lights. Finished through
paintlib.finish (paint.enrich mottle + all five maps incl. normals).

The hazard chevrons are drawn centre-symmetric on a temp image: the leaf and
pylon zones are shared by both facing sides, which flip in X, and a ^-pattern
maps onto itself.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw

import ms_barricade_gate_layout as L
from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, jit, shade,
                   BOLT_LOG, TEAMGREY, YELLOW, BLACKISH, AO_BASE, AO_DEEP)
import paintlib as PL

RNG = np.random.default_rng(90210)
W = 1024
STEM = 'ms_barricade_gate'

PLATE_A = (106, 103, 96)
PLATE_B = (92, 89, 83)
PLATE_R = (112, 88, 64)
SAND_C  = (137, 121, 92)
STEEL_D = (66, 68, 71)
CONC    = (128, 126, 120)


def uv_px(zone, a, b):
    p = [0.0, 0.0, 0.0]
    p['xyz'.index(zone.axes[0])] = a
    p['xyz'.index(zone.axes[1])] = b
    u, v = zone.uv(p)
    return u * W, v * W


def chevrons(m, box, step=30):
    """Centre-symmetric hazard chevrons, drawn on a temp image so stripes
    never bleed into neighbouring zones."""
    x0, y0, x1, y1 = (int(v) for v in box)
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        return
    tmp = Image.new('RGB', (w, h), tuple(YELLOW))
    td = ImageDraw.Draw(tmp)
    cx = w / 2
    for i in range(-1, int(cx / step) + 2):
        if i % 2 == 0:
            continue
        for s in (-1, 1):
            xa = cx + s * i * step
            td.polygon([(xa, h), (xa + s * step, h), (xa + s * (step + h), 0),
                        (xa + s * h, 0)], fill=BLACKISH)
    m.dif.paste(tmp, (x0, y0))
    m.o.rectangle([x0, y0, x1, y1], fill=(AO_BASE - 6, 150, 60))


def paint_leaf(m):
    zone = L.GATE_LEAF
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=PLATE_A, ao=AO_BASE - 8, rough=180, metal=120)
    for (a0, a1, tone) in ((0.05, 1.75, PLATE_A), (1.75, 3.45, PLATE_B),
                           (3.45, 5.15, PLATE_R)):
        px0, py1 = uv_px(zone, a0, 0.15)
        px1, py0 = uv_px(zone, a1, 2.85)
        m.d.rectangle([px0, py0, px1, py1], fill=jit(tone, 4))
        m.o.rectangle([px0, py0, px1, py1],
                      fill=(AO_BASE - 6, 190 if tone is PLATE_R else 175,
                            60 if tone is PLATE_R else 130))
        seam_v(m, int(px1), int(py0) + 2, int(py1) - 2, tone)
    bx0, by1 = uv_px(zone, 0.15, 1.05)
    bx1, by0 = uv_px(zone, 5.05, 1.95)
    chevrons(m, (bx0, by0, bx1, by1))
    for wy in (2.7, 0.32):                    # bolt rows, top and bottom rail
        bolts(m, [uv_px(zone, wx, wy) for wx in np.linspace(0.35, 4.85, 12)],
              r=2, base=PLATE_B)
    for wx in (0.65, 4.55):                   # team squares, mirror-safe
        tx0, ty1 = uv_px(zone, wx - 0.32, 2.25)
        tx1, ty0 = uv_px(zone, wx + 0.32, 2.62)
        PL.team_panel(m, (tx0, ty0, tx1, ty1), outline=shade(PLATE_B, 0.5),
                      base=shade(TEAMGREY, 0.72))
    wear_edges(m, (x0, y0, x1, y1), PLATE_A, 50)


def paint_pylons(m):
    for zone, tone in ((L.PYLON, CONC), (L.PYLON_Z, shade(CONC, 0.95))):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=tone, ao=AO_BASE - 6, rough=205, metal=45)
        _, base1 = uv_px(zone, 0, 0.75)
        _, base0 = uv_px(zone, 0, 0.1)
        chevrons(m, (x0, base1, x1, base0), step=24)
        for wy in (1.5, 2.4):
            _, py = uv_px(zone, 0, wy)
            seam_h(m, x0 + 2, x1 - 2, int(py), CONC)
        _, ty0 = uv_px(zone, 0, 3.35)
        _, ty1 = uv_px(zone, 0, 2.95)
        PL.team_panel(m, (x0, ty0, x1, ty1), outline=shade(CONC, 0.55),
                      base=shade(TEAMGREY, 0.72))
        wear_edges(m, (x0, y0, x1, y1), CONC, 32)
    bolts(m, [(L.PYLON.rect[0] + (L.PYLON.rect[2] - L.PYLON.rect[0])
               * (i + 0.5) / 6, uv_px(L.PYLON, 0, 3.1)[1])
              for i in range(6)], r=2, base=CONC)


def paint_cells(m):
    x0, y0, x1, y1 = L.LINTEL.rect
    chevrons(m, (x0, y0, x1, y1), step=34)
    wear_edges(m, (x0, y0, x1, y1), YELLOW, 40)
    x0, y0, x1, y1 = L.LINTEL_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_D, ao=AO_BASE - 10, rough=175,
         metal=150)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, STEEL_D, hi=False)
    x0, y0, x1, y1 = L.TOPS.rect              # pylon caps
    fill(m, (x0, y0, x1, y1), dif=shade(STEEL_D, 1.08), ao=AO_BASE - 8,
         rough=185, metal=140)
    bolts(m, [(x0 + 10, y0 + 10), (x1 - 10, y0 + 10), (x0 + 10, y1 - 10),
              (x1 - 10, y1 - 10)], r=3, base=STEEL_D)
    m.d.rectangle([x0 + 3, y0 + 3, x1 - 3, y1 - 3],
                  outline=shade(STEEL_D, 0.6), width=2)
    x0, y0, x1, y1 = L.SAND.rect              # sandbags
    fill(m, (x0, y0, x1, y1), dif=SAND_C, ao=AO_BASE - 10, rough=240, metal=0)
    for gy in range(y0, y1, 14):
        m.d.line([(x0, gy), (x1, gy)], fill=shade(SAND_C, 0.82), width=2)
        off = 16 if (gy // 14) % 2 else 0
        for gx in range(x0 + off, x1, 32):
            m.d.line([(gx, gy), (gx, min(gy + 14, y1))],
                     fill=shade(SAND_C, 0.86))
    for _ in range(80):
        sx, sy = RNG.uniform(x0, x1 - 4), RNG.uniform(y0, y1 - 3)
        m.d.ellipse([sx, sy, sx + 3, sy + 2],
                    fill=jit(shade(SAND_C, RNG.uniform(0.85, 1.12)), 5))
    fill(m, L.TRIM.rect, dif=STEEL_D, ao=AO_BASE - 12, rough=165, metal=155)
    fill(m, L.DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=210, metal=40)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    fill(m, (0, 0, W, W), dif=PLATE_B, ao=AO_BASE - 10, rough=190, metal=100)
    paint_leaf(m)
    paint_pylons(m)
    paint_cells(m)

    wx = PL.standard_weather(m, L, ground_rects=(), side_zones=(L.GATE_LEAF,),
                             seed=90210, mud=0.5, grime=0.45,
                             rust_fraction=0.55)
    wx.plate_bottom_rust(L.GATE_LEAF.rect, n=9, band=8, strength=0.65)
    wx.mud_band(L.PYLON.rect, 0.4, fade='down')
    wx.mud_band(L.PYLON_Z.rect, 0.4, fade='down')
    wx.mud_band(L.SAND.rect, 0.45, fade='down', spatter=False)
    wx.oily(L.TRIM.rect, 0.3)                 # hinge grease

    from normals import HeightMap
    hm = HeightMap()
    bx0, by1 = uv_px(L.GATE_LEAF, 0.15, 1.05)
    bx1, by0 = uv_px(L.GATE_LEAF, 5.05, 1.95)
    hm.rect((bx0, by0, bx1, by1), 0.22)
    for gy in range(L.SAND.rect[1], L.SAND.rect[3], 14):
        hm.line((L.SAND.rect[0], gy), (L.SAND.rect[2], gy), -0.3, width=2)

    PL.finish(m, L, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
