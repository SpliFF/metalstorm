"""gen_ms_landing_ship — build ms_landing_ship (LSV Peltast) + clips.

Armoured landing ship, ships-row s2 (35 m): one U-section loft skins
hull, bulwarks and the open vehicle well deck (floor rises into the
raised quarterdeck aft), animated bow `ramp` (clip `unload` lowers it
about X for beaching), hazard rails on the bulwark caps, floor guide
rails + cradle cross-beams with `link1..link4` attach empties per the
fable_airship transport contract, aft bridge with mast, rotating nav
`radar` (idle clip), twin exhaust stacks and life-raft canisters.

Usage: python3 gen_ms_landing_ship.py [png]
"""
from __future__ import annotations
import numpy as np

import ms_landing_ship_layout as S  # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, loft, chamfer_box, tube, ngon_ring, limb
from gltf_export import export

STEM = 'ms_landing_ship'
OUT = 'out'


# ── helpers ──────────────────────────────────────────────────────────────

def ring_from_section(sec):
    z, yb, yk, yt, yf, wb, wk, wt, wi = sec
    return [
        (wb, yb, z), (wk, yk, z), (wt, yt, z),      # +x side up
        (wi, yt, z), (wi, yf, z),                    # +x bulwark cap -> floor
        (-wi, yf, z), (-wi, yt, z),                  # floor -> -x bulwark cap
        (-wt, yt, z), (-wk, yk, z), (-wb, yb, z),    # -x side down
    ]


def hull_zone(c, n):
    if n[1] < -0.55:
        return S.S_BELLY
    if n[1] > 0.45:
        if c[1] > 4.15:
            return S.S_RIM
        if c[1] > 3.0 and abs(n[2]) < 0.4:
            return S.S_AFT_DECK
        return S.S_WELL_FLOOR
    # inboard faces: normal points back across the centreline
    if abs(n[0]) > 0.3 and n[0] * c[0] < 0:
        return S.S_WELL_WALL
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


def interp_col(z, col):
    zs = [s[0] for s in S.HULL_SECTIONS]
    return float(np.interp(z, zs, [s[col] for s in S.HULL_SECTIONS]))


# ── body ─────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    rings = [ring_from_section(s) for s in S.HULL_SECTIONS]
    loft(p, rings, hull_zone)          # open ends; bow/stern faces below

    # bow face (z = -16.6 plane): open mouth above the ramp sill
    zb = S.HULL_SECTIONS[0][0]
    _, yb, yk, yt, yf, wb, wk, wt, wi = S.HULL_SECTIONS[0]
    B = (0, 0, -1)

    def V(x, y):
        return (x, y, zb)

    quad_out(p, [V(-wb, yb), V(wb, yb), V(wi, yf), V(-wi, yf)], B, S.S_BOW)
    for sx in (1, -1):
        quad_out(p, [V(sx * wk, yk), V(sx * wt, yt), V(sx * wi, yt),
                     V(sx * wi, yf)], B, S.S_BOW)
        quad_out(p, [V(sx * wb, yb), V(sx * wk, yk), V(sx * wi, yf)], B,
                 S.S_BOW)
        # ramp guide horn on the bow bulwark cap
        limb(p, (sx * (wi + 0.28), yt, zb + 0.35),
             (sx * (wi + 0.28), yt + 0.75, zb + 0.15), 0.09, 0.05,
             S.S_MAST, n=4)

    # stern transom (z = 17.3 plane): closed up to the quarterdeck lip
    zs_ = S.HULL_SECTIONS[-1][0]
    _, yb, yk, yt, yf, wb, wk, wt, wi = S.HULL_SECTIONS[-1]
    T = (0, 0, 1)

    def W(x, y):
        return (x, y, zs_)

    quad_out(p, [W(-wb, yb), W(wb, yb), W(wk, yk), W(-wk, yk)], T, S.S_STERN)
    quad_out(p, [W(-wk, yk), W(wk, yk), W(wi, yf), W(-wi, yf)], T, S.S_STERN)
    for sx in (1, -1):
        quad_out(p, [W(sx * wk, yk), W(sx * wt, yt), W(sx * wi, yt),
                     W(sx * wi, yf)], T, S.S_STERN)

    # well deck cradle: guide rails + cross-beams under each slot
    z0, z1 = S.RAIL_RUN
    for sx in (1, -1):
        box(p, (sx * S.RAIL_X, S.FLOOR_Y + 0.11, (z0 + z1) / 2),
            (0.28, 0.22, z1 - z0), S.S_CRADLE, ch=0.02)
    for (_, _, lz) in S.LINKS:
        box(p, (0.0, S.FLOOR_Y + 0.10, lz + 2.55), (S.BEAM_W, 0.20, 0.45),
            S.S_CRADLE, ch=0.02)

    # hazard rails along both bulwark caps (posts + piecewise top rail)
    zs = np.linspace(S.POST_Z0, S.POST_Z1, S.POST_N)
    for sx in (1, -1):
        pts = []
        for pz in zs:
            wt_ = interp_col(pz, 7)
            wi_ = interp_col(pz, 8)
            yt_ = interp_col(pz, 3)
            px = sx * (wt_ + wi_) / 2
            pts.append((px, yt_, pz))
            limb(p, (px, yt_, pz), (px, yt_ + S.POST_H, pz), 0.05, 0.04,
                 S.S_RAIL, n=4)
        for i in range(len(pts) - 1):
            a, b = pts[i], pts[i + 1]
            limb(p, (a[0], a[1] + S.POST_H, a[2]),
                 (b[0], b[1] + S.POST_H, b[2]), 0.055, 0.055, S.S_RAIL, n=4)

    # mooring bollards on the caps
    for (bz,) in S.BOLLARDS:
        wt_ = interp_col(bz, 7)
        wi_ = interp_col(bz, 8)
        yt_ = interp_col(bz, 3)
        for sx in (1, -1):
            limb(p, (sx * (wt_ + wi_) / 2, yt_, bz),
                 (sx * (wt_ + wi_) / 2, yt_ + 0.45, bz), 0.10, 0.10,
                 S.S_MAST, n=4)

    # well floodlights on the inboard walls
    for (lz, sx) in ((-8.0, 1), (-8.0, -1), (4.0, 1), (4.0, -1)):
        wi_ = interp_col(lz, 8)
        yt_ = interp_col(lz, 3)
        box(p, (sx * (wi_ - 0.16), yt_ - 0.45, lz), (0.32, 0.3, 0.4),
            S.S_LIGHT, ch=0.02)

    # aft bridge + gear
    x, y, z, w, h, d = S.BRIDGE
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+x': S.S_BRIDGE_S, '-x': S.S_BRIDGE_S, '-z': S.S_BRIDGE_F,
                 '+z': S.S_BRIDGE_F, '+y': S.S_BRTOP}, skip=('-y',))
    limb(p, S.MAST_FOOT, S.MAST_TOP, 0.07, 0.05, S.S_MAST, n=4)
    limb(p, (-S.YARD_HW, 8.10, 13.2), (S.YARD_HW, 8.10, 13.2), 0.04, 0.04,
         S.S_MAST, n=4)
    for (sx, sz) in S.STACKS:
        limb(p, (sx, S.AFT_DECK_Y, sz), (sx, S.STACK_TOP, sz), 0.36, 0.30,
             S.S_STACK, n=6, cap_end=S.S_DARK)
    for (rx, rz) in S.RAFTS:
        tube(p, [(rz - S.RAFT_LEN / 2, S.RAFT_R, 6.55),
                 (rz + S.RAFT_LEN / 2, S.RAFT_R, 6.55)], S.S_RAFT, n=6,
             xoff=rx, cap_start=S.S_DARK, cap_end=S.S_DARK)
    # quarterdeck vents
    for sx in (1.6, -1.6):
        box(p, (sx, S.AFT_DECK_Y + 0.3, 12.2), (0.9, 0.6, 0.7), S.S_TRIM,
            ch=0.04, skip=('-y',))
    return p


