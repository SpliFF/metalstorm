"""gen_ms_mechs_s1 — RW-1 "Tick": unmanned FOUR-LEGGED recon walker, 3.0 m
tall, faceted sensor head (no cockpit, no glazing), chin-mounted medium MG.

Reverse-jointed (knee-back) legs at all four corners; the limb / joint_stub /
extrude_profile primitives and the foot_comp + shifted clip helpers are lifted
from the shipped gen_mech.py (fable_mech) and scaled down. Pivots ARE the
joints; every rest rotation is identity.
"""
from __future__ import annotations
import numpy as np

from meshlib import Part, chamfer_box, tube, ngon_ring, limb, mirror_x
from gltf_export import export
import ms_mechs_s1_layout as M

STEM = 'ms_mechs_s1'
OUT = 'out'
RNG = np.random.default_rng(90210)


# ── primitives copied from gen_mech.py ───────────────────────────────────

def joint_stub(p, center, r, half_w, rect=None, cap_zone=None, n=8):
    """n-gon axle stub along X at `center` — the visible hip/knee/ankle
    joints. Parametric wrap + outer caps."""
    rect = rect or M.M_JOINT
    cx0, cy0, cx1, cy1 = rect
    r0 = ngon_ring((center[0] - half_w, center[1], center[2]), r, n=n, axis='x')
    r1 = ngon_ring((center[0] + half_w, center[1], center[2]), r, n=n, axis='x')
    for j in range(n):
        k = (j + 1) % n
        u0 = (cx0 + (cx1 - cx0) * j / n) / 1024.0
        u1 = (cx0 + (cx1 - cx0) * (j + 1) / n) / 1024.0
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
    """Extruded side profile along X (winding-safe) — the foot."""
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


# ── pieces ───────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    x, y, z, w, h, d = M.HULL
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+y': M.B_TOP, '-y': M.B_DARK, '+x': M.B_SIDE, '-x': M.B_SIDE,
                 '+z': M.B_REAR, '-z': M.B_FRONT})
    # deck stowage / aerial box (light-recon kit, off-centre)
    x, y, z, w, h, d = M.STOWAGE
    chamfer_box(p, (x, y, z), (w, h, d), 0.025,
                {'+y': M.B_TOP, '+x': M.B_SIDE, '-x': M.B_SIDE,
                 '+z': M.B_REAR, '-z': M.B_FRONT}, skip=('-y',))
    # four hip fairings, one per corner — they make the leg roots read
    sw, sh, sd = M.SPONSON
    for sx in (1, -1):
        for hz in (M.HIP_ZF, M.HIP_ZR):
            chamfer_box(p, (sx * M.SPONSON_X, M.HIP_Y + 0.01, hz), (sw, sh, sd),
                        0.035,
                        {'+y': M.B_TOP, '-y': M.B_DARK,
                         '+x': M.B_SPONSON, '-x': M.B_SPONSON,
                         '+z': M.B_REAR, '-z': M.B_FRONT})
    return p


def build_head():
    """turret — a faceted multi-sensor cluster. NO canopy, NO glass."""
    p = Part('turret')
    x, y, z, w, h, d = M.COLLAR
    chamfer_box(p, (x, y, z), (w, h, d), 0.04,
                {'+y': M.H_TOP, '-y': M.B_DARK, '+x': M.H_SIDE, '-x': M.H_SIDE,
                 '+z': M.H_VENT, '-z': M.H_MAIN})
    x, y, z, w, h, d = M.SENSOR
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+y': M.H_TOP, '+x': M.H_SIDE, '-x': M.H_SIDE,
                 '+z': M.H_MAIN, '-z': M.H_MAIN}, skip=('-y',))
    bx, by, bz, bw, bh, bd = M.BLISTER
    for sx in (1, -1):
        chamfer_box(p, (sx * bx, by, bz), (bw, bh, bd), 0.035,
                    {'+y': M.H_TOP, '-y': M.H_LENS, '+x': M.H_SIDE,
                     '-x': M.H_SIDE, '-z': M.H_LENS, '+z': M.H_MAIN})
    x, y, z, w, h, d = M.PANEL
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': M.H_PANEL, '-y': M.H_PANEL, '+x': M.H_SIDE,
                 '-x': M.H_SIDE, '+z': M.H_MAIN, '-z': M.H_MAIN})
    # single comms blade / mast — the one silhouette spike, tip at y = 3.0 m
    limb(p, M.MAST_P0, M.MAST_P1, M.MAST_R0, M.MAST_R1, M.MAST, n=6,
         cap_end=M.M_JOINT_CAP)
    return p


