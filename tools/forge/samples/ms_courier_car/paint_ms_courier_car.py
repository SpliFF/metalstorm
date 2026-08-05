"""paint_ms_courier_car — texture painter for ms_courier_car.

Paints the full 1024² PBR set from ms_courier_car_layout's zones:
  diffuse  (sRGB)   — armour panels, seams, canvas satchels, decals, wear
  orm      (linear) — R=AO, G=roughness, B=metallic
  emissive (sRGB)   — headlight slits, taillights, visor slit, RWS optic
  team     (linear) — R channel = team-colour blend mask (never baked
                      into diffuse)

Shares fable_tank's palette + helper layer (paint.py), weathering.py
(dirt/rust/oil/soot) and normals.py (height-map bake). RNG seed 90210.
"""
from __future__ import annotations
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

import ms_courier_car_layout as L
from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots,
                   wear_edges, jit, shade, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, LOWER, STEEL, STEEL_DK,
                   RUBBER, TRACK_MET, GLASS, YELLOW, BLACKISH, TEAMGREY,
                   CYAN, AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_RUBBER, R_GLASS,
                   M_ARMOR, M_STEEL, M_TRACK, M_GLASS)
import paint as P

RNG = np.random.default_rng(90210)
STEM = 'ms_courier_car'
OUT = 'out'
W = 1024

CANVAS = (118, 104, 78)          # satchel canvas
CANVAS_DK = (96, 84, 62)
STRAP = (58, 50, 40)
R_CANVAS, M_CANVAS = 225, 5

FONT_CANDIDATES = [
    P.FONT,                                              # linux (forge sandbox)
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',  # macOS
    '/System/Library/Fonts/Supplemental/Arial.ttf',
]


def font(size):
    for f in FONT_CANDIDATES:
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default(size=size)


def numeral(m, cx, cy, text, size, color=(196, 200, 204)):
    f = font(size)
    tw = m.d.textlength(text, font=f)
    m.d.text((cx - tw / 2 + 2, cy - size / 2 + 2), text, font=f,
             fill=shade(ARMOR_DK, 0.55))
    m.d.text((cx - tw / 2, cy - size / 2), text, font=f, fill=color)


# ── zone painters ────────────────────────────────────────────────────────

def paint_dark(m):
    fill(m, L.Z_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)
    fill(m, L.Z_CANVAS.rect, dif=CANVAS_DK, ao=AO_BASE - 30,
         rough=R_CANVAS, metal=M_CANVAS)
    # canvas cell: patch noise so degenerate-UV faces still read cloth
    x0, y0, x1, y1 = L.Z_CANVAS.rect
    for _ in range(10):
        bx = x0 + RNG.random() * (x1 - x0 - 14)
        by = y0 + RNG.random() * (y1 - y0 - 10)
        m.d.rectangle([bx, by, bx + 14, by + 10], fill=jit(CANVAS_DK, 7))


