"""gen_ms_anc_custodian — assemble ms_anc_custodian and export .gltf/.bin.

ANCIENT REGISTER maintenance automaton, s1 (4.50 m long, budget 1800 tris).
Monolithic hovering wedge: one unbroken lofted hull, four perfect-circle
underside emitter plates each with a detached inner disc, a belly keel and
a dorsal ridge carrying cyan tracery, a circular deck core well capped by a
floating lens, two folded manipulator arms on the flanks, and a free-
floating ring gyro (`dish`) turning inside a second, detached halo ring.
Nothing is bolted, riveted or patched — every break in the surface is a
clean recessed seam, painted, not modelled.

Run: python3 gen_ms_anc_custodian.py  → out/ms_anc_custodian{,_png}.gltf
"""
from __future__ import annotations
import numpy as np

import ms_anc_custodian_layout as F      # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, Zone, loft, chamfer_box, ngon_ring, limb, mirror_x
from gltf_export import export

STEM = 'ms_anc_custodian'
OUT = 'out'

RNG = np.random.default_rng(90210)       # forge determinism seed


# ── low-level helpers ───────────────────────────────────────────────────

def poly_out(p, ring, outward, zone):
    """n-gon face wound so its normal points along `outward`."""
    a, b, c = (np.asarray(ring[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    verts = list(ring)
    p.add_face(verts if np.dot(n, np.asarray(outward, dtype=float)) > 0
               else verts[::-1], zone=zone)


def quad_out(p, verts, outward, zone):
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, np.asarray(outward, dtype=float)) > 0
               else verts[::-1], zone=zone)


def band(p, ra, rb, rect, outward_of):
    """Skin two coaxial equal-length rings with parametric UVs into a rect.
    outward_of(centre) -> the direction the quad should face."""
    x0, y0, x1, y1 = rect
    n = len(ra)
    va, vb = y0 / M.ATLAS, y1 / M.ATLAS
    for j in range(n):
        k = (j + 1) % n
        quad = [ra[j], ra[k], rb[k], rb[j]]
        u0 = (x0 + (x1 - x0) * j / n) / M.ATLAS
        u1 = (x0 + (x1 - x0) * (j + 1) / n) / M.ATLAS
        uvs = [(u0, va), (u1, va), (u1, vb), (u0, vb)]
        ctr = np.mean(np.array(quad, dtype=float), axis=0)
        nrm = np.cross(np.asarray(quad[1], dtype=float) - np.asarray(quad[0], dtype=float),
                       np.asarray(quad[3], dtype=float) - np.asarray(quad[0], dtype=float))
        if np.dot(nrm, np.asarray(outward_of(ctr), dtype=float)) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)


def annulus(p, ro, ri, outward, zone):
    """Flat ring between two coplanar coaxial rings."""
    n = len(ro)
    for j in range(n):
        k = (j + 1) % n
        quad_out(p, [ro[j], ro[k], ri[k], ri[j]], outward, zone)


def radial_y(cx, cz):
    return lambda c: (c[0] - cx, 0.0, c[2] - cz)


def radial_x(cy, cz):
    return lambda c: (0.0, c[1] - cy, c[2] - cz)


# ── hull ────────────────────────────────────────────────────────────────

def hull_ring(sec):
    z, yb, ym, yt, yd, wb, wm, wt, wd = sec
    return [
        (wb, yb, z), (wm, ym, z), (wt, yt, z), (wd, yd, z),
        (-wd, yd, z), (-wt, yt, z), (-wm, ym, z), (-wb, yb, z),
    ]


def hull_zone(c, n):
    if n[1] < -0.45:
        return F.A_BELLY
    if n[2] < -0.62:
        return F.A_FRONT
    if n[2] > 0.62:
        return F.A_REAR
    if abs(n[0]) > 0.40:
        return F.A_SIDE
    return F.A_TOP


