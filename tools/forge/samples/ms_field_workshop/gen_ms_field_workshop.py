"""gen_ms_field_workshop — build ms_field_workshop + idle traverse clip.

Open-sided 14x10 m field workshop: skillion corrugated roof on six posts
with eave headers and corner braces, free-standing gantry crane (portal
columns, yellow rails, animated `crane` bridge with trolley/cable/hook),
two workbenches, engine hoist, three parts bins + rack, drums, crate on
pallet, tool locker, welding bottles. Only `crane` animates: a slow rail
traverse with end dwells (idle clip, translation channel).

Usage: python3 gen_ms_field_workshop.py
"""
from __future__ import annotations
import os
import numpy as np

import ms_field_workshop_layout as L   # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, Zone, chamfer_box, ngon_ring, limb
from gltf_export import export

STEM = 'ms_field_workshop'
OUT = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', '..', 'out'))
RNG = np.random.default_rng(90210)


# ── helpers (forge patterns) ─────────────────────────────────────────────

def quad_out(p, verts, outward, zone):
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, outward) > 0 else verts[::-1], zone=zone)


PBOX_FACES = {
    '+y': [(-1, 1, -1), (-1, 1, 1), (1, 1, 1), (1, 1, -1)],
    '-y': [(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)],
    '+x': [(1, -1, -1), (1, 1, -1), (1, 1, 1), (1, -1, 1)],
    '-x': [(-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1)],
    '-z': [(-1, -1, -1), (-1, 1, -1), (1, 1, -1), (1, -1, -1)],
    '+z': [(-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)],
}


def pbox(p, center, size, zones, skip=()):
    """Plain 6-quad box (12 tris, no bevels) — STYLE.md lets us skip the
    bevel on edges too small for the tri budget. zones: Zone or face dict."""
    if not isinstance(zones, dict):
        zones = {k: zones for k in PBOX_FACES}
    cx, cy, cz = center
    hx, hy, hz = size[0] / 2.0, size[1] / 2.0, size[2] / 2.0
    for k, signs in PBOX_FACES.items():
        if k in skip or k not in zones:
            continue
        p.add_face([(cx + sx * hx, cy + sy * hy, cz + sz * hz)
                    for (sx, sy, sz) in signs], zone=zones[k])


