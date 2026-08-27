"""paint_ms_tanks_s1 — 1024² PBR set for ms_tanks_s1 (tankette pack).

Raider-tier armour language: olive line-tank palette, thin-skinned read
(more scuffs than plate), white air-ID band + stencil star on the deck,
team chevron on the glacis + skirt stripes, '1x' hull numerals, rubber
wheels with steel hubs. paintlib-driven; PL.finish applies the standard
enrich pass + weathering and writes all five maps.
"""
from __future__ import annotations
import os
import numpy as np

import ms_tanks_s1_layout as L        # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024
import paintlib as PL

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, jit, shade,
                   BOLT_LOG, ARMOR, ARMOR_LT, ARMOR_DK, LOWER, STEEL,
                   STEEL_DK, RUBBER, TRACK_MET, YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP, R_ARMOR, R_STEEL, R_RUBBER,
                   M_ARMOR, M_STEEL, M_TRACK, RNG)

W = 1024
STEM = 'ms_tanks_s1'
WHITE_MK = (198, 202, 206)


def paint_dark(m):
    fill(m, L.T_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)


def paint_top(m):
    z = L.T_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    # panel patches
    for _ in range(5):
        bx = x0 + RNG.random() * (x1 - x0 - 80)
        by = y0 + RNG.random() * (y1 - y0 - 52)
        m.d.polygon([(bx, by + 8), (bx + 66, by), (bx + 78, by + 34),
                     (bx + 14, by + 44)], fill=jit(ARMOR_DK, 3))
    # deck seams
    for wz in (-1.8, -0.9, 0.1, 1.0, 1.9):
        _, v = z.uv((0, 0, wz))
        seam_h(m, x0 + 4, x1 - 4, int(v * W), ARMOR)
    for wx in (-0.6, 0.6):
        u, _ = z.uv((wx, 0, 0))
        seam_v(m, int(u * W), y0 + 4, y1 - 4, ARMOR)
    # white air-ID band across the nose deck
    bu0, bv0 = z.uv((-0.85, 0, -2.05))
    bu1, bv1 = z.uv((0.85, 0, -1.75))
    band = PL.nbox(bu0 * W, bv0 * W, bu1 * W, bv1 * W)
    m.d.rectangle(band, fill=WHITE_MK)
    m.o.rectangle(band, fill=(AO_BASE, R_ARMOR + 15, M_ARMOR))
    wear_edges(m, tuple(int(c) for c in band), ARMOR, 28)
    # stencil star on the rear deck (strategic-zoom read)
    su, sv = z.uv((0.0, 0, 0.65))
    PL.roundel_star(m, su * W, sv * W, 34, WHITE_MK)
    # engine intake grilles aft
    gu0, gv0 = z.uv((-0.5, 0, 1.05))
    gu1, gv1 = z.uv((0.5, 0, 1.35))
    g = PL.nbox(gu0 * W, gv0 * W, gu1 * W, gv1 * W)
    m.d.rectangle(g, fill=STEEL_DK)
    for gy in range(int(g[1]) + 3, int(g[3]) - 2, 6):
        m.d.line([(g[0] + 3, gy), (g[2] - 3, gy)], fill=BLACKISH, width=2)
    m.o.rectangle(g, fill=(AO_DEEP, R_STEEL, M_STEEL))
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 50)


def paint_side(m):
    z = L.T_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    _, wv = z.uv((0, 0.58, 0))
    wy = int(wv * W)
    m.d.rectangle([x0, wy, x1, y1], fill=LOWER)
    m.o.rectangle([x0, wy, x1, y1], fill=(AO_BASE - 30, R_ARMOR, M_ARMOR))
    seam_h(m, x0, x1, wy, ARMOR)
    for wz in (-1.5, -0.4, 0.7, 1.7):
        u, _ = z.uv((0, 0, wz))
        seam_v(m, int(u * W), y0 + 3, wy, ARMOR)
    # team stripe segment at the bow side (kept near hull tone for impostors)
    su0, sv0 = z.uv((0, 0.94, -2.10))
    su1, sv1 = z.uv((0, 0.70, -1.55))
    PL.team_panel(m, (su0 * W, sv0 * W, su1 * W, sv1 * W),
                  outline=ARMOR_DK, base=shade(ARMOR, 1.06))
    # hull number
    nu, nv = z.uv((0, 0.86, 0.30))
    f = PL.font(40)
    m.d.text((nu * W - 22, nv * W - 22), '11', font=f, fill=WHITE_MK)
    bolts(m, [(x0 + 14 + i * ((x1 - x0 - 28) / 9), wy - 8)
              for i in range(10)], base=ARMOR)
    wear_edges(m, (x0, y0, x1, wy), ARMOR, 42)


