"""gen_ms_cargo_tramp — build ms_cargo_tramp + clips.

Tramp freighter, ships-row s3 (55 m): closed 6-point hull loft
(bottom/sides/deck in one skin, sheer rises into the forecastle),
two open holds with coamings + prefab crate/drum/tarp cargo, static
deck crane between the holds, aft superstructure with funnel, mast,
railings, and a `laundry` piece on the poop deck (idle sway clip).

Usage: python3 gen_ms_cargo_tramp.py
"""
from __future__ import annotations
import numpy as np

import ms_cargo_tramp_layout as S   # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, loft, chamfer_box, limb, ngon_ring
from gltf_export import export
import parts as P

STEM = 'ms_cargo_tramp'
OUT = 'out'
RNG = np.random.default_rng(90210)


# ── helpers ──────────────────────────────────────────────────────────────

def ring_from_section(sec):
    z, yb, yk, yt, wb, wk, wt = sec
    return [
        (wb, yb, z), (wk, yk, z), (wt, yt, z),
        (-wt, yt, z), (-wk, yk, z), (-wb, yb, z),
    ]


def hull_zone(c, n):
    if n[1] < -0.5:
        return S.S_BELLY
    if n[1] > 0.5:
        return S.S_DECK
    return S.S_HULL_SIDE


def interp_col(z, col):
    zs = [s[0] for s in S.HULL_SECTIONS]
    return float(np.interp(z, zs, [s[col] for s in S.HULL_SECTIONS]))


# ── body ─────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    rings = [ring_from_section(s) for s in S.HULL_SECTIONS]
    loft(p, rings, hull_zone)

    # bow face (closes the first ring plane)
    _, yb, yk, yt, wb, wk, wt = S.HULL_SECTIONS[0]
    zb = S.HULL_SECTIONS[0][0]
    P.quad_out(p, [(-wb, yb, zb), (wb, yb, zb), (wk, yk, zb), (-wk, yk, zb)],
               (0, 0, -1), S.S_BOW)
    P.quad_out(p, [(-wk, yk, zb), (wk, yk, zb), (wt, yt, zb), (-wt, yt, zb)],
               (0, 0, -1), S.S_BOW)
    # stern transom
    _, yb, yk, yt, wb, wk, wt = S.HULL_SECTIONS[-1]
    zs_ = S.HULL_SECTIONS[-1][0]
    P.quad_out(p, [(-wb, yb, zs_), (wb, yb, zs_), (wk, yk, zs_),
                   (-wk, yk, zs_)], (0, 0, 1), S.S_STERN)
    P.quad_out(p, [(-wk, yk, zs_), (wk, yk, zs_), (wt, yt, zs_),
                   (-wt, yt, zs_)], (0, 0, 1), S.S_STERN)

    # hold coamings + cargo
    for (z0, z1) in S.HOLDS:
        yc = (S.COAM_Y0 + S.COAM_Y1) / 2
        h = S.COAM_Y1 - S.COAM_Y0
        zm = (z0 + z1) / 2
        for sx in (1, -1):
            chamfer_box(p, (sx * S.HOLD_HW, yc, zm),
                        (S.COAM_T, h, z1 - z0), 0.02,
                        {'+x': S.S_COAM, '-x': S.S_COAM, '+y': S.S_COAM_TOP,
                         '+z': S.S_COAM, '-z': S.S_COAM}, skip=('-y',))
        for ze in (z0, z1):
            chamfer_box(p, (0.0, yc, ze), (S.HOLD_HW * 2, h, S.COAM_T), 0.02,
                        {'+x': S.S_COAM, '-x': S.S_COAM, '+y': S.S_COAM_TOP,
                         '+z': S.S_COAM, '-z': S.S_COAM}, skip=('-y',))

    # hold 1: crate cargo poking above the coaming
    P.crate_stack(p, (0.15, S.DECK_Y + 0.1, -11.0), rows=2, cols=3, tiers=2,
                  size=1.15, zone=S.S_CRATE, rng=RNG)
    # hold 2: drums forward, tarped stack aft
    P.drum_row(p, (-1.7, S.DECK_Y + 0.1, -1.6), count=4, r=0.34, h=1.0,
               zone=S.S_DRUM)
    P.drum_row(p, (-1.7, S.DECK_Y + 0.1, -0.7), count=4, r=0.34, h=1.0,
               zone=S.S_DRUM)
    P.tarp_over(p, (0.0, S.DECK_Y + 0.1, 2.9), (4.2, 1.5, 3.4), sag=0.22,
                zone=S.S_TARP)

    # deck crane between the holds (static jib over hold 1)
    chamfer_box(p, (0.0, S.DECK_Y + 0.35, S.CRANE_Z), (1.5, 0.7, 1.5), 0.05,
                {'+x': S.S_TRIM, '-x': S.S_TRIM, '+y': S.S_TRIM,
                 '+z': S.S_TRIM, '-z': S.S_TRIM}, skip=('-y',))
    limb(p, (0.0, S.DECK_Y + 0.6, S.CRANE_Z), (0.0, S.CRANE_TOP, S.CRANE_Z),
         0.28, 0.20, S.S_MAST, n=6)
    limb(p, (0.0, S.CRANE_TOP - 0.4, S.CRANE_Z), S.JIB_TIP, 0.16, 0.09,
         S.S_MAST, n=4)
    # cables: topping lift + fall with hook block
    limb(p, (0.0, S.CRANE_TOP, S.CRANE_Z), S.JIB_TIP, 0.025, 0.025,
         S.S_RAIL, n=3)
    tx, ty, tz = S.JIB_TIP
    limb(p, (tx, ty, tz), (tx, ty - 1.6, tz), 0.02, 0.02, S.S_RAIL, n=3)
    P.box6(p, (tx, ty - 1.75, tz), (0.22, 0.3, 0.22), S.S_DARK, ch=0.02)

    # aft superstructure + funnel
    x, y, z, w, h, d = S.SUPER
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+x': S.S_SUPER_S, '-x': S.S_SUPER_S, '-z': S.S_SUPER_F,
                 '+z': S.S_SUPER_F, '+y': S.S_SUPER_TOP}, skip=('-y',))
    fx, fz = S.FUNNEL
    limb(p, (fx, y + h / 2, fz), (fx, S.FUNNEL_TOP, fz), 0.85, 0.70,
         S.S_FUNNEL, n=6, cap_end=S.S_DARK)

    # forecastle mast + yard + aerial
    limb(p, S.MAST_FOOT, S.MAST_TOP, 0.10, 0.06, S.S_MAST, n=4)
    limb(p, (-S.YARD_HW, 9.6, -23.0), (S.YARD_HW, 9.6, -23.0), 0.04, 0.04,
         S.S_MAST, n=4)
    P.antenna(p, (0.4, 9.9, 19.5), h=2.4, zone=S.S_RAIL)

    # railings: main deck sides, forecastle front, poop deck
    for sx in (1, -1):
        P.railing(p, (sx * 4.45, S.DECK_Y, -18.5), (sx * 4.45, S.DECK_Y, 13.0),
                  h=0.9, post_step=3.5, r=0.035, zone=S.S_RAIL)
        P.railing(p, (sx * 3.0, S.DECK_Y + 0.15, 26.0),
                  (sx * 3.0, S.DECK_Y + 0.15, 22.2),
                  h=0.9, post_step=2.0, r=0.035, zone=S.S_RAIL)
    P.railing(p, (-3.9, S.FC_DECK_Y, -20.4), (3.9, S.FC_DECK_Y, -20.4),
              h=0.9, post_step=2.0, r=0.035, zone=S.S_RAIL)

    # laundry posts on the poop deck (line itself is the animated piece)
    lx, ly, lz = S.LAUNDRY_OFF
    for sx in (1, -1):
        limb(p, (sx * S.LAUNDRY_HW, 4.45, lz), (sx * S.LAUNDRY_HW, ly, lz),
             0.05, 0.04, S.S_RAIL, n=4)

    # bollards fore + aft
    for (bz, by) in ((-22.0, S.FC_DECK_Y), (25.5, 4.45)):
        for sx in (1, -1):
            limb(p, (sx * 2.4, by, bz), (sx * 2.4, by + 0.4, bz), 0.10, 0.10,
                 S.S_MAST, n=4)
    return p


