"""gen_ms_ferry — build ms_ferry (double-ended vehicle ferry) + clips.

Civilian ships-row s2 (35 m): symmetric double-ended hull loft with a
flat open vehicle deck, pontoon sponsons on both sides, ramps hinged at
both ends (`ramp` -z, `ramp2` +z; clip `unload` lowers both), gantry
frame carrying a pilot house over the deck, link1..link4 transport
empties in two lanes, life-ring and drum clutter, corner bollards.

Usage: python3 gen_ms_ferry.py
"""
from __future__ import annotations
import numpy as np

import ms_ferry_layout as S  # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, loft, chamfer_box, limb
from gltf_export import export
import parts as P

STEM = 'ms_ferry'
OUT = 'out'


def ring_from_section(sec):
    z, yb, yk, yd, wb, wk, wd = sec
    return [
        (wb, yb, z), (wk, yk, z), (wd, yd, z),
        (-wd, yd, z), (-wk, yk, z), (-wb, yb, z),
    ]


def hull_zone(c, n):
    if n[1] > 0.5:
        return S.S_DECK
    if n[1] < -0.5:
        return S.S_BELLY
    return S.S_HULL


def box(p, center, size, zone, ch=0.04, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def interp_col(z, col):
    zs = [s[0] for s in S.HULL_SECTIONS]
    return float(np.interp(z, zs, [s[col] for s in S.HULL_SECTIONS]))


# ── body ─────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    rings = [ring_from_section(s) for s in S.HULL_SECTIONS]
    loft(p, rings, hull_zone)

    # end faces (both ends, below the ramp sill)
    for sec, outward in ((S.HULL_SECTIONS[0], (0, 0, -1)),
                         (S.HULL_SECTIONS[-1], (0, 0, 1))):
        z, yb, yk, yd, wb, wk, wd = sec
        P.quad_out(p, [(-wb, yb, z), (wb, yb, z), (wk, yk, z), (-wk, yk, z)],
                   outward, S.S_END)
        P.quad_out(p, [(-wk, yk, z), (wk, yk, z), (wd, yd, z), (-wd, yd, z)],
                   outward, S.S_END)

    # pontoon sponsons
    for sx in (1, -1):
        cx, cy, cz = S.SPON_C
        P.box6(p, (sx * cx, cy, cz), S.SPON_SZ, S.S_SPON, ch=0.12)

    # gantry frame: 4 legs + top cross beams + diagonal braces
    zg = S.GANTRY_Z
    for sx in (1, -1):
        for dz in (-0.95, 0.95):
            limb(p, (sx * S.GANTRY_LEG_X, S.DECK_Y, zg + dz),
                 (sx * S.GANTRY_LEG_X * 0.88, S.GANTRY_TOP_Y, zg + dz * 0.6),
                 0.13, 0.10, S.S_GANTRY, n=4)
        # side spandrel beam between leg tops
        limb(p, (sx * S.GANTRY_LEG_X * 0.88, S.GANTRY_TOP_Y, zg - 0.57),
             (sx * S.GANTRY_LEG_X * 0.88, S.GANTRY_TOP_Y, zg + 0.57),
             0.10, 0.10, S.S_GANTRY, n=4)
    # transverse top beams the cabin sits on
    for dz in (-0.75, 0.75):
        limb(p, (-S.GANTRY_LEG_X * 0.88, S.GANTRY_TOP_Y, zg + dz),
             (S.GANTRY_LEG_X * 0.88, S.GANTRY_TOP_Y, zg + dz),
             0.11, 0.11, S.S_GANTRY, n=4)

    # pilot house atop the gantry
    x, y, z, w, h, d = S.CABIN
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+x': S.S_CAB_S, '-x': S.S_CAB_S, '+z': S.S_CAB_F,
                 '-z': S.S_CAB_F, '+y': S.S_CAB_TOP}, skip=('-y',))
    # mast + beacon + stubby exhaust on the roof
    limb(p, (0, y + h / 2, z), S.MAST_TOP, 0.06, 0.04, S.S_POST, n=4)
    P.beacon(p, S.BEACON_C, size=0.16, glow_zone=S.S_DARK)
    limb(p, (1.1, y + h / 2, z + 0.7), (1.1, y + h / 2 + 0.9, z + 0.7),
         0.14, 0.12, S.S_POST, n=4)

    # life ring on the +x gantry leg (thin box, painted ring)
    rx, ry, rz = S.RING_C
    box(p, (rx, ry, rz), (0.10, 0.80, 0.80), S.S_RING, ch=0.02)

    # drum clutter beside a gantry leg (off the traffic lanes)
    dx, dy, dz2 = S.DRUMS
    P.drum(p, (dx, dy + 0.45, dz2 - 0.35), r=0.30, h=0.90, zone=S.S_DRUM, n=8)
    P.drum(p, (dx - 0.15, dy + 0.45, dz2 + 0.42), r=0.30, h=0.90,
           zone=S.S_DRUM, n=8)

    # corner bollards + low kerb rails along the deck edges
    for bz in S.BOLLARD_Z:
        wd_ = interp_col(bz, 6)
        for sx in (1, -1):
            limb(p, (sx * (wd_ - 0.35), S.DECK_Y, bz),
                 (sx * (wd_ - 0.35), S.DECK_Y + 0.45, bz), 0.10, 0.10,
                 S.S_POST, n=4)
    for sx in (1, -1):
        box(p, (sx * 3.28, S.DECK_Y + 0.08, 0.0), (0.22, 0.16, 26.0),
            S.S_TRIM, ch=0.02, skip=('-y',))
    return p


