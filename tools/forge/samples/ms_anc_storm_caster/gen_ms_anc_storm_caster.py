"""gen_ms_anc_storm_caster — assemble the Ancient storm caster and export.

Ancient register: monolithic, seamless, grand. Everything is a large
unbroken surface cut by recessed seams — no rivets, no patches. Pieces:

    body   scorched earth ring, flared apron, collar, inner recess,
           discharge-array floor, four grounded lightning vanes, and the
           team-mask capture tab on the front (-Z) vane
    core   cyan tesla core: pedestal, column, FLOATING faceted crystal,
           needle spire, finial   (rises 0.45 m during `open`)
    ring   floating halo above the oculus (precesses during `idle`)
    dome   the hemispheric shell's compression ring — parent of
    petal1..petal6   iris petals, hinged on the equator (`open`: part 56 deg)

Run: python3 gen_ms_anc_storm_caster.py -> out/*.gltf + .bin
"""
import numpy as np

import ms_anc_storm_caster_layout as F     # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part
from gltf_export import export

STEM = 'ms_anc_storm_caster'
OUT = 'out'


# ── low-level helpers ───────────────────────────────────────────────────

def face_out(p, verts, outward, zone=None, uvs=None):
    """Add a polygon wound so its normal points along `outward`."""
    a, b, c = (np.asarray(verts[i], float) for i in range(3))
    n = np.cross(b - a, c - a)
    if np.dot(n, np.asarray(outward, float)) >= 0:
        p.add_face(list(verts), zone=zone, uvs=uvs)
    else:
        p.add_face(list(verts)[::-1], zone=zone,
                   uvs=(list(uvs)[::-1] if uvs is not None else None))


def ring_pts(r, y, n, phase=0.0):
    return [(r * np.cos(phase + 2 * np.pi * i / n), y,
             r * np.sin(phase + 2 * np.pi * i / n)) for i in range(n)]


def skin(p, r0, r1, rect, f0, f1, out_fn, closed=True, uspan=(0.0, 1.0)):
    """Skin two equal-length vertex rings with parametric UVs.
    u = around (index) mapped through `uspan` into rect x;
    v = f0 (ring r0) -> f1 (ring r1) as fractions of rect height.
    out_fn(quad_centre, j) -> outward hint for winding."""
    x0, y0, x1, y1 = rect
    A = M.ATLAS
    n = len(r0)
    quads = n if closed else n - 1
    denom = n if closed else n - 1
    us0, us1 = uspan
    for j in range(quads):
        k = (j + 1) % n
        quad = [r0[j], r0[k], r1[k], r1[j]]
        fa = us0 + (us1 - us0) * (j / denom)
        fb = us0 + (us1 - us0) * ((j + 1) / denom)
        ua = (x0 + (x1 - x0) * fa) / A
        ub = (x0 + (x1 - x0) * fb) / A
        va = (y0 + (y1 - y0) * f0) / A
        vb = (y0 + (y1 - y0) * f1) / A
        uvs = [(ua, va), (ub, va), (ub, vb), (ua, vb)]
        c = np.mean(np.asarray(quad, float), axis=0)
        face_out(p, quad, out_fn(c, j), uvs=uvs)


def band_y(p, y0, r0, y1, r1, n, rect, f0=0.0, f1=1.0, inward=False):
    """Coaxial (about Y) wrap band between two rings."""
    a = ring_pts(r0, y0, n)
    b = ring_pts(r1, y1, n)
    s = -1.0 if inward else 1.0

    def out_fn(c, j):
        return (s * c[0], 0.0, s * c[2])
    skin(p, a, b, rect, f0, f1, out_fn)


def annulus(p, y, ri, ro, n, zone, up=True):
    """Horizontal annulus with a planar (x,z) Zone."""
    a = ring_pts(ri, y, n)
    b = ring_pts(ro, y, n)
    hint = (0, 1 if up else -1, 0)
    for j in range(n):
        k = (j + 1) % n
        face_out(p, [a[j], a[k], b[k], b[j]], hint, zone=zone)


def band_ring_uv(p, ri, ro, y, n, rect, f0, f1, up=True):
    """Horizontal annulus with a PARAMETRIC wrap (u around, v radial)."""
    a = ring_pts(ri, y, n)
    b = ring_pts(ro, y, n)
    hint = (0.0, 1.0 if up else -1.0, 0.0)
    skin(p, a, b, rect, f0, f1, lambda c, j: hint)


