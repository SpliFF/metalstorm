"""gen_ms_dress_resistance — Resistance dressing kit (accessory set).

Five elements as separate ROOT pieces in one glTF (spec: dressing kit):
  net (root)    camo net canopy — tarp_over draped shell + 4 corner poles
  stow (root)   stowage bundles — tarped bundle + three lashed crates
  rack (root)   jerrycan rack — welded frame + two 2-can blocks
  flag (root)   cause-flag on a square scrap post; `idle` wave clip
                (rigid Y rotation about the post axis — the cloth flutters,
                the post spins invisibly about itself); team via mask
  smoke (root)  improvised smoke discharger — bracket + 4 welded pipes

Each element's local origin is its mount plane (y=0). Root offsets fan the
kit out along X for display only — see out/README.txt for mount offsets.
Deterministic: geometry from ms_dress_resistance_layout constants only.
Run: python3 gen_ms_dress_resistance.py -> out/ms_dress_resistance{,_png}.gltf
"""
import numpy as np

import ms_dress_resistance_layout as L
from meshlib import Part, chamfer_box, limb
from gltf_export import export
import parts as P

STEM = 'ms_dress_resistance'
OUT = 'out'
RNG = np.random.default_rng(90210)


# ── net: camo canopy ────────────────────────────────────────────────────

def build_net():
    p = Part('net')
    P.tarp_over(p, (0.0, 0.0, 0.0), L.NET_SIZE, sag=L.NET_SAG, zone=L.NET)
    for (px, pz) in L.NET_POLES:
        limb(p, (px, 0.0, pz), (px * 1.04, L.NET_POLE_TOP, pz * 1.04),
             0.035, 0.028, L.TRIM_R, n=3)
    return p


# ── stow: bundles ───────────────────────────────────────────────────────

def build_stow():
    p = Part('stow')
    P.tarp_over(p, L.STOW_TARP_C, L.STOW_TARP_SZ, sag=0.16, zone=L.TARP)
    for (center, size) in L.STOW_CRATES:
        P.crate(p, center, size, L.CRATE)
    return p


# ── rack: jerrycans ─────────────────────────────────────────────────────

def build_rack():
    p = Part('rack')
    for (px, pz) in L.RACK_POSTS:
        limb(p, (px, 0.0, pz), (px, L.RACK_H, pz), 0.03, 0.03,
             L.TRIM_R, n=3, cap_end=L.DARK)
    x0, x1 = L.RACK_POSTS[0][0], L.RACK_POSTS[1][0]
    for ry in L.RACK_RAIL_Y:
        for pz in (-0.17, 0.17):
            limb(p, (x0, ry, pz), (x1, ry, pz), 0.025, 0.025, L.TRIM_R, n=3)
    for (cx, cy, cz) in L.CAN_BLOCKS:
        chamfer_box(p, (cx, cy, cz), L.CAN_BLOCK_SZ, 0.025,
                    {k: L.CAN for k in ('+x', '-x', '+y', '+z', '-z')},
                    skip=('-y',))
    return p


# ── flag: cause-flag on a scrap post ────────────────────────────────────

def dbl_quad(p, verts, zone):
    """Double-sided non-planar quad: explicit triangles, SAME diagonal on
    both sides (guide pitfall — reversed quads fan the other diagonal)."""
    a, b, c, d = verts
    for tri in ((a, b, c), (a, c, d)):
        p.add_face(list(tri), zone=zone)
        p.add_face(list(tri)[::-1], zone=zone)


def build_flag():
    p = Part('flag')
    limb(p, (0.0, 0.0, 0.0), (0.0, L.POLE_H, 0.0), L.POLE_R0, L.POLE_R1,
         L.POLE_R, n=4, cap_end=L.DARK)
    x0 = L.POLE_R0 + 0.006
    y0, y1 = L.CLOTH_Y0, L.CLOTH_Y1
    xm, xe = L.CLOTH_X_MID, L.CLOTH_X_END
    zm, ze = L.CLOTH_Z_MID, L.CLOTH_Z_END
    dr = L.CLOTH_DROOP
    # inner panel (pole edge -> mid crease)
    dbl_quad(p, [(x0, y1, 0.0), (xm, y1 - dr * 0.5, zm),
                 (xm, y0 - dr * 0.5, zm), (x0, y0, 0.0)], L.FLAG)
    # outer panel (mid crease -> trailing edge, droops + bends back)
    dbl_quad(p, [(xm, y1 - dr * 0.5, zm), (xe, y1 - dr, ze),
                 (xe, y0 - dr, ze), (xm, y0 - dr * 0.5, zm)], L.FLAG)
    return p


# ── smoke: improvised discharger cluster ────────────────────────────────

def build_smoke():
    p = Part('smoke')
    bw, bh, bd = L.SMOKE_BRACKET
    chamfer_box(p, (0.0, bh / 2, 0.0), (bw, bh, bd), 0.03,
                {k: L.BRACKET for k in ('+x', '-x', '+y', '+z', '-z')},
                skip=('-y',))
    by, bz = L.SMOKE_BASE
    ty, tz = L.SMOKE_TIP
    for sx in L.SMOKE_XS:
        limb(p, (sx, by, bz), (sx, ty, tz), L.SMOKE_TUBE_R,
             L.SMOKE_TUBE_R * 1.06, L.TUBE_R, n=5, cap_end=L.DARK)
    return p


# ── clips ───────────────────────────────────────────────────────────────

def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    # `idle`: cloth flutter — the whole flag piece sways about the post's
    # own Y axis (post is rotationally near-invisible). Seamless loop:
    # last key repeats the first.
    keys = [(0.0, qy(0.0)), (0.7, qy(7.0)), (1.3, qy(2.0)),
            (2.0, qy(-6.5)), (2.8, qy(0.0))]
    return [{'name': 'idle', 'channels': [('flag', 'rotation', keys)]}]


def build_all():
    return [
        dict(name='net', parent=-1, offset=L.NET_OFF, part=build_net()),
        dict(name='stow', parent=-1, offset=L.STOW_OFF, part=build_stow()),
        dict(name='rack', parent=-1, offset=L.RACK_OFF, part=build_rack()),
        dict(name='flag', parent=-1, offset=L.FLAG_OFF, part=build_flag()),
        dict(name='smoke', parent=-1, offset=L.SMOKE_OFF, part=build_smoke()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_dress_resistance] total: {total} tris')
