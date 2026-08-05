"""gen_ms_courier_car — build ms_courier_car geometry, export .gltf + .bin.

Fast armoured courier car (5.5 m, low silhouette, sloped plates,
satchel racks, unmanned MG ring, spinnable axles). Piece tree:

    body ─ axle_f            (spin — engine Spin API, wheels rest at Y=0)
         ─ axle_r            (spin)
         ─ turret            (MG ring yaw)
             └ barrel        (MG elevation)
                 └ muzzle    (empty flare/aim piece)

No authored clips — wheels/ring are engine-driven (same contract as the
civkit truck/bus axles). Deterministic (geometry is closed-form; the
painter shares RNG seed 90210).

Usage: python3 gen_ms_courier_car.py   (writes out/ms_courier_car.gltf
[KTX2 URIs] + out/ms_courier_car_png.gltf [preview] + shared .bin)
"""
from __future__ import annotations
import numpy as np

from meshlib import Part, Zone, loft, chamfer_box, tube, ngon_ring, limb
from gltf_export import export
import ms_courier_car_layout as L

STEM = 'ms_courier_car'
OUT = 'out'


# ── zone classifier (same scheme as fable_tank's hull) ───────────────────

def hull_zone(c, n):
    if n[1] < -0.5:
        return L.Z_DARK
    if abs(n[0]) > 0.62:
        return L.Z_HULL_SIDE
    if n[2] < -0.55:
        return L.Z_GLACIS
    if n[2] > 0.55:
        return L.Z_HULL_REAR
    return L.Z_HULL_TOP


def ring_from_section(sec):
    z, yb, yw, ys, yd, wb, ww, wd, wt = sec
    return [
        (wb, yb, z), (ww, yw, z), (wd, ys, z), (wt, yd, z),
        (-wt, yd, z), (-wd, ys, z), (-ww, yw, z), (-wb, yb, z),
    ]


def quad_out(p, verts, outward, zone):
    """Add a polygon wound so its normal points along `outward`."""
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, np.asarray(outward, dtype=float)) > 0
               else verts[::-1], zone=zone)


# ── body ────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    rings = [ring_from_section(s) for s in L.HULL_SECTIONS]
    loft(p, rings, hull_zone, cap_start=L.Z_GLACIS, cap_end=L.Z_HULL_REAR)

    # driver vision block half-embedded in the glacis slope
    x, y, z, w, h, d = L.VISOR
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': L.Z_HULL_TOP, '+x': L.Z_VISOR, '-x': L.Z_VISOR,
                 '-z': L.Z_VISOR, '+z': L.Z_VISOR}, skip=('-y',))
    # crew hatch behind the MG ring
    hx, hy, hz = L.HATCH
    chamfer_box(p, (hx, hy, hz), L.HATCH_SIZE, 0.02,
                {'+y': L.Z_HATCH, '+x': L.Z_HATCH, '-x': L.Z_HATCH,
                 '+z': L.Z_HATCH, '-z': L.Z_HATCH}, skip=('-y',))
    # bull bar
    x, y, z, w, h, d = L.BUMPER
    chamfer_box(p, (x, y, z), (w, h, d), 0.04,
                {'+y': L.Z_BUMPER, '-y': L.Z_DARK, '+x': L.Z_BUMPER,
                 '-x': L.Z_BUMPER, '-z': L.Z_BUMPER, '+z': L.Z_BUMPER})
    # twin exhaust pipes poking past the tail
    for (ex, ey, ez) in L.EXHAUSTS:
        chamfer_box(p, (ex, ey, ez), L.EXHAUST_SIZE, 0.03,
                    {'+y': L.Z_EXHAUST, '-y': L.Z_DARK, '+x': L.Z_EXHAUST,
                     '-x': L.Z_EXHAUST, '+z': L.Z_EXHAUST}, skip=('-z',))

    # satchel rack: platform slab + rear retaining rail
    x, y, z, w, h, d = L.RACK_SLAB
    chamfer_box(p, (x, y, z), (w, h, d), 0.015,
                {'+y': L.Z_SATCH_TOP, '-y': L.Z_DARK, '+x': L.Z_RACK,
                 '-x': L.Z_RACK, '+z': L.Z_RACK, '-z': L.Z_RACK})
    x, y, z, w, h, d = L.RACK_RAIL
    chamfer_box(p, (x, y, z), (w, h, d), 0.015,
                {'+y': L.Z_RACK, '+x': L.Z_RACK, '-x': L.Z_RACK,
                 '+z': L.Z_RACK, '-z': L.Z_RACK}, skip=('-y',))
    # racked satchel bundles
    for (sx, sz) in L.SATCHELS:
        chamfer_box(p, (sx, L.SATCHEL_Y, sz), L.SATCHEL_SIZE, 0.05,
                    {'+y': L.Z_SATCH_TOP, '+x': L.Z_SATCH_SIDE,
                     '-x': L.Z_SATCH_SIDE, '+z': L.Z_SATCH_END,
                     '-z': L.Z_SATCH_END}, skip=('-y',))
    # flank panniers
    for (px, py, pz) in L.PANNIERS:
        chamfer_box(p, (px, py, pz), L.PANNIER_SIZE, 0.04,
                    {'+x': L.Z_PAN_SIDE, '-x': L.Z_PAN_SIDE,
                     '+z': L.Z_CANVAS, '-z': L.Z_CANVAS,
                     '+y': L.Z_CANVAS, '-y': L.Z_DARK})

    # whip antenna (dispatch radio — silhouette-relevant)
    limb(p, L.ANT_BASE, L.ANT_TOP, L.ANT_R[0], L.ANT_R[1], L.Z_ANT, n=4,
         cap_end=L.Z_DARK)
    return p


