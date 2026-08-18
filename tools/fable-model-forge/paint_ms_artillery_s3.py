"""paint_ms_artillery_s3 — 1024² PBR set for ms_artillery_s3 (heavy SPG).

Same army as the artillery line: blue-grey armour, rust and soot, kinetic
weathering. Open gun deck read — tread-plate rear deck with a painted
traverse ring, forward engine block with intake grilles and sooted
stacks, long gun in gun-steel with wear bands, gun shield with a white
gun-name stencil. Team: hull-side team panels + a deck ID numeral in the
team mask. Emissive: headlights + amber deck work-light only.
"""
from __future__ import annotations
import numpy as np

import ms_artillery_s3_layout as L    # sets meshlib.ATLAS = 1024
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
STEM = 'ms_artillery_s3'

GUNSTEEL   = (66, 70, 76)
GUNSTEEL_D = (52, 55, 60)
AMBER      = (255, 176, 60)
WHITE_MK   = (198, 202, 206)


def numeral(m, cx, cy, text, size, color=WHITE_MK):
    f = PL.font(size)
    tw = m.d.textlength(text, font=f)
    m.d.text((cx - tw / 2 + 2, cy - size * 0.55 + 2), text, font=f,
             fill=shade(ARMOR_DK, 0.55))
    m.d.text((cx - tw / 2, cy - size * 0.55), text, font=f, fill=color)


# ── hull ────────────────────────────────────────────────────────────────

def paint_dark(m):
    fill(m, L.C_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)


def paint_hull_top(m):
    z = L.C_HULL_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    for _ in range(7):
        bx = x0 + RNG.random() * (x1 - x0 - 80)
        by = y0 + RNG.random() * (y1 - y0 - 40)
        m.d.polygon([(bx, by + 8), (bx + 66, by), (bx + 78, by + 30),
                     (bx + 14, by + 38)], fill=jit(ARMOR_DK, 3))
    # deck panel seams (u runs along z here)
    for wz in (-4.4, -2.4, -1.2, 0.2, 1.2, 3.2, 4.5):
        u, _ = z.uv((0, 0, wz))
        seam_v(m, int(u * W), y0 + 4, y1 - 4, ARMOR)
    for wx in (-0.8, 0.8):
        _, v = z.uv((wx, 0, 0))
        seam_h(m, x0 + 4, x1 - 4, int(v * W), ARMOR)
    # open gun deck: darker tread-plate area from mid-hull aft
    pu0, pv0 = z.uv((0, 0, 1.0))
    pu1, pv1 = z.uv((0, 0, 5.1))
    deck = [pu0 * W, y0 + 6, pu1 * W, y1 - 6]
    m.d.rectangle(deck, fill=shade(ARMOR_DK, 0.92))
    m.o.rectangle(deck, fill=(AO_BASE - 20, R_ARMOR + 10, M_ARMOR))
    for gx in range(int(deck[0]) + 4, int(deck[2]) - 2, 9):
        m.d.line([(gx, deck[1] + 3), (gx, deck[3] - 3)],
                 fill=shade(ARMOR_DK, 0.72), width=1)
    # painted traverse ring around the pedestal
    cu, cv = z.uv((0, 0, L.PED_Z))
    ru, _ = z.uv((0, 0, L.PED_Z + 0.85))
    rr = ru * W - cu * W
    m.d.ellipse([cu * W - rr, cv * W - rr, cu * W + rr, cv * W + rr],
                outline=shade(ARMOR_LT, 1.05), width=4)
    m.d.ellipse([cu * W - rr - 8, cv * W - rr - 8, cu * W + rr + 8,
                 cv * W + rr + 8], outline=shade(ARMOR_DK, 0.7), width=2)
    # deck ID numeral in the TEAM MASK, forward of the ring
    f = PL.font(56)
    nu, nv = z.uv((0.05, 0, 0.35))
    tw = m.d.textlength('3', font=f)
    m.d.text((nu * W - tw / 2, nv * W - 30), '3', font=f, fill=TEAMGREY)
    m.t.text((nu * W - tw / 2, nv * W - 30), '3', font=f, fill=(255, 0, 0))
    # crew grip strips along the deck edges
    for wx in (-0.95, 0.95):
        _, v = z.uv((wx, 0, 0))
        m.d.rectangle([int(deck[0]), v * W - 2, int(deck[2]), v * W + 2],
                      fill=shade(ARMOR, 0.7))
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 55)