def paint_hull_top(m):
    zone = L.Z_HULL_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    # angular two-tone camo blocks
    for _ in range(6):
        bx = x0 + RNG.random() * (x1 - x0 - 90)
        by = y0 + RNG.random() * (y1 - y0 - 55)
        m.d.polygon([(bx, by + 9), (bx + 76, by), (bx + 90, by + 38),
                     (bx + 16, by + 50)], fill=jit(ARMOR_DK, 3))
    # deck panel seams
    for wz in (-2.15, -1.35, -0.55, 0.35, 1.15, 2.05):
        _, v = zone.uv((0, 0, wz))
        seam_h(m, x0 + 4, x1 - 4, int(v * W), ARMOR)
    for wx in (-0.55, 0.0, 0.55):
        u, _ = zone.uv((wx, 0, 0))
        seam_v(m, int(u * W), y0 + 4, y1 - 4, ARMOR)
    # MG ring base circle on the cab roof
    cu, cv = zone.uv((0, 0, L.TURRET_OFF[2]))
    cx, cy = cu * W, cv * W
    rx = abs(zone.uv((L.RING_R + 0.05, 0, 0))[0] - zone.uv((0, 0, 0))[0]) * W
    ry = abs(zone.uv((0, 0, L.TURRET_OFF[2] + L.RING_R + 0.05))[1] - cv) * W
    m.d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry],
                fill=STEEL_DK, outline=shade(STEEL_DK, 0.6), width=3)
    m.o.ellipse([cx - rx, cy - ry, cx + rx, cy + ry],
                fill=(AO_DEEP + 20, R_STEEL, M_STEEL))
    for i in range(10):
        a = 2 * np.pi * i / 10
        bolts(m, [(cx + np.cos(a) * (rx - 4), cy + np.sin(a) * (ry - 4))],
              r=2, base=STEEL)
    # bonnet grip strips + tactical numeral forward of the visor
    for wz in (-1.95, -1.80):
        _, v = zone.uv((0, 0, wz))
        m.d.rectangle([x0 + 40, v * W - 2, x1 - 40, v * W + 2],
                      fill=shade(ARMOR, 0.7))
    nu, nv = zone.uv((0.0, 0, -1.20))
    numeral(m, nu * W, nv * W, '07', 40)
    # team ID square on the free deck strip behind the hatch
    tu0, tv0 = zone.uv((-0.22, 0, 0.60))
    tu1, tv1 = zone.uv((0.22, 0, 0.82))
    m.t.rectangle([tu0 * W, tv0 * W, tu1 * W, tv1 * W], fill=(255, 0, 0))
    m.d.rectangle([tu0 * W, tv0 * W, tu1 * W, tv1 * W], fill=TEAMGREY,
                  outline=shade(ARMOR, 0.5))
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 55)


def paint_glacis(m):
    zone = L.Z_GLACIS
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    seam_v(m, (x0 + x1) // 2, y0 + 3, y1 - 3, ARMOR_DK)
    _, wv = zone.uv((0, 0.80, 0))
    seam_h(m, x0 + 3, x1 - 3, int(wv * W), ARMOR_DK)
    # team chevron (mask; grey stand-in on diffuse)
    cxm = (x0 + x1) / 2
    ch_w, ch_h = (x1 - x0) * 0.30, (y1 - y0) * 0.24
    cy0 = y0 + (y1 - y0) * 0.26
    poly = [(cxm - ch_w, cy0 + ch_h), (cxm, cy0), (cxm + ch_w, cy0 + ch_h),
            (cxm + ch_w, cy0 + ch_h + 12), (cxm, cy0 + 12),
            (cxm - ch_w, cy0 + ch_h + 12)]
    m.t.polygon(poly, fill=(255, 0, 0))
    m.d.polygon(poly, fill=TEAMGREY, outline=shade(ARMOR_DK, 0.5))
    # headlight slits (emissive) either side below the chevron
    for fx in (0.22, 0.78):
        lx = x0 + (x1 - x0) * fx
        ly = y0 + (y1 - y0) * 0.62
        m.d.rectangle([lx - 12, ly - 4, lx + 12, ly + 4], fill=GLASS)
        m.e.rectangle([lx - 10, ly - 2, lx + 10, ly + 2], fill=(200, 212, 220))
        m.o.rectangle([lx - 12, ly - 4, lx + 12, ly + 4],
                      fill=(AO_SEAM, R_GLASS, M_GLASS))
    # tow shackles low on the plate
    for fx in (0.18, 0.82):
        tx = x0 + (x1 - x0) * fx
        ty = y1 - (y1 - y0) * 0.16
        m.d.rectangle([tx - 8, ty - 5, tx + 8, ty + 5], fill=STEEL_DK)
        m.d.ellipse([tx - 4, ty - 3, tx + 4, ty + 3], fill=BLACKISH)
        m.o.rectangle([tx - 8, ty - 5, tx + 8, ty + 5],
                      fill=(AO_SEAM, R_STEEL, M_STEEL))
    bolts(m, [(x0 + 8 + i * ((x1 - x0 - 16) / 5), y0 + 7) for i in range(6)],
          base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 45)


def paint_hull_rear(m):
    zone = L.Z_HULL_REAR
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    # dispatch door: recessed panel with hinges + handle
    db = [x0 + (x1 - x0) * 0.28, y0 + (y1 - y0) * 0.12,
          x0 + (x1 - x0) * 0.72, y0 + (y1 - y0) * 0.66]
    m.d.rectangle(db, fill=shade(ARMOR_DK, 0.9), outline=shade(ARMOR_DK, 0.5),
                  width=2)
    m.o.rectangle(db, fill=(AO_BASE - 20, R_ARMOR, M_ARMOR))
    for fy in (0.2, 0.8):
        hy = db[1] + (db[3] - db[1]) * fy
        m.d.rectangle([db[0] - 4, hy - 5, db[0] + 3, hy + 5], fill=STEEL_DK)
    m.d.rectangle([db[2] - 12, (db[1] + db[3]) / 2 - 2,
                   db[2] - 4, (db[1] + db[3]) / 2 + 2], fill=STEEL)
    bolts(m, [(db[0] + 8 + i * ((db[2] - db[0] - 16) / 3), db[1] + 8)
              for i in range(4)], base=ARMOR_DK)
    # taillights (emissive red) + team square + numeral
    for fx in (0.12, 0.88):
        lx = x0 + (x1 - x0) * fx
        m.e.rectangle([lx - 9, y0 + 22, lx + 9, y0 + 28], fill=(160, 30, 24))
        m.d.rectangle([lx - 9, y0 + 22, lx + 9, y0 + 28], fill=(70, 20, 18))
    m.t.rectangle([x1 - 40, y0 + 40, x1 - 12, y0 + 66], fill=(255, 0, 0))
    m.d.rectangle([x1 - 40, y0 + 40, x1 - 12, y0 + 66], fill=TEAMGREY)
    numeral(m, x0 + 28, y0 + 52, '07', 26)
    # hazard strip along the bottom edge
    for i in range(int((x1 - x0) / 16) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 16, y1 - 14), (x0 + i * 16 + 16, y1 - 14),
                     (x0 + i * 16 + 8, y1 - 4), (x0 + i * 16 - 8, y1 - 4)],
                    fill=c)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 40)


