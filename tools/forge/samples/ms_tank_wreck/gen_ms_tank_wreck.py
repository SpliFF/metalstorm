"""gen_ms_tank_wreck — assemble ms_tank_wreck and export .gltf/.bin.

Burned-out fable_tank wreck, ONE static piece ('body').  Sub-assemblies
(hull, tracks, turret, bent barrel) are built in the tank's local frames
so the fable_tank atlas windows project correctly, then baked into the
body part with a rigid transform (merge()): turret dismounted/half-slid
off the left hull side, right track thrown flat beside the hull, barrel
kinked down+sideways past BEND_Z.  No clips.
Run: build.sh . ms_tank_wreck 1500 body --no-team
"""
import numpy as np

import ms_tank_wreck_layout as F       # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, Zone, chamfer_box, ngon_ring, loft, limb
from gltf_export import export

STEM = 'ms_tank_wreck'
OUT = 'out'


# ── rigid transform: bake a local-frame part into the body ──────────────

def _rot(yaw=0.0, pitch=0.0, roll=0.0):
    """R = Ry(yaw) @ Rx(pitch) @ Rz(roll), degrees."""
    a, b, c = np.radians([yaw, pitch, roll])
    Ry = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0],
                   [-np.sin(a), 0, np.cos(a)]])
    Rx = np.array([[1, 0, 0], [0, np.cos(b), -np.sin(b)],
                   [0, np.sin(b), np.cos(b)]])
    Rz = np.array([[np.cos(c), -np.sin(c), 0],
                   [np.sin(c), np.cos(c), 0], [0, 0, 1]])
    return Ry @ Rx @ Rz


def merge(dst, src, off=(0, 0, 0), yaw=0.0, pitch=0.0, roll=0.0):
    R = _rot(yaw, pitch, roll)
    o = np.asarray(off, dtype=float)
    base = len(dst.pos)
    for v in src.pos:
        dst.pos.append(tuple(R @ np.asarray(v, dtype=float) + o))
    for n in src.nrm:
        dst.nrm.append(tuple(R @ np.asarray(n, dtype=float)))
    dst.uv.extend(src.uv)
    dst.idx.extend(i + base for i in src.idx)


# ── shared helpers ──────────────────────────────────────────────────────

def _uv(px, py):
    return (px / M.ATLAS, py / M.ATLAS)


_FACES = {
    '+y': ([(-1, 1, -1), (-1, 1, 1), (1, 1, 1), (1, 1, -1)],
           [(0, 0), (0, 1), (1, 1), (1, 0)]),
    '-y': ([(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)],
           [(0, 0), (1, 0), (1, 1), (0, 1)]),
    '+x': ([(1, -1, -1), (1, 1, -1), (1, 1, 1), (1, -1, 1)],
           [(0, 1), (0, 0), (1, 0), (1, 1)]),
    '-x': ([(-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1)],
           [(0, 1), (1, 1), (1, 0), (0, 0)]),
    '-z': ([(-1, -1, -1), (-1, 1, -1), (1, 1, -1), (1, -1, -1)],
           [(0, 1), (0, 0), (1, 0), (1, 1)]),
    '+z': ([(-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)],
           [(0, 1), (1, 1), (1, 0), (0, 0)]),
}


def cell_box(p, center, size, side_cell, top_cell, yaw=0.0, skip=('-y',)):
    """Plain box, every face mapped onto the FULL cell rect (shared paint);
    yaw about +Y for scatter — UVs are face-local so rotation is free."""
    cx, cy, cz = center
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    a = np.radians(yaw)
    ca, sa = np.cos(a), np.sin(a)

    def T(sx, sy, sz):
        lx, ly, lz = sx * hx, sy * hy, sz * hz
        return (cx + lx * ca + lz * sa, cy + ly, cz - lx * sa + lz * ca)

    for key, (signs, uvp) in _FACES.items():
        if key in skip:
            continue
        cell = top_cell if key in ('+y', '-y') else side_cell
        x0, y0, x1, y1 = cell
        us, vs = (x0, x1), (y0, y1)
        verts = [T(*s) for s in signs]
        uvs = [_uv(us[i], vs[j]) for (i, j) in uvp]
        p.add_face(verts, uvs=uvs)


