"""gen_ms_anc_gate — assemble ms_anc_gate and export .gltf/.bin.

Ancient ring gate, 30 m: stepped monolithic plinth, two colossal uprights
sharing one unbroken inner plane, cantilevered yoke brackets carrying open
cradle arcs, a seamless segmented ring floating inside them (piece `ring`,
VERY slow idle rotation about its own +Z axis — 180 s/rev), an unsupported
floating keystone above the apex, and four half-buried conduit stubs.
No team colour.
Run: python3 gen_ms_anc_gate.py -> out/ms_anc_gate{,_png}.gltf
"""
import numpy as np

import ms_anc_gate_layout as F   # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, chamfer_box, limb
from gltf_export import export

STEM = 'ms_anc_gate'
OUT = 'out'


# ── reusable primitive: chamfered-rect torus / open arc in the XY plane ──
def ring_arc(part, center, angles, ro_of, ri, depth_of, ch, rects,
             closed=False):
    """Loft a closed 8-point chamfered-rectangle profile around a circle
    lying in the XY plane (axis = +Z).  `angles` are radians; ro_of(k) and
    depth_of(k) give the per-station outer radius / axial depth so raised
    node bosses come for free.  `rects` maps 'out'/'in'/'side' -> atlas rect;
    UVs are parametric (u = angle param, v = across the profile) using
    F.PROFILE_EDGES.  closed=True wraps the last station back to the first.
    Genuinely reusable — candidate for prefabs/parts.py.
    """
    cx, cy, cz = center
    ns = len(angles)

    def profile(k):
        ro, hd = ro_of(k), depth_of(k) / 2.0
        return [(ro - ch, -hd), (ro, -hd + ch), (ro, hd - ch), (ro - ch, hd),
                (ri + ch, hd), (ri, hd - ch), (ri, -hd + ch), (ri + ch, -hd)]

    pts, mids = [], []
    for k, a in enumerate(angles):
        ca, sa = np.cos(a), np.sin(a)
        pts.append([(cx + ca * r, cy + sa * r, cz + z) for (r, z) in profile(k)])
        rm = (ro_of(k) + ri) / 2.0
        mids.append(np.array([cx + ca * rm, cy + sa * rm, cz]))

    span = ns if closed else ns - 1
    for k in range(span):
        j = (k + 1) % ns
        core = (mids[k] + mids[j]) / 2.0
        for (ea, eb, key, v0, v1) in F.PROFILE_EDGES:
            x0, y0, x1, y1 = rects[key]
            ua = (x0 + (x1 - x0) * k / span) / M.ATLAS
            ub = (x0 + (x1 - x0) * (k + 1) / span) / M.ATLAS
            va = (y0 + (y1 - y0) * v0) / M.ATLAS
            vb = (y0 + (y1 - y0) * v1) / M.ATLAS
            quad = [pts[k][ea], pts[k][eb], pts[j][eb], pts[j][ea]]
            uvs = [(ua, va), (ua, vb), (ub, vb), (ub, va)]
            c = np.mean(np.array(quad), axis=0)
            nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                           np.asarray(quad[3]) - np.asarray(quad[0]))
            if np.dot(nrm, c - core) < 0:
                quad, uvs = quad[::-1], uvs[::-1]
            part.add_face(quad, uvs=uvs)