def paint_hull_side(m):
    zone = L.Z_HULL_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    # waistline: sloped lower plate darker
    _, wv = zone.uv((0, 0.82, 0))
    wy = int(wv * W)
    m.d.rectangle([x0, wy, x1, y1], fill=LOWER)
    m.o.rectangle([x0, wy, x1, y1], fill=(AO_BASE - 30, R_ARMOR, M_ARMOR))
    seam_h(m, x0, x1, wy, ARMOR)
    # panel seams
    for wz in (-1.9, -0.95, 0.15, 1.05, 2.0):
        u, _ = zone.uv((0, 0, wz))
        seam_v(m, int(u * W), y0 + 3, wy, ARMOR)
    # engine intake grille over the rear arch
    iu0, iv0 = zone.uv((0, 1.28, 2.05))
    iu1, iv1 = zone.uv((0, 1.02, 2.55))
    ib = [iu0 * W, iv0 * W, iu1 * W, iv1 * W]
    m.d.rectangle(ib, fill=STEEL_DK)
    vent_slots(m, [ib[0] + 3, ib[1] + 3, ib[2] - 3, ib[3] - 3], 4,
               horizontal=False)
    # fuel filler forward of the rear arch
    fu, fv = zone.uv((0, 1.0, 1.15))
    m.d.ellipse([fu * W - 7, fv * W - 7, fu * W + 7, fv * W + 7],
                fill=STEEL_DK, outline=shade(ARMOR, 0.55))
    # shoulder team stripe (thin, full length — reads at strategic zoom)
    su0, sv0 = zone.uv((0, 1.36, -2.4))
    su1, sv1 = zone.uv((0, 1.28, 2.3))
    m.t.rectangle([su0 * W, sv0 * W, su1 * W, sv1 * W], fill=(255, 0, 0))
    m.d.rectangle([su0 * W, sv0 * W, su1 * W, sv1 * W], fill=TEAMGREY)
    # courier service emblem: mirror-safe winged diamond at mid-hull
    eu, ev = zone.uv((0, 1.12, -0.35))
    ex, ey = eu * W, ev * W
    m.d.polygon([(ex - 10, ey), (ex, ey - 9), (ex + 10, ey), (ex, ey + 9)],
                fill=(196, 200, 204))
    for s in (-1, 1):
        m.d.polygon([(ex + s * 12, ey - 2), (ex + s * 30, ey - 7),
                     (ex + s * 30, ey - 3), (ex + s * 12, ey + 2)],
                    fill=(170, 174, 178))
    wear_edges(m, (x0, y0, x1, wy), ARMOR, 45)


