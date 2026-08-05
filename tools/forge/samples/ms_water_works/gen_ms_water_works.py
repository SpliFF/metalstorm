"""gen_ms_water_works — build ms_water_works (named resource site) + idle clip.

16 m riveted water tower on four braced legs (catwalk, ladder, roof
cone, overflow pipe landing above the catwalk — the staining feature),
gabled pumphouse with stack, samson-post walking-beam pump (piece
`pump`, the only animated node: idle stroke rocking about local X),
riser + ground pipe runs to a delivery standpipe, wellhead, crank
housing with flywheel, and a barrel pair. Scale-relative to the shipped
buildings (STYLE.md buildings row: footprint-driven, flat-shaded).

Usage: python3 gen_ms_water_works.py [png]
"""
from __future__ import annotations
import numpy as np

import ms_water_works_layout as L   # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, chamfer_box, ngon_ring, limb
from gltf_export import export

STEM = 'ms_water_works'
OUT = 'out'


# ── helpers (forge patterns) ─────────────────────────────────────────────

def drum_y(p, cx, cz, ybase, ytop, r, wrap_rect, cap_zone=None,
           bot_zone=None, n=8, phase=None):
    """Vertical n-gon drum, u around the wrap rect, v = height (v-down =
    world-down). cap_zone/bot_zone: Zone whose rect hosts the end discs
    (window rebuilt around cx,cz like gen_factory's drum_y)."""
    r0 = ngon_ring((cx, ybase, cz), r, n=n, axis='y', phase=phase)
    r1 = ngon_ring((cx, ytop, cz), r, n=n, axis='y', phase=phase)
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
        p.add_face(ngon_ring((cx, ytop, cz), r, n=n, axis='y', phase=phase),
                   zone=zc, flip=True)
    if bot_zone is not None:
        zb = Zone(bot_zone.rect, ('x', 'z'), ((cx - r, cx + r), (cz - r, cz + r)))
        p.add_face(ngon_ring((cx, ybase, cz), r, n=n, axis='y', phase=phase),
                   zone=zb)
    return r0, r1


def hose(p, pts, r, rect=None, collars=True, n=6):
    rect = rect or L.W_PIPE
    for i in range(len(pts) - 1):
        limb(p, pts[i], pts[i + 1], r, r, rect, n=n)
    if collars:
        for i in range(1, len(pts) - 1):
            a, b = np.asarray(pts[i - 1]), np.asarray(pts[i])
            d = b - a
            d = d / max(1e-9, np.linalg.norm(d))
            c0 = tuple(b - d * 0.1)
            c1 = tuple(b + d * 0.1)
            limb(p, c0, c1, r * 1.3, r * 1.3, rect, n=n)


