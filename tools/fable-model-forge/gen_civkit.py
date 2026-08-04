"""gen_civkit — build all five civilian models on the shared atlas.

ms_habitat / ms_transit_hub / ms_depot (static `body`) and
ms_civtruck / ms_civbus (`body` + spinnable `axle_f`/`axle_r` pieces).
After export, every glTF's image URIs are rewritten to the shared
`fable_civkit_*` texture set.

Usage: python3 gen_civkit.py
"""
from __future__ import annotations
import json
import numpy as np

import civkit_layout as C          # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, loft, chamfer_box, tube, ngon_ring, limb
from gltf_export import export

OUT = 'out'
TEX_STEM = 'fable_civkit'


def quad_out(p, verts, outward, zone):
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, outward) > 0 else verts[::-1], zone=zone)


def bldg_box(p, center, size, side, front, roof, ch=0.06, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': roof, '-y': roof, '+x': side, '-x': side,
                 '+z': front, '-z': front}, skip=skip)


def box(p, center, size, zone, ch=0.04, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def wheel_pair(p, cz, r):
    """Axle piece geometry: two 8-gon wheels + connecting axle bar."""
    for sx in (-1.02, 1.02):
        ra = ngon_ring((sx - C.WHEEL_HW, 0, 0), r, n=8, axis='x')
        rb = ngon_ring((sx + C.WHEEL_HW, 0, 0), r, n=8, axis='x')
        for j in range(8):
            k = (j + 1) % 8
            quad = [ra[j], ra[k], rb[k], rb[j]]
            cq = np.mean(np.array(quad), axis=0)
            quad_out(p, quad, (0, cq[1], cq[2]), C.WHEEL)
        quad_out(p, list(ra), (-1, 0, 0), C.HUB)
        quad_out(p, list(rb), (1, 0, 0), C.HUB)
    box(p, (0, 0, 0), (1.9, 0.22, 0.22), C.DARKC, ch=0.02)


def build_habitat():
    p = Part('body')
    bldg_box(p, C.HAB_A[:3], C.HAB_A[3:], C.H_SIDE, C.H_FRONT, C.H_ROOF)
    bldg_box(p, C.HAB_B[:3], C.HAB_B[3:], C.H_SIDE, C.H_FRONT, C.H_ROOF)
    bldg_box(p, C.HAB_STAIR[:3], C.HAB_STAIR[3:], C.H_SIDE, C.H_FRONT,
             C.H_ROOF)
    # balconies on slab A's street face
    for by in C.HAB_BALCONY_Y:
        box(p, (-2.0, by, -12.15), (20.0, 0.18, 0.7), C.TRIMC, ch=0.02)
    # entrance porch + steps
    box(p, C.HAB_PORCH[:3], C.HAB_PORCH[3:], C.TRIMC, ch=0.03)
    box(p, (-2.0, 0.18, -12.5), (5.0, 0.36, 1.4), C.TRIMC, ch=0.02)
    # roof furniture: water tank, AC boxes, antenna
    tx, tz = C.HAB_TANK
    limb(p, (tx, 20.0, tz), (tx, 22.2, tz), 1.15, 1.15, C.TANKW, n=8)
    for (ax, az) in ((-6.5, -9.5), (-9.0, -3.5), (3.5, 2.0), (8.0, 7.5)):
        box(p, (ax, 20.4 if ax < 0 else 18.4, az), (1.4, 0.8, 1.4), C.TRIMC,
            ch=0.04)
    limb(p, (-4.0, 20.0, -2.0), (-4.0, 23.5, -2.0), 0.06, 0.03,
         C.TRIMC.rect, n=4)
    return [dict(name='body', parent=-1, offset=(0, 0, 0), part=p)]


def build_transit():
    p = Part('body')
    x, y, z, w, h, d = C.HUB_HALL
    bldg_box(p, (x, y, z), (w, h, d), C.T_SIDE, C.T_FRONT, C.T_ROOF,
             skip=('+y',))
    # arched roof read: two angled slabs over the hall
    for (z0, z1, y0, y1) in ((-11.0, -4.0, 9.05, 10.4), (-4.0, 3.0, 10.4, 9.05)):
        quad_out(p, [(-12.2, y0, z0), (12.2, y0, z0), (12.2, y1, z1),
                     (-12.2, y1, z1)], (0, 1, 0), C.T_ROOF)
        quad_out(p, [(-12.2, y0 - 0.04, z0), (12.2, y0 - 0.04, z0),
                     (12.2, y1 - 0.04, z1), (-12.2, y1 - 0.04, z1)],
                 (0, -1, 0), C.DARKC)
    # platform + canopy on columns
    box(p, C.HUB_PLAT[:3], C.HUB_PLAT[3:], C.TRIMC, ch=0.04)
    box(p, C.HUB_CANOPY[:3], C.HUB_CANOPY[3:], C.T_CANOPY, ch=0.05)
    for (cx, cz) in C.HUB_COLS:
        limb(p, (cx, 0.4, cz), (cx, 4.6, cz), 0.14, 0.12, C.TRIMC.rect, n=6)
    # clock pylon + sign board
    bldg_box(p, C.HUB_PYLON[:3], C.HUB_PYLON[3:], C.T_SIDE, C.T_FRONT,
             C.T_ROOF)
    box(p, (C.HUB_PYLON[0], 10.6, C.HUB_PYLON[2]), (2.2, 1.2, 2.2),
        C.GLOWC, ch=0.05)
    x, y, z, w, h, d = C.HUB_SIGN
    chamfer_box(p, (x, y, z), (w, h, d), 0.04,
                {'+y': C.TRIMC, '-y': C.TRIMC, '+x': C.TRIMC, '-x': C.TRIMC,
                 '-z': C.T_SIGN, '+z': C.TRIMC})
    return [dict(name='body', parent=-1, offset=(0, 0, 0), part=p)]


def build_depot():
    p = Part('body')
    x, y, z, w, h, d = C.DEP_HALL
    bldg_box(p, (x, y, z), (w, h, d), C.D_SIDE, C.D_FRONT, C.D_ROOF,
             skip=('+y',))
    # gable roof (ridge along z) + end triangles
    top = y + h / 2
    ridge = top + C.DEP_RIDGE
    for s in (1, -1):
        quad_out(p, [(s * (w / 2 + 0.5), top - 0.15, z - d / 2 - 0.3),
                     (s * (w / 2 + 0.5), top - 0.15, z + d / 2 + 0.3),
                     (0, ridge, z + d / 2 + 0.3), (0, ridge, z - d / 2 - 0.3)],
                 (s * 0.4, 1, 0), C.D_ROOF)
    for sz in (z - d / 2, z + d / 2):
        out = -1 if sz < z else 1
        quad_out(p, [(-w / 2, top, sz), (w / 2, top, sz), (0, ridge, sz)],
                 (0, 0, out), C.D_FRONT)
    # loading dock + bumpers
    box(p, C.DEP_DOCK[:3], C.DEP_DOCK[3:], C.D_SIDE, ch=0.04)
    for bx in (-6.0, 0.0, 6.0):
        box(p, (bx, 0.5, 9.9), (1.2, 0.5, 0.3), C.DARKC, ch=0.02)
    # fuel tank on saddles
    tx, ty, tz, tr, tl = C.DEP_TANK
    tube(p, [(tz + tl / 2, tr, ty), (tz - tl / 2, tr, ty)], C.TANKW, n=8,
         xoff=tx, cap_start=C.TRIMC, cap_end=C.TRIMC)
    for sz in (tz - 1.8, tz + 1.8):
        box(p, (tx, 0.5, sz), (2.4, 1.0, 0.5), C.TRIMC, ch=0.03)
    # crate cluster + yard light poles
    for (cx, cy, cz, cs) in C.DEP_CRATES:
        box(p, (cx, cy, cz), (cs, cs * 0.95, cs), C.CRATE, ch=0.03)
    for (px, pz) in C.DEP_POLES:
        limb(p, (px, 0.2, pz), (px, 6.4, pz), 0.09, 0.06, C.TRIMC.rect, n=4)
        box(p, (px, 6.5, pz + 0.4), (0.3, 0.25, 1.0), C.GLOWC, ch=0.02)
    return [dict(name='body', parent=-1, offset=(0, 0, 0), part=p)]


def build_truck():
    p = Part('body')
    x, y, z, w, h, d = C.TRK_CAB
    chamfer_box(p, (x, y, z), (w, h, d), 0.16,
                {'+y': C.K_ROOF, '-y': C.DARKC, '+x': C.K_SIDE,
                 '-x': C.K_SIDE, '-z': C.K_FRONT, '+z': C.K_SIDE})
    x, y, z, w, h, d = C.TRK_BOX
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+y': C.K_ROOF, '-y': C.DARKC, '+x': C.K_SIDE,
                 '-x': C.K_SIDE, '-z': C.K_SIDE, '+z': C.K_FRONT})
    box(p, C.TRK_CHASSIS[:3], C.TRK_CHASSIS[3:], C.DARKC, ch=0.03)
    box(p, (0, 0.62, -3.68), (2.2, 0.42, 0.25), C.TRIMC, ch=0.03)  # bumper
    pieces = [dict(name='body', parent=-1, offset=(0, 0, 0), part=p)]
    for i, (az, ar) in enumerate(C.TRK_AXLES):
        ax = Part(f'axle_{"f" if i == 0 else "r"}')
        wheel_pair(ax, az, ar)
        pieces.append(dict(name=f'axle_{"f" if i == 0 else "r"}', parent=0,
                           offset=(0, ar, az), part=ax))
    return pieces


