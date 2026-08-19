"""gen_ms_subs_s3 — build ms_subs_s3 (hunter-killer pair).

45 m s3 attack sub on the axis datum (centreline y=0): 14-station body
of revolution at 12 segments, LOW RAKED BLENDED sail (open half-ellipse
loft sunk into the hull, faired aft into a dorsal hump — no vertical
sides, no masts, no sail planes), X-form stern planes (four swept
diagonal fins), pump-jet shroud ring with four stator vanes, flush
retractable bow-plane blisters, long shallow sonar flank arrays.
`muzzle` empty at the bow torpedo tube tip. No clips (s3 squad def).

Usage: python3 gen_ms_subs_s3.py
"""
from __future__ import annotations
import numpy as np

import ms_subs_s3_layout as S   # sets meshlib.ATLAS = 2048
from meshlib import Part, loft, ngon_ring, limb
from gltf_export import export

STEM = 'ms_subs_s3'
OUT = 'out'
rng = np.random.default_rng(90210)


def quad_out(p, verts, outward, zone):
    """Add a polygon wound so its normal points along `outward`."""
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, np.asarray(outward, float)) > 0
               else list(verts)[::-1], zone=zone)


# ── hull of revolution ───────────────────────────────────────────────────

def hull_zone(c, n):
    if n[1] > 0.55:
        return S.S_TOP
    if n[1] < -0.55:
        return S.S_BELLY
    return S.S_SIDE


def build_hull(p):
    rings = [ngon_ring((0.0, 0.0, z), r, n=S.SEG, axis='z')
             for (z, r) in S.STATIONS]
    loft(p, rings, hull_zone, cap_start=S.S_NOSE, cap_end=S.S_DARKZ)


# ── blended sail / dorsal hump ───────────────────────────────────────────

def sail_zone(c, n):
    if n[1] > 0.9:
        return S.S_SAILTOP
    return S.S_SAIL if c[0] >= 0 else S.S_SAIL_M


def build_sail(p):
    ts = np.linspace(0.0, np.pi, S.SAIL_PTS)   # right -> top -> left
    rings = []
    for (z, h, w) in S.SAIL_PROF:
        cy = S.top_y(z) - S.SAIL_SINK
        a = h + S.SAIL_SINK
        rings.append([(w * np.cos(t), cy + a * np.sin(t), z) for t in ts])
    loft(p, rings, sail_zone, close=False)


# ── X-form stern planes ──────────────────────────────────────────────────

def build_fins(p):
    for ang in S.FIN_ANGLES:
        th = np.radians(ang)
        d = np.array([np.cos(th), np.sin(th), 0.0])
        tv = np.array([-np.sin(th), np.cos(th), 0.0])

        def pt(s, z, side):
            tk = np.interp(s, [S.FIN_ROOT_S, S.FIN_TIP_S],
                           [S.FIN_TH_ROOT, S.FIN_TH_TIP])
            v = d * s + tv * (side * tk / 2.0)
            return (float(v[0]), float(v[1]), z)

        rs, ts_ = S.FIN_ROOT_S, S.FIN_TIP_S
        rl, rt, tl, tt = S.FIN_RL_Z, S.FIN_RT_Z, S.FIN_TL_Z, S.FIN_TT_Z
        # side faces
        quad_out(p, [pt(rs, rl, 1), pt(rs, rt, 1), pt(ts_, tt, 1),
                     pt(ts_, tl, 1)], tv, S.S_FIN)
        quad_out(p, [pt(rs, rl, -1), pt(rs, rt, -1), pt(ts_, tt, -1),
                     pt(ts_, tl, -1)], -tv, S.S_FIN)
        # leading / trailing / tip edges
        quad_out(p, [pt(rs, rl, 1), pt(rs, rl, -1), pt(ts_, tl, -1),
                     pt(ts_, tl, 1)], d * 0.5 + np.array([0, 0, -1.0]),
                 S.S_FIN)
        quad_out(p, [pt(rs, rt, 1), pt(rs, rt, -1), pt(ts_, tt, -1),
                     pt(ts_, tt, 1)], d * 0.3 + np.array([0, 0, 1.0]),
                 S.S_FIN)
        quad_out(p, [pt(ts_, tl, 1), pt(ts_, tl, -1), pt(ts_, tt, -1),
                     pt(ts_, tt, 1)], d, S.S_FIN)


