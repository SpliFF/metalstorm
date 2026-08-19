"""gen_ms_artillery_s4 — assemble ms_artillery_s4 and export .gltf/.bin.

Continental siege gun (artillery s4, ~15 m): twin-run track pods per side,
girder carriage deck over them, colossal howitzer (multi-baffle brake,
recuperators) on a rotating ring mount with counterweight/breech house,
shell hoist + oversized shell rack + rear anchor spades.
Aim chain: turret -> barrel -> muzzle (single weapon slot).

Run: $FORGE/venv/bin/python gen_ms_artillery_s4.py  -> out/…gltf/bin
"""
from __future__ import annotations
import os
import numpy as np

import ms_artillery_s4_layout as L    # sets meshlib.ATLAS = 2048
from meshlib import Part, Zone, chamfer_box, ngon_ring, mirror_x, limb
from gltf_export import export
from parts import ladder, railing, box6

STEM = 'ms_artillery_s4'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')


def box(p, center, size, zones, skip=()):
    chamfer_box(p, center, size, 0.0, zones, skip=skip)


# ── body: carriage deck + everything bolted to it ───────────────────────

def build_body():
    p = Part('body')

    # girder carriage deck slab
    chamfer_box(p, L.DECK_C, L.DECK_SZ, 0.06,
                {'+y': L.C_DECK_TOP, '-y': L.C_DARK, '+x': L.C_DECK_SIDE,
                 '-x': L.C_DECK_SIDE, '+z': L.C_DECK_REAR,
                 '-z': L.C_DECK_FRONT})

    # longitudinal girder beams under the deck
    for (gx, gy, gz) in L.GIRDERS:
        box(p, (gx, gy, gz), L.GIRDER_SZ,
            {'+x': L.C_GIRDER_BOX, '-x': L.C_GIRDER_BOX, '+y': L.C_DARK,
             '-y': L.C_GIRDER_BOX, '+z': L.C_GIRDER_BOX,
             '-z': L.C_GIRDER_BOX})

    # deck edge stringers
    for sx in (2.9, -2.9):
        chamfer_box(p, (sx, 2.42, 0.45), (0.18, 0.14, 12.0), 0.02,
                    {'+y': L.C_DECK_TOP, '+x': L.C_TRIM_BOX,
                     '-x': L.C_TRIM_BOX, '+z': L.C_TRIM_BOX,
                     '-z': L.C_TRIM_BOX}, skip=('-y',))

    # driver cab, front-left
    chamfer_box(p, L.CAB_C, L.CAB_SZ, 0.05,
                {'+y': L.C_CAB_TOP, '+x': L.C_CAB_SIDE, '-x': L.C_CAB_SIDE,
                 '+z': L.C_CAB_FRONT, '-z': L.C_CAB_FRONT}, skip=('-y',))

    # exhaust stacks + mufflers behind the cab
    for (sx, sz) in L.STACKS:
        limb(p, (sx, L.DECK_TOP_Y, sz), (sx, L.STACK_TOP, sz), 0.10, 0.09,
             L.C_TRIM, n=6)
        box6(p, (sx, 2.62, sz), L.MUFFLER_SZ, L.C_TRIM_BOX, 0.02,
             skip=('-y',))

    # floodlight masts (amber deck floods)
    for (fx, fz) in L.FLOODS:
        limb(p, (fx, L.DECK_TOP_Y, fz), (fx, L.FLOOD_TOP, fz), 0.07, 0.05,
             L.C_TRIM, n=4)
        box6(p, (fx, L.FLOOD_TOP + 0.11, fz), L.FLOOD_BOX, L.C_LIGHT, 0.02)

    # team banner plates hung on the deck sides
    bx, by, bz = L.BANNER_C
    for s in (1, -1):
        box(p, (s * bx, by, bz), L.BANNER_SZ,
            {'+x': L.C_BANNER, '-x': L.C_BANNER, '+y': L.C_BANNER,
             '-y': L.C_BANNER, '+z': L.C_BANNER, '-z': L.C_BANNER})

    # rear deck shell rack + oversized shells
    for rc in L.RAIL_CS:
        box(p, rc, L.RAIL_SZ,
            {'+y': L.C_TRIM_BOX, '+x': L.C_TRIM_BOX, '-x': L.C_TRIM_BOX,
             '+z': L.C_TRIM_BOX, '-z': L.C_TRIM_BOX}, skip=('-y',))
    for sz_ in L.SHELL_ZS:
        x0, x1 = L.SHELL_X
        limb(p, (x0, L.SHELL_Y, sz_), (x1, L.SHELL_Y, sz_),
             L.SHELL_R, L.SHELL_R, L.C_SHELL, n=6, cap_start=L.C_TRIM_BOX)
        limb(p, (x1, L.SHELL_Y, sz_), (L.SHELL_NOSE, L.SHELL_Y, sz_),
             L.SHELL_R, 0.05, L.C_SHELL, n=6)

    # shell hoist A-frame + hook block
    ax, ay, az = L.HOIST_APEX
    for (fx, fz) in L.HOIST_FEET:
        top_x = ax if fx > 0 else -ax
        limb(p, (fx, L.DECK_TOP_Y, fz), (top_x, ay, az), 0.09, 0.07,
             L.C_GIRDER, n=4)
    limb(p, (-ax, ay, az), (ax, ay, az), 0.10, 0.10, L.C_GIRDER, n=4)
    limb(p, (0, ay, az), (0, L.HOOK_Y + 0.15, az), 0.022, 0.022, L.C_TRIM,
         n=3)
    box6(p, (0, L.HOOK_Y, az), (0.20, 0.30, 0.20), L.C_TRIM_BOX, 0.02)

    # rear anchor spades
    for (a, b) in L.SPADE_ARM:
        limb(p, a, b, 0.14, 0.11, L.C_GIRDER, n=4)
    for c in L.SPADE_C:
        chamfer_box(p, c, L.SPADE_SZ, 0.04,
                    {'+y': L.C_SPADE, '+x': L.C_SPADE, '-x': L.C_SPADE,
                     '+z': L.C_SPADE, '-z': L.C_SPADE}, skip=('-y',))

    # crew gantry: rear ladder + deck railings
    ladder(p, L.LADDER[0], L.LADDER[1], width=0.5, zone=L.C_GANTRY)
    for (a, b) in L.RAILS:
        railing(p, a, b, h=0.85, post_step=1.7, r=0.035, zone=L.C_GANTRY)
    return p


