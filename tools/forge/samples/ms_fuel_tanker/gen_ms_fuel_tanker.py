"""gen_ms_fuel_tanker — armoured fuel tanker truck (ms_fuel_tanker).

7.5 m wheeled hauler: armoured cab, cylindrical fuel tank on saddles
(8-gon tube, parametric wrap UVs so painted hazard bands land as rings),
spine walkway with filler manhole domes, rear valve cabinet with a
spinnable hose reel, three spinnable axles (civkit convention: separate
axle pieces a unit script can Spin; hose_reel spins about +X).
Unarmed — no turret/barrel/muzzle chain.  Deterministic (no RNG).

Usage: python3 gen_ms_fuel_tanker.py
"""
from __future__ import annotations
import numpy as np

import ms_fuel_tanker_layout as T
from meshlib import Part, chamfer_box, ngon_ring, tube, limb
from gltf_export import export

OUT = 'out'
STEM = 'ms_fuel_tanker'


def quad_out(p, verts, outward, zone):
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, outward) > 0 else verts[::-1], zone=zone)


def box(p, center, size, zone, ch=0.04, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def wheel_pair(p):
    """Axle piece geometry: two 8-gon wheels + connecting axle bar."""
    for sx in (-T.WHEEL_X, T.WHEEL_X):
        ra = ngon_ring((sx - T.WHEEL_HW, 0, 0), T.WHEEL_R, n=8, axis='x')
        rb = ngon_ring((sx + T.WHEEL_HW, 0, 0), T.WHEEL_R, n=8, axis='x')
        for j in range(8):
            k = (j + 1) % 8
            quad = [ra[j], ra[k], rb[k], rb[j]]
            cq = np.mean(np.array(quad), axis=0)
            quad_out(p, quad, (0, cq[1], cq[2]), T.WHEELZ)
        quad_out(p, list(ra), (-1, 0, 0), T.HUBZ)
        quad_out(p, list(rb), (1, 0, 0), T.HUBZ)
    box(p, (0, 0, 0), (1.9, 0.22, 0.22), T.DARKZ, ch=0.02)


def hose_reel():
    """Reel piece: two 8-gon flanges + hose drum + hose-end lump.
    Piece-local frame centred on the spin axis (+X)."""
    p = Part('hose_reel')
    for sx in (-T.REEL_FL_X, T.REEL_FL_X):
        ra = ngon_ring((sx - T.REEL_FL_HW, 0, 0), T.REEL_FL_R, n=8, axis='x')
        rb = ngon_ring((sx + T.REEL_FL_HW, 0, 0), T.REEL_FL_R, n=8, axis='x')
        for j in range(8):
            k = (j + 1) % 8
            quad = [ra[j], ra[k], rb[k], rb[j]]
            cq = np.mean(np.array(quad), axis=0)
            quad_out(p, quad, (0, cq[1], cq[2]), T.REELZ)
        quad_out(p, list(ra), (-1, 0, 0), T.REELZ)
        quad_out(p, list(rb), (1, 0, 0), T.REELZ)
    ra = ngon_ring((-T.REEL_DR_X, 0, 0), T.REEL_DR_R, n=8, axis='x')
    rb = ngon_ring((T.REEL_DR_X, 0, 0), T.REEL_DR_R, n=8, axis='x')
    for j in range(8):
        k = (j + 1) % 8
        quad = [ra[j], ra[k], rb[k], rb[j]]
        cq = np.mean(np.array(quad), axis=0)
        quad_out(p, quad, (0, cq[1], cq[2]), T.REEL_DRUM)
    # coiled hose-end lump riding the drum (stays inside the flange sweep)
    box(p, (0, 0, -0.27), (0.22, 0.20, 0.26), T.REEL_DRUM, ch=0.03)
    return p


def build():
    p = Part('body')
    # armoured cab
    x, y, z, w, h, d = T.CAB
    chamfer_box(p, (x, y, z), (w, h, d), 0.14,
                {'+y': T.CAB_ROOF, '-y': T.DARKZ, '+x': T.CAB_SIDE,
                 '-x': T.CAB_SIDE, '-z': T.CAB_FRONT, '+z': T.CAB_FRONT})
    box(p, T.CHASSIS[:3], T.CHASSIS[3:], T.DARKZ, ch=0.03)
    box(p, T.BUMPER_F[:3], T.BUMPER_F[3:], T.TRIMZ, ch=0.04)
    # rear valve cabinet (painted valve wheels / placard on its -z face
    # would face the tank — detail zone goes on +z, the visible rear)
    x, y, z, w, h, d = T.VALVE_BOX
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+y': T.TRIMZ, '-y': T.DARKZ, '+x': T.TRIMZ,
                 '-x': T.TRIMZ, '+z': T.VALVEZ, '-z': T.TRIMZ})
    box(p, T.PEDESTAL[:3], T.PEDESTAL[3:], T.TRIMZ, ch=0.03)
    for sz in T.SADDLE_Z:
        box(p, (0, T.SADDLE_Y, sz), T.SADDLE, T.DARKZ, ch=0.04)
    for (fz, fl) in T.FENDERS:
        for s in (1, -1):
            box(p, (s * T.WHEEL_X, T.FENDER_Y, fz), (0.5, 0.14, fl),
                T.SKIRT, ch=0.03)
    # the tank itself: 8-gon shell, tapered end rings, capped
    tube(p, T.TANK_STATIONS, T.TANKW, n=8,
         cap_start=T.TANK_CAP, cap_end=T.TANK_CAP)
    box(p, T.WALKWAY[:3], T.WALKWAY[3:], T.TRIMZ, ch=0.02)
    for hz in T.HATCH_Z:                       # filler manhole domes
        limb(p, (0, 2.90, hz), (0, 3.08, hz), 0.26, 0.26, T.TRIMZ.rect,
             n=6, cap_end=T.TRIMZ)
    ex, ez = T.EXHAUST
    limb(p, (ex, 2.5, ez), (ex, 3.1, ez), 0.12, 0.10, T.DARKZ.rect,
         n=6, cap_end=T.DARKZ)

    pieces = [dict(name='body', parent=-1, offset=(0, 0, 0), part=p)]
    pieces.append(dict(name='hose_reel', parent=0, offset=T.REEL_OFF,
                       part=hose_reel()))
    for (nm, az) in T.AXLES:
        ax = Part(nm)
        wheel_pair(ax)
        pieces.append(dict(name=nm, parent=0, offset=(0, T.WHEEL_R, az),
                           part=ax))
    pieces.append(dict(name='nozzle', parent=0, offset=T.NOZZLE_OFF,
                       part=None))
    return pieces


if __name__ == '__main__':
    pieces = build()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_fuel_tanker] {STEM}: {total} tris')
