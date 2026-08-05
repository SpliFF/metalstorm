"""paint_ms_colossus_wreck — 2048 PBR set for ms_colossus_wreck.

Dead-machine repaint of the colossus language: faded chipped plate
overrun by rust blooms and soot shadows, oil-black joints, mud-caked
feet, raw torn-steel edges, scorched ash pad.  The ONLY emissive is the
small warm ember glow inside the cracked furnace chest (amber — human
tech, never cyan).  No team colour (--no-team map prop): team mask
stays black.  Large-quad cells kept tone-on-tone (impostor baker
flat-shades from the UV centroid).
"""
from __future__ import annotations
import numpy as np

import ms_colossus_wreck_layout as L   # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges,
                   jit, shade, BOLT_LOG,
                   ARMOR, STEEL, STEEL_DK, BLACKISH,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, M_ARMOR, M_STEEL, RNG)
import paintlib as PL

W = 2048
PLATE = (117, 110, 99)                # dead faded hull plate, sun-bleached warm
PLATE_DK = shade(PLATE, 0.85)
RUST = (132, 76, 44)
RUST_DK = (94, 55, 33)
SOOT = (50, 47, 44)
ASH = (110, 104, 96)
ASH_DK = (88, 82, 76)
IRON = (72, 68, 62)
EMBER = (255, 118, 28)
EMBER_DIM = (150, 58, 12)
BONE = (168, 158, 138)                # horn/claw keratin-steel
CHROME_DULL = (150, 154, 158)


def rust_blotches(m, rect, n, s0=0.5, s1=1.0):
    """Soft rust blooms — tone-on-tone, no hard stripes."""
    x0, y0, x1, y1 = rect
    for _ in range(n):
        rx = RNG.uniform(x0 + 6, x1 - 26)
        ry = RNG.uniform(y0 + 6, y1 - 22)
        rw = RNG.uniform(14, 46) * RNG.uniform(s0, s1)
        rh = rw * RNG.uniform(0.5, 0.9)
        c = jit(shade(RUST, RNG.uniform(0.8, 1.15)), 8)
        m.d.ellipse([rx, ry, rx + rw, ry + rh], fill=c)
        m.o.ellipse([rx, ry, rx + rw, ry + rh], fill=(AO_BASE - 12, 225, 30))
        if RNG.random() < 0.5:
            m.d.ellipse([rx + rw * 0.25, ry + rh * 0.25,
                         rx + rw * 0.7, ry + rh * 0.7], fill=jit(RUST_DK, 6))


def scorch(m, rect, n=6):
    x0, y0, x1, y1 = rect
    for _ in range(n):
        rx = RNG.uniform(x0, x1 - 40)
        ry = RNG.uniform(y0, y1 - 30)
        rw, rh = RNG.uniform(24, 70), RNG.uniform(16, 46)
        m.d.ellipse([rx, ry, rx + rw, ry + rh],
                    fill=jit(shade(SOOT, RNG.uniform(0.9, 1.25)), 4))


