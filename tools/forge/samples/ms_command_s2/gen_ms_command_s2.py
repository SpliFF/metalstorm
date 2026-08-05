"""gen_ms_command_s2 — assemble ms_command_s2 and export .gltf/.bin.

Tracked command vehicle (tanks-row s2, ~7.5 m): turretless armoured
casemate hull, map-table awning over the rear porch, whip antenna farm,
rotating sensor head (`dish`, idle sweep) and a separate `banner` piece
(team-mask heavy). THE commander-as-unit body.

Run: python3 gen_ms_command_s2.py   → OUT/ms_command_s2{,_png}.gltf + .bin
"""
from __future__ import annotations
import os
import numpy as np

import ms_command_s2_layout as L    # sets meshlib.ATLAS = 1024
from meshlib import Part, Zone, loft, chamfer_box, ngon_ring, mirror_x, limb
from gltf_export import export

STEM = 'ms_command_s2'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   '..', '..', 'out')


# ── zone classifiers ─────────────────────────────────────────────────────

def hull_zone(c, n):
    if n[1] < -0.5:
        return L.C_DARK
    if abs(n[0]) > 0.62:
        return L.C_HULL_SIDE
    if n[2] < -0.55:
        return L.C_GLACIS
    if n[2] > 0.55:
        return L.C_HULL_REAR
    return L.C_HULL_TOP


def cabin_zone(c, n):
    if n[1] < -0.5:
        return L.C_DARK
    if abs(n[0]) > 0.62:
        return L.C_CABIN_SIDE
    if n[2] < -0.55:
        return L.C_CABIN_FRONT
    if n[2] > 0.55:
        return L.C_CABIN_REAR
    return L.C_CABIN_TOP


def ring_from_section(sec):
    z, yb, yw, ys, yd, wb, ww, wd, wt = sec
    return [
        (wb, yb, z), (ww, yw, z), (wd, ys, z), (wt, yd, z),
        (-wt, yd, z), (-wd, ys, z), (-ww, yw, z), (-wb, yb, z),
    ]


def box(p, center, size, zones, skip=()):
    """Un-chamfered box (bevel skipped: edges below the bevel-size floor)."""
    chamfer_box(p, center, size, 0.0, zones, skip=skip)


# ── body ────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')

    # hull
    rings = [ring_from_section(s) for s in L.HULL_SECTIONS]
    loft(p, rings, hull_zone, cap_start=L.C_GLACIS, cap_end=L.C_HULL_REAR)

    # casemate cabin
    rings = [ring_from_section(s) for s in L.CABIN_SECTIONS]
    loft(p, rings, cabin_zone, cap_start=L.C_CABIN_FRONT, cap_end=L.C_CABIN_REAR)

    # glacis sensor visor bar
    x, y, z, w, h, d = L.SENSOR_BAR
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': L.C_SENSOR, '-z': L.C_SENSOR, '+x': L.C_SENSOR,
                 '-x': L.C_SENSOR, '+z': L.C_SENSOR}, skip=('-y',))

    # driver hatch (front deck) + commander hatch (cabin roof)
    for (hx, hy, hz, hw, hh, hd) in (L.DRIVER_HATCH, L.ROOF_HATCH):
        chamfer_box(p, (hx, hy + hh / 2 - 0.012, hz), (hw, hh, hd), 0.015,
                    {'+y': L.C_HATCH, '+x': L.C_HATCH, '-x': L.C_HATCH,
                     '+z': L.C_HATCH, '-z': L.C_HATCH}, skip=('-y',))

    # engine intake grille on the front deck
    x, y, z, w, h, d = L.INTAKE
    chamfer_box(p, (x, y, z), (w, h, d), 0.02,
                {'+y': L.C_INTAKE, '+x': L.C_HULL_SIDE, '-x': L.C_HULL_SIDE,
                 '+z': L.C_HULL_SIDE, '-z': L.C_HULL_SIDE}, skip=('-y',))

    # exhaust mufflers on the forward sponsons
    for (ex, ey, ez) in L.EXHAUSTS:
        chamfer_box(p, (ex, ey, ez), L.EXHAUST_SIZE, 0.03,
                    {'+y': L.C_EXHAUST, '+x': L.C_EXHAUST, '-x': L.C_EXHAUST,
                     '+z': L.C_EXHAUST, '-z': L.C_EXHAUST}, skip=('-y',))

    # sponson stowage bins
    for (sx, sy, sz) in L.STOW_BINS:
        chamfer_box(p, (sx, sy, sz), L.STOW_SIZE, 0.03,
                    {'+y': L.C_STOW_TOP, '+x': L.C_STOW, '-x': L.C_STOW,
                     '+z': L.C_STOW, '-z': L.C_STOW}, skip=('-y',))

    # ── map-table awning over the rear porch ──
    z0, z1 = L.AWNING_Z
    xw, yf, yr, th = L.AWNING_XW, L.AWNING_YF, L.AWNING_YR, L.AWNING_TH
    p.add_face([(-xw, yf, z0), (-xw, yr, z1), (xw, yr, z1), (xw, yf, z0)],
               zone=L.C_AWNING_TOP)
    p.add_face([(-xw, yf - th, z0), (xw, yf - th, z0),
                (xw, yr - th, z1), (-xw, yr - th, z1)], zone=L.C_AWNING_BOT)
    p.add_face([(xw, yf - th, z0), (xw, yf, z0), (xw, yr, z1),
                (xw, yr - th, z1)], zone=L.C_AWNING_EDGE)
    p.add_face([(-xw, yf - th, z0), (-xw, yr - th, z1), (-xw, yr, z1),
                (-xw, yf, z0)], zone=L.C_AWNING_EDGE)
    p.add_face([(-xw, yf - th, z0), (-xw, yf, z0), (xw, yf, z0),
                (xw, yf - th, z0)], zone=L.C_AWNING_EDGE)
    p.add_face([(-xw, yr - th, z1), (xw, yr - th, z1), (xw, yr, z1),
                (-xw, yr, z1)], zone=L.C_AWNING_EDGE)

    # awning posts
    for (px, pz) in L.POSTS:
        top = yf - th if pz < (z0 + z1) / 2 else yr - th
        top = yf - th + (yr - yf) * (pz - z0) / (z1 - z0) - 0.0
        limb(p, (px, 1.38, pz), (px, top + 0.02, pz), 0.035, 0.03,
             L.C_TRIM, n=4)

    # map table
    x, y, z, w, h, d = L.TABLE
    chamfer_box(p, (x, y, z), (w, h, d), 0.025,
                {'+y': L.C_TABLE_TOP, '+x': L.C_TABLE_SIDE2,
                 '-x': L.C_TABLE_SIDE2, '+z': L.C_TABLE_SIDE,
                 '-z': L.C_TABLE_SIDE}, skip=('-y',))

    # whip antenna farm
    for (base, tip) in L.WHIPS:
        limb(p, base, tip, 0.030, 0.012, L.C_ANT, n=3)
    for (cx, cy, cz) in L.COILS:
        box(p, (cx, cy, cz), L.COIL_SIZE,
            {'+y': L.C_TRIM_BOX, '+x': L.C_TRIM_BOX, '-x': L.C_TRIM_BOX,
             '+z': L.C_TRIM_BOX, '-z': L.C_TRIM_BOX}, skip=('-y',))

    # sensor mast (static; `dish` pivots on its top)
    mx, my, mz = L.MAST_BASE
    limb(p, (mx, my, mz), (mx, L.MAST_TOP_Y, mz), 0.055, 0.042,
         L.C_MAST, n=6)
    return p


