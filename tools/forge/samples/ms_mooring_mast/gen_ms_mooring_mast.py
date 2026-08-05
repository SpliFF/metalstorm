"""gen_ms_mooring_mast — assemble ms_mooring_mast and export .gltf/.bin.

Airship mooring mast (transport terminus, 20 m, sized against the 65 m
fable_airship nose spike): concrete anchor pad + equipment hut, four-leg
tapering lattice tower on footings, external spiral boarding stair with
handrail + support struts, railed top platform, and a rotating mooring
`head` (idle clip: slow 360° weathervane) carrying the receiver cone,
boarding gangway, counterweight and the red `beacon` (emissive).
`dock` is an empty attach piece at the cone mouth for the airship nose.
Run: python3 gen_ms_mooring_mast.py → out/ms_mooring_mast{,_png}.gltf + .bin
"""
import numpy as np

import ms_mooring_mast_layout as F      # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, chamfer_box, ngon_ring, limb, tube
from gltf_export import export

STEM = 'ms_mooring_mast'
OUT = 'out'

# on-the-fly zones (rects from the layout; windows piece-local)
Z_PLAT_B = Zone(F.R_DARK.rect, ('x', 'z'), ((-3.3, 3.3), (-3.3, 3.3)))
Z_CONE_FACE = Zone(F.R_CONE_IN, ('x', 'y'),
                   ((-1.1, 1.1), (F.CONE_Y + 1.1, F.CONE_Y - 1.1)))
Z_TIP = Zone(F.R_TRIM, ('x', 'y'), ((-0.2, 0.2), (0.85, 0.55)))


# ── local helpers ────────────────────────────────────────────────────────

def box5(p, center, size, rect):
    """Plain 5-face box (no bottom, no bevel — STYLE.md: skip bevels too
    small for the budget) with every face mapped across `rect`."""
    cx, cy, cz = center
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    x0, y0, x1, y1 = rect
    uvs = [(x0 / M.ATLAS, y0 / M.ATLAS), (x1 / M.ATLAS, y0 / M.ATLAS),
           (x1 / M.ATLAS, y1 / M.ATLAS), (x0 / M.ATLAS, y1 / M.ATLAS)]

    def V(sx, sy, sz):
        return (cx + sx * hx, cy + sy * hy, cz + sz * hz)
    faces = [
        [V(-1, 1, -1), V(-1, 1, 1), V(1, 1, 1), V(1, 1, -1)],       # +y
        [V(1, -1, -1), V(1, 1, -1), V(1, 1, 1), V(1, -1, 1)],       # +x
        [V(-1, -1, -1), V(-1, -1, 1), V(-1, 1, 1), V(-1, 1, -1)],   # -x
        [V(-1, -1, -1), V(-1, 1, -1), V(1, 1, -1), V(1, -1, -1)],   # -z
        [V(-1, -1, 1), V(1, -1, 1), V(1, 1, 1), V(-1, 1, 1)],       # +z
    ]
    for f in faces:
        p.add_face(f, uvs=uvs)


def oriented(quad, uvs, want):
    """Return (poly, uvs) wound so the flat normal points along `want`.
    Works for tris and quads (last vertex spans the polygon with [1])."""
    n = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                 np.asarray(quad[-1]) - np.asarray(quad[0]))
    if np.dot(n, want) < 0:
        return quad[::-1], uvs[::-1]
    return quad, uvs


def quad_ring(p, ring_a, ring_b, rect, v0f, v1f, want, skip=()):
    """Quad band between two equal-length rings; u = segment index across
    `rect`, v = band [v0f, v1f]. want(c) = desired normal direction."""
    x0, y0, x1, y1 = rect
    n = len(ring_a)
    for j in range(n):
        if j in skip:
            continue
        k = (j + 1) % n
        quad = [ring_a[j], ring_a[k], ring_b[k], ring_b[j]]
        ua = (x0 + (x1 - x0) * j / n) / M.ATLAS
        ub = (x0 + (x1 - x0) * (j + 1) / n) / M.ATLAS
        va = (y0 + (y1 - y0) * v0f) / M.ATLAS
        vb = (y0 + (y1 - y0) * v1f) / M.ATLAS
        uvs = [(ua, va), (ub, va), (ub, vb), (ua, vb)]
        c = np.mean(np.array(quad), axis=0)
        quad, uvs = oriented(quad, uvs, np.asarray(want(c), dtype=float))
        p.add_face(quad, uvs=uvs)


