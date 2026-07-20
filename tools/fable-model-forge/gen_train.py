"""gen_train — build the four land-train units on the shared atlas.

Shared chassis language (plated hull, exposed 8-gon wheel axles, skirt
segments, coupler knuckles with link empties, deck walkways) + per-type
superstructure.  Exported glTF image URIs are rewritten to the shared
`fable_train_*` texture set (§28 pattern).

Usage: python3 gen_train.py
"""
from __future__ import annotations
import json
import numpy as np

import train_layout as T           # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, loft, chamfer_box, tube, ngon_ring, limb
from gltf_export import export

OUT = 'out'
TEX_STEM = 'fable_train'


def quad_out(p, verts, outward, zone):
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, outward) > 0 else verts[::-1], zone=zone)


def box(p, center, size, zone, ch=0.05, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def hull_box(p, center, size, side, end, top, ch=0.12, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': top, '-y': T.DARKT, '+x': side, '-x': side,
                 '+z': end, '-z': end}, skip=skip)


def wheelset(name, r=T.WHEEL_R, hw=T.WHEEL_HW):
    p = Part(name)
    for sx in (-T.WHEEL_X, T.WHEEL_X):
        ra = ngon_ring((sx - hw, 0, 0), r, n=8, axis='x')
        rb = ngon_ring((sx + hw, 0, 0), r, n=8, axis='x')
        for j in range(8):
            k = (j + 1) % 8
            quad = [ra[j], ra[k], rb[k], rb[j]]
            cq = np.mean(np.array(quad), axis=0)
            quad_out(p, quad, (0, cq[1], cq[2]), T.WHEELZ)
        quad_out(p, list(ra), (-1, 0, 0), T.HUBZ)
        quad_out(p, list(rb), (1, 0, 0), T.HUBZ)
    box(p, (0, 0, 0), (3.9, 0.34, 0.34), T.DARKT, ch=0.03)
    return p


def chassis(p, hl, top, side, end, topz, axles, rails=True):
    """Shared chassis: hull, fenders, skirt segments, couplers, rails."""
    hull_box(p, (0, (T.HULL_BOT + top) / 2, 0), (T.HULL_W, top - T.HULL_BOT,
             hl * 2), side, end, topz)
    # fender strip over the wheels + skirt segments between them
    for s in (1, -1):
        box(p, (s * T.WHEEL_X, T.FENDER_Y, 0), (0.55, 0.35, hl * 2 - 0.4),
            side, ch=0.05)
        zs = sorted(axles)
        gaps = [(-hl + 0.3, zs[0] - 1.45)] + \
               [(zs[i] + 1.45, zs[i + 1] - 1.45) for i in range(len(zs) - 1)] \
               + [(zs[-1] + 1.45, hl - 0.3)]
        for (g0, g1) in gaps:
            if g1 - g0 > 0.35:
                box(p, (s * (T.WHEEL_X + 0.05), 1.35, (g0 + g1) / 2),
                    (0.28, 1.15, g1 - g0), side, ch=0.04)
    # coupler knuckles both ends
    for s in (1, -1):
        box(p, (0, T.LINK_Y, s * (hl + 0.35)), (0.6, 0.5, 0.8), T.COUPZ,
            ch=0.05)
        box(p, (0, T.LINK_Y, s * (hl + 0.05)), (1.5, 0.9, 0.4), T.COUPZ,
            ch=0.05)
        limb(p, (0.0, T.LINK_Y, s * (hl + 0.62)),
             (0.0, T.LINK_Y, s * (hl + 0.85)), 0.16, 0.13, T.COUPZ.rect, n=6)
    # low deck bulwarks (spall lips, not walls)
    if rails:
        for s in (1, -1):
            box(p, (s * 1.98, top + 0.11, 0), (0.12, 0.22, hl * 2 - 1.2),
                T.TRIMT, ch=0.02)


def small_cupola(kind):
    """MG or flame cupola turret piece + barrel piece."""
    tp = Part('cup')
    box(tp, (0, 0.22, 0), (1.0, 0.5, 1.1), T.CUPZ, ch=0.08)
    box(tp, (0, 0.55, 0.15), (0.6, 0.25, 0.6), T.CUPZ, ch=0.05)
    if kind == 'flame':
        for sx in (-0.32, 0.32):
            limb(tp, (sx, 0.15, 0.35), (sx, 0.15, 0.62), 0.14, 0.14,
                 T.CUPBW, n=6)
    bp = Part('cupb')
    if kind == 'mg':
        tube(bp, [(0.1, 0.045, 0.0), (-0.75, 0.035, 0.0)], T.CUPBW, n=6,
             cap_end=T.DARKT)
        box(bp, (0, -0.05, 0.05), (0.16, 0.14, 0.4), T.CUPZ, ch=0.02)
    else:                                   # flame projector
        tube(bp, [(0.1, 0.09, 0.0), (-0.55, 0.07, 0.0),
                  (-0.72, 0.11, 0.0)], T.CUPBW, n=6, cap_end=T.GLOWZ)
        box(bp, (0, -0.06, 0.1), (0.2, 0.16, 0.5), T.CUPZ, ch=0.02)
    return tp, bp