def plate_cellpaint(m, rect, base=PLATE, seams=3, riv=True, holes=2):
    x0, y0, x1, y1 = rect
    fill(m, rect, dif=base, ao=AO_BASE - 6, rough=205, metal=90)
    for i in range(1, seams + 1):
        sy = y0 + (y1 - y0) * i / (seams + 1)
        seam_h(m, x0 + 3, x1 - 3, int(sy), base)
    if riv:
        pts = [(x0 + 10, y0 + 10), (x1 - 10, y0 + 10),
               (x0 + 10, y1 - 10), (x1 - 10, y1 - 10)]
        bolts(m, pts, r=3, base=base)
    # shell holes / gouges
    for _ in range(holes):
        hx = RNG.uniform(x0 + 20, x1 - 20)
        hy = RNG.uniform(y0 + 20, y1 - 20)
        r = RNG.uniform(5, 11)
        m.d.ellipse([hx - r, hy - r, hx + r, hy + r], fill=BLACKISH)
        m.d.ellipse([hx - r * 1.7, hy - r * 1.7, hx + r * 1.7, hy + r * 1.7],
                    outline=jit(RUST_DK, 6), width=3)
        m.o.ellipse([hx - r, hy - r, hx + r, hy + r], fill=(AO_DEEP, 220, 40))
    rust_blotches(m, rect, max(3, (x1 - x0) // 90))
    wear_edges(m, rect, base, 60)


def paint_pad(m):
    x0, y0, x1, y1 = L.PAD_T
    fill(m, L.PAD_T, dif=ASH, ao=AO_BASE - 10, rough=225, metal=0)
    # ash mottle (tone-on-tone)
    for _ in range(1100):
        px = RNG.uniform(x0, x1 - 3)
        py = RNG.uniform(y0, y1 - 3)
        c = jit(shade(ASH, RNG.uniform(0.85, 1.12)), 5)
        m.d.rectangle([px, py, px + RNG.uniform(1, 4), py + RNG.uniform(1, 4)],
                      fill=c)
    # broad scorch shadow under the hulk (cell centre-left) + impact gouges
    m.d.ellipse([x0 + 40, y0 + 170, x1 - 150, y1 - 130],
                fill=jit(shade(ASH_DK, 0.9), 4))
    scorch(m, (x0 + 60, y0 + 190, x1 - 170, y1 - 150), 14)
    for _ in range(9):     # drag gouges radiating from the fall
        gx = RNG.uniform(x0 + 80, x1 - 120)
        gy = RNG.uniform(y0 + 120, y1 - 100)
        ang = RNG.uniform(0, np.pi)
        ln = RNG.uniform(40, 130)
        m.d.line([(gx, gy), (gx + np.cos(ang) * ln, gy + np.sin(ang) * ln)],
                 fill=jit(ASH_DK, 6), width=int(RNG.uniform(3, 7)))
    # debris speckle
    for _ in range(70):
        px = RNG.uniform(x0, x1 - 6)
        py = RNG.uniform(y0, y1 - 6)
        m.d.rectangle([px, py, px + RNG.uniform(2, 6), py + RNG.uniform(2, 5)],
                      fill=jit(IRON, 12) if RNG.random() < 0.5 else jit(RUST_DK, 10))
    wear_edges(m, L.PAD_T, ASH, 40)
    fill(m, L.PAD_S, dif=shade(ASH_DK, 0.9), ao=AO_BASE - 20, rough=230, metal=0)


def paint_torso(m):
    for zone, seams_v in ((L.C_TORSO_FRONT, (-1.1, 1.1)),
                          (L.C_TORSO_REAR, (-1.2, 1.2))):
        rect = zone.rect
        x0, y0, x1, y1 = rect
        fill(m, rect, dif=PLATE, ao=AO_BASE - 6, rough=205, metal=90)
        for wy in (0.8, 1.9, 3.0):
            _, v = zone.uv((0, wy, 0))
            seam_h(m, x0 + 4, x1 - 4, int(v * W), PLATE)
        for wx in seams_v:
            u, _ = zone.uv((wx, 0, 0))
            seam_v(m, int(u * W), y0 + 4, y1 - 4, PLATE)
        bolts(m, [(x0 + 14, y0 + 14), (x1 - 14, y0 + 14),
                  (x0 + 14, y1 - 14), (x1 - 14, y1 - 14)], r=3, base=PLATE)
        rust_blotches(m, rect, 10)
        scorch(m, rect, 7)
        wear_edges(m, rect, PLATE, 70)

    # side: plate upper band, machinery lower band (subtle split)
    zone = L.C_TORSO_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, zone.rect, dif=PLATE, ao=AO_BASE - 6, rough=205, metal=90)
    _, mv = zone.uv((0, 1.1, 0))
    m.d.rectangle([x0, int(mv * W), x1, y1], fill=shade(PLATE, 0.88))
    m.o.rectangle([x0, int(mv * W), x1, y1], fill=(AO_BASE - 26, R_ARMOR, M_ARMOR))
    seam_h(m, x0, x1, int(mv * W), PLATE)
    for wz in (-2.2, -0.9, 0.5, 1.4):
        u, _ = zone.uv((0, 0, wz))
        seam_v(m, int(u * W), y0 + 4, y1 - 4, PLATE)
    rust_blotches(m, zone.rect, 16)
    scorch(m, zone.rect, 9)
    wear_edges(m, zone.rect, PLATE, 60)

    # top carapace: subtle two-tone mottle only (impostor-safe)
    zone = L.C_TORSO_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, zone.rect, dif=PLATE, ao=AO_BASE - 5, rough=205, metal=90)
    for _ in range(9):
        bx = RNG.uniform(x0, x1 - 90)
        by = RNG.uniform(y0, y1 - 60)
        m.d.ellipse([bx, by, bx + RNG.uniform(40, 90), by + RNG.uniform(26, 60)],
                    fill=jit(shade(PLATE, RNG.uniform(0.9, 1.08)), 4))
    for wz in (-2.2, -0.6, 0.9):
        _, v = zone.uv((0, 0, wz))
        seam_h(m, x0 + 4, x1 - 4, int(v * W), PLATE)
    rust_blotches(m, zone.rect, 12)
    scorch(m, zone.rect, 6)
    wear_edges(m, zone.rect, PLATE, 70)


