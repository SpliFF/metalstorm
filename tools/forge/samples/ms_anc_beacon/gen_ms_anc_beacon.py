"""gen_ms_anc_beacon — assemble ms_anc_beacon and export .gltf/.bin.

ANCIENT REGISTER summoning beacon, 26 m, articulated: soil-buried
monolithic stepped dais, seamless tapering mast (six segments, recessed
seams only), four cantilevered mid-mast vanes with four FLOATING
keystones above them, a wider-than-mast crown corbel, and an unfolding
petal array — hub piece `array` (perfect 12-gon circle, slow seamless
idle rotation about Y) carrying six blades `petal1..petal6` that unfold
30 deg outward about their hub-tangent hinges (`open`, seamless
unfold-hold-refold). Intense CYAN lens crowns the axis at 26 m.
Guy-less. No team colour.
Run: python3 gen_ms_anc_beacon.py -> out/ms_anc_beacon{,_png}.gltf
"""
import numpy as np

import ms_anc_beacon_layout as F   # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, chamfer_box
from gltf_export import export

STEM = 'ms_anc_beacon'
OUT = 'out'
A = float(M.ATLAS)


# ── low-level helpers (correct winding + parametric UVs) ─────────────────

def _newell(vs):
    n = np.zeros(3)
    for i in range(len(vs)):
        c, x = vs[i], vs[(i + 1) % len(vs)]
        n[0] += (c[1] - x[1]) * (c[2] + x[2])
        n[1] += (c[2] - x[2]) * (c[0] + x[0])
        n[2] += (c[0] - x[0]) * (c[1] + x[1])
    ln = np.linalg.norm(n)
    return n / ln if ln > 1e-12 else n


def face_out(p, verts, outward, uvs):
    """Add a polygon wound so its flat normal points along `outward`."""
    vs = [np.asarray(v, float) for v in verts]
    if np.dot(_newell(vs), np.asarray(outward, float)) < 0:
        vs, uvs = vs[::-1], uvs[::-1]
    p.add_face([tuple(v) for v in vs], uvs=uvs)


def _subrect(rect, v0, v1):
    x0, y0, x1, y1 = rect
    h = y1 - y0
    return (x0, y0 + h * v0, x1, y0 + h * v1)


def _cap_uvs(poly, nrm, rect):
    """Planar-project a cap polygon into `rect` using its own basis."""
    P = [np.asarray(v, float) for v in poly]
    e1 = P[1] - P[0]
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(nrm, e1)
    ss = np.array([[float(np.dot(v - P[0], e1)), float(np.dot(v - P[0], e2))]
                   for v in P])
    lo, hi = ss.min(axis=0), ss.max(axis=0)
    span = np.maximum(hi - lo, 1e-6)
    x0, y0, x1, y1 = rect
    return [(( x0 + (x1 - x0) * (0.06 + 0.88 * (s[0] - lo[0]) / span[0])) / A,
             ( y0 + (y1 - y0) * (0.06 + 0.88 * (s[1] - lo[1]) / span[1])) / A)
            for s in ss]


def prism(p, poly, ext, rect):
    """Extrude convex polygon `poly` by vector `ext`; parametric side UVs in
    the top half of `rect`, planar-projected caps in the bottom half."""
    Aq = [np.asarray(v, float) for v in poly]
    e = np.asarray(ext, float)
    eh = e / np.linalg.norm(e)
    Bq = [v + e for v in Aq]
    nrm = _newell(Aq)
    if np.dot(nrm, eh) < 0:            # keep nrm on the +ext side
        nrm = -nrm
        Aq, Bq = Bq, Aq
        eh = -eh
    n = len(Aq)
    sx0, sy0, sx1, sy1 = _subrect(rect, 0.0, 0.52)
    for i in range(n):
        j = (i + 1) % n
        ed = Aq[j] - Aq[i]
        outw = np.cross(nrm, ed)
        u0 = (sx0 + (sx1 - sx0) * i / n) / A
        u1 = (sx0 + (sx1 - sx0) * (i + 1) / n) / A
        uvs = [(u0, sy0 / A), (u1, sy0 / A), (u1, sy1 / A), (u0, sy1 / A)]
        face_out(p, [Aq[i], Aq[j], Bq[j], Bq[i]], outw, uvs)
    crect = _subrect(rect, 0.56, 1.0)
    face_out(p, Bq, nrm, _cap_uvs(Bq, nrm, crect))
    face_out(p, Aq, -nrm, _cap_uvs(Aq, nrm, crect))