def paint_glacis(m):
    z = L.C_GLACIS
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    seam_h(m, x0 + 3, x1 - 3, int(y0 + (y1 - y0) * 0.42), ARMOR_DK)
    seam_v(m, int(x0 + (x1 - x0) * 0.5), y0 + 3, y1 - 3, ARMOR_DK)
    # headlights (functional, warm)
    for fx in (0.16, 0.84):
        lx = x0 + (x1 - x0) * fx
        ly = y0 + (y1 - y0) * 0.34
        PL.headlight(m, [lx - 9, ly - 6, lx + 9, ly + 6])
    # spare track links bolted across the lower glacis
    ty = y1 - (y1 - y0) * 0.30
    for i in range(5):
        sx = x0 + (x1 - x0) * (0.22 + i * 0.14)
        m.d.rectangle([sx - 10, ty - 8, sx + 10, ty + 8], fill=TRACK_MET)
        m.d.line([(sx, ty - 8), (sx, ty + 8)], fill=BLACKISH, width=2)
        m.o.rectangle([sx - 10, ty - 8, sx + 10, ty + 8],
                      fill=(AO_SEAM, R_STEEL, M_TRACK))
    # tow points
    for fx in (0.10, 0.90):
        tx = x0 + (x1 - x0) * fx
        m.d.rectangle([tx - 8, ty - 5, tx + 8, ty + 5], fill=STEEL_DK)
        m.d.ellipse([tx - 4, ty - 3, tx + 4, ty + 3], fill=BLACKISH)
    bolts(m, [(x0 + 10 + i * ((x1 - x0 - 20) / 7), y0 + 8) for i in range(8)],
          base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 45)


def paint_hull_rear(m):
    z = L.C_HULL_REAR
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    # spade hinge rail across the upper edge
    ry = y0 + (y1 - y0) * 0.18
    m.d.rectangle([x0 + 8, ry - 6, x1 - 8, ry + 6], fill=STEEL_DK)
    m.o.rectangle([x0 + 8, ry - 6, x1 - 8, ry + 6],
                  fill=(AO_SEAM, R_STEEL, M_STEEL))
    bolts(m, [(x0 + 20 + i * ((x1 - x0 - 40) / 5), ry) for i in range(6)],
          base=STEEL_DK)
    numeral(m, (x0 + x1) / 2, y0 + (y1 - y0) * 0.45, '3', 44)
    # hazard strip along the bottom edge + taillights
    PL.hazard_band(m, [x0 + 4, y1 - 16, x1 - 4, y1 - 4])
    for fx in (0.10, 0.90):
        lx = x0 + (x1 - x0) * fx
        PL.taillight(m, [lx - 10, y0 + 22, lx + 10, y0 + 30])
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 35)


def paint_hull_side(m):
    z = L.C_HULL_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    _, wv = z.uv((0, 0, 0.85))
    _, bv = z.uv((0, 0.86, 0))
    wy = int(bv * W)
    m.d.rectangle([x0, wy, x1, y1], fill=LOWER)
    m.o.rectangle([x0, wy, x1, y1], fill=(AO_BASE - 30, R_ARMOR, M_ARMOR))
    seam_h(m, x0, x1, wy, ARMOR)
    for wz in (-3.4, -1.6, 0.4, 2.2, 4.0):
        u, _ = z.uv((0, 0, wz))
        seam_v(m, int(u * W), y0 + 3, wy, ARMOR)
    # hull-side TEAM panel amidships (symmetric — zone is L/R shared)
    pu0, pv0 = z.uv((0, 0, 0.75))
    pu1, pv1 = z.uv((0, 0, 2.05))
    panel = PL.nbox(pu0 * W, y0 + 10, pu1 * W, wy - 6)
    PL.team_panel(m, panel, outline=shade(ARMOR, 0.5))
    bolts(m, [(x0 + 12 + i * ((x1 - x0 - 24) / 11), wy - 8)
              for i in range(12)], base=ARMOR)
    wear_edges(m, (x0, y0, x1, wy), ARMOR, 40)


# ── running gear ────────────────────────────────────────────────────────

