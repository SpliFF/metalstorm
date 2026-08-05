"""gen_ms_rail_platform — build ms_rail_platform (transport terminus).

24 x 12 m rail platform + single track spur matched to the fable_train
gauge (rails at TRACK_X ± train_layout.WHEEL_X), striped platform canopy
on a rear colonnade, slewing loading crane (`crane` yaw piece + `hook`
bob piece, both driven by the idle clip), buffer stop at the +Z track
end, signal post with emissive lamps at the -Z approach end, kiosk +
yard-lamp + crate/drum dressing.  `berth` is an empty on the track
centreline for game-code train alignment (see layout NOTE: spawn trains
+RAIL_Y1 so wheels sit on the rail head).

Forward -Z, up +Y, ground Y=0, 1 u = 1 m.  Deterministic (no RNG in
geometry; the painter seeds 90210).

Usage: python3 gen_ms_rail_platform.py
"""
from __future__ import annotations
import numpy as np

import ms_rail_platform_layout as L   # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, chamfer_box, ngon_ring, limb
from gltf_export import export

STEM = 'ms_rail_platform'
OUT = 'out'


# ── helpers (forge patterns) ─────────────────────────────────────────────

def quad_out(p, verts, outward, zone):
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, outward) > 0 else verts[::-1], zone=zone)


