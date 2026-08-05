"""gen_ms_barricade_set — modular staging-post barricade kit.

Three elements as separate ROOT pieces in one glTF (spec: barricade kit):
  wall (root)        8 m scrap-plate wall segment on an earth berm
  corner (root)      90° corner, arms along +X (faces -Z) and +Z (faces -X)
  gate_frame (root)  8 m gateway; child `gate` leaf swings inward on a
                     -X-pylon hinge via the `open` clip (rigid node
                     rotation channel, LINEAR, ~3.2 s, non-looping)
Deterministic: geometry from ms_barricade_set_layout constants only.
Run: python3 gen_ms_barricade_set.py → out/ms_barricade_set{,_png}.gltf + .bin
"""
import numpy as np

import ms_barricade_set_layout as L
from meshlib import Part, chamfer_box, limb
from gltf_export import export

STEM = 'ms_barricade_set'
OUT = 'out'


def quad_out(p, verts, outward, zone):
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, np.asarray(outward, dtype=float)) > 0
               else verts[::-1], zone=zone)


# ── earthwork berms (trapezoid loft, open bottom) ───────────────────────

def berm_x(p, x0, x1, cap0=True, cap1=True):
    """Berm running along X, centred on z=0, front slope faces -Z."""
    hb, ht, h = L.BERM_HB, L.BERM_HT, L.BERM_H
    quad_out(p, [(x0, 0, -hb), (x1, 0, -hb), (x1, h, -ht), (x0, h, -ht)],
             (0, 0.45, -1), L.EARTH)
    quad_out(p, [(x0, 0, hb), (x1, 0, hb), (x1, h, ht), (x0, h, ht)],
             (0, 0.45, 1), L.EARTH)
    quad_out(p, [(x0, h, -ht), (x1, h, -ht), (x1, h, ht), (x0, h, ht)],
             (0, 1, 0), L.EARTH_TOP)
    if cap0:
        quad_out(p, [(x0, 0, -hb), (x0, h, -ht), (x0, h, ht), (x0, 0, hb)],
                 (-1, 0, 0), L.EARTH_Z)
    if cap1:
        quad_out(p, [(x1, 0, -hb), (x1, h, -ht), (x1, h, ht), (x1, 0, hb)],
                 (1, 0, 0), L.EARTH_Z)


def berm_z(p, z0, z1, cap0=True, cap1=True):
    """Berm running along Z, centred on x=0, front slope faces -X."""
    hb, ht, h = L.BERM_HB, L.BERM_HT, L.BERM_H
    quad_out(p, [(-hb, 0, z0), (-hb, 0, z1), (-ht, h, z1), (-ht, h, z0)],
             (-1, 0.45, 0), L.EARTH_Z)
    quad_out(p, [(hb, 0, z0), (hb, 0, z1), (ht, h, z1), (ht, h, z0)],
             (1, 0.45, 0), L.EARTH_Z)
    quad_out(p, [(-ht, h, z0), (-ht, h, z1), (ht, h, z1), (ht, h, z0)],
             (0, 1, 0), L.EARTH_TOP_Z)
    if cap0:
        quad_out(p, [(-hb, 0, z0), (-ht, h, z0), (ht, h, z0), (hb, 0, z0)],
                 (0, 0, -1), L.EARTH)
    if cap1:
        quad_out(p, [(-hb, 0, z1), (-ht, h, z1), (ht, h, z1), (hb, 0, z1)],
                 (0, 0, 1), L.EARTH)


# ── scrap plates ────────────────────────────────────────────────────────

def plate_x(p, cx, w, top, zoff):
    h = top - L.PLATE_Y0
    chamfer_box(p, (cx, L.PLATE_Y0 + h / 2, zoff), (w, h, L.PLATE_T), 0.04,
                {'-z': L.WALL_F, '+z': L.WALL_F, '+y': L.WALL_TOP,
                 '+x': L.TRIM, '-x': L.TRIM}, skip=('-y',))


