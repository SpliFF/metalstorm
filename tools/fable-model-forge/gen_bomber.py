"""gen_bomber — build fable_bomber (FB-9 Petrel).

s2 compact carrier bomber: blended flattened fuselage, wide canopy,
twin dorsal intakes, cranked delta wings with buried roots, two chunky
finned bombs on pylons, closed belly bay, twin canted fins, over-tail
nozzles, fixed (hideable) landing gear pieces.

Usage: python3 gen_bomber.py [png]
"""
from __future__ import annotations
import numpy as np

import bomber_layout as B          # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, loft, chamfer_box, tube, ngon_ring, limb
from gltf_export import export

STEM = 'fable_bomber'
OUT = 'out'


def quad_out(p, verts, outward, zone):
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, outward) > 0 else verts[::-1], zone=zone)


def box(p, center, size, zone, ch=0.03, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def fus_ring(z, w, wt, yt, yb, yc):
    wb = w * 0.60
    return [(w, yc, z), (wt, yt, z), (-wt, yt, z), (-w, yc, z),
            (-wb, yb, z), (wb, yb, z)]


def fus_zone(c, n):
    if n[1] > 0.55:
        return B.B_TOP
    if n[1] < -0.55:
        return B.B_BOT
    return B.B_SIDE


def blade_flat(p, stations, s, taxis, top_zone, bot_zone, edge_zone):
    def sec(st):
        x, y, zle, zte, th = st
        if taxis == 'y':
            return [(s * x, y + th / 2, zle), (s * x, y + th / 2, zte),
                    (s * x, y - th / 2, zte), (s * x, y - th / 2, zle)]
        return [(s * (x + th / 2), y, zle), (s * (x + th / 2), y, zte),
                (s * (x - th / 2), y, zte), (s * (x - th / 2), y, zle)]

    up = (0, 1, 0) if taxis == 'y' else (s, 0, 0)
    dn = tuple(-c for c in up)
    rings = [sec(st) for st in stations]
    for i in range(len(rings) - 1):
        r0, r1 = rings[i], rings[i + 1]
        quad_out(p, [r0[0], r0[1], r1[1], r1[0]], up, top_zone)
        quad_out(p, [r0[3], r0[2], r1[2], r1[3]], dn, bot_zone)
        quad_out(p, [r0[0], r0[3], r1[3], r1[0]], (0, 0, -1), edge_zone)
        quad_out(p, [r0[1], r0[2], r1[2], r1[1]], (0, 0, 1), edge_zone)
    dx = stations[-1][0] - stations[0][0]
    dy = stations[-1][1] - stations[0][1]
    quad_out(p, rings[-1], (s * np.sign(dx + 1e-9), np.sign(dy) * 0.4, 0),
             edge_zone)


def bomb(p, x, y, z_nose, z_tail):
    tube(p, [(z_tail, B.BOMB_R * 0.55, y), (z_tail - 0.45, B.BOMB_R, y),
             (z_nose + 0.75, B.BOMB_R, y), (z_nose + 0.25, B.BOMB_R * 0.6, y),
             (z_nose, B.BOMB_R * 0.12, y)],
         B.B_BOMB, n=8, xoff=x, cap_start=B.B_DARK, cap_end=B.B_DARK)
    for (dx, dy) in ((0.38, 0), (-0.38, 0), (0, 0.38), (0, -0.38)):
        fz0, fz1 = z_tail - 0.62, z_tail - 0.05
        quad = [(x, y, fz0), (x, y, fz1),
                (x + dx, y + dy, fz1), (x + dx, y + dy, fz0 + 0.32)]
        quad_out(p, quad, (-dy, dx, 0), B.B_TRIM)
        quad_out(p, list(quad), (dy, -dx, 0), B.B_TRIM)


def build_body():
    p = Part('body')
    rings = [fus_ring(*s) for s in B.FUS_SECTIONS]
    loft(p, rings, fus_zone, cap_start=B.B_TRIM, cap_end=B.B_TRIM)

    def arch(z, w, yb, yt):
        return [(w, yb, z), (w * 0.55, yt, z), (0.0, yt + 0.06, z),
                (-w * 0.55, yt, z), (-w, yb, z)]
    loft(p, [arch(*s) for s in B.CAN_SECTIONS],
         lambda c, n: B.B_CANOPY, cap_end=B.B_TRIM)

    for s in (1, -1):
        # dorsal intake humps
        irings = []
        for (z, xi, xo, yb, yt) in B.INTAKE_SECTIONS:
            r = [(s * xo, yb, z), (s * xo, yt, z), (s * xi, yt, z),
                 (s * xi, yb, z)]
            irings.append(r if s > 0 else r[::-1])
        loft(p, irings, fus_zone, cap_start=B.B_DARK)

        # wings + canted fins
        blade_flat(p, B.WING, s, 'y', B.B_TOP, B.B_BOT, B.B_TRIM)
        blade_flat(p, B.FIN, s, 'x', B.B_FIN, B.B_FIN, B.B_TRIM)

        # pylon + bomb
        z0, z1, yt, yb = B.PYLON
        box(p, (s * B.PYLON_X, (yt + yb) / 2, (z0 + z1) / 2),
            (0.14, yt - yb, z1 - z0), B.B_TRIM, ch=0.02)
        bomb(p, s * B.PYLON_X, B.BOMB[0], B.BOMB[1], B.BOMB[2])

        # wingtip nav boxes
        nx, ny, nz = B.NAV_L
        box(p, (s * nx, ny, nz), (0.16, 0.10, 0.34),
            B.B_NAVP if s > 0 else B.B_NAVS, ch=0.01)

        # over-tail nozzle (stations zmax→zmin; aft cap glows)
        tube(p, B.NOZZLE, B.B_NOZZLE, n=10, xoff=s * B.NOZZLE_X,
             cap_start=B.B_BURNER)

    # closed belly bomb bay (painted doors) + chin sensor ball
    bx, by, bz, bw, bh, bd = B.BAY
    box(p, (bx, by, bz), (bw, bh, bd), B.B_BOT, ch=0.05, skip=('+y',))
    sx, sy, sz = B.SENSOR
    limb(p, (sx, sy + 0.15, sz), (sx, sy - 0.28, sz), 0.20, 0.14,
         B.B_TRIM.rect, n=6)
    for (ax, ay, az) in B.ANTENNAS:
        quad = [(ax, ay, az), (ax, ay + 0.20, az + 0.09),
                (ax, ay + 0.20, az + 0.25), (ax, ay, az + 0.31)]
        quad_out(p, quad, (1, 0, 0), B.B_TRIM)
        quad_out(p, list(quad), (-1, 0, 0), B.B_TRIM)
    box(p, (0.0, 0.88, 4.4), (0.7, 0.12, 0.5), B.B_TRIM, ch=0.02)  # chaff
    return p


def wheel(p, c, r, hw):
    cx, cy, cz = c
    ra = ngon_ring((cx - hw, cy, cz), r, n=8, axis='x')
    rb = ngon_ring((cx + hw, cy, cz), r, n=8, axis='x')
    for j in range(8):
        k = (j + 1) % 8
        quad = [ra[j], ra[k], rb[k], rb[j]]
        cq = np.mean(np.array(quad), axis=0)
        quad_out(p, quad, (0, cq[1] - cy, cq[2] - cz), B.B_DARK)
    quad_out(p, list(ra), (-1, 0, 0), B.B_GEAR)
    quad_out(p, list(rb), (1, 0, 0), B.B_GEAR)


def build_gear(name, attach, drop, r, hw, s=1):
    p = Part(name)
    limb(p, (0, 0, 0), (0, -drop, -0.06), 0.075, 0.06, B.B_GEAR.rect, n=6)
    limb(p, (0, -drop * 0.55, -0.04), (s * 0.10, -drop * 0.9, 0.16),
         0.035, 0.03, B.B_GEAR.rect, n=4)
    wheel(p, (0, -drop, 0.02), r, hw)
    quad = [(s * 0.14, 0.02, -0.30), (s * 0.14, 0.02, 0.30),
            (s * 0.14, -drop * 0.8, 0.30), (s * 0.14, -drop * 0.8, -0.30)]
    quad_out(p, quad, (s, 0, 0), B.B_TRIM)
    quad_out(p, list(quad), (-s, 0, 0), B.B_TRIM)
    return p


def build_all():
    (nx, ny, nz), ndrop, nr, nhw = B.GEAR_N
    (mx, my, mz), mdrop, mr, mhw = B.GEAR_M
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='gear_n', parent=0, offset=(nx, ny, nz),
             part=build_gear('gear_n', (nx, ny, nz), ndrop, nr, nhw)),
        dict(name='gear_l', parent=0, offset=(mx, my, mz),
             part=build_gear('gear_l', (mx, my, mz), mdrop, mr, mhw, s=1)),
        dict(name='gear_r', parent=0, offset=(-mx, my, mz),
             part=build_gear('gear_r', (-mx, my, mz), mdrop, mr, mhw, s=-1)),
        dict(name='muzzle', parent=0, offset=B.MUZZLE_OFF, part=None),
        dict(name='exhaust', parent=0, offset=B.EXHAUST_OFF, part=None),
    ]
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_bomber] total tris: {total}')
