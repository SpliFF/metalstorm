"""paint_ms_mechs_s3 — texture painter for the scale-3 heavy assault walker.

Same faction language as ms_mechs_s2 / fable_mech: gunmetal armour with
mismatched field-replaced plates, hazard striping on the gun tip and brow,
soot at the exhaust and muzzle, rust streaks under fittings, grime at the
feet. Register is LINE MILITARY HEAVY. Human tech -> AMBER emissive only
(vision slit glow, running lamps, vent heat), never cyan. NO glass anywhere
— the casemate head gets a painted vision slit, not a canopy.
"""
from __future__ import annotations
import numpy as np

import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024

import paintlib as PL
from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   shade, jit, stencil, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, LOWER, STEEL, STEEL_DK,
                   TRACK_MET, YELLOW, BLACKISH,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_RUBBER,
                   M_ARMOR, M_STEEL, M_TRACK)
import ms_mechs_s3_layout as M

W = 1024
STEM = 'ms_mechs_s3'
TEAM_BASE = (120, 124, 128)          # held near the hull grey (impostor-safe)
AMBER = (255, 150, 40)               # slit / lamp glow
AMBER_DIM = (120, 62, 14)
# tone-on-tone patch palette: the torso front/rear loft caps are triangle
# fans and the baker flat-shades each fan triangle, so high-contrast cells
# there flood whole wedges (seen on the first bake).
PATCH_PAL = (ARMOR, jit(ARMOR, 6), ARMOR_DK, jit(ARMOR, 4),
             (96, 100, 106), (88, 96, 104))
HULL_NO = '31'


def px(zone, world):
    u, v = zone.uv(world)
    return u * W, v * W


# ---------------------------------------------------------------- torso ---

def paint_torso(m):
    for zone in (M.M_TORSO_FRONT, M.M_TORSO_SIDE, M.M_TORSO_REAR):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=ARMOR)
        # armoured midriff below the waist line — kept tone-on-tone so the
        # loft cap fans (flat-shaded by the impostor baker) stay calm
        wy = int(px(zone, (0, 0.45, 0))[1])
        m.d.rectangle([x0, wy, x1, y1], fill=shade(ARMOR, 0.88))
        m.o.rectangle([x0, wy, x1, y1], fill=(AO_BASE - 30, R_ARMOR, M_ARMOR))
        seam_h(m, x0 + 2, x1 - 2, wy, ARMOR)
        wear_edges(m, (x0, y0, x1, wy), ARMOR, 30)

    # ---- chest: sloped glacis plates, team chevron, hull numeral
    zone = M.M_TORSO_FRONT
    x0, y0, x1, y1 = zone.rect
    PL.panel_patchwork(m, (x0 + 6, y0 + 6, x1 - 6, y0 + 70), PATCH_PAL, 3, 2)
    for wy in (1.30, 0.85):
        seam_h(m, x0 + 2, x1 - 2, int(px(zone, (0, wy, 0))[1]), ARMOR)
    cx, cy = px(zone, (0.0, 1.05, 0))
    chev = [(cx - 46, cy + 26), (cx, cy - 6), (cx + 46, cy + 26),
            (cx + 46, cy + 44), (cx, cy + 12), (cx - 46, cy + 44)]
    m.t.polygon(chev, fill=(255, 0, 0))
    m.d.polygon(chev, fill=TEAM_BASE)
    stencil(m, (x0 + 12, y1 - 42), HULL_NO, 30, (188, 192, 196), bridge=False)
    bolts(m, [(x0 + 14 + i * ((x1 - x0 - 28) / 5), y0 + 12) for i in range(6)],
          base=ARMOR)

    # ---- side: intake slats, stowage roll, seams
    zone = M.M_TORSO_SIDE
    x0, y0, x1, y1 = zone.rect
    iu0, iv0 = px(zone, (0, 1.35, -0.20))
    iu1, iv1 = px(zone, (0, 0.95, 0.45))
    ib = PL.nbox(iu0, iv0, iu1, iv1)
    m.d.rectangle(ib, fill=STEEL_DK)
    m.o.rectangle(ib, fill=(AO_BASE - 40, R_STEEL, M_STEEL))
    vent_slots(m, [ib[0] + 3, ib[1] + 3, ib[2] - 3, ib[3] - 3], 5)
    su0, sv0 = px(zone, (0, 0.80, -0.95))
    su1, sv1 = px(zone, (0, 0.55, -0.30))
    m.d.rectangle(PL.nbox(su0, sv0, su1, sv1), fill=(84, 76, 58))   # tarp roll
    seam_v(m, int(px(zone, (0, 0, -0.60))[0]), y0 + 3, y1 - 3, ARMOR)
    bolts(m, [(x0 + 18, y0 + 16), (x1 - 18, y0 + 16)], base=ARMOR)

    # ---- rear: engine access panel + numeral
    zone = M.M_TORSO_REAR
    x0, y0, x1, y1 = zone.rect
    m.d.rectangle([x0 + 30, y0 + 40, x1 - 30, y0 + 100], fill=ARMOR_DK)
    m.o.rectangle([x0 + 30, y0 + 40, x1 - 30, y0 + 100],
                  fill=(AO_BASE - 20, R_ARMOR, M_ARMOR))
    bolts(m, [(x0 + 38 + i * ((x1 - x0 - 76) / 3), y0 + 48) for i in range(4)],
          base=ARMOR_DK)
    stencil(m, (x1 - 82, y0 + 110), HULL_NO, 32, (182, 186, 190), bridge=False)


