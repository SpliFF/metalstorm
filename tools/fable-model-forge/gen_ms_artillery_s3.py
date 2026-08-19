"""gen_ms_artillery_s3 — assemble ms_artillery_s3 and export .gltf/.bin.

Heavy open-mount SPG (artillery s3, 10.5 m): long low tracked chassis,
forward engine block with twin exhaust stacks, open rear gun deck with a
pedestal mount (`turret`) carrying a gun shield and a hull-length
high-velocity howitzer (`barrel`, rest elevation +17 deg baked into the
geometry, pivot at the trunnion) ending in a double-baffle brake with a
`muzzle` empty at the bore tip. Recoil spades folded at the rear, ammo
lockers, small loading-crane arm.

Run: python3 gen_ms_artillery_s3.py  -> out/ms_artillery_s3{,_png}.gltf
"""
from __future__ import annotations
import os
import numpy as np

import ms_artillery_s3_layout as L    # sets meshlib.ATLAS = 1024
from meshlib import Part, loft, chamfer_box, ngon_ring, mirror_x, limb
from gltf_export import export

STEM = 'ms_artillery_s3'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')


# ── zone classifiers ─────────────────────────────────────────────────────

def hull_zone(c, n):
    if n[1] < -0.5:
        return L.C_DARK
    if abs(n[0]) > 0.62:
        return L.C_HULL_SIDE
    if n[2] < -0.55:
        return L.C_GLACIS
    if n[2] > 0.55:
        return L.C_HULL_REAR
    return L.C_HULL_TOP


def ring_from_section(sec):
    z, yb, yw, ys, yd, wb, ww, wd, wt = sec
    return [
        (wb, yb, z), (ww, yw, z), (wd, ys, z), (wt, yd, z),
        (-wt, yd, z), (-wd, ys, z), (-ww, yw, z), (-wb, yb, z),
    ]


# ── body ────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')

    rings = [ring_from_section(s) for s in L.HULL_SECTIONS]
    loft(p, rings, hull_zone, cap_start=L.C_GLACIS, cap_end=L.C_HULL_REAR)

    # forward engine block
    x, y, z, w, h, d = L.ENGINE
    chamfer_box(p, (x, y, z), (w, h, d), 0.04,
                {'+y': L.C_ENGINE_TOP, '+x': L.C_ENGINE_SIDE,
                 '-x': L.C_ENGINE_SIDE, '+z': L.C_ENGINE_FACE,
                 '-z': L.C_ENGINE_FACE}, skip=('-y',))

    # twin exhaust stacks beside the engine deck
    for (sx, sz) in L.STACKS:
        limb(p, (sx, 1.92, sz), (sx * 1.05, L.STACK_TOP_Y, sz - 0.06),
             0.10, 0.088, L.C_STACK, n=6, cap_end=L.C_DARK)

    # rear-deck ammo lockers
    for (lx, ly, lz) in L.LOCKERS:
        chamfer_box(p, (lx, ly, lz), L.LOCKER_SIZE, 0.03,
                    {'+y': L.C_LOCKER_T, '+x': L.C_LOCKER_S,
                     '-x': L.C_LOCKER_S, '+z': L.C_LOCKER_E,
                     '-z': L.C_LOCKER_E}, skip=('-y',))

    # loading-crane arm (stowage dressing, rear-right corner)
    bx, by, bz = L.CRANE_BASE
    limb(p, (bx, by, bz), (bx, L.CRANE_TOP_Y, bz), 0.08, 0.062,
         L.C_TRIM, n=6)
    limb(p, (bx, L.CRANE_TOP_Y - 0.08, bz), L.CRANE_TIP, 0.05, 0.038,
         L.C_TRIM, n=4)
    tx, ty, tz = L.CRANE_TIP
    limb(p, (tx, ty, tz), (tx, ty - 0.34, tz), 0.014, 0.012, L.C_TRIM, n=3)
    chamfer_box(p, (tx, ty - 0.42, tz), (0.10, 0.12, 0.06), 0.012,
                {k: L.C_TRIM_BOX for k in ('+x', '-x', '+y', '-y', '+z', '-z')})

    # amber deck work-light on the crane mast head
    chamfer_box(p, L.LIGHT_BOX, (0.12, 0.12, 0.12), 0.02,
                {k: L.C_LIGHT for k in ('+x', '-x', '+y', '+z', '-z')},
                skip=('-y',))

    # recoil spades folded against the rear plate (double-sided plates)
    ty_, tz_ = L.SPADE_TOP
    by_, bz_ = L.SPADE_BOT
    for cx in L.SPADES:
        quad = [(cx - L.SPADE_HW, ty_, tz_), (cx + L.SPADE_HW, ty_, tz_),
                (cx + L.SPADE_HW, by_, bz_), (cx - L.SPADE_HW, by_, bz_)]
        p.add_face(quad, zone=L.C_SPADE)          # outward (+z-ish)
        p.add_face(quad, zone=L.C_SPADE, flip=True)
    return p


# ── tracks ──────────────────────────────────────────────────────────────

