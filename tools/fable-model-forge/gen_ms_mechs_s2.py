"""gen_ms_mechs_s2 — geometry + walk/idle/death clips for the Metalstorm
scale-2 LINE mech: an upright, forward-knee biped with a glazed manned
cockpit head and a shoulder-hardpoint autocannon.

Helper functions (joint_stub, extrude_profile, ring_from_section, the
quaternion helpers and foot_comp) are copied from the shipped gen_mech.py —
that reuse is intended by the brief.
"""
from __future__ import annotations
import numpy as np

import ms_mechs_s2_layout as M   # sets meshlib.ATLAS = 1024 on import
from meshlib import Part, loft, chamfer_box, tube, ngon_ring, limb, mirror_x
from gltf_export import export

STEM = 'ms_mechs_s2'
OUT = 'out'


# ---- helpers (from gen_mech.py) ----------------------------------------

def ring_from_section(sec):
    z, yb, yw, ys, yd, wb, ww, wd, wt = sec
    return [
        (wb, yb, z), (ww, yw, z), (wd, ys, z), (wt, yd, z),
        (-wt, yd, z), (-wd, ys, z), (-ww, yw, z), (-wb, yb, z),
    ]


def joint_stub(p, center, r, half_w, rect=None, cap_zone=None):
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
        p.add_face(list(ring), zone=cap_zone or M.M_JOINT_CAP, flip=(sign < 0))


def extrude_profile(p, prof, half_w, side_zone, wrap_rect):
    n = len(prof)
    area = sum(prof[i][0] * prof[(i + 1) % n][1]
               - prof[(i + 1) % n][0] * prof[i][1] for i in range(n))
    ccw_zy = area > 0
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


# ---- zone classifiers ---------------------------------------------------

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


def head_zone(c, n):
    if n[1] < -0.5:
        return M.M_DARK
    if abs(n[0]) > 0.6:
        return M.M_COCKPIT_S
    if n[2] < -0.30:
        return M.M_COCKPIT_F      # windscreen face + its upper slope
    if n[1] > 0.45:
        return M.M_COCKPIT_T
    return M.M_COCKPIT_S


# ---- pieces -------------------------------------------------------------

def build_body():
    p = Part('body')
    x, y, z, w, h, d = M.PELVIS
    chamfer_box(p, (x, y, z), (w, h, d), 0.07,
                {'+y': M.M_PELVIS, '-y': M.M_DARK, '+x': M.M_PELVIS,
                 '-x': M.M_PELVIS, '+z': M.M_PELVIS, '-z': M.M_PELVIS})
    x, y, z, w, h, d = M.PELVIS_SKIRT
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': M.M_PELVIS, '-y': M.M_DARK, '+x': M.M_PELVIS,
                 '-x': M.M_PELVIS, '+z': M.M_PELVIS, '-z': M.M_PELVIS})
    for sx in (1, -1):
        joint_stub(p, (sx * (M.HIP_X - 0.05), M.HIP_Y, 0.0), 0.22, 0.10)
    return p


def build_torso():
    p = Part('turret')
    loft(p, [ring_from_section(s) for s in M.TORSO_SECTIONS], torso_zone,
         cap_start=M.M_TORSO_FRONT, cap_end=M.M_TORSO_REAR)
    # glazed manned cockpit head, hung on the front of the torso
    loft(p, [ring_from_section(s) for s in M.HEAD_SECTIONS], head_zone,
         cap_start=M.M_COCKPIT_F, cap_end=None)
    for (box, ch, zones) in (
        (M.BROW, 0.02, M.M_BROW),
        (M.HATCH, 0.02, M.M_HATCH),
        (M.AMMO_BIN, 0.04, M.M_AMMO_BIN),
        (M.VENT_BOX, 0.03, M.M_VENTS),
        (M.PAULDRON_R, 0.05, M.M_PAULDRON),
        (M.PAULDRON_L, 0.04, M.M_PAULDRON),
        (M.STEP_BLOCK, 0.02, M.M_STEP),
    ):
        x, y, z, w, h, d = box
        zd = {k: zones for k in ('+y', '+x', '-x', '+z', '-z')}
        zd['-y'] = M.M_DARK
        chamfer_box(p, (x, y, z), (w, h, d), ch, zd)
    # crew grab rail, ammo belt from the backpack bin to the gun, antenna
    limb(p, M.RAIL_A, M.RAIL_B, 0.035, 0.035, M.M_CHUTE, n=6)
    limb(p, M.CHUTE_A, M.CHUTE_B, 0.115, 0.09, M.M_CHUTE, n=8)
    limb(p, M.ANT_A, M.ANT_B, 0.05, 0.018, M.M_ANTENNA, n=6)
    joint_stub(p, M.SHOULDER_BOSS, 0.19, 0.13)
    return p