def paint_torso_top(m):
    zone = M.M_TORSO_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    for wz in (-0.55, 0.15, 0.65):
        seam_h(m, x0 + 3, x1 - 3, int(px(zone, (0, 0, wz))[1]), ARMOR)
    for wx in (-0.70, 0.70):
        seam_v(m, int(px(zone, (wx, 0, 0))[0]), y0 + 3, y1 - 3, ARMOR)
    # team roof wedge (reads for the player camera)
    a = px(zone, (-0.36, 0, 0.42))
    b = px(zone, (0.36, 0, 0.42))
    c = px(zone, (0.0, 0, -0.10))
    m.t.polygon([a, b, c], fill=(255, 0, 0))
    m.d.polygon([a, b, c], fill=TEAM_BASE)
    nu, nv = px(zone, (0.85, 0, 0.55))
    stencil(m, (nu - 24, nv - 18), HULL_NO, 36, (196, 200, 204), bridge=False)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 34)


def paint_pelvis_and_dark(m):
    fill(m, M.M_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)
    zone = M.M_PELVIS
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=LOWER, ao=AO_BASE - 25)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, LOWER)
    bolts(m, [(x0 + 12 + i * ((x1 - x0 - 24) / 4), y0 + 14) for i in range(5)],
          base=LOWER)
    m.d.rectangle([x0 + 10, y1 - 26, x1 - 10, y1 - 14], fill=STEEL_DK)
    m.o.rectangle([x0 + 10, y1 - 26, x1 - 10, y1 - 14],
                  fill=(AO_DEEP, R_STEEL, M_STEEL))
    wear_edges(m, (x0, y0, x1, y1), LOWER, 34)


# ------------------------------------------------------------- casemate ---