def paint_wheels(m):
    # tread wrap: rubber with grouser lugs per facet
    x0, y0, x1, y1 = L.Z_WHEEL_WRAP
    fill(m, (x0, y0, x1, y1), dif=RUBBER, ao=AO_BASE - 30, rough=R_RUBBER,
         metal=0)
    n = 16
    for i in range(n):
        lx = x0 + (x1 - x0) * i / n
        lw = (x1 - x0) / n
        m.d.rectangle([lx + lw * 0.30, y0 + 2, lx + lw * 0.70, y1 - 2],
                      fill=jit((48, 50, 54), 4))
        m.d.line([(lx, y0), (lx, y1)], fill=(22, 23, 26), width=2)
        m.o.rectangle([lx + lw * 0.30, y0 + 2, lx + lw * 0.70, y1 - 2],
                      fill=(AO_SEAM, R_RUBBER, 0))
    # hub cap: tyre ring + steel rim + lug bolts
    zone = L.Z_HUB
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=RUBBER, ao=AO_BASE - 25, rough=R_RUBBER,
         metal=0)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rr = abs(zone.uv((0, 0, 0.40))[0] * W - cx)
    m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=RUBBER)
    r2 = rr * 0.62
    m.d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], fill=jit(TRACK_MET, 3))
    m.o.ellipse([cx - r2, cy - r2, cx + r2, cy + r2],
                fill=(AO_SEAM, R_STEEL, M_TRACK))
    for k in range(6):
        a = k * np.pi / 3 + 0.26
        bolts(m, [(cx + np.cos(a) * r2 * 0.58, cy + np.sin(a) * r2 * 0.58)],
              r=3, base=TRACK_MET)
    m.d.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=STEEL_DK)
    # sidewall arc shading
    m.d.arc([cx - rr + 2, cy - rr + 2, cx + rr - 2, cy + rr - 2], 0, 360,
            fill=(24, 25, 28), width=3)


def paint_ring(m):
    # drum wrap: armoured segments + bolt row
    x0, y0, x1, y1 = L.Z_RING
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 10)
    for j in range(8):
        sx = x0 + (x1 - x0) * j / 8
        seam_v(m, int(sx), y0 + 2, y1 - 2, ARMOR_DK)
    bolts(m, [(x0 + (x1 - x0) * (j + 0.5) / 8, (y0 + y1) / 2)
              for j in range(8)], r=2, base=ARMOR_DK)
    # pedestal wrap: dark steel column
    x0, y0, x1, y1 = L.Z_PED
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 25, rough=R_STEEL,
         metal=M_STEEL)
    seam_h(m, x0, x1, (y0 + y1) // 2, STEEL_DK, hi=False)
    # ring top: steel plate with slew-bearing bolt circle
    zone = L.Z_RING_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 12, rough=R_STEEL,
         metal=M_STEEL)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rr = abs(zone.uv((0.40, 0, 0))[0] * W - cx)
    m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=STEEL,
                outline=shade(STEEL, 0.6), width=2)
    m.d.ellipse([cx - rr * 0.45, cy - rr * 0.45, cx + rr * 0.45,
                 cy + rr * 0.45], fill=STEEL_DK)
    for i in range(12):
        a = 2 * np.pi * i / 12
        bolts(m, [(cx + np.cos(a) * rr * 0.78, cy + np.sin(a) * rr * 0.78)],
              r=2, base=STEEL)