def paint_glacis(m):
    z = L.T_GLACIS
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    seam_h(m, x0 + 3, x1 - 3, int(y0 + (y1 - y0) * 0.42), ARMOR_DK)
    # team chevron
    cxm = (x0 + x1) / 2
    ch_w, ch_h = (x1 - x0) * 0.28, (y1 - y0) * 0.24
    cy0 = y0 + (y1 - y0) * 0.20
    poly = [(cxm - ch_w, cy0 + ch_h), (cxm, cy0), (cxm + ch_w, cy0 + ch_h),
            (cxm + ch_w, cy0 + ch_h + 12), (cxm, cy0 + 12),
            (cxm - ch_w, cy0 + ch_h + 12)]
    m.t.polygon(poly, fill=(255, 0, 0))
    m.d.polygon(poly, fill=shade(ARMOR_LT, 1.02), outline=shade(ARMOR_DK, 0.5))
    # headlights
    for fx in (0.16, 0.84):
        lx = x0 + (x1 - x0) * fx
        ly = y0 + (y1 - y0) * 0.58
        PL.headlight(m, (lx - 8, ly - 5, lx + 8, ly + 5))
    bolts(m, [(x0 + 9 + i * ((x1 - x0 - 18) / 6), y0 + 8) for i in range(7)],
          base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 40)


def paint_rear(m):
    z = L.T_REAR
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    # engine access door
    db = [x0 + (x1 - x0) * 0.28, y0 + (y1 - y0) * 0.18,
          x0 + (x1 - x0) * 0.72, y0 + (y1 - y0) * 0.80]
    m.d.rectangle(db, outline=shade(ARMOR_DK, 0.5), width=3)
    bolts(m, [(db[0] + 7, db[1] + 7), (db[2] - 7, db[1] + 7),
              (db[0] + 7, db[3] - 7), (db[2] - 7, db[3] - 7)], base=ARMOR_DK)
    f = PL.font(30)
    m.d.text(((db[0] + db[2]) / 2 - 16, db[1] + 8), '11', font=f,
             fill=WHITE_MK)
    # hazard strip + taillights + team ID square
    PL.hazard_band(m, (x0 + 2, y1 - 14, x1 - 2, y1 - 4))
    PL.taillight(m, (x0 + 12, y0 + 16, x0 + 34, y0 + 24))
    PL.team_panel(m, (x1 - 44, y0 + 12, x1 - 12, y0 + 40),
                  outline=ARMOR_DK, base=shade(ARMOR, 1.06))
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 34)


def paint_wheel(m):
    # square wheel cell: rubber rim ring (tread quads sample the rim) around
    # a steel hub disc — keep it N-fold symmetric for the X-spin
    z = L.T_WHEEL
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=RUBBER, ao=AO_BASE - 16, rough=R_RUBBER,
         metal=10)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rr = (x1 - x0) / 2 - 4
    m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=shade(RUBBER, 1.12))
    r2 = rr * 0.60
    m.d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], fill=jit(TRACK_MET, 3))
    m.o.ellipse([cx - r2, cy - r2, cx + r2, cy + r2],
                fill=(AO_SEAM, R_STEEL, M_TRACK))
    for a in np.linspace(0, 2 * np.pi, 5, endpoint=False):
        m.d.line([(cx + np.cos(a) * r2 * 0.25, cy + np.sin(a) * r2 * 0.25),
                  (cx + np.cos(a) * r2 * 0.85, cy + np.sin(a) * r2 * 0.85)],
                 fill=shade(TRACK_MET, 0.62), width=5)
    for a in np.linspace(0, 2 * np.pi, 5, endpoint=False):
        bolts(m, [(cx + np.cos(a + 0.62) * r2 * 0.55,
                   cy + np.sin(a + 0.62) * r2 * 0.55)], r=3, base=TRACK_MET)
    m.d.ellipse([cx - 7, cy - 7, cx + 7, cy + 7], fill=STEEL_DK)


