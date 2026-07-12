"""gen_battleship — build fable_battleship (FNS Sovereign) + idle clip.

80 m capital hull: sheer-lined loft, three triple-railgun turrets on
barbettes (A/B superfiring fore, C aft), stacked superstructure with
bridge wings and fire-control tower, raked funnel, lattice mast with a
rotating radar, VLS panel, boats on davits, PDC mounts, deck railings.

Usage: python3 gen_battleship.py [png]
"""
from __future__ import annotations
import numpy as np

import battleship_layout as B      # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, loft, chamfer_box, tube, ngon_ring, limb, mirror_x
from gltf_export import export

STEM = 'fable_battleship'
OUT = 'out'


# ── helpers ──────────────────────────────────────────────────────────────

def ring_from_section(sec):
    z, yb, yw, ys, yd, wb, ww, wd, wt = sec
    return [
        (wb, yb, z), (ww, yw, z), (wd, ys, z), (wt, yd, z),
        (-wt, yd, z), (-wd, ys, z), (-ww, yw, z), (-wb, yb, z),
    ]


def drum_y(p, cx, cz, ybase, ytop, r0, wrap_rect, cap_zone=None, n=8, r1=None):
    r1_ = r0 if r1 is None else r1
    ra = ngon_ring((cx, ybase, cz), r0, n=n, axis='y')
    rb = ngon_ring((cx, ytop, cz), r1_, n=n, axis='y')
    dx0, dy0, dx1, dy1 = wrap_rect
    for j in range(n):
        k = (j + 1) % n
        u0 = (dx0 + (dx1 - dx0) * j / n) / M.ATLAS
        u1 = (dx0 + (dx1 - dx0) * (j + 1) / n) / M.ATLAS
        quad = [ra[j], ra[k], rb[k], rb[j]]
        uvs = [(u0, dy1 / M.ATLAS), (u1, dy1 / M.ATLAS),
               (u1, dy0 / M.ATLAS), (u0, dy0 / M.ATLAS)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        rad = ctr - np.array([cx, ctr[1], cz])
        if np.dot(nrm, rad) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)
    if cap_zone is not None:
        zc = Zone(cap_zone.rect, ('x', 'z'),
                  ((cx - r1_, cx + r1_), (cz - r1_, cz + r1_)))
        p.add_face(ngon_ring((cx, ytop, cz), r1_, n=n, axis='y'), zone=zc,
                   flip=True)


