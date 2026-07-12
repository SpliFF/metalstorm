"""gen_heavy — build fable_heavy geometry and export .gltf + .bin.

Extra-heavy tank: 2× fable_tank length, twin-tube main gun, independent
secondary turret (turret2/barrel2/muzzle2) on the front-left sponson.

Usage: python3 gen_heavy.py [png]
"""
from __future__ import annotations
import numpy as np

import heavy_layout as L        # sets meshlib.ATLAS = 2048 on import
import meshlib as M
from meshlib import Part, Zone, loft, chamfer_box, tube, ngon_ring, mirror_x
from gltf_export import export

STEM = 'fable_heavy'
OUT = 'out'


# ── zone classifiers ─────────────────────────────────────────────────────

def hull_zone(c, n):
    if n[1] < -0.5:
        return L.Z_DARK
    if abs(n[0]) > 0.62:
        return L.Z_HULL_SIDE
    if n[2] < -0.55:
        return L.Z_GLACIS
    if n[2] > 0.55:
        return L.Z_HULL_REAR
    return L.Z_HULL_TOP


def turret_zone(c, n):
    if n[1] < -0.5:
        return L.Z_DARK
    if abs(n[0]) > 0.62:
        return L.Z_TURRET_SIDE
    if n[2] < -0.55:
        return L.Z_TURRET_FRONT
    if n[2] > 0.55:
        return L.Z_TURRET_REAR
    return L.Z_TURRET_TOP


def ring_from_section(sec):
    z, yb, yw, ys, yd, wb, ww, wd, wt = sec
    return [
        (wb, yb, z), (ww, yw, z), (wd, ys, z), (wt, yd, z),
        (-wt, yd, z), (-wd, ys, z), (-ww, yw, z), (-wb, yb, z),
    ]


def drum(p: Part, cx, cz, ybase, ytop, r, wrap_rect, cap_zone=None, n=8):
    """Vertical n-gon drum with parametric wrap UVs + optional top cap."""
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
        zc = Zone(cap_zone.rect, ('x', 'z'),
                  ((cx - r, cx + r), (cz - r, cz + r)))
        p.add_face(ngon_ring((cx, ytop, cz), r, n=n, axis='y'), zone=zc,
                   flip=True)