def paint_tracks_side(m):
    zone = L.C_TRACK_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=LOWER, ao=AO_BASE - 25)

    def py(wy):
        return zone.uv((0, wy, 0))[1] * W

    def pz(wz):
        return zone.uv((0, 0, wz))[0] * W

    # wheel-well band behind the wheels — open running gear, deep shadow
    m.d.rectangle([x0, py(0.92), x1, py(0.05)], fill=BLACKISH)
    m.o.rectangle([x0, py(0.92), x1, py(0.05)],
                  fill=(AO_DEEP - 30, R_RUBBER, 30))
    # 8 road wheels (geometry discs land on these cells)
    for wz in L.ROAD_WHEELS:
        cx, cy = pz(wz), py(L.WHEEL_CY)
        r = pz(wz + L.WHEEL_R) - pz(wz)
        m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=RUBBER)
        r2 = r * 0.64
        m.d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2],
                    fill=jit(TRACK_MET, 3))
        m.o.ellipse([cx - r, cy - r, cx + r, cy + r],
                    fill=(AO_DEEP, R_RUBBER, 30))
        m.o.ellipse([cx - r2, cy - r2, cx + r2, cy + r2],
                    fill=(AO_SEAM, R_STEEL, M_TRACK))
        for k in range(6):
            a = k * np.pi / 3 + 0.3
            bolts(m, [(cx + np.cos(a) * r2 * 0.55,
                       cy + np.sin(a) * r2 * 0.55)], r=2, base=TRACK_MET)
        m.d.ellipse([cx - 3, cy - 3, cx + 3, cy + 3], fill=STEEL_DK)
    # return-roller strip along the top run
    ry0, ry1 = py(1.14), py(0.98)
    m.d.rectangle([x0, ry0, x1, ry1], fill=shade(LOWER, 1.08))
    seam_h(m, x0, x1, int(ry1), LOWER)
    wear_edges(m, (x0, y0, x1, y1), LOWER, 30)


def paint_track_wrap(m):
    x0, y0, x1, y1 = L.C_TRACK_WRAP
    fill(m, (x0, y0, x1, y1), dif=TRACK_MET, ao=AO_SEAM, rough=R_RUBBER,
         metal=M_TRACK)
    n = 64
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
    x0, y0, x1, y1 = L.C_FENDER.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 8)
    for gx in range(x0 + 6, x1 - 4, 14):
        for gy in range(y0 + 6, y1 - 4, 12):
            off = 4 if ((gy - y0) // 12) % 2 else 0
            m.d.line([(gx + off, gy), (gx + off + 5, gy + 4)],
                     fill=shade(ARMOR_DK, 1.28), width=2)
    seam_h(m, x0, x1, y0 + 2, ARMOR_DK, hi=False)


# ── engine block + stacks ───────────────────────────────────────────────

def paint_engine(m):
    z = L.C_ENGINE_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    # twin intake grilles
    for fv in (0.28, 0.72):
        gy = y0 + (y1 - y0) * fv
        gb = [x0 + 14, gy - 22, x1 - 14, gy + 22]
        m.d.rectangle(gb, fill=STEEL_DK)
        m.o.rectangle(gb, fill=(AO_DEEP, R_STEEL, M_STEEL))
        vent_slots(m, [gb[0] + 6, gb[1] + 6, gb[2] - 6, gb[3] - 6], 4)
    seam_v(m, (x0 + x1) // 2, y0 + 4, y1 - 4, ARMOR)
    bolts(m, [(x0 + 10 + i * ((x1 - x0 - 20) / 7), y0 + 8) for i in range(8)],
          base=ARMOR)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 35)

    x0, y0, x1, y1 = L.C_ENGINE_SIDE.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    # cooling louvres
    for i in range(6):
        lx = x0 + 18 + i * ((x1 - x0 - 36) / 5)
        m.d.line([(lx, y0 + 14), (lx + 8, y1 - 14)],
                 fill=shade(ARMOR_DK, 0.8), width=4)
    seam_h(m, x0 + 2, x1 - 2, y1 - 10, ARMOR)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 30)

    x0, y0, x1, y1 = L.C_ENGINE_FACE.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    bolts(m, [(x0 + 10 + i * ((x1 - x0 - 20) / 5), (y0 + y1) / 2)
              for i in range(6)], base=ARMOR_DK)

    # exhaust stack wrap: heat-scorched steel, sooted at the top (u = up)
    x0, y0, x1, y1 = L.C_STACK
    fill(m, (x0, y0, x1, y1), dif=(60, 56, 54), ao=AO_BASE - 20, rough=200,
         metal=140)
    m.d.rectangle([x0 + (x1 - x0) * 0.62, y0, x1, y1], fill=(44, 40, 38))
    for fy in (0.3, 0.6):
        gy = y0 + (y1 - y0) * fy
        m.d.rectangle([x0, gy - 2, x1, gy + 2], fill=STEEL_DK)


