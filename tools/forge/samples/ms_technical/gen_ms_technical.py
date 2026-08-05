"""gen_ms_technical — assemble ms_technical and export .gltf/.bin.

Anarchic technical (~4.8 m pickup): hood + cab forward, open flatbed
rear, mismatched standoff scrap plates, welded ram bar with spikes,
side exhaust stack, welded gun ring + pedestal on the bed carrying the
standard aimable chain (turret/barrel/muzzle via prefabs.turret_parts),
spinnable axle_f/axle_r, ammo crate, and a rag-pennant pole (flag).
Clips: idle (pennant sway), walk (axle spin).

Run: $PY gen_ms_technical.py → out/ms_technical{,_png}.gltf + .bin
"""
from __future__ import annotations
import numpy as np

import ms_technical_layout as L         # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, chamfer_box, ngon_ring, limb
from gltf_export import export
import parts as P

STEM = 'ms_technical'
OUT = 'out'
RNG = np.random.default_rng(90210)      # forge convention (geometry is
                                        # deterministic; kept for parity)


def quad_out(p, verts, outward, zone):
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, outward) > 0 else verts[::-1], zone=zone)


def box(p, center, size, zone, ch=0.03, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def wheelset(name):
    """Axle piece: two 8-gon wheels + connecting axle bar (piece-local)."""
    p = Part(name)
    for sx in (-L.WHEEL_X, L.WHEEL_X):
        ra = ngon_ring((sx - L.WHEEL_HW, 0, 0), L.WHEEL_R, n=8, axis='x')
        rb = ngon_ring((sx + L.WHEEL_HW, 0, 0), L.WHEEL_R, n=8, axis='x')
        for j in range(8):
            k = (j + 1) % 8
            quad = [ra[j], ra[k], rb[k], rb[j]]
            cq = np.mean(np.array(quad), axis=0)
            quad_out(p, quad, (0, cq[1], cq[2]), L.WHEEL)
        quad_out(p, list(ra), (-1, 0, 0), L.HUB)
        quad_out(p, list(rb), (1, 0, 0), L.HUB)
    box(p, (0, 0, 0), (1.90, 0.20, 0.20), L.DARK, ch=0.02)
    return p


def build_body():
    p = Part('body')

    # chassis frame
    box(p, L.CHASSIS[:3], L.CHASSIS[3:], L.DARK, ch=0.03)

    # engine hood (front)
    x, y, z, w, h, d = L.HOOD
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+y': L.HOOD_TOP, '-y': L.DARK, '+x': L.CAB_SIDE,
                 '-x': L.CAB_SIDE, '-z': L.FRONT, '+z': L.DARK})
    # scrap sheet lashed over one hood corner (mismatched panel)
    box(p, L.PLATE_HOOD[:3], L.PLATE_HOOD[3:], L.SCRAP_C, ch=0.015,
        skip=('-y',))

    # cab
    x, y, z, w, h, d = L.CAB
    chamfer_box(p, (x, y, z), (w, h, d), 0.07,
                {'+y': L.CAB_ROOF, '-y': L.DARK, '+x': L.CAB_SIDE,
                 '-x': L.CAB_SIDE, '-z': L.FRONT, '+z': L.DARK})
    # welded windscreen visor slit plate
    x, y, z, w, h, d = L.WINDSCR_PL
    chamfer_box(p, (x, y, z), (w, h, d), 0.02,
                {'+y': L.SCRAP_C, '-y': L.DARK, '+x': L.SCRAP_C,
                 '-x': L.SCRAP_C, '-z': L.SCRAP_C, '+z': L.DARK})
    # mismatched cab door plates (deliberately asymmetric L vs R)
    box(p, L.PLATE_CABL[:3], L.PLATE_CABL[3:], L.SCRAP_B, ch=0.015)
    box(p, L.PLATE_CABR[:3], L.PLATE_CABR[3:], L.SCRAP_A, ch=0.015)

    # flatbed: deck + low side walls + tailgate
    x, y, z, w, h, d = L.BED_FLR
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': L.BED_FLOOR, '-y': L.DARK, '+x': L.BED_SIDE,
                 '-x': L.BED_SIDE, '-z': L.DARK, '+z': L.REAR})
    bx, by, bz, bw, bh, bd = L.BED_WALL
    for s in (1, -1):
        chamfer_box(p, (s * bx, by, bz), (bw, bh, bd), 0.02,
                    {'+y': L.TRIM, '-y': L.DARK, '+x': L.BED_SIDE,
                     '-x': L.BED_SIDE, '-z': L.BED_SIDE, '+z': L.REAR})
    x, y, z, w, h, d = L.TAILGATE
    chamfer_box(p, (x, y, z), (w, h, d), 0.02,
                {'+y': L.TRIM, '-y': L.DARK, '+x': L.TRIM, '-x': L.TRIM,
                 '-z': L.REAR, '+z': L.REAR})
    box(p, L.BUMPER_R[:3], L.BUMPER_R[3:], L.TRIM, ch=0.03)

    # mismatched scrap plates bolted along the bed walls
    box(p, L.PLATE_BEDL[:3], L.PLATE_BEDL[3:], L.SCRAP_A, ch=0.015)
    box(p, L.PLATE_BEDL2[:3], L.PLATE_BEDL2[3:], L.SCRAP_C, ch=0.015)
    box(p, L.PLATE_BEDR[:3], L.PLATE_BEDR[3:], L.SCRAP_B, ch=0.015)
    box(p, L.PLATE_BEDR2[:3], L.PLATE_BEDR2[3:], L.SCRAP_A, ch=0.015)

    # welded ram bar: two posts, two cross-bars, four forward spikes
    y0, y1 = L.RAM_BAR_Y
    for s in (1, -1):
        limb(p, (s * L.RAM_POST_X, y0 - 0.10, L.RAM_Z + 0.10),
             (s * L.RAM_POST_X, y1 + 0.06, L.RAM_Z), 0.05, 0.05,
             L.TRIM.rect, n=4)
    for by_ in (y0, y1):
        limb(p, (-L.RAM_BAR_X, by_, L.RAM_Z), (L.RAM_BAR_X, by_, L.RAM_Z),
             0.055, 0.055, L.TRIM.rect, n=4)
    for (sx, sy) in L.SPIKES:
        limb(p, (sx, sy, L.RAM_Z), (sx, sy, L.RAM_Z - L.SPIKE_LEN),
             0.045, 0.008, L.TRIM.rect, n=3)

    # side exhaust stack (scavenged upright pipe, right flank)
    ex, ey0, ey1, ez = L.EXHAUST
    limb(p, (ex, ey0, ez), (ex, ey1, ez), 0.075, 0.065, L.POLE, n=6,
         cap_end=L.DARK)

    # gun-ring pedestal welded to the bed deck
    limb(p, L.PED_BASE, L.TUR_MOUNT, 0.11, 0.09, L.TRIM.rect, n=6)

    # ammo crate lashed in the bed corner
    P.crate(p, L.CRATE_POS, L.CRATE_SZ, zone=L.CARGO)
    return p


