"""paint_ms_artillery_s1 — 1024² PBR set for ms_artillery_s1.

Light wheeled mortar carrier of the blue-grey army: armor-grey truck hull
with a dark lower band, glass half-cab, timber-decked bed, gunmetal mortar
tube on a steel turntable, olive ammo crates, canvas tarp roll. Team mask
(R channel): cab door panel + cab roof ID square (+ rear ID chip) — never
baked into diffuse. Emissive: headlights only, warm. Weathering: mud on
running gear, dust film, plate-bottom rust, soot at exhaust and muzzle.
"""
from __future__ import annotations
import numpy as np

import ms_artillery_s1_layout as L     # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, LOWER, STEEL, STEEL_DK,
                   RUBBER, TRACK_MET, GLASS, YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_RUBBER, R_GLASS,
                   M_ARMOR, M_STEEL, M_TRACK, M_GLASS, RNG)
import paintlib as PL

W = 1024
CANVAS = (96, 88, 70)
CRATE_OD = (86, 92, 66)                # olive-drab ammo crates
GUNMETAL = (58, 62, 68)
PLANK = (98, 86, 66)                   # weathered timber bed


def paint_top(m):
    z = L.S_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    # hood panel seams
    for wz in (-1.9, -1.4):
        _, v = z.uv((0, 0, wz))
        seam_h(m, x0 + 6, x1 - 6, int(v * W), ARMOR)
    # cab roof band (slightly lighter) + team ID square
    _, rv0 = z.uv((0, 0, -1.18))
    _, rv1 = z.uv((0, 0, -0.30))
    m.d.rectangle([x0 + 4, rv0 * W, x1 - 4, rv1 * W], fill=jit(ARMOR_LT, 2))
    cu, _ = z.uv((0, 0, 0))
    cx = cu * W
    cy = (rv0 + rv1) / 2 * W
    PL.team_panel(m, (cx - 26, cy - 26, cx + 26, cy + 26),
                  outline=shade(ARMOR_DK, 0.6))
    seam_h(m, x0 + 4, x1 - 4, int(rv1 * W), ARMOR)
    # bed deck: timber planks between the rails
    _, bv0 = z.uv((0, 0, -0.18))
    u0, _ = z.uv((-L.RAIL_X + 0.07, 0, 0))
    u1, _ = z.uv((L.RAIL_X - 0.07, 0, 0))
    bed = [min(u0, u1) * W, bv0 * W, max(u0, u1) * W, y1 - 4]
    m.d.rectangle(bed, fill=PLANK)
    m.o.rectangle(bed, fill=(AO_BASE - 15, 200, 10))
    nplank = 7
    for i in range(1, nplank):
        px = bed[0] + (bed[2] - bed[0]) * i / nplank
        m.d.line([(px, bed[1]), (px, bed[3])], fill=shade(PLANK, 0.7), width=2)
    for fy in (0.25, 0.55, 0.85):
        py = bed[1] + (bed[3] - bed[1]) * fy
        m.d.line([(bed[0], py), (bed[2], py)], fill=shade(PLANK, 0.6), width=3)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 45)


def paint_side(m):
    z = L.S_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    # dark lower band (chassis/rocker)
    _, wv = z.uv((0, 0.62, 0))
    wy = int(wv * W)
    m.d.rectangle([x0, wy, x1, y1], fill=LOWER)
    m.o.rectangle([x0, wy, x1, y1], fill=(AO_BASE - 30, R_ARMOR, M_ARMOR))
    seam_h(m, x0, x1, wy, ARMOR)
    # panel seams
    for wz in (-1.62, -0.30, 0.6, 1.4):
        u, _ = z.uv((0, 0, wz))
        seam_v(m, int(u * W), y0 + 3, wy, ARMOR)
    # cab side window (glass, not emissive)
    gu0, gv0 = z.uv((0, 1.46, -1.05))
    gu1, gv1 = z.uv((0, 1.10, -0.42))
    PL.glass_rect(m, PL.nbox(gu0 * W, gv0 * W, gu1 * W, gv1 * W),
                  outline=shade(ARMOR_DK, 0.6))
    # team door panel below the window
    pu0, pv0 = z.uv((0, 1.04, -1.05))
    pu1, pv1 = z.uv((0, 0.68, -0.45))
    PL.team_panel(m, PL.nbox(pu0 * W, pv0 * W, pu1 * W, pv1 * W),
                  outline=shade(ARMOR, 0.5))
    # bed-side plank hint above the rocker on the rear half
    su0, sv0 = z.uv((0, 1.00, 0.05))
    su1, sv1 = z.uv((0, 0.80, 2.20))
    sb = PL.nbox(su0 * W, sv0 * W, su1 * W, sv1 * W)
    m.d.rectangle(sb, fill=jit(ARMOR_DK, 3))
    for fz in (0.5, 1.0, 1.5, 2.0):
        u, _ = z.uv((0, 0, fz))
        m.d.line([(u * W, sb[1]), (u * W, sb[3])], fill=shade(ARMOR_DK, 0.7),
                 width=2)
    bolts(m, [(x0 + 12 + i * ((x1 - x0 - 24) / 9), y0 + 9) for i in range(10)],
          base=ARMOR)
    wear_edges(m, (x0, y0, x1, wy), ARMOR, 45)


