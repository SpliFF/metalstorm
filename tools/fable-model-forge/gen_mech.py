"""gen_mech — build fable_mech (MW-3 Strider) geometry + walk/idle/death
clips and export .gltf + .bin via the generic exporter.

Reverse-joint biped at exactly fable_tank's height (3.18 m). All pivots
are the joints; rest rotations identity (limb slant baked into geometry).
"""
from __future__ import annotations
import numpy as np

from meshlib import Part, Zone, loft, chamfer_box, tube, ngon_ring, limb, mirror_x
from gltf_export import export
import mech_layout as M

STEM = 'fable_mech'
OUT = 'out'


# ── zone classifier for the torso loft ───────────────────────────────────

def torso_zone(c, n):
    if n[1] < -0.5:
        return M.M_DARK
    if abs(n[0]) > 0.62:
        return M.M_TORSO_SIDE
    if n[2] < -0.55:
        return M.M_TORSO_FRONT
    if n[2] > 0.55:
        return M.M_TORSO_REAR
    return M.M_TORSO_TOP


def ring_from_section(sec):
    z, yb, yw, ys, yd, wb, ww, wd, wt = sec
    return [
        (wb, yb, z), (ww, yw, z), (wd, ys, z), (wt, yd, z),
        (-wt, yd, z), (-wd, ys, z), (-ww, yw, z), (-wb, yb, z),
    ]


def joint_stub(p, center, r, half_w, rect=None, cap_zone=None):
    """8-gon axle stub along X at `center` — the visible hip/knee/ankle/
    shoulder joints. Parametric wrap + outer cap."""
    rect = rect or M.M_JOINT
    cx0, cy0, cx1, cy1 = rect
    r0 = ngon_ring((center[0] - half_w, center[1], center[2]), r, n=8, axis='x')
    r1 = ngon_ring((center[0] + half_w, center[1], center[2]), r, n=8, axis='x')
    for j in range(8):
        k = (j + 1) % 8
        u0 = (cx0 + (cx1 - cx0) * j / 8) / 1024.0
        u1 = (cx0 + (cx1 - cx0) * (j + 1) / 8) / 1024.0
        quad = [r0[j], r0[k], r1[k], r1[j]]
        uvs = [(u0, cy0 / 1024.0), (u1, cy0 / 1024.0),
               (u1, cy1 / 1024.0), (u0, cy1 / 1024.0)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        rad = ctr - np.array([ctr[0], center[1], center[2]])
        if np.dot(nrm, rad) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)
    for (ring, sign) in ((r1, 1.0), (r0, -1.0)):
        # axis='x' ring fan normal is +X; flip for the -X cap
        p.add_face(list(ring), zone=cap_zone or M.M_JOINT_CAP,
                   flip=(sign < 0))


def extrude_profile(p, prof, half_w, side_zone, wrap_rect):
    """Extruded side profile along X (track-pod pattern, winding-safe)."""
    n = len(prof)
    area = sum(prof[i][0] * prof[(i + 1) % n][1]
               - prof[(i + 1) % n][0] * prof[i][1] for i in range(n))
    ccw_zy = area > 0  # CCW in (z,y) -> fan normal -X
    outer = [(half_w, y, z) for (z, y) in prof]
    inner = [(-half_w, y, z) for (z, y) in prof]
    p.add_face(outer, zone=side_zone, flip=ccw_zy)
    p.add_face(inner, zone=side_zone, flip=not ccw_zy)
    x0, y0, x1, y1 = wrap_rect
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
        quad = [(half_w, prof[i][1], prof[i][0]), (-half_w, prof[i][1], prof[i][0]),
                (-half_w, prof[j][1], prof[j][0]), (half_w, prof[j][1], prof[j][0])]
        uvs = [(u0, y0 / 1024.0), (u0, y1 / 1024.0),
               (u1, y1 / 1024.0), (u1, y0 / 1024.0)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        if np.dot(nrm, ctr - centroid) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)


# ── pieces ───────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    x, y, z, w, h, d = M.PELVIS
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+y': M.M_PELVIS, '-y': M.M_DARK, '+x': M.M_PELVIS,
                 '-x': M.M_PELVIS, '+z': M.M_PELVIS, '-z': M.M_PELVIS})
    for sx in (1, -1):
        joint_stub(p, (sx * (M.HIP_X - 0.04), M.HIP_Y, 0.0), 0.19, 0.08)
    return p


