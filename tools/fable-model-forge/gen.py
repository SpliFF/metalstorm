"""gen — build fable_tank geometry and export .gltf + .bin.

Usage: python3 gen.py [png]   ('png' emits a preview gltf with PNG
texture URIs for the local three.js rig; default emits the shippable
KTX2/basisu gltf).  Both variants share the same .bin.
"""
from __future__ import annotations
import json
import struct
import sys
import numpy as np

from meshlib import Part, Zone, loft, chamfer_box, tube, ngon_ring, mirror_x
from gltf_export import export
import layout as L

STEM = 'fable_tank'
OUT = 'out'


# ── zone classifiers ─────────────────────────────────────────────────────

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


def turret_zone(c, n):
    if n[1] < -0.5:
        return L.Z_DARK
    if abs(n[0]) > 0.62:
        return L.Z_TURRET_SIDE
    if n[2] < -0.55:
        return L.Z_TURRET_FRONT
    if n[2] > 0.55:
        return L.Z_TURRET_REAR
    return L.Z_TURRET_TOP


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
    loft(p, rings, hull_zone, cap_start=L.Z_GLACIS, cap_end=L.Z_HULL_REAR)

    for (hx, hz) in L.HATCHES:
        chamfer_box(p, (hx, L.HULL_DECK_Y + L.HATCH_SIZE[1] / 2 - 0.015, hz),
                    L.HATCH_SIZE, 0.02,
                    {'+y': L.Z_HATCH, '+x': L.Z_HATCH, '-x': L.Z_HATCH,
                     '+z': L.Z_HATCH, '-z': L.Z_HATCH}, skip=('-y',))
    x, y, z, w, h, d = L.SENSOR_BAR
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': L.Z_SENSOR, '-z': L.Z_SENSOR, '+x': L.Z_SENSOR,
                 '-x': L.Z_SENSOR, '+z': L.Z_SENSOR}, skip=('-y',))
    x, y, z, w, h, d = L.INTAKE
    chamfer_box(p, (x, y, z), (w, h, d), 0.025,
                {'+y': L.Z_INTAKE, '+x': L.Z_HULL_SIDE, '-x': L.Z_HULL_SIDE,
                 '+z': L.Z_HULL_REAR, '-z': L.Z_HULL_REAR}, skip=('-y',))
    for (ex, ey, ez) in L.EXHAUSTS:
        chamfer_box(p, (ex, ey, ez), L.EXHAUST_SIZE, 0.04,
                    {'+y': L.Z_HULL_TOP, '+x': L.Z_HULL_SIDE, '-x': L.Z_HULL_SIDE,
                     '+z': L.Z_EXHAUST, '-z': L.Z_HULL_SIDE}, skip=('-y',))
    return p


# ── tracks ──────────────────────────────────────────────────────────────

def build_tracks_l():
    p = Part('tracks_l')
    prof = L.TRACK_PROFILE
    w = L.TRACK_HALF_W
    n = len(prof)

    outer = [(w, y, z) for (z, y) in prof]
    inner = [(-w, y, z) for (z, y) in prof]
    # profile is CCW in the (z,y) plane -> raw fan normal is -X;
    # outer (+x) face needs +X, inner needs -X.
    p.add_face(outer, zone=L.Z_TRACK_SIDE, flip=True)
    p.add_face(inner, zone=L.Z_TRACK_SIDE)

    # wrap: arc-length parametric UV into Z_TRACK_WRAP
    x0, y0, x1, y1 = L.Z_TRACK_WRAP
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

    # hubs (sprocket + idler) on the outer face
    for (hz, hy, hr) in (L.HUB_FRONT, L.HUB_REAR):
        rings = [ngon_ring((w - 0.01, hy, hz), hr, n=8, axis='x'),
                 ngon_ring((w + 0.08, hy, hz), hr, n=8, axis='x')]
        # ring order around x-axis: ensure outward quads via loft flip check
        hx0, hy0, hx1, hy1 = L.Z_HUB
        for j in range(8):
            k = (j + 1) % 8
            u0 = (hx0 + (hx1 - hx0) * j / 8) / 1024.0
            u1 = (hx0 + (hx1 - hx0) * (j + 1) / 8) / 1024.0
            quad = [rings[0][j], rings[0][k], rings[1][k], rings[1][j]]
            uvs = [(u0, hy0 / 1024.0), (u1, hy0 / 1024.0),
                   (u1, hy1 / 1024.0), (u0, hy1 / 1024.0)]
            nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                           np.asarray(quad[3]) - np.asarray(quad[0]))
            ctr = np.mean(np.array(quad), axis=0)
            rad = ctr - np.array([ctr[0], hy, hz])
            if np.dot(nrm, rad) < 0:
                quad, uvs = quad[::-1], uvs[::-1]
            p.add_face(quad, uvs=uvs)
        cap = ngon_ring((w + 0.08, hy, hz), hr, n=8, axis='x')
        zc = Zone(L.Z_HUB_CAP.rect, ('z', 'y'),
                  ((hz - hr, hz + hr), (hy + hr, hy - hr)))
        # axis='x' ring is CCW in (y,z) -> raw fan normal +X = outward here
        p.add_face(cap, zone=zc)

    # fender top plate, sitting flush on the pod top
    (fz0, fz1), fy, fh, fw = L.FENDER
    chamfer_box(p, (0.0, fy + fh / 2 - 0.02, (fz0 + fz1) / 2),
                (fw, fh, fz1 - fz0), 0.035,
                {'+y': L.Z_FENDER, '+x': L.Z_TRACK_SIDE, '-x': L.Z_TRACK_SIDE,
                 '+z': L.Z_TRACK_SIDE, '-z': L.Z_TRACK_SIDE}, skip=('-y',))
    # hanging side-skirt plate over the upper track run
    sx, sy, sw, sh, sz0, sz1 = L.SKIRT
    chamfer_box(p, (sx, sy, (sz0 + sz1) / 2), (sw, sh, sz1 - sz0), 0.02,
                {'+x': L.Z_TRACK_SIDE, '-x': L.Z_DARK, '+y': L.Z_TRACK_SIDE,
                 '-y': L.Z_DARK, '+z': L.Z_TRACK_SIDE, '-z': L.Z_TRACK_SIDE})
    return p