def build_gun():
    p = Part('barrel')
    joint_stub(p, (0.10, 0.0, 0.06), 0.185, 0.13)
    for (box, ch, zone) in ((M.GUN_RECEIVER, 0.04, M.M_RECEIVER),
                            (M.GUN_MAG, 0.03, M.M_MAG),
                            (M.GUN_BRAKE, 0.03, M.M_MUZZLE_CELL)):
        x, y, z, w, h, d = box
        chamfer_box(p, (x, y, z), (w, h, d), ch,
                    {k: zone for k in ('+y', '-y', '+x', '-x', '+z', '-z')})
    tube(p, M.GUN_TUBE, M.M_GUN_WRAP, n=8, cap_end=None)
    (tz0, tz1), tr = M.GUN_TIP
    tube(p, [(tz0, tr), (tz1, tr)], M.M_GUN_WRAP, n=8, cap_end=M.M_MUZZLE_CELL)
    return p


def build_thigh_l():
    p = Part('thigh_l')
    joint_stub(p, (0.0, 0.0, 0.0), 0.225, 0.12)
    limb(p, (0, -0.03, -0.01), M.KNEE, M.THIGH_R0, M.THIGH_R1, M.M_THIGH)
    joint_stub(p, M.KNEE, 0.185, 0.11)
    return p


def build_shin_l():
    p = Part('shin_l')
    limb(p, (0, 0.0, 0.0), M.ANKLE, M.SHIN_R0, M.SHIN_R1, M.M_SHIN)
    joint_stub(p, M.ANKLE, 0.145, 0.095)
    return p


def build_foot_l():
    p = Part('foot_l')
    extrude_profile(p, M.FOOT_PROFILE, M.FOOT_HALF_W,
                    M.M_FOOT_SIDE, M.M_FOOT_WRAP)
    return p


# ---- clips --------------------------------------------------------------

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
            ('thigh_l', 'rotation', rot_keys(it, M.IDLE_THIGH)),
            ('thigh_r', 'rotation', rot_keys(it, M.IDLE_THIGH)),
            ('shin_l', 'rotation', rot_keys(it, M.IDLE_SHIN)),
            ('shin_r', 'rotation', rot_keys(it, M.IDLE_SHIN)),
            ('foot_l', 'rotation', rot_keys(
                it, [foot_comp(a, b) for a, b in zip(M.IDLE_THIGH, M.IDLE_SHIN)])),
            ('foot_r', 'rotation', rot_keys(
                it, [foot_comp(a, b) for a, b in zip(M.IDLE_THIGH, M.IDLE_SHIN)])),
        ],
    }

    dt = M.DEATH_KEYS
    torso_q = [qmul(qy(y), qx(pp))
               for y, pp in zip(M.DEATH_TORSO_YAW, M.DEATH_TORSO_PITCH)]
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


# ---- assembly -----------------------------------------------------------

def build_all():
    body = build_body()
    torso = build_torso()
    gun = build_gun()
    tl, sl, fl = build_thigh_l(), build_shin_l(), build_foot_l()
    tr = mirror_x(tl, 'thigh_r')
    sr = mirror_x(sl, 'shin_r')
    fr = mirror_x(fl, 'foot_r')
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=body),           # 0
        dict(name='turret', parent=0, offset=M.TURRET_OFF, part=torso),      # 1
        dict(name='barrel', parent=1, offset=M.BARREL_OFF, part=gun),        # 2
        dict(name='muzzle', parent=2, offset=M.MUZZLE_OFF, part=None),       # 3
        dict(name='exhaust', parent=1, offset=M.EXHAUST_OFF, part=None),     # 4
        dict(name='thigh_l', parent=0, offset=(M.HIP_X, M.HIP_Y, 0), part=tl),
        dict(name='shin_l', parent=5, offset=M.KNEE, part=sl),
        dict(name='foot_l', parent=6, offset=M.ANKLE, part=fl),
        dict(name='thigh_r', parent=0, offset=(-M.HIP_X, M.HIP_Y, 0), part=tr),
        dict(name='shin_r', parent=8, offset=M.KNEE, part=sr),
        dict(name='foot_r', parent=9, offset=M.ANKLE, part=fr),
    ]
    return pieces


def _bbox(pieces):
    xf = {}
    lo = np.array([1e9] * 3)
    hi = np.array([-1e9] * 3)
    for i, pc in enumerate(pieces):
        par = pc['parent']
        base = xf[par] if par >= 0 else np.zeros(3)
        o = base + np.asarray(pc['offset'], dtype=float)
        xf[i] = o
        if pc['part'] is None:
            continue
        for v in pc['part'].pos:
            w = o + np.asarray(v, dtype=float)
            lo = np.minimum(lo, w)
            hi = np.maximum(hi, w)
    return lo, hi


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    lo, hi = _bbox(pieces)
    d = hi - lo
    print(f'[gen] bbox  W(x)={d[0]:.3f}  H(y)={d[1]:.3f}  D(z)={d[2]:.3f}  '
          f'min={np.round(lo,3)} max={np.round(hi,3)}')
    total = sum(p['part'].tri_count() for p in pieces if p['part'] is not None)
    print(f'TOTAL {total} tris')
