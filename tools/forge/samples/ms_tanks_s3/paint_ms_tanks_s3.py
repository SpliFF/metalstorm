"""paint_ms_tanks_s3 — 1024² PBR set for ms_tanks_s3 (heavy tank platoon).

Line-tank armour language one step below the s4 dreadnought: olive plate,
heavy skirt armour over seven road wheels, railgun shroud in gunmetal with
warm capacitor tell-tales at the brake, team panels on turret cheeks +
skirt + rear ID square, '3x' hull numerals. paintlib-driven; PL.finish
applies the standard enrich pass + weathering and writes all five maps.
"""
from __future__ import annotations
import os
import numpy as np

import ms_tanks_s3_layout as L        # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024
import paintlib as PL

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, BOLT_LOG, ARMOR, ARMOR_LT, ARMOR_DK, LOWER,
                   STEEL, STEEL_DK, RUBBER, TRACK_MET, YELLOW, BLACKISH,
                   TEAMGREY, AO_BASE, AO_SEAM, AO_DEEP, R_ARMOR, R_STEEL,
                   R_RUBBER, M_ARMOR, M_STEEL, M_TRACK, RNG)

W = 1024
STEM = 'ms_tanks_s3'
WHITE_MK = (198, 202, 206)
AMBER = (255, 176, 60)
TEAM_BASE = shade(ARMOR, 1.06)


def paint_dark(m):
    fill(m, L.H_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)


def paint_hull_top(m):
    z = L.H_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    for _ in range(7):
        bx = x0 + RNG.random() * (x1 - x0 - 90)
        by = y0 + RNG.random() * (y1 - y0 - 60)
        m.d.polygon([(bx, by + 10), (bx + 76, by), (bx + 90, by + 40),
                     (bx + 16, by + 52)], fill=jit(ARMOR_DK, 3))
    for wz in (-4.8, -3.4, -2.0, -0.4, 1.2, 2.8, 4.2, 5.2):
        _, v = z.uv((0, 0, wz))
        seam_h(m, x0 + 4, x1 - 4, int(v * W), ARMOR)
    for wx in (-0.85, 0.0, 0.85):
        u, _ = z.uv((wx, 0, 0))
        seam_v(m, int(u * W), y0 + 4, y1 - 4, ARMOR)
    # engine deck aft: darker plate + grilles
    pu0, pv0 = z.uv((-1.15, 0, 2.6))
    pu1, pv1 = z.uv((1.15, 0, 5.3))
    deck = PL.nbox(pu0 * W, pv0 * W, pu1 * W, pv1 * W)
    m.d.rectangle(deck, fill=shade(ARMOR_DK, 0.92))
    m.o.rectangle(deck, fill=(AO_BASE - 20, R_ARMOR + 10, M_ARMOR))
    for gy in range(int(deck[1]) + 6, int(deck[3]) - 4, 12):
        m.d.line([(deck[0] + 4, gy), (deck[2] - 4, gy)],
                 fill=shade(ARMOR_DK, 0.72), width=2)
    # white air-ID band across the glacis deck
    bu0, bv0 = z.uv((-1.2, 0, -5.2))
    bu1, bv1 = z.uv((1.2, 0, -4.8))
    band = PL.nbox(bu0 * W, bv0 * W, bu1 * W, bv1 * W)
    m.d.rectangle(band, fill=WHITE_MK)
    wear_edges(m, tuple(int(c) for c in band), ARMOR, 30)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 55)


