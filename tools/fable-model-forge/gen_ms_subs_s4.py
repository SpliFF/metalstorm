"""gen_ms_subs_s4 — build ms_subs_s4 (missile leviathan) + idle clip.

Strategic boomer, subs-row s4 (65 m): hull of revolution on the y=0 axis
datum (16 segments, beam 8.0), broad low wide-footed sail set forward,
slab-sided turtleback missile casing (~40% of hull length) with a 2x6 VLS
hatch grid under raised coamings, bow planes on the hull, cruciform stern
planes, and ONE large shrouded screw as a separate `prop` piece. Empties:
`muzzle` at the bow tube tip, `muzzle2` at the VLS field centre. One `idle`
clip: 8 s/rev prop rotation about the hull axis, final quaternion key
PRE-NEGATED so Babylon's shortest-arc slerp keeps spinning one way.

Usage: python3 gen_ms_subs_s4.py
"""
from __future__ import annotations
import numpy as np

import ms_subs_s4_layout as S   # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, loft, chamfer_box, tube, ngon_ring, limb
from gltf_export import export

STEM = 'ms_subs_s4'
OUT = 'out'
RNG = np.random.default_rng(90210)


def mir(z):
    """Mirrored twin of a planar zone (u-window reversed) for the far side
    of the projection axis — text stays readable on both faces."""
    (a0, a1), b = z.win
    return Zone(z.rect, z.axes, ((a1, a0), b))


S_SAIL_SIDE_M = mir(S.S_SAIL_SIDE)


def quad_out(p, verts, outward, zone):
    """Add a polygon wound so its normal points along `outward`."""
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, outward) > 0 else list(verts)[::-1],
               zone=zone)


def hull_r(z):
    zs = [s[0] for s in S.HULL_STATIONS]
    rs = [s[1] for s in S.HULL_STATIONS]
    return float(np.interp(z, zs, rs))


# ── body ─────────────────────────────────────────────────────────────────

def hull_zone(c, n):
    if n[1] > 0.45:
        return S.S_HULL_TOP
    if n[1] < -0.45:
        return S.S_HULL_BOT
    return S.S_HULL_SIDE


def case_zone(c, n):
    if n[1] > 0.6:
        return S.S_CASE_TOP
    return S.S_CASE_SIDE


def sail_zone(c, n):
    if abs(n[0]) >= abs(n[2]):
        return S.S_SAIL_SIDE if n[0] > 0 else S_SAIL_SIDE_M
    return S.S_SAIL_END


def case_ring(sec):
    z, wb, wt, yt = sec
    kw = wt + 0.30                    # knuckle width
    ky = yt - 0.90                    # knuckle height
    return [(-wb, S.CASE_Y0, z), (-kw, ky, z), (-wt, yt, z),
            (wt, yt, z), (kw, ky, z), (wb, S.CASE_Y0, z)]


def sail_ring(ring):
    y, w, zf, zb = ring
    c = 0.45
    return [(w, y, zb - c), (w, y, zf + c), (w - c, y, zf),
            (-w + c, y, zf), (-w, y, zf + c), (-w, y, zb - c),
            (-w + c, y, zb), (w - c, y, zb)]


