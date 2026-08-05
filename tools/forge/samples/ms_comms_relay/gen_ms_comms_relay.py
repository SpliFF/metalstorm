"""gen_ms_comms_relay — assemble ms_comms_relay and export .gltf/.bin.

Comms relay mast (radar s2, STYLE.md: 6 m mast+dish): anchored equipment
pad, walk-in shelter, guyed lattice mast (three splayed legs + three guy
cables), rotating twin-dish cross-arm at the mast head — `dish` is the
animated piece (10 s sweep, idle clip) — and an amber warning beacon
(the only emissive) at the tip. Follows ms_radar_s1 one size up.
Run: python3 gen_ms_comms_relay.py → out/ms_comms_relay{,_png}.gltf + .bin
"""
import numpy as np

import ms_comms_relay_layout as F   # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, Zone, chamfer_box, limb
from gltf_export import export

STEM = 'ms_comms_relay'
OUT = 'out'

ALL_FACES = ('+y', '-y', '+x', '-x', '+z', '-z')


def build_body():
    p = Part('body')

    # anchored equipment pad
    x, y, z, w, h, d = F.PAD
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+y': F.R_PAD, '+x': F.R_PADS, '-x': F.R_PADS,
                 '+z': F.R_PADS_F, '-z': F.R_PADS_F}, skip=('-y',))

    # walk-in equipment shelter
    x, y, z, w, h, d = F.CABINET
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+x': F.R_CAB, '-x': F.R_CAB, '+z': F.R_CAB_F,
                 '-z': F.R_CAB_F, '+y': F.R_CAB_T}, skip=('-y',))

    # guyed lattice mast: centre pole + three splayed legs + cross braces
    mx, mz = F.MAST_X, F.MAST_Z
    limb(p, (mx, F.PAD_TOP, mz), (mx, F.MAST_TOP, mz), 0.11, 0.065,
         F.R_MAST, n=6)
    for a in (0.0, 2.094, 4.189):
        lx, lz = mx + F.LEG_R * np.sin(a), mz + F.LEG_R * np.cos(a)
        limb(p, (lx, F.PAD_TOP, lz), (mx, F.LEG_TOP, mz), 0.055, 0.04,
             F.R_MAST, n=4)
        limb(p, ((lx + mx) / 2, (F.PAD_TOP + F.LEG_TOP) / 2, (lz + mz) / 2),
             (mx, F.BRACE_Y, mz), 0.032, 0.032, F.R_TRIM, n=4)

    # three guy cables, interleaved between the legs, collar → pad anchors
    for a in (1.047, 3.142, 5.236):
        gx = min(max(mx + F.GUY_R * np.sin(a), -2.3), 2.3)
        gz = min(max(mz + F.GUY_R * np.cos(a), -2.3), 2.3)
        limb(p, (gx, F.PAD_TOP + 0.02, gz), (mx, F.GUY_Y, mz),
             0.018, 0.018, F.R_GUY, n=3)

    # cable run shelter → mast base
    limb(p, (F.CABINET[0] - 0.4, F.PAD_TOP + 0.45, F.CABINET[2] + 0.4),
         (mx, F.PAD_TOP + 0.28, mz), 0.06, 0.06, F.R_TRIM, n=4)

    # amber aircraft-warning beacon at the mast tip (emissive)
    chamfer_box(p, (mx, F.BEACON_Y, mz), (0.24, 0.24, 0.24), 0.03,
                {k: F.R_LIGHT for k in ALL_FACES})
    return p


def build_dish():
    p = Part('dish')
    # bearing sleeve around the mast head
    limb(p, (0, -0.08, 0), (0, 0.40, 0), 0.15, 0.13, F.R_YOKE, n=6)
    # cross-arm carrying the twin link dishes
    limb(p, (-F.ARM_HALF, 0.22, 0), (F.ARM_HALF, 0.22, 0), 0.055, 0.055,
         F.R_YOKE, n=4, cap_start=F.R_DARK, cap_end=F.R_DARK)
    # twin dishes: 12-gon plates facing ±X, tilted 8° skyward (front/back)
    tilt = np.radians(8)
    u = np.array([0.0, 0.0, 1.0])
    for s in (1.0, -1.0):
        ctr = np.array([s * F.ARM_HALF, 0.22, 0.0])
        nd = np.array([s * np.cos(tilt), np.sin(tilt), 0.0])
        v = np.cross(nd, u)
        ring = [tuple(ctr + F.DISH_R * (np.cos(t) * u + np.sin(t) * v))
                for t in np.linspace(0, 2 * np.pi, 13)[:-1]]
        p.add_face(ring, zone=F.R_DISH)
        p.add_face(ring, zone=F.R_DISH_B, flip=True)
        # feed arm + head
        tip = ctr + nd * 0.50
        limb(p, tuple(ctr), tuple(tip), 0.035, 0.024, F.R_TRIM, n=4)
        chamfer_box(p, tuple(tip), (0.10, 0.10, 0.10), 0.014,
                    {k: F.R_DARK for k in ALL_FACES})
    return p


def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    T = 10.0
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
