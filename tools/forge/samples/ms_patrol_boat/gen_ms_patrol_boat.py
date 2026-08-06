"""gen_ms_patrol_boat — build ms_patrol_boat (PB Vigil) + clips.

Fast patrol launch, ships-row s1 (20 m): hard-chine planing hull loft
(waterline Y=0, draft ~0.9 m), spray rails at the chine knuckle, open
gun ring forward with the standard turret/barrel/muzzle autocannon
chain, small wheelhouse midships, mast with nav beacon and a `flag`
whip (idle clip sway), stern equipment rack (crates, drums, tarp)
inside deck railing.

Usage: python3 gen_ms_patrol_boat.py
"""
from __future__ import annotations
import numpy as np

import ms_patrol_boat_layout as S   # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, loft, chamfer_box, ngon_ring, limb
from gltf_export import export
import parts as P

STEM = 'ms_patrol_boat'
OUT = 'out'


# ── helpers ──────────────────────────────────────────────────────────────

def ring_from_section(sec):
    z, yk, yc, yd, wk, wc, wd = sec
    return [
        (wk, yk, z), (wc, yc, z), (wd, yd, z),      # +x keel -> chine -> sheer
        (-wd, yd, z), (-wc, yc, z), (-wk, yk, z),   # deck across, -x down
    ]


def hull_zone(c, n):
    if n[1] > 0.5:
        return S.S_DECK
    if n[1] < -0.55:
        return S.S_BELLY
    return S.S_HULL_SIDE


def interp_col(z, col):
    zs = [s[0] for s in S.HULL_SECTIONS]
    return float(np.interp(z, zs, [s[col] for s in S.HULL_SECTIONS]))


# ── body ─────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    rings = [ring_from_section(s) for s in S.HULL_SECTIONS]
    loft(p, rings, hull_zone)

    # bow cap (tiny end polygon) + stern transom
    zb = S.HULL_SECTIONS[0][0]
    _, yk, yc, yd, wk, wc, wd = S.HULL_SECTIONS[0]
    P.quad_out(p, [(wk, yk, zb), (wc, yc, zb), (wd, yd, zb),
                   (-wd, yd, zb), (-wc, yc, zb), (-wk, yk, zb)],
               (0, 0, -1), S.S_HULL_SIDE)
    zs_ = S.HULL_SECTIONS[-1][0]
    _, yk, yc, yd, wk, wc, wd = S.HULL_SECTIONS[-1]
    P.quad_out(p, [(wk, yk, zs_), (wc, yc, zs_), (wd, yd, zs_),
                   (-wd, yd, zs_), (-wc, yc, zs_), (-wk, yk, zs_)],
               (0, 0, 1), S.S_STERN)

    # spray rails at the chine knuckle (both sides, segmented to follow it)
    for (z0, z1) in S.SPRAY_RUNS:
        zs = np.linspace(z0, z1, 4)
        for sx in (1, -1):
            for i in range(len(zs) - 1):
                a_z, b_z = zs[i], zs[i + 1]
                a = (sx * (interp_col(a_z, 5) + 0.05),
                     interp_col(a_z, 2) + 0.06, a_z)
                b = (sx * (interp_col(b_z, 5) + 0.05),
                     interp_col(b_z, 2) + 0.06, b_z)
                limb(p, a, b, 0.06, 0.06, S.S_MAST, n=3)

    # gun ring platform on the foredeck
    cx, cy, cz = S.RING_C
    deck_y = interp_col(cz, 3)
    r0 = ngon_ring((cx, deck_y - 0.06, cz), S.RING_R, n=8, axis='y')
    r1 = ngon_ring((cx, cy, cz), S.RING_R, n=8, axis='y')
    loft(p, [r0, r1], lambda c, n: S.S_RING)
    P.quad_out(p, r1, (0, 1, 0), S.S_RING)
    # ring coaming (open gun ring read): low posts around the rim
    for i in range(8):
        a = i * np.pi / 4 + np.pi / 8
        px_, pz_ = cx + 0.98 * np.cos(a), cz + 0.98 * np.sin(a)
        limb(p, (px_, cy, pz_), (px_, cy + 0.42, pz_), 0.035, 0.03,
             S.S_RAIL, n=3)

    # wheelhouse
    x, y, z, w, h, d = S.WH
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+x': S.S_WH_SIDE, '-x': S.S_WH_SIDE, '-z': S.S_WH_FRONT,
                 '+z': S.S_WH_FRONT, '+y': S.S_WH_TOP}, skip=('-y',))
    # roof team panel plinth (painted; small nav box on the roof)
    chamfer_box(p, (0.0, S.WH_ROOF_Y + 0.10, -0.6), (0.7, 0.2, 0.7), 0.03,
                {k: S.S_TRIM for k in ('+x', '-x', '+y', '+z', '-z')},
                skip=('-y',))

    # mast + yard + nav beacon
    limb(p, S.MAST_FOOT, S.MAST_TOP, 0.06, 0.04, S.S_MAST, n=4)
    limb(p, (-0.55, 4.45, 1.62), (0.55, 4.45, 1.62), 0.03, 0.03,
         S.S_MAST, n=3)
    P.beacon(p, (0.0, 5.22, 1.55), size=0.14, glow_zone=S.S_LIGHT)

    # stern equipment rack: crates + drums + tarp inside railing
    rng = np.random.default_rng(90210)
    P.crate(p, (-0.75, 1.15 + 0.375, 5.6), size=0.75, zone=S.S_RACK)
    P.crate(p, (-0.75, 1.15 + 0.30, 6.55), size=0.60, zone=S.S_RACK)
    P.drum(p, (0.75, 1.14, 5.7), r=0.30, h=0.85, zone=S.S_DRUM, n=6)
    P.drum(p, (0.75, 1.13, 6.45), r=0.30, h=0.85, zone=S.S_DRUM, n=6)
    P.tarp_over(p, (0.0, 1.12, 7.9), (2.4, 0.75, 1.6), sag=0.14,
                zone=S.S_RACK)
    for (a, b) in S.RAIL_RUNS:
        P.railing(p, a, b, h=0.8, post_step=1.5, r=0.035, zone=S.S_RAIL)

    return p


