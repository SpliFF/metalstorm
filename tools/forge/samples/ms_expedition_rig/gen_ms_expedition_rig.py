"""gen_ms_expedition_rig — assemble ms_expedition_rig and export .gltf/.bin.

6-wheel expedition truck (~7 m, forward -Z) with FOUR interchangeable
mission modules mounted at the same deck socket — all exported, the
engine hides the unused ones.  Piece tree:

  body
   ├─ axle_f / axle_m / axle_r   (spinnable, civkit wheel convention)
   ├─ mod_survey ─ dish          (dish = animated piece, idle clip)
   ├─ mod_envoy
   ├─ mod_repair
   └─ mod_mast

Run: python3 gen_ms_expedition_rig.py  → out/ms_expedition_rig{,_png}.gltf + .bin
Deterministic: geometry is closed-form (no RNG); painter uses seed 90210.
"""
from __future__ import annotations
import numpy as np

import ms_expedition_rig_layout as L    # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, Zone, chamfer_box, ngon_ring, limb
from gltf_export import export

STEM = 'ms_expedition_rig'
OUT = 'out'


# ── helpers ──────────────────────────────────────────────────────────────

def quad_out(p, verts, outward, zone):
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, outward) > 0 else verts[::-1], zone=zone)


SLAB_FACES = {
    '+y': [(-1, 1, -1), (-1, 1, 1), (1, 1, 1), (1, 1, -1)],
    '-y': [(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)],
    '+x': [(1, -1, -1), (1, 1, -1), (1, 1, 1), (1, -1, 1)],
    '-x': [(-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1)],
    '-z': [(-1, -1, -1), (-1, 1, -1), (1, 1, -1), (1, -1, -1)],
    '+z': [(-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)],
}


def slab(p, center, size, zone, skip=()):
    """Unbevelled 12-tri box for pieces whose edges are below the bevel
    threshold (STYLE.md: skip the bevel rather than add a sliver)."""
    cx, cy, cz = center
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    for k, signs in SLAB_FACES.items():
        if k in skip:
            continue
        p.add_face([(cx + sx * hx, cy + sy * hy, cz + sz * hz)
                    for sx, sy, sz in signs], zone=zone)


def cbox(p, xyzwhd, zones, ch=0.05, skip=()):
    x, y, z, w, h, d = xyzwhd
    chamfer_box(p, (x, y, z), (w, h, d), ch, zones, skip=skip)


def wheel_pair(p):
    """Axle piece geometry: two 8-gon wheels + connecting axle bar
    (civkit convention; axle-local frame, wheel centre at origin Y)."""
    for sx in (-L.WHEEL_X, L.WHEEL_X):
        ra = ngon_ring((sx - L.WHEEL_HW, 0, 0), L.WHEEL_R, n=8, axis='x')
        rb = ngon_ring((sx + L.WHEEL_HW, 0, 0), L.WHEEL_R, n=8, axis='x')
        for j in range(8):
            k = (j + 1) % 8
            quad = [ra[j], ra[k], rb[k], rb[j]]
            cq = np.mean(np.array(quad), axis=0)
            quad_out(p, quad, (0, cq[1], cq[2]), L.WHEELZ)
        quad_out(p, list(ra), (-1, 0, 0), L.HUBZ)
        quad_out(p, list(rb), (1, 0, 0), L.HUBZ)
    slab(p, (0, 0, 0), L.AXLE_BAR, L.DARKZ)


# ── chassis ──────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    # cab (cab-over) — bevelled per STYLE.md
    cbox(p, L.CAB, {'+y': L.CAB_ROOF, '-y': L.DARKZ, '+x': L.CAB_SIDE,
                    '-x': L.CAB_SIDE, '-z': L.CAB_FRONT, '+z': L.CAB_FRONT},
         ch=0.14)
    # frame rails + flatbed deck
    cbox(p, L.CHASSIS, {'+y': L.DARKZ, '-y': L.DARKZ, '+x': L.DARKZ,
                        '-x': L.DARKZ, '-z': L.DARKZ, '+z': L.DARKZ}, ch=0.04)
    cbox(p, L.DECK, {'+y': L.BED_TOP, '-y': L.DARKZ, '+x': L.BED_SIDE,
                     '-x': L.BED_SIDE, '-z': L.BED_END, '+z': L.BED_END},
         ch=0.05)
    slab(p, L.HEADBOARD[:3], L.HEADBOARD[3:], L.BED_END)
    slab(p, L.BULLBAR[:3], L.BULLBAR[3:], L.BULLZ)
    slab(p, L.REARBAR[:3], L.REARBAR[3:], L.BULLZ)
    slab(p, L.LIGHTBAR[:3], L.LIGHTBAR[3:], L.GLOWZ)
    slab(p, L.SUNVISOR[:3], L.SUNVISOR[3:], L.CAB_ROOF)
    for t in L.TANKS:
        slab(p, t[:3], t[3:], L.TANKZ)
    for s in L.STEPS:
        slab(p, s[:3], s[3:], L.DARKZ)
    # exhaust stack behind the cab
    ex, ez = L.EXH
    limb(p, (ex, 1.35, ez), (ex, 2.62, ez), 0.09, 0.07, L.EXHW, n=4,
         cap_end=L.DARKZ)
    return p