# ── zone classifiers (tank pattern) ─────────────────────────────────────

def hull_zone(c, n):
    if n[1] < -0.5:
        return F.Z_DARK
    if abs(n[0]) > 0.62:
        return F.Z_HULL_SIDE
    if n[2] < -0.55:
        return F.Z_GLACIS
    if n[2] > 0.55:
        return F.Z_HULL_REAR
    return F.Z_HULL_TOP


def turret_zone(c, n):
    if n[1] < -0.5:
        return F.Z_DARK
    if abs(n[0]) > 0.62:
        return F.Z_TURRET_SIDE
    if n[2] < -0.55:
        return F.Z_TURRET_FRONT
    if n[2] > 0.55:
        return F.Z_TURRET_REAR
    return F.Z_TURRET_TOP


def ring_from_section(sec):
    z, yb, yw, ys, yd, wb, ww, wd, wt = sec
    return [
        (wb, yb, z), (ww, yw, z), (wd, ys, z), (wt, yd, z),
        (-wt, yd, z), (-wd, ys, z), (-ww, yw, z), (-wb, yb, z),
    ]


# ── hull (local tank frame) ─────────────────────────────────────────────

def build_hull():
    p = Part('hull')
    rings = [ring_from_section(s) for s in F.HULL_SECTIONS]
    loft(p, rings, hull_zone, cap_start=F.Z_GLACIS, cap_end=F.Z_HULL_REAR)

    # one hatch shut, one blown open (dark bore ring)
    hx, hz = F.HATCH_SHUT
    cell_box(p, (hx, F.HULL_DECK_Y + F.HATCH_SIZE[1] / 2 - 0.015, hz),
             F.HATCH_SIZE, F.Z_HATCH.rect, F.Z_HATCH.rect)
    hx, hz = F.HATCH_OPEN
    cell_box(p, (hx, F.HULL_DECK_Y + 0.02, hz),
             (F.HATCH_SIZE[0], 0.04, F.HATCH_SIZE[2]),
             F.Z_DARK.rect, F.Z_DARK.rect)
    # engine intake grille
    x, y, z, w, h, d = F.INTAKE
    chamfer_box(p, (x, y, z), (w, h, d), 0.025,
                {'+y': F.Z_INTAKE, '+x': F.Z_HULL_SIDE, '-x': F.Z_HULL_SIDE,
                 '+z': F.Z_HULL_REAR, '-z': F.Z_HULL_REAR}, skip=('-y',))
    # exhausts
    for (ex, ey, ez) in F.EXHAUSTS:
        chamfer_box(p, (ex, ey, ez), F.EXHAUST_SIZE, 0.04,
                    {'+y': F.Z_HULL_TOP, '+x': F.Z_HULL_SIDE,
                     '-x': F.Z_HULL_SIDE, '+z': F.Z_EXHAUST,
                     '-z': F.Z_HULL_SIDE}, skip=('-y',))
    return p


# ── track (local tank track frame) ──────────────────────────────────────

def build_track():
    p = Part('track')
    prof = F.TRACK_PROFILE
    w = F.TRACK_HALF_W
    n = len(prof)
    outer = [(w, y, z) for (z, y) in prof]
    inner = [(-w, y, z) for (z, y) in prof]
    p.add_face(outer, zone=F.Z_TRACK_SIDE, flip=True)
    p.add_face(inner, zone=F.Z_TRACK_SIDE)

    x0, y0, x1, y1 = F.TRACK_WRAP
    seg = [np.hypot(prof[(i + 1) % n][0] - prof[i][0],
                    prof[(i + 1) % n][1] - prof[i][1]) for i in range(n)]
    total = sum(seg)
    acc = 0.0
    centroid = np.array([0.0, sum(y for _, y in prof) / n,
                         sum(z for z, _ in prof) / n])
    for i in range(n):
        j = (i + 1) % n
        u0 = (x0 + (x1 - x0) * acc / total) / M.ATLAS
        acc += seg[i]
        u1 = (x0 + (x1 - x0) * acc / total) / M.ATLAS
        va, vb = y0 / M.ATLAS, y1 / M.ATLAS
        quad = [(w, prof[i][1], prof[i][0]), (-w, prof[i][1], prof[i][0]),
                (-w, prof[j][1], prof[j][0]), (w, prof[j][1], prof[j][0])]
        uvs = [(u0, va), (u0, vb), (u1, vb), (u1, va)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        if np.dot(nrm, ctr - centroid) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)
    return p


