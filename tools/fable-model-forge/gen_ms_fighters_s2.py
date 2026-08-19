"""gen_ms_fighters_s2 — build ms_fighters_s2 (manned light fighter, tier 2).

Conventional single-engine single-fin day fighter: chined hex fuselage
loft with a nose annular intake (dark throat), real bubble canopy well
forward, dorsal spine fairing running back to a single vertical fin, low
tailplane, moderately swept mid wing (9.0 m span exactly), chin gun tray
with stub barrel, one underwing AA missile rail per side, tricycle
landing gear as separate fixed pieces. Fixedwing rig: bare muzzle /
muzzle2 / exhaust empties, NO turret chain, ZERO clips.

Usage: $FORGE/venv/bin/python gen_ms_fighters_s2.py
"""
from __future__ import annotations
import numpy as np

import ms_fighters_s2_layout as F        # sets meshlib.ATLAS = 1024
from meshlib import Part, loft, chamfer_box, tube, ngon_ring, limb
from gltf_export import export

STEM = 'ms_fighters_s2'
OUT = 'out'
RNG = np.random.default_rng(90210)


# ── helpers (fighters-slice pattern) ───────────────────────────────────
def quad_out(p, verts, outward, zone):
    """Add a polygon wound so its normal points along `outward`."""
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, outward) > 0 else verts[::-1], zone=zone)


def box(p, center, size, zone, ch=0.03, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def body_zone(c, n):
    """World-anchored band pick for the fuselage skin."""
    if n[1] > 0.55:
        return F.F_TOP
    if n[1] < -0.55:
        return F.F_BOT
    return F.F_SIDE


def hex_ring(z, w, wt, yt, yb, yc):
    """Chined 6-point section (right-chine → top → left → bottom)."""
    wb = w * 0.55
    return [(w, yc, z), (wt, yt, z), (-wt, yt, z), (-w, yc, z),
            (-wb, yb, z), (wb, yb, z)]


def blade_flat(p, stations, s, taxis, top_zone, bot_zone, edge_zone,
               cap_tip=True):
    """Station-lofted flat lifting surface (wings / fin / tailplane).

    stations: (span, y, z_le, z_te, thickness); taxis 'y' for horizontal
    surfaces, 'x' for the vertical fin. Root left open (buried).
    """
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
                 (s * np.sign(dx + 1e-9), np.sign(dy + 1e-9) * 0.4, 0),
                 edge_zone)


def missile(p, x, y, r, z_nose, z_tail):
    """Slim AA missile: tapered tube + 4 tail fins."""
    tube(p, [(z_tail, r * 0.85, y), (z_tail - 0.30, r, y),
             (z_nose + 0.50, r, y), (z_nose, r * 0.10, y)],
         F.F_MISSILE, n=6, xoff=x, cap_start=F.F_DARK, cap_end=F.F_DARK)
    for (dx, dy) in ((0.24, 0), (-0.24, 0), (0, 0.24), (0, -0.24)):
        fz0, fz1 = z_tail - 0.48, z_tail - 0.04
        quad = [(x, y, fz0), (x, y, fz1),
                (x + dx, y + dy, fz1), (x + dx, y + dy, fz0 + 0.24)]
        quad_out(p, quad, (-dy, dx, 0), F.F_TRIM)
        quad_out(p, list(quad), (dy, -dx, 0), F.F_TRIM)


def wheel(p, c, r, hw, n=8):
    cx, cy, cz = c
    ra = ngon_ring((cx - hw, cy, cz), r, n=n, axis='x')
    rb = ngon_ring((cx + hw, cy, cz), r, n=n, axis='x')
    for j in range(n):
        k = (j + 1) % n
        quad = [ra[j], ra[k], rb[k], rb[j]]
        cq = np.mean(np.array(quad), axis=0)
        quad_out(p, quad, (0, cq[1] - cy, cq[2] - cz), F.F_DARK)
    quad_out(p, list(ra), (-1, 0, 0), F.F_GEAR)
    quad_out(p, list(rb), (1, 0, 0), F.F_GEAR)


