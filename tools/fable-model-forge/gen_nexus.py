"""gen_nexus — assemble ms_command_nexus and export .gltf/.bin.

Command Nexus: fortified 23×23 m pad, two-tier keep, octagonal comms
tower with a proud war-room glass band, parapet crown, antenna mast,
four corner bastions, gated -Z front with an entry ramp, roof vents and
a pipe run. Static geometry on `body`; `dish` rotates (idle clip).
Run: python3 gen_nexus.py   → out/ms_command_nexus{,_png}.gltf + .bin
"""
import numpy as np

import nexus_layout as F        # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, chamfer_box, ngon_ring, limb
from gltf_export import export

STEM = 'ms_command_nexus'
OUT = 'out'


def drum_y(p, cx, cz, ybase, ytop, r, wrap_rect, cap_zone=None, n=8):
    r0 = ngon_ring((cx, ybase, cz), r, n=n, axis='y')
    r1 = ngon_ring((cx, ytop, cz), r, n=n, axis='y')
    dx0, dy0, dx1, dy1 = wrap_rect
    for j in range(n):
        k = (j + 1) % n
        u0 = (dx0 + (dx1 - dx0) * j / n) / M.ATLAS
        u1 = (dx0 + (dx1 - dx0) * (j + 1) / n) / M.ATLAS
        quad = [r0[j], r0[k], r1[k], r1[j]]
        uvs = [(u0, dy1 / M.ATLAS), (u1, dy1 / M.ATLAS),
               (u1, dy0 / M.ATLAS), (u0, dy0 / M.ATLAS)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        rad = ctr - np.array([cx, ctr[1], cz])
        if np.dot(nrm, rad) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)
    if cap_zone is not None:
        zc = Zone(cap_zone.rect, ('x', 'z'), ((cx - r, cx + r), (cz - r, cz + r)))
        p.add_face(ngon_ring((cx, ytop, cz), r, n=n, axis='y'), zone=zc, flip=True)


def hose(p, pts, r, rect=None, collars=True, n=6):
    rect = rect or F.N_PIPE
    for i in range(len(pts) - 1):
        limb(p, pts[i], pts[i + 1], r, r, rect, n=n)
    if collars:
        for i in range(1, len(pts) - 1):
            a, b = np.asarray(pts[i - 1]), np.asarray(pts[i])
            d = b - a
            d = d / max(1e-9, np.linalg.norm(d))
            limb(p, tuple(b - d * 0.12), tuple(b + d * 0.12), r * 1.28, r * 1.28, rect, n=n)


