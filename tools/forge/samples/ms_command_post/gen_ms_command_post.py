"""gen_ms_command_post — assemble ms_command_post and export .gltf/.bin.

Prefab command post (staging-post kit, 12x8 m footprint): concrete pad,
prefab hall with lit doorway + window band, rooftop command module with
antenna cluster (lattice mast, two whips, array panel, beacon), sandbag
skirt with a door gap, genset, and a ground-mounted flag pole. `flag`
is the only animated piece — idle wave clip via small rotation/scale
keys on the cloth node.
Run: python3 gen_ms_command_post.py -> out/ms_command_post{,_png}.gltf + .bin
"""
import numpy as np

import ms_command_post_layout as F      # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, Zone, chamfer_box, ngon_ring, limb
from gltf_export import export

STEM = 'ms_command_post'
OUT = 'out'


def box(p, center, size, zones, ch=0.04, skip=('-y',)):
    chamfer_box(p, center, size, ch, zones, skip=skip)


def zbox(rect, center, size, m=0.06):
    """Anchored 6-face zone dict for a prop box: every face projects the
    whole box (+margin) onto one shared atlas rect, so props at any world
    position stay inside their cell (garrison's origin-anchored prop
    zones bleed for off-origin props — anchor per-prop instead)."""
    cx, cy, cz = center
    hx, hy, hz = size[0] / 2 + m, size[1] / 2 + m, size[2] / 2 + m
    return {
        '+x': Zone(rect, ('z', 'y'), ((cz - hz, cz + hz), (cy + hy, cy - hy))),
        '-x': Zone(rect, ('z', 'y'), ((cz - hz, cz + hz), (cy + hy, cy - hy))),
        '+z': Zone(rect, ('x', 'y'), ((cx - hx, cx + hx), (cy + hy, cy - hy))),
        '-z': Zone(rect, ('x', 'y'), ((cx - hx, cx + hx), (cy + hy, cy - hy))),
        '+y': Zone(rect, ('x', 'z'), ((cx - hx, cx + hx), (cz - hz, cz + hz))),
        '-y': Zone(rect, ('x', 'z'), ((cx - hx, cx + hx), (cz - hz, cz + hz))),
    }


