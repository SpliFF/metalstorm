"""gen_ms_fighters_s4 — build ms_fighters_s4 (s4 air-dominance gunship).

Blended-wing-body heavy gunship: broad cranked-arrow planform, full-length
dorsal weapons spine, tandem two-seat canopy, chin autocannon trough,
four buried engines across a broad tail deck, twin canted fins on the wing
cranks, heavy landing gear, and a REAL traversing dorsal AA missile mount
(turret2 -> turret2_barrel -> turret2_muzzle) for weapon slot 2.

Usage: $FORGE/venv/bin/python gen_ms_fighters_s4.py
"""
from __future__ import annotations
import numpy as np

import ms_fighters_s4_layout as F        # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, loft, chamfer_box, tube, ngon_ring, limb
from gltf_export import export

STEM = 'ms_fighters_s4'
OUT = 'out'
RNG = np.random.default_rng(90210)


def quad_out(p, verts, outward, zone):
    """Add a polygon wound so its normal points along `outward`."""
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, outward) > 0 else verts[::-1], zone=zone)


def box(p, center, size, zones, ch=0.04, skip=()):
    if not isinstance(zones, dict):
        zones = {k: zones for k in ('+x', '-x', '+y', '-y', '+z', '-z')}
    chamfer_box(p, center, size, ch, zones, skip=skip)


# ── body-band zone chooser (world-anchored) ─────────────────────────────

def fus_zone(c, n):
    if n[1] > 0.55:
        return F.F_TOP
    if n[1] < -0.55:
        return F.F_BOT
    return F.F_SIDE


def fus_ring(z, w, wt, yt, yb, yc):
    """Chined hexagonal station: chine corners, flat top, flat bottom."""
    wb = w * 0.52
    return [(w, yc, z), (wt, yt, z), (-wt, yt, z), (-w, yc, z),
            (-wb, yb, z), (wb, yb, z)]


def spine_ring(z, hw, yt, yb):
    return [(hw, yb, z), (hw, yt, z), (-hw, yt, z), (-hw, yb, z)]


def can_ring(z, w, yb, yt):
    return [(w, yb, z), (w * 0.55, yt, z), (0.0, yt + 0.06, z),
            (-w * 0.55, yt, z), (-w, yb, z)]


# ── lifting surfaces ────────────────────────────────────────────────────

def blade_flat(p, stations, s, taxis, top_zone, bot_zone, edge_zone):
    """Station-based flat blade (span_x, y, z_le, z_te, thickness).
    thickness axis 'y' for horizontal surfaces, 'x' for canted fins."""
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


def missile(p, stations, x, rect, cap):
    """Rail missile: n-gon body + 4 tail fins."""
    tube(p, stations, rect, n=6, xoff=x, cap_start=cap, cap_end=cap)
    y = stations[0][2]
    z_tail, z_nose = stations[0][0], stations[-1][0]
    for (dx, dy) in ((0.22, 0), (-0.22, 0), (0, 0.22), (0, -0.22)):
        fz0, fz1 = z_tail - 0.34, z_tail - 0.02
        quad = [(x, y, fz0), (x, y, fz1),
                (x + dx, y + dy, fz1), (x + dx, y + dy, fz0 + 0.18)]
        quad_out(p, quad, (-dy, dx, 0), cap)
        quad_out(p, list(quad), (dy, -dx, 0), cap)


