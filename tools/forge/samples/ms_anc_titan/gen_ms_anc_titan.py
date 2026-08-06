"""gen_ms_anc_titan — assemble ms_anc_titan (Titan warframe) and export.

ANCIENT s4 HERO, ~26 m quadruped. Cathedral hull lofted as one unbroken
monolith, carried on four fluted columnar legs; dorsal main lance on
turret/barrel/muzzle; chin repeater on turret2/barrel2/muzzle2; command
spire at the stern under a floating halo ring; raised cyan power-vein
rails running the hull's full length so they read from the horizon.

Clips: walk (lateral-sequence quadruped gait, ground-solved body Y,
seamless) + idle (spire scan + halo turn + vein breath).

Run: python3 gen_ms_anc_titan.py  → out/ms_anc_titan{,_png}.gltf + .bin
"""
from __future__ import annotations
import os
import numpy as np

import ms_anc_titan_layout as L        # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, loft, chamfer_box, tube, ngon_ring, limb, mirror_x
from gltf_export import export

STEM = 'ms_anc_titan'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')


# ── helpers ─────────────────────────────────────────────────────────────

def box(p, center, size, zones, ch=0.10, skip=()):
    chamfer_box(p, center, size, ch, zones, skip=skip)


def box1(p, center, size, zone, ch=0.10, skip=()):
    """Precise machined box, one zone on every face (ancient monolith)."""
    chamfer_box(p, center, size, ch,
                {k: zone for k in ('+x', '-x', '+y', '-y', '+z', '-z')},
                skip=skip)


def drum(p, center, r, half_w, rect=None, cap_zone=None, n=8):
    """n-gon bearing drum along X — the visible hip/knee/ankle/trunnion."""
    rect = rect or L.C_JOINT
    cx0, cy0, cx1, cy1 = rect
    r0 = ngon_ring((center[0] - half_w, center[1], center[2]), r, n=n, axis='x')
    r1 = ngon_ring((center[0] + half_w, center[1], center[2]), r, n=n, axis='x')
    for j in range(n):
        k = (j + 1) % n
        u0 = (cx0 + (cx1 - cx0) * j / n) / M.ATLAS
        u1 = (cx0 + (cx1 - cx0) * (j + 1) / n) / M.ATLAS
        quad = [r0[j], r0[k], r1[k], r1[j]]
        uvs = [(u0, cy0 / M.ATLAS), (u1, cy0 / M.ATLAS),
               (u1, cy1 / M.ATLAS), (u0, cy1 / M.ATLAS)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        rad = ctr - np.array([ctr[0], center[1], center[2]])
        if np.dot(nrm, rad) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)
    for (ring, out) in ((r1, 1.0), (r0, -1.0)):
        p.add_face(list(ring), zone=cap_zone or L.C_JOINT_CAP, flip=(out < 0))


def flutes(p, p0, p1, r, count, fr, rect):
    """Cathedral column fluting: slim ridges rung around a limb axis."""
    a = np.asarray(p0, float)
    b = np.asarray(p1, float)
    d = b - a
    ln = np.linalg.norm(d)
    if ln < 1e-9:
        return
    d /= ln
    ref = np.array([1.0, 0.0, 0.0]) if abs(d[0]) < 0.9 else np.array([0.0, 0.0, 1.0])
    u = np.cross(d, ref)
    u /= np.linalg.norm(u)
    v = np.cross(d, u)
    for i in range(count):
        ang = 2 * np.pi * i / count + np.pi / count
        off = u * (r * np.cos(ang)) + v * (r * np.sin(ang))
        limb(p, tuple(a + off), tuple(b + off * 0.86), fr, fr * 0.78, rect, n=3)


def disc(p, center, r, zone, n=12, axis='z', flip=False):
    ring = ngon_ring(center, r, n=n, axis=axis)
    p.add_face(list(ring), zone=zone, flip=flip)


