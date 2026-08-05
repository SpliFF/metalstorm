"""gen_ms_dreadnought — build ms_dreadnought (Leviathan) + clips.

Anarchic salvage dreadnought, s4 hero (~80 m): closed hull loft with a
riveted ram prow, three welded slab turret chains (turret/barrel/muzzle
A fore, turret3/... B superfiring, turret2/... C aft baked facing +Z),
scrap-armoured superstructure, twin raked funnels, trophy chains along
the rails, salvage crane derrick on the port quarter, mainmast with the
battle `flag` standard (idle clip waves it).

Usage: python3 gen_ms_dreadnought.py
"""
from __future__ import annotations
import numpy as np

import ms_dreadnought_layout as S   # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, loft, chamfer_box, tube, ngon_ring, limb
from gltf_export import export
import parts as P

STEM = 'ms_dreadnought'
OUT = 'out'
RNG = np.random.default_rng(90210)


# ── helpers ──────────────────────────────────────────────────────────────

def ring_from_section(sec):
    z, yb, yk, yd, wb, wk, wd = sec
    return [(wb, yb, z), (wk, yk, z), (wd, yd, z),
            (-wd, yd, z), (-wk, yk, z), (-wb, yb, z)]


def hull_zone(c, n):
    if n[1] < -0.55:
        return S.S_BELLY
    if n[1] > 0.6:
        return S.S_BELLY if c[1] < 0.0 else S.S_DECK
    return S.S_HULL


def interp_col(z, col):
    zs = [s[0] for s in S.HULL_SECTIONS]
    return float(np.interp(z, zs, [s[col] for s in S.HULL_SECTIONS]))


def box(p, center, size, zone, ch=0.05, skip=()):
    chamfer_box(p, center, size, ch,
                {k: zone for k in ('+x', '-x', '+y', '-y', '+z', '-z')},
                skip=skip)


