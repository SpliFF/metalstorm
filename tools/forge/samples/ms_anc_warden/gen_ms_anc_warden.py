"""gen_ms_anc_warden — assemble ms_anc_warden and export .gltf/.bin.

Warden automaton: 11.9 m ANCIENT guardian biped.  Gyro-sphere hip inside
two free-standing halo rings, monolithic torso with a cantilevered rear
counterweight, sensor cowl with a cyan visor slit, shoulder-mounted lance
on the standard turret/barrel/muzzle chain, long clean limb columns on
perfect-circle joint discs.

Clips: walk (quadruple-beat, seamless) + idle (sensor-cowl scan).
Run: python3 gen_ms_anc_warden.py  -> out/ms_anc_warden{,_png}.gltf + .bin
"""
from __future__ import annotations
import os
import numpy as np

import ms_anc_warden_layout as L      # sets meshlib.ATLAS = 2048
import meshlib
from meshlib import Part, Zone, loft, chamfer_box, tube, ngon_ring, mirror_x, limb
from gltf_export import export

STEM = 'ms_anc_warden'
OUT = 'out'
ATL = float(meshlib.ATLAS)


# ── generic helpers ──────────────────────────────────────────────────────

def box_zones(c, s, side_rect, front_rect=None, top_rect=None,
              bot_rect=None, pad=1.04):
    """Per-instance Zones fitted to ONE box, so any box lands inside its
    atlas cell wherever it sits in piece-local space.  The painter then
    dresses each cell by fraction (see the layout header)."""
    cx, cy, cz = c
    hw, hh, hd = s[0] / 2 * pad, s[1] / 2 * pad, s[2] / 2 * pad
    fr = front_rect or side_rect
    tr = top_rect or side_rect
    br = bot_rect or tr
    return {
        '+x': Zone(side_rect, ('z', 'y'), ((cz - hd, cz + hd), (cy + hh, cy - hh))),
        '-x': Zone(side_rect, ('-z', 'y'), ((-cz - hd, -cz + hd), (cy + hh, cy - hh))),
        '-z': Zone(fr, ('x', 'y'), ((cx - hw, cx + hw), (cy + hh, cy - hh))),
        '+z': Zone(fr, ('-x', 'y'), ((-cx - hw, -cx + hw), (cy + hh, cy - hh))),
        '+y': Zone(tr, ('x', 'z'), ((cx - hw, cx + hw), (cz - hd, cz + hd))),
        '-y': Zone(br, ('x', '-z'), ((cx - hw, cx + hw), (-cz - hd, -cz + hd))),
    }


def abox(p, c, s, ch, side_rect, front_rect=None, top_rect=None,
         bot_rect=None, skip=()):
    chamfer_box(p, c, s, ch,
                box_zones(c, s, side_rect, front_rect, top_rect, bot_rect),
                skip=skip)


def disc_zone(rect, cy, cz, r, mirror=False):
    """Zone for a circular joint face lying in the (z,y) plane, centred on
    the disc so the perfect-circle art lands concentric in its cell."""
    k = r * 1.06
    az = (cz + k, cz - k) if mirror else (cz - k, cz + k)
    return Zone(rect, ('z', 'y'), (az, (cy + k, cy - k)))


def band(p, ra, rb, rect, out_fn, v0=0.0, v1=1.0, u0=0.0, u1=1.0):
    """Skin two equal-length rings with parametric UVs into `rect`;
    every quad is wound so its normal agrees with out_fn(centroid)."""
    n = len(ra)
    x0, y0, x1, y1 = rect
    va = (y0 + (y1 - y0) * v0) / ATL
    vb = (y0 + (y1 - y0) * v1) / ATL
    for j in range(n):
        k = (j + 1) % n
        ua = (x0 + (x1 - x0) * (u0 + (u1 - u0) * j / n)) / ATL
        ub = (x0 + (x1 - x0) * (u0 + (u1 - u0) * (j + 1) / n)) / ATL
        quad = [ra[j], ra[k], rb[k], rb[j]]
        uvs = [(ua, va), (ub, va), (ub, vb), (ua, vb)]
        c = np.mean(np.array(quad), axis=0)
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        if np.dot(nrm, out_fn(c)) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)


def zband(p, ra, rb, zone_of, out_fn):
    """Same as band() but each quad picks a Zone (world projection)."""
    n = len(ra)
    for j in range(n):
        k = (j + 1) % n
        quad = [ra[j], ra[k], rb[k], rb[j]]
        c = np.mean(np.array(quad), axis=0)
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        out = out_fn(c)
        if np.dot(nrm, out) < 0:
            quad = quad[::-1]
        p.add_face(quad, zone=zone_of(c, out / max(1e-9, np.linalg.norm(out))))


