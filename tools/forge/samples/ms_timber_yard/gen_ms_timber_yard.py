"""gen_ms_timber_yard — assemble ms_timber_yard and export .gltf/.bin.

Timber yard resource site (12x12 m): dirt pad, pyramid log stacks +
loose bark logs, an open-sided saw shed (posts + mono-pitch corrugated
roof) housing a saw bench with a half-cut log and a circular `blade`
piece (idle spin clip about local +Z), a log crane (concrete footing,
mast, jib, cable, hook block), banded cut-lumber stacks and sawdust
cone piles.  Map prop, no team colour.
Run: python3 gen_ms_timber_yard.py → out/ms_timber_yard{,_png}.gltf + .bin
"""
import numpy as np

import ms_timber_yard_layout as F      # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, Zone, chamfer_box, ngon_ring, limb
from gltf_export import export

STEM = 'ms_timber_yard'
OUT = 'out'
RNG = np.random.default_rng(90210)


def _uv(px, py):
    return (px / M.ATLAS, py / M.ATLAS)


# face key -> (corner signs CCW-outward, uv corner picker) — sample pattern
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
    """Plain box, every face mapped onto the FULL cell; yaw about +Y."""
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


def log(p, cx, cz, y, yaw, hl, r=None):
    """Horizontal bark log along local X, yawed about +Y."""
    r = r or F.LOG_R
    a = np.radians(yaw)
    ca, sa = np.cos(a), np.sin(a)
    p0 = (cx - hl * ca, y, cz + hl * sa)
    p1 = (cx + hl * ca, y, cz - hl * sa)
    e0 = Zone(F.LOG_E, ('z', 'y'), ((cz - r, cz + r), (y + r, y - r)))
    e1 = Zone(F.LOG_E, ('z', 'y'), ((cz + r, cz - r), (y + r, y - r)))
    limb(p, p0, p1, r, r, F.LOG_W, n=F.LOG_N,
         cap_start=e0, cap_end=e1)


def cone(p, cx, cz, base_y, r, h, zone_cell, n=8):
    """Sawdust cone: n-gon fan to an apex, open bottom."""
    ring = ngon_ring((cx, base_y, cz), r, n=n, axis='y')
    apex = (cx, base_y + h, cz)
    zone = Zone(zone_cell, ('x', 'z'), ((cx - r, cx + r), (cz - r, cz + r)))
    for j in range(n):
        k = (j + 1) % n
        tri = [ring[j], ring[k], apex]
        nrm = np.cross(np.asarray(tri[1]) - np.asarray(tri[0]),
                       np.asarray(tri[2]) - np.asarray(tri[0]))
        ctr = np.mean(np.array(tri), axis=0)
        rad = ctr - np.array([cx, ctr[1], cz])
        if np.dot(nrm, rad) < 0:
            tri = tri[::-1]
        p.add_face(tri, zone=zone)


