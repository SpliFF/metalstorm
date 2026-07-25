"""gen_staticdef — assemble ms_staticdefense_s1 and export .gltf/.bin.

Autocannon emplacement (static defense s1): octagonal concrete revetment
with sandbag rim, sunken pit, armored plinth, rotating twin-autocannon
turret. Chain body → turret → barrel → muzzle (cosmetic-aim ready).
Run: python3 gen_staticdef.py → out/ms_staticdefense_s1{,_png}.gltf + .bin
"""
import numpy as np

import staticdef_layout as F        # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, Zone, chamfer_box, ngon_ring, loft, tube, limb
from gltf_export import export

STEM = 'ms_staticdefense_s1'
OUT = 'out'


def drum_y(p, cx, cz, ybase, ytop, r0, wrap_rect, cap_zone=None, n=8, r1=None):
    """Vertical n-gon drum with parametric wrap (battleship §22 helper)."""
    r1_ = r0 if r1 is None else r1
    ra = ngon_ring((cx, ybase, cz), r0, n=n, axis='y')
    rb = ngon_ring((cx, ytop, cz), r1_, n=n, axis='y')
    dx0, dy0, dx1, dy1 = wrap_rect
    for j in range(n):
        k = (j + 1) % n
        u0 = (dx0 + (dx1 - dx0) * j / n) / M.ATLAS
        u1 = (dx0 + (dx1 - dx0) * (j + 1) / n) / M.ATLAS
        quad = [ra[j], ra[k], rb[k], rb[j]]
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
        zc = Zone(cap_zone.rect, ('x', 'z'),
                  ((cx - r1_, cx + r1_), (cz - r1_, cz + r1_)))
        p.add_face(ngon_ring((cx, ytop, cz), r1_, n=n, axis='y'), zone=zc,
                   flip=True)


def wall_zone(c, n):
    if n[1] > 0.55:
        return F.S_TOP
    if n[1] < -0.55:
        return F.S_DARK
    return F.S_WALL if abs(n[2]) >= abs(n[0]) else F.S_WALL_Z