def cap(p, ring, zone, outward):
    nrm = np.cross(np.asarray(ring[1]) - np.asarray(ring[0]),
                   np.asarray(ring[2]) - np.asarray(ring[0]))
    p.add_face(list(ring), zone=zone, flip=(np.dot(nrm, outward) < 0))


def disc_joint(p, center, r, half_w, wrap_rect, cap_rect):
    """Perfect-circle joint disc on the X axis — the ancient hinge."""
    cx, cy, cz = center
    r0 = ngon_ring((cx - half_w, cy, cz), r, n=L.DISC_N, axis='x')
    r1 = ngon_ring((cx + half_w, cy, cz), r, n=L.DISC_N, axis='x')
    band(p, r0, r1, wrap_rect,
         lambda c: np.array([0.0, c[1] - cy, c[2] - cz]))
    cap(p, r1, disc_zone(cap_rect, cy, cz, r), np.array([1.0, 0, 0]))
    cap(p, r0, disc_zone(cap_rect, cy, cz, r, mirror=True),
        np.array([-1.0, 0, 0]))


def halo(p, center, R, th, ext, n, axis, rect_o, rect_i, rect_e):
    """Free-standing ring (no spokes) around `axis` — the gyro halo and
    the lance emitter.  Outer / inner / two rim bands."""
    cx, cy, cz = center
    ia = 'xyz'.index(axis)
    a0 = (cy if axis == 'y' else cz) - ext / 2
    a1 = a0 + ext

    def ring(rad, along):
        c = list(center)
        c[ia] = along
        return ngon_ring(tuple(c), rad, n=n, axis=axis)

    ri, ro = R - th / 2, R + th / 2

    def radial(sign):
        def f(c):
            v = np.array(c, dtype=float) - np.array([cx, cy, cz], dtype=float)
            v[ia] = 0.0
            return v * sign
        return f

    ax = np.zeros(3)
    ax[ia] = 1.0
    band(p, ring(ro, a0), ring(ro, a1), rect_o, radial(1.0))
    band(p, ring(ri, a0), ring(ri, a1), rect_i, radial(-1.0))
    band(p, ring(ri, a1), ring(ro, a1), rect_e, lambda c: ax, v0=0.0, v1=0.5)
    band(p, ring(ri, a0), ring(ro, a0), rect_e, lambda c: -ax, v0=0.5, v1=1.0)


def extrude_profile(p, prof, half_w, side_zone, wrap_rect):
    """Extruded side profile along X (foot pad), winding-safe."""
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
        u0 = (x0 + (x1 - x0) * acc / total) / ATL
        acc += seg[i]
        u1 = (x0 + (x1 - x0) * acc / total) / ATL
        quad = [(half_w, prof[i][1], prof[i][0]),
                (-half_w, prof[i][1], prof[i][0]),
                (-half_w, prof[j][1], prof[j][0]),
                (half_w, prof[j][1], prof[j][0])]
        uvs = [(u0, y0 / ATL), (u0, y1 / ATL), (u1, y1 / ATL), (u1, y0 / ATL)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        if np.dot(nrm, ctr - centroid) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)


def ring_from_section(sec):
    z, yb, yw, ys, yd, wb, ww, wd, wt = sec
    return [
        (wb, yb, z), (ww, yw, z), (wd, ys, z), (wt, yd, z),
        (-wt, yd, z), (-wd, ys, z), (-ww, yw, z), (-wb, yb, z),
    ]


# ── body: gyro-sphere hip ────────────────────────────────────────────────

def hip_zone(c, n):
    if abs(n[1]) > 0.80:
        return L.A_HIP_CAP
    return L.A_HIP_F if c[2] < 0 else L.A_HIP_B


def build_body():
    p = Part('body')
    ctr = np.array(L.SPHERE_C, dtype=float)
    rings = [ngon_ring((L.SPHERE_C[0], L.SPHERE_C[1] + dy, L.SPHERE_C[2]),
                       r, n=L.SPHERE_N, axis='y')
             for (dy, r) in L.SPHERE_RINGS]
    for i in range(len(rings) - 1):
        zband(p, rings[i], rings[i + 1], hip_zone,
              lambda c: np.array(c, dtype=float) - ctr)
    cap(p, rings[-1], L.A_HIP_CAP, np.array([0.0, 1.0, 0.0]))
    cap(p, rings[0], L.A_HIP_CAP, np.array([0.0, -1.0, 0.0]))

    # open socket collars where the leg discs seat (no caps — a recess)
    cx, cr, chw = L.HIP_COLLAR
    for sx in (1.0, -1.0):
        r0 = ngon_ring((sx * (cx - chw), L.HIP_Y, 0.0), cr, n=L.DISC_N, axis='x')
        r1 = ngon_ring((sx * (cx + chw), L.HIP_Y, 0.0), cr, n=L.DISC_N, axis='x')
        band(p, r0, r1, L.A_TRIM,
             lambda c: np.array([0.0, c[1] - L.HIP_Y, c[2]]))
    return p


