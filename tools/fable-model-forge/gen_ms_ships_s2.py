"""gen_ms_ships_s2 — Metalstorm ships s2 "Destroyer" (35 m, squad of 2).

Seagoing line destroyer: sheered/flared hull loft with a knuckle and a
cruiser stern (waterline at Y=0, keel -2.2 m), raised fo'c'sle carrying
the enclosed main gunhouse, a STACKED two-tier sloped-armour casemate
amidships, an armoured wheelhouse with slit windows, a stub lattice
mast with nav radar bar and yardarm, and THE RAKED FUNNEL (the only
funnel in the ship line — this tier's signature) immediately aft of the
wheelhouse, with a cap grille and steam-pipe stubs up its side. Open
quarterdeck aft: flak bandstand, depth-charge rails, boat davits, rails.

Rig: turret -> barrel -> muzzle (MS_AC_S3, yaw/pitch),
     turret2 -> turret2_barrel -> muzzle2 (MS_FLAK_S1),
     muzzle3 (bare empty, stern depth-charge release — nothing to traverse).
No clips: squad_size 2, squad members render in rest pose.

Usage: python3 gen_ms_ships_s2.py
"""
from __future__ import annotations
import numpy as np

import ms_ships_s2_layout as S            # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, loft, chamfer_box, tube, ngon_ring, limb
from gltf_export import export
import parts as P

STEM = 'ms_ships_s2'
OUT = 'out'

ZS = [s[0] for s in S.HULL_SECTIONS]


# ── helpers ─────────────────────────────────────────────────────────────

def deck_y(z):
    return float(np.interp(z, ZS, [s[3] for s in S.HULL_SECTIONS]))


def deck_w(z):
    return float(np.interp(z, ZS, [s[6] for s in S.HULL_SECTIONS]))


def ring_from_section(sec):
    z, yb, yk, yd, wb, wk, wd = sec
    return [
        (wb, yb, z), (wk, yk, z), (wd, yd, z),
        (-wd, yd, z), (-wk, yk, z), (-wb, yb, z),
    ]


def hull_zone(c, n):
    if n[1] < -0.55:
        return S.S_BELLY
    if n[1] > 0.55:
        return S.S_DECK
    return S.S_HULL_SIDE


def box(p, center, size, zone, ch=0.05, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def quad_out(p, verts, outward, zone):
    """Polygon wound so its normal points along `outward` (defect #5)."""
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, outward) > 0 else list(verts)[::-1],
               zone=zone)


def sloped_block(p, z0, z1, tz0, tz1, wb, wt, y0, y1,
                 side_zone, end_zone, top_zone, top=True):
    """One tier of sloped (inboard-raked) casemate armour."""
    for sx in (1, -1):
        quad_out(p, [(sx * wb, y0, z0), (sx * wb, y0, z1),
                     (sx * wt, y1, tz1), (sx * wt, y1, tz0)],
                 (sx, 0, 0), side_zone)
    quad_out(p, [(-wb, y0, z0), (wb, y0, z0), (wt, y1, tz0), (-wt, y1, tz0)],
             (0, 0, -1), end_zone)
    quad_out(p, [(-wb, y0, z1), (wb, y0, z1), (wt, y1, tz1), (-wt, y1, tz1)],
             (0, 0, 1), end_zone)
    if top:
        quad_out(p, [(-wt, y1, tz0), (wt, y1, tz0), (wt, y1, tz1),
                     (-wt, y1, tz1)], (0, 1, 0), top_zone)


