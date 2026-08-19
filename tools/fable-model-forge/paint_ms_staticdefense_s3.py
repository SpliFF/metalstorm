"""paint_ms_staticdefense_s3 — 1024 PBR set for ms_staticdefense_s3.

Defense Battery read: weathered concrete pad/tier with hazard corners,
bolted ARMOR-plate casemate (vents, cable trunking, entry door, team
panel), yellow/black hazard slew ring, worn-steel railgun cradle with
ribbed capacitor drums, dark gunmetal accelerator sleeve whose thin
amber charge-indicator strip is the ONLY emissive, sooted emitter tube
and flak tubes, olive ammo boxes on the flak shelf.
"""
from __future__ import annotations
import numpy as np
from PIL import ImageFilter

import ms_staticdefense_s3_layout as L   # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   shade, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, STEEL, STEEL_DK,
                   YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS)
import paintlib as PL

W = 1024
CONCRETE = (146, 144, 138)
GUNMETAL = (88, 92, 98)
OLIVE = (96, 102, 74)
AMBER = (255, 176, 64)


def paint_concrete(m):
    # pad top: concrete, expansion joints, hazard corner wedges
    z = L.R_PAD_T
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE, rough=R_ARMOR + 20,
         metal=0)
    for f in (1/3, 2/3):
        m.d.line([(x0 + (x1-x0)*f, y0+2), (x0 + (x1-x0)*f, y1-2)],
                 fill=shade(CONCRETE, 0.86), width=2)
        m.d.line([(x0+2, y0 + (y1-y0)*f), (x1-2, y0 + (y1-y0)*f)],
                 fill=shade(CONCRETE, 0.86), width=2)
    cw = 48
    for cx, cy in ((x0, y0), (x1-cw, y0), (x0, y1-cw), (x1-cw, y1-cw)):
        for i in range(0, cw, 16):
            m.d.polygon([(cx+i, cy), (cx+i+8, cy), (cx, cy+i+8), (cx, cy+i)],
                        fill=YELLOW if (i//16) % 2 == 0 else BLACKISH)
    fill(m, L.R_PAD_S.rect, dif=shade(CONCRETE, 0.88), ao=AO_BASE-10,
         rough=R_ARMOR + 20, metal=0)

    # tier sides: concrete with a steel entry door + cable trunking risers
    z = L.R_TIER_S
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CONCRETE, 0.96), ao=AO_BASE - 4,
         rough=R_ARMOR + 18, metal=0)
    for f in (0.25, 0.5, 0.75):
        seam_v(m, int(x0 + (x1-x0)*f), y0 + 4, y1 - 4, shade(CONCRETE, 0.96))
    # entry door (z-face cell, appears on both z faces): 0.9 m wide, full tier
    u, v = PL.zone_fns(L.R_TIER_SZ)
    db = PL.nbox(u(-0.45), v(2.05), u(0.45), v(0.62))
    m.d.rectangle(db, fill=ARMOR_DK, outline=shade(ARMOR_DK, 0.55), width=3)
    m.o.rectangle(db, fill=(AO_BASE - 14, R_ARMOR, M_ARMOR))
    m.d.rectangle([db[2]-12, (db[1]+db[3])/2 - 4, db[2]-5, (db[1]+db[3])/2 + 4],
                  fill=STEEL)
    bolts(m, [(db[0]+8, db[1]+8), (db[2]-8, db[1]+8),
              (db[0]+8, db[3]-8), (db[2]-8, db[3]-8)], base=ARMOR_DK)
    # cable trunking climbing beside the door
    for wx in (0.75, 0.95):
        tx = u(wx)
        m.d.rectangle([min(tx, u(wx+0.12)), v(2.1), max(tx, u(wx+0.12)), y1-2],
                      fill=STEEL_DK)
        m.o.rectangle([min(tx, u(wx+0.12)), v(2.1), max(tx, u(wx+0.12)), y1-2],
                      fill=(AO_SEAM, R_STEEL, M_STEEL))
    fill(m, L.R_TIER_T.rect, dif=shade(CONCRETE, 0.92), ao=AO_BASE - 4,
         rough=R_ARMOR + 18, metal=0)
    tz = L.R_TIER_T
    for f in (1/3, 2/3):
        m.d.line([(tz.rect[0] + (tz.rect[2]-tz.rect[0])*f, tz.rect[1]+2),
                  (tz.rect[0] + (tz.rect[2]-tz.rect[0])*f, tz.rect[3]-2)],
                 fill=shade(CONCRETE, 0.84), width=2)


