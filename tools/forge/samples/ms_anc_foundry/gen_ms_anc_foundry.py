"""gen_ms_anc_foundry — assemble ms_anc_foundry and export .gltf/.bin.

Ancient automated foundry, 40 m: five-tier monolithic ziggurat with clean
recessed seams and cornice lips, three cantilevered casting halls thrown
clear of the mass, a monumental circular pour-gate, rows of clean vent
hoods, four crown pylons with inward-cantilevered beaks, two gantry arms
frozen mid-task (one ladle still hanging over the pour line), and a
central core shaft (`core`, dim cyan, floating collar) on a slow seamless
idle rise/fall with ABSOLUTE translation keys. Slag spill at the foot has
gone to glass. No team colour.
Run: python3 gen_ms_anc_foundry.py -> out/ms_anc_foundry{,_png}.gltf
"""
import numpy as np

import ms_anc_foundry_layout as F   # sets meshlib.ATLAS = 2048
from meshlib import Part, chamfer_box, limb, ngon_ring
from gltf_export import export

STEM = 'ms_anc_foundry'
OUT = 'out'
RNG = np.random.default_rng(90210)


def zbox(p, center, size, rect_x, rect_z, rect_y, ch=0.10, skip=()):
    chamfer_box(p, center, size, ch,
                F.face_zones(center, size, rect_x, rect_z, rect_y), skip=skip)


def build_body():
    p = Part('body')

    # ── buried apron: soil drift + the glass sheet it sits in ────────────
    c, s = F.APRON
    chamfer_box(p, c, s, 0.16,
                {'+y': F.R_GLASS_TOP, '+x': F.R_GLASS_SZ, '-x': F.R_GLASS_SZ,
                 '+z': F.R_GLASS_S, '-z': F.R_GLASS_S}, skip=('-y',))

    # slag spill gone to glass — irregular frozen pools, flat on the ground
    for (cx, cy, cz), r, n in F.POOLS:
        ring = []
        for i in range(n):
            a = 2 * np.pi * i / n
            rr = r * (0.72 + 0.28 * RNG.random())
            ring.append((cx + rr * np.cos(a), cy, cz + rr * np.sin(a)))
        p.add_face(ring, zone=F.R_GLASS_TOP, flip=True)

    # ── the ziggurat: five monolithic tiers + cornice lips ───────────────
    for c, s in F.TIERS:
        chamfer_box(p, c, s, 0.22, F.TIER_ZONES, skip=('-y',))
    for c, s in F.CORNICES:
        chamfer_box(p, c, s, 0.14,
                    {k: F.R_CORNICE for k in
                     ('+x', '-x', '+y', '-y', '+z', '-z')})

    # ── cantilevered casting halls (nothing underneath) ─────────────────
    for c, s, axis in F.HALLS:
        if axis == 'x':
            zs = F.face_zones(c, s, F.R_HALL_END, F.R_HALL_SIDE, F.R_HALL_TOP)
        else:
            zs = F.face_zones(c, s, F.R_HALL_SIDE, F.R_HALL_END, F.R_HALL_TOP)
        chamfer_box(p, c, s, 0.18, zs)

    # ── rows of clean vents ─────────────────────────────────────────────
    for c, s in F.VENTS:
        zbox(p, c, s, F.R_VENT, F.R_VENT, F.R_VENT, ch=0.08)

    # ── monumental pour gate: a perfect circle, seamless ────────────────
    gx, gy, gz = F.GATE_C
    disc = ngon_ring((gx, gy, gz - 0.06), F.GATE_R, 24, 'z')
    p.add_face(disc, zone=F.R_GATE, flip=True)
    ring = ngon_ring((gx, gy, gz - 0.30), F.GATE_RING_R, F.GATE_N, 'z')
    for i in range(F.GATE_N):
        limb(p, ring[i], ring[(i + 1) % F.GATE_N],
             F.GATE_BAR, F.GATE_BAR, F.R_GATERING, n=4)

    # ── crown pylons + inward-cantilevered beaks ────────────────────────
    for c, s in F.PYLONS:
        zbox(p, c, s, F.R_PYLON, F.R_PYLON, F.R_HALL_TOP, ch=0.12)
    for c, s in F.BEAKS:
        zbox(p, c, s, F.R_PYLON, F.R_PYLON, F.R_HALL_TOP, ch=0.12)

    # ── gantry arms, frozen mid-task ────────────────────────────────────
    zbox(p, *F.ARM_A_SHOULDER, F.R_PYLON, F.R_PYLON, F.R_HALL_TOP, ch=0.12)
    a, b, r0, r1 = F.ARM_A_BOOM
    limb(p, a, b, r0, r1, F.R_ARM, n=6, cap_end=F.R_DARK)
    a, b, r0, r1 = F.ARM_A_HANG
    limb(p, a, b, r0, r1, F.R_ARM, n=4)
    a, b, r0, r1 = F.ARM_A_LADLE
    limb(p, a, b, r0, r1, F.R_SHAFT, n=8, cap_start=F.R_DARK, cap_end=F.R_LENS)

    zbox(p, *F.ARM_B_SHOULDER, F.R_PYLON, F.R_PYLON, F.R_HALL_TOP, ch=0.12)
    a, b, r0, r1 = F.ARM_B_BOOM
    limb(p, a, b, r0, r1, F.R_ARM, n=6)
    a, b, r0, r1 = F.ARM_B_STRUT
    limb(p, a, b, r0, r1, F.R_ARM, n=4, cap_end=F.R_LENS)
    zbox(p, *F.ARM_B_HEAD, F.R_VENT, F.R_VENT, F.R_VENT, ch=0.10)
    return p


def build_core():
    """Central core shaft + free-floating collar; pivot on the foundry axis."""
    p = Part('core')
    st = F.CORE_STATIONS
    for i in range(len(st) - 1):
        y0, r0 = st[i]
        y1, r1 = st[i + 1]
        limb(p, (0.0, y0, 0.0), (0.0, y1, 0.0), r0, r1, F.R_SHAFT, n=12,
             cap_end=(F.R_LENS if i == len(st) - 2 else None))

    # floating collar: a perfect ring, touching nothing
    verts = ngon_ring((0.0, F.COLLAR_Y, 0.0), F.COLLAR_R, F.COLLAR_N, 'y')
    n = len(verts)
    for i in range(n):
        limb(p, verts[i], verts[(i + 1) % n],
             F.COLLAR_BAR, F.COLLAR_BAR, F.R_COLLAR, n=6)
    # emitter studs on the collar (dim cyan lenses)
    step = n // F.STUD_N
    for i in range(0, n, step):
        v = np.asarray(verts[i], dtype=float)
        out = np.array([v[0], 0.0, v[2]])
        out /= np.linalg.norm(out)
        c = tuple(v + out * 0.30)
        chamfer_box(p, c, F.STUD_SIZE, 0.08,
                    F.face_zones(c, F.STUD_SIZE, F.R_LENS_R, F.R_LENS_R,
                                 F.R_LENS_R))
    return p


def build_clips():
    """Slow idle breath of the core: ABSOLUTE translation keys, seamless."""
    x, y, z = F.CORE_PIVOT
    T, A = F.IDLE_T, F.IDLE_RISE
    keys = [(0.00 * T, (x, y, z)),
            (0.25 * T, (x, y + A, z)),
            (0.50 * T, (x, y, z)),
            (0.75 * T, (x, y - A, z)),
            (1.00 * T, (x, y, z))]
    return [{'name': 'idle', 'channels': [('core', 'translation', keys)]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='core', parent=0, offset=F.CORE_PIVOT, part=build_core()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