def paint_front(m):
    z = L.S_FRONT
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    # radiator grille slats
    vent_slots(m, [x0 + 24, y0 + 42, x1 - 24, y1 - 26], 6)
    # headlight pair (the only emissive)
    for fx in (0.22, 0.78):
        lx = x0 + (x1 - x0) * fx
        ly = y0 + (y1 - y0) * 0.26
        PL.headlight(m, (lx - 9, ly - 6, lx + 9, ly + 6), on=True)
    bolts(m, [(x0 + 10 + i * ((x1 - x0 - 20) / 3), y1 - 9) for i in range(4)],
          base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 30)


def paint_rear(m):
    z = L.S_REAR
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    PL.hazard_band(m, (x0 + 2, y1 - 16, x1 - 2, y1 - 2))
    # rear team ID chip + dead taillights
    m.t.rectangle([x1 - 36, y0 + 8, x1 - 10, y0 + 32], fill=(255, 0, 0))
    m.d.rectangle([x1 - 36, y0 + 8, x1 - 10, y0 + 32], fill=TEAMGREY)
    PL.taillight(m, (x0 + 10, y0 + 12, x0 + 32, y0 + 20), on=False)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 28)


def paint_windscreen(m):
    z = L.S_WINDS
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    PL.glass_rect(m, (x0 + 10, y0 + 12, x1 - 10, y1 - 16),
                  outline=shade(ARMOR_DK, 0.55))
    # centre mullion
    m.d.rectangle([(x0 + x1) / 2 - 3, y0 + 12, (x0 + x1) / 2 + 3, y1 - 16],
                  fill=ARMOR_DK)


def paint_running_gear(m):
    PL.wheel_cell(m, L.S_WHEEL)
    PL.hub_cell(m, L.S_HUB.rect, spokes=6, lugs=5)


def paint_bed_kit(m):
    # rails / tailgate fittings: painted steel
    r = L.S_FIT.rect
    fill(m, r, dif=jit(ARMOR_DK, 2), ao=AO_BASE - 10, rough=R_STEEL,
         metal=M_STEEL)
    bolts(m, [(r[0] + 14 + i * ((r[2] - r[0] - 28) / 6), (r[1] + r[3]) / 2)
              for i in range(7)], base=ARMOR_DK)
    # ammo crates: olive timber, stencil band, rope handles
    z = L.S_CRATE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=CRATE_OD, ao=AO_BASE - 15, rough=205, metal=5)
    for fy in (0.32, 0.68):
        m.d.line([(x0 + 4, y0 + (y1 - y0) * fy), (x1 - 4, y0 + (y1 - y0) * fy)],
                 fill=shade(CRATE_OD, 0.7), width=3)
    band = [x0 + 10, y0 + (y1 - y0) * 0.42, x1 - 10, y0 + (y1 - y0) * 0.58]
    m.d.rectangle(band, fill=shade(CRATE_OD, 1.25))
    for i in range(4):
        sx = band[0] + 12 + i * 26
        m.d.rectangle([sx, band[1] + 4, sx + 12, band[3] - 4],
                      fill=shade(CRATE_OD, 0.5))
    wear_edges(m, (x0, y0, x1, y1), CRATE_OD, 20)
    # tarp roll: strapped canvas
    z = L.S_TARP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=CANVAS, ao=AO_BASE - 20, rough=205, metal=5)
    for fx in (0.25, 0.5, 0.75):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 3, y0 + 3, sx + 3, y1 - 3], fill=STEEL_DK)
        m.o.rectangle([sx - 3, y0 + 3, sx + 3, y1 - 3],
                      fill=(AO_SEAM, R_STEEL, M_STEEL))
    wear_edges(m, (x0, y0, x1, y1), CANVAS, 16)


