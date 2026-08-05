"""gen_ms_market_stalls — assemble ms_market_stalls and export gltf.

Civilian market cluster (8x8 m): five timber-post stalls at differing
heights, canvas back walls, crate counters, loose crates, hanging goods
bundles, warm string lights on sagging wires, and one `awning` piece
carrying all five canopies with a subtle seamless `idle` flap.
Run via build.sh.  Seed 90210.
"""
import numpy as np

import ms_market_stalls_layout as F      # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, Zone
from gltf_export import export

STEM = 'ms_market_stalls'
OUT = 'out'


def _uv(px, py):
    return (px / M.ATLAS, py / M.ATLAS)


# face key -> (corner signs CCW-outward, uv corner picker) — supply-dump idiom
_FACES = {
    '+y': ([(-1, 1, -1), (-1, 1, 1), (1, 1, 1), (1, 1, -1)],
           [(0, 0), (0, 1), (1, 1), (1, 0)]),
    '-y': ([(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)],
           [(0, 0), (1, 0), (1, 1), (0, 1)]),
    '+x': ([(1, -1, -1), (1, 1, -1), (1, 1, 1), (1, -1, 1)],
           [(0, 1), (0, 0), (1, 0), (1, 1)]),
    '-x': ([(-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1)],
           [(0, 1), (1, 1), (1, 0), (0, 0)]),
    '-z': ([(-1, -1, -1), (-1, 1, -1), (1, 1, -1), (1, -1, -1)],
           [(0, 1), (0, 0), (1, 0), (1, 1)]),
    '+z': ([(-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)],
           [(0, 1), (1, 1), (1, 0), (0, 0)]),
}


def cell_box(p, center, size, side_cell, top_cell, yaw=0.0, skip=('-y',)):
    """Plain box, each face mapped onto the full cell rect; yaw about +Y."""
    cx, cy, cz = center
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    a = np.radians(yaw)
    ca, sa = np.cos(a), np.sin(a)

    def T(sx, sy, sz):
        lx, ly, lz = sx * hx, sy * hy, sz * hz
        return (cx + lx * ca + lz * sa, cy + ly, cz - lx * sa + lz * ca)

    for key, (signs, uvp) in _FACES.items():
        if key in skip:
            continue
        cell = top_cell if key in ('+y', '-y') else side_cell
        x0, y0, x1, y1 = cell
        us, vs = (x0, x1), (y0, y1)
        verts = [T(*s) for s in signs]
        uvs = [_uv(us[i], vs[j]) for (i, j) in uvp]
        p.add_face(verts, uvs=uvs)


def dquad(p, verts, cell_a, cell_b=None):
    """Double-sided quad; each side mapped onto a full cell."""
    for cell, vv in ((cell_a, verts), (cell_b or cell_a, verts[::-1])):
        x0, y0, x1, y1 = cell
        uvs = [_uv(x0, y0), _uv(x1, y0), _uv(x1, y1), _uv(x0, y1)]
        p.add_face(vv, uvs=uvs)


def stall_frame(cx, cz, w, d, hf, hb, yaw):
    """World-space corner posts + beams + counter + back canvas for a stall.
    Local frame: back at -z (tall), front at +z (short). Returns a fn that
    maps local (x,y,z) -> world."""
    a = np.radians(yaw)
    ca, sa = np.cos(a), np.sin(a)

    def T(lx, ly, lz):
        return (cx + lx * ca + lz * sa, ly, cz - lx * sa + lz * ca)
    return T