def box(p, center, size, zone, ch=0.04, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def pbox(p, center, size, zones, skip=()):
    """Plain 6-face box (ch=0 chamfer_box: bevel quads degenerate away)."""
    if isinstance(zones, Zone):
        zones = {k: zones for k in ('+y', '-y', '+x', '-x', '+z', '-z')}
    chamfer_box(p, center, size, 0.0, zones, skip=skip)


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
        p.add_face(ngon_ring((cx, ytop, cz), r, n=n, axis='y'),
                   zone=cap_zone, flip=True)


# ── static structure (all on `body`) ─────────────────────────────────────

def build_body():
    p = Part('body')

    # platform slab (coping/deck; -y buried)
    x, y, z, w, h, d = L.SLAB
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+y': L.P_DECK, '+x': L.P_SIDE, '-x': L.P_SIDE,
                 '+z': L.P_END, '-z': L.P_END}, skip=('-y',))

    # ballast prism (top + shoulder slopes + trapezoid ends)
    bt, z0, z1 = L.BAL_TOP, L.BAL_Z0, L.BAL_Z1
    quad_out(p, [(L.BAL_XT0, bt, z0), (L.BAL_XT1, bt, z0),
                 (L.BAL_XT1, bt, z1), (L.BAL_XT0, bt, z1)],
             (0, 1, 0), L.P_BAL)
    quad_out(p, [(L.BAL_XB0, 0, z0), (L.BAL_XT0, bt, z0),
                 (L.BAL_XT0, bt, z1), (L.BAL_XB0, 0, z1)],
             (-1, 0.4, 0), L.P_BALS)
    quad_out(p, [(L.BAL_XB1, 0, z0), (L.BAL_XT1, bt, z0),
                 (L.BAL_XT1, bt, z1), (L.BAL_XB1, 0, z1)],
             (1, 0.4, 0), L.P_BALS)
    for (ze, sgn) in ((z0, -1), (z1, 1)):
        quad_out(p, [(L.BAL_XB0, 0, ze), (L.BAL_XT0, bt, ze),
                     (L.BAL_XT1, bt, ze), (L.BAL_XB1, 0, ze)],
                 (0, 0.1, sgn), L.P_DARK)

    # sleepers (proud of the ballast, under both rails)
    for sz in np.arange(-11.4, 10.9, 1.65):
        pbox(p, (L.TRACK_X, 0.095, sz), (4.9, 0.15, 0.55),
             L.P_DARK, skip=('-y',))

    # rails on the fable_train gauge
    for rx in (L.TRACK_X - L.GAUGE_X, L.TRACK_X + L.GAUGE_X):
        zc = (L.RAIL_Z0 + L.RAIL_Z1) / 2
        pbox(p, (rx, (L.RAIL_Y0 + L.RAIL_Y1) / 2, zc),
             (L.RAIL_W, L.RAIL_Y1 - L.RAIL_Y0, L.RAIL_Z1 - L.RAIL_Z0),
             {'+y': L.P_RAILT, '+x': L.P_RAIL, '-x': L.P_RAIL,
              '+z': L.P_DARK, '-z': L.P_DARK}, skip=('-y',))

    # canopy: colonnade columns + header + braces + striped roof
    for cz in L.COLS:
        limb(p, (L.COL_X, L.DECK_Y, cz), (L.COL_X, L.COL_TOP, cz),
             0.17, 0.14, L.P_TRIM.rect, n=4)
        limb(p, (L.COL_X + 0.05, L.COL_TOP - 0.15, cz),
             (L.BRACE_TIP[0], L.BRACE_TIP[1], cz),
             0.09, 0.06, L.P_TRIM.rect, n=4)
    hx, hy, hz, hw, hh, hd = L.HEADER
    pbox(p, (hx, hy, hz), (hw, hh, hd), L.P_TRIM)
    rx_, ry_, rz_, rw_, rh_, rd_ = L.ROOF
    chamfer_box(p, (rx_, ry_, rz_), (rw_, rh_, rd_), 0.03,
                {'+y': L.P_CAN_TOP, '-y': L.P_CAN_BOT, '+x': L.P_CAN_EDGE,
                 '-x': L.P_CAN_EDGE, '+z': L.P_CAN_EDGE, '-z': L.P_CAN_EDGE})

    # kiosk (ticket booth) under the canopy
    kx, ky, kz, kw, kh, kd = L.KIOSK
    chamfer_box(p, (kx, ky, kz), (kw, kh, kd), 0.05,
                {'+x': L.P_KIOSK, '-x': L.P_KIOSK, '+z': L.P_KIOSK,
                 '-z': L.P_KIOSK, '+y': L.P_TRIM}, skip=('-y',))

    # crane pedestal (the slewing crane itself is its own piece)
    px, py, pz, pw, ph, pd = L.PED
    pbox(p, (px, py, pz), (pw, ph, pd), L.P_TRIM, skip=('-y',))

    # buffer stop at the +Z track end
    bx, by, bz, bw, bh, bd = L.BUFF_BEAM
    chamfer_box(p, (bx, by, bz), (bw, bh, bd), 0.04,
                {k: L.P_BUFF for k in ('+y', '-y', '+x', '-x', '+z', '-z')})
    qx, qy_, qz_, qw, qh, qd = L.BUFF_PLATE
    pbox(p, (qx, qy_, qz_), (qw, qh, qd), L.P_BUFF, skip=('+z',))
    for rx in (L.TRACK_X - L.GAUGE_X, L.TRACK_X + L.GAUGE_X):
        limb(p, (rx, 0.12, L.BUFF_Z + 0.9), (rx, by + 0.1, bz),
             0.14, 0.11, L.P_BUFF.rect, n=4)
        limb(p, (rx, 0.12, bz), (rx, by + 0.22, bz),
             0.12, 0.12, L.P_BUFF.rect, n=4)
        pbox(p, (rx, 0.09, L.BUFF_Z + 0.75), (0.5, 0.18, 0.9),
             L.P_DARK, skip=('-y',))

    # signal post at the -Z approach (far side of the spur)
    limb(p, (L.SIG_X, 0.0, L.SIG_Z), (L.SIG_X, L.SIG_TOP, L.SIG_Z),
         0.12, 0.08, L.P_TRIM.rect, n=6)
    sx, sy, sz_, sw, sh, sd = L.SIG_HEAD
    pbox(p, (sx, sy, sz_), (sw, sh, sd), L.P_SIGHEAD)
    for ly in (4.72, 4.17):          # lamp visor hoods over the -Z face
        quad_out(p, [(sx - 0.16, ly, sz_ - sd / 2),
                     (sx + 0.16, ly, sz_ - sd / 2),
                     (sx + 0.13, ly + 0.05, sz_ - sd / 2 - 0.16),
                     (sx - 0.13, ly + 0.05, sz_ - sd / 2 - 0.16)],
                 (0, 1, -0.4), L.P_DARK)
    cx_, cz2, cw2, ch2, cd2 = L.CABINET
    pbox(p, (cx_, ch2 / 2, cz2), (cw2, ch2, cd2), L.P_CRATE, skip=('-y',))

    # yard lamp posts on the platform edge (unlit housings)
    for lz in L.LAMPS_Z:
        limb(p, (L.LAMP_X, L.DECK_Y, lz), (L.LAMP_X, L.LAMP_TOP, lz),
             0.08, 0.06, L.P_TRIM.rect, n=4)
        pbox(p, (L.LAMP_X + 0.28, L.LAMP_TOP + 0.1, lz),
             (0.9, 0.22, 0.42), L.P_LAMP)

    # freight dressing: crates, pallet, drum
    for (cx, cz, cs) in L.CRATES:
        pbox(p, (cx, L.DECK_Y + cs / 2, cz), (cs, cs, cs),
             L.P_CRATE, skip=('-y',))
    ax, az, aw, ah, ad = L.PALLET
    pbox(p, (ax, L.DECK_Y + ah / 2, az), (aw, ah, ad),
         L.P_CRATE, skip=('-y',))
    dx, dz, dr, dh = L.DRUM
    drum_y(p, dx, dz, L.DECK_Y, L.DECK_Y + dh, dr, L.P_CRATE.rect,
           cap_zone=L.P_DARK, n=8)
    return p