# ── body ─────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')

    # dirt pad
    w, h, d = F.PAD
    cell_box(p, (0, h / 2, 0), (w, h, d), F.PAD_S, F.PAD_T)

    # log stacks (pyramids)
    for (cx, cz, yaw, hl, rows) in F.LOG_STACKS:
        pitch = 2 * F.LOG_R * 0.96
        for row in range(rows):
            n = rows - row
            y = F.PAD_TOP_Y + F.LOG_R + row * (2 * F.LOG_R * 0.87)
            a = np.radians(yaw)
            for i in range(n):
                off = (i - (n - 1) / 2) * pitch
                lx = cx + off * np.sin(a)
                lz = cz + off * np.cos(a)
                jl = hl * float(RNG.uniform(0.9, 1.0))
                log(p, lx, lz, y, yaw + float(RNG.uniform(-2, 2)), jl)

    # loose logs
    for (cx, cz, yaw, hl) in F.LOOSE_LOGS:
        log(p, cx, cz, F.PAD_TOP_Y + F.LOG_R, yaw, hl)

    # ── saw shed ──
    hw, hd = F.SHED_W / 2, F.SHED_D / 2
    posts = [(F.SHED_CX - hw, F.SHED_CZ - hd, F.POST_H_HI),
             (F.SHED_CX + hw, F.SHED_CZ - hd, F.POST_H_HI),
             (F.SHED_CX - hw, F.SHED_CZ + hd, F.POST_H_LO),
             (F.SHED_CX + hw, F.SHED_CZ + hd, F.POST_H_LO)]
    for (px, pz, ph) in posts:
        limb(p, (px, F.PAD_TOP_Y, pz), (px, ph, pz),
             F.POST_S * 0.5, F.POST_S * 0.5, F.POST_W, n=4)
    # mono-pitch roof slab: high at -z, low at +z, with overhang
    x0, x1 = F.SHED_CX - hw - F.ROOF_OVER, F.SHED_CX + hw + F.ROOF_OVER
    z0, z1 = F.SHED_CZ - hd - F.ROOF_OVER, F.SHED_CZ + hd + F.ROOF_OVER
    slope = (F.POST_H_HI - F.POST_H_LO) / F.SHED_D
    y_at = lambda z: F.POST_H_LO + slope * ((F.SHED_CZ + hd + F.ROOF_OVER) - z)
    zt = Zone(F.ROOF_T, ('x', 'z'), ((x0, x1), (z0, z1)))
    zu = Zone(F.ROOF_U, ('x', 'z'), ((x0, x1), (z0, z1)))
    top = [(x0, y_at(z0) + F.ROOF_TH, z0), (x0, y_at(z1) + F.ROOF_TH, z1),
           (x1, y_at(z1) + F.ROOF_TH, z1), (x1, y_at(z0) + F.ROOF_TH, z0)]
    bot = [(x0, y_at(z0), z0), (x0, y_at(z1), z1),
           (x1, y_at(z1), z1), (x1, y_at(z0), z0)]
    p.add_face(top, zone=zt)                     # up
    p.add_face(bot[::-1], zone=zu)               # underside
    edge = Zone(F.ROOF_U, ('x', 'y'), ((x0, x1), (3.6, 2.4)))
    p.add_face([bot[0], top[0], top[3], bot[3]], zone=edge)     # -z fascia
    p.add_face([bot[1], bot[2], top[2], top[1]], zone=edge)     # +z fascia
    edgez = Zone(F.ROOF_U, ('z', 'y'), ((z0, z1), (3.6, 2.4)))
    p.add_face([bot[0], bot[1], top[1], top[0]], zone=edgez)    # -x
    p.add_face([bot[3], top[3], top[2], bot[2]], zone=edgez)    # +x

    # saw bench + half-cut log on it
    bw, bh, bd = F.BENCH_SIZE
    cell_box(p, (F.BENCH_C[0], F.PAD_TOP_Y + bh / 2, F.BENCH_C[2]),
             (bw, bh, bd), F.BENCH_S, F.BENCH_T)
    blx, blz, blhl = F.BENCH_LOG
    log(p, blx, blz, F.PAD_TOP_Y + bh + F.LOG_R * 0.8, 0, blhl,
        r=F.LOG_R * 0.8)

    # ── log crane ──
    bx, bz = F.CRANE_BASE
    fw, fh, fd = F.CRANE_FOOT
    czone = Zone(F.CONC_C, ('x', 'y'),
                 ((bx - fw / 2, bx + fw / 2),
                  (F.PAD_TOP_Y + fh, F.PAD_TOP_Y)))
    ctop = Zone(F.CONC_C, ('x', 'z'),
                ((bx - fw / 2, bx + fw / 2), (bz - fd / 2, bz + fd / 2)))
    chamfer_box(p, (bx, F.PAD_TOP_Y + fh / 2, bz), (fw, fh, fd), 0.05,
                {'+y': ctop, '+x': czone, '-x': czone, '+z': czone,
                 '-z': czone}, skip=('-y',))
    mast_top = Zone(F.MAST_W, ('x', 'z'),
                    ((bx - F.MAST_R, bx + F.MAST_R),
                     (bz - F.MAST_R, bz + F.MAST_R)))
    limb(p, (bx, F.PAD_TOP_Y + fh, bz), (bx, F.MAST_H, bz),
         F.MAST_R, F.MAST_R * 0.8, F.MAST_W, n=6, cap_end=mast_top)
    # jib toward -x over the log stacks, slight upward rake
    tip = (bx - F.JIB_LEN, F.JIB_Y + 0.35, bz)
    limb(p, (bx, F.JIB_Y, bz), tip, F.JIB_R, F.JIB_R * 0.6, F.JIB_W, n=4,
         cap_end=Z_DARK_CAP)
    # stay strut mast-top → mid-jib
    mid = (bx - F.JIB_LEN * 0.55, F.JIB_Y + 0.19 + 0.02, bz)
    limb(p, (bx, F.MAST_H, bz), mid, 0.045, 0.045, F.CABLE_W, n=4)
    # cable + hook block
    hx, hy = tip[0], tip[1] - F.CABLE_DROP
    limb(p, (tip[0], tip[1], bz), (hx, hy, bz),
         F.CABLE_R, F.CABLE_R, F.CABLE_W, n=4)
    hw2, hh2, hd2 = F.HOOK_SIZE
    cell_box(p, (hx, hy - hh2 / 2, bz), (hw2, hh2, hd2),
             F.HOOK_C, F.HOOK_C, skip=())

    # cut lumber stacks
    for (cx, cz, yaw, w2, h2, d2) in F.LUMBER_STACKS:
        cell_box(p, (cx, F.PAD_TOP_Y + h2 / 2, cz), (w2, h2, d2),
                 F.LUMBER_S, F.LUMBER_T, yaw=yaw)

    # sawdust piles
    for (cx, cz, r, hgt) in F.SAWDUST_PILES:
        cone(p, cx, cz, F.PAD_TOP_Y, r, hgt, F.SAWDUST)
    return p