# ── track pods (twin runs per side) ─────────────────────────────────────

def add_run(p, xc):
    prof = L.TRACK_PROFILE
    w = L.RUN_HW
    n = len(prof)
    outer = [(xc + w, y, z) for (z, y) in prof]
    inner = [(xc - w, y, z) for (z, y) in prof]
    p.add_face(outer, zone=L.C_TRACK_SIDE, flip=True)
    p.add_face(inner, zone=L.C_TRACK_SIDE)
    # wrap: arc-length parametric UV
    x0, y0, x1, y1 = L.C_TRACK_WRAP
    seg = [np.hypot(prof[(i + 1) % n][0] - prof[i][0],
                    prof[(i + 1) % n][1] - prof[i][1]) for i in range(n)]
    total = sum(seg)
    acc = 0.0
    centroid = np.array([xc, sum(y for _, y in prof) / n,
                         sum(z for z, _ in prof) / n])
    A = float(L.ATLAS)
    for i in range(n):
        j = (i + 1) % n
        u0 = (x0 + (x1 - x0) * acc / total) / A
        acc += seg[i]
        u1 = (x0 + (x1 - x0) * acc / total) / A
        va, vb = y0 / A, y1 / A
        quad = [(xc + w, prof[i][1], prof[i][0]),
                (xc - w, prof[i][1], prof[i][0]),
                (xc - w, prof[j][1], prof[j][0]),
                (xc + w, prof[j][1], prof[j][0])]
        uvs = [(u0, va), (u0, vb), (u1, vb), (u1, va)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        if np.dot(nrm, ctr - centroid) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)


def build_tracks_l():
    p = Part('tracks_l')
    add_run(p, L.RUN_X)
    add_run(p, -L.RUN_X)
    # heavy bogie skirt on the outer face
    chamfer_box(p, L.SKIRT_C, L.SKIRT_SZ, 0.02,
                {'+x': L.C_SKIRT, '-x': L.C_DARK, '+y': L.C_SKIRT,
                 '-y': L.C_DARK, '+z': L.C_SKIRT, '-z': L.C_SKIRT})
    # fender deck spanning both runs
    chamfer_box(p, L.FENDER_C, L.FENDER_SZ, 0.03,
                {'+y': L.C_FENDER, '-y': L.C_DARK, '+x': L.C_TRACK_SIDE,
                 '-x': L.C_TRACK_SIDE, '+z': L.C_TRACK_SIDE,
                 '-z': L.C_TRACK_SIDE})
    return p


# ── turret: ring mount + counterweight house + trunnions ────────────────