# ── body ────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')

    # BWB centre body
    loft(p, [fus_ring(*s) for s in F.FUS_SECTIONS], fus_zone,
         cap_start=F.F_TRIM, cap_end=F.F_TAIL)
    # dorsal weapons/avionics spine
    loft(p, [spine_ring(*s) for s in F.SPINE_SECTIONS], fus_zone,
         cap_end=F.F_TAIL)
    # tandem two-seat canopy (two glazed bows in line)
    loft(p, [can_ring(*s) for s in F.CAN_SECTIONS],
         lambda c, n: F.F_CANOPY, cap_end=F.F_TRIM)

    for s in (1, -1):
        blade_flat(p, F.WING, s, 'y', F.F_TOP, F.F_BOT, F.F_TRIM)
        blade_flat(p, F.FIN, s, 'x', F.F_FIN, F.F_FIN, F.F_TRIM)

        # two shoulder intake mouths per side
        for (cx, cy, cz, sx, sy, sz) in F.INTAKES:
            box(p, (s * cx, cy, cz), (sx, sy, sz),
                {'+y': F.F_TOP, '-y': F.F_BOT, '+x': F.F_SIDE,
                 '-x': F.F_SIDE, '-z': F.F_DARK, '+z': F.F_INTK}, ch=0.06)

        # belly gear sponson
        (gx, gy, gz), (sx, sy, sz) = F.SPONSON
        box(p, (s * gx, gy, gz), (sx, sy, sz),
            {'-y': F.F_BOT, '+x': F.F_SIDE, '-x': F.F_SIDE,
             '-z': F.F_TRIM, '+z': F.F_TRIM}, ch=0.08, skip=('+y',))

        # wingtip nav box
        nx, ny, nz = F.NAV_TIP
        box(p, (s * nx, ny, nz), (0.16, 0.12, 0.40),
            F.F_NAVP if s > 0 else F.F_NAVS, ch=0.02)

        # nozzles (stations run zmax -> zmin so cap_start faces aft)
        for nxo in F.NOZZLE_XS:
            tube(p, F.NOZZLE, F.F_NOZZLE, n=8, xoff=s * nxo,
                 cap_start=F.F_BURNER)

    # broad aft engine deck carrying the four nozzles
    c, sz = F.TAIL_DECK
    box(p, c, sz, {'+y': F.F_TOP, '-y': F.F_BOT, '+x': F.F_SIDE,
                   '-x': F.F_SIDE, '+z': F.F_TAIL, '-z': F.F_TRIM}, ch=0.08)

    # chin autocannon trough + protruding tube
    c, sz = F.GUN_TROUGH
    box(p, c, sz, {'-y': F.F_BOT, '+x': F.F_SIDE, '-x': F.F_SIDE,
                   '-z': F.F_TRIM, '+z': F.F_TRIM}, ch=0.06, skip=('+y',))
    tube(p, F.GUN_TUBE, F.F_TRIM.rect, n=6, cap_end=F.F_DARK)

    # chaff/flare dispenser + pitot + blade antennae
    box(p, F.CHAFF, (1.30, 0.16, 0.60), F.F_TRIM, ch=0.03)
    px, py_, pz = F.PITOT
    limb(p, (px, py_, pz), (px, py_ + 0.04, pz - 0.62), 0.035, 0.015,
         F.F_TRIM.rect, n=4)
    for (ax, ay, az) in F.ANTENNAS:
        vs = [(ax, ay, az), (ax, ay + 0.30, az + 0.14),
              (ax, ay + 0.30, az + 0.38), (ax, ay, az + 0.46)]
        quad_out(p, vs, (1, 0, 0), F.F_TRIM)
        quad_out(p, list(vs), (-1, 0, 0), F.F_TRIM)
    return p


# ── dorsal AA missile mount (slot 2 aim chain) ──────────────────────────

def build_turret2():
    """Ring mount rotating about Y; authored at rest, forward/level."""
    p = Part('turret2')
    rb, rt, h = F.TUR2_RING
    r0 = ngon_ring((0, 0.0, 0), rb, n=8, axis='y')
    r1 = ngon_ring((0, h, 0), rt, n=8, axis='y')
    loft(p, [r0, r1], lambda c, n: T_of(n), cap_end=F.T_TOP)
    x, y0, y1, z0, z1 = F.TUR2_CHEEK
    for s in (1, -1):
        box(p, (s * x, (y0 + y1) / 2, (z0 + z1) / 2),
            (0.16, y1 - y0, z1 - z0),
            {'+y': F.T_TOP, '-y': F.T_TOP, '+x': F.T_SIDE, '-x': F.T_SIDE,
             '+z': F.T_TRIM, '-z': F.T_TRIM}, ch=0.03)
    return p


