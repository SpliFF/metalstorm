"""gen_ms_tanks_s3 — assemble ms_tanks_s3 and export .gltf/.bin.

Heavy tracked tank (tanks-row s3, 12 m): lofted hull between two track
pods, big angular railgun turret (turret/barrel/muzzle) and a pintle MG
chain (turret2/barrel2/muzzle2) on the rear deck.

Run: $PY gen_ms_tanks_s3.py   → out/ms_tanks_s3{,_png}.gltf + .bin
"""
from __future__ import annotations
import os
import numpy as np

import ms_tanks_s3_layout as L      # sets meshlib.ATLAS = 1024
from meshlib import Part, loft, chamfer_box, limb, mirror_x, ngon_ring
from gltf_export import export
import parts as P

STEM = 'ms_tanks_s3'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')


def hull_zone(c, n):
    if n[1] < -0.5:
        return L.H_DARK
    if abs(n[0]) > 0.62:
        return L.H_SIDE
    if n[2] < -0.55:
        return L.H_GLACIS
    if n[2] > 0.55:
        return L.H_REAR
    return L.H_TOP


def ring_from_section(sec):
    z, yb, yw, ys, yd, wb, ww, wd, wt = sec
    return [
        (wb, yb, z), (ww, yw, z), (wd, ys, z), (wt, yd, z),
        (-wt, yd, z), (-wd, ys, z), (-ww, yw, z), (-wb, yb, z),
    ]


def build_body():
    p = Part('body')
    rings = [ring_from_section(s) for s in L.HULL_SECTIONS]
    loft(p, rings, hull_zone, cap_start=L.H_GLACIS, cap_end=L.H_REAR)

    # exhaust stacks on the rear deck
    for (ex, ey, ez) in L.EXHAUSTS:
        chamfer_box(p, (ex, ey, ez), L.EXHAUST_SIZE, 0.03,
                    {'+y': L.TRIM_BOX, '+x': L.H_SIDE, '-x': L.H_SIDE,
                     '+z': L.H_SIDE, '-z': L.H_SIDE}, skip=('-y',))

    # long sponson stowage bins
    for (sx, sy, sz) in L.STOW_BINS:
        chamfer_box(p, (sx, sy, sz), L.STOW_SIZE, 0.03,
                    {'+y': L.STOW, '+x': L.STOW, '-x': L.STOW,
                     '+z': L.STOW, '-z': L.STOW}, skip=('-y',))
    return p


def build_tracks_l():
    p = Part('tracks_l')
    prof = L.TRACK_PROFILE
    w = L.TRACK_HALF_W
    n = len(prof)

    outer = [(w, y, z) for (z, y) in prof]
    inner = [(-w, y, z) for (z, y) in prof]
    p.add_face(outer, zone=L.TRK_SIDE, flip=True)
    p.add_face(inner, zone=L.TRK_SIDE)

    # wrap: arc-length parametric UV into TRK_WRAP
    x0, y0, x1, y1 = L.TRK_WRAP
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

    # fender top plate
    (fz0, fz1), fy, fh, fw = L.FENDER
    chamfer_box(p, (0.0, fy + fh / 2 - 0.02, (fz0 + fz1) / 2),
                (fw, fh, fz1 - fz0), 0.03,
                {'+y': L.TRK_FENDER, '+x': L.TRK_SIDE, '-x': L.TRK_SIDE,
                 '+z': L.TRK_SIDE, '-z': L.TRK_SIDE}, skip=('-y',))
    # hanging side-skirt plate over the upper track run
    sx, sy, sw, sh, sz0, sz1 = L.SKIRT
    chamfer_box(p, (sx, sy, (sz0 + sz1) / 2), (sw, sh, sz1 - sz0), 0.02,
                {'+x': L.TRK_SIDE, '-x': L.H_DARK, '+y': L.TRK_SIDE,
                 '-y': L.H_DARK, '+z': L.TRK_SIDE, '-z': L.TRK_SIDE})
    return p