def build_body():
    p = Part('body')

    # concrete pad
    x, y, z, w, h, d = F.PAD
    chamfer_box(p, (x, y, z), (w, h, d), 0.12,
                {'+y': F.N_PAD, '+x': F.N_PADS, '-x': F.N_PADS,
                 '+z': F.N_PADS_F, '-z': F.N_PADS_F}, skip=('-y',))

    # keep tier 1
    x, y, z, w, h, d = F.TIER1
    chamfer_box(p, (x, y, z), (w, h, d), 0.10,
                {'+x': F.N_T1_SIDE, '-x': F.N_T1_SIDE, '-z': F.N_T1_FR,
                 '+z': F.N_T1_FR, '+y': F.N_T1_ROOF}, skip=('-y',))

    # keep tier 2
    x, y, z, w, h, d = F.TIER2
    chamfer_box(p, (x, y, z), (w, h, d), 0.09,
                {'+x': F.N_T2_SIDE, '-x': F.N_T2_SIDE, '-z': F.N_T2_FR,
                 '+z': F.N_T2_FR, '+y': F.N_T2_ROOF}, skip=('-y',))

    # comms tower: octagon drum + proud war-room band + crown cap
    drum_y(p, 0, 0, F.T2_TOP, F.TOWER_TOP, F.TOWER_R, F.N_TOWER, n=8)
    by0, by1, br = F.BAND
    drum_y(p, 0, 0, by0, by1, br, F.N_BAND, n=8)
    drum_y(p, 0, 0, F.TOWER_TOP, F.CROWN_TOP, F.CROWN_R, F.N_CROWN_W,
           cap_zone=F.N_CROWN, n=8)

    # antenna mast + beacon tip
    limb(p, (0, F.CROWN_TOP, 0), (0, F.MAST_TOP, 0), 0.18, 0.07, F.N_MAST, n=6)
    chamfer_box(p, (0, F.MAST_TOP + 0.16, 0), (0.30, 0.32, 0.30), 0.03,
                {'+y': F.N_BEACON, '-y': F.N_BEACON, '+x': F.N_BEACON,
                 '-x': F.N_BEACON, '+z': F.N_BEACON, '-z': F.N_BEACON})

    # corner bastions
    bw, bh, bd = F.BASTION_SZ
    for bx, bz in F.BASTIONS:
        zs = Zone(F.N_BASTION.rect, ('z', 'y'),
                  ((bz - 1.7, bz + 1.7), (4.9, 1.2)))
        zf = Zone(F.N_BASTION_F.rect, ('x', 'y'),
                  ((bx - 1.7, bx + 1.7), (4.9, 1.2)))
        zt = Zone(F.N_BASTION_TOP.rect, ('x', 'z'),
                  ((bx - 1.7, bx + 1.7), (bz - 1.7, bz + 1.7)))
        chamfer_box(p, (bx, F.PAD_TOP + bh / 2, bz), (bw, bh, bd), 0.08,
                    {'+x': zs, '-x': zs, '+z': zf, '-z': zf, '+y': zt},
                    skip=('-y',))

    # gate doorframe (recessed door plane painted in N_GATE)
    x, y, z, w, h, d = F.GATE
    chamfer_box(p, (x, y, z), (w, h, d), 0.08,
                {'-z': F.N_GATE, '+x': F.N_TRIM_Z, '-x': F.N_TRIM_Z,
                 '+y': F.N_TRIM_Z}, skip=('+z', '-y'))

    # entry ramp: wedge from pad edge down to ground
    hw = F.RAMP_W / 2
    z0, z1 = F.RAMP_Z0, F.RAMP_Z1
    top = [(-hw, F.PAD_TOP, z0), (hw, F.PAD_TOP, z0),
           (hw, 0.0, z1), (-hw, 0.0, z1)]
    p.add_face(top, zone=F.N_RAMP)                       # sloped top
    p.add_face([(-hw, 0, z0), (-hw, F.PAD_TOP, z0), (-hw, 0, z1)],
               zone=F.N_PADS)                            # left tri
    p.add_face([(hw, 0, z0), (hw, 0, z1), (hw, F.PAD_TOP, z0)],
               zone=F.N_PADS)                            # right tri

    # tier1 roof vents
    for vx, vy, vz in F.VENTS:
        chamfer_box(p, (vx, vy + 0.5, vz), (1.7, 1.0, 1.0), 0.06,
                    {'+x': F.N_VENT, '-x': F.N_VENT, '+z': F.N_VENT,
                     '-z': F.N_VENT, '+y': F.N_DARK}, skip=('-y',))

    # pipe run: tier2 wall → tier1 roof → down tier1 wall → pad
    hose(p, [(F.PIPE_X - 2.0, F.T1_TOP + 1.6, 2.4),
             (F.PIPE_X - 0.4, F.T1_TOP + 0.35, 2.4),
             (F.PIPE_X + 0.42, F.T1_TOP - 0.35, 2.4),
             (F.PIPE_X + 0.42, F.PAD_TOP + 0.45, 2.4),
             (F.PIPE_X + 1.9, F.PAD_TOP + 0.28, 2.4)], 0.16)

    return p


def build_dish():
    p = Part('dish')
    drum_y(p, 0, 0, -0.07, 0.12, 0.85, F.N_TRIM, cap_zone=F.N_DISH, n=10)
    limb(p, (0, 0.06, 0), (0, 0.62, -0.72), 0.06, 0.045, F.N_MAST, n=4)
    return p


def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    T = 16.0
    dish_keys = [(T * i / 4, qy(90.0 * i)) for i in range(5)]
    return [{'name': 'idle', 'channels': [('dish', 'rotation', dish_keys)]}]


def build_all():
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='dish', parent=0, offset=F.DISH_OFF, part=build_dish()),
    ]
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
