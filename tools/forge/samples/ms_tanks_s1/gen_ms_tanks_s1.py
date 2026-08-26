"""gen_ms_tanks_s1 — assemble ms_tanks_s1 and export .gltf/.bin.

Wheeled tankette (tanks-row s1, 4.5 m): lofted armoured hull, four wheels
on spinnable axle_f/axle_r pieces, small autocannon turret on the standard
turret/barrel/muzzle aim chain, mudguards, stowage, whip aerial.

Run: $PY gen_ms_tanks_s1.py   → out/ms_tanks_s1{,_png}.gltf + .bin
"""
from __future__ import annotations
import os
import numpy as np

import ms_tanks_s1_layout as L      # sets meshlib.ATLAS = 1024
from meshlib import Part, loft, chamfer_box, limb
from gltf_export import export
import parts as P

STEM = 'ms_tanks_s1'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')


def hull_zone(c, n):
    if n[1] < -0.5:
        return L.T_DARK
    if abs(n[0]) > 0.62:
        return L.T_SIDE
    if n[2] < -0.55:
        return L.T_GLACIS
    if n[2] > 0.55:
        return L.T_REAR
    return L.T_TOP


def ring_from_section(sec):
    z, yb, yw, ys, yd, wb, ww, wd, wt = sec
    return [
        (wb, yb, z), (ww, yw, z), (wd, ys, z), (wt, yd, z),
        (-wt, yd, z), (-wd, ys, z), (-ww, yw, z), (-wb, yb, z),
    ]


def build_body():
    p = Part('body')
    rings = [ring_from_section(s) for s in L.HULL_SECTIONS]
    loft(p, rings, hull_zone, cap_start=L.T_GLACIS, cap_end=L.T_REAR)

    # mudguards over the wheels
    for (fx, fy, fz, fw, fh, fd) in L.FENDERS:
        chamfer_box(p, (fx, fy, fz), (fw, fh, fd), 0.02,
                    {'+y': L.T_FENDER, '+x': L.T_SIDE, '-x': L.T_SIDE,
                     '+z': L.T_SIDE, '-z': L.T_SIDE}, skip=('-y',))

    # driver hatch on the front deck
    hx, hy, hz, hw, hh, hd = L.DRIVER_HATCH
    chamfer_box(p, (hx, hy + hh / 2 - 0.012, hz), (hw, hh, hd), 0.015,
                {'+y': L.T_HATCH, '+x': L.T_HATCH, '-x': L.T_HATCH,
                 '+z': L.T_HATCH, '-z': L.T_HATCH}, skip=('-y',))

    # rear stowage box
    sx, sy, sz, sw, sh, sd = (L.STOW_BOX[0], L.STOW_BOX[1], L.STOW_BOX[2],
                              L.STOW_BOX[3], L.STOW_BOX[4], L.STOW_BOX[5])
    chamfer_box(p, (sx, sy, sz), (sw, sh, sd), 0.03,
                {'+y': L.T_STOW, '+x': L.T_STOW, '-x': L.T_STOW,
                 '+z': L.T_STOW, '-z': L.T_STOW}, skip=('-y',))

    # exhaust pipes off the tail
    for (p0, p1) in L.EXHAUSTS:
        limb(p, p0, p1, L.EXHAUST_R, L.EXHAUST_R * 0.9, L.T_TRIM, n=4)

    # whip aerial
    ax, ay, az = L.AERIAL
    limb(p, (ax, ay, az), (ax + 0.12, L.AERIAL_TOP, az + 0.10),
         0.025, 0.010, L.T_TRIM, n=3)
    return p


def build_all():
    pieces = [dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body())]

    # spinnable axles (engine spins X)
    for name, z in (('axle_f', L.AXLE_F_Z), ('axle_r', L.AXLE_R_Z)):
        ax = P.axle_piece(name, z, L.AXLE_Y, track=L.TRACK_W, r=L.WHEEL_R,
                          w=L.WHEEL_W, zone=L.T_WHEEL, n=L.WHEEL_N)
        ax['parent'] = 0
        pieces.append(ax)

    # aim chain: turret / barrel / muzzle
    t = P.turret_parts(body_index=0, mount=L.TURRET_MOUNT,
                       ring_r=L.TURRET_RING, barrel_len=L.BARREL_LEN,
                       barrel_r=L.BARREL_R, body_zone=L.T_TURRET,
                       barrel_rect=L.T_BARREL)
    base = len(pieces)
    t[1]['parent'] = base           # barrel under turret
    t[2]['parent'] = base + 1       # muzzle under barrel
    pieces.extend(t)
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
