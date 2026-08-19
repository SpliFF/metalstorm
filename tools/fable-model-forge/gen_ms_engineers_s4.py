"""gen_ms_engineers_s4 — assemble ms_engineers_s4 and export .gltf/.bin.

Mobile fabrication platform (ENGINEERS s4): single vast tracked crawler.
Two full-length track pods, fabrication deck, glazed crew cab forward,
open-sided fabrication bay amidships, slewing crane aft (crane_base →
crane_boom), gas bottles, crates, floodlights, amber beacon. Unarmed.

Run: $PY gen_ms_engineers_s4.py   → out/ms_engineers_s4{,_png}.gltf + .bin
"""
from __future__ import annotations
import os
import numpy as np

import ms_engineers_s4_layout as L    # sets meshlib.ATLAS = 2048
from meshlib import Part, chamfer_box, limb
from gltf_export import export
import parts as PP

STEM = 'ms_engineers_s4'
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')

RNG = np.random.default_rng(90210)


# ── track pods (written into body) ───────────────────────────────────────

def add_pod(p, cx):
    prof = L.POD_PROFILE
    w = L.POD_HW
    n = len(prof)
    hi = [(cx + w, y, z) for (z, y) in prof]   # side at larger x
    lo = [(cx - w, y, z) for (z, y) in prof]
    # profile is CCW in (z,y) → raw fan normal is -X; +x-facing side flips.
    p.add_face(hi, zone=L.Z_POD_SIDE, flip=True)
    p.add_face(lo, zone=L.Z_POD_SIDE)

    # wrap: arc-length parametric UV into Z_POD_WRAP
    x0, y0, x1, y1 = L.Z_POD_WRAP
    seg = [np.hypot(prof[(i + 1) % n][0] - prof[i][0],
                    prof[(i + 1) % n][1] - prof[i][1]) for i in range(n)]
    total = sum(seg)
    acc = 0.0
    centroid = np.array([cx, sum(y for _, y in prof) / n,
                         sum(z for z, _ in prof) / n])
    A = 2048.0
    for i in range(n):
        j = (i + 1) % n
        u0 = (x0 + (x1 - x0) * acc / total) / A
        acc += seg[i]
        u1 = (x0 + (x1 - x0) * acc / total) / A
        va, vb = y0 / A, y1 / A
        quad = [(cx + w, prof[i][1], prof[i][0]),
                (cx - w, prof[i][1], prof[i][0]),
                (cx - w, prof[j][1], prof[j][0]),
                (cx + w, prof[j][1], prof[j][0])]
        uvs = [(u0, va), (u0, vb), (u1, vb), (u1, va)]
        nrm = np.cross(np.asarray(quad[1], float) - np.asarray(quad[0], float),
                       np.asarray(quad[3], float) - np.asarray(quad[0], float))
        ctr = np.mean(np.array(quad), axis=0)
        if np.dot(nrm, ctr - centroid) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)


