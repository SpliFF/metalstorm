"""gen_ms_bombers_s4 — build ms_bombers_s4 (s4 strategic bomber).

A PURE TAILLESS FLYING WING: 22.00 m span over 13.2 m length, no fins and
no tail whatsoever, no distinct fuselage — one wide flat lifting surface
thickening to a blended centre section.  Straight 35 deg swept leading
edges to a pointed apex, sawtooth / W trailing edge, over-wing intake
ramps feeding buried engines that exhaust through shielded slot nozzles
in the upper aft surface, two closed weapons bays in the centrebody
underside, a low faired 3-bow side-by-side canopy blended into the apex,
heavy multi-wheel gear, and a LOW traversing dorsal flak ring
(turret3 -> turret3_barrel -> turret3_muzzle) for weapon slot 3.

Usage: $FORGE/venv/bin/python gen_ms_bombers_s4.py
"""
from __future__ import annotations
import numpy as np

import ms_bombers_s4_layout as F        # sets meshlib.ATLAS = 2048
from meshlib import Part, loft, chamfer_box, tube, ngon_ring, limb
from gltf_export import export

STEM = 'ms_bombers_s4'
OUT = 'out'


# ── helpers ─────────────────────────────────────────────────────────────
def quad_out(p, verts, outward, zone):
    """Add a polygon wound so its normal points along `outward`."""
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, outward) > 0 else verts[::-1], zone=zone)


def box(p, center, size, zones, ch=0.04, skip=()):
    if not isinstance(zones, dict):
        zones = {k: zones for k in ('+x', '-x', '+y', '-y', '+z', '-z')}
    chamfer_box(p, center, size, ch, zones, skip=skip)


def fus_zone(c, n):
    """World-anchored planform band pick for the wing skin."""
    if n[1] > 0.55:
        return F.F_TOP
    if n[1] < -0.55:
        return F.F_BOT
    return F.F_SIDE


# ── the wing (there is nothing else — the centrebody IS the wing) ───────
def subdivide(stations):
    """Insert the midpoint of every interval.  The TE sawtooth breaks all
    sit ON listed stations, so midpoint interpolation never crosses a break
    and every straight planform segment stays exactly straight.  Smaller
    quads also stop the impostor baker's flat shading flooding whole panels."""
    out = []
    for i, st in enumerate(stations[:-1]):
        nx = stations[i + 1]
        out.append(st)
        out.append(tuple((a + b) / 2.0 for a, b in zip(st, nx)))
    out.append(stations[-1])
    return out


WING_FINE = subdivide(F.WING)


def wing_ring(st, s):
    """9-point chordwise section at one spanwise station, mirrored by s."""
    x, zle, zte, yc, th = st
    c = zte - zle
    r = [(s * x, yc + tf * th, zle + cf * c) for (cf, tf) in F.SECTION]
    return r if s > 0 else r[::-1]


def slab_rings(sections, s):
    """4-point (x_in..x_out) rings for a surface fairing: intake ramps and
    shielded nozzle shelves.  Ring order gives outward normals for s=+1
    with z increasing; reversed for the mirrored side."""
    rings = []
    for (z, xi, xo, yb, yt) in sections:
        r = [(s * xo, yb, z), (s * xo, yt, z), (s * xi, yt, z), (s * xi, yb, z)]
        rings.append(r if s > 0 else r[::-1])
    return rings


