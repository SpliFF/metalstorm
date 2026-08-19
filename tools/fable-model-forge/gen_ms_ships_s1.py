"""gen_ms_ships_s1 — build ms_ships_s1 (patrol boat flotilla, squad of 4).

Ships row s1 (20 m): hard-chine PLANING hull lofted from keel/chine/sheer
stations (waterline Y=0, draft 1.4 m), spray rails on the chine knuckle,
fine bow entry, wide transom with two waterjet tunnel mouths. OPEN deck:
a circular splinter-shield gun tub forward carrying the standard
turret/barrel/muzzle autocannon chain, a minimal 1.6 m wheelhouse
amidships, a plain whip mast with a small nav radar, and an open aft
working deck (drums, crates, tarp) inside a stern railing.

No enclosed superstructure, no funnel — that is what separates s1 from
s2/s3 in the impostor cell.

Usage: python3 gen_ms_ships_s1.py
"""
from __future__ import annotations
import numpy as np

import ms_ships_s1_layout as S   # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, loft, chamfer_box, ngon_ring, limb
from gltf_export import export
import parts as P

STEM = 'ms_ships_s1'
OUT = 'out'


# ── helpers ──────────────────────────────────────────────────────────────

def ring_from_section(sec):
    z, yk, yc, yd, wk, wc, wd = sec
    return [
        (wk, yk, z), (wc, yc, z), (wd, yd, z),      # +x keel -> chine -> sheer
        (-wd, yd, z), (-wc, yc, z), (-wk, yk, z),   # deck across, -x down
    ]


def hull_zone(c, n):
    if n[1] > 0.5:
        return S.S_DECK
    if n[1] < -0.55:
        return S.S_BELLY
    return S.S_HULL_SIDE


def interp_col(z, col):
    zs = [s[0] for s in S.HULL_SECTIONS]
    return float(np.interp(z, zs, [s[col] for s in S.HULL_SECTIONS]))


# ── body ─────────────────────────────────────────────────────────────────

def build_hull(p):
    rings = [ring_from_section(s) for s in S.HULL_SECTIONS]
    loft(p, rings, hull_zone)

    # stem cap (near-degenerate bow polygon) + transom
    for sec, outward, zone in ((S.HULL_SECTIONS[0], (0, 0, -1), S.S_HULL_SIDE),
                               (S.HULL_SECTIONS[-1], (0, 0, 1), S.S_STERN)):
        z, yk, yc, yd, wk, wc, wd = sec
        P.quad_out(p, [(wk, yk, z), (wc, yc, z), (wd, yd, z),
                       (-wd, yd, z), (-wc, yc, z), (-wk, yk, z)],
                   outward, zone)

    # spray rails along the chine knuckle (both sides)
    for (z0, z1) in S.SPRAY_RUNS:
        zs = np.linspace(z0, z1, 4)
        for sx in (1, -1):
            for i in range(len(zs) - 1):
                az, bz = float(zs[i]), float(zs[i + 1])
                a = (sx * (interp_col(az, 5) + 0.06),
                     interp_col(az, 2) + 0.05, az)
                b = (sx * (interp_col(bz, 5) + 0.06),
                     interp_col(bz, 2) + 0.05, bz)
                limb(p, a, b, 0.07, 0.07, S.S_MAST, n=3)

    # waterjet tunnel mouths in the transom (short recessed barrels)
    for (jx, jy) in S.JETS:
        limb(p, (jx, jy, 9.30), (jx, jy, 10.0), S.JET_R, S.JET_R * 0.92,
             S.S_JET, n=6)


def build_breakwater(p):
    """Low V splash plate across the foredeck, apex forward (-Z)."""
    zc, za = -3.30, -3.95          # trailing edge z, apex z
    h = 0.42
    for sx in (1, -1):
        xo = sx * 2.05
        base_o = (xo, interp_col(zc, 3), zc)
        base_a = (0.0, interp_col(za, 3), za)
        top_o = (xo, base_o[1] + h, zc)
        top_a = (0.0, base_a[1] + h, za)
        P.quad_out(p, [base_o, base_a, top_a, top_o], (0, 0, -1), S.S_TUB)
        P.quad_out(p, [base_o, base_a, top_a, top_o], (0, 0, 1), S.S_TUB)
        P.quad_out(p, [top_o, top_a,
                       (0.0, top_a[1], za + 0.12), (xo, top_o[1], zc + 0.12)],
                   (0, 1, 0), S.S_TUB)


