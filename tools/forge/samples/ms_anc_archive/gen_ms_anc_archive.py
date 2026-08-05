"""gen_ms_anc_archive — assemble ms_anc_archive and export .gltf/.bin.

ANCIENT REGISTER data archive, 22 m. Monolithic 16-gon plinth with a
sunken court and a central altar; five LEANING data-stacks on precise
octagonal footings, each cut by four clean recessed seams and crowned
by a floating shard; and a floating tilted `index` ring carrying twelve
index tablets, threading between the stacks with a very slow seamless
idle orbit about Y. No bolts, no patches, no team colour.

Run: python3 gen_ms_anc_archive.py -> out/ms_anc_archive{,_png}.gltf
"""
import numpy as np

import ms_anc_archive_layout as F   # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, limb, ngon_ring
from gltf_export import export

STEM = 'ms_anc_archive'
OUT = 'out'
A = 2048.0


# ── generic helpers (candidates for prefabs/parts.py) ───────────────────

def _n(v):
    v = np.asarray(v, dtype=float)
    return v / np.linalg.norm(v)


def _wind(quad, uvs, ref):
    """Return (quad, uvs) wound so the face normal points along `ref`."""
    q = [np.asarray(v, dtype=float) for v in quad]
    nrm = np.cross(q[1] - q[0], q[3] - q[0])
    if np.dot(nrm, ref) < 0:
        return quad[::-1], uvs[::-1]
    return quad, uvs


def band(part, ra, rb, rect, out='radial', axis_xz=(0.0, 0.0)):
    """Loft two equal-length closed rings with parametric UVs.
    u runs around the ring (rect x0..x1); ring `ra` maps to the rect's
    BOTTOM edge (y1) and `rb` to its top (y0), so world-up reads image-up.
    `out`: 'radial' | '-radial' | '+y' | '-y' — which way the faces look."""
    x0, y0, x1, y1 = rect
    n = len(ra)
    for i in range(n):
        k = (i + 1) % n
        ua = (x0 + (x1 - x0) * i / n) / A
        ub = (x0 + (x1 - x0) * (i + 1) / n) / A
        va, vb = y1 / A, y0 / A
        quad = [ra[i], ra[k], rb[k], rb[i]]
        uvs = [(ua, va), (ub, va), (ub, vb), (ua, vb)]
        c = np.mean(np.array(quad, dtype=float), axis=0)
        if out == 'radial':
            ref = np.array([c[0] - axis_xz[0], 0.0, c[2] - axis_xz[1]])
        elif out == '-radial':
            ref = -np.array([c[0] - axis_xz[0], 0.0, c[2] - axis_xz[1]])
        elif out == '+y':
            ref = np.array([0.0, 1.0, 0.0])
        else:
            ref = np.array([0.0, -1.0, 0.0])
        quad, uvs = _wind(quad, uvs, ref)
        part.add_face(quad, uvs=uvs)


def _area_vec(ring):
    """Newell area vector of a closed planar loop (origin independent)."""
    vs = [np.asarray(v, dtype=float) for v in ring]
    nrm = np.zeros(3)
    for i in range(len(vs)):
        nrm += np.cross(vs[i], vs[(i + 1) % len(vs)])
    return nrm


def fan_disc(part, ring, rect, ref=(0.0, 1.0, 0.0), inset=0.06):
    """Cap a closed ring as one fan-triangulated polygon, UVs laid out as a
    disc inside `rect` (parametric — works anywhere in the world)."""
    x0, y0, x1, y1 = rect
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rx, ry = (x1 - x0) / 2 * (1 - inset), (y1 - y0) / 2 * (1 - inset)
    n = len(ring)
    uvs = [((cx + rx * np.cos(2 * np.pi * i / n)) / A,
            (cy + ry * np.sin(2 * np.pi * i / n)) / A) for i in range(n)]
    q, uu = list(ring), uvs
    if np.dot(_area_vec(ring), np.asarray(ref, dtype=float)) < 0:
        q, uu = q[::-1], uu[::-1]
    part.add_face(q, uvs=uu)


def fan_zone(part, ring, zone, ref=(0.0, 1.0, 0.0)):
    """Cap a closed ring with a planar-projected Zone, wound toward `ref`."""
    q = list(ring)
    if np.dot(_area_vec(ring), np.asarray(ref, dtype=float)) < 0:
        q = q[::-1]
    part.add_face(q, zone=zone)