# ── body ─────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    rings = [ring_from_section(s) for s in S.HULL_SECTIONS]
    loft(p, rings, hull_zone)

    # bow + stern cap faces
    for sec, outward, zone in ((S.HULL_SECTIONS[0], (0, 0, -1), S.S_BOW),
                               (S.HULL_SECTIONS[-1], (0, 0, 1), S.S_STERN)):
        z, yb, yk, yd, wb, wk, wd = sec
        P.quad_out(p, [(-wb, yb, z), (wb, yb, z), (wk, yk, z), (-wk, yk, z)],
                   outward, zone)
        P.quad_out(p, [(-wk, yk, z), (wk, yk, z), (wd, yd, z), (-wd, yd, z)],
                   outward, zone)

    # riveted ram prow + splayed tusks
    x, y, z, w, h, d = S.RAM_BOX
    chamfer_box(p, (x, y, z), (w, h, d), 0.08,
                {'+x': S.S_RAM, '-x': S.S_RAM, '+y': S.S_RAM, '-y': S.S_RAM,
                 '-z': S.S_BOW, '+z': S.S_BOW})
    x, y, z, w, h, d = S.RAM_WEDGE
    chamfer_box(p, (x, y, z), (w, h, d), 0.10,
                {'+x': S.S_RAM, '-x': S.S_RAM, '+y': S.S_RAM, '-y': S.S_RAM,
                 '-z': S.S_BOW})
    for (a, b) in S.RAM_SPIKES:
        limb(p, a, b, 0.16, 0.03, S.S_MAST, n=4)

    # anchor hawse plates
    for (sx, az) in S.ANCHORS:
        wz = interp_col(az, 6)
        box(p, (sx * (wz * 0.94), 2.9, az), (0.5, 1.5, 2.0), S.S_PLATE,
            ch=0.05)

    # barbette drums under A and C turrets
    for tz in (S.TURRET_A[2], S.TURRET_C[2]):
        yd = interp_col(tz, 3)
        P.drum(p, (0.0, yd - 0.15, tz), S.BARB_R, S.BARB_H + 0.15, S.S_BARB,
               n=8)
    # B superfiring step block + its barbette
    x, y, z, w, h, d = S.STEP_BOX
    chamfer_box(p, (x, y, z), (w, h, d), 0.08,
                {'+x': S.S_SUP_S, '-x': S.S_SUP_S, '-z': S.S_SUP_F,
                 '+z': S.S_SUP_F, '+y': S.S_SUP_T}, skip=('-y',))
    P.drum(p, (0.0, y + h / 2 - 0.05, S.TURRET_B[2]), S.BARB_R * 0.92,
           S.TURRET_B[1] - (y + h / 2) + 0.1, S.S_BARB, n=8)

    # scrap-armoured superstructure
    x, y, z, w, h, d = S.MAIN_BLOCK
    chamfer_box(p, (x, y, z), (w, h, d), 0.10,
                {'+x': S.S_SUP_S, '-x': S.S_SUP_S, '-z': S.S_SUP_F,
                 '+z': S.S_SUP_F, '+y': S.S_SUP_T}, skip=('-y',))
    x, y, z, w, h, d = S.BRIDGE
    chamfer_box(p, (x, y, z), (w, h, d), 0.08,
                {'+x': S.S_SUP_S, '-x': S.S_SUP_S, '-z': S.S_SUP_F,
                 '+z': S.S_SUP_F, '+y': S.S_SUP_T}, skip=('-y',))
    for (sx, sy, sz) in S.SPONSONS:
        box(p, (sx, sy, sz), S.SPONSON_SZ, S.S_PLATE, ch=0.06, skip=('-y',))
    # welded-on scrap patch plates (thin proud boxes on the block faces)
    for (px_, py_, pz_, pw, ph) in ((4.45, 5.6, 4.2, 2.6, 1.6),
                                    (-4.45, 7.6, 10.0, 3.2, 1.9),
                                    (4.45, 8.2, 11.5, 2.2, 1.3),
                                    (-4.45, 5.2, 5.0, 2.0, 2.2)):
        box(p, (px_, py_, pz_), (0.14, ph, pw), S.S_PLATE, ch=0.02)
    box(p, (0.0, 6.4, 0.95), (5.0, 2.6, 0.16), S.S_PLATE, ch=0.02)

    # twin raked funnels
    for ((fx0, fy0, fz0), (fx1, fy1, fz1), r0, r1) in S.FUNNELS:
        limb(p, (fx0, fy0, fz0), (fx1, fy1, fz1), r0, r1, S.S_FUNNEL, n=8,
             cap_end=S.S_DARK)

    # mainmast, yard, stay
    limb(p, S.MAST_FOOT, S.MAST_TOP, 0.16, 0.08, S.S_MAST, n=4)
    my = np.interp(S.YARD_Y, (S.MAST_FOOT[1], S.MAST_TOP[1]),
                   (S.MAST_FOOT[2], S.MAST_TOP[2]))
    limb(p, (-S.YARD_HW, S.YARD_Y, my), (S.YARD_HW, S.YARD_Y, my),
         0.06, 0.06, S.S_MAST, n=4)
    limb(p, (0.0, 15.6, 15.25), (0.0, 11.4, S.BRIDGE[2] + 1.0), 0.035, 0.035,
         S.S_CHAIN, n=4)

    # salvage crane derrick (port quarter)
    limb(p, S.CRANE_FOOT, S.CRANE_TOP, 0.30, 0.22, S.S_MAST, n=6)
    limb(p, (S.CRANE_FOOT[0], S.CRANE_TOP[1] - 0.4, S.CRANE_FOOT[2]),
         S.BOOM_TIP, 0.18, 0.12, S.S_MAST, n=4)
    limb(p, (S.CRANE_FOOT[0], 5.6, S.CRANE_FOOT[2]),
         (S.BOOM_TIP[0] - 0.35, S.BOOM_TIP[1] - 0.35, S.BOOM_TIP[2] - 0.9),
         0.05, 0.05, S.S_CHAIN, n=4)                       # stay cable
    limb(p, S.BOOM_TIP, (S.BOOM_TIP[0], S.HOOK_Y + 0.5, S.BOOM_TIP[2]),
         0.05, 0.05, S.S_CHAIN, n=4)                       # fall cable
    box(p, (S.BOOM_TIP[0], S.HOOK_Y, S.BOOM_TIP[2]), (0.9, 0.8, 0.9),
        S.S_TROPHY, ch=0.05)                               # salvage lump
    box(p, (S.CRANE_FOOT[0] - 1.2, 4.75, S.CRANE_FOOT[2]), (1.1, 0.8, 1.4),
        S.S_PLATE, ch=0.05, skip=('-y',))                  # winch house

    # trophy rails: posts + sagging chains + hung trophy plates
    k = 0
    for (z0, z1, n_posts) in S.RAIL_SPANS:
        for sx in (1, -1):
            zs = np.linspace(z0, z1, n_posts)
            tops = []
            for pz in zs:
                wd = interp_col(pz, 6) - S.RAIL_INSET
                yd = interp_col(pz, 3)
                tp = (sx * wd, yd + S.POST_H, pz)
                tops.append(tp)
                limb(p, (sx * wd, yd, pz), tp, 0.055, 0.045, S.S_MAST, n=4)
            for i in range(len(tops) - 1):
                a, b = tops[i], tops[i + 1]
                mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 0.32,
                       (a[2] + b[2]) / 2)
                limb(p, a, mid, 0.045, 0.05, S.S_CHAIN, n=4)
                limb(p, mid, b, 0.05, 0.045, S.S_CHAIN, n=4)
                if k % 2 == 0:      # battered trophy plate hung at the sag
                    box(p, (mid[0], mid[1] - 0.55, mid[2]),
                        (0.16, 0.95, 1.05), S.S_TROPHY, ch=0.03)
                k += 1

    # deck clutter (prefabs)
    P.crate_stack(p, S.CRATES_AT, rows=2, cols=2, tiers=2, size=1.05,
                  zone=S.S_PLATE, rng=RNG)
    P.drum_row(p, S.DRUMS_AT, count=3, r=0.4, h=1.1, zone=S.S_DARK)
    P.tarp_over(p, S.TARP_AT, (2.6, 1.1, 2.8), zone=S.S_PLATE)
    # bollard stubs fore + aft
    for bz in (-33.5, 33.0):
        wd = interp_col(bz, 6) - 0.9
        yd = interp_col(bz, 3)
        for sx in (1, -1):
            limb(p, (sx * wd, yd, bz), (sx * wd, yd + 0.5, bz), 0.13, 0.13,
                 S.S_MAST, n=4)
    return p