def main_turret(face):
    """Weapons-platform howitzer turret (face=-1 bakes -Z, +1 bakes +Z)."""
    s = face
    tp = Part('mt')
    chamfer_box(tp, (0, 0.5, s * 0.15), (2.6, 1.0, 3.0), 0.14,
                {'+y': T.TUR_TOP, '-y': T.TURZ, '+x': T.TURZ, '-x': T.TURZ,
                 '+z': T.TURZ, '-z': T.TURZ})
    box(tp, (0, 1.1, s * 0.7), (1.2, 0.35, 1.2), T.TURZ, ch=0.05)
    bp = Part('mb')
    tube(bp, [(s * 0.3, 0.30, 0.0), (s * -1.9, 0.24, 0.0),
              (s * -2.6, 0.28, 0.0)], T.BARRELW, n=8, cap_end=T.DARKT)
    box(bp, (0, 0.0, s * 0.15), (0.9, 0.7, 0.9), T.TURZ, ch=0.06)
    return tp, bp


def build_engine():
    p = Part('body')
    chassis(p, T.ENG_HL, T.ENG_TOP, T.E_SIDE, T.E_FRONT, T.E_TOP,
            T.ENG_AXLES)
    # armored prow: glacis wedge down to the plow
    quad_out(p, [(-2.1, T.ENG_TOP, -T.ENG_HL), (2.1, T.ENG_TOP, -T.ENG_HL),
                 (1.7, 2.4, -T.ENG_HL - 1.0), (-1.7, 2.4, -T.ENG_HL - 1.0)],
             (0, 0.5, -1), T.E_FRONT)
    quad_out(p, [(-1.7, 2.4, -T.ENG_HL - 1.0), (1.7, 2.4, -T.ENG_HL - 1.0),
                 (0.0, 0.28, T.PLOW_TIP), ], (0, 0.4, -1), T.E_FRONT)
    for s in (1, -1):                       # plow side wings
        quad_out(p, [(s * 1.7, 2.4, -T.ENG_HL - 1.0),
                     (s * 2.3, 2.1, -T.ENG_HL + 0.4),
                     (s * 2.3, 0.3, -T.ENG_HL + 0.4), (0, 0.28, T.PLOW_TIP)],
                 (s, 0.1, -0.5), T.E_FRONT)
    # cab with slit windows (painted) + sensors
    x, y, z, w, h, d = T.ENG_CAB
    hull_box(p, (x, y, z), (w, h, d), T.E_SIDE, T.E_FRONT, T.E_TOP, ch=0.15)
    box(p, (0.9, 5.9, -4.6), (0.5, 0.3, 0.5), T.TRIMT, ch=0.03)
    limb(p, (-1.2, 5.75, -4.4), (-1.2, 6.6, -4.4), 0.05, 0.02,
         T.TRIMT.rect, n=4)
    # exhaust stacks + engine deck louvres (painted) + spotlights
    for sz in T.ENG_STACKS:
        limb(p, (1.35, T.ENG_TOP, sz), (1.35, 5.6, sz), 0.28, 0.24,
             T.TRIMT.rect, n=6)
    for sx in (-1.5, 1.5):
        box(p, (sx, 3.4, -T.ENG_HL - 0.4), (0.5, 0.35, 0.3), T.GLOWZ,
            ch=0.02)
    pieces = [dict(name='body', parent=-1, offset=(0, 0, 0), part=p)]
    # forward railgun chain
    tp = Part('t')
    chamfer_box(tp, (0, 0.45, -0.1), (2.4, 0.9, 2.7), 0.12,
                {'+y': T.TUR_TOP, '-y': T.TURZ, '+x': T.TURZ, '-x': T.TURZ,
                 '+z': T.TURZ, '-z': T.TURZ})
    bp = Part('b')
    tube(bp, [(0.3, 0.22, 0.0), (-2.4, 0.17, 0.0), (-3.3, 0.20, 0.0)],
         T.BARRELW, n=8, cap_end=T.DARKT)
    box(bp, (0, 0, 0.1), (0.8, 0.6, 0.8), T.TURZ, ch=0.05)
    pieces += [
        dict(name='turret', parent=0, offset=T.ENG_TURRET, part=tp),
        dict(name='barrel', parent=1, offset=T.ENG_BARREL, part=bp),
        dict(name='muzzle', parent=2, offset=T.ENG_MUZZLE, part=None),
    ]
    # AA flak chain
    ft = Part('ft')
    box(ft, (0, 0.3, 0), (1.6, 0.6, 1.8), T.TURZ, ch=0.08)
    limb(ft, (0.55, 0.6, 0.4), (0.55, 1.15, 0.4), 0.22, 0.18, T.CUPBW, n=6)
    fb = Part('fb')
    for sx in (-0.28, 0.28):
        tube(fb, [(0.2, 0.09, 0.0), (-1.3, 0.07, 0.0)], T.CUPBW, n=6,
             xoff=sx, cap_end=T.DARKT)
    box(fb, (0, -0.02, 0.15), (0.9, 0.4, 0.7), T.TURZ, ch=0.05)
    pieces += [
        dict(name='turret2', parent=0, offset=T.ENG_FLAK, part=ft),
        dict(name='barrel2', parent=4, offset=T.ENG_FLAK_B, part=fb),
        dict(name='muzzle2', parent=5, offset=T.ENG_FLAK_M, part=None),
    ]
    for i, az in enumerate(T.ENG_AXLES):
        pieces.append(dict(name=f'axle{i + 1}', parent=0,
                           offset=(0, T.WHEEL_R, az),
                           part=wheelset(f'axle{i + 1}')))
    pieces.append(dict(name='link_f', parent=0,
                       offset=(0, T.LINK_Y, -T.ENG_HL - 0.7), part=None))
    pieces.append(dict(name='link_r', parent=0,
                       offset=(0, T.LINK_Y, T.ENG_HL + 0.7), part=None))
    pieces.append(dict(name='exhaust', parent=0, offset=(1.35, 5.7, 3.3),
                       part=None))
    return pieces