def vert_tube(p, stations, rect, n=8, cap_top=None):
    """n-gon tube along +Y: stations [(y, r), ...] bottom→top; parametric
    UVs (u around, v = world height mapped image-down = world-down)."""
    x0, y0, x1, y1 = rect
    ys = [s[0] for s in stations]
    ylo, yhi = min(ys), max(ys)
    rings = [ngon_ring((0, y, 0), r, n=n, axis='y') for (y, r) in stations]
    for i in range(len(rings) - 1):
        va = (y0 + (y1 - y0) * (yhi - stations[i][0]) / (yhi - ylo)) / M.ATLAS
        vb = (y0 + (y1 - y0) * (yhi - stations[i + 1][0]) / (yhi - ylo)) / M.ATLAS
        for j in range(n):
            k = (j + 1) % n
            ua = (x0 + (x1 - x0) * j / n) / M.ATLAS
            ub = (x0 + (x1 - x0) * (j + 1) / n) / M.ATLAS
            quad = [rings[i][j], rings[i][k], rings[i + 1][k], rings[i + 1][j]]
            uvs = [(ua, va), (ub, va), (ub, vb), (ua, vb)]
            c = np.mean(np.array(quad), axis=0)
            quad, uvs = oriented(quad, uvs, np.array([c[0], 0.0, c[2]]))
            p.add_face(quad, uvs=uvs)
    if cap_top is not None:
        p.add_face(list(rings[-1]), zone=cap_top, flip=True)
    return rings


def leg_w(y):
    """Tower half-width at height y (linear taper base→top)."""
    t = (y - 0.5) / (F.TOWER_TOP - 0.5)
    return F.LEG_BASE_W + (F.LEG_TOP_W - F.LEG_BASE_W) * t


def stair_pt(i):
    """Stair centreline sample i → (angle, y, cos, sin)."""
    t = i / F.STAIR_SEGS
    a = F.STAIR_A0 + (F.STAIR_A1 - F.STAIR_A0) * t
    y = F.STAIR_Y0 + (F.STAIR_Y1 - F.STAIR_Y0) * t
    return a, y, np.cos(a), np.sin(a)


# ── body ─────────────────────────────────────────────────────────────────

def build_pad(p):
    x, y, z, w, h, d = F.PAD
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+y': F.R_PAD, '+x': F.R_PADS, '-x': F.R_PADS,
                 '+z': F.R_PADS_F, '-z': F.R_PADS_F}, skip=('-y',))
    for (ax, az) in F.FOOTINGS:
        box5(p, (ax, F.PAD_TOP + F.FOOTING_SZ[1] / 2, az), F.FOOTING_SZ,
             F.R_ANCHOR.rect)
    x, y, z, w, h, d = F.HUT
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+x': F.R_HUT, '-x': F.R_HUT, '+z': F.R_HUT_F,
                 '-z': F.R_HUT_F, '+y': F.R_HUT_T}, skip=('-y',))


def build_tower(p):
    ft_top = F.PAD_TOP + F.FOOTING_SZ[1]
    corners = [(1, 1), (-1, 1), (-1, -1), (1, -1)]
    for (sx, sz) in corners:
        limb(p, (sx * F.LEG_BASE_W, ft_top, sz * F.LEG_BASE_W),
             (sx * F.LEG_TOP_W, F.TOWER_TOP, sz * F.LEG_TOP_W),
             F.LEG_R0, F.LEG_R1, F.R_TOWER, n=4)
    # ring frames: 4 horizontal members joining the legs
    for ry in F.RINGS:
        w = leg_w(ry)
        pts = [(sx * w, ry, sz * w) for (sx, sz) in corners]
        for j in range(4):
            limb(p, pts[j], pts[(j + 1) % 4], 0.05, 0.05, F.R_TOWER, n=4)
    # X-braces per bay per face
    for b in range(len(F.BAY_BOUNDS) - 1):
        y0, y1 = F.BAY_BOUNDS[b], F.BAY_BOUNDS[b + 1]
        w0, w1 = leg_w(y0), leg_w(y1)
        for j in range(4):
            (ax, az), (bx, bz) = corners[j], corners[(j + 1) % 4]
            pa0 = (ax * w0, y0, az * w0)
            pb0 = (bx * w0, y0, bz * w0)
            pa1 = (ax * w1, y1, az * w1)
            pb1 = (bx * w1, y1, bz * w1)
            limb(p, pa0, pb1, 0.045, 0.045, F.R_TOWER, n=3)
            limb(p, pb0, pa1, 0.045, 0.045, F.R_TOWER, n=3)