# ── body ────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')

    add_pod(p, L.POD_CX)
    add_pod(p, -L.POD_CX)

    # fabrication deck spanning both pods
    chamfer_box(p, L.DECK_C, L.DECK_S, 0.05,
                {'+y': L.Z_DECK, '-y': L.Z_DARK,
                 '+x': L.Z_DECK_EDGE, '-x': L.Z_DECK_EDGE,
                 '+z': L.Z_HULL_END, '-z': L.Z_HULL_END})

    # belly hull between the pods
    chamfer_box(p, L.BELLY_C, L.BELLY_S, 0.04,
                {'+x': L.Z_BELLY, '-x': L.Z_BELLY, '+y': L.Z_DARK,
                 '-y': L.Z_DARK, '+z': L.Z_HULL_END, '-z': L.Z_HULL_END})

    # crew cab (glazed, forward) + visor
    chamfer_box(p, L.CAB_C, L.CAB_S, 0.07,
                {'-x': L.Z_CAB_SIDE, '+x': L.Z_CAB_SIDE_M,
                 '-z': L.Z_CAB_FRONT, '+z': L.Z_CAB_REAR,
                 '+y': L.Z_CAB_TOP}, skip=('-y',))
    chamfer_box(p, L.VISOR_C, L.VISOR_S, 0.02,
                {'+y': L.Z_CAB_TOP, '-y': L.Z_DARK, '+x': L.Z_DARK,
                 '-x': L.Z_DARK, '+z': L.Z_DARK, '-z': L.Z_DARK})

    # rotating-beacon mast + amber beacon head (emissive cell)
    limb(p, L.BEACON_MAST[0], L.BEACON_MAST[1], 0.05, 0.045, L.Z_MAST, n=4)
    PP.beacon(p, L.BEACON_C, L.BEACON_SZ, glow_zone=L.Z_LIGHT)

    # cab-roof floodlights
    for (fx, fy, fz) in L.CAB_FLOODS:
        limb(p, (fx, 7.4, fz + 0.1), (fx, fy - 0.1, fz), 0.05, 0.04,
             L.Z_MAST, n=4)
        PP.box6(p, (fx, fy, fz), L.FLOOD_SZ, L.Z_FLOOD, ch=0.03)

    # exhaust stacks behind the cab
    for (ex, ez) in L.EXHAUSTS:
        limb(p, (ex, 3.25, ez), (ex, L.EXH_TOP, ez), 0.18, 0.15, L.Z_EXH, n=4)
        PP.box6(p, (ex, L.EXH_TOP + 0.04, ez), (0.42, 0.12, 0.42),
                L.Z_DARK, ch=0.02)

    # fabrication-bay roof on columns
    chamfer_box(p, L.ROOF_C, L.ROOF_S, 0.05,
                {'+y': L.Z_ROOF_TOP, '-y': L.Z_ROOF_BOT,
                 '+x': L.Z_ROOF_EDGE, '-x': L.Z_ROOF_EDGE,
                 '+z': L.Z_ROOF_EDGE, '-z': L.Z_ROOF_EDGE})
    for sx in (L.COL_X, -L.COL_X):
        for cz in L.COL_Z:
            limb(p, (sx, 3.28, cz), (sx, L.COL_TOP, cz), 0.16, 0.14,
                 L.Z_MAST, n=4)

    # under-roof bay worklights
    for (wx, wy, wz) in L.BAY_LIGHTS:
        PP.box6(p, (wx, wy, wz), L.BAY_LIGHT_SZ, L.Z_FLOOD, ch=0.02)

    # workpiece slab on the bay floor (welding glow painted on it)
    chamfer_box(p, L.WORK_C, L.WORK_S, 0.04,
                {'+y': L.Z_WORK_TOP, '+z': L.Z_WORK, '-z': L.Z_WORK,
                 '+x': L.Z_WORK, '-x': L.Z_WORK}, skip=('-y',))

    # stowage: crate stack + tarped bundle + gas bottle rack
    PP.crate_stack(p, L.CRATE_ORIGIN, rows=2, cols=2, tiers=1, size=1.0,
                   zone=L.Z_CRATE, rng=RNG)
    PP.tarp_over(p, L.TARP_C, L.TARP_S, sag=0.16, zone=L.Z_TARP)
    for bz in L.BOTTLE_Z:
        PP.drum(p, (L.BOTTLE_X, 3.32, bz), r=L.BOTTLE_R, h=L.BOTTLE_H,
                zone=L.Z_BOTTLE, n=6)
    # rack rail in front of the bottles
    limb(p, (L.BOTTLE_X - 0.42, 4.35, L.BOTTLE_Z[0] - 0.3),
         (L.BOTTLE_X - 0.42, 4.35, L.BOTTLE_Z[-1] + 0.3), 0.04, 0.04,
         L.Z_TRIM, n=3)

    # access ladder (cab rear) + aft deck railings
    PP.ladder(p, L.LADDER[0], L.LADDER[1], width=0.5, zone=L.Z_TRIM)
    PP.railing(p, L.RAIL_REAR[0], L.RAIL_REAR[1], h=1.0, zone=L.Z_TRIM)
    for (a, b) in L.RAIL_SIDES:
        PP.railing(p, a, b, h=1.0, zone=L.Z_TRIM)

    return p