def ring_solid(p, center, r, h, n, zone, cap_top=True, cap_bot=False):
    """Vertical n-gon drum about +Y."""
    cx, cy, cz = center
    r0 = ngon_ring((cx, cy, cz), r, n=n, axis='y')
    r1 = ngon_ring((cx, cy + h, cz), r, n=n, axis='y')
    for j in range(n):
        k = (j + 1) % n
        quad = [r0[j], r0[k], r1[k], r1[j]]
        c = np.mean(np.array(quad), axis=0)
        rad = np.array([c[0] - cx, 0.0, c[2] - cz])
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        if np.dot(nrm, rad) < 0:
            quad = quad[::-1]
        p.add_face(quad, zone=zone)
    if cap_top:
        p.add_face(list(r1), zone=zone, flip=True)      # +Y
    if cap_bot:
        p.add_face(list(r0), zone=zone, flip=False)     # -Y


def annulus(p, center, r_out, r_in, h, n, zone):
    """Perfect floating ring — top/bottom annular faces + both rims."""
    cx, cy, cz = center
    ot = ngon_ring((cx, cy + h / 2, cz), r_out, n=n, axis='y')
    ob = ngon_ring((cx, cy - h / 2, cz), r_out, n=n, axis='y')
    it = ngon_ring((cx, cy + h / 2, cz), r_in, n=n, axis='y')
    ib = ngon_ring((cx, cy - h / 2, cz), r_in, n=n, axis='y')
    for j in range(n):
        k = (j + 1) % n
        p.add_face([it[j], it[k], ot[k], ot[j]], zone=zone, flip=True)
        p.add_face([ib[j], ib[k], ob[k], ob[j]], zone=zone)
        p.add_face([ob[j], ob[k], ot[k], ot[j]], zone=zone, flip=True)
        p.add_face([ib[j], ib[k], it[k], it[j]], zone=zone)


# ── hull ────────────────────────────────────────────────────────────────

def hull_zone(c, n):
    if n[1] < -0.45:
        return L.C_UNDER
    if abs(n[0]) > 0.55:
        return L.C_HULL_SIDE
    if n[2] < -0.60:
        return L.C_PROW
    if n[2] > 0.60:
        return L.C_HULL_REAR
    return L.C_HULL_TOP


def ring_from_section(sec):
    z = sec[0]
    ys = sec[1:7]
    ws = sec[7:13]
    right = [(ws[i], ys[i], z) for i in range(6)]
    left = [(-ws[i], ys[i], z) for i in range(5, -1, -1)]
    return right + left


def vein_points(level, out, dy):
    """Sample a vein rail along the hull loft at a named section level."""
    li = L.LEVELS.index(level)
    pts = []
    for sec in L.HULL_SECTIONS:
        z = sec[0]
        y = sec[1 + li] + dy
        x = sec[7 + li] * out
        pts.append((x, y, z))
    return pts