# ── pedestal mount + shield ─────────────────────────────────────────────

def paint_mount(m):
    # pedestal wrap: ribbed drum + bolt ring at the base
    x0, y0, x1, y1 = L.C_PED
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 10, rough=R_STEEL,
         metal=M_STEEL)
    for fx in np.linspace(0.12, 0.88, 5):
        gx = x0 + (x1 - x0) * fx
        m.d.line([(gx, y0 + 4), (gx, y1 - 4)], fill=shade(STEEL, 0.8),
                 width=3)
    bolts(m, [(x0 + 8 + i * ((x1 - x0 - 16) / 7), y1 - 10)
              for i in range(8)], base=STEEL)
    # trunnion cheeks / tray cell
    x0, y0, x1, y1 = L.C_MOUNT.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 12, rough=R_STEEL,
         metal=M_STEEL)
    m.d.ellipse([x0 + 20, (y0 + y1) / 2 - 26, x0 + 72,
                 (y0 + y1) / 2 + 26], fill=GUNSTEEL,
                outline=shade(STEEL_DK, 0.6), width=3)
    bolts(m, [(x0 + 46 + np.cos(a) * 20, (y0 + y1) / 2 + np.sin(a) * 20)
              for a in np.linspace(0, 2 * np.pi, 6, endpoint=False)],
          base=STEEL_DK)
    seam_h(m, x0 + 4, x1 - 4, (y0 + y1) // 2 + 34, STEEL_DK)
    wear_edges(m, (x0, y0, x1, y1), STEEL_DK, 25)


def paint_shield(m):
    # front: heavy armour, patch plates, bolted frame, white stencil
    z = L.C_SHIELD_F
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    PL.panel_patchwork(m, (x0 + 8, y0 + 8, x1 - 8, y1 - 8),
                       (ARMOR_DK, shade(ARMOR_DK, 0.9), ARMOR,
                        shade(ARMOR_DK, 1.1)), cols=3, rows=2)
    m.d.rectangle([x0 + 6, y0 + 6, x1 - 6, y1 - 6],
                  outline=shade(ARMOR_DK, 0.55), width=3)
    bolts(m, [(x0 + 14 + i * ((x1 - x0 - 28) / 7), y0 + 14)
              for i in range(8)], base=ARMOR_DK)
    bolts(m, [(x0 + 14 + i * ((x1 - x0 - 28) / 7), y1 - 14)
              for i in range(8)], base=ARMOR_DK)
    # gun port shadow where the tube passes
    cu, cv = z.uv((0, 1.0, 0))
    m.d.ellipse([cu * W - 30, cv * W - 26, cu * W + 30, cv * W + 26],
                fill=BLACKISH)
    m.o.ellipse([cu * W - 30, cv * W - 26, cu * W + 30, cv * W + 26],
                fill=(AO_DEEP, R_ARMOR, M_ARMOR))
    numeral(m, (x0 + x1) / 2, y1 - 40, 'LONG TOM', 26)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 40)

    # back: lighter, crew side — stowage straps and a rack
    z = L.C_SHIELD_B
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ARMOR, 1.04), ao=AO_BASE - 12)
    cu, cv = z.uv((0, 1.0, 0))
    m.d.ellipse([cu * W - 30, cv * W - 26, cu * W + 30, cv * W + 26],
                fill=BLACKISH)
    for fx in (0.18, 0.82):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 22, y0 + 30, sx + 22, y1 - 50], fill=LOWER)
        for fy in (0.3, 0.6):
            sy = y0 + 30 + ((y1 - 50) - (y0 + 30)) * fy
            m.d.rectangle([sx - 24, sy - 3, sx + 24, sy + 3], fill=STEEL_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 25)


# ── gun ─────────────────────────────────────────────────────────────────

