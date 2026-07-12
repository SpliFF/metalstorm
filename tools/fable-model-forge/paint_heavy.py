"""paint_heavy — texture painter for fable_heavy (2048² PBR set).

Texel density matches fable_tank (same px/m), so seams/bolts/wear read at
the same world scale — the unit is physically larger, not upscaled.
Reuses paint.py's helper layer with the module resolution patched to 2048.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

import heavy_layout as L        # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048                       # Maps() canvases + helpers now 2048²
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   stencil, jit, shade, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, LOWER, STEEL, STEEL_DK, RUBBER,
                   TRACK_MET, GLASS, YELLOW, BLACKISH, TEAMGREY, CYAN,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_RUBBER, R_GLASS,
                   M_ARMOR, M_STEEL, M_TRACK, M_GLASS, FONT, RNG)

W = 2048
NUM = '02'                       # tactical numeral for this hull
WHEELS = [-5.31 + i * 1.18 for i in range(10)]
WHEEL_Y, WHEEL_R = 0.70, 0.50


# ── hull ─────────────────────────────────────────────────────────────────

def paint_dark(m):
    fill(m, L.Z_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)


def paint_hull_top(m):
    zone = L.Z_HULL_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    for _ in range(11):
        bx = x0 + RNG.random() * (x1 - x0 - 110)
        by = y0 + RNG.random() * (y1 - y0 - 60)
        m.d.polygon([(bx, by + 10), (bx + 96, by), (bx + 112, by + 40),
                     (bx + 20, by + 52)], fill=jit(ARMOR_DK, 3))
    # transverse deck seams every ~1.5 m of hull
    for wz in np.arange(-7.0, 7.6, 1.5):
        _, v = zone.uv((0, 0, wz))
        seam_h(m, x0 + 4, x1 - 4, int(v * W), ARMOR)
    for wx in (-1.55, -0.70, 0.70, 1.55):
        u, _ = zone.uv((wx, 0, 0))
        seam_v(m, int(u * W), y0 + 4, y1 - 4, ARMOR)
    # main turret ring
    cu, cv = zone.uv((0, 0, L.TURRET_OFF[2]))
    cx, cy = cu * W, cv * W
    ring = 2.55
    rx = abs(zone.uv((ring, 0, 0))[0] - zone.uv((0, 0, 0))[0]) * W
    ry = abs(zone.uv((0, 0, L.TURRET_OFF[2] + ring))[1] - cv) * W
    m.d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry],
                fill=STEEL_DK, outline=shade(STEEL_DK, 0.6), width=3)
    m.o.ellipse([cx - rx, cy - ry, cx + rx, cy + ry],
                fill=(AO_DEEP + 20, R_STEEL, M_STEEL))
    for i in range(20):
        a = 2 * np.pi * i / 20
        bolts(m, [(cx + np.cos(a) * (rx - 6), cy + np.sin(a) * (ry - 5))],
              r=2, base=STEEL)
    # grip strips fore + walkway aft
    for wz in (-4.6, -4.3, 3.9, 4.2):
        _, v = zone.uv((0, 0, wz))
        m.d.rectangle([x0 + 40, v * W - 2, x1 - 40, v * W + 2],
                      fill=shade(ARMOR, 0.7))
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 90)


def paint_glacis(m):
    x0, y0, x1, y1 = L.Z_GLACIS.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    seam_h(m, x0 + 3, x1 - 3, int(y0 + (y1 - y0) * 0.38), ARMOR_DK)
    for fx in (0.33, 0.67):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 3, y1 - 3, ARMOR_DK)
    # big team chevron
    cxm = (x0 + x1) / 2
    ch_w, ch_h = (x1 - x0) * 0.30, (y1 - y0) * 0.26
    cy0 = y0 + (y1 - y0) * 0.26
    poly = [(cxm - ch_w, cy0 + ch_h), (cxm, cy0), (cxm + ch_w, cy0 + ch_h),
            (cxm + ch_w, cy0 + ch_h + 22), (cxm, cy0 + 22),
            (cxm - ch_w, cy0 + ch_h + 22)]
    m.t.polygon(poly, fill=(255, 0, 0))
    m.d.polygon(poly, fill=TEAMGREY, outline=shade(ARMOR_DK, 0.5))
    # numeral on the lower plate
    f = ImageFont.truetype(FONT, 56)
    tw = m.d.textlength(NUM, font=f)
    ny = y0 + (y1 - y0) * 0.66
    m.d.text((cxm - tw / 2 + 2, ny + 2), NUM, font=f, fill=shade(ARMOR_DK, 0.55))
    m.d.text((cxm - tw / 2, ny), NUM, font=f, fill=(196, 200, 204))
    # tow points
    for fx in (0.13, 0.87):
        tx = x0 + (x1 - x0) * fx
        ty = y1 - (y1 - y0) * 0.20
        m.d.rectangle([tx - 11, ty - 7, tx + 11, ty + 7], fill=STEEL_DK)
        m.d.ellipse([tx - 6, ty - 5, tx + 6, ty + 5], fill=BLACKISH)
        m.o.rectangle([tx - 11, ty - 7, tx + 11, ty + 7],
                      fill=(AO_SEAM, R_STEEL, M_STEEL))
    bolts(m, [(x0 + 12 + i * ((x1 - x0 - 24) / 10), y0 + 9) for i in range(11)],
          base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 70)


def paint_hull_rear(m):
    x0, y0, x1, y1 = L.Z_HULL_REAR.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    gb = [x0 + (x1 - x0) * 0.20, y0 + (y1 - y0) * 0.14,
          x0 + (x1 - x0) * 0.80, y0 + (y1 - y0) * 0.46]
    m.d.rectangle(gb, fill=STEEL_DK)
    vent_slots(m, [gb[0] + 5, gb[1] + 5, gb[2] - 5, gb[3] - 5], 5)
    hz = [x0, y1 - 18, x1, y1 - 5]
    for i in range(int((x1 - x0) / 18) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 18, hz[1]), (x0 + i * 18 + 18, hz[1]),
                     (x0 + i * 18 + 9, hz[3]), (x0 + i * 18 - 9, hz[3])], fill=c)
    m.t.rectangle([x1 - 58, y0 + 14, x1 - 16, y0 + 52], fill=(255, 0, 0))
    m.d.rectangle([x1 - 58, y0 + 14, x1 - 16, y0 + 52], fill=TEAMGREY)
    f = ImageFont.truetype(FONT, 40)
    m.d.text((x0 + 18, y0 + 12), NUM, font=f, fill=(188, 192, 196))
    m.e.rectangle([x0 + 18, y0 + 62, x0 + 52, y0 + 69], fill=(160, 30, 24))
    m.d.rectangle([x0 + 18, y0 + 62, x0 + 52, y0 + 69], fill=(70, 20, 18))
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 55)


def paint_hull_side(m):
    zone = L.Z_HULL_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    _, wv = zone.uv((0, 1.85, 0))
    wy = int(wv * W)
    m.d.rectangle([x0, wy, x1, y1], fill=LOWER)
    m.o.rectangle([x0, wy, x1, y1], fill=(AO_BASE - 30, R_ARMOR, M_ARMOR))
    seam_h(m, x0, x1, wy, ARMOR)
    for wz in (-6.6, -4.8, -2.9, -1.0, 0.9, 2.8, 4.6, 6.4):
        u, _ = zone.uv((0, 0, wz))
        seam_v(m, int(u * W), y0 + 3, wy, ARMOR)
    # faint powered conduit along the shoulder line
    _, gv = zone.uv((0, 2.72, 0))
    gu0, _ = zone.uv((0, 0, -3.4))
    gu1, _ = zone.uv((0, 0, 6.6))
    m.e.rectangle([gu0 * W, gv * W - 2, gu1 * W, gv * W + 2], fill=(24, 62, 72))
    m.d.rectangle([gu0 * W, gv * W - 2, gu1 * W, gv * W + 2], fill=(42, 62, 68))
    # side intake near the engine bay
    iu0, _ = zone.uv((0, 0, 4.2))
    iu1, iv0 = zone.uv((0, 2.75, 5.9))
    _, iv1 = zone.uv((0, 2.25, 0))
    ib = [iu0 * W, iv0 * W, iu1 * W, iv1 * W]
    m.d.rectangle(ib, fill=STEEL_DK)
    vent_slots(m, [ib[0] + 4, ib[1] + 4, ib[2] - 4, ib[3] - 4], 4)
    wear_edges(m, (x0, y0, x1, wy), ARMOR, 65)


# ── running gear ─────────────────────────────────────────────────────────

def draw_wheel(m, cx, cy, r, weathered=False):
    rim = (30, 31, 34) if weathered else RUBBER
    met = (52, 53, 56) if weathered else TRACK_MET
    m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=rim)
    r2 = r * 0.68
    m.d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], fill=jit(met, 3))
    if weathered:
        m.o.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(70, 210, 30))
        m.o.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], fill=(110, 150, 170))
    else:
        m.o.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(AO_DEEP, R_RUBBER, 30))
        m.o.ellipse([cx - r2, cy - r2, cx + r2, cy + r2],
                    fill=(AO_SEAM, R_STEEL, M_TRACK))
    for k in range(6):
        a = k * np.pi / 3 + 0.3
        bolts(m, [(cx + np.cos(a) * r2 * 0.55, cy + np.sin(a) * r2 * 0.55)],
              r=2, base=met)
    m.d.ellipse([cx - 4, cy - 4, cx + 4, cy + 4],
                fill=(40, 41, 44) if weathered else STEEL_DK)


def paint_tracks_side(m):
    zone = L.Z_TRACK_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=LOWER, ao=AO_BASE - 25)

    def py(wy):
        return zone.uv((0, wy, 0))[1] * W

    def pz(wz):
        return zone.uv((0, 0, wz))[0] * W

    # wheel-well band (void) + road wheels
    m.d.rectangle([x0, py(1.32), x1, py(0.08)], fill=BLACKISH)
    m.o.rectangle([x0, py(1.32), x1, py(0.08)], fill=(AO_DEEP - 30, R_RUBBER, 30))
    for wz in WHEELS:
        cx, cy = pz(wz), py(WHEEL_Y)
        r = pz(wz + WHEEL_R) - pz(wz)
        draw_wheel(m, cx, cy, r)
    # skirt armor band (plates project y 1.16..2.08)
    sy0, sy1 = py(2.08), py(1.16)
    m.d.rectangle([x0, sy0, x1, sy1], fill=ARMOR_DK)
    m.o.rectangle([x0, sy0, x1, sy1], fill=(AO_BASE, R_ARMOR, M_ARMOR))
    for i in range(9):
        sx = x0 + (x1 - x0) * (i + 1) / 10.0
        seam_v(m, int(sx), int(sy0) + 2, int(sy1) - 2, ARMOR_DK)
    bolts(m, [(x0 + (x1 - x0) * (i + 0.5) / 10.0, (sy0 + sy1) / 2)
              for i in range(10)], base=ARMOR_DK)
    # team stripe on the skirt front
    m.t.rectangle([x0 + 8, sy0 + 4, x0 + 84, sy1 - 4], fill=(255, 0, 0))
    m.d.rectangle([x0 + 8, sy0 + 4, x0 + 84, sy1 - 4], fill=TEAMGREY)
    # upper pod side band + fender edge
    fy0, fy1 = py(2.42), py(2.22)
    m.d.rectangle([x0, fy0, x1, fy1], fill=ARMOR)
    seam_h(m, x0, x1, int(fy1), ARMOR)
    wear_edges(m, (x0, int(sy0), x1, int(sy1)), ARMOR_DK, 50)


def paint_track_wrap(m):
    x0, y0, x1, y1 = L.Z_TRACK_WRAP
    fill(m, (x0, y0, x1, y1), dif=TRACK_MET, ao=AO_SEAM, rough=R_RUBBER,
         metal=M_TRACK)
    n = 80
    for i in range(n):
        lx = x0 + (x1 - x0) * i / n
        lw = (x1 - x0) / n
        m.d.rectangle([lx + 1, y0, lx + lw - 1, y1], fill=jit(TRACK_MET, 5))
        m.d.line([(lx, y0), (lx, y1)], fill=BLACKISH, width=2)
        m.d.rectangle([lx + lw * 0.35, y0 + 2, lx + lw * 0.65, y1 - 2],
                      fill=RUBBER)
        m.o.rectangle([lx + lw * 0.35, y0 + 2, lx + lw * 0.65, y1 - 2],
                      fill=(AO_SEAM, R_RUBBER, 60))


def paint_fender(m):
    x0, y0, x1, y1 = L.Z_FENDER.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 8)
    # tonal patches so the long apron doesn't read flat from altitude
    for _ in range(8):
        bx = x0 + RNG.random() * (x1 - x0 - 130)
        by = y0 + RNG.random() * (y1 - y0 - 40)
        m.d.polygon([(bx, by + 8), (bx + 110, by), (bx + 124, by + 30),
                     (bx + 16, by + 38)], fill=jit(shade(ARMOR_DK, 0.9), 3))
    # panel joints along the run
    for fx in np.arange(0.12, 0.95, 0.12):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 3, y1 - 3, ARMOR_DK)
    for gx in range(x0 + 6, x1 - 4, 14):
        for gy in range(y0 + 6, y1 - 4, 12):
            off = 4 if ((gy - y0) // 12) % 2 else 0
            m.d.line([(gx + off, gy), (gx + off + 5, gy + 4)],
                     fill=shade(ARMOR_DK, 1.13), width=1)
    seam_h(m, x0, x1, y0 + 2, ARMOR_DK, hi=False)
    for i in range(6):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 10, y0 + 2), (x0 + 10 + i * 10, y0 + 2),
                     (x0 + 4 + i * 10, y0 + 16), (x0 - 6 + i * 10, y0 + 16)],
                    fill=c)


# ── main turret ──────────────────────────────────────────────────────────

def paint_turret_top(m):
    zone = L.Z_TURRET_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    for _ in range(7):
        bx = x0 + RNG.random() * (x1 - x0 - 90)
        by = y0 + RNG.random() * (y1 - y0 - 55)
        m.d.polygon([(bx, by + 9), (bx + 74, by), (bx + 88, by + 38),
                     (bx + 16, by + 48)], fill=jit(ARMOR_DK, 3))
    for wz in (-1.9, -0.7, 0.6, 1.8, 2.7):
        _, v = zone.uv((0, 0, wz))
        seam_h(m, x0 + 4, x1 - 4, int(v * W), ARMOR)
    for wx in (-1.15, 0.0, 1.15):
        u, _ = zone.uv((wx, 0, 0))
        seam_v(m, int(u * W), y0 + 4, y1 - 4, ARMOR)
    # commander hatch ring beside the sight drum
    hu, hv = zone.uv((-0.75, 0, 1.15))
    hx, hy = hu * W, hv * W
    m.d.ellipse([hx - 34, hy - 26, hx + 34, hy + 26], fill=ARMOR_DK,
                outline=shade(ARMOR, 0.55), width=2)
    bolts(m, [(hx + np.cos(a) * 27, hy + np.sin(a) * 20)
              for a in np.linspace(0, 2 * np.pi, 8, endpoint=False)],
          base=ARMOR_DK)
    m.d.rectangle([hx - 5, hy - 15, hx + 5, hy + 2], fill=STEEL_DK)
    # front wedge team flash
    fu0, fv0 = zone.uv((-0.45, 0, -2.85))
    fu1, fv1 = zone.uv((0.45, 0, -2.05))
    m.t.polygon([(fu0 * W, fv1 * W), ((fu0 + fu1) / 2 * W, fv0 * W),
                 (fu1 * W, fv1 * W)], fill=(255, 0, 0))
    m.d.polygon([(fu0 * W, fv1 * W), ((fu0 + fu1) / 2 * W, fv0 * W),
                 (fu1 * W, fv1 * W)], fill=TEAMGREY)
    # roof tactical numeral
    nu, nv = zone.uv((0.0, 0, 2.35))
    f = ImageFont.truetype(FONT, 58)
    tw = m.d.textlength(NUM, font=f)
    m.d.text((nu * W - tw / 2 + 2, nv * W - 27 + 2), NUM, font=f,
             fill=shade(ARMOR_DK, 0.55))
    m.d.text((nu * W - tw / 2, nv * W - 27), NUM, font=f, fill=(196, 200, 204))
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 60)


def paint_turret_side(m):
    zone = L.Z_TURRET_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    _, bv = zone.uv((0, 0.32, 0))
    m.d.rectangle([x0, int(bv * W), x1, y1], fill=STEEL_DK)
    m.o.rectangle([x0, int(bv * W), x1, y1], fill=(AO_DEEP, R_STEEL, M_STEEL))
    # mirror-safe team panel with double chevron
    pu0, pv0 = zone.uv((0, 1.42, -0.30))
    pu1, pv1 = zone.uv((0, 0.68, 1.35))
    panel = [pu0 * W, pv0 * W, pu1 * W, pv1 * W]
    m.t.rectangle(panel, fill=(255, 0, 0))
    m.d.rectangle(panel, fill=TEAMGREY)
    m.d.rectangle(panel, outline=shade(ARMOR, 0.5), width=2)
    pw, ph = panel[2] - panel[0], panel[3] - panel[1]
    cxp = (panel[0] + panel[2]) / 2
    for k in (0.18, 0.5):
        chev = [(cxp - pw * 0.30, panel[1] + ph * (k + 0.30)),
                (cxp, panel[1] + ph * k),
                (cxp + pw * 0.30, panel[1] + ph * (k + 0.30)),
                (cxp + pw * 0.30, panel[1] + ph * (k + 0.46)),
                (cxp, panel[1] + ph * (k + 0.16)),
                (cxp - pw * 0.30, panel[1] + ph * (k + 0.46))]
        m.t.polygon(chev, fill=(0, 0, 0))
        m.d.polygon(chev, fill=(44, 48, 52))
    for wz in (-1.4, 1.95, 2.7):
        u, _ = zone.uv((0, 0, wz))
        seam_v(m, int(u * W), y0 + 3, int(bv * W), ARMOR)
    # cheek appliqué bolts (plates project into this zone)
    cu0, cv0 = zone.uv((0, 1.26, -2.50))
    cu1, cv1 = zone.uv((0, 0.58, -1.60))
    m.d.rectangle([cu0 * W, cv0 * W, cu1 * W, cv1 * W],
                  outline=shade(ARMOR, 0.55), width=2)
    bolts(m, [(cu0 * W + 8 + i * (cu1 * W - cu0 * W - 16) / 3, cv0 * W + 8)
              for i in range(4)], base=ARMOR)
    wear_edges(m, (x0, y0, x1, int(bv * W)), ARMOR, 40)


def paint_turret_front(m):
    x0, y0, x1, y1 = L.Z_TURRET_FRONT.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    seam_v(m, (x0 + x1) // 2, y0 + 3, y1 - 3, ARMOR_DK)
    for fx in (0.22, 0.78):
        lx = x0 + (x1 - x0) * fx
        ly = y0 + (y1 - y0) * 0.28
        m.d.rectangle([lx - 8, ly - 5, lx + 8, ly + 5], fill=GLASS)
        m.e.rectangle([lx - 6, ly - 3, lx + 6, ly + 3], fill=(190, 205, 215))
        m.o.rectangle([lx - 8, ly - 5, lx + 8, ly + 5],
                      fill=(AO_SEAM, R_GLASS, M_GLASS))
    bolts(m, [(x0 + 10 + i * ((x1 - x0 - 20) / 5), y1 - 9) for i in range(6)],
          base=ARMOR_DK)


def paint_turret_rear(m):
    x0, y0, x1, y1 = L.Z_TURRET_REAR.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    vent_slots(m, [x0 + 12, y0 + 12, x1 - 12, y0 + 38], 2)
    m.d.rectangle([x0 + 14, y0 + 48, x1 - 14, y1 - 12], fill=shade(LOWER, 1.1))
    for fx in (0.3, 0.7):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 2, y0 + 48, sx + 2, y1 - 12], fill=STEEL_DK)
    m.o.rectangle([x0 + 14, y0 + 48, x1 - 14, y1 - 12],
                  fill=(AO_BASE - 40, 190, 10))
    f = ImageFont.truetype(FONT, 32)
    m.d.text((x0 + 10, y0 + 8), NUM, font=f, fill=(188, 192, 196))


# ── armament ─────────────────────────────────────────────────────────────

def paint_barrel(m):
    x0, y0, x1, y1 = L.Z_BARREL_WRAP
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 15, rough=R_STEEL,
         metal=M_STEEL)
    z_hi = L.TUBE_STATIONS[0][0]
    zlen = abs(L.TUBE_STATIONS[-1][0] - z_hi)

    def pu(wz):
        return x0 + (x1 - x0) * abs(wz - z_hi) / zlen

    # armored jacket back half with cooling ribs
    su1 = pu(-3.30)
    m.d.rectangle([x0, y0, su1, y1], fill=ARMOR_DK)
    m.o.rectangle([x0, y0, su1, y1], fill=(AO_BASE, R_ARMOR, M_ARMOR))
    for i in range(7):
        rx = x0 + (su1 - x0) * (0.30 + i * 0.10)
        m.d.rectangle([rx, y0, rx + 5, y1], fill=STEEL_DK)
        m.o.rectangle([rx, y0, rx + 5, y1], fill=(AO_SEAM, R_STEEL, M_STEEL))
    stencil(m, (x0 + 10, y0 + (y1 - y0) * 0.36), 'VGD-2H', 24,
            shade(ARMOR, 1.25), bridge=False)
    # fore tube: darker steel + heat tint toward the muzzle
    m.d.rectangle([su1, y0, x1, y1], fill=STEEL_DK)
    m.o.rectangle([su1, y0, x1, y1], fill=(AO_BASE - 10, 110, 210))
    hx0 = int(pu(-6.20))
    hw = int(x1 - hx0)
    if hw > 0:
        heat = Image.new('RGB', (hw, y1 - y0), (74, 52, 50))
        grad = Image.new('L', (hw, 1), 0)
        for gx in range(hw):
            grad.putpixel((gx, 0), int(70 * (gx / max(1, hw - 1)) ** 1.6))
        m.dif.paste(heat, (hx0, y0), grad.resize((hw, y1 - y0)))
    # accelerator glow slits on the ±X facets
    for band in (3, 7):
        by0 = y0 + (y1 - y0) * band / 8 + 2
        by1 = y0 + (y1 - y0) * (band + 1) / 8 - 2
        m.e.rectangle([pu(-3.45), by0, pu(-7.40), by1], fill=(30, 80, 92))
    m.e.rectangle([x1 - 7, y0, x1, y1], fill=CYAN)
    m.d.rectangle([x1 - 7, y0, x1, y1], fill=(40, 60, 66))


def paint_cap_ring(m):
    x0, y0, x1, y1 = L.Z_CAP_RING
    fill(m, (x0, y0, x1, y1), dif=(50, 54, 60), ao=AO_BASE - 20, rough=120,
         metal=200)
    midx = (x0 + x1) / 2
    m.e.rectangle([midx - 6, y0, midx + 6, y1], fill=CYAN)
    m.d.rectangle([midx - 6, y0, midx + 6, y1], fill=(46, 70, 76))
    for fx in (0.18, 0.82):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 4, y0, sx + 4, y1], fill=BLACKISH)
        m.o.rectangle([sx - 4, y0, sx + 4, y1], fill=(AO_SEAM, R_STEEL, M_STEEL))


def paint_sleeve(m):
    for (zone, horiz) in ((L.Z_SLEEVE, True), (L.Z_SLEEVE_S, False)):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 12, rough=R_ARMOR,
             metal=M_ARMOR)
        for fx in (0.3, 0.5, 0.7):
            sx = x0 + (x1 - x0) * fx
            m.d.rectangle([sx - 3, y0 + 2, sx + 3, y1 - 2], fill=STEEL_DK)
            m.o.rectangle([sx - 3, y0 + 2, sx + 3, y1 - 2],
                          fill=(AO_SEAM, R_STEEL, M_STEEL))
        bolts(m, [(x0 + 10, (y0 + y1) / 2), (x1 - 10, (y0 + y1) / 2)],
              base=ARMOR_DK)


def paint_breech(m):
    x0, y0, x1, y1 = L.Z_BREECH.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 20, rough=125, metal=200)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, STEEL)
    seam_v(m, (x0 + x1) // 2, y0 + 3, y1 - 3, STEEL)
    bolts(m, [(x0 + 12 + i * ((x1 - x0 - 24) / 5), y0 + 12) for i in range(6)],
          base=STEEL)
    m.d.rectangle([x0 + 14, y1 - 30, x0 + 66, y1 - 14], fill=YELLOW)
    m.d.text((x0 + 17, y1 - 29), 'HV2', font=ImageFont.truetype(FONT, 13),
             fill=BLACKISH)


def paint_brake(m):
    x0, y0, x1, y1 = L.Z_BRAKE.rect
    fill(m, (x0, y0, x1, y1), dif=(58, 62, 68), ao=AO_BASE - 20, rough=115,
         metal=205)
    vent_slots(m, [x0 + 12, y0 + 16, x1 - 12, y1 - 40], 3)
    for i in range(int((x1 - x0) / 16) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 16, y1 - 28), (x0 + i * 16 + 16, y1 - 28),
                     (x0 + i * 16 + 8, y1 - 12), (x0 + i * 16 - 8, y1 - 12)],
                    fill=c)
    cx, cy = (x0 + x1) / 2, y0 + (y1 - y0) * 0.40
    m.d.ellipse([cx - 18, cy - 18, cx + 18, cy + 18], fill=BLACKISH)
    m.o.ellipse([cx - 18, cy - 18, cx + 18, cy + 18], fill=(AO_DEEP - 40, 220, 0))


def paint_tube_cap(m):
    r = L.Z_TUBE_CAP.rect
    fill(m, r, dif=BLACKISH, ao=AO_DEEP, rough=210, metal=60)
    cx, cy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    m.d.ellipse([cx - 15, cy - 15, cx + 15, cy + 15], fill=(12, 12, 14))


# ── secondary turret ─────────────────────────────────────────────────────

def paint_turret2(m):
    # drum wrap: facet panels + vision slits + team band ring
    x0, y0, x1, y1 = L.Z_T2_WRAP
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 6)
    n = 10
    for i in range(n):
        sx = x0 + (x1 - x0) * i / n
        seam_v(m, int(sx), y0 + 2, y1 - 2, ARMOR)
        if i % 2 == 0:
            m.d.rectangle([sx + 8, y0 + 14, sx + (x1 - x0) / n - 8, y0 + 24],
                          fill=GLASS)
            m.o.rectangle([sx + 8, y0 + 14, sx + (x1 - x0) / n - 8, y0 + 24],
                          fill=(AO_BASE, R_GLASS, M_GLASS))
    # painted team band ring low on the drum
    m.t.rectangle([x0, y1 - 26, x1, y1 - 12], fill=(255, 0, 0))
    m.d.rectangle([x0, y1 - 26, x1, y1 - 12], fill=TEAMGREY)
    bolts(m, [(x0 + (x1 - x0) * (i + 0.5) / n, y0 + 36) for i in range(n)],
          base=ARMOR)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 30)
    # roof
    x0, y0, x1, y1 = L.Z_T2_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for a in np.linspace(0, 2 * np.pi, 10, endpoint=False):
        m.d.line([(cx + np.cos(a) * 24, cy + np.sin(a) * 24),
                  (cx + np.cos(a) * 86, cy + np.sin(a) * 86)],
                 fill=shade(ARMOR, 0.6), width=2)
    m.d.ellipse([cx - 26, cy - 26, cx + 26, cy + 26], fill=ARMOR_DK,
                outline=shade(ARMOR, 0.5), width=2)
    bolts(m, [(cx + np.cos(a) * 70, cy + np.sin(a) * 70)
              for a in np.linspace(0.3, 2 * np.pi + 0.3, 10, endpoint=False)],
          base=ARMOR)


def paint_barrel2(m):
    x0, y0, x1, y1 = L.Z_B2_WRAP
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 12, rough=118,
         metal=205)
    # collar ring + slim glow line
    m.d.rectangle([x0 + 30, y0, x0 + 44, y1], fill=(50, 54, 60))
    m.e.rectangle([x0 + 34, y0, x0 + 40, y1], fill=(40, 130, 148))
    m.e.rectangle([x1 - 5, y0, x1, y1], fill=(70, 180, 200))
    m.d.rectangle([x1 - 5, y0, x1, y1], fill=(40, 60, 66))
    # mantlet / roof-sensor cell
    x0, y0, x1, y1 = L.Z_B2_CELL.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 10)
    bolts(m, [(x0 + 12, y0 + 12), (x1 - 12, y0 + 12), (x0 + 12, y1 - 12),
              (x1 - 12, y1 - 12)], base=ARMOR_DK)
    m.d.rectangle([x0 + 20, (y0 + y1) / 2 - 8, x1 - 20, (y0 + y1) / 2 + 8],
                  fill=GLASS)
    m.e.ellipse([(x0 + x1) / 2 - 4, (y0 + y1) / 2 - 4,
                 (x0 + x1) / 2 + 4, (y0 + y1) / 2 + 4], fill=(86, 200, 220))


# ── deck fittings ────────────────────────────────────────────────────────

def paint_details(m):
    # hatch
    x0, y0, x1, y1 = L.Z_HATCH.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    m.d.ellipse([x0 + 10, y0 + 10, x1 - 10, y1 - 10], fill=ARMOR,
                outline=shade(ARMOR_DK, 0.55), width=2)
    bolts(m, [((x0 + x1) / 2 + np.cos(a) * ((x1 - x0) / 2 - 14),
               (y0 + y1) / 2 + np.sin(a) * ((y1 - y0) / 2 - 14))
              for a in np.linspace(0, 2 * np.pi, 10, endpoint=False)],
          base=ARMOR)
    m.d.rectangle([(x0 + x1) / 2 - 15, (y0 + y1) / 2 - 4,
                   (x0 + x1) / 2 + 15, (y0 + y1) / 2 + 4], fill=STEEL_DK)
    # engine-deck grille (big twin intake banks)
    x0, y0, x1, y1 = L.Z_INTAKE.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 25)
    midx = (x0 + x1) // 2
    for gb in ([x0 + 10, y0 + 12, midx - 8, y1 - 12],
               [midx + 8, y0 + 12, x1 - 10, y1 - 12]):
        m.d.rectangle(gb, fill=STEEL_DK)
        vent_slots(m, [gb[0] + 4, gb[1] + 4, gb[2] - 4, gb[3] - 4], 7,
                   glow=(70, 26, 8))
    bolts(m, [(x0 + 8, y0 + 8), (x1 - 8, y0 + 8), (x0 + 8, y1 - 8),
              (x1 - 8, y1 - 8)], base=STEEL)
    # exhaust stack sides: heat-stained steel + clamp rings
    x0, y0, x1, y1 = L.Z_EXHAUST.rect
    fill(m, (x0, y0, x1, y1), dif=(60, 56, 54), ao=AO_BASE - 30, rough=190,
         metal=160)
    heat = Image.new('RGB', (x1 - x0, (y1 - y0) // 3), (86, 58, 48))
    grad = Image.new('L', (1, (y1 - y0) // 3), 0)
    for gy in range((y1 - y0) // 3):
        grad.putpixel((0, gy), int(110 * (1 - gy / max(1, (y1 - y0) // 3 - 1))))
    m.dif.paste(heat, (x0, y0), grad.resize((x1 - x0, (y1 - y0) // 3)))
    for fy in (0.30, 0.62):
        sy = y0 + (y1 - y0) * fy
        m.d.rectangle([x0 + 2, sy - 3, x1 - 2, sy + 3], fill=STEEL_DK)
        m.o.rectangle([x0 + 2, sy - 3, x1 - 2, sy + 3],
                      fill=(AO_SEAM, R_STEEL, M_STEEL))
    # stack top: grated vent + heat glow
    x0, y0, x1, y1 = L.Z_STACK_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=BLACKISH, ao=AO_DEEP, rough=205, metal=80)
    m.d.ellipse([x0 + 14, y0 + 14, x1 - 14, y1 - 14], fill=(16, 15, 15))
    m.e.ellipse([x0 + 20, y0 + 20, x1 - 20, y1 - 20], fill=(150, 52, 14))
    for fy in (0.35, 0.5, 0.65):
        gy = y0 + (y1 - y0) * fy
        m.d.line([(x0 + 16, gy), (x1 - 16, gy)], fill=(40, 40, 42), width=3)
    # sensor bar: black visor + cyan core
    x0, y0, x1, y1 = L.Z_SENSOR.rect
    fill(m, (x0, y0, x1, y1), dif=GLASS, ao=AO_BASE, rough=R_GLASS,
         metal=M_GLASS)
    midy = (y0 + y1) / 2
    m.e.rectangle([x0 + 8, midy - 2, x1 - 8, midy + 2], fill=CYAN)
    for fx in (0.2, 0.5, 0.8):
        lx = x0 + (x1 - x0) * fx
        m.e.ellipse([lx - 3, midy - 9, lx + 3, midy - 3], fill=(120, 200, 220))
    # stowage: strapped crates + tarp
    x0, y0, x1, y1 = L.Z_STOW.rect
    fill(m, (x0, y0, x1, y1), dif=shade(LOWER, 1.08), ao=AO_BASE - 15)
    m.d.rounded_rectangle([x0 + 10, y0 + 14, x1 - 10, y1 - 12], 10,
                          fill=(84, 78, 66))
    m.o.rectangle([x0 + 10, y0 + 14, x1 - 10, y1 - 12],
                  fill=(AO_BASE - 30, 200, 5))
    for fx in (0.25, 0.5, 0.75):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 3, y0 + 10, sx + 3, y1 - 8], fill=STEEL_DK)
    seam_h(m, x0 + 8, x1 - 8, (y0 + y1) // 2, (84, 78, 66), hi=False)
    # fuel drum wrap: ribs + hazard band + stencil
    x0, y0, x1, y1 = L.Z_DRUM
    fill(m, (x0, y0, x1, y1), dif=(66, 70, 74), ao=AO_BASE - 12, rough=150,
         metal=170)
    for fy in (0.22, 0.5, 0.78):
        sy = y0 + (y1 - y0) * fy
        m.d.rectangle([x0, sy - 3, x1, sy + 3], fill=shade((66, 70, 74), 0.7))
        m.o.rectangle([x0, sy - 3, x1, sy + 3], fill=(AO_SEAM, R_STEEL, M_STEEL))
    m.d.rectangle([x0, y0 + 6, x1, y0 + 16], fill=YELLOW)
    stencil(m, (x0 + 12, y0 + (y1 - y0) * 0.58), 'FUEL', 16, shade(ARMOR, 1.3),
            bridge=False)
    # drum cap
    r = L.Z_DRUM_CAP.rect
    fill(m, r, dif=(66, 70, 74), ao=AO_BASE - 10, rough=150, metal=170)
    ccx, ccy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    m.d.ellipse([ccx - 12, ccy - 12, ccx + 12, ccy + 12], fill=STEEL_DK)
    bolts(m, [(ccx + np.cos(a) * 34, ccy + np.sin(a) * 34)
              for a in np.linspace(0.2, 2 * np.pi + 0.2, 6, endpoint=False)],
          base=(66, 70, 74))
    # spare track links: tread blocks
    x0, y0, x1, y1 = L.Z_SPARE.rect
    fill(m, (x0, y0, x1, y1), dif=TRACK_MET, ao=AO_BASE - 25, rough=R_RUBBER,
         metal=M_TRACK)
    for i in range(4):
        lx = x0 + (x1 - x0) * i / 4
        m.d.line([(lx, y0), (lx, y1)], fill=BLACKISH, width=3)
        m.d.rectangle([lx + (x1 - x0) / 8 - 6, y0 + 6,
                       lx + (x1 - x0) / 8 + 6, y1 - 6], fill=RUBBER)
    # antenna base: steel + status light
    x0, y0, x1, y1 = L.Z_ANT.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 15, rough=140,
         metal=190)
    seam_h(m, x0 + 4, x1 - 4, y0 + (y1 - y0) // 3, STEEL_DK, hi=False)
    m.e.ellipse([(x0 + x1) / 2 - 4, y0 + 10, (x0 + x1) / 2 + 4, y0 + 18],
                fill=(190, 60, 40))
    # sponson sides: bolted plates
    x0, y0, x1, y1 = L.Z_SPONSON.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 8)
    seam_h(m, x0 + 4, x1 - 4, (y0 + y1) // 2 + 14, ARMOR_DK)
    for fx in (0.33, 0.66):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 3, y1 - 3, ARMOR_DK)
    bolts(m, [(x0 + 14 + i * ((x1 - x0 - 28) / 6), y0 + 10) for i in range(7)],
          base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 30)
    # sponson top: turret2 ring + tread strips
    zone = L.Z_SPONSON_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    cu, cv = zone.uv((L.TURRET2_OFF[0], 0, L.TURRET2_OFF[2]))
    scx, scy = cu * W, cv * W
    ring = 0.90
    rx = abs(zone.uv((L.TURRET2_OFF[0] + ring, 0, 0))[0] - zone.uv(
        (L.TURRET2_OFF[0], 0, 0))[0]) * W
    ry = abs(zone.uv((0, 0, L.TURRET2_OFF[2] + ring))[1] - cv) * W
    m.d.ellipse([scx - rx, scy - ry, scx + rx, scy + ry], fill=STEEL_DK,
                outline=shade(STEEL_DK, 0.6), width=3)
    m.o.ellipse([scx - rx, scy - ry, scx + rx, scy + ry],
                fill=(AO_DEEP + 20, R_STEEL, M_STEEL))
    for i in range(12):
        a = 2 * np.pi * i / 12
        bolts(m, [(scx + np.cos(a) * (rx - 5), scy + np.sin(a) * (ry - 4))],
              r=2, base=STEEL)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 25)
    # mud flaps: rubber with worn chevron
    x0, y0, x1, y1 = L.Z_MUDFLAP.rect
    fill(m, (x0, y0, x1, y1), dif=RUBBER, ao=AO_BASE - 35, rough=215, metal=20)
    for fx in (0.25, 0.5, 0.75):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 2, y0 + 4, sx + 2, y1 - 4], fill=(28, 30, 33))
    for i in range(int((x1 - x0) / 20) + 1):
        c = (150, 122, 40) if i % 2 == 0 else (30, 31, 34)
        m.d.polygon([(x0 + i * 20, y1 - 22), (x0 + i * 20 + 20, y1 - 22),
                     (x0 + i * 20 + 10, y1 - 6), (x0 + i * 20 - 10, y1 - 6)],
                    fill=c)
    # tow cable / trim strips: braided steel
    x0, y0, x1, y1 = L.Z_TRIM.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 20, rough=170,
         metal=185)
    for gx in range(x0, x1, 8):
        m.d.line([(gx, y0 + 2), (gx + 6, y1 - 2)], fill=(44, 46, 50), width=1)
    for fx in (0.04, 0.96):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 8, y0 + 2, sx + 8, y1 - 2], fill=STEEL)
        m.o.rectangle([sx - 8, y0 + 2, sx + 8, y1 - 2],
                      fill=(AO_SEAM, R_STEEL, M_STEEL))
    # engine deck sides: louvres
    x0, y0, x1, y1 = L.Z_ENGDECK.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 10)
    vent_slots(m, [x0 + 14, y0 + 10, x1 - 14, y1 - 10], 3)
    # sensor pod: glass front + housing
    x0, y0, x1, y1 = L.Z_POD.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    m.d.rectangle([x0 + 12, y0 + 16, x1 - 12, y1 - 34], fill=GLASS)
    m.o.rectangle([x0 + 12, y0 + 16, x1 - 12, y1 - 34],
                  fill=(AO_BASE, R_GLASS, M_GLASS))
    m.e.ellipse([(x0 + x1) / 2 - 5, (y0 + y1) / 2 - 12,
                 (x0 + x1) / 2 + 5, (y0 + y1) / 2 - 2], fill=(170, 60, 50))
    # sight drum wrap + top
    x0, y0, x1, y1 = L.Z_SIGHT
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 10)
    m.d.rectangle([x0, y0 + 12, x1, y0 + 30], fill=GLASS)
    m.o.rectangle([x0, y0 + 12, x1, y0 + 30], fill=(AO_BASE, R_GLASS, M_GLASS))
    m.e.rectangle([x0 + 2, y0 + 16, x0 + (x1 - x0) // 3, y0 + 26],
                  fill=(60, 160, 180))
    r = L.Z_SIGHT_TOP.rect
    fill(m, r, dif=ARMOR_DK)
    bolts(m, [((r[0] + r[2]) / 2 + np.cos(a) * 22,
               (r[1] + r[3]) / 2 + np.sin(a) * 22)
              for a in np.linspace(0, 2 * np.pi, 6, endpoint=False)],
          base=ARMOR_DK)
    # bustle rack: slats + tarp
    x0, y0, x1, y1 = L.Z_BUSTLE.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    vent_slots(m, [x0 + 8, y0 + 10, x1 - 8, y0 + 34], 2)
    m.d.rounded_rectangle([x0 + 16, y0 + 40, x1 - 16, y1 - 10], 9,
                          fill=(84, 78, 66))
    m.o.rectangle([x0 + 16, y0 + 40, x1 - 16, y1 - 10],
                  fill=(AO_BASE - 30, 200, 5))
    for fx in (0.28, 0.55, 0.8):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 2, y0 + 40, sx + 2, y1 - 10], fill=STEEL_DK)
    # smoke launchers: 3 tubes each bank
    x0, y0, x1, y1 = L.Z_SMOKE.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    for fx in (0.25, 0.5, 0.75):
        scx = x0 + (x1 - x0) * fx
        scy = (y0 + y1) / 2
        m.d.ellipse([scx - 10, scy - 10, scx + 10, scy + 10], fill=BLACKISH)
        m.d.ellipse([scx - 7, scy - 7, scx + 7, scy + 7], fill=STEEL_DK)
        m.o.ellipse([scx - 10, scy - 10, scx + 10, scy + 10],
                    fill=(AO_DEEP, R_STEEL, M_STEEL))
    # hub wrap + cap
    x0, y0, x1, y1 = L.Z_HUB
    fill(m, (x0, y0, x1, y1), dif=TRACK_MET, ao=AO_BASE - 30, rough=130,
         metal=M_TRACK)
    for i in range(8):
        sx = x0 + (x1 - x0) * i / 8
        m.d.line([(sx, y0), (sx, y1)], fill=BLACKISH, width=2)
    r = L.Z_HUB_CAP.rect
    fill(m, r, dif=TRACK_MET, ao=AO_BASE - 20, rough=130, metal=M_TRACK)
    hcx, hcy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    rr = (r[2] - r[0]) / 2 - 5
    for a in np.linspace(0, 2 * np.pi, 8, endpoint=False):
        m.d.line([(hcx + np.cos(a) * rr * 0.25, hcy + np.sin(a) * rr * 0.25),
                  (hcx + np.cos(a) * rr * 0.9, hcy + np.sin(a) * rr * 0.9)],
                 fill=shade(TRACK_MET, 0.6), width=5)
    m.d.ellipse([hcx - 10, hcy - 10, hcx + 10, hcy + 10], fill=STEEL_DK)
    bolts(m, [(hcx + np.cos(a) * 15, hcy + np.sin(a) * 15)
              for a in np.linspace(0.4, 2 * np.pi + 0.4, 6, endpoint=False)],
          base=TRACK_MET)


# ── assembly ─────────────────────────────────────────────────────────────

def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_dark(m)
    paint_hull_top(m)
    paint_glacis(m)
    paint_hull_rear(m)
    paint_hull_side(m)
    paint_tracks_side(m)
    paint_track_wrap(m)
    paint_fender(m)
    paint_turret_top(m)
    paint_turret_side(m)
    paint_turret_front(m)
    paint_turret_rear(m)
    paint_barrel(m)
    paint_cap_ring(m)
    paint_sleeve(m)
    paint_breech(m)
    paint_brake(m)
    paint_tube_cap(m)
    paint_turret2(m)
    paint_barrel2(m)
    paint_details(m)

    # ── weathering (heavier than the line tank: this thing lives forward) ──
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=47)
    wx.crevice_grime(m.dif, 0.52)
    wx.mud_band(L.Z_TRACK_SIDE.rect, 1.0, fade='down')
    tx0, ty0, tx1, ty1 = L.Z_TRACK_SIDE.rect
    skirt_bot = int(L.Z_TRACK_SIDE.uv((0, 1.16, 0))[1] * W)
    wx.plate_bottom_rust((tx0, ty0, tx1, skirt_bot), n=14, band=9,
                         strength=0.75)
    for i in range(11):
        sx = tx0 + (tx1 - tx0) * (i + 0.5) / 11.0
        wx.rust_streak(sx, skirt_bot - 4, 18, strength=0.4)
    wx.mud_band(L.Z_TRACK_WRAP, 0.6, fade=None)
    wx.mud_band(L.Z_HUB, 0.45, fade=None)
    wx.mud_band(L.Z_HUB_CAP.rect, 0.45, fade=None)
    wx.mud_band(L.Z_FENDER.rect, 0.22, fade=None, spatter=False)
    wx.mud_band(L.Z_MUDFLAP.rect, 0.85, fade='down')
    wx.mud_band(L.Z_HULL_SIDE.rect, 0.75, fade='down', dust=0.4)
    wx.mud_band(L.Z_GLACIS.rect, 0.65, fade='down', dust=0.35)
    gx0, gy0, gx1, gy1 = L.Z_GLACIS.rect
    for fx in (0.13, 0.5, 0.87):
        wx.rust_streak(gx0 + (gx1 - gx0) * fx, gy0 + (gy1 - gy0) * 0.58,
                       40, width=2.6, strength=0.4)
    wx.mud_band(L.Z_HULL_REAR.rect, 0.5, fade='down', dust=0.25)
    wx.mud_band(L.Z_SPONSON.rect, 0.4, fade='down', spatter=False)
    wx.mud_band(L.Z_SPONSON_TOP.rect, 0.2, fade=None, spatter=False)
    wx.mud_band(L.Z_HULL_TOP.rect, 0.2, fade=None, spatter=False)
    wx.mud_band(L.Z_TURRET_TOP.rect, 0.18, fade=None, spatter=False)
    wx.mud_band(L.Z_TURRET_SIDE.rect, 0.24, fade='down', spatter=False)
    wx.mud_band(L.Z_TURRET_FRONT.rect, 0.24, fade='down', spatter=False)
    wx.mud_band(L.Z_TURRET_REAR.rect, 0.26, fade='down', spatter=False)
    wx.mud_band(L.Z_BUSTLE.rect, 0.3, fade=None, spatter=False)
    wx.mud_band((L.Z_T2_WRAP[0], L.Z_T2_WRAP[1], L.Z_T2_WRAP[2],
                 L.Z_T2_WRAP[3]), 0.3, fade='down', spatter=False)
    for r in (L.Z_HULL_SIDE.rect, L.Z_GLACIS.rect, L.Z_HULL_REAR.rect,
              L.Z_TRACK_SIDE.rect, L.Z_SPONSON.rect):
        wx.plate_bottom_rust(r, n=8, strength=0.6)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.62)
    wx.oily(L.Z_HUB_CAP.rect, 0.35)
    wx.oily(L.Z_BREECH.rect, 0.25)
    bx0, by0, bx1, by1 = L.Z_BARREL_WRAP
    wx.soot_patch((bx0 + (bx1 - bx0) * 0.74, by0, bx1, by1), 0.5, fade='right')
    wx.soot_patch(L.Z_BRAKE.rect, 0.35)
    b2 = L.Z_B2_WRAP
    wx.soot_patch((b2[0] + (b2[2] - b2[0]) * 0.7, b2[1], b2[2], b2[3]), 0.45,
                  fade='right')
    wx.soot_patch(L.Z_EXHAUST.rect, 0.7)
    wx.soot_patch(L.Z_STACK_TOP.rect, 0.85)
    # rust streaks running off the drum ribs
    dx0, dy0, dx1, dy1 = L.Z_DRUM
    for fx in (0.2, 0.55, 0.85):
        wx.rust_streak(dx0 + (dx1 - dx0) * fx, dy0 + (dy1 - dy0) * 0.3,
                       26, strength=0.45)
    wx.apply(m)

    # ── void pass: wheel-well gaps are EMPTY SPACE ──
    zone = L.Z_TRACK_SIDE

    def vpy(wy):
        return zone.uv((0, wy, 0))[1] * W

    def vpz(wz):
        return zone.uv((0, 0, wz))[0] * W

    tx0v, _, tx1v, _ = zone.rect
    m.d.rectangle([tx0v, vpy(1.32), tx1v, vpy(0.08)], fill=(11, 12, 14))
    m.o.rectangle([tx0v, vpy(1.32), tx1v, vpy(0.08)], fill=(28, 240, 0))
    for wz in WHEELS:
        cx, cy = vpz(wz), vpy(WHEEL_Y)
        r = vpz(wz + WHEEL_R) - vpz(wz)
        draw_wheel(m, cx, cy, r, weathered=True)
        m.d.arc([cx - r, cy - r, cx + r, cy + r], 30, 150,
                fill=(74, 62, 48), width=3)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()

    def hpy(wy):
        return zone.uv((0, wy, 0))[1] * W

    def hpz(wz):
        return zone.uv((0, 0, wz))[0] * W

    tx0, ty0, tx1, ty1 = zone.rect
    hm.rect((tx0, hpy(1.32), tx1, hpy(0.08)), -3.2)   # well = cliff recess
    for wz in WHEELS:
        cx, cy = hpz(wz), hpy(WHEEL_Y)
        r = hpz(wz + WHEEL_R) - hpz(wz)
        hm.disc(cx, cy, r, 0.3)
        hm.disc(cx, cy, r * 0.68, 0.5)
        hm.disc(cx, cy, 5, 0.68)
    hm.rect((tx0, hpy(2.08), tx1, hpy(1.16)), 0.22)   # skirt proud
    hm.rect((tx0, hpy(2.42), tx1, hpy(2.22)), 0.3)    # fender edge band
    wx0, wy0, wx1, wy1 = L.Z_TRACK_WRAP
    for i in range(80):
        lx = wx0 + (wx1 - wx0) * i / 80
        lw = (wx1 - wx0) / 80
        hm.rect((lx + 1.5, wy0, lx + lw - 1.5, wy1), 0.5)
        hm.rect((lx + lw * 0.35, wy0 + 2, lx + lw * 0.65, wy1 - 2), 0.85)
    r = L.Z_HUB_CAP.rect
    hcx, hcy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    hrr = (r[2] - r[0]) / 2 - 5
    for a in np.linspace(0, 2 * np.pi, 8, endpoint=False):
        hm.line((hcx + np.cos(a) * hrr * 0.25, hcy + np.sin(a) * hrr * 0.25),
                (hcx + np.cos(a) * hrr * 0.9, hcy + np.sin(a) * hrr * 0.9),
                0.5, width=5)
    hm.disc(hcx, hcy, 10, 0.7)
    fx0, fy0, fx1, fy1 = L.Z_FENDER.rect
    for gx in range(fx0 + 6, fx1 - 4, 14):
        for gy in range(fy0 + 6, fy1 - 4, 12):
            off = 4 if ((gy - fy0) // 12) % 2 else 0
            hm.line((gx + off, gy), (gx + off + 5, gy + 4), 0.3, width=2)
    cx0, cy0, cx1, cy1 = L.Z_CAP_RING
    hm.rect(((cx0 + cx1) / 2 - 6, cy0, (cx0 + cx1) / 2 + 6, cy1), 0.5)
    # engine grille recess + stack top hollow
    ix0, iy0, ix1, iy1 = L.Z_INTAKE.rect
    imid = (ix0 + ix1) // 2
    hm.rect((ix0 + 10, iy0 + 12, imid - 8, iy1 - 12), -0.8)
    hm.rect((imid + 8, iy0 + 12, ix1 - 10, iy1 - 12), -0.8)
    sx0, sy0, sx1, sy1 = L.Z_STACK_TOP.rect
    hm.disc((sx0 + sx1) / 2, (sy0 + sy1) / 2, (sx1 - sx0) / 2 - 16, -1.2)
    # drum ribs proud
    dx0, dy0, dx1, dy1 = L.Z_DRUM
    for fy in (0.22, 0.5, 0.78):
        sy = dy0 + (dy1 - dy0) * fy
        hm.rect((dx0, sy - 3, dx1, sy + 3), 0.4)
    hm.crevices_from(m.dif, 0.6)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=5.0).save('out/fable_heavy_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save('out/fable_heavy_diffuse.png')
    m.orm.save('out/fable_heavy_orm.png')
    m.emi.save('out/fable_heavy_emissive.png')
    m.tea.save('out/fable_heavy_team.png')
    print('[paint_heavy] full 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
