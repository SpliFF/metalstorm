"""gen_ms_anc_aqueduct — build ms_anc_aqueduct (30 m ancient aqueduct bay).

Monolithic two-tier arcade carrying a sealed channel.  Lower tier: two
15 m-pitch great arches (R 5.9) on 5.6 m thick piers with a stepped base
course, projecting imposts and keystones.  A single unbroken cantilevered
cornice divides the tiers.  Upper tier: six 5 m-pitch arches (R 1.6).  A
sealed channel and a projecting rim (which carries the cyan pulse line)
run the full length.

TILEABLE: piers of both arcades are centred on z = ±15 and clipped there,
so chained segments merge into whole piers; every horizontal member runs
z = -15 .. +15 at full section.

BREACH: the upper bay centred z = +2.5 has lost its entire crown wedge —
the channel spans the 3.2 m gap unsupported — and the channel floor is
ruptured above it, spilling a fossilised calcite flow that drapes the
cornice, runs down the z = 0 pier and pools on the ground.

Single static `body` piece, no clips, no team.  Forward -Z, up +Y,
ground Y = 0, 1 u = 1 m.  Deterministic (seed 90210 for the flow lumps).

Usage: python3 gen_ms_anc_aqueduct.py
"""
from __future__ import annotations
import numpy as np

import ms_anc_aqueduct_layout as L    # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, chamfer_box, limb
from gltf_export import export

STEM = 'ms_anc_aqueduct'
OUT = 'out'
RNG = np.random.default_rng(90210)
ATL = float(L.ATLAS)


# ── small helpers ────────────────────────────────────────────────────────

def newell(vs):
    n = np.zeros(3)
    k = len(vs)
    for i in range(k):
        c = np.asarray(vs[i], float)
        d = np.asarray(vs[(i + 1) % k], float)
        n[0] += (c[1] - d[1]) * (c[2] + d[2])
        n[1] += (c[2] - d[2]) * (c[0] + d[0])
        n[2] += (c[0] - d[0]) * (c[1] + d[1])
    return n


def face_n(p, vs, want, zone=None, uvs=None):
    """Add a face, flipping so its normal points along `want`."""
    n = newell(vs)
    p.add_face(vs, zone=zone, uvs=uvs,
               flip=(float(np.dot(n, np.asarray(want, float))) < 0.0))


def zclip(zc, w):
    """Clip a member of width w centred on zc to the tileable envelope."""
    a, b = max(L.Z0, zc - w / 2.0), min(L.Z1, zc + w / 2.0)
    return (a + b) / 2.0, (b - a)


def pier_zones(zc, w, side=None):
    """Elevation on ±x, plain stone on the arch reveals, dark core on any
    face that lands on a tile seam."""
    side = side or L.Z_STONE
    zz = {'+x': L.Z_ELEV, '-x': L.Z_ELEV, '+z': side, '-z': side}
    if zc + w / 2.0 >= L.Z1 - 1e-6:
        zz['+z'] = L.Z_CORE
    if zc - w / 2.0 <= L.Z0 + 1e-6:
        zz['-z'] = L.Z_CORE
    return zz


# ── the arcade primitive ─────────────────────────────────────────────────