def build_body():
    p = Part('body')

    # ── stepped plinth: three monolithic slabs, recessed seams (texture) ──
    for (cx, cy, cz, w, h, d) in (F.T1, F.T2, F.DAIS):
        chamfer_box(p, (cx, cy, cz), (w, h, d), 0.18,
                    {'+y': F.R_PL_TOP, '+x': F.R_PL_SZ, '-x': F.R_PL_SZ,
                     '+z': F.R_PL_SX, '-z': F.R_PL_SX}, skip=('-y',))

    # ── two colossal uprights; inner faces share the plane x = ±9.8 ──
    for sx in (1, -1):
        zz = F.R_UP_ZR if sx > 0 else F.R_UP_ZL
        tz = F.R_UP_TR if sx > 0 else F.R_UP_TL
        for (xi, xo, y0, y1, dz) in F.UPRIGHTS:
            cx = sx * (xi + xo) / 2.0
            chamfer_box(p, (cx, (y0 + y1) / 2.0, 0.0),
                        (xo - xi, y1 - y0, dz), F.UP_CH,
                        {'+x': F.R_UP_X, '-x': F.R_UP_X,
                         '+z': zz, '-z': zz, '+y': tz}, skip=('-y',))

        # ── cantilevered yoke bracket: upright inner plane -> cradle ──
        ycx, yy0, yy1, yw, ydz = F.YOKE
        chamfer_box(p, (sx * ycx, (yy0 + yy1) / 2.0, 0.0),
                    (yw, yy1 - yy0, ydz), 0.12,
                    {'+x': F.R_YK_X, '-x': F.R_YK_X,
                     '+z': (F.R_YK_ZR if sx > 0 else F.R_YK_ZL),
                     '-z': (F.R_YK_ZR if sx > 0 else F.R_YK_ZL),
                     '+y': (F.R_YK_YR if sx > 0 else F.R_YK_YL),
                     '-y': (F.R_YK_YR if sx > 0 else F.R_YK_YL)})

        # ── open cradle arc: perfect circle, ends free (nothing bolted) ──
        a_mid = 0.0 if sx > 0 else np.pi
        half = np.radians(F.CRA_HALF)
        ang = [a_mid - half + 2 * half * k / F.CRA_N for k in range(F.CRA_N + 1)]
        ring_arc(p, (0.0, F.RING_CY, 0.0), ang,
                 lambda k: F.CRA_RO, F.CRA_RI, lambda k: F.CRA_D, F.CRA_CH,
                 {'out': F.R_CRA_OUT, 'in': F.R_CRA_IN, 'side': F.R_CRA_SIDE})

    # ── floating keystone: unsupported, 0.55 m clear above the ring apex ──
    kx, ky, kz, kw, kh, kd = F.KEY
    chamfer_box(p, (kx, ky, kz), (kw, kh, kd), 0.22,
                {'+y': F.R_KEY_Y, '-y': F.R_KEY_Y,
                 '+x': F.R_KEY_X, '-x': F.R_KEY_X,
                 '+z': F.R_KEY_Z, '-z': F.R_KEY_Z})

    # ── four half-buried conduit stubs + soil-buried collar plates ──
    for sx in (1, -1):
        for sz in (1, -1):
            a = (sx * F.CON_A[0], F.CON_A[1], sz * F.CON_A[2])
            b = (sx * F.CON_B[0], F.CON_B[1], sz * F.CON_B[2])
            cap = F.at(F.R_CON_CAP, ('x', 'y'), ((-1.1, 1.1), (1.1, -1.1)), b)
            limb(p, a, b, F.CON_R0, F.CON_R1, F.R_CON, n=8, cap_end=cap)
            c = (sx * F.COL_C[0], F.COL_C[1], sz * F.COL_C[2])
            top = F.at(F.R_COL_TOP, ('x', 'z'), ((-1.4, 1.4), (-1.4, 1.4)), c)
            sdx = F.at(F.R_COL_SD, ('x', 'y'), ((-1.4, 1.4), (0.3, -0.3)), c)
            sdz = F.at(F.R_COL_SD, ('z', 'y'), ((-1.4, 1.4), (0.3, -0.3)), c)
            chamfer_box(p, c, F.COL_S, 0.10,
                        {'+y': top, '+x': sdz, '-x': sdz,
                         '+z': sdx, '-z': sdx}, skip=('-y',))
    return p


def build_ring():
    """Seamless segmented ring, piece-local (pivot on the portal axis)."""
    p = Part('ring')
    n = F.RING_N
    ang = [2 * np.pi * i / n for i in range(n)]

    def boss(k):
        return (k % F.BOSS_MOD) in (0, 1)

    ring_arc(p, (0.0, 0.0, 0.0), ang,
             lambda k: F.RING_RO + (F.BOSS_DR if boss(k) else 0.0),
             F.RING_RI,
             lambda k: F.RING_D + (F.BOSS_DD if boss(k) else 0.0),
             F.RING_CH,
             {'out': F.R_RING_OUT, 'in': F.R_RING_IN, 'side': F.R_RING_SIDE},
             closed=True)
    return p


def qz(deg):
    r = np.radians(deg) / 2
    return (0.0, 0.0, float(np.sin(r)), float(np.cos(r)))


def build_clips():
    # VERY slow idle: 180 s per revolution about the portal axis, seamless
    T = 180.0
    keys = [(T * i / 4, qz(90.0 * i)) for i in range(5)]
    return [{'name': 'idle', 'channels': [('ring', 'rotation', keys)]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='ring', parent=0, offset=F.RING_PIVOT, part=build_ring()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=build_clips(),
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=build_clips(),
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
