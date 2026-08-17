"""paint_ms_staticdefense_s2 — 1024² PBR set for ms_staticdefense_s2.

Defense Battery read: weathered poured-concrete casemate (pour seams,
form ties, entry door, resupply hatch, wall vents), hazard-chevron slew
ring on the turret, riveted steel plinth, ARMOR gunhouse with team
chevron + roof numeral 22, heat-banded gunmetal twin tubes with muzzle
soot, open flak pintle in dark steel, sandbags/crates at the base.
Emissive: the amber perimeter beacon ONLY.
"""
from __future__ import annotations
import numpy as np
from PIL import ImageFilter

import ms_staticdefense_s2_layout as L   # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024
import paintlib as PL

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   shade, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, STEEL, STEEL_DK,
                   YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS)

W = 1024
CONCRETE = (148, 145, 138)
CONC_DK = shade(CONCRETE, 0.88)
GUNMETAL = (82, 84, 88)
SAND = (167, 148, 110)
WOOD = (108, 99, 72)
AMBER = (255, 176, 64)


def paint_casemate(m):
    # roof: concrete deck, expansion joints, hazard slew ring, team square
    z = L.R_ROOF
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE, rough=R_ARMOR + 22,
         metal=0)
    u, v = PL.zone_fns(z)
    for f in (1 / 3, 2 / 3):
        m.d.line([(x0 + (x1 - x0) * f, y0 + 2), (x0 + (x1 - x0) * f, y1 - 2)],
                 fill=shade(CONCRETE, 0.87), width=2)
        m.d.line([(x0 + 2, y0 + (y1 - y0) * f), (x1 - 2, y0 + (y1 - y0) * f)],
                 fill=shade(CONCRETE, 0.87), width=2)
    # hazard annulus around the slew plinth (centre world x0, z0.4)
    cx, cy = u(0.0), v(0.4)
    r_in = abs(u(1.20) - u(0.0))
    r_out = abs(u(1.48) - u(0.0))
    for i in range(24):
        a0 = 2 * np.pi * i / 24
        a1 = 2 * np.pi * (i + 1) / 24
        col = YELLOW if i % 2 == 0 else BLACKISH
        pts = [(cx + r_in * np.cos(a0), cy + r_in * np.sin(a0)),
               (cx + r_out * np.cos(a0), cy + r_out * np.sin(a0)),
               (cx + r_out * np.cos(a1), cy + r_out * np.sin(a1)),
               (cx + r_in * np.cos(a1), cy + r_in * np.sin(a1))]
        m.d.polygon(pts, fill=col)
    # team ID square, front-left roof quadrant
    PL.team_panel(m, PL.nbox(u(-2.0), v(-1.0), u(-1.3), v(-0.3)),
                  outline=CONC_DK)
    wear_edges(m, z.rect, CONCRETE, density=24)

    # lower-slab ledge: darker pour, anchor plates at the corners
    z = L.R_LEDGE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=CONC_DK, ao=AO_BASE - 6, rough=R_ARMOR + 22,
         metal=0)
    u, v = PL.zone_fns(z)
    for wx_ in (-2.45, 2.45):
        for wz_ in (-2.25, 2.65):
            px, py = u(wx_), v(wz_)
            m.d.rectangle([px - 12, py - 12, px + 12, py + 12], fill=STEEL_DK)
            bolts(m, [(px - 7, py - 7), (px + 7, py - 7), (px - 7, py + 7),
                      (px + 7, py + 7)], r=3, base=STEEL_DK)

    # lower walls: pour seams + form ties; entry door on the ±x faces
    for z2, has_door in ((L.R_WALL_LO, True), (L.R_WALL_LO_F, False)):
        x0, y0, x1, y1 = z2.rect
        fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE - 4,
             rough=R_ARMOR + 22, metal=0)
        u, v = PL.zone_fns(z2)
        seam_h(m, x0 + 4, x1 - 4, int(v(0.55)), CONCRETE)
        for f in (0.2, 0.45, 0.7):
            tx = x0 + (x1 - x0) * f
            for ty in (0.3, 0.8):
                m.d.ellipse([tx - 3, v(ty) - 3, tx + 3, v(ty) + 3],
                            fill=shade(CONCRETE, 0.8))
        if has_door:
            db = PL.nbox(u(0.5), v(1.08), u(1.3), v(0.02))
            m.d.rectangle(db, fill=ARMOR_DK, outline=shade(ARMOR_DK, 0.55),
                          width=3)
            m.o.rectangle(db, fill=(AO_BASE - 14, R_ARMOR, M_ARMOR))
            m.d.rectangle([db[2] - 12, (db[1] + db[3]) / 2 - 3, db[2] - 5,
                           (db[1] + db[3]) / 2 + 3], fill=STEEL)
            bolts(m, [(db[0] + 8, db[1] + 8), (db[2] - 8, db[1] + 8)],
                  r=3, base=ARMOR_DK)
        else:
            # resupply hatch outline on the front/back faces
            hb = PL.nbox(u(-1.6), v(0.9), u(-0.6), v(0.15))
            m.d.rectangle(hb, fill=CONC_DK, outline=STEEL_DK, width=3)
            bolts(m, [(hb[0] + 10, hb[1] + 10), (hb[2] - 10, hb[1] + 10),
                      (hb[0] + 10, hb[3] - 10), (hb[2] - 10, hb[3] - 10)],
                  r=3, base=CONC_DK)
        wear_edges(m, z2.rect, CONCRETE, density=20)

    # upper walls: concrete with a steel vent strip + stencil
    for z2 in (L.R_WALL_UP, L.R_WALL_UP_F):
        x0, y0, x1, y1 = z2.rect
        fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE - 4,
             rough=R_ARMOR + 22, metal=0)
        u, v = PL.zone_fns(z2)
        vb = PL.nbox(u(1.0), v(1.7), u(1.9), v(1.35))
        m.d.rectangle(vb, fill=STEEL_DK)
        m.o.rectangle(vb, fill=(AO_BASE - 10, R_STEEL, M_STEEL))
        vent_slots(m, (vb[0] + 6, vb[1] + 6, vb[2] - 6, vb[3] - 6), 3)
        f = PL.font(30)
        m.d.text((u(-1.8), v(1.7)), 'BTY-22', font=f, fill=(210, 205, 190))
        wear_edges(m, z2.rect, CONCRETE, density=18)