def paint_furnace(m):
    """Cracked chest furnace: iron grille over a dying ember bed."""
    x0, y0, x1, y1 = L.FURNACE_CELL
    fill(m, L.FURNACE_CELL, dif=IRON, ao=AO_BASE - 20, rough=210, metal=60)
    # ember bed: dim glow field with brighter cores (lower half hottest)
    for _ in range(120):
        px = RNG.uniform(x0 + 8, x1 - 12)
        py = RNG.uniform(y0 + 30, y1 - 8)
        r = RNG.uniform(2, 7)
        heat = RNG.uniform(0.25, 1.0) * (0.4 + 0.6 * (py - y0) / (y1 - y0))
        dif = tuple(int(c * (0.35 + 0.5 * heat)) for c in EMBER)
        emi = tuple(int(c * heat) for c in (EMBER if heat > 0.55 else EMBER_DIM))
        m.d.ellipse([px - r, py - r, px + r, py + r], fill=dif)
        m.e.ellipse([px - r, py - r, px + r, py + r], fill=emi)
    # glowing crack lines
    for _ in range(6):
        cx = RNG.uniform(x0 + 14, x1 - 40)
        cy = RNG.uniform(y0 + 44, y1 - 20)
        pts = [(cx, cy)]
        for _k in range(4):
            pts.append((pts[-1][0] + RNG.uniform(6, 22),
                        pts[-1][1] + RNG.uniform(-10, 10)))
        m.d.line(pts, fill=EMBER_DIM, width=2)
        m.e.line(pts, fill=(200, 84, 16), width=2)
    # iron grille bars over the embers
    for i in range(5):
        bx = x0 + (x1 - x0) * (i + 0.5) / 5
        m.d.rectangle([bx - 7, y0 + 6, bx + 7, y1 - 6], fill=jit(IRON, 5))
        m.o.rectangle([bx - 7, y0 + 6, bx + 7, y1 - 6],
                      fill=(AO_BASE - 8, 205, 70))
        m.e.rectangle([bx - 7, y0 + 6, bx + 7, y1 - 6], fill=(0, 0, 0))
    # frame + heavy soot top edge
    m.d.rectangle([x0 + 1, y0 + 1, x1 - 2, y1 - 2], outline=BLACKISH, width=5)
    m.e.rectangle([x0 + 1, y0 + 1, x1 - 2, y1 - 2], outline=(0, 0, 0), width=5)
    m.d.rectangle([x0, y0, x1, y0 + 22], fill=jit(SOOT, 4))