def build_turret():
    p = Part('turret')
    # turret ring collar
    rings = [ngon_ring((0, 0, 0), L.TURRET_RING, n=10, axis='y'),
             ngon_ring((0, 0.20, 0), L.TURRET_RING, n=10, axis='y')]
    P._ring_solid(p, rings, L.TUR_SIDE, cap_last=False)

    # angular turret body
    x, y, z, w, h, d = L.TUR_BODY
    chamfer_box(p, (x, y, z), (w, h, d), 0.10,
                {'+x': L.TUR_SIDE, '-x': L.TUR_SIDE, '+y': L.TUR_TOP,
                 '+z': L.TUR_REAR, '-z': L.TUR_FRONT}, skip=('-y',))
    # mantlet block
    x, y, z, w, h, d = L.MANTLET
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+x': L.TUR_SIDE, '-x': L.TUR_SIDE, '+y': L.TUR_TOP,
                 '+z': L.TUR_FRONT, '-z': L.TUR_FRONT, '-y': L.H_DARK})
    # rear stowage basket
    x, y, z, w, h, d = L.BASKET
    chamfer_box(p, (x, y, z), (w, h, d), 0.04,
                {'+x': L.STOW, '-x': L.STOW, '+y': L.STOW,
                 '+z': L.TUR_REAR, '-z': L.TUR_REAR, '-y': L.H_DARK})
    # commander hatch + gunner sight box
    for (hx, hy, hz, hw, hh, hd) in (L.TUR_HATCH, L.SIGHT_BOX):
        chamfer_box(p, (hx, hy + hh / 2 - 0.012, hz), (hw, hh, hd), 0.02,
                    {'+y': L.HATCH, '+x': L.HATCH, '-x': L.HATCH,
                     '+z': L.HATCH, '-z': L.HATCH}, skip=('-y',))
    # whip aerial off the turret roof
    ax, ay, az = L.AERIAL
    limb(p, (ax, ay, az), (ax + 0.15, L.AERIAL_TOP, az + 0.12),
         0.028, 0.012, L.TRIM, n=3)
    return p


def build_barrel():
    p = Part('barrel')
    # recoil shroud then the rail pair read as a single tapered tube
    limb(p, (0, 0, 0.10), (0, 0, -L.SHROUD_LEN), L.SHROUD_R,
         L.SHROUD_R * 0.9, L.BARREL_R_, n=6)
    limb(p, (0, 0, -L.SHROUD_LEN + 0.05), (0, 0, -L.BARREL_LEN + 0.30),
         L.BARREL_RAD, L.BARREL_RAD * 0.9, L.BARREL_R_, n=6)
    # muzzle brake / capacitor block at the tip
    x, y, z, w, h, d = L.BRAKE
    chamfer_box(p, (x, y, z), (w, h, d), 0.04,
                {'+x': L.TRIM_BOX, '-x': L.TRIM_BOX, '+y': L.TRIM_BOX,
                 '-y': L.TRIM_BOX, '+z': L.TRIM_BOX, '-z': L.TRIM_BOX})
    return p


def build_all():
    body = build_body()
    tl = build_tracks_l()
    tr = mirror_x(tl, 'tracks_r')
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=body),
        dict(name='tracks_l', parent=0, offset=L.TRACK_OFF, part=tl),
        dict(name='tracks_r', parent=0,
             offset=(-L.TRACK_OFF[0], L.TRACK_OFF[1], L.TRACK_OFF[2]),
             part=tr),
        dict(name='turret', parent=0, offset=L.TURRET_OFF,
             part=build_turret()),
    ]
    pieces.append(dict(name='barrel', parent=3, offset=L.BARREL_OFF,
                       part=build_barrel()))
    pieces.append(dict(name='muzzle', parent=4,
                       offset=(0, 0, -L.BARREL_LEN), part=Part('muzzle')))

    # MG chain: turret2 / barrel2 / muzzle2 (slot-2 name convention)
    t2 = P.turret_parts(body_index=0, mount=L.MG_OFF, ring_r=L.MG_RING,
                        barrel_len=L.MG_BARREL_L, barrel_r=L.MG_BARREL_RD,
                        twin=True, body_zone=L.MG_BODY,
                        barrel_rect=L.MG_BARREL)
    for pc, nm in zip(t2, ('turret2', 'barrel2', 'muzzle2')):
        pc['name'] = nm
        pc['part'].name = nm
    base = len(pieces)
    t2[1]['parent'] = base
    t2[2]['parent'] = base + 1
    pieces.extend(t2)
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