def paint_head(m):
    """Armoured slab cockpit: vision slit with a faint amber interior glow,
    heavy bolted plates, running lamps. NO glazing."""
    # --- front face: the slit
    zone = M.H_FRONT
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    su0, sv0 = px(zone, (-0.50, 2.72, 0))
    su1, sv1 = px(zone, (0.50, 2.58, 0))
    sb = PL.nbox(su0, sv0, su1, sv1)
    m.d.rectangle(sb, fill=(26, 28, 30))
    m.o.rectangle(sb, fill=(AO_DEEP - 30, 60, 30))
    # slit mullions + a thin amber interior glow line
    sw = sb[2] - sb[0]
    for k in (1, 2, 3):
        mx = sb[0] + sw * k / 4
        m.d.rectangle([mx - 2, sb[1], mx + 2, sb[3]], fill=ARMOR_DK)
    m.e.rectangle([sb[0] + 4, sb[3] - 5, sb[2] - 4, sb[3] - 2], fill=AMBER_DIM)
    # bolted cheek plates below the slit
    m.d.rectangle([x0 + 6, sb[3] + 8, x1 - 6, y1 - 8], fill=ARMOR)
    m.o.rectangle([x0 + 6, sb[3] + 8, x1 - 6, y1 - 8],
                  fill=(AO_BASE - 15, R_ARMOR, M_ARMOR))
    bolts(m, [(x0 + 20 + i * ((x1 - x0 - 40) / 4), sb[3] + 18)
              for i in range(5)], base=ARMOR)
    # amber running lamps at the cheek corners
    PL.headlight(m, (x0 + 12, y1 - 40, x0 + 36, y1 - 20), lamp=AMBER)
    PL.headlight(m, (x1 - 36, y1 - 40, x1 - 12, y1 - 20), lamp=AMBER)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 26)

    # --- sides: bolted slab + pistol-port plug
    zone = M.H_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    seam_h(m, x0 + 3, x1 - 3, int(px(zone, (0, 2.52, 0))[1]), ARMOR_DK)
    pu, pv = px(zone, (0, 2.72, -0.55))
    m.d.ellipse([pu - 10, pv - 10, pu + 10, pv + 10], fill=(50, 52, 54))
    m.o.ellipse([pu - 10, pv - 10, pu + 10, pv + 10],
                fill=(AO_DEEP, R_STEEL, M_STEEL))
    bolts(m, [(x0 + 16 + i * ((x1 - x0 - 32) / 3), y1 - 20) for i in range(4)],
          base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 24)

    # --- casemate top (under the roof slab)
    zone = M.H_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, ARMOR)
    bolts(m, [(x0 + 18, y0 + 16), (x1 - 18, y0 + 16),
              (x0 + 18, y1 - 16), (x1 - 18, y1 - 16)], base=ARMOR)

    # --- rear plate
    zone = M.H_REAR
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    m.d.rectangle([x0 + 22, y0 + 30, x1 - 22, y1 - 30], fill=ARMOR_DK)
    m.o.rectangle([x0 + 22, y0 + 30, x1 - 22, y1 - 30],
                  fill=(AO_BASE - 20, R_ARMOR, M_ARMOR))
    bolts(m, [(x0 + 30, y0 + 38), (x1 - 30, y0 + 38),
              (x0 + 30, y1 - 38), (x1 - 30, y1 - 38)], base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 26)

    # --- roof slab
    zone = M.M_ROOF
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_LT, ao=AO_BASE - 8)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, ARMOR_LT)
    bolts(m, [(x0 + 14, y0 + 12), (x1 - 14, y0 + 12),
              (x0 + 14, y1 - 12), (x1 - 14, y1 - 12)], base=ARMOR_LT)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 26)

    # --- brow lip: hazard-edged armour over the slit
    x0, y0, x1, y1 = M.M_BROW.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 18)
    PL.hazard_band(m, (x0 + 3, y1 - 16, x1 - 3, y1 - 4), step=11)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 30)

    # --- chin sensor block: dark housing, one small amber optic
    zone = M.M_SENSOR
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(46, 48, 50), ao=AO_BASE - 30,
         rough=170, metal=120)
    cxp, cyp = (x0 + x1) / 2, y0 + (y1 - y0) * 0.60
    m.d.ellipse([cxp - 7, cyp - 7, cxp + 7, cyp + 7], fill=(30, 26, 22))
    m.e.ellipse([cxp - 4, cyp - 4, cxp + 4, cyp + 4], fill=AMBER)


