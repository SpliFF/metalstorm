"""gen_ms_barricade_gate — 8 m barricade gateway with an animated leaf.

The gate element of the old ms_barricade_set kit sheet as a model of its own,
root offset zeroed (units-assets review 2026-09-10). Pieces `body` (two pylons
+ hazard lintel + sandbag toes) and `gate` (the scrap leaf, hinge at the -X
pylon); clip `open` is a rigid rotation channel, LINEAR, ~3.2 s, non-looping.
Run: python3 gen_ms_barricade_gate.py -> out/ms_barricade_gate{,_png}.gltf+.bin
"""
import numpy as np

import ms_barricade_gate_layout as L
from meshlib import Part, chamfer_box, limb
from gltf_export import export

STEM = 'ms_barricade_gate'
OUT = 'out'


def sandbag_row(p, cx, cz, length):
    chamfer_box(p, (cx, 0.30, cz), (length, 0.6, 0.72), 0.12,
                {'+y': L.SAND, '+x': L.SAND, '-x': L.SAND,
                 '+z': L.SAND, '-z': L.SAND}, skip=('-y',))


def build_body():
    p = Part('body')
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


def build_leaf():
    p = Part('gate')
    # leaf: local origin = hinge axis; panel spans x 0.05..5.15
    chamfer_box(p, (0.05 + L.LEAF_W / 2, 0.15 + L.LEAF_H / 2, 0),
                (L.LEAF_W, L.LEAF_H, L.LEAF_T), 0.03,
                {'-z': L.GATE_LEAF, '+z': L.GATE_LEAF, '+y': L.TRIM,
                 '-y': L.TRIM, '+x': L.TRIM, '-x': L.TRIM})
    # hinge barrel on the pivot axis
    limb(p, (0, 0.25, 0), (0, 2.75, 0), 0.085, 0.075, L.TRIM.rect, n=4,
         cap_end=L.TRIM)
    # X-brace across the front face
    zf = -(L.LEAF_T / 2 + 0.05)
    limb(p, (0.35, 0.45, zf), (4.85, 2.55, zf), 0.055, 0.055, L.TRIM.rect, n=3)
    limb(p, (0.35, 2.55, zf), (4.85, 0.45, zf), 0.055, 0.055, L.TRIM.rect, n=3)
    return p


def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    keys = [(t, qy(deg)) for (t, deg) in L.OPEN_KEYS]
    return [{'name': 'open', 'channels': [('gate', 'rotation', keys)]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0.0, 0.0, 0.0), part=build_body()),
        dict(name='gate', parent=0, offset=(L.HINGE_X, 0.0, 0.0),
             part=build_leaf()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_{STEM}] total tris: {total}')
