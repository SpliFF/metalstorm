"""gen_ms_anc_lance_battery — assemble the ancient particle lance battery.

ANCIENT REGISTER (world-before): monolithic, precise, seamless. A 24-gon
soil-buried drum monolith carries a stepped plinth; 0.95 m of empty air above
it a yoke ring FLOATS, unattached, and cantilevers two blade arms forward to
trunnions that sling a 14 m particle lance — a coil-segmented shaft beaded
with six cyan acceleration rings, encircled by two free-floating field
collars, ending in a four-prong emitter around a cyan core.

Standard aimable chain: body -> turret (floating yoke ring, yaw) -> barrel
(the lance, pitch) -> muzzle (empty, at the emitter tip).
Idle clip: 26 s slow yoke scan, +/-42 deg, seamless.

Run: python3 gen_ms_anc_lance_battery.py -> out/*.gltf + .bin
"""
import numpy as np

import ms_anc_lance_battery_layout as F     # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, chamfer_box, ngon_ring, limb, tube
from parts import quad_out
from gltf_export import export

STEM = 'ms_anc_lance_battery'
OUT = 'out'
A = float(F.ATLAS)


# ── generic skinning helpers (wrap UVs: u = around, v = along) ───────────

def skin(part, rings, vfr, rect, outward):
    """Skin consecutive equal-length vertex rings with parametric wrap UVs.

    rings: list of rings (each a list of points, consistent ordering).
    vfr:   v fraction 0..1 per ring (0 = rect top).
    rect:  atlas rect (x0, y0, x1, y1).
    outward: callable(quad_centre_ndarray) -> outward direction vector.
    """
    x0, y0, x1, y1 = rect
    n = len(rings[0])
    for i in range(len(rings) - 1):
        r0, r1 = rings[i], rings[i + 1]
        va = (y0 + (y1 - y0) * vfr[i]) / A
        vb = (y0 + (y1 - y0) * vfr[i + 1]) / A
        for j in range(n):
            k = (j + 1) % n
            ua = (x0 + (x1 - x0) * j / n) / A
            ub = (x0 + (x1 - x0) * (j + 1) / n) / A
            quad = [r0[j], r0[k], r1[k], r1[j]]
            uvs = [(ua, va), (ub, va), (ub, vb), (ua, vb)]
            c = np.mean(np.array(quad, dtype=float), axis=0)
            nrm = np.cross(np.asarray(quad[1], float) - np.asarray(quad[0], float),
                           np.asarray(quad[3], float) - np.asarray(quad[0], float))
            if np.dot(nrm, np.asarray(outward(c), float)) < 0:
                quad, uvs = quad[::-1], uvs[::-1]
            part.add_face(quad, uvs=uvs)


def out_y(c):      # cylinder about the Y axis
    return (c[0], 0.0, c[2])


def out_z(c):      # cylinder about the Z axis
    return (c[0], c[1], 0.0)


def const(v):
    return lambda c: v


def beam(part, p0, p1, a0, b0, a1, b1, rect, up=(0.0, 0.0, 1.0),
         cap0=False, cap1=False, cap_zone=None):
    """Rectangular-section blade between two points — the ancient cantilever
    primitive (limb() only makes n-gon prisms with a circular section).
    a = half-size along `right` (up x d), b = half-size along the residual up.
    """
    p0 = np.asarray(p0, float)
    p1 = np.asarray(p1, float)
    d = p1 - p0
    ln = float(np.linalg.norm(d))
    if ln < 1e-9:
        return
    d /= ln
    upv = np.asarray(up, float)
    if abs(float(np.dot(upv, d))) > 0.95:
        upv = np.array([1.0, 0.0, 0.0])
    r = np.cross(upv, d)
    r /= np.linalg.norm(r)
    u2 = np.cross(d, r)

    def ring(p, a, b):
        return [tuple(p + r * a + u2 * b), tuple(p - r * a + u2 * b),
                tuple(p - r * a - u2 * b), tuple(p + r * a - u2 * b)]

    R0, R1 = ring(p0, a0, b0), ring(p1, a1, b1)
    skin(part, [R0, R1], [0.0, 1.0], rect,
         lambda c: c - (p0 + d * float(np.dot(c - p0, d))))
    if cap0:
        quad_out(part, R0, -d, cap_zone)
    if cap1:
        quad_out(part, R1, d, cap_zone)