# ── body ────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    n = F.N_BIG

    # scorched, glassed earth ring — two concentric bands so the impostor
    # keeps a radial gradient instead of one flat disc colour
    r0, r1, r2 = F.SCORCH_R
    annulus(p, F.SCORCH_Y, r0, r1, n, F.R_SCORCH)
    annulus(p, F.SCORCH_Y, r1, r2, n, F.R_SCORCH)

    # flared monolithic apron (cantilevered rim), grounded — no base face
    band_y(p, F.APRON_Y0, F.APRON_R0, F.APRON_Y1, F.APRON_R1, n,
           F.R_APRON_W, f0=1.0, f1=0.0)
    annulus(p, F.APRON_Y1, F.COLLAR_R, F.APRON_R1, n, F.R_DISC)

    # collar drum (shrouded by the dome ring) + inner recess + array floor
    band_y(p, F.COLLAR_Y0, F.COLLAR_R, F.COLLAR_Y1, F.COLLAR_R, n,
           F.R_COLLAR_W, f0=1.0, f1=0.0)
    annulus(p, F.COLLAR_Y1, F.RECESS_R, F.COLLAR_R, n, F.R_DISC)
    band_y(p, F.COLLAR_Y1, F.RECESS_R, F.ARRAY_Y, F.RECESS_R, n,
           F.R_RECESS_W, f0=0.0, f1=1.0, inward=True)
    a0, a1, a2 = F.ARRAY_R
    annulus(p, F.ARRAY_Y, a0, a1, n, F.R_DISC)
    annulus(p, F.ARRAY_Y, a1, a2, n, F.R_DISC)

    # four grounded lightning vanes
    for vi, adeg in enumerate(F.VANE_A):
        build_vane(p, np.radians(adeg))
        if vi == F.TAB_VANE:
            build_tab(p, np.radians(adeg))
    return p


HEX = [(1.00, 0.0), (0.55, 1.0), (-0.55, 1.0),
       (-1.00, 0.0), (-0.55, -1.0), (0.55, -1.0)]


def _vane_ring(a, y, r, hw, ht):
    rh = np.array([np.cos(a), 0.0, np.sin(a)])
    th = np.array([-np.sin(a), 0.0, np.cos(a)])
    up = np.array([0.0, y, 0.0])
    return [tuple(rh * (r + oq * ht) + th * (ot * hw) + up) for (ot, oq) in HEX]


def build_vane(p, a):
    """Standing-stone blade: flattened hexagonal section, wide tangentially,
    thin radially, leaning outward out of the apron flare."""
    rh = np.array([np.cos(a), 0.0, np.sin(a)])
    th = np.array([-np.sin(a), 0.0, np.cos(a)])
    rings = [_vane_ring(a, *st) for st in F.VANE]
    ns = len(rings)

    def out_fn(c, j):
        ot = (HEX[j][0] + HEX[(j + 1) % 6][0]) * 0.5
        oq = (HEX[j][1] + HEX[(j + 1) % 6][1]) * 0.5
        return tuple(rh * oq + th * ot)

    for i in range(ns - 1):
        f0 = 1.0 - i / (ns - 1)
        f1 = 1.0 - (i + 1) / (ns - 1)
        skin(p, rings[i], rings[i + 1], F.R_VANE, f0, f1, out_fn)
    face_out(p, rings[-1], (0, 1, 0), zone=F.R_DARK)      # tip cap


def build_tab(p, a):
    """Capture tab: a proud plate on the vane's outward face (team mask)."""
    rh = np.array([np.cos(a), 0.0, np.sin(a)])
    th = np.array([-np.sin(a), 0.0, np.cos(a)])
    quad_in, quad_out_ = [], []
    for (y, sx) in ((F.TAB_Y0, -1), (F.TAB_Y0, 1), (F.TAB_Y1, 1), (F.TAB_Y1, -1)):
        r, hw, ht = F.vane_at(y)
        base = rh * (r + ht) + th * (sx * F.TAB_HW) + np.array([0.0, y, 0.0])
        quad_in.append(tuple(base))
        quad_out_.append(tuple(base + rh * F.TAB_PROUD))
    face_out(p, quad_out_, tuple(rh), zone=F.R_TAB)
    for j in range(4):
        k = (j + 1) % 4
        e = np.asarray(quad_out_[k], float) - np.asarray(quad_out_[j], float)
        side = np.cross(e, rh)
        face_out(p, [quad_in[j], quad_in[k], quad_out_[k], quad_out_[j]],
                 tuple(side), zone=F.R_DARK)