def paint_casemate(m):
    z = L.R_CASE_S
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 4, rough=R_ARMOR,
         metal=M_ARMOR)
    # bolted armour plates
    u, v = PL.zone_fns(z)
    for f in (0.25, 0.5, 0.75):
        seam_v(m, int(x0 + (x1-x0)*f), y0 + 4, y1 - 4, ARMOR)
    plate_y = int(v(3.2))
    seam_h(m, x0 + 4, x1 - 4, plate_y, ARMOR)
    step = (x1 - x0) // 8
    bolts(m, [(x0 + step//2 + i*step, plate_y - 8) for i in range(8)],
          r=3, base=ARMOR)
    bolts(m, [(x0 + step//2 + i*step, y1 - 10) for i in range(8)],
          r=3, base=ARMOR)
    # cooling vents on the upper band
    vent_slots(m, (int(u(-1.5)), int(v(4.0)), int(u(-0.6)), int(v(3.55))), 4)
    vent_slots(m, (int(u(0.6)), int(v(4.0)), int(u(1.5)), int(v(3.55))), 4)
    # cable trunking run along the plate seam
    m.d.rectangle([x0+6, plate_y+10, x1-6, plate_y+22], fill=STEEL_DK)
    m.o.rectangle([x0+6, plate_y+10, x1-6, plate_y+22],
                  fill=(AO_SEAM, R_STEEL, M_STEEL))
    # team panel, lower-left of the wall
    PL.team_panel(m, PL.nbox(u(-1.7), v(3.0), u(-0.9), v(2.4)),
                  outline=ARMOR_DK)
    wear_edges(m, z.rect, ARMOR, density=24)

    # casemate roof: darker deck + bolted ring collar
    z = L.R_CASE_T
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ARMOR, 0.84), ao=AO_BASE - 6,
         rough=R_ARMOR + 12, metal=M_ARMOR)
    cx, cy = (x0+x1)/2, (y0+y1)/2
    rr = (x1 - x0) * 0.44
    m.d.ellipse([cx-rr, cy-rr, cx+rr, cy+rr], outline=shade(ARMOR, 0.7),
                width=4)
    for a in np.linspace(0, 2*np.pi, 12, endpoint=False):
        bolts(m, [(cx + rr*0.92*np.cos(a), cy + rr*0.92*np.sin(a))],
              r=3, base=shade(ARMOR, 0.84))
    wear_edges(m, z.rect, shade(ARMOR, 0.84), density=20)

    # slew ring: hazard chevrons
    PL.hazard_band(m, L.R_RING.rect)


def paint_turret(m):
    # cradle walls: worn steel plates (lighter than the casemate so the
    # turret separates tonally at zoom)
    CRADLE = shade(STEEL, 1.18)
    z = L.R_TURRET
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=CRADLE, ao=AO_BASE - 4, rough=R_STEEL,
         metal=M_STEEL)
    u, v = PL.zone_fns(z)
    seam_h(m, x0+4, x1-4, int(v(0.6)), CRADLE)
    for f in (0.3, 0.7):
        seam_v(m, int(x0 + (x1-x0)*f), y0+4, y1-4, CRADLE)
    step = (x1 - x0) // 6
    bolts(m, [(x0 + step//2 + i*step, int(v(0.6)) - 8) for i in range(6)],
          r=3, base=CRADLE)
    wear_edges(m, z.rect, STEEL, density=26)

    # cradle roof: team ID patch + panel seams
    z = L.R_TURRET_T
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(STEEL, 1.06), ao=AO_BASE - 6,
         rough=R_STEEL + 8, metal=M_STEEL)
    for f in (1/3, 2/3):
        seam_h(m, x0+2, x1-2, int(y0 + (y1-y0)*f), shade(STEEL, 1.06))
    ut, vt = PL.zone_fns(z)
    PL.team_panel(m, PL.nbox(ut(0.35), vt(0.5), ut(1.05), vt(1.3)),
                  outline=STEEL_DK)
    wear_edges(m, z.rect, shade(STEEL, 0.9), density=20)

    # capacitor drums: ribbed steel with stencil band
    x0, y0, x1, y1 = L.R_CAP.rect
    fill(m, (x0, y0, x1, y1), dif=shade(STEEL, 0.82), ao=AO_BASE - 6,
         rough=R_STEEL, metal=M_STEEL)
    for f in np.linspace(0.12, 0.88, 5):
        gy = int(y0 + (y1-y0)*f)
        m.d.line([(x0+2, gy), (x1-2, gy)], fill=shade(STEEL, 0.68), width=3)
        m.o.line([(x0+2, gy), (x1-2, gy)], fill=(AO_SEAM, R_STEEL, M_STEEL),
                 width=3)
    m.d.rectangle([x0 + (x1-x0)*0.42, y0+8, x0 + (x1-x0)*0.58, y0+22],
                  fill=YELLOW)


def paint_gun(m):
    # breech + sleeve end caps cell: dark machined steel
    x0, y0, x1, y1 = L.R_BREECH.rect
    fill(m, (x0, y0, x1, y1), dif=shade(GUNMETAL, 0.9), ao=AO_BASE - 10,
         rough=R_STEEL - 8, metal=M_STEEL + 20)
    bolts(m, [(x0+16, y0+16), (x1-16, y0+16), (x0+16, y1-16), (x1-16, y1-16)],
          r=4, base=shade(GUNMETAL, 0.9))
    seam_h(m, x0+6, x1-6, (y0+y1)//2, shade(GUNMETAL, 0.9))

    # accelerator sleeve sides: rail lines + thin amber charge strip
    for z, strip in ((L.R_SLV_S, True), (L.R_SLV_T, False)):
        x0, y0, x1, y1 = z.rect
        fill(m, (x0, y0, x1, y1), dif=GUNMETAL, ao=AO_BASE - 6,
             rough=R_STEEL - 6, metal=M_STEEL + 16)
        # longitudinal rail ribs
        for f in (0.2, 0.8):
            gy = int(y0 + (y1-y0)*f)
            m.d.line([(x0+4, gy), (x1-4, gy)], fill=shade(GUNMETAL, 0.72),
                     width=4)
            m.o.line([(x0+4, gy), (x1-4, gy)], fill=(AO_SEAM, R_STEEL, M_STEEL),
                     width=4)
        # segment seams (accelerator stations)
        for f in np.linspace(0.15, 0.85, 5):
            seam_v(m, int(x0 + (x1-x0)*f), y0+4, y1-4, GUNMETAL)
        if strip:
            # the ONLY emissive: subtle amber charge-indicator strip
            sy0, sy1 = (y0+y1)//2 - 4, (y0+y1)//2 + 4
            sx0, sx1 = int(x0 + (x1-x0)*0.12), int(x0 + (x1-x0)*0.82)
            m.d.rectangle([sx0, sy0, sx1, sy1], fill=shade(AMBER, 0.75))
            m.o.rectangle([sx0, sy0, sx1, sy1], fill=(AO_BASE, R_GLASS, M_GLASS))
            m.e.rectangle([sx0, sy0, sx1, sy1], fill=(150, 96, 30))
            # brighter charge pips toward the breech
            for f in (0.16, 0.26, 0.36):
                px = int(x0 + (x1-x0)*f)
                m.e.rectangle([px, sy0+1, px+8, sy1-1], fill=AMBER)

    # emitter tube: gunmetal, banded, soot at the muzzle (right) end
    x0, y0, x1, y1 = L.R_BARREL
    fill(m, (x0, y0, x1, y1), dif=shade(GUNMETAL, 1.05), ao=AO_BASE - 4,
         rough=R_STEEL - 4, metal=M_STEEL + 16)
    for f in (0.1, 0.55, 0.62):
        gx = int(x0 + (x1-x0)*f)
        m.d.line([(gx, y0+2), (gx, y1-2)], fill=shade(GUNMETAL, 0.7), width=3)

    # trim (antenna): dark steel
    fill(m, L.R_TRIM, dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)


def paint_flak(m):
    # flak mount: worn steel, hazard toe stripe on the house
    z = L.R_FLAK
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(STEEL, 0.94), ao=AO_BASE - 6,
         rough=R_STEEL, metal=M_STEEL)
    u, v = PL.zone_fns(z)
    seam_h(m, x0+4, x1-4, int(v(0.2)), shade(STEEL, 0.94))
    bolts(m, [(x0+18, y1-14), ((x0+x1)//2, y1-14), (x1-18, y1-14)],
          r=3, base=shade(STEEL, 0.94))
    wear_edges(m, z.rect, shade(STEEL, 0.94), density=22)

    # flak tubes: dark gunmetal, sooted at the muzzle (right) end
    x0, y0, x1, y1 = L.R_FLAKB
    fill(m, (x0, y0, x1, y1), dif=shade(GUNMETAL, 0.92), ao=AO_BASE - 6,
         rough=R_STEEL, metal=M_STEEL + 10)
    for f in (0.2, 0.75):
        gx = int(x0 + (x1-x0)*f)
        m.d.line([(gx, y0+2), (gx, y1-2)], fill=shade(GUNMETAL, 0.68), width=3)

    # shelf: dark deck plate
    x0, y0, x1, y1 = L.R_SHELF_Z.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)
    bolts(m, [(x0 + 14 + i*((x1-x0-28)//3), (y0+y1)//2) for i in range(4)],
          r=3, base=STEEL_DK)

    # ammo boxes: olive, strap lines, stencil dash
    z = L.R_CRATE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=OLIVE, ao=AO_BASE - 4, rough=R_ARMOR + 10,
         metal=0)
    for f in (0.3, 0.7):
        gx = int(x0 + (x1-x0)*f)
        m.d.line([(gx, y0+2), (gx, y1-2)], fill=shade(OLIVE, 0.72), width=3)
    m.d.rectangle([x0 + (x1-x0)*0.42, (y0+y1)//2 - 5,
                   x0 + (x1-x0)*0.58, (y0+y1)//2 + 5], fill=YELLOW)

    fill(m, L.R_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 16,
         metal=M_ARMOR)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_concrete(m)
    paint_casemate(m)
    paint_turret(m)
    paint_gun(m)
    paint_flak(m)

    wx = PL.standard_weather(
        m, L,
        ground_rects=(L.R_PAD_S.rect,),
        side_zones=(L.R_TIER_S, L.R_CASE_S),
        seed=41, mud=0.42, grime=0.5)
    # extra reads: rain streaks off the casemate roof, rust under plates,
    # soot at the muzzles (railgun + flak), scorch at the sleeve front
    wx.mud_band(L.R_PAD_T.rect, 0.3, fade=None, spatter=True)
    wx.plate_bottom_rust(L.R_CASE_S.rect, n=4, strength=0.4)
    wx.plate_bottom_rust(L.R_TIER_S.rect, n=3, strength=0.35)
    wx.rust_streak(L.R_CASE_S.rect[0] + 46, L.R_CASE_S.rect[1] + 20, 60,
                   width=2.5, strength=0.32)
    wx.rust_streak(L.R_CASE_S.rect[2] - 58, L.R_CASE_S.rect[1] + 20, 48,
                   width=2.0, strength=0.28)
    bx0, by0, bx1, by1 = L.R_BARREL
    wx.soot_patch((int(bx0 + (bx1-bx0)*0.8), by0, bx1, by1), strength=0.7,
                  fade='left')
    fx0, fy0, fx1, fy1 = L.R_FLAKB
    wx.soot_patch((int(fx0 + (fx1-fx0)*0.72), fy0, fx1, fy1), strength=0.6,
                  fade='left')
    sx0, sy0, sx1, sy1 = L.R_SLV_S.rect
    wx.soot_patch((int(sx0 + (sx1-sx0)*0.86), sy0, sx1, sy1), strength=0.35,
                  fade='left')

    PL.finish(m, L, 'ms_staticdefense_s3', wx=wx)


if __name__ == '__main__':
    paint_all()