# ── tracks ──────────────────────────────────────────────────────────────

def build_tracks_l():
    p = Part('tracks_l')
    prof = L.TRACK_PROFILE
    w = L.TRACK_HALF_W
    n = len(prof)

    outer = [(w, y, z) for (z, y) in prof]
    inner = [(-w, y, z) for (z, y) in prof]
    # profile is CCW in the (z,y) plane -> raw fan normal is -X;
    # outer (+x) face needs +X, inner needs -X.
    p.add_face(outer, zone=L.C_TRACK_SIDE, flip=True)
    p.add_face(inner, zone=L.C_TRACK_SIDE)

    # wrap: arc-length parametric UV into C_TRACK_WRAP
    x0, y0, x1, y1 = L.C_TRACK_WRAP
    seg = [np.hypot(prof[(i + 1) % n][0] - prof[i][0],
                    prof[(i + 1) % n][1] - prof[i][1]) for i in range(n)]
    total = sum(seg)
    acc = 0.0
    centroid = np.array([0.0, sum(y for _, y in prof) / n,
                         sum(z for z, _ in prof) / n])
    for i in range(n):
        j = (i + 1) % n
        u0 = (x0 + (x1 - x0) * acc / total) / 1024.0
        acc += seg[i]
        u1 = (x0 + (x1 - x0) * acc / total) / 1024.0
        va, vb = y0 / 1024.0, y1 / 1024.0
        quad = [(w, prof[i][1], prof[i][0]), (-w, prof[i][1], prof[i][0]),
                (-w, prof[j][1], prof[j][0]), (w, prof[j][1], prof[j][0])]
        uvs = [(u0, va), (u0, vb), (u1, vb), (u1, va)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        if np.dot(nrm, ctr - centroid) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)

    # fender top plate, sitting flush on the pod top
    (fz0, fz1), fy, fh, fw = L.FENDER
    chamfer_box(p, (0.0, fy + fh / 2 - 0.02, (fz0 + fz1) / 2),
                (fw, fh, fz1 - fz0), 0.03,
                {'+y': L.C_FENDER, '+x': L.C_TRACK_SIDE, '-x': L.C_TRACK_SIDE,
                 '+z': L.C_TRACK_SIDE, '-z': L.C_TRACK_SIDE}, skip=('-y',))
    # hanging side-skirt plate over the upper track run
    sx, sy, sw, sh, sz0, sz1 = L.SKIRT
    chamfer_box(p, (sx, sy, (sz0 + sz1) / 2), (sw, sh, sz1 - sz0), 0.018,
                {'+x': L.C_TRACK_SIDE, '-x': L.C_DARK, '+y': L.C_TRACK_SIDE,
                 '-y': L.C_DARK, '+z': L.C_TRACK_SIDE, '-z': L.C_TRACK_SIDE})
    return p