def paint_turret(m):
    # gunhouse sides: armour plates, seams, team chevron band
    for z in (L.R_GH, L.R_GH_F):
        x0, y0, x1, y1 = z.rect
        fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 4, rough=R_ARMOR,
             metal=M_ARMOR)
        u, v = PL.zone_fns(z)
        seam_h(m, x0 + 4, x1 - 4, int(v(0.72)), ARMOR)
        for f in (0.3, 0.62):
            seam_v(m, int(x0 + (x1 - x0) * f), y0 + 4, y1 - 4, ARMOR)
        # team chevron band along the lower plate
        tb = PL.nbox(x0 + 10, int(v(0.42)), x1 - 10, int(v(0.28)))
        PL.team_panel(m, tb, outline=ARMOR_DK)
        bolts(m, [(x0 + 16 + i * ((x1 - x0 - 32) / 5), y1 - 10)
                  for i in range(6)], base=ARMOR)
        wear_edges(m, z.rect, ARMOR, density=22)

    # gunhouse top: darker plate, hatch ring, numeral 22
    z = L.R_GH_T
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ARMOR, 0.85), ao=AO_BASE - 6,
         rough=R_ARMOR + 10, metal=M_ARMOR)
    u, v = PL.zone_fns(z)
    hx, hy = u(-0.45), v(0.55)
    m.d.ellipse([hx - 26, hy - 26, hx + 26, hy + 26], fill=ARMOR_DK,
                outline=shade(ARMOR_DK, 0.6), width=3)
    m.o.ellipse([hx - 26, hy - 26, hx + 26, hy + 26],
                fill=(AO_BASE - 12, R_ARMOR, M_ARMOR))
    f = PL.font(56)
    m.d.text((u(0.15), v(0.1)), '22', font=f, fill=(216, 212, 198))
    wear_edges(m, z.rect, shade(ARMOR, 0.85), density=20)

    # mantlet: dark armour, bolted
    z = L.R_MANT
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 8, rough=R_ARMOR,
         metal=M_ARMOR)
    bolts(m, [(x0 + 12, y0 + 12), (x1 - 12, y0 + 12), (x0 + 12, y1 - 12),
              (x1 - 12, y1 - 12)], r=3, base=ARMOR_DK)

    # slew ring: hazard chevrons (the spec's hazard-striped slew ring)
    PL.hazard_band(m, L.R_RING.rect)

    # plinth: riveted dark steel
    z = L.R_PLINTH
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)
    bolts(m, [(x0 + 12 + i * ((x1 - x0 - 24) / 9), (y0 + y1) / 2)
              for i in range(10)], r=3, base=STEEL_DK)


