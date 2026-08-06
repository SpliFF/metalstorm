"""gen_ms_fishing_trawler — build ms_fishing_trawler + clips.

s1 civilian trawler (~18 m): closed-ring hull loft (high sheer bow,
fo'c'sle stepping down to the aft working deck), wheelhouse with mast
and exhaust stub, aft A-frame gantry carrying the animated `boom`
piece (net + floats hang from it; clip `idle` sways it about Z),
trawl winch, fish crate stacks, bulwark rails, bollards, and a net
draped over the starboard rail. No team colour (map prop).

Usage: python3 gen_ms_fishing_trawler.py
"""
from __future__ import annotations
import numpy as np

import ms_fishing_trawler_layout as S   # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, loft, chamfer_box, ngon_ring, limb
from gltf_export import export
import parts as PP

STEM = 'ms_fishing_trawler'
OUT = 'out'


# ── helpers ──────────────────────────────────────────────────────────────

def ring_from_section(sec):
    z, yk_, ykn, yd, wk, wkn, wd = sec
    return [
        (wk, yk_, z), (wkn, ykn, z), (wd, yd, z),     # +x side up
        (-wd, yd, z), (-wkn, ykn, z), (-wk, yk_, z),  # deck across, -x down
    ]


def hull_zone(c, n):
    if n[1] < -0.5:
        return S.S_BELLY
    if n[1] > 0.5:
        return S.S_DECK
    return S.S_HULL_SIDE


def quad_out(p, verts, outward, zone):
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    nrm = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(nrm, outward) > 0 else list(verts)[::-1],
               zone=zone)


def dquad(p, a, b, c, d, zone):
    """Double-sided quad, SAME diagonal (a-c) on both sides."""
    p.add_face([a, b, c], zone=zone)
    p.add_face([a, c, d], zone=zone)
    p.add_face([c, b, a], zone=zone)
    p.add_face([d, c, a], zone=zone)


# ── body ─────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    rings = [ring_from_section(s) for s in S.HULL_SECTIONS]
    loft(p, rings, hull_zone)

    # bow cap (z=-9) and stern transom (z=8.8)
    for sec, outward, zone in ((S.HULL_SECTIONS[0], (0, 0, -1), S.S_BOW),
                               (S.HULL_SECTIONS[-1], (0, 0, 1), S.S_STERN)):
        z, yk_, ykn, yd, wk, wkn, wd = sec
        quad_out(p, [(-wd, yd, z), (wd, yd, z), (wkn, ykn, z),
                     (-wkn, ykn, z)], outward, zone)
        quad_out(p, [(-wkn, ykn, z), (wkn, ykn, z), (wk, yk_, z),
                     (-wk, yk_, z)], outward, zone)

    # wheelhouse
    x, y, z, w, h, d = S.WH
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+x': S.S_WH_S, '-x': S.S_WH_S, '+z': S.S_WH_F,
                 '-z': S.S_WH_F, '+y': S.S_WH_TOP}, skip=('-y',))
    # mast + yard + antenna + exhaust stub
    limb(p, S.MAST_FOOT, S.MAST_TOP, 0.06, 0.04, S.S_MAST, n=4)
    limb(p, (-0.8, 5.9, -3.6), (0.8, 5.9, -3.6), 0.03, 0.03, S.S_MAST, n=3)
    PP.antenna(p, (-0.9, 4.10, -2.6), h=1.6, zone=S.S_MAST)
    sx, sy, sz = S.STACK
    limb(p, (sx, sy, sz), (sx, S.STACK_TOP, sz), 0.17, 0.15, S.S_WINCH,
         n=5, cap_end=S.S_DARK)

    # A-frame stern gantry
    for i, (fx, fy, fz) in enumerate(S.GANTRY_FEET):
        top = S.GANTRY_TOP[0] if fx > 0 else S.GANTRY_TOP[1]
        limb(p, (fx, fy, fz), top, 0.10, 0.07, S.S_RAIL, n=4)
    limb(p, S.GANTRY_TOP[0], S.GANTRY_TOP[1], 0.09, 0.09, S.S_RAIL, n=4)

    # trawl winch: drum + support cheeks
    (ax_, ay_, az_), (bx_, by_, bz_), wr = S.WINCH
    limb(p, (ax_, ay_, az_), (bx_, by_, bz_), wr, wr, S.S_WINCH, n=6)
    for wx_ in (ax_, bx_):
        limb(p, (wx_, S.DECK_AFT_Y, az_), (wx_, ay_, az_), 0.10, 0.08,
             S.S_RAIL, n=4)

    # fish crates: stack on the working deck + two loose ones
    rng = np.random.default_rng(90210)
    PP.crate_stack(p, S.CRATES, rows=2, cols=2, tiers=2, size=0.55,
                   zone=S.S_CRATE, rng=rng)
    PP.crate(p, (-1.55, S.DECK_AFT_Y + 0.30, 3.3), size=0.60, zone=S.S_CRATE)
    PP.crate(p, (-1.35, S.DECK_AFT_Y + 0.26, 4.05), size=0.52, zone=S.S_CRATE)

    # bulwark rails + bollards
    for a, b in S.RAIL_RUNS:
        PP.railing(p, a, b, h=0.72, post_step=2.2, r=0.035, zone=S.S_RAIL)
    for bx_, by_, bz_ in S.BOLLARDS:
        limb(p, (bx_, by_, bz_), (bx_, by_ + 0.35, bz_), 0.08, 0.08,
             S.S_MAST, n=4)

    # net draped over the starboard rail (double-sided, sags inboard)
    z0, z1 = S.NET_SIDE_Z
    zm = (z0 + z1) / 2
    dquad(p, (2.45, 2.05, z0), (2.45, 2.02, z1),
          (1.55, 1.38, z1 - 0.4), (1.55, 1.38, z0 + 0.4), S.S_NET_SIDE)
    dquad(p, (2.45, 2.05, z0), (2.62, 0.95, z0 + 0.3),
          (2.60, 0.92, z1 - 0.3), (2.45, 2.02, z1), S.S_NET_SIDE)
    # cork floats along the rail-hung net
    for fx, fy, fz in S.FLOATS_SIDE:
        PP.box6(p, (fx, fy + 0.75, fz), (0.22, 0.18, 0.22), S.S_FLOAT,
                ch=0.03)
    return p