def paint_glacis(m):
    z = L.H_GLACIS
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    seam_h(m, x0 + 3, x1 - 3, int(y0 + (y1 - y0) * 0.38), ARMOR_DK)
    seam_v(m, (x0 + x1) // 2, y0 + 3, y1 - 3, ARMOR_DK)
    # team chevron
    cxm = (x0 + x1) / 2
    ch_w, ch_h = (x1 - x0) * 0.30, (y1 - y0) * 0.26
    cy0 = y0 + (y1 - y0) * 0.22
    poly = [(cxm - ch_w, cy0 + ch_h), (cxm, cy0), (cxm + ch_w, cy0 + ch_h),
            (cxm + ch_w, cy0 + ch_h + 14), (cxm, cy0 + 14),
            (cxm - ch_w, cy0 + ch_h + 14)]
    m.t.polygon(poly, fill=(255, 0, 0))
    m.d.polygon(poly, fill=TEAM_BASE, outline=shade(ARMOR_DK, 0.5))
    for fx in (0.15, 0.85):
        lx = x0 + (x1 - x0) * fx
        ly = y0 + (y1 - y0) * 0.55
        PL.headlight(m, (lx - 9, ly - 6, lx + 9, ly + 6))
    # tow points
    for fx in (0.12, 0.88):
        tx = x0 + (x1 - x0) * fx
        ty = y1 - (y1 - y0) * 0.18
        m.d.rectangle([tx - 9, ty - 6, tx + 9, ty + 6], fill=STEEL_DK)
        m.d.ellipse([tx - 4, ty - 3, tx + 4, ty + 3], fill=BLACKISH)
    bolts(m, [(x0 + 10 + i * ((x1 - x0 - 20) / 8), y0 + 8) for i in range(9)],
          base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 45)


def paint_rear(m):
    z = L.H_REAR
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    # engine doors
    db = [x0 + (x1 - x0) * 0.24, y0 + (y1 - y0) * 0.14,
          x0 + (x1 - x0) * 0.76, y0 + (y1 - y0) * 0.82]
    m.d.rectangle(db, outline=shade(ARMOR_DK, 0.5), width=3)
    seam_v(m, int((db[0] + db[2]) / 2), int(db[1]) + 3, int(db[3]) - 3,
           ARMOR_DK)
    bolts(m, [(db[0] + 8, db[1] + 8), (db[2] - 8, db[1] + 8),
              (db[0] + 8, db[3] - 8), (db[2] - 8, db[3] - 8)], base=ARMOR_DK)
    f = PL.font(38)
    m.d.text(((db[0] + db[2]) / 2 - 20, db[1] + 12), '31', font=f,
             fill=WHITE_MK)
    PL.hazard_band(m, (x0 + 2, y1 - 16, x1 - 2, y1 - 4))
    PL.taillight(m, (x0 + 14, y0 + 14, x0 + 40, y0 + 28))
    PL.team_panel(m, (x1 - 48, y0 + 12, x1 - 14, y0 + 44),
                  outline=ARMOR_DK, base=TEAM_BASE)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 35)


def paint_hull_side(m):
    z = L.H_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    _, wv = z.uv((0, 1.25, 0))
    wy = int(wv * W)
    m.d.rectangle([x0, wy, x1, y1], fill=LOWER)
    m.o.rectangle([x0, wy, x1, y1], fill=(AO_BASE - 30, R_ARMOR, M_ARMOR))
    seam_h(m, x0, x1, wy, ARMOR)
    for wz in (-4.2, -2.4, -0.6, 1.2, 3.0, 4.6):
        u, _ = z.uv((0, 0, wz))
        seam_v(m, int(u * W), y0 + 3, wy, ARMOR)
    wear_edges(m, (x0, y0, x1, wy), ARMOR, 40)


