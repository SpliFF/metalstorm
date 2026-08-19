"""paint_ms_artillery_s4 — 2048² PBR set for ms_artillery_s4.

Continental siege gun: line-artillery blue-grey armour language, girder
carriage with riveted web sides, gunmetal howitzer with a painted team
ring stripe behind the muzzle brake, big hull-side team banners, olive
shells with brass driving bands. Emissive: headlights, two amber deck
floods, small amber breech/instrument glows. Heavy kinetic weathering —
rust under fittings, soot at brake and stacks, mud at the runs.
"""
from __future__ import annotations
import os
import numpy as np

import ms_artillery_s4_layout as L    # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import font
from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, LOWER, STEEL, STEEL_DK,
                   RUBBER, TRACK_MET, GLASS, YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_RUBBER, R_GLASS,
                   M_ARMOR, M_STEEL, M_TRACK, M_GLASS, RNG)
import paintlib as PL

W = 2048
STEM = 'ms_artillery_s4'

GUNMETAL  = (72, 74, 78)
GUNM_DK   = (56, 58, 62)
OLIVE     = (96, 98, 70)
BRASS     = (168, 138, 72)
AMBER     = (255, 176, 60)
WHITE_MK  = (198, 202, 206)


def numeral(m, cx, cy, text, size, color=WHITE_MK):
    f = PL.font(size)
    tw = m.d.textlength(text, font=f)
    m.d.text((cx - tw / 2 + 2, cy - size * 0.55 + 2), text, font=f,
             fill=shade(ARMOR_DK, 0.55))
    m.d.text((cx - tw / 2, cy - size * 0.55), text, font=f, fill=color)


# ── deck ────────────────────────────────────────────────────────────────

def paint_deck_top(m):
    z = L.C_DECK_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    for _ in range(9):
        bx = x0 + RNG.random() * (x1 - x0 - 110)
        by = y0 + RNG.random() * (y1 - y0 - 80)
        m.d.polygon([(bx, by + 14), (bx + 90, by), (bx + 108, by + 52),
                     (bx + 20, by + 68)], fill=jit(ARMOR_DK, 3))
    for wz in (-4.6, -3.4, -2.2, -1.0, 0.2, 1.6, 3.0, 4.2, 5.4):
        _, v = z.uv((0, 0, wz))
        seam_h(m, x0 + 4, x1 - 4, int(v * W), ARMOR)
    for wx in (-2.3, -1.1, 0.0, 1.1, 2.3):
        u, _ = z.uv((wx, 0, 0))
        seam_v(m, int(u * W), y0 + 4, y1 - 4, ARMOR)
    # turret ring seat: dark machined circle + bolt ring
    cu, cv = z.uv((0, 0, 0.8))
    cx, cy = cu * W, cv * W
    ru, _ = z.uv((2.05, 0, 0.8))
    r = ru * W - cx
    m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=shade(STEEL_DK, 0.9))
    m.o.ellipse([cx - r, cy - r, cx + r, cy + r],
                fill=(AO_BASE - 25, R_STEEL, M_STEEL))
    bolts(m, [(cx + np.cos(a) * r * 0.92, cy + np.sin(a) * r * 0.92)
              for a in np.linspace(0, 2 * np.pi, 16, endpoint=False)],
          base=STEEL_DK)
    # hazard band across the working rear deck
    _, hv0 = z.uv((0, 0, 3.95))
    _, hv1 = z.uv((0, 0, 4.2))
    PL.hazard_band(m, (x0 + 6, hv0 * W, x1 - 6, hv1 * W))
    # stack soot region gets darkened in weathering; grip strips at front
    for wz in (-3.3, -3.15):
        _, v = z.uv((0, 0, wz))
        m.d.rectangle([x0 + 30, v * W - 3, x1 - 30, v * W + 3],
                      fill=shade(ARMOR, 0.7))
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 70)