def build_torso():
    p = Part('turret')
    rings = [ring_from_section(s) for s in M.TORSO_SECTIONS]
    loft(p, rings, torso_zone, cap_start=M.M_TORSO_FRONT, cap_end=M.M_TORSO_REAR)
    x, y, z, w, h, d = M.HEAD
    chamfer_box(p, (x, y, z), (w, h, d), 0.045,
                {'+y': M.M_HEAD, '+x': M.M_HEAD, '-x': M.M_HEAD,
                 '-z': M.M_HEAD, '+z': M.M_HEAD}, skip=('-y',))
    x, y, z, w, h, d = M.PAULDRON
    chamfer_box(p, (x, y, z), (w, h, d), 0.035,
                {'+y': M.M_SHOULDER, '+x': M.M_SHOULDER, '-x': M.M_SHOULDER,
                 '-z': M.M_SHOULDER, '+z': M.M_SHOULDER, '-y': M.M_DARK})
    x, y, z, w, h, d = M.BACKPACK
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': M.M_TORSO_TOP, '+x': M.M_TORSO_SIDE, '-x': M.M_TORSO_SIDE,
                 '+z': M.M_VENTS, '-z': M.M_TORSO_REAR}, skip=('-y',))
    # right shoulder mount boss (the barrel hangs at −0.66)
    joint_stub(p, (-0.74, 0.46, 0.02), 0.17, 0.10)
    return p


def build_gun():
    p = Part('barrel')
    joint_stub(p, (0.08, 0.0, 0.02), 0.17, 0.12)
    x, y, z, w, h, d = M.GUN_RECEIVER
    chamfer_box(p, (x, y, z), (w, h, d), 0.04,
                {'+y': M.M_RECEIVER, '-y': M.M_RECEIVER, '+x': M.M_RECEIVER,
                 '-x': M.M_RECEIVER, '-z': M.M_RECEIVER, '+z': M.M_RECEIVER})
    tube(p, M.GUN_TUBE, M.M_GUN_WRAP, n=8, cap_end=None)
    z0, z1 = M.GUN_RAIL_ZSPAN
    for (rx, rw, rh) in M.GUN_RAILS:
        chamfer_box(p, (rx, 0.0, (z0 + z1) / 2), (rw, rh, abs(z1 - z0)), 0.014,
                    {'+y': M.M_RAIL, '-y': M.M_RAIL, '+x': M.M_RAIL,
                     '-x': M.M_RAIL, '-z': M.M_MUZZLE_CELL, '+z': M.M_MUZZLE_CELL})
    x, y, z, w, h, d = M.GUN_MUZZLE_BLOCK
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': M.M_MUZZLE_CELL, '-y': M.M_MUZZLE_CELL,
                 '+x': M.M_MUZZLE_CELL, '-x': M.M_MUZZLE_CELL,
                 '-z': M.M_MUZZLE_CELL, '+z': M.M_MUZZLE_CELL})
    (tz0, tz1), tr = M.GUN_TIP
    tube(p, [(tz0, tr), (tz1, tr)], M.M_GUN_WRAP, n=8, cap_end=M.M_MUZZLE_CELL)
    return p


def build_thigh_l():
    p = Part('thigh_l')
    joint_stub(p, (0.0, 0.0, 0.0), 0.19, 0.11)
    limb(p, (0, -0.02, 0.02), M.KNEE, M.THIGH_R0, M.THIGH_R1, M.M_THIGH)
    joint_stub(p, M.KNEE, 0.155, 0.10)
    return p


def build_shin_l():
    p = Part('shin_l')
    limb(p, (0, 0.0, 0.0), M.ANKLE, M.SHIN_R0, M.SHIN_R1, M.M_SHIN)
    joint_stub(p, M.ANKLE, 0.125, 0.085)
    return p


def build_foot_l():
    p = Part('foot_l')
    extrude_profile(p, M.FOOT_PROFILE, M.FOOT_HALF_W,
                    M.M_FOOT_SIDE, M.M_FOOT_WRAP)
    return p


# ── clips ────────────────────────────────────────────────────────────────

def qx(deg):
    r = np.radians(deg) / 2
    return (float(np.sin(r)), 0.0, 0.0, float(np.cos(r)))


def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz)


def foot_comp(thigh, shin):
    f = -(thigh + shin) * M.WALK_FOOT_COMP
    return max(-M.WALK_FOOT_CLAMP, min(M.WALK_FOOT_CLAMP, f))


def rot_keys(times, degs, q=qx):
    return [(t, q(d)) for t, d in zip(times, degs)]


