"""gen_ms_tank_farm — build ms_tank_farm (fuel tank farm) + idle clip.

Three 8 m storage tanks (10-gon drums with sloped roofs, wind girders
and foundation skirts) inside a sloped concrete bund wall, front
collection header with per-tank outlet nozzles, export line crossing
the bund toward the paired ms_oil_derrick (flange ends at the pad edge
z=-8.3), two header valves + export valve station with cabinet, spiral
stairs on the outer tanks with roof landings + hatches, bund crossover
step, hazard placard boards and bollards on the apron. Only the roof
turbine `vent` on the centre tank animates (idle clip); `fumes` is an
empty FX attachment above it.

Usage: python3 gen_ms_tank_farm.py
"""
from __future__ import annotations
import numpy as np

import ms_tank_farm_layout as T    # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, chamfer_box, ngon_ring, limb
from gltf_export import export

STEM = 'ms_tank_farm'
OUT = 'out'


# ── helpers (forge patterns, per gen_factory.py) ─────────────────────────

def quad_out(p, verts, outward, zone):
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, np.asarray(outward, float)) > 0
               else verts[::-1], zone=zone)


def drum_y(p, cx, cz, ybase, ytop, r0, r1, wrap_rect, cap_zone=None, n=10):
    """Vertical drum cx/cz, radius r0 at base -> r1 at top; parametric
    wrap UVs (u around, v down = base at rect bottom)."""
    ra = ngon_ring((cx, ybase, cz), r0, n=n, axis='y')
    rb = ngon_ring((cx, ytop, cz), r1, n=n, axis='y')
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
                  ((cx - r1, cx + r1), (cz - r1, cz + r1)))
        p.add_face(ngon_ring((cx, ytop, cz), r1, n=n, axis='y'),
                   zone=zc, flip=True)


def hose(p, pts, r, rect=None, collars=True, n=6):
    rect = rect or T.PIPEW
    for i in range(len(pts) - 1):
        limb(p, pts[i], pts[i + 1], r, r, rect, n=n)
    if collars:
        for i in range(1, len(pts) - 1):
            a, b = np.asarray(pts[i - 1]), np.asarray(pts[i])
            d = b - a
            d = d / max(1e-9, np.linalg.norm(d))
            c0 = tuple(b - d * 0.12)
            c1 = tuple(b + d * 0.12)
            limb(p, c0, c1, r * 1.28, r * 1.28, rect, n=n)


