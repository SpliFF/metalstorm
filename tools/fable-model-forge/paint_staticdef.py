"""paint_staticdef — 1024² PBR set for ms_staticdefense_s1.

Read: weathered concrete berm with a blast-door entry, sandbag rim,
hazard-striped pit floor ring, riveted steel plinth, faction blue-grey
gunhouse with team panels + roof numeral, gunmetal twin autocannons with
heat-banded flash hiders, ammo crates, amber perimeter beacon.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import staticdef_layout as L        # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
P.FONT = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, stencil, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, LOWER, STEEL, STEEL_DK,
                   YELLOW, BLACKISH, TEAMGREY, CYAN, ORANGE,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, RNG)

CONCRETE = (139, 136, 128)
SANDBAG = (128, 112, 88)
GUNMETAL = (62, 66, 72)
AMBER = (255, 176, 60)


def paint_top(m):
    """S_TOP: top-down world zone — berm rim ring + pit floor + plinth ring."""
    z = L.S_TOP
    x0, y0, x1, y1 = z.rect
    W_, H_ = x1 - x0, y1 - y0
    ppm = W_ / 6.0                                   # px per metre (world ±3)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    # base: concrete everywhere
    fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE, rough=R_ARMOR + 22, metal=0)
    # pit floor: darker poured slab inside the inner ring
    r_in = L.RING_R_INR * ppm
    m.d.ellipse([cx - r_in, cy - r_in, cx + r_in, cy + r_in],
                fill=shade(CONCRETE, 0.84))
    m.o.ellipse([cx - r_in, cy - r_in, cx + r_in, cy + r_in],
                fill=(AO_BASE - 14, R_ARMOR + 26, 0))
    # radial expansion joints across the berm rim
    for a in np.linspace(0, 2 * np.pi, 17)[:-1]:
        dx, dy = np.cos(a), np.sin(a)
        m.d.line([(cx + dx * r_in, cy + dy * r_in),
                  (cx + dx * W_ / 2 * 0.99, cy + dy * H_ / 2 * 0.99)],
                 fill=shade(CONCRETE, 0.8), width=2)
    # hazard ring around the plinth (turret slew warning)
    r_hz = (L.PLINTH_R + 0.55) * ppm
    for a in np.linspace(0, 2 * np.pi, 33)[:-1]:
        a2 = a + np.pi / 33
        if int(a / (np.pi / 16)) % 2:
            continue
        m.d.line([(cx + np.cos(a) * r_hz, cy + np.sin(a) * r_hz),
                  (cx + np.cos(a2) * r_hz, cy + np.sin(a2) * r_hz)],
                 fill=YELLOW, width=6)
    # floor drain + scuffed track ring under the hazard line
    m.d.ellipse([cx - 5, cy - 5, cx + 5, cy + 5], fill=BLACKISH)
    # entry threshold marks at -Z (image: -z is toward y0? win z (-3,3) → v0=-3)
    # z window (-3..3) maps -3 → y0: entry (-Z) band sits at the TOP of the rect
    m.d.rectangle([cx - 0.8 * ppm, y0 + 0.35 * ppm, cx + 0.8 * ppm, y0 + 0.85 * ppm],
                  fill=shade(CONCRETE, 0.9))
    for i in range(-3, 4):
        m.d.line([(cx + i * 18, y0 + 0.38 * ppm), (cx + i * 18, y0 + 0.82 * ppm)],
                 fill=shade(YELLOW, 0.85), width=4)


def paint_walls(m):
    """S_WALL/S_WALL_Z share one rect: concrete band with a blast door."""
    x0, y0, x1, y1 = L.S_WALL.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CONCRETE, 0.94), ao=AO_BASE - 6,
         rough=R_ARMOR + 24, metal=0)
    # horizontal pour seams
    for fy in (0.32, 0.66):
        seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * fy), CONCRETE)
    # form-tie dimples
    bolts(m, [(x, y) for x in range(int(x0) + 24, int(x1) - 10, 60)
              for y in (y0 + 24, y1 - 22)], r=3, base=CONCRETE)
    # weep stains below the form ties (subtle verticals; no directional
    # features here — every wall family's centre face samples rect centre)
    for wxp in range(int(x0) + 54, int(x1) - 10, 60):
        m.d.line([(wxp, y0 + 30), (wxp, y0 + 30 + int(RNG.integers(10, 26)))],
                 fill=shade(CONCRETE, 0.82), width=2)


def paint_bags(m):
    """S_BAGS: two courses of stacked sandbags (shared ±x/±z band)."""
    x0, y0, x1, y1 = L.S_BAGS.rect
    fill(m, (x0, y0, x1, y1), dif=SANDBAG, ao=AO_BASE - 8, rough=R_ARMOR + 30,
         metal=0)
    rows = 3
    rh = (y1 - y0) / rows
    for r in range(rows):
        ry = y0 + r * rh
        m.d.line([(x0, ry), (x1, ry)], fill=shade(SANDBAG, 0.62), width=3)
        m.o.line([(x0, ry), (x1, ry)], fill=(AO_SEAM, R_ARMOR + 30, 0), width=3)
        off = (r % 2) * 24
        for bx in range(int(x0) - 24 + off, int(x1) + 24, 48):
            m.d.arc([bx, ry + 2, bx + 48, ry + rh + 6], 200, 340,
                    fill=shade(SANDBAG, 0.7), width=2)
            m.d.line([(bx + 24, ry + 4), (bx + 24, ry + rh - 4)],
                     fill=shade(SANDBAG, 0.66), width=2)
        # per-bag tonal variance
        for bx in range(int(x0) + off, int(x1), 48):
            if RNG.random() < 0.4:
                m.d.rectangle([bx + 3, ry + 4, bx + 45, ry + rh - 3],
                              fill=jit(SANDBAG, 9))


def paint_plinth(m):
    x0, y0, x1, y1 = L.S_PLINTH
    fill(m, (x0, y0, x1, y1), dif=LOWER, ao=AO_BASE - 8, rough=R_ARMOR,
         metal=M_ARMOR + 30)
    # vertical armor plate joints + rivet rows (parametric wrap: u around)
    for fx in np.linspace(0, 1, 11)[:-1]:
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 3, y1 - 3, LOWER)
    bolts(m, [(x0 + (x1 - x0) * fx + 14, y) for fx in np.linspace(0, 1, 11)[:-1]
              for y in (y0 + 14, y1 - 14)], r=3, base=LOWER)
    # top cap
    zc = L.S_PLINTH_T
    fill(m, zc.rect, dif=shade(LOWER, 1.06), ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR + 30)
    tx0, ty0, tx1, ty1 = zc.rect
    tc = ((tx0 + tx1) / 2, (ty0 + ty1) / 2)
    rr = (tx1 - tx0) * 0.36
    m.d.ellipse([tc[0] - rr, tc[1] - rr, tc[0] + rr, tc[1] + rr],
                outline=shade(LOWER, 0.7), width=4)


def paint_gunhouse(m):
    # sides
    z = L.S_GH_S
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 4, rough=R_ARMOR,
         metal=M_ARMOR)
    seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * 0.42), ARMOR)
    # team chevron panel (mask-cut emblem survives team paint)
    px0, px1 = x0 + (x1 - x0) * 0.30, x0 + (x1 - x0) * 0.58
    py0, py1 = y0 + (y1 - y0) * 0.16, y0 + (y1 - y0) * 0.62
    m.d.rectangle([px0, py0, px1, py1], fill=TEAMGREY)
    m.t.rectangle([px0, py0, px1, py1], fill=(255, 0, 0))
    mid = (py0 + py1) / 2
    m.t.polygon([(px0 + 14, mid), ((px0 + px1) / 2, py0 + 8),
                 ((px0 + px1) / 2, mid), (px0 + 14, py1 - 8)], fill=(0, 0, 0))
    bolts(m, [(x, y) for x in range(int(x0) + 16, int(x1) - 8, 56)
              for y in (y0 + 12, y1 - 10)], r=3, base=ARMOR)
    wear_edges(m, z.rect, ARMOR, density=22)
    # front/rear shared rect: darker lower band + vision slit
    z = L.S_GH_F
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR)
    m.d.rectangle([x0, y0 + (y1 - y0) * 0.62, x1, y1], fill=shade(ARMOR_DK, 0.9))
    # narrow optics slit (front reads it; rear samples the same band as vents)
    sx0 = x0 + (x1 - x0) * 0.36
    sx1 = x0 + (x1 - x0) * 0.64
    m.d.rectangle([sx0, y0 + 26, sx1, y0 + 40], fill=(24, 34, 40))
    m.o.rectangle([sx0, y0 + 26, sx1, y0 + 40], fill=(AO_DEEP, R_GLASS, 0))
    m.e.rectangle([sx0 + 3, y0 + 29, sx1 - 3, y0 + 37], fill=(30, 70, 80))
    wear_edges(m, z.rect, ARMOR_DK, density=18)
    # roof: hatch + numeral, reads from behind (v toward +z = rear)
    z = L.S_GH_T
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ARMOR, 0.96), ao=AO_BASE - 2,
         rough=R_ARMOR + 4, metal=M_ARMOR)
    seam_v(m, int((x0 + x1) / 2), y0 + 4, y1 - 4, ARMOR)
    # crew hatch (rear-left quarter)
    hx, hy, hr = x0 + (x1 - x0) * 0.30, y0 + (y1 - y0) * 0.68, 34
    m.d.ellipse([hx - hr, hy - hr, hx + hr, hy + hr], fill=shade(ARMOR, 1.08))
    m.d.ellipse([hx - hr, hy - hr, hx + hr, hy + hr],
                outline=shade(ARMOR, 0.6), width=3)
    bolts(m, [(hx + hr * np.cos(a), hy + hr * np.sin(a))
              for a in np.linspace(0, 2 * np.pi, 9)[:-1]], r=2, base=ARMOR)
    # roof numeral on a team square (mask-cut digits)
    nx, ny = x0 + (x1 - x0) * 0.66, y0 + (y1 - y0) * 0.55
    m.d.rectangle([nx - 34, ny - 40, nx + 34, ny + 40], fill=TEAMGREY)
    m.t.rectangle([nx - 34, ny - 40, nx + 34, ny + 40], fill=(255, 0, 0))
    stencil(m, (nx - 26, ny - 34), '11', 58, shade(ARMOR_DK, 0.65))
    # cut the numeral out of the mask so it survives team paint
    tmp = Image.new('L', (120, 90), 0)
    ImageDraw.Draw(tmp)
    # simpler: draw numeral onto team mask in black via stencil on a proxy
    # (stencil writes only to diffuse; replicate cheaply with text)
    from PIL import ImageFont
    f = ImageFont.truetype(P.FONT, 58)
    m.t.text((nx - 26, ny - 34), '11', font=f, fill=(0, 0, 0))


def paint_guns(m):
    # tube wrap: gunmetal with heat bands near the muzzle end (u = length)
    x0, y0, x1, y1 = L.S_GUN
    fill(m, (x0, y0, x1, y1), dif=GUNMETAL, ao=AO_BASE - 6, rough=R_STEEL + 10,
         metal=M_STEEL - 20)
    # breech end collar (u0 side = station 0 = breech)
    m.d.rectangle([x0, y0, x0 + 26, y1], fill=STEEL_DK)
    # heat discoloration toward the muzzle
    for i, (fx, c) in enumerate((((0.80), (74, 66, 78)), ((0.88), (86, 70, 64)),
                                 ((0.95), (66, 58, 54)))):
        m.d.rectangle([x0 + (x1 - x0) * fx, y0, x0 + (x1 - x0) * (fx + 0.06), y1],
                      fill=c)
    # flash-hider slots
    for fx in (0.86, 0.90, 0.94):
        m.d.rectangle([x0 + (x1 - x0) * fx, y0 + (y1 - y0) * 0.2,
                       x0 + (x1 - x0) * fx + 4, y0 + (y1 - y0) * 0.8],
                      fill=BLACKISH)
        m.o.rectangle([x0 + (x1 - x0) * fx, y0 + (y1 - y0) * 0.2,
                       x0 + (x1 - x0) * fx + 4, y0 + (y1 - y0) * 0.8],
                      fill=(AO_DEEP, R_STEEL, M_STEEL))
    # muzzle cap: bore
    z = L.S_MUZZ
    fill(m, z.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_STEEL, metal=M_STEEL - 40)
    # cradle
    z = L.S_CRADLE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)
    seam_h(m, x0 + 2, x1 - 2, int((y0 + y1) / 2), STEEL)
    bolts(m, [(x0 + 12, y0 + 12), (x1 - 12, y0 + 12), (x0 + 12, y1 - 12),
              (x1 - 12, y1 - 12)], r=3, base=STEEL)
    # recoil cylinder glow strip (energy plumbing, restrained)
    m.e.rectangle([x0 + (x1 - x0) * 0.4, y0 + 6, x0 + (x1 - x0) * 0.6, y0 + 10],
                  fill=(40, 90, 100))


def paint_props(m):
    # sandbags: stitched bag courses (S_TOP already covers rim tops; bags
    # sample S_TOP + wall zones on sides — give the ammo/detail cells art)
    z = L.S_AMMO
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=(84, 92, 74), ao=AO_BASE - 6,
         rough=R_ARMOR + 16, metal=M_ARMOR - 10)
    seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * 0.5), (84, 92, 74))
    stencil(m, (x0 + 12, y0 + 12), 'AMMO 30MM', 22, jit(YELLOW, 8))
    for fy in (0.68, 0.84):
        m.d.line([(x0 + 6, y0 + (y1 - y0) * fy), (x1 - 6, y0 + (y1 - y0) * fy)],
                 fill=shade((84, 92, 74), 0.7), width=2)
    bolts(m, [(x0 + 10, y0 + 10), (x1 - 10, y0 + 10)], r=2, base=(84, 92, 74))
    # sensor wrap: dark sensor housing with a lens line
    x0, y0, x1, y1 = L.S_SENSOR
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 10, rough=R_STEEL,
         metal=M_STEEL - 30)
    m.e.rectangle([x0 + (x1 - x0) * 0.42, y0 + 4, x0 + (x1 - x0) * 0.58, y0 + 8],
                  fill=(60, 140, 150))
    # perimeter beacon: amber glass
    z = L.S_LIGHT
    fill(m, z.rect, dif=AMBER, ao=AO_BASE, rough=R_GLASS, metal=M_GLASS)
    x0, y0, x1, y1 = z.rect
    m.e.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2], fill=shade(AMBER, 0.8))
    # dark void cell
    fill(m, L.S_DARK.rect, dif=(14, 14, 16), ao=AO_DEEP, rough=R_ARMOR + 20,
         metal=0)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_top(m)
    paint_walls(m)
    paint_bags(m)
    paint_plinth(m)
    paint_gunhouse(m)
    paint_guns(m)
    paint_props(m)

    from weathering import Weather, vertical_rects_of
    from paint import enrich
    enrich(m)
    wx = Weather(seed=41)
    wx.crevice_grime(m.dif, 0.4)
    wx.mud_band(L.S_TOP.rect, 0.28, fade=None, spatter=True)
    wx.mud_band(L.S_WALL.rect, 0.55, fade='down')
    wx.plate_bottom_rust(L.S_WALL.rect, n=6, strength=0.5)
    wx.plate_bottom_rust(L.S_PLINTH, n=4, strength=0.4)
    wx.mud_band(L.S_PLINTH, 0.35, fade='down', dust=0.3)
    for z in (L.S_GH_S, L.S_GH_F):
        wx.mud_band(z.rect, 0.22, fade='down', dust=0.25)
    wx.soot_patch((L.S_GUN[0] + int((L.S_GUN[2] - L.S_GUN[0]) * 0.8), L.S_GUN[1],
                   L.S_GUN[2], L.S_GUN[3]), strength=0.6)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.4)
    wx.apply(m)

    from normals import HeightMap
    hm = HeightMap()
    # berm expansion joints ride the crevice pass; add plinth plate grooves
    x0, y0, x1, y1 = L.S_PLINTH
    for fx in np.linspace(0, 1, 11)[:-1]:
        hm.line((x0 + (x1 - x0) * fx, y0 + 3), (x0 + (x1 - x0) * fx, y1 - 3),
                -0.8, width=2)
    # sandbag courses on the wall band
    hm.crevices_from(m.dif, 0.5)
    hm.bolts_from(BOLT_LOG, 0.55)
    hm.weather_from(wx)
    hm.to_normal_image(strength=5.0).save('out/ms_staticdefense_s1_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.5))
    m.dif.save('out/ms_staticdefense_s1_diffuse.png')
    m.orm.save('out/ms_staticdefense_s1_orm.png')
    m.emi.save('out/ms_staticdefense_s1_emissive.png')
    m.tea.save('out/ms_staticdefense_s1_team.png')
    print('[paint_staticdef] full 1024 texture set written to out/')


if __name__ == '__main__':
    paint_all()