def paint_deck_side(m):
    z = L.C_DECK_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    # riveted girder web read: dark lower band + X-brace pattern
    midy = y0 + int((y1 - y0) * 0.45)
    m.d.rectangle([x0, midy, x1, y1], fill=shade(LOWER, 0.95))
    m.o.rectangle([x0, midy, x1, y1], fill=(AO_BASE - 25, R_ARMOR, M_ARMOR))
    seam_h(m, x0, x1, midy, ARMOR)
    st = (x1 - x0) // 12
    for i in range(12):
        gx = x0 + i * st
        m.d.line([(gx, midy + 2), (gx + st, y1 - 2)],
                 fill=shade(LOWER, 0.75), width=3)
        m.d.line([(gx + st, midy + 2), (gx, y1 - 2)],
                 fill=shade(LOWER, 0.75), width=3)
    bolts(m, [(x0 + 14 + i * ((x1 - x0 - 28) / 21.0), y0 + 12)
              for i in range(22)], base=ARMOR)
    bolts(m, [(x0 + 14 + i * ((x1 - x0 - 28) / 21.0), y1 - 10)
              for i in range(22)], base=LOWER)
    # hull number forward
    u, _ = z.uv((0, 0, -4.4))
    numeral(m, u * W, (y0 + y1) / 2, '04', 56)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 40)


def paint_deck_front(m):
    z = L.C_DECK_FRONT
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    for fx in (0.16, 0.84):
        lx = x0 + (x1 - x0) * fx
        ly = (y0 + y1) / 2
        PL.headlight(m, (lx - 14, ly - 9, lx + 14, ly + 9))
    # tow shackles
    for fx in (0.32, 0.68):
        tx = x0 + (x1 - x0) * fx
        m.d.rectangle([tx - 12, y1 - 26, tx + 12, y1 - 12], fill=STEEL_DK)
        m.d.ellipse([tx - 6, y1 - 23, tx + 6, y1 - 15], fill=BLACKISH)
    PL.hazard_band(m, (x0 + 4, y1 - 10, x1 - 4, y1 - 2))
    bolts(m, [(x0 + 12 + i * ((x1 - x0 - 24) / 9.0), y0 + 10)
              for i in range(10)], base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 40)


def paint_deck_rear(m):
    z = L.C_DECK_REAR
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    PL.taillight(m, (x0 + 16, y0 + 14, x0 + 46, y0 + 26))
    PL.taillight(m, (x1 - 46, y0 + 14, x1 - 16, y0 + 26))
    PL.team_panel(m, (x1 - 96, y0 + 10, x1 - 56, y0 + 40),
                  outline=shade(ARMOR_DK, 0.5))
    numeral(m, (x0 + x1) / 2, (y0 + y1) / 2, '04', 48)
    PL.hazard_band(m, (x0 + 4, y1 - 10, x1 - 4, y1 - 2))
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 35)


def paint_dark(m):
    fill(m, L.C_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)


# ── running gear ────────────────────────────────────────────────────────

def paint_tracks_side(m):
    zone = L.C_TRACK_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=LOWER, ao=AO_BASE - 25)

    def py(wy):
        return zone.uv((0, wy, 0))[1] * W

    def pz(wz):
        return zone.uv((0, 0, wz))[0] * W

    m.d.rectangle([x0, py(1.05), x1, py(0.06)], fill=BLACKISH)
    m.o.rectangle([x0, py(1.05), x1, py(0.06)],
                  fill=(AO_DEEP - 30, R_RUBBER, 30))
    for wz in L.ROAD_WHEELS:
        cx, cy = pz(wz), py(0.52)
        r = pz(wz + 0.46) - pz(wz)
        m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=RUBBER)
        r2 = r * 0.62
        m.d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2],
                    fill=jit(TRACK_MET, 3))
        m.o.ellipse([cx - r, cy - r, cx + r, cy + r],
                    fill=(AO_DEEP, R_RUBBER, 30))
        m.o.ellipse([cx - r2, cy - r2, cx + r2, cy + r2],
                    fill=(AO_SEAM, R_STEEL, M_TRACK))
        for k in range(6):
            a = k * np.pi / 3 + 0.3
            bolts(m, [(cx + np.cos(a) * r2 * 0.55,
                       cy + np.sin(a) * r2 * 0.55)], r=3, base=TRACK_MET)
        m.d.ellipse([cx - 4, cy - 4, cx + 4, cy + 4], fill=STEEL_DK)
    # upper run band + return rollers
    uy0, uy1 = py(1.60), py(1.30)
    m.d.rectangle([x0, uy0, x1, uy1], fill=shade(LOWER, 0.9))
    for wz in (-2.2, 0.0, 2.2):
        cx = pz(wz)
        m.d.ellipse([cx - 12, (uy0 + uy1) / 2 - 12, cx + 12,
                     (uy0 + uy1) / 2 + 12], fill=jit(TRACK_MET, 4))
    wear_edges(m, (x0, y0, x1, y1), LOWER, 40)


