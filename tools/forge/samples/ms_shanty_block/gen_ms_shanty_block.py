"""gen_ms_shanty_block — assemble ms_shanty_block and export .gltf/.bin.

Civilian shanty block (16x16 m): eight stacked corrugated shacks with
offset footprints and overhanging roof slabs, external stairs with a
landing + railing, two ladders, water drums, three stove-pipe chimneys,
and a laundry line (`line` piece: wire + hanging cloth, idle sway clip).
Run: python3 gen_ms_shanty_block.py -> out/ms_shanty_block{,_png}.gltf
"""
import numpy as np

import ms_shanty_block_layout as F      # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, chamfer_box, limb
from gltf_export import export
import parts as P

STEM = 'ms_shanty_block'
OUT = 'out'


def wall_zones(cy):
    """Pick the storey wall-zone pair by shack centre height."""
    if cy < 2.4:
        return F.C_W1X, F.C_W1Z
    if cy < 4.9:
        return F.C_W2X, F.C_W2Z
    return F.C_W3X, F.C_W3Z


def build_body():
    p = Part('body')

    # packed-earth base slab
    x, y, z, w, h, d = F.PAD
    chamfer_box(p, (x, y, z), (w, h, d), 0.04,
                {'+y': F.C_PAD, '+x': F.C_DARK, '-x': F.C_DARK,
                 '+z': F.C_DARK, '-z': F.C_DARK}, skip=('-y',))

    # shacks + overhanging roof slabs
    for shack in F.SHACKS_1 + F.SHACKS_2 + F.SHACKS_3:
        cx, cy, cz, w, h, d = shack
        zx, zz = wall_zones(cy)
        chamfer_box(p, (cx, cy, cz), (w, h, d), 0.05,
                    {'+x': zx, '-x': zx, '+z': zz, '-z': zz,
                     '+y': F.C_ROOF}, skip=('-y',))
        top = cy + h / 2
        chamfer_box(p, (cx, top + F.ROOF_T / 2, cz),
                    (w + F.ROOF_LIP, F.ROOF_T, d + F.ROOF_LIP), 0.02,
                    {'+x': zx, '-x': zx, '+z': zz, '-z': zz,
                     '+y': F.C_ROOF, '-y': F.C_ROOF})

    # external stairs (west face of A) + landing + railing
    P.stairs(p, F.STAIR_BASE, F.STAIR_TOP, width=F.STAIR_W,
             tread_zone=F.C_TREAD, side_zone=F.C_SIDE)
    lx, ly, lz, lw, lh, ld = F.LANDING
    chamfer_box(p, (lx, ly, lz), (lw, lh, ld), 0.02,
                {'+y': F.C_TREAD, '-y': F.C_TREAD, '+x': F.C_SIDE,
                 '-x': F.C_SIDE, '+z': F.C_SIDE, '-z': F.C_SIDE})
    P.railing(p, F.RAIL_A, F.RAIL_B, h=0.95, post_step=1.2, zone=F.C_MAST)

    # ladders
    P.ladder(p, *F.LAD1, zone=F.C_MAST)
    P.ladder(p, *F.LAD2, zone=F.C_MAST)

    # water drums in the yard gap
    P.drum_row(p, F.DRUM_ORIGIN, count=F.DRUM_N, r=F.DRUM_R, h=F.DRUM_H,
               zone=F.C_DRUM)

    # stove-pipe chimneys (slight kink + rain cap)
    for (cx, by, cz, ty) in F.CHIMNEYS:
        limb(p, (cx, by, cz), (cx, ty - 0.25, cz), F.CHIM_R, F.CHIM_R * 0.9,
             F.C_MAST, n=4)
        limb(p, (cx, ty - 0.25, cz), (cx + 0.12, ty, cz), F.CHIM_R * 0.9,
             F.CHIM_R * 0.8, F.C_MAST, n=4)
        chamfer_box(p, (cx + 0.12, ty + 0.03, cz), (0.26, 0.05, 0.26), 0.01,
                    {'+y': F.C_DARK, '-y': F.C_DARK, '+x': F.C_DARK,
                     '-x': F.C_DARK, '+z': F.C_DARK, '-z': F.C_DARK})

    # laundry poles (wire + cloth live on the `line` piece)
    for (px, pz) in (F.POLE1, F.POLE2):
        limb(p, (px, F.PAD_TOP, pz), (px, F.PAD_TOP + F.POLE_H + 0.05, pz),
             0.045, 0.035, F.C_MAST, n=4, cap_end=F.C_DARK)
    return p


def build_line():
    """Laundry line: sagging wire + hanging cloth, LOCAL origin at pole1
    top; wire runs local +X to (LINE_SPAN,0,0) so an x-axis sway rotation
    keeps both wire ends pinned to the poles."""
    p = Part('line')
    s = F.LINE_SPAN
    mid = (s / 2, -F.LINE_SAG, 0.0)
    limb(p, (0, 0, 0), mid, 0.016, 0.016, F.C_MAST, n=3)
    limb(p, mid, (s, 0, 0), 0.016, 0.016, F.C_MAST, n=3)
    zf = F.C_CLOTH
    for cx, cw, chh in zip(F.CLOTH_XS, F.CLOTH_W, F.CLOTH_H):
        t = cx / s
        sag = -4 * F.LINE_SAG * t * (1 - t)       # parabolic wire drop
        x0, x1 = cx - cw / 2, cx + cw / 2
        zoff = 0.015
        quad = [(x0, sag - 0.01, zoff), (x1, sag - 0.01, zoff),
                (x1, sag - 0.01 - chh, zoff), (x0, sag - 0.01 - chh, zoff)]
        p.add_face(quad, zone=zf)
        p.add_face(quad, zone=zf, flip=True)
    return p


def qx(deg):
    r = np.radians(deg) / 2
    return (float(np.sin(r)), 0.0, 0.0, float(np.cos(r)))


def build_clips():
    """Subtle idle sway on the laundry line: small x-axis rotation swings
    the cloth in z; wire endpoints sit on the rotation axis. Seamless."""
    T = 4.2
    angs = [0.0, 1.6, 2.6, 1.2, 0.0, -1.5, -2.4, -1.0, 0.0]
    n = len(angs)
    rot = [(T * i / (n - 1), qx(a)) for i, a in enumerate(angs)]
    return [{'name': 'idle', 'channels': [('line', 'rotation', rot)]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='line', parent=0, offset=F.LINE_OFF, part=build_line()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_shanty_block] total tris: {total}')