def build_gun():
    """barrel — chin / under-slung medium MG on a gimbal yoke."""
    p = Part('barrel')
    joint_stub(p, (0.0, 0.02, 0.16), 0.105, 0.20, n=6)
    x, y, z, w, h, d = M.GUN_YOKE
    chamfer_box(p, (x, y, z), (w, h, d), 0.035,
                {'+y': M.G_BODY, '-y': M.G_BODY, '+x': M.G_BODY,
                 '-x': M.G_BODY, '+z': M.G_BODY, '-z': M.G_BODY})
    x, y, z, w, h, d = M.GUN_AMMO   # ammo feed / belt box, offset to one side
    chamfer_box(p, (x, y, z), (w, h, d), 0.025,
                {'+y': M.G_BODY, '-y': M.G_BODY, '+x': M.G_BODY,
                 '-x': M.G_BODY, '+z': M.G_BODY, '-z': M.G_BODY})
    tube(p, M.GUN_TUBE, M.G_WRAP, n=8, cap_end=None)
    tube(p, M.GUN_SHROUD, M.G_WRAP, n=8, cap_end=M.G_TIP)   # flash hider
    return p


def build_thigh(name, radii, stub_hip=M.STUB_HIP, stub_knee=M.STUB_KNEE):
    p = Part(name)
    joint_stub(p, (0.0, 0.0, 0.0), stub_hip[0], stub_hip[1])
    limb(p, (0.02, -0.02, 0.02), M.KNEE, radii[0], radii[1], M.M_THIGH)
    joint_stub(p, M.KNEE, stub_knee[0], stub_knee[1])
    return p


def build_shin(name, radii):
    p = Part(name)
    limb(p, (0.0, 0.0, 0.0), M.ANKLE, radii[0], radii[1], M.M_SHIN)
    joint_stub(p, M.ANKLE, M.STUB_ANKLE[0], M.STUB_ANKLE[1])
    return p


def build_foot(name):
    p = Part(name)
    extrude_profile(p, M.FOOT_PROFILE, M.FOOT_HALF_W,
                    M.M_FOOT_SIDE, M.M_FOOT_WRAP)
    return p


# ── clip helpers (from gen_mech.py) ──────────────────────────────────────

def qx(deg):
    r = np.radians(deg) / 2
    return (float(np.sin(r)), 0.0, 0.0, float(np.cos(r)))