def emitter_plate(p, cx, cz, r, y_top, y_lip):
    """Perfect-circle hover emitter: buried collar, lip annulus, and an
    inner disc hanging free below it (ancient 'floating element')."""
    n = F.EMIT_N
    ro_t = ngon_ring((cx, y_top, cz), r, n=n, axis='y')
    ro_b = ngon_ring((cx, y_lip, cz), r, n=n, axis='y')
    band(p, ro_t, ro_b, F.A_EMIT, radial_y(cx, cz))
    ri_b = ngon_ring((cx, y_lip, cz), r * F.EMIT_INNER, n=n, axis='y')
    zf = Zone(F.A_EMIT_F, ('x', 'z'), ((cx - r, cx + r), (cz - r, cz + r)))
    annulus(p, ro_b, ri_b, (0, -1, 0), zf)
    # inner wall back up into the hull so the bore is never see-through
    ri_t = ngon_ring((cx, y_top, cz), r * F.EMIT_INNER, n=n, axis='y')
    band(p, ri_t, ri_b, F.A_EMIT, lambda c, f=radial_y(cx, cz):
         tuple(-v for v in f(c)))
    poly_out(p, ri_t, (0, 1, 0), F.A_DARK)
    # the free-floating emitter disc
    dr = r * F.EMIT_DISC
    disc = ngon_ring((cx, y_lip - F.EMIT_GAP, cz), dr, n=n, axis='y')
    zl = Zone(F.A_LENS, ('x', 'z'), ((cx - dr, cx + dr), (cz - dr, cz + dr)))
    poly_out(p, disc, (0, -1, 0), zl)


def core_well(p):
    """Circular core well on the dorsal deck, capped by a floating lens."""
    n, cz = F.CORE_N, F.CORE_Z
    skirt = F.CORE_FLOOR - 0.04
    ro_t = ngon_ring((0, F.CORE_TOP, cz), F.CORE_R, n=n, axis='y')
    ro_b = ngon_ring((0, skirt, cz), F.CORE_R, n=n, axis='y')
    band(p, ro_t, ro_b, F.A_EMIT, radial_y(0, cz))
    ri_t = ngon_ring((0, F.CORE_TOP, cz), F.CORE_RI, n=n, axis='y')
    annulus(p, ro_t, ri_t, (0, 1, 0), F.A_CORE)
    ri_f = ngon_ring((0, F.CORE_FLOOR, cz), F.CORE_RI, n=n, axis='y')
    band(p, ri_t, ri_f, F.A_EMIT,
         lambda c: (-(c[0] - 0.0), 0.0, -(c[2] - cz)))
    poly_out(p, ri_f, (0, 1, 0), F.A_DARK)
    lens = ngon_ring((0, F.CORE_LENS_Y, cz), F.CORE_LENS_R, n=n, axis='y')
    poly_out(p, lens, (0, 1, 0), F.A_CORE_L)
    poly_out(p, lens, (0, -1, 0), F.A_DARK)


def halo_ring(p):
    """Detached ring hovering around the dish pylon — nothing touches it."""
    n, cz, y = F.HALO_N, F.PYLON_Z, F.HALO_Y
    h = F.HALO_TH / 2
    ot = ngon_ring((0, y + h, cz), F.HALO_RO, n=n, axis='y')
    ob = ngon_ring((0, y - h, cz), F.HALO_RO, n=n, axis='y')
    it = ngon_ring((0, y + h, cz), F.HALO_RI, n=n, axis='y')
    ib = ngon_ring((0, y - h, cz), F.HALO_RI, n=n, axis='y')
    band(p, ot, ob, F.A_HALO, radial_y(0, cz))
    band(p, it, ib, F.A_HALO, lambda c: (-c[0], 0.0, -(c[2] - cz)))
    annulus(p, ot, it, (0, 1, 0), F.A_HALO_F)
    annulus(p, ob, ib, (0, -1, 0), F.A_HALO_F)


