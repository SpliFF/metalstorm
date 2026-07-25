"""paint_garrison — 2048² PBR set for ms_garrison.

"Garrison 04" infantry muster compound: weathered concrete pad with
painted formation boxes + lane markings, blast walls with hazard gate
edging and wall-top walkway, corrugated barracks halls with lit window
strips, armory with blast door, watchtower with lit cab, sensor array,
amber perimeter beacons. Military family: same concrete/armor language
as the command nexus, team mask on the gate banner + roof code.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

import garrison_layout as L         # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
P.FONT = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, stencil, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, LOWER, STEEL, STEEL_DK,
                   YELLOW, BLACKISH, TEAMGREY, CYAN, ORANGE,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, RNG)

CONCRETE = (143, 140, 132)
CONCRETE_D = (124, 121, 114)
PANEL = (117, 124, 130)      # corrugated wall panel
ROOF = (84, 90, 97)          # barracks roof sheet
GALV = (160, 164, 169)
AMBER = (255, 176, 60)
WARM = (255, 214, 150)       # lit windows


def ppm(z):
    x0, y0, x1, y1 = z.rect
    (a0, a1), _ = z.win
    return (x1 - x0) / (a1 - a0)


def paint_pad(m):
    z = L.G_PAD
    x0, y0, x1, y1 = z.rect
    k = (x1 - x0) / 20.8                      # px per metre
    cx = x0 + (0 - -10.4) * k
    fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE, rough=R_ARMOR + 22,
         metal=0)

    def X(wx):
        return x0 + (wx + 10.4) * k

    def Z(wz):
        return y0 + (wz + 10.4) * k
    # expansion joints every ~4 m
    for w in np.arange(-8, 9, 4):
        m.d.line([(X(w), y0 + 2), (X(w), y1 - 2)], fill=shade(CONCRETE, 0.85), width=2)
        m.d.line([(x0 + 2, Z(w)), (x1 - 2, Z(w))], fill=shade(CONCRETE, 0.85), width=2)
    # muster yard: painted formation boxes in the central lane (x -2..2)
    for i, fz in enumerate(np.arange(-7.6, -0.4, 1.8)):
        bx0, bz0 = X(-1.9), Z(fz)
        bx1, bz1 = X(1.9), Z(fz + 1.3)
        m.d.rectangle([bx0, bz0, bx1, bz1], outline=(196, 200, 196), width=3)
        f = ImageFont.truetype(P.FONT, 26)
        m.d.text((bx0 + 8, bz0 + 6), f'{i + 1}', font=f, fill=(196, 200, 196))
    # lane arrows from the gate to the yard
    for fz in np.arange(-9.0, -7.6, 0.7):
        ax, az_ = cx, Z(fz)
        m.d.polygon([(ax - 14, az_ + 18), (ax + 14, az_ + 18), (ax, az_ - 6)],
                    fill=(196, 200, 196))
    # roadway edge lines through the gate
    m.d.line([(X(-1.7), Z(-10.3)), (X(-1.7), Z(-8.0))], fill=YELLOW, width=4)
    m.d.line([(X(1.7), Z(-10.3)), (X(1.7), Z(-8.0))], fill=YELLOW, width=4)
    # helibox at the rear-right open corner? no — keep single-purpose: muster
    # kill zone hatching along the inside of the walls (footpath)
    # roof code painted on the pad is wrong — goes on barracks roof instead
    # tower base hazard square
    m.d.rectangle([X(5.6), Z(-7.9), X(8.2), Z(-5.3)], outline=YELLOW, width=4)


def paint_walls(m):
    x0, y0, x1, y1 = L.G_WALL.rect
    fill(m, (x0, y0, x1, y1), dif=CONCRETE_D, ao=AO_BASE - 6,
         rough=R_ARMOR + 24, metal=0)
    # panel seams every ~2 m
    k = (x1 - x0) / 20.8
    for w in np.arange(-8, 9, 2):
        seam_v(m, int(x0 + (w + 10.4) * k), y0 + 3, y1 - 3, CONCRETE_D)
    seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * 0.24), CONCRETE_D)
    # gate hazard edging at centre (both faces of the gate flanks sample here)
    for gx in (x0 + (10.4 - 1.75) * k, x0 + (10.4 + 1.75) * k):
        for i in range(0, 40, 16):
            m.d.rectangle([gx - 5, y0 + 20 + i * 3, gx + 5, y0 + 20 + i * 3 + 24],
                          fill=YELLOW if (i // 16) % 2 == 0 else BLACKISH)
    bolts(m, [(x, y) for x in range(int(x0) + 40, int(x1) - 20, 120)
              for y in (y0 + 30, y1 - 24)], r=4, base=CONCRETE_D)
    # wall-top: narrow walkway strip
    z = L.G_WALLTOP
    fill(m, z.rect, dif=shade(CONCRETE_D, 1.05), ao=AO_BASE - 4,
         rough=R_ARMOR + 18, metal=0)


def paint_barracks(m):
    # side band: corrugated panels + lit window strip + wainscot
    z = L.G_BK_S1
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=PANEL, ao=AO_BASE - 4, rough=R_ARMOR + 10,
         metal=M_ARMOR + 20)
    # corrugation ribs every ~0.45 m (11 m span → px)
    k = (x1 - x0) / 11.0
    for w in np.arange(0, 11.0, 0.45):
        m.d.line([(x0 + w * k, y0 + 4), (x0 + w * k, y1 - 4)],
                 fill=shade(PANEL, 0.90), width=2)
    # wainscot band
    m.d.rectangle([x0, y0 + (y1 - y0) * 0.72, x1, y1], fill=shade(PANEL, 0.8))
    m.o.rectangle([x0, y0 + (y1 - y0) * 0.72, x1, y1],
                  fill=(AO_BASE - 10, R_ARMOR + 16, M_ARMOR))
    # window strip under the eave: lit panes (seeded ~40%)
    wy0, wy1 = y0 + (y1 - y0) * 0.16, y0 + (y1 - y0) * 0.30
    for i, w in enumerate(np.arange(0.7, 10.4, 0.9)):
        wx0, wx1 = x0 + w * k, x0 + (w + 0.55) * k
        lit = RNG.random() < 0.42
        m.d.rectangle([wx0, wy0, wx1, wy1], fill=(30, 38, 44))
        m.o.rectangle([wx0, wy0, wx1, wy1], fill=(AO_BASE - 16, R_GLASS, 0))
        if lit:
            m.e.rectangle([wx0 + 2, wy0 + 2, wx1 - 2, wy1 - 2],
                          fill=shade(WARM, 0.62))
    # personnel door + roll door on the yard side
    dx = x0 + 5.1 * k
    m.d.rectangle([dx, y0 + (y1 - y0) * 0.34, dx + 0.9 * k, y1 - 4],
                  fill=STEEL_DK)
    for gy in np.arange(0.42, 0.95, 0.11):
        m.d.line([(dx + 2, y0 + (y1 - y0) * gy), (dx + 0.9 * k - 2,
                                                  y0 + (y1 - y0) * gy)],
                 fill=shade(STEEL_DK, 1.22), width=2)
    ddx = x0 + 8.2 * k
    m.d.rectangle([ddx, y0 + (y1 - y0) * 0.4, ddx + 0.62 * k, y1 - 4],
                  fill=shade(STEEL_DK, 1.1))
    wear_edges(m, z.rect, PANEL, density=40)
    # end band: gable + team banner + entrance
    z = L.G_BK_E1
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(PANEL, 0.96), ao=AO_BASE - 4,
         rough=R_ARMOR + 10, metal=M_ARMOR + 20)
    k = (x1 - x0) / 6.2
    for w in np.arange(0, 6.2, 0.45):
        m.d.line([(x0 + w * k, y0 + 4), (x0 + w * k, y1 - 4)],
                 fill=shade(PANEL, 0.90), width=2)
    # big end door + team stripe above it
    mid = (x0 + x1) / 2
    m.d.rectangle([mid - 0.9 * k, y0 + (y1 - y0) * 0.36, mid + 0.9 * k, y1 - 4],
                  fill=STEEL_DK)
    m.d.rectangle([mid - 1.4 * k, y0 + (y1 - y0) * 0.20, mid + 1.4 * k,
                   y0 + (y1 - y0) * 0.30], fill=TEAMGREY)
    m.t.rectangle([mid - 1.4 * k, y0 + (y1 - y0) * 0.20, mid + 1.4 * k,
                   y0 + (y1 - y0) * 0.30], fill=(255, 0, 0))
    # roof band (u = x eave→ridge, v = z): sheet seams run along v
    z = L.G_BK_R1
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ROOF, ao=AO_BASE - 2, rough=R_ARMOR + 14,
         metal=M_ARMOR + 30)
    kz = (y1 - y0) / 11.0
    for w in np.arange(0, 11.0, 0.9):
        m.d.line([(x0 + 3, y0 + w * kz), (x1 - 3, y0 + w * kz)],
                 fill=shade(ROOF, 0.86), width=2)
    seam_v(m, int((x0 + x1) / 2), y0 + 3, y1 - 3, ROOF)
    # roof code on the LEFT slope only (u 0..0.5); v-down = +z, so
    # normally-drawn text reads correctly from behind (§11 doctrine)
    stencil(m, (x0 + (x1 - x0) * 0.08, y0 + (y1 - y0) * 0.36), 'GAR-04', 56,
            shade(ROOF, 0.55))
    f = ImageFont.truetype(P.FONT, 56)
    m.t.text((x0 + (x1 - x0) * 0.08, y0 + (y1 - y0) * 0.36), 'GAR-04', font=f,
             fill=(0, 0, 0))
    wear_edges(m, z.rect, ROOF, density=30)


def paint_armory(m):
    z = L.G_ARM_S
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR)
    seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * 0.4), ARMOR_DK)
    # blast door + warning ring
    mid = (x0 + x1) / 2
    m.d.rectangle([mid - 60, y0 + (y1 - y0) * 0.34, mid + 60, y1 - 4],
                  fill=STEEL_DK)
    for i in range(0, 120, 24):
        m.d.rectangle([mid - 60 + i, y1 - 26, mid - 60 + i + 12, y1 - 6],
                      fill=YELLOW if (i // 24) % 2 == 0 else BLACKISH)
    stencil(m, (mid - 58, y0 + 16), 'ARMORY', 30, jit(YELLOW, 6))
    m.e.rectangle([mid - 66, y0 + (y1 - y0) * 0.36, mid - 62,
                   y1 - 8], fill=(120, 40, 30))
    m.e.rectangle([mid + 62, y0 + (y1 - y0) * 0.36, mid + 66,
                   y1 - 8], fill=(120, 40, 30))
    bolts(m, [(x, y) for x in (x0 + 16, x1 - 16) for y in (y0 + 16, y1 - 16)],
          r=4, base=ARMOR_DK)
    z = L.G_ARM_R
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ARMOR_DK, 1.04), ao=AO_BASE - 4,
         rough=R_ARMOR + 6, metal=M_ARMOR)
    seam_v(m, int((x0 + x1) / 2), y0 + 3, y1 - 3, ARMOR_DK)
    bolts(m, [(x, y) for x in (x0 + 20, x1 - 20) for y in (y0 + 20, y1 - 20)],
          r=3, base=ARMOR_DK)


def paint_tower_gate(m):
    # tower legs/mast wrap
    x0, y0, x1, y1 = L.G_TWR
    fill(m, (x0, y0, x1, y1), dif=GALV, ao=AO_BASE - 4, rough=R_STEEL - 10,
         metal=M_STEEL)
    for gy in range(int(y0) + 20, int(y1), 36):
        m.d.line([(x0 + 2, gy), (x1 - 2, gy)], fill=shade(GALV, 0.88), width=2)
    # cab: armored booth with a lit vision band
    z = L.G_TWR_CAB
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 2, rough=R_ARMOR,
         metal=M_ARMOR)
    vy0, vy1 = y0 + (y1 - y0) * 0.22, y0 + (y1 - y0) * 0.44
    m.d.rectangle([x0 + 10, vy0, x1 - 10, vy1], fill=(26, 34, 40))
    m.o.rectangle([x0 + 10, vy0, x1 - 10, vy1], fill=(AO_BASE - 14, R_GLASS, 0))
    # segmented panes with mullions; only some lit
    npanes = 6
    for i in range(npanes):
        px0 = x0 + 14 + (x1 - x0 - 28) * i / npanes
        px1 = x0 + 14 + (x1 - x0 - 28) * (i + 0.82) / npanes
        if RNG.random() < 0.5:
            m.e.rectangle([px0, vy0 + 5, px1, vy1 - 5], fill=shade(WARM, 0.34))
    seam_h(m, x0 + 4, x1 - 4, int(y0 + (y1 - y0) * 0.58), ARMOR)
    bolts(m, [(x, y1 - 12) for x in range(int(x0) + 16, int(x1), 60)], r=3,
          base=ARMOR)
    z = L.G_TWR_TOP
    fill(m, z.rect, dif=shade(ARMOR, 0.95), ao=AO_BASE - 4, rough=R_ARMOR + 8,
         metal=M_ARMOR)
    # gatehouse: concrete towers with hazard base + floodlight glow
    z = L.G_GATE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CONCRETE_D, 0.96), ao=AO_BASE - 6,
         rough=R_ARMOR + 22, metal=0)
    seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * 0.30), CONCRETE_D)
    for i in range(0, int(x1 - x0), 28):
        m.d.polygon([(x0 + i, y1), (x0 + i + 14, y1), (x0 + i + 28, y1 - 22),
                     (x0 + i + 14, y1 - 22)],
                    fill=YELLOW if (i // 28) % 2 == 0 else BLACKISH)
    # gate ID banner (team-masked)
    mid = (x0 + x1) / 2
    m.d.rectangle([mid - 88, y0 + 14, mid + 88, y0 + 60], fill=TEAMGREY)
    m.t.rectangle([mid - 88, y0 + 14, mid + 88, y0 + 60], fill=(255, 0, 0))
    stencil(m, (mid - 80, y0 + 18), 'GARRISON 04', 30, shade(ARMOR_DK, 0.5))
    f = ImageFont.truetype(P.FONT, 30)
    m.t.text((mid - 80, y0 + 18), 'GARRISON 04', font=f, fill=(0, 0, 0))
    z = L.G_GATE_T
    fill(m, z.rect, dif=shade(CONCRETE_D, 1.04), ao=AO_BASE - 4,
         rough=R_ARMOR + 20, metal=0)


def paint_props(m):
    # crates: olive with straps + stencil
    z = L.G_CRATE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=(88, 94, 78), ao=AO_BASE - 6,
         rough=R_ARMOR + 16, metal=M_ARMOR - 12)
    for fy in (0.30, 0.62):
        m.d.line([(x0 + 4, y0 + (y1 - y0) * fy), (x1 - 4, y0 + (y1 - y0) * fy)],
                 fill=shade((88, 94, 78), 0.7), width=4)
    stencil(m, (x0 + 20, y0 + 20), 'SUPPLY', 34, jit(YELLOW, 8))
    # fuel tank wrap: pale tank with hazard ring + FUEL stencil
    x0, y0, x1, y1 = L.G_TANKW
    fill(m, (x0, y0, x1, y1), dif=(168, 162, 150), ao=AO_BASE - 4,
         rough=R_ARMOR + 8, metal=M_ARMOR + 40)
    m.d.rectangle([x0 + (x1 - x0) * 0.44, y0, x0 + (x1 - x0) * 0.56, y1],
                  fill=jit(ORANGE, 10))
    stencil(m, (x0 + 20, y0 + 40, ), 'FUEL', 40, (60, 56, 50))
    # sensor panel: dark array with cyan emitter rows
    z = L.G_DISH
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=(38, 44, 52), ao=AO_BASE - 8,
         rough=R_ARMOR - 30, metal=M_STEEL - 40)
    for fy in (0.25, 0.5, 0.75):
        m.d.line([(x0 + 8, y0 + (y1 - y0) * fy), (x1 - 8, y0 + (y1 - y0) * fy)],
                 fill=(30, 60, 70), width=6)
        m.e.line([(x0 + 10, y0 + (y1 - y0) * fy), (x1 - 10, y0 + (y1 - y0) * fy)],
                 fill=shade(CYAN, 0.45), width=4)
    fill(m, L.G_DISH_B.rect, dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)
    # flag mast wrap
    x0, y0, x1, y1 = L.G_FLAG
    fill(m, (x0, y0, x1, y1), dif=GALV, ao=AO_BASE - 4, rough=R_STEEL - 20,
         metal=M_STEEL)
    # beacons
    z = L.G_LIGHT
    fill(m, z.rect, dif=AMBER, ao=AO_BASE, rough=R_GLASS, metal=M_GLASS)
    x0, y0, x1, y1 = z.rect
    m.e.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2], fill=shade(AMBER, 0.75))
    # door cell + dark cell
    z = L.G_DOOR
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 10, rough=R_STEEL,
         metal=M_STEEL - 20)
    fill(m, L.G_DARK.rect, dif=(14, 14, 16), ao=AO_DEEP, rough=R_ARMOR + 20,
         metal=0)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_pad(m)
    paint_walls(m)
    paint_barracks(m)
    paint_armory(m)
    paint_tower_gate(m)
    paint_props(m)

    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=73)
    wx.crevice_grime(m.dif, 0.4)
    wx.mud_band(L.G_PAD.rect, 0.22, fade=None, spatter=True)
    wx.mud_band(L.G_WALL.rect, 0.5, fade='down')
    wx.plate_bottom_rust(L.G_WALL.rect, n=8, strength=0.4)
    for z in (L.G_BK_S1, L.G_BK_E1):
        wx.mud_band(z.rect, 0.35, fade='down', dust=0.3)
        wx.plate_bottom_rust(z.rect, n=6, strength=0.5)
    wx.mud_band(L.G_ARM_S.rect, 0.3, fade='down')
    wx.mud_band(L.G_BK_R1.rect, 0.16, fade=None, dust=0.3)
    wx.rust_streak(L.G_BK_R1.rect[0] + 300, L.G_BK_R1.rect[1] + 40, 60,
                   width=3, strength=0.35)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.4)
    wx.apply(m)

    from normals import HeightMap
    hm = HeightMap()
    # corrugation ribs ride crevices; add pad joints
    z = L.G_PAD
    x0, y0, x1, y1 = z.rect
    k = (x1 - x0) / 20.8
    for w in np.arange(-8, 9, 4):
        hm.line((x0 + (w + 10.4) * k, y0 + 2), (x0 + (w + 10.4) * k, y1 - 2),
                -0.6, width=2)
        hm.line((x0 + 2, y0 + (w + 10.4) * k), (x1 - 2, y0 + (w + 10.4) * k),
                -0.6, width=2)
    hm.crevices_from(m.dif, 0.5)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.2).save('out/ms_garrison_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save('out/ms_garrison_diffuse.png')
    m.orm.save('out/ms_garrison_orm.png')
    m.emi.save('out/ms_garrison_emissive.png')
    m.tea.save('out/ms_garrison_team.png')
    print('[paint_garrison] full 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
