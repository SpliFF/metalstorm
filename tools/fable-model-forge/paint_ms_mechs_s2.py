"""paint_ms_mechs_s2 — texture painter for the scale-2 LINE mech.

Same faction language as fable_mech / fable_tank: blue-grey armour, orange
vent heat, hazard striping on the gun tip and the shoulder hardpoint, soot at
the exhaust and the muzzle, rust under fittings, grime at the feet.  Register
is LINE MILITARY: mismatched replacement plates, a stencilled lance numeral,
functional stowage.  Human tech -> AMBER emissive only, never cyan.
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
                   shade, jit, stencil, font, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, LOWER, STEEL, STEEL_DK,
                   TRACK_MET, GLASS, YELLOW, BLACKISH,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_RUBBER, R_GLASS,
                   M_ARMOR, M_STEEL, M_TRACK, M_GLASS)
import ms_mechs_s2_layout as M

W = 1024
STEM = 'ms_mechs_s2'
TEAM_BASE = (120, 124, 128)          # held near the hull grey (impostor-safe)
AMBER = (255, 150, 40)               # instrument / running-lamp glow
AMBER_DIM = (128, 68, 16)
PATCH_PAL = (ARMOR, ARMOR_LT, ARMOR_DK, LOWER, (104, 100, 96), (88, 96, 104))
LANCE = '24'


def px(zone, world):
    u, v = zone.uv(world)
    return u * W, v * W


# ---------------------------------------------------------------- torso ---

def paint_torso(m):
    for zone in (M.M_TORSO_FRONT, M.M_TORSO_SIDE, M.M_TORSO_REAR):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=ARMOR)
        # armoured midriff below the waist line
        _, wy = px(zone, (0, 0.34, 0)) if zone.axes[1] == 'y' else (0, y1)
        wy = int(wy)
        m.d.rectangle([x0, wy, x1, y1], fill=LOWER)
        m.o.rectangle([x0, wy, x1, y1], fill=(AO_BASE - 30, R_ARMOR, M_ARMOR))
        seam_h(m, x0 + 2, x1 - 2, wy, ARMOR)
        wear_edges(m, (x0, y0, x1, wy), ARMOR, 28)

    # ---- chest: field-replaced plates, team chevron, lance numeral
    zone = M.M_TORSO_FRONT
    x0, y0, x1, y1 = zone.rect
    PL.panel_patchwork(m, (x0 + 6, y0 + 6, x1 - 6, y0 + 74), PATCH_PAL, 3, 2)
    for wy in (1.06, 0.74):
        seam_h(m, x0 + 2, x1 - 2, int(px(zone, (0, wy, 0))[1]), ARMOR)
    cx, cy = px(zone, (0.0, 0.66, 0))
    chev = [(cx - 52, cy + 30), (cx, cy - 6), (cx + 52, cy + 30),
            (cx + 52, cy + 50), (cx, cy + 14), (cx - 52, cy + 50)]
    m.t.polygon(chev, fill=(255, 0, 0))
    m.d.polygon(chev, fill=TEAM_BASE)
    stencil(m, (x0 + 12, y1 - 40), LANCE, 26, (188, 192, 196), bridge=False)
    bolts(m, [(x0 + 14 + i * ((x1 - x0 - 28) / 5), y0 + 12) for i in range(6)],
          base=ARMOR)

    # ---- side: intake slats, stowage strap, rail shadow
    zone = M.M_TORSO_SIDE
    x0, y0, x1, y1 = zone.rect
    iu0, iv0 = px(zone, (0, 0.80, 0.16))
    iu1, iv1 = px(zone, (0, 0.52, 0.56))
    ib = PL.nbox(iu0, iv0, iu1, iv1)
    m.d.rectangle(ib, fill=STEEL_DK)
    m.o.rectangle(ib, fill=(AO_BASE - 40, R_STEEL, M_STEEL))
    vent_slots(m, [ib[0] + 3, ib[1] + 3, ib[2] - 3, ib[3] - 3], 4)
    su0, sv0 = px(zone, (0, 0.42, -0.62))
    su1, sv1 = px(zone, (0, 0.20, -0.14))
    m.d.rectangle(PL.nbox(su0, sv0, su1, sv1), fill=(84, 76, 58))   # tarp roll
    bolts(m, [(x0 + 18, y0 + 16), (x1 - 18, y0 + 16)], base=ARMOR)

    # ---- rear: access hatch panel + rear numeral
    zone = M.M_TORSO_REAR
    x0, y0, x1, y1 = zone.rect
    m.d.rectangle([x0 + 28, y0 + 42, x1 - 28, y0 + 104], fill=ARMOR_DK)
    m.o.rectangle([x0 + 28, y0 + 42, x1 - 28, y0 + 104],
                  fill=(AO_BASE - 20, R_ARMOR, M_ARMOR))
    bolts(m, [(x0 + 36 + i * ((x1 - x0 - 72) / 3), y0 + 50) for i in range(4)],
          base=ARMOR_DK)
    stencil(m, (x1 - 74, y0 + 112), LANCE, 30, (182, 186, 190), bridge=False)


def paint_torso_top(m):
    zone = M.M_TORSO_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    for wz in (-0.30, 0.30, 0.70):
        seam_h(m, x0 + 3, x1 - 3, int(px(zone, (0, 0, wz))[1]), ARMOR)
    for wx in (-0.55, 0.55):
        seam_v(m, int(px(zone, (wx, 0, 0))[0]), y0 + 3, y1 - 3, ARMOR)
    # team roof wedge (reads for the player camera)
    a = px(zone, (-0.30, 0, 0.10))
    b = px(zone, (0.30, 0, 0.10))
    c = px(zone, (0.0, 0, -0.34))
    m.t.polygon([a, b, c], fill=(255, 0, 0))
    m.d.polygon([a, b, c], fill=TEAM_BASE)
    nu, nv = px(zone, (0.66, 0, 0.62))
    stencil(m, (nu - 22, nv - 18), LANCE, 34, (196, 200, 204), bridge=False)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 32)


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


# -------------------------------------------------------------- cockpit ---

def paint_cockpit(m):
    """Manned cockpit: multi-pane glazing with amber instrument glow, an
    armoured brow lip, a wiper, and side quarter-lights."""
    # --- front / windscreen
    zone = M.M_COCKPIT_F
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    gu0, gv0 = px(zone, (-0.34, 1.45, 0))
    gu1, gv1 = px(zone, (0.34, 1.06, 0))
    gb = PL.nbox(gu0, gv0, gu1, gv1)
    PL.glass_rect(m, gb, outline=ARMOR_DK)
    # three panes split by armoured mullions
    gw = gb[2] - gb[0]
    for k in (1, 2):
        mx = gb[0] + gw * k / 3
        m.d.rectangle([mx - 3, gb[1], mx + 3, gb[3]], fill=ARMOR_DK)
        m.o.rectangle([mx - 3, gb[1], mx + 3, gb[3]],
                      fill=(AO_SEAM, R_ARMOR, M_ARMOR))
    # amber instrument glow spilling up the inside of the glass
    m.e.rectangle([gb[0] + 5, gb[3] - 14, gb[2] - 5, gb[3] - 4], fill=AMBER_DIM)
    for k in range(3):
        cxp = gb[0] + gw * (k + 0.5) / 3
        m.e.ellipse([cxp - 7, gb[3] - 17, cxp + 7, gb[3] - 5], fill=AMBER)
    # wiper across the centre pane
    m.d.line([(gb[0] + gw * 0.36, gb[3] - 4), (gb[0] + gw * 0.60, gb[1] + 6)],
             fill=BLACKISH, width=3)
    # armoured cheeks below the glass + bolt row
    m.d.rectangle([x0 + 6, gb[3] + 6, x1 - 6, y1 - 8], fill=ARMOR)
    m.o.rectangle([x0 + 6, gb[3] + 6, x1 - 6, y1 - 8],
                  fill=(AO_BASE - 15, R_ARMOR, M_ARMOR))
    bolts(m, [(x0 + 20 + i * ((x1 - x0 - 40) / 4), gb[3] + 16) for i in range(5)],
          base=ARMOR)
    # amber running lamps at the cheek corners
    PL.headlight(m, (x0 + 14, y1 - 44, x0 + 40, y1 - 22), lamp=AMBER)
    PL.headlight(m, (x1 - 40, y1 - 44, x1 - 14, y1 - 22), lamp=AMBER)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 26)

    # --- sides: quarter-light slit + hull plate
    zone = M.M_COCKPIT_S
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    qu0, qv0 = px(zone, (0, 1.38, -1.00))
    qu1, qv1 = px(zone, (0, 1.20, -0.66))
    qb = PL.nbox(qu0, qv0, qu1, qv1)
    PL.glass_rect(m, qb, outline=ARMOR_DK)
    m.e.rectangle([qb[0] + 3, qb[3] - 7, qb[2] - 3, qb[3] - 2], fill=AMBER_DIM)
    seam_h(m, x0 + 3, x1 - 3, int(px(zone, (0, 1.06, 0))[1]), ARMOR_DK)
    bolts(m, [(x0 + 16 + i * ((x1 - x0 - 32) / 3), y1 - 22) for i in range(4)],
          base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 24)

    # --- roof of the head
    zone = M.M_COCKPIT_T
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, ARMOR)
    bolts(m, [(x0 + 18, y0 + 16), (x1 - 18, y0 + 16),
              (x0 + 18, y1 - 16), (x1 - 18, y1 - 16)], base=ARMOR)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 26)

    # --- brow lip: hazard-edged armour over the viewport
    zone = M.M_BROW
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 18)
    PL.hazard_band(m, (x0 + 4, y1 - 16, x1 - 4, y1 - 4), step=12)
    bolts(m, [(x0 + 16 + i * ((x1 - x0 - 32) / 5), y0 + 14) for i in range(6)],
          base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 30)


def paint_hatch_and_step(m):
    zone = M.M_HATCH
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_LT, ao=AO_BASE - 10)
    m.d.rectangle([x0 + 5, y0 + 5, x1 - 5, y1 - 5], outline=shade(ARMOR, 0.5),
                  width=2)
    cxp, cyp = (x0 + x1) / 2, (y0 + y1) / 2
    m.d.ellipse([cxp - 9, cyp - 9, cxp + 9, cyp + 9], fill=STEEL_DK)  # hatch ring
    bolts(m, [(x0 + 12, y0 + 12), (x1 - 12, y0 + 12),
              (x0 + 12, y1 - 12), (x1 - 12, y1 - 12)], base=ARMOR_LT)
    stencil(m, (x0 + 8, y1 - 24), 'CREW', 11, YELLOW, bridge=False)

    zone = M.M_STEP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 30, rough=200, metal=180)
    for i in range(6):
        sx = x0 + 6 + i * ((x1 - x0 - 12) / 5)
        m.d.line([(sx, y0 + 4), (sx, y1 - 4)], fill=BLACKISH, width=2)
    m.d.rectangle([x0 + 2, y0 + 2, x1 - 2, y0 + 6], fill=YELLOW)


def paint_backpack(m):
    zone = M.M_AMMO_BIN
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    PL.panel_patchwork(m, (x0 + 6, y0 + 6, x1 - 6, y1 - 34), PATCH_PAL, 3, 2)
    m.d.rectangle([x0 + 8, y1 - 30, x1 - 8, y1 - 8], fill=STEEL_DK)
    m.o.rectangle([x0 + 8, y1 - 30, x1 - 8, y1 - 8],
                  fill=(AO_BASE - 30, R_STEEL, M_STEEL))
    stencil(m, (x0 + 14, y1 - 28), '30 mm  AP-T  x600', 15, YELLOW, bridge=False)
    bolts(m, [(x0 + 16 + i * ((x1 - x0 - 32) / 5), y0 + 14) for i in range(6)],
          base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 30)

    zone = M.M_VENTS
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(60, 56, 54), ao=AO_BASE - 35,
         rough=190, metal=160)
    vent_slots(m, [x0 + 8, y0 + 10, x1 - 8, y1 - 10], 5, glow=(150, 58, 14))


def paint_pauldron(m):
    zone = M.M_PAULDRON
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    panel = (x0 + 14, y0 + 14, x1 - 14, y1 - 30)
    PL.team_panel(m, panel, outline=ARMOR, base=TEAM_BASE)
    # mask-cutout chevron inside the team panel (survives the team respray)
    cxp = (panel[0] + panel[2]) / 2
    ph = panel[3] - panel[1]
    chev = [(cxp - 24, panel[1] + ph * 0.64), (cxp, panel[1] + ph * 0.26),
            (cxp + 24, panel[1] + ph * 0.64), (cxp + 24, panel[1] + ph * 0.84),
            (cxp, panel[1] + ph * 0.46), (cxp - 24, panel[1] + ph * 0.84)]
    m.t.polygon(chev, fill=(0, 0, 0))
    m.d.polygon(chev, fill=(44, 48, 52))
    PL.hazard_band(m, (x0 + 6, y1 - 22, x1 - 6, y1 - 8), step=13)
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
        if tag == 'shin':   # actuator / piston highlight down the shin
            m.d.rectangle([x0 + 24, y0 + int(0.5 * bh), x1 - 34,
                           y0 + int(1.5 * bh)], fill=(150, 155, 160))
            m.o.rectangle([x0 + 24, y0 + int(0.5 * bh), x1 - 34,
                           y0 + int(1.5 * bh)], fill=(AO_BASE, 90, 230))
        wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 30)

    # joint stubs
    x0, y0, x1, y1 = M.M_JOINT
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 25, rough=140, metal=190)
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

    # feet — a proper boot: toe cap, heel block, cleated sole
    zone = M.M_FOOT_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 20)
    seam_v(m, int(px(zone, (0, 0, -0.34))[0]), y0 + 2, y1 - 2, LOWER)  # toe cap
    seam_v(m, int(px(zone, (0, 0, 0.14))[0]), y0 + 2, y1 - 2, LOWER)   # heel
    bolts(m, [(px(zone, (0, -0.10, z))[0], px(zone, (0, -0.10, z))[1])
              for z in (-0.44, -0.20, 0.04, 0.24)], base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), LOWER, 42)
    x0, y0, x1, y1 = M.M_FOOT_WRAP
    fill(m, (x0, y0, x1, y1), dif=TRACK_MET, ao=AO_SEAM, rough=R_RUBBER,
         metal=M_TRACK)
    for i in range(11):
        sx = x0 + (x1 - x0) * i / 11
        m.d.line([(sx, y0), (sx, y1)], fill=BLACKISH, width=3)

    # ammo belt / grab rail wrap + antenna
    x0, y0, x1, y1 = M.M_CHUTE
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 30, rough=150, metal=200)
    for i in range(14):     # belt links
        sx = x0 + (x1 - x0) * i / 14
        m.d.line([(sx, y0), (sx, y1)], fill=(96, 84, 52), width=3)
        m.d.line([(sx + 3, y0), (sx + 3, y1)], fill=BLACKISH, width=1)
    x0, y0, x1, y1 = M.M_ANTENNA
    fill(m, (x0, y0, x1, y1), dif=BLACKISH, ao=AO_BASE - 20, rough=190, metal=90)
    m.d.rectangle([x0, y0, x0 + (x1 - x0) // 3, y1], fill=STEEL_DK)
    m.d.rectangle([x1 - 8, y0, x1, y1], fill=(150, 60, 40))


# ------------------------------------------------------------------ gun ---

def paint_gun(m):
    # tube wrap: heat-blued toward the muzzle
    x0, y0, x1, y1 = M.M_GUN_WRAP
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 10, rough=115, metal=210)
    from PIL import Image
    heat_w = int((x1 - x0) * 0.34)
    heat = Image.new('RGB', (heat_w, y1 - y0), (72, 54, 50))
    grad = Image.new('L', (heat_w, 1), 0)
    for gx in range(heat_w):
        grad.putpixel((gx, 0), int(120 * (1 - gx / max(1, heat_w - 1)) ** 1.5))
    m.dif.paste(heat, (x0, y0), grad.resize((heat_w, y1 - y0)))
    for band in (2, 6):   # cooling ribs along the ±X facets
        by0 = int(y0 + (y1 - y0) * band / 8 + 2)
        by1 = int(y0 + (y1 - y0) * (band + 1) / 8 - 2)
        for i in range(18):
            sx = x0 + 20 + i * ((x1 - x0 - 40) / 18)
            m.d.line([(sx, by0), (sx, by1)], fill=BLACKISH, width=2)

    # receiver: stencils, hazard tab, bolt row
    zone = M.M_RECEIVER
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 12)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2 + 10, ARMOR_DK)
    bolts(m, [(x0 + 14 + i * ((x1 - x0 - 28) / 4), y1 - 14) for i in range(5)],
          base=ARMOR_DK)
    stencil(m, (x0 + 14, y0 + 12), 'MS-AC/30', 19, shade(ARMOR, 1.3),
            bridge=False)
    m.d.rectangle([x1 - 52, y0 + 10, x1 - 12, y0 + 26], fill=YELLOW)
    stencil(m, (x1 - 48, y0 + 12), 'AMMO', 11, BLACKISH, bridge=False)

    # box magazine: patched steel + feed lips + capacity stencil
    zone = M.M_MAG
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 18, rough=150, metal=190)
    m.d.rectangle([x0 + 6, y0 + 6, x1 - 6, y0 + 24], fill=STEEL_DK)
    m.o.rectangle([x0 + 6, y0 + 6, x1 - 6, y0 + 24],
                  fill=(AO_DEEP, R_STEEL, M_STEEL))
    for i in range(9):     # visible rounds through the feed cut-out
        sx = x0 + 14 + i * ((x1 - x0 - 28) / 9)
        m.d.rectangle([sx, y0 + 30, sx + 8, y1 - 22], fill=(122, 96, 46))
        m.d.rectangle([sx + 8, y0 + 30, sx + 10, y1 - 22], fill=(70, 56, 28))
    PL.hazard_band(m, (x0 + 6, y1 - 18, x1 - 6, y1 - 6), step=12)
    bolts(m, [(x0 + 12, y0 + 14), (x1 - 12, y0 + 14)], base=STEEL)

    # muzzle brake / tube cap: hazard tip + bore
    zone = M.M_MUZZLE_CELL
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 20, rough=120, metal=205)
    PL.hazard_band(m, (x0, y1 - 22, x1, y1 - 4), step=13)
    cxp, cyp = (x0 + x1) / 2, y0 + (y1 - y0) * 0.36
    m.d.ellipse([cxp - 11, cyp - 11, cxp + 11, cyp + 11], fill=BLACKISH)
    m.o.ellipse([cxp - 11, cyp - 11, cxp + 11, cyp + 11], fill=(AO_DEEP - 40, 220, 0))
    for a in (0.0, np.pi / 2):   # brake ports
        m.d.rectangle([cxp - 30 + 46 * np.cos(a), cyp - 26,
                       cxp - 22 + 46 * np.cos(a), cyp - 6], fill=BLACKISH)


# ---------------------------------------------------------------- build ---

def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_pelvis_and_dark(m)
    paint_torso(m)
    paint_torso_top(m)
    paint_cockpit(m)
    paint_hatch_and_step(m)
    paint_backpack(m)
    paint_pauldron(m)
    paint_limbs(m)
    paint_gun(m)

    wx = PL.standard_weather(
        m, M,
        ground_rects=(M.M_FOOT_SIDE.rect, M.M_FOOT_WRAP),
        side_zones=(M.M_TORSO_FRONT, M.M_TORSO_SIDE, M.M_TORSO_REAR,
                    M.M_COCKPIT_F, M.M_COCKPIT_S),
        seed=41, mud=0.30, grime=0.40, rust_fraction=0.5)
    # ground contact rises up the legs (u runs hip -> foot on the limb wraps)
    wx.mud_band(M.M_SHIN, 0.62, fade='right')
    wx.mud_band(M.M_THIGH, 0.34, fade='right')
    wx.mud_band(M.M_JOINT, 0.3, fade=None, spatter=False)
    wx.mud_band(M.M_PELVIS.rect, 0.38, fade='down', dust=0.25)
    wx.mud_band(M.M_TORSO_TOP.rect, 0.14, fade=None, spatter=False)
    wx.mud_band(M.M_PAULDRON.rect, 0.3, fade='down', spatter=False)
    wx.mud_band(M.M_AMMO_BIN.rect, 0.3, fade='down', spatter=False)
    wx.mud_band(M.M_RECEIVER.rect, 0.25, fade=None, spatter=False)
    for z in (M.M_TORSO_FRONT, M.M_TORSO_SIDE, M.M_TORSO_REAR, M.M_PAULDRON,
              M.M_AMMO_BIN, M.M_COCKPIT_S):
        wx.plate_bottom_rust(z.rect, n=4, strength=0.5)
    wx.plate_bottom_rust(M.M_PELVIS.rect, n=5, strength=0.65)
    wx.plate_bottom_rust(M.M_FOOT_SIDE.rect, n=8, band=14, strength=0.85)
    wx.oily(M.M_JOINT, 0.55)
    wx.oily(M.M_JOINT_CAP.rect, 0.5)
    wx.oily(M.M_CHUTE, 0.45)
    gx0, gy0, gx1, gy1 = M.M_GUN_WRAP
    wx.soot_patch((gx0, gy0, gx0 + (gx1 - gx0) * 0.32, gy1), 0.55, fade='left')
    wx.soot_patch(M.M_MUZZLE_CELL.rect, 0.7)
    wx.soot_patch(M.M_VENTS.rect, 0.6)

    hm = NM.HeightMap()
    fx0, fy0, fx1, fy1 = M.M_FOOT_WRAP
    for i in range(11):           # sole cleats
        lx = fx0 + (fx1 - fx0) * i / 11
        lw = (fx1 - fx0) / 11
        hm.rect((lx + 2, fy0 + 2, lx + lw - 3, fy1 - 2), 0.6)
    jx0, jy0, jx1, jy1 = M.M_JOINT
    for i in range(8):            # joint gasket ribs
        sx = jx0 + (jx1 - jx0) * i / 8
        hm.line((sx, jy0), (sx, jy1), -0.5, width=2)
    r = M.M_JOINT_CAP.rect
    hm.disc((r[0] + r[2]) / 2, (r[1] + r[3]) / 2, 8, 0.6)
    sx0, sy0, sx1, sy1 = M.M_SHIN
    bh = (sy1 - sy0) / 8
    hm.rect((sx0 + 24, sy0 + int(0.5 * bh), sx1 - 34, sy0 + int(1.5 * bh)), 0.5)
    cx0, cy0, cx1, cy1 = M.M_CHUTE
    for i in range(14):           # belt links stand proud
        sx = cx0 + (cx1 - cx0) * i / 14
        hm.rect((sx, cy0 + 2, sx + 3, cy1 - 2), 0.55)
    r = M.M_BROW.rect
    hm.rect((r[0] + 4, r[1] + 4, r[2] - 4, r[3] - 4), 0.7)
    r = M.M_HATCH.rect
    hm.rect((r[0] + 5, r[1] + 5, r[2] - 5, r[3] - 5), 0.5)

    PL.finish(m, M, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
