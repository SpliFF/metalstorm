"""gen_garrison — assemble ms_garrison and export .gltf/.bin.

Infantry muster compound (10×10 footprint → 20×20 m): perimeter blast
wall with -Z gatehouse, two pitched-roof barracks halls, armory block,
watchtower with rotating `dish` sensor (12 s idle clip), flag mast,
props. Pieces: body + dish.
Run: python3 gen_garrison.py → out/ms_garrison{,_png}.gltf + .bin
"""
import numpy as np

import garrison_layout as F         # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, chamfer_box, ngon_ring, limb
from gltf_export import export

STEM = 'ms_garrison'
OUT = 'out'


def box(p, center, size, zones, ch=0.04, skip=('-y',)):
    chamfer_box(p, center, size, ch, zones, skip=skip)


def wall_zone_for(nx, nz):
    return F.G_WALL if abs(nz) >= abs(nx) else F.G_WALL_Z


def barracks(p, cx, cz, w, d, wh, rh, zs, ze, zr):
    """Pitched-roof hall. zs/ze/zr = side/end/roof zones."""
    hw, hd = w / 2, d / 2
    # walls
    box(p, (cx - hw + 0.11, wh / 2, cz), (0.22, wh, d),
        {'-x': zs, '+x': F.G_DARK}, ch=0.03)
    box(p, (cx + hw - 0.11, wh / 2, cz), (0.22, wh, d),
        {'+x': zs, '-x': F.G_DARK}, ch=0.03)
    box(p, (cx, wh / 2, cz - hd + 0.11), (w - 0.44, wh, 0.22),
        {'-z': ze, '+z': F.G_DARK}, ch=0.03)
    box(p, (cx, wh / 2, cz + hd - 0.11), (w - 0.44, wh, 0.22),
        {'+z': ze, '-z': F.G_DARK}, ch=0.03)
    # gable ends (triangles above the end walls)
    for sz, flip in ((-1, False), (1, True)):
        tri = [(cx - hw, wh, cz + sz * hd), (cx + hw, wh, cz + sz * hd),
               (cx, rh, cz + sz * hd)]
        p.add_face(tri, zone=ze, flip=(sz < 0))
    # roof slopes (double-sided not needed: only outside visible)
    eave = 0.35
    for sx in (-1, 1):
        quad = [(cx + sx * (hw + eave), wh - 0.08, cz - hd - eave),
                (cx + sx * (hw + eave), wh - 0.08, cz + hd + eave),
                (cx, rh, cz + hd + eave), (cx, rh, cz - hd - eave)]
        n_up = np.cross(np.subtract(quad[1], quad[0]), np.subtract(quad[3], quad[0]))
        if n_up[1] < 0:
            quad = quad[::-1]
        p.add_face(quad, zone=zr)
        p.add_face(quad, zone=F.G_DARK, flip=True)   # underside (visible at eaves)


