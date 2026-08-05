"""gen_ms_watchtower — assemble ms_watchtower and export .gltf/.bin.

Staging-post kit: 10 m guard watchtower (STYLE.md building doctrine —
texture-led, everything on `body` except the searchlight): anchored pad,
four splayed legs with ring + X lattice bracing, steel floor slab,
enclosed cab with window band, overhanging roof, side ladder, antenna
whip, and a roof-corner searchlight — `light` is the animated piece
(12 s idle yaw sweep ±55°, emissive lens).
Run: python3 gen_ms_watchtower.py → out/ms_watchtower{,_png}.gltf + .bin
"""
import numpy as np

import ms_watchtower_layout as F     # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, Zone, chamfer_box, ngon_ring, limb, tube
from gltf_export import export

STEM = 'ms_watchtower'
OUT = 'out'


def build_body():
    p = Part('body')

    # anchored pad
    x, y, z, w, h, d = F.PAD
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+y': F.R_PAD, '+x': F.R_PADS, '-x': F.R_PADS,
                 '+z': F.R_PADS_F, '-z': F.R_PADS_F}, skip=('-y',))

    # four splayed legs
    for sx in (-1, 1):
        for sz in (-1, 1):
            limb(p, (sx * F.LEG_BASE, F.PAD_TOP, sz * F.LEG_BASE),
                 (sx * F.LEG_TOP, F.LEG_TOP_Y, sz * F.LEG_TOP),
                 0.11, 0.085, F.R_LEG, n=4)

    # horizontal ring braces at two levels
    for by in (F.BRACE_Y0, F.BRACE_Y1):
        hb = F._half_at(by)
        corners = [(-hb, by, -hb), (hb, by, -hb), (hb, by, hb), (-hb, by, hb)]
        for i in range(4):
            limb(p, corners[i], corners[(i + 1) % 4], 0.05, 0.05, F.R_TRIM, n=4)

    # X lattice braces on all four faces, two bands
    for (y0, y1) in ((F.PAD_TOP, F.BRACE_Y0), (F.BRACE_Y0, F.BRACE_Y1)):
        h0, h1 = F._half_at(y0), F._half_at(y1)
        for face in range(4):
            # face corner pairs: ±x faces and ±z faces
            if face == 0:    # -z
                a0, b0 = (-h0, y0, -h0), (h0, y0, -h0)
                a1, b1 = (-h1, y1, -h1), (h1, y1, -h1)
            elif face == 1:  # +z
                a0, b0 = (-h0, y0, h0), (h0, y0, h0)
                a1, b1 = (-h1, y1, h1), (h1, y1, h1)
            elif face == 2:  # -x
                a0, b0 = (-h0, y0, -h0), (-h0, y0, h0)
                a1, b1 = (-h1, y1, -h1), (-h1, y1, h1)
            else:            # +x
                a0, b0 = (h0, y0, -h0), (h0, y0, h0)
                a1, b1 = (h1, y1, -h1), (h1, y1, h1)
            limb(p, a0, b1, 0.04, 0.04, F.R_TRIM, n=4)
            limb(p, b0, a1, 0.04, 0.04, F.R_TRIM, n=4)

    # floor slab (ledge visible around the cab base)
    x, y, z, w, h, d = F.FLOOR
    chamfer_box(p, (x, y, z), (w, h, d), 0.04,
                {'+x': F.R_FLOOR_E, '-x': F.R_FLOOR_E, '+z': F.R_FLOOR_EF,
                 '-z': F.R_FLOOR_EF, '+y': F.R_FLOOR_T, '-y': F.R_DARK})

    # enclosed cab (top under the roof, bottom flush on the slab)
    x, y, z, w, h, d = F.CAB
    chamfer_box(p, (x, y, z), (w, h, d), 0.04,
                {'+x': F.R_CAB, '-x': F.R_CAB, '+z': F.R_CAB_F,
                 '-z': F.R_CAB_F}, skip=('+y', '-y'))

    # overhanging roof slab
    x, y, z, w, h, d = F.ROOF
    chamfer_box(p, (x, y, z), (w, h, d), 0.04,
                {'+y': F.R_CAB_T, '-y': F.R_DARK, '+x': F.R_ROOF_E,
                 '-x': F.R_ROOF_E, '+z': F.R_ROOF_EF, '-z': F.R_ROOF_EF})

    # ladder up the -Z face (rails + rungs, colossus vocabulary)
    for sx in (-1, 1):
        limb(p, (sx * F.LADDER_X, F.PAD_TOP, F.LADDER_Z),
             (sx * F.LADDER_X, 7.34, F.LADDER_Z), 0.035, 0.035, F.R_TRIM, n=4)
    for ry in np.linspace(0.9, 6.66, 10):
        limb(p, (-F.LADDER_X, ry, F.LADDER_Z),
             (F.LADDER_X, ry, F.LADDER_Z), 0.025, 0.025, F.R_TRIM, n=4)

    # antenna whip on the rear roof corner (tip = the 10 m mark)
    limb(p, (F.ANT_X, 9.30, F.ANT_Z), (F.ANT_X, F.ANT_TOP, F.ANT_Z),
         0.028, 0.014, F.R_TRIM, n=4)
    return p


def build_light():
    """Searchlight, light-local frame: pivot post at the origin, drum on a
    U-yoke aimed -Z with a slight baked-in downward tilt (rest rotation
    stays identity so the yaw sweep pivots cleanly)."""
    p = Part('light')
    # pivot post
    limb(p, (0, 0, 0), (0, 0.30, 0), 0.07, 0.06, F.R_TRIM, n=6)
    # U-yoke arms up to the drum trunnions
    for sx in (-1, 1):
        limb(p, (0, 0.28, 0.0), (sx * 0.20, F.DRUM_Y, 0.02),
             0.045, 0.035, F.R_TRIM, n=4)
    # drum: octagonal tube along Z, nose drooped for a downward beam;
    # front cap = emissive lens, rear cap = louvred back
    tube(p, [(0.26, F.DRUM_R * 0.82, F.DRUM_Y + 0.00),
             (0.20, F.DRUM_R, F.DRUM_Y + 0.01),
             (-0.20, F.DRUM_R, F.DRUM_Y - 0.02),
             (-0.26, F.DRUM_R * 0.82, F.DRUM_Y - 0.03)],
         F.R_HOUS, n=8, cap_start=F.R_DRUM_B, cap_end=F.R_LENS)
    return p


def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    """12 s guard sweep: yaw -55° → +55° → -55°, sine-eased via dense
    keys, seamless loop (last key repeats the first)."""
    T = 12.0
    keys = []
    for i in range(9):
        t = T * i / 8
        ang = -55.0 * np.cos(2 * np.pi * t / T)
        keys.append((t, qy(ang)))
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