def build_body():
    p = Part('body')

    # ── the monolith: one unbroken cathedral loft, prow to stern ──
    rings = [ring_from_section(s) for s in L.HULL_SECTIONS]
    loft(p, rings, hull_zone, cap_start=L.C_PROW, cap_end=L.C_HULL_REAR)

    # prow ram wedge (a second, sharper blade ahead of the keel)
    wr = []
    for (z, yb, yt, hw) in reversed(L.PROW_WEDGE):   # loft must run +Z
        wr.append([(hw, yb, z), (hw, yt, z), (-hw, yt, z), (-hw, yb, z)])
    loft(p, wr, lambda c, n: L.C_PROW if abs(n[2]) > 0.5 else
         (L.C_UNDER if n[1] < -0.4 else L.C_HULL_SIDE), cap_start=L.C_PROW)

    # dorsal spine ridge + recessed deck tracery panel
    box1(p, (L.SPINE[0], L.SPINE[1], L.SPINE[2]), L.SPINE[3:6],
         L.C_DECK, ch=0.16, skip=('-y',))
    x, y, z, w, h, d = L.DECK_PANEL
    box(p, (x, y, z), (w, h, d),
        {'+y': L.C_TRACERY, '+x': L.C_DECK, '-x': L.C_DECK,
         '+z': L.C_DECK, '-z': L.C_DECK}, ch=0.07, skip=('-y',))

    # cantilevered leg buttresses
    for (bx, by, bz) in L.BUTTRESS:
        box(p, (bx, by, bz), L.BUTTRESS_SIZE,
            {'+y': L.C_SHOULDER, '-y': L.C_UNDER, '+x': L.C_HULL_SIDE,
             '-x': L.C_HULL_SIDE, '+z': L.C_HULL_SIDE, '-z': L.C_HULL_SIDE},
            ch=0.22)

    # banner recess plates — team read, both flanks
    for (bx, by, bz) in L.BANNER_PLATE:
        box(p, (bx, by, bz), L.BANNER_SIZE,
            {'+x': L.C_BANNER, '-x': L.C_BANNER, '+y': L.C_GLYPH,
             '-y': L.C_GLYPH, '+z': L.C_GLYPH, '-z': L.C_GLYPH}, ch=0.09)

    # prow core: housing + cyan lens disc, and the ventral belly core
    x, y, z, w, h, d = L.CORE_HOUSING
    box(p, (x, y, z), (w, h, d),
        {'-z': L.C_CORE, '+z': L.C_PROW, '+y': L.C_PROW, '-y': L.C_PROW,
         '+x': L.C_PROW, '-x': L.C_PROW}, ch=0.12)
    disc(p, L.CORE_DISC, L.CORE_R, L.C_CORE, n=16, axis='z', flip=True)
    disc(p, L.BELLY_DISC, L.BELLY_R, L.C_CORE, n=12, axis='y')  # -Y

    # flying ribs, both sides
    for (a, b, c) in L.RIBS:
        for s in (1, -1):
            sa = (a[0] * s, a[1], a[2])
            sb = (b[0] * s, b[1], b[2])
            sc = (c[0] * s, c[1], c[2])
            limb(p, sa, sb, L.RIB_R, L.RIB_R * 0.92, L.C_RIB, n=4)
            limb(p, sb, sc, L.RIB_R * 0.92, L.RIB_R * 0.8, L.C_RIB, n=4)

    # forward-raked cathedral crest over the prow
    for (a, b, c) in L.PROW_HORNS:
        for sgn in (1, -1):
            sa = (a[0] * sgn, a[1], a[2])
            sb = (b[0] * sgn, b[1], b[2])
            sc = (c[0] * sgn, c[1], c[2])
            limb(p, sa, sb, L.HORN_R, L.HORN_R * 0.9, L.C_RIB, n=4)
            limb(p, sb, sc, L.HORN_R * 0.9, L.HORN_R * 0.5, L.C_RIB, n=4)

    # stern vanes
    for (vx, vy, vz) in L.VANES:
        box1(p, (vx, vy, vz), L.VANE_SIZE, L.C_HULL_REAR, ch=0.08)

    # ── cyan power veins: raised rails riding the loft, full length ──
    for (level, out, dy) in L.VEIN_RAILS:
        pts = vein_points(level, out, dy)
        for s in (1, -1):
            sp = [(px * s, py, pz) for (px, py, pz) in pts]
            for a, b in zip(sp, sp[1:]):
                limb(p, a, b, L.VEIN_R, L.VEIN_R, L.C_VEIN, n=3)
    for (a, b) in L.VEIN_DROPS:
        for s in (1, -1):
            limb(p, (a[0] * s, a[1], a[2]), (b[0] * s, b[1], b[2]),
                 L.VEIN_R * 0.9, L.VEIN_R * 0.9, L.C_VEIN, n=3)
    return p


# ── legs ────────────────────────────────────────────────────────────────

def build_thigh(name, knee):
    p = Part(name)
    drum(p, (0.0, 0.0, 0.0), L.HIP_DRUM[0], L.HIP_DRUM[1], n=10)
    limb(p, (0.0, -0.15, 0.0), knee, L.THIGH_R0, L.THIGH_R1, L.C_THIGH, n=8)
    flutes(p, (0.0, -0.30, 0.0), knee, L.THIGH_R0 * 0.96, L.FLUTE_N,
           L.FLUTE_R, L.C_FLUTE)
    x, y, z, w, h, d = L.THIGH_PLATE
    box(p, (x + knee[0] * 0.5, y, z + knee[2] * 0.5), (w, h, d),
        {'+x': L.C_LEG_PLATE, '-x': L.C_LEG_PLATE, '+z': L.C_LEG_PLATE,
         '-z': L.C_LEG_PLATE, '+y': L.C_DARK, '-y': L.C_DARK}, ch=0.14)
    drum(p, knee, L.KNEE_DRUM[0], L.KNEE_DRUM[1], n=10)
    # vein filament down the column
    limb(p, (0.0, -0.6, -L.THIGH_R0 * 0.92),
         (knee[0], knee[1] + 0.5, knee[2] - L.THIGH_R1 * 0.92),
         0.11, 0.10, L.C_VEIN, n=3)
    return p