def build_body():
    p = Part('body')

    # revetment ring: outer berm slope → rim top → inner wall → floor lip
    n = 8
    r_out = ngon_ring((0, 0.0, 0), F.RING_R_OUT, n=n, axis='y')
    r_top = ngon_ring((0, F.RING_H, 0), F.RING_R_TOP, n=n, axis='y')
    r_inr = ngon_ring((0, F.RING_H, 0), F.RING_R_INR, n=n, axis='y')
    r_inb = ngon_ring((0, F.FLOOR_Y, 0), F.RING_R_INR + 0.10, n=n, axis='y')
    loft(p, [r_out, r_top, r_inr, r_inb], wall_zone, flip_side=True)
    # pit floor disc
    p.add_face(list(reversed(ngon_ring((0, F.FLOOR_Y, 0), F.RING_R_INR + 0.10,
                                       n=n, axis='y'))), zone=F.S_TOP)

    # sandbag ridge segments along the rim top (skip the -Z entry notch)
    for i in range(n):
        a0 = np.pi / n + 2 * np.pi * i / n
        ac = a0 + np.pi / n
        # rim midpoint direction; leave the -Z segment open as the entryway
        dx, dz = np.sin(ac), np.cos(ac)
        if dz < -0.85:
            continue
        rr = (F.RING_R_TOP + F.RING_R_INR) / 2
        seg = 2 * rr * np.sin(np.pi / n) * 0.72
        cx, cz = dx * rr, dz * rr
        yaw = np.arctan2(dx, dz)
        c, s = np.cos(yaw), np.sin(yaw)
        w, h, d = seg, 0.34, 0.46
        hw, hh, hd = w / 2, h / 2, d / 2
        base = []
        for sy in (-1, 1):
            for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                lx, ly, lz = sx * hw, sy * hh, sz * hd
                base.append((cx + lx * c + lz * s, F.RING_H + hh + ly,
                             cz - lx * s + lz * c))
        b = base
        p.add_face([b[0], b[1], b[2], b[3]], zone=F.S_DARK, flip=True)
        p.add_face([b[4], b[5], b[6], b[7]], zone=F.S_BAGS)
        for (i0, i1, i2, i3) in ((0, 1, 5, 4), (1, 2, 6, 5),
                                 (2, 3, 7, 6), (3, 0, 4, 7)):
            quad = [b[i0], b[i1], b[i2], b[i3]]
            ctr = np.mean(np.array(quad), axis=0)
            nn = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                          np.asarray(quad[3]) - np.asarray(quad[0]))
            if np.dot(nn, ctr - np.array([cx, F.RING_H + hh, cz])) < 0:
                quad, nn = quad[::-1], -nn
            p.add_face(quad, zone=F.S_BAGS if abs(nn[2]) >= abs(nn[0])
                       else F.S_BAGS_Z)

    # entry step pad inside the pit at -Z (stays inside the berm)
    chamfer_box(p, (0, F.FLOOR_Y + 0.06, -1.95), (1.5, 0.16, 0.8),
                0.03, {'+y': F.S_TOP, '+x': F.S_WALL_Z, '-x': F.S_WALL_Z,
                       '-z': F.S_WALL, '+z': F.S_WALL}, skip=('-y',))

    # central plinth drum (straight barrel + tapered collar)
    drum_y(p, 0, 0, F.FLOOR_Y, F.PLINTH_H - 0.14, F.PLINTH_R, F.S_PLINTH, n=10)
    drum_y(p, 0, 0, F.PLINTH_H - 0.14, F.PLINTH_H, F.PLINTH_R,
           F.S_PLINTH, cap_zone=F.S_PLINTH_T, n=10, r1=F.PLINTH_R - 0.12)

    # ammo crates in the pit (two stacks) + generator box
    chamfer_box(p, (1.55, F.FLOOR_Y + 0.26, 0.75), (0.85, 0.52, 0.62), 0.04,
                {'+y': F.S_AMMO, '+x': F.S_AMMO, '-x': F.S_AMMO,
                 '+z': F.S_AMMO, '-z': F.S_AMMO}, skip=('-y',))
    chamfer_box(p, (1.38, F.FLOOR_Y + 0.72, 0.62), (0.62, 0.40, 0.50), 0.04,
                {'+y': F.S_AMMO, '+x': F.S_AMMO, '-x': F.S_AMMO,
                 '+z': F.S_AMMO, '-z': F.S_AMMO}, skip=('-y',))
    chamfer_box(p, (-1.62, F.FLOOR_Y + 0.34, 0.85), (0.75, 0.68, 0.58), 0.04,
                {'+y': F.S_AMMO, '+x': F.S_AMMO, '-x': F.S_AMMO,
                 '+z': F.S_AMMO, '-z': F.S_AMMO}, skip=('-y',))
    # cable run generator → plinth
    limb(p, (-1.45, F.FLOOR_Y + 0.10, 0.70), (-0.55, F.FLOOR_Y + 0.08, 0.25),
         0.045, 0.045, F.S_SENSOR, n=4)

    # perimeter warning light post at +Z rim
    limb(p, (0.0, F.RING_H, 2.38), (0.0, F.RING_H + 0.55, 2.38),
         0.035, 0.03, F.S_SENSOR, n=4)
    chamfer_box(p, (0.0, F.RING_H + 0.62, 2.38), (0.13, 0.13, 0.13), 0.02,
                {'+y': F.S_LIGHT, '-y': F.S_LIGHT, '+x': F.S_LIGHT,
                 '-x': F.S_LIGHT, '+z': F.S_LIGHT, '-z': F.S_LIGHT})
    return p