def build_body():
    p = Part('body')
    H = F.PAD_HALF
    # concrete pad
    box(p, (0, 0.09, 0), (2 * H, 0.18, 2 * H),
        {'+y': F.G_PAD, '+x': F.G_WALL_Z, '-x': F.G_WALL_Z,
         '+z': F.G_WALL, '-z': F.G_WALL}, ch=0.03)

    # perimeter walls (leave the gate opening on -Z)
    W_, T, WH = F.WALL_HALF, F.WALL_T, F.WALL_H
    gw = F.GATE_W / 2
    # -Z front wall: two segments flanking the gate
    for cx, w in ((-(W_ + gw) / 2 + 0.0, W_ - gw), ((W_ + gw) / 2, W_ - gw)):
        box(p, (cx, WH / 2 + 0.1, -W_), (w, WH, T),
            {'-z': F.G_WALL, '+z': F.G_WALL, '+y': F.G_WALLTOP,
             '+x': F.G_WALL_Z, '-x': F.G_WALL_Z}, ch=0.04)
    box(p, (0, WH / 2 + 0.1, W_), (2 * W_ + T, WH, T),
        {'-z': F.G_WALL, '+z': F.G_WALL, '+y': F.G_WALLTOP}, ch=0.04)
    for sx in (-1, 1):
        box(p, (sx * W_, WH / 2 + 0.1, 0), (T, WH, 2 * W_ - T),
            {'-x': F.G_WALL_Z, '+x': F.G_WALL_Z, '+y': F.G_WALLTOP}, ch=0.04)
    # corner posts
    for sx in (-1, 1):
        for sz in (-1, 1):
            box(p, (sx * W_, (WH + 0.15) / 2 + 0.1, sz * W_), (0.9, WH + 0.15, 0.9),
                {'+x': F.G_WALL_Z, '-x': F.G_WALL_Z, '+z': F.G_WALL,
                 '-z': F.G_WALL, '+y': F.G_WALLTOP}, ch=0.05)

    # gatehouse towers + lintel
    for sx in (-1, 1):
        box(p, (sx * (gw + 0.55), F.GATE_H / 2 + 0.1, -W_), (1.1, F.GATE_H, 1.6),
            {'-z': F.G_GATE_Z, '+z': F.G_GATE_Z, '+x': F.G_GATE,
             '-x': F.G_GATE, '+y': F.G_GATE_T}, ch=0.05)
    box(p, (0, F.GATE_H - 0.45, -W_), (2 * gw + 1.1, 0.9, 1.3),
        {'-z': F.G_GATE, '+z': F.G_GATE, '+y': F.G_GATE_T,
         '-y': F.G_DARK, '+x': F.G_GATE, '-x': F.G_GATE}, ch=0.05, skip=())

    # barracks halls
    cx, cz, w, d, wh, rh = F.BK1
    barracks(p, cx, cz, w, d, wh, rh, F.G_BK_S1, F.G_BK_E1, F.G_BK_R1)
    cx, cz, w, d, wh, rh = F.BK2
    barracks(p, cx, cz, w, d, wh, rh, F.G_BK_S2, F.G_BK_E2, F.G_BK_R2)

    # armory block (flat roof, rear-centre)
    ax, az, aw, ad, ah = F.ARM
    box(p, (ax, ah / 2 + 0.1, az), (aw, ah, ad),
        {'-z': F.G_ARM_S, '+z': F.G_ARM_S, '+x': F.G_ARM_SZ, '-x': F.G_ARM_SZ,
         '+y': F.G_ARM_R}, ch=0.05)
    # armory door canopy
    box(p, (ax, 2.35, az - ad / 2 - 0.35), (2.0, 0.14, 0.8),
        {'+y': F.G_ARM_R, '-y': F.G_DARK, '-z': F.G_ARM_S,
         '+x': F.G_ARM_S, '-x': F.G_ARM_S}, ch=0.02, skip=('+z',))

    # watchtower: 4 legs, cab, roof
    tx, tz = F.TWR_X, F.TWR_Z
    for lx in (-0.85, 0.85):
        for lz in (-0.85, 0.85):
            limb(p, (tx + lx, 0.15, tz + lz), (tx + lx * 0.55, F.TWR_H, tz + lz * 0.55),
                 0.10, 0.08, F.G_TWR, n=4)
    # cross braces
    limb(p, (tx - 0.8, 2.6, tz - 0.8), (tx + 0.8, 4.6, tz + 0.8), 0.05, 0.05,
         F.G_TWR, n=4)
    limb(p, (tx + 0.8, 2.6, tz - 0.8), (tx - 0.8, 4.6, tz + 0.8), 0.05, 0.05,
         F.G_TWR, n=4)
    # cab
    box(p, (tx, F.TWR_H + 0.75, tz), (2.4, 1.5, 2.4),
        {'+x': F.G_TWR_CAB, '-x': F.G_TWR_CAB, '+z': F.G_TWR_CABZ,
         '-z': F.G_TWR_CABZ, '-y': F.G_DARK}, ch=0.05, skip=())
    box(p, (tx, F.TWR_TOP - 0.06, tz), (2.7, 0.14, 2.7),
        {'+y': F.G_TWR_TOP, '-y': F.G_DARK, '+x': F.G_TWR_CAB,
         '-x': F.G_TWR_CAB, '+z': F.G_TWR_CABZ, '-z': F.G_TWR_CABZ}, ch=0.03,
        skip=())
    # ladder (colossus vocabulary: rails + rungs)
    for lx in (tx - 1.18, tx - 0.88):
        limb(p, (lx, 0.15, tz - 1.0), (lx, F.TWR_H + 0.2, tz - 1.0),
             0.035, 0.035, F.G_TWR, n=4)
    for ry in np.linspace(0.7, F.TWR_H - 0.3, 9):
        limb(p, (tx - 1.18, ry, tz - 1.0), (tx - 0.88, ry, tz - 1.0),
             0.025, 0.025, F.G_TWR, n=4)

    # flag mast + crossarm
    limb(p, (F.FLAG_X, 0.15, F.FLAG_Z), (F.FLAG_X, 6.8, F.FLAG_Z),
         0.07, 0.045, F.G_FLAG, n=6)
    limb(p, (F.FLAG_X, 6.5, F.FLAG_Z), (F.FLAG_X + 0.9, 6.5, F.FLAG_Z),
         0.03, 0.025, F.G_FLAG, n=4)

    # yard props: crate stacks + fuel tank + sandbag posts at the gate
    for (px_, pz, s) in ((1.1, -2.8, 1.0), (0.1, -3.3, 0.8), (3.9, 8.5, 1.1)):
        box(p, (px_, 0.18 + 0.45 * s, pz), (0.9 * s, 0.9 * s, 0.9 * s),
            {'+y': F.G_CRATE, '+x': F.G_CRATE, '-x': F.G_CRATE,
             '+z': F.G_CRATE, '-z': F.G_CRATE}, ch=0.03)
    # horizontal fuel tank on cradles (front-left corner)
    tkx, tkz = F.TANK_X, F.TANK_Z
    r0 = ngon_ring((tkx, 1.05, tkz - 1.4), 0.75, n=8, axis='z')
    r1 = ngon_ring((tkx, 1.05, tkz + 1.4), 0.75, n=8, axis='z')
    hx0, hy0, hx1, hy1 = F.G_TANKW
    for j in range(8):
        k = (j + 1) % 8
        u0 = (hx0 + (hx1 - hx0) * j / 8) / M.ATLAS
        u1 = (hx0 + (hx1 - hx0) * (j + 1) / 8) / M.ATLAS
        quad = [r0[j], r0[k], r1[k], r1[j]]
        uvs = [(u0, hy0 / M.ATLAS), (u1, hy0 / M.ATLAS),
               (u1, hy1 / M.ATLAS), (u0, hy1 / M.ATLAS)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        rad = ctr - np.array([tkx, 1.05, ctr[2]])
        if np.dot(nrm, rad) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)
    for (zc, flip) in ((tkz - 1.4, True), (tkz + 1.4, False)):
        ring = ngon_ring((tkx, 1.05, zc), 0.75, n=8, axis='z')
        zcap = Zone(F.G_LIGHT.rect, ('x', 'y'),
                    ((tkx - 0.75, tkx + 0.75), (1.8, 0.3)))
        p.add_face(ring, zone=F.G_DARK, flip=flip)
    for zc in (tkz - 0.9, tkz + 0.9):
        box(p, (tkx, 0.35, zc), (1.7, 0.5, 0.3),
            {'+x': F.G_CRATE, '-x': F.G_CRATE, '+z': F.G_CRATE,
             '-z': F.G_CRATE, '+y': F.G_CRATE}, ch=0.02)
    # gate sandbag posts
    for sx in (-1, 1):
        box(p, (sx * (gw + 1.6), 0.5, -W_ + 1.2), (1.2, 0.8, 1.0),
            {'+y': F.G_CRATE, '+x': F.G_CRATE, '-x': F.G_CRATE,
             '+z': F.G_CRATE, '-z': F.G_CRATE}, ch=0.06)
    # perimeter lights on the rear corners
    for sx in (-1, 1):
        limb(p, (sx * (W_ - 0.6), F.WALL_H + 0.1, W_ - 0.6),
             (sx * (W_ - 0.6), F.WALL_H + 0.85, W_ - 0.6), 0.04, 0.03,
             F.G_FLAG, n=4)
        box(p, (sx * (W_ - 0.6), F.WALL_H + 0.95, W_ - 0.6), (0.16, 0.16, 0.16),
            {'+y': F.G_LIGHT, '-y': F.G_LIGHT, '+x': F.G_LIGHT,
             '-x': F.G_LIGHT, '+z': F.G_LIGHT, '-z': F.G_LIGHT}, ch=0.02,
            skip=())
    return p


def build_dish():
    p = Part('dish')
    # mast stub + tilted rectangular array panel
    limb(p, (0, 0, 0), (0, 0.35, 0), 0.06, 0.05, F.G_TWR, n=6)
    tilt = np.radians(24)
    ctr = np.array([0, 0.42, -0.30])
    nrm = np.array([0, np.sin(tilt), -np.cos(tilt)])
    u = np.array([1.0, 0, 0])
    v = np.cross(nrm, u)
    hw, hh = 0.85, 0.45
    quad = [tuple(ctr + u * -hw + v * -hh), tuple(ctr + u * hw + v * -hh),
            tuple(ctr + u * hw + v * hh), tuple(ctr + u * -hw + v * hh)]
    p.add_face(quad, zone=F.G_DISH)
    p.add_face(quad, zone=F.G_DISH_B, flip=True)
    limb(p, (0, 0.35, 0), tuple(ctr + nrm * -0.06), 0.035, 0.03, F.G_TWR, n=4)
    return p


def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    T = 12.0
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