# ── laundry (animated piece) ─────────────────────────────────────────────

def build_laundry():
    """Piece-local: pivot ON the line; cloths hang -Y. Sway about X."""
    p = Part('laundry')
    hw = S.LAUNDRY_HW
    limb(p, (-hw, 0, 0), (hw, 0, 0), 0.025, 0.025, S.S_RAIL, n=3)
    for (x0, x1, drop) in ((-1.6, -0.75, 0.75), (-0.4, 0.5, 0.65),
                           (0.85, 1.55, 0.8)):
        v = [(x0, -0.02, 0.0), (x1, -0.02, 0.0),
             (x1, -0.02 - drop, 0.06), (x0, -0.02 - drop, 0.06)]
        p.add_face(v, zone=S.S_CLOTH)
        p.add_face(v[::-1], zone=S.S_CLOTH)
    return p


# ── clips ────────────────────────────────────────────────────────────────

def qx(deg):
    r = np.radians(deg) / 2
    return (float(np.sin(r)), 0.0, 0.0, float(np.cos(r)))


def build_clips():
    a = S.LAUNDRY_SWAY
    idle = {
        'name': 'idle',
        'channels': [
            ('laundry', 'rotation', [
                (0.0, qx(0.0)), (1.0, qx(a)), (2.0, qx(0.0)),
                (3.0, qx(-a)), (4.0, qx(0.0)),
            ]),
        ],
    }
    return [idle]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='laundry', parent=0, offset=S.LAUNDRY_OFF,
             part=build_laundry()),
        dict(name='exhaust', parent=0, offset=S.EXHAUST_OFF, part=None),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_cargo_tramp] total tris: {total}')
