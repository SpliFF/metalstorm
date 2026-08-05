"""gen_ms_pontoon_wharf — build ms_pontoon_wharf + idle clip.

Transport terminus: 30 m floating wharf — three deck sections on six
visible pontoon floats, berth cleats + hanging fenders on the -X face,
railed walkway (+Z) to shore with its own float and ramp plate, staged
supply crates, seaward beacon mast, and a pedestal crane — the `crane`
piece slews lazily over the berth in the 20 s idle clip.  Sized for the
35 m landing ship alongside.  Tri budget 1500.

Usage: python3 gen_ms_pontoon_wharf.py [png]
"""
from __future__ import annotations
import os
import numpy as np

import ms_pontoon_wharf_layout as L    # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, chamfer_box, ngon_ring, limb
from gltf_export import export

STEM = 'ms_pontoon_wharf'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   '..', '..', 'out')


# ── helpers (forge patterns) ─────────────────────────────────────────────

def quad_out(p, verts, outward, zone):
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, outward) > 0 else verts[::-1], zone=zone)


def box(p, center, size, zone, ch=0.04, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def spot_zone(rect, cx, cz, r):
    """Dynamic top-cap zone centred on a world (x,z) spot."""
    return Zone(rect, ('x', 'z'), ((cx - r, cx + r), (cz - r, cz + r)))


def crate_zone(cx, cy, s):
    """Dynamic all-face zone window centred on one crate."""
    h = s / 2 + 0.1
    return Zone(L.W_CRATE.rect, ('x', 'y'), ((cx - h, cx + h),
                                             (cy + h, cy - h)))


# ── the wharf body ───────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    # deck sections (three floating slabs, 0.3 m gaps)
    for zc in L.SECTIONS:
        chamfer_box(p, (0.0, L.DECK_TOP - L.SECT_H / 2, zc),
                    (L.DECK_W, L.SECT_H, L.SECT_L), 0.06,
                    {'+y': L.W_DECK, '-y': L.W_PONT_TOP,
                     '+x': L.W_DECKSIDE, '-x': L.W_DECKSIDE,
                     '+z': L.W_DECKEND, '-z': L.W_DECKEND})
    # pontoon floats (pairs under each section — the floating read)
    pw, ph, pd = L.PONT_SIZE
    for zc in L.SECTIONS:
        for sx in (-1, 1):
            chamfer_box(p, (sx * L.PONT_X, ph / 2, zc), (pw, ph, pd), 0.12,
                        {'+y': L.W_PONT_TOP, '-y': L.W_PONT_TOP,
                         '+x': L.W_PONT, '-x': L.W_PONT,
                         '+z': L.W_PONT_F, '-z': L.W_PONT_F})
    # walkway to shore: slab + float + shore ramp plate
    wz0, wz1 = L.WALK_Z
    chamfer_box(p, (0.0, L.WALK_TOP - 0.225, (wz0 + wz1) / 2),
                (L.WALK_W, 0.45, wz1 - wz0), 0.05,
                {'+y': L.W_WALK, '-y': L.W_PONT_TOP,
                 '+x': L.W_DECKSIDE, '-x': L.W_DECKSIDE,
                 '+z': L.W_DECKEND, '-z': L.W_DECKEND})
    wx, wy, wzc, ww, wh, wd = L.WALK_PONT
    chamfer_box(p, (wx, wy, wzc), (ww, wh, wd), 0.12,
                {'+y': L.W_PONT_TOP, '-y': L.W_PONT_TOP,
                 '+x': L.W_PONT, '-x': L.W_PONT,
                 '+z': L.W_PONT_F, '-z': L.W_PONT_F})
    rz0, rz1 = L.RAMP_Z
    ry0, ry1 = L.RAMP_Y
    hw = L.WALK_W / 2 - 0.15
    plate = [(-hw, ry0, rz0), (hw, ry0, rz0), (hw, ry1, rz1), (-hw, ry1, rz1)]
    quad_out(p, plate, (0, 1, 0.3), L.W_WALK)
    quad_out(p, list(plate), (0, -1, -0.3), L.W_DARK)
    # walkway handrails: posts + top rail (limbs — cheap, silhouette-true)
    for sx in (-1, 1):
        rx = sx * L.RAIL_X
        for pz in L.RAIL_POSTS:
            limb(p, (rx, L.WALK_TOP, pz), (rx, L.WALK_TOP + L.RAIL_H, pz),
                 0.045, 0.045, L.W_RAIL, n=4)
        limb(p, (rx, L.WALK_TOP + L.RAIL_H, wz0 + 0.2),
             (rx, L.WALK_TOP + L.RAIL_H, wz1 + 0.2), 0.05, 0.05,
             L.W_RAIL, n=4, cap_start=L.W_DARK, cap_end=L.W_DARK)
        limb(p, (rx, L.WALK_TOP + 0.5, wz0 + 0.2),
             (rx, L.WALK_TOP + 0.5, wz1 + 0.2), 0.03, 0.03, L.W_RAIL, n=4)
    # berth cleats (-X edge): post + horn bar
    for cz in L.CLEATS:
        limb(p, (L.CLEAT_X, L.DECK_TOP - 0.05, cz),
             (L.CLEAT_X, L.DECK_TOP + 0.30, cz), 0.075, 0.06, L.W_CLEAT, n=4)
        limb(p, (L.CLEAT_X, L.DECK_TOP + 0.30, cz - 0.30),
             (L.CLEAT_X, L.DECK_TOP + 0.30, cz + 0.30), 0.058, 0.058,
             L.W_CLEAT, n=4, cap_start=L.W_DARK, cap_end=L.W_DARK)
    # hanging fenders: berth face (4) + spares on +X (2)
    fy0, fy1 = L.FENDER_Y
    for fz in L.FENDERS_B:
        limb(p, (-3.38, fy0, fz), (-3.38, fy1, fz), L.FENDER_R, L.FENDER_R,
             L.W_FENDER, n=6, cap_end=L.W_DARK)
    for fz in L.FENDERS_S:
        limb(p, (3.38, fy0, fz), (3.38, fy1, fz), L.FENDER_R, L.FENDER_R,
             L.W_FENDER, n=6, cap_end=L.W_DARK)
    # crane pedestal (crane piece sits on the bearing at PED_TOP)
    px, pz = L.PED_XZ
    r0, r1 = L.PED_R
    limb(p, (px, L.DECK_TOP - 0.05, pz), (px, L.PED_TOP, pz), r0, r1,
         L.W_PED, n=8)
    # seaward beacon mast + lamp head
    mx, mz = L.MAST_XZ
    limb(p, (mx, L.DECK_TOP, mz), (mx, L.MAST_TOP - 0.4, mz), 0.09, 0.06,
         L.W_RAIL, n=6)
    limb(p, (mx, L.MAST_TOP - 0.4, mz), (mx, L.MAST_TOP, mz), 0.16, 0.14,
         L.W_LIGHT, n=6,
         cap_end=spot_zone(L.W_DARK.rect, mx, mz, 0.2))
    # staged supply crates near the walkway junction
    for (cx, cz, cs) in L.CRATES:
        cy = L.DECK_TOP + cs / 2
        box(p, (cx, cy, cz), (cs, cs, cs), crate_zone(cx, cy, cs), ch=0.05)
    return p


# ── the crane (slew piece; boom fixed to the cab, rest pose -Z) ──────────

def build_crane():
    p = Part('crane')
    # cab on the bearing
    chamfer_box(p, (0.0, 0.55, 0.15), (1.7, 1.1, 2.3), 0.08,
                {'+y': L.W_CRANE, '-y': L.W_CRANE,
                 '+x': L.W_CRANE, '-x': L.W_CRANE,
                 '+z': L.W_CRANE_F, '-z': L.W_CRANE_F})
    # counterweight block aft
    chamfer_box(p, (0.0, 0.80, 1.60), (1.4, 0.9, 0.85), 0.08,
                {'+y': L.W_CRANE, '-y': L.W_CRANE,
                 '+x': L.W_CRANE, '-x': L.W_CRANE,
                 '+z': L.W_CRANE_F, '-z': L.W_CRANE_F})
    # A-frame post + boom + tie rod
    limb(p, (0.0, 1.10, 0.55), (0.0, 2.30, 0.75), 0.13, 0.10, L.W_BOOM, n=4)
    bx, by, bz = L.BOOM_TIP
    limb(p, (0.0, 0.95, -0.85), (bx, by, bz), 0.23, 0.10, L.W_BOOM, n=4,
         cap_end=L.W_DARK)
    limb(p, (0.0, 2.30, 0.70), (bx, by - 0.12, bz + 0.55), 0.045, 0.045,
         L.W_CLEAT, n=4)
    # hoist cable + hook block hanging near the tip
    limb(p, (0.0, by - 0.10, L.HOOK_Z), (0.0, 1.45, L.HOOK_Z), 0.028, 0.028,
         L.W_CLEAT, n=4)
    chamfer_box(p, (0.0, 1.25, L.HOOK_Z), (0.30, 0.42, 0.24), 0.03,
                {'+y': L.W_HOOK, '-y': L.W_HOOK, '+x': L.W_HOOK,
                 '-x': L.W_HOOK, '+z': L.W_HOOK, '-z': L.W_HOOK})
    limb(p, (0.0, 1.04, L.HOOK_Z), (0.0, 0.86, L.HOOK_Z + 0.12), 0.045,
         0.035, L.W_CLEAT, n=4, cap_end=L.W_DARK)
    return p


# ── clips ────────────────────────────────────────────────────────────────

def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    """Idle: lazy crane slew over the berth (+yaw swings the -Z boom
    toward the -X berth face), dwell, swing back past centre, return.
    Last key repeats the first for a seamless loop."""
    keys = [(0.0, qy(0.0)), (2.0, qy(0.0)), (5.5, qy(42.0)),
            (9.0, qy(42.0)), (12.0, qy(0.0)), (14.0, qy(0.0)),
            (16.5, qy(-28.0)), (18.5, qy(-28.0)), (20.0, qy(0.0))]
    idle = {'name': 'idle', 'channels': [('crane', 'rotation', keys)]}
    return [idle]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='crane', parent=0, offset=L.CRANE_OFF, part=build_crane()),
        dict(name='berth', parent=0, offset=L.BERTH_OFF, part=None),
        dict(name='shore', parent=0, offset=L.SHORE_OFF, part=None),
    ]
    return pieces


if __name__ == '__main__':
    import sys
    pieces = build_all()
    clips = build_clips()
    modes = ['png'] if 'png' in sys.argv[1:] else ['ktx2', 'png']
    for mode in modes:
        export(pieces, STEM, texmode=mode, outdir=OUT, clips=clips,
               normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_pontoon_wharf] total tris: {total}')
