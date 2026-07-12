"""gen_factory — build fable_factory (generic factory) + idle clip.

Sawtooth assembly hall, office block, twin stacks with ladder, silo
pair with transfer pipes, horizontal tank on saddles, rooftop crane
over the gate, rear extraction fan (spins) and a comms dish (rotates)
— the only animated pieces. Scale-relative to the shipped units.

Usage: python3 gen_factory.py [png]
"""
from __future__ import annotations
import numpy as np

import factory_layout as F         # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, chamfer_box, tube, ngon_ring, limb
from gltf_export import export

STEM = 'fable_factory'
OUT = 'out'


# ── helpers (forge patterns) ─────────────────────────────────────────────

def drum_y(p, cx, cz, ybase, ytop, r, wrap_rect, cap_zone=None, n=8):
    r0 = ngon_ring((cx, ybase, cz), r, n=n, axis='y')
    r1 = ngon_ring((cx, ytop, cz), r, n=n, axis='y')
    dx0, dy0, dx1, dy1 = wrap_rect
    for j in range(n):
        k = (j + 1) % n
        u0 = (dx0 + (dx1 - dx0) * j / n) / M.ATLAS
        u1 = (dx0 + (dx1 - dx0) * (j + 1) / n) / M.ATLAS
        quad = [r0[j], r0[k], r1[k], r1[j]]
        uvs = [(u0, dy1 / M.ATLAS), (u1, dy1 / M.ATLAS),
               (u1, dy0 / M.ATLAS), (u0, dy0 / M.ATLAS)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        rad = ctr - np.array([cx, ctr[1], cz])
        if np.dot(nrm, rad) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)
    if cap_zone is not None:
        zc = Zone(cap_zone.rect, ('x', 'z'), ((cx - r, cx + r), (cz - r, cz + r)))
        p.add_face(ngon_ring((cx, ytop, cz), r, n=n, axis='y'), zone=zc, flip=True)


def hose(p, pts, r, rect=None, collars=True, n=6):
    rect = rect or F.F_PIPE
    for i in range(len(pts) - 1):
        limb(p, pts[i], pts[i + 1], r, r, rect, n=n)
    if collars:
        for i in range(1, len(pts) - 1):
            a, b = np.asarray(pts[i - 1]), np.asarray(pts[i])
            d = b - a
            d = d / max(1e-9, np.linalg.norm(d))
            c0 = tuple(b - d * 0.12)
            c1 = tuple(b + d * 0.12)
            limb(p, c0, c1, r * 1.28, r * 1.28, rect, n=n)