# ── body ────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')

    # hull skin
    rings = [ring_from_section(s) for s in S.HULL_SECTIONS]
    loft(p, rings, hull_zone)

    # raked stem cap + cruiser-stern transom
    for sec, zone, outward in ((S.HULL_SECTIONS[0], S.S_BOW, (0, 0, -1)),
                               (S.HULL_SECTIONS[-1], S.S_STERN, (0, 0, 1))):
        z, yb, yk, yd, wb, wk, wd = sec
        quad_out(p, [(-wb, yb, z), (wb, yb, z), (wk, yk, z), (-wk, yk, z)],
                 outward, zone)
        quad_out(p, [(-wk, yk, z), (wk, yk, z), (wd, yd, z), (-wd, yd, z)],
                 outward, zone)

    # ── stacked casemate: tier 1 (roof is an annulus round tier 2) ──
    sloped_block(p, S.C1_Z0, S.C1_Z1, S.C1_TZ0, S.C1_TZ1, S.C1_WB, S.C1_WT,
                 S.DECK_Y, S.C1_TOP_Y, S.S_CASE_S, S.S_CASE_END,
                 S.S_CASE_TOP, top=False)
    # tier-1 roof walkway ring around the tier-2 footprint
    a0, a1, aw = S.C1_TZ0, S.C1_TZ1, S.C1_WT
    b0, b1, bw = S.C2_Z0, S.C2_Z1, S.C2_WB
    y = S.C1_TOP_Y
    for sx in (1, -1):
        quad_out(p, [(sx * aw, y, a0), (sx * aw, y, a1),
                     (sx * bw, y, b1), (sx * bw, y, b0)],
                 (0, 1, 0), S.S_CASE_TOP)
    quad_out(p, [(-aw, y, a0), (aw, y, a0), (bw, y, b0), (-bw, y, b0)],
             (0, 1, 0), S.S_CASE_TOP)
    quad_out(p, [(-aw, y, a1), (aw, y, a1), (bw, y, b1), (-bw, y, b1)],
             (0, 1, 0), S.S_CASE_TOP)
    # tier 2
    sloped_block(p, S.C2_Z0, S.C2_Z1, S.C2_TZ0, S.C2_TZ1, S.C2_WB, S.C2_WT,
                 S.C1_TOP_Y, S.C2_TOP_Y, S.S_CASE_S, S.S_CASE_END,
                 S.S_CASE_TOP, top=True)
    # splinter-plate strakes on the casemate flanks (functional, > 0.3 m)
    for cz in (-2.2, 1.4, 4.6):
        for sx in (1, -1):
            box(p, (sx * 3.02, 3.35, cz), (0.16, 0.9, 1.5), S.S_CASE_S,
                ch=0.03)
    # access hatches on the tier-1 roof
    for hz in (-3.9, 5.9):
        box(p, (0.0, S.C1_TOP_Y + 0.13, hz), (1.5, 0.26, 0.9), S.S_HATCH,
            ch=0.03, skip=('-y',))

    # ── armoured wheelhouse ──
    wx_, wy_, wz_, ww_, wh_, wd_ = S.WH
    chamfer_box(p, (wx_, wy_, wz_), (ww_, wh_, wd_), 0.10,
                {'+x': S.S_WH_S, '-x': S.S_WH_S, '-z': S.S_WH_F,
                 '+z': S.S_WH_F, '+y': S.S_WH_TOP}, skip=('-y',))
    # bridge-wing platforms
    for sx in (1, -1):
        box(p, (sx * 2.25, 6.02, -1.9), (1.1, 0.16, 1.9), S.S_WH_TOP,
            ch=0.03)

    # ── THE FUNNEL — raked aft, cap grille, steam-pipe stubs ──
    limb(p, S.FUN_BASE, S.FUN_TOP, S.FUN_R0, S.FUN_R1, S.S_FUNNEL, n=8)
    # cap ring (grille lip, slightly proud) + dark grille disc
    d = np.asarray(S.FUN_TOP, float) - np.asarray(S.FUN_BASE, float)
    d = d / np.linalg.norm(d)
    lip0 = np.asarray(S.FUN_TOP, float) - d * 0.16
    lip1 = np.asarray(S.FUN_TOP, float) + d * 0.06
    limb(p, tuple(lip0), tuple(lip1), S.FUN_CAP_R, S.FUN_CAP_R,
         S.S_FUNNEL, n=8, cap_end=S.S_DARK)
    # steam-pipe stubs running up the funnel flank
    for (px, ph) in S.STEAM_PIPES:
        a = np.asarray(S.FUN_BASE, float) + d * 0.55 + np.array([px, 0, 0])
        b = np.asarray(S.FUN_BASE, float) + d * 3.25 + np.array([px, 0, 0])
        limb(p, tuple(a), tuple(b), 0.11, 0.09, S.S_MAST, n=4,
             cap_end=S.S_DARK)
    # funnel guy-braces down to the casemate roof
    for sx in (1, -1):
        limb(p, (sx * 0.90, 5.95, 2.6), (sx * 1.70, 8.60, 3.20),
             0.05, 0.04, S.S_MAST, n=3)

    # ── mast + yardarm + nav radar bar ──
    limb(p, S.MAST_FOOT, S.MAST_TOP, 0.13, 0.07, S.S_MAST, n=5)
    my = S.YARD_Y
    mz = float(np.interp(my, [S.MAST_FOOT[1], S.MAST_TOP[1]],
                         [S.MAST_FOOT[2], S.MAST_TOP[2]]))
    limb(p, (-S.YARD_HW, my, mz), (S.YARD_HW, my, mz), 0.05, 0.05,
         S.S_MAST, n=4)
    for sx in (1, -1):   # yardarm stays
        limb(p, (sx * S.YARD_HW, my, mz), (0.0, my + 0.95, mz + 0.10),
             0.03, 0.03, S.S_MAST, n=3)
    # nav radar bar (fixed — no clips on a squadded def)
    rx, ry, rz = S.RADAR_C
    box(p, (rx, ry, rz), (2.4, 0.30, 0.24), S.S_RADAR, ch=0.04)

    # ── fo'c'sle: breakwater, anchor gear, main-turret barbette ring ──
    box(p, (0.0, deck_y(-13.2) + 0.28, -13.2), (5.2, 0.56, 0.30),
        S.S_TRIM, ch=0.04, skip=('-y',))          # breakwater
    for sx in (1, -1):                            # anchor windlass drums
        limb(p, (sx * 0.95, deck_y(-15.3) + 0.30, -15.6),
             (sx * 0.95, deck_y(-15.3) + 0.30, -15.0), 0.26, 0.26,
             S.S_MAST, n=6, cap_start=S.S_DARK, cap_end=S.S_DARK)
    # barbette under the main gunhouse
    rings = [ngon_ring((0, S.TUR_MOUNT[1] - 0.95, -11.0), 1.62, n=8, axis='y'),
             ngon_ring((0, S.TUR_MOUNT[1] - 0.02, -11.0), 1.62, n=8, axis='y')]
    loft(p, rings, lambda c, n: S.S_CASE_S)

    # ── quarterdeck: flak bandstand, depth-charge rails, davits ──
    box(p, (0.0, (S.DECK_Y + S.BAND_Y) * 0.5, S.BAND_Z),
        (3.1, S.BAND_Y - S.DECK_Y, 2.5), S.S_CASE_S, ch=0.05, skip=('-y',))
    for (rx_, z0, z1) in S.DC_RAILS:              # depth-charge rack rails
        limb(p, (rx_, S.DC_Y - 0.34, z0), (rx_, S.DC_Y - 0.34, z1),
             0.09, 0.09, S.S_MAST, n=4)
        limb(p, (rx_, S.DC_Y - 0.34, z0), (rx_, S.DECK_Y, z0),
             0.07, 0.07, S.S_MAST, n=3)
        limb(p, (rx_, S.DC_Y - 0.34, z1), (rx_, deck_y(z1), z1),
             0.07, 0.07, S.S_MAST, n=3)
        for i in range(4):                        # charges on the rail
            cz = z0 + (z1 - z0) * (0.12 + 0.26 * i)
            tube(p, [(cz - S.DC_LEN / 2, S.DC_R, S.DC_Y),
                     (cz + S.DC_LEN / 2, S.DC_R, S.DC_Y)],
                 S.S_DC, n=6, xoff=rx_, cap_start=S.S_DARK,
                 cap_end=S.S_DARK)
    for (dx, dz) in S.DAVITS:                     # boat davits
        limb(p, (dx, deck_y(dz), dz), (dx, deck_y(dz) + 1.55, dz),
             0.09, 0.07, S.S_MAST, n=4)
        limb(p, (dx, deck_y(dz) + 1.55, dz),
             (dx + np.sign(dx) * 0.85, deck_y(dz) + 1.35, dz),
             0.07, 0.06, S.S_MAST, n=3)

    # ── deck fittings ──
    for (bz, side) in S.BOLLARDS:
        limb(p, (side * (deck_w(bz) - 0.45), deck_y(bz), bz),
             (side * (deck_w(bz) - 0.45), deck_y(bz) + 0.45, bz),
             0.11, 0.11, S.S_MAST, n=4, cap_end=S.S_DARK)
    for (hz,) in S.HATCHES:
        box(p, (0.0, deck_y(hz) + 0.16, hz), (1.7, 0.32, 1.7), S.S_HATCH,
            ch=0.03, skip=('-y',))
    # railings: quarterdeck + fo'c'sle + stern
    for (rx_, z0, z1) in S.RAIL_RUNS + S.FOC_RAILS:
        P.railing(p, (rx_, deck_y(z0), z0), (rx_, deck_y(z1), z1),
                  h=S.RAIL_Y, post_step=2.4, r=0.045, zone=S.S_MAST)
    P.railing(p, (-2.0, deck_y(17.0), 17.0), (2.0, deck_y(17.0), 17.0),
              h=S.RAIL_Y, post_step=2.0, r=0.045, zone=S.S_MAST)
    return p


