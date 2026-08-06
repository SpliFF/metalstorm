"""gen_ms_anc_sentinel — assemble ms_anc_sentinel and export .gltf/.bin.

Ancient sentinel drone (s1 flyer, 3.48 m): seamless oblate lens hull with a
cyan equatorial light line, three folded stabiliser vanes swept down under
the belly (team-mask tips), a slung `eye` pod with a cyan iris that scans a
full turn per idle loop, and a free-floating `halo` ring that counter-scans
above the crown without ever touching the hull.

Flyer: authored at hover height 0 — the model origin is the hover
reference at the hull mid-plane, NOT a ground contact point.

Run: python3 gen_ms_anc_sentinel.py -> out/ms_anc_sentinel{,_png}.gltf + .bin
"""
from __future__ import annotations
import numpy as np

import ms_anc_sentinel_layout as F   # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, loft
from gltf_export import export

STEM = 'ms_anc_sentinel'
OUT = 'out'


def quad_out(p, verts, outward, zone=None, uvs=None):
    """Add a quad wound so its flat normal points along `outward`."""
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    flip = np.dot(n, np.asarray(outward, dtype=float)) <= 0
    p.add_face(verts, zone=zone, uvs=uvs, flip=flip)


def rect_uv(rect, fu, fv):
    """(0..1, 0..1) inside an atlas rect -> glTF uv."""
    x0, y0, x1, y1 = rect
    return ((x0 + fu * (x1 - x0)) / M.ATLAS,
            (y0 + fv * (y1 - y0)) / M.ATLAS)


# ── body: the seamless oblate hull + three folded vanes ─────────────────

def hull_ring(y, r, n):
    """Ring about +Y, ordered so loft() emits outward normals."""
    return [(r * np.cos(2 * np.pi * i / n), y, r * np.sin(2 * np.pi * i / n))
            for i in range(n)]


def hull_zone(c, n):
    """Rim cylinder -> equatorial light line; else project from above/below."""
    if abs(n[1]) < 0.25:
        return F.Z_EQ
    return F.Z_TOP if n[1] > 0 else F.Z_BOT


def vane(p, az_deg):
    """One folded stabiliser blade at azimuth `az_deg` (0 deg = +X, 90 = +Z).

    Chord runs along the local tangent, span sweeps down-and-inward, the
    broad faces point radially out/in.  UVs are explicit: u = chord,
    v = span (0 at the buried root, 1 at the team-mask tip).
    """
    a = np.radians(az_deg)
    e_r = np.array([np.cos(a), 0.0, np.sin(a)])
    e_t = np.array([-np.sin(a), 0.0, np.cos(a)])
    up = np.array([0.0, 1.0, 0.0])
    st = F.VANE_ST
    ns = len(st)

    corners, norms = [], []
    for i, (r, y, c, th) in enumerate(st):
        # span tangent in the (radial, y) half-plane, central-differenced
        j0, j1 = max(0, i - 1), min(ns - 1, i + 1)
        d = np.array([st[j1][0] - st[j0][0], st[j1][1] - st[j0][1]])
        d /= max(np.linalg.norm(d), 1e-9)
        nn = np.array([-d[1], d[0]])            # thickness dir, same plane
        nv = nn[0] * e_r + nn[1] * up
        base = r * e_r + y * up
        corners.append([base + c * e_t + th * nv,   # A: chord+, thick+
                        base - c * e_t + th * nv,   # B: chord-, thick+
                        base - c * e_t - th * nv,   # C: chord-, thick-
                        base + c * e_t - th * nv])  # D: chord+, thick-
        norms.append(nv)

    R = F.R_VANE
    EPS = 0.055                                  # sliver for the chord edges
    for i in range(ns - 1):
        A0, B0, C0, D0 = corners[i]
        A1, B1, C1, D1 = corners[i + 1]
        v0, v1 = F.VANE_SP[i], F.VANE_SP[i + 1]
        nv = norms[i] + norms[i + 1]
        quad_out(p, [A0, B0, B1, A1], nv, uvs=[
            rect_uv(R, 1.0, v0), rect_uv(R, 0.0, v0),
            rect_uv(R, 0.0, v1), rect_uv(R, 1.0, v1)])
        quad_out(p, [D0, C0, C1, D1], -nv, uvs=[
            rect_uv(R, 1.0, v0), rect_uv(R, 0.0, v0),
            rect_uv(R, 0.0, v1), rect_uv(R, 1.0, v1)])
        quad_out(p, [A0, D0, D1, A1], e_t, uvs=[
            rect_uv(R, 1.0, v0), rect_uv(R, 1.0 - EPS, v0),
            rect_uv(R, 1.0 - EPS, v1), rect_uv(R, 1.0, v1)])
        quad_out(p, [B0, C0, C1, B1], -e_t, uvs=[
            rect_uv(R, 0.0, v0), rect_uv(R, EPS, v0),
            rect_uv(R, EPS, v1), rect_uv(R, 0.0, v1)])

    # tip cap — inside the team-mask band
    A, B, C, D = corners[-1]
    tip = (np.array(F.VANE_ST[-1][:2]) - np.array(F.VANE_ST[-2][:2]))
    tipv = tip[0] * e_r + tip[1] * up
    quad_out(p, [A, B, C, D], tipv, uvs=[
        rect_uv(R, 1.0, 1.0), rect_uv(R, 0.0, 1.0),
        rect_uv(R, 0.0, 1.0 - EPS), rect_uv(R, 1.0, 1.0 - EPS)])