# ── body ───────────────────────────────────────────────────────────────
def build_body():
    p = Part('body')

    # chined fuselage; nose ring left open — the intake duct closes it
    rings = [hex_ring(*s) for s in F.FUS_SECTIONS]
    loft(p, rings, body_zone, cap_end=F.F_TRIM)

    # nose annular intake: lip ring shrunk inward to a dark throat
    lip = rings[0]
    k = F.INTAKE_SCALE
    inner = [(x * k, F.INTAKE_Y + (y - F.INTAKE_Y) * k, F.INTAKE_Z)
             for (x, y, _) in lip]
    loft(p, [lip, inner], lambda c, n: F.F_DUCT, cap_end=F.F_DARK,
         flip_side=True)

    # dorsal spine fairing (canopy deck back to the fin root)
    def spine(z, hw, yb, yt):
        return [(hw, yb, z), (hw, yt, z), (-hw, yt, z), (-hw, yb, z)]
    loft(p, [spine(*s) for s in F.SPINE_SECTIONS], body_zone,
         cap_start=F.F_TRIM, cap_end=F.F_TRIM)

    # bubble canopy, well forward — THE manned cue at zoom
    def arch(z, w, yb, yt):
        return [(w, yb, z), (w * 0.52, yt, z), (0.0, yt + 0.06, z),
                (-w * 0.52, yt, z), (-w, yb, z)]
    loft(p, [arch(*s) for s in F.CAN_SECTIONS],
         lambda c, n: F.F_CANOPY, cap_end=F.F_TRIM)

    # comms blade antenna on the spine (two-sided thin plate)
    bz0, bz1, by0, by1, sweep = F.BLADE
    blade = [(0.0, by0, bz0), (0.0, by1, bz0 + sweep),
             (0.0, by1, bz1), (0.0, by0, bz1)]
    quad_out(p, blade, (1, 0, 0), F.F_TRIM)
    quad_out(p, list(blade), (-1, 0, 0), F.F_TRIM)

    # single vertical fin (centreline; root buried in the spine)
    blade_flat(p, F.FIN, 1, 'x', F.F_FIN, F.F_FIN, F.F_TRIM)

    for s in (1, -1):
        # moderately swept mid wing + low tailplane
        blade_flat(p, F.WING, s, 'y', F.F_TOP, F.F_BOT, F.F_TRIM)
        blade_flat(p, F.TAILPLANE, s, 'y', F.F_TOP, F.F_BOT, F.F_TRIM)

        # underwing pylon + AA missile
        for (px, pyt, pyb, my, mr, mz0, mz1) in F.PYLONS:
            box(p, (s * px, (pyt + pyb) / 2, (mz0 + mz1) / 2 + 0.35),
                (0.12, pyt - pyb + 0.14, (mz1 - mz0) * 0.52), F.F_TRIM,
                ch=0.02)
            missile(p, s * px, my, mr, mz0, mz1)

        # wingtip nav box (port red / starboard green cells)
        nx, ny, nz = F.NAV_TIP
        box(p, (s * nx, ny, nz), (0.12, 0.09, 0.28),
            F.F_NAVP if s > 0 else F.F_NAVS, ch=0.01)

    # single afterburner nozzle (stations zmax→zmin so cap_start faces aft)
    tube(p, F.NOZZLE, F.F_NOZZLE, n=8, cap_start=F.F_BURNER)

    # chin gun tray + stub barrel
    c, sz = F.GUN_FAIRING
    box(p, c, sz, F.F_TRIM, ch=0.03)
    tube(p, [(z, r, F.GUN_Y) for (z, r) in F.GUN_BARREL], F.F_NOZZLE, n=6,
         xoff=F.GUN_X, cap_end=F.F_DARK)
    return p


# ── landing gear (piece-local; origin at the attach point) ─────────────
def build_gear(name, drop, r, hw, s=1):
    p = Part(name)
    limb(p, (0, 0, 0), (0, -drop, -0.04), 0.060, 0.045, F.F_GEAR.rect, n=6)
    limb(p, (0, -drop * 0.5, -0.02), (s * 0.09, -drop * 0.9, 0.14),
         0.028, 0.022, F.F_GEAR.rect, n=4)
    wheel(p, (0, -drop, 0.02), r, hw)
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
        dict(name='muzzle2', parent=0, offset=F.MUZZLE2, part=None),
        dict(name='exhaust', parent=0, offset=F.EXHAUST_OFF, part=None),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'TOTAL: {total} tris')