def build_tracks_l():
    p = Part('tracks_l')
    prof = L.TRACK_PROFILE
    w = L.TRACK_HALF_W
    n = len(prof)

    outer = [(w, y, z) for (z, y) in prof]
    inner = [(-w, y, z) for (z, y) in prof]
    p.add_face(outer, zone=L.C_TRACK_SIDE, flip=True)
    p.add_face(inner, zone=L.C_TRACK_SIDE)

    # wrap: arc-length parametric UV into C_TRACK_WRAP
    x0, y0, x1, y1 = L.C_TRACK_WRAP
    seg = [np.hypot(prof[(i + 1) % n][0] - prof[i][0],
                    prof[(i + 1) % n][1] - prof[i][1]) for i in range(n)]
    total = sum(seg)
    acc = 0.0
    centroid = np.array([0.0, sum(y for _, y in prof) / n,
                         sum(z for z, _ in prof) / n])
    for i in range(n):
        j = (i + 1) % n
        u0 = (x0 + (x1 - x0) * acc / total) / 1024.0
        acc += seg[i]
        u1 = (x0 + (x1 - x0) * acc / total) / 1024.0
        va, vb = y0 / 1024.0, y1 / 1024.0
        quad = [(w, prof[i][1], prof[i][0]), (-w, prof[i][1], prof[i][0]),
                (-w, prof[j][1], prof[j][0]), (w, prof[j][1], prof[j][0])]
        uvs = [(u0, va), (u0, vb), (u1, vb), (u1, va)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        if np.dot(nrm, ctr - centroid) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)

    # proud octagonal road-wheel discs on the outer face (silhouette bulges)
    for wz in L.ROAD_WHEELS:
        ring = ngon_ring((w + 0.045, L.WHEEL_CY, wz), L.WHEEL_R, n=8,
                         axis='x')
        p.add_face(ring, zone=L.C_TRACK_SIDE, flip=True)

    # fender top plate, flush on the pod top (no skirt: open running gear)
    (fz0, fz1), fy, fh, fw = L.FENDER
    chamfer_box(p, (0.0, fy + fh / 2 - 0.02, (fz0 + fz1) / 2),
                (fw, fh, fz1 - fz0), 0.03,
                {'+y': L.C_FENDER, '+x': L.C_TRACK_SIDE, '-x': L.C_TRACK_SIDE,
                 '+z': L.C_TRACK_SIDE, '-z': L.C_TRACK_SIDE}, skip=('-y',))
    return p


# ── pedestal mount (turret) ─────────────────────────────────────────────

def build_turret():
    p = Part('turret')
    # octagonal pedestal drum
    limb(p, (0, 0, 0), (0, L.PED_H, 0), L.PED_R0, L.PED_R1, L.C_PED, n=8,
         cap_end=L.C_TRIM_BOX)
    # trunnion cheeks
    for c in L.CHEEKS:
        chamfer_box(p, c, L.CHEEK_SIZE, 0.02,
                    {k: L.C_MOUNT for k in ('+x', '-x', '+y', '+z', '-z')},
                    skip=('-y',))
    # ready-round tray aft of the mount
    x, y, z, w, h, d = L.TRAY
    chamfer_box(p, (x, y, z), (w, h, d), 0.02,
                {k: L.C_MOUNT for k in ('+x', '-x', '+y', '+z', '-z')},
                skip=('-y',))
    # gun shield plate (double-sided, tilted back)
    by, bz = L.SHIELD_BOT
    ty, tz = L.SHIELD_TOP
    sx = L.SHIELD_X
    quad = [(-sx, ty, tz), (sx, ty, tz), (sx, by, bz), (-sx, by, bz)]
    p.add_face(quad, zone=L.C_SHIELD_F)           # faces -z (front)
    p.add_face(quad, zone=L.C_SHIELD_B, flip=True)
    return p


# ── barrel (rest elevation baked; pivot at trunnion) ────────────────────

def build_barrel():
    p = Part('barrel')
    D, PD = L.DIR, L.PERP

    def at(t, drop=0.0):
        return tuple(D * t + PD * drop)

    # breech block
    limb(p, at(L.BREECH_BACK), at(L.BREECH_FWD), 0.175, 0.155,
         L.C_BREECH, n=8, cap_start=L.C_DARK)
    # main tube
    limb(p, at(L.TUBE_A), at(L.TUBE_B), 0.115, 0.088, L.C_BARREL, n=8)
    # double-baffle muzzle brake
    a, b = L.BAFFLE1
    limb(p, at(a), at(b), 0.150, 0.150, L.C_BRAKE, n=8, cap_start=L.C_DARK)
    a, b = L.BAFFLE2
    limb(p, at(a), at(b), 0.150, 0.130, L.C_BRAKE, n=8,
         cap_start=L.C_DARK, cap_end=L.C_DARK)
    limb(p, at(L.BAFFLE1[1] - 0.02), at(L.BAFFLE2[0] + 0.02), 0.070, 0.070,
         L.C_BRAKE, n=6)
    # recuperator cylinder under the tube
    limb(p, at(L.RECUP_A, L.RECUP_DROP), at(L.RECUP_B, L.RECUP_DROP),
         0.075, 0.060, L.C_RECUP, n=6, cap_end=L.C_TRIM_BOX)
    return p


# ── assembly ────────────────────────────────────────────────────────────

def build_all():
    body = build_body()
    tl = build_tracks_l()
    tr = mirror_x(tl, 'tracks_r')
    muz = Part('muzzle')
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=body),
        dict(name='tracks_l', parent=0, offset=L.TRACK_OFF, part=tl),
        dict(name='tracks_r', parent=0,
             offset=(-L.TRACK_OFF[0], L.TRACK_OFF[1], L.TRACK_OFF[2]),
             part=tr),
        dict(name='turret', parent=0, offset=L.TURRET_OFF,
             part=build_turret()),
        dict(name='barrel', parent=3, offset=L.BARREL_OFF,
             part=build_barrel()),
        dict(name='muzzle', parent=4, offset=tuple(L.DIR * L.BARREL_LEN),
             part=muz),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