def build_shin(name, ankle):
    p = Part(name)
    limb(p, (0.0, 0.0, 0.0), ankle, L.SHIN_R0, L.SHIN_R1, L.C_SHIN, n=8)
    flutes(p, (0.0, -0.10, 0.0), ankle, L.SHIN_R0 * 0.95, L.FLUTE_N,
           L.FLUTE_R * 0.9, L.C_FLUTE)
    x, y, z, w, h, d = L.SHIN_PLATE
    box(p, (x + ankle[0] * 0.5, y, z + ankle[2] * 0.5), (w, h, d),
        {'+x': L.C_LEG_PLATE, '-x': L.C_LEG_PLATE, '+z': L.C_LEG_PLATE,
         '-z': L.C_LEG_PLATE, '+y': L.C_DARK, '-y': L.C_DARK}, ch=0.12)
    drum(p, ankle, L.ANKLE_DRUM[0], L.ANKLE_DRUM[1], n=8)
    limb(p, (0.0, -0.4, -L.SHIN_R0 * 0.92),
         (ankle[0], ankle[1] + 0.45, ankle[2] - L.SHIN_R1 * 0.92),
         0.10, 0.09, L.C_VEIN, n=3)
    return p


def build_foot(name):
    p = Part(name)
    for i, (x, y, z, w, h, d) in enumerate(L.FOOT_STACK):
        zones = {'+y': L.C_FOOT_TOP, '-y': L.C_SOLE,
                 '+x': L.C_FOOT_SIDE, '-x': L.C_FOOT_SIDE,
                 '+z': L.C_FOOT_SIDE, '-z': L.C_FOOT_SIDE}
        box(p, (x, y, z), (w, h, d), zones, ch=0.10,
            skip=('-y',) if i < len(L.FOOT_STACK) - 1 else ())
    return p


# ── dorsal main lance ───────────────────────────────────────────────────

def build_turret():
    p = Part('turret')
    ring_solid(p, (0.0, -0.20, 0.0), L.RING_R, L.RING_H, L.RING_N,
               L.C_YOKE, cap_top=True)
    x, y, z, w, h, d = L.YOKE_BASE
    box1(p, (x, y, z), (w, h, d), L.C_YOKE, ch=0.14)
    for (ax, ay, az) in L.YOKE_ARMS:
        box1(p, (ax, ay, az), L.YOKE_ARM_SIZE, L.C_YOKE, ch=0.10)
        drum(p, (ax * 1.16, L.TRUNNION_Y, L.BARREL_OFF[2]), L.TRUNNION_R,
             L.TRUNNION_HW, n=10)
    # cyan tracery rails up the yoke arms
    for s in (1, -1):
        limb(p, (s * 1.66, 1.00, -1.15), (s * 1.66, 2.85, -1.15),
             0.16, 0.16, L.C_VEIN, n=3)
    return p