# ── flag whip ────────────────────────────────────────────────────────────

def build_flag():
    """Piece-local: pivot at the mast attachment; whip + cloth aft (+z)."""
    p = Part('flag')
    limb(p, (0, 0.30, 0), (0, -0.05, 0.04), 0.02, 0.015, S.S_MAST, n=3)
    w, h = S.FLAG_W, S.FLAG_H
    quad = [(0, 0.05, 0.05), (0, 0.05, 0.05 + w),
            (0, 0.05 + h, 0.05 + w), (0, 0.05 + h, 0.05)]
    p.add_face(quad, zone=S.S_FLAG)
    p.add_face(quad[::-1], zone=S.S_FLAG)
    return p


# ── clips ────────────────────────────────────────────────────────────────

def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    T = 6.0
    sway = [0.0, 9.0, 0.0, -9.0, 0.0]
    idle = {
        'name': 'idle',
        'channels': [
            ('flag', 'rotation', [(T * i / 4, qy(a))
                                  for i, a in enumerate(sway)]),
        ],
    }
    return [idle]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),  # 0
    ]
    t = P.turret_parts(body_index=0, mount=S.TURRET_OFF, ring_r=0.50,
                       barrel_len=S.BARREL_LEN, barrel_r=S.BARREL_R,
                       body_zone=S.S_TURRET, barrel_rect=S.S_BARREL)
    base = len(pieces)              # 1
    t[1]['parent'] = base           # barrel under turret
    t[2]['parent'] = base + 1       # muzzle under barrel
    pieces.extend(t)                # 1 turret, 2 barrel, 3 muzzle
    pieces.append(dict(name='flag', parent=0, offset=S.FLAG_OFF,
                       part=build_flag()))                      # 4
    pieces.append(dict(name='exhaust', parent=0, offset=S.EXHAUST_OFF,
                       part=None))                              # 5 (empty)
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_patrol_boat] total tris: {total}')