# ── axles (spinnable) ───────────────────────────────────────────────────

def build_axle(name):
    p = Part(name)
    r, hw = L.WHEEL_R, L.WHEEL_HW
    x0, y0, x1, y1 = L.Z_WHEEL_WRAP
    for sx in (-L.WHEEL_X, L.WHEEL_X):
        ra = ngon_ring((sx - hw, 0, 0), r, n=8, axis='x')
        rb = ngon_ring((sx + hw, 0, 0), r, n=8, axis='x')
        for j in range(8):
            k = (j + 1) % 8
            u0 = (x0 + (x1 - x0) * j / 8) / 1024.0
            u1 = (x0 + (x1 - x0) * (j + 1) / 8) / 1024.0
            quad = [ra[j], ra[k], rb[k], rb[j]]
            uvs = [(u0, y0 / 1024.0), (u1, y0 / 1024.0),
                   (u1, y1 / 1024.0), (u0, y1 / 1024.0)]
            nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                           np.asarray(quad[3]) - np.asarray(quad[0]))
            ctr = np.mean(np.array(quad), axis=0)
            rad = np.array([0.0, ctr[1], ctr[2]])
            if np.dot(nrm, rad) < 0:
                quad, uvs = quad[::-1], uvs[::-1]
            p.add_face(quad, uvs=uvs)
        # caps: outboard face = hub, inboard face = dark
        if sx < 0:
            quad_out(p, list(ra), (-1, 0, 0), L.Z_HUB)
            quad_out(p, list(rb), (1, 0, 0), L.Z_DARK)
        else:
            quad_out(p, list(rb), (1, 0, 0), L.Z_HUB)
            quad_out(p, list(ra), (-1, 0, 0), L.Z_DARK)
    w, h, d = L.AXLE_BAR
    chamfer_box(p, (0, 0, 0), (w, h, d), 0.02,
                {'+y': L.Z_DARK, '-y': L.Z_DARK, '+x': L.Z_DARK,
                 '-x': L.Z_DARK, '+z': L.Z_DARK, '-z': L.Z_DARK})
    return p


# ── MG ring (unmanned) ──────────────────────────────────────────────────

def build_turret():
    p = Part('turret')
    # armoured ring drum (parametric wrap, tank sight-drum pattern)
    r0 = ngon_ring((0, 0.0, 0), L.RING_R, n=8, axis='y')
    r1 = ngon_ring((0, L.RING_H, 0), L.RING_R, n=8, axis='y')
    dx0, dy0, dx1, dy1 = L.Z_RING
    for j in range(8):
        k = (j + 1) % 8
        u0 = (dx0 + (dx1 - dx0) * j / 8) / 1024.0
        u1 = (dx0 + (dx1 - dx0) * (j + 1) / 8) / 1024.0
        quad = [r0[j], r0[k], r1[k], r1[j]]
        uvs = [(u0, dy1 / 1024.0), (u1, dy1 / 1024.0),
               (u1, dy0 / 1024.0), (u0, dy0 / 1024.0)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        rad = ctr - np.array([0.0, ctr[1], 0.0])
        if np.dot(nrm, rad) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)
    p.add_face(ngon_ring((0, L.RING_H, 0), L.RING_R, n=8, axis='y'),
               zone=L.Z_RING_TOP, flip=True)
    # pedestal column up to the elevation cradle
    py0, py1 = L.PED_SPAN
    q0 = ngon_ring((0, py0, 0), L.PED_R, n=8, axis='y')
    q1 = ngon_ring((0, py1, 0), L.PED_R, n=8, axis='y')
    px0, pyy0, px1, pyy1 = L.Z_PED
    for j in range(8):
        k = (j + 1) % 8
        u0 = (px0 + (px1 - px0) * j / 8) / 1024.0
        u1 = (px0 + (px1 - px0) * (j + 1) / 8) / 1024.0
        quad = [q0[j], q0[k], q1[k], q1[j]]
        uvs = [(u0, pyy1 / 1024.0), (u1, pyy1 / 1024.0),
               (u1, pyy0 / 1024.0), (u0, pyy0 / 1024.0)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        rad = ctr - np.array([0.0, ctr[1], 0.0])
        if np.dot(nrm, rad) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)
    return p


def build_barrel():
    p = Part('barrel')
    x, y, z, w, h, d = L.RECEIVER
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': L.Z_MG_TOP, '-y': L.Z_MG_TOP, '+x': L.Z_MG_SIDE,
                 '-x': L.Z_MG_SIDE, '+z': L.Z_MG_END, '-z': L.Z_MG_END})
    x, y, z, w, h, d = L.AMMO_BOX
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': L.Z_AMMO, '-y': L.Z_AMMO, '+x': L.Z_AMMO,
                 '-x': L.Z_AMMO, '+z': L.Z_AMMO, '-z': L.Z_AMMO})
    tube(p, L.TUBE_STATIONS, L.Z_MG_WRAP, n=8, cap_end=L.Z_TUBE_CAP)
    return p


# ── assembly ────────────────────────────────────────────────────────────

def build_all():
    body = build_body()
    af = build_axle('axle_f')
    ar = build_axle('axle_r')
    tur = build_turret()
    bar = build_barrel()

    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=body),
        dict(name='axle_f', parent=0, offset=(0, L.WHEEL_R, L.AXLE_F_Z),
             part=af),
        dict(name='axle_r', parent=0, offset=(0, L.WHEEL_R, L.AXLE_R_Z),
             part=ar),
        dict(name='turret', parent=0, offset=L.TURRET_OFF, part=tur),
        dict(name='barrel', parent=3, offset=L.BARREL_OFF, part=bar),
        dict(name='muzzle', parent=4, offset=L.MUZZLE_OFF, part=None),
    ]
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