def paint_mg(m):
    # receiver top/bottom: steel, optic block with emissive eye at front
    x0, y0, x1, y1 = L.Z_MG_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 18, rough=R_STEEL,
         metal=M_STEEL)
    seam_v(m, (x0 + x1) // 2, y0 + 3, y1 - 3, STEEL, hi=False)
    # optic housing near the muzzle-side edge (front = low v in window)
    ou0, ov0 = L.Z_MG_TOP.uv((-0.07, 0, -0.24))
    ou1, ov1 = L.Z_MG_TOP.uv((0.07, 0, -0.06))
    m.d.rectangle([ou0 * W, ov0 * W, ou1 * W, ov1 * W], fill=BLACKISH)
    m.o.rectangle([ou0 * W, ov0 * W, ou1 * W, ov1 * W],
                  fill=(AO_DEEP, R_GLASS, M_GLASS))
    m.e.ellipse([(ou0 + ou1) / 2 * W - 3, (ov0 + ov1) / 2 * W - 3,
                 (ou0 + ou1) / 2 * W + 3, (ov0 + ov1) / 2 * W + 3],
                fill=CYAN)
    bolts(m, [(x0 + 10 + i * ((x1 - x0 - 20) / 3), y1 - 8) for i in range(4)],
          base=STEEL)
    # receiver sides: cooling slots + charging handle groove
    x0, y0, x1, y1 = L.Z_MG_SIDE.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 18, rough=R_STEEL,
         metal=M_STEEL)
    vent_slots(m, [x0 + 14, y0 + 14, x0 + 66, y1 - 20], 3, horizontal=False)
    m.d.rectangle([x0 + 76, (y0 + y1) / 2 - 2, x1 - 10, (y0 + y1) / 2 + 2],
                  fill=STEEL_DK)
    # ends: breech plate / muzzle collar
    x0, y0, x1, y1 = L.Z_MG_END.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 22, rough=R_STEEL,
         metal=M_STEEL)
    bolts(m, [(x0 + 10 + i * ((x1 - x0 - 20) / 2), (y0 + y1) / 2)
              for i in range(3)], base=STEEL_DK)
    # barrel wrap: dark steel, wear ring at the chamber (left = breech)
    x0, y0, x1, y1 = L.Z_MG_WRAP
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 15, rough=120,
         metal=205)
    m.d.rectangle([x0, y0, x0 + 14, y1], fill=STEEL)
    m.o.rectangle([x0, y0, x0 + 14, y1], fill=(AO_BASE - 10, 105, 215))
    # muzzle cap: bore
    r = L.Z_TUBE_CAP.rect
    fill(m, r, dif=BLACKISH, ao=AO_DEEP, rough=210, metal=60)
    cx, cy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    m.d.ellipse([cx - 10, cy - 10, cx + 10, cy + 10], fill=(12, 12, 14))
    # ammo box: painted steel, lid seam, latch, stencil
    x0, y0, x1, y1 = L.Z_AMMO.rect
    fill(m, (x0, y0, x1, y1), dif=(74, 76, 66), ao=AO_BASE - 15,
         rough=R_STEEL + 20, metal=140)
    seam_h(m, x0 + 3, x1 - 3, y0 + 18, (74, 76, 66))
    m.d.rectangle([(x0 + x1) / 2 - 4, y0 + 12, (x0 + x1) / 2 + 4, y0 + 24],
                  fill=STEEL_DK)
    m.d.rectangle([x0 + 12, y1 - 30, x0 + 58, y1 - 16], fill=YELLOW)
    m.d.text((x0 + 15, y1 - 29), '12.7', font=font(12), fill=BLACKISH)
    wear_edges(m, (x0, y0, x1, y1), (74, 76, 66), 25)