# ── dish (rotating sensor head) ─────────────────────────────────────────

def build_dish():
    p = Part('dish')
    # yoke column + forward arm
    limb(p, (0, 0, 0), (0, 0.34, 0), 0.05, 0.045, L.C_MAST, n=6)
    limb(p, (0, 0.30, 0), (0, 0.30, -0.24), 0.038, 0.032, L.C_TRIM, n=4)
    # open scanning dish: 12-gon plate, near-vertical (scans the horizon)
    tilt = np.radians(L.DISH_TILT)
    ctr = np.array(L.DISH_CTR)
    normal_dir = np.array([0.0, np.sin(tilt), -np.cos(tilt)])
    u = np.array([1.0, 0.0, 0.0])
    v = np.cross(normal_dir, u)
    ring = [tuple(ctr + L.DISH_R * (np.cos(t) * u + np.sin(t) * v))
            for t in np.linspace(0, 2 * np.pi, 13)[:-1]]
    p.add_face(ring, zone=L.C_DISH_F, flip=True)
    p.add_face(ring, zone=L.C_DISH_B)
    # feed arm + head
    tip = tuple(ctr + normal_dir * 0.42)
    limb(p, tuple(ctr), tip, 0.028, 0.02, L.C_TRIM, n=4)
    box(p, tip, (0.09, 0.09, 0.09),
        {'+y': L.C_LIGHT, '-y': L.C_LIGHT, '+x': L.C_LIGHT,
         '-x': L.C_LIGHT, '+z': L.C_LIGHT, '-z': L.C_LIGHT})
    return p


# ── banner ──────────────────────────────────────────────────────────────

def build_banner():
    p = Part('banner')
    # mount plinth, pole, finial beacon, trailing gaff
    box(p, (0, 0.05, 0), (0.14, 0.10, 0.14),
        {'+y': L.C_TRIM_BOX, '+x': L.C_TRIM_BOX, '-x': L.C_TRIM_BOX,
         '+z': L.C_TRIM_BOX, '-z': L.C_TRIM_BOX}, skip=('-y',))
    limb(p, (0, 0.08, 0), (0, L.POLE_H, 0), 0.032, 0.022, L.C_POLE, n=4)
    box(p, (0, L.POLE_H + 0.05, 0), (0.08, 0.11, 0.08),
        {'+y': L.C_LIGHT, '-y': L.C_LIGHT, '+x': L.C_LIGHT,
         '-x': L.C_LIGHT, '+z': L.C_LIGHT, '-z': L.C_LIGHT})
    limb(p, (0, L.GAFF_Y, -0.02), (0, L.GAFF_Y, L.GAFF_LEN), 0.02, 0.016,
         L.C_TRIM, n=4)

    # cloth: 4-column strip with a baked wave, both sides
    cols = []
    for i, cz in enumerate(L.CLOTH_COLS_Z):
        wx = L.CLOTH_WAVE_X[i]
        ty, by = L.CLOTH_TOP_Y[i], L.CLOTH_BOT_Y[i]
        my = (ty + by) / 2
        cols.append([(wx * 0.4, ty, cz), (wx * 1.4, my, cz), (wx, by, cz)])
    for c in range(len(cols) - 1):
        for r in range(2):
            quad = [cols[c][r], cols[c][r + 1],
                    cols[c + 1][r + 1], cols[c + 1][r]]
            p.add_face(quad, zone=L.C_BANNER_F, flip=True)
            p.add_face(quad, zone=L.C_BANNER_B)
    return p


# ── clips ───────────────────────────────────────────────────────────────

def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    T = 12.0
    dish_keys = [(T * i / 4, qy(90.0 * i)) for i in range(5)]
    sway = [(0.0, qy(0)), (T * 0.25, qy(6)), (T * 0.5, qy(0)),
            (T * 0.75, qy(-6)), (T, qy(0))]
    return [{'name': 'idle', 'channels': [('dish', 'rotation', dish_keys),
                                          ('banner', 'rotation', sway)]}]


# ── assembly ────────────────────────────────────────────────────────────

def build_all():
    body = build_body()
    tl = build_tracks_l()
    tr = mirror_x(tl, 'tracks_r')
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=body),
        dict(name='tracks_l', parent=0, offset=L.TRACK_OFF, part=tl),
        dict(name='tracks_r', parent=0,
             offset=(-L.TRACK_OFF[0], L.TRACK_OFF[1], L.TRACK_OFF[2]), part=tr),
        dict(name='dish', parent=0, offset=L.DISH_OFF, part=build_dish()),
        dict(name='banner', parent=0, offset=L.BANNER_OFF, part=build_banner()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=build_clips(),
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=build_clips(),
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