def build_barrel():
    p = Part('barrel')
    x, y, z, w, h, d = L.LANCE_RECEIVER
    box(p, (x, y, z), (w, h, d),
        {'+x': L.C_RECEIVER, '-x': L.C_RECEIVER, '+y': L.C_RECEIVER,
         '-y': L.C_RECEIVER, '+z': L.C_RECEIVER, '-z': L.C_RECEIVER},
        ch=0.16)
    tube(p, L.LANCE_TUBE, L.C_LANCE, n=L.LANCE_N,
         cap_start=L.C_RECEIVER, cap_end=None)
    for (z0, z1, r) in L.LANCE_RINGS:
        tube(p, [(z0, r), (z1, r)], L.C_TRIM, n=L.LANCE_N)
    for (rx, ry) in L.LANCE_RAILS:
        box1(p, (rx, ry, L.LANCE_RAIL_Z), L.LANCE_RAIL_SIZE,
             L.C_TRIM_BOX, ch=0.07)
        limb(p, (rx * 1.22, ry, L.LANCE_RAIL_Z + 5.6),
             (rx * 1.22, ry, L.LANCE_RAIL_Z - 5.6), 0.15, 0.15, L.C_VEIN, n=3)
    # emitter crown: prongs around a cyan aperture
    for i in range(L.EMITTER_PRONGS):
        a = 2 * np.pi * i / L.EMITTER_PRONGS + np.pi / L.EMITTER_PRONGS
        p0 = (np.cos(a) * L.EMITTER_R0, np.sin(a) * L.EMITTER_R0,
              L.EMITTER_BASE_Z)
        p1 = (np.cos(a) * L.EMITTER_R1, np.sin(a) * L.EMITTER_R1,
              L.EMITTER_TIP_Z)
        limb(p, p0, p1, 0.28, 0.16, L.C_TRIM, n=4)
    disc(p, (0.0, 0.0, L.EMITTER_BASE_Z - 0.05), L.EMITTER_RING_R,
         L.C_EMITTER, n=12, axis='z', flip=True)
    return p


# ── chin repeater ───────────────────────────────────────────────────────

def build_turret2():
    p = Part('turret2')
    ring_solid(p, (0.0, -L.REP_BALL_H / 2, 0.0), L.REP_BALL_R, L.REP_BALL_H,
               L.REP_BALL_N, L.C_REP_BODY, cap_top=True, cap_bot=True)
    x, y, z, w, h, d = L.REP_HOUSING
    box1(p, (x, y, z), (w, h, d), L.C_REP_BODY, ch=0.10)
    return p


def build_barrel2():
    p = Part('barrel2')
    x, y, z, w, h, d = L.REP_BLOCK
    box1(p, (x, y, z), (w, h, d), L.C_REP_BODY, ch=0.10)
    for (tx, ty) in L.REP_TUBES:
        tube(p, [(sz, sr, ty) for (sz, sr) in L.REP_TUBE], L.C_REP_WRAP,
             n=L.REP_N, xoff=tx)
    disc(p, (0.0, 0.0, -3.10), 0.52, L.C_EMITTER, n=10, axis='z', flip=True)
    return p


# ── spire + halo ────────────────────────────────────────────────────────

def spire_zone(c, n):
    if n[1] > 0.7:
        return L.C_SPIRE_TOP
    return L.C_SPIRE_SIDE


def build_spire():
    p = Part('spire')
    x, y, z, w, h, d = L.SPIRE_PLINTH
    box1(p, (x, y, z), (w, h, d), L.C_SPIRE_TOP, ch=0.10, skip=('-y',))
    rings = [ngon_ring((0.0, sy, 0.0), hw, n=L.SPIRE_N, axis='y')
             for (sy, hw) in L.SPIRE_SECTIONS]
    loft(p, rings, spire_zone, cap_end=L.C_SPIRE_TOP)
    for (vx, vy, vz) in L.SPIRE_VANES:
        size = (L.SPIRE_VANE_SIZE if abs(vz) > abs(vx) else
                (L.SPIRE_VANE_SIZE[2], L.SPIRE_VANE_SIZE[1],
                 L.SPIRE_VANE_SIZE[0]))
        box1(p, (vx, vy, vz), size, L.C_SPIRE_SIDE, ch=0.06)
    ring_solid(p, (0.0, L.SPIRE_LENS_Y - 0.30, 0.0), L.SPIRE_LENS_R, 0.60,
               12, L.C_LENS, cap_top=False)
    disc(p, (0.0, L.SPIRE_LENS_Y + 0.32, 0.0), L.SPIRE_LENS_R * 0.92,
         L.C_LENS, n=12, axis='y', flip=True)
    for (fx, fy, fz) in L.SPIRE_FILAMENTS:
        limb(p, (fx, fy - 0.6, fz), (fx * 0.45, fy + 1.5, fz * 0.45),
             0.09, 0.06, L.C_FILAMENT, n=3)
    return p