# ── body: the monolith ──────────────────────────────────────────────────

def build_body():
    p = Part('body')
    n = F.N_DRUM

    def rings_of(spec):
        return [ngon_ring((0, y, 0), r, n=n, axis='y') for (y, r) in spec]

    # buried skirt flare (ground contact — soil swallows the foot)
    sk = rings_of(F.SKIRT_RINGS)
    skin(p, sk, [0.0, 1.0], F.R_SKIRT, out_y)

    # the drum monolith: one unbroken wall, straight-sided, chamfered crown
    dr = rings_of(F.DRUM_RINGS)
    vf = [(F.DRUM_Y_TOP - y) / (F.DRUM_Y_TOP - F.DRUM_Y_BOT)
          for (y, _) in F.DRUM_RINGS]
    skin(p, dr, vf, F.R_DRUM, out_y)

    # recessed crown shelf: concentric rows so the live ring is real geometry
    pl = rings_of(F.PLINTH_RINGS)
    sh = [ngon_ring((0, F.DRUM_TOP_Y, 0), r, n=n, axis='y')
          for r in F.SHELF_RINGS]
    skin(p, sh, list(np.linspace(0, 1, len(sh))), F.R_SHELF, const((0, 1, 0)))

    # stepped plinth
    vf = [(F.PLINTH_Y_TOP - y) / (F.PLINTH_Y_TOP - F.PLINTH_Y_BOT)
          for (y, _) in F.PLINTH_RINGS]
    skin(p, pl, vf, F.R_PLINTH, out_y)

    # the levitation dais — concentric glyph rows the floating ring hovers over
    da = [ngon_ring((0, F.PLINTH_TOP_Y, 0), r, n=n, axis='y')
          for r in F.DAIS_RINGS]
    skin(p, da, list(np.linspace(0, 1, len(da))), F.R_DAIS, const((0, 1, 0)))
    quad_out(p, da[-1], (0, 1, 0), F.Z_DAIS)

    # four capture plaques on the cardinal facets (24-gon facet centres land
    # exactly on +-X / +-Z, so a flat plaque sits square on the wall)
    sides = {k: F.Z_TRIM for k in ('+x', '-x', '+y', '-y', '+z', '-z')}
    for sgn in (1, -1):
        z = dict(sides)
        z['+z' if sgn > 0 else '-z'] = F.Z_PLAQ_Z
        chamfer_box(p, (0, F.PLAQ_Y, sgn * F.PLAQ_OFF),
                    (F.PLAQ_W, F.PLAQ_H, F.PLAQ_T), 0.05, z,
                    skip=('-z' if sgn > 0 else '+z',))
        z = dict(sides)
        z['+x' if sgn > 0 else '-x'] = F.Z_PLAQ_X
        chamfer_box(p, (sgn * F.PLAQ_OFF, F.PLAQ_Y, 0),
                    (F.PLAQ_T, F.PLAQ_H, F.PLAQ_W), 0.05, z,
                    skip=('-x' if sgn > 0 else '+x',))
    return p


# ── turret: the floating yoke ring ──────────────────────────────────────

def build_turret():
    """Ring-local frame: origin at the ring's mid-plane centre, no contact
    with anything below — the whole piece hovers."""
    p = Part('turret')
    n = F.N_RING
    ro, ri, hh = F.RING_RO, F.RING_RI, F.RING_HH

    o_top = ngon_ring((0, hh, 0), ro, n=n, axis='y')
    o_bot = ngon_ring((0, -hh, 0), ro, n=n, axis='y')
    i_top = ngon_ring((0, hh, 0), ri, n=n, axis='y')
    i_bot = ngon_ring((0, -hh, 0), ri, n=n, axis='y')

    skin(p, [o_top, o_bot], [0.0, 1.0], F.R_RING_O, out_y)          # outer rim
    skin(p, [i_top, i_bot], [0.0, 1.0], F.R_RING_I,
         lambda c: (-c[0], 0.0, -c[2]))                             # glowing bore
    skin(p, [o_top, i_top], [0.0, 1.0], F.R_RING_T, const((0, 1, 0)))
    skin(p, [o_bot, i_bot], [0.0, 1.0], F.R_RING_B, const((0, -1, 0)))

    # two blade arms, cantilevered forward off the ring crown
    fx, fy, fz = F.ARM_FOOT
    kx, ky, kz = F.ARM_KNEE
    tx, ty, tz = F.TRUN
    for s in (-1, 1):
        beam(p, (s * fx, fy, fz), (s * kx, ky, kz),
             F.ARM_A0, F.ARM_B0, F.ARM_A1, F.ARM_B1, F.R_ARM,
             cap0=True, cap_zone=F.Z_TRIM)
        beam(p, (s * kx, ky, kz), (s * tx, ty, tz),
             F.ARM_A1, F.ARM_B1, F.ARM_A2, F.ARM_B2, F.R_ARM)

    # trunnion drums (axis X) — the lance hangs between them
    for s in (-1, 1):
        a = ngon_ring((s * (tx + F.TRUN_HL), ty, tz), F.TRUN_R, n=12, axis='x')
        b = ngon_ring((s * (tx - F.TRUN_HL), ty, tz), F.TRUN_R, n=12, axis='x')
        skin(p, [a, b], [0.0, 1.0], F.R_TRUN,
             lambda c, ty=ty, tz=tz: (0.0, c[1] - ty, c[2] - tz))
        quad_out(p, a, (s, 0, 0), F.Z_TRIM)
    return p


