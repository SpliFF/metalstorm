"""gen_ms_river_monitor — build ms_river_monitor + clips.

Armoured river monitor, ships-row s2 (35 m): shallow-draft flat-bottom
hull loft (waterline Y=0), low freeboard, sloped casemate armour
amidships, twin-gun main `turret`->`barrel`->`muzzle` chain forward on
the casemate roof, armoured wheelhouse, stub raked funnel, mast + nav
`radar` bar (idle clip), deck fittings (bollards, hatch coamings,
life-raft canisters), `exhaust` FX empty at the funnel mouth.

Usage: python3 gen_ms_river_monitor.py
"""
from __future__ import annotations
import numpy as np

import ms_river_monitor_layout as S  # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, loft, chamfer_box, tube, ngon_ring, limb
from gltf_export import export

STEM = 'ms_river_monitor'
OUT = 'out'


# ── helpers ──────────────────────────────────────────────────────────────

def ring_from_section(sec):
    z, yb, yk, yd, wb, wk, wd = sec
    return [
        (wb, yb, z), (wk, yk, z), (wd, yd, z),       # +x side up
        (-wd, yd, z), (-wk, yk, z), (-wb, yb, z),    # deck across, -x down
    ]


def hull_zone(c, n):
    if n[1] < -0.55:
        return S.S_BELLY
    if n[1] > 0.5:
        return S.S_DECK
    return S.S_HULL_SIDE


def box(p, center, size, zone, ch=0.04, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def quad_out(p, verts, outward, zone):
    """Add a polygon wound so its normal points along `outward`."""
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, outward) > 0 else list(verts)[::-1],
               zone=zone)


# ── body ─────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    rings = [ring_from_section(s) for s in S.HULL_SECTIONS]
    loft(p, rings, hull_zone)

    # bow face (raked stem cap) + stern transom
    for sec, zone, outward in ((S.HULL_SECTIONS[0], S.S_BOW, (0, 0, -1)),
                               (S.HULL_SECTIONS[-1], S.S_STERN, (0, 0, 1))):
        z, yb, yk, yd, wb, wk, wd = sec
        quad_out(p, [(-wb, yb, z), (wb, yb, z), (wk, yk, z), (-wk, yk, z)],
                 outward, zone)
        quad_out(p, [(-wk, yk, z), (wk, yk, z), (wd, yd, z), (-wd, yd, z)],
                 outward, zone)

    # sloped casemate armour (sides, ends, roof — no bottom)
    b0, b1, t0, t1 = S.CASE_Z0, S.CASE_Z1, S.CASE_TZ0, S.CASE_TZ1
    wb_, wt_, yD, yT = S.CASE_WB, S.CASE_WT, S.DECK_Y, S.CASE_TOP_Y
    for sx in (1, -1):
        quad_out(p, [(sx * wb_, yD, b0), (sx * wb_, yD, b1),
                     (sx * wt_, yT, t1), (sx * wt_, yT, t0)],
                 (sx, 0, 0), S.S_CASE_S)
    quad_out(p, [(-wb_, yD, b0), (wb_, yD, b0), (wt_, yT, t0),
                 (-wt_, yT, t0)], (0, 0, -1), S.S_CASE_END)
    quad_out(p, [(-wb_, yD, b1), (wb_, yD, b1), (wt_, yT, t1),
                 (-wt_, yT, t1)], (0, 0, 1), S.S_CASE_END)
    quad_out(p, [(-wt_, yT, t0), (wt_, yT, t0), (wt_, yT, t1),
                 (-wt_, yT, t1)], (0, 1, 0), S.S_CASE_TOP)

    # wheelhouse (armoured, slit windows painted on the zone)
    x, y, z, w, h, d = S.WH
    chamfer_box(p, (x, y, z), (w, h, d), 0.08,
                {'+x': S.S_WH_S, '-x': S.S_WH_S, '-z': S.S_WH_F,
                 '+z': S.S_WH_F, '+y': S.S_WH_TOP}, skip=('-y',))

    # stub raked funnel
    limb(p, S.FUNNEL_BASE, S.FUNNEL_TOP, S.FUNNEL_R0, S.FUNNEL_R1,
         S.S_FUNNEL, n=8, cap_end=S.S_DARK)

    # mast + crosstree on the wheelhouse roof
    limb(p, S.MAST_FOOT, S.MAST_TOP, 0.07, 0.05, S.S_MAST, n=4)
    limb(p, (-S.YARD_HW, 6.10, S.MAST_FOOT[2]),
         (S.YARD_HW, 6.10, S.MAST_FOOT[2]), 0.04, 0.04, S.S_MAST, n=4)

    # deck fittings: bollards, hatch coamings, life-raft canisters
    for (bz, side) in S.BOLLARDS:
        wd_ = float(np.interp(bz, [s[0] for s in S.HULL_SECTIONS],
                              [s[6] for s in S.HULL_SECTIONS]))
        yd_ = float(np.interp(bz, [s[0] for s in S.HULL_SECTIONS],
                              [s[3] for s in S.HULL_SECTIONS]))
        limb(p, (side * (wd_ - 0.45), yd_, bz),
             (side * (wd_ - 0.45), yd_ + 0.42, bz), 0.10, 0.10, S.S_MAST, n=4)
    for (hz,) in S.HATCHES:
        box(p, (0.0, S.DECK_Y + 0.16, hz), (1.9, 0.32, 1.9), S.S_HATCH,
            ch=0.03, skip=('-y',))
    for (rx, rz) in S.RAFTS:
        tube(p, [(rz - S.RAFT_LEN / 2, S.RAFT_R, 2.6),
                 (rz + S.RAFT_LEN / 2, S.RAFT_R, 2.6)], S.S_RAFT, n=6,
             xoff=rx, cap_start=S.S_DARK, cap_end=S.S_DARK)
    # towing post on the afterdeck
    limb(p, (0.0, S.DECK_Y, 13.0), (0.0, S.DECK_Y + 0.6, 13.0), 0.14, 0.12,
         S.S_MAST, n=4)
    return p