# ── crane ───────────────────────────────────────────────────────────────

def build_crane_base():
    p = Part('crane_base')
    # slew pedestal
    PP.drum(p, (0, 0, 0), r=L.PED_R, h=L.PED_H, zone=L.Z_CRANE_SIDE, n=8)
    # operator house + counterweight
    chamfer_box(p, L.HOUSE_C, L.HOUSE_S, 0.05,
                {'-x': L.Z_CRANE_SIDE, '+x': L.Z_CRANE_SIDE_M,
                 '-z': L.Z_CRANE_FACE, '+z': L.Z_CRANE_REAR,
                 '+y': L.Z_CRANE_TOP}, skip=('-y',))
    chamfer_box(p, L.CWT_C, L.CWT_S, 0.05,
                {'-x': L.Z_CRANE_SIDE, '+x': L.Z_CRANE_SIDE_M,
                 '-z': L.Z_CRANE_REAR, '+z': L.Z_CRANE_REAR,
                 '+y': L.Z_CRANE_TOP, '-y': L.Z_DARK})
    # A-frame up to the boom pivot sheave
    for sx in (1, -1):
        limb(p, (sx * 0.5, 2.1, 0.2), (sx * 0.12, 2.5, -1.0), 0.09, 0.07,
             L.Z_MAST, n=4)
    limb(p, (-0.14, 2.5, -1.0), (0.14, 2.5, -1.0), 0.07, 0.07, L.Z_MAST, n=4)
    return p


def build_crane_boom():
    p = Part('crane_boom')
    tx, ty, tz = L.BOOM_TIP
    # pivot boss
    PP.box6(p, (0, 0.05, 0), (0.6, 0.5, 0.6), L.Z_HOOK, ch=0.04)
    # twin lattice chords converging at the tip
    for sx in (1, -1):
        limb(p, (sx * 0.26, -0.1, 0.35), (sx * 0.05, ty - 0.05, tz + 0.05),
             0.13, 0.09, L.Z_BOOM, n=4)
    # cross braces
    for t in (0.3, 0.55, 0.8):
        a = (0.26 + (0.05 - 0.26) * t, -0.1 + (ty - 0.05 + 0.1) * t,
             0.35 + (tz + 0.05 - 0.35) * t)
        b = (-a[0], a[1], a[2])
        limb(p, a, b, 0.05, 0.05, L.Z_BOOM, n=3)
    # tip pulley block, hook cable, hook block
    PP.box6(p, (tx, ty, tz), (0.32, 0.36, 0.52), L.Z_HOOK, ch=0.03)
    limb(p, (tx, ty - 0.15, tz), (tx, 2.98, tz), 0.035, 0.035, L.Z_TRIM, n=3)
    PP.box6(p, (tx, 2.78, tz), (0.3, 0.42, 0.2), L.Z_HOOK, ch=0.03)
    return p


# ── clips ───────────────────────────────────────────────────────────────

def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def qx(deg):
    r = np.radians(deg) / 2
    return (float(np.sin(r)), 0.0, 0.0, float(np.cos(r)))


def build_clips():
    T = 10.0
    sweep = [(0.0, qy(0)), (T * 0.25, qy(25)), (T * 0.5, qy(0)),
             (T * 0.75, qy(-25)), (T, qy(0))]
    bob = [(0.0, qx(0)), (T * 0.25, qx(-2.5)), (T * 0.5, qx(0)),
           (T * 0.75, qx(-2.5)), (T, qx(0))]
    return [{'name': 'idle',
             'channels': [('crane_base', 'rotation', sweep),
                          ('crane_boom', 'rotation', bob)]}]


# ── assembly ────────────────────────────────────────────────────────────

def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='crane_base', parent=0, offset=L.CRANE_OFF,
             part=build_crane_base()),
        dict(name='crane_boom', parent=1, offset=L.BOOM_OFF,
             part=build_crane_boom()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print('AABB (world, offsets applied): '
          'x -5.25..5.25  y 0.00..9.93  z -9.95..9.95')
    print(f'TOTAL: {total} tris')