# ── turret chain ─────────────────────────────────────────────────────────

def build_turret(name, aft=False):
    p = Part(name)
    s = -1.0 if aft else 1.0
    w, h, d = S.TUR_SLAB
    chamfer_box(p, (0.0, h / 2, s * 0.1), (w, h, d), 0.14,
                {'+x': S.S_TUR_S, '-x': S.S_TUR_S, '+y': S.S_TUR_T,
                 '-z': S.S_TUR_F, '+z': S.S_TUR_F}, skip=('-y',))
    # roof hatch + stowage + rear spike pair (Anarchic trim)
    box(p, (1.1, h + 0.12, s * 1.4), (0.9, 0.28, 0.9), S.S_TUR_T, ch=0.03)
    box(p, (-1.6, h * 0.55, s * 2.6), (1.6, 1.0, 0.9), S.S_PLATE, ch=0.04)
    for sx in (1.9, -1.9):
        limb(p, (sx, h, s * 2.5), (sx * 1.15, h + 0.85, s * 2.9),
             0.09, 0.015, S.S_MAST, n=4)
    return p


def build_barrel(name, aft=False):
    p = Part(name)
    s = -1.0 if aft else 1.0
    box(p, (0.0, 0.0, s * -0.55), (3.6, 1.7, 1.5), S.S_MANTLET, ch=0.10)
    for xo in (S.TUBE_X, -S.TUBE_X):
        tube(p, [(s * z, r) for (z, r) in S.TUBE_STATIONS], S.S_BARREL,
             n=6, xoff=xo,
             cap_end=None if aft else S.S_TUBECAP,
             cap_start=S.S_TUBECAP if aft else None)
    return p


# ── flag (battle standard) ───────────────────────────────────────────────

def build_flag():
    """Planar panel trailing +Z from the mast; both windings (same diagonal
    per the double-sided rule — planar quad, explicit triangles)."""
    p = Part('flag')
    wv, hv = S.FLAG_W, S.FLAG_H
    v = [(0.0, hv * 0.5, 0.0), (0.0, hv * 0.5, wv),
         (0.0, -hv * 0.5, wv * 0.96), (0.0, -hv * 0.5, 0.0)]
    for tri in ((v[0], v[1], v[2]), (v[0], v[2], v[3])):
        p.add_face(list(tri), zone=S.S_FLAG)
        p.add_face(list(tri)[::-1], zone=S.S_FLAG)
    return p


# ── clips ────────────────────────────────────────────────────────────────

def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    T = 6.0
    keys = [(T * i / 8, qy(a)) for i, a in
            enumerate((0, 7, 11, 6, 0, -6, -11, -7, 0))]
    idle = {'name': 'idle', 'channels': [('flag', 'rotation', keys)]}
    return [idle]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    bx, by, bz = S.BARREL_OFF
    mx, my_, mz = S.MUZZLE_OFF
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),   # 0
        dict(name='turret', parent=0, offset=S.TURRET_A,
             part=build_turret('turret')),                                   # 1
        dict(name='barrel', parent=1, offset=(bx, by, bz),
             part=build_barrel('barrel')),                                   # 2
        dict(name='muzzle', parent=2, offset=(mx, my_, mz), part=None),      # 3
        dict(name='turret2', parent=0, offset=S.TURRET_C,
             part=build_turret('turret2', aft=True)),                        # 4
        dict(name='barrel2', parent=4, offset=(bx, by, -bz),
             part=build_barrel('barrel2', aft=True)),                        # 5
        dict(name='muzzle2', parent=5, offset=(mx, my_, -mz), part=None),    # 6
        dict(name='turret3', parent=0, offset=S.TURRET_B,
             part=build_turret('turret3')),                                  # 7
        dict(name='barrel3', parent=7, offset=(bx, by, bz),
             part=build_barrel('barrel3')),                                  # 8
        dict(name='muzzle3', parent=8, offset=(mx, my_, mz), part=None),     # 9
        dict(name='flag', parent=0, offset=S.FLAG_OFF, part=build_flag()),   # 10
        dict(name='exhaust', parent=0, offset=S.EXHAUST_OFF, part=None),     # 11
    ]
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_dreadnought] total tris: {total}')