# ── dome: compression ring + iris petals ────────────────────────────────

def build_dome_ring():
    """Seamless compression ring — dome-local, hinge plane at y=0. It floats
    clear of the apron and shrouds the collar with a recessed shadow gap."""
    p = Part('dome')
    n = F.N_BIG
    band_y(p, F.DR_Y0, F.DR_OUT, F.DR_Y1, F.DR_OUT, n, F.R_DRING_O,
           f0=1.0, f1=0.0)
    band_ring_uv(p, F.DR_IN, F.DR_OUT, F.DR_Y1, n, F.R_DRING_T, 0.0, 1.0)
    band_y(p, F.DR_Y1, F.DR_IN, F.DR_Y0, F.DR_IN, n, F.R_DRING_I,
           f0=0.0, f1=1.0, inward=True)
    return p


def _sph(rad, a, f):
    return np.array([rad * np.cos(f) * np.cos(a), rad * np.sin(f),
                     rad * np.cos(f) * np.sin(a)])


def build_petal(k):
    """Spherical shell wedge; local origin at the hinge on the equator."""
    ac = F.PETAL_A[k]
    H = _sph(F.DOME_R, ac, 0.0)
    p = Part(f'petal{k + 1}')
    Ro, Ri = F.DOME_R, F.DOME_R - F.PETAL_TH
    A = np.linspace(ac - F.PETAL_HALF, ac + F.PETAL_HALF, F.NU + 1)
    Fl = np.linspace(F.LAT0, F.LAT1, F.NV + 1)
    ax = M.ATLAS

    def pt(rad, i, j):
        return tuple(_sph(rad, A[i], Fl[j]) - H)

    def cell(rect, i, j):
        x0, y0, x1, y1 = rect
        ua = (x0 + (x1 - x0) * i / F.NU) / ax
        ub = (x0 + (x1 - x0) * (i + 1) / F.NU) / ax
        vb = (y0 + (y1 - y0) * (1 - j / F.NV)) / ax
        va = (y0 + (y1 - y0) * (1 - (j + 1) / F.NV)) / ax
        return [(ua, vb), (ub, vb), (ub, va), (ua, va)]

    for i in range(F.NU):
        for j in range(F.NV):
            q = [pt(Ro, i, j), pt(Ro, i + 1, j), pt(Ro, i + 1, j + 1), pt(Ro, i, j + 1)]
            c = np.mean(np.asarray(q, float), axis=0) + H
            face_out(p, q, tuple(c), uvs=cell(F.R_PETAL_O, i, j))
            q = [pt(Ri, i, j), pt(Ri, i + 1, j), pt(Ri, i + 1, j + 1), pt(Ri, i, j + 1)]
            c = np.mean(np.asarray(q, float), axis=0) + H
            face_out(p, q, tuple(-c), uvs=cell(F.R_PETAL_I, i, j))

    # rim strips (4 stacked bands in R_PETAL_E) — the cut faces of the iris
    ex0, ey0, ex1, ey1 = F.R_PETAL_E
    strip = (ey1 - ey0) / 4.0

    def sub(s):
        return (ex0, ey0 + s * strip, ex1, ey0 + (s + 1) * strip)

    def tan_f(a, f):
        return np.array([-np.sin(f) * np.cos(a), np.cos(f), -np.sin(f) * np.sin(a)])

    def tan_a(a, f):
        return np.array([-np.cos(f) * np.sin(a), 0.0, np.cos(f) * np.cos(a)])

    amid = ac
    fmid = 0.5 * (F.LAT0 + F.LAT1)
    # bottom rim (lat0) and top rim (lat1) — u along azimuth
    for s, (jj, sgn) in enumerate(((0, -1.0), (F.NV, 1.0))):
        o = tuple(sgn * tan_f(amid, Fl[jj]))
        ro = [pt(Ro, i, jj) for i in range(F.NU + 1)]
        ri = [pt(Ri, i, jj) for i in range(F.NU + 1)]
        skin(p, ro, ri, sub(s), 0.0, 1.0, lambda c, j, o=o: o, closed=False)
    # side rims (a0, a1) — u along latitude
    for s, (ii, sgn) in enumerate(((0, -1.0), (F.NU, 1.0)), start=2):
        o = tuple(sgn * tan_a(A[ii], fmid))
        ro = [pt(Ro, ii, j) for j in range(F.NV + 1)]
        ri = [pt(Ri, ii, j) for j in range(F.NV + 1)]
        skin(p, ro, ri, sub(s), 0.0, 1.0, lambda c, j, o=o: o, closed=False)
    return p