# ── ramps ────────────────────────────────────────────────────────────────

def build_ramp(name, lip_out_sign):
    """Piece-local: hinge axis = local X at origin; plate rises +Y when
    raised. lip_out_sign: -1 for the -z end ramp (outboard face -z),
    +1 for the +z end (outboard face +z)."""
    p = Part(name)
    w, h, t = S.RAMP_W, S.RAMP_H, S.RAMP_T
    zc = lip_out_sign * -0.13
    out_zone = S.S_RAMP_OUT
    in_zone = S.S_RAMP_IN
    zones = {'+x': S.S_TRIM, '-x': S.S_TRIM, '+y': S.S_TRIM, '-y': S.S_TRIM}
    if lip_out_sign < 0:
        zones['-z'] = out_zone
        zones['+z'] = in_zone
    else:
        zones['+z'] = out_zone
        zones['-z'] = in_zone
    chamfer_box(p, (0.0, h / 2, zc), (w, h, t), 0.04, zones)
    # stiffener ribs on the outboard face
    for ry in (0.85, 1.75):
        box(p, (0.0, ry, zc + lip_out_sign * (t / 2 + 0.06)),
            (w - 0.5, 0.22, 0.12), S.S_TRIM, ch=0.02)
    # hinge lugs
    for sx in (1, -1):
        box(p, (sx * (w / 2 - 0.25), 0.08, -zc * 0.4), (0.28, 0.4, 0.5),
            S.S_TRIM, ch=0.03)
    return p


# ── clips ────────────────────────────────────────────────────────────────

def qx(deg):
    r = np.radians(deg) / 2
    return (float(np.sin(r)), 0.0, 0.0, float(np.cos(r)))


def build_clips():
    d = S.RAMP_DROP

    def keys(sign):
        return [(0.0, qx(0.0)), (0.5, qx(0.0)), (2.0, qx(sign * d * 0.55)),
                (4.0, qx(sign * d * 0.95)), (4.6, qx(sign * d)),
                (8.0, qx(sign * d))]

    unload = {
        'name': 'unload',
        'channels': [
            ('ramp', 'rotation', keys(1)),      # -z end: -100 deg
            ('ramp2', 'rotation', keys(-1)),    # +z end: +100 deg
        ],
    }
    return [unload]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='ramp', parent=0, offset=S.RAMP_HINGE,
             part=build_ramp('ramp', -1)),
        dict(name='ramp2', parent=0, offset=S.RAMP2_HINGE,
             part=build_ramp('ramp2', 1)),
    ]
    for i, off in enumerate(S.LINKS):
        pieces.append(dict(name=f'link{i + 1}', parent=0, offset=off,
                           part=None))
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_ferry] total tris: {total}')