def build_clips():
    n = len(M.WALK_THIGH)
    wt = [M.WALK_T * i / (n - 1) for i in range(n)]
    half = (n - 1) // 2

    def shifted(tbl):
        # right leg = left phase-shifted by half a cycle (loop-safe)
        return [tbl[(i + half) % (n - 1)] for i in range(n - 1)] + \
               [tbl[half % (n - 1)]]

    thigh_r = shifted(M.WALK_THIGH)
    shin_r = shifted(M.WALK_SHIN)
    walk = {
        'name': 'walk',
        'channels': [
            ('thigh_l', 'rotation', rot_keys(wt, M.WALK_THIGH)),
            ('shin_l', 'rotation', rot_keys(wt, M.WALK_SHIN)),
            ('foot_l', 'rotation', rot_keys(
                wt, [foot_comp(a, b) for a, b in zip(M.WALK_THIGH, M.WALK_SHIN)])),
            ('thigh_r', 'rotation', rot_keys(wt, thigh_r)),
            ('shin_r', 'rotation', rot_keys(wt, shin_r)),
            ('foot_r', 'rotation', rot_keys(
                wt, [foot_comp(a, b) for a, b in zip(thigh_r, shin_r)])),
            ('body', 'translation', [(t, (0.0, dy, 0.0))
                                     for t, dy in zip(wt, M.WALK_BODY_Y)]),
            ('turret', 'rotation', rot_keys(wt, M.WALK_TORSO_YAW, q=qy)),
            ('barrel', 'rotation', rot_keys(wt, M.WALK_GUN_PITCH)),
        ],
    }

    it = M.IDLE_KEYS
    idle = {
        'name': 'idle',
        'channels': [
            ('body', 'translation', [(t, (0.0, dy, 0.0))
                                     for t, dy in zip(it, M.IDLE_BODY_Y)]),
            ('turret', 'rotation', rot_keys(it, M.IDLE_TORSO_YAW, q=qy)),
            ('barrel', 'rotation', rot_keys(it, M.IDLE_GUN_PITCH)),
        ],
    }

    dt = M.DEATH_KEYS
    torso_q = [qmul(qy(y), qx(p))
               for y, p in zip(M.DEATH_TORSO_YAW, M.DEATH_TORSO_PITCH)]
    death = {
        'name': 'death',
        'channels': [
            ('body', 'translation', [(t, tuple(map(float, v)))
                                     for t, v in zip(dt, M.DEATH_BODY)]),
            ('turret', 'rotation', list(zip(dt, torso_q))),
            ('barrel', 'rotation', rot_keys(dt, M.DEATH_GUN)),
            ('thigh_l', 'rotation', rot_keys(dt, M.DEATH_THIGH_L)),
            ('thigh_r', 'rotation', rot_keys(dt, M.DEATH_THIGH_R)),
            ('shin_l', 'rotation', rot_keys(dt, M.DEATH_SHIN_L)),
            ('shin_r', 'rotation', rot_keys(dt, M.DEATH_SHIN_R)),
            ('foot_l', 'rotation', rot_keys(
                dt, [foot_comp(a, b) * 0.6
                     for a, b in zip(M.DEATH_THIGH_L, M.DEATH_SHIN_L)])),
            ('foot_r', 'rotation', rot_keys(
                dt, [foot_comp(a, b) * 0.6
                     for a, b in zip(M.DEATH_THIGH_R, M.DEATH_SHIN_R)])),
        ],
    }
    return [walk, idle, death]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    body = build_body()
    torso = build_torso()
    gun = build_gun()
    tl = build_thigh_l()
    sl = build_shin_l()
    fl = build_foot_l()
    tr = mirror_x(tl, 'thigh_r')
    sr = mirror_x(sl, 'shin_r')
    fr = mirror_x(fl, 'foot_r')

    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=body),          # 0
        dict(name='turret', parent=0, offset=M.TURRET_OFF, part=torso),     # 1
        dict(name='barrel', parent=1, offset=M.BARREL_OFF, part=gun),       # 2
        dict(name='muzzle', parent=2, offset=M.MUZZLE_OFF, part=None),      # 3
        dict(name='exhaust', parent=1, offset=M.EXHAUST_OFF, part=None),    # 4
        dict(name='thigh_l', parent=0, offset=(M.HIP_X, M.HIP_Y, 0), part=tl),
        dict(name='shin_l', parent=5, offset=M.KNEE, part=sl),
        dict(name='foot_l', parent=6, offset=M.ANKLE, part=fl),
        dict(name='thigh_r', parent=0, offset=(-M.HIP_X, M.HIP_Y, 0), part=tr),
        dict(name='shin_r', parent=8, offset=M.KNEE, part=sr),
        dict(name='foot_r', parent=9, offset=M.ANKLE, part=fr),
    ]
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