# ── turret chain ─────────────────────────────────────────────────────────

def build_turret():
    """Piece-local, pivot at the casemate roof. Round barbette + sloped
    armoured house; engine yaws this piece."""
    p = Part('turret')
    r = S.TUR_RING_R
    # barbette ring
    rings = [ngon_ring((0, 0.0, 0), r, n=8, axis='y'),
             ngon_ring((0, 0.22, 0), r * 0.97, n=8, axis='y')]
    loft(p, rings, lambda c, n: S.S_TUR_S)
    # sloped house: base rect -> smaller top rect (armour slope all round)
    hb, ht = 1.55, 1.05           # half-widths base/top
    db0, db1 = -1.95, 1.85        # base z extent
    dt0, dt1 = -1.45, 1.35        # top z extent
    y0, y1 = 0.22, 1.55
    corners_b = [(hb, y0, db0), (hb, y0, db1), (-hb, y0, db1), (-hb, y0, db0)]
    corners_t = [(ht, y1, dt0), (ht, y1, dt1), (-ht, y1, dt1), (-ht, y1, dt0)]
    zones = (S.S_TUR_S, S.S_TUR_F, S.S_TUR_S, S.S_TUR_F)
    outw = ((1, 0, 0), (0, 0, 1), (-1, 0, 0), (0, 0, -1))
    for i in range(4):
        j = (i + 1) % 4
        quad_out(p, [corners_b[i], corners_b[j], corners_t[j], corners_t[i]],
                 outw[i], zones[i])
    quad_out(p, corners_t, (0, 1, 0), S.S_TUR_T)
    # mantlet block around the barrel roots
    box(p, (0.0, S.BAR_OFF[1], -1.62), (1.35, 0.62, 0.55), S.S_TUR_F,
        ch=0.05)
    # commander's hatch + vision block
    box(p, (0.55, 1.62, 0.3), (0.55, 0.14, 0.55), S.S_TUR_T, ch=0.02,
        skip=('-y',))
    return p


def build_barrel():
    p = Part('barrel')
    for sx in (1, -1):
        x = sx * S.BAR_SPACING
        limb(p, (x, 0, 0.25), (x, 0, -S.BAR_LEN), S.BAR_R, S.BAR_R * 0.82,
             S.S_BARREL, n=6)
        # muzzle reinforce
        limb(p, (x, 0, -S.BAR_LEN + 0.55), (x, 0, -S.BAR_LEN + 0.02),
             S.BAR_R * 1.25, S.BAR_R * 1.25, S.S_BARREL, n=6,
             cap_end=S.S_DARK)
    return p


# ── radar ────────────────────────────────────────────────────────────────

def build_radar():
    p = Part('radar')
    limb(p, (0, -0.30, 0), (0, -0.05, 0), 0.09, 0.07, S.S_MAST, n=4)
    box(p, (0, 0.10, 0), (1.5, 0.26, 0.30), S.S_RADAR, ch=0.03)
    return p


# ── clips ────────────────────────────────────────────────────────────────

def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    T = 8.0
    idle = {
        'name': 'idle',
        'channels': [
            ('radar', 'rotation', [(T * i / 4, qy(90.0 * i))
                                   for i in range(5)]),
        ],
    }
    return [idle]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    pieces = [
        dict(name='body',   parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='turret', parent=0,  offset=S.TUR_MOUNT, part=build_turret()),
        dict(name='barrel', parent=1,  offset=S.BAR_OFF, part=build_barrel()),
        dict(name='muzzle', parent=2,  offset=S.MUZ_OFF, part=None),
        dict(name='radar',  parent=0,  offset=S.RADAR_OFF, part=build_radar()),
        dict(name='exhaust', parent=0, offset=S.EXHAUST_OFF, part=None),
    ]
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_river_monitor] total tris: {total}')
