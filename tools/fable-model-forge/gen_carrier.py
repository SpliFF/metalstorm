"""gen_carrier — build fable_carrier (FCV-8 Bastion) + idle clip.

Sci-fi fleet carrier: hull + notched flight deck lofts, starboard
island with rotating radar, twin EM catapult lanes with jet blast
deflectors, aimable PDC chain, aft-port CIWS dome, and the working
deck-edge elevator — a separate piece carrying a simplified deck-park
FA-6, translating down past the hangar mouth and back in the 16 s
idle clip.  Pad empties pad1–pad7 mark the painted parking spots for
the QueryLandingPad contract.

Usage: python3 gen_carrier.py [png]
"""
from __future__ import annotations
import numpy as np

import carrier_layout as C         # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, loft, chamfer_box, tube, ngon_ring, limb
from gltf_export import export

STEM = 'fable_carrier'
OUT = 'out'


def quad_out(p, verts, outward, zone):
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, outward) > 0 else verts[::-1], zone=zone)


def box(p, center, size, zone, ch=0.05, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def hull_ring(z, yb, yw, wb, ww, wt):
    yt = C.HULL_TOP
    return [(wt, yt, z), (-wt, yt, z), (-ww, yw, z), (-wb, yb, z),
            (wb, yb, z), (ww, yw, z)]


def deck_ring(z, wl, wr):
    return [(wl, 7.95, z), (wl * 0.94, C.DECK_Y, z), (-wr * 0.94, C.DECK_Y, z),
            (-wr, 7.95, z), (-wr * 0.92, 7.2, z), (wl * 0.92, 7.2, z)]


def deck_zone(c, n):
    if n[1] > 0.6:
        return C.C_DECK
    if n[1] < -0.6:
        return C.C_TRIM
    return C.C_HULL


def build_body():
    p = Part('body')
    # ── hull + flight deck ──
    loft(p, [hull_ring(*s) for s in C.HULL_SECTIONS],
         lambda c, n: C.C_HULL, cap_start=C.C_TRIM, cap_end=C.C_STERN)
    loft(p, [deck_ring(*s) for s in C.DECK_SECTIONS], deck_zone,
         cap_start=C.C_TRIM, cap_end=C.C_TRIM)

    # ── island (starboard) ──
    for dims in (C.ISL_BASE, C.ISL_MID, C.ISL_BRIDGE):
        x, yc, zc, w, h, d = dims
        chamfer_box(p, (x, yc, zc), (w, h, d), 0.12,
                    {'+y': C.C_ISL, '-y': C.C_ISL, '+x': C.C_ISL,
                     '-x': C.C_ISL, '+z': C.C_ISL_F, '-z': C.C_ISL_F})
    mx, my, mz = C.ISL_MAST
    limb(p, (mx, my, mz), (mx, 19.4, mz), 0.34, 0.18, C.C_TRIM.rect, n=6)
    limb(p, (mx - 1.2, 16.1, mz + 1.8), (mx - 0.4, 18.2, mz + 1.2), 0.08,
         0.05, C.C_TRIM.rect, n=4)
    dx, dy, dz = C.SENSOR_DOME
    limb(p, (dx, dy, dz), (dx, dy + 1.1, dz), 0.75, 0.28, C.C_TRIM.rect, n=8)
    box(p, (mx, 16.5, 8.9), (1.4, 0.9, 1.4), C.C_TRIM, ch=0.06)   # comms
    # aft island (flight control)
    for dims in (C.ISL2_BASE, C.ISL2_TOWER):
        x, yc, zc, w, h, d = dims
        chamfer_box(p, (x, yc, zc), (w, h, d), 0.10,
                    {'+y': C.C_ISL, '-y': C.C_ISL, '+x': C.C_ISL,
                     '-x': C.C_ISL, '+z': C.C_ISL_F, '-z': C.C_ISL_F})
    m2x, m2y, m2z = C.ISL2_MAST
    limb(p, (m2x, m2y, m2z), (m2x, 15.6, m2z), 0.22, 0.10, C.C_TRIM.rect,
         n=6)
    d2x, d2y, d2z = C.ISL2_DOME
    limb(p, (d2x, d2y, d2z), (d2x, d2y + 0.85, d2z), 0.6, 0.22,
         C.C_TRIM.rect, n=8)
    # island nav beacons
    box(p, (mx + 2.35, 15.2, 4.5), (0.22, 0.22, 0.4), C.C_NAVP, ch=0.01)
    box(p, (mx - 2.35, 15.2, 4.5), (0.22, 0.22, 0.4), C.C_NAVS, ch=0.01)

    # ── jet blast deflectors (raised angled plates behind the cats) ──
    for cx in C.CATS:
        z0, z1 = C.JBD_Z, C.JBD_Z + 1.5
        w = C.JBD_W / 2
        plate = [(cx - w, C.DECK_Y, z1), (cx + w, C.DECK_Y, z1),
                 (cx + w, 9.55, z0 + 0.35), (cx - w, 9.55, z0 + 0.35)]
        quad_out(p, plate, (0, 0.5, -1), C.C_JBD)
        quad_out(p, list(plate), (0, -0.5, 1), C.C_TRIM)
        for rx in (cx - w + 0.4, cx, cx + w - 0.4):     # support ribs
            quad_out(p, [(rx - 0.09, C.DECK_Y, z1), (rx + 0.09, C.DECK_Y, z1),
                         (rx + 0.09, 9.5, z0 + 0.4), (rx - 0.09, 9.5, z0 + 0.4)],
                     (0, -0.4, 1), C.C_TRIM)

    # ── hangar mouth + elevator guide rails (port side) ──
    hx, hy, hz, hw, hh, hd = C.HANGAR
    chamfer_box(p, (hx, hy, hz), (hw, hh, hd), 0.04,
                {'+x': C.C_HANGAR, '+y': C.C_TRIM, '-y': C.C_TRIM,
                 '+z': C.C_TRIM, '-z': C.C_TRIM}, skip=('-x',))
    for rz in C.ELEV_RAILS:
        box(p, (8.55, 5.6, rz), (0.55, 5.4, 0.75), C.C_TRIM, ch=0.04)

    # ── sponsons, CIWS dome, catwalk rails, whips, nav, life rafts ──
    sx, sy, sz, sw, sh, sd = C.SPONSON
    box(p, (sx, sy, sz), (sw, sh, sd), C.C_SPONSON, ch=0.08)
    cx, cy, cz = C.CIWS
    box(p, (cx, cy + 0.5, cz), (2.2, 1.0, 2.2), C.C_SPONSON, ch=0.06)
    limb(p, (cx, cy + 1.0, cz), (cx, cy + 2.1, cz), 0.85, 0.3,
         C.C_TRIM.rect, n=8)
    limb(p, (cx, cy + 1.45, cz - 0.9), (cx, cy + 1.45, cz - 1.55), 0.16,
         0.13, C.C_TRIM.rect, n=6)
    for (wx, wz) in C.WHIPS:
        tilt = 0.6 if wx > 0 else -0.6
        limb(p, (wx, C.DECK_Y - 0.5, wz), (wx + tilt, C.DECK_Y + 3.2, wz),
             0.05, 0.02, C.C_TRIM.rect, n=4)
    for (nx, ny, nz), zone in ((C.NAV_P, C.C_NAVP), (C.NAV_S, C.C_NAVS)):
        box(p, (nx, ny, nz), (0.3, 0.3, 0.55), zone, ch=0.02)
    for wz in (-42.0, -26.0, -8.0, 34.0, 46.0):      # life-raft canisters
        for s in (1, -1):
            wl = 14.0 if abs(wz) < 40 else 10.5
            box(p, (s * wl, 7.55, wz), (0.5, 0.4, 1.3), C.C_TRIM, ch=0.05)
    return p


def mini_fighter(p, cx, cy, cz):
    """Simplified deck-park FA-6 (local coords, nose -z), ~130 tris."""
    secs = [(-7.0, 0.10, 0.20), (-5.2, 0.55, 0.95), (-2.4, 0.85, 1.35),
            (1.8, 0.90, 1.40), (5.6, 0.68, 1.05), (7.2, 0.40, 0.75)]
    rings = []
    for (z, w, h) in secs:
        yb, yt = cy + 0.15, cy + 0.15 + h
        rings.append([(cx + w, yt, cz + z), (cx - w, yt, cz + z),
                      (cx - w * 0.85, yb, cz + z), (cx + w * 0.85, yb, cz + z)])
    loft(p, rings, lambda c, n: C.C_PLANE, cap_start=C.C_TRIM,
         cap_end=C.C_TRIM)
    # canopy hint
    box(p, (cx, cy + 1.62, cz - 2.9), (0.75, 0.5, 2.2), C.C_TRIM, ch=0.15)
    # wings / stabs / canted fins as thin slabs
    for s in (1, -1):
        quad_out(p, [(cx + s * 0.8, cy + 1.05, cz - 0.5),
                     (cx + s * 5.9, cy + 1.1, cz + 2.6),
                     (cx + s * 5.9, cy + 1.1, cz + 3.9),
                     (cx + s * 0.8, cy + 1.05, cz + 4.2)],
                 (0, 1, 0), C.C_PLANE)
        quad_out(p, [(cx + s * 0.8, cy + 1.0, cz - 0.5),
                     (cx + s * 5.9, cy + 1.05, cz + 2.6),
                     (cx + s * 5.9, cy + 1.05, cz + 3.9),
                     (cx + s * 0.8, cy + 1.0, cz + 4.2)],
                 (0, -1, 0), C.C_TRIM)
        quad_out(p, [(cx + s * 0.85, cy + 1.6, cz + 5.0),
                     (cx + s * 1.45, cy + 3.3, cz + 6.1),
                     (cx + s * 1.45, cy + 3.3, cz + 7.3),
                     (cx + s * 0.85, cy + 1.6, cz + 7.2)],
                 (s, 0.3, 0), C.C_TRIM)
        quad_out(p, [(cx + s * 0.85, cy + 1.6, cz + 5.0),
                     (cx + s * 1.45, cy + 3.3, cz + 6.1),
                     (cx + s * 1.45, cy + 3.3, cz + 7.3),
                     (cx + s * 0.85, cy + 1.6, cz + 7.2)],
                 (-s, -0.3, 0), C.C_TRIM)


def build_elevator():
    p = Part('elevator')
    w, h, d = C.ELEV_SIZE
    chamfer_box(p, (0, h / 2, 0), (w, h, d), 0.06,
                {'+y': C.C_ELEV, '-y': C.C_TRIM, '+x': C.C_TRIM,
                 '-x': C.C_TRIM, '+z': C.C_TRIM, '-z': C.C_TRIM})
    for dz in (-6.4, 0.0, 6.4):                     # underframe beams
        box(p, (0, -0.28, dz), (w - 0.8, 0.35, 0.6), C.C_TRIM, ch=0.03)
    mini_fighter(p, 0.4, h, -0.4)
    return p


def build_turret():
    p = Part('turret')
    chamfer_box(p, (0, 0.55, 0), (2.7, 1.1, 3.3), 0.14,
                {'+y': C.C_TUR, '-y': C.C_TUR, '+x': C.C_TUR, '-x': C.C_TUR,
                 '+z': C.C_TUR, '-z': C.C_TUR})
    box(p, (0, 1.25, 0.6), (1.1, 0.5, 1.3), C.C_TRIM, ch=0.05)   # sensor
    return p


def build_barrel():
    p = Part('barrel')
    for s in (1, -1):
        tube(p, [(0.25, 0.17, 0.0), (-1.7, 0.14, 0.0), (-2.4, 0.16, 0.0)],
             C.C_BARREL, n=8, xoff=s * C.TUBE_X, cap_end=C.C_DARK)
    box(p, (0, 0.0, -0.1), (1.35, 0.55, 0.9), C.C_TRIM, ch=0.06)  # mantlet
    return p


def build_radar():
    p = Part('radar')
    box(p, (0, 0.3, 0), (4.2, 0.9, 0.28), C.C_RADAR, ch=0.04)
    box(p, (0, -0.25, 0), (0.5, 0.5, 0.4), C.C_TRIM, ch=0.03)
    return p


def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    T = 16.0
    rad = [(T * i / 16, qy(90.0 * i)) for i in range(17)]
    ex, ey, ez = C.ELEV_OFF
    lo = ey - C.ELEV_DROP
    elev = [(0.0, (ex, ey, ez)), (3.0, (ex, ey, ez)), (6.0, (ex, lo, ez)),
            (10.0, (ex, lo, ez)), (13.0, (ex, ey, ez)), (T, (ex, ey, ez))]
    idle = {'name': 'idle', 'channels': [
        ('radar', 'rotation', rad),
        ('elevator', 'translation', elev),
    ]}
    return [idle]


def build_all():
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),   # 0
        dict(name='turret', parent=0, offset=C.TURRET_OFF, part=build_turret()),
        dict(name='barrel', parent=1, offset=C.BARREL_OFF, part=build_barrel()),
        dict(name='muzzle', parent=2, offset=C.MUZZLE_OFF, part=None),
        dict(name='radar', parent=0, offset=C.RADAR_OFF, part=build_radar()),
        dict(name='elevator', parent=0, offset=C.ELEV_OFF,
             part=build_elevator()),
        dict(name='exhaust', parent=0, offset=C.EXHAUST_OFF, part=None),
    ]
    y = C.DECK_Y + 0.1
    for i, (px, pz) in enumerate(C.PADS_HELO + C.PADS_FIGHT + [C.PAD_BOMBER]):
        pieces.append(dict(name=f'pad{i + 1}', parent=0, offset=(px, y, pz),
                           part=None))
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_carrier] total tris: {total}')
