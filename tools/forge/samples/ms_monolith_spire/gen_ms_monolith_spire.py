"""gen_ms_monolith_spire — assemble ms_monolith_spire and export .gltf/.bin.

Ancient-tech landmark spire, 20 m: scorched base apron, five tapering
monolithic slab segments with slight wrong-angle offsets, 4-gon spike
tip, and a floating offset octagonal ring collar (`ring` piece — very
slow seamless idle rotation about Y). No team colour.
Run: python3 gen_ms_monolith_spire.py -> out/ms_monolith_spire{,_png}.gltf
"""
import numpy as np

import ms_monolith_spire_layout as F   # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, chamfer_box, limb, ngon_ring
from gltf_export import export

STEM = 'ms_monolith_spire'
OUT = 'out'


def build_body():
    p = Part('body')

    # scorched base apron (monolithic slab, big chamfer)
    x, y, z, w, h, d = F.APRON
    chamfer_box(p, (x, y, z), (w, h, d), 0.12,
                {'+y': F.R_APRON, '+x': F.R_APRON_S, '-x': F.R_APRON_S,
                 '+z': F.R_APRON_SZ, '-z': F.R_APRON_SZ}, skip=('-y',))

    # five tapering slab segments, seamless, slight alternating offsets
    for cx, cz, y0, y1, w in F.SEGS:
        cy = (y0 + y1) / 2
        h = y1 - y0
        chamfer_box(p, (cx, cy, cz), (w, h, w), 0.07,
                    {'+x': F.R_SEG_X, '-x': F.R_SEG_X,
                     '+z': F.R_SEG_Z, '-z': F.R_SEG_Z,
                     '+y': F.R_SHELF}, skip=('-y',))

    # 4-gon spike tip
    limb(p, (F.SEGS[-1][0], F.TIP_BASE, F.SEGS[-1][1]),
         (0.0, F.TIP_TOP, 0.0), F.TIP_R, 0.04, F.R_TIP, n=4)
    return p


def build_ring():
    """Floating offset octagonal ring collar; piece pivot on the spire axis."""
    p = Part('ring')
    ox, oy, oz = F.RING_OFF
    verts = ngon_ring((ox, oy, oz), F.RING_R, 8, 'y')
    n = len(verts)
    for i in range(n):
        a = tuple(verts[i])
        b = tuple(verts[(i + 1) % n])
        limb(p, a, b, F.RING_BAR, F.RING_BAR, F.R_RING, n=6)
    # four emitter studs on alternating ring vertices (emissive cyan caps)
    for i in range(0, n, 2):
        v = np.asarray(verts[i], dtype=float)
        ctr = np.array([ox, oy, oz])
        outw = v - ctr
        outw[1] = 0.0
        outw /= np.linalg.norm(outw)
        chamfer_box(p, tuple(v + outw * 0.22), (0.30, 0.30, 0.30), 0.04,
                    {k: F.R_STUD_Z
                     for k in ('+y', '-y', '+x', '-x', '+z', '-z')})
    return p


def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    # VERY slow idle: 90 s per revolution, seamless quaternion loop
    T = 90.0
    keys = [(T * i / 4, qy(90.0 * i)) for i in range(5)]
    return [{'name': 'idle', 'channels': [('ring', 'rotation', keys)]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='ring', parent=0, offset=F.RING_PIVOT, part=build_ring()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=build_clips(), normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=build_clips(), normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