def paint_head(m):
    for zone in (L.C_HEAD_TOP, L.C_HEAD_SIDE):
        rect = zone.rect
        fill(m, rect, dif=PLATE, ao=AO_BASE - 6, rough=205, metal=90)
        x0, y0, x1, y1 = rect
        seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, PLATE)
        rust_blotches(m, rect, 8)
        scorch(m, rect, 4)
        wear_edges(m, rect, PLATE, 46)
    # front: dead visor slit — dark, NO emissive
    zone = L.C_HEAD_FRONT
    x0, y0, x1, y1 = zone.rect
    fill(m, zone.rect, dif=PLATE_DK, ao=AO_BASE - 10, rough=205, metal=90)
    u0, v0 = zone.uv((-0.72, 0.42, 0))
    u1, v1 = zone.uv((0.72, 0.12, 0))
    m.d.rectangle(PL.nbox(u0 * W, v0 * W, u1 * W, v1 * W), fill=BLACKISH)
    m.o.rectangle(PL.nbox(u0 * W, v0 * W, u1 * W, v1 * W), fill=(AO_DEEP, 160, 60))
    rust_blotches(m, zone.rect, 4, s0=0.4, s1=0.7)
    wear_edges(m, zone.rect, PLATE_DK, 40)


def paint_pack(m):
    zone = L.C_PACK
    x0, y0, x1, y1 = zone.rect
    fill(m, zone.rect, dif=PLATE_DK, ao=AO_BASE - 8, rough=210, metal=80)
    for fx in (0.3, 0.62):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 4, y1 - 4, PLATE_DK)
    rust_blotches(m, zone.rect, 14)
    scorch(m, zone.rect, 8)
    wear_edges(m, zone.rect, PLATE_DK, 55)
    x0, y0, x1, y1 = L.C_PACK_TOP.rect
    fill(m, L.C_PACK_TOP.rect, dif=shade(PLATE_DK, 0.94), ao=AO_BASE - 10,
         rough=210, metal=80)
    for i in range(1, 4):     # rack door seams (tone-on-tone)
        sx = x0 + (x1 - x0) * i / 4
        seam_v(m, int(sx), y0 + 3, y1 - 3, PLATE_DK)
    rust_blotches(m, L.C_PACK_TOP.rect, 6)
    wear_edges(m, L.C_PACK_TOP.rect, PLATE_DK, 36)