def build_body():
    p = Part('body')

    # ── the flying wing itself: one loft per half, meeting at x=0 ──
    for s in (1, -1):
        rings = [wing_ring(st, s) for st in WING_FINE]
        loft(p, rings, fus_zone, cap_end=F.F_SIDE)

    # ── low, wide 3-bow canopy blended into the leading-edge apex ──
    def arch(z, w, yb, yt):
        return [(w, yb, z), (w * 0.55, yt, z), (0.0, yt + 0.06, z),
                (-w * 0.55, yt, z), (-w, yb, z)]
    loft(p, [arch(*s) for s in F.CAN_SECTIONS],
         lambda c, n: F.F_CANOPY, cap_end=F.F_TRIM)

    for s in (1, -1):
        # ── over-wing intake ramp (mouth faces -Z, fairs in aft) ──
        irings = slab_rings(F.INTAKE_SECTIONS, s)
        loft(p, irings, fus_zone)
        quad_out(p, list(irings[0]), (0, 0, -1), F.F_INTK)
        quad_out(p, list(irings[-1]), (0, 0, 1), F.F_TRIM)

        # ── shielded slot nozzle shelf (exit = aft cap) ──
        nrings = slab_rings(F.NOZZLE_SECTIONS, s)
        loft(p, nrings, fus_zone)
        quad_out(p, list(nrings[0]), (0, 0, -1), F.F_TRIM)
        quad_out(p, list(nrings[-1]), (0, 0, 1), F.F_SLOT)

        # ── wingtip nav pod ──
        nx, ny, nz = F.NAV_TIP
        box(p, (s * nx, ny, nz), (0.14, 0.12, 0.44),
            F.F_NAVP if s > 0 else F.F_NAVS, ch=0.02)

        # ── belly chaff/flare dispenser ──
        cx, cy, cz = F.CHAFF
        box(p, (s * cx, cy, cz), (0.72, 0.16, 0.62),
            {'-y': F.F_BOT, '+x': F.F_TRIM, '-x': F.F_TRIM,
             '+z': F.F_TRIM, '-z': F.F_TRIM}, ch=0.03, skip=('+y',))

    # ── two weapons bays (closed boxes with painted doors) ──
    for (c, sz) in (F.BAY_FWD, F.BAY_AFT):
        box(p, c, sz, {'-y': F.F_BOT, '+x': F.F_BAYSD, '-x': F.F_BAYSD,
                       '+z': F.F_BAYSD, '-z': F.F_BAYSD}, ch=0.06,
            skip=('+y',))

    # ── chin targeting blister (buried into the forebody underside) ──
    sx, sy, sz = F.SENSOR
    limb(p, (sx, sy, sz), (sx, sy - 0.30, sz), 0.24, 0.17, F.F_TRIM.rect, n=6,
         cap_end=F.F_DARK)

    # ── dorsal blade antennae ──
    for (ax, ay, az) in F.ANTENNAS:
        vs = [(ax, ay, az), (ax, ay + 0.26, az + 0.12),
              (ax, ay + 0.26, az + 0.34), (ax, ay, az + 0.42)]
        quad_out(p, vs, (1, 0, 0), F.F_TRIM)
        quad_out(p, list(vs), (-1, 0, 0), F.F_TRIM)
    return p


# ── dorsal flak ring (slot 3 aim chain, section 16c) ────────────────────
def T_of(c, n):
    return F.T_TOP if abs(n[1]) > 0.55 else F.T_SIDE


def build_turret3():
    """Low yawing barbette.  Rotates about Y; authored at rest, level."""
    p = Part('turret3')
    rb, rt, h = F.TUR3_RING
    r0 = ngon_ring((0, 0.0, 0), rb, n=12, axis='y')
    r1 = ngon_ring((0, h, 0), rt, n=12, axis='y')
    loft(p, [r0, r1], T_of, cap_end=F.T_TOP, flip_side=True)
    x, y0, y1, z0, z1 = F.TUR3_CHEEK
    for s in (1, -1):
        box(p, (s * x, (y0 + y1) / 2, (z0 + z1) / 2),
            (0.18, y1 - y0, z1 - z0),
            {'+y': F.T_TOP, '-y': F.T_TOP, '+x': F.T_SIDE, '-x': F.T_SIDE,
             '+z': F.T_TRIM, '-z': F.T_TRIM}, ch=0.03)
    return p