# ── mission modules (piece-local frames, origin at MOD_OFF) ──────────────

def build_mod_survey():
    p = Part('mod_survey')
    slab(p, L.SUR_SKID[:3], L.SUR_SKID[3:], L.MODBASE)
    cbox(p, L.SUR_HOUSE, {'+y': L.MODBASE, '-y': L.DARKZ, '+x': L.MODSIDE,
                          '-x': L.MODSIDE, '-z': L.MODSIDE, '+z': L.MODSIDE},
         ch=0.05)
    # core-drill derrick: A-frame + crown block + drill string
    dx, dz = L.SUR_DERRICK
    for lx in (dx - 0.28, dx + 0.28):
        limb(p, (lx, 1.07, dz), (dx, 2.0, dz), 0.05, 0.04, L.DRILLW, n=4)
    slab(p, L.SUR_BLOCK[:3], L.SUR_BLOCK[3:], L.DARKZ)
    limb(p, (dx, 1.95, dz), (dx, 0.2, dz), 0.045, 0.045, L.DRILLW, n=6,
         cap_end=L.DARKZ)
    # dish pedestal (dish itself is a child piece)
    px, pz = L.SUR_PED
    limb(p, (px, 0.18, pz), (px, 1.05, pz), 0.09, 0.07, L.MASTW, n=6)
    return p


def build_dish():
    p = Part('dish')
    # yoke the plate hangs from (pivot at piece origin)
    limb(p, (0, 0, 0), (0, 0.22, 0), 0.07, 0.07, L.TRIMW, n=6)
    limb(p, (0, 0.22, 0), (0, 0.22, -0.3), 0.05, 0.05, L.TRIMW, n=4)
    # open 12-gon plate tilted skyward
    tilt = np.radians(L.DISH_TILT)
    ctr = np.array([0, 0.22, -0.42])
    ndir = np.array([0, np.cos(tilt), -np.sin(tilt)])
    u = np.array([1.0, 0, 0])
    v = np.cross(ndir, u)
    ring = [tuple(ctr + L.DISH_R * (np.cos(t) * u + np.sin(t) * v))
            for t in np.linspace(0, 2 * np.pi, 13)[:-1]]
    p.add_face(ring, zone=L.DISH_F)
    p.add_face(ring, zone=L.DISH_B, flip=True)
    # feed arm + head
    tip = tuple(ctr + ndir * 0.5)
    limb(p, tuple(ctr), tip, 0.03, 0.022, L.TRIMW, n=4)
    slab(p, tip, (0.1, 0.1, 0.1), L.GLOWZ)
    return p


def build_mod_envoy():
    p = Part('mod_envoy')
    slab(p, L.ENV_PLAT[:3], L.ENV_PLAT[3:], L.MODBASE)
    for (px, pz) in L.ENV_POSTS:
        limb(p, (px, 0.18, pz), (px, 1.88, pz), 0.05, 0.04, L.TRIMW, n=4)
    cbox(p, L.ENV_CANOPY, {'+y': L.CANOPY, '-y': L.CANOPY, '+x': L.CANOPY,
                           '-x': L.CANOPY, '-z': L.CANOPY, '+z': L.CANOPY},
         ch=0.04)
    slab(p, L.ENV_TABLE[:3], L.ENV_TABLE[3:], L.CRATEZ)
    sx, sz = L.ENV_STAFF
    limb(p, (sx, 0.18, sz), (sx, 3.1, sz), 0.045, 0.028, L.TRIMW, n=4,
         cap_end=L.DARKZ)
    p.add_face(L.ENV_PENNANT, zone=L.FLAGZ)
    p.add_face(L.ENV_PENNANT, zone=L.FLAGZ, flip=True)
    return p