def plate_z(p, cz, w, top, xoff):
    h = top - L.PLATE_Y0
    chamfer_box(p, (xoff, L.PLATE_Y0 + h / 2, cz), (L.PLATE_T, h, w), 0.04,
                {'-x': L.WALLZ_F, '+x': L.WALLZ_F, '+y': L.WALLZ_TOP,
                 '+z': L.TRIM, '-z': L.TRIM}, skip=('-y',))


def sandbag_row(p, cx, cz, length, along='x'):
    size = (length, 0.6, 0.72) if along == 'x' else (0.72, 0.6, length)
    chamfer_box(p, (cx, 0.30, cz), size, 0.12,
                {'+y': L.SAND, '+x': L.SAND, '-x': L.SAND,
                 '+z': L.SAND, '-z': L.SAND}, skip=('-y',))


# ── elements ────────────────────────────────────────────────────────────

def build_wall():
    p = Part('wall')
    berm_x(p, -L.SEG_HALF, L.SEG_HALF)
    for (cx, w, top, zoff) in L.WALL_PLATES:
        plate_x(p, cx, w, top, zoff)
    for x in L.WALL_POSTS:
        limb(p, (x, 0.15, L.POST_Z), (x, L.POST_H, L.POST_Z), 0.09, 0.07,
             L.TRIM.rect, n=4, cap_end=L.TRIM)
    for x in L.WALL_BRACES:
        limb(p, (x, 0.25, L.BRACE_FOOT), (x, 2.15, L.POST_Z - 0.06),
             0.06, 0.05, L.TRIM.rect, n=4)
    for (cx, cz, length) in L.WALL_BAGS:
        sandbag_row(p, cx, cz, length)
    return p


def build_corner():
    p = Part('corner')
    # +X arm (faces -Z) and +Z arm (faces -X)
    berm_x(p, 0.7, L.ARM_LEN, cap0=False)
    for (c, w, top, off) in L.ARM_PLATES:
        plate_x(p, c, w, top, off)
    berm_z(p, 0.7, L.ARM_LEN, cap0=False)
    for (c, w, top, off) in L.ARM_PLATES_Z:
        plate_z(p, c, w, top, off)
    # arm-end posts + one rear brace per arm
    limb(p, (L.ARM_LEN - 0.05, 0.15, L.POST_Z),
         (L.ARM_LEN - 0.05, L.POST_H, L.POST_Z), 0.09, 0.07,
         L.TRIM.rect, n=4, cap_end=L.TRIM)
    limb(p, (L.POST_Z, 0.15, L.ARM_LEN - 0.05),
         (L.POST_Z, L.POST_H, L.ARM_LEN - 0.05), 0.09, 0.07,
         L.TRIM.rect, n=4, cap_end=L.TRIM)
    limb(p, (2.5, 0.25, L.BRACE_FOOT), (2.5, 2.15, L.POST_Z - 0.06),
         0.06, 0.05, L.TRIM.rect, n=4)
    limb(p, (L.BRACE_FOOT, 0.25, 2.5), (L.POST_Z - 0.06, 2.15, 2.5),
         0.06, 0.05, L.TRIM.rect, n=4)
    # junction: earth mound + corner post + watch platform
    mw, mh, md = L.MOUND_SIZE
    chamfer_box(p, (0, mh / 2, 0), (mw, mh, md), 0.28,
                {'+y': L.EARTH_TOP, '+x': L.EARTH_Z, '-x': L.EARTH_Z,
                 '+z': L.EARTH, '-z': L.EARTH}, skip=('-y',))
    pw, ph, pd = L.CPOST_SIZE
    chamfer_box(p, (0, ph / 2 + 0.1, 0), (pw, ph, pd), 0.05,
                {'-z': L.PYLON, '+z': L.PYLON, '+x': L.PYLON_Z,
                 '-x': L.PYLON_Z, '+y': L.TOPS}, skip=('-y',))
    gw, gh, gd = L.CPLAT_SIZE
    chamfer_box(p, (0, L.CPLAT_Y + gh / 2, 0), (gw, gh, gd), 0.03,
                {'+y': L.TOPS, '-y': L.DARK, '+x': L.TRIM, '-x': L.TRIM,
                 '+z': L.TRIM, '-z': L.TRIM})
    return p