def box(p, center, size, zone, ch=0.05, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def railing(p, start, end, zone=None, h=0.95):
    zone = zone or B.B_TRIM
    a, b = np.asarray(start, float), np.asarray(end, float)
    L = np.linalg.norm(b - a)
    n = max(2, int(L / 2.4) + 1)
    for i in range(n):
        t = i / (n - 1)
        pt = a + (b - a) * t
        box(p, (pt[0], pt[1] + h / 2, pt[2]), (0.07, h, 0.07), zone, ch=0.01)
    mid = (a + b) / 2
    d = b - a
    size = (abs(d[0]) + 0.08 if abs(d[0]) > abs(d[2]) else 0.08, 0.08,
            abs(d[2]) + 0.08 if abs(d[2]) >= abs(d[0]) else 0.08)
    box(p, (mid[0], mid[1] + h, mid[2]), size, zone, ch=0.01)


def hull_zone(c, n):
    if n[1] > 0.6:
        return B.B_DECK
    return B.B_HULL_SIDE


def tur_zone(c, n):
    if n[1] < -0.5:
        return B.B_DARK
    if abs(n[0]) > 0.62:
        return B.B_TUR_SIDE
    if abs(n[2]) > 0.55:
        return B.B_TUR_FRONT
    return B.B_TUR_TOP


# ── hull + everything static ─────────────────────────────────────────────

def build_body():
    p = Part('body')
    rings = [ring_from_section(s) for s in B.HULL_SECTIONS]
    bow = Zone(B.B_HULL_SIDE.rect, ('x', 'y'), ((-0.6, 0.6), (6.0, -0.1)))
    loft(p, rings, hull_zone, cap_start=bow, cap_end=B.B_STERN)
    # barbettes
    for (bz, by, br, bt) in B.BARBETTES:
        drum_y(p, 0.0, bz, by, bt + 0.05, br, B.B_BARBETTE, n=10)
    # superstructure stack
    x, y, z, w, h, d = B.LEVEL01
    s01 = Zone(B.B_SUPER.rect, ('z', 'y'), ((-7.5, 15.5), (8.1, 4.9)))
    s01f = Zone(B.B_SUPER.rect, ('x', 'y'), ((5.7, -5.7), (8.1, 4.9)))
    chamfer_box(p, (x, y, z), (w, h, d), 0.07,
                {'+x': s01, '-x': s01, '-z': s01f, '+z': s01f,
                 '+y': B.B_DECK}, skip=('-y',))
    x, y, z, w, h, d = B.LEVEL02
    s02 = Zone(B.B_SUPER.rect, ('z', 'y'), ((-7.5, 15.5), (10.7, 7.9)))
    s02f = Zone(B.B_SUPER.rect, ('x', 'y'), ((5.7, -5.7), (10.7, 7.9)))
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+x': s02, '-x': s02, '-z': s02f, '+z': s02f,
                 '+y': B.B_DECK}, skip=('-y',))
    x, y, z, w, h, d = B.BRIDGE
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+x': B.B_BRIDGE, '-x': B.B_BRIDGE, '-z': B.B_BRIDGE,
                 '+z': B.B_BRIDGE, '+y': B.B_DECK}, skip=('-y',))
    for (wx, wy, wz) in B.WINGS:
        box(p, (wx, wy, wz), B.WING_SIZE, B.B_TRIM, ch=0.02)
        railing(p, (wx - B.WING_SIZE[0] / 2 + 0.1, wy + 0.1, wz - 1.5),
                (wx - B.WING_SIZE[0] / 2 + 0.1, wy + 0.1, wz + 1.5), h=0.8)
        railing(p, (wx + B.WING_SIZE[0] / 2 - 0.1, wy + 0.1, wz - 1.5),
                (wx + B.WING_SIZE[0] / 2 - 0.1, wy + 0.1, wz + 1.5), h=0.8)
        limb(p, (wx * 0.92, wy + 0.1, wz + 1.3),
             (wx * 0.92, wy + 2.3, wz + 1.3), 0.05, 0.04, B.B_TRIM.rect, n=4)
    x, y, z, w, h, d = B.TOWER
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+x': B.B_TOWER, '-x': B.B_TOWER, '-z': B.B_TOWER,
                 '+z': B.B_TOWER, '+y': B.B_DECK}, skip=('-y',))
    x, y, z, w, h, d = B.RANGEFINDER
    box(p, (x, y, z), (w, h, d), B.B_TOWER, ch=0.04)
    # funnel (tapered) + top ring
    fx, fz, fy0, fy1, fr0, fr1 = B.FUNNEL
    drum_y(p, fx, fz, fy0, fy1, fr0, B.B_FUNNEL, cap_zone=B.B_STACKTOP,
           n=10, r1=fr1)
    drum_y(p, fx, fz, fy1 - 0.55, fy1 - 0.3, fr1 * 1.12, B.B_FUNNEL, n=10)
    # lattice mast + platform (radar is its own piece above)
    ax, ay, az = B.MAST_APEX
    for (lx, lz) in B.MAST_LEGS:
        limb(p, (lx, 10.55, lz), (ax, ay, az), 0.10, 0.07, B.B_TRIM.rect, n=4)
    box(p, (ax, ay + 0.1, az), (1.7, 0.2, 1.7), B.B_TRIM, ch=0.02)
    # VLS panel on 01-level roof
    x, y, z, w, h, d = B.VLS_BOX
    box(p, (x, y, z), (w, h, d), B.B_VLS, ch=0.03, skip=('-y',))
    # aft deckhouse (hangar) — helipad painted on the quarterdeck
    x, y, z, w, h, d = B.DECKHOUSE
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+x': B.B_DECKHOUSE, '-x': B.B_DECKHOUSE, '-z': B.B_DECKHOUSE,
                 '+z': B.B_DECKHOUSE, '+y': B.B_DECK}, skip=('-y',))
    # PDC mounts
    for (px, py, pz) in B.PDCS:
        box(p, (px, py + 0.15, pz), (1.0, 0.3, 1.0), B.B_PDC, ch=0.03)
        drum_y(p, px, pz, py + 0.3, py + 1.0, 0.42, B.B_BARBETTE, n=8,
               cap_zone=B.B_PDC)
        for dx in (-0.16, 0.16):
            limb(p, (px + dx, py + 0.75, pz), (px + dx, py + 0.75, pz - 1.3),
                 0.06, 0.05, B.B_TRIM.rect, n=4)
    # boats on davits
    for (bx, by, bz) in B.BOATS:
        tube(p, [(bz - B.BOAT_LEN / 2, B.BOAT_R, by), (bz + B.BOAT_LEN / 2, B.BOAT_R, by)],
             B.B_BOAT, n=8, xoff=bx, cap_start=B.B_BOAT_CAP, cap_end=B.B_BOAT_CAP)
        for dz in (-1.2, 1.2):
            box(p, (bx * 0.965, by + 0.75, bz + dz), (0.1, 1.5, 0.1),
                B.B_TRIM, ch=0.01)
            box(p, (bx, by + 1.42, bz + dz), (0.85, 0.1, 0.1), B.B_TRIM,
                ch=0.01)
    # breakwater wedge ahead of A barbette
    bxw, byw, bzw = B.BREAKWATER
    chamfer_box(p, (bxw, byw, bzw), (6.4, 1.0, 0.4), 0.04,
                {'+z': B.B_BREAK, '-z': B.B_BREAK, '+x': B.B_BREAK,
                 '-x': B.B_BREAK, '+y': B.B_BREAK}, skip=('-y',))
    # deck furniture: capstans, bollard pairs, vents
    for (cz_, cr) in ((-33.5, 0.5), (-31.5, 0.5)):
        drum_y(p, 0.0, cz_, B.DECK_Y + 0.55, B.DECK_Y + 0.9, cr, B.B_BARBETTE,
               n=8, cap_zone=B.B_PDC)
    for (bz_,) in ((-20.0,), (-8.0,), (8.0,), (16.0,), (26.0,), (33.0,)):
        for sx in (1, -1):
            wdk = np.interp(bz_, [s[0] for s in B.HULL_SECTIONS],
                            [s[8] for s in B.HULL_SECTIONS])
            box(p, (sx * (wdk - 0.5), B.DECK_Y + 0.25, bz_),
                (0.22, 0.5, 0.22), B.B_TRIM, ch=0.02)
    for (vz, vs) in ((17.5, 1.1), (24.5, 0.9)):
        box(p, (2.8, B.DECK_Y + vs / 2, vz), (1.2, vs, 1.2), B.B_PDC, ch=0.04)
    # deck-edge railings (bow, midship sides, quarterdeck)
    for sx in (1, -1):
        railing(p, (sx * 2.9, B.DECK_Y + 0.62, -38.5),
                (sx * 4.7, B.DECK_Y + 0.18, -28.0))
        railing(p, (sx * 5.4, B.DECK_Y + 0.05, -21.0),
                (sx * 5.75, B.DECK_Y + 0.0, -9.0))
        railing(p, (sx * 5.5, B.DECK_Y + 0.02, 15.5),
                (sx * 5.0, B.DECK_Y + 0.05, 26.0))
        railing(p, (sx * 4.6, B.DECK_Y + 0.08, 28.0),
                (sx * 3.6, B.DECK_Y + 0.12, 38.5))
    return p


