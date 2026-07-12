"""gen_fighter — build fable_fighter (FA-6 Shrike).

s3 air-superiority fighter: chined hex-loft fuselage, faceted bubble
canopy, twin flank intakes with splitter plates, cranked wings with
buried roots (§23 rule), underwing + wingtip AA missiles, twin canted
fins, twin afterburner nozzles, fixed landing gear pieces.

Usage: python3 gen_fighter.py [png]
"""
from __future__ import annotations
import numpy as np

import fighter_layout as F         # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, loft, chamfer_box, tube, ngon_ring, limb
from gltf_export import export

STEM = 'fable_fighter'
OUT = 'out'


def quad_out(p, verts, outward, zone):
    """Add a polygon wound so its normal points along `outward`."""
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, outward) > 0 else verts[::-1], zone=zone)


def box(p, center, size, zone, ch=0.03, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def fus_ring(z, w, wt, yt, yb, yc):
    wb = w * 0.52
    return [(w, yc, z), (wt, yt, z), (-wt, yt, z), (-w, yc, z),
            (-wb, yb, z), (wb, yb, z)]


def fus_zone(c, n):
    if n[1] > 0.55:
        return F.F_TOP
    if n[1] < -0.55:
        return F.F_BOT
    return F.F_SIDE


def missile(p, x, y, z_nose, z_tail):
    """AA missile: tube body + 4 tail fins + seeker tip."""
    ln = z_tail - z_nose
    tube(p, [(z_tail, F.MSL_R * 0.9, y), (z_tail - 0.35, F.MSL_R, y),
             (z_nose + 0.55, F.MSL_R, y), (z_nose + 0.18, F.MSL_R * 0.55, y),
             (z_nose, F.MSL_R * 0.12, y)],
         F.F_MISSILE, n=8, xoff=x, cap_start=F.F_DARK, cap_end=F.F_DARK)
    for (dx, dy) in ((0.3, 0), (-0.3, 0), (0, 0.3), (0, -0.3)):
        fz0, fz1 = z_tail - 0.55, z_tail - 0.06
        quad = [(x, y, fz0), (x, y, fz1),
                (x + dx, y + dy, fz1), (x + dx, y + dy, fz0 + 0.28)]
        quad_out(p, quad, (-dy, dx, 0), F.F_TRIM)      # thin fin: both faces
        quad_out(p, list(quad), (dy, -dx, 0), F.F_TRIM)


def build_body_full():
    p = Part('body')
    rings = [fus_ring(*s) for s in F.FUS_SECTIONS]
    loft(p, rings, fus_zone, cap_start=F.F_TRIM, cap_end=F.F_TRIM)

    def arch(z, w, yb, yt):
        return [(w, yb, z), (w * 0.52, yt, z), (0.0, yt + 0.07, z),
                (-w * 0.52, yt, z), (-w, yb, z)]
    loft(p, [arch(*s) for s in F.CAN_SECTIONS],
         lambda c, n: F.F_CANOPY, cap_end=F.F_TRIM)

    for s in (1, -1):
        # intake duct + splitter
        irings = []
        for (z, xi, xo, yb, yt) in F.INTAKE_SECTIONS:
            r = [(s * xo, yb, z), (s * xo, yt, z), (s * xi, yt, z),
                 (s * xi, yb, z)]
            irings.append(r if s > 0 else r[::-1])
        loft(p, irings, fus_zone, cap_start=F.F_DARK)
        x, z0, z1, y0, y1 = F.SPLITTER
        pl = [(s * x, y0, z0), (s * x, y1, z0), (s * x, y1, z1), (s * x, y0, z1)]
        quad_out(p, pl, (s, 0, 0), F.F_TRIM)
        quad_out(p, list(pl), (-s, 0, 0), F.F_TRIM)

        # lifting surfaces (top/bottom sample the world-anchored zones)
        blade_flat(p, F.WING, s, 'y', F.F_TOP, F.F_BOT, F.F_TRIM)
        blade_flat(p, F.STAB, s, 'y', F.F_TOP, F.F_BOT, F.F_TRIM)
        blade_flat(p, F.FIN, s, 'x', F.F_FIN, F.F_FIN, F.F_TRIM)

        # underwing pylon + missile
        z0, z1, yt, yb = F.PYLON
        box(p, (s * F.PYLON_X, (yt + yb) / 2, (z0 + z1) / 2),
            (0.14, yt - yb, z1 - z0), F.F_TRIM, ch=0.02)
        missile(p, s * F.PYLON_X, F.MSL_PYLON[0], F.MSL_PYLON[1],
                F.MSL_PYLON[2])
        # wingtip rail + missile
        rx, ry, rz0, rz1 = F.TIP_RAIL
        box(p, (s * rx, ry, (rz0 + rz1) / 2), (0.16, 0.14, rz1 - rz0),
            F.F_TRIM, ch=0.02)
        missile(p, s * rx, F.MSL_TIP[0], F.MSL_TIP[1], F.MSL_TIP[2])
        # wingtip nav boxes (port +x red / starboard green cells)
        nx, ny, nz = F.NAV_L
        box(p, (s * nx, ny, nz), (0.16, 0.10, 0.34),
            F.F_NAVP if s > 0 else F.F_NAVS, ch=0.01)

        # nozzle (stations zmax→zmin so cap_start faces aft, +z out)
        tube(p, F.NOZZLE, F.F_NOZZLE, n=10, xoff=s * F.NOZZLE_X,
             cap_start=F.F_BURNER)

    # chin gun fairing + greebles
    box(p, (0.52, 1.22, -4.95), (0.30, 0.24, 1.1), F.F_TRIM, ch=0.04)
    limb(p, F.PITOT, (F.PITOT[0], F.PITOT[1] + 0.02, F.PITOT[2] - 0.55),
         0.025, 0.012, F.F_TRIM.rect, n=4)
    for (ax, ay, az) in F.ANTENNAS:
        quad_out(p, [(ax, ay, az), (ax, ay + 0.22, az + 0.10),
                     (ax, ay + 0.22, az + 0.28), (ax, ay, az + 0.34)],
                 (1, 0, 0), F.F_TRIM)
        quad_out(p, [(ax, ay, az), (ax, ay + 0.22, az + 0.10),
                     (ax, ay + 0.22, az + 0.28), (ax, ay, az + 0.34)],
                 (-1, 0, 0), F.F_TRIM)
    # chaff/flare dispenser
    box(p, (0.0, 0.92, 5.2), (0.7, 0.12, 0.5), F.F_TRIM, ch=0.02)
    return p


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


def wheel(p, c, r, hw):
    """Wheel: two n-gon rings along x, skinned, dark caps + hub."""
    cx, cy, cz = c
    ra = ngon_ring((cx - hw, cy, cz), r, n=8, axis='x')
    rb = ngon_ring((cx + hw, cy, cz), r, n=8, axis='x')
    for j in range(8):
        k = (j + 1) % 8
        quad = [ra[j], ra[k], rb[k], rb[j]]
        cq = np.mean(np.array(quad), axis=0)
        quad_out(p, quad, (0, cq[1] - cy, cq[2] - cz), F.F_DARK)
    quad_out(p, list(ra), (-1, 0, 0), F.F_GEAR)
    quad_out(p, list(rb), (1, 0, 0), F.F_GEAR)


def build_gear(name, attach, drop, r, hw, s=1):
    """Gear leg, piece-local (origin at the fuselage attach point)."""
    p = Part(name)
    limb(p, (0, 0, 0), (0, -drop, -0.06), 0.075, 0.06, F.F_GEAR.rect, n=6)
    limb(p, (0, -drop * 0.55, -0.04), (s * 0.10, -drop * 0.9, 0.16),
         0.035, 0.03, F.F_GEAR.rect, n=4)                 # drag brace
    wheel(p, (0, -drop, 0.02), r, hw)
    # gear door plate hanging beside the strut
    quad_out(p, [(s * 0.14, 0.02, -0.30), (s * 0.14, 0.02, 0.30),
                 (s * 0.14, -drop * 0.8, 0.30), (s * 0.14, -drop * 0.8, -0.30)],
             (s, 0, 0), F.F_TRIM)
    quad_out(p, [(s * 0.14, 0.02, -0.30), (s * 0.14, 0.02, 0.30),
                 (s * 0.14, -drop * 0.8, 0.30), (s * 0.14, -drop * 0.8, -0.30)],
             (-s, 0, 0), F.F_TRIM)
    return p


def build_all():
    (nx, ny, nz), ndrop, nr, nhw = F.GEAR_N
    (mx, my, mz), mdrop, mr, mhw = F.GEAR_M
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body_full()),
        dict(name='gear_n', parent=0, offset=(nx, ny, nz),
             part=build_gear('gear_n', (nx, ny, nz), ndrop, nr, nhw)),
        dict(name='gear_l', parent=0, offset=(mx, my, mz),
             part=build_gear('gear_l', (mx, my, mz), mdrop, mr, mhw, s=1)),
        dict(name='gear_r', parent=0, offset=(-mx, my, mz),
             part=build_gear('gear_r', (-mx, my, mz), mdrop, mr, mhw, s=-1)),
        dict(name='muzzle', parent=0, offset=F.GUN_MUZZLE, part=None),
        dict(name='muzzle2', parent=0, offset=F.MUZZLE2, part=None),
        dict(name='exhaust', parent=0, offset=F.EXHAUST_OFF, part=None),
    ]
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_fighter] total tris: {total}')