def build_stair(p):
    x0, y0, x1, y1 = F.R_STAIR
    ci = F.STAIR_R - F.STAIR_W / 2
    co = F.STAIR_R + F.STAIR_W / 2
    n = F.STAIR_SEGS

    def ring(i):
        _, y, ca, sa = stair_pt(i)
        return dict(ti=(ci * ca, y, ci * sa), to=(co * ca, y, co * sa),
                    bi=(ci * ca, y - F.STAIR_TH, ci * sa),
                    bo=(co * ca, y - F.STAIR_TH, co * sa))

    bands = {'top': (0.0, 0.25), 'out': (0.25, 0.5),
             'bot': (0.5, 0.75), 'inn': (0.75, 1.0)}

    def band_uvs(i, key):
        v0f, v1f = bands[key]
        ua = (x0 + (x1 - x0) * i / n) / M.ATLAS
        ub = (x0 + (x1 - x0) * (i + 1) / n) / M.ATLAS
        va = (y0 + (y1 - y0) * v0f) / M.ATLAS
        vb = (y0 + (y1 - y0) * v1f) / M.ATLAS
        return [(ua, va), (ub, va), (ub, vb), (ua, vb)]

    rings = [ring(i) for i in range(n + 1)]
    for i in range(n):
        r0, r1 = rings[i], rings[i + 1]
        c = np.mean(np.array([r0['ti'], r1['to']]), axis=0)
        rad = np.array([c[0], 0.0, c[2]])
        for key, quad, want in (
                ('top', [r0['ti'], r0['to'], r1['to'], r1['ti']], (0, 1, 0)),
                ('out', [r0['to'], r0['bo'], r1['bo'], r1['to']], rad),
                ('bot', [r0['bo'], r0['bi'], r1['bi'], r1['bo']], (0, -1, 0)),
                ('inn', [r0['bi'], r0['ti'], r1['ti'], r1['bi']], -rad)):
            q, uv = oriented(quad, band_uvs(i, key),
                             np.asarray(want, dtype=float))
            p.add_face(q, uvs=uv)
    # end caps
    for r, want in ((rings[0], np.cross([0, 1, 0], rings[0]['to'])),
                    (rings[-1], np.cross(np.asarray(rings[-1]['to']), [0, 1, 0]))):
        quad = [r['ti'], r['to'], r['bo'], r['bi']]
        q, uv = oriented(quad, band_uvs(0, 'out'),
                         np.asarray([want[0], 0.0, want[2]]))
        p.add_face(q, uvs=uv)
    # handrail: posts + double-sided ribbon along the outer edge
    for i in range(0, n + 1, F.RAIL_POST_EVERY):
        t = rings[i]['to']
        limb(p, t, (t[0], t[1] + F.RAIL_H, t[2]), 0.035, 0.03, F.R_TRIM, n=3)
    for i in range(n):
        a = rings[i]['to']
        b = rings[i + 1]['to']
        quad = [(a[0], a[1] + F.RAIL_H - F.RAIL_BAND, a[2]),
                (b[0], b[1] + F.RAIL_H - F.RAIL_BAND, b[2]),
                (b[0], b[1] + F.RAIL_H, b[2]),
                (a[0], a[1] + F.RAIL_H, a[2])]
        uvs = band_uvs(i, 'out')
        p.add_face(quad, uvs=uvs)
        p.add_face(quad[::-1], uvs=uvs[::-1])
    # support struts: stair underside → tower
    for i in range(F.STRUT_EVERY, n, F.STRUT_EVERY):
        bi = rings[i]['bi']
        y = bi[1]
        w = leg_w(min(max(y, 0.5), F.TOWER_TOP)) * 1.05
        r = np.hypot(bi[0], bi[2])
        inner = (bi[0] * w / r, y, bi[2] * w / r)
        limb(p, bi, inner, 0.04, 0.04, F.R_TRIM, n=3)


def build_platform(p):
    lo = ngon_ring((0, F.PLAT_Y0, 0), F.PLAT_R, n=8, axis='y')
    hi = ngon_ring((0, F.PLAT_Y1, 0), F.PLAT_R, n=8, axis='y')
    p.add_face(hi, zone=F.R_PLAT, flip=True)          # deck top
    p.add_face(lo, zone=Z_PLAT_B, flip=False)         # underside
    rad = lambda c: (c[0], 0, c[2])
    quad_ring(p, lo, hi, F.R_RIM, 0.0, 0.33, rad)     # rim side
    # parapet ring wall with a gap segment at the -Z stair arrival (j=5)
    po_lo = hi
    po_hi = ngon_ring((0, F.PARAPET_TOP, 0), F.PLAT_R, n=8, axis='y')
    pi_hi = ngon_ring((0, F.PARAPET_TOP, 0), F.PARAPET_R_IN, n=8, axis='y')
    pi_lo = ngon_ring((0, F.PLAT_Y1, 0), F.PARAPET_R_IN, n=8, axis='y')
    gap = (5,)
    quad_ring(p, po_lo, po_hi, F.R_RIM, 0.33, 0.62, rad, skip=gap)
    quad_ring(p, po_hi, pi_hi, F.R_RIM, 0.62, 0.80, lambda c: (0, 1, 0),
              skip=gap)
    quad_ring(p, pi_hi, pi_lo, F.R_RIM, 0.80, 1.0,
              lambda c: (-c[0], 0, -c[2]), skip=gap)
    # gap end caps (parapet cross-section closes at both sides of the gap)
    for j in (5, 6):
        quad = [po_lo[j], po_hi[j], pi_hi[j], pi_lo[j]]
        tang = np.cross(np.asarray([po_lo[j][0], 0, po_lo[j][2]]), [0, 1, 0])
        if j == 6:
            tang = -tang
        q, uv = oriented(quad, [Z_PLAT_B.uv(v) for v in quad], tang)
        p.add_face(q, uvs=uv)


