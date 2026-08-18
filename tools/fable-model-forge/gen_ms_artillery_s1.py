"""gen_ms_artillery_s1 — assemble ms_artillery_s1 and export .gltf/.bin.

Light wheeled mortar carrier (artillery s1, 4.5 m, budget 2000, aim ~1200):
half-cab flatbed truck, spinnable axle_f/axle_r, and on the rear bed a
heavy mortar on a ring turntable — `turret` (turntable + baseplate +
bipod) -> `barrel` (stubby tube at 65 deg resting elevation, pivot at the
trunnion) -> `muzzle` (empty at the tube mouth).

Run: $PY gen_ms_artillery_s1.py  → out/ms_artillery_s1{,_png}.gltf + .bin
"""
from __future__ import annotations
import numpy as np

import ms_artillery_s1_layout as F     # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, Zone, loft, chamfer_box, ngon_ring, limb
from gltf_export import export

STEM = 'ms_artillery_s1'
OUT = 'out'

RNG = np.random.default_rng(90210)     # forge determinism seed

ELEV = np.radians(F.ELEV_DEG)
DIR = np.array([0.0, np.sin(ELEV), -np.cos(ELEV)])   # tube axis, up-forward


# ── helpers ──────────────────────────────────────────────────────────────

def quad_out(p, verts, outward, zone):
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, np.asarray(outward, dtype=float)) > 0
               else verts[::-1], zone=zone)


def ring_from_section(sec):
    z, yb, yw, ys, yd, wb, ww, wd, wt = sec
    return [
        (wb, yb, z), (ww, yw, z), (wd, ys, z), (wt, yd, z),
        (-wt, yd, z), (-wd, ys, z), (-ww, yw, z), (-wb, yb, z),
    ]


def body_zone(c, n):
    if n[1] < -0.5:
        return F.S_DARK
    if n[2] < -0.30 and c[1] > 1.12:
        return F.S_WINDS                 # windscreen slope
    if abs(n[0]) > 0.62:
        return F.S_SIDE
    if n[2] < -0.55:
        return F.S_FRONT
    if n[2] > 0.55:
        return F.S_REAR
    return F.S_TOP


def wheel(p, center, r, hw):
    """8-gon tyre around X with parametric tread UVs + hub caps."""
    c = np.asarray(center, dtype=float)
    ax = np.array([1.0, 0.0, 0.0])
    ra = ngon_ring(tuple(c - ax * hw), r, n=F.WHEEL_N, axis='x')
    rb = ngon_ring(tuple(c + ax * hw), r, n=F.WHEEL_N, axis='x')
    x0, y0, x1, y1 = F.S_WHEEL
    nseg = F.WHEEL_N
    for j in range(nseg):
        k = (j + 1) % nseg
        u0 = (x0 + (x1 - x0) * j / nseg) / M.ATLAS
        u1 = (x0 + (x1 - x0) * (j + 1) / nseg) / M.ATLAS
        va, vb = y0 / M.ATLAS, y1 / M.ATLAS
        quad = [ra[j], ra[k], rb[k], rb[j]]
        uvs = [(u0, va), (u1, va), (u1, vb), (u0, vb)]
        ctr = np.mean(np.array(quad), axis=0)
        rad = ctr - (c + ax * np.dot(ctr - c, ax))
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        if np.dot(nrm, rad) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)
    za = Zone(F.S_HUB.rect, ('z', 'y'),
              ((c[2] - r, c[2] + r), (c[1] + r, c[1] - r)))
    quad_out(p, list(ra), (-1, 0, 0), za)
    quad_out(p, list(rb), (1, 0, 0), za)


def ring_cylinder(p, y0, y1, r, n, side_rect, cap_zone):
    """Vertical n-gon drum with parametric side UVs + top cap."""
    ra = ngon_ring((0, y0, 0), r, n=n, axis='y')
    rb = ngon_ring((0, y1, 0), r, n=n, axis='y')
    rx0, ry0, rx1, ry1 = side_rect
    for j in range(n):
        k = (j + 1) % n
        u0 = (rx0 + (rx1 - rx0) * j / n) / M.ATLAS
        u1 = (rx0 + (rx1 - rx0) * (j + 1) / n) / M.ATLAS
        va, vb = ry0 / M.ATLAS, ry1 / M.ATLAS
        quad = [ra[j], ra[k], rb[k], rb[j]]
        uvs = [(u0, va), (u1, va), (u1, vb), (u0, vb)]
        ctr = np.mean(np.array(quad), axis=0)
        rad = np.array([ctr[0], 0.0, ctr[2]])
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        if np.dot(nrm, rad) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)
    p.add_face(list(rb), zone=cap_zone)