def paint_gun(m):
    # breech: dark gun steel, interrupted-screw ring seams
    x0, y0, x1, y1 = L.C_BREECH
    fill(m, (x0, y0, x1, y1), dif=GUNSTEEL_D, ao=AO_BASE - 12, rough=150,
         metal=170)
    for fx in (0.22, 0.5, 0.86):
        gx = x0 + (x1 - x0) * fx
        m.d.rectangle([gx - 3, y0 + 2, gx + 3, y1 - 2],
                      fill=shade(GUNSTEEL_D, 0.72))
    bolts(m, [(x0 + (x1 - x0) * 0.68, y0 + 14 + i * 18) for i in range(5)],
          base=GUNSTEEL_D)
    # tube: gun steel, wear band toward muzzle, chalk mission tallies
    x0, y0, x1, y1 = L.C_BARREL
    fill(m, (x0, y0, x1, y1), dif=GUNSTEEL, ao=AO_BASE - 6, rough=160,
         metal=170)
    for fx in (0.18, 0.46, 0.74):
        gx = x0 + (x1 - x0) * fx
        m.d.rectangle([gx - 2, y0, gx + 2, y1], fill=shade(GUNSTEEL, 0.8))
    m.d.rectangle([x0 + (x1 - x0) * 0.88, y0, x1, y1],
                  fill=shade(GUNSTEEL, 0.88))
    for i in range(7):     # tally marks near the breech end of the tube
        tx = x0 + 14 + i * 8
        m.d.line([(tx, y0 + 8), (tx, y0 + 20)], fill=WHITE_MK, width=2)
    # brake: darker, scorched
    x0, y0, x1, y1 = L.C_BRAKE
    fill(m, (x0, y0, x1, y1), dif=GUNSTEEL_D, ao=AO_BASE - 14, rough=190,
         metal=150)
    m.d.rectangle([x0 + (x1 - x0) * 0.55, y0, x1, y1], fill=(42, 42, 44))
    # recuperator: steel cylinder with clamp bands
    x0, y0, x1, y1 = L.C_RECUP
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)
    for fx in (0.25, 0.75):
        gx = x0 + (x1 - x0) * fx
        m.d.rectangle([gx - 4, y0, gx + 4, y1], fill=STEEL_DK)


# ── deck furniture ──────────────────────────────────────────────────────

def paint_furniture(m):
    # ammo lockers: straps, latches, stencil
    x0, y0, x1, y1 = L.C_LOCKER_S.rect
    fill(m, (x0, y0, x1, y1), dif=shade(LOWER, 1.06), ao=AO_BASE - 12)
    for fx in (0.3, 0.7):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 3, y0 + 4, sx + 3, y1 - 4], fill=STEEL_DK)
        m.d.rectangle([sx - 5, (y0 + y1) / 2 - 5, sx + 5,
                       (y0 + y1) / 2 + 5], fill=STEEL)
    numeral(m, (x0 + x1) / 2, y0 + 22, 'AMMO', 20, color=YELLOW)
    wear_edges(m, (x0, y0, x1, y1), LOWER, 25)
    x0, y0, x1, y1 = L.C_LOCKER_T.rect
    fill(m, (x0, y0, x1, y1), dif=shade(LOWER, 1.02), ao=AO_BASE - 8)
    for fx in (0.3, 0.7):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 3, y0 + 4, sx + 3, y1 - 4], fill=STEEL_DK)
    x0, y0, x1, y1 = L.C_LOCKER_E.rect
    fill(m, (x0, y0, x1, y1), dif=shade(LOWER, 0.98), ao=AO_BASE - 14)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, LOWER)

    # recoil spade plates: bare steel, earth-stained tips, rib
    x0, y0, x1, y1 = L.C_SPADE.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 10, rough=R_STEEL + 20,
         metal=M_STEEL)
    m.d.rectangle([x0, y1 - 34, x1, y1], fill=(74, 64, 52))
    m.o.rectangle([x0, y1 - 34, x1, y1], fill=(AO_BASE - 30, 220, 40))
    for fx in (0.25, 0.5, 0.75):
        gx = x0 + (x1 - x0) * fx
        m.d.rectangle([gx - 3, y0 + 4, gx + 3, y1 - 4],
                      fill=shade(STEEL, 0.8))
    bolts(m, [(x0 + 16 + i * ((x1 - x0 - 32) / 3), y0 + 10)
              for i in range(4)], base=STEEL)
    wear_edges(m, (x0, y0, x1, y1), STEEL, 35)

    # trim wrap (crane, small parts)
    fill(m, L.C_TRIM, dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)
    x0, y0, x1, y1 = L.C_TRIM
    for fy in (0.33, 0.66):
        gy = y0 + (y1 - y0) * fy
        m.d.rectangle([x0, gy - 2, x1, gy + 2], fill=(150, 154, 159))

    # amber deck work-light
    z = L.C_LIGHT
    fill(m, z.rect, dif=AMBER, ao=AO_BASE, rough=R_GLASS, metal=M_GLASS)
    x0, y0, x1, y1 = z.rect
    m.e.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2], fill=shade(AMBER, 0.8))