def box(p, center, size, zone, ch=0.04, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def drum_y(p, cx, cz, ybase, ytop, r, wrap_rect, cap_zone=None, n=8):
    r0 = ngon_ring((cx, ybase, cz), r, n=n, axis='y')
    r1 = ngon_ring((cx, ytop, cz), r, n=n, axis='y')
    dx0, dy0, dx1, dy1 = wrap_rect
    for j in range(n):
        k = (j + 1) % n
        u0 = (dx0 + (dx1 - dx0) * j / n) / M.ATLAS
        u1 = (dx0 + (dx1 - dx0) * (j + 1) / n) / M.ATLAS
        quad = [r0[j], r0[k], r1[k], r1[j]]
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
        zc = Zone(cap_zone.rect, ('x', 'z'), ((cx - r, cx + r), (cz - r, cz + r)))
        p.add_face(ngon_ring((cx, ytop, cz), r, n=n, axis='y'), zone=zc, flip=True)


# ── the building ─────────────────────────────────────────────────────────

def post_top(pz):
    return L.roof_y(pz) - L.RT - L.HEADER_H


def build_body():
    p = Part('body')
    # concrete pad
    x, y, z, w, h, d = L.PAD
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+y': L.W_PAD, '+x': L.W_PADS_S, '-x': L.W_PADS_S,
                 '+z': L.W_PADS_F, '-z': L.W_PADS_F}, skip=('-y',))
    # skillion roof slab (tilted — explicit quads)
    A = (-L.RX, L.RY_F, -L.RZ)
    B = (L.RX, L.RY_F, -L.RZ)
    C = (L.RX, L.RY_B, L.RZ)
    D = (-L.RX, L.RY_B, L.RZ)
    A2, B2, C2, D2 = [(v[0], v[1] - L.RT, v[2]) for v in (A, B, C, D)]
    quad_out(p, [A, B, C, D], (0, 1, 0), L.W_ROOF_T)
    quad_out(p, [A2, D2, C2, B2], (0, -1, 0), L.W_ROOF_U)
    quad_out(p, [A, B, B2, A2], (0, 0, -1), L.W_FASCIA)
    quad_out(p, [D, C, C2, D2], (0, 0, 1), L.W_FASCIA)
    quad_out(p, [A, D, D2, A2], (-1, 0, 0), L.W_FASCIA_S)
    quad_out(p, [B, C, C2, B2], (1, 0, 0), L.W_FASCIA_S)
    # posts + eave headers + corner braces + purlins
    for pz in L.POST_ZS:
        for px in L.POST_XS:
            limb(p, (px, L.PAD_TOP, pz), (px, post_top(pz), pz),
                 0.11, 0.10, L.W_POST, n=4)
        hy = L.roof_y(pz) - L.RT - L.HEADER_H / 2
        pbox(p, (0.0, hy, pz), (13.8, L.HEADER_H, L.HEADER_H), L.W_BEAM)
        for px in (L.POST_XS[0], L.POST_XS[-1]):
            s = 1.0 if px > 0 else -1.0
            limb(p, (px - s * 0.11, post_top(pz) - 1.15, pz),
                 (px - s * 1.35, post_top(pz) + 0.1, pz),
                 0.05, 0.05, L.W_POST, n=4)
    for pz in L.PURLIN_ZS:
        pbox(p, (0.0, L.roof_y(pz) - L.RT - 0.07, pz), (14.0, 0.14, 0.14),
             L.W_BEAM)
    # gantry portal: 4 columns + 2 rails + end stops
    rail_bot = L.RAIL_TOP - L.RAIL_SIZE[1]
    for gz in (-L.GZ, L.GZ):
        for gx in (-L.GX, L.GX):
            limb(p, (gx, L.PAD_TOP, gz), (gx, rail_bot + 0.01, gz),
                 0.10, 0.10, L.W_POST, n=4)
        chamfer_box(p, (0.0, L.RAIL_TOP - L.RAIL_SIZE[1] / 2, gz),
                    L.RAIL_SIZE, 0.04,
                    {k: L.W_RAIL for k in PBOX_FACES})
        for sx in (-L.STOP_X, L.STOP_X):
            pbox(p, (sx, L.RAIL_TOP + 0.1, gz), (0.2, 0.2, 0.3), L.W_TRIM)
    # workbenches along the -x side
    for i, zc in enumerate(L.BENCH_ZC):
        tw, th, td = L.BENCH_TOP
        pbox(p, (L.BENCH_X, 0.91, zc), (tw, th, td),
             {'+y': L.W_BENCH_T[i], '-y': L.W_BENCH_S, '+x': L.W_BENCH_S,
              '-x': L.W_BENCH_S, '+z': L.W_BENCH_S, '-z': L.W_BENCH_S})
        pw, ph, pd = L.BENCH_PANEL
        for sz in (zc - td / 2 + pd / 2, zc + td / 2 - pd / 2):
            pbox(p, (L.BENCH_X, L.PAD_TOP + ph / 2, sz), (pw, ph, pd),
                 L.W_BENCH_S)
    # parts bins along the +x side (open tops painted as part heaps)
    for i, zc in enumerate(L.BIN_ZC):
        bw, bh, bd = L.BIN_SIZE
        pbox(p, (L.BIN_X, L.PAD_TOP + bh / 2, zc), (bw, bh, bd),
             {'+y': L.W_BIN_T[i], '+x': L.W_BIN_S[i], '-x': L.W_BIN_S[i],
              '+z': L.W_BIN_S[i], '-z': L.W_BIN_S[i]})
    # bin rack (2 side panels + 3 shelves)
    rx, rz = L.RACK
    for sz in (rz - 0.55, rz + 0.55):
        pbox(p, (rx, L.PAD_TOP + 0.85, sz), (0.9, 1.7, 0.12), L.W_RACK)
    for sy in (0.75, 1.25, 1.75):
        pbox(p, (rx, L.PAD_TOP + sy, rz), (0.85, 0.08, 1.0), L.W_DARK)
    # engine hoist (boom faces the open -z bay)
    hx, hz = L.HOIST
    for sx in (-0.33, 0.33):
        pbox(p, (hx + sx, L.PAD_TOP + 0.07, hz - 0.65), (0.16, 0.14, 1.7),
             L.W_HOIST)
    pbox(p, (hx, L.PAD_TOP + 0.07, hz - 0.1), (0.7, 0.12, 0.14), L.W_HOIST)
    limb(p, (hx, L.PAD_TOP, hz), (hx, 2.05, hz), 0.075, 0.07, L.W_HOISTP, n=4)
    limb(p, (hx, 1.95, hz), (hx, 2.25, hz - 1.35), 0.055, 0.05, L.W_HOISTP,
         n=4)
    limb(p, (hx, 2.2, hz - 1.3), (hx, 1.75, hz - 1.3), 0.03, 0.03, L.W_DARKP,
         n=4)
    pbox(p, (hx, 1.65, hz - 1.3), (0.12, 0.16, 0.1), L.W_TRIM)
    # drums / crate on pallet / tool locker / welding bottles
    for (dx, dz) in L.DRUMS:
        drum_y(p, dx, dz, L.PAD_TOP, L.PAD_TOP + L.DRUM_H, L.DRUM_R,
               L.W_DRUM, cap_zone=L.W_DRUM_T, n=8)
    x, y, z, w, h, d = L.CRATE
    chamfer_box(p, (x, y, z), (w, h, d), 0.04,
                {k: L.W_CRATE for k in PBOX_FACES}, skip=('-y',))
    x, y, z, w, h, d = L.PALLET
    pbox(p, (x, y, z), (w, h, d), L.W_TRIM, skip=('-y',))
    x, y, z, w, h, d = L.LOCKER
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': L.W_DARK, '-y': L.W_DARK, '+x': L.W_LOCKER,
                 '-x': L.W_LOCKER, '+z': L.W_LOCKER, '-z': L.W_LOCKER},
                skip=('-y',))
    for (gx, gz) in L.GAS:
        limb(p, (gx, L.PAD_TOP, gz), (gx, L.PAD_TOP + L.GAS_H, gz),
             L.GAS_R, L.GAS_R * 0.85, L.W_GAS, n=6, cap_end=L.W_DARK)
    return p