def box(p, center, size, zone, ch=0.04, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def pbox(p, center, size, zone):
    """Plain 5-face box (bottom skipped) — cheap greeble, no bevel."""
    cx, cy, cz = center
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    quad_out(p, [(cx - hx, cy + hy, cz - hz), (cx + hx, cy + hy, cz - hz),
                 (cx + hx, cy + hy, cz + hz), (cx - hx, cy + hy, cz + hz)],
             (0, 1, 0), zone)
    for sx in (-1, 1):
        quad_out(p, [(cx + sx * hx, cy - hy, cz - hz),
                     (cx + sx * hx, cy - hy, cz + hz),
                     (cx + sx * hx, cy + hy, cz + hz),
                     (cx + sx * hx, cy + hy, cz - hz)], (sx, 0, 0), zone)
    for sz in (-1, 1):
        quad_out(p, [(cx - hx, cy - hy, cz + sz * hz),
                     (cx + hx, cy - hy, cz + sz * hz),
                     (cx + hx, cy + hy, cz + sz * hz),
                     (cx - hx, cy + hy, cz + sz * hz)], (0, 0, sz), zone)


def handwheel(p, cx, wy, cz, stem_y0):
    """Valve: stem riser + horizontal 8-gon handwheel disc."""
    limb(p, (cx, stem_y0, cz), (cx, wy - 0.04, cz), 0.07, 0.06,
         T.TRIM.rect, n=4)
    drum_y(p, cx, cz, wy - 0.05, wy + 0.05, T.WHEEL_R, T.WHEEL_R,
           T.WHEELW, n=8)
    zc = Zone(T.WHEELC, ('x', 'z'),
              ((cx - T.WHEEL_R, cx + T.WHEEL_R),
               (cz - T.WHEEL_R, cz + T.WHEEL_R)))
    p.add_face(ngon_ring((cx, wy + 0.05, cz), T.WHEEL_R, n=8, axis='y'),
               zone=zc, flip=True)
    p.add_face(ngon_ring((cx, wy - 0.05, cz), T.WHEEL_R, n=8, axis='y'),
               zone=zc)


def spiral_stair(p, tx, tz, a0_deg, a1_deg):
    """Helical tread ribbon + outer rail ribbon around a tank."""
    a0, a1 = np.radians(a0_deg), np.radians(a1_deg)
    y0, y1 = T.PAD_TOP + 0.15, T.TANK_TOP_Y
    x0r, sy0, x1r, sy1 = T.STAIR
    tread_v = (sy0 + 4, sy0 + (sy1 - sy0) * 0.42)
    rail_v = (sy0 + (sy1 - sy0) * 0.5, sy1 - 4)

    def pt(a, r, y):
        return (tx + r * np.cos(a), y, tz + r * np.sin(a))
    n = T.STAIR_SEGS
    for i in range(n):
        f0, f1 = i / n, (i + 1) / n
        aa, ab = a0 + (a1 - a0) * f0, a0 + (a1 - a0) * f1
        ya, yb = y0 + (y1 - y0) * f0, y0 + (y1 - y0) * f1
        u0 = (x0r + (x1r - x0r) * f0) / M.ATLAS
        u1 = (x0r + (x1r - x0r) * f1) / M.ATLAS
        # tread ribbon (top face only)
        quad = [pt(aa, T.STAIR_RI, ya), pt(aa, T.STAIR_RO, ya),
                pt(ab, T.STAIR_RO, yb), pt(ab, T.STAIR_RI, yb)]
        uvs = [(u0, tread_v[1] / M.ATLAS), (u0, tread_v[0] / M.ATLAS),
               (u1, tread_v[0] / M.ATLAS), (u1, tread_v[1] / M.ATLAS)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        if nrm[1] < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)
        # outer rail ribbon (double-sided thin wall)
        rq = [pt(aa, T.STAIR_RO, ya), pt(ab, T.STAIR_RO, yb),
              pt(ab, T.STAIR_RO, yb + T.STAIR_RAIL),
              pt(aa, T.STAIR_RO, ya + T.STAIR_RAIL)]
        ruv = [(u0, rail_v[1] / M.ATLAS), (u1, rail_v[1] / M.ATLAS),
               (u1, rail_v[0] / M.ATLAS), (u0, rail_v[0] / M.ATLAS)]
        p.add_face(rq, uvs=ruv)
        p.add_face(rq[::-1], uvs=ruv[::-1])
    # roof landing at the top end (local zone: LAND plate rect)
    ae = a1
    lc = pt(ae, (T.STAIR_RI + T.STAIR_RO) / 2, y1 + 0.06)
    lz = Zone(T.LAND, ('x', 'z'),
              ((lc[0] - 0.6, lc[0] + 0.6), (lc[2] - 0.6, lc[2] + 0.6)))
    pbox(p, lc, (1.1, 0.12, 1.1), lz)


# ── the site ─────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    # concrete pad
    x, y, z, w, h, d = T.PAD
    chamfer_box(p, (x, y, z), (w, h, d), 0.08,
                {'+y': T.PADT, '+x': T.PADS, '-x': T.PADS,
                 '+z': T.PADS_F, '-z': T.PADS_F}, skip=('-y',))
    # bund wall ring: mitred quads, sloped outer face + coping + inner face
    yb, yt = T.PAD_TOP, T.BUND_H

    def ring(hx, z0, z1, yy):
        return [(-hx, yy, z0), (hx, yy, z0), (hx, yy, z1), (-hx, yy, z1)]
    r_bo = ring(T.BUND_BO_X, T.BUND_BO_Z0, T.BUND_BO_Z1, yb)
    r_to = ring(T.BUND_TO_X, T.BUND_TO_Z0, T.BUND_TO_Z1, yt)
    r_ti = ring(T.BUND_IN_X, T.BUND_IN_Z0, T.BUND_IN_Z1, yt)
    r_bi = ring(T.BUND_IN_X, T.BUND_IN_Z0, T.BUND_IN_Z1, yb)
    for j in range(4):
        k = (j + 1) % 4
        c = np.mean([r_bo[j], r_bo[k]], axis=0)
        out = np.array([c[0], 0, c[2]])
        out = out / max(1e-9, np.linalg.norm(out))
        zone_o = T.BUND_OX if abs(out[0]) > abs(out[2]) else T.BUND_OZ
        quad_out(p, [r_bo[j], r_bo[k], r_to[k], r_to[j]], tuple(out), zone_o)
        quad_out(p, [r_to[j], r_to[k], r_ti[k], r_ti[j]], (0, 1, 0),
                 T.BUND_TOP)
        quad_out(p, [r_ti[j], r_ti[k], r_bi[k], r_bi[j]], tuple(-out), zone_o)
    # tanks: skirt, shell, wind girder, roof slope + cap
    for (tx, tz) in T.TANKS:
        drum_y(p, tx, tz, T.PAD_TOP, T.SKIRT_Y1, T.SKIRT_R, T.SKIRT_R,
               T.SKIRTW, n=T.TANK_N)
        drum_y(p, tx, tz, T.PAD_TOP, T.TANK_TOP_Y, T.TANK_R, T.TANK_R,
               T.TANKW, n=T.TANK_N)
        drum_y(p, tx, tz, T.GIRD_Y0, T.GIRD_Y1, T.GIRD_R, T.GIRD_R,
               T.GIRDW, n=T.TANK_N)
        drum_y(p, tx, tz, T.TANK_TOP_Y, T.ROOF_Y, T.TANK_R, T.ROOF_R,
               T.ROOFW, cap_zone=T.TANK_TOP, n=T.TANK_N)
    # roof hatches near the stair landings (outer tanks; local zone windows)
    for (hx, hz) in ((T.TANKS[0][0] + 1.15, T.TANKS[0][1] - 0.9),
                     (T.TANKS[2][0] - 1.15, T.TANKS[2][1] - 0.9)):
        hzone = Zone(T.HATCH.rect, ('x', 'z'),
                     ((hx - 0.7, hx + 0.7), (hz - 0.7, hz + 0.7)))
        pbox(p, (hx, T.ROOF_Y + 0.2, hz), (0.9, 0.4, 0.9), hzone)
    # tank outlet nozzles -> front collection header
    hy, hz = T.HEADER_Y, T.HEADER_Z
    for (tx, tz) in T.TANKS:
        zf = tz - T.TANK_R
        hose(p, [(tx, T.OUTLET_Y, zf + 0.3), (tx, T.OUTLET_Y, zf - 0.75),
                 (tx, hy, hz)], T.OUTLET_R)
    hose(p, [(-T.TANKS[2][0], hy, hz), (0, hy, hz), (T.TANKS[2][0], hy, hz)],
         T.HEADER_R)
    # fill riser up the centre tank shell to the roof edge
    bx, bz = T.TANKS[1]
    hose(p, [(bx + 1.6, hy, hz), (bx + 1.6, T.TANK_TOP_Y + 0.35,
              bz - T.TANK_R - 0.35),
             (bx + 1.3, T.TANK_TOP_Y + 0.35, bz - T.TANK_R + 0.5)], 0.2)
    # export line: riser, over the bund, down, run to the pad-edge flange
    ex = T.EXPORT_X
    hose(p, [(ex, hy, hz), (ex, T.EXPORT_TOP, hz),
             (ex, T.EXPORT_TOP, T.EXPORT_WZ), (ex, T.EXPORT_Y, T.EXPORT_WZ),
             (ex, T.EXPORT_Y, T.EXPORT_END)], 0.3)
    flange_z = Zone(T.DARK.rect, ('x', 'y'),
                    ((ex - 0.5, ex + 0.5), (T.EXPORT_Y - 0.5, T.EXPORT_Y + 0.5)))
    limb(p, (ex, T.EXPORT_Y, T.EXPORT_END),
         (ex, T.EXPORT_Y, T.EXPORT_END - 0.12), 0.42, 0.42, T.PIPEW, n=6,
         cap_end=flange_z)
    # valve stations: two on the header, one on the export apron run
    for (vx, vy) in T.VALVE_HDR:
        handwheel(p, vx, vy, hz, hy)
    vx, vy, vz = T.VALVE_EXP
    handwheel(p, vx, vy, vz, T.EXPORT_Y)
    # control cabinet
    cx, cz = T.CAB_POS
    cw, chh, cd = T.CAB_SIZE
    box(p, (cx, T.PAD_TOP + chh / 2, cz), (cw, chh, cd), T.CAB, ch=0.05,
        skip=('-y',))
    # spiral stairs on the outer tanks
    spiral_stair(p, T.TANKS[0][0], T.TANKS[0][1], *T.STAIR_A)
    spiral_stair(p, T.TANKS[2][0], T.TANKS[2][1], *T.STAIR_C)
    # bund crossover step (outer step, coping platform, inner step)
    cx = T.CROSS_X
    pbox(p, (cx, T.PAD_TOP + 0.45, -5.65), (1.0, 0.9, 0.8), T.STEP)
    pbox(p, (cx, T.BUND_H + 0.07, -4.9), (1.0, 0.14, 1.6), T.STEP)
    pbox(p, (cx, T.PAD_TOP + 0.55, -4.15), (1.0, 1.1, 0.7), T.STEP)
    # hazard placard boards on posts (face -Z, apron side)
    u0, v0, u1, v1 = [c / M.ATLAS for c in T.PLACARD]
    for (px, pz) in T.PLACARDS:
        limb(p, (px, T.PAD_TOP, pz), (px, T.PLACARD_Y - T.PLACARD_S / 2, pz),
             0.06, 0.05, T.TRIM.rect, n=4)
        s = T.PLACARD_S / 2
        quad = [(px - s, T.PLACARD_Y - s, pz - 0.03),
                (px + s, T.PLACARD_Y - s, pz - 0.03),
                (px + s, T.PLACARD_Y + s, pz - 0.03),
                (px - s, T.PLACARD_Y + s, pz - 0.03)]
        uvs = [(u0, v1), (u1, v1), (u1, v0), (u0, v0)]
        p.add_face(quad, uvs=uvs, flip=True)              # front (-z)
        p.add_face(quad, uvs=uvs)                         # back (mirrored board)
    # bollards guarding the export flange
    for (bx_, bz_) in T.BOLLARDS:
        bcap = Zone(T.DARK.rect, ('x', 'z'),
                    ((bx_ - 0.2, bx_ + 0.2), (bz_ - 0.2, bz_ + 0.2)))
        limb(p, (bx_, T.PAD_TOP, bz_), (bx_, T.PAD_TOP + 0.9, bz_),
             0.14, 0.12, T.TRIM.rect, n=4, cap_end=bcap)
    return p


def build_vent():
    p = Part('vent')
    drum_y(p, 0, 0, 0.0, T.VENT_H, T.VENT_R, T.VENT_R * 0.82, T.VENTW, n=6)
    zc = Zone(T.VENT_TOP.rect, ('x', 'z'),
              ((-T.VENT_R, T.VENT_R), (-T.VENT_R, T.VENT_R)))
    p.add_face(ngon_ring((0, T.VENT_H, 0), T.VENT_R * 0.82, n=6, axis='y'),
               zone=zc, flip=True)
    return p


# ── clips ────────────────────────────────────────────────────────────────

def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    T_ = 12.0
    vent_keys = [(T_ * i / 8, qy(90.0 * i)) for i in range(9)]
    idle = {
        'name': 'idle',
        'channels': [
            ('vent', 'rotation', vent_keys),
        ],
    }
    return [idle]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='vent', parent=0, offset=T.VENT_OFF, part=build_vent()),
        dict(name='fumes', parent=0, offset=T.FUMES_OFF, part=None),
    ]
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_tank_farm] total tris: {total}')