def paint_turret(m):
    z = L.T_TURRET
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    for _ in range(3):
        bx = x0 + RNG.random() * (x1 - x0 - 70)
        by = y0 + RNG.random() * (y1 - y0 - 44)
        m.d.polygon([(bx, by + 8), (bx + 58, by), (bx + 68, by + 28),
                     (bx + 12, by + 36)], fill=jit(ARMOR_DK, 3))
    seam_h(m, x0 + 4, x1 - 4, (y0 + y1) // 2, ARMOR)
    # commander hatch ring (top projection centre)
    cu, cv = z.uv((0.10, 0, 0.12))
    m.d.ellipse([cu * W - 26, cv * W - 26, cu * W + 26, cv * W + 26],
                fill=ARMOR_DK, outline=shade(ARMOR_DK, 0.55), width=2)
    bolts(m, [(cu * W + np.cos(a) * 20, cv * W + np.sin(a) * 20)
              for a in np.linspace(0, 2 * np.pi, 6, endpoint=False)],
          base=ARMOR_DK)
    # team band along the turret rear
    PL.team_panel(m, (x0 + 8, y1 - 26, x1 - 8, y1 - 8),
                  outline=ARMOR_DK, base=shade(ARMOR, 1.06))
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 34)


def paint_cells(m):
    # barrel wrap: gunmetal + muzzle-end soot band
    x0, y0, x1, y1 = L.T_BARREL
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 8, rough=130,
         metal=200)
    m.d.rectangle([x0, y0, x1, y0 + 14], fill=BLACKISH)  # muzzle-end band
    for fy in (0.35, 0.65):
        gy = y0 + (y1 - y0) * fy
        m.d.rectangle([x0, gy - 2, x1, gy + 2], fill=shade(STEEL_DK, 0.7))
    # trim wrap (exhausts, aerial)
    fill(m, L.T_TRIM, dif=STEEL_DK, ao=AO_BASE - 10, rough=150, metal=180)
    tx0, ty0, tx1, ty1 = L.T_TRIM
    m.d.rectangle([tx0, ty0 + (ty1 - ty0) // 2 - 3, tx1,
                   ty0 + (ty1 - ty0) // 2 + 3], fill=GALV)
    # fender tops: dark tread plate
    x0, y0, x1, y1 = L.T_FENDER.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 8)
    for gx in range(x0 + 6, x1 - 4, 14):
        for gy in range(y0 + 6, y1 - 4, 12):
            off = 4 if ((gy - y0) // 12) % 2 else 0
            m.d.line([(gx + off, gy), (gx + off + 5, gy + 4)],
                     fill=shade(ARMOR_DK, 1.28), width=2)
    # stowage: canvas-lashed crate read
    x0, y0, x1, y1 = L.T_STOW.rect
    fill(m, (x0, y0, x1, y1), dif=shade(LOWER, 1.06), ao=AO_BASE - 12,
         rough=220, metal=0)
    for fx in (0.28, 0.55, 0.82):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 3, y0 + 4, sx + 3, y1 - 4], fill=STEEL_DK)
    seam_h(m, x0 + 2, x1 - 2, y0 + 12, LOWER)
    # driver hatch cell
    x0, y0, x1, y1 = L.T_HATCH.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    m.d.ellipse([x0 + 8, y0 + 8, x1 - 8, y1 - 8], fill=ARMOR,
                outline=shade(ARMOR_DK, 0.55), width=2)
    bolts(m, [((x0 + x1) / 2 + np.cos(a) * ((x1 - x0) / 2 - 12),
               (y0 + y1) / 2 + np.sin(a) * ((y1 - y0) / 2 - 12))
              for a in np.linspace(0, 2 * np.pi, 8, endpoint=False)],
          base=ARMOR)


GALV = (150, 154, 159)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_dark(m)
    paint_top(m)
    paint_side(m)
    paint_glacis(m)
    paint_rear(m)
    paint_wheel(m)
    paint_turret(m)
    paint_cells(m)

    wx = PL.standard_weather(
        m, L,
        ground_rects=[L.T_WHEEL.rect, L.T_FENDER.rect],
        side_zones=[L.T_SIDE, L.T_GLACIS, L.T_REAR],
        seed=41, mud=0.6, grime=0.5)
    wx.soot_patch(L.T_BARREL, 0.4)

    from normals import HeightMap
    hm = HeightMap()
    # fender tread diamonds
    fx0, fy0, fx1, fy1 = L.T_FENDER.rect
    for gx in range(fx0 + 6, fx1 - 4, 14):
        for gy in range(fy0 + 6, fy1 - 4, 12):
            off = 4 if ((gy - fy0) // 12) % 2 else 0
            hm.line((gx + off, gy), (gx + off + 5, gy + 4), 0.45, width=2)
    # wheel hub relief
    x0, y0, x1, y1 = L.T_WHEEL.rect
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rr = (x1 - x0) / 2 - 4
    hm.disc(cx, cy, rr * 0.60, 0.5)
    hm.disc(cx, cy, 7, 0.7)

    PL.finish(m, L, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
