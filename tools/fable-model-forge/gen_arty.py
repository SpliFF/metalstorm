"""gen_arty — assemble ms_artillery_s2 and export .gltf/.bin.

Self-propelled howitzer (artillery s2, 7.5 m): low hull on tracks,
rear-set casemate turret, long elevated howitzer with double-baffle
brake and twin recuperators, rear recoil spade. Chain body →
tracks_l/r + turret → barrel → muzzle (cosmetic-aim ready).
Run: python3 gen_arty.py → out/ms_artillery_s2{,_png}.gltf + .bin
"""
import numpy as np

import arty_layout as L             # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, Zone, chamfer_box, ngon_ring, loft, tube, limb, mirror_x
from gltf_export import export

STEM = 'ms_artillery_s2'
OUT = 'out'


def hull_zone(c, n):
    if n[1] > 0.55:
        return L.A_HULL_TOP
    if n[1] < -0.55:
        return L.A_DARK
    if abs(n[0]) > 0.62:
        return L.A_HULL_SIDE
    return L.A_GLACIS if n[2] < 0 else L.A_HULL_REAR


def cab_zone(c, n):
    if n[1] > 0.55:
        return L.A_CAB_TOP
    if n[1] < -0.55:
        return L.A_DARK
    if abs(n[0]) > 0.62:
        return L.A_CAB_SIDE
    return L.A_CAB_FRONT if n[2] < 0 else L.A_CAB_REAR


def ring_from_section(sec):
    z, yb, yw, ys, yd, wb, ww, wd, wt = sec
    return [
        (wb, yb, z), (ww, yw, z), (wd, ys, z), (wt, yd, z),
        (-wt, yd, z), (-wd, ys, z), (-ww, yw, z), (-wb, yb, z),
    ]


def build_body():
    p = Part('body')
    rings = [ring_from_section(s) for s in L.HULL_SECTIONS]
    loft(p, rings, hull_zone, cap_start=L.A_GLACIS, cap_end=L.A_HULL_REAR)

    # driver hatch (front-left deck)
    chamfer_box(p, (0.55, L.HULL_DECK_Y + 0.03, -2.10), (0.56, 0.09, 0.56),
                0.02, {'+y': L.A_HATCH, '+x': L.A_HATCH, '-x': L.A_HATCH,
                       '+z': L.A_HATCH, '-z': L.A_HATCH}, skip=('-y',))
    # engine intake grille (front deck — engine forward, gun rear)
    chamfer_box(p, (0.0, L.HULL_DECK_Y + 0.04, -1.15), (1.5, 0.10, 0.92),
                0.025, {'+y': L.A_INTAKE, '+x': L.A_HULL_SIDE,
                        '-x': L.A_HULL_SIDE, '+z': L.A_HULL_SIDE,
                        '-z': L.A_HULL_SIDE}, skip=('-y',))
    # exhaust housing (left rear flank)
    chamfer_box(p, (L.EXHAUST_OFF[0] - 0.35, 1.30, L.EXHAUST_OFF[2]),
                (0.44, 0.40, 0.60), 0.04,
                {'+y': L.A_HULL_TOP, '+x': L.A_HULL_SIDE, '-x': L.A_HULL_SIDE,
                 '+z': L.A_EXHAUST, '-z': L.A_HULL_SIDE}, skip=(),)
    # rear recoil spade: angled blade + two arms
    sx, sy, sz, sw, sh, sd = L.SPADE
    for ax in (-0.75, 0.75):
        limb(p, (ax, 0.55, 3.30), (ax, 0.28, 3.95), 0.09, 0.08, L.A_CRANE, n=4)
    # blade: single chamfer box, tilted read baked by two stacked boxes
    chamfer_box(p, (sx, 0.30, sz + 0.14), (sw, 0.46, sd), 0.04,
                {'+y': L.A_SPADE, '-y': L.A_DARK, '+x': L.A_SPADE,
                 '-x': L.A_SPADE, '+z': L.A_SPADE, '-z': L.A_SPADE})
    chamfer_box(p, (sx, 0.62, sz + 0.02), (sw * 0.82, 0.26, sd * 0.8),
                0.03, {'+y': L.A_SPADE, '-y': L.A_DARK, '+x': L.A_SPADE,
                       '-x': L.A_SPADE, '+z': L.A_SPADE, '-z': L.A_SPADE})
    # headlight pods on the glacis
    for hx in (-0.95, 0.95):
        chamfer_box(p, (hx, 1.30, -3.40), (0.22, 0.16, 0.18), 0.02,
                    {'+y': L.A_HULL_TOP, '+x': L.A_HULL_SIDE,
                     '-x': L.A_HULL_SIDE, '-z': L.A_LIGHT, '+z': L.A_HULL_SIDE})
    return p


