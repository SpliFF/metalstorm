"""gen_ms_fighters_s1 — build ms_fighters_s1 (s1 interceptor drone).

Tailless cropped-delta UNMANNED interceptor: chined blended-wing-body
loft, NO canopy (flush faceted EO sensor blister on the spine instead),
downturned anhedral wingtip fins in place of canted tail fins, one flush
dorsal intake feeding one nozzle, chin MG fairing + stub barrel, small
fixed landing gear as separate pieces.

Usage: $FORGE/venv/bin/python gen_ms_fighters_s1.py
"""
from __future__ import annotations
import numpy as np

import ms_fighters_s1_layout as F        # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, loft, chamfer_box, tube, ngon_ring, limb
from gltf_export import export

STEM = 'ms_fighters_s1'
OUT = 'out'
RNG = np.random.default_rng(90210)


def quad_out(p, verts, outward, zone):
    """Add a polygon wound so its normal points along `outward`."""
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, outward) > 0 else verts[::-1], zone=zone)


def box(p, center, size, zone, ch=0.02, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def fus_ring(z, w, wt, yt, yb, yc):
    wb = w * 0.52
    return [(w, yc, z), (wt, yt, z), (-wt, yt, z), (-w, yc, z),
            (-wb, yb, z), (wb, yb, z)]


def fus_zone(c, n):
    if n[1] > 0.55:
        return F.F_TOP
    if n[1] < -0.55:
        return F.F_BOT
    return F.F_SIDE


def box_ring(z, hw, yb, yt):
    return [(hw, yb, z), (hw, yt, z), (-hw, yt, z), (-hw, yb, z)]


def blade_flat(p, stations, s, taxis, top_zone, bot_zone, edge_zone,
               cap_tip=True):
    """Station-based lifting surface (fighter_layout pattern).
    stations: (span_x, y, z_le, z_te, thickness); taxis 'y' horizontal."""
    def sec(st):
        x, y, zle, zte, th = st
        if taxis == 'y':
            return [(s * x, y + th / 2, zle), (s * x, y + th / 2, zte),
                    (s * x, y - th / 2, zte), (s * x, y - th / 2, zle)]
        return [(s * (x + th / 2), y, zle), (s * (x + th / 2), y, zte),
                (s * (x - th / 2), y, zte), (s * (x - th / 2), y, zle)]

    up = (0, 1, 0) if taxis == 'y' else (s, 0, 0)
    dn = tuple(-c for c in up)
    rings = [sec(st) for st in stations]
    for i in range(len(rings) - 1):
        r0, r1 = rings[i], rings[i + 1]
        quad_out(p, [r0[0], r0[1], r1[1], r1[0]], up, top_zone)
        quad_out(p, [r0[3], r0[2], r1[2], r1[3]], dn, bot_zone)
        quad_out(p, [r0[0], r0[3], r1[3], r1[0]], (0, 0, -1), edge_zone)
        quad_out(p, [r0[1], r0[2], r1[2], r1[1]], (0, 0, 1), edge_zone)
    if cap_tip:
        dx = stations[-1][0] - stations[0][0]
        dy = stations[-1][1] - stations[0][1]
        quad_out(p, rings[-1],
                 (s * np.sign(dx + 1e-9), np.sign(dy) * 0.4, 0), edge_zone)


def build_body():
    p = Part('body')

    # ── chined blended-wing-body fuselage ──
    loft(p, [fus_ring(*s) for s in F.FUS_SECTIONS], fus_zone,
         cap_start=F.F_TRIM, cap_end=F.F_TRIM)

    # ── flush dorsal intake (one scoop on the spine) ──
    loft(p, [box_ring(*s) for s in F.INTAKE_SECTIONS], fus_zone,
         cap_start=F.F_DARK)

    # ── faceted EO sensor blister — this drone has NO canopy ──
    loft(p, [box_ring(*s) for s in F.BLISTER_SECTIONS],
         lambda c, n: F.F_BLIST)

    # ── comms blade antenna (two-sided thin plate) ──
    bz0, bz1, by0, by1, sweep = F.BLADE
    blade = [(0.0, by0, bz0), (0.0, by1, bz0 + sweep),
             (0.0, by1, bz1), (0.0, by0, bz1)]
    quad_out(p, blade, (1, 0, 0), F.F_TRIM)
    quad_out(p, list(blade), (-1, 0, 0), F.F_TRIM)

    # ── lifting surfaces + downturned tips (mirrored) ──
    for s in (1, -1):
        blade_flat(p, F.WING, s, 'y', F.F_TOP, F.F_BOT, F.F_TRIM,
                   cap_tip=False)
        blade_flat(p, F.TIPFIN, s, 'y', F.F_TOP, F.F_BOT, F.F_TRIM)

    # ── single nozzle (stations zmax→zmin so cap_start faces aft) ──
    tube(p, F.NOZZLE, F.F_NOZZLE, n=8, cap_start=F.F_BURNER)

    # ── chin MG fairing + stub barrel ──
    c, sz = F.MG_BOX
    box(p, c, sz, F.F_TRIM, ch=0.03)
    tube(p, [(z, r, F.MG_Y) for (z, r) in F.MG_BARREL], F.F_BARREL, n=6,
         cap_end=F.F_DARK)
    return p


def wheel(p, c, r, hw):
    cx, cy, cz = c
    ra = ngon_ring((cx - hw, cy, cz), r, n=6, axis='x')
    rb = ngon_ring((cx + hw, cy, cz), r, n=6, axis='x')
    for j in range(6):
        k = (j + 1) % 6
        quad = [ra[j], ra[k], rb[k], rb[j]]
        cq = np.mean(np.array(quad), axis=0)
        quad_out(p, quad, (0, cq[1] - cy, cq[2] - cz), F.F_DARK)
    quad_out(p, list(ra), (-1, 0, 0), F.F_GEAR)
    quad_out(p, list(rb), (1, 0, 0), F.F_GEAR)


def build_gear(name, drop, r, hw, s=1):
    """Light drone gear leg, piece-local (origin at the hull attach point)."""
    p = Part(name)
    limb(p, (0, 0, 0), (0, -drop, -0.03), 0.045, 0.036, F.F_GEAR.rect, n=4)
    wheel(p, (0, -drop, 0.0), r, hw)
    return p


def build_all():
    (nx, ny, nz), ndrop, nr, nhw = F.GEAR_N
    (mx, my, mz), mdrop, mr, mhw = F.GEAR_M
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='gear_n', parent=0, offset=(nx, ny, nz),
             part=build_gear('gear_n', ndrop, nr, nhw)),
        dict(name='gear_l', parent=0, offset=(mx, my, mz),
             part=build_gear('gear_l', mdrop, mr, mhw, s=1)),
        dict(name='gear_r', parent=0, offset=(-mx, my, mz),
             part=build_gear('gear_r', mdrop, mr, mhw, s=-1)),
        dict(name='muzzle', parent=0, offset=F.GUN_MUZZLE, part=None),
        dict(name='exhaust', parent=0, offset=F.EXHAUST_OFF, part=None),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_{STEM}] total tris: {total}')
