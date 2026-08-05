"""paint_ms_dig_site — 1024 PBR set for ms_dig_site (no team colour).

Dig-site read: trampled dirt ring with rut marks, stratified pit walls,
pit floor with a revealed ancient monolithic slab (dark, seamless, faint
CYAN tracery — the only cyan, emissive), timber scaffold, steel cable and
hoist, dirt spoil heaps, crate of finds, pale string lines, and two warm
work lights (the only warm emissive).
"""
from __future__ import annotations
import numpy as np

import ms_dig_site_layout as L   # sets meshlib.ATLAS = 1024
import paintlib as PL
from paint import (Maps, fill, seam_h, seam_v, bolts, shade, wear_edges,
                   STEEL, STEEL_DK, BLACKISH, AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, M_ARMOR, M_STEEL, BOLT_LOG)

W = 1024
RNG = np.random.default_rng(90210)

DIRT      = (118, 100, 78)
DIRT_DK   = (98, 82, 62)
DIRT_LT   = (132, 114, 90)
SPOIL     = (106, 88, 66)
STRATA    = [(124, 106, 82), (108, 88, 66), (92, 74, 56), (80, 62, 46)]
TIMBER    = (128, 99, 66)
TIMBER_DK = (106, 80, 52)
STRING    = (224, 216, 196)
ANCIENT   = (58, 62, 68)
CYAN      = (70, 220, 230)
LAMP_WARM = (255, 222, 160)


def paint_ground(m):
    z = L.R_GROUND
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=DIRT, ao=AO_BASE, rough=R_ARMOR + 24, metal=0)
    # low-contrast mottling (impostor baker: keep tone-on-tone)
    for _ in range(160):
        px = RNG.uniform(x0, x1); py = RNG.uniform(y0, y1)
        r = RNG.uniform(4, 16)
        c = DIRT_DK if RNG.random() < 0.5 else DIRT_LT
        m.d.ellipse([px - r, py - r, px + r, py + r],
                    fill=shade(c, RNG.uniform(0.96, 1.04)))
    # trample-darkened apron around the pit rim
    pu0, pv0 = z.uv((-L.P_HALF - 0.5, 0, -L.P_HALF - 0.5))
    pu1, pv1 = z.uv((L.P_HALF + 0.5, 0, L.P_HALF + 0.5))
    m.d.rectangle([pu0 * W, pv0 * W, pu1 * W, pv1 * W],
                  outline=shade(DIRT_DK, 0.92), width=14)
    # wheelbarrow ruts from the pit toward each spoil heap
    for (sx, _, szz, _, _) in (L.SPOIL_A, L.SPOIL_B):
        au, av = z.uv((np.sign(sx) * L.P_HALF, 0, np.sign(szz) * L.P_HALF))
        bu, bv = z.uv((sx, 0, szz))
        for off in (-3, 3):
            m.d.line([(au * W + off, av * W), (bu * W + off, bv * W)],
                     fill=shade(DIRT_DK, 0.9), width=3)
    # scattered stones
    for _ in range(60):
        px = RNG.uniform(x0, x1); py = RNG.uniform(y0, y1)
        r = RNG.uniform(1.5, 3.5)
        m.d.ellipse([px - r, py - r, px + r, py + r], fill=shade(STEEL, 0.7))


def paint_pit(m):
    # stratified walls, darker with depth
    x0, y0, x1, y1 = L.R_PITW_X.rect
    n = len(STRATA)
    for i, c in enumerate(STRATA):
        yy0 = y0 + (y1 - y0) * i / n
        yy1 = y0 + (y1 - y0) * (i + 1) / n
        fill(m, (x0, int(yy0), x1, int(yy1)), dif=c, ao=AO_BASE - 8 - 6 * i,
             rough=R_ARMOR + 26, metal=0)
    for i in range(1, n):
        seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * i / n), STRATA[i - 1])
    # embedded rocks
    for _ in range(30):
        px = RNG.uniform(x0, x1); py = RNG.uniform(y0, y1)
        r = RNG.uniform(2, 5)
        m.d.ellipse([px - r, py - r, px + r, py + r], fill=shade(STEEL, 0.62))

    # pit floor: worked dirt + revealed ancient slab
    z = L.R_PITF
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=DIRT_DK, ao=AO_BASE - 16,
         rough=R_ARMOR + 26, metal=0)
    # the slab (world x 0.45±1.0, z 0.25±0.75) — monolithic, seamless
    su0, sv0 = z.uv((-0.55, 0, -0.5))
    su1, sv1 = z.uv((1.45, 0, 1.0))
    sb = [su0 * W, sv0 * W, su1 * W, sv1 * W]
    m.d.rectangle(sb, fill=ANCIENT)
    m.o.rectangle(sb, fill=(AO_BASE - 6, R_STEEL - 20, 120))
    # cyan tracery: one clean circuit-line motif, faint
    cx, cy = (sb[0] + sb[2]) / 2, (sb[1] + sb[3]) / 2
    pts = [(sb[0] + 10, cy), (cx - 14, cy), (cx - 14, sb[1] + 10),
           (cx + 16, sb[1] + 10), (cx + 16, cy + 12), (sb[2] - 10, cy + 12)]
    m.d.line(pts, fill=CYAN, width=3)
    m.e.line(pts, fill=(40, 130, 138))
    m.d.ellipse([cx - 5, cy - 5, cx + 5, cy + 5], fill=CYAN)
    m.e.ellipse([cx - 5, cy - 5, cx + 5, cy + 5], fill=(60, 180, 190))


