"""gen_ms_supply_truck — assemble ms_supply_truck and export .gltf/.bin.

Armoured military supply truck (7 m cab-over): plated cargo box with
standoff applique plates, brush guard, side skirts, roof stowage
(tarp roll, spare wheel, hatch), exhaust stack, whip antenna; 6x6
running gear on three spinnable axle pieces (axle_f/axle_m/axle_r —
script Spin API, same contract as ms_civtruck).  No authored clips:
wheeled vehicles spin their axle pieces at runtime.

Run: python3 gen_ms_supply_truck.py → out/ms_supply_truck{,_png}.gltf + .bin
"""
from __future__ import annotations
import numpy as np

import ms_supply_truck_layout as L      # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, chamfer_box, ngon_ring, limb
from gltf_export import export

STEM = 'ms_supply_truck'
OUT = 'out'
RNG = np.random.default_rng(90210)      # forge convention (geometry is
                                        # deterministic; kept for parity)


def quad_out(p, verts, outward, zone):
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, outward) > 0 else verts[::-1], zone=zone)


def box(p, center, size, zone, ch=0.04, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def wheelset(name):
    """Axle piece: two 8-gon wheel pairs + connecting axle bar."""
    p = Part(name)
    for sx in (-L.WHEEL_X, L.WHEEL_X):
        ra = ngon_ring((sx - L.WHEEL_HW, 0, 0), L.WHEEL_R, n=8, axis='x')
        rb = ngon_ring((sx + L.WHEEL_HW, 0, 0), L.WHEEL_R, n=8, axis='x')
        for j in range(8):
            k = (j + 1) % 8
            quad = [ra[j], ra[k], rb[k], rb[j]]
            cq = np.mean(np.array(quad), axis=0)
            quad_out(p, quad, (0, cq[1], cq[2]), L.WHEEL)
        quad_out(p, list(ra), (-1, 0, 0), L.HUB)
        quad_out(p, list(rb), (1, 0, 0), L.HUB)
    box(p, (0, 0, 0), (2.34, 0.24, 0.24), L.DARK, ch=0.02)
    return p


def build_body():
    p = Part('body')

    # chassis frame
    box(p, L.CHASSIS[:3], L.CHASSIS[3:], L.DARK, ch=0.04)

    # armoured cab (cab-over)
    x, y, z, w, h, d = L.CAB
    chamfer_box(p, (x, y, z), (w, h, d), 0.10,
                {'+y': L.CAB_ROOF, '-y': L.DARK, '+x': L.CAB_SIDE,
                 '-x': L.CAB_SIDE, '-z': L.CAB_FRONT, '+z': L.DARK})
    # windshield visor plate
    x, y, z, w, h, d = L.VISOR
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': L.CAB_SIDE, '-y': L.DARK, '+x': L.CAB_SIDE,
                 '-x': L.CAB_SIDE, '-z': L.CAB_SIDE, '+z': L.CAB_SIDE})

    # plated cargo box
    x, y, z, w, h, d = L.BOX
    chamfer_box(p, (x, y, z), (w, h, d), 0.08,
                {'+y': L.BOX_ROOF, '-y': L.DARK, '+x': L.BOX_SIDE,
                 '-x': L.BOX_SIDE, '-z': L.DARK, '+z': L.BOX_REAR})
    # standoff applique plates on the box flanks
    px, py, pz, pw, ph, pd = L.PLATE
    for s in (1, -1):
        box(p, (s * px, py, pz), (pw, ph, pd), L.BOX_SIDE, ch=0.02)

    # front bumper + brush guard
    x, y, z, w, h, d = L.BUMPER
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+y': L.DARK, '-y': L.DARK, '+x': L.TRIM, '-x': L.TRIM,
                 '-z': L.CAB_FRONT, '+z': L.DARK})
    for s in (1, -1):
        limb(p, (s * L.GUARD_X, L.GUARD_Y[0], L.GUARD_Z),
             (s * L.GUARD_X, L.GUARD_Y[1], L.GUARD_Z), 0.05, 0.05,
             L.TRIM.rect, n=4)
    limb(p, (-L.GUARD_X - 0.10, L.GUARD_BAR, L.GUARD_Z),
         (L.GUARD_X + 0.10, L.GUARD_BAR, L.GUARD_Z), 0.05, 0.05,
         L.TRIM.rect, n=4)

    # side skirts + fenders over the wheels
    sx_, sy_, sz_, sw_, sh_, sd_ = L.SKIRT
    for s in (1, -1):
        box(p, (s * sx_, sy_, sz_), (sw_, sh_, sd_), L.TRIM, ch=0.02)
        for (fx, fy, fz, fw, fh, fd) in (L.FENDER_F, L.FENDER_R):
            box(p, (s * fx, fy, fz), (fw, fh, fd), L.TRIM, ch=0.02,
                skip=('-y',))

    # underslung stowage bins
    for tb in (L.TOOLBOX_R, L.TOOLBOX_L):
        box(p, tb[:3], tb[3:], L.STOW, ch=0.03)

    # roof stowage: lashed tarp roll (cab), spare wheel + hatch (box)
    x, y, z, w, h, d = L.TARP_ROLL
    chamfer_box(p, (x, y, z), (w, h, d), 0.12,
                {'+y': L.TARP, '-y': L.DARK, '+x': L.TARP, '-x': L.TARP,
                 '+z': L.TARP, '-z': L.TARP})
    wx, wy, wz, wr, whw = L.SPARE
    ra = ngon_ring((wx, wy - whw, wz), wr, n=8, axis='y')
    rb = ngon_ring((wx, wy + whw, wz), wr, n=8, axis='y')
    for j in range(8):
        k = (j + 1) % 8
        quad = [ra[j], ra[k], rb[k], rb[j]]
        cq = np.mean(np.array(quad), axis=0)
        quad_out(p, quad, (cq[0] - wx, 0, cq[2] - wz), L.WHEEL)
    quad_out(p, list(rb), (0, 1, 0), L.HUB)
    box(p, L.HATCH[:3], L.HATCH[3:], L.TRIM, ch=0.03)

    # exhaust stack (behind cab) + whip antenna
    ex, ey0, ey1, ez = L.EXHAUST
    limb(p, (ex, ey0, ez), (ex, ey1, ez), 0.10, 0.085, L.EXH, n=6,
         cap_end=L.DARK)
    ax, ay0, ay1, az = L.ANTENNA
    limb(p, (ax, ay0, az), (ax, ay1, az), 0.035, 0.015, L.TRIM.rect, n=4)
    return p


def build_all():
    pieces = [dict(name='body', parent=-1, offset=(0, 0, 0),
                   part=build_body())]
    for (nm, az) in L.AXLES:
        pieces.append(dict(name=nm, parent=0, offset=(0, L.WHEEL_R, az),
                           part=wheelset(nm)))
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