# ── turrets ──────────────────────────────────────────────────────────────

def build_turret(name):
    p = Part(name)
    rings = [ring_from_section(s) for s in B.TUR_SECTIONS]
    loft(p, rings, tur_zone, cap_start=B.B_TUR_FRONT, cap_end=B.B_TUR_FRONT)
    # rangefinder ears + roof hatch box
    box(p, (0.0, 2.5, 2.6), (3.2, 0.45, 0.7), B.B_TUR_TOP, ch=0.04)
    box(p, (1.3, 2.45, 0.2), (0.8, 0.3, 0.8), B.B_TUR_TOP, ch=0.03)
    return p


def build_barrel(name, aft=False):
    p = Part(name)
    s = -1.0 if aft else 1.0

    def fz(z):
        return s * z   # fore keeps -Z tubes; aft bakes them facing +Z

    # mantlet block
    box(p, (0.0, -0.05, fz(-0.6)), (6.1, 2.0, 1.7), B.B_TUR_FRONT, ch=0.08)
    for xo in (-B.TUBE_X, 0.0, B.TUBE_X):
        tube(p, [(fz(z), r, -0.05) for (z, r) in B.TUBE_STATIONS],
             B.B_BARREL, n=8, xoff=xo,
             cap_end=None if aft else B.B_TUBE_CAP,
             cap_start=B.B_TUBE_CAP if aft else None)
        (cz0, cz1), cr = B.CAP_RING
        tube(p, [(fz(cz0), cr, -0.05), (fz(cz1), cr, -0.05)], B.B_CAP_RING,
             n=8, xoff=xo,
             cap_start=B.B_TUBE_CAP, cap_end=B.B_TUBE_CAP)
        (tz0, tz1), tr = B.TIP_STUB
        tube(p, [(fz(tz0), tr, -0.05), (fz(tz1), tr, -0.05)], B.B_CAP_RING,
             n=8, xoff=xo,
             cap_end=None if aft else B.B_TUBE_CAP,
             cap_start=B.B_TUBE_CAP if aft else None)
    return p