def build_turret():
    p = Part('turret')
    # ring drum
    limb(p, (0, -0.05, 0), (0, L.RING_H, 0), L.RING_R0, L.RING_R1,
         L.C_RING, n=14)
    ring = ngon_ring((0, L.RING_H, 0), L.RING_R1, 14, axis='y')
    p.add_face(ring, zone=L.C_RING_TOP, flip=True)
    p.add_face(ring, zone=L.C_RING_TOP)
    # counterweight / breech house
    chamfer_box(p, L.HOUSE_C, L.HOUSE_SZ, 0.05,
                {'+y': L.C_HOUSE_TOP, '-y': L.C_DARK, '+x': L.C_HOUSE_SIDE,
                 '-x': L.C_HOUSE_SIDE, '+z': L.C_HOUSE_REAR,
                 '-z': L.C_HOUSE_FRONT})
    for vc in L.VENTS:
        box(p, vc, L.VENT_SZ,
            {'+y': L.C_TRIM_BOX, '+x': L.C_TRIM_BOX, '-x': L.C_TRIM_BOX,
             '+z': L.C_TRIM_BOX, '-z': L.C_TRIM_BOX}, skip=('-y',))
    # trunnion cheeks
    for cc in L.CHEEK_CS:
        chamfer_box(p, cc, L.CHEEK_SZ, 0.04,
                    {'+y': L.C_TRUNNION, '+x': L.C_TRUNNION,
                     '-x': L.C_TRUNNION, '+z': L.C_TRUNNION,
                     '-z': L.C_TRUNNION}, skip=('-y',))
    return p


# ── barrel: colossal tube, rest elevation baked in ──────────────────────

def build_barrel():
    p = Part('barrel')
    D, P = L.D, L.P_UP

    def at(t, up=0.0, x=0.0):
        return tuple(t * D + up * P + np.array([x, 0.0, 0.0]))

    # breech jacket (recoils back into the house)
    limb(p, at(-1.7), at(0.6), 0.46, 0.42, L.C_BREECH, n=8,
         cap_start=L.C_CAP_R)
    # trunnion hub cross-shaft
    limb(p, (-1.25, 0, 0), (1.25, 0, 0), 0.16, 0.16, L.C_TRIM, n=6)
    # tube: jacket -> inner -> collar -> outer
    limb(p, at(0.5), at(2.2), 0.36, 0.33, L.C_BARREL, n=10)
    limb(p, at(2.1), at(5.3), 0.30, 0.27, L.C_BARREL, n=10)
    limb(p, at(5.2), at(5.55), 0.31, 0.31, L.C_BARREL, n=10)
    limb(p, at(5.5), at(8.15), 0.26, 0.23, L.C_BARREL2, n=10)
    # muzzle brake: core + three big baffle discs
    limb(p, at(8.1), at(9.42), 0.24, 0.24, L.C_BRAKE, n=8)
    for i, (t0, t1) in enumerate(L.BAFFLES):
        cap = L.C_CAP_F if i == len(L.BAFFLES) - 1 else None
        limb(p, at(t0), at(t1), 0.48, 0.48, L.C_BRAKE, n=8, cap_end=cap)
    # recuperator cylinders above the tube
    for s in (1, -1):
        p0 = np.array(at(0.1, 0.55, 0.30 * s))
        limb(p, tuple(p0), tuple(p0 + 3.3 * D), 0.15, 0.15, L.C_RECUP, n=6,
             cap_end=L.C_TRIM_BOX)
    # cradle rails below the tube
    for s in (1, -1):
        p0 = np.array(at(-0.6, -0.55, 0.34 * s))
        limb(p, tuple(p0), tuple(p0 + 3.4 * D), 0.12, 0.12, L.C_RECUP, n=4)
    return p


# ── assembly ────────────────────────────────────────────────────────────

def build_all():
    body = build_body()
    tl = build_tracks_l()
    tr = mirror_x(tl, 'tracks_r')
    ox, oy, oz = L.TRACK_OFF
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=body),
        dict(name='tracks_l', parent=0, offset=(ox, oy, oz), part=tl),
        dict(name='tracks_r', parent=0, offset=(-ox, oy, oz), part=tr),
        dict(name='turret', parent=0, offset=L.TURRET_OFF,
             part=build_turret()),
        dict(name='barrel', parent=3, offset=L.BARREL_OFF,
             part=build_barrel()),
        dict(name='muzzle', parent=4, offset=L.MUZZLE_OFF,
             part=Part('muzzle')),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