# ── slot 1: main gunhouse chain ─────────────────────────────────────────

def build_turret():
    """Piece-local; pivot on the fo'c'sle. Engine yaws this piece."""
    p = Part('turret')
    r = S.TUR_RING_R
    loft(p, [ngon_ring((0, -0.02, 0), r, n=8, axis='y'),
             ngon_ring((0, 0.26, 0), r * 0.98, n=8, axis='y')],
         lambda c, n: S.S_TUR_S)
    # enclosed gunhouse: sloped armour all round
    hb, ht = 1.42, 0.98
    db0, db1 = -1.95, 1.75
    dt0, dt1 = -1.40, 1.30
    y0, y1 = 0.26, 1.72
    cb = [(hb, y0, db0), (hb, y0, db1), (-hb, y0, db1), (-hb, y0, db0)]
    ct = [(ht, y1, dt0), (ht, y1, dt1), (-ht, y1, dt1), (-ht, y1, dt0)]
    zones = (S.S_TUR_S, S.S_TUR_F, S.S_TUR_S, S.S_TUR_F)
    outw = ((1, 0, 0), (0, 0, 1), (-1, 0, 0), (0, 0, -1))
    for i in range(4):
        j = (i + 1) % 4
        quad_out(p, [cb[i], cb[j], ct[j], ct[i]], outw[i], zones[i])
    quad_out(p, ct, (0, 1, 0), S.S_TUR_T)
    # mantlet + blast-bag collar at the tube root
    box(p, (0.0, S.BAR_OFF[1], -1.58), (1.15, 0.72, 0.62), S.S_TUR_F, ch=0.06)
    limb(p, (0.0, S.BAR_OFF[1], -1.30), (0.0, S.BAR_OFF[1], -1.92),
         0.40, 0.33, S.S_BARREL, n=8)
    # rangefinder hood + hatch
    box(p, (0.0, 1.86, 0.45), (2.05, 0.28, 0.42), S.S_TUR_F, ch=0.05)
    box(p, (0.62, 1.80, 1.05), (0.55, 0.16, 0.55), S.S_TUR_T, ch=0.03,
        skip=('-y',))
    return p


