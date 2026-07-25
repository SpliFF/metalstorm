"""gen_radar — assemble ms_radar_s1 and export .gltf/.bin.

Field sensor mast (radar s1, STYLE.md: 4 m mast+dish): anchored pad,
equipment cabinet, guyed lattice mast, and a rotating open dish on a
yoke — `dish` is the animated piece (8 s sweep, idle clip).
Run: python3 gen_radar.py   → out/ms_radar_s1{,_png}.gltf + .bin
"""
import numpy as np

import radar_layout as F        # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, Zone, chamfer_box, ngon_ring, limb
from gltf_export import export

STEM = 'ms_radar_s1'
OUT = 'out'


def build_body():
    p = Part('body')

    # anchored pad
    x, y, z, w, h, d = F.PAD
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+y': F.R_PAD, '+x': F.R_PADS, '-x': F.R_PADS,
                 '+z': F.R_PADS_F, '-z': F.R_PADS_F}, skip=('-y',))

    # equipment cabinet
    x, y, z, w, h, d = F.CABINET
    chamfer_box(p, (x, y, z), (w, h, d), 0.04,
                {'+x': F.R_CAB, '-x': F.R_CAB, '+z': F.R_CAB_F,
                 '-z': F.R_CAB_F, '+y': F.R_CAB_T}, skip=('-y',))

    # lattice mast: centre pole + three splayed legs + cross braces
    mx, mz = F.MAST_X, F.MAST_Z
    limb(p, (mx, F.PAD_TOP, mz), (mx, F.MAST_TOP, mz), 0.09, 0.06, F.R_MAST, n=6)
    for a in (0.0, 2.094, 4.189):
        lx, lz = mx + 0.55 * np.sin(a), mz + 0.55 * np.cos(a)
        limb(p, (lx, F.PAD_TOP, lz), (mx, 2.30, mz), 0.045, 0.035, F.R_MAST, n=4)
        limb(p, ((lx + mx) / 2, (F.PAD_TOP + 2.30) / 2, (lz + mz) / 2),
             (mx, 1.45, mz), 0.028, 0.028, F.R_TRIM, n=4)

    # cable run cabinet → mast base
    limb(p, (F.CABINET[0] - 0.3, F.PAD_TOP + 0.35, F.CABINET[2] + 0.3),
         (mx, F.PAD_TOP + 0.22, mz), 0.05, 0.05, F.R_TRIM, n=4)

    # status light atop the cabinet
    chamfer_box(p, (F.CABINET[0], F.PAD_TOP + 1.28, F.CABINET[2]),
                (0.16, 0.16, 0.16), 0.02,
                {'+y': F.R_LIGHT, '-y': F.R_LIGHT, '+x': F.R_LIGHT,
                 '-x': F.R_LIGHT, '+z': F.R_LIGHT, '-z': F.R_LIGHT})
    return p


def build_dish():
    p = Part('dish')
    # yoke: short cross-arm the dish hangs from
    limb(p, (0, 0, 0), (0, 0.22, 0), 0.07, 0.07, F.R_YOKE, n=6)
    limb(p, (0, 0.22, 0), (0, 0.22, -0.30), 0.05, 0.05, F.R_YOKE, n=4)
    # open dish: shallow 12-gon plate tilted skyward (front/back faces)
    tilt = np.radians(28)
    ctr = np.array([0, 0.22, -0.42])
    normal_dir = np.array([0, np.cos(tilt), -np.sin(tilt)])
    # build the plate in its own plane
    u = np.array([1.0, 0, 0])
    v = np.cross(normal_dir, u)
    ring = [tuple(ctr + F.DISH_R * (np.cos(t) * u + np.sin(t) * v))
            for t in np.linspace(0, 2 * np.pi, 13)[:-1]]
    zf = Zone(F.R_DISH.rect, ('x', 'y'), ((-F.DISH_R, F.DISH_R), (0.97, -0.53)))
    zb = Zone(F.R_DISH_B.rect, ('x', 'y'), ((-F.DISH_R, F.DISH_R), (0.97, -0.53)))
    p.add_face(ring, zone=zf)
    p.add_face(ring, zone=zb, flip=True)
    # feed arm + head
    tip = tuple(ctr + normal_dir * 0.55)
    limb(p, tuple(ctr), tip, 0.035, 0.025, F.R_TRIM, n=4)
    chamfer_box(p, tip, (0.10, 0.10, 0.10), 0.015,
                {'+y': F.R_LIGHT, '-y': F.R_LIGHT, '+x': F.R_LIGHT,
                 '-x': F.R_LIGHT, '+z': F.R_LIGHT, '-z': F.R_LIGHT})
    return p


def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    T = 8.0
    keys = [(T * i / 4, qy(90.0 * i)) for i in range(5)]
    return [{'name': 'idle', 'channels': [('dish', 'rotation', keys)]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='dish', parent=0, offset=F.DISH_OFF, part=build_dish()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=build_clips(), normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=build_clips(), normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