def paint_mortar(m):
    # tube wrap: gunmetal with reinforcing bands + heat scorch near muzzle
    x0, y0, x1, y1 = L.S_TUBE
    fill(m, (x0, y0, x1, y1), dif=GUNMETAL, ao=AO_BASE - 8, rough=R_STEEL - 15,
         metal=M_STEEL + 30)
    for fx in (0.30, 0.55, 0.86):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 4, y0, sx + 4, y1], fill=shade(GUNMETAL, 0.72))
    # trim wrap: mechanical steel
    fill(m, L.S_TRIM, dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)
    # breech housing
    z = L.S_BREECH
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(GUNMETAL, 1.1), ao=AO_BASE - 10,
         rough=R_STEEL, metal=M_STEEL + 20)
    bolts(m, [(x0 + 12, y0 + 12), (x1 - 12, y0 + 12), (x0 + 12, y1 - 12),
              (x1 - 12, y1 - 12)], base=GUNMETAL)
    # turntable ring wrap: steel with bolt ring
    x0, y0, x1, y1 = L.S_RING_W
    fill(m, (x0, y0, x1, y1), dif=TRACK_MET, ao=AO_BASE - 12, rough=R_STEEL,
         metal=M_TRACK)
    bolts(m, [(x0 + 10 + i * ((x1 - x0 - 20) / 7), (y0 + y1) / 2)
              for i in range(8)], r=2, base=TRACK_MET)
    # ring top: radial wear ring
    z = L.S_RING_T
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=jit(TRACK_MET, 3), ao=AO_BASE - 10,
         rough=R_STEEL, metal=M_TRACK)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rr = (x1 - x0) / 2 - 6
    m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                outline=shade(TRACK_MET, 0.7), width=4)
    m.d.ellipse([cx - rr * 0.55, cy - rr * 0.55, cx + rr * 0.55,
                 cy + rr * 0.55], outline=shade(TRACK_MET, 1.2), width=3)
    # baseplate: dark forged steel, cross ribs
    z = L.S_PLATE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 15, rough=R_STEEL + 10,
         metal=M_STEEL)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for a in np.linspace(0, np.pi, 4, endpoint=False):
        dx, dy = np.cos(a) * (x1 - x0) * 0.44, np.sin(a) * (y1 - y0) * 0.44
        m.d.line([(cx - dx, cy - dy), (cx + dx, cy + dy)],
                 fill=shade(STEEL_DK, 1.3), width=4)
    m.d.ellipse([cx - 10, cy - 10, cx + 10, cy + 10], fill=BLACKISH)
    # mount / pedestal
    z = L.S_MOUNT
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 10)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, ARMOR_DK)
    bolts(m, [(x0 + 12, y0 + 14), (x1 - 12, y0 + 14)], base=ARMOR_DK)
    # dark cell (undersides, bores)
    fill(m, L.S_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_top(m)
    paint_side(m)
    paint_front(m)
    paint_rear(m)
    paint_windscreen(m)
    paint_running_gear(m)
    paint_bed_kit(m)
    paint_mortar(m)

    # ── weathering: field truck, muddy running gear, mortar soot ──
    wx = PL.standard_weather(
        m, L,
        ground_rects=(L.S_WHEEL, L.S_HUB.rect),
        side_zones=(L.S_SIDE, L.S_FRONT, L.S_REAR),
        seed=41, mud=0.55, grime=0.55, rust_fraction=0.5)
    for r in (L.S_SIDE.rect, L.S_FRONT.rect, L.S_REAR.rect):
        wx.plate_bottom_rust(r, n=6, strength=0.5)
    wx.oily(L.S_HUB.rect, 0.35)
    # soot: exhaust trim wrap end + muzzle end of the tube wrap
    tx0, ty0, tx1, ty1 = L.S_TUBE
    wx.soot_patch((tx0 + (tx1 - tx0) * 0.7, ty0, tx1, ty1), 0.6)
    wx.mud_band(L.S_TOP.rect, 0.2, fade=None, spatter=False)
    wx.mud_band(L.S_TARP.rect, 0.25, fade=None, spatter=False)

    # ── height → normal map extras ──
    from normals import HeightMap
    hm = HeightMap()
    x0, y0, x1, y1 = L.S_WHEEL
    for i in range(20):
        lx = x0 + (x1 - x0) * i / 20
        lw = (x1 - x0) / 20
        hm.rect((lx + 1, y0 + 2, lx + lw * 0.55, y1 - 2), 0.7)
    # bed plank grooves
    z = L.S_TOP
    _, bv0 = z.uv((0, 0, -0.18))
    u0, _ = z.uv((-L.RAIL_X + 0.07, 0, 0))
    u1, _ = z.uv((L.RAIL_X - 0.07, 0, 0))
    bx0, bx1 = sorted((u0 * W, u1 * W))
    for i in range(1, 7):
        px = bx0 + (bx1 - bx0) * i / 7
        hm.line((px, bv0 * W), (px, z.rect[3] - 4), -0.4, width=2)
    # baseplate ribs stand proud
    r = L.S_PLATE.rect
    cx, cy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    for a in np.linspace(0, np.pi, 4, endpoint=False):
        dx, dy = np.cos(a) * (r[2] - r[0]) * 0.44, np.sin(a) * (r[3] - r[1]) * 0.44
        hm.line((cx - dx, cy - dy), (cx + dx, cy + dy), 0.45, width=4)

    PL.finish(m, L, 'ms_artillery_s1', hm=hm, wx=wx)
    print('[paint_ms_artillery_s1] full 1024 texture set written to out/')


if __name__ == '__main__':
    paint_all()