def arch_bay(p, zc, R, y_s, y_t, hx, n, top_face=True, brk=None):
    """One arched bay of a solid wall.

    The wall between two piers is a shell: an elevation fan on each ±x
    face (radial quads from the semicircular intrados out to the bay
    rectangle) plus the curved soffit joining them.  `brk` = (a, b) as
    fractions of pi removes that angular wedge (a collapsed crown) and
    caps the two clean fracture planes.
    """
    C = np.array([zc, y_s])

    def pt(t):
        return np.array([zc + R * np.cos(t), y_s + R * np.sin(t)])

    def bnd(t):
        d = np.array([np.cos(t), np.sin(t)])
        ts = []
        if abs(d[0]) > 1e-9:
            ts.append(R / abs(d[0]))
        if d[1] > 1e-9:
            ts.append((y_t - y_s) / d[1])
        return C + min(ts) * d

    def killed(tm):
        return brk is not None and brk[0] <= tm / np.pi <= brk[1]

    sx0, sy0, sx1, sy1 = L.Z_SOFF.rect

    def suv(uf, vf):
        return ((sx0 + (sx1 - sx0) * uf) / ATL, (sy0 + (sy1 - sy0) * vf) / ATL)

    for i in range(n):
        t0, t1 = np.pi * i / n, np.pi * (i + 1) / n
        tm = 0.5 * (t0 + t1)
        if killed(tm):
            continue
        P0, P1, Q0, Q1 = pt(t0), pt(t1), bnd(t0), bnd(t1)
        for s in (1, -1):                       # elevation fan, both faces
            x = s * hx
            face_n(p, [(x, Q0[1], Q0[0]), (x, P0[1], P0[0]),
                       (x, P1[1], P1[0]), (x, Q1[1], Q1[0])],
                   (s, 0, 0), zone=L.Z_ELEV)
        face_n(p, [(-hx, P0[1], P0[0]), (hx, P0[1], P0[0]),   # soffit
                   (hx, P1[1], P1[0]), (-hx, P1[1], P1[0])],
               (0.0, -np.sin(tm), -np.cos(tm)),
               uvs=[suv(t0 / np.pi, 0.0), suv(t0 / np.pi, 1.0),
                    suv(t1 / np.pi, 1.0), suv(t1 / np.pi, 0.0)])

    # clean fracture planes at the two break edges
    if brk is not None:
        for frac, sgn in ((brk[0], -1.0), (brk[1], 1.0)):
            t = frac * np.pi
            P, Q = pt(t), bnd(t)
            want = (0.0, sgn * np.cos(t), -sgn * np.sin(t))
            face_n(p, [(-hx, P[1], P[0]), (hx, P[1], P[0]),
                       (hx, Q[1], Q[0]), (-hx, Q[1], Q[0])],
                   want, zone=L.Z_CORE)

    # wall top over the bay (the whole span is lost when the bay is broken)
    if top_face and brk is None:
        face_n(p, [(-hx, y_t, zc - R), (hx, y_t, zc - R),
                   (hx, y_t, zc + R), (-hx, y_t, zc + R)],
               (0, 1, 0), zone=L.Z_TOP)