def paint_spoil(m):
    x0, y0, x1, y1 = L.R_SPOIL1.rect
    fill(m, (x0, y0, x1, y1), dif=SPOIL, ao=AO_BASE - 6,
         rough=R_ARMOR + 28, metal=0)
    for _ in range(90):
        px = RNG.uniform(x0, x1); py = RNG.uniform(y0, y1)
        r = RNG.uniform(2, 6)
        c = shade(SPOIL, RNG.uniform(0.82, 1.14))
        m.d.ellipse([px - r, py - r, px + r, py + r], fill=c)


def paint_parts(m):
    # timber wrap: planked, low-contrast grain
    x0, y0, x1, y1 = L.R_WOOD
    fill(m, (x0, y0, x1, y1), dif=TIMBER, ao=AO_BASE - 4,
         rough=R_ARMOR + 18, metal=0)
    for gx in range(x0 + 12, x1, 22):
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)],
                 fill=shade(TIMBER_DK, RNG.uniform(0.95, 1.05)), width=2)
    # steel wrap (cable, hook, lamp posts)
    fill(m, L.R_STEEL, dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)
    # string wrap: pale line
    fill(m, L.R_STRING, dif=STRING, ao=AO_BASE, rough=R_ARMOR + 10, metal=0)

    # crate of finds: planks + battens + stencil
    z = L.R_CRATE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=TIMBER, ao=AO_BASE - 4,
         rough=R_ARMOR + 16, metal=0)
    for f in (0.33, 0.66):
        seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * f), TIMBER)
    m.d.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2],
                  outline=TIMBER_DK, width=6)
    bolts(m, [(x0 + 10, y0 + 10), (x1 - 10, y0 + 10), (x0 + 10, y1 - 10),
              (x1 - 10, y1 - 10)], r=3, base=TIMBER_DK)
    ft = PL.font(26)
    m.d.text(((x0 + x1) / 2, (y0 + y1) / 2), 'DIG 7', font=ft,
             fill=shade(BLACKISH, 1.4), anchor='mm')

    # hoist wrap: rusty steel with rib seams
    z = L.R_HOIST
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(STEEL, 0.9), ao=AO_BASE - 6,
         rough=R_STEEL + 10, metal=M_STEEL)
    for f in (0.3, 0.7):
        seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * f), shade(STEEL, 0.9))
    bolts(m, [(x0 + 12, y0 + 12), (x1 - 12, y0 + 12)], r=3,
          base=shade(STEEL, 0.9))
    wear_edges(m, z.rect, shade(STEEL, 0.9), density=18)

    # lamp head housing (non-lit faces)
    fill(m, L.R_LAMPBOX.rect, dif=STEEL_DK, ao=AO_BASE - 8,
         rough=R_STEEL, metal=M_STEEL)
    # lamp face: warm emissive — the human-tech lights
    x0, y0, x1, y1 = L.R_LAMP.rect
    fill(m, (x0, y0, x1, y1), dif=LAMP_WARM, ao=AO_BASE,
         rough=R_STEEL - 30, metal=0)
    m.e.rectangle([x0 + 4, y0 + 4, x1 - 4, y1 - 4], fill=LAMP_WARM)
    fill(m, L.R_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 16,
         metal=M_ARMOR)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_ground(m)
    paint_pit(m)
    paint_spoil(m)
    paint_parts(m)

    wx = PL.standard_weather(
        m, L,
        ground_rects=(L.R_SPOIL1.rect,),
        side_zones=(L.R_PITW_X, L.R_CRATE),
        seed=41, mud=0.4, grime=0.5, rust_fraction=0.5)
    wx.rust_streak(L.R_HOIST.rect[0] + 30, L.R_HOIST.rect[1] + 20, 60,
                   width=2.5, strength=0.35)
    PL.finish(m, L, 'ms_dig_site', wx=wx)


if __name__ == '__main__':
    paint_all()
