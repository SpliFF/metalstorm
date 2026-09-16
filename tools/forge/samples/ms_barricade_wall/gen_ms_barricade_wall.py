"""gen_ms_barricade_wall — 8 m scrap-plate wall segment on an earth berm.

The wall element of the old ms_barricade_set kit sheet as a model of its own,
root offset zeroed (kit layout docstring; units-assets review 2026-09-10).
ONE piece `body`, no clips. Deterministic: geometry from the layout constants.
Run: python3 gen_ms_barricade_wall.py -> out/ms_barricade_wall{,_png}.gltf+.bin
"""
import numpy as np

import ms_barricade_wall_layout as L
from meshlib import Part, chamfer_box, limb
from gltf_export import export

STEM = 'ms_barricade_wall'
OUT = 'out'


def quad_out(p, verts, outward, zone):
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, np.asarray(outward, dtype=float)) > 0
               else verts[::-1], zone=zone)


def berm_x(p, x0, x1):
    """Berm running along X, centred on z=0, front slope faces -Z."""
    hb, ht, h = L.BERM_HB, L.BERM_HT, L.BERM_H
    quad_out(p, [(x0, 0, -hb), (x1, 0, -hb), (x1, h, -ht), (x0, h, -ht)],
             (0, 0.45, -1), L.EARTH)
    quad_out(p, [(x0, 0, hb), (x1, 0, hb), (x1, h, ht), (x0, h, ht)],
             (0, 0.45, 1), L.EARTH)
    quad_out(p, [(x0, h, -ht), (x1, h, -ht), (x1, h, ht), (x0, h, ht)],
             (0, 1, 0), L.EARTH_TOP)
    for (x, out) in ((x0, -1), (x1, 1)):
        quad_out(p, [(x, 0, -hb), (x, h, -ht), (x, h, ht), (x, 0, hb)],
                 (out, 0, 0), L.EARTH_Z)


def plate_x(p, cx, w, top, zoff):
    h = top - L.PLATE_Y0
    chamfer_box(p, (cx, L.PLATE_Y0 + h / 2, zoff), (w, h, L.PLATE_T), 0.04,
                {'-z': L.WALL_F, '+z': L.WALL_F, '+y': L.WALL_TOP,
                 '+x': L.TRIM, '-x': L.TRIM}, skip=('-y',))


def sandbag_row(p, cx, cz, length):
    chamfer_box(p, (cx, 0.30, cz), (length, 0.6, 0.72), 0.12,
                {'+y': L.SAND, '+x': L.SAND, '-x': L.SAND,
                 '+z': L.SAND, '-z': L.SAND}, skip=('-y',))


def build_body():
    p = Part('body')
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


def build_all():
    return [dict(name='body', parent=-1, offset=(0.0, 0.0, 0.0),
                 part=build_body())]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_{STEM}] total tris: {total}')