def build_halo():
    p = Part('halo')
    annulus(p, (0.0, 0.0, 0.0), L.HALO_R_OUT, L.HALO_R_IN, L.HALO_H,
            L.HALO_N, L.C_HALO)
    return p


# ── clips ───────────────────────────────────────────────────────────────

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


def rot_keys(times, degs, q=qx):
    return [(t, q(d)) for t, d in zip(times, degs)]


def foot_comp(thigh, shin):
    f = -(thigh + shin) * L.WALK_FOOT_COMP
    return max(-L.WALK_FOOT_CLAMP, min(L.WALK_FOOT_CLAMP, f))


def shifted(tbl, k):
    n = len(tbl)
    return [tbl[(i + k) % n] for i in range(n)]


def _roty(vec, deg):
    """Y component of vec after a rotation about X by `deg`."""
    t = np.radians(deg)
    return vec[1] * np.cos(t) - vec[2] * np.sin(t)


LEG_SPEC = [
    ('fl', 1, L.HIP_Z_F, L.KNEE_F, L.ANKLE_F),
    ('fr', -1, L.HIP_Z_F, L.KNEE_F, L.ANKLE_F),
    ('hl', 1, L.HIP_Z_H, L.KNEE_H, L.ANKLE_H),
    ('hr', -1, L.HIP_Z_H, L.KNEE_H, L.ANKLE_H),
]


def leg_tables():
    """Per-leg (thigh, shin, foot) angle tables, phase-shifted, closed."""
    out = {}
    for (tag, _s, _z, _k, _a) in LEG_SPEC:
        k = L.PHASE[tag]
        th = shifted(L.WALK_THIGH, k)
        sh = shifted(L.WALK_SHIN, k)
        ft = [foot_comp(a, b) for a, b in zip(th, sh)]
        out[tag] = (th + [th[0]], sh + [sh[0]], ft + [ft[0]])
    return out


def ground_solve(tabs):
    """Body Y per key: plant the lowest foot exactly on the ground."""
    n = L.WALK_KEYS + 1
    dy = []
    for i in range(n):
        lowest = 1e9
        for (tag, _s, _z, knee, ankle) in LEG_SPEC:
            th, sh, ft = tabs[tag]
            t1, t2, t3 = th[i], sh[i], ft[i]
            y = L.HIP_Y + _roty(knee, t1) + _roty(ankle, t1 + t2)
            for zs in (-L.FOOT_Z_SPAN, 0.0, L.FOOT_Z_SPAN):
                yy = y + _roty((0.0, L.FOOT_BOTTOM, zs), t1 + t2 + t3)
                lowest = min(lowest, yy)
        dy.append(-lowest)
    return dy


def build_clips():
    tabs = leg_tables()
    n = L.WALK_KEYS + 1
    wt = [L.WALK_T * i / (n - 1) for i in range(n)]
    dy = ground_solve(tabs)

    def close(tbl):
        return tbl + [tbl[0]]

    body_q = [qmul(qy(y), qz(r))
              for y, r in zip(close(L.WALK_BODY_YAW), close(L.WALK_BODY_ROLL))]
    ch = [
        ('body', 'translation', [(t, (0.0, float(v), 0.0))
                                 for t, v in zip(wt, dy)]),
        ('body', 'rotation', list(zip(wt, body_q))),
        ('turret', 'rotation', rot_keys(wt, close(L.WALK_TURRET_YAW), q=qy)),
        ('barrel', 'rotation', rot_keys(wt, close(L.WALK_LANCE_PITCH))),
        ('spire', 'rotation', rot_keys(wt, close(L.WALK_SPIRE_YAW), q=qy)),
        ('halo', 'rotation', rot_keys(wt, close(L.WALK_HALO_YAW) [:-1]
                                      + [-360.0], q=qy)),
    ]
    for (tag, _s, _z, _k, _a) in LEG_SPEC:
        th, sh, ft = tabs[tag]
        ch.append((f'thigh_{tag}', 'rotation', rot_keys(wt, th)))
        ch.append((f'shin_{tag}', 'rotation', rot_keys(wt, sh)))
        ch.append((f'foot_{tag}', 'rotation', rot_keys(wt, ft)))
    walk = {'name': 'walk', 'channels': ch}

    it = L.IDLE_KEYS
    spire_q = [qmul(qy(y), qx(p_))
               for y, p_ in zip(L.IDLE_SPIRE_YAW, L.IDLE_SPIRE_PITCH)]
    idle = {
        'name': 'idle',
        'channels': [
            ('body', 'translation', [(t, (0.0, float(v), 0.0))
                                     for t, v in zip(it, L.IDLE_BODY_Y)]),
            ('spire', 'rotation', list(zip(it, spire_q))),
            ('halo', 'rotation', rot_keys(it, L.IDLE_HALO_YAW, q=qy)),
            ('turret', 'rotation', rot_keys(it, L.IDLE_TURRET_YAW, q=qy)),
            ('barrel', 'rotation', rot_keys(it, L.IDLE_LANCE_PITCH)),
        ],
    }
    return [walk, idle]


