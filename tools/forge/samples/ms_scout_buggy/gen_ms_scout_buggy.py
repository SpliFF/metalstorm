"""gen_ms_scout_buggy — assemble ms_scout_buggy and export .gltf/.bin.

Light scout buggy (tanks s1, 4.5 m, spec budget 1500 tris): open-frame
tub, roll cage, pintle sensor pod on the cage cross-bar (`dish` piece,
8 s idle sweep clip), spinnable `axle_f`/`axle_r` wheel pieces, two
spare wheels on the rear rack, whip aerial.

Run: python3 gen_ms_scout_buggy.py  → out/ms_scout_buggy{,_png}.gltf + .bin
"""
from __future__ import annotations
import numpy as np

import ms_scout_buggy_layout as F      # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, Zone, loft, chamfer_box, ngon_ring, limb, mirror_x
from gltf_export import export

STEM = 'ms_scout_buggy'
OUT = 'out'

RNG = np.random.default_rng(90210)     # forge determinism seed


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
    if abs(n[0]) > 0.62:
        return F.S_SIDE
    if n[2] < -0.55:
        return F.S_FRONT
    if n[2] > 0.55:
        return F.S_REAR
    return F.S_TOP


def wheel(p, center, r, hw, axis='x', cap_zone=None):
    """8-gon tyre around `axis` with parametric tread UVs + hub caps."""
    cap_zone = cap_zone or (F.S_HUB if axis == 'x' else F.S_HUB_Z)
    c = np.asarray(center, dtype=float)
    ax = np.zeros(3)
    ax['xyz'.index(axis)] = 1.0
    ra = ngon_ring(tuple(c - ax * hw), r, n=8, axis=axis)
    rb = ngon_ring(tuple(c + ax * hw), r, n=8, axis=axis)
    x0, y0, x1, y1 = F.S_WHEEL
    for j in range(8):
        k = (j + 1) % 8
        u0 = (x0 + (x1 - x0) * j / 8) / M.ATLAS
        u1 = (x0 + (x1 - x0) * (j + 1) / 8) / M.ATLAS
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
    # hub caps: project through a zone window centred on the wheel
    if axis == 'x':
        za = Zone(cap_zone.rect, ('z', 'y'),
                  ((c[2] - r, c[2] + r), (c[1] + r, c[1] - r)))
    else:
        za = Zone(cap_zone.rect, ('x', 'y'),
                  ((c[0] - r, c[0] + r), (c[1] + r, c[1] - r)))
    quad_out(p, list(ra), tuple(-ax), za)
    quad_out(p, list(rb), tuple(ax), za)


# ── pieces ───────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    rings = [ring_from_section(s) for s in F.BODY_SECTIONS]
    loft(p, rings, body_zone, cap_start=F.S_FRONT, cap_end=F.S_REAR)

    # dash cowl over the open cockpit's leading edge
    x, y, z, w, h, d = F.DASH_BOX
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': F.S_TOP, '+x': F.S_SIDE, '-x': F.S_SIDE,
                 '+z': F.S_DASH, '-z': F.S_DASH}, skip=('-y',))
    # bucket seats (base + backrest) — the open-frame giveaway
    for (sx, sz) in F.SEATS:
        bw, bh, bd = F.SEAT_BASE
        chamfer_box(p, (sx, F.SEAT_Y, sz), (bw, bh, bd), 0.03,
                    {'+y': F.S_SEAT, '+x': F.S_SEAT, '-x': F.S_SEAT,
                     '+z': F.S_SEAT, '-z': F.S_SEAT}, skip=('-y',))
        kw, kh, kd = F.SEAT_BACK
        chamfer_box(p, (sx, F.SEAT_Y + bh / 2 + kh / 2 - 0.02,
                        sz + bd / 2 - kd / 2), (kw, kh, kd), 0.03,
                    {'+y': F.S_SEAT, '+x': F.S_SEAT, '-x': F.S_SEAT,
                     '+z': F.S_SEAT, '-z': F.S_SEAT}, skip=('-y',))
    # engine intake hump on the rear deck
    x, y, z, w, h, d = F.ENGINE_BOX
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': F.S_ENGINE, '+x': F.S_SIDE, '-x': F.S_SIDE,
                 '+z': F.S_REAR, '-z': F.S_REAR}, skip=('-y',))
    # exhaust pipe out the rear
    limb(p, F.EXHAUST[0], F.EXHAUST[1], F.EXHAUST_R, F.EXHAUST_R,
         F.S_TRIM, n=4, cap_end=F.S_DARK)
    # side step sills
    for (sx, sy, sz) in F.SILLS:
        chamfer_box(p, (sx, sy, sz), F.SILL_SIZE, 0.02,
                    {'+y': F.S_SILL, '-y': F.S_DARK, '+x': F.S_SIDE,
                     '-x': F.S_SIDE, '+z': F.S_SIDE, '-z': F.S_SIDE})

    # roll cage: front + main hoops, roof rails, rear braces
    (fx0, fy0), (fx1, fy1) = F.HOOP_MAIN
    (gx0, gy0), (gx1, gy1) = F.HOOP_FRONT
    zm, zf = F.HOOP_MAIN_Z, F.HOOP_FRONT_Z
    for s in (1, -1):
        limb(p, (s * fx0, fy0, zm), (s * fx1, fy1, zm), F.CAGE_R, F.CAGE_R,
             F.S_CAGE, n=4)
        limb(p, (s * gx0, gy0, zf), (s * gx1, gy1, zf), F.CAGE_R, F.CAGE_R,
             F.S_CAGE, n=4)
        # roof rail front-hoop head -> main-hoop head
        limb(p, (s * gx1, gy1, zf), (s * fx1, fy1, zm), F.CAGE_R * 0.9,
             F.CAGE_R * 0.9, F.S_CAGE, n=4)
        # rear brace main-hoop head -> engine deck
        limb(p, (s * fx1, fy1, zm), (s * F.BRACE_REAR[0], F.BRACE_REAR[1],
             F.BRACE_REAR[2]), F.CAGE_R * 0.9, F.CAGE_R * 0.9, F.S_CAGE, n=4)
    # cross bars (main-hoop head + front-hoop head)
    limb(p, (-fx1, fy1, zm), (fx1, fy1, zm), F.CAGE_R, F.CAGE_R, F.S_CAGE, n=4)
    limb(p, (-gx1, gy1, zf), (gx1, gy1, zf), F.CAGE_R * 0.9, F.CAGE_R * 0.9,
         F.S_CAGE, n=4)
    # pintle stub the sensor pod sits on
    limb(p, (0, F.DISH_OFF[1] - 0.10, F.DISH_OFF[2]),
         (0, F.DISH_OFF[1], F.DISH_OFF[2]), 0.05, 0.045, F.S_TRIM, n=4)

    # brush-bar bumper across the nose
    for s in (1, -1):
        limb(p, (s * F.BUMPER_X, F.BUMPER_Y[0] - 0.08, F.BUMPER_Z + 0.06),
             (s * F.BUMPER_X, F.BUMPER_Y[1], F.BUMPER_Z), F.BUMPER_R,
             F.BUMPER_R, F.S_TRIM, n=4)
    for by in F.BUMPER_Y:
        limb(p, (-F.BUMPER_X, by, F.BUMPER_Z), (F.BUMPER_X, by, F.BUMPER_Z),
             F.BUMPER_R, F.BUMPER_R, F.S_TRIM, n=4)

    # rear rack frame + two spare wheels
    x, y, z, w, h, d = F.STOW_BOX
    chamfer_box(p, (x, y, z), (w, h, d), 0.025,
                {'+y': F.S_STOW, '+x': F.S_SIDE, '-x': F.S_SIDE,
                 '+z': F.S_STOW, '-z': F.S_STOW}, skip=('-y',))
    for (px, py, pz) in F.SPARES:
        wheel(p, (px, py, pz), F.SPARE_R, F.SPARE_HW, axis='z')

    # whip aerial
    ax, ay, az = F.AERIAL
    limb(p, (ax, ay, az), (ax, F.AERIAL_TOP, az), 0.022, 0.008, F.S_TRIM,
         n=4, cap_end=F.S_DARK)
    return p