def build_tracks_l():
    p = Part('tracks_l')
    prof = L.TRACK_PROFILE
    w = L.TRACK_HALF_W
    n = len(prof)
    outer = [(w, y, z) for (z, y) in prof]
    inner = [(-w, y, z) for (z, y) in prof]
    p.add_face(outer, zone=L.A_TRACK_SIDE, flip=True)
    p.add_face(inner, zone=L.A_TRACK_SIDE)

    x0, y0, x1, y1 = L.A_TRACK_WRAP
    seg = [np.hypot(prof[(i + 1) % n][0] - prof[i][0],
                    prof[(i + 1) % n][1] - prof[i][1]) for i in range(n)]
    total = sum(seg)
    acc = 0.0
    centroid = np.array([0.0, sum(y for _, y in prof) / n,
                         sum(z for z, _ in prof) / n])
    for i in range(n):
        j = (i + 1) % n
        u0 = (x0 + (x1 - x0) * acc / total) / M.ATLAS
        acc += seg[i]
        u1 = (x0 + (x1 - x0) * acc / total) / M.ATLAS
        va, vb = y0 / M.ATLAS, y1 / M.ATLAS
        quad = [(w, prof[i][1], prof[i][0]), (-w, prof[i][1], prof[i][0]),
                (-w, prof[j][1], prof[j][0]), (w, prof[j][1], prof[j][0])]
        uvs = [(u0, va), (u0, vb), (u1, vb), (u1, va)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        if np.dot(nrm, ctr - centroid) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)

    for (hz, hy, hr) in (L.HUB_FRONT, L.HUB_REAR):
        rings = [ngon_ring((w - 0.01, hy, hz), hr, n=8, axis='x'),
                 ngon_ring((w + 0.07, hy, hz), hr, n=8, axis='x')]
        hx0, hy0, hx1, hy1 = L.A_HUB
        for j in range(8):
            k = (j + 1) % 8
            u0 = (hx0 + (hx1 - hx0) * j / 8) / M.ATLAS
            u1 = (hx0 + (hx1 - hx0) * (j + 1) / 8) / M.ATLAS
            quad = [rings[0][j], rings[0][k], rings[1][k], rings[1][j]]
            uvs = [(u0, hy0 / M.ATLAS), (u1, hy0 / M.ATLAS),
                   (u1, hy1 / M.ATLAS), (u0, hy1 / M.ATLAS)]
            nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                           np.asarray(quad[3]) - np.asarray(quad[0]))
            ctr = np.mean(np.array(quad), axis=0)
            rad = ctr - np.array([ctr[0], hy, hz])
            if np.dot(nrm, rad) < 0:
                quad, uvs = quad[::-1], uvs[::-1]
            p.add_face(quad, uvs=uvs)
        cap = ngon_ring((w + 0.07, hy, hz), hr, n=8, axis='x')
        zc = Zone(L.A_HUB_CAP.rect, ('z', 'y'),
                  ((hz - hr, hz + hr), (hy + hr, hy - hr)))
        p.add_face(cap, zone=zc)

    (fz0, fz1), fy, fh, fw = L.FENDER
    chamfer_box(p, (0.0, fy + fh / 2 - 0.02, (fz0 + fz1) / 2),
                (fw, fh, fz1 - fz0), 0.03,
                {'+y': L.A_FENDER, '+x': L.A_TRACK_SIDE, '-x': L.A_TRACK_SIDE,
                 '+z': L.A_TRACK_SIDE, '-z': L.A_TRACK_SIDE}, skip=('-y',))
    return p


