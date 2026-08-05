"""paint_ms_watchtower — 1024² PBR set for ms_watchtower.

Staging-post guard tower read: weathered concrete pad with hazard
corners, galvanised lattice legs, steel floor/roof slabs with hazard
edging, ARMOR-grey enclosed cab with a dark wrap-around window band,
team stripe + roof patch, and a steel searchlight drum whose lens is
the ONLY emissive on the model (spec: emissive lens, nothing else lit).
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import ms_watchtower_layout as L   # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, STEEL, STEEL_DK,
                   GLASS, YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, RNG)

W = 1024
CONCRETE = (146, 144, 138)
GALV = (166, 170, 175)
LENS_WARM = (255, 236, 190)


def paint_pad(m):
    z = L.R_PAD
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE, rough=R_ARMOR + 20, metal=0)
    # expansion joints
    for f in (1/3, 2/3):
        m.d.line([(x0 + (x1-x0)*f, y0+2), (x0 + (x1-x0)*f, y1-2)], fill=shade(CONCRETE, 0.86), width=2)
        m.d.line([(x0+2, y0 + (y1-y0)*f), (x1-2, y0 + (y1-y0)*f)], fill=shade(CONCRETE, 0.86), width=2)
    # hazard corner wedges + anchor bolts at the leg feet
    cw = 56
    for cx, cy in ((x0, y0), (x1-cw, y0), (x0, y1-cw), (x1-cw, y1-cw)):
        for i in range(0, cw, 16):
            m.d.polygon([(cx+i, cy), (cx+i+8, cy), (cx, cy+i+8), (cx, cy+i)],
                        fill=YELLOW if (i//16) % 2 == 0 else BLACKISH)
    # leg-foot base plates (legs land at ±1.85 world)
    for wx in (-1.85, 1.85):
        for wz in (-1.85, 1.85):
            u, v = z.uv((wx, 0, wz))
            px, py = u * W, v * W
            m.d.rectangle([px-18, py-18, px+18, py+18], fill=STEEL_DK)
            m.o.rectangle([px-18, py-18, px+18, py+18], fill=(AO_SEAM, R_STEEL, M_STEEL))
            bolts(m, [(px-12, py-12), (px+12, py-12), (px-12, py+12), (px+12, py+12)],
                  r=3, base=STEEL_DK)
    fill(m, L.R_PADS.rect, dif=shade(CONCRETE, 0.9), ao=AO_BASE-10,
         rough=R_ARMOR + 20, metal=0)


def paint_cab(m):
    for z in (L.R_CAB, L.R_CAB_F):
        x0, y0, x1, y1 = z.rect
        fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 4, rough=R_ARMOR,
             metal=M_ARMOR)
        # wrap-around window band on the upper half (dark glass, NOT lit)
        _, gv0 = z.uv((0, 8.85, 0))
        _, gv1 = z.uv((0, 8.15, 0))
        gy0, gy1 = gv0 * W, gv1 * W
        m.d.rectangle([x0+14, gy0, x1-14, gy1], fill=GLASS)
        m.o.rectangle([x0+14, gy0, x1-14, gy1], fill=(AO_BASE, R_GLASS, M_GLASS))
        # mullions
        for f in (0.25, 0.5, 0.75):
            mx = x0 + (x1-x0)*f
            m.d.rectangle([mx-4, gy0, mx+4, gy1], fill=ARMOR_DK)
            m.o.rectangle([mx-4, gy0, mx+4, gy1], fill=(AO_BASE-4, R_ARMOR, M_ARMOR))
        # sill seam under the glass
        seam_h(m, x0+4, x1-4, int(gy1) + 6, ARMOR)
        # team stripe band below the sill
        _, tv0 = z.uv((0, 8.02, 0))
        _, tv1 = z.uv((0, 7.80, 0))
        m.d.rectangle([x0+6, tv0*W, x1-6, tv1*W], fill=TEAMGREY)
        m.t.rectangle([x0+6, tv0*W, x1-6, tv1*W], fill=(255, 0, 0))
        # lower panel seams + bolts
        seam_h(m, x0+4, x1-4, int(tv1*W) + 14, ARMOR)
        for f in (0.33, 0.66):
            seam_v(m, int(x0 + (x1-x0)*f), int(tv1*W) + 14, y1 - 4, ARMOR)
        bolts(m, [(x0+14, y1-12), (x0 + (x1-x0)//2, y1-12), (x1-14, y1-12)],
              base=ARMOR)
        wear_edges(m, z.rect, ARMOR, density=20)
    # narrow access door on the ±z faces (ladder side)
    z = L.R_CAB_F
    x0, y0, x1, y1 = z.rect
    du0, dv0 = z.uv((-0.35, 8.9, 0))
    du1, dv1 = z.uv((0.35, 7.32, 0))
    db = [du0*W, dv0*W, du1*W, dv1*W]
    m.d.rectangle(db, fill=ARMOR_DK, outline=shade(ARMOR_DK, 0.55), width=3)
    m.o.rectangle(db, fill=(AO_BASE - 14, R_ARMOR, M_ARMOR))
    # door window + handle
    m.d.rectangle([db[0]+10, db[1]+10, db[2]-10, db[1]+44], fill=GLASS)
    m.o.rectangle([db[0]+10, db[1]+10, db[2]-10, db[1]+44], fill=(AO_BASE, R_GLASS, M_GLASS))
    m.d.rectangle([db[2]-14, (db[1]+db[3])/2 - 3, db[2]-6, (db[1]+db[3])/2 + 3],
                  fill=STEEL)


def paint_roof(m):
    # roof top: dark weatherproof deck, hatch, walk strips, team patch
    z = L.R_CAB_T
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ARMOR, 0.82), ao=AO_BASE - 6,
         rough=R_ARMOR + 14, metal=M_ARMOR)
    for f in (1/3, 2/3):
        seam_h(m, x0+2, x1-2, int(y0 + (y1-y0)*f), shade(ARMOR, 0.82))
    # access hatch (rear-left quadrant)
    hu0, hv0 = z.uv((-1.2, 0, 0.4))
    hu1, hv1 = z.uv((-0.4, 0, 1.2))
    hb = [hu0*W, hv0*W, hu1*W, hv1*W]
    m.d.rectangle(hb, fill=ARMOR_DK, outline=shade(ARMOR_DK, 0.55), width=3)
    m.o.rectangle(hb, fill=(AO_BASE - 12, R_ARMOR, M_ARMOR))
    bolts(m, [(hb[0]+8, hb[1]+8), (hb[2]-8, hb[1]+8), (hb[0]+8, hb[3]-8),
              (hb[2]-8, hb[3]-8)], base=ARMOR_DK)
    # team ID patch (reads from the air) — front-right quadrant
    tu0, tv0 = z.uv((0.4, 0, -1.2))
    tu1, tv1 = z.uv((1.2, 0, -0.4))
    m.d.rectangle([tu0*W, tv0*W, tu1*W, tv1*W], fill=TEAMGREY)
    m.t.rectangle([tu0*W, tv0*W, tu1*W, tv1*W], fill=(255, 0, 0))
    wear_edges(m, z.rect, shade(ARMOR, 0.82), density=24)

    # roof edge band: hazard chevrons
    for z2 in (L.R_ROOF_E, L.R_ROOF_EF):
        x0, y0, x1, y1 = z2.rect
        fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 6,
             rough=R_ARMOR, metal=M_ARMOR)
        for i in range(int((x1 - x0) / 24) + 1):
            c = YELLOW if i % 2 == 0 else BLACKISH
            m.d.polygon([(x0 + i*24, y0+3), (x0 + i*24 + 24, y0+3),
                         (x0 + i*24 + 12, y1-3), (x0 + i*24 - 12, y1-3)], fill=c)

    # floor edge band: dark steel, bolted
    for z2 in (L.R_FLOOR_E, L.R_FLOOR_EF):
        x0, y0, x1, y1 = z2.rect
        fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 10,
             rough=R_STEEL, metal=M_STEEL)
        bolts(m, [(x0 + 20 + i * ((x1-x0-40) / 7), (y0+y1)/2) for i in range(8)],
              r=3, base=STEEL_DK)
    # floor-top ledge
    fill(m, L.R_FLOOR_T.rect, dif=shade(STEEL_DK, 1.12), ao=AO_BASE - 8,
         rough=R_STEEL, metal=M_STEEL)


def paint_details(m):
    # galvanised legs with lattice banding
    fill(m, L.R_LEG, dif=GALV, ao=AO_BASE - 4, rough=R_STEEL - 10, metal=M_STEEL)
    x0, y0, x1, y1 = L.R_LEG
    for gx in range(int(x0)+16, int(x1), 28):
        m.d.line([(gx, y0+2), (gx, y1-2)], fill=shade(GALV, 0.88), width=2)
    # trim wrap: dark steel (braces, ladder, yoke, post, antenna)
    fill(m, L.R_TRIM, dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL, metal=M_STEEL)
    # searchlight drum wrap: steel with rib bands
    fill(m, L.R_HOUS, dif=STEEL, ao=AO_BASE - 6, rough=R_STEEL, metal=M_STEEL)
    x0, y0, x1, y1 = L.R_HOUS
    for f in (0.22, 0.5, 0.78):
        gx = x0 + (x1-x0)*f
        m.d.line([(gx, y0+2), (gx, y1-2)], fill=shade(STEEL, 0.8), width=3)
        m.o.line([(gx, y0+2), (gx, y1-2)], fill=(AO_SEAM, R_STEEL, M_STEEL), width=3)
    fill(m, L.R_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 16, metal=M_ARMOR)

    # drum rear cap: louvred cooling grille
    z = L.R_DRUM_B
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 10, rough=R_STEEL,
         metal=M_STEEL)
    vent_slots(m, (x0 + 18, y0 + 24, x1 - 18, y1 - 24), 4)
    bolts(m, [(x0+10, y0+10), (x1-10, y0+10), (x0+10, y1-10), (x1-10, y1-10)],
          r=3, base=STEEL_DK)

    # lens: the ONLY emissive on the model — warm searchlight glass
    z = L.R_LENS
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=LENS_WARM, ao=AO_BASE, rough=R_GLASS,
         metal=M_GLASS)
    cx, cy = (x0+x1)/2, (y0+y1)/2
    rr = min(x1-x0, y1-y0) * 0.46
    m.d.ellipse([cx-rr, cy-rr, cx+rr, cy+rr], fill=(255, 248, 224),
                outline=shade(STEEL, 0.9), width=4)
    m.e.ellipse([cx-rr, cy-rr, cx+rr, cy+rr], fill=LENS_WARM)
    hr = rr * 0.45
    m.e.ellipse([cx-hr, cy-hr, cx+hr, cy+hr], fill=(255, 252, 240))


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_pad(m)
    paint_cab(m)
    paint_roof(m)
    paint_details(m)

    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=47)
    wx.crevice_grime(m.dif, 0.35)
    wx.mud_band(L.R_PAD.rect, 0.32, fade=None, spatter=True)
    wx.mud_band(L.R_PADS.rect, 0.5, fade='down')
    wx.mud_band(L.R_LEG, 0.45, fade='left')          # u=0 = leg foot
    for z in (L.R_CAB, L.R_CAB_F):
        wx.mud_band(z.rect, 0.2, fade='down', dust=0.3)
        wx.plate_bottom_rust(z.rect, n=4, strength=0.4)
    wx.plate_bottom_rust(L.R_FLOOR_E.rect, n=4, strength=0.5)
    wx.plate_bottom_rust(L.R_ROOF_EF.rect, n=3, strength=0.35)
    # rain streaks off the roof corners down the cab walls
    wx.rust_streak(L.R_CAB.rect[0] + 40, L.R_CAB.rect[1] + 24, 46,
                   width=2.5, strength=0.3)
    wx.rust_streak(L.R_CAB.rect[2] - 52, L.R_CAB.rect[1] + 24, 38,
                   width=2.0, strength=0.28)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.4)
    wx.apply(m)

    from normals import HeightMap
    hm = HeightMap()
    x0, y0, x1, y1 = L.R_PAD.rect
    for f in (1/3, 2/3):
        hm.line((x0 + (x1-x0)*f, y0+2), (x0 + (x1-x0)*f, y1-2), -0.5, width=2)
        hm.line((x0+2, y0 + (y1-y0)*f), (x1-2, y0 + (y1-y0)*f), -0.5, width=2)
    hm.crevices_from(m.dif, 0.5)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.0).save('out/ms_watchtower_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.5))
    m.dif.save('out/ms_watchtower_diffuse.png')
    m.orm.save('out/ms_watchtower_orm.png')
    m.emi.save('out/ms_watchtower_emissive.png')
    m.tea.save('out/ms_watchtower_team.png')
    print('[paint_ms_watchtower] full 1024 texture set written to out/')


if __name__ == '__main__':
    paint_all()