# ── tesla core + halo ───────────────────────────────────────────────────

def build_core():
    p = Part('core')
    band_y(p, F.PED_Y0, F.PED_R0, F.PED_Y1, F.PED_R1, 12, F.R_CORE, 1.0, 0.62)
    annulus(p, F.PED_Y1, F.COL_R0, F.PED_R1, 12, F.R_DISC)
    band_y(p, F.COL_Y0, F.COL_R0, F.COL_Y1, F.COL_R1, 8, F.R_CORE, 0.58, 0.0)
    face_out(p, ring_pts(F.COL_R1, F.COL_Y1, 8), (0, 1, 0), zone=F.R_DISC)

    # floating faceted crystal — the discharge core (bipyramid)
    n, ax = F.CRY_N, M.ATLAS
    rg = ring_pts(F.CRY_R, F.CRY_MID, n)
    x0, y0, x1, y1 = F.R_CRYST
    for i in range(n):
        k = (i + 1) % n
        ua = (x0 + (x1 - x0) * i / n) / ax
        ub = (x0 + (x1 - x0) * (i + 1) / n) / ax
        um = (ua + ub) * 0.5
        vt, vm, vb = y0 / ax, (y0 + y1) * 0.5 / ax, y1 / ax
        apex_t = (0.0, F.CRY_HI, 0.0)
        apex_b = (0.0, F.CRY_LO, 0.0)
        face_out(p, [rg[i], rg[k], apex_t], tuple(np.mean(
            np.asarray([rg[i], rg[k], apex_t], float), axis=0) -
            np.array([0.0, F.CRY_MID, 0.0])),
            uvs=[(ua, vm), (ub, vm), (um, vt)])
        face_out(p, [rg[i], rg[k], apex_b], tuple(np.mean(
            np.asarray([rg[i], rg[k], apex_b], float), axis=0) -
            np.array([0.0, F.CRY_MID, 0.0])),
            uvs=[(ua, vm), (ub, vm), (um, vb)])

    # needle spire through the oculus
    st = F.NEEDLE
    for i in range(len(st) - 1):
        band_y(p, st[i][0], st[i][1], st[i + 1][0], st[i + 1][1], 6,
               F.R_NEEDLE, 1.0 - i / (len(st) - 1),
               1.0 - (i + 1) / (len(st) - 1))
    # finial
    fr = ring_pts(F.FIN_R, F.FIN_MID, 6)
    for i in range(6):
        k = (i + 1) % 6
        for apex, vspan in (((0.0, F.FIN_HI, 0.0), (0.5, 0.0)),
                            ((0.0, F.FIN_LO, 0.0), (0.5, 1.0))):
            c = np.mean(np.asarray([fr[i], fr[k], apex], float), axis=0) - \
                np.array([0.0, F.FIN_MID, 0.0])
            ua = (F.R_CRYST[0] + (F.R_CRYST[2] - F.R_CRYST[0]) * i / 6) / M.ATLAS
            ub = (F.R_CRYST[0] + (F.R_CRYST[2] - F.R_CRYST[0]) * (i + 1) / 6) / M.ATLAS
            vy0, vy1 = F.R_CRYST[1], F.R_CRYST[3]
            va = (vy0 + (vy1 - vy0) * vspan[0]) / M.ATLAS
            vb = (vy0 + (vy1 - vy0) * vspan[1]) / M.ATLAS
            face_out(p, [fr[i], fr[k], apex], tuple(c),
                     uvs=[(ua, va), (ub, va), ((ua + ub) / 2, vb)])
    return p