def build_flag():
    """Pennant pole (piece-local; foot at origin): pole + rag triangle."""
    p = Part('flag')
    limb(p, (0, 0, 0), (0, L.FLAG_H, 0), 0.024, 0.014, L.POLE, n=3)
    tip, drop, sweep = L.FLAG_H - 0.04, 0.24, 0.46
    tri = [(0.0, tip, 0.0), (0.0, tip - drop, 0.0),
           (0.0, tip - drop / 2, sweep)]
    p.add_face(tri, zone=L.PENNANT)             # both windings: cloth is
    p.add_face(tri[::-1], zone=L.PENNANT)       # visible from both sides
    return p


def build_all():
    pieces = [dict(name='body', parent=-1, offset=(0, 0, 0),
                   part=build_body())]
    # aimable chain: turret (yaw) → barrel (pitch) → muzzle (empty)
    t = P.turret_parts(body_index=0, mount=L.TUR_MOUNT, ring_r=L.RING_R,
                       barrel_len=L.BARREL_LEN, barrel_r=L.BARREL_R,
                       body_zone=L.GUN, barrel_rect=L.GUN_BARR)
    base = len(pieces)
    t[1]['parent'] = base           # barrel under turret
    t[2]['parent'] = base + 1       # muzzle under barrel
    # small welded muzzle brake near the tip (functional read)
    box(t[1]['part'], (0, 0, -L.BARREL_LEN + 0.10), (0.13, 0.13, 0.22),
        L.GUN, ch=0.02)
    pieces.extend(t)
    for (nm, az) in L.AXLES:
        pieces.append(dict(name=nm, parent=0, offset=(0, L.AXLE_Y, az),
                           part=wheelset(nm)))
    pieces.append(dict(name='flag', parent=0, offset=L.FLAG_BASE,
                       part=build_flag()))
    return pieces


def build_clips():
    def qx(deg):                    # quaternion, rotation about +X
        a = np.radians(deg) / 2
        return (float(np.sin(a)), 0.0, 0.0, float(np.cos(a)))

    def qy(deg):                    # quaternion, rotation about +Y
        a = np.radians(deg) / 2
        return (0.0, float(np.sin(a)), 0.0, float(np.cos(a)))

    # walk: one full axle revolution per 0.6 s (four quarter-turn keys;
    # end quat (0,0,0,-1) == identity rotation, so the loop is seamless)
    spin = [(0.0, qx(0)), (0.15, qx(90)), (0.30, qx(180)),
            (0.45, qx(270)), (0.60, qx(360))]
    walk = {'name': 'walk',
            'channels': [('axle_f', 'rotation', spin),
                         ('axle_r', 'rotation', spin)]}
    # idle: pennant pole sways about its own axis (rag flutter read)
    sway = [(0.0, qy(0)), (0.6, qy(14)), (1.2, qy(0)),
            (1.8, qy(-14)), (2.4, qy(0))]
    idle = {'name': 'idle', 'channels': [('flag', 'rotation', sway)]}
    return [idle, walk]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
    for i, pc in enumerate(pieces):
        print(f'  [{i}] {pc["name"]} parent={pc["parent"]} '
              f'off={pc["offset"]} tris={pc["part"].tri_count()}')
