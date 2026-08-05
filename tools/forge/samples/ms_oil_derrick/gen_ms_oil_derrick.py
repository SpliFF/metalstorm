"""gen_ms_oil_derrick — assemble ms_oil_derrick and export .gltf/.bin.

Named resource site (spec: 18 m lattice oil derrick + nodding-donkey pump,
wellhead manifold, doghouse shed, oil-stained ground plate, <=1500 tris).
Two pieces: static `body` and the pivoting walking `beam` (idle nod clip,
+/-6 deg about local +X over 6 s — the horsehead at -Z rises and falls).
Run: python3 gen_ms_oil_derrick.py  -> out/ms_oil_derrick{,_png}.gltf + .bin
"""
import numpy as np

import ms_oil_derrick_layout as F      # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, chamfer_box, limb
from gltf_export import export

STEM = 'ms_oil_derrick'
OUT = 'out'


def box(p, center, size, zone, ch=0.04, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def dhalf(y):
    """Derrick half-width at height y (legs splay base -> top)."""
    t = (y - F.PLATE_TOP) / (F.TOP_Y - F.PLATE_TOP)
    return F.BASE_H + (F.TOP_H - F.BASE_H) * t


def build_derrick(p):
    cx, cz = F.DERRICK_C
    h0, h1 = dhalf(F.PLATE_TOP), dhalf(F.TOP_Y)
    # 4 splayed corner legs
    for sx in (-1, 1):
        for sz in (-1, 1):
            limb(p, (cx + sx * h0, F.PLATE_TOP, cz + sz * h0),
                 (cx + sx * h1, F.TOP_Y, cz + sz * h1),
                 F.LEG_R0, F.LEG_R1, F.R_LATTICE, n=4)
    # horizontal girt rings
    for gy in F.GIRT_YS:
        h = dhalf(gy)
        corners = [(cx - h, gy, cz - h), (cx + h, gy, cz - h),
                   (cx + h, gy, cz + h), (cx - h, gy, cz + h)]
        for i in range(4):
            limb(p, corners[i], corners[(i + 1) % 4],
                 F.GIRT_R, F.GIRT_R, F.R_LATTICE, n=4)
    # X-braces on all 4 faces of every bay
    levels = [F.PLATE_TOP + 0.05] + list(F.GIRT_YS) + [F.TOP_Y]
    for y0, y1 in zip(levels[:-1], levels[1:]):
        ha, hb = dhalf(y0), dhalf(y1)
        for ax, s in (('x', 1), ('x', -1), ('z', 1), ('z', -1)):
            def corner(y, h, side):
                if ax == 'z':
                    return (cx + side * h, y, cz + s * h)
                return (cx + s * h, y, cz + side * h)
            for d in (1, -1):
                limb(p, corner(y0, ha, d), corner(y1, hb, -d),
                     F.BRACE_R, F.BRACE_R, F.R_LATTICE, n=4)
    # crown platform + sheave housing (tops out at 18.0 m)
    x, y, z, w, h, d = F.CROWN
    chamfer_box(p, (x, y, z), (w, h, d), 0.04,
                {'+y': F.R_CROWN_T, '-y': F.R_CROWN_T, '+x': F.R_CROWN_S,
                 '-x': F.R_CROWN_S, '+z': F.R_CROWN_F, '-z': F.R_CROWN_F})
    box(p, F.SHEAVE[:3], F.SHEAVE[3:], F.R_STEELG, ch=0.03)


def build_wellhead(p):
    wx, wz = F.WELL_X, F.WELL_Z
    # flange / body / flange stack + stuffing box
    limb(p, (wx, F.PLATE_TOP, wz), (wx, 0.44, wz), 0.30, 0.30, F.R_WELL,
         n=6, cap_end=F.R_DARK)
    limb(p, (wx, 0.44, wz), (wx, 1.15, wz), 0.17, 0.17, F.R_WELL, n=6)
    limb(p, (wx, 1.15, wz), (wx, 1.28, wz), 0.26, 0.26, F.R_WELL,
         n=6, cap_end=F.R_DARK)
    limb(p, (wx, 1.28, wz), (wx, 1.52, wz), 0.10, 0.08, F.R_TRIM,
         n=4, cap_end=F.R_DARK)
    # flow line to the manifold header
    limb(p, (wx + 0.1, 0.85, wz), (F.HEADER_X, 0.85, wz), 0.09, 0.09,
         F.R_PIPE, n=6)
    limb(p, (F.HEADER_X, 0.85, wz - 0.75), (F.HEADER_X, 0.85, wz + 0.75),
         0.09, 0.09, F.R_PIPE, n=6, cap_start=F.R_DARK, cap_end=F.R_DARK)
    # valve risers + handwheels
    for rz in F.RISER_ZS:
        limb(p, (F.HEADER_X, 0.85, rz), (F.HEADER_X, 1.32, rz),
             0.07, 0.07, F.R_PIPE, n=4)
        limb(p, (F.HEADER_X, 1.32, rz), (F.HEADER_X, 1.40, rz),
             0.22, 0.22, F.R_TRIM, n=6, cap_start=F.R_DARK, cap_end=F.R_VALVE)
    # header drop leg into the plate
    limb(p, (F.HEADER_X, 0.85, wz + 0.75), (F.HEADER_X, F.PLATE_TOP, wz + 0.75),
         0.08, 0.08, F.R_PIPE, n=4)


def build_pump_base(p):
    px, pz = F.PUMP_X, F.POST_Z
    # samson post: A-frame of 4 splayed legs + cross girt + saddle
    for sx in (-1, 1):
        for sz in (-1, 1):
            limb(p, (px + sx * 0.8, F.PLATE_TOP, pz + sz * 1.0),
                 (px + sx * 0.15, F.POST_TOP, pz + sz * 0.12),
                 0.09, 0.07, F.R_POST, n=4)
    limb(p, (px - 0.6, 1.5, pz - 0.72), (px - 0.6, 1.5, pz + 0.72),
         0.05, 0.05, F.R_POST, n=4)
    limb(p, (px + 0.6, 1.5, pz - 0.72), (px + 0.6, 1.5, pz + 0.72),
         0.05, 0.05, F.R_POST, n=4)
    box(p, (px, F.POST_TOP + 0.08, pz), (0.5, 0.25, 0.6), F.R_STEELG, ch=0.03)
    # gear skid, gearbox, motor
    box(p, F.GEAR_SKID[:3], F.GEAR_SKID[3:], F.R_STEELG, ch=0.03)
    box(p, F.GEARBOX[:3], F.GEARBOX[3:], F.R_GEAR, ch=0.05)
    box(p, F.MOTOR[:3], F.MOTOR[3:], F.R_STEELG, ch=0.04)


def build_doghouse(p):
    x, y, z, w, h, d = F.DOG
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+y': F.R_DOG_R, '+x': F.R_DOG_S, '-x': F.R_DOG_S,
                 '+z': F.R_DOG_F, '-z': F.R_DOG_F}, skip=('-y',))
    x, y, z, w, h, d = F.DOG_ROOF
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': F.R_DOG_R, '-y': F.R_DOG_R, '+x': F.R_DOG_S,
                 '-x': F.R_DOG_S, '+z': F.R_DOG_F, '-z': F.R_DOG_F})
    box(p, F.DOG_STEP[:3], F.DOG_STEP[3:], F.R_STEELG, ch=0.02)
    vx, vz = F.DOG_VENT
    limb(p, (vx, 2.9, vz), (vx, 3.5, vz), 0.07, 0.07, F.R_TRIM,
         n=4, cap_end=F.R_DARK)