def build_gun_tub(p):
    """Open circular splinter shield on the foredeck (no roof)."""
    cx, cz = S.TUB_C
    r_o, r_i = S.TUB_R, S.TUB_R - 0.10
    y0, y1 = S.TUB_FLOOR - 0.05, S.TUB_TOP
    rings = [
        ngon_ring((cx, y0, cz), r_o, n=10, axis='y'),
        ngon_ring((cx, y1, cz), r_o, n=10, axis='y'),
        ngon_ring((cx, y1, cz), r_i, n=10, axis='y'),
        ngon_ring((cx, y0 + 0.03, cz), r_i, n=10, axis='y'),
    ]
    loft(p, rings, lambda c, n: S.S_TUB if abs(n[1]) < 0.5 else S.S_TUB_FLOOR)
    # tub deck plate
    P.quad_out(p, ngon_ring((cx, S.TUB_FLOOR, cz), r_i, n=10, axis='y'),
               (0, 1, 0), S.S_TUB_FLOOR)


def build_foredeck_gear(p):
    """Anchor winch on the stem head — functional foredeck greeble."""
    zw = -8.35
    P.box6(p, (0.0, interp_col(zw, 3) + 0.22, zw), (0.66, 0.42, 0.52),
           S.S_TRIM, ch=0.04)


def build_wheelhouse(p):
    x, y, z = S.WH_C
    w, h, d = S.WH_SIZE
    chamfer_box(p, (x, y, z), (w, h, d), 0.07,
                {'+x': S.S_WH_SIDE, '-x': S.S_WH_SIDE, '-z': S.S_WH_FRONT,
                 '+z': S.S_WH_FRONT, '+y': S.S_WH_TOP}, skip=('-y',))
    # roof ID plinth (small team panel lives here)
    chamfer_box(p, (0.0, S.WH_ROOF_Y + 0.09, -0.55), (0.66, 0.18, 0.60), 0.03,
                {k: S.S_TRIM for k in ('+x', '-x', '+y', '+z', '-z')},
                skip=('-y',))


def build_mast(p):
    limb(p, S.MAST_FOOT, S.MAST_TOP, 0.065, 0.045, S.S_MAST, n=4)
    P.box6(p, S.RADAR_C, S.RADAR_SZ, S.S_TRIM, ch=0.03)
    P.beacon(p, (0.0, 4.30, 1.78), size=0.15, glow_zone=S.S_LIGHT)


def build_aft_deck(p):
    dy = 1.52                       # aft deck plate height
    P.drum(p, (0.90, dy, 5.35), r=0.32, h=0.95, zone=S.S_DRUM, n=6)
    P.drum(p, (0.90, dy, 6.20), r=0.32, h=0.95, zone=S.S_DRUM, n=6)
    P.crate(p, (-0.85, dy + 0.38, 5.45), size=0.76, zone=S.S_RACK)
    P.crate(p, (-0.85, dy + 0.30, 6.35), size=0.60, zone=S.S_RACK)
    P.tarp_over(p, (0.0, dy, 8.05), (2.5, 0.72, 1.55), sag=0.14,
                zone=S.S_RACK)
    for (a, b) in S.RAIL_RUNS:
        P.railing(p, a, b, h=0.85, post_step=1.7, r=0.04, zone=S.S_RAIL)


def build_body():
    p = Part('body')
    build_hull(p)
    build_breakwater(p)
    build_foredeck_gear(p)
    build_gun_tub(p)
    build_wheelhouse(p)
    build_mast(p)
    build_aft_deck(p)
    return p


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
    ]
    t = P.turret_parts(body_index=0, mount=S.TURRET_OFF, ring_r=0.52,
                       barrel_len=S.BARREL_LEN, barrel_r=S.BARREL_R,
                       body_zone=S.S_TURRET, barrel_rect=S.S_BARREL)
    base = len(pieces)              # 1
    t[1]['parent'] = base           # barrel under turret
    t[2]['parent'] = base + 1       # muzzle under barrel
    pieces.extend(t)
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=None,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=None,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'TOTAL {total} tris')