def build_turret():
    p = Part('turret')
    rings = [ring_from_section(s) for s in L.CAB_SECTIONS]
    loft(p, rings, cab_zone, cap_start=L.A_CAB_FRONT, cap_end=L.A_CAB_REAR)

    # loader hatch on the roof
    chamfer_box(p, (-0.52, 1.28, 0.75), (0.56, 0.08, 0.56), 0.02,
                {'+y': L.A_HATCH, '+x': L.A_HATCH, '-x': L.A_HATCH,
                 '+z': L.A_HATCH, '-z': L.A_HATCH}, skip=('-y',))
    # commander sight drum (right-front roof)
    cx, cz, cr, ch = 0.58, -0.15, 0.20, 0.24
    ra = ngon_ring((cx, 1.28, cz), cr, n=8, axis='y')
    rb = ngon_ring((cx, 1.28 + ch, cz), cr, n=8, axis='y')
    hx0, hy0, hx1, hy1 = L.A_CRANE
    for j in range(8):
        k = (j + 1) % 8
        u0 = (hx0 + (hx1 - hx0) * j / 8) / M.ATLAS
        u1 = (hx0 + (hx1 - hx0) * (j + 1) / 8) / M.ATLAS
        quad = [ra[j], ra[k], rb[k], rb[j]]
        uvs = [(u0, hy1 / M.ATLAS), (u1, hy1 / M.ATLAS),
               (u1, hy0 / M.ATLAS), (u0, hy0 / M.ATLAS)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        rad = ctr - np.array([cx, ctr[1], cz])
        if np.dot(nrm, rad) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)
    zc = Zone(L.A_HATCH.rect, ('x', 'z'), ((cx - cr, cx + cr), (cz - cr, cz + cr)))
    p.add_face(ngon_ring((cx, 1.28 + ch, cz), cr, n=8, axis='y'), zone=zc,
               flip=True)

    # mantlet collar where the tube exits the casemate front slope
    chamfer_box(p, (0.0, 1.00, -1.10), (0.62, 0.52, 0.62), 0.06,
                {'+y': L.A_CAB_TOP, '-y': L.A_DARK, '+x': L.A_CAB_SIDE,
                 '-x': L.A_CAB_SIDE, '-z': L.A_CAB_FRONT, '+z': L.A_CAB_REAR})
    # ammo resupply crane post (rear-left corner) — the battery read
    limb(p, (-0.85, 1.26, 1.55), (-0.85, 1.95, 1.55), 0.07, 0.06, L.A_CRANE, n=6)
    limb(p, (-0.85, 1.90, 1.55), (-0.15, 1.82, 1.05), 0.05, 0.045, L.A_CRANE, n=4)
    # stowage baskets on the flanks
    for sx in (-1, 1):
        chamfer_box(p, (sx * 1.16, 0.55, 0.90), (0.18, 0.50, 1.30), 0.03,
                    {'+y': L.A_AMMO, '-y': L.A_DARK, '+x': L.A_AMMO,
                     '-x': L.A_AMMO, '+z': L.A_AMMO, '-z': L.A_AMMO})
    return p


def build_barrel():
    p = Part('barrel')
    el = np.radians(L.BARREL_ELEV)
    d = np.array([0.0, np.sin(el), -np.cos(el)])
    up = np.array([0.0, np.cos(el), np.sin(el)])

    # breech block behind the trunnion
    chamfer_box(p, (0.0, -0.02, 0.36), (0.60, 0.62, 0.80), 0.05,
                {'+y': L.A_BREECH, '-y': L.A_BREECH, '+x': L.A_BREECH,
                 '-x': L.A_BREECH, '+z': L.A_BREECH, '-z': L.A_BREECH})

    # main tube: thick chase → step → slender chase → brake collar
    p0 = np.array([0.0, 0.0, -0.20])
    stations = [(0.0, 0.150), (1.05, 0.130), (1.10, 0.100), (2.75, 0.092),
                (2.85, 0.115)]
    pts = [tuple(p0 + d * t) for t, _ in stations]
    for i in range(len(stations) - 1):
        limb(p, pts[i], pts[i + 1], stations[i][1], stations[i + 1][1],
             L.A_TUBE, n=8)

    # double-baffle muzzle brake: two slabs + tip stub
    for t, sz in ((3.00, (0.46, 0.44, 0.22)), (3.26, (0.46, 0.44, 0.22))):
        c = p0 + d * t
        chamfer_box(p, tuple(c), sz, 0.04,
                    {'+y': L.A_BRAKE, '-y': L.A_BRAKE, '+x': L.A_BRAKE,
                     '-x': L.A_BRAKE, '+z': L.A_BRAKE, '-z': L.A_BRAKE})
    limb(p, tuple(p0 + d * 2.85), tuple(p0 + d * L.TUBE_LEN), 0.085, 0.082,
         L.A_TUBE, n=8, cap_end=L.A_TUBE_CAP)

    # twin recuperator cylinders above the chase (cyan plumbing lives here)
    for sx in (-0.16, 0.16):
        r0 = p0 + up * 0.26 + np.array([sx, 0, 0])
        limb(p, tuple(r0 + d * -0.05), tuple(r0 + d * 1.15), 0.07, 0.065,
             L.A_RECUP.rect if isinstance(L.A_RECUP, Zone) else L.A_RECUP,
             n=6, cap_end=None)
    return p


def muzzle_offset():
    el = np.radians(L.BARREL_ELEV)
    d = np.array([0.0, np.sin(el), -np.cos(el)])
    tip = np.array([0.0, 0.0, -0.20]) + d * L.TUBE_LEN
    return tuple(round(float(v), 4) for v in tip)


def build_all():
    tl = build_tracks_l()
    tr = mirror_x(tl, 'tracks_r')
    tx, ty, tz = L.TRACK_OFF
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='tracks_l', parent=0, offset=(tx, ty, tz), part=tl),
        dict(name='tracks_r', parent=0, offset=(-tx, ty, tz), part=tr),
        dict(name='turret', parent=0, offset=L.TURRET_OFF, part=build_turret()),
        dict(name='barrel', parent=3, offset=L.BARREL_OFF, part=build_barrel()),
        dict(name='muzzle', parent=4, offset=muzzle_offset(), part=None),
        dict(name='exhaust', parent=0, offset=L.EXHAUST_OFF, part=None),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