def box(p, center, size, zone, ch=0.04, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def ladder(p, x, y0, y1, z, axis='z', zone=None):
    """Wall ladder: 2 rails + rungs every 0.44 m. axis = wall normal dir."""
    zone = zone or F.F_TRIM
    if axis == 'z':
        for rx in (x - 0.25, x + 0.25):
            box(p, (rx, (y0 + y1) / 2, z), (0.07, y1 - y0, 0.07), zone, ch=0.01)
        n = int((y1 - y0) / 0.44)
        for i in range(n):
            box(p, (x, y0 + 0.2 + i * 0.44, z), (0.56, 0.06, 0.06), zone, ch=0.01)
    else:
        for rz in (z - 0.25, z + 0.25):
            box(p, (x, (y0 + y1) / 2, rz), (0.07, y1 - y0, 0.07), zone, ch=0.01)
        n = int((y1 - y0) / 0.44)
        for i in range(n):
            box(p, (x, y0 + 0.2 + i * 0.44, z), (0.06, 0.06, 0.56), zone, ch=0.01)


def railing(p, start, end, zone=None, h=1.05):
    """Roof railing: posts every ~2.2 m + a top rail box."""
    zone = zone or F.F_RAIL
    a, b = np.asarray(start, float), np.asarray(end, float)
    L = np.linalg.norm(b - a)
    n = max(2, int(L / 2.2) + 1)
    for i in range(n):
        t = i / (n - 1)
        pt = a + (b - a) * t
        box(p, (pt[0], pt[1] + h / 2, pt[2]), (0.08, h, 0.08), zone, ch=0.01)
    mid = (a + b) / 2
    d = b - a
    size = (abs(d[0]) + 0.1 if abs(d[0]) > abs(d[2]) else 0.1, 0.09,
            abs(d[2]) + 0.1 if abs(d[2]) >= abs(d[0]) else 0.1)
    box(p, (mid[0], mid[1] + h, mid[2]), size, zone, ch=0.01)


# ── the building ─────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    # concrete pad
    x, y, z, w, h, d = F.PAD
    chamfer_box(p, (x, y, z), (w, h, d), 0.12,
                {'+y': F.F_PAD, '+x': F.F_PADS, '-x': F.F_PADS,
                 '+z': F.F_PADS_F, '-z': F.F_PADS_F}, skip=('-y',))
    # main hall
    x, y, z, w, h, d = F.HALL
    chamfer_box(p, (x, y, z), (w, h, d), 0.10,
                {'+x': F.F_SIDE, '-x': F.F_SIDE, '-z': F.F_FRONT,
                 '+z': F.F_REAR, '+y': F.F_ROOF_S}, skip=('-y',))
    # sawtooth roof: 4 teeth, glass faces toward the front (-z)
    hx0, hx1 = x - w / 2, x + w / 2
    for i in range(F.TEETH):
        zf = (z - d / 2) + i * F.TOOTH_D
        zb = zf + F.TOOTH_D
        gl = [(hx0, F.HALL_TOP, zf), (hx1, F.HALL_TOP, zf),
              (hx1, F.RIDGE, zf), (hx0, F.RIDGE, zf)]
        p.add_face(gl, zone=F.F_SKY, flip=True)          # faces -z
        p.add_face(gl, zone=F.F_SKY)                     # back side (closed)
        sl = [(hx0, F.RIDGE, zf), (hx1, F.RIDGE, zf),
              (hx1, F.HALL_TOP, zb), (hx0, F.HALL_TOP, zb)]
        p.add_face(sl, zone=F.F_ROOF_S)                  # slope up-face
        for (sx, flip) in ((hx0, True), (hx1, False)):
            tri = [(sx, F.HALL_TOP, zf), (sx, F.RIDGE, zf), (sx, F.HALL_TOP, zb)]
            p.add_face(tri, zone=F.F_SIDE, flip=flip)
    # gate frame
    x, y, z, w, h, d = F.DOOR_FRAME
    box(p, (x, y, z), (w, h, d), F.F_DOOR, ch=0.08)
    # office block + roof railing + mast
    x, y, z, w, h, d = F.OFFICE
    chamfer_box(p, (x, y, z), (w, h, d), 0.08,
                {'+x': F.F_OFFICE, '-x': F.F_OFFICE, '-z': F.F_OFFICE_F,
                 '+z': F.F_OFFICE_F, '+y': F.F_OFF_ROOF}, skip=('-y',))
    ox0, ox1 = x - w / 2 + 0.2, x + w / 2 - 0.2
    oz0, oz1 = z - d / 2 + 0.2, z + d / 2 - 0.2
    railing(p, (ox0, F.OFF_TOP, oz0), (ox1, F.OFF_TOP, oz0))
    railing(p, (ox0, F.OFF_TOP, oz1), (ox1, F.OFF_TOP, oz1))
    railing(p, (ox1, F.OFF_TOP, oz0), (ox1, F.OFF_TOP, oz1))
    mx, mz = F.MAST
    limb(p, (mx, F.OFF_TOP, mz), (mx, F.OFF_TOP + 2.35, mz), 0.09, 0.07,
         F.F_TRIM.rect, n=6)
    # stacks (pierce the hall roof) + collars + ladder on stack 1
    for k, (sx, sz, sr, stop) in enumerate(F.STACKS):
        drum_y(p, sx, sz, F.HALL_TOP - 0.5, stop, sr, F.F_STACK,
               cap_zone=F.F_STACK_TOP, n=8)
        drum_y(p, sx, sz, stop - 1.1, stop - 0.85, sr * 1.14, F.F_STACK, n=8)
        drum_y(p, sx, sz, F.HALL_TOP + 0.9, F.HALL_TOP + 1.15, sr * 1.14,
               F.F_STACK, n=8)
    ladder(p, F.STACKS[0][0], F.HALL_TOP + 0.4, F.STACKS[0][3] - 0.9,
           F.STACKS[0][1] - F.STACKS[0][2] - 0.12, axis='z')
    # roof vent boxes in the valleys
    box(p, (-6.0, F.HALL_TOP + 0.55, 3.4), (2.2, 1.1, 1.6), F.F_VENT)
    box(p, (2.5, F.HALL_TOP + 0.55, -1.2), (1.8, 1.1, 1.4), F.F_VENT)
    # front roof railing + roof access ladder on the left wall
    railing(p, (hx0 + 0.2, F.HALL_TOP, z - 0.5 - 8.9),
            (hx1 - 0.2, F.HALL_TOP, z - 0.5 - 8.9))
    ladder(p, hx0 - 0.12, F.PAD_TOP + 0.3, F.HALL_TOP + 0.3, 5.5, axis='x',
           zone=F.F_LADDER)
    # silos + transfer pipes into the hall
    for (sx, sz) in F.SILOS:
        drum_y(p, sx, sz, F.PAD_TOP - 0.1, F.SILO_TOP, F.SILO_R, F.F_TANK,
               cap_zone=F.F_TANK_TOP, n=10)
        drum_y(p, sx, sz, F.PAD_TOP + 5.6, F.PAD_TOP + 5.85, F.SILO_R * 1.1,
               F.F_TANK, n=10)
        box(p, (sx, F.SILO_TOP + 0.25, sz), (0.7, 0.5, 0.7), F.F_TRIM)
        hose(p, [(sx - 0.9, F.SILO_TOP - 0.4, sz),
                 (sx - 3.2, F.SILO_TOP - 1.6, sz),
                 (6.3, F.PAD_TOP + 6.4, sz)], 0.34)
    # catwalk between silos
    box(p, (12.2, F.PAD_TOP + 4.9, 4.8), (1.1, 0.14, 3.6), F.F_RAIL, ch=0.02)
    railing(p, (12.75, F.PAD_TOP + 5.0, 3.4), (12.75, F.PAD_TOP + 5.0, 6.4),
            h=0.9)
    # horizontal tank on saddles (left flank)
    tx, ty, tz, tr, tl = F.HTANK
    tube(p, [(tz - tl / 2, tr, ty), (tz + tl / 2, tr, ty)], F.F_HTANK, n=8,
         xoff=tx, cap_start=F.F_TANK_TOP, cap_end=F.F_TANK_TOP)
    for dz in (-1.9, 1.9):
        box(p, (tx, F.PAD_TOP + 0.6, tz + dz), (2.2, 1.2, 0.5), F.F_TRIM)
    hose(p, [(tx, ty + tr - 0.1, tz + 2.6), (tx + 1.2, ty + 1.2, tz + 4.2),
             (-10.2 + 0.2, ty + 0.6, tz + 5.4)], 0.22)
    # rear wall pipe runs with flanges
    for py in (3.4, 4.5):
        hose(p, [(-9.4, py, 10.45), (-4.2, py, 10.45), (1.2, py, 10.45),
                 (5.6, py, 10.45)], 0.42)
    # rear extraction fan housing (the fan disc is its own piece)
    fx, fy, fz = F.FAN_OFF
    r0 = ngon_ring((fx, fy, fz - 0.28), F.FAN_R + 0.22, n=10, axis='z')
    r1 = ngon_ring((fx, fy, fz + 0.30), F.FAN_R + 0.22, n=10, axis='z')
    fx0, fy0, fx1, fy1 = F.F_FANH
    for j in range(10):
        k = (j + 1) % 10
        u0 = (fx0 + (fx1 - fx0) * j / 10) / M.ATLAS
        u1 = (fx0 + (fx1 - fx0) * (j + 1) / 10) / M.ATLAS
        quad = [r0[j], r0[k], r1[k], r1[j]]
        uvs = [(u0, fy0 / M.ATLAS), (u1, fy0 / M.ATLAS),
               (u1, fy1 / M.ATLAS), (u0, fy1 / M.ATLAS)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        rad = ctr - np.array([fx, fy, ctr[2]])
        if np.dot(nrm, rad) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)
    # rooftop crane over the gate
    kz = 1.0 - 6.6
    box(p, (-2.0, F.HALL_TOP + 0.9, kz), (0.7, 1.8, 0.7), F.F_CRANE)
    box(p, (-2.0, 12.35, kz - 3.2), (0.55, 0.75, 7.2), F.F_CRANE, ch=0.06)
    limb(p, (-2.0, F.HALL_TOP + 1.7, kz), (-2.0, 12.6, kz - 5.8), 0.09, 0.08,
         F.F_TRIM.rect, n=6)
    box(p, (-2.0, 11.75, kz - 5.0), (0.8, 0.5, 0.9), F.F_HOOK)
    box(p, (-2.0, 10.4, kz - 5.0), (0.08, 2.3, 0.08), F.F_HOOK, ch=0.01)
    box(p, (-2.0, 9.15, kz - 5.0), (0.55, 0.55, 0.35), F.F_HOOK)
    # wall louvers + floodlights + conduit
    for lz in (-3.0, 2.2, 7.0):
        box(p, (6.25, F.PAD_TOP + 2.2, lz), (0.25, 1.5, 1.9), F.F_VENT)
    for (lx, lz, la) in ((-9.6, F.DOOR_Z + 0.15, 'f'), (4.2, F.DOOR_Z + 0.15, 'f'),
                         (-9.9, 10.1, 'r')):
        zoff = -0.45 if la == 'f' else 0.45
        box(p, (lx, 9.6, (F.DOOR_Z if la == 'f' else 10.2) + zoff / 3),
            (0.9, 0.7, 0.9), F.F_LIGHT)
    hose(p, [(-10.05, 2.3, -6.0), (-10.05, 2.3, 2.0), (-10.05, 2.3, 9.0)],
         0.12, n=6)
    # transformer yard (front-left corner of the pad)
    for (tx_, tz_) in ((-12.6, -8.6), (-12.6, -5.8)):
        box(p, (tx_, F.PAD_TOP + 1.0, tz_), (1.7, 2.0, 2.2), F.F_TRAFO)
        for fdz in (-0.75, -0.25, 0.25, 0.75):
            box(p, (tx_ + 0.95, F.PAD_TOP + 1.0, tz_ + fdz),
                (0.25, 1.7, 0.14), F.F_TRAFO, ch=0.015)
        for pdx in (-0.45, 0.1, 0.55):
            box(p, (tx_ + pdx, F.PAD_TOP + 2.25, tz_), (0.12, 0.5, 0.12),
                F.F_TRIM, ch=0.01)
    hose(p, [(-12.6, F.PAD_TOP + 2.6, -7.2), (-11.3, F.PAD_TOP + 3.4, -7.2),
             (-10.25, F.PAD_TOP + 3.2, -7.2)], 0.1, n=6)
    # crates + barrels + bollards near the gate
    for (cx, cz, cs) in ((3.6, -10.6, 1.5), (5.0, -10.2, 1.2), (4.3, -9.2, 1.3)):
        box(p, (cx, F.PAD_TOP + cs / 2, cz), (cs, cs, cs), F.F_CRATE, ch=0.05)
    for (bx, bz) in ((6.1, -9.6), (6.7, -10.4)):
        drum_y(p, bx, bz, F.PAD_TOP, F.PAD_TOP + 1.15, 0.48, F.F_TANK,
               cap_zone=F.F_TANK_TOP, n=8)
    for bdx in (-7.2, -4.4, 0.6, 3.4):
        box(p, (-2.0 + bdx, F.PAD_TOP + 0.55, -10.9), (0.35, 1.1, 0.35),
            F.F_TRIM, ch=0.03)
    return p


def build_dish():
    p = Part('dish')
    drum_y(p, 0, 0, -0.06, 0.10, 0.62, F.F_FANH, cap_zone=F.F_DISH, n=10)
    limb(p, (0, 0.05, 0), (0, 0.45, -0.55), 0.05, 0.04, F.F_TRIM.rect, n=4)
    return p


def build_fan():
    p = Part('fan')
    # thin 10-gon disc; blades painted on both faces
    ring_f = ngon_ring((0, 0, -0.04), F.FAN_R, n=10, axis='z')
    ring_b = ngon_ring((0, 0, 0.04), F.FAN_R, n=10, axis='z')
    p.add_face(list(ring_f), zone=F.F_FAN, flip=True)
    p.add_face(list(ring_b), zone=F.F_FAN)
    hub = ngon_ring((0, 0, -0.10), 0.22, n=8, axis='z')
    p.add_face(list(hub), zone=F.F_DARK, flip=True)
    return p


# ── clips ────────────────────────────────────────────────────────────────

def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def qz(deg):
    r = np.radians(deg) / 2
    return (0.0, 0.0, float(np.sin(r)), float(np.cos(r)))


def build_clips():
    T = 12.0
    dish_keys = [(T * i / 4, qy(90.0 * i)) for i in range(5)]
    fan_keys = [(T * i / 16, qz(90.0 * i)) for i in range(17)]
    idle = {
        'name': 'idle',
        'channels': [
            ('dish', 'rotation', dish_keys),
            ('fan', 'rotation', fan_keys),
        ],
    }
    return [idle]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='dish', parent=0, offset=F.DISH_OFF, part=build_dish()),
        dict(name='fan', parent=0, offset=F.FAN_OFF, part=build_fan()),
        dict(name='exhaust', parent=0, offset=F.EXHAUST_OFF, part=None),
    ]
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_factory] total tris: {total}')