def build_barrel():
    """Single AC tube, pitch pivot at origin, firing -Z."""
    p = Part('barrel')
    limb(p, (0, 0, 0.30), (0, 0, -S.BAR_LEN + 0.02), S.BAR_R,
         S.BAR_R * 0.84, S.S_BARREL, n=8)
    limb(p, (0, 0, -S.BAR_LEN + 0.62), (0, 0, -S.BAR_LEN),
         S.BAR_R * 1.30, S.BAR_R * 1.22, S.S_BARREL, n=8, cap_end=S.S_DARK)
    return p


# ── slot 2: flak tub chain ──────────────────────────────────────────────

def build_turret2():
    """Open flak tub / ring mount on the after bandstand."""
    p = Part('turret2')
    r = S.TUR2_RING_R
    loft(p, [ngon_ring((0, 0.0, 0), r, n=8, axis='y'),
             ngon_ring((0, 0.82, 0), r * 1.06, n=8, axis='y')],
         lambda c, n: S.S_FLAK)
    # tub rim + gunner platform floor
    loft(p, [ngon_ring((0, 0.82, 0), r * 1.06, n=8, axis='y'),
             ngon_ring((0, 0.90, 0), r * 0.94, n=8, axis='y')],
         lambda c, n: S.S_FLAK)
    quad_out(p, [(-r * 0.9, 0.02, -r * 0.9), (r * 0.9, 0.02, -r * 0.9),
                 (r * 0.9, 0.02, r * 0.9), (-r * 0.9, 0.02, r * 0.9)],
             (0, 1, 0), S.S_FLAK)
    # trunnion pedestal + ready-use ammo locker
    box(p, (0.0, 0.42, 0.10), (0.60, 0.80, 0.55), S.S_FLAK, ch=0.04)
    box(p, (0.0, 0.30, 0.72), (0.90, 0.44, 0.34), S.S_FLAK, ch=0.03)
    return p