def prism_run(part, p0, p1, ex, ez, stations, rect, cap_rect=None):
    """Rectangular-section prism swept from p0 to p1 along its own axis.

    stations: [(t, half_width_along_ex, half_depth_along_ez)] with t in
    0..1. UVs: u = t (rect x0..x1), v = one of four equal face bands —
    band 0 = +ez, 1 = -ex, 2 = -ez, 3 = +ex. Broad faces are bands 0/2.
    """
    p0 = np.asarray(p0, dtype=float)
    p1 = np.asarray(p1, dtype=float)
    ex = _n(ex)
    ez = _n(ez)
    axis = p1 - p0
    x0, y0, x1, y1 = rect
    rings, uus, axpts = [], [], []
    for (t, hw, hd) in stations:
        P = p0 + axis * t
        rings.append([tuple(P + ex * hw + ez * hd), tuple(P - ex * hw + ez * hd),
                      tuple(P - ex * hw - ez * hd), tuple(P + ex * hw - ez * hd)])
        uus.append((x0 + (x1 - x0) * t) / A)
        axpts.append(P)
    for i in range(len(rings) - 1):
        ra, rb = rings[i], rings[i + 1]
        ua, ub = uus[i], uus[i + 1]
        mid = (axpts[i] + axpts[i + 1]) / 2
        for j in range(4):
            k = (j + 1) % 4
            va = (y0 + (y1 - y0) * j / 4) / A
            vb = (y0 + (y1 - y0) * (j + 1) / 4) / A
            quad = [ra[j], ra[k], rb[k], rb[j]]
            uvs = [(ua, va), (ua, vb), (ub, vb), (ub, va)]
            c = np.mean(np.array(quad, dtype=float), axis=0)
            quad, uvs = _wind(quad, uvs, c - mid)
            part.add_face(quad, uvs=uvs)
    if cap_rect is not None:
        fan_disc(part, rings[-1], cap_rect, ref=_n(axis))


# ── the court ───────────────────────────────────────────────────────────

def build_court(p):
    rings = [ngon_ring((0.0, y, 0.0), r, F.COURT_N, 'y') for (y, r) in F.COURT_RINGS]
    for (ia, ib, rect, out) in F.COURT_BANDS:
        band(p, rings[ia], rings[ib], rect, out=out)
    # sunken court floor — one unbroken slab, glyph rosette in the texture
    fan_disc(p, rings[-1], F.R_COURT.rect, ref=(0, 1, 0))

    # central altar: monolithic octagonal drum + floating keystone shard
    a0 = ngon_ring((0.0, F.ALTAR_Y0, 0.0), F.ALTAR_R0, F.ALTAR_N, 'y')
    a1 = ngon_ring((0.0, F.ALTAR_Y1, 0.0), F.ALTAR_R1, F.ALTAR_N, 'y')
    band(p, a0, a1, F.W_ALTAR, out='radial')
    fan_zone(p, a1, F.R_ALTAR_TOP, ref=(0, 1, 0))
    shard(p, (0.0, F.KEY_Y, 0.0), (0.0, 1.0, 0.0), F.KEY_R, F.KEY_H)


def shard(p, centre, axis, r, h):
    """Floating bipyramid data-shard, apexes along `axis`."""
    a = _n(axis)
    c = np.asarray(centre, dtype=float)
    limb(p, tuple(c - a * h), tuple(c), 0.02, r, F.W_NODE, n=4)
    limb(p, tuple(c), tuple(c + a * h), r, 0.02, F.W_NODE, n=4)


# ── the five leaning data-stacks ────────────────────────────────────────

def stack_frame(theta_deg, top_y, lean_k, lean_phi_deg):
    th = np.radians(theta_deg)
    er = np.array([np.cos(th), 0.0, np.sin(th)])
    et = np.array([-np.sin(th), 0.0, np.cos(th)])
    base = er * F.STACK_RING_R + np.array([0.0, F.PAD_Y1, 0.0])
    run = top_y - F.PAD_Y1
    ph = np.radians(lean_phi_deg)
    lean = (-er * np.cos(ph) + et * np.sin(ph)) * lean_k * run
    top = base + np.array([0.0, run, 0.0]) + lean
    d = _n(top - base)
    ex = _n(et - d * float(np.dot(et, d)))       # broad-face width axis
    ez = np.cross(ex, d)
    if float(np.dot(ez, er)) < 0:
        ez = -ez
    return base, top, ex, _n(ez), er