def paint_track_wrap(m):
    x0, y0, x1, y1 = L.C_TRACK_WRAP
    fill(m, (x0, y0, x1, y1), dif=TRACK_MET, ao=AO_SEAM, rough=R_RUBBER,
         metal=M_TRACK)
    n = 72
    for i in range(n):
        lx = x0 + (x1 - x0) * i / n
        lw = (x1 - x0) / n
        m.d.rectangle([lx + 1, y0, lx + lw - 1, y1], fill=jit(TRACK_MET, 5))
        m.d.line([(lx, y0), (lx, y1)], fill=BLACKISH, width=2)
        m.d.rectangle([lx + lw * 0.35, y0 + 3, lx + lw * 0.65, y1 - 3],
                      fill=RUBBER)
        m.o.rectangle([lx + lw * 0.35, y0 + 3, lx + lw * 0.65, y1 - 3],
                      fill=(AO_SEAM, R_RUBBER, 60))


def paint_skirt(m):
    z = L.C_SKIRT
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 10)
    for i in range(7):
        sx = x0 + (x1 - x0) * (i + 1) / 8.0
        seam_v(m, int(sx), y0 + 3, y1 - 3, ARMOR_DK)
    bolts(m, [(x0 + (x1 - x0) * (i + 0.5) / 8.0, y0 + 12)
              for i in range(8)], base=ARMOR_DK)
    bolts(m, [(x0 + (x1 - x0) * (i + 0.5) / 8.0, y1 - 12)
              for i in range(8)], base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 40)


def paint_fender(m):
    x0, y0, x1, y1 = L.C_FENDER.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 8)
    for gx in range(x0 + 8, x1 - 6, 18):
        for gy in range(y0 + 8, y1 - 6, 16):
            off = 5 if ((gy - y0) // 16) % 2 else 0
            m.d.line([(gx + off, gy), (gx + off + 6, gy + 5)],
                     fill=shade(ARMOR_DK, 1.28), width=2)
    seam_h(m, x0, x1, y0 + 3, ARMOR_DK, hi=False)


# ── turret ──────────────────────────────────────────────────────────────

def paint_house_side(m):
    z = L.C_HOUSE_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    # big team banner panel on the counterweight flank
    pu0, pv0 = z.uv((0, 1.7, 0.55))
    pu1, pv1 = z.uv((0, 0.7, 2.55))
    PL.team_panel(m, (pu0 * W, pv0 * W, pu1 * W, pv1 * W),
                  outline=shade(ARMOR, 0.5))
    numeral(m, (pu0 + pu1) / 2 * W, (pv0 + pv1) / 2 * W, '04', 72,
            color=(50, 54, 60))
    for wz in (0.9, 1.9):
        u, _ = z.uv((0, 0, wz))
        seam_v(m, int(u * W), y0 + 3, y1 - 3, ARMOR)
    bolts(m, [(x0 + 14 + i * ((x1 - x0 - 28) / 11.0), y1 - 12)
              for i in range(12)], base=ARMOR)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 35)


def paint_house_front(m):
    x0, y0, x1, y1 = L.C_HOUSE_FRONT.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    seam_v(m, (x0 + x1) // 2, y0 + 3, y1 - 3, ARMOR_DK)
    # breech instrument row: small amber gauges (functional glow)
    gy = y0 + (y1 - y0) * 0.62
    for fx in (0.22, 0.34, 0.66, 0.78):
        gx = x0 + (x1 - x0) * fx
        m.d.rectangle([gx - 9, gy - 7, gx + 9, gy + 7], fill=(40, 36, 30))
        m.e.rectangle([gx - 6, gy - 4, gx + 6, gy + 4], fill=(150, 92, 26))
        m.o.rectangle([gx - 9, gy - 7, gx + 9, gy + 7],
                      fill=(AO_SEAM, R_GLASS, M_GLASS))
    bolts(m, [(x0 + 12 + i * ((x1 - x0 - 24) / 7.0), y0 + 10)
              for i in range(8)], base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 30)


def paint_house_rear(m):
    x0, y0, x1, y1 = L.C_HOUSE_REAR.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    db = [x0 + (x1 - x0) * 0.32, y0 + (y1 - y0) * 0.18,
          x0 + (x1 - x0) * 0.68, y1 - 8]
    m.d.rectangle(db, outline=shade(ARMOR_DK, 0.5), width=3)
    m.d.rectangle([db[0] + 12, (db[1] + db[3]) / 2 - 4,
                   db[0] + 34, (db[1] + db[3]) / 2 + 4], fill=STEEL_DK)
    # amber tell-tales over the door
    for i in range(3):
        lx = x0 + 28 + i * 22
        m.d.ellipse([lx - 5, y0 + 14, lx + 5, y0 + 24], fill=AMBER)
        m.e.ellipse([lx - 5, y0 + 14, lx + 5, y0 + 24],
                    fill=shade(AMBER, 0.65))
    numeral(m, x1 - 40, y0 + 30, '04', 34)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 30)