def build_gate_frame():
    p = Part('gate_frame')
    pw, ph, pd = L.PYLON_SIZE
    cw, chh, cd = L.CAP_SIZE
    for sx in (-1, 1):
        chamfer_box(p, (sx * L.PYLON_X, ph / 2, 0), (pw, ph, pd), 0.05,
                    {'-z': L.PYLON, '+z': L.PYLON, '+x': L.PYLON_Z,
                     '-x': L.PYLON_Z, '+y': L.TOPS}, skip=('-y',))
        chamfer_box(p, (sx * L.PYLON_X, ph + chh / 2, 0), (cw, chh, cd), 0.03,
                    {'+y': L.TOPS, '-y': L.DARK, '+x': L.TRIM, '-x': L.TRIM,
                     '+z': L.TRIM, '-z': L.TRIM})
    x, y, z, w, h, d = L.LINTEL_BOX
    chamfer_box(p, (x, y, z), (w, h, d), 0.04,
                {'-z': L.LINTEL, '+z': L.LINTEL, '+y': L.LINTEL_TOP,
                 '-y': L.DARK, '+x': L.TRIM, '-x': L.TRIM})
    for (cx, cz, length) in L.GATE_BAGS:
        sandbag_row(p, cx, cz, length)
    return p


def build_gate_leaf():
    p = Part('gate')
    # leaf: local origin = hinge axis; panel spans x 0.05..5.15
    chamfer_box(p, (0.05 + L.LEAF_W / 2, 0.15 + L.LEAF_H / 2, 0),
                (L.LEAF_W, L.LEAF_H, L.LEAF_T), 0.03,
                {'-z': L.GATE_LEAF, '+z': L.GATE_LEAF, '+y': L.TRIM,
                 '-y': L.TRIM, '+x': L.TRIM, '-x': L.TRIM})
    # hinge barrel on the pivot axis
    limb(p, (0, 0.25, 0), (0, 2.75, 0), 0.085, 0.075, L.TRIM.rect, n=6,
         cap_end=L.TRIM)
    # X-brace across the front face
    zf = -(L.LEAF_T / 2 + 0.05)
    limb(p, (0.35, 0.45, zf), (4.85, 2.55, zf), 0.055, 0.055,
         L.TRIM.rect, n=4)
    limb(p, (0.35, 2.55, zf), (4.85, 0.45, zf), 0.055, 0.055,
         L.TRIM.rect, n=4)
    # latch block on the free edge
    lx, ly, lz = L.LEAF_LATCH
    chamfer_box(p, (lx, ly, lz), (0.2, 0.5, 0.34), 0.03,
                {'+x': L.TRIM, '-x': L.TRIM, '+y': L.TRIM, '-y': L.TRIM,
                 '+z': L.TRIM, '-z': L.TRIM})
    return p


# ── clips ───────────────────────────────────────────────────────────────

def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    # `open`: leaf swings inward (+Z) about the hinge; slow start, firm
    # stop with a small settle. Non-looping — last key holds the pose.
    keys = [(0.0, qy(0.0)), (0.5, qy(-8.0)), (1.6, qy(-60.0)),
            (2.8, qy(-106.0)), (3.2, qy(-104.0))]
    return [{'name': 'open', 'channels': [('gate', 'rotation', keys)]}]


def build_all():
    return [
        dict(name='wall', parent=-1, offset=L.WALL_OFF, part=build_wall()),
        dict(name='corner', parent=-1, offset=L.CORNER_OFF,
             part=build_corner()),
        dict(name='gate_frame', parent=-1, offset=L.GATE_OFF,
             part=build_gate_frame()),
        dict(name='gate', parent=2, offset=(L.HINGE_X, 0.0, 0.0),
             part=build_gate_leaf()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_barricade_set] total tris: {total}')