def paint_satchels(m):
    # tops: canvas rolls with straps at each satchel station
    zone = L.Z_SATCH_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=CANVAS, ao=AO_BASE - 8, rough=R_CANVAS,
         metal=M_CANVAS)
    for _ in range(14):
        bx = x0 + RNG.random() * (x1 - x0 - 40)
        by = y0 + RNG.random() * (y1 - y0 - 26)
        m.d.polygon([(bx, by + 6), (bx + 34, by), (bx + 40, by + 18),
                     (bx + 8, by + 24)], fill=jit(CANVAS, 8))
    # rack slab margin visible around the satchels: steel slats
    for (sx, sz) in L.SATCHELS:
        for dx in (-0.10, 0.10):
            u0, v0 = zone.uv((sx + dx - 0.025, 0, sz - 0.42))
            u1, v1 = zone.uv((sx + dx + 0.025, 0, sz + 0.42))
            m.d.rectangle([u0 * W, v0 * W, u1 * W, v1 * W], fill=STRAP)
            m.o.rectangle([u0 * W, v0 * W, u1 * W, v1 * W],
                          fill=(AO_SEAM, R_CANVAS, M_CANVAS))
        bu, bv = zone.uv((sx, 0, sz))
        m.d.rectangle([bu * W - 5, bv * W - 4, bu * W + 5, bv * W + 4],
                      fill=(150, 138, 96))   # brass plate tag
    # sides: canvas with strap drops + buckles
    zone = L.Z_SATCH_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=CANVAS, ao=AO_BASE - 10, rough=R_CANVAS,
         metal=M_CANVAS)
    for (sx, sz) in L.SATCHELS:
        for dz in (-0.22, 0.22):
            u, _ = zone.uv((0, 0, sz + dz))
            m.d.rectangle([u * W - 4, y0 + 2, u * W + 4, y1 - 2], fill=STRAP)
            bolts(m, [(u * W, y0 + (y1 - y0) * 0.72)], r=2, base=STRAP)
    seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * 0.30), CANVAS, hi=False)
    wear_edges(m, (x0, y0, x1, y1), CANVAS, 30)
    # ends: flap + stencil
    zone = L.Z_SATCH_END
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=CANVAS_DK, ao=AO_BASE - 12, rough=R_CANVAS,
         metal=M_CANVAS)
    for (sx, sz) in L.SATCHELS:
        u0, _ = zone.uv((sx - 0.16, 0, 0))
        u1, _ = zone.uv((sx + 0.16, 0, 0))
        m.d.rectangle([u0 * W, y0 + 8, u1 * W, y0 + (y1 - y0) * 0.44],
                      fill=jit(CANVAS, 6))
        m.d.rectangle([(u0 + u1) / 2 * W - 3, y0 + (y1 - y0) * 0.36,
                       (u0 + u1) / 2 * W + 3, y0 + (y1 - y0) * 0.52],
                      fill=STRAP)
    m.d.text((x0 + 8, y1 - 22), 'DSPX-07', font=font(14),
             fill=shade(CANVAS, 0.5))
    # panniers: canvas flap + strap + team patch
    zone = L.Z_PAN_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=CANVAS, ao=AO_BASE - 10, rough=R_CANVAS,
         metal=M_CANVAS)
    m.d.rectangle([x0 + 4, y0 + 4, x1 - 4, y0 + (y1 - y0) * 0.38],
                  fill=jit(CANVAS_DK, 4))
    for fx in (0.30, 0.70):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 4, y0 + 4, sx + 4, y1 - 4], fill=STRAP)
        bolts(m, [(sx, y0 + (y1 - y0) * 0.42)], r=2, base=STRAP)
    m.t.rectangle([x1 - 34, y1 - 30, x1 - 10, y1 - 10], fill=(255, 0, 0))
    m.d.rectangle([x1 - 34, y1 - 30, x1 - 10, y1 - 10], fill=TEAMGREY)
    wear_edges(m, (x0, y0, x1, y1), CANVAS, 26)