# ── the model ────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')

    # ── soil drift + stepped base course at each lower pier ──
    for zc in L.LP_Z:
        cz, w = zclip(zc, L.LP_W + L.BERM_DZ * 2)
        chamfer_box(p, (0.0, L.BERM_H / 2, cz),
                    (L.BERM_HX * 2, L.BERM_H, w), 0.42,
                    {k: L.Z_SOIL for k in ('+x', '-x', '+y', '+z', '-z')},
                    skip=('-y',))
        cz, w = zclip(zc, L.LP_W + L.BASE_DZ * 2)
        zz = pier_zones(zc, w)
        zz['+y'] = L.Z_TOP
        chamfer_box(p, (0.0, L.BASE_H / 2, cz),
                    (L.BASE_HX * 2, L.BASE_H, w), 0.16, zz, skip=('-y',))

    # ── lower piers (full height of the tier; the cornice caps them) ──
    for zc in L.LP_Z:
        cz, w = zclip(zc, L.LP_W)
        chamfer_box(p, (0.0, L.L_TOP / 2, cz),
                    (L.LP_HX * 2, L.L_TOP, w), 0.22,
                    pier_zones(zc, w), skip=('-y', '+y'))
        # impost block at the springing line
        cz, w = zclip(zc, L.LP_W + L.IMP_DZ * 2)
        zz = pier_zones(zc, w)
        zz['+y'], zz['-y'] = L.Z_TOP, L.Z_CORE
        chamfer_box(p, (0.0, (L.IMP_Y0 + L.IMP_Y1) / 2, cz),
                    (L.IMP_HX * 2, L.IMP_Y1 - L.IMP_Y0, w), 0.1, zz)

    # ── the two great arches ──
    for zc in L.L_BAYS:
        arch_bay(p, zc, L.L_R, L.L_SPRING, L.L_TOP, L.LP_HX, L.L_N,
                 top_face=False)
        # keystone straddling the crown, proud of the wall face
        ky = L.L_SPRING + L.L_R
        chamfer_box(p, (0.0, (ky + L.L_TOP) / 2, zc),
                    (L.KEY_HX * 2, L.L_TOP - ky, L.KEY_DZ), 0.12,
                    {'+x': L.Z_ELEV, '-x': L.Z_ELEV,
                     '+z': L.Z_STONE, '-z': L.Z_STONE},
                    skip=('-y', '+y'))

    # ── the cornice: one unbroken cantilevered band ──
    chamfer_box(p, (0.0, (L.COR_Y0 + L.COR_Y1) / 2, 0.0),
                (L.COR_HX * 2, L.COR_Y1 - L.COR_Y0, L.Z1 - L.Z0), 0.14,
                {'+x': L.Z_ELEV, '-x': L.Z_ELEV, '+y': L.Z_TOP,
                 '-y': L.Z_CORE, '+z': L.Z_CORE, '-z': L.Z_CORE})

    # ── upper piers ──
    for zc in L.UP_Z:
        cz, w = zclip(zc, L.UP_W)
        zz = pier_zones(zc, w)
        zz['+y'] = L.Z_TOP
        chamfer_box(p, (0.0, (L.U_Y0 + L.U_TOP) / 2, cz),
                    (L.UP_HX * 2, L.U_TOP - L.U_Y0, w), 0.16, zz,
                    skip=('-y',))

    # ── the six upper arches (one breached) ──
    for zc in L.U_BAYS:
        brk = ((L.BREACH_A, L.BREACH_B)
               if abs(zc - L.BREACH_BAY) < 1e-6 else None)
        arch_bay(p, zc, L.U_R, L.U_SPRING, L.U_TOP, L.UP_HX, L.U_N, brk=brk)

    # ── sealed channel + projecting rim ──
    chamfer_box(p, (0.0, (L.CH_Y0 + L.CH_Y1) / 2, 0.0),
                (L.CH_HX * 2, L.CH_Y1 - L.CH_Y0, L.Z1 - L.Z0), 0.12,
                {'+x': L.Z_ELEV, '-x': L.Z_ELEV,
                 '+z': L.Z_CORE, '-z': L.Z_CORE}, skip=('+y', '-y'))
    chamfer_box(p, (0.0, (L.RIM_Y0 + L.RIM_Y1) / 2, 0.0),
                (L.RIM_HX * 2, L.RIM_Y1 - L.RIM_Y0, L.Z1 - L.Z0), 0.1,
                {'+x': L.Z_ELEV, '-x': L.Z_ELEV, '+y': L.Z_TOP,
                 '-y': L.Z_CORE, '+z': L.Z_CORE, '-z': L.Z_CORE})

    build_breach(p)
    build_calcite(p)
    return p


def build_breach(p):
    """Channel underside exposed over the lost bay, plus its rupture."""
    y = L.CH_Y0
    za, zb = L.BREACH_BAY - L.U_R, L.BREACH_BAY + L.U_R
    hx, rhx = L.CH_HX, L.RUP_HX
    r0, r1 = L.RUP_Z0, L.RUP_Z1

    def down(x0, x1, z0, z1, zone):
        face_n(p, [(x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1)],
               (0, -1, 0), zone=zone)

    down(-hx, hx, za, r0, L.Z_CORE)          # channel soffit, +z of the hole
    down(-hx, hx, r1, zb, L.Z_CORE)          # channel soffit, -z of the hole
    down(-hx, -rhx, r0, r1, L.Z_CORE)        # either side of the hole
    down(rhx, hx, r0, r1, L.Z_CORE)

    # rupture walls (seen looking up into the channel) + calcite plug plate
    ry = L.RUP_Y
    for z in (r0, r1):
        want = (0, 0, 1.0 if z == r0 else -1.0)
        face_n(p, [(-rhx, y, z), (rhx, y, z), (rhx, ry, z), (-rhx, ry, z)],
               want, zone=L.Z_CORE)
    for s in (1, -1):
        face_n(p, [(s * rhx, y, r0), (s * rhx, y, r1),
                   (s * rhx, ry, r1), (s * rhx, ry, r0)],
               (-s, 0, 0), zone=L.Z_CORE)
    face_n(p, [(-rhx, ry, r0), (rhx, ry, r0), (rhx, ry, r1), (-rhx, ry, r1)],
           (0, -1, 0), zone=L.Z_CALC)