def paint_tracks_side(m):
    zone = L.TRK_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=LOWER, ao=AO_BASE - 25)

    def py(wy):
        return zone.uv((0, wy, 0))[1] * W

    def pz(wz):
        return zone.uv((0, 0, wz))[0] * W

    # wheel well
    m.d.rectangle([x0, py(1.05), x1, py(0.06)], fill=BLACKISH)
    m.o.rectangle([x0, py(1.05), x1, py(0.06)],
                  fill=(AO_DEEP - 30, R_RUBBER, 30))
    # 7 road wheels
    for wz in L.ROAD_WHEELS:
        cx, cy = pz(wz), py(0.55)
        r = pz(wz + 0.52) - pz(wz)
        m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=RUBBER)
        r2 = r * 0.66
        m.d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2],
                    fill=jit(TRACK_MET, 3))
        m.o.ellipse([cx - r, cy - r, cx + r, cy + r],
                    fill=(AO_DEEP, R_RUBBER, 30))
        m.o.ellipse([cx - r2, cy - r2, cx + r2, cy + r2],
                    fill=(AO_SEAM, R_STEEL, M_TRACK))
        for k in range(6):
            a = k * np.pi / 3 + 0.3
            bolts(m, [(cx + np.cos(a) * r2 * 0.55,
                       cy + np.sin(a) * r2 * 0.55)], r=2, base=TRACK_MET)
        m.d.ellipse([cx - 3, cy - 3, cx + 3, cy + 3], fill=STEEL_DK)
    # heavy skirt armour band
    sy0, sy1 = py(1.36), py(0.74)
    m.d.rectangle([x0, sy0, x1, sy1], fill=ARMOR_DK)
    m.o.rectangle([x0, sy0, x1, sy1], fill=(AO_BASE, R_ARMOR, M_ARMOR))
    for i in range(7):
        sx = x0 + (x1 - x0) * (i + 1) / 8.0
        seam_v(m, int(sx), int(sy0) + 2, int(sy1) - 2, ARMOR_DK)
    bolts(m, [(x0 + (x1 - x0) * (i + 0.5) / 8.0, (sy0 + sy1) / 2)
              for i in range(8)], base=ARMOR_DK)
    # team stripe segment at the skirt front
    PL.team_panel(m, (x0 + 6, sy0 + 3, x0 + 60, sy1 - 3),
                  outline=ARMOR_DK, base=TEAM_BASE)
    # fender edge band
    fy0, fy1 = py(1.60), py(1.42)
    m.d.rectangle([x0, fy0, x1, fy1], fill=ARMOR)
    seam_h(m, x0, x1, int(fy1), ARMOR)
    wear_edges(m, (x0, int(sy0), x1, int(sy1)), ARMOR_DK, 32)


def paint_track_wrap(m):
    x0, y0, x1, y1 = L.TRK_WRAP
    fill(m, (x0, y0, x1, y1), dif=TRACK_MET, ao=AO_SEAM, rough=R_RUBBER,
         metal=M_TRACK)
    n = 64
    for i in range(n):
        lx = x0 + (x1 - x0) * i / n
        lw = (x1 - x0) / n
        m.d.rectangle([lx + 1, y0, lx + lw - 1, y1], fill=jit(TRACK_MET, 5))
        m.d.line([(lx, y0), (lx, y1)], fill=BLACKISH, width=2)
        m.d.rectangle([lx + lw * 0.35, y0 + 2, lx + lw * 0.65, y1 - 2],
                      fill=RUBBER)