def build_body():
    p = Part('body')
    rings = [hull_ring(y, r, F.HULL_N) for (y, r) in F.HULL_RINGS]
    loft(p, rings, hull_zone, cap_start=F.Z_TOP, cap_end=F.Z_DARK)
    for az in F.VANE_AZ:
        vane(p, az)
    return p


# ── eye: slung sensor pod, iris at -Z, scans about +Y ───────────────────

def build_eye():
    p = Part('eye')
    rings = []
    for (z, r) in F.EYE_RINGS:
        rings.append([(r * np.cos(2 * np.pi * i / F.EYE_N),
                       F.EYE_CY + r * np.sin(2 * np.pi * i / F.EYE_N), z)
                      for i in range(F.EYE_N)])
    loft(p, rings, lambda c, n: F.Z_EYE, cap_start=F.Z_IRIS, cap_end=F.Z_DARK)
    return p


# ── halo: free-floating ring above the crown ────────────────────────────

def build_halo():
    p = Part('halo')
    nu, nv = F.HALO_NU, F.HALO_NV
    R, t = F.HALO_R, F.HALO_T

    def vert(i, j):
        A = 2 * np.pi * i / nu
        B = 2 * np.pi * j / nv + np.pi      # j = nv/2 -> outer equator (v=0.5)
        e_r = np.array([np.cos(A), 0.0, np.sin(A)])
        return R * e_r + t * (np.cos(B) * e_r + np.sin(B) * np.array([0, 1, 0]))

    for i in range(nu):
        for j in range(nv):
            i1, j1 = (i + 1) % nu, (j + 1) % nv
            v00, v10, v11, v01 = vert(i, j), vert(i1, j), vert(i1, j1), vert(i, j1)
            ctr = np.array([np.cos(2 * np.pi * (i + 0.5) / nu), 0.0,
                            np.sin(2 * np.pi * (i + 0.5) / nu)]) * R
            outward = (v00 + v10 + v11 + v01) / 4.0 - ctr
            quad_out(p, [v00, v10, v11, v01], outward, uvs=[
                rect_uv(F.R_HALO, i / nu, j / nv),
                rect_uv(F.R_HALO, (i + 1) / nu, j / nv),
                rect_uv(F.R_HALO, (i + 1) / nu, (j + 1) / nv),
                rect_uv(F.R_HALO, i / nu, (j + 1) / nv)])
    return p


# ── idle clip: eye scan + halo counter-scan and float ───────────────────

def qy(deg):
    h = np.radians(deg) / 2.0
    return (0.0, float(np.sin(h)), 0.0, float(np.cos(h)))


def build_clips():
    T = F.IDLE_T
    n = 8                                    # 45 deg steps -> clean slerp
    eye = [(T * i / n, qy(360.0 * F.EYE_TURNS * i / n)) for i in range(n + 1)]
    halo = [(T * i / n, qy(360.0 * F.HALO_TURNS * i / n)) for i in range(n + 1)]
    hy = F.HALO_OFF[1]
    bob = [(T * i / 16,
            (0.0, hy + F.HALO_BOB * float(np.sin(2 * np.pi * i / 8)), 0.0))
           for i in range(17)]
    return [{'name': 'idle', 'channels': [
        ('eye', 'rotation', eye),
        ('halo', 'rotation', halo),
        ('halo', 'translation', bob),
    ]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),   # 0
        dict(name='eye', parent=0, offset=F.EYE_OFF, part=build_eye()),      # 1
        dict(name='halo', parent=0, offset=F.HALO_OFF, part=build_halo()),   # 2
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    for pc in pieces:
        print(f"  {pc['name']:6s} {pc['part'].tri_count():5d} tris")
    print(f'{STEM}: {total} tris')