def build_calcite(p):
    """Fossilised flow: a lumpy faceted drape from the rupture to a pool."""
    rect = L.Z_CALC.rect
    # main drape: rupture -> over the cornice lip -> down the z = 0 pier
    path = [
        (0.00, 27.10, 2.50, 1.60),
        (0.80, 26.30, 2.50, 1.42),
        (1.70, 25.20, 2.35, 1.26),
        (2.50, 23.40, 2.10, 1.16),
        (3.15, 21.60, 1.80, 1.10),
        (3.62, 20.40, 1.55, 1.05),   # over the cornice lip (x 3.3)
        (3.45, 18.60, 1.30, 0.96),
        (3.22, 15.50, 1.05, 0.88),
        (3.34, 12.90, 0.95, 0.84),   # past the impost (x 3.05)
        (3.40, 11.60, 0.90, 0.88),
        (3.22, 8.00, 0.80, 0.92),
        (3.35, 5.00, 0.75, 1.05),
        (3.70, 2.60, 0.70, 1.26),
        (3.95, 1.00, 0.65, 1.80),
    ]
    # forked strand: splits at the cornice and runs the far side of the pier
    fork = [
        (3.45, 18.60, 1.30, 0.72),
        (3.30, 17.00, 0.10, 0.66),
        (3.22, 13.00, -0.45, 0.62),
        (3.20, 8.00, -0.62, 0.66),
        (3.30, 4.00, -0.70, 0.80),
        (3.58, 1.20, -0.75, 1.20),
    ]
    for run in (path, fork):
        for i in range(len(run) - 1):
            x0, y0, z0, r0 = run[i]
            x1, y1, z1, r1 = run[i + 1]
            j = (RNG.random(3) - 0.5) * 0.16
            limb(p, (x0, y0, z0), (x1 + j[0], y1, z1 + j[2]), r0, r1,
                 rect, n=6)
    # pools at the foot, spreading into the soil drift
    limb(p, (3.95, 0.00, 0.60), (3.95, 1.15, 0.60), 2.55, 1.65, rect, n=8,
         cap_end=L.Z_CALC)
    limb(p, (3.65, 0.00, -0.85), (3.65, 0.80, -0.85), 1.75, 1.15, rect, n=7,
         cap_end=L.Z_CALC)
    # stalactite fingers hanging round the rupture rim
    for (fx, fz, fl, fr) in ((1.15, 1.95, 1.9, 0.42), (-0.95, 2.85, 1.4, 0.34),
                             (0.35, 3.15, 2.4, 0.38)):
        limb(p, (fx, L.CH_Y0 + 0.05, fz), (fx, L.CH_Y0 - fl, fz),
             fr, 0.08, rect, n=5)
    # one fallen monolith on the ground below the breach
    limb(p, (4.25, 0.30, 4.90), (4.95, 1.75, 6.50), 1.05, 0.80,
         L.Z_STONE.rect, n=4, cap_start=L.Z_CORE, cap_end=L.Z_CORE)


def build_all():
    return [dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body())]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=[],
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=[],
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    lo, hi = pieces[0]['part'].bounds()
    print(f'[gen_ms_anc_aqueduct] total tris: {total}')
    print(f'[gen_ms_anc_aqueduct] bounds min {tuple(round(v, 2) for v in lo)} '
          f'max {tuple(round(v, 2) for v in hi)}')