def paint_fender(m):
    x0, y0, x1, y1 = L.TRK_FENDER.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 8)
    for gx in range(x0 + 6, x1 - 4, 14):
        for gy in range(y0 + 6, y1 - 4, 12):
            off = 4 if ((gy - y0) // 12) % 2 else 0
            m.d.line([(gx + off, gy), (gx + off + 5, gy + 4)],
                     fill=shade(ARMOR_DK, 1.28), width=2)
    seam_h(m, x0, x1, y0 + 2, ARMOR_DK, hi=False)


def paint_turret(m):
    # sides (both cheeks share the zone — keep symmetric)
    z = L.TUR_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    _, bv = z.uv((0, 0.24, 0))
    m.d.rectangle([x0, int(bv * W), x1, y1], fill=STEEL_DK)
    m.o.rectangle([x0, int(bv * W), x1, y1], fill=(AO_DEEP, R_STEEL, M_STEEL))
    # team cheek panel
    pu0, pv0 = z.uv((0, 0.95, -1.35))
    pu1, pv1 = z.uv((0, 0.40, -0.25))
    PL.team_panel(m, (pu0 * W, pv0 * W, pu1 * W, pv1 * W),
                  outline=ARMOR_DK, base=TEAM_BASE)
    f = PL.font(52)
    nu, nv = z.uv((0, 0.80, 0.85))
    m.d.text((nu * W - 28, nv * W - 28), '31', font=f, fill=WHITE_MK)
    for wz in (-0.9, 0.4, 1.2):
        u, _ = z.uv((0, 0, wz))
        seam_v(m, int(u * W), y0 + 3, int(bv * W), ARMOR)
    wear_edges(m, (x0, y0, x1, int(bv * W)), ARMOR, 32)

    # front + mantlet
    x0, y0, x1, y1 = L.TUR_FRONT.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, ARMOR_DK)
    bolts(m, [(x0 + 10 + i * ((x1 - x0 - 20) / 5), y1 - 10)
              for i in range(6)], base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 30)

    # rear
    x0, y0, x1, y1 = L.TUR_REAR.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    PL.team_panel(m, (x1 - 44, y0 + 10, x1 - 12, y0 + 40),
                  outline=ARMOR_DK, base=TEAM_BASE)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 25)

    # top
    z = L.TUR_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    for _ in range(4):
        bx = x0 + RNG.random() * (x1 - x0 - 70)
        by = y0 + RNG.random() * (y1 - y0 - 44)
        m.d.polygon([(bx, by + 8), (bx + 60, by), (bx + 70, by + 30),
                     (bx + 12, by + 40)], fill=jit(ARMOR_DK, 3))
    su, sv = z.uv((0.0, 0, 0.9))
    PL.roundel_star(m, su * W, sv * W, 40, WHITE_MK)
    for wz in (-1.0, 0.1, 1.1):
        _, v = z.uv((0, 0, wz))
        seam_h(m, x0 + 4, x1 - 4, int(v * W), ARMOR)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 35)