def paint_hatch(m):
    zone = M.M_HATCH
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_LT, ao=AO_BASE - 10)
    m.d.rectangle([x0 + 5, y0 + 5, x1 - 5, y1 - 5], outline=shade(ARMOR, 0.5),
                  width=2)
    cxp, cyp = (x0 + x1) / 2, (y0 + y1) / 2
    m.d.ellipse([cxp - 10, cyp - 10, cxp + 10, cyp + 10], fill=STEEL_DK)
    bolts(m, [(x0 + 12, y0 + 12), (x1 - 12, y0 + 12),
              (x0 + 12, y1 - 12), (x1 - 12, y1 - 12)], base=ARMOR_LT)
    stencil(m, (x0 + 8, y1 - 24), 'CREW', 12, YELLOW, bridge=False)


def paint_backpack(m):
    zone = M.M_AMMO_BIN
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    PL.panel_patchwork(m, (x0 + 6, y0 + 6, x1 - 6, y1 - 36), PATCH_PAL, 3, 2)
    m.d.rectangle([x0 + 8, y1 - 32, x1 - 8, y1 - 8], fill=STEEL_DK)
    m.o.rectangle([x0 + 8, y1 - 32, x1 - 8, y1 - 8],
                  fill=(AO_BASE - 30, R_STEEL, M_STEEL))
    stencil(m, (x0 + 14, y1 - 30), '90 mm AP-T x240', 16, YELLOW, bridge=False)
    bolts(m, [(x0 + 16 + i * ((x1 - x0 - 32) / 5), y0 + 14) for i in range(6)],
          base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 30)

    zone = M.M_VENTS
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(60, 56, 54), ao=AO_BASE - 35,
         rough=190, metal=160)
    vent_slots(m, [x0 + 10, y0 + 12, x1 - 10, y1 - 12], 6, glow=(150, 58, 14))


def paint_pauldron(m):
    zone = M.M_PAULDRON
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    panel = (x0 + 16, y0 + 14, x1 - 16, y1 - 32)
    PL.team_panel(m, panel, outline=ARMOR, base=TEAM_BASE)
    # mask-cutout chevron inside the team panel (survives the team respray)
    cxp = (panel[0] + panel[2]) / 2
    ph = panel[3] - panel[1]
    chev = [(cxp - 24, panel[1] + ph * 0.64), (cxp, panel[1] + ph * 0.26),
            (cxp + 24, panel[1] + ph * 0.64), (cxp + 24, panel[1] + ph * 0.84),
            (cxp, panel[1] + ph * 0.46), (cxp - 24, panel[1] + ph * 0.84)]
    m.t.polygon(chev, fill=(0, 0, 0))
    m.d.polygon(chev, fill=(44, 48, 52))
    PL.hazard_band(m, (x0 + 6, y1 - 24, x1 - 6, y1 - 8), step=13)
    bolts(m, [(x0 + 10, y0 + 8), (x1 - 10, y0 + 8)], base=ARMOR)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 26)


# ---------------------------------------------------------------- limbs ---