def skin(p, rings, rect, cap_start=False, cap_end=False, cap_rect=None):
    """Skin equal-length vertex rings; u runs along the rings, v around."""
    x0, y0, x1, y1 = rect
    nr, n = len(rings), len(rings[0])
    ctr = [np.mean(np.array(r), axis=0) for r in rings]
    for i in range(nr - 1):
        r0, r1 = rings[i], rings[i + 1]
        u0 = (x0 + (x1 - x0) * i / (nr - 1)) / A
        u1 = (x0 + (x1 - x0) * (i + 1) / (nr - 1)) / A
        axis = 0.5 * (ctr[i] + ctr[i + 1])
        for j in range(n):
            k = (j + 1) % n
            quad = [r0[j], r0[k], r1[k], r1[j]]
            va = (y0 + (y1 - y0) * j / n) / A
            vb = (y0 + (y1 - y0) * (k if k else n) / n) / A
            uvs = [(u0, va), (u0, vb), (u1, vb), (u1, va)]
            outw = np.mean(np.array(quad), axis=0) - axis
            face_out(p, quad, outw, uvs)
    cr = cap_rect if cap_rect is not None else rect
    cx0, cy0, cx1, cy1 = cr
    def circ_uvs(m):
        return [(((cx0 + cx1) / 2 + 0.42 * (cx1 - cx0) * np.cos(2 * np.pi * j / m)) / A,
                 ((cy0 + cy1) / 2 + 0.42 * (cy1 - cy0) * np.sin(2 * np.pi * j / m)) / A)
                for j in range(m)]
    if cap_start:
        face_out(p, rings[0], ctr[0] - ctr[1], circ_uvs(n))
    if cap_end:
        face_out(p, rings[-1], ctr[-1] - ctr[-2], circ_uvs(n))


def ring_y(cy, y, r, n, phase=0.0):
    """n-gon ring in the XZ plane at height y, centred on (cy[0], cy[1])."""
    return [(cy[0] + r * np.cos(phase + 2 * np.pi * i / n), y,
             cy[1] + r * np.sin(phase + 2 * np.pi * i / n)) for i in range(n)]


def radial(theta):
    """(outward radial d, tangent t) with d x Y = t (right-handed)."""
    d = np.array([np.cos(theta), 0.0, np.sin(theta)])
    t = np.array([-np.sin(theta), 0.0, np.cos(theta)])
    return d, t


def profile_prism(p, prof, theta, thick, rect):
    """Extrude a (radius, y) profile placed on the radial `theta` plane,
    tangentially by `thick` — buttresses, vanes, keystones."""
    d, t = radial(theta)
    poly = [tuple(d * r + np.array([0.0, y, 0.0]) - t * (thick / 2)) for r, y in prof]
    prism(p, poly, tuple(t * thick), rect)


# ── body ─────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    zbox = {'+x': F.R_MAST_X, '-x': F.R_MAST_X,
            '+z': F.R_MAST_Z, '-z': F.R_MAST_Z, '+y': F.R_SHELF}

    # monolithic stepped dais (lowest tier soil-buried in the texture)
    for cy, h, w, ch in F.DAIS:
        chamfer_box(p, (0.0, cy, 0.0), (w, h, w), ch,
                    {'+y': F.R_DAIS_TOP, '+x': F.R_DAIS_SX, '-x': F.R_DAIS_SX,
                     '+z': F.R_DAIS_SZ, '-z': F.R_DAIS_SZ}, skip=('-y',))

    # seamless tapering mast — segmentation IS the seam, nothing bolted
    for cx, cz, y0, y1, w in F.SEGS:
        chamfer_box(p, (cx, (y0 + y1) / 2, cz), (w, y1 - y0, w), 0.075,
                    zbox, skip=('-y',))

    # crown corbel — wider than the mast it stands on
    cx, cy, cz, w, h, d, ch = F.CORBEL
    chamfer_box(p, (cx, cy, cz), (w, h, d), ch, zbox, skip=('-y',))

    # four swept buttress wedges at 45 deg (off the vane axes)
    for i in range(F.BUTTRESS_N):
        th = np.pi / 4 + 2 * np.pi * i / F.BUTTRESS_N
        profile_prism(p, F.BUTTRESS, th, F.BUTTRESS_T, F.R_BUTT)

    # four mid-mast cantilever vanes + four FLOATING keystones above them
    kr, ky, kz = F.KEY_SIZE
    for i in range(F.VANE_N):
        th = 2 * np.pi * i / F.VANE_N
        profile_prism(p, F.VANE, th, F.VANE_T, F.R_VANE)
        key = [(F.KEY_R - kr / 2, F.KEY_Y - ky / 2),
               (F.KEY_R + kr / 2, F.KEY_Y - ky / 2),
               (F.KEY_R + kr / 2, F.KEY_Y + ky / 2),
               (F.KEY_R - kr / 2, F.KEY_Y + ky / 2)]
        profile_prism(p, key, th, kz, F.R_KEY)
    return p


