"""paint_ms_dress_resistance — 1024² PBR set for the Resistance dressing kit.

Field-improvised register: low-contrast camo net (tone-on-tone blobs + faint
mesh grid — keeps the impostor baker's flat-shading honest on the big
canopy quads), canvas tarp with lashing straps, stencilled crates, olive
jerrycan blocks with painted can seams, weathered scrap flag post, soot-
mouthed welded smoke tubes. Team colour ONLY on the cause-flag cloth via
the team mask R channel (dark stencil star left unmasked). No emissive —
nothing on this kit is powered.
"""
from __future__ import annotations
import numpy as np

import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024
import paintlib as PL

import ms_dress_resistance_layout as L
from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, shade, jit,
                   BOLT_LOG, BLACKISH, TEAMGREY, AO_BASE, AO_DEEP)

RNG = np.random.default_rng(90210)
W = 1024
STEM = 'ms_dress_resistance'

NET_BASE = (80, 84, 62)       # camo net olive
NET_TONES = [(90, 82, 60), (70, 76, 55), (92, 91, 68)]   # ±15% tone-on-tone
CANVAS   = (99, 92, 68)       # tarp hessian
WOOD     = (108, 86, 56)      # crate planks
OLIVE    = (74, 78, 60)       # jerrycan steel
STEEL_D  = (66, 68, 71)       # frame / bracket / tube steel
TIMBER   = (88, 73, 52)       # flag post
STENCIL  = (168, 158, 132)    # hand-stencil paint


def paint_net(m):
    x0, y0, x1, y1 = L.NET.rect
    fill(m, (x0, y0, x1, y1), dif=NET_BASE, ao=AO_BASE - 10, rough=240,
         metal=5)
    # tone-on-tone camo blobs
    for _ in range(46):
        bx = RNG.uniform(x0, x1 - 40)
        by = RNG.uniform(y0, y1 - 30)
        bw = RNG.uniform(36, 110)
        bh = RNG.uniform(24, 70)
        tone = NET_TONES[int(RNG.integers(0, 3))]
        m.d.ellipse([bx, by, bx + bw, by + bh], fill=jit(tone, 4))
    # faint net mesh grid (both diagonals, very low contrast)
    mesh = shade(NET_BASE, 0.9)
    for k in range(-(y1 - y0), x1 - x0, 22):
        m.d.line([(x0 + k, y0), (x0 + k + (y1 - y0), y1)], fill=mesh)
        m.d.line([(x0 + k + (y1 - y0), y0), (x0 + k, y1)], fill=mesh)
    # a few ragged darker patches (scrim rags)
    for _ in range(14):
        bx = RNG.uniform(x0, x1 - 26)
        by = RNG.uniform(y0, y1 - 18)
        m.d.ellipse([bx, by, bx + RNG.uniform(14, 26), by + RNG.uniform(9, 18)],
                    fill=jit(shade(NET_BASE, 0.84), 4))
    wear_edges(m, (x0, y0, x1, y1), NET_BASE, 30)


def paint_tarp(m):
    x0, y0, x1, y1 = L.TARP.rect
    fill(m, (x0, y0, x1, y1), dif=CANVAS, ao=AO_BASE - 8, rough=235, metal=0)
    # fold shading bands
    for fy in (0.25, 0.5, 0.75):
        yy = y0 + (y1 - y0) * fy
        m.d.line([(x0, yy), (x1, yy)], fill=shade(CANVAS, 0.9), width=4)
    # lashing straps across the bundle
    for fx in (0.28, 0.72):
        xx = x0 + (x1 - x0) * fx
        m.d.rectangle([xx - 4, y0, xx + 4, y1], fill=shade(STEEL_D, 1.1))
        m.o.rectangle([xx - 4, y0, xx + 4, y1], fill=(AO_BASE - 8, 170, 60))
    # patched corner
    m.d.rectangle([x1 - 66, y1 - 50, x1 - 14, y1 - 12],
                  fill=jit(shade(CANVAS, 1.1), 4),
                  outline=shade(CANVAS, 0.7))
    wear_edges(m, (x0, y0, x1, y1), CANVAS, 30)