def paint_limbs(m):
    for rect, tag in ((M.M_THIGH, 'thigh'), (M.M_SHIN, 'shin')):
        x0, y0, x1, y1 = rect
        fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 10)
        m.d.rectangle([x0, y0, x0 + 16, y1], fill=STEEL_DK)
        m.d.rectangle([x1 - 16, y0, x1, y1], fill=STEEL_DK)
        m.o.rectangle([x0, y0, x0 + 16, y1], fill=(AO_DEEP, R_STEEL, M_STEEL))
        m.o.rectangle([x1 - 16, y0, x1, y1], fill=(AO_DEEP, R_STEEL, M_STEEL))
        bh = (y1 - y0) / 8
        m.d.rectangle([x0 + 20, y0 + 3 * bh, x1 - 20, y0 + 5 * bh],
                      fill=jit(ARMOR, 3))
        seam_v(m, int((x0 + x1) / 2), y0 + 2, y1 - 2, ARMOR_DK)
        wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 30)

    # hip actuator piston: bright working rod
    x0, y0, x1, y1 = M.M_PISTON
    fill(m, (x0, y0, x1, y1), dif=(150, 155, 160), ao=AO_BASE,
         rough=90, metal=230)
    m.d.rectangle([x0, y0, x0 + (x1 - x0) // 3, y1], fill=STEEL_DK)

    # joint stubs
    x0, y0, x1, y1 = M.M_JOINT
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 25, rough=140,
         metal=190)
    for i in range(8):
        sx = x0 + (x1 - x0) * i / 8
        m.d.line([(sx, y0), (sx, y1)], fill=BLACKISH, width=2)
    r = M.M_JOINT_CAP.rect
    fill(m, r, dif=TRACK_MET, ao=AO_BASE - 15, rough=130, metal=M_TRACK)
    cxp, cyp = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    m.d.ellipse([cxp - 8, cyp - 8, cxp + 8, cyp + 8], fill=STEEL_DK)
    bolts(m, [(cxp + np.cos(a) * 17, cyp + np.sin(a) * 17)
              for a in np.linspace(0.3, 2 * np.pi + 0.3, 6, endpoint=False)],
          base=TRACK_MET)

    # armoured shin plate: tone-on-tone band + rivets
    zone = M.M_SHINPLATE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_LT, ao=AO_BASE - 8)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, ARMOR_LT)
    bolts(m, [(x0 + 16 + i * ((x1 - x0 - 32) / 4), y0 + 16) for i in range(5)],
          base=ARMOR_LT)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 34)
    x0, y0, x1, y1 = M.M_SHINPLATE_WRAP
    fill(m, (x0, y0, x1, y1), dif=ARMOR_LT, ao=AO_BASE - 15)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, ARMOR_LT)

    # feet: toe cap / heel seams, cleated sole wrap, toe boxes
    zone = M.M_FOOT_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 20)
    seam_v(m, int(px(zone, (0, 0, -0.55))[0]), y0 + 2, y1 - 2, LOWER)  # toe
    seam_v(m, int(px(zone, (0, 0, 0.45))[0]), y0 + 2, y1 - 2, LOWER)   # heel
    bolts(m, [(px(zone, (0, -0.16, z))[0], px(zone, (0, -0.16, z))[1])
              for z in (-0.62, -0.20, 0.20, 0.52)], base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), LOWER, 44)
    x0, y0, x1, y1 = M.M_FOOT_WRAP
    fill(m, (x0, y0, x1, y1), dif=TRACK_MET, ao=AO_SEAM, rough=R_RUBBER,
         metal=M_TRACK)
    for i in range(12):
        sx = x0 + (x1 - x0) * i / 12
        m.d.line([(sx, y0), (sx, y1)], fill=BLACKISH, width=3)
    x0, y0, x1, y1 = M.M_TOE.rect
    fill(m, (x0, y0, x1, y1), dif=LOWER, ao=AO_BASE - 22)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, LOWER)
    wear_edges(m, (x0, y0, x1, y1), LOWER, 46)

    # ammo belt wrap + antenna
    x0, y0, x1, y1 = M.M_CHUTE
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 30, rough=150,
         metal=200)
    for i in range(14):
        sx = x0 + (x1 - x0) * i / 14
        m.d.line([(sx, y0), (sx, y1)], fill=(96, 84, 52), width=3)
        m.d.line([(sx + 3, y0), (sx + 3, y1)], fill=BLACKISH, width=1)
    x0, y0, x1, y1 = M.M_ANTENNA
    fill(m, (x0, y0, x1, y1), dif=BLACKISH, ao=AO_BASE - 20, rough=190,
         metal=90)
    m.d.rectangle([x0, y0, x0 + (x1 - x0) // 3, y1], fill=STEEL_DK)
    m.d.rectangle([x1 - 8, y0, x1, y1], fill=(150, 60, 40))


# ------------------------------------------------------------------ gun ---

def paint_gun(m):
    # tube wrap: heat-blued toward the muzzle
    x0, y0, x1, y1 = M.M_GUN_WRAP
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 10, rough=115,
         metal=210)
    from PIL import Image
    heat_w = int((x1 - x0) * 0.32)
    heat = Image.new('RGB', (heat_w, y1 - y0), (72, 54, 50))
    grad = Image.new('L', (heat_w, 1), 0)
    for gx in range(heat_w):
        grad.putpixel((gx, 0), int(120 * (1 - gx / max(1, heat_w - 1)) ** 1.5))
    m.dif.paste(heat, (x0, y0), grad.resize((heat_w, y1 - y0)))
    for band in (2, 6):   # cooling ribs along the +-X facets
        by0 = int(y0 + (y1 - y0) * band / 8 + 2)
        by1 = int(y0 + (y1 - y0) * (band + 1) / 8 - 2)
        for i in range(20):
            sx = x0 + 20 + i * ((x1 - x0 - 40) / 20)
            m.d.line([(sx, by0), (sx, by1)], fill=BLACKISH, width=2)

    # receiver: stencils, hazard tab, bolt row
    zone = M.M_RECEIVER
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 12)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2 + 10, ARMOR_DK)
    bolts(m, [(x0 + 14 + i * ((x1 - x0 - 28) / 4), y1 - 14) for i in range(5)],
          base=ARMOR_DK)
    stencil(m, (x0 + 14, y0 + 12), 'MS-AC/90', 19, shade(ARMOR, 1.3),
            bridge=False)
    m.d.rectangle([x1 - 52, y0 + 10, x1 - 12, y0 + 26], fill=YELLOW)
    stencil(m, (x1 - 48, y0 + 12), 'AMMO', 11, BLACKISH, bridge=False)

    # box magazine: patched steel + visible rounds + hazard lip
    zone = M.M_MAG
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 18, rough=150, metal=190)
    m.d.rectangle([x0 + 6, y0 + 6, x1 - 6, y0 + 24], fill=STEEL_DK)
    m.o.rectangle([x0 + 6, y0 + 6, x1 - 6, y0 + 24],
                  fill=(AO_DEEP, R_STEEL, M_STEEL))
    for i in range(8):
        sx = x0 + 14 + i * ((x1 - x0 - 28) / 8)
        m.d.rectangle([sx, y0 + 30, sx + 9, y1 - 24], fill=(122, 96, 46))
        m.d.rectangle([sx + 9, y0 + 30, sx + 11, y1 - 24], fill=(70, 56, 28))
    PL.hazard_band(m, (x0 + 6, y1 - 20, x1 - 6, y1 - 6), step=12)
    bolts(m, [(x0 + 12, y0 + 14), (x1 - 12, y0 + 14)], base=STEEL)

    # muzzle brake / tube cap: hazard tip + bore
    zone = M.M_MUZZLE_CELL
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 20, rough=120,
         metal=205)
    PL.hazard_band(m, (x0, y1 - 22, x1, y1 - 4), step=13)
    cxp, cyp = (x0 + x1) / 2, y0 + (y1 - y0) * 0.36
    m.d.ellipse([cxp - 12, cyp - 12, cxp + 12, cyp + 12], fill=BLACKISH)
    m.o.ellipse([cxp - 12, cyp - 12, cxp + 12, cyp + 12],
                fill=(AO_DEEP - 40, 220, 0))
    for a in (0.0, np.pi / 2):   # brake ports
        m.d.rectangle([cxp - 30 + 46 * np.cos(a), cyp - 26,
                       cxp - 22 + 46 * np.cos(a), cyp - 6], fill=BLACKISH)