def paint_details(m):
    # crew hatch: circular lid + handle + bolt ring
    zone = L.Z_HATCH
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    m.d.ellipse([x0 + 10, y0 + 10, x1 - 10, y1 - 10], fill=ARMOR,
                outline=shade(ARMOR_DK, 0.55), width=2)
    bolts(m, [((x0 + x1) / 2 + np.cos(a) * ((x1 - x0) / 2 - 16),
               (y0 + y1) / 2 + np.sin(a) * ((y1 - y0) / 2 - 16))
              for a in np.linspace(0, 2 * np.pi, 8, endpoint=False)],
          base=ARMOR)
    m.d.rectangle([(x0 + x1) / 2 - 12, (y0 + y1) / 2 - 4,
                   (x0 + x1) / 2 + 12, (y0 + y1) / 2 + 4], fill=STEEL_DK)
    # visor: armoured brow with glass slit (faint emissive)
    x0, y0, x1, y1 = L.Z_VISOR.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 12)
    sy = y0 + (y1 - y0) * 0.40
    m.d.rectangle([x0 + 8, sy - 6, x1 - 8, sy + 6], fill=GLASS)
    m.o.rectangle([x0 + 8, sy - 6, x1 - 8, sy + 6],
                  fill=(AO_BASE, R_GLASS, M_GLASS))
    m.e.rectangle([x0 + 12, sy - 2, x1 - 12, sy + 2], fill=(46, 96, 108))
    bolts(m, [(x0 + 10 + i * ((x1 - x0 - 20) / 4), y1 - 8) for i in range(5)],
          base=ARMOR_DK)
    # exhaust: heat-tinted steel, bore at the rear (right) edge
    x0, y0, x1, y1 = L.Z_EXHAUST.rect
    fill(m, (x0, y0, x1, y1), dif=(60, 56, 54), ao=AO_BASE - 30, rough=190,
         metal=160)
    hw = int((x1 - x0) * 0.45)
    heat = Image.new('RGB', (hw, y1 - y0), (76, 54, 50))
    grad = Image.new('L', (hw, 1), 0)
    for gx in range(hw):
        grad.putpixel((gx, 0), int(130 * (gx / max(1, hw - 1)) ** 1.5))
    m.dif.paste(heat, (x1 - hw, y0), grad.resize((hw, y1 - y0)))
    m.d.rectangle([x1 - 8, y0 + 6, x1, y1 - 6], fill=BLACKISH)
    m.o.rectangle([x1 - 8, y0 + 6, x1, y1 - 6], fill=(AO_DEEP - 30, 220, 20))
    seam_v(m, x0 + int((x1 - x0) * 0.30), y0 + 3, y1 - 3, (60, 56, 54),
           hi=False)
    # bull bar: hazard chevrons over dark steel
    x0, y0, x1, y1 = L.Z_BUMPER.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 15, rough=150,
         metal=170)
    for i in range(int((x1 - x0) / 22) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 22, y0 + 6), (x0 + i * 22 + 22, y0 + 6),
                     (x0 + i * 22 + 10, y1 - 6), (x0 + i * 22 - 12, y1 - 6)],
                    fill=c)
    wear_edges(m, (x0, y0, x1, y1), STEEL_DK, 40)
    # rack frame: steel slats
    x0, y0, x1, y1 = L.Z_RACK.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 20, rough=R_STEEL,
         metal=M_STEEL)
    for i in range(8):
        sx = x0 + (x1 - x0) * (i + 0.5) / 8
        m.d.rectangle([sx - 2, y0 + 3, sx + 2, y1 - 3],
                      fill=shade(STEEL_DK, 0.7))
    # antenna wrap: dark steel whip
    x0, y0, x1, y1 = L.Z_ANT
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 10, rough=140,
         metal=190)
    m.d.rectangle([x0, y0, x0 + 10, y1], fill=BLACKISH)


# ── assembly ─────────────────────────────────────────────────────────────