# ── turret + bent barrel (turret-local frame) ───────────────────────────

def build_turret():
    p = Part('turret')
    rings = [ring_from_section(s) for s in F.TURRET_SECTIONS]
    loft(p, rings, turret_zone,
         cap_start=F.Z_TURRET_FRONT, cap_end=F.Z_TURRET_REAR)
    x, y, z, w, h, d = F.BUSTLE
    chamfer_box(p, (x, y, z), (w, h, d), 0.045,
                {'+y': F.Z_TURRET_TOP, '+x': F.Z_TURRET_SIDE,
                 '-x': F.Z_TURRET_SIDE, '+z': F.Z_TURRET_REAR,
                 '-z': F.Z_TURRET_REAR}, skip=('-y',))
    merge(p, build_barrel(), off=F.BARREL_OFF)
    return p


def build_barrel():
    p = Part('barrel')
    x, y, z, w, h, d = F.BREECH
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+y': F.Z_BREECH, '+x': F.Z_BREECH, '-x': F.Z_BREECH,
                 '+z': F.Z_BREECH, '-z': F.Z_BREECH, '-y': F.Z_BREECH})
    # main tube along -Z via limb segments (per-station radii)
    st = F.TUBE_STATIONS
    for i in range(len(st) - 1):
        (za, ra), (zb, rb) = st[i], st[i + 1]
        if za == zb:
            continue
        limb(p, (0, 0, za), (0, 0, zb), ra, rb, F.BARREL_WRAP, n=8,
             cap_end=F.Z_TUBE_CAP if i == len(st) - 2 else None)
    # bend: rotate everything beyond BEND_Z about the kink point
    R = _rot(yaw=F.BEND_YAW, pitch=F.BEND_PITCH)
    k = np.array([0.0, 0.0, F.BEND_Z])
    for i, v in enumerate(p.pos):
        v = np.asarray(v, dtype=float)
        if v[2] < F.BEND_Z:
            p.pos[i] = tuple(R @ (v - k) + k)
            p.nrm[i] = tuple(R @ np.asarray(p.nrm[i], dtype=float))
    return p


# ── debris (world frame) ────────────────────────────────────────────────

def add_debris(p):
    for (cx, cy, cz, w, h, d, yaw) in F.PLATES:
        cell_box(p, (cx, cy, cz), (w, h, d), F.PLATE_S, F.PLATE_T, yaw=yaw)
    cx, cy, cz, w, h, d, yaw = F.HATCH_LID
    cell_box(p, (cx, cy, cz), (w, h, d), F.Z_HATCH.rect, F.Z_HATCH.rect,
             yaw=yaw)
    # loose road wheel lying flat (axis +Y)
    wx, wz, wr, wt = F.WHEEL
    cap = Zone(F.HUB_CAP, ('x', 'z'), ((wx - wr, wx + wr), (wz - wr, wz + wr)))
    limb(p, (wx, 0.02, wz), (wx, 0.02 + wt, wz), wr, wr, F.WHEEL_WRAP, n=8,
         cap_end=cap)
    return p


# ── assembly ────────────────────────────────────────────────────────────

def build_body():
    body = Part('body')
    merge(body, build_hull(), off=(0, F.SETTLE, 0))
    track = build_track()
    merge(body, track, off=F.TRACK_L_OFF)                       # attached L
    merge(body, track, off=F.THROWN_OFF,
          yaw=F.THROWN_YAW, roll=F.THROWN_ROLL)                 # thrown R
    merge(body, build_turret(), off=F.TURRET_POS,
          yaw=F.TURRET_YAW, pitch=F.TURRET_PITCH, roll=F.TURRET_ROLL)
    add_debris(body)
    return body


def build_all():
    return [dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body())]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