def box(p, center, size, zone, ch=0.04, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def face_dir(p, verts, zone, want):
    """Add a polygon, flipping so the flat normal points along `want`."""
    n = np.zeros(3)
    vs = [np.asarray(v, float) for v in verts]
    for i in range(len(vs)):
        c, nx = vs[i], vs[(i + 1) % len(vs)]
        n[0] += (c[1] - nx[1]) * (c[2] + nx[2])
        n[1] += (c[2] - nx[2]) * (c[0] + nx[0])
        n[2] += (c[0] - nx[0]) * (c[1] + nx[1])
    p.add_face(verts, zone=zone, flip=(np.dot(n, np.asarray(want, float)) < 0))


def leg_off(y):
    """Per-axis leg offset at height y (legs taper inward toward the tank)."""
    t = (y - L.LEG_Y0) / (L.LEG_Y1 - L.LEG_Y0)
    return L.LEG_OFF_B + (L.LEG_OFF_T - L.LEG_OFF_B) * t


# ── the site (everything static lives on `body`) ─────────────────────────

def build_body():
    p = Part('body')
    TX, TZ = L.TWR_X, L.TWR_Z

    # concrete pad
    x, y, z, w, h, d = L.PAD
    chamfer_box(p, (x, y, z), (w, h, d), 0.12,
                {'+y': L.W_PAD, '+x': L.W_PADS, '-x': L.W_PADS,
                 '+z': L.W_PADS_F, '-z': L.W_PADS_F}, skip=('-y',))

    # ── water tower ──
    # riveted tank shell (10 facets, flat-top phase) + bottom cap
    drum_y(p, TX, TZ, L.TANK_Y0, L.TANK_Y1, L.TANK_R, L.W_TANK,
           bot_zone=L.W_TANK_BOT, n=L.TANK_N)
    # conical roof to an apex ring + finial mast (spec: 16 m total)
    rb = ngon_ring((TX, L.TANK_Y1, TZ), L.TANK_R, n=L.TANK_N, axis='y')
    rt = ngon_ring((TX, L.ROOF_Y, TZ), L.ROOF_R, n=L.TANK_N, axis='y')
    for j in range(L.TANK_N):
        k = (j + 1) % L.TANK_N
        face_dir(p, [rb[j], rb[k], rt[k], rt[j]], L.W_ROOF,
                 (rb[j][0] - TX, L.TANK_R, rb[j][2] - TZ))
    face_dir(p, rt, L.W_ROOF, (0, 1, 0))
    limb(p, (TX, L.ROOF_Y - 0.05, TZ), (TX, L.FINIAL_Y, TZ), 0.09, 0.04,
         L.W_TRIM, n=4, cap_end=L.W_DARK)

    # four braced legs
    for sx in (-1, 1):
        for sz in (-1, 1):
            limb(p, (TX + sx * L.LEG_OFF_B, L.LEG_Y0, TZ + sz * L.LEG_OFF_B),
                 (TX + sx * L.LEG_OFF_T, L.LEG_Y1, TZ + sz * L.LEG_OFF_T),
                 0.22, 0.17, L.W_LEG, n=6)
    # ring braces at two levels + X diagonals between them on all 4 faces
    y0, y1 = L.BRACE_Y
    o0, o1 = leg_off(y0), leg_off(y1)
    corners0 = [(TX + sx * o0, y0, TZ + sz * o0) for sx, sz in
                ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    corners1 = [(TX + sx * o1, y1, TZ + sz * o1) for sx, sz in
                ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    for i in range(4):
        j = (i + 1) % 4
        limb(p, corners0[i], corners0[j], 0.09, 0.09, L.W_BRACE, n=4)
        limb(p, corners1[i], corners1[j], 0.09, 0.09, L.W_BRACE, n=4)
        limb(p, corners0[i], corners1[j], 0.06, 0.06, L.W_BRACE, n=4)
        limb(p, corners0[j], corners1[i], 0.06, 0.06, L.W_BRACE, n=4)

    # catwalk disc under the tank + perimeter railing
    drum_y(p, TX, TZ, L.CAT_Y - 0.12, L.CAT_Y, L.CAT_RO, L.W_RAIL,
           cap_zone=L.W_CATWALK, bot_zone=L.W_CATWALK, n=L.TANK_N)
    posts = ngon_ring((TX, L.CAT_Y, TZ), L.CAT_RO - 0.08, n=L.TANK_N, axis='y')
    tops = ngon_ring((TX, L.CAT_Y + L.RAIL_H, TZ), L.CAT_RO - 0.08,
                     n=L.TANK_N, axis='y')
    for j in range(L.TANK_N):
        limb(p, posts[j], tops[j], 0.045, 0.045, L.W_RAIL, n=4)
        limb(p, tops[j], tops[(j + 1) % L.TANK_N], 0.05, 0.05, L.W_RAIL, n=4)

    # access ladder: two rails + painted-rung ribbon (W_LADDER)
    lx, lz = L.LADDER_X, L.LADDER_Z
    for rx in (lx - 0.35, lx + 0.35):
        limb(p, (rx, 0.8, lz), (rx, 10.1, lz), 0.05, 0.05, L.W_TRIM, n=4)
    rib = [(lx - 0.35, 0.8, lz), (lx + 0.35, 0.8, lz),
           (lx + 0.35, 10.1, lz), (lx - 0.35, 10.1, lz)]
    face_dir(p, rib, L.W_LADDER, (0, 0, -1))
    face_dir(p, rib, L.W_LADDER, (0, 0, 1))

    # riser pipe (tank bottom -> ground) + overflow pipe (the stain source)
    hose(p, [(TX, L.TANK_Y0 + 0.1, TZ), (TX, L.PAD_TOP - 0.05, TZ)], 0.28,
         collars=False)
    limb(p, (TX, 5.6, TZ), (TX, 5.9, TZ), 0.36, 0.36, L.W_PIPE, n=6)
    ox = TX + (L.TANK_R + L.OVER_STAND) * np.cos(L.OVER_A)
    oz = TZ + (L.TANK_R + L.OVER_STAND) * np.sin(L.OVER_A)
    sx = TX + (L.TANK_R - 0.1) * np.cos(L.OVER_A)
    sz = TZ + (L.TANK_R - 0.1) * np.sin(L.OVER_A)
    hose(p, [(sx, L.TANK_Y1 - 0.35, sz), (ox, L.TANK_Y1 - 0.35, oz),
             (ox, L.OVER_Y0, oz)], 0.12)
    face_dir(p, ngon_ring((ox, L.OVER_Y0, oz), 0.12, n=6, axis='y'),
             L.W_DARK, (0, -1, 0))

    # ground pipe runs: tower -> delivery standpipe, tower -> pumphouse
    hose(p, [(TX, L.PIPE_Y, TZ), (TX, L.PIPE_Y, L.STAND_Z),
             (L.STAND_X, L.PIPE_Y, L.STAND_Z)], 0.18)
    hose(p, [(TX, L.PIPE_Y, TZ), (0.6, L.PIPE_Y, TZ),
             (L.HOUSE_X0, L.PIPE_Y, 1.6)], 0.18)

    # delivery standpipe (the named-resource tap) + valve wheel + spout
    limb(p, (L.STAND_X, L.PAD_TOP - 0.05, L.STAND_Z),
         (L.STAND_X, 2.5, L.STAND_Z), 0.15, 0.15, L.W_PIPE, n=6,
         cap_end=L.W_DARK)
    limb(p, (L.STAND_X, 2.2, L.STAND_Z), (L.STAND_X, 2.2, L.STAND_Z - 0.6),
         0.1, 0.1, L.W_PIPE, n=6, cap_end=L.W_DARK)
    wheel = ngon_ring((L.STAND_X + 0.15, 1.9, L.STAND_Z), 0.28, n=8, axis='x')
    zw = Zone(L.W_VALVE.rect, ('z', 'y'),
              ((L.STAND_Z - 0.5, L.STAND_Z + 0.5), (2.4, 1.4)))
    face_dir(p, wheel, zw, (1, 0, 0))
    face_dir(p, wheel, zw, (-1, 0, 0))

    # ── pumphouse ──
    x, y, z, w, h, d = L.HOUSE
    chamfer_box(p, (x, y, z), (w, h, d), 0.08,
                {'+x': L.W_HOUSE_S, '-x': L.W_HOUSE_S, '-z': L.W_HOUSE_F,
                 '+z': L.W_HOUSE_R}, skip=('-y', '+y'))
    # gable ends + roof slabs (ridge along z)
    for gz, want in ((L.HOUSE_Z0, (0, 0, -1)), (L.HOUSE_Z1, (0, 0, 1))):
        zone = L.W_HOUSE_F if want[2] < 0 else L.W_HOUSE_R
        face_dir(p, [(L.HOUSE_X0, L.EAVE_Y, gz), (x, L.RIDGE_Y, gz),
                     (L.HOUSE_X1, L.EAVE_Y, gz)], zone, want)
    slope = (L.RIDGE_Y - L.EAVE_Y) / (w / 2)
    zf, zr = L.HOUSE_Z0 - L.ROOF_OVER, L.HOUSE_Z1 + L.ROOF_OVER
    for s in (-1, 1):
        xe = x + s * (w / 2 + L.ROOF_OVER)
        ye = L.RIDGE_Y - (w / 2 + L.ROOF_OVER) * slope
        top = [(x, L.RIDGE_Y + L.ROOF_TH, zf), (x, L.RIDGE_Y + L.ROOF_TH, zr),
               (xe, ye + L.ROOF_TH, zr), (xe, ye + L.ROOF_TH, zf)]
        bot = [(x, L.RIDGE_Y, zf), (x, L.RIDGE_Y, zr),
               (xe, ye, zr), (xe, ye, zf)]
        face_dir(p, top, L.W_HOUSE_RF, (0, 1, 0))
        face_dir(p, bot, L.W_HOUSE_RF, (0, -1, 0))
        face_dir(p, [top[3], top[2], bot[2], bot[3]], L.W_HOUSE_S, (s, 0, 0))
        face_dir(p, [top[0], top[3], bot[3], bot[0]], L.W_HOUSE_F, (0, 0, -1))
        face_dir(p, [top[1], top[2], bot[2], bot[1]], L.W_HOUSE_R, (0, 0, 1))
    # stack pierces the +x roof slope
    sx_, sy_, sz_ = L.STACK
    limb(p, (sx_, sy_, sz_), (sx_, L.STACK_TOP, sz_), 0.19, 0.17,
         L.W_STACK, n=6, cap_end=L.W_DARK)
    limb(p, (sx_, L.STACK_TOP - 0.35, sz_), (sx_, L.STACK_TOP - 0.15, sz_),
         0.24, 0.24, L.W_STACK, n=6)

    # ── pump gear on the pad (static support for the `pump` piece) ──
    ax, ay, az = L.SAMSON_APEX
    # samson post A-frame (4 legs to the beam pivot) + apex crossbar
    for sxs in (-1, 1):
        for szs in (-1, 1):
            limb(p, (ax + sxs * 0.95, L.PAD_TOP, az + szs * 0.72),
                 (ax + sxs * 0.16, ay - 0.12, az + szs * 0.1),
                 0.13, 0.09, L.W_LEG, n=4)
    limb(p, (ax - 0.3, ay - 0.05, az), (ax + 0.3, ay - 0.05, az),
         0.11, 0.11, L.W_TRIM, n=4, cap_start=L.W_DARK, cap_end=L.W_DARK)
    # crank housing + flywheel (painted spokes)
    cx, cy, cz, cw, chh, cd = L.CRANK_BOX
    box(p, (cx, cy, cz), (cw, chh, cd), L.W_WELL, ch=0.06)
    fw = ngon_ring((cx - cw / 2 - 0.07, cy + 0.1, cz), 0.55, n=8, axis='x')
    zfw = Zone(L.W_VALVE.rect, ('z', 'y'),
               ((cz - 0.6, cz + 0.6), (cy + 0.7, cy - 0.5)))
    face_dir(p, fw, zfw, (-1, 0, 0))
    face_dir(p, fw, zfw, (1, 0, 0))
    # wellhead + stuffing box + polished rod (static; the horsehead's
    # travel envelope always overlaps the rod top at 3.1 m)
    limb(p, (L.WELL_X, L.PAD_TOP, L.WELL_Z), (L.WELL_X, 2.1, L.WELL_Z),
         0.22, 0.22, L.W_PIPE, n=6, cap_end=L.W_DARK)
    limb(p, (L.WELL_X, 2.1, L.WELL_Z), (L.WELL_X, 2.4, L.WELL_Z),
         0.1, 0.1, L.W_TRIM, n=4)
    limb(p, (L.WELL_X, 2.4, L.WELL_Z), (L.WELL_X, 3.1, L.WELL_Z),
         0.04, 0.04, L.W_TRIM, n=4)
    # discharge run wellhead -> house front wall
    hose(p, [(L.WELL_X + 0.35, 1.35, L.WELL_Z), (L.WELL_X + 0.35, 1.35, L.HOUSE_Z0)],
         0.12, collars=False)

    # barrels behind the house
    for (bx, bz) in L.DRUMS:
        drum_y(p, bx, bz, L.PAD_TOP, L.PAD_TOP + L.DRUM_H, L.DRUM_R,
               L.W_DRUM, cap_zone=L.W_DRUM_TOP, n=8)
    return p


def build_pump():
    """Walking beam (piece-local; origin = pivot at the samson apex)."""
    p = Part('pump')
    # beam
    bx, by, bz, bw, bh, bd = L.BEAM_BOX
    box(p, (bx, by, bz), (bw, bh, bd), L.W_BEAM, ch=0.05)
    # horsehead: extruded side profile with an arced front
    prof = [(-2.15, 0.42), (-2.55, 0.38), (L.HEAD_Z1, 0.05),
            (L.HEAD_Z1 - 0.02, -0.4), (-2.6, -0.85), (L.HEAD_Z0, -0.85)]
    hw = 0.2
    for sxs, want in ((-hw, (-1, 0, 0)), (hw, (1, 0, 0))):
        face_dir(p, [(sxs, yy, zz) for (zz, yy) in prof], L.W_HEAD, want)
    for i in range(len(prof)):
        (z0_, y0_), (z1_, y1_) = prof[i], prof[(i + 1) % len(prof)]
        mid = np.array([0.0, (y0_ + y1_) / 2, (z0_ + z1_) / 2])
        want = mid - np.array([0.0, -0.2, -2.45])
        face_dir(p, [(-hw, y0_, z0_), (hw, y0_, z0_),
                     (hw, y1_, z1_), (-hw, y1_, z1_)], L.W_HEAD, tuple(want))
    # counterweight
    wx, wy, wz, ww, wh_, wd = L.WEIGHT_BOX
    box(p, (wx, wy, wz), (ww, wh_, wd), L.W_WEIGHT, ch=0.06)
    # pitman rods: beam tail down to the crank housing
    for sxs in (-1, 1):
        limb(p, (sxs * 0.26, -0.1, L.PITMAN_Z),
             (sxs * 0.26, -2.1, L.PITMAN_Z - 0.05), 0.05, 0.05, L.W_TRIM, n=4)
    return p


# ── clips ────────────────────────────────────────────────────────────────

def qx(deg):
    r = np.radians(deg) / 2
    return (float(np.sin(r)), 0.0, 0.0, float(np.cos(r)))


def build_clips():
    """Idle stroke: the beam rocks about the pivot's local X (sine-ish,
    5 linear keys per period, first == last for a seamless loop)."""
    T, A = L.STROKE_T, L.STROKE_DEG
    keys = [(0.0, qx(0)), (T * 0.25, qx(A)), (T * 0.5, qx(0)),
            (T * 0.75, qx(-A)), (T, qx(0))]
    return [{'name': 'idle', 'channels': [('pump', 'rotation', keys)]}]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='pump', parent=0, offset=L.PUMP_OFF, part=build_pump()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_water_works] total tris: {total}')