def build_body():
    p = Part('body')
    # oil-stained ground plate
    x, y, z, w, h, d = F.PLATE
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+y': F.R_PLATE_T, '+x': F.R_PLATE_SX, '-x': F.R_PLATE_SX,
                 '+z': F.R_PLATE_SZ, '-z': F.R_PLATE_SZ}, skip=('-y',))
    build_derrick(p)
    build_wellhead(p)
    build_pump_base(p)
    build_doghouse(p)
    return p


def build_beam():
    p = Part('beam')
    # walking beam
    chamfer_box(p, F.BEAM_BOX[:3], F.BEAM_BOX[3:], 0.03,
                {'+x': F.R_BEAM_S, '-x': F.R_BEAM_S, '+y': F.R_BEAM_T,
                 '-y': F.R_DARK, '+z': F.R_STEELG, '-z': F.R_STEELG})
    # horsehead (front, hangs over the wellhead)
    chamfer_box(p, F.HEAD_BOX[:3], F.HEAD_BOX[3:], 0.05,
                {'+y': F.R_BEAM_T, '-y': F.R_DARK, '+x': F.R_HEAD,
                 '-x': F.R_HEAD, '+z': F.R_STEELG, '-z': F.R_STEELG})
    # tail counterweight
    chamfer_box(p, F.CWT_BOX[:3], F.CWT_BOX[3:], 0.05,
                {'+y': F.R_STEELG, '-y': F.R_DARK, '+x': F.R_CWT,
                 '-x': F.R_CWT, '+z': F.R_STEELG, '-z': F.R_STEELG})
    # saddle bearing block at the pivot
    box(p, F.BEARING[:3], F.BEARING[3:], F.R_STEELG, ch=0.03)
    return p


def qx(deg):
    r = np.radians(deg) / 2
    return (float(np.sin(r)), 0.0, 0.0, float(np.cos(r)))


def build_clips():
    T, A, N = F.NOD_PERIOD, F.NOD_AMP, 12
    keys = [(T * i / N, qx(A * np.sin(2 * np.pi * i / N)))
            for i in range(N + 1)]           # last key == first: seamless loop
    return [{'name': 'idle', 'channels': [('beam', 'rotation', keys)]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='beam', parent=0, offset=F.BEAM_OFF, part=build_beam()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=build_clips(),
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=build_clips(),
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