# ── gyro: two free-standing halo rings ───────────────────────────────────

def build_gyro():
    p = Part('gyro')
    for (cy, R, th, ext, n) in (L.HALO_UPPER, L.HALO_LOWER):
        halo(p, (0.0, cy, 0.0), R, th, ext, n, 'y',
             L.A_RING_O, L.A_RING_I, L.A_RING_E)
    # orrery pylons seated on the upper halo
    cy, R = L.HALO_UPPER[0], L.HALO_UPPER[1]
    top = cy + L.HALO_UPPER[3] / 2
    for (adeg, pr, ph, pn) in L.PYLONS:
        a = np.radians(adeg)
        px, pz = R * np.cos(a), R * np.sin(a)
        b0 = ngon_ring((px, top - 0.06, pz), pr, n=pn, axis='y')
        b1 = ngon_ring((px, top + ph, pz), pr * 0.82, n=pn, axis='y')
        band(p, b0, b1, L.A_TRIM,
             lambda c, px=px, pz=pz: np.array([c[0] - px, 0.0, c[2] - pz]))
        cap(p, b1, Zone(L.A_CYAN, ('x', 'z'),
                        ((px - pr, px + pr), (pz - pr, pz + pr))),
            np.array([0.0, 1.0, 0.0]))
    return p


# ── turret: torso monolith ───────────────────────────────────────────────

def torso_zone(c, n):
    if n[1] < -0.5:
        return L.A_TORSO_BT
    if abs(n[0]) > 0.62:
        return L.A_TORSO_S
    if n[2] < -0.55:
        return L.A_TORSO_F
    if n[2] > 0.55:
        return L.A_TORSO_B
    return L.A_TORSO_T


def build_turret():
    p = Part('turret')

    # waist drum — a perfect circle so the yaw joint reads seamless
    y0, y1 = L.WAIST_Y
    r0 = ngon_ring((0, y0, 0), L.WAIST_R, n=L.WAIST_N, axis='y')
    r1 = ngon_ring((0, y1, 0), L.WAIST_R, n=L.WAIST_N, axis='y')
    band(p, r0, r1, L.A_WAIST, lambda c: np.array([c[0], 0.0, c[2]]))
    cap(p, r0, L.A_DARK, np.array([0.0, -1.0, 0.0]))

    # monolith
    rings = [ring_from_section(s) for s in L.TORSO_SECTIONS]
    loft(p, rings, torso_zone, cap_start=L.A_TORSO_F, cap_end=L.A_TORSO_B)

    # shoulder slabs
    px, py, pz, pw, ph, pd = L.PAULDRON
    for sx in (1.0, -1.0):
        abox(p, (sx * px, py, pz), (pw, ph, pd), 0.06,
             L.A_PAULD_S, L.A_PAULD_S, L.A_PAULD_T)

    # chest core lens — proud circular boss, cyan iris
    lx, ly, lz = L.LENS_C
    ro = ngon_ring((lx, ly, lz + L.LENS_D), L.LENS_R, n=L.LENS_N, axis='z')
    rf = ngon_ring((lx, ly, lz), L.LENS_R * 0.94, n=L.LENS_N, axis='z')
    band(p, ro, rf, L.A_TRIM, lambda c: np.array([c[0] - lx, c[1] - ly, 0.0]))
    cap(p, rf, Zone(L.A_LENS, ('x', 'y'),
                    ((lx - L.LENS_R, lx + L.LENS_R), (ly + L.LENS_R, ly - L.LENS_R))),
        np.array([0.0, 0.0, -1.0]))

    # lance shoulder socket ring (perfect circle on the +x flank)
    sx_, sy_, sz_ = L.SOCKET_C
    s0 = ngon_ring((sx_ - L.SOCKET_W, sy_, sz_), L.SOCKET_R, n=L.DISC_N, axis='x')
    s1 = ngon_ring((sx_ + L.SOCKET_W, sy_, sz_), L.SOCKET_R, n=L.DISC_N, axis='x')
    band(p, s0, s1, L.A_TRIM,
         lambda c: np.array([0.0, c[1] - sy_, c[2] - sz_]))

    # rear cantilever counterweight
    limb(p, L.BOOM_A, L.BOOM_B, L.BOOM_R[0], L.BOOM_R[1], L.A_TRIM, n=6)
    bx, by, bz, bw, bh, bd = L.BOOM_BLOCK
    abox(p, (bx, by, bz), (bw, bh, bd), 0.05, L.A_BOOM, L.A_BOOM, L.A_BOOM)
    return p


