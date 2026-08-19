"""gen_ms_bombers_s3 — build the s3 Medium Level Bomber (conventional tail).

The orthodox airframe of the bomber line: long slab fuselage with the §26 wide
flattened section, LOW 3-bow side-by-side canopy + glazed bomb-aimer chin
panel, dorsal spine, shoulder-mounted straight-taper wing with TWO podded
underwing engine nacelles on pylons (own intake lip forward of the LE, own
nozzle aft of the TE), a REAL empennage (single tall centreline fin rooted in
the aft deck + horizontal tailplane), a 5.6 m ventral weapons bay with the
slot-1 release empty at its centre, and a fixed ventral MG blister aft of the
bay for slot 2. No turret — §26: the bomber has no defensive turret.

Usage: $FORGE/venv/bin/python gen_ms_bombers_s3.py
"""
from __future__ import annotations
import numpy as np

import ms_bombers_s3_layout as B        # sets meshlib.ATLAS = 2048
from meshlib import Part, loft, chamfer_box, tube, ngon_ring, limb
from gltf_export import export

STEM = 'ms_bombers_s3'
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
    """World-anchored band pick for the fuselage / spine skin."""
    if n[1] > 0.55:
        return B.B_TOP
    if n[1] < -0.55:
        return B.B_BOT
    return B.B_SIDE


def fus_ring(z, w, wt, yt, yb, yc):
    """Chined 6-point section — WIDE and FLAT-BOTTOMED (§26 bomber grammar)."""
    wb = w * 0.86                     # near-square flat belly, not a keel
    return [(w, yc, z), (wt, yt, z), (-wt, yt, z), (-w, yc, z),
            (-wb, yb, z), (wb, yb, z)]


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


def wheel(p, c, r, hw, n=8):
    cx, cy, cz = c
    ra = ngon_ring((cx - hw, cy, cz), r, n=n, axis='x')
    rb = ngon_ring((cx + hw, cy, cz), r, n=n, axis='x')
    for j in range(n):
        k = (j + 1) % n
        quad = [ra[j], ra[k], rb[k], rb[j]]
        cq = np.mean(np.array(quad), axis=0)
        quad_out(p, quad, (0, cq[1] - cy, cq[2] - cz), B.B_DARK)
    quad_out(p, list(ra), (-1, 0, 0), B.B_GEAR)
    quad_out(p, list(rb), (1, 0, 0), B.B_GEAR)