def build_stacks(p):
    for i, (theta, top_y, lk, lp) in enumerate(F.STACKS):
        base, top, ex, ez, er = stack_frame(theta, top_y, lk, lp)
        # precise octagonal footing
        f0 = ngon_ring((base[0], F.PAD_Y0, base[2]), F.PAD_R0, F.PAD_N, 'y')
        f1 = ngon_ring((base[0], F.PAD_Y1, base[2]), F.PAD_R1, F.PAD_N, 'y')
        band(p, f0, f1, F.W_PAD, out='radial', axis_xz=(base[0], base[2]))
        fan_disc(p, f1, F.R_PADTOP, ref=(0, 1, 0))
        # the leaning monolith
        st = [(t, (F.STK_HW0 + (F.STK_HW1 - F.STK_HW0) * t) * s,
                  (F.STK_HD0 + (F.STK_HD1 - F.STK_HD0) * t) * s)
              for (t, s) in F.STK_STATIONS]
        prism_run(p, base, top, ex, ez, st, F.W_STACK[i], cap_rect=F.R_STKCAP)
        # floating shard above the crown, continuing the lean
        d = _n(top - base)
        shard(p, tuple(top + d * (F.NODE_GAP + F.NODE_H)), d, F.NODE_R, F.NODE_H)


# ── the floating index ring (piece `index`) ─────────────────────────────

def ring_frames():
    u1 = np.array([1.0, 0.0, 0.0])
    u2 = np.array([0.0, np.sin(F.RING_TILT), np.cos(F.RING_TILT)])
    out = []
    for i in range(F.RING_SEGS):
        a = 2 * np.pi * i / F.RING_SEGS
        C = F.RING_R * (np.cos(a) * u1 + np.sin(a) * u2)
        T = _n(-np.sin(a) * u1 + np.cos(a) * u2)
        N = _n(C)
        B = _n(np.cross(T, N))
        out.append((C, T, N, B))
    return out


def build_index():
    p = Part('index')
    fr = ring_frames()
    n = len(fr)
    m = len(F.RING_PROFILE)
    x0, y0, x1, y1 = F.W_RING
    pts = [[f[0] + f[2] * pw + f[3] * pt for (pw, pt) in F.RING_PROFILE]
           for f in fr]
    for i in range(n):
        j2 = (i + 1) % n
        ua = (x0 + (x1 - x0) * i / n) / A
        ub = (x0 + (x1 - x0) * (i + 1) / n) / A
        mid = (fr[i][0] + fr[j2][0]) / 2
        for j in range(m):
            k = (j + 1) % m
            va = (y0 + (y1 - y0) * j / m) / A
            vb = (y0 + (y1 - y0) * (j + 1) / m) / A
            quad = [tuple(pts[i][j]), tuple(pts[i][k]),
                    tuple(pts[j2][k]), tuple(pts[j2][j])]
            uvs = [(ua, va), (ua, vb), (ub, vb), (ub, va)]
            c = np.mean(np.array(quad, dtype=float), axis=0)
            quad, uvs = _wind(quad, uvs, c - mid)
            p.add_face(quad, uvs=uvs)
    # index tablets standing off the ring's +B face
    st = [(0.0, F.TAB_HW, F.TAB_HD), (1.0, F.TAB_HW * 0.86, F.TAB_HD)]
    for i in range(0, n, F.TAB_EVERY):
        C, T, N, B = fr[i]
        b0 = C + B * (F.RING_PT * 0.92)
        prism_run(p, b0, b0 + B * F.TAB_H, T, N, st, F.W_TABLET,
                  cap_rect=F.R_TABCAP)
    return p


def build_body():
    p = Part('body')
    build_court(p)
    build_stacks(p)
    return p


# ── clips ───────────────────────────────────────────────────────────────

def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    T = F.IDLE_PERIOD
    keys = [(T * i / 4, qy(90.0 * i)) for i in range(5)]
    return [{'name': 'idle', 'channels': [('index', 'rotation', keys)]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='index', parent=0, offset=F.RING_PIVOT, part=build_index()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