def paint_guns(m):
    # main tubes: gunmetal, heat bands + soot toward the muzzle (u=x1)
    x0, y0, x1, y1 = L.R_BARREL
    fill(m, (x0, y0, x1, y1), dif=GUNMETAL, ao=AO_BASE - 6, rough=R_STEEL - 8,
         metal=M_STEEL + 20)
    for f, k in ((0.68, 0.9), (0.78, 0.82), (0.86, 0.72)):
        gx = x0 + (x1 - x0) * f
        m.d.rectangle([gx, y0 + 2, gx + 8, y1 - 2], fill=shade(GUNMETAL, k))
    m.d.rectangle([x0 + (x1 - x0) * 0.9, y0 + 2, x1 - 2, y1 - 2],
                  fill=shade(GUNMETAL, 0.55))
    # flak tube: same treatment
    x0, y0, x1, y1 = L.R_FLAKB
    fill(m, (x0, y0, x1, y1), dif=GUNMETAL, ao=AO_BASE - 6, rough=R_STEEL - 8,
         metal=M_STEEL + 20)
    m.d.rectangle([x0 + (x1 - x0) * 0.85, y0 + 2, x1 - 2, y1 - 2],
                  fill=shade(GUNMETAL, 0.55))
    # tube end caps
    x0, y0, x1, y1 = L.R_CAP.rect
    fill(m, (x0, y0, x1, y1), dif=shade(GUNMETAL, 0.6), ao=AO_BASE - 12,
         rough=R_STEEL, metal=M_STEEL)

    # trim wrap: dark steel (antenna, pedestal, yoke, cross-yoke)
    fill(m, L.R_TRIM, dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)

    # flak mount zone: dark steel with a band for the ammo drum
    z = L.R_FLAK
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)
    u, v = PL.zone_fns(z)
    m.d.rectangle([x0 + 4, v(0.5), x1 - 4, v(0.34)], fill=shade(STEEL_DK, 1.2))
    bolts(m, [(x0 + 14 + i * ((x1 - x0 - 28) / 4), y1 - 12) for i in range(5)],
          r=3, base=STEEL_DK)


def paint_clutter(m):
    # sandbags: course bands + patch jitter
    z = L.R_SAND
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=SAND, ao=AO_BASE - 4, rough=R_ARMOR + 30,
         metal=0)
    rng = np.random.default_rng(90210)
    for cy in np.linspace(y0 + 14, y1 - 14, 4):
        m.d.line([(x0 + 2, cy), (x1 - 2, cy)], fill=shade(SAND, 0.82), width=3)
    for _ in range(26):
        px = rng.uniform(x0 + 6, x1 - 16)
        py = rng.uniform(y0 + 6, y1 - 12)
        m.d.rectangle([px, py, px + rng.uniform(8, 22), py + rng.uniform(4, 9)],
                      fill=shade(SAND, rng.uniform(0.86, 1.12)))

    # crates: olive planks + strapping
    z = L.R_CRATE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=WOOD, ao=AO_BASE - 4, rough=R_ARMOR + 24,
         metal=0)
    for f in (0.33, 0.66):
        m.d.line([(x0 + 2, y0 + (y1 - y0) * f), (x1 - 2, y0 + (y1 - y0) * f)],
                 fill=shade(WOOD, 0.8), width=2)
    for f in (0.25, 0.75):
        gx = x0 + (x1 - x0) * f
        m.d.rectangle([gx - 3, y0 + 2, gx + 3, y1 - 2], fill=STEEL_DK)

    # roof vent box: dark armour + louvres
    z = L.R_VENT
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 8, rough=R_ARMOR,
         metal=M_ARMOR)
    vent_slots(m, (x0 + 14, y0 + 20, x1 - 14, y1 - 20), 4)

    # ammo hatch box: steel plate, hazard corners, bolts
    z = L.R_HATCH
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)
    PL.hazard_band(m, (x0 + 4, y0 + 4, x1 - 4, y0 + 18))
    bolts(m, [(x0 + 10, y1 - 10), (x1 - 10, y1 - 10),
              ((x0 + x1) / 2, y1 - 10)], r=3, base=STEEL_DK)

    # beacon: amber lens — the ONLY emissive on the model
    x0, y0, x1, y1 = L.R_BEACON.rect
    fill(m, (x0, y0, x1, y1), dif=AMBER, ao=AO_BASE, rough=R_GLASS,
         metal=M_GLASS)
    m.e.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2], fill=AMBER)

    fill(m, L.R_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 16,
         metal=M_ARMOR)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_casemate(m)
    paint_turret(m)
    paint_guns(m)
    paint_clutter(m)

    wx = PL.standard_weather(
        m, L,
        ground_rects=(L.R_SAND.rect, L.R_CRATE.rect),
        side_zones=(L.R_WALL_LO, L.R_WALL_LO_F, L.R_WALL_UP, L.R_WALL_UP_F),
        seed=41, mud=0.45, grime=0.5)
    # rain-streak rust off the roof edge down the concrete
    for z in (L.R_WALL_UP, L.R_WALL_UP_F):
        x0, y0, x1, y1 = z.rect
        wx.rust_streak(x0 + 60, y0 + 8, 60, width=2.5, strength=0.32)
        wx.rust_streak(x1 - 80, y0 + 8, 46, width=2.0, strength=0.28)
    for z in (L.R_GH, L.R_GH_F):
        wx.plate_bottom_rust(z.rect, n=4, strength=0.4)
    wx.plate_bottom_rust(L.R_PLINTH.rect, n=3, strength=0.45)

    PL.finish(m, L, 'ms_staticdefense_s2', wx=wx)


if __name__ == '__main__':
    paint_all()