def paint_house_top(m):
    z = L.C_HOUSE_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    for _ in range(4):
        bx = x0 + RNG.random() * (x1 - x0 - 70)
        by = y0 + RNG.random() * (y1 - y0 - 50)
        m.d.polygon([(bx, by + 10), (bx + 58, by), (bx + 70, by + 34),
                     (bx + 12, by + 44)], fill=jit(ARMOR_DK, 3))
    for wz in (1.0, 2.0):
        _, v = z.uv((0, 0, wz))
        seam_h(m, x0 + 4, x1 - 4, int(v * W), ARMOR)
    PL.roundel_star(m, (x0 + x1) / 2, (y0 + y1) / 2, 44, WHITE_MK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 30)


def paint_ring(m):
    x0, y0, x1, y1 = L.C_RING
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 15, rough=R_STEEL,
         metal=M_STEEL)
    # v is around the drum: segment seams + bolt rows
    for i in range(8):
        gy = y0 + (y1 - y0) * i / 8.0
        m.d.line([(x0, gy), (x1, gy)], fill=shade(STEEL_DK, 0.7), width=2)
    bolts(m, [((x0 + x1) / 2, y0 + (y1 - y0) * (i + 0.5) / 8.0)
              for i in range(8)], base=STEEL_DK)
    # ring top annulus
    z = L.C_RING_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(STEEL_DK, 1.05), ao=AO_BASE - 15,
         rough=R_STEEL, metal=M_STEEL)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rr = (x1 - x0) * 0.46
    m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                outline=shade(STEEL_DK, 0.65), width=4)
    bolts(m, [(cx + np.cos(a) * rr * 0.88, cy + np.sin(a) * rr * 0.88)
              for a in np.linspace(0, 2 * np.pi, 14, endpoint=False)],
          base=STEEL_DK)


def paint_trunnion(m):
    z = L.C_TRUNNION
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 10)
    # trunnion hub disc at the pivot
    hu, hv = z.uv((0, 0, -0.1, ))[0], z.uv((0, 1.35, -0.1))[1]
    cx, cy = hu * W, hv * W
    r = 34
    m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=STEEL_DK)
    m.o.ellipse([cx - r, cy - r, cx + r, cy + r],
                fill=(AO_SEAM, R_STEEL, M_STEEL))
    bolts(m, [(cx + np.cos(a) * r * 0.7, cy + np.sin(a) * r * 0.7)
              for a in np.linspace(0, 2 * np.pi, 8, endpoint=False)],
          base=STEEL_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 30)


# ── gun ─────────────────────────────────────────────────────────────────