# ── pieces ───────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    rings = [ring_from_section(s) for s in F.BODY_SECTIONS]
    loft(p, rings, body_zone, cap_start=F.S_FRONT, cap_end=F.S_REAR)

    # bed rail lip (side rails + tailgate)
    for sx in (F.RAIL_X, -F.RAIL_X):
        chamfer_box(p, (sx, F.RAIL_Y, F.RAIL_Z), F.RAIL_BOX, 0.02,
                    {'+y': F.S_FIT, '+x': F.S_SIDE, '-x': F.S_SIDE,
                     '+z': F.S_FIT, '-z': F.S_FIT}, skip=('-y',))
    chamfer_box(p, (0, F.RAIL_Y, F.GATE_Z), F.GATE_BOX, 0.02,
                {'+y': F.S_FIT, '+x': F.S_FIT, '-x': F.S_FIT,
                 '+z': F.S_REAR, '-z': F.S_FIT}, skip=('-y',))

    # ammo crates on the bed
    for (cx, cz, cs) in F.CRATES:
        chamfer_box(p, (cx, F.DECK_Y + cs / 2, cz), (cs, cs, cs), cs * 0.05,
                    {k: F.S_CRATE for k in ('+x', '-x', '+y', '+z', '-z')},
                    skip=('-y',))

    # tarp-lashed stowage roll at the bed rear
    tx, ty, tz = F.TARP_CTR
    tw, th, td = F.TARP_SIZE
    chamfer_box(p, (tx, ty + th / 2, tz), (tw, th, td), 0.06,
                {k: F.S_TARP for k in ('+x', '-x', '+y', '+z', '-z')},
                skip=('-y',))

    # exhaust stack behind the cab (left side), with bracket
    ex, ey, ez = F.EXH_BASE
    limb(p, (ex, ey, ez), (ex, F.EXH_TOP_Y, ez), F.EXH_R, F.EXH_R * 0.9,
         F.S_TRIM, n=4, cap_end=F.S_DARK)
    limb(p, (ex + 0.14, ey + 0.30, ez), (ex, ey + 0.34, ez), 0.03, 0.03,
         F.S_TRIM, n=3)

    # front brush bar
    for s in (1, -1):
        limb(p, (s * 0.52, 0.40, -2.30), (s * 0.52, 0.92, -2.36), 0.04, 0.04,
             F.S_TRIM, n=4)
    for by, bz in ((0.52, -2.34), (0.86, -2.36)):
        limb(p, (-0.52, by, bz), (0.52, by, bz), 0.04, 0.04, F.S_TRIM, n=4)

    # whip aerial off the cab rear corner
    limb(p, (0.52, 1.42, -0.40), (0.52, 2.35, -0.44), 0.020, 0.008,
         F.S_TRIM, n=3, cap_end=F.S_DARK)
    return p


def build_axle(name):
    p = Part(name)
    for sx in (F.TRACK_X, -F.TRACK_X):
        wheel(p, (sx, 0.0, 0.0), F.WHEEL_R, F.WHEEL_HW)
    chamfer_box(p, (0, 0, 0), F.AXLE_BAR, 0.02,
                {k: F.S_DARK for k in ('+x', '-x', '+y', '-y', '+z', '-z')})
    return p


def build_turret():
    p = Part('turret')
    # ring turntable
    ring_cylinder(p, 0.0, F.RING_H, F.RING_R, 8, F.S_RING_W, F.S_RING_T)
    # octagonal baseplate socketed on the ring
    ra = ngon_ring((0, F.RING_H, 0.02), F.PLATE_R, n=8, axis='y')
    rb = ngon_ring((0, F.RING_H + F.PLATE_H, 0.02), F.PLATE_R * 0.92,
                   n=8, axis='y')
    for j in range(8):
        k = (j + 1) % 8
        quad_out(p, [ra[j], ra[k], rb[k], rb[j]],
                 (ra[j][0] + ra[k][0], 0.2, ra[j][2] + ra[k][2]), F.S_PLATE)
    p.add_face(list(rb), zone=F.S_PLATE)
    # pedestal block carrying the traverse gear
    chamfer_box(p, (0, 0.30, 0.06), F.PED_BOX, 0.03,
                {k: F.S_MOUNT for k in ('+x', '-x', '+y', '+z', '-z')},
                skip=('-y',))
    # bipod legs up to the trunnion + cross beam
    bx, by, bz = F.BIPOD_FOOT
    tx, ty, tz = F.TRUNNION
    for s in (1, -1):
        limb(p, (s * bx, by, bz), (s * 0.13, ty - 0.02, tz), 0.045, 0.04,
             F.S_TRIM, n=4)
    limb(p, (-0.15, ty, tz), (0.15, ty, tz), 0.055, 0.055, F.S_TRIM, n=4,
         cap_start=F.S_DARK, cap_end=F.S_DARK)
    return p


def build_barrel():
    p = Part('barrel')
    d = DIR
    # breech housing riding the pivot
    chamfer_box(p, tuple(d * -0.16), F.BREECH_BOX, 0.03,
                {k: F.S_BREECH for k in ('+x', '-x', '+y', '-y', '+z', '-z')})
    # tube: breech -> muzzle, slight taper
    limb(p, tuple(d * -F.TUBE_BACK), tuple(d * F.TUBE_FWD),
         F.TUBE_R0, F.TUBE_R1, F.S_TUBE, n=6, cap_start=F.S_DARK)
    # muzzle collar + open bore cap
    limb(p, tuple(d * (F.TUBE_FWD - 0.14)), tuple(d * F.TUBE_FWD),
         F.MUZZ_RING, F.MUZZ_RING, F.S_TUBE, n=6, cap_end=F.S_DARK)
    return p


def build_all():
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='axle_f', parent=0, offset=(0, F.AXLE_Y, F.AXLE_F_Z),
             part=build_axle('axle_f')),
        dict(name='axle_r', parent=0, offset=(0, F.AXLE_Y, F.AXLE_R_Z),
             part=build_axle('axle_r')),
        dict(name='turret', parent=0, offset=F.TUR_OFF, part=build_turret()),
    ]
    pieces.append(dict(name='barrel', parent=3, offset=F.TRUNNION,
                       part=build_barrel()))
    pieces.append(dict(name='muzzle', parent=4,
                       offset=tuple(DIR * F.TUBE_FWD), part=Part('muzzle')))
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