# ------------------------------------------------------------------ pod ---

def paint_pod(m):
    # rack sides: low-contrast armour + AA stencil
    zone = M.M_POD
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 12)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, ARMOR_DK)
    stencil(m, (x0 + 12, y0 + 12), 'AA', 22, shade(ARMOR, 1.3), bridge=False)
    bolts(m, [(x0 + 12, y1 - 14), (x1 - 12, y1 - 14)], base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 24)

    # rack front: 2x2 missile cells with ochre tips
    zone = M.M_POD_F
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(58, 60, 62), ao=AO_BASE - 25,
         rough=170, metal=140)
    for kx in (0.28, 0.72):
        for ky in (0.30, 0.70):
            cxp = x0 + (x1 - x0) * kx
            cyp = y0 + (y1 - y0) * ky
            m.d.ellipse([cxp - 20, cyp - 20, cxp + 20, cyp + 20],
                        fill=BLACKISH)
            m.d.ellipse([cxp - 13, cyp - 13, cxp + 13, cyp + 13],
                        fill=(146, 108, 54))     # missile nose
            m.d.ellipse([cxp - 4, cyp - 4, cxp + 4, cyp + 4], fill=(60, 44, 24))
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 22)

    # rack top: tone-on-tone panel + hazard tail edge
    zone = M.M_POD_T
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 10)
    seam_v(m, (x0 + x1) // 2, y0 + 2, y1 - 2, ARMOR_DK)
    PL.hazard_band(m, (x1 - 26, y0 + 3, x1 - 6, y1 - 3), step=10)

    # missile tip cells: ochre nose colour
    x0, y0, x1, y1 = M.M_TIP.rect
    fill(m, (x0, y0, x1, y1), dif=(146, 108, 54), ao=AO_BASE - 10,
         rough=160, metal=90)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, (146, 108, 54))

    # pedestal + drum
    zone = M.M_PED
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=LOWER, ao=AO_BASE - 25)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, LOWER)
    bolts(m, [(x0 + 12, y0 + 12), (x1 - 12, y0 + 12)], base=LOWER)
    wear_edges(m, (x0, y0, x1, y1), LOWER, 30)
    x0, y0, x1, y1 = M.M_DRUM.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 22, rough=140,
         metal=190)
    cxp, cyp = (x0 + x1) / 2, (y0 + y1) / 2
    m.d.ellipse([cxp - 26, cyp - 26, cxp + 26, cyp + 26], fill=STEEL)
    bolts(m, [(cxp + np.cos(a) * 34, cyp + np.sin(a) * 34)
              for a in np.linspace(0.4, 2 * np.pi + 0.4, 6, endpoint=False)],
          base=STEEL_DK)