# ── head: sensor cowl ────────────────────────────────────────────────────

def build_head():
    p = Part('head')
    x, y, z, w, h, d = L.COWL_HOOD
    abox(p, (x, y, z), (w, h, d), 0.09, L.A_COWL_S, L.A_COWL_F, L.A_COWL_T)
    x, y, z, w, h, d = L.COWL_VISOR
    abox(p, (x, y, z), (w, h, d), 0.04, L.A_VISOR, L.A_VISOR, L.A_VISOR)
    x, y, z, w, h, d = L.COWL_CREST
    abox(p, (x, y, z), (w, h, d), 0.05, L.A_CREST, L.A_CREST, L.A_CREST)
    x, y, z, w, h, d = L.COWL_SIGIL
    abox(p, (x, y, z), (w, h, d), 0.015, L.A_SIGIL, L.A_SIGIL, L.A_SIGIL,
         skip=('-y',))
    return p


# ── barrel: shoulder lance ───────────────────────────────────────────────

def build_barrel():
    p = Part('barrel')
    yx, yr, yw = L.YOKE
    disc_joint(p, (yx, 0.0, 0.0), yr, yw, L.A_JOINT, L.A_JCAP)
    x, y, z, w, h, d = L.LANCE_BREECH
    abox(p, (x, y, z), (w, h, d), 0.07, L.A_BREECH, L.A_BREECH, L.A_BREECH)
    tube(p, L.LANCE_TUBE, L.A_LANCE_W, n=8,
         cap_start=Zone(L.A_BREECH, ('x', 'y'),
                        ((-0.45, 0.45), (0.45, -0.45))),
         cap_end=Zone(L.A_EMIT, ('x', 'y'), ((-0.24, 0.24), (0.24, -0.24))))
    x, y, z, w, h, d = L.LANCE_CHANNEL
    abox(p, (x, y, z), (w, h, d), 0.04, L.A_LANCE_S, L.A_LANCE_S, L.A_LANCE_T)
    ez, eR, eth, eext, en = L.EMITTER
    halo(p, (0.0, 0.0, ez), eR, eth, eext, en, 'z',
         L.A_RING_O, L.A_RING_I, L.A_RING_E)
    return p


# ── legs ─────────────────────────────────────────────────────────────────

def build_thigh_l():
    p = Part('thigh_l')
    dx, dr, dw = L.HIP_DISC
    disc_joint(p, (dx, 0.0, 0.0), dr, dw, L.A_JOINT, L.A_JCAP)
    limb(p, (0, -0.06, 0.0), L.KNEE, L.THIGH_R[0], L.THIGH_R[1], L.A_LIMB_TH)
    x, y, z, w, h, d = L.THIGH_PLATE
    abox(p, (x, y, z), (w, h, d), 0.05, L.A_PLATE_S, L.A_PLATE_F, L.A_PLATE_F)
    kx, kr, kw = L.KNEE_DISC
    disc_joint(p, (kx, L.KNEE[1], L.KNEE[2]), kr, kw, L.A_JOINT2, L.A_JCAP2)
    return p


def build_shin_l():
    p = Part('shin_l')
    limb(p, (0, 0.0, 0.0), L.ANKLE, L.SHIN_R[0], L.SHIN_R[1], L.A_LIMB_SH)
    x, y, z, w, h, d = L.SHIN_PLATE
    abox(p, (x, y, z), (w, h, d), 0.05, L.A_PLATE_S, L.A_PLATE_F, L.A_PLATE_F)
    ax, ar, aw = L.ANKL_DISC
    disc_joint(p, (ax, L.ANKLE[1], L.ANKLE[2]), ar, aw, L.A_JOINT2, L.A_JCAP2)
    return p


def build_foot_l():
    p = Part('foot_l')
    extrude_profile(p, L.FOOT_PROFILE, L.FOOT_HALF_W, L.A_FOOT_S, L.A_FOOT_W)
    x, y, z, w, h, d = L.FOOT_PLATE
    abox(p, (x, y, z), (w, h, d), 0.05, L.A_PLATE_S, L.A_PLATE_F, L.A_FOOT_T)
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
    f = -(thigh + shin) * L.WALK_FOOT_COMP
    return max(-L.WALK_FOOT_CLAMP, min(L.WALK_FOOT_CLAMP, f))