def build_halo():
    """Perfect circle, floating, tilted — precesses on `idle`."""
    p = Part('ring')
    n, R, w, h = F.HALO_N, F.HALO_R, F.HALO_W, F.HALO_H
    t = F.HALO_TILT
    ct, stt = np.cos(t), np.sin(t)

    def tilt(v):
        x, y, z = v
        return (x, y * ct - z * stt, y * stt + z * ct)

    A = [tilt((np.cos(2 * np.pi * i / n) * (R + w / 2), h / 2,
               np.sin(2 * np.pi * i / n) * (R + w / 2))) for i in range(n)]
    B = [tilt((np.cos(2 * np.pi * i / n) * (R + w / 2), -h / 2,
               np.sin(2 * np.pi * i / n) * (R + w / 2))) for i in range(n)]
    C = [tilt((np.cos(2 * np.pi * i / n) * (R - w / 2), -h / 2,
               np.sin(2 * np.pi * i / n) * (R - w / 2))) for i in range(n)]
    D = [tilt((np.cos(2 * np.pi * i / n) * (R - w / 2), h / 2,
               np.sin(2 * np.pi * i / n) * (R - w / 2))) for i in range(n)]
    tube_c = [tilt((np.cos(2 * np.pi * i / n) * R, 0.0,
                    np.sin(2 * np.pi * i / n) * R)) for i in range(n)]

    def mk(r0, r1, f0, f1):
        def out_fn(c, j):
            k = (j + 1) % n
            mid = (np.asarray(tube_c[j], float) + np.asarray(tube_c[k], float)) * 0.5
            return tuple(np.asarray(c, float) - mid)
        skin(p, r0, r1, F.R_HALO, f0, f1, out_fn)

    mk(A, B, 0.00, 0.25)      # outer face
    mk(B, C, 0.25, 0.50)      # underside
    mk(C, D, 0.50, 0.75)      # inner face
    mk(D, A, 0.75, 1.00)      # top face
    return p


# ── clips ───────────────────────────────────────────────────────────────

def q_axis(axis, ang):
    ax = np.asarray(axis, float)
    ax = ax / np.linalg.norm(ax)
    s = np.sin(ang / 2.0)
    return (float(ax[0] * s), float(ax[1] * s), float(ax[2] * s),
            float(np.cos(ang / 2.0)))


def _open_profile():
    """(t, s) with s in 0..1; seamless — last key repeats the first."""
    def ss(x):
        return x * x * (3 - 2 * x)
    keys = [(0.0, 0.0), (0.6, 0.0)]
    for i in range(1, 6):
        keys.append((0.6 + 2.2 * i / 5, ss(i / 5)))
    keys.append((6.2, 1.0))
    for i in range(1, 6):
        keys.append((6.2 + 2.2 * i / 5, 1.0 - ss(i / 5)))
    keys.append((9.0, 0.0))
    return keys


def build_clips():
    prof = _open_profile()
    alpha = np.radians(F.OPEN_DEG)
    ch = []
    for k in range(6):
        a = F.PETAL_A[k]
        axis = (-np.sin(a), 0.0, np.cos(a))          # equator tangent
        ch.append((f'petal{k + 1}', 'rotation',
                   [(t, q_axis(axis, -alpha * s)) for (t, s) in prof]))
    ch.append(('core', 'translation',
               [(t, (0.0, F.ARRAY_Y + F.CORE_RISE * s, 0.0)) for (t, s) in prof]))
    idle = [('ring', 'rotation',
             [(24.0 * i / 8, q_axis((0, 1, 0), 2 * np.pi * i / 8)) for i in range(9)])]
    return [{'name': 'open', 'channels': ch},
            {'name': 'idle', 'channels': idle}]


# ── assembly ────────────────────────────────────────────────────────────

def build_all():
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='core', parent=0, offset=(0, F.ARRAY_Y, 0), part=build_core()),
        dict(name='ring', parent=1, offset=F.HALO_OFF, part=build_halo()),
        dict(name='dome', parent=0, offset=(0, F.DOME_Y, 0), part=build_dome_ring()),
    ]
    for k in range(6):
        H = _sph(F.DOME_R, F.PETAL_A[k], 0.0)
        pieces.append(dict(name=f'petal{k + 1}', parent=3,
                           offset=(float(H[0]), 0.0, float(H[2])),
                           part=build_petal(k)))
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    for pc in pieces:
        print(f"  {pc['name']:<8} {pc['part'].tri_count():>5} tris")
    print(f'{STEM}: {total} tris')