def paint_barrel(m):
    # inner tube: gunmetal with jacket step shading (u along the tube)
    x0, y0, x1, y1 = L.C_BARREL
    fill(m, (x0, y0, x1, y1), dif=GUNMETAL, ao=AO_BASE - 8, rough=150,
         metal=140)
    m.d.rectangle([x0, y0, x0 + int((x1 - x0) * 0.30), y1],
                  fill=shade(GUNMETAL, 1.08))
    for fu in (0.30, 0.55, 0.80):
        gx = x0 + (x1 - x0) * fu
        m.d.rectangle([gx - 3, y0, gx + 3, y1], fill=GUNM_DK)
    # outer tube: team ring stripe just behind the brake
    x0, y0, x1, y1 = L.C_BARREL2
    fill(m, (x0, y0, x1, y1), dif=GUNMETAL, ao=AO_BASE - 8, rough=150,
         metal=140)
    s0 = x0 + int((x1 - x0) * 0.74)
    s1 = x0 + int((x1 - x0) * 0.90)
    m.d.rectangle([s0, y0, s1, y1], fill=TEAMGREY)
    m.t.rectangle([s0, y0, s1, y1], fill=(255, 0, 0))
    m.d.rectangle([s0, y0, s1, y1], outline=GUNM_DK, width=2)
    # brake: near-black, heat-worn
    x0, y0, x1, y1 = L.C_BRAKE
    fill(m, (x0, y0, x1, y1), dif=(52, 52, 55), ao=AO_BASE - 20, rough=180,
         metal=120)
    for fu in (0.25, 0.55, 0.85):
        gx = x0 + (x1 - x0) * fu
        m.d.rectangle([gx - 4, y0, gx + 4, y1], fill=(36, 36, 38))
    # caps: bore + breech plate
    x0, y0, x1, y1 = L.C_CAP_F.rect
    fill(m, (x0, y0, x1, y1), dif=(30, 30, 32), ao=AO_DEEP, rough=200,
         metal=60)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    m.d.ellipse([cx - 14, cy - 14, cx + 14, cy + 14], fill=(12, 12, 12))
    x0, y0, x1, y1 = L.C_CAP_R.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 15)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    bolts(m, [(cx + np.cos(a) * 24, cy + np.sin(a) * 24)
              for a in np.linspace(0, 2 * np.pi, 8, endpoint=False)],
          base=ARMOR_DK)
    # breech jacket: dark green-grey, bolt rows, amber instrument dot
    x0, y0, x1, y1 = L.C_BREECH
    fill(m, (x0, y0, x1, y1), dif=(70, 74, 64), ao=AO_BASE - 10, rough=170,
         metal=110)
    for fu in (0.30, 0.70):
        gx = x0 + (x1 - x0) * fu
        m.d.rectangle([gx - 3, y0, gx + 3, y1], fill=(52, 55, 47))
        bolts(m, [(gx + 12, y0 + (y1 - y0) * (i + 0.5) / 5.0)
                  for i in range(5)], base=(70, 74, 64))
    gx = x0 + int((x1 - x0) * 0.88)
    gy = (y0 + y1) // 2
    m.d.rectangle([gx - 8, gy - 6, gx + 8, gy + 6], fill=(40, 36, 30))
    m.e.rectangle([gx - 5, gy - 3, gx + 5, gy + 3], fill=(150, 92, 26))
    # recuperators: steel with bands
    x0, y0, x1, y1 = L.C_RECUP
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)
    for fu in (0.18, 0.5, 0.82):
        gx = x0 + (x1 - x0) * fu
        m.d.rectangle([gx - 4, y0, gx + 4, y1], fill=STEEL_DK)


# ── dressing ────────────────────────────────────────────────────────────

def paint_banner(m):
    z = L.C_BANNER
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=TEAMGREY, ao=AO_BASE - 4, rough=235,
         metal=0)
    m.t.rectangle([x0, y0, x1, y1], fill=(255, 0, 0))
    for gy in range(y0 + 8, y1, 22):
        m.d.line([(x0 + 2, gy), (x1 - 2, gy)],
                 fill=jit(shade(TEAMGREY, 0.94), 3), width=2)
    # dark lashing sleeve top + punched sigil (kept off the mask)
    m.d.rectangle([x0, y0, x1, y0 + 16], fill=(38, 40, 46))
    m.t.rectangle([x0, y0, x1, y0 + 16], fill=(0, 0, 0))
    cx, cy = (x0 + x1) / 2, y0 + (y1 - y0) * 0.45
    r = (x1 - x0) * 0.26
    m.d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(38, 40, 46),
                width=5)
    PL.roundel_star(m, cx, cy, r * 0.7, (38, 40, 46), ring=False)
    m.t.ellipse([cx - r - 3, cy - r - 3, cx + r + 3, cy + r + 3],
                fill=(0, 0, 0))
    wear_edges(m, (x0, y0, x1, y1), TEAMGREY, 25)