def build_body():
    p = Part('body')

    # hull of revolution (nose -Z), capped both ends by hand (pitfall #3)
    rings = [ngon_ring((0, 0, z), r, n=S.N_SEG, axis='z')
             for (z, r) in S.HULL_STATIONS]
    loft(p, rings, hull_zone)
    quad_out(p, list(rings[0]), (0, 0, -1), S.S_DARK)
    quad_out(p, list(rings[-1]), (0, 0, 1), S.S_DARK)

    # turtleback missile casing — slab-sided, open bottom buried in the hull
    crings = [case_ring(s) for s in S.CASE_SECTIONS]
    loft(p, crings, case_zone, close=False, flip_side=True)
    # end fairings: close front/back faces down to the hull
    for ring, outward in ((crings[0], (0, 0, -1)), (crings[-1], (0, 0, 1))):
        quad_out(p, list(ring), outward, S.S_CASE_SIDE)

    # VLS hatch coamings (2 rows x 6 big square hatches)
    for hx in S.HATCH_ROWS:
        for hz in S.HATCH_Z:
            chamfer_box(p, (hx, S.DECK_Y + S.COAM_H / 2, hz),
                        (S.HATCH_W, S.COAM_H, S.HATCH_W), 0.035,
                        {'+y': S.S_CASE_TOP, '+x': S.S_TRIM, '-x': S.S_TRIM,
                         '+z': S.S_TRIM, '-z': S.S_TRIM}, skip=('-y',))

    # sail — broad, low, wide-footed, set forward
    srings = [sail_ring(r) for r in S.SAIL_RINGS]
    loft(p, srings, sail_zone, close=True)
    quad_out(p, list(srings[-1]), (0, 1, 0), S.S_SAIL_TOP)

    # periscope / snorkel masts on the sail top
    for (mx, mz, mh) in S.MASTS:
        limb(p, (mx, S.SAIL_TOP_Y - 0.2, mz), (mx, S.SAIL_TOP_Y + mh, mz),
             0.14, 0.10, S.S_MAST, n=4, cap_end=S.S_DARK)

    # bow planes: one spanning slab through the hull near the nose
    chamfer_box(p, (0, S.BOWPLANE_Y, S.BOWPLANE_Z),
                (2 * S.BOWPLANE_TIP, 0.26, sum(S.BOWPLANE_CH) / 2), 0.06,
                {'+y': S.S_FIN_PLAN, '-y': S.S_FIN_PLAN, '+x': S.S_TRIM,
                 '-x': S.S_TRIM, '+z': S.S_TRIM, '-z': S.S_TRIM})

    # cruciform stern planes: horizontal + vertical spanning slabs
    chamfer_box(p, (0, 0, S.STERN_Z),
                (2 * S.STERN_TIP, S.STERN_T, sum(S.STERN_CH) / 2), 0.06,
                {'+y': S.S_FIN_PLAN, '-y': S.S_FIN_PLAN, '+x': S.S_TRIM,
                 '-x': S.S_TRIM, '+z': S.S_TRIM, '-z': S.S_TRIM})
    chamfer_box(p, (0, 0, S.STERN_Z),
                (S.STERN_T, 2 * S.STERN_TIP, sum(S.STERN_CH) / 2), 0.06,
                {'+x': S.S_FIN, '-x': S.S_FIN, '+y': S.S_TRIM,
                 '-y': S.S_TRIM, '+z': S.S_TRIM, '-z': S.S_TRIM})

    # sonar blister under the bow
    chamfer_box(p, S.BLISTER[:3], S.BLISTER[3:], 0.12,
                {'-y': S.S_HULL_BOT, '+x': S.S_TRIM, '-x': S.S_TRIM,
                 '+z': S.S_TRIM, '-z': S.S_TRIM}, skip=('+y',))

    # deck cleats along the casing edge (functional greeble)
    for (cx, cz) in ((-2.6, -7.5), (2.6, -7.5), (-2.6, 17.5), (2.6, 17.5)):
        chamfer_box(p, (cx, S.DECK_Y - 0.35, cz), (0.5, 0.22, 0.9), 0.03,
                    {'+y': S.S_TRIM, '+x': S.S_TRIM, '-x': S.S_TRIM,
                     '+z': S.S_TRIM, '-z': S.S_TRIM}, skip=('-y',))

    # stern shaft + shroud (duct revolve: out_f -> out_b -> in_b -> in_f)
    limb(p, (0, 0, S.SHAFT_Z0 - 0.1), (0, 0, S.SHAFT_Z1), 0.50, 0.34,
         S.S_PROP, n=8, cap_end=S.S_DARK)
    n = 12
    duct = [ngon_ring((0, 0, S.SHROUD_Z0), S.SHROUD_RO, n=n, axis='z'),
            ngon_ring((0, 0, S.SHROUD_Z1), S.SHROUD_RO, n=n, axis='z'),
            ngon_ring((0, 0, S.SHROUD_Z1), S.SHROUD_RI, n=n, axis='z'),
            ngon_ring((0, 0, S.SHROUD_Z0), S.SHROUD_RI, n=n, axis='z')]
    duct.append(duct[0])
    loft(p, duct, lambda c, nrm: S.S_SHROUD)
    # shroud support struts (diagonal cruciform)
    for a in (45, 135, 225, 315):
        r = np.radians(a)
        ux, uy = np.cos(r), np.sin(r)
        limb(p, (ux * 1.05, uy * 1.05, 29.3),
             (ux * 1.62, uy * 1.62, S.SHROUD_Z0 + 0.35), 0.10, 0.08,
             S.S_MAST, n=4)
    return p


# ── prop (piece-local; spins about +Z hull axis) ─────────────────────────

def build_prop():
    p = Part('prop')
    tube(p, [(-0.55, 0.28), (-0.35, S.PROP_HUB_R), (0.35, S.PROP_HUB_R),
             (0.55, 0.26)], S.S_PROP, n=8, cap_start=S.S_DARK,
         cap_end=S.S_DARK, axis='z')
    for k in range(S.PROP_BLADES):
        th = 2 * np.pi * k / S.PROP_BLADES
        u = np.array([np.cos(th), np.sin(th), 0.0])
        t = np.array([-np.sin(th), np.cos(th), 0.0])
        r0, r1 = S.PROP_HUB_R + 0.02, S.PROP_BLADE_R
        A = tuple(u * r0 + t * 0.30 + [0, 0, -0.10])
        B = tuple(u * r1 + t * 0.34 + [0, 0, 0.16])
        C = tuple(u * r1 - t * 0.34 + [0, 0, 0.30])
        D = tuple(u * r0 - t * 0.30 + [0, 0, 0.04])
        # double-sided blade: explicit triangles, SAME diagonal (A-C)
        p.add_face([A, B, C], zone=S.S_BLADE)
        p.add_face([A, C, D], zone=S.S_BLADE)
        p.add_face([A, C, B], zone=S.S_BLADE)
        p.add_face([A, D, C], zone=S.S_BLADE)
    return p


# ── clips ────────────────────────────────────────────────────────────────

def qz(deg, negate=False):
    r = np.radians(deg) / 2
    q = np.array([0.0, 0.0, np.sin(r), np.cos(r)])
    if negate:
        q = -q
    return tuple(float(v) for v in q)


def build_clips():
    T = 8.0     # seconds per revolution, seamless loop
    # full-turn quaternion trap: final key PRE-NEGATED -> (0,0,0,-1) so every
    # consecutive pair keeps a positive dot product (no shortest-arc rewind)
    keys = [(0.0, qz(0.0)),
            (T / 3, qz(120.0)),
            (2 * T / 3, qz(240.0)),
            (T, qz(360.0, negate=True))]
    return [{'name': 'idle', 'channels': [('prop', 'rotation', keys)]}]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='prop', parent=0, offset=S.PROP_OFF, part=build_prop()),
        dict(name='muzzle', parent=0, offset=S.MUZZLE_OFF, part=None),
        dict(name='muzzle2', parent=0, offset=S.VLS_CENTRE, part=None),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'TOTAL: {total} tris')