def build_body():
    p = Part('body')

    # concrete pad
    x, y, z, w, h, d = F.PAD
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+y': F.C_PAD, '+x': F.C_PADS_Z, '-x': F.C_PADS_Z,
                 '+z': F.C_PADS, '-z': F.C_PADS}, skip=('-y',))

    # main prefab hall
    x, y, z, w, h, d = F.HALL
    chamfer_box(p, (x, y, z), (w, h, d), 0.08,
                {'+x': F.C_WALL_S, '-x': F.C_WALL_S, '-z': F.C_WALL_F,
                 '+z': F.C_WALL_R, '+y': F.C_ROOF}, skip=('-y',))

    # rooftop command module
    x, y, z, w, h, d = F.UP
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+x': F.C_UP_S, '-x': F.C_UP_S, '-z': F.C_UP_F,
                 '+z': F.C_UP_F, '+y': F.C_UP_R}, skip=('-y',))

    # door canopy (rear face flush against the front wall)
    x, y, z, w, h, d = F.CANOPY
    chamfer_box(p, (x, y, z), (w, h, d), 0.02,
                {'+y': F.C_CANOPY, '-y': F.C_CANOPY, '-z': F.C_CANOPY,
                 '+x': F.C_CANOPY, '-x': F.C_CANOPY}, skip=('+z',))

    # sandbag skirt (large chamfer -> soft bag-berm read)
    for (cx, cz, w, d) in F.SAND_SEGS:
        box(p, (cx, F.PAD_TOP + F.SAND_H / 2, cz), (w, F.SAND_H, d),
            {'+x': F.C_SAND_Z, '-x': F.C_SAND_Z, '+z': F.C_SAND,
             '-z': F.C_SAND, '+y': F.C_SAND_T}, ch=0.16)
    for (cx, cz) in F.SAND_POSTS:
        box(p, (cx, F.PAD_TOP + F.POST_SZ[1] / 2, cz), F.POST_SZ,
            {'+x': F.C_SAND_Z, '-x': F.C_SAND_Z, '+z': F.C_SAND,
             '-z': F.C_SAND, '+y': F.C_SAND_T}, ch=0.14)

    # flag pole + crossarm nub (cloth is the separate `flag` piece)
    limb(p, (F.FLAG_X, F.PAD_TOP, F.FLAG_Z), (F.FLAG_X, F.POLE_TOP, F.FLAG_Z),
         0.055, 0.035, F.C_MAST, n=6, cap_end=F.C_DARK)
    limb(p, (F.FLAG_X, F.POLE_TOP - 0.28, F.FLAG_Z),
         (F.FLAG_X + 0.22, F.POLE_TOP - 0.28, F.FLAG_Z), 0.022, 0.02,
         F.C_MAST, n=4)

    # antenna cluster on the command-module roof
    mx, mz = F.MAST_X, F.MAST_Z
    limb(p, (mx, F.UP_TOP, mz), (mx, F.MAST_TOP, mz), 0.07, 0.04,
         F.C_MAST, n=6)
    for a in (0.6, 2.7, 4.8):                     # three stay braces
        bx, bz = mx + 0.45 * np.sin(a), mz + 0.45 * np.cos(a)
        limb(p, (bx, F.UP_TOP, bz), (mx, F.UP_TOP + 1.5, mz), 0.022, 0.02,
             F.C_MAST, n=4)
    limb(p, (mx - 0.5, F.MAST_TOP - 0.5, mz), (mx + 0.5, F.MAST_TOP - 0.5, mz),
         0.025, 0.025, F.C_MAST, n=4)             # crossarm
    for (wx, wz, tip) in (F.WHIP1, F.WHIP2):      # whip antennas
        limb(p, (wx, F.UP_TOP, wz), (wx, tip, wz), 0.03, 0.012,
             F.C_MAST, n=4, cap_end=F.C_DARK)
    # tilted array panel on the mast, facing the door side (-z)
    px, py, pz = F.PANEL_C
    tilt = np.radians(18)
    ctr = np.array([px, py, pz - 0.10])
    nrm = np.array([0, np.sin(tilt), -np.cos(tilt)])
    u = np.array([1.0, 0, 0])
    v = np.cross(nrm, u)
    hw, hh = 0.42, 0.28
    quad = [tuple(ctr + u * -hw + v * -hh), tuple(ctr + u * hw + v * -hh),
            tuple(ctr + u * hw + v * hh), tuple(ctr + u * -hw + v * hh)]
    zp = Zone(F.C_PANEL, ('x', 'y'), ((px - hw, px + hw), (py + hh, py - hh)))
    p.add_face(quad, zone=zp)
    p.add_face(quad, zone=zp, flip=True)
    limb(p, (px, py - 0.28, pz), tuple(ctr - nrm * 0.02), 0.02, 0.02,
         F.C_MAST, n=4)
    # beacon at the mast tip
    bx, by, bz = F.BEACON
    box(p, (bx, by, bz), (0.14, 0.14, 0.14), zbox(F.C_LIGHT, (bx, by, bz),
        (0.14, 0.14, 0.14)), ch=0.02, skip=())

    # genset (outside the ring, rear-left) + exhaust stub + cable run
    gx, gy, gz, gw, gh, gd = F.GEN
    box(p, (gx, gy, gz), (gw, gh, gd), zbox(F.C_PROP, (gx, gy, gz),
        (gw, gh, gd)), ch=0.05)
    limb(p, (gx + 0.45, gy + gh / 2, gz + 0.3),
         (gx + 0.45, gy + gh / 2 + 0.5, gz + 0.3), 0.05, 0.045, F.C_MAST, n=4,
         cap_end=F.C_DARK)
    limb(p, (gx + gw / 2, 0.32, gz), (-4.35, 0.30, gz),
         0.035, 0.035, F.C_MAST, n=4)

    # comms cabinet + AC unit on the hall roof (functional greebles)
    cx, cy, cz, cw, chh, cd = F.CABI
    box(p, (cx, cy, cz), (cw, chh, cd), zbox(F.C_PROP, (cx, cy, cz),
        (cw, chh, cd)), ch=0.04)
    ax, ay, az, aw, ah, ad = F.ACV
    box(p, (ax, ay, az), (aw, ah, ad), zbox(F.C_ACV, (ax, ay, az),
        (aw, ah, ad)), ch=0.04)
    # cable tray cabinet -> command module wall
    limb(p, (cx, cy + 0.5, cz), (F.UP[0] + 1.0, F.HALL_TOP + 0.9, F.UP[2] - 1.7),
         0.03, 0.03, F.C_MAST, n=4)
    return p


def build_flag():
    """Cloth only; origin at the pole-top hoist. Extends +X with a slight
    baked -> +Z kink so it catches light; both sides visible."""
    p = Part('flag')
    w, h = F.FLAG_W, F.FLAG_H
    kink = 0.07
    rows = [(0.04, 0.0), (w * 0.55, kink), (w, -0.03)]
    zf = F.C_FLAG
    for i in range(len(rows) - 1):
        (x0, z0), (x1, z1) = rows[i], rows[i + 1]
        sag0 = 0.05 * (x0 / w)
        sag1 = 0.05 * (x1 / w)
        quad = [(x0, -0.02 - sag0, z0), (x1, -0.02 - sag1, z1),
                (x1, -0.02 - sag1 - h, z1), (x0, -0.02 - sag0 - h, z0)]
        p.add_face(quad, zone=zf)
        p.add_face(quad, zone=zf, flip=True)
    return p


def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    """Idle flag wave: small yaw rotation + x-stretch flutter on the
    cloth node (rigid channels per the clip-player contract)."""
    T = 3.2
    angs = [0.0, 6.0, 9.0, 4.0, 0.0, -5.0, -8.0, -3.0, 0.0]
    sxs = [1.0, 1.05, 0.97, 1.06, 1.0, 0.95, 1.04, 0.98, 1.0]
    n = len(angs)
    rot = [(T * i / (n - 1), qy(a)) for i, a in enumerate(angs)]
    scl = [(T * i / (n - 1), (s, 1.0 + (1.0 - s) * 0.4, 1.0))
           for i, s in enumerate(sxs)]
    return [{'name': 'idle', 'channels': [
        ('flag', 'rotation', rot),
        ('flag', 'scale', scl),
    ]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='flag', parent=0, offset=F.FLAG_OFF, part=build_flag()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_command_post] total tris: {total}')