# ── body ────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    rings = [ring_from_section(s) for s in L.HULL_SECTIONS]
    loft(p, rings, hull_zone, cap_start=L.Z_GLACIS, cap_end=L.Z_HULL_REAR)

    for (hx, hz) in L.HATCHES:
        chamfer_box(p, (hx, L.HULL_DECK_Y + L.HATCH_SIZE[1] / 2 - 0.02, hz),
                    L.HATCH_SIZE, 0.025,
                    {'+y': L.Z_HATCH, '+x': L.Z_HATCH, '-x': L.Z_HATCH,
                     '+z': L.Z_HATCH, '-z': L.Z_HATCH}, skip=('-y',))
    x, y, z, w, h, d = L.SENSOR_BAR
    chamfer_box(p, (x, y, z), (w, h, d), 0.035,
                {'+y': L.Z_SENSOR, '-z': L.Z_SENSOR, '+x': L.Z_SENSOR,
                 '-x': L.Z_SENSOR, '+z': L.Z_SENSOR}, skip=('-y',))
    # raised engine deck (grille painted on the +y face)
    x, y, z, w, h, d = L.ENG_DECK
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+y': L.Z_INTAKE, '+x': L.Z_ENGDECK, '-x': L.Z_ENGDECK,
                 '+z': L.Z_ENGDECK, '-z': L.Z_ENGDECK}, skip=('-y',))
    # exhaust stacks
    for (ex, ey, ez) in L.EXHAUST_STACKS:
        chamfer_box(p, (ex, ey, ez), L.STACK_SIZE, 0.05,
                    {'+y': L.Z_STACK_TOP, '+x': L.Z_EXHAUST, '-x': L.Z_EXHAUST,
                     '+z': L.Z_EXHAUST, '-z': L.Z_EXHAUST}, skip=('-y',))
    # deck-edge stowage
    for (sx, sy, sz, sw, sh, sd) in L.STOWS:
        chamfer_box(p, (sx, sy, sz), (sw, sh, sd), 0.04,
                    {'+y': L.Z_STOW, '+x': L.Z_STOW, '-x': L.Z_STOW,
                     '+z': L.Z_STOW, '-z': L.Z_STOW}, skip=('-y',))
    # vertical fuel drums on the rear plate
    for (dx, dy, dz) in L.DRUMS:
        drum(p, dx, dz, dy - L.DRUM_H / 2, dy + L.DRUM_H / 2, L.DRUM_R,
             L.Z_DRUM, cap_zone=L.Z_DRUM_CAP)
    # spare track links half-embedded on the glacis
    for (sx, sy, sz) in L.SPARES:
        chamfer_box(p, (sx, sy, sz), L.SPARE_SIZE, 0.02,
                    {'+y': L.Z_SPARE, '+x': L.Z_SPARE, '-x': L.Z_SPARE,
                     '+z': L.Z_SPARE, '-z': L.Z_SPARE}, skip=('-y',))
    # tow cable along the right deck edge
    x, y, z, w, h, d = L.TOWCABLE
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': L.Z_TRIM, '+x': L.Z_TRIM, '-x': L.Z_TRIM,
                 '+z': L.Z_TRIM, '-z': L.Z_TRIM}, skip=('-y',))
    # antenna base
    x, y, z, w, h, d = L.ANT
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': L.Z_ANT, '+x': L.Z_ANT, '-x': L.Z_ANT,
                 '+z': L.Z_ANT, '-z': L.Z_ANT}, skip=('-y',))
    # turret2 sponson pedestal (front-left)
    x, y, z, w, h, d = L.SPONSON
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+y': L.Z_SPONSON_TOP, '+x': L.Z_SPONSON, '-x': L.Z_SPONSON,
                 '+z': L.Z_SPONSON, '-z': L.Z_SPONSON, '-y': L.Z_DARK})
    return p


# ── tracks ──────────────────────────────────────────────────────────────

def build_tracks_l():
    p = Part('tracks_l')
    prof = L.TRACK_PROFILE
    w = L.TRACK_HALF_W
    n = len(prof)

    outer = [(w, y, z) for (z, y) in prof]
    inner = [(-w, y, z) for (z, y) in prof]
    p.add_face(outer, zone=L.Z_TRACK_SIDE, flip=True)
    p.add_face(inner, zone=L.Z_TRACK_SIDE)

    # wrap: arc-length parametric UV into Z_TRACK_WRAP
    x0, y0, x1, y1 = L.Z_TRACK_WRAP
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

    # hubs (sprocket + idler) on the outer face
    for (hz, hy, hr) in (L.HUB_FRONT, L.HUB_REAR):
        rings = [ngon_ring((w - 0.01, hy, hz), hr, n=8, axis='x'),
                 ngon_ring((w + 0.11, hy, hz), hr, n=8, axis='x')]
        hx0, hy0, hx1, hy1 = L.Z_HUB
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
        cap = ngon_ring((w + 0.11, hy, hz), hr, n=8, axis='x')
        zc = Zone(L.Z_HUB_CAP.rect, ('z', 'y'),
                  ((hz - hr, hz + hr), (hy + hr, hy - hr)))
        p.add_face(cap, zone=zc)

    # fender top plate, sitting flush on the pod top
    (fz0, fz1), fy, fh, fw = L.FENDER
    chamfer_box(p, (0.0, fy + fh / 2 - 0.02, (fz0 + fz1) / 2),
                (fw, fh, fz1 - fz0), 0.045,
                {'+y': L.Z_FENDER, '+x': L.Z_TRACK_SIDE, '-x': L.Z_TRACK_SIDE,
                 '+z': L.Z_TRACK_SIDE, '-z': L.Z_TRACK_SIDE}, skip=('-y',))
    # hanging side-skirt plates (two segments with a service gap)
    for (sx, sy, sw, sh, sz0, sz1) in L.SKIRTS:
        chamfer_box(p, (sx, sy, (sz0 + sz1) / 2), (sw, sh, sz1 - sz0), 0.025,
                    {'+x': L.Z_TRACK_SIDE, '-x': L.Z_DARK, '+y': L.Z_TRACK_SIDE,
                     '-y': L.Z_DARK, '+z': L.Z_TRACK_SIDE, '-z': L.Z_TRACK_SIDE})
    # mud flaps front/rear
    for (mx, my, mz) in L.MUDFLAPS:
        chamfer_box(p, (mx, my, mz), L.MUDFLAP_SIZE, 0.02,
                    {'+z': L.Z_MUDFLAP, '-z': L.Z_MUDFLAP, '+x': L.Z_MUDFLAP,
                     '-x': L.Z_MUDFLAP, '+y': L.Z_MUDFLAP, '-y': L.Z_DARK})
    return p