def paint_stack(m):
    x0, y0, x1, y1 = L.STACK_W
    fill(m, L.STACK_W, dif=IRON, ao=AO_BASE - 8, rough=195, metal=120)
    for i in range(6):     # circumference facets, subtle
        fx = x0 + (x1 - x0) * i / 6
        m.d.rectangle([fx, y0, fx + (x1 - x0) / 6, y1],
                      fill=jit(shade(IRON, 0.92 + 0.05 * (i % 3)), 3))
    m.d.rectangle([x0, y0, x1, y0 + (y1 - y0) // 4], fill=jit(SOOT, 4))
    rust_blotches(m, L.STACK_W, 8, s0=0.4, s1=0.8)
    wear_edges(m, L.STACK_W, IRON, 40)
    # top: sooted hollow
    x0, y0, x1, y1 = L.C_STACK_TOP.rect
    fill(m, L.C_STACK_TOP.rect, dif=SOOT, ao=AO_DEEP + 10, rough=225, metal=30)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    m.d.ellipse([cx - 40, cy - 40, cx + 40, cy + 40], fill=BLACKISH)
    m.o.ellipse([cx - 40, cy - 40, cx + 40, cy + 40], fill=(AO_DEEP, 230, 20))


def paint_pauldron_collar(m):
    plate_cellpaint(m, L.C_PAULDRON.rect, base=PLATE, seams=2, holes=3)
    plate_cellpaint(m, L.C_PAULDRON_S.rect, base=PLATE_DK, seams=1, holes=1)
    plate_cellpaint(m, L.COLLAR_CELL, base=PLATE_DK, seams=1, holes=1)
    plate_cellpaint(m, L.PELVIS_CELL, base=shade(PLATE, 0.9), seams=2, holes=1)
    plate_cellpaint(m, L.PLATE_CELL, base=PLATE, seams=2, holes=2)
    plate_cellpaint(m, L.RECEIVER_CELL, base=shade(IRON, 1.3), seams=2, holes=1)


def paint_fittings(m):
    # joint drums: oily dark steel with ring grooves
    x0, y0, x1, y1 = L.JOINT_W
    fill(m, L.JOINT_W, dif=STEEL_DK, ao=AO_BASE - 14, rough=160, metal=170)
    for fy in (0.3, 0.7):
        seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * fy), STEEL_DK)
    rust_blotches(m, L.JOINT_W, 4, s0=0.3, s1=0.6)
    fill(m, L.JOINT_CAP, dif=shade(STEEL_DK, 0.9), ao=AO_BASE - 16,
         rough=165, metal=170)
    x0, y0, x1, y1 = L.JOINT_CAP
    m.d.ellipse([x0 + 26, y0 + 26, x1 - 26, y1 - 26], outline=STEEL, width=3)
    bolts(m, [((x0 + x1) / 2, y0 + 18), ((x0 + x1) / 2, y1 - 18),
              (x0 + 18, (y0 + y1) / 2), (x1 - 18, (y0 + y1) / 2)],
          r=3, base=STEEL_DK)
    # hose: rubber with corrugation ribs
    x0, y0, x1, y1 = L.HOSE_W
    fill(m, L.HOSE_W, dif=(52, 50, 48), ao=AO_BASE - 12, rough=205, metal=10)
    for gx in range(x0 + 4, x1 - 2, 10):
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)], fill=(70, 68, 64), width=3)
    # piston: dulled chrome, rust-specked
    x0, y0, x1, y1 = L.PISTON_W
    fill(m, L.PISTON_W, dif=CHROME_DULL, ao=AO_BASE - 6, rough=90, metal=210)
    m.d.rectangle([x0, y0, x0 + (x1 - x0) // 2, y1], fill=shade(CHROME_DULL, 0.8))
    rust_blotches(m, L.PISTON_W, 3, s0=0.25, s1=0.5)
    # trim + dark + horn
    fill(m, L.TRIM_CELL, dif=(38, 40, 44), ao=AO_BASE - 12, rough=200, metal=60)
    rust_blotches(m, L.TRIM_CELL, 3, s0=0.3, s1=0.6)
    fill(m, L.DARK_CELL, dif=BLACKISH, ao=AO_DEEP, rough=210, metal=40)
    x0, y0, x1, y1 = L.C_HORN.rect
    fill(m, L.C_HORN.rect, dif=BONE, ao=AO_BASE - 6, rough=170, metal=50)
    m.d.rectangle([x0, y0, x1, y0 + (y1 - y0) // 3], fill=shade(BONE, 0.85))
    wear_edges(m, L.C_HORN.rect, BONE, 30)
    # torn metal: dark sheared body, bright raw edge at shard tips (v0)
    x0, y0, x1, y1 = L.TORN_CELL
    fill(m, L.TORN_CELL, dif=shade(IRON, 0.85), ao=AO_BASE - 18, rough=185,
         metal=140)
    m.d.rectangle([x0, y0, x1, y0 + 26], fill=(172, 176, 180))   # raw shear
    m.d.rectangle([x0, y0 + 26, x1, y0 + 44], fill=jit(RUST, 6))
    for _ in range(14):
        sx = RNG.uniform(x0, x1 - 8)
        m.d.line([(sx, y0 + 20), (sx + RNG.uniform(-6, 6), y0 + RNG.uniform(50, 110))],
                 fill=jit(RUST_DK, 8), width=2)
    rust_blotches(m, (x0, y0 + 40, x1, y1), 6)


def paint_limbs_weapons(m):
    # limb wrap: armor with knee-band + grime (u along limb, v around)
    x0, y0, x1, y1 = L.LIMB_W
    fill(m, L.LIMB_W, dif=PLATE, ao=AO_BASE - 8, rough=205, metal=90)
    for fx in (0.33, 0.66):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 3, y1 - 3, PLATE)
    rust_blotches(m, L.LIMB_W, 14)
    scorch(m, L.LIMB_W, 6)
    wear_edges(m, L.LIMB_W, PLATE, 55)
    # arm wrap
    x0, y0, x1, y1 = L.ARM_W
    fill(m, L.ARM_W, dif=PLATE_DK, ao=AO_BASE - 8, rough=205, metal=90)
    seam_v(m, (x0 + x1) // 2, y0 + 3, y1 - 3, PLATE_DK)
    rust_blotches(m, L.ARM_W, 10)
    wear_edges(m, L.ARM_W, PLATE_DK, 45)
    # foot: mud-caked plate
    x0, y0, x1, y1 = L.C_FOOT_SIDE.rect
    fill(m, L.C_FOOT_SIDE.rect, dif=shade(PLATE, 0.85), ao=AO_BASE - 12,
         rough=215, metal=70)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, shade(PLATE, 0.85))
    rust_blotches(m, L.C_FOOT_SIDE.rect, 8)
    wear_edges(m, L.C_FOOT_SIDE.rect, shade(PLATE, 0.85), 40)
    fill(m, L.FOOT_W, dif=shade(PLATE, 0.8), ao=AO_BASE - 14, rough=218, metal=70)
    rust_blotches(m, L.FOOT_W, 8)
    # gun tubes: gunmetal, soot toward the muzzle (u1 side)
    x0, y0, x1, y1 = L.GUN_W
    fill(m, L.GUN_W, dif=shade(IRON, 1.2), ao=AO_BASE - 8, rough=170, metal=170)
    for fx in (0.15, 0.5, 0.85):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 2, y1 - 2, shade(IRON, 1.2))
    rust_blotches(m, L.GUN_W, 6, s0=0.3, s1=0.6)
    # muzzle cell: dark bores
    x0, y0, x1, y1 = L.C_MUZZLE.rect
    fill(m, L.C_MUZZLE.rect, dif=SOOT, ao=AO_DEEP + 15, rough=210, metal=60)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    m.d.ellipse([cx - 34, cy - 34, cx + 34, cy + 34], fill=BLACKISH)
    m.o.ellipse([cx - 34, cy - 34, cx + 34, cy + 34], fill=(AO_DEEP, 220, 30))
    # ammo drum wrap + cap
    x0, y0, x1, y1 = L.TANK_W
    fill(m, L.TANK_W, dif=shade(IRON, 1.1), ao=AO_BASE - 8, rough=180, metal=150)
    for fy in (0.3, 0.7):
        seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * fy), shade(IRON, 1.1))
    rust_blotches(m, L.TANK_W, 5, s0=0.3, s1=0.7)
    x0, y0, x1, y1 = L.C_TANK_CAP.rect
    fill(m, L.C_TANK_CAP.rect, dif=shade(IRON, 1.0), ao=AO_BASE - 10,
         rough=185, metal=150)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    m.d.ellipse([cx - 30, cy - 30, cx + 30, cy + 30], outline=STEEL_DK, width=4)
    # rubble: scorched debris
    x0, y0, x1, y1 = L.RUBBLE_CELL
    fill(m, L.RUBBLE_CELL, dif=shade(SOOT, 1.15), ao=AO_BASE - 16, rough=215,
         metal=60)
    for _ in range(24):
        px = RNG.uniform(x0, x1 - 10)
        py = RNG.uniform(y0, y1 - 10)
        m.d.rectangle([px, py, px + RNG.uniform(4, 12), py + RNG.uniform(3, 9)],
                      fill=jit(shade(SOOT, RNG.uniform(0.85, 1.3)), 6))
    rust_blotches(m, L.RUBBLE_CELL, 5, s0=0.3, s1=0.6)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_pad(m)
    paint_torso(m)
    paint_furnace(m)
    paint_head(m)
    paint_pack(m)
    paint_stack(m)
    paint_pauldron_collar(m)
    paint_fittings(m)
    paint_limbs_weapons(m)

    # ── weathering: the wreck recipe — everything rusts, soots, silts ──
    wx = PL.standard_weather(
        m, L,
        ground_rects=(L.FOOT_W, L.PAD_S, L.RUBBLE_CELL),
        side_zones=(L.C_TORSO_FRONT, L.C_TORSO_SIDE, L.C_TORSO_REAR,
                    L.C_PACK, L.C_PAULDRON_S),
        seed=90210, mud=0.45, grime=0.4, rust_fraction=0.8)
    # heavy rust streaking off every seam line on the big hull cells
    for rect in (L.C_TORSO_FRONT.rect, L.C_TORSO_SIDE.rect,
                 L.C_TORSO_REAR.rect, L.C_TORSO_TOP.rect, L.C_PACK.rect,
                 L.LIMB_W, L.C_PAULDRON.rect):
        x0, y0, x1, y1 = rect
        for fx in np.linspace(0.1, 0.9, 6):
            wx.rust_streak(x0 + (x1 - x0) * fx,
                           y0 + (y1 - y0) * RNG.uniform(0.1, 0.5),
                           int(RNG.uniform(24, 60)), width=2.4, strength=0.5)
        wx.plate_bottom_rust(rect, n=8, strength=0.7)
    # soot: stacks, furnace surround, gun muzzles
    wx.soot_patch(L.C_STACK_TOP.rect, 0.9)
    sx0, sy0, sx1, sy1 = L.STACK_W
    wx.soot_patch((sx0, sy0, sx1, sy0 + (sy1 - sy0) // 3), 0.75)
    fx0, fy0, fx1, fy1 = L.FURNACE_CELL
    wx.soot_patch((fx0, fy0, fx1, fy0 + 40), 0.6)
    gx0, gy0, gx1, gy1 = L.GUN_W
    wx.soot_patch((gx0 + (gx1 - gx0) * 3 // 4, gy0, gx1, gy1), 0.6, fade='right')
    wx.soot_patch(L.C_MUZZLE.rect, 0.5)
    # oil at the dead joints
    wx.oily(L.JOINT_W, 0.55)
    wx.oily(L.JOINT_CAP, 0.4)
    # mud silted against the grounded cells
    wx.mud_band(L.C_FOOT_SIDE.rect, 0.9, fade='down')
    wx.mud_band(L.PLATE_CELL, 0.4, fade='down', dust=0.3)
    wx.mud_band(L.PELVIS_CELL, 0.5, fade='down', dust=0.25)

    # ── normals: proud grille bars, seams via crevices, weather relief ──
    from normals import HeightMap
    hm = HeightMap()
    x0, y0, x1, y1 = L.FURNACE_CELL
    for i in range(5):
        bx = x0 + (x1 - x0) * (i + 0.5) / 5
        hm.rect((bx - 7, y0 + 6, bx + 7, y1 - 6), 0.7)
    x0, y0, x1, y1 = L.HOSE_W
    for gx in range(x0 + 4, x1 - 2, 10):
        hm.line((gx, y0 + 2), (gx, y1 - 2), 0.4, width=2)
    x0, y0, x1, y1 = L.TORN_CELL
    hm.rect((x0, y0, x1, y0 + 26), 0.5)
    r = L.C_STACK_TOP.rect
    hm.disc((r[0] + r[2]) / 2, (r[1] + r[3]) / 2, (r[2] - r[0]) / 2 - 14, -1.1)
    PL.finish(m, L, 'ms_colossus_wreck', hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