def build_crane():
    p = Part('crane')
    # end trucks riding the rails
    for gz in (-L.GZ, L.GZ):
        pbox(p, (0.0, L.TRUCK[1] / 2, gz), L.TRUCK, L.W_CRANE)
    # bridge beam spanning z on top of the trucks
    chamfer_box(p, (0.0, L.TRUCK[1] + L.BRIDGE[1] / 2, 0.0), L.BRIDGE, 0.05,
                {k: L.W_CRANE for k in PBOX_FACES})
    # trolley + cable + hook block + hook
    chamfer_box(p, (0.0, 0.06, L.TROLLEY_Z), L.TROLLEY, 0.04,
                {k: L.W_TROLLEY for k in PBOX_FACES})
    limb(p, (0.0, L.CABLE_Y[0], L.TROLLEY_Z), (0.0, L.CABLE_Y[1], L.TROLLEY_Z),
         0.045, 0.045, L.W_DARKP, n=4)
    pbox(p, (0.0, -1.48, L.TROLLEY_Z), L.HOOK_BLOCK, L.W_HOOK)
    pbox(p, (0.0, -1.74, L.TROLLEY_Z), (0.07, 0.22, 0.07), L.W_HOOK)
    pbox(p, (0.06, -1.9, L.TROLLEY_Z), (0.26, 0.09, 0.08), L.W_HOOK)
    return p


# ── clips ────────────────────────────────────────────────────────────────

def build_clips():
    y = L.CRANE_OFF[1]
    home = (0.0, y, 0.0)
    left = (-L.TRAV, y, 0.0)
    right = (L.TRAV, y, 0.0)
    T = L.TRAV_T
    keys = [(0.0, home), (T * 0.217, left), (T * 0.283, left),
            (T * 0.5, home), (T * 0.717, right), (T * 0.783, right),
            (T, home)]
    idle = {'name': 'idle', 'channels': [('crane', 'translation', keys)]}
    return [idle]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='crane', parent=0, offset=L.CRANE_OFF, part=build_crane()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_field_workshop] total tris: {total}')