# ── assembly ────────────────────────────────────────────────────────────

def build_all():
    body = build_body()
    turret = build_turret()
    barrel = build_barrel()
    turret2 = build_turret2()
    barrel2 = build_barrel2()
    spire = build_spire()
    halo = build_halo()

    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=body),           # 0
        dict(name='turret', parent=0, offset=L.TURRET_OFF, part=turret),     # 1
        dict(name='barrel', parent=1, offset=L.BARREL_OFF, part=barrel),     # 2
        dict(name='muzzle', parent=2, offset=L.MUZZLE_OFF, part=None),       # 3
        dict(name='turret2', parent=0, offset=L.TURRET2_OFF, part=turret2),  # 4
        dict(name='barrel2', parent=4, offset=L.BARREL2_OFF, part=barrel2),  # 5
        dict(name='muzzle2', parent=5, offset=L.MUZZLE2_OFF, part=None),     # 6
        dict(name='spire', parent=0, offset=L.SPIRE_OFF, part=spire),        # 7
        dict(name='halo', parent=0, offset=L.HALO_OFF, part=halo),           # 8
    ]

    thigh_f = build_thigh('thigh_fl', L.KNEE_F)
    shin_f = build_shin('shin_fl', L.ANKLE_F)
    foot_f = build_foot('foot_fl')
    thigh_h = build_thigh('thigh_hl', L.KNEE_H)
    shin_h = build_shin('shin_hl', L.ANKLE_H)
    foot_h = build_foot('foot_hl')

    for (tag, s, hz, knee, ankle) in LEG_SPEC:
        front = tag[0] == 'f'
        th = thigh_f if front else thigh_h
        sh = shin_f if front else shin_h
        ft = foot_f if front else foot_h
        if s > 0:
            thp = Part(f'thigh_{tag}')
            thp.pos, thp.nrm, thp.uv, thp.idx = (list(th.pos), list(th.nrm),
                                                 list(th.uv), list(th.idx))
            shp = Part(f'shin_{tag}')
            shp.pos, shp.nrm, shp.uv, shp.idx = (list(sh.pos), list(sh.nrm),
                                                 list(sh.uv), list(sh.idx))
            ftp = Part(f'foot_{tag}')
            ftp.pos, ftp.nrm, ftp.uv, ftp.idx = (list(ft.pos), list(ft.nrm),
                                                 list(ft.uv), list(ft.idx))
            k, a = knee, ankle
        else:
            thp = mirror_x(th, f'thigh_{tag}')
            shp = mirror_x(sh, f'shin_{tag}')
            ftp = mirror_x(ft, f'foot_{tag}')
            k = (-knee[0], knee[1], knee[2])
            a = (-ankle[0], ankle[1], ankle[2])
        base = len(pieces)
        pieces.append(dict(name=f'thigh_{tag}', parent=0,
                           offset=(s * L.HIP_X, L.HIP_Y, hz), part=thp))
        pieces.append(dict(name=f'shin_{tag}', parent=base, offset=k, part=shp))
        pieces.append(dict(name=f'foot_{tag}', parent=base + 1, offset=a,
                           part=ftp))
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