def car_base(top):
    p = Part('body')
    chassis(p, T.CAR_HL, top, T.C_SIDE, T.C_END, T.C_TOP, T.CAR_AXLES)
    return p


def car_axles_links(pieces):
    for i, az in enumerate(T.CAR_AXLES):
        pieces.append(dict(name=f'axle{i + 1}', parent=0,
                           offset=(0, T.WHEEL_R, az),
                           part=wheelset(f'axle{i + 1}')))
    pieces.append(dict(name='link_f', parent=0,
                       offset=(0, T.LINK_Y, -T.CAR_HL - 0.7), part=None))
    pieces.append(dict(name='link_r', parent=0,
                       offset=(0, T.LINK_Y, T.CAR_HL + 0.7), part=None))
    return pieces


def build_gun():
    p = car_base(T.GUN_TOP)
    # barbette rings
    for (bz, _) in T.GUN_TURRETS:
        box(p, (0, T.GUN_TOP + 0.2, bz), (2.9, 0.4, 3.2), T.TRIMT, ch=0.06)
    pieces = [dict(name='body', parent=-1, offset=(0, 0, 0), part=p)]
    names = [('turret', 'barrel', 'muzzle'), ('turret2', 'barrel2', 'muzzle2')]
    for i, ((bz, face), (tn, bn, mn)) in enumerate(zip(T.GUN_TURRETS, names)):
        tp, bp = main_turret(face)
        ti = len(pieces)
        pieces.append(dict(name=tn, parent=0, offset=(0, T.GUN_TOP + 0.45, bz),
                           part=tp))
        pieces.append(dict(name=bn, parent=ti,
                           offset=(0, T.GUN_BARREL[1],
                                   face * abs(T.GUN_BARREL[2])),
                           part=bp))
        pieces.append(dict(name=mn, parent=ti + 1,
                           offset=(0, 0, face * abs(T.GUN_MUZZLE[2])),
                           part=None))
    # MG cupola (turret3)
    tp, bp = small_cupola('mg')
    ti = len(pieces)
    pieces.append(dict(name='turret3', parent=0,
                       offset=(0, T.GUN_TOP + 0.65, 0.0), part=tp))
    pieces.append(dict(name='barrel3', parent=ti, offset=T.CUP_BAR, part=bp))
    pieces.append(dict(name='muzzle3', parent=ti + 1, offset=T.CUP_MUZ,
                       part=None))
    return car_axles_links(pieces)