# ── barrel: the lance ───────────────────────────────────────────────────

def build_barrel():
    p = Part('barrel')
    tube(p, F.lance_stations(), F.R_LANCE, n=F.N_TUBE,
         cap_start=F.Z_BREECH, cap_end=F.Z_TIP, axis='z')

    # free-floating field collars — no strut, no contact with the shaft
    for cz in F.COLLAR_Z:
        ro, ri, hh = F.COLLAR_RO, F.COLLAR_RI, F.COLLAR_HH
        of = ngon_ring((0, 0, cz - hh), ro, n=F.N_COLLAR, axis='z')
        ob = ngon_ring((0, 0, cz + hh), ro, n=F.N_COLLAR, axis='z')
        i_f = ngon_ring((0, 0, cz - hh), ri, n=F.N_COLLAR, axis='z')
        i_b = ngon_ring((0, 0, cz + hh), ri, n=F.N_COLLAR, axis='z')
        skin(p, [of, ob], [0.0, 1.0], F.R_COL_O, out_z)
        skin(p, [i_f, i_b], [0.0, 1.0], F.R_COL_I, lambda c: (-c[0], -c[1], 0.0))
        skin(p, [of, i_f], [0.0, 1.0], F.R_COL_F, const((0, 0, -1)))
        skin(p, [ob, i_b], [0.0, 1.0], F.R_COL_B, const((0, 0, 1)))

    # four-prong emitter cage, splayed open around the core
    for i in range(F.N_PRONG):
        a = np.pi / 4 + i * np.pi / 2
        ca, sa = float(np.cos(a)), float(np.sin(a))
        limb(p, (ca * F.PRONG_R0, sa * F.PRONG_R0, F.PRONG_Z0),
             (ca * F.PRONG_R1, sa * F.PRONG_R1, F.PRONG_Z1),
             F.PRONG_T0, F.PRONG_T1, F.R_PRONG, n=4,
             cap_start=F.Z_TRIM, cap_end=F.Z_TRIM)

    # emitter core: the lit face at the heart of the cage
    core = ngon_ring((0, 0, F.CORE_DISC_Z), F.CORE_DISC_R, n=12, axis='z')
    quad_out(p, core, (0, 0, -1), F.Z_CORE)
    return p


# ── clips ───────────────────────────────────────────────────────────────

def qy(deg):
    r = np.radians(deg) / 2.0
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    """Idle: the yoke ring scans, slow and untroubled — 26 s, +/-42 deg,
    cosine-eased, last key repeats the first (seamless)."""
    T = 26.0
    keys = []
    for i in range(13):
        t = T * i / 12
        keys.append((t, qy(-42.0 * float(np.cos(2 * np.pi * t / T)))))
    return [{'name': 'idle', 'channels': [('turret', 'rotation', keys)]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='turret', parent=0, offset=(0, F.RING_Y, 0),
             part=build_turret()),
        dict(name='barrel', parent=1, offset=(0.0, F.TRUN[1], F.TRUN[2]),
             part=build_barrel()),
        dict(name='muzzle', parent=2, offset=(0, 0, F.PRONG_TIP), part=Part('muzzle')),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