# ── crane (yaw) + hook (bob) pieces ──────────────────────────────────────

def build_crane():
    p = Part('crane')
    drum_y(p, 0, 0, -0.05, 0.25, 0.5, L.P_CRANE.rect,
           cap_zone=L.P_DARK, n=8)                       # turntable
    chamfer_box(p, (0.35, 0.66, 0), (1.5, 0.8, 1.1), 0.06,
                {k: L.P_CRANE for k in ('+y', '-y', '+x', '-x', '+z', '-z')})
    pbox(p, (0, 2.35, 0), (0.45, 4.2, 0.45), L.P_CRANE,
         skip=('-y',))                                   # mast
    pbox(p, (2.0, 4.1, 0), (7.4, 0.42, 0.36), L.P_CRANE)  # jib
    chamfer_box(p, (-1.45, 3.85, 0), (0.9, 0.85, 0.8), 0.06,
                {k: L.P_CRANE for k in ('+y', '-y', '+x', '-x', '+z', '-z')})
    pbox(p, (L.HOOK_OFF[0], 3.86, 0), (0.3, 0.32, 0.3), L.P_CRANE,
         skip=('+y',))                                   # tip pulley block
    for szn in (-0.12, 0.12):                            # tie rods
        limb(p, (0.0, 4.5, szn), (4.7, 4.33, 0.0), 0.05, 0.04,
             L.P_CRANE.rect, n=4)
    return p


def build_hook():
    p = Part('hook')
    limb(p, (0, 0.15, 0), (0, -2.35, 0), 0.035, 0.035,
         L.P_HOOK.rect, n=4)                             # cable fall
    pbox(p, (0, -2.55, 0), (0.34, 0.5, 0.22), L.P_HOOK)  # block
    limb(p, (0, -2.8, 0), (0.13, -3.05, 0), 0.055, 0.05, L.P_HOOK.rect, n=4)
    limb(p, (0.13, -3.05, 0), (0.24, -2.86, 0), 0.05, 0.035,
         L.P_HOOK.rect, n=4)                             # hook curl
    return p


# ── idle clip: slow slew + hook bob (loop-seamless) ──────────────────────

def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    crane_keys = [(0.0, qy(0)), (3.0, qy(24)), (5.0, qy(24)),
                  (8.0, qy(-14)), (10.0, qy(-14)), (12.0, qy(0))]
    hx, hy, hz = L.HOOK_OFF          # translations are ABSOLUTE (rest+delta)
    hook_keys = [(0.0, (hx, hy, hz)), (3.0, (hx, hy, hz)),
                 (4.5, (hx, hy - 0.6, hz)), (6.5, (hx, hy - 0.6, hz)),
                 (8.0, (hx, hy, hz)), (12.0, (hx, hy, hz))]
    idle = {
        'name': 'idle',
        'channels': [
            ('crane', 'rotation', crane_keys),
            ('hook', 'translation', hook_keys),
        ],
    }
    return [idle]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='crane', parent=0, offset=L.CRANE_OFF, part=build_crane()),
        dict(name='hook', parent=1, offset=L.HOOK_OFF, part=build_hook()),
        dict(name='berth', parent=0, offset=L.BERTH_OFF, part=None),
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
    print(f'[gen_ms_rail_platform] total tris: {total}')