def build_turret():
    p = Part('turret')
    # gunhouse: 6-station loft — chiselled front, flat roof
    W2 = F.GH_W / 2
    ys = [0.0, 0.24, 0.56, F.GH_H]          # bottom, waist, shoulder, roof
    ws = [W2 * 0.80, W2, W2 * 0.94, W2 * 0.64]
    zf = [-0.78, -0.90, -0.85, -0.52]       # front z per station
    zr = [0.84, 0.94, 0.88, 0.68]           # rear z per station
    rings = []
    for y, w, zf_, zr_ in zip(ys, ws, zf, zr):
        rings.append([(-w, y, zf_), (w, y, zf_), (w, y, zr_), (-w, y, zr_)])

    def gh_zone(c, n):
        if n[1] > 0.6:
            return F.S_GH_T
        if n[1] < -0.6:
            return F.S_DARK
        if abs(n[0]) > 0.6:
            return F.S_GH_S
        return F.S_GH_F if n[2] < 0 else F.S_GH_R
    loft(p, rings, gh_zone, flip_side=True)
    p.add_face(rings[-1], zone=F.S_GH_T, flip=True)   # roof (ring order winds -Y)
    p.add_face(rings[0], zone=F.S_DARK)               # underside

    # mantlet slot cheeks around the trunnion
    chamfer_box(p, (0, F.TRUN_Y, F.TRUN_Z - 0.42), (1.02, 0.5, 0.5), 0.05,
                {'+y': F.S_GH_T, '+x': F.S_GH_S, '-x': F.S_GH_S,
                 '-z': F.S_GH_F, '+z': F.S_GH_R}, skip=('-y',))

    # roof sensor head on a short mast (reaches the 3 m style height)
    limb(p, (0.34, F.GH_H, 0.30), (0.34, F.GH_H + 0.42, 0.30),
         0.05, 0.04, F.S_SENSOR, n=6)
    chamfer_box(p, (0.34, F.GH_H + 0.56, 0.30), (0.30, 0.28, 0.24), 0.03,
                {'+y': F.S_GH_T, '+x': F.S_GH_S, '-x': F.S_GH_S,
                 '-z': F.S_LIGHT, '+z': F.S_GH_S})
    # ammo feed box (left flank of the gunhouse)
    chamfer_box(p, (0.80, 0.28, -0.05), (0.20, 0.36, 0.62), 0.03,
                {'+y': F.S_GH_T, '-y': F.S_DARK, '+x': F.S_GH_S,
                 '+z': F.S_GH_S, '-z': F.S_GH_S, '-x': F.S_GH_S})
    # spent-case ejection chute (right side)
    chamfer_box(p, (-0.80, 0.26, 0.15), (0.16, 0.30, 0.46), 0.02,
                {'+y': F.S_GH_T, '-y': F.S_DARK, '-x': F.S_GH_S,
                 '+z': F.S_GH_S, '-z': F.S_GH_S, '+x': F.S_GH_S})
    return p


def build_barrel():
    p = Part('barrel')
    el = np.radians(F.BARREL_ELEV)
    # cradle block at the trunnion
    chamfer_box(p, (0, 0.0, 0.06), (0.78, 0.44, 0.72), 0.05,
                {'+y': F.S_CRADLE, '-y': F.S_DARK, '+x': F.S_CRADLE,
                 '-x': F.S_CRADLE, '-z': F.S_CRADLE, '+z': F.S_CRADLE})
    # twin tubes, elevation baked into the geometry
    for sx in (-1, 1):
        x = sx * F.GUN_GAP
        p0 = np.array([x, 0.06, -0.30])
        d = np.array([0.0, np.sin(el), -np.cos(el)])
        stations = [(0.0, 0.085), (0.30, 0.062), (1.55, 0.052),
                    (1.72, 0.075), (F.BARREL_LEN, 0.070)]
        pts = [tuple(p0 + d * t) for t, _ in stations]
        for i in range(len(stations) - 1):
            limb(p, pts[i], pts[i + 1], stations[i][1], stations[i + 1][1],
                 F.S_GUN, n=8,
                 cap_end=F.S_MUZZ if i == len(stations) - 2 else None)
    return p


def muzzle_offset():
    el = np.radians(F.BARREL_ELEV)
    d = np.array([0.0, np.sin(el), -np.cos(el)])
    tip = np.array([0.0, 0.06, -0.30]) + d * F.BARREL_LEN
    return tuple(round(float(v), 4) for v in tip)


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='turret', parent=0, offset=(0, F.TURRET_Y, 0), part=build_turret()),
        dict(name='barrel', parent=1, offset=(0, F.TRUN_Y, F.TRUN_Z), part=build_barrel()),
        dict(name='muzzle', parent=2, offset=muzzle_offset(), part=None),
        dict(name='exhaust', parent=0, offset=(-1.62, F.FLOOR_Y + 0.72, 0.85), part=None),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
