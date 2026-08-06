"""gen_ms_lighthouse — assemble ms_lighthouse and export .gltf/.bin.

Coastal lighthouse (~22 m): rock plinth, keeper hut, tapered octagonal
masonry tower (three stacked limb bands so the stripe gets its own atlas
cell), gallery drum + prefab railing, glazed lamp room, roof cone, red aux
beacon, prefab ladder up the -X face. `light` is the animated piece — the
rotating lamp assembly, very slow seamless Y loop (idle clip).
Run: python3 gen_ms_lighthouse.py → out/ms_lighthouse{,_png}.gltf + .bin
"""
import numpy as np

import ms_lighthouse_layout as F   # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, chamfer_box, limb
from gltf_export import export
import parts as P

STEM = 'ms_lighthouse'
OUT = 'out'
ALL = ('+y', '-y', '+x', '-x', '+z', '-z')


def build_body():
    p = Part('body')

    # rock plinth: two stacked weather-rounded blocks
    for (x, y, z, w, h, d), ch in ((F.ROCK_LO, 0.22), (F.ROCK_HI, 0.18)):
        chamfer_box(p, (x, y, z), (w, h, d), ch,
                    {'+y': F.R_ROCK_T, '+z': F.R_ROCK_S, '-z': F.R_ROCK_S,
                     '+x': F.R_ROCK_S2, '-x': F.R_ROCK_S2}, skip=('-y',))

    # keeper hut + roof slab (door on -Z face)
    x, y, z, w, h, d = F.HUT
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+x': F.R_HUT_S, '-x': F.R_HUT_S, '+z': F.R_HUT_F,
                 '-z': F.R_HUT_F}, skip=('-y', '+y'))
    x, y, z, w, h, d = F.HUT_ROOF
    P.box6(p, (x, y, z), (w, h, d), F.R_HUT_T, ch=0.04, skip=('-y',))

    # tapered tower: three stacked octagonal bands (stripe band = own cell)
    ys = (F.TOW_BASE_Y, F.TOW_MID0_Y, F.TOW_MID1_Y, F.TOW_TOP_Y)
    rects = (F.R_TOW_LO, F.R_TOW_MID, F.R_TOW_UP)
    for i in range(3):
        limb(p, (0, ys[i], 0), (0, ys[i + 1], 0),
             F.TOW_R[ys[i]], F.TOW_R[ys[i + 1]], rects[i], n=8)

    # gallery drum (underside dark, walkable top)
    limb(p, (0, F.GALL_Y0, 0), (0, F.GALL_Y1, 0), F.GALL_R, F.GALL_R,
         F.R_GALL, n=8, cap_start=F.R_DARK, cap_end=F.R_GALL_T)

    # gallery railing: octagon of prefab rail segments
    corners = [(F.RAIL_R * np.cos(a), F.GALL_Y1, F.RAIL_R * np.sin(a))
               for a in np.pi / 8 + np.linspace(0, 2 * np.pi, 9)[:-1]]
    for i in range(8):
        P.railing(p, corners[i], corners[(i + 1) % 8], h=F.RAIL_H,
                  post_step=2.0, r=0.035, zone=F.R_TRIMR)

    # lamp room glazing + roof cone + finial mast
    limb(p, (0, F.GLASS_Y0, 0), (0, F.GLASS_Y1, 0), 1.05, 0.98,
         F.R_GLASS, n=8)
    limb(p, (0, F.ROOF_Y0, 0), (0, F.ROOF_Y1, 0), 1.18, 0.10,
         F.R_ROOF, n=8, cap_start=F.R_DARK)
    limb(p, (0, F.ROOF_Y1, 0), (0, F.BEACON_Y - 0.08, 0), 0.05, 0.04,
         F.R_TRIMR, n=4)

    # red aux beacon at the very tip (emissive zone)
    P.beacon(p, (0, F.BEACON_Y, 0), size=0.20, glow_zone=F.R_RED)

    # prefab ladder up the -X face, following the taper
    P.ladder(p, F.LADDER_BASE, F.LADDER_TOP, width=0.5, rung_step=1.0,
             zone=F.R_TRIMR)

    # door step at the hut entrance
    P.box6(p, (F.HUT[0], F.PLINTH_Y + 0.09, F.HUT[2] - F.HUT[5] / 2 - 0.25),
           (1.2, 0.18, 0.5), F.R_ROCK_S, ch=0.03, skip=('-y',))
    return p


def build_light():
    """Rotating lamp assembly, piece-local about the lamp-room centre."""
    p = Part('light')
    P.box6(p, (0, 0.05, 0), (0.62, 0.85, 0.62), F.R_HOUS, ch=0.05)
    for s in (1.0, -1.0):
        chamfer_box(p, (0, 0.08, s * 0.40), (0.52, 0.58, 0.16), 0.03,
                    {k: F.R_LENS for k in ALL})
    return p


def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    T = 24.0   # very slow continuous sweep; seamless quaternion loop
    keys = [(T * i / 4, qy(90.0 * i)) for i in range(5)]
    return [{'name': 'idle', 'channels': [('light', 'rotation', keys)]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='light', parent=0, offset=F.LIGHT_OFF, part=build_light()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=build_clips(), normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=build_clips(), normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