# ── assemble ────────────────────────────────────────────────────────────

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
    paint_engine(m)
    paint_mount(m)
    paint_shield(m)
    paint_gun(m)
    paint_furniture(m)

    # ── weathering: heavy field gun — mud low, soot at stacks/brake ──
    wx = PL.standard_weather(
        m, L,
        ground_rects=(L.C_TRACK_WRAP, L.C_FENDER.rect),
        side_zones=(L.C_HULL_SIDE, L.C_GLACIS, L.C_HULL_REAR),
        seed=41, mud=0.55, grime=0.55, rust_fraction=0.5)
    wx.mud_band(L.C_TRACK_SIDE.rect, 0.95, fade='down')
    wx.mud_band(L.C_HULL_TOP.rect, 0.15, fade=None, spatter=False)
    wx.mud_band(L.C_ENGINE_SIDE.rect, 0.25, fade='down', spatter=False)
    wx.mud_band(L.C_SPADE.rect, 0.6, fade='down')
    wx.mud_band(L.C_LOCKER_S.rect, 0.25, fade='down', spatter=False)
    tx0, ty0, tx1, ty1 = L.C_TRACK_SIDE.rect
    for r in (L.C_HULL_SIDE.rect, L.C_GLACIS.rect, L.C_HULL_REAR.rect):
        wx.plate_bottom_rust(r, n=6, strength=0.5)
    wx.plate_bottom_rust((tx0, ty0, tx1, ty1), n=8, band=8, strength=0.6)
    wx.soot_patch(L.C_STACK, 0.75)
    wx.soot_patch(L.C_BRAKE, 0.6)
    sx0, sy0, sx1, sy1 = L.C_SHIELD_F.rect
    for fx in (0.2, 0.5, 0.8):
        wx.rust_streak(sx0 + (sx1 - sx0) * fx, sy0 + 18, 30, strength=0.35)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    zone = L.C_TRACK_SIDE

    def hpy(wy):
        return zone.uv((0, wy, 0))[1] * W

    def hpz(wz):
        return zone.uv((0, 0, wz))[0] * W

    hm.rect((tx0, hpy(0.92), tx1, hpy(0.05)), -3.0)
    for wz in L.ROAD_WHEELS:
        cx, cy = hpz(wz), hpy(L.WHEEL_CY)
        r = hpz(wz + L.WHEEL_R) - hpz(wz)
        hm.disc(cx, cy, r, 0.35)
        hm.disc(cx, cy, r * 0.64, 0.55)
        hm.disc(cx, cy, 4, 0.7)
    # discrete track links
    wx0, wy0, wx1, wy1 = L.C_TRACK_WRAP
    for i in range(64):
        lx = wx0 + (wx1 - wx0) * i / 64
        lw = (wx1 - wx0) / 64
        hm.rect((lx + 1.5, wy0, lx + lw - 1.5, wy1), 0.5)
        hm.rect((lx + lw * 0.35, wy0 + 2, lx + lw * 0.65, wy1 - 2), 0.85)
    # fender tread diamonds
    fx0, fy0, fx1, fy1 = L.C_FENDER.rect
    for gx in range(fx0 + 6, fx1 - 4, 14):
        for gy in range(fy0 + 6, fy1 - 4, 12):
            off = 4 if ((gy - fy0) // 12) % 2 else 0
            hm.line((gx + off, gy), (gx + off + 5, gy + 4), 0.45, width=2)
    # engine intake recesses
    ex0, ey0, ex1, ey1 = L.C_ENGINE_TOP.rect
    for fv in (0.28, 0.72):
        gy = ey0 + (ey1 - ey0) * fv
        hm.rect((ex0 + 14, gy - 22, ex1 - 14, gy + 22), -0.6)
    # shield patch plates proud
    hm.rect((sx0 + 8, sy0 + 8, sx1 - 8, sy1 - 8), 0.25)

    PL.finish(m, L, STEM, hm=hm, wx=wx, outdir='out')


if __name__ == '__main__':
    paint_all()