def prow_vane(p, s):
    """A flat cantilevered blade swept forward off the prow flank. Grand,
    confident planform — the wedge reads as a delta from above."""
    top = [(s * x, yt, z) for (x, z, yt, yb) in F.VANE]
    bot = [(s * x, yb, z) for (x, z, yt, yb) in F.VANE]
    poly_out(p, top, (0, 1, 0), F.A_TOP)
    poly_out(p, bot, (0, -1, 0), F.A_BELLY)
    ctr = np.mean(np.array(top + bot, dtype=float), axis=0)
    for i in range(4):
        k = (i + 1) % 4
        quad = [top[i], top[k], bot[k], bot[i]]
        mid = np.mean(np.array([top[i], top[k]], dtype=float), axis=0)
        out = (mid[0] - ctr[0], 0.0, mid[2] - ctr[2])
        quad_out(p, quad, out, F.A_SIDE)


def build_body():
    p = Part('body')
    rings = [hull_ring(s) for s in F.HULL_SECTIONS]
    loft(p, rings, hull_zone, cap_start=F.A_FRONT, cap_end=F.A_REAR)

    # belly keel — the cyan under-line runs along its underside
    x, y, z = F.KEEL_C
    chamfer_box(p, (x, y, z), F.KEEL_SIZE, 0.03,
                {'-y': F.A_SPINE, '+x': F.A_TRIMZ, '-x': F.A_TRIMZ,
                 '+z': F.A_TRIMZ, '-z': F.A_TRIMZ}, skip=('+y',))

    for s in (1, -1):
        prow_vane(p, s)

    for (cx, cz, r, yt, yl) in F.EMITTERS:
        emitter_plate(p, cx, cz, r, yt, yl)

    core_well(p)

    # team chips, one per shoulder (CAPTURABLE marker)
    cx, cy, cz = F.CHIP_C
    for s in (1, -1):
        chamfer_box(p, (s * cx, cy, cz), F.CHIP_SIZE, 0.02,
                    {'+x': F.A_CHIP, '-x': F.A_CHIP, '+y': F.A_TRIMZ,
                     '-y': F.A_TRIMZ, '+z': F.A_TRIMZ, '-z': F.A_TRIMZ})

    # dish pylon + the detached halo that floats around it
    limb(p, (0, F.PYLON_BASE, F.PYLON_Z), (0, F.PYLON_TOP, F.PYLON_Z),
         F.PYLON_R[0], F.PYLON_R[1], F.A_TRIM, n=6, cap_end=F.A_DARK)
    halo_ring(p)
    return p


# ── folded manipulator arm ──────────────────────────────────────────────

def build_arm(name):
    p = Part(name)
    xi, xo, r = F.ARM_HUB
    ra = ngon_ring((xi, 0, 0), r, n=F.ARM_HUB_N, axis='x')
    rb = ngon_ring((xo, 0, 0), r, n=F.ARM_HUB_N, axis='x')
    band(p, ra, rb, F.A_TRIM, radial_x(0.0, 0.0))
    poly_out(p, rb, (1, 0, 0), F.A_ARM_C)

    a, b, r0, r1 = F.ARM_UPPER
    limb(p, a, b, r0, r1, F.A_ARM, n=6, cap_start=F.A_TRIMZ)
    a, b, r0, r1 = F.ARM_FORE
    limb(p, a, b, r0, r1, F.A_ARM, n=6, cap_start=F.A_TRIMZ)

    chamfer_box(p, F.ARM_TOOL_C, F.ARM_TOOL_S, 0.03,
                {'+x': F.A_TOOL, '-x': F.A_TOOL, '+y': F.A_TOOL,
                 '-y': F.A_TOOL, '+z': F.A_TOOL, '-z': F.A_TOOL})
    # free-floating cyan tool lens ahead of the head
    tip = ngon_ring(F.ARM_TIP, F.ARM_TIP_R, n=8, axis='z')
    poly_out(p, tip, (0, 0, -1), F.A_GLOW)
    poly_out(p, tip, (0, 0, 1), F.A_DARK)
    return p