def build_body():
    p = Part('body')
    build_pad(p)
    build_tower(p)
    build_stair(p)
    build_platform(p)
    return p


# ── head / beacon ────────────────────────────────────────────────────────

def build_head():
    p = Part('head')
    vert_tube(p, [(0.0, F.DRUM_R0), (F.DRUM_H, F.DRUM_R1)], F.R_HEAD,
              n=8, cap_top=F.R_HEAD_T)
    # receiver cone (buried into the drum at the attach end)
    tube(p, [(F.CONE_Z0, F.CONE_R0, F.CONE_Y),
             (F.CONE_Z1, F.CONE_R1, F.CONE_Y)], F.R_CONE, n=8)
    ro = ngon_ring((0, F.CONE_Y, F.CONE_Z1), F.CONE_R1, n=8, axis='z')
    ri = ngon_ring((0, F.CONE_Y, F.CONE_Z1), F.CONE_R_IN, n=8, axis='z')
    for j in range(8):
        k = (j + 1) % 8
        quad = [ro[j], ro[k], ri[k], ri[j]]
        q, uv = oriented(quad, [Z_CONE_FACE.uv(v) for v in quad],
                         np.array([0.0, 0.0, -1.0]))
        p.add_face(q, uvs=uv)                          # mouth annulus
    apex = (0.0, F.CONE_Y, F.CONE_APEX_Z)
    for j in range(8):
        k = (j + 1) % 8
        tri = [ri[j], ri[k], apex]
        q, uv = oriented(tri + [], [Z_CONE_FACE.uv(v) for v in tri],
                         np.array([0.0, 0.0, -1.0]))
        p.add_face(q, uvs=uv)                          # interior cup
    # boarding gangway (forward, under the cone)
    x, y, z, w, h, d = F.GANGWAY
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+x': F.R_GANG, '-x': F.R_GANG, '-z': F.R_GANG_F,
                 '+y': F.R_GANG_T}, skip=('+z', '-y'))
    # counterweight (aft)
    x, y, z, w, h, d = F.CW
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+x': F.R_CW, '-x': F.R_CW, '+z': F.R_CW_F,
                 '+y': F.R_CW_T, '-y': F.R_CW_T}, skip=('-z',))
    return p


def build_beacon():
    p = Part('beacon')
    limb(p, (0, 0, 0), (0, F.BEACON_POST_H, 0), 0.05, 0.05, F.R_TRIM, n=4)
    x, y, z, w, h, d = F.BEACON_BOX
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+x': F.R_BEACON, '-x': F.R_BEACON, '+z': F.R_BEACON,
                 '-z': F.R_BEACON, '+y': F.R_BEACON, '-y': F.R_BEACON})
    # finial tip pyramid
    top = y + h / 2
    half = 0.14
    ring = [(half, top, half), (-half, top, half),
            (-half, top, -half), (half, top, -half)]
    apex = (0.0, F.BEACON_TIP, 0.0)
    for j in range(4):
        k = (j + 1) % 4
        tri = [ring[j], ring[k], apex]
        c = np.mean(np.array(tri), axis=0)
        q, uv = oriented(tri, [Z_TIP.uv(v) for v in tri],
                         np.array([c[0], 0.3, c[2]]))
        p.add_face(q, uvs=uv)
    return p


# ── clips ────────────────────────────────────────────────────────────────

def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    T = 40.0    # slow weathervane, one turn
    keys = [(T * i / 4, qy(90.0 * i)) for i in range(5)]
    return [{'name': 'idle', 'channels': [('head', 'rotation', keys)]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='head', parent=0, offset=F.HEAD_OFF, part=build_head()),
        dict(name='beacon', parent=1, offset=F.BEACON_OFF, part=build_beacon()),
        dict(name='dock', parent=1, offset=F.DOCK_OFF, part=None),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