def build_axle(name, az):
    p = Part(name)
    for sx in (F.TRACK_X, -F.TRACK_X):
        wheel(p, (sx, 0.0, 0.0), F.WHEEL_R, F.WHEEL_HW, axis='x')
    w, h, d = F.AXLE_BAR
    chamfer_box(p, (0, 0, 0), (w, h, d), 0.02,
                {'+y': F.S_DARK, '-y': F.S_DARK, '+x': F.S_DARK,
                 '-x': F.S_DARK, '+z': F.S_DARK, '-z': F.S_DARK})
    return p


def build_dish():
    p = Part('dish')
    # pivot collar
    limb(p, (0, 0, 0), (0, 0.10, 0), 0.045, 0.045, F.S_TRIM, n=4)
    # sensor pod housing
    x, y, z, w, h, d = F.POD_BOX
    chamfer_box(p, (x, y, z), (w, h, d), 0.025,
                {'+y': F.S_POD, '-y': F.S_DARK, '+x': F.S_POD,
                 '-x': F.S_POD, '-z': F.S_POD_F, '+z': F.S_POD})
    # mini open dish plate, tilted skyward (front + back faces)
    tilt = np.radians(F.DISH_TILT)
    ctr = np.array(F.DISH_CTR)
    ndir = np.array([0.0, np.cos(tilt), -np.sin(tilt)])
    u = np.array([1.0, 0.0, 0.0])
    v = np.cross(ndir, u)
    ring = [tuple(ctr + F.DISH_R * (np.cos(t) * u + np.sin(t) * v))
            for t in np.linspace(0, 2 * np.pi, 11)[:-1]]
    zf = Zone(F.S_DISH.rect, ('x', 'y'),
              ((-F.DISH_R, F.DISH_R), (ctr[1] + F.DISH_R, ctr[1] - F.DISH_R)))
    zb = Zone(F.S_DISH_B.rect, ('x', 'y'),
              ((-F.DISH_R, F.DISH_R), (ctr[1] + F.DISH_R, ctr[1] - F.DISH_R)))
    p.add_face(ring, zone=zf)
    p.add_face(ring, zone=zb, flip=True)
    # feed stub out the dish normal
    limb(p, tuple(ctr), tuple(ctr + ndir * 0.20), 0.022, 0.016, F.S_TRIM,
         n=4, cap_end=F.S_DARK)
    return p


def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    """`dish` idle sweep: seamless ±60° pintle scan, 8 s loop."""
    T = 8.0
    sweep = [0.0, 60.0, 0.0, -60.0, 0.0]
    keys = [(T * i / 4, qy(a)) for i, a in enumerate(sweep)]
    return [{'name': 'idle', 'channels': [('dish', 'rotation', keys)]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='axle_f', parent=0, offset=(0, F.WHEEL_R, F.AXLE_F_Z),
             part=build_axle('axle_f', F.AXLE_F_Z)),
        dict(name='axle_r', parent=0, offset=(0, F.WHEEL_R, F.AXLE_R_Z),
             part=build_axle('axle_r', F.AXLE_R_Z)),
        dict(name='dish', parent=0, offset=F.DISH_OFF, part=build_dish()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=build_clips(),
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=build_clips(),
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
