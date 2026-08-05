"""gen_ms_supply_dump — assemble ms_supply_dump and export .gltf/.bin.

Staging-post kit (10x10 m): dirt pad, wood-crate stacks (big ones
chamfered, small ones plain + yawed for silhouette variety), olive ammo
boxes, upright/lying drum clusters, two fuel bladders, a pallet row,
concrete barrier blocks, a pipe stack, and one draped `tarp` piece with
a subtle idle flap.  Chamfer only where the edge is big enough to pay
for it (STYLE.md bevel rule); everything else is plain flat-shaded.
Run: python3 gen_ms_supply_dump.py → out/ms_supply_dump{,_png}.gltf + .bin
"""
import numpy as np

import ms_supply_dump_layout as F      # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, Zone, chamfer_box, ngon_ring, loft, limb
from gltf_export import export

STEM = 'ms_supply_dump'
OUT = 'out'


# ── shared helpers ───────────────────────────────────────────────────────

def _uv(px, py):
    return (px / M.ATLAS, py / M.ATLAS)


# face key -> (corner signs CCW-outward, uv corner picker)
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
    """Plain box; every face UV-mapped onto the FULL cell rect, so all
    instances share one painted cell.  yaw (deg) rotates about +Y for
    scatter variety — UVs are face-local so rotation is free."""
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


def box_zones(center, size, side_cell, top_cell):
    """Per-item world-window Zones for chamfer_box (axis-aligned only)."""
    x, y, z = center
    w, h, d = size
    sv = (y + h / 2, y - h / 2)
    return {
        '+y': Zone(top_cell, ('x', 'z'), ((x - w / 2, x + w / 2),
                                          (z - d / 2, z + d / 2))),
        '+x': Zone(side_cell, ('z', 'y'), ((z - d / 2, z + d / 2), sv)),
        '-x': Zone(side_cell, ('z', 'y'), ((z + d / 2, z - d / 2), sv)),
        '-z': Zone(side_cell, ('x', 'y'), ((x - w / 2, x + w / 2), sv)),
        '+z': Zone(side_cell, ('x', 'y'), ((x + w / 2, x - w / 2), sv)),
    }


def drum(p, cx, cz, ybase, h, r, n=6):
    """Vertical n-gon drum: parametric side wrap into DRUM_W + lid cap."""
    ra = ngon_ring((cx, ybase, cz), r, n=n, axis='y')
    rb = ngon_ring((cx, ybase + h, cz), r, n=n, axis='y')
    dx0, dy0, dx1, dy1 = F.DRUM_W
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
    lid = Zone(F.DRUM_T, ('x', 'z'), ((cx - r, cx + r), (cz - r, cz + r)))
    p.add_face(ngon_ring((cx, ybase + h, cz), r, n=n, axis='y'),
               zone=lid, flip=True)


def bladder(p, cx, cz, rx, rz, yaw):
    """Low squashed fuel pillow: 8-gon loft of BLAD_PROFILE + top cap."""
    a = np.radians(yaw)
    ca, sa = np.cos(a), np.sin(a)
    ex = max(rx, rz) + 0.05
    z_top = Zone(F.BLAD_T, ('x', 'z'), ((cx - ex, cx + ex), (cz - ex, cz + ex)))
    z_sx = Zone(F.BLAD_S, ('z', 'y'), ((cz - ex, cz + ex), (0.85, 0.0)))
    z_sz = Zone(F.BLAD_S, ('x', 'y'), ((cx - ex, cx + ex), (0.85, 0.0)))

    def zf(c, n):
        if n[1] > 0.55:
            return z_top
        return z_sx if abs(n[0]) >= abs(n[2]) else z_sz

    rings = []
    for (y, f) in F.BLAD_PROFILE:
        ring = []
        for i in range(8):
            t = np.pi / 8 + 2 * np.pi * i / 8
            lx, lz = rx * f * np.cos(t), rz * f * np.sin(t)
            ring.append((cx + lx * ca + lz * sa, y, cz - lx * sa + lz * ca))
        rings.append(ring)
    loft(p, rings, zf, flip_side=True, cap_end=z_top)