# ── ramp ─────────────────────────────────────────────────────────────────

def build_ramp():
    """Piece-local: hinge axis = local X at the origin; plate rises +Y when
    raised (rest pose). `unload` rotates about X by RAMP_DROP."""
    p = Part('ramp')
    w, h, t = S.RAMP_W, S.RAMP_H, S.RAMP_T
    zc = -0.16
    chamfer_box(p, (0.0, h / 2, zc), (w, h, t), 0.05,
                {'-z': S.S_RAMP_OUT, '+z': S.S_RAMP_IN, '+x': S.S_TRIM,
                 '-x': S.S_TRIM, '+y': S.S_TRIM, '-y': S.S_TRIM})
    # armour ribs on the seaward face
    for ry in (1.05, 2.15):
        box(p, (0.0, ry, zc - t / 2 - 0.07), (w - 0.5, 0.26, 0.14),
            S.S_RAMP_OUT, ch=0.02, skip=('+z',))
    # hinge lugs astride the axis
    for sx in (1, -1):
        box(p, (sx * (w / 2 - 0.25), 0.10, zc + 0.05), (0.30, 0.5, 0.55),
            S.S_TRIM, ch=0.03)
    return p


# ── radar ────────────────────────────────────────────────────────────────

def build_radar():
    p = Part('radar')
    limb(p, (0, -0.34, 0), (0, -0.06, 0), 0.10, 0.08, S.S_MAST, n=4)
    box(p, (0, 0.12, 0), (1.7, 0.30, 0.34), S.S_RADAR, ch=0.03)
    box(p, (0, 0.12, -0.21), (1.1, 0.20, 0.10), S.S_RADAR, ch=0.02)
    return p


# ── clips ────────────────────────────────────────────────────────────────

def qx(deg):
    r = np.radians(deg) / 2
    return (float(np.sin(r)), 0.0, 0.0, float(np.cos(r)))


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
    d = S.RAMP_DROP
    unload = {
        'name': 'unload',
        'channels': [
            ('ramp', 'rotation', [
                (0.0, qx(0.0)), (0.6, qx(0.0)), (2.2, qx(d * 0.55)),
                (4.2, qx(d * 0.95)), (4.8, qx(d)), (8.0, qx(d)),
            ]),
        ],
    }
    return [idle, unload]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),  # 0
        dict(name='ramp', parent=0, offset=S.RAMP_HINGE, part=build_ramp()),
        dict(name='radar', parent=0, offset=S.RADAR_OFF, part=build_radar()),
    ]
    for i, off in enumerate(S.LINKS):
        pieces.append(dict(name=f'link{i + 1}', parent=0, offset=off,
                           part=None))
    pieces.append(dict(name='exhaust', parent=0, offset=S.EXHAUST_OFF,
                       part=None))
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_landing_ship] total tris: {total}')