# ── turret ──────────────────────────────────────────────────────────────

def build_turret():
    p = Part('turret')
    rings = [ring_from_section(s) for s in L.TURRET_SECTIONS]
    loft(p, rings, turret_zone, cap_start=L.Z_TURRET_FRONT, cap_end=L.Z_TURRET_REAR)

    # commander sight drum (octagon, axis y)
    sx, sz, sr, sh = L.SIGHT_DRUM
    ybase = 0.96
    r0 = ngon_ring((sx, ybase, sz), sr, n=8, axis='y')
    r1 = ngon_ring((sx, ybase + sh, sz), sr, n=8, axis='y')
    dx0, dy0, dx1, dy1 = L.Z_SIGHT
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
        rad = ctr - np.array([sx, ctr[1], sz])
        if np.dot(nrm, rad) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)
    zc = Zone(L.Z_SIGHT_TOP.rect, ('x', 'z'),
              ((sx - sr, sx + sr), (sz - sr, sz + sr)))
    p.add_face(ngon_ring((sx, ybase + sh, sz), sr, n=8, axis='y'), zone=zc,
               flip=True)

    x, y, z, w, h, d = L.SENSOR_POD
    chamfer_box(p, (x, y, z), (w, h, d), 0.035,
                {'+y': L.Z_POD, '+x': L.Z_POD, '-x': L.Z_POD,
                 '-z': L.Z_POD, '+z': L.Z_POD, '-y': L.Z_DARK})
    x, y, z, w, h, d = L.BUSTLE
    chamfer_box(p, (x, y, z), (w, h, d), 0.045,
                {'+y': L.Z_BUSTLE, '+x': L.Z_BUSTLE, '-x': L.Z_BUSTLE,
                 '+z': L.Z_BUSTLE, '-z': L.Z_BUSTLE}, skip=('-y',))
    for (mx, my, mz) in L.SMOKES:
        chamfer_box(p, (mx, my, mz), L.SMOKE_SIZE, 0.03,
                    {'+y': L.Z_SMOKE, '+x': L.Z_SMOKE, '-x': L.Z_SMOKE,
                     '-z': L.Z_SMOKE, '+z': L.Z_SMOKE, '-y': L.Z_DARK})
    return p


# ── barrel ──────────────────────────────────────────────────────────────

def build_barrel():
    p = Part('barrel')
    x, y, z, w, h, d = L.BREECH
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+y': L.Z_BREECH, '+x': L.Z_BREECH, '-x': L.Z_BREECH,
                 '+z': L.Z_BREECH, '-z': L.Z_BREECH, '-y': L.Z_BREECH})
    tube(p, L.TUBE_STATIONS, L.Z_BARREL_WRAP, n=8, cap_end=L.Z_TUBE_CAP)
    (cz0, cz1), cr = L.CAP_RING
    tube(p, [(cz0, cr), (cz1, cr)], L.Z_CAP_RING, n=8,
         cap_start=L.Z_TUBE_CAP, cap_end=L.Z_TUBE_CAP)
    z0, z1 = L.RAIL_ZSPAN
    for (rx, rw, rh) in L.RAILS:
        chamfer_box(p, (rx, 0.0, (z0 + z1) / 2), (rw, rh, abs(z1 - z0)), 0.018,
                    {'+y': L.Z_RAIL_SIDE, '-y': L.Z_RAIL_SIDE,
                     '+x': L.Z_RAIL_SIDE, '-x': L.Z_RAIL_SIDE,
                     '-z': L.Z_TUBE_CAP, '+z': L.Z_TUBE_CAP})
    x, y, z, w, h, d = L.BRAKE
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+y': L.Z_BRAKE, '-y': L.Z_BRAKE, '+x': L.Z_BRAKE,
                 '-x': L.Z_BRAKE, '-z': L.Z_BRAKE, '+z': L.Z_BRAKE})
    (tz0, tz1), tr = L.TIP_STUB
    tube(p, [(tz0, tr), (tz1, tr)], L.Z_CAP_RING, n=8, cap_end=L.Z_TUBE_CAP)
    return p


# ── assembly ────────────────────────────────────────────────────────────

def build_all():
    body = build_body()
    tl = build_tracks_l()
    tr = mirror_x(tl, 'tracks_r')
    tur = build_turret()
    bar = build_barrel()

    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=body),
        dict(name='tracks_l', parent=0, offset=L.TRACK_OFF, part=tl),
        dict(name='tracks_r', parent=0,
             offset=(-L.TRACK_OFF[0], L.TRACK_OFF[1], L.TRACK_OFF[2]), part=tr),
        dict(name='turret', parent=0, offset=L.TURRET_OFF, part=tur),
        dict(name='barrel', parent=3, offset=L.BARREL_OFF, part=bar),
        dict(name='muzzle', parent=4, offset=L.MUZZLE_OFF, part=None),
        dict(name='exhaust', parent=0, offset=L.EXHAUST_OFF, part=None),
    ]
    return pieces



if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