# ── main turret ─────────────────────────────────────────────────────────

def build_turret():
    p = Part('turret')
    rings = [ring_from_section(s) for s in L.TURRET_SECTIONS]
    loft(p, rings, turret_zone, cap_start=L.Z_TURRET_FRONT, cap_end=L.Z_TURRET_REAR)

    # commander sight drum
    sx, sz, sr, sh = L.SIGHT_DRUM
    drum(p, sx, sz, L.SIGHT_YBASE, L.SIGHT_YBASE + sh, sr, L.Z_SIGHT,
         cap_zone=L.Z_SIGHT_TOP)

    # cheek appliqué plates
    for (cx, cy, cz) in L.CHEEKS:
        chamfer_box(p, (cx, cy, cz), L.CHEEK_SIZE, 0.035,
                    {'+y': L.Z_TURRET_SIDE, '-y': L.Z_DARK,
                     '+x': L.Z_TURRET_SIDE, '-x': L.Z_TURRET_SIDE,
                     '+z': L.Z_TURRET_SIDE, '-z': L.Z_TURRET_FRONT})

    x, y, z, w, h, d = L.SENSOR_POD
    chamfer_box(p, (x, y, z), (w, h, d), 0.04,
                {'+y': L.Z_POD, '+x': L.Z_POD, '-x': L.Z_POD,
                 '-z': L.Z_POD, '+z': L.Z_POD, '-y': L.Z_DARK})
    x, y, z, w, h, d = L.BUSTLE
    chamfer_box(p, (x, y, z), (w, h, d), 0.055,
                {'+y': L.Z_BUSTLE, '+x': L.Z_BUSTLE, '-x': L.Z_BUSTLE,
                 '+z': L.Z_BUSTLE, '-z': L.Z_BUSTLE}, skip=('-y',))
    for (mx, my, mz) in L.SMOKES:
        chamfer_box(p, (mx, my, mz), L.SMOKE_SIZE, 0.035,
                    {'+y': L.Z_SMOKE, '+x': L.Z_SMOKE, '-x': L.Z_SMOKE,
                     '-z': L.Z_SMOKE, '+z': L.Z_SMOKE, '-y': L.Z_DARK})
    return p


# ── main barrel (twin tubes) ────────────────────────────────────────────

def build_barrel():
    p = Part('barrel')
    x, y, z, w, h, d = L.BREECH
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+y': L.Z_BREECH, '+x': L.Z_BREECH, '-x': L.Z_BREECH,
                 '+z': L.Z_BREECH, '-z': L.Z_BREECH, '-y': L.Z_BREECH})
    # inter-tube cradle sleeve
    x, y, z, w, h, d = L.SLEEVE
    chamfer_box(p, (x, y, z), (w, h, d), 0.04,
                {'+y': L.Z_SLEEVE, '-y': L.Z_SLEEVE, '+x': L.Z_SLEEVE_S,
                 '-x': L.Z_SLEEVE_S, '+z': L.Z_SLEEVE_S, '-z': L.Z_SLEEVE_S})
    for side in (1.0, -1.0):
        xo = side * L.TUBE_X
        tube(p, L.TUBE_STATIONS, L.Z_BARREL_WRAP, n=8, cap_end=L.Z_TUBE_CAP,
             xoff=xo)
        (cz0, cz1), cr = L.CAP_RING
        tube(p, [(cz0, cr), (cz1, cr)], L.Z_CAP_RING, n=8,
             cap_start=L.Z_TUBE_CAP, cap_end=L.Z_TUBE_CAP, xoff=xo)
        bw, bh, bd = L.BRAKE_SIZE
        chamfer_box(p, (xo, 0.0, L.BRAKE_Z), (bw, bh, bd), 0.06,
                    {'+y': L.Z_BRAKE, '-y': L.Z_BRAKE, '+x': L.Z_BRAKE,
                     '-x': L.Z_BRAKE, '-z': L.Z_BRAKE, '+z': L.Z_BRAKE})
        (tz0, tz1), tr = L.TIP_STUB
        tube(p, [(tz0, tr), (tz1, tr)], L.Z_CAP_RING, n=8,
             cap_end=L.Z_TUBE_CAP, xoff=xo)
    return p