def paint_crate(m):
    x0, y0, x1, y1 = L.CRATE.rect
    fill(m, (x0, y0, x1, y1), dif=WOOD, ao=AO_BASE - 8, rough=225, metal=10)
    for gx in range(x0 + 24, x1, 24):
        seam_v(m, gx, y0 + 2, y1 - 2, WOOD, hi=False)
    for gy in (y0 + 8, y1 - 8):
        m.d.line([(x0 + 2, gy), (x1 - 2, gy)], fill=shade(WOOD, 0.8), width=3)
    bolts(m, [(x0 + 10, y0 + 10), (x1 - 10, y0 + 10),
              (x0 + 10, y1 - 10), (x1 - 10, y1 - 10)], r=2, base=WOOD)
    # hand stencil
    m.d.text((x0 + 28, (y0 + y1) // 2 - 12), 'R-7', font=PL.font(24),
             fill=shade(STENCIL, 0.9))
    wear_edges(m, (x0, y0, x1, y1), WOOD, 35)


def paint_cans(m):
    x0, y0, x1, y1 = L.CAN.rect
    fill(m, (x0, y0, x1, y1), dif=OLIVE, ao=AO_BASE - 8, rough=150, metal=130)
    u, v = PL.zone_fns(L.CAN)
    # block gap at rack centre x=0 (between the two blocks)
    gx = u(0.0)
    m.d.rectangle([gx - 5, y0, gx + 5, y1], fill=BLACKISH)
    m.o.rectangle([gx - 5, y0, gx + 5, y1], fill=(AO_DEEP, 200, 30))
    # per block: can seam + X ribs + filler caps
    for bx in (-0.22, 0.22):
        bx0, bx1 = u(bx - 0.20), u(bx + 0.20)
        seam_v(m, int(u(bx)), y0 + 4, y1 - 4, OLIVE)      # two cans per block
        for cx in (bx - 0.10, bx + 0.10):
            cx0, cx1 = u(cx - 0.085), u(cx + 0.085)
            ry0, ry1 = v(0.55), v(0.18)
            rib = shade(OLIVE, 1.12)
            m.d.line([(cx0, ry0), (cx1, ry1)], fill=rib, width=3)
            m.d.line([(cx0, ry1), (cx1, ry0)], fill=rib, width=3)
            m.d.ellipse([u(cx) - 5, v(0.60) - 5, u(cx) + 5, v(0.60) + 5],
                        fill=shade(OLIVE, 0.7))
        m.d.rectangle([bx0, y0 + 2, bx1, y1 - 2],
                      outline=shade(OLIVE, 0.6), width=2)
    wear_edges(m, (x0, y0, x1, y1), OLIVE, 40)


def paint_flag(m):
    u, v = PL.zone_fns(L.FLAG)
    # cloth cell: team respray over the whole cloth window
    b = PL.nbox(u(0.0), v(2.55), u(1.15), v(1.65))
    PL.team_panel(m, b, outline=None)
    m.o.rectangle(b, fill=(AO_BASE - 6, 245, 0))
    # cloth wave shading, tone-on-tone on the respray grey
    for fx in (0.35, 0.62, 0.88):
        xx = b[0] + (b[2] - b[0]) * fx
        m.d.line([(xx, b[1]), (xx, b[3])], fill=shade(TEAMGREY, 0.92),
                 width=5)
    # cause-mark: stencil star, mask CUT OUT so it stays dark cloth
    cx, cy = u(0.5), v(2.1)
    r = (v(1.65) - v(2.55)) * 0.30
    pts = []
    for i in range(10):
        a = -np.pi / 2 + i * np.pi / 5
        rr = r if i % 2 == 0 else r * 0.42
        pts.append((cx + rr * np.cos(a), cy + rr * np.sin(a)))
    m.d.polygon(pts, fill=(46, 42, 38))
    m.t.polygon(pts, fill=(0, 0, 0))
    # frayed trailing edge
    for _ in range(20):
        yy = RNG.uniform(b[1], b[3])
        m.d.line([(b[2] - RNG.uniform(3, 16), yy), (b[2], yy)],
                 fill=shade(TEAMGREY, 0.75))


def paint_bracket_and_rects(m):
    # smoke bracket
    x0, y0, x1, y1 = L.BRACKET.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_D, ao=AO_BASE - 10, rough=170,
         metal=150)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, STEEL_D, hi=False)
    bolts(m, [(x0 + 12, y0 + 12), (x1 - 12, y0 + 12),
              (x0 + 12, y1 - 12), (x1 - 12, y1 - 12)], r=3, base=STEEL_D)
    wear_edges(m, (x0, y0, x1, y1), STEEL_D, 40)
    # frame steel (limb rect)
    x0, y0, x1, y1 = L.TRIM_R
    fill(m, (x0, y0, x1, y1), dif=STEEL_D, ao=AO_BASE - 12, rough=165,
         metal=155)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, STEEL_D, hi=False)
    # flag post: weathered timber/scrap, grain along u
    x0, y0, x1, y1 = L.POLE_R
    fill(m, (x0, y0, x1, y1), dif=TIMBER, ao=AO_BASE - 10, rough=220,
         metal=20)
    for fy in (0.3, 0.6, 0.85):
        yy = int(y0 + (y1 - y0) * fy)
        m.d.line([(x0, yy), (x1, yy)], fill=shade(TIMBER, 0.85), width=2)
    # smoke tubes: steel with soot at the muzzle end (u = 1 → right edge)
    x0, y0, x1, y1 = L.TUBE_R
    fill(m, (x0, y0, x1, y1), dif=shade(STEEL_D, 0.95), ao=AO_BASE - 10,
         rough=180, metal=145)
    sx = x0 + int((x1 - x0) * 0.78)
    m.d.rectangle([sx, y0, x1, y1], fill=jit(shade(BLACKISH, 1.1), 4))
    m.o.rectangle([sx, y0, x1, y1], fill=(AO_DEEP + 20, 220, 40))
    # weld ring where tubes meet the bracket (u = 0 end)
    m.d.rectangle([x0, y0, x0 + 6, y1], fill=shade(STEEL_D, 1.25))
    # dark cap cell
    fill(m, L.DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=210, metal=40)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    fill(m, (0, 0, W, W), dif=NET_BASE, ao=AO_BASE - 10, rough=210, metal=40)
    paint_net(m)
    paint_tarp(m)
    paint_crate(m)
    paint_cans(m)
    paint_flag(m)
    paint_bracket_and_rects(m)

    # ── weathering: deck kit — dust and rust, no ground mud ──
    wx = PL.standard_weather(m, L, ground_rects=(), side_zones=(),
                             seed=90210, rust_fraction=0.5)
    wx.mud_band(L.NET.rect, 0.2, fade='down', spatter=False)   # dust drift
    wx.mud_band(L.TARP.rect, 0.25, fade='down', spatter=False)
    for fx in (0.2, 0.5, 0.8):
        x0, y0, x1, _ = L.BRACKET.rect
        wx.rust_streak(x0 + (x1 - x0) * fx, y0 + 8,
                       int(RNG.uniform(16, 30)), width=2.2, strength=0.5)
    wx.oily(L.TUBE_R, 0.35)          # burnt oil on the discharger pipes
    PL.finish(m, L, STEM, wx=wx)


if __name__ == '__main__':
    paint_all()