Z_DARK_CAP = F.Z_DARK


# ── blade (piece-local: disk in XY plane, spin axis +Z) ─────────────────

def build_blade():
    p = Part('blade')
    r, t, n = F.BLADE_R, F.BLADE_TH / 2, F.BLADE_N
    front = ngon_ring((0, 0, -t), r, n=n, axis='z')
    back = ngon_ring((0, 0, t), r, n=n, axis='z')
    zf = Zone(F.BLADE_C, ('x', 'y'), ((-r, r), (r, -r)))
    zb = Zone(F.BLADE_C, ('x', 'y'), ((r, -r), (r, -r)))
    p.add_face(front, zone=zf, flip=True)
    p.add_face(back, zone=zb)
    # fix winding: ensure front face normal points -z, back +z
    # (add_face fan-triangulates; flip chosen empirically via validate)
    # arbor stub through the blade along +Z
    limb(p, (0, 0, -0.09), (0, 0, 0.09), 0.045, 0.045, F.ARBOR_W, n=6,
         cap_start=Zone(F.ARBOR_W, ('x', 'y'), ((-0.05, 0.05), (0.05, -0.05))),
         cap_end=Zone(F.ARBOR_W, ('x', 'y'), ((0.05, -0.05), (0.05, -0.05))))
    return p


# ── idle spin clip ───────────────────────────────────────────────────────

def build_clips():
    T = F.BLADE_SPIN_T
    n = 8
    keys = []
    for i in range(n + 1):
        th = 2 * np.pi * i / n
        keys.append((T * i / n,
                     (0.0, 0.0, float(np.sin(th / 2)), float(np.cos(th / 2)))))
    return [{'name': 'idle', 'channels': [('blade', 'rotation', keys)]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='blade', parent=0, offset=F.BLADE_OFF, part=build_blade()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=build_clips(),
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=build_clips(),
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