def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_dark(m)
    paint_hull_top(m)
    paint_glacis(m)
    paint_hull_rear(m)
    paint_hull_side(m)
    paint_wheels(m)
    paint_ring(m)
    paint_mg(m)
    paint_satchels(m)
    paint_details(m)

    # ── weathering pass (dirt/rust/oil/soot where physics puts them) ──
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=41)
    wx.crevice_grime(m.dif, 0.62)
    # running gear heaviest — a courier lives on bad roads
    wx.mud_band(L.Z_WHEEL_WRAP, 0.9, fade=None)
    wx.mud_band(L.Z_HUB.rect, 0.7, fade=None)
    wx.mud_band(L.Z_HULL_SIDE.rect, 0.8, fade='down', dust=0.4)
    wx.mud_band(L.Z_GLACIS.rect, 0.6, fade='down', dust=0.35)
    wx.mud_band(L.Z_HULL_REAR.rect, 0.55, fade='down', dust=0.3)
    wx.mud_band(L.Z_BUMPER.rect, 0.55, fade='down')
    wx.mud_band(L.Z_PAN_SIDE.rect, 0.45, fade='down', spatter=False)
    # high surfaces: thin dust film only
    wx.mud_band(L.Z_HULL_TOP.rect, 0.2, fade=None, spatter=False)
    wx.mud_band(L.Z_SATCH_TOP.rect, 0.22, fade=None, spatter=False)
    wx.mud_band(L.Z_SATCH_SIDE.rect, 0.25, fade='down', spatter=False)
    wx.mud_band(L.Z_RING, 0.2, fade=None, spatter=False)
    # rust: water lines at plate bottoms + around bolt heads
    for r in (L.Z_HULL_SIDE.rect, L.Z_GLACIS.rect, L.Z_HULL_REAR.rect):
        wx.plate_bottom_rust(r, n=7, strength=0.6)
    gx0, gy0, gx1, gy1 = L.Z_GLACIS.rect
    for fx in (0.18, 0.5, 0.82):
        wx.rust_streak(gx0 + (gx1 - gx0) * fx, gy0 + (gy1 - gy0) * 0.5,
                       30, width=2.4, strength=0.4)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.55)
    # grease on the hubs; soot at exhausts + MG muzzle
    wx.oily(L.Z_HUB.rect, 0.35)
    wx.soot_patch(L.Z_EXHAUST.rect, 0.7, fade='right')
    bx0, by0, bx1, by1 = L.Z_MG_WRAP
    wx.soot_patch((bx0 + (bx1 - bx0) * 0.7, by0, bx1, by1), 0.5,
                  fade='right')
    wx.apply(m)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    # wheel tread lugs proud of the carcass
    x0, y0, x1, y1 = L.Z_WHEEL_WRAP
    for i in range(16):
        lx = x0 + (x1 - x0) * i / 16
        lw = (x1 - x0) / 16
        hm.rect((lx + lw * 0.30, y0 + 2, lx + lw * 0.70, y1 - 2), 0.7)
    # hub rim + cap
    zone = L.Z_HUB
    cx, cy = (zone.rect[0] + zone.rect[2]) / 2, (zone.rect[1] + zone.rect[3]) / 2
    rr = abs(zone.uv((0, 0, 0.40))[0] * W - cx)
    hm.disc(cx, cy, rr * 0.62, 0.4)
    hm.disc(cx, cy, 6, 0.6)
    # ring segment plates proud
    x0, y0, x1, y1 = L.Z_RING
    for j in range(8):
        sx0 = x0 + (x1 - x0) * j / 8
        sx1 = x0 + (x1 - x0) * (j + 1) / 8
        hm.rect((sx0 + 2, y0 + 2, sx1 - 2, y1 - 2), 0.3)
    # visor slit recessed
    x0, y0, x1, y1 = L.Z_VISOR.rect
    sy = y0 + (y1 - y0) * 0.40
    hm.rect((x0 + 8, sy - 6, x1 - 8, sy + 6), -0.6)
    # satchel straps bite into the canvas
    zone = L.Z_SATCH_TOP
    for (sx, sz) in L.SATCHELS:
        for dx in (-0.10, 0.10):
            u0, v0 = zone.uv((sx + dx - 0.025, 0, sz - 0.42))
            u1, v1 = zone.uv((sx + dx + 0.025, 0, sz + 0.42))
            hm.rect((u0 * W, v0 * W, u1 * W, v1 * W), -0.45)
    zone = L.Z_SATCH_SIDE
    x0, y0, x1, y1 = zone.rect
    for (sx, sz) in L.SATCHELS:
        for dz in (-0.22, 0.22):
            u, _ = zone.uv((0, 0, sz + dz))
            hm.rect((u * W - 4, y0 + 2, u * W + 4, y1 - 2), -0.45)
    # rack slats
    x0, y0, x1, y1 = L.Z_RACK.rect
    for i in range(8):
        sx = x0 + (x1 - x0) * (i + 0.5) / 8
        hm.rect((sx - 2, y0 + 3, sx + 2, y1 - 3), -0.35)
    # automatic detail: seams -> grooves, bolts -> domes, weather bumps
    hm.crevices_from(m.dif, 0.6)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=5.0).save(f'{OUT}/{STEM}_normals.png')

    # soften emissive so glow edges aren't razor-hard in mips
    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save(f'{OUT}/{STEM}_diffuse.png')
    m.orm.save(f'{OUT}/{STEM}_orm.png')
    m.emi.save(f'{OUT}/{STEM}_emissive.png')
    m.tea.save(f'{OUT}/{STEM}_team.png')
    print(f'[paint] full texture set written to {OUT}/')


if __name__ == '__main__':
    paint_all()