def paint_shells(m):
    x0, y0, x1, y1 = L.C_SHELL
    fill(m, (x0, y0, x1, y1), dif=OLIVE, ao=AO_BASE - 6, rough=180,
         metal=60)
    # brass driving bands near the base (low u) and mid
    for f0, f1 in ((0.06, 0.11), (0.30, 0.34)):
        m.d.rectangle([x0 + (x1 - x0) * f0, y0, x0 + (x1 - x0) * f1, y1],
                      fill=BRASS)
        m.o.rectangle([x0 + (x1 - x0) * f0, y0, x0 + (x1 - x0) * f1, y1],
                      fill=(AO_BASE, 90, 220))
    # stencil ring
    gx = x0 + int((x1 - x0) * 0.6)
    m.d.rectangle([gx - 3, y0, gx + 3, y1], fill=WHITE_MK)
    wear_edges(m, (x0, y0, x1, y1), OLIVE, 25)


def paint_cab(m):
    z = L.C_CAB_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    PL.glass_rect(m, (x0 + (x1 - x0) * 0.55, y0 + 16,
                      x1 - 12, y0 + 42))
    bolts(m, [(x0 + 10 + i * ((x1 - x0 - 20) / 5.0), y1 - 10)
              for i in range(6)], base=ARMOR)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 25)
    x0, y0, x1, y1 = L.C_CAB_FRONT.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    PL.glass_rect(m, (x0 + 14, y0 + 14, x1 - 14, y0 + 40))
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 25)
    x0, y0, x1, y1 = L.C_CAB_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    m.d.ellipse([(x0 + x1) / 2 - 26, (y0 + y1) / 2 - 26,
                 (x0 + x1) / 2 + 26, (y0 + y1) / 2 + 26], fill=ARMOR_DK,
                outline=shade(ARMOR_DK, 0.6), width=3)


def paint_spade(m):
    z = L.C_SPADE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 20)
    for i in range(4):
        gx = x0 + (x1 - x0) * (i + 1) / 5.0
        seam_v(m, int(gx), y0 + 3, y1 - 3, ARMOR_DK)
    bolts(m, [(x0 + (x1 - x0) * (i + 0.5) / 5.0, y0 + 14)
              for i in range(5)], base=ARMOR_DK)
    # bare-steel dig edge
    m.d.rectangle([x0, y1 - 14, x1, y1], fill=STEEL)
    m.o.rectangle([x0, y1 - 14, x1, y1], fill=(AO_BASE, 100, 210))
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 50)


def paint_small_cells(m):
    # girder/gantry/trim parametric wraps
    fill(m, L.C_GIRDER, dif=shade(ARMOR_DK, 1.05), ao=AO_BASE - 10,
         rough=R_ARMOR, metal=60)
    x0, y0, x1, y1 = L.C_GIRDER
    for fy in (0.3, 0.7):
        m.d.line([(x0, y0 + (y1 - y0) * fy), (x1, y0 + (y1 - y0) * fy)],
                 fill=shade(ARMOR_DK, 0.75), width=2)
    fill(m, L.C_GANTRY, dif=STEEL_DK, ao=AO_BASE - 12, rough=R_STEEL,
         metal=M_STEEL)
    fill(m, L.C_TRIM, dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)
    fill(m, L.C_TRIM_BOX.rect, dif=shade(STEEL_DK, 1.06), ao=AO_BASE - 8,
         rough=R_STEEL, metal=M_STEEL)
    x0, y0, x1, y1 = L.C_TRIM_BOX.rect
    m.d.rectangle([x0, (y0 + y1) // 2 - 3, x1, (y0 + y1) // 2 + 3],
                  fill=shade(STEEL_DK, 0.8))
    # girder-box cell: painted lattice web
    z = L.C_GIRDER_BOX
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(LOWER, 0.92), ao=AO_BASE - 22)
    st = (x1 - x0) // 10
    for i in range(10):
        gx = x0 + i * st
        m.d.line([(gx, y0 + 2), (gx + st, y1 - 2)],
                 fill=shade(LOWER, 0.7), width=3)
        m.d.line([(gx + st, y0 + 2), (gx, y1 - 2)],
                 fill=shade(LOWER, 0.7), width=3)
    bolts(m, [(x0 + 10 + i * ((x1 - x0 - 20) / 13.0), y0 + 8)
              for i in range(14)], base=LOWER)
    # amber flood/lamp cell — fully emissive warm
    z = L.C_LIGHT
    fill(m, z.rect, dif=AMBER, ao=AO_BASE, rough=R_GLASS, metal=M_GLASS)
    x0, y0, x1, y1 = z.rect
    m.e.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2], fill=shade(AMBER, 0.85))


# ── assemble ────────────────────────────────────────────────────────────