# ── boom (animated; net + floats hang from it) ───────────────────────────

def build_boom():
    p = Part('boom')
    tip = S.BOOM_TIP
    limb(p, (0, 0, 0), tip, 0.09, 0.05, S.S_BOOM, n=4)
    # lifting tackle: short pendant down from 70% along the spar
    hx, hy, hz = 0.0, tip[1] * 0.7, tip[2] * 0.7
    limb(p, (hx, hy, hz), (hx, hy - 0.55, hz), 0.02, 0.02, S.S_BOOM, n=3)
    # hung net bundle: main panel + narrow crossing skirt (double-sided)
    ny = hy - 0.55
    dquad(p, (-1.35, ny, hz - 0.15), (1.35, ny, hz - 0.15),
          (0.85, ny - 2.6, hz + 0.25), (-0.85, ny - 2.6, hz + 0.25), S.S_NET)
    dquad(p, (-0.9, ny, hz + 0.3), (0.9, ny, hz + 0.3),
          (0.55, ny - 2.1, hz - 0.2), (-0.55, ny - 2.1, hz - 0.2), S.S_NET)
    # cork floats clipped along the headrope
    for fx in (-1.0, -0.33, 0.33, 1.0):
        PP.box6(p, (fx, ny - 0.10, hz), (0.20, 0.16, 0.20), S.S_FLOAT,
                ch=0.03)
    return p


# ── clips ────────────────────────────────────────────────────────────────

def qz(deg):
    r = np.radians(deg) / 2
    return (0.0, 0.0, float(np.sin(r)), float(np.cos(r)))


def build_clips():
    a = S.BOOM_SWAY
    idle = {
        'name': 'idle',
        'channels': [
            ('boom', 'rotation', [
                (0.0, qz(0.0)), (2.0, qz(a)), (4.0, qz(0.0)),
                (6.0, qz(-a)), (8.0, qz(0.0)),
            ]),
        ],
    }
    return [idle]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='boom', parent=0, offset=S.BOOM_PIVOT, part=build_boom()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_fishing_trawler] total tris: {total}')
