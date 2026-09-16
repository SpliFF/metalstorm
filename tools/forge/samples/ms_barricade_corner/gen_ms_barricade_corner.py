"""gen_ms_barricade_corner — 90° barricade corner, two 4 m arms.

The corner element of the old ms_barricade_set kit sheet as a model of its
own, root offset zeroed (units-assets review 2026-09-10). ONE piece `body`,
no clips. Deterministic: geometry from the layout constants only.
Run: python3 gen_ms_barricade_corner.py -> out/ms_barricade_corner{,_png}.gltf
"""
import numpy as np

import ms_barricade_corner_layout as L
from meshlib import Part, chamfer_box, limb
from gltf_export import export

STEM = 'ms_barricade_corner'
OUT = 'out'


def quad_out(p, verts, outward, zone):
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, np.asarray(outward, dtype=float)) > 0
               else verts[::-1], zone=zone)


def berm_x(p, x0, x1, cap0=True, cap1=True):
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


def build_body():
    p = Part('body')
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


def build_all():
    return [dict(name='body', parent=-1, offset=(0.0, 0.0, 0.0),
                 part=build_body())]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_{STEM}] total tris: {total}')