# ── body ─────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')

    # dirt pad
    w, h, d = F.PAD
    cell_box(p, (0, h / 2, 0), (w, h, d), F.PAD_S, F.PAD_T)

    # pallets
    pw, ph, pd = F.PALLET_SIZE
    for (cx, cz) in F.PALLETS:
        cell_box(p, (cx, F.PAD_TOP_Y + ph / 2, cz), (pw, ph, pd),
                 F.PALLET_S, F.PALLET_T)

    # wood crates
    for (cx, cy, cz, cw, chh, cd, yaw, cham) in F.WOOD_CRATES:
        if cham:
            chamfer_box(p, (cx, cy, cz), (cw, chh, cd), 0.05,
                        box_zones((cx, cy, cz), (cw, chh, cd),
                                  F.CRATE_S, F.CRATE_T), skip=('-y',))
        else:
            cell_box(p, (cx, cy, cz), (cw, chh, cd), F.CRATE_S, F.CRATE_T,
                     yaw=yaw)

    # ammo boxes
    for (cx, cy, cz, cw, chh, cd, yaw) in F.AMMO_BOXES:
        cell_box(p, (cx, cy, cz), (cw, chh, cd), F.AMMO_S, F.AMMO_T, yaw=yaw)

    # drum clusters
    for (cx, cz, dh) in F.DRUMS:
        drum(p, cx, cz, F.PAD_TOP_Y, dh, F.DRUM_R)
    lx, ly, lz, hl, lr = F.DRUM_LYING
    lid = Zone(F.DRUM_T, ('z', 'y'), ((lz - lr, lz + lr), (ly + lr, ly - lr)))
    limb(p, (lx - hl, ly, lz), (lx + hl, ly, lz), lr, lr, F.DRUM_W, n=6,
         cap_start=lid, cap_end=lid)

    # fuel bladders
    for (cx, cz, rx, rz, yaw) in F.BLADDERS:
        bladder(p, cx, cz, rx, rz, yaw)

    # pipe stack
    for (cy, cz) in F.PIPES:
        limb(p, (F.PIPE_CX - F.PIPE_HL, cy, cz), (F.PIPE_CX + F.PIPE_HL, cy, cz),
             F.PIPE_R, F.PIPE_R, F.PIPE_W, n=6,
             cap_start=F.Z_DARK, cap_end=F.Z_DARK)

    # concrete barrier blocks
    for (cx, cy, cz, cw, chh, cd) in F.CONC_BLOCKS:
        chamfer_box(p, (cx, cy, cz), (cw, chh, cd), 0.06,
                    box_zones((cx, cy, cz), (cw, chh, cd),
                              F.CONC_S, F.CONC_T), skip=('-y',))
    return p


# ── tarp ─────────────────────────────────────────────────────────────────

def build_tarp():
    p = Part('tarp')
    rows = []
    for zi, z in enumerate(F.TARP_STATIONS):
        sag, hl, hr = F.TARP_JITTER[zi]
        row = []
        for xi, (x, y) in enumerate(F.TARP_PROFILE):
            dy = sag if xi in (1, 2) else (hl if xi == 0 else hr)
            row.append((x, y + dy, z))
        rows.append(row)
    for s in range(len(rows) - 1):
        for i in range(len(F.TARP_PROFILE) - 1):
            quad = [rows[s][i], rows[s + 1][i], rows[s + 1][i + 1],
                    rows[s][i + 1]]                      # +Y-ish outward
            p.add_face(quad, zone=F.Z_TARP_T)
            p.add_face(quad[::-1], zone=F.Z_TARP_U)      # underside
    return p


# ── idle flap clip ───────────────────────────────────────────────────────

def _qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz)


def _qx(deg):
    r = np.radians(deg) / 2
    return (float(np.sin(r)), 0.0, 0.0, float(np.cos(r)))


def _qz(deg):
    r = np.radians(deg) / 2
    return (0.0, 0.0, float(np.sin(r)), float(np.cos(r)))


def build_clips():
    A, T = F.TARP_FLAP_DEG, F.TARP_FLAP_T
    n = 8
    keys = []
    for i in range(n + 1):                      # last key repeats the first
        ph = 2 * np.pi * i / n
        q = _qmul(_qx(A * np.sin(ph)), _qz(A * 0.7 * np.cos(ph)))
        keys.append((T * i / n, q))
    return [{'name': 'idle', 'channels': [('tarp', 'rotation', keys)]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='tarp', parent=0, offset=F.TARP_OFF, part=build_tarp()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=build_clips(),
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=build_clips(),
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