# ── `dish`: the free-floating ring gyro ─────────────────────────────────

def build_dish():
    p = Part('dish')
    t = np.radians(F.DISH_TILT)
    nrm = np.array([0.0, np.sin(t), -np.cos(t)])
    ux = np.array([1.0, 0.0, 0.0])
    vy = np.cross(nrm, ux)
    ang = np.linspace(0, 2 * np.pi, F.DISH_N, endpoint=False) + np.pi / F.DISH_N

    def ring(R, off):
        return [tuple(nrm * off + R * (np.cos(a) * ux + np.sin(a) * vy))
                for a in ang]

    h = F.DISH_TH / 2
    ro_f, ro_b = ring(F.DISH_RO, h), ring(F.DISH_RO, -h)
    ri_f, ri_b = ring(F.DISH_RI, h), ring(F.DISH_RI, -h)
    zf = Zone(F.A_DISH_F, ('x', 'y'),
              ((-F.DISH_UWIN, F.DISH_UWIN), (F.DISH_VWIN, -F.DISH_VWIN)))
    zb = Zone(F.A_DISH_B, ('x', 'y'),
              ((F.DISH_UWIN, -F.DISH_UWIN), (F.DISH_VWIN, -F.DISH_VWIN)))
    annulus(p, ro_f, ri_f, tuple(nrm), zf)
    annulus(p, ro_b, ri_b, tuple(-nrm), zb)

    def rad(c):
        c = np.asarray(c, dtype=float)
        return tuple(c - nrm * float(np.dot(c, nrm)))

    band(p, ro_f, ro_b, F.A_DISH_R, rad)
    band(p, ri_f, ri_b, F.A_DISH_R,
         lambda c: tuple(-np.asarray(rad(c), dtype=float)))

    # the core lens floats unattached at the ring's centre
    lr = F.DISH_LENS_R
    lens = [tuple(lr * (np.cos(a) * ux + np.sin(a) * vy))
            for a in np.linspace(0, 2 * np.pi, 12, endpoint=False)]
    lw = lr * 1.15
    zl = Zone(F.A_LENS_D, ('x', 'y'),
              ((-lw, lw), (lw * np.cos(t), -lw * np.cos(t))))
    poly_out(p, lens, tuple(nrm), zl)
    poly_out(p, lens, tuple(-nrm), F.A_DARK)

    # slender stem passing up through the ring's hole (never touching it)
    a, b, r0, r1 = F.DISH_STEM
    limb(p, a, b, r0, r1, F.A_TRIM, n=6, cap_end=F.A_DARK)
    return p


# ── clips ───────────────────────────────────────────────────────────────

def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    """idle — the ring gyro turns forever (90° steps keep every slerp on the
    short arc) while the whole chassis breathes on its hover field. Body
    translation keys are ABSOLUTE node translations; first == last, so both
    channels loop seamlessly."""
    T = F.IDLE_T
    spin = [(T * i / 4, qy(90 * i)) for i in range(5)]
    bob = [(0.0, (0.0, 0.0, 0.0)),
           (T * 0.25, (0.0, F.BOB_UP, 0.0)),
           (T * 0.50, (0.0, 0.0, 0.0)),
           (T * 0.75, (0.0, F.BOB_DOWN, 0.0)),
           (T, (0.0, 0.0, 0.0))]
    return [{'name': 'idle',
             'channels': [('dish', 'rotation', spin),
                          ('body', 'translation', bob)]}]


def build_all():
    arm_l = build_arm('arm_l')
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='dish', parent=0, offset=F.DISH_OFF, part=build_dish()),
        dict(name='arm_l', parent=0, offset=F.ARM_OFF, part=arm_l),
        dict(name='arm_r', parent=0,
             offset=(-F.ARM_OFF[0], F.ARM_OFF[1], F.ARM_OFF[2]),
             part=mirror_x(arm_l, 'arm_r')),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=build_clips(),
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=build_clips(),
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