# ── secondary turret (independent, front-left) ─────────────────────────

def build_turret2():
    p = Part('turret2')
    drum(p, 0.0, 0.0, -0.03, L.T2_H, L.T2_R, L.Z_T2_WRAP,
         cap_zone=L.Z_T2_TOP, n=10)
    # mantlet block where barrel2 exits
    bx, by, bz = L.BARREL2_OFF
    chamfer_box(p, (bx, by, -L.T2_R + 0.02), (0.52, 0.44, 0.34), 0.04,
                {'+y': L.Z_B2_CELL, '+x': L.Z_B2_CELL, '-x': L.Z_B2_CELL,
                 '-z': L.Z_B2_CELL, '+z': L.Z_B2_CELL, '-y': L.Z_DARK})
    # roof sensor
    x, y, z, w, h, d = L.T2_SENSOR
    chamfer_box(p, (x, y, z), (w, h, d), 0.02,
                {'+y': L.Z_B2_CELL, '+x': L.Z_B2_CELL, '-x': L.Z_B2_CELL,
                 '-z': L.Z_B2_CELL, '+z': L.Z_B2_CELL}, skip=('-y',))
    return p


def build_barrel2():
    p = Part('barrel2')
    tube(p, L.B2_STATIONS, L.Z_B2_WRAP, n=8, cap_end=L.Z_TUBE_CAP)
    x, y, z, w, h, d = L.B2_BRAKE
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': L.Z_B2_CELL, '-y': L.Z_B2_CELL, '+x': L.Z_B2_CELL,
                 '-x': L.Z_B2_CELL, '-z': L.Z_B2_CELL, '+z': L.Z_B2_CELL})
    return p


# ── assembly ────────────────────────────────────────────────────────────

def build_all():
    body = build_body()
    tl = build_tracks_l()
    tr = mirror_x(tl, 'tracks_r')
    tur = build_turret()
    bar = build_barrel()
    t2 = build_turret2()
    b2 = build_barrel2()

    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=body),
        dict(name='tracks_l', parent=0, offset=L.TRACK_OFF, part=tl),
        dict(name='tracks_r', parent=0,
             offset=(-L.TRACK_OFF[0], L.TRACK_OFF[1], L.TRACK_OFF[2]), part=tr),
        dict(name='turret', parent=0, offset=L.TURRET_OFF, part=tur),
        dict(name='barrel', parent=3, offset=L.BARREL_OFF, part=bar),
        dict(name='muzzle', parent=4, offset=L.MUZZLE_OFF, part=None),
        dict(name='muzzle_l', parent=4,
             offset=(L.TUBE_X, 0.0, L.MUZZLE_OFF[2]), part=None),
        dict(name='muzzle_r', parent=4,
             offset=(-L.TUBE_X, 0.0, L.MUZZLE_OFF[2]), part=None),
        dict(name='turret2', parent=0, offset=L.TURRET2_OFF, part=t2),
        dict(name='barrel2', parent=8, offset=L.BARREL2_OFF, part=b2),
        dict(name='muzzle2', parent=9, offset=L.MUZZLE2_OFF, part=None),
        dict(name='exhaust', parent=0, offset=L.EXHAUST_OFF, part=None),
    ]
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_heavy] total tris: {total}')