def build_bus():
    p = Part('body')
    x, y, z, w, h, d = C.BUS_BODY
    chamfer_box(p, (x, y, z), (w, h, d), 0.22,
                {'+y': C.B_ROOF, '-y': C.DARKC, '+x': C.B_SIDE,
                 '-x': C.B_SIDE, '-z': C.B_FRONT, '+z': C.B_FRONT})
    box(p, C.BUS_AC[:3], C.BUS_AC[3:], C.B_ROOF, ch=0.06)
    box(p, (0, 0.62, -5.25), (2.3, 0.4, 0.22), C.TRIMC, ch=0.03)   # bumpers
    box(p, (0, 0.62, 5.25), (2.3, 0.4, 0.22), C.TRIMC, ch=0.03)
    pieces = [dict(name='body', parent=-1, offset=(0, 0, 0), part=p)]
    for i, (az, ar) in enumerate(C.BUS_AXLES):
        ax = Part(f'axle_{"f" if i == 0 else "r"}')
        wheel_pair(ax, az, ar)
        pieces.append(dict(name=f'axle_{"f" if i == 0 else "r"}', parent=0,
                           offset=(0, ar, az), part=ax))
    return pieces


MODELS = {
    'ms_habitat': build_habitat,
    'ms_transit_hub': build_transit,
    'ms_depot': build_depot,
    'ms_civtruck': build_truck,
    'ms_civbus': build_bus,
}


def rewrite_uris(stem):
    for suffix in ('', '_png'):
        path = f'{OUT}/{stem}{suffix}.gltf'
        doc = json.load(open(path))
        for img in doc.get('images', []):
            uri = img['uri']
            for kind in ('diffuse', 'orm', 'emissive', 'team', 'normals'):
                if kind in uri:
                    ext = 'png' if suffix else 'ktx2'
                    img['uri'] = f'{TEX_STEM}_{kind}.{ext}'
        json.dump(doc, open(path, 'w'), separators=(',', ':'))


if __name__ == '__main__':
    for stem, fn in MODELS.items():
        pieces = fn()
        export(pieces, stem, texmode='ktx2', outdir=OUT, normal_map=True)
        export(pieces, stem, texmode='png', outdir=OUT, normal_map=True)
        rewrite_uris(stem)
        total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
        print(f'[gen_civkit] {stem}: {total} tris')