def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_dark(m)
    paint_deck_top(m)
    paint_deck_side(m)
    paint_deck_front(m)
    paint_deck_rear(m)
    paint_tracks_side(m)
    paint_track_wrap(m)
    paint_skirt(m)
    paint_fender(m)
    paint_house_side(m)
    paint_house_front(m)
    paint_house_rear(m)
    paint_house_top(m)
    paint_ring(m)
    paint_trunnion(m)
    paint_barrel(m)
    paint_banner(m)
    paint_shells(m)
    paint_cab(m)
    paint_spade(m)
    paint_small_cells(m)

    # ── weathering: heavy kinetic — this thing crawls through the waste ──
    wx = PL.standard_weather(
        m, L,
        ground_rects=[L.C_TRACK_SIDE.rect, L.C_TRACK_WRAP, L.C_SKIRT.rect,
                      L.C_SPADE.rect, L.C_FENDER.rect],
        side_zones=[L.C_DECK_SIDE, L.C_DECK_FRONT, L.C_DECK_REAR,
                    L.C_HOUSE_SIDE, L.C_HOUSE_FRONT, L.C_HOUSE_REAR,
                    L.C_CAB_SIDE, L.C_BANNER],
        seed=47, mud=0.55, grime=0.6)
    # soot: muzzle brake, outer tube end, exhaust stack region of the deck
    wx.soot_patch(L.C_BRAKE, 0.7)
    bx0, by0, bx1, by1 = L.C_BARREL2
    wx.soot_patch((bx0 + int((bx1 - bx0) * 0.9), by0, bx1, by1), 0.5)
    zt = L.C_DECK_TOP
    su0, sv0 = zt.uv((2.2, 0, -4.2))
    su1, sv1 = zt.uv((0.4, 0, -3.0))
    wx.soot_patch((min(su0, su1) * W, sv0 * W, max(su0, su1) * W, sv1 * W),
                  0.55)
    # rust streaks under deck-side fittings and skirt bolts
    dx0, dy0, dx1, dy1 = L.C_DECK_SIDE.rect
    for fx in (0.12, 0.3, 0.52, 0.7, 0.88):
        wx.rust_streak(dx0 + (dx1 - dx0) * fx, dy0 + 14, 30, strength=0.4)
    kx0, ky0, kx1, ky1 = L.C_SKIRT.rect
    for i in range(8):
        wx.rust_streak(kx0 + (kx1 - kx0) * (i + 0.5) / 8.0, ky0 + 16, 40,
                       strength=0.45)
    wx.plate_bottom_rust(L.C_SKIRT.rect, n=8, band=10, strength=0.6)
    wx.plate_bottom_rust(L.C_DECK_SIDE.rect, n=6, strength=0.45)

    # ── height map extras ──
    from normals import HeightMap
    hm = HeightMap()
    zone = L.C_TRACK_SIDE

    def hpy(wy):
        return zone.uv((0, wy, 0))[1] * W

    def hpz(wz):
        return zone.uv((0, 0, wz))[0] * W

    tx0, ty0, tx1, ty1 = zone.rect
    hm.rect((tx0, hpy(1.05), tx1, hpy(0.06)), -3.0)
    for wz in L.ROAD_WHEELS:
        cx, cy = hpz(wz), hpy(0.52)
        r = hpz(wz + 0.46) - hpz(wz)
        hm.disc(cx, cy, r, 0.3)
        hm.disc(cx, cy, r * 0.62, 0.5)
        hm.disc(cx, cy, 5, 0.68)
    wx0, wy0, wx1, wy1 = L.C_TRACK_WRAP
    for i in range(72):
        lx = wx0 + (wx1 - wx0) * i / 72
        lw = (wx1 - wx0) / 72
        hm.rect((lx + 1.5, wy0, lx + lw - 1.5, wy1), 0.5)
        hm.rect((lx + lw * 0.35, wy0 + 3, lx + lw * 0.65, wy1 - 3), 0.85)
    fx0, fy0, fx1, fy1 = L.C_FENDER.rect
    for gx in range(fx0 + 8, fx1 - 6, 18):
        for gy in range(fy0 + 8, fy1 - 6, 16):
            off = 5 if ((gy - fy0) // 16) % 2 else 0
            hm.line((gx + off, gy), (gx + off + 6, gy + 5), 0.45, width=2)

    PL.finish(m, L, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