def T_of(n):
    return F.T_TOP if abs(n[1]) > 0.55 else F.T_SIDE


def build_turret2_barrel():
    """Elevating twin missile-rail box, at rest pointing forward (-Z)."""
    p = Part('turret2_barrel')
    c, sz = F.BARREL_BOX
    box(p, c, sz, {'+y': F.T_TOP, '-y': F.T_TOP, '+x': F.T_SIDE,
                   '-x': F.T_SIDE, '+z': F.T_TRIM, '-z': F.T_TRIM}, ch=0.05)
    for s in (1, -1):
        missile(p, F.RAIL_MSL, s * F.RAIL_X, F.T_RAIL, F.T_DARK)
        # rail beam under each round
        box(p, (s * F.RAIL_X, 0.28, -0.62), (0.10, 0.08, 2.10),
            F.T_TRIM, ch=0.02)
    return p


# ── landing gear ────────────────────────────────────────────────────────

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
    """Heavy gear leg, piece-local (origin at the airframe attach point)."""
    p = Part(name)
    limb(p, (0, 0, 0), (0, -drop, -0.08), 0.13, 0.10, F.F_GEAR.rect, n=6)
    limb(p, (0, -drop * 0.50, -0.05), (s * 0.22, -drop * 0.92, 0.34),
         0.06, 0.045, F.F_GEAR.rect, n=4)                    # drag brace
    limb(p, (0, -drop * 0.62, -0.03), (0, -drop * 0.98, -0.42),
         0.05, 0.04, F.F_GEAR.rect, n=4)                     # forward strut
    # axle beam
    box(p, (0, -drop, tandem_z if tandem_z else 0.0),
        (max(0.5, twin_x * 2 + 0.3), 0.13, 0.16 + 2 * abs(tandem_z)),
        F.F_GEAR, ch=0.03)
    if tandem_z:
        wheel(p, (0, -drop, -tandem_z), r, hw)
        wheel(p, (0, -drop, tandem_z), r, hw)
    else:
        wheel(p, (-twin_x, -drop, 0.0), r, hw)
        wheel(p, (twin_x, -drop, 0.0), r, hw)
    # gear door plate beside the strut
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
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='gear_n', parent=0, offset=(nx, ny, nz),
             part=build_gear('gear_n', ndrop, nr, nhw, s=1, twin_x=0.24)),
        dict(name='gear_l', parent=0, offset=(mx, my, mz),
             part=build_gear('gear_l', mdrop, mr, mhw, s=1, tandem_z=0.58)),
        dict(name='gear_r', parent=0, offset=(-mx, my, mz),
             part=build_gear('gear_r', mdrop, mr, mhw, s=-1, tandem_z=0.58)),
        dict(name='muzzle', parent=0, offset=F.GUN_MUZZLE, part=None),
        dict(name='turret2', parent=0, offset=F.TUR2_OFF,
             part=build_turret2()),
        dict(name='turret2_barrel', parent=5, offset=F.BARREL_OFF,
             part=build_turret2_barrel()),
        dict(name='turret2_muzzle', parent=6, offset=F.MUZZLE2_OFF,
             part=None),
        dict(name='exhaust', parent=0, offset=F.EXHAUST_OFF, part=None),
    ]
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_{STEM}] total tris: {total}')
    for pc in pieces:
        if pc['part'] is not None:
            b = pc['part'].bounds()
            print(f"  {pc['name']:16s} {pc['part'].tri_count():5d} tris  "
                  f"bounds {tuple(round(v,2) for v in b[0])} "
                  f"{tuple(round(v,2) for v in b[1])}")