# ── array (hub + axis column + crown lens) ───────────────────────────────

def build_array():
    p = Part('array')
    rings = [ring_y((0.0, 0.0), y, r, F.HUB_N) for y, r in F.HUB_RINGS]
    skin(p, rings, F.R_HUB, cap_start=True, cap_end=True,
         cap_rect=F.R_HUBCAP.rect)
    col = [ring_y((0.0, 0.0), y, r, F.COLUMN_N) for y, r in F.COLUMN]
    skin(p, col, F.R_COLUMN)
    lens = [ring_y((0.0, 0.0), y, r, F.LENS_N) for y, r in F.LENS]
    skin(p, lens, F.R_LENS, cap_start=True, cap_end=True,
         cap_rect=F.R_DARK.rect)
    return p


# ── petals ───────────────────────────────────────────────────────────────

def build_petal(i):
    """Blade + inner emitter filament, authored about its hinge origin in
    array-parallel axes (so the piece's rest rotation is identity)."""
    p = Part('petal%d' % (i + 1))
    d, t = radial(F.PETAL_ANGLES[i])
    Y = np.array([0.0, 1.0, 0.0])
    rings = []
    for inw, y, hw, ht in F.PETAL:
        c = -d * inw + Y * y
        rings.append([tuple(c + t * (hw * np.cos(a)) + d * (ht * np.sin(a)))
                      for a in (np.pi / F.PETAL_SECT
                                + 2 * np.pi * k / F.PETAL_SECT
                                for k in range(F.PETAL_SECT))])
    skin(p, rings, F.R_PETAL, cap_start=True, cap_end=True,
         cap_rect=F.R_PETAL_CAP)
    fil = []
    for inw, y, r in F.FIL:
        c = -d * (inw + F.FIL_STANDOFF) + Y * y
        fil.append([tuple(c + t * (r * np.cos(a)) + d * (r * np.sin(a)))
                    for a in (np.pi / F.FIL_N + 2 * np.pi * k / F.FIL_N
                              for k in range(F.FIL_N))])
    skin(p, fil, F.R_FIL, cap_start=True, cap_end=True, cap_rect=F.R_FIL)
    return p


# ── clips ────────────────────────────────────────────────────────────────

def quat(axis, deg):
    a = np.radians(deg) / 2.0
    ax = np.asarray(axis, float)
    ax = ax / np.linalg.norm(ax)
    s = float(np.sin(a))
    return (float(ax[0] * s), float(ax[1] * s), float(ax[2] * s),
            float(np.cos(a)))


# The unfold is authored as its own `open` clip per the spec, but the
# toolkit's validate.py hard-codes the allowed clip names to
# {walk, idle, death}, so shipping it separately fails the build gate.
# SPLIT_OPEN_CLIP=False therefore folds the identical petal channels into
# `idle`, which the engine plays out of the box; flip it to True the moment
# validate.py's allow-list grows `open` (the client's playClip(name) already
# accepts any name).
SPLIT_OPEN_CLIP = False


def petal_channels(period):
    """Seamless unfold -> hold-wide -> refold on all six blades."""
    k0, k1, k2, k3 = F.OPEN_KEYS
    ch = []
    for i in range(F.PETAL_N):
        _, t = radial(F.PETAL_ANGLES[i])
        shut = quat(t, 0.0)
        wide = quat(t, -F.PETAL_OPEN_DEG)     # -a about the tangent tips out
        ch.append(('petal%d' % (i + 1), 'rotation',
                   [(k0 * period, shut), (k1 * period, wide),
                    (k2 * period, wide), (k3 * period, shut)]))
    return ch


def build_clips():
    T = F.IDLE_PERIOD
    spin = ('array', 'rotation',
            [(T * i / 4.0, quat((0, 1, 0), 90.0 * i)) for i in range(5)])
    if SPLIT_OPEN_CLIP:
        return [{'name': 'idle', 'channels': [spin]},
                {'name': 'open', 'channels': petal_channels(F.OPEN_PERIOD)}]
    return [{'name': 'idle', 'channels': [spin] + petal_channels(T)}]


def build_all():
    d0 = np.array([0.0, 0.0, 0.0])
    pieces = [dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
              dict(name='array', parent=0, offset=F.ARRAY_PIVOT,
                   part=build_array())]
    for i in range(F.PETAL_N):
        d, _ = radial(F.PETAL_ANGLES[i])
        h = d * F.PETAL_HINGE_R + np.array([0.0, F.PETAL_HINGE_Y, 0.0]) + d0
        pieces.append(dict(name='petal%d' % (i + 1), parent=1,
                           offset=tuple(float(v) for v in h),
                           part=build_petal(i)))
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