def build_turret2_barrel():
    """SHORT twin flak tubes on the one pitch piece."""
    p = Part('turret2_barrel')
    for sx in (1, -1):
        x = sx * S.BAR2_SPACING
        limb(p, (x, 0, 0.32), (x, 0, -S.BAR2_LEN), S.BAR2_R,
             S.BAR2_R * 0.85, S.S_BARREL, n=6, cap_end=S.S_DARK)
        limb(p, (x, 0, -S.BAR2_LEN + 0.42), (x, 0, -S.BAR2_LEN + 0.04),
             S.BAR2_R * 1.5, S.BAR2_R * 1.4, S.S_BARREL, n=6)
    # shared cradle + drum magazine
    box(p, (0.0, 0.0, 0.22), (0.66, 0.26, 0.44), S.S_FLAK, ch=0.03)
    box(p, (0.0, 0.30, 0.10), (0.34, 0.34, 0.30), S.S_FLAK, ch=0.03)
    return p


# ── assembly ────────────────────────────────────────────────────────────

def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='turret', parent=0, offset=S.TUR_MOUNT, part=build_turret()),
        dict(name='barrel', parent=1, offset=S.BAR_OFF, part=build_barrel()),
        dict(name='muzzle', parent=2, offset=S.MUZ_OFF, part=None),
        dict(name='turret2', parent=0, offset=S.TUR2_MOUNT,
             part=build_turret2()),
        dict(name='turret2_barrel', parent=4, offset=S.BAR2_OFF,
             part=build_turret2_barrel()),
        dict(name='muzzle2', parent=5, offset=S.MUZ2_OFF, part=None),
        dict(name='muzzle3', parent=0, offset=S.MUZ3_OFF, part=None),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    lo = np.array([1e9, 1e9, 1e9])
    hi = -lo.copy()
    for pc in pieces:
        if pc['part'] is None or not pc['part'].pos:
            continue
        off = np.asarray(pc['offset'], float)
        # nested offsets: turret chain adds its parents' offsets
        if pc['name'] in ('barrel',):
            off = off + np.asarray(S.TUR_MOUNT, float)
        if pc['name'] in ('turret2_barrel',):
            off = off + np.asarray(S.TUR2_MOUNT, float)
        a = np.asarray(pc['part'].pos, float) + off
        lo = np.minimum(lo, a.min(axis=0))
        hi = np.maximum(hi, a.max(axis=0))
    print(f'[gen] extents  x {lo[0]:.2f}..{hi[0]:.2f} (beam {hi[0]-lo[0]:.2f})'
          f'  y {lo[1]:.2f}..{hi[1]:.2f}  z {lo[2]:.2f}..{hi[2]:.2f}'
          f' (length {hi[2]-lo[2]:.2f})')
    print(f'TOTAL {total} tris')