# ── pump-jet shroud ──────────────────────────────────────────────────────

def shroud_zone(c, n):
    if abs(n[2]) > 0.7 or np.dot((c[0], c[1]), (n[0], n[1])) < 0:
        return S.S_DARKZ           # annuli + inner duct: dark
    return S.S_SHROUD


def build_shroud(p):
    n = S.SEG
    of = ngon_ring((0, 0, S.SHR_Z0), S.SHR_RO0, n=n, axis='z')
    orr = ngon_ring((0, 0, S.SHR_Z1), S.SHR_RO1, n=n, axis='z')
    ir = ngon_ring((0, 0, S.SHR_Z1), S.SHR_RI1, n=n, axis='z')
    if_ = ngon_ring((0, 0, S.SHR_Z0), S.SHR_RI0, n=n, axis='z')
    loft(p, [of, orr, ir, if_, of], shroud_zone)
    # stator vanes at 0/90/180/270 (offset from the 45-deg fins)
    cone_r = S.hull_r(S.VANE_Z)
    ri = float(np.interp(S.VANE_Z, [S.SHR_Z0, S.SHR_Z1],
                         [S.SHR_RI0, S.SHR_RI1]))
    for ang in (0.0, 90.0, 180.0, 270.0):
        th = np.radians(ang)
        d = (np.cos(th), np.sin(th))
        limb(p, (d[0] * (cone_r - 0.15), d[1] * (cone_r - 0.15), S.VANE_Z),
             (d[0] * (ri + 0.06), d[1] * (ri + 0.06), S.VANE_Z),
             0.10, 0.07, S.S_DARKR, n=4)


# ── flush blisters (bow planes, sonar arrays) ────────────────────────────

def blister(p, z0, z1, ylo, yhi, proud, inset, nseg, zone, sx):
    """Shallow strip on the side flat: outer face follows the hull at a
    constant proud offset; inner edge buried below the surface."""
    zs = np.linspace(z0, z1, nseg + 1)
    xo = [sx * (S.flat_x(z) + proud) for z in zs]
    xi = [sx * (S.flat_x(z) - inset) for z in zs]
    for i in range(nseg):
        j = i + 1
        quad_out(p, [(xo[i], ylo, zs[i]), (xo[j], ylo, zs[j]),
                     (xo[j], yhi, zs[j]), (xo[i], yhi, zs[i])],
                 (sx, 0, 0), zone)
        quad_out(p, [(xo[i], yhi, zs[i]), (xo[j], yhi, zs[j]),
                     (xi[j], yhi, zs[j]), (xi[i], yhi, zs[i])],
                 (0, 1, 0), zone)
        quad_out(p, [(xo[i], ylo, zs[i]), (xo[j], ylo, zs[j]),
                     (xi[j], ylo, zs[j]), (xi[i], ylo, zs[i])],
                 (0, -1, 0), zone)
    quad_out(p, [(xo[0], ylo, zs[0]), (xo[0], yhi, zs[0]),
                 (xi[0], yhi, zs[0]), (xi[0], ylo, zs[0])], (0, 0, -1), zone)
    quad_out(p, [(xo[-1], ylo, zs[-1]), (xo[-1], yhi, zs[-1]),
                 (xi[-1], yhi, zs[-1]), (xi[-1], ylo, zs[-1])],
             (0, 0, 1), zone)


# ── assembly ─────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    build_hull(p)
    build_sail(p)
    build_fins(p)
    build_shroud(p)
    for sx in (1, -1):
        blister(p, S.PLANE_Z0, S.PLANE_Z1, S.PLANE_Y0, S.PLANE_Y1,
                S.PLANE_PROUD, S.PLANE_INSET, 2, S.S_PLANE, sx)
        blister(p, S.SONAR_Z0, S.SONAR_Z1, S.SONAR_Y0, S.SONAR_Y1,
                S.SONAR_PROUD, S.SONAR_INSET, 4, S.S_SONAR, sx)
    return p


if __name__ == '__main__':
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='muzzle', parent=0, offset=S.MUZZLE, part=None),
    ]
    clips = []
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    lo, hi = pieces[0]['part'].bounds()
    print(f'[gen_ms_subs_s3] bounds {lo} .. {hi}')
    print(f'TOTAL: {total} tris')