def build_mod_repair():
    p = Part('mod_repair')
    slab(p, L.REP_BASE[:3], L.REP_BASE[3:], L.MODBASE)
    cbox(p, L.REP_PED, {'+y': L.MODBASE, '-y': L.DARKZ, '+x': L.MODSIDE,
                        '-x': L.MODSIDE, '-z': L.MODSIDE, '+z': L.MODSIDE},
         ch=0.05)
    limb(p, L.REP_POST[0], L.REP_POST[1], 0.1, 0.09, L.DRILLW, n=6)
    limb(p, L.REP_BOOM[0], L.REP_BOOM[1], 0.09, 0.055, L.DRILLW, n=4,
         cap_end=L.DARKZ)
    limb(p, L.REP_CABLE[0], L.REP_CABLE[1], 0.018, 0.018, L.TRIMW, n=4)
    slab(p, L.REP_HOOK[:3], L.REP_HOOK[3:], L.DARKZ)
    slab(p, L.REP_RACK[:3], L.REP_RACK[3:], L.CRATEZ)
    for c in L.REP_CRATES:
        slab(p, c[:3], c[3:], L.CRATEZ)
    for c in L.REP_CANS:
        slab(p, c[:3], c[3:], L.CRATEZ)
    # spare wheel lying flat on the deck
    wx, wy, wz, wr, whh = L.REP_SPARE
    ra = ngon_ring((wx, wy - whh, wz), wr, n=8, axis='y')
    rb = ngon_ring((wx, wy + whh, wz), wr, n=8, axis='y')
    for j in range(8):
        k = (j + 1) % 8
        quad = [ra[j], ra[k], rb[k], rb[j]]
        cq = np.mean(np.array(quad), axis=0)
        quad_out(p, quad, (cq[0] - wx, 0, cq[2] - wz), L.DARKZ)
    quad_out(p, list(ra), (0, -1, 0), L.DARKZ)
    quad_out(p, list(rb), (0, 1, 0), L.DARKZ)
    return p


def build_mod_mast():
    p = Part('mod_mast')
    cbox(p, L.MAST_CAB, {'+y': L.MODBASE, '-y': L.DARKZ, '+x': L.MODSIDE,
                         '-x': L.MODSIDE, '-z': L.MODSIDE, '+z': L.MODSIDE},
         ch=0.05)
    mx, mz = L.MAST_XZ
    for (y0, y1, r) in L.MAST_SEGS:
        limb(p, (mx, y0, mz), (mx, y1, mz), r, r * 0.8, L.MASTW, n=6,
             cap_end=L.DARKZ)
    # yard arms + dipole whiskers
    yy = L.MAST_YARDY
    for s in (-1, 1):
        limb(p, (mx, yy, mz), (mx + s * L.MAST_YARDS, yy, mz), 0.035, 0.03,
             L.TRIMW, n=4)
        tipx = mx + s * L.MAST_YARDS
        limb(p, (tipx, yy, mz), (tipx, yy + L.MAST_WHISK, mz), 0.02, 0.012,
             L.TRIMW, n=4)
    slab(p, L.MAST_BEACON[:3], L.MAST_BEACON[3:], L.GLOWZ)
    return p


# ── assembly / clips ─────────────────────────────────────────────────────

def build_all():
    pieces = [dict(name='body', parent=-1, offset=(0, 0, 0),
                   part=build_body())]
    for (name, az) in L.AXLES:
        ax = Part(name)
        wheel_pair(ax)
        pieces.append(dict(name=name, parent=0,
                           offset=(0, L.WHEEL_GROUND, az), part=ax))
    survey_i = len(pieces)
    pieces.append(dict(name='mod_survey', parent=0, offset=L.MOD_OFF,
                       part=build_mod_survey()))
    pieces.append(dict(name='dish', parent=survey_i, offset=L.DISH_OFF,
                       part=build_dish()))
    pieces.append(dict(name='mod_envoy', parent=0, offset=L.MOD_OFF,
                       part=build_mod_envoy()))
    pieces.append(dict(name='mod_repair', parent=0, offset=L.MOD_OFF,
                       part=build_mod_repair()))
    pieces.append(dict(name='mod_mast', parent=0, offset=L.MOD_OFF,
                       part=build_mod_mast()))
    return pieces


def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    """idle: survey dish sweeps a full revolution in 8 s (loop-seamless —
    last key repeats the first pose at 360°)."""
    T = 8.0
    keys = [(T * i / 4, qy(90.0 * i)) for i in range(5)]
    return [{'name': 'idle', 'channels': [('dish', 'rotation', keys)]}]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=build_clips(),
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=build_clips(),
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