def build_body():
    p = Part('body')
    rng = np.random.default_rng(90210)

    # plaza pad
    w, h, d = F.PAD
    cell_box(p, (0, h / 2, 0), (w, h, d), F.PAD_S, F.PAD_T)

    for (cx, cz, w, d, hf, hb, yaw, _cell) in F.STALLS:
        T = stall_frame(cx, cz, w, d, hf, hb, yaw)
        hw, hd = w / 2, d / 2
        # four posts (back pair taller)
        for (lx, lz, hh) in ((-hw, -hd, hb), (hw, -hd, hb),
                             (-hw, hd, hf), (hw, hd, hf)):
            wx, wy, wz = T(lx, 0, lz)
            cell_box(p, (wx, hh / 2, wz), (F.POST, hh, F.POST),
                     F.POST_S, F.POST_T, yaw=yaw)
        # front + back head beams
        for (lz, hh) in ((hd, hf), (-hd, hb)):
            bx, _, bz = T(0, 0, lz)
            cell_box(p, (bx, hh - F.BEAM / 2, bz), (w, F.BEAM, F.BEAM),
                     F.BEAM_S, F.BEAM_S, yaw=yaw)
        # counter (crate-table) across the front half
        cd = d * F.COUNTER_D_F
        ccx, _, ccz = T(0, 0, hd - cd / 2 - 0.15)
        cell_box(p, (ccx, F.PAD_TOP_Y + F.COUNTER_H / 2, ccz),
                 (w - 0.25, F.COUNTER_H, cd), F.COUNT_S, F.COUNT_T, yaw=yaw)
        # canvas back wall (double-sided quad between the back posts)
        v = [T(-hw + 0.05, 0.25, -hd + 0.02), T(hw - 0.05, 0.25, -hd + 0.02),
             T(hw - 0.05, hb - 0.15, -hd + 0.02),
             T(-hw + 0.05, hb - 0.15, -hd + 0.02)]
        dquad(p, v, F.BACK_C)

    # loose crates
    for (cx, cy, cz, cw, chh, cd, yaw) in F.CRATES:
        cell_box(p, (cx, F.PAD_TOP_Y + cy + chh / 2, cz), (cw, chh, cd),
                 F.CRATE_S, F.CRATE_T, yaw=yaw)

    # hanging goods (small bundles hung under the beams; keep all 6 faces)
    for (cx, yt, cz, gw, gh, gd, yaw, cell) in F.GOODS_HANG:
        s = F.GOODS if cell == 1 else F.GOODS2
        cell_box(p, (cx, yt - gh / 2, cz), (gw, gh, gd), s, s,
                 yaw=yaw, skip=())
        # cord
        dquad(p, [(cx - 0.012, yt, cz), (cx + 0.012, yt, cz),
                  (cx + 0.012, yt + 0.22, cz), (cx - 0.012, yt + 0.22, cz)],
              F.WIRE)

    # string lights: sagging wire ribbons + warm bulb quads
    for (a, b, sag, nb) in F.LIGHT_RUNS:
        a, b = np.array(a, float), np.array(b, float)
        nseg = 6
        pts = []
        for i in range(nseg + 1):
            t = i / nseg
            pt = a + (b - a) * t
            pt[1] -= sag * np.sin(np.pi * t)
            pts.append(pt)
        # wire as a thin vertical ribbon (double-sided)
        for p0, p1 in zip(pts, pts[1:]):
            v = [tuple(p0), tuple(p1),
                 (p1[0], p1[1] + 0.02, p1[2]), (p0[0], p0[1] + 0.02, p0[2])]
            dquad(p, v, F.WIRE)
        # bulbs: small camera-agnostic X-crossed quads
        r = F.BULB_R
        for i in range(nb):
            t = (i + 0.5) / nb
            c = a + (b - a) * t
            c[1] -= sag * np.sin(np.pi * t) + r * 1.6
            dquad(p, [(c[0] - r, c[1] - r, c[2]), (c[0] + r, c[1] - r, c[2]),
                      (c[0] + r, c[1] + r, c[2]), (c[0] - r, c[1] + r, c[2])],
                  F.LIGHT)
    return p


def build_awning():
    """All five canopies in one animated piece (local to F.AWN_OFF)."""
    p = Part('awning')
    ox, oy, oz = F.AWN_OFF
    cells = {'A': F.AWN_A, 'B': F.AWN_B, 'C': F.AWN_C, 'D': F.AWN_D}

    for (cx, cz, w, d, hf, hb, yaw, key) in F.STALLS:
        cell = cells[key]
        a = np.radians(yaw)
        ca, sa = np.cos(a), np.sin(a)

        def T(lx, ly, lz):
            return (cx + lx * ca + lz * sa - ox, ly - oy,
                    cz - lx * sa + lz * ca - oz)

        hw = w / 2 + 0.08
        zb, zf = -d / 2 - 0.10, d / 2 + F.AWN_OVERHANG
        yb, yf = hb + 0.02, hf + 0.02
        zm, ym = (zb + zf) / 2, (yb + yf) / 2 - F.AWN_SAG
        # canopy: 2 sloped quads (back->mid->front) with mid sag, doubled
        x0, y0, x1, y1 = cell
        xm_px = (x0 + x1) / 2
        for (za, ya, zc, yc, ua, uc) in ((zb, yb, zm, ym, y0, (y0 + y1) / 2),
                                         (zm, ym, zf, yf, (y0 + y1) / 2, y1)):
            v = [T(-hw, ya, za), T(hw, ya, za), T(hw, yc, zc), T(-hw, yc, zc)]
            uvs = [_uv(x0, ua), _uv(x1, ua), _uv(x1, uc), _uv(x0, uc)]
            p.add_face(v[::-1], uvs=uvs[::-1])          # top (up-facing)
            ux0, uy0, ux1, uy1 = F.AWN_U
            uuvs = [_uv(ux0, uy0), _uv(ux1, uy0), _uv(ux1, uy1), _uv(ux0, uy1)]
            p.add_face(v, uvs=uuvs)                     # underside
        # front valance hem (double-sided strip, same canvas cell bottom band)
        v = [T(-hw, yf, zf), T(hw, yf, zf),
             T(hw, yf - F.VALANCE, zf), T(-hw, yf - F.VALANCE, zf)]
        uvs = [_uv(x0, y1 - 24), _uv(x1, y1 - 24), _uv(x1, y1), _uv(x0, y1)]
        p.add_face(v, uvs=uvs)
        p.add_face(v[::-1], uvs=uvs)
    return p


# ── idle flap clip ───────────────────────────────────────────────────────

def _q(ax, deg):
    r = np.radians(deg) / 2
    s, c = float(np.sin(r)), float(np.cos(r))
    return {'x': (s, 0.0, 0.0, c), 'z': (0.0, 0.0, s, c)}[ax]


def _qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz)


def build_clips():
    A, T = F.FLAP_DEG, F.FLAP_T
    n = 8
    keys = []
    for i in range(n + 1):                       # last key repeats the first
        ph = 2 * np.pi * i / n
        q = _qmul(_q('x', A * np.sin(ph)), _q('z', A * 0.6 * np.cos(ph)))
        keys.append((T * i / n, q))
    return [{'name': 'idle', 'channels': [('awning', 'rotation', keys)]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='awning', parent=0, offset=F.AWN_OFF, part=build_awning()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=build_clips(),
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=build_clips(),
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
