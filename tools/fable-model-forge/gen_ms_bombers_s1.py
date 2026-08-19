"""gen_ms_bombers_s1 — build ms_bombers_s1 (s1 strike drone).

UNMANNED V-TAIL strike drone: wide flattened flat-bottomed chined
fuselage, NO canopy (a faceted hexagonal sensor blister pair — dorsal +
chin — and a short comms blade stand in for it), straight-taper
mid-mounted wing with ~20 deg LE sweep and squared tips, two
ruddervators in a shallow ~40 deg V on short aft booms (no fin, no
tailplane), a bulged closed belly weapons bay with the slot-1 `muzzle`
release empty at its centre, one flush dorsal spine intake feeding ONE
shielded nozzle over the booms, short wide-track fixed gear as separate
hideable pieces.

Pieces: body, gear_n, gear_l, gear_r, muzzle, exhaust.  No clips —
a fixedwing has nothing that visibly rotates.

Usage: $FORGE/venv/bin/python gen_ms_bombers_s1.py
"""
from __future__ import annotations
import numpy as np

import ms_bombers_s1_layout as F        # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, loft, chamfer_box, tube, ngon_ring, limb
from gltf_export import export

STEM = 'ms_bombers_s1'
OUT = 'out'


def quad_out(p, verts, outward, zone):
    """Add a polygon wound so its normal points along `outward`."""
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, outward) > 0 else verts[::-1], zone=zone)


def box(p, center, size, zones, ch=0.02, skip=()):
    if not isinstance(zones, dict):
        zones = {k: zones for k in ('+y', '-y', '+x', '-x', '+z', '-z')}
    chamfer_box(p, center, size, ch, zones, skip=skip)


def fus_ring(z, w, wt, yt, yb, yc):
    """6-point chined section — wb 0.72·w keeps the underside BROAD and FLAT
    (bomber grammar), unlike the fighter's 0.52 keel."""
    wb = w * 0.72
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
    """Station-based lifting surface (lifted from gen_ms_fighters_s3).
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

    # ── wide flattened chined fuselage ──
    loft(p, [fus_ring(*s) for s in F.FUS_SECTIONS], fus_zone,
         cap_start=F.F_TRIM, cap_end=F.F_TRIM)

    # ── flush dorsal intake scoop (one, on the spine — no flank ducts) ──
    loft(p, [box_ring(*s) for s in F.INTAKE_SECTIONS], fus_zone,
         cap_start=F.F_DARK)

    # ── faceted hexagonal sensor blisters — this drone has NO canopy ──
    loft(p, [box_ring(*s) for s in F.BLISTER_D], lambda c, n: F.F_BLIST)
    loft(p, [box_ring(*s) for s in F.BLISTER_C], lambda c, n: F.F_BLIST)

    # ── short comms blade antenna (two-sided thin plate) ──
    bz0, bz1, by0, by1, sweep = F.BLADE
    blade = [(0.0, by0, bz0), (0.0, by1, bz0 + sweep),
             (0.0, by1, bz1), (0.0, by0, bz1)]
    quad_out(p, blade, (1, 0, 0), F.F_TRIM)
    quad_out(p, list(blade), (-1, 0, 0), F.F_TRIM)

    # ── bulged belly weapons bay (closed; doors are painted) ──
    bx, by, bz, bw, bh, bd = F.BAY
    box(p, (bx, by, bz), (bw, bh, bd),
        {'+y': F.F_BAY, '-y': F.F_BAY, '+x': F.F_SIDE, '-x': F.F_SIDE,
         '+z': F.F_TRIM, '-z': F.F_TRIM}, ch=0.05, skip=('+y',))

    for s in (1, -1):
        # straight-taper mid wing (root buried inside the chine)
        blade_flat(p, F.WING, s, 'y', F.F_TOP, F.F_BOT, F.F_TRIM)

        # short aft tail boom — its nose is buried in the wing skin
        brings = []
        for (z, xi, xo, yb, yt) in F.BOOM_SECTIONS:
            r = [(s * xo, yb, z), (s * xo, yt, z), (s * xi, yt, z),
                 (s * xi, yb, z)]
            brings.append(r if s > 0 else r[::-1])
        loft(p, brings, fus_zone, cap_start=F.F_DARK, cap_end=F.F_TRIM)

        # ── THE SIGNATURE: V-tail ruddervator, ~40 deg dihedral ──
        blade_flat(p, F.VTAIL, s, 'y', F.F_TOP, F.F_BOT, F.F_TRIM)

    # ── ONE shielded nozzle over/between the booms (aft cap glows) ──
    tube(p, F.NOZZLE, F.F_NOZZLE, n=8, cap_start=F.F_BURNER)
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


def build_gear(name, drop, r, hw):
    """Short fixed drone leg, piece-local (origin at the hull attach point)."""
    p = Part(name)
    limb(p, (0, 0, 0), (0, -drop, -0.04), 0.055, 0.042, F.F_GEAR.rect, n=4)
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
             part=build_gear('gear_l', mdrop, mr, mhw)),
        dict(name='gear_r', parent=0, offset=(-mx, my, mz),
             part=build_gear('gear_r', mdrop, mr, mhw)),
        # ONE armed slot (MS_BOMB_S1) → ONE fixed muzzle at the bay centre.
        # No turret/barrel chain: getAimPieces returning null is the PASS.
        dict(name='muzzle', parent=0, offset=F.MUZZLE_OFF, part=None),
        dict(name='exhaust', parent=0, offset=F.EXHAUST_OFF, part=None),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_{STEM}] total: {total} tris')
