"""gen_ms_fighters_s3 — build the s3 Heavy Fighter (twin-boom interceptor).

Twin engine nacelle booms at |x| = 2.2 (each with its own intake funnel and
nozzle), a short central pod with a big forward bubble canopy, pointed radome
and dorsal spine, trapezoidal shoulder wing with forward-swept inboard trailing
edge, one outward-canted fin atop EACH boom joined by a tailplane, two
underwing AA missile pylons per side, and wide-track landing gear (mains
retracting into the booms).

Usage: $FORGE/venv/bin/python gen_ms_fighters_s3.py
"""
from __future__ import annotations
import numpy as np

import ms_fighters_s3_layout as F        # sets meshlib.ATLAS = 1024
from meshlib import Part, loft, chamfer_box, tube, ngon_ring, limb
from gltf_export import export

STEM = 'ms_fighters_s3'
OUT = 'out'


# ── helpers ────────────────────────────────────────────────────────────
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
    """World-anchored band pick for hull/boom skin."""
    if n[1] > 0.55:
        return F.F_TOP
    if n[1] < -0.55:
        return F.F_BOT
    return F.F_SIDE


def hex_ring(z, w, wt, yt, yb, yc, xoff=0.0, s=1):
    """Chined 6-point section (right-chine → top → left → bottom)."""
    wb = w * 0.55
    r = [(w, yc, z), (wt, yt, z), (-wt, yt, z), (-w, yc, z),
         (-wb, yb, z), (wb, yb, z)]
    r = [(xoff + s * x, y, zz) for (x, y, zz) in r]
    return r if s > 0 else r[::-1]


def blade_flat(p, stations, s, taxis, top_zone, bot_zone, edge_zone):
    """Station-lofted flat lifting surface (wings/fins/stabs).

    stations: (span, y, z_le, z_te, thickness); taxis 'y' for horizontal
    surfaces, 'x' for near-vertical fins. Root left open (buried), tip capped.
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
    dx = stations[-1][0] - stations[0][0]
    dy = stations[-1][1] - stations[0][1]
    quad_out(p, rings[-1], (s * np.sign(dx + 1e-9), np.sign(dy) * 0.4, 0),
             edge_zone)


def missile(p, x, y, r, z_nose, z_tail):
    """Slim AA missile: tapered tube + 4 tail fins."""
    tube(p, [(z_tail, r * 0.85, y), (z_tail - 0.30, r, y),
             (z_nose + 0.50, r, y), (z_nose, r * 0.10, y)],
         F.F_MISSILE, n=6, xoff=x, cap_start=F.F_DARK, cap_end=F.F_DARK)
    for (dx, dy) in ((0.26, 0), (-0.26, 0), (0, 0.26), (0, -0.26)):
        fz0, fz1 = z_tail - 0.50, z_tail - 0.04
        quad = [(x, y, fz0), (x, y, fz1),
                (x + dx, y + dy, fz1), (x + dx, y + dy, fz0 + 0.26)]
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

    # central pod (chined hex loft, pointed radome forward)
    loft(p, [hex_ring(*s) for s in F.POD_SECTIONS], body_zone,
         cap_start=F.F_TRIM, cap_end=F.F_TRIM)

    # dorsal spine fairing
    def spine(z, hw, yb, yt):
        return [(hw, yb, z), (hw, yt, z), (-hw, yt, z), (-hw, yb, z)]
    loft(p, [spine(*s) for s in F.SPINE_SECTIONS], body_zone,
         cap_start=F.F_TRIM, cap_end=F.F_TRIM)

    # single-piece bubble canopy, well forward
    def arch(z, w, yb, yt):
        return [(w, yb, z), (w * 0.52, yt, z), (0.0, yt + 0.06, z),
                (-w * 0.52, yt, z), (-w, yb, z)]
    loft(p, [arch(*s) for s in F.CAN_SECTIONS],
         lambda c, n: F.F_CANOPY, cap_end=F.F_TRIM)

    for s in (1, -1):
        xo = s * F.BOOM_X

        # engine boom
        brings = [hex_ring(*sec, xoff=xo, s=s) for sec in F.BOOM_SECTIONS]
        loft(p, brings, body_zone, cap_end=F.F_TRIM)

        # intake funnel: lip ring shrunk inward to a dark throat
        lip = brings[0]
        k = F.INTAKE_SCALE
        inner = [(xo + (x - xo) * k, F.INTAKE_Y + (y - F.INTAKE_Y) * k,
                  F.INTAKE_Z) for (x, y, _) in lip]
        loft(p, [lip, inner], lambda c, n: F.F_DUCT, cap_end=F.F_DARK,
             flip_side=True)

        # afterburner nozzle
        tube(p, F.NOZZLE, F.F_NOZZLE, n=8, xoff=xo, cap_start=F.F_BURNER)

        # lifting surfaces
        blade_flat(p, F.WING, s, 'y', F.F_TOP, F.F_BOT, F.F_TRIM)
        blade_flat(p, F.TAILPLANE, s, 'y', F.F_TOP, F.F_BOT, F.F_TRIM)
        blade_flat(p, F.FIN, s, 'x', F.F_FIN, F.F_FIN, F.F_TRIM)

        # underwing pylons + AA missiles (two per side)
        for (px, pyt, pyb, my, mr, mz0, mz1) in F.PYLONS:
            box(p, (s * px, (pyt + pyb) / 2, (mz0 + mz1) / 2 + 0.35),
                (0.13, pyt - pyb + 0.16, (mz1 - mz0) * 0.52), F.F_TRIM, ch=0.02)
            missile(p, s * px, my, mr, mz0, mz1)

        # wingtip nav box (port red / starboard green cells)
        nx, ny, nz = F.NAV_TIP
        box(p, (s * nx, ny, nz), (0.14, 0.10, 0.30),
            F.F_NAVP if s > 0 else F.F_NAVS, ch=0.01)

    # nose gun fairing + pitot + chaff/flare dispenser
    box(p, *F.GUN_FAIRING, F.F_TRIM, ch=0.04)
    limb(p, F.PITOT, (F.PITOT[0], F.PITOT[1] - 0.02, F.PITOT[2] - 0.55),
         0.025, 0.012, F.F_TRIM.rect, n=4)
    box(p, F.CHAFF, (0.62, 0.12, 0.46), F.F_TRIM, ch=0.02)
    return p


# ── landing gear (piece-local; origin at the attach point) ─────────────
def build_gear(name, drop, r, hw, s=1):
    p = Part(name)
    limb(p, (0, 0, 0), (0, -drop, -0.05), 0.075, 0.055, F.F_GEAR.rect, n=6)
    limb(p, (0, -drop * 0.5, -0.03), (s * 0.10, -drop * 0.9, 0.16),
         0.032, 0.026, F.F_GEAR.rect, n=4)
    wheel(p, (0, -drop, 0.02), r, hw)
    door = [(s * 0.13, 0.02, -0.28), (s * 0.13, 0.02, 0.28),
            (s * 0.13, -drop * 0.75, 0.28), (s * 0.13, -drop * 0.75, -0.28)]
    quad_out(p, door, (s, 0, 0), F.F_TRIM)
    quad_out(p, list(door), (-s, 0, 0), F.F_TRIM)
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
    print(f'[gen_{STEM}] total tris: {total}')