# ── body ───────────────────────────────────────────────────────────────
def build_body():
    p = Part('body')

    # long slab fuselage (chined 6-pt loft, constant section over the bay)
    loft(p, [fus_ring(*s) for s in B.FUS_SECTIONS], body_zone,
         cap_start=B.B_TRIM, cap_end=B.B_TRIM)

    # dorsal spine aft of the canopy
    def spine(z, hw, yb, yt):
        return [(hw, yb, z), (hw, yt, z), (-hw, yt, z), (-hw, yb, z)]
    loft(p, [spine(*s) for s in B.SPINE_SECTIONS], body_zone,
         cap_start=B.B_TRIM, cap_end=B.B_TRIM)

    # LOW 3-bow side-by-side canopy, set INTO the forward deck
    def arch(z, w, yb, yt):
        return [(w, yb, z), (w * 0.60, yt, z), (0.0, yt + 0.04, z),
                (-w * 0.60, yt, z), (-w, yb, z)]
    loft(p, [arch(*s) for s in B.CAN_SECTIONS],
         lambda c, n: B.B_CANOPY, cap_end=B.B_TRIM)

    # glazed bomb-aimer chin panel under the nose
    box(p, *B.AIMER, B.B_GLASS, ch=0.06)

    # single tall centreline fin (root buried in the aft deck / spine)
    blade_flat(p, B.FIN, 1, 'x', B.B_FIN, B.B_FIN, B.B_TRIM)

    for s in (1, -1):
        # shoulder wing + tailplane
        blade_flat(p, B.WING, s, 'y', B.B_TOP, B.B_BOT, B.B_TRIM)
        blade_flat(p, B.TAILPLANE, s, 'y', B.B_TOP, B.B_BOT, B.B_TRIM)

        xo = s * B.NAC_X

        # podded engine nacelle: nozzle aft (glowing cap), duct forward
        tube(p, B.NACELLE, B.B_NAC, n=12, xoff=xo, cap_start=B.B_BURNER)

        # intake lip funnel, forward of the wing leading edge
        lip = ngon_ring((xo, B.NAC_Y, B.INTAKE_Z), B.INTAKE_R, n=12)
        throat = ngon_ring((xo, B.NAC_Y, B.THROAT_Z), B.THROAT_R, n=12)
        loft(p, [lip, throat], lambda c, n: B.B_DUCT, cap_end=B.B_DARK,
             flip_side=True)

        # pylon fairing bridging nacelle crown to the wing underside
        pyc, pyh, pz0, pz1 = B.NAC_PYLON
        box(p, (xo, pyc, (pz0 + pz1) / 2), (0.30, pyh, pz1 - pz0),
            B.B_TRIM, ch=0.03)

        # wingtip nav box (port red / starboard green)
        nx, ny, nz = B.NAV_TIP
        box(p, (s * nx, ny, nz), (0.16, 0.11, 0.34),
            B.B_NAVP if s > 0 else B.B_NAVS, ch=0.01)

    # long ventral weapons bay — closed door box, painted doors + ARM outline
    bx, by, bz, bw, bh, bd = B.BAY
    box(p, (bx, by, bz), (bw, bh, bd), B.B_BOT, ch=0.05, skip=('+y',))

    # FIXED ventral MG blister aft of the bay (slot 2 — no turret, §26)
    box(p, *B.MG_FAIRING, B.B_TRIM, ch=0.05)
    tube(p, B.MG_BARREL, B.B_BARREL, n=6, cap_start=B.B_DARK)

    # greebles: blade antennas on the spine + chaff/flare box
    for (ax, ay, az) in B.ANTENNAS:
        quad = [(ax, ay, az), (ax, ay + 0.26, az + 0.10),
                (ax, ay + 0.26, az + 0.30), (ax, ay, az + 0.38)]
        quad_out(p, quad, (1, 0, 0), B.B_TRIM)
        quad_out(p, list(quad), (-1, 0, 0), B.B_TRIM)
    box(p, *B.CHAFF, B.B_TRIM, ch=0.02)
    box(p, *B.TAILCONE, B.B_TRIM, ch=0.05)
    limb(p, (B.PITOT[0], B.PITOT[1], B.PITOT[2] + 0.55),
         B.PITOT, 0.035, 0.014, B.B_TRIM.rect, n=4)
    return p


# ── landing gear (piece-local; origin at the attach point) ─────────────
def build_gear(name, drop, r, hw, s=1, twin=False):
    p = Part(name)
    limb(p, (0, 0, 0), (0, -drop, -0.05), 0.085, 0.062, B.B_GEAR.rect, n=6)
    limb(p, (0, -drop * 0.5, -0.03), (s * 0.12, -drop * 0.9, 0.18),
         0.036, 0.028, B.B_GEAR.rect, n=4)
    if twin:
        wheel(p, (-r * 0.62, -drop, 0.02), r, hw)
        wheel(p, (r * 0.62, -drop, 0.02), r, hw)
    else:
        wheel(p, (-hw - 0.06, -drop, 0.02), r, hw)
        wheel(p, (hw + 0.06, -drop, 0.02), r, hw)
    door = [(s * 0.15, 0.02, -0.32), (s * 0.15, 0.02, 0.32),
            (s * 0.15, -drop * 0.78, 0.32), (s * 0.15, -drop * 0.78, -0.32)]
    quad_out(p, door, (s, 0, 0), B.B_TRIM)
    quad_out(p, list(door), (-s, 0, 0), B.B_TRIM)
    return p


def build_all():
    (nx, ny, nz), ndrop, nr, nhw = B.GEAR_N
    (mx, my, mz), mdrop, mr, mhw = B.GEAR_M
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='gear_n', parent=0, offset=(nx, ny, nz),
             part=build_gear('gear_n', ndrop, nr, nhw, twin=True)),
        dict(name='gear_l', parent=0, offset=(mx, my, mz),
             part=build_gear('gear_l', mdrop, mr, mhw, s=1)),
        dict(name='gear_r', parent=0, offset=(-mx, my, mz),
             part=build_gear('gear_r', mdrop, mr, mhw, s=-1)),
        dict(name='muzzle', parent=0, offset=B.MUZZLE_OFF, part=None),
        dict(name='muzzle2', parent=0, offset=B.MUZZLE2_OFF, part=None),
        dict(name='exhaust', parent=0, offset=B.EXHAUST_OFF, part=None),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_{STEM}] total tris: {total}')