def paint_cells(m):
    # railgun barrel wrap: gunmetal, rail seam, capacitor rings near the tip
    x0, y0, x1, y1 = L.BARREL_R_
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 8, rough=125,
         metal=205)
    m.d.rectangle([x0, y0, x1, y0 + 16], fill=BLACKISH)   # muzzle soot band
    seam_v(m, (x0 + x1) // 2, y0 + 4, y1 - 4, STEEL_DK)   # rail split line
    for fy in (0.22, 0.30, 0.38):
        gy = y0 + (y1 - y0) * fy
        m.d.rectangle([x0, gy - 3, x1, gy + 3], fill=shade(STEEL_DK, 0.7))
        m.e.rectangle([x0 + 4, gy - 1, x1 - 4, gy + 1], fill=(120, 60, 18))
    # trim wrap (aerial, exhaust tops, brake)
    fill(m, L.TRIM, dif=STEEL_DK, ao=AO_BASE - 10, rough=150, metal=180)
    tx0, ty0, tx1, ty1 = L.TRIM
    vent_slots(m, [tx0 + 8, ty0 + 10, tx1 - 8, ty0 + 44], 4,
               glow=(110, 40, 12))
    # hatch cell
    x0, y0, x1, y1 = L.HATCH.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    m.d.ellipse([x0 + 8, y0 + 8, x1 - 8, y1 - 8], fill=ARMOR,
                outline=shade(ARMOR_DK, 0.55), width=2)
    bolts(m, [((x0 + x1) / 2 + np.cos(a) * ((x1 - x0) / 2 - 12),
               (y0 + y1) / 2 + np.sin(a) * ((y1 - y0) / 2 - 12))
              for a in np.linspace(0, 2 * np.pi, 8, endpoint=False)],
          base=ARMOR)
    # MG body + barrel cells
    x0, y0, x1, y1 = L.MG_BODY.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 8)
    seam_h(m, x0 + 4, x1 - 4, (y0 + y1) // 2, ARMOR_DK)
    bolts(m, [(x0 + 14, y0 + 14), (x1 - 14, y0 + 14),
              (x0 + 14, y1 - 14), (x1 - 14, y1 - 14)], base=ARMOR_DK)
    fill(m, L.MG_BARREL, dif=STEEL_DK, ao=AO_BASE - 8, rough=130, metal=200)
    bx0, by0, bx1, by1 = L.MG_BARREL
    m.d.rectangle([bx0, by0, bx1, by0 + 8], fill=BLACKISH)
    # stowage cells: canvas-lashed
    x0, y0, x1, y1 = L.STOW.rect
    fill(m, (x0, y0, x1, y1), dif=shade(LOWER, 1.06), ao=AO_BASE - 12,
         rough=220, metal=0)
    for fx in (0.2, 0.4, 0.6, 0.8):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 3, y0 + 4, sx + 3, y1 - 4], fill=STEEL_DK)
    seam_h(m, x0 + 2, x1 - 2, y0 + 14, LOWER)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_dark(m)
    paint_hull_top(m)
    paint_glacis(m)
    paint_rear(m)
    paint_hull_side(m)
    paint_tracks_side(m)
    paint_track_wrap(m)
    paint_fender(m)
    paint_turret(m)
    paint_cells(m)

    wx = PL.standard_weather(
        m, L,
        ground_rects=[L.TRK_SIDE.rect, L.TRK_WRAP, L.TRK_FENDER.rect],
        side_zones=[L.H_SIDE, L.H_GLACIS, L.H_REAR],
        seed=41, mud=0.75, grime=0.6)
    # skirt rust streaks under the bolts + soot at exhausts/muzzle
    tx0, ty0, tx1, ty1 = L.TRK_SIDE.rect
    skirt_bot = int(L.TRK_SIDE.uv((0, 0.74, 0))[1] * 1024)
    for i in range(7):
        sx = tx0 + (tx1 - tx0) * (i + 0.5) / 7.0
        wx.rust_streak(sx, skirt_bot - 4, 16, strength=0.4)
    wx.soot_patch(L.BARREL_R_, 0.5)
    wx.soot_patch((L.TRIM[0], L.TRIM[1], L.TRIM[2], L.TRIM[1] + 50), 0.7)

    from normals import HeightMap
    hm = HeightMap()

    def hpy(wy):
        return L.TRK_SIDE.uv((0, wy, 0))[1] * 1024

    def hpz(wz):
        return L.TRK_SIDE.uv((0, 0, wz))[0] * 1024

    hm.rect((tx0, hpy(1.05), tx1, hpy(0.06)), -3.0)
    for wz in L.ROAD_WHEELS:
        cx, cy = hpz(wz), hpy(0.55)
        r = hpz(wz + 0.52) - hpz(wz)
        hm.disc(cx, cy, r, 0.3)
        hm.disc(cx, cy, r * 0.66, 0.5)
    hm.rect((tx0, hpy(1.36), tx1, hpy(0.74)), 0.24)
    hm.rect((tx0, hpy(1.60), tx1, hpy(1.42)), 0.3)
    wx0, wy0, wx1, wy1 = L.TRK_WRAP
    for i in range(64):
        lx = wx0 + (wx1 - wx0) * i / 64
        lw = (wx1 - wx0) / 64
        hm.rect((lx + 1.5, wy0, lx + lw - 1.5, wy1), 0.5)
    fx0, fy0, fx1, fy1 = L.TRK_FENDER.rect
    for gx in range(fx0 + 6, fx1 - 4, 14):
        for gy in range(fy0 + 6, fy1 - 4, 12):
            off = 4 if ((gy - fy0) // 12) % 2 else 0
            hm.line((gx + off, gy), (gx + off + 5, gy + 4), 0.45, width=2)

    PL.finish(m, L, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