# ---------------------------------------------------------------- build ---

def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_pelvis_and_dark(m)
    paint_torso(m)
    paint_torso_top(m)
    paint_head(m)
    paint_hatch(m)
    paint_backpack(m)
    paint_pauldron(m)
    paint_limbs(m)
    paint_gun(m)
    paint_pod(m)

    wx = PL.standard_weather(
        m, M,
        ground_rects=(M.M_FOOT_SIDE.rect, M.M_FOOT_WRAP, M.M_TOE.rect),
        side_zones=(M.M_TORSO_FRONT, M.M_TORSO_SIDE, M.M_TORSO_REAR,
                    M.H_FRONT, M.H_SIDE),
        seed=90210, mud=0.32, grime=0.42, rust_fraction=0.5)
    # ground contact rises up the legs (u runs hip -> foot on the limb wraps)
    wx.mud_band(M.M_SHIN, 0.62, fade='right')
    wx.mud_band(M.M_SHINPLATE.rect, 0.45, fade='down', dust=0.25)
    wx.mud_band(M.M_SHINPLATE_WRAP, 0.40, fade=None, spatter=False)
    wx.mud_band(M.M_THIGH, 0.32, fade='right')
    wx.mud_band(M.M_JOINT, 0.3, fade=None, spatter=False)
    wx.mud_band(M.M_PELVIS.rect, 0.38, fade='down', dust=0.25)
    wx.mud_band(M.M_TORSO_TOP.rect, 0.12, fade=None, spatter=False)
    wx.mud_band(M.M_PAULDRON.rect, 0.3, fade='down', spatter=False)
    wx.mud_band(M.M_AMMO_BIN.rect, 0.3, fade='down', spatter=False)
    wx.mud_band(M.M_RECEIVER.rect, 0.25, fade=None, spatter=False)
    wx.mud_band(M.M_PED.rect, 0.35, fade='down', spatter=False)
    for z in (M.M_TORSO_FRONT, M.M_TORSO_SIDE, M.M_TORSO_REAR, M.M_PAULDRON,
              M.M_AMMO_BIN, M.H_SIDE, M.M_SHINPLATE):
        wx.plate_bottom_rust(z.rect, n=4, strength=0.5)
    wx.plate_bottom_rust(M.M_PELVIS.rect, n=5, strength=0.65)
    wx.plate_bottom_rust(M.M_FOOT_SIDE.rect, n=8, band=14, strength=0.85)
    wx.oily(M.M_JOINT, 0.55)
    wx.oily(M.M_JOINT_CAP.rect, 0.5)
    wx.oily(M.M_CHUTE, 0.45)
    wx.oily(M.M_PISTON, 0.5)
    gx0, gy0, gx1, gy1 = M.M_GUN_WRAP
    wx.soot_patch((gx0, gy0, gx0 + (gx1 - gx0) * 0.30, gy1), 0.55, fade='left')
    wx.soot_patch(M.M_MUZZLE_CELL.rect, 0.7)
    wx.soot_patch(M.M_VENTS.rect, 0.6)
    wx.soot_patch(M.M_POD_F.rect, 0.35)

    hm = NM.HeightMap()
    fx0, fy0, fx1, fy1 = M.M_FOOT_WRAP
    for i in range(12):           # sole cleats
        lx = fx0 + (fx1 - fx0) * i / 12
        lw = (fx1 - fx0) / 12
        hm.rect((lx + 2, fy0 + 2, lx + lw - 3, fy1 - 2), 0.6)
    jx0, jy0, jx1, jy1 = M.M_JOINT
    for i in range(8):            # joint gasket ribs
        sx = jx0 + (jx1 - jx0) * i / 8
        hm.line((sx, jy0), (sx, jy1), -0.5, width=2)
    r = M.M_JOINT_CAP.rect
    hm.disc((r[0] + r[2]) / 2, (r[1] + r[3]) / 2, 8, 0.6)
    r = M.M_BROW.rect
    hm.rect((r[0] + 4, r[1] + 4, r[2] - 4, r[3] - 4), 0.7)
    r = M.M_HATCH.rect
    hm.rect((r[0] + 5, r[1] + 5, r[2] - 5, r[3] - 5), 0.5)
    r = M.M_SHINPLATE.rect
    hm.rect((r[0] + 6, r[1] + 6, r[2] - 6, r[3] - 6), 0.45)
    cx0, cy0, cx1, cy1 = M.M_CHUTE
    for i in range(14):           # belt links stand proud
        sx = cx0 + (cx1 - cx0) * i / 14
        hm.rect((sx, cy0 + 2, sx + 3, cy1 - 2), 0.55)
    r = M.M_POD_F.rect            # missile cells recessed
    for kx in (0.28, 0.72):
        for ky in (0.30, 0.70):
            hm.disc(r[0] + (r[2] - r[0]) * kx, r[1] + (r[3] - r[1]) * ky,
                    16, -0.5)

    PL.finish(m, M, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
