"""paint_ms_staticdefense_s4 — 1024^2 PBR set for ms_staticdefense_s4.

Fortress-battery read: weathered poured concrete tiers with pour seams,
form-tie dots and battered shadow bands; hazard slew ring on the barbette
top; bolted-plate ARMOR gunhouse with team chevron + roof numeral 44;
armoured ammo-lift housing with painted blast doors; gunmetal howitzer
(ribbed recoil sleeve, heat-banded tube, sooted multi-baffle brake);
open flak ring on a concrete corner drum. Emissive: the two amber
beacons and a thin optics slit on the mantlet — nothing else lit.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import ms_staticdefense_s4_layout as L   # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024
import paintlib as PL

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, stencil, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, STEEL, STEEL_DK,
                   GLASS, YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS)

W = 1024
CONCRETE = (148, 145, 137)
CONCRETE_DK = (126, 123, 116)
GUNMETAL = (96, 100, 104)
GUNMETAL_DK = (72, 75, 79)
SANDBAG = (150, 136, 106)
CRATE = (122, 106, 78)
AMBER = (255, 176, 64)


def concrete_cell(m, zone, base=CONCRETE, pours=3, ties=True):
    """Poured-concrete face: pour seams + form-tie dots + edge wear."""
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=base, ao=AO_BASE, rough=R_ARMOR + 22, metal=0)
    for i in range(1, pours):
        yy = int(y0 + (y1 - y0) * i / pours)
        m.d.line([(x0 + 2, yy), (x1 - 2, yy)], fill=shade(base, 0.87), width=2)
        m.o.line([(x0 + 2, yy), (x1 - 2, yy)], fill=(AO_SEAM, R_ARMOR + 22, 0), width=2)
    if ties:
        rng = np.random.default_rng(90210)
        for gx in range(int(x0) + 28, int(x1) - 10, 56):
            for gy in range(int(y0) + 20, int(y1) - 8, 44):
                m.d.ellipse([gx - 2, gy - 2, gx + 2, gy + 2],
                            fill=shade(base, 0.78 + rng.random() * 0.08))
    wear_edges(m, zone.rect, base, density=22)


def paint_bastion(m):
    # base tier sides: concrete with a dark plinth band at ground contact
    z = L.R_BASE_S
    concrete_cell(m, z, pours=3)
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    pb = v(0.22)
    m.d.rectangle([x0, pb, x1, y1], fill=CONCRETE_DK)
    m.o.rectangle([x0, pb, x1, y1], fill=(AO_BASE - 14, R_ARMOR + 24, 0))
    # crest hazard strip along the top edge
    PL.hazard_band(m, (x0 + 4, y0 + 2, x1 - 4, y0 + 14))

    # mid tier sides: concrete, faction stencil
    z = L.R_MID_S
    concrete_cell(m, z, pours=2)
    x0, y0, x1, y1 = z.rect
    try:
        stencil(m, (x0 + 36, (y0 + y1) / 2 + 6), 'BSTN 44', 28,
                shade(CONCRETE_DK, 0.62))
    except Exception:
        pass

    # base tier top: concrete deck, painted walk lanes, drain grates
    z = L.R_BASE_T
    concrete_cell(m, z, pours=4)
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    # walk lane from ladder (front) around to the flak drum
    m.d.rectangle([u(1.35), v(-2.9), u(1.95), v(2.0)], fill=shade(CONCRETE, 0.92))
    # perimeter warning line
    m.d.rectangle([x0 + 8, y0 + 8, x1 - 8, y1 - 8], outline=jit(YELLOW, 6), width=4)

    # mid tier top (ring visible around the barbette)
    concrete_cell(m, L.R_MID_T, pours=1, ties=False)

    # barbette wrap: concrete with vertical rebar shadows + bolted crown band
    z = L.R_BARB
    concrete_cell(m, z, pours=2, ties=False)
    x0, y0, x1, y1 = z.rect
    for f in np.linspace(0.08, 0.92, 8):
        gx = x0 + (x1 - x0) * f
        m.d.line([(gx, y0 + 4), (gx, y1 - 4)], fill=shade(CONCRETE, 0.9), width=2)
    m.d.rectangle([x0, y0, x1, y0 + 12], fill=STEEL_DK)
    m.o.rectangle([x0, y0, x1, y0 + 12], fill=(AO_BASE - 8, R_STEEL, M_STEEL))
    bolts(m, [(x0 + 16 + i * ((x1 - x0 - 32) / 11), y0 + 6) for i in range(12)],
          r=2, base=STEEL_DK)

    # barbette top: steel deck + hazard slew ring around the turret race
    z = L.R_BARB_T
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CONCRETE, 0.94), ao=AO_BASE - 4,
         rough=R_ARMOR + 18, metal=0)
    u, v = PL.zone_fns(z)
    cx, cy = u(L.BARB_C[0]), v(L.BARB_C[1])
    r_out, r_in = abs(u(L.BARB_C[0] + 1.72) - cx), abs(u(L.BARB_C[0] + 1.44) - cx)
    # alternating yellow/black arc segments (hazard slew ring)
    for i in range(16):
        a0, a1 = i * 22.5, (i + 1) * 22.5
        col = YELLOW if i % 2 == 0 else BLACKISH
        m.d.arc([cx - r_out, cy - r_out, cx + r_out, cy + r_out],
                start=a0, end=a1, fill=col, width=int(r_out - r_in))
    # slew race: dark steel ring inside the hazard band
    m.d.ellipse([cx - r_in, cy - r_in, cx + r_in, cy + r_in],
                outline=STEEL_DK, width=10)
    m.o.ellipse([cx - r_in, cy - r_in, cx + r_in, cy + r_in],
                outline=(AO_SEAM, R_STEEL, M_STEEL), width=10)


def paint_house(m):
    """Ammo-lift housing: bolted armour plate, blast doors, vents."""
    for z in (L.R_HOUSE, L.R_HOUSE_F):
        x0, y0, x1, y1 = z.rect
        fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 4, rough=R_ARMOR,
             metal=M_ARMOR)
        seam_h(m, x0 + 4, x1 - 4, int(y0 + (y1 - y0) * 0.32), ARMOR)
        bolts(m, [(x0 + 12 + i * ((x1 - x0 - 24) / 5), y0 + 10) for i in range(6)],
              r=3, base=ARMOR)
        wear_edges(m, z.rect, ARMOR, density=18)
    # blast doors on the +x face cell: double leaf, hazard frame, handles
    z = L.R_HOUSE_F
    u, v = PL.zone_fns(z)
    db = PL.nbox(u(2.05), v(3.05), u(2.75), v(1.55))
    PL.hazard_band(m, (db[0] - 10, db[1] - 12, db[2] + 10, db[1] - 4))
    m.d.rectangle(db, fill=ARMOR_DK, outline=shade(ARMOR_DK, 0.55), width=3)
    m.o.rectangle(db, fill=(AO_BASE - 14, R_ARMOR, M_ARMOR))
    mid = (db[0] + db[2]) / 2
    m.d.line([(mid, db[1] + 4), (mid, db[3] - 4)], fill=shade(ARMOR_DK, 0.5), width=3)
    bolts(m, [(db[0] + 8, db[1] + 8), (db[2] - 8, db[1] + 8),
              (db[0] + 8, db[3] - 8), (db[2] - 8, db[3] - 8)], r=3, base=ARMOR_DK)
    vent_slots(m, (db[0] + 10, db[3] - 34, db[2] - 10, db[3] - 12), 3)


def paint_turret(m):
    # gunhouse facets: ARMOR plate, panel seams, team chevron band
    z = L.R_TUR
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 2, rough=R_ARMOR,
         metal=M_ARMOR)
    u, v = PL.zone_fns(z)
    for f in (0.25, 0.5, 0.75):
        seam_v(m, int(x0 + (x1 - x0) * f), y0 + 4, y1 - 4, ARMOR)
    seam_h(m, x0 + 4, x1 - 4, int(v(1.28)), ARMOR)
    bolts(m, [(x0 + 16 + i * ((x1 - x0 - 32) / 9), int(v(1.28)) + 10)
              for i in range(10)], r=3, base=ARMOR)
    # team chevron band low on the gunhouse skirt
    tb = PL.nbox(x0 + 8, v(0.34), x1 - 8, v(0.08))
    PL.team_panel(m, tb, outline=ARMOR_DK)
    wear_edges(m, z.rect, ARMOR, density=26)

    # roof: darker deck, team numeral 44, lifting eyes
    z = L.R_TUR_T
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ARMOR, 0.84), ao=AO_BASE - 6,
         rough=R_ARMOR + 12, metal=M_ARMOR)
    PL.team_panel(m, ((x0 + x1) / 2 - 26, (y0 + y1) / 2 - 26,
                      (x0 + x1) / 2 + 26, (y0 + y1) / 2 + 26), outline=ARMOR_DK)
    try:
        stencil(m, ((x0 + x1) / 2 - 15, (y0 + y1) / 2 - 14), '44', 30, BLACKISH)
    except Exception:
        pass
    bolts(m, [(x0 + 12, y0 + 12), (x1 - 12, y0 + 12), (x0 + 12, y1 - 12),
              (x1 - 12, y1 - 12)], r=3, base=shade(ARMOR, 0.84))
    wear_edges(m, z.rect, shade(ARMOR, 0.84), density=20)

    # mantlet + cupola cell: heavy cast plate, optics slit (thin warm glow)
    z = L.R_MANT
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ARMOR, 0.9), ao=AO_BASE - 8,
         rough=R_ARMOR + 8, metal=M_ARMOR)
    bolts(m, [(x0 + 12 + i * ((x1 - x0 - 24) / 4), y0 + 12) for i in range(5)],
          r=4, base=shade(ARMOR, 0.9))
    sy = int(y0 + (y1 - y0) * 0.42)
    m.d.rectangle([x0 + 20, sy, x1 - 20, sy + 6], fill=(120, 96, 48))
    m.e.rectangle([x0 + 22, sy + 1, x1 - 22, sy + 5], fill=(140, 96, 36))
    wear_edges(m, z.rect, shade(ARMOR, 0.9), density=16)


def paint_guns(m):
    # recoil sleeve: dark gunmetal with rib bands
    fill(m, L.R_SLEEVE, dif=GUNMETAL_DK, ao=AO_BASE - 6, rough=R_STEEL,
         metal=M_STEEL)
    x0, y0, x1, y1 = L.R_SLEEVE
    for f in (0.2, 0.4, 0.6, 0.8):
        gx = x0 + (x1 - x0) * f
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)], fill=shade(GUNMETAL_DK, 0.78), width=3)
        m.o.line([(gx, y0 + 2), (gx, y1 - 2)], fill=(AO_SEAM, R_STEEL, M_STEEL), width=3)
    # main tube: gunmetal, heat banding toward the muzzle (u = breech->muzzle)
    fill(m, L.R_GUN, dif=GUNMETAL, ao=AO_BASE - 4, rough=R_STEEL - 6,
         metal=M_STEEL + 20)
    x0, y0, x1, y1 = L.R_GUN
    for i, f in enumerate((0.62, 0.74, 0.86)):
        gx = x0 + (x1 - x0) * f
        m.d.rectangle([gx - 4, y0 + 2, gx + 4, y1 - 2],
                      fill=shade(GUNMETAL, 0.86 - i * 0.06))
    # muzzle brake: near-black steel, sooted at the tip
    fill(m, L.R_BRAKE, dif=shade(GUNMETAL_DK, 0.8), ao=AO_BASE - 10,
         rough=R_STEEL + 10, metal=M_STEEL)
    # flak tubes: same gunmetal
    fill(m, L.R_FLAKB, dif=GUNMETAL, ao=AO_BASE - 4, rough=R_STEEL - 6,
         metal=M_STEEL + 20)
    # flak gunhouse cell: ARMOR with a small team square
    z = L.R_FLAK
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 4, rough=R_ARMOR,
         metal=M_ARMOR)
    PL.team_panel(m, (x0 + 12, y0 + 12, x0 + 44, y0 + 44), outline=ARMOR_DK)
    seam_h(m, x0 + 4, x1 - 4, int((y0 + y1) / 2), ARMOR)
    wear_edges(m, z.rect, ARMOR, density=16)


def paint_details(m):
    # flak drum: concrete like the bastion
    concrete_cell(m, L.R_DRUM, pours=3)
    concrete_cell(m, L.R_DRUM_T, pours=1, ties=False)
    x0, y0, x1, y1 = L.R_DRUM_T.rect
    m.d.rectangle([x0 + 6, y0 + 6, x1 - 6, y1 - 6], outline=jit(YELLOW, 6), width=3)

    # sandbags: canvas courses
    z = L.R_SAND
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=SANDBAG, ao=AO_BASE - 6, rough=R_ARMOR + 26,
         metal=0)
    rng = np.random.default_rng(90210)
    for gy in range(int(y0), int(y1), 24):
        m.d.line([(x0 + 2, gy), (x1 - 2, gy)], fill=shade(SANDBAG, 0.82), width=2)
        for gx in range(int(x0) + 12 + (gy // 24 % 2) * 14, int(x1) - 6, 30):
            m.d.line([(gx, gy), (gx, gy + 24)], fill=shade(SANDBAG, 0.86), width=2)

    # crates / lockers: stencilled timber-and-steel
    z = L.R_CRATE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=CRATE, ao=AO_BASE - 6, rough=R_ARMOR + 20,
         metal=0)
    m.d.rectangle([x0 + 4, y0 + 4, x1 - 4, y1 - 4], outline=shade(CRATE, 0.7),
                  width=3)
    m.d.line([(x0 + 4, y0 + 4), (x1 - 4, y1 - 4)], fill=shade(CRATE, 0.78), width=3)
    try:
        stencil(m, (x0 + 18, (y0 + y1) / 2 - 10), 'HE-155', 20,
                shade(CRATE, 0.5))
    except Exception:
        pass

    # trim wrap (ladder, aerial, buttresses = concrete-grey steel)
    fill(m, L.R_TRIM, dif=shade(CONCRETE_DK, 0.92), ao=AO_BASE - 8,
         rough=R_ARMOR + 14, metal=M_STEEL - 30)

    # beacons: amber emissive glow cell
    z = L.R_BEACON
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=AMBER, ao=AO_BASE, rough=R_GLASS, metal=0)
    m.e.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2], fill=AMBER)

    # dark cell (caps, undersides)
    fill(m, L.R_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 16,
         metal=M_ARMOR)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_bastion(m)
    paint_house(m)
    paint_turret(m)
    paint_guns(m)
    paint_details(m)

    wx = PL.standard_weather(
        m, L,
        ground_rects=(L.R_SAND.rect,),
        side_zones=(L.R_BASE_S, L.R_MID_S, L.R_DRUM),
        seed=41, mud=0.4, grime=0.5, rust_fraction=0.45)
    # rust streaks under the crown-band bolts down the barbette concrete
    bx0, by0, bx1, _ = L.R_BARB.rect
    for f in (0.16, 0.42, 0.7, 0.88):
        wx.rust_streak(bx0 + (bx1 - bx0) * f, by0 + 14, 52, width=2.4,
                       strength=0.34)
    # rain rust off the blast-door frame
    hx0, hy0, hx1, hy1 = L.R_HOUSE_F.rect
    wx.rust_streak(hx0 + 40, hy0 + 26, 44, width=2.2, strength=0.3)
    wx.plate_bottom_rust(L.R_HOUSE.rect, n=4, strength=0.4)
    wx.plate_bottom_rust(L.R_TUR.rect, n=5, strength=0.35)
    # muzzle soot: tip half of the brake cell + tube muzzle end
    gx0, gy0, gx1, gy1 = L.R_BRAKE
    wx.soot_patch((int(gx0 + (gx1 - gx0) * 0.45), gy0, gx1, gy1), strength=0.8)
    tx0, ty0, tx1, ty1 = L.R_GUN
    wx.soot_patch((int(tx0 + (tx1 - tx0) * 0.8), ty0, tx1, ty1), strength=0.5,
                  fade='left')
    # base grime at ground contact
    wx.mud_band(L.R_BASE_S.rect, 0.55, fade='down')

    PL.finish(m, L, 'ms_staticdefense_s4', wx=wx)


if __name__ == '__main__':
    paint_all()