def build_radar():
    p = Part('radar')
    drum_y(p, 0, 0, -0.05, 0.25, 0.28, B.B_BARBETTE, n=8)
    box(p, (0, 0.45, 0), (3.0, 0.4, 0.45), B.B_RADAR, ch=0.03)
    box(p, (0, 0.45, -0.28), (2.2, 0.28, 0.12), B.B_RADAR, ch=0.02)
    return p


# ── clips ────────────────────────────────────────────────────────────────

def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    T = 10.0
    idle = {
        'name': 'idle',
        'channels': [
            ('radar', 'rotation', [(T * i / 4, qy(90.0 * i)) for i in range(5)]),
        ],
    }
    return [idle]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    body = build_body()
    tA = build_turret('turret')
    tC = build_turret('turret2')
    tB = build_turret('turret3')
    bA = build_barrel('barrel')
    bC = build_barrel('barrel2', aft=True)
    bB = build_barrel('barrel3')
    radar = build_radar()

    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=body),            # 0
        dict(name='turret', parent=0, offset=B.TURRET_A, part=tA),            # 1
        dict(name='barrel', parent=1, offset=B.BARREL_OFF, part=bA),          # 2
        dict(name='muzzle', parent=2, offset=B.MUZZLE_OFF, part=None),        # 3
        dict(name='muzzle_l', parent=2,
             offset=(B.TUBE_X, 0.0, B.MUZZLE_OFF[2]), part=None),             # 4
        dict(name='muzzle_r', parent=2,
             offset=(-B.TUBE_X, 0.0, B.MUZZLE_OFF[2]), part=None),            # 5
        dict(name='turret2', parent=0, offset=B.TURRET_C, part=tC),           # 6
        dict(name='barrel2', parent=6,
             offset=(0.0, B.BARREL_OFF[1], -B.BARREL_OFF[2]), part=bC),       # 7
        dict(name='muzzle2', parent=7,
             offset=(0.0, 0.0, -B.MUZZLE_OFF[2]), part=None),                 # 8
        dict(name='turret3', parent=0, offset=B.TURRET_B, part=tB),           # 9
        dict(name='barrel3', parent=9, offset=B.BARREL_OFF, part=bB),         # 10
        dict(name='muzzle3', parent=10, offset=B.MUZZLE_OFF, part=None),      # 11
        dict(name='radar', parent=0, offset=B.RADAR_OFF, part=radar),         # 12
        dict(name='exhaust', parent=0, offset=B.EXHAUST_OFF, part=None),      # 13
    ]
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_battleship] total tris: {total}')