def build_troop():
    p = car_base(T.TROOP_TOP)
    # roof hatches + vents + side door frames
    for hz in (-5.5, -1.5, 2.5, 6.0):
        box(p, (0.8, T.TROOP_TOP + 0.12, hz), (1.0, 0.24, 1.2), T.TRIMT,
            ch=0.03)
    for vz in (-3.5, 0.5, 4.5):
        box(p, (-1.1, T.TROOP_TOP + 0.15, vz), (0.6, 0.3, 0.6), T.TRIMT,
            ch=0.03)
    pieces = [dict(name='body', parent=-1, offset=(0, 0, 0), part=p)]
    for i, (cz, kind) in enumerate(T.TROOP_CUPS):
        tp, bp = small_cupola(kind)
        tn = 'turret' if i == 0 else 'turret2'
        bn = 'barrel' if i == 0 else 'barrel2'
        mn = 'muzzle' if i == 0 else 'muzzle2'
        ti = len(pieces)
        pieces.append(dict(name=tn, parent=0,
                           offset=(0, T.TROOP_TOP + 0.2, cz), part=tp))
        pieces.append(dict(name=bn, parent=ti, offset=T.CUP_BAR, part=bp))
        pieces.append(dict(name=mn, parent=ti + 1, offset=T.CUP_MUZ,
                           part=None))
    return car_axles_links(pieces)


def build_cargo():
    p = Part('body')
    chassis(p, T.CAR_HL, T.CARGO_BED, T.C_SIDE, T.C_END, T.C_TOP,
            T.CAR_AXLES, rails=False)
    # armored stake walls (open top)
    for s in (1, -1):
        box(p, (s * 2.0, (T.CARGO_BED + T.CARGO_WALL) / 2, 0),
            (0.2, T.CARGO_WALL - T.CARGO_BED, T.CAR_HL * 2 - 0.6), T.C_SIDE,
            ch=0.03)
    for s in (1, -1):
        box(p, (0, (T.CARGO_BED + T.CARGO_WALL) / 2, s * (T.CAR_HL - 0.35)),
            (4.0, T.CARGO_WALL - T.CARGO_BED, 0.2), T.C_END, ch=0.03)
    # lashed cargo: tarp lump, crates, drums
    box(p, (-0.2, T.CARGO_BED + 0.85, 2.6), (3.2, 1.7, 5.6), T.TARPZ,
        ch=0.35)
    for (cx, cz, cs) in ((-0.9, -2.2, 1.5), (0.9, -2.6, 1.3), (0.1, -4.2, 1.6)):
        box(p, (cx, T.CARGO_BED + cs / 2, cz), (cs, cs, cs), T.CRATEZ,
            ch=0.04)
    for dz in (-6.3, -5.5):
        limb(p, (1.3, T.CARGO_BED, dz), (1.3, T.CARGO_BED + 1.1, dz), 0.4,
             0.4, T.CUPBW, n=6)
    # MG cupola on a pulpit at the fore end
    box(p, (0, T.CARGO_BED + 1.0, -6.9), (1.6, 2.0, 1.6), T.C_SIDE, ch=0.06)
    pieces = [dict(name='body', parent=-1, offset=(0, 0, 0), part=p)]
    tp, bp = small_cupola('mg')
    pieces.append(dict(name='turret', parent=0, offset=(0, T.CARGO_BED + 2.1,
                       -6.9), part=tp))
    pieces.append(dict(name='barrel', parent=1, offset=T.CUP_BAR, part=bp))
    pieces.append(dict(name='muzzle', parent=2, offset=T.CUP_MUZ, part=None))
    return car_axles_links(pieces)


MODELS = {
    'fable_train_engine': build_engine,
    'fable_train_gun': build_gun,
    'fable_train_troop': build_troop,
    'fable_train_cargo': build_cargo,
}


def rewrite_uris(stem):
    for suffix in ('', '_png'):
        path = f'{OUT}/{stem}{suffix}.gltf'
        doc = json.load(open(path))
        for img in doc.get('images', []):
            for kind in ('diffuse', 'normals', 'orm', 'emissive', 'team'):
                if f'_{kind}.' in img['uri']:
                    ext = 'png' if suffix else 'ktx2'
                    img['uri'] = f'{TEX_STEM}_{kind}.{ext}'
                    break
        json.dump(doc, open(path, 'w'), separators=(',', ':'))


if __name__ == '__main__':
    for stem, fn in MODELS.items():
        pieces = fn()
        export(pieces, stem, texmode='ktx2', outdir=OUT, normal_map=True)
        export(pieces, stem, texmode='png', outdir=OUT, normal_map=True)
        rewrite_uris(stem)
        total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
        print(f'[gen_train] {stem}: {total} tris')