def build_turret3_barrel():
    """Pitching twin flak gun, at rest pointing forward (-Z) and level."""
    p = Part('turret3_barrel')
    c, sz = F.BARREL_BOX
    box(p, c, sz, {'+y': F.T_TOP, '-y': F.T_TOP, '+x': F.T_SIDE,
                   '-x': F.T_SIDE, '+z': F.T_TRIM, '-z': F.T_TRIM}, ch=0.05)
    (dx, dy, dz), dsz = F.DRUM
    for s in (1, -1):
        box(p, (s * dx, dy, dz), dsz,
            {'+y': F.T_TOP, '-y': F.T_TOP, '+x': F.T_SIDE, '-x': F.T_SIDE,
             '+z': F.T_TRIM, '-z': F.T_TRIM}, ch=0.04)
        tube(p, F.FLAK_TUBE, F.T_BARREL, n=6, xoff=s * F.FLAK_X,
             cap_end=F.T_DARK)
        # muzzle brake collar
        box(p, (s * F.FLAK_X, 0.0, -1.44), (0.20, 0.20, 0.22), F.T_TRIM,
            ch=0.03)
    return p


# ── landing gear (piece-local; origin at the airframe attach point) ─────
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


def build_gear(name, drop, r, hw, s=1, twin_x=0.0, tandem_z=0.0):
    p = Part(name)
    limb(p, (0, 0, 0), (0, -drop, -0.08), 0.13, 0.10, F.F_GEAR.rect, n=6)
    limb(p, (0, -drop * 0.50, -0.05), (s * 0.22, -drop * 0.92, 0.32),
         0.06, 0.045, F.F_GEAR.rect, n=4)                    # drag brace
    limb(p, (0, -drop * 0.62, -0.03), (0, -drop * 0.98, -0.40),
         0.05, 0.04, F.F_GEAR.rect, n=4)                     # forward strut
    box(p, (0, -drop, tandem_z if tandem_z else 0.0),
        (max(0.5, twin_x * 2 + 0.3), 0.13, 0.16 + 2 * abs(tandem_z)),
        F.F_GEAR, ch=0.03)
    if tandem_z:
        wheel(p, (0, -drop, -tandem_z), r, hw)
        wheel(p, (0, -drop, tandem_z), r, hw)
    else:
        wheel(p, (-twin_x, -drop, 0.0), r, hw)
        wheel(p, (twin_x, -drop, 0.0), r, hw)
    dz = 0.34 + abs(tandem_z)
    vs = [(s * 0.26, 0.02, -dz), (s * 0.26, 0.02, dz),
          (s * 0.26, -drop * 0.78, dz), (s * 0.26, -drop * 0.78, -dz)]
    quad_out(p, vs, (s, 0, 0), F.F_TRIM)
    quad_out(p, list(vs), (-s, 0, 0), F.F_TRIM)
    return p


# ── assembly ────────────────────────────────────────────────────────────
def build_all():
    (nx, ny, nz), ndrop, nr, nhw = F.GEAR_N
    (mx, my, mz), mdrop, mr, mhw = F.GEAR_M
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='gear_n', parent=0, offset=(nx, ny, nz),
             part=build_gear('gear_n', ndrop, nr, nhw, s=1, twin_x=0.22)),
        dict(name='gear_l', parent=0, offset=(mx, my, mz),
             part=build_gear('gear_l', mdrop, mr, mhw, s=1, tandem_z=0.60)),
        dict(name='gear_r', parent=0, offset=(-mx, my, mz),
             part=build_gear('gear_r', mdrop, mr, mhw, s=-1, tandem_z=0.60)),
        dict(name='muzzle', parent=0, offset=F.MUZZLE_OFF, part=None),
        dict(name='muzzle2', parent=0, offset=F.MUZZLE2_OFF, part=None),
        dict(name='turret3', parent=0, offset=F.TUR3_OFF,
             part=build_turret3()),
        dict(name='turret3_barrel', parent=6, offset=F.BARREL_OFF,
             part=build_turret3_barrel()),
        dict(name='turret3_muzzle', parent=7, offset=F.MUZZLE3_OFF,
             part=None),
        dict(name='exhaust', parent=0, offset=F.EXHAUST_OFF, part=None),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    for pc in pieces:
        if pc['part'] is not None:
            b = pc['part'].bounds()
            print(f"  {pc['name']:16s} {pc['part'].tri_count():5d} "
                  f"bounds {tuple(round(v, 2) for v in b[0])} "
                  f"{tuple(round(v, 2) for v in b[1])}")
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_{STEM}] TOTAL {total} tris')