def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def qz(deg):
    r = np.radians(deg) / 2
    return (0.0, 0.0, float(np.sin(r)), float(np.cos(r)))


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
        """half-cycle phase shift, loop-safe (last key == first)."""
        return [tbl[(i + half) % (n - 1)] for i in range(n - 1)] + \
               [tbl[half % (n - 1)]]

    # DIAGONAL TROT: (front-left, rear-right) in phase; (front-right,
    # rear-left) shifted half a cycle.
    a_th, a_sh = M.WALK_THIGH, M.WALK_SHIN
    b_th, b_sh = shifted(M.WALK_THIGH), shifted(M.WALK_SHIN)
    pairs = [('fl', a_th, a_sh), ('rr', a_th, a_sh),
             ('fr', b_th, b_sh), ('rl', b_th, b_sh)]

    walk_ch = []
    for tag, th, sh in pairs:
        walk_ch += [
            (f'thigh_{tag}', 'rotation', rot_keys(wt, th)),
            (f'shin_{tag}', 'rotation', rot_keys(wt, sh)),
            (f'foot_{tag}', 'rotation',
             rot_keys(wt, [foot_comp(a, b) for a, b in zip(th, sh)])),
        ]
    walk_ch += [
        ('body', 'translation', [(t, (0.0, dy, 0.0))
                                 for t, dy in zip(wt, M.WALK_BODY_Y)]),
        ('turret', 'rotation', rot_keys(wt, M.WALK_HEAD_YAW, q=qy)),
        ('barrel', 'rotation', rot_keys(wt, M.WALK_GUN_PITCH)),
    ]
    walk = {'name': 'walk', 'channels': walk_ch}

    it = M.IDLE_KEYS
    idle = {
        'name': 'idle',
        'channels': [
            ('turret', 'rotation', rot_keys(it, M.IDLE_HEAD_YAW, q=qy)),
            ('barrel', 'rotation', rot_keys(it, M.IDLE_GUN_PITCH)),
            ('body', 'translation', [(t, (0.0, dy, 0.0))
                                     for t, dy in zip(it, M.IDLE_BODY_Y)]),
        ],
    }

    dt = M.DEATH_KEYS
    head_q = [qmul(qy(y), qx(p))
              for y, p in zip(M.DEATH_HEAD_YAW, M.DEATH_HEAD_PITCH)]
    death_ch = [
        ('body', 'translation', [(t, tuple(map(float, v)))
                                 for t, v in zip(dt, M.DEATH_BODY)]),
        ('body', 'rotation', rot_keys(dt, M.DEATH_BODY_PITCH)),
        ('turret', 'rotation', list(zip(dt, head_q))),
        ('barrel', 'rotation', rot_keys(dt, M.DEATH_GUN)),
    ]
    for tag in ('fl', 'fr', 'rl', 'rr'):
        sgn = 1.0 if tag.endswith('l') else -1.0     # splay outboard
        death_ch += [
            (f'thigh_{tag}', 'rotation',
             [(t, qmul(qz(sgn * s), qx(a)))
              for t, s, a in zip(dt, M.DEATH_SPLAY, M.DEATH_THIGH)]),
            (f'shin_{tag}', 'rotation', rot_keys(dt, M.DEATH_SHIN)),
            (f'foot_{tag}', 'rotation',
             rot_keys(dt, [foot_comp(a, b) * 0.6
                           for a, b in zip(M.DEATH_THIGH, M.DEATH_SHIN)])),
        ]
    death = {'name': 'death', 'channels': death_ch}
    return [walk, idle, death]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    body = build_body()
    head = build_head()
    gun = build_gun()

    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=body),        # 0
        dict(name='turret', parent=0, offset=M.TURRET_OFF, part=head),    # 1
        dict(name='barrel', parent=1, offset=M.BARREL_OFF, part=gun),     # 2
        dict(name='muzzle', parent=2, offset=M.MUZZLE_OFF, part=None),    # 3
        dict(name='exhaust', parent=1, offset=M.EXHAUST_OFF, part=None),  # 4
    ]

    knee_r = (M.KNEE[0], M.KNEE[1], M.KNEE[2])
    knee_l = (-M.KNEE[0], M.KNEE[1], M.KNEE[2])
    ankle_r = (M.ANKLE[0], M.ANKLE[1], M.ANKLE[2])
    ankle_l = (-M.ANKLE[0], M.ANKLE[1], M.ANKLE[2])

    for tag, hz, th_r, sh_r in (('f', M.HIP_ZF, M.THIGH_RF, M.SHIN_RF),
                                ('r', M.HIP_ZR, M.THIGH_RR, M.SHIN_RR)):
        tl = build_thigh(f'thigh_{tag}l', th_r)
        sl = build_shin(f'shin_{tag}l', sh_r)
        fl = build_foot(f'foot_{tag}l')
        tr = mirror_x(tl, f'thigh_{tag}r')
        sr = mirror_x(sl, f'shin_{tag}r')
        fr = mirror_x(fl, f'foot_{tag}r')
        for side, (tp, sp, fp) in (('l', (tl, sl, fl)), ('r', (tr, sr, fr))):
            sx = 1.0 if side == 'l' else -1.0
            i = len(pieces)
            pieces += [
                dict(name=f'thigh_{tag}{side}', parent=0,
                     offset=(sx * M.HIP_X, M.HIP_Y, hz), part=tp),
                dict(name=f'shin_{tag}{side}', parent=i,
                     offset=knee_r if side == 'l' else knee_l, part=sp),
                dict(name=f'foot_{tag}{side}', parent=i + 1,
                     offset=ankle_r if side == 'l' else ankle_l, part=fp),
            ]
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)

    lo = np.array([1e9, 1e9, 1e9])
    hi = -lo.copy()
    for pc in pieces:
        part = pc['part']
        if part is None or not part.pos:
            continue
        # accumulate world offset up the parent chain
        off = np.array(pc['offset'], dtype=float)
        par = pc['parent']
        while par >= 0:
            off = off + np.array(pieces[par]['offset'], dtype=float)
            par = pieces[par]['parent']
        v = np.array(part.pos) + off
        lo = np.minimum(lo, v.min(axis=0))
        hi = np.maximum(hi, v.max(axis=0))
    dim = hi - lo
    print(f'bbox  W(x)={dim[0]:.3f}  H(y)={dim[1]:.3f}  L(z)={dim[2]:.3f}  '
          f'(y {lo[1]:.3f}..{hi[1]:.3f})')
    total = sum(p['part'].tri_count() for p in pieces if p['part'] is not None)
    print(f'TOTAL {total} tris')