def rot_keys(times, degs, q=qx):
    return [(t, q(d)) for t, d in zip(times, degs)]


def build_clips():
    n = len(L.WALK_THIGH)
    wt = [L.WALK_T * i / (n - 1) for i in range(n)]
    half = (n - 1) // 2

    def shifted(tbl):
        return [tbl[(i + half) % (n - 1)] for i in range(n - 1)] + \
               [tbl[half % (n - 1)]]

    thigh_r = shifted(L.WALK_THIGH)
    shin_r = shifted(L.WALK_SHIN)
    walk = {
        'name': 'walk',
        'channels': [
            ('thigh_l', 'rotation', rot_keys(wt, L.WALK_THIGH)),
            ('shin_l', 'rotation', rot_keys(wt, L.WALK_SHIN)),
            ('foot_l', 'rotation', rot_keys(
                wt, [foot_comp(a, b)
                     for a, b in zip(L.WALK_THIGH, L.WALK_SHIN)])),
            ('thigh_r', 'rotation', rot_keys(wt, thigh_r)),
            ('shin_r', 'rotation', rot_keys(wt, shin_r)),
            ('foot_r', 'rotation', rot_keys(
                wt, [foot_comp(a, b) for a, b in zip(thigh_r, shin_r)])),
            ('body', 'translation', [(t, (dx, dy, 0.0)) for t, dx, dy
                                     in zip(wt, L.WALK_BODY_X, L.WALK_BODY_Y)]),
            ('gyro', 'rotation', [(t, qmul(qy(s), qx(0.0)))
                                  for t, s in zip(wt, L.WALK_GYRO_SPIN)]),
            ('turret', 'rotation', rot_keys(wt, L.WALK_TORSO_YAW, q=qy)),
            ('head', 'rotation', rot_keys(wt, L.WALK_HEAD_YAW, q=qy)),
            ('barrel', 'rotation', rot_keys(wt, L.WALK_LANCE_PITCH)),
        ],
    }

    it = L.IDLE_KEYS
    head_q = [qmul(qy(y), qx(pt))
              for y, pt in zip(L.IDLE_HEAD_YAW, L.IDLE_HEAD_PITCH)]
    idle = {
        'name': 'idle',
        'channels': [
            ('head', 'rotation', list(zip(it, head_q))),
            ('turret', 'rotation', rot_keys(it, L.IDLE_TORSO_YAW, q=qy)),
            ('gyro', 'rotation', rot_keys(it, L.IDLE_GYRO_SPIN, q=qy)),
            ('body', 'translation', [(t, (0.0, dy, 0.0))
                                     for t, dy in zip(it, L.IDLE_BODY_Y)]),
            ('barrel', 'rotation', rot_keys(it, L.IDLE_LANCE_PITCH)),
        ],
    }
    return [walk, idle]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    body = build_body()
    gyro = build_gyro()
    turret = build_turret()
    head = build_head()
    barrel = build_barrel()
    tl, sl, fl = build_thigh_l(), build_shin_l(), build_foot_l()
    tr = mirror_x(tl, 'thigh_r')
    sr = mirror_x(sl, 'shin_r')
    fr = mirror_x(fl, 'foot_r')
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=body),          # 0
        dict(name='gyro', parent=0, offset=L.GYRO_OFF, part=gyro),          # 1
        dict(name='turret', parent=0, offset=L.TORSO_OFF, part=turret),     # 2
        dict(name='head', parent=2, offset=L.HEAD_OFF, part=head),          # 3
        dict(name='barrel', parent=2, offset=L.LANCE_OFF, part=barrel),     # 4
        dict(name='muzzle', parent=4, offset=L.MUZZLE_OFF, part=None),      # 5
        dict(name='thigh_l', parent=0, offset=(L.HIP_X, L.HIP_Y, 0), part=tl),
        dict(name='shin_l', parent=6, offset=L.KNEE, part=sl),              # 7
        dict(name='foot_l', parent=7, offset=L.ANKLE, part=fl),             # 8
        dict(name='thigh_r', parent=0, offset=(-L.HIP_X, L.HIP_Y, 0), part=tr),
        dict(name='shin_r', parent=9, offset=L.KNEE, part=sr),              # 10
        dict(name='foot_r', parent=10, offset=L.ANKLE, part=fr),            # 11
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
