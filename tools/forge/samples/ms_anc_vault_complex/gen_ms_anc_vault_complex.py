"""gen_ms_anc_vault_complex — the ancient vault complex facade.

35 m cliff-set facility front: stylobate, cyclopean cantilevered architrave,
monolithic portal bay, MAIN vault door (piece `door`, 10 m segmented disc,
clip `open` rolls it 11.78 m aside along its track — exactly 3 x 45 deg so
the 8-fold segment pattern lands on itself, seamless start/end poses), two
smaller sealed doors, raised approach causeway with flanking monolith pylons
carrying floating cap slabs, collapsed overburden fan at the -X corner.

Two pieces (body, door). No team. Tri budget <= 4500.

Usage: $FORGE/venv/bin/python gen_ms_anc_vault_complex.py
"""
from __future__ import annotations
import math

import numpy as np

import ms_anc_vault_complex_layout as L   # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, chamfer_box, ngon_ring
from gltf_export import export
import parts as P

STEM = 'ms_anc_vault_complex'
OUT = 'out'
RNG = np.random.default_rng(90210)


# ───────────────────────────────────────────────── circular-solid helpers

def disc_z(p, cx, cy, z, r, n, zone, forward=True):
    """Fan disc in a z-plane; normal toward -Z when forward, else +Z."""
    ring = ngon_ring((cx, cy, z), r, n=n, axis='z')
    want = -1.0 if forward else 1.0
    for j in range(n):
        k = (j + 1) % n
        tri = [ring[j], ring[k], (cx, cy, z)]
        nrm = np.cross(np.asarray(tri[1]) - np.asarray(tri[0]),
                       np.asarray(tri[2]) - np.asarray(tri[0]))
        if nrm[2] * want < 0:
            tri = tri[::-1]
        p.add_face(tri, zone=zone)


def annulus_z(p, cx, cy, z, ri, ro, n, zone, forward=True):
    """Flat ring between two radii in a z-plane."""
    a = ngon_ring((cx, cy, z), ri, n=n, axis='z')
    b = ngon_ring((cx, cy, z), ro, n=n, axis='z')
    want = -1.0 if forward else 1.0
    for j in range(n):
        k = (j + 1) % n
        quad = [a[j], a[k], b[k], b[j]]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        if nrm[2] * want < 0:
            quad = quad[::-1]
        p.add_face(quad, zone=zone)


def ring_wall(p, cx, cy, z0, z1, r, n, wrap_rect):
    """Outward-facing rim wall between two z-plane rings; parametric wrap."""
    r0 = ngon_ring((cx, cy, z0), r, n=n, axis='z')
    r1 = ngon_ring((cx, cy, z1), r, n=n, axis='z')
    dx0, dy0, dx1, dy1 = wrap_rect
    for j in range(n):
        k = (j + 1) % n
        u0 = (dx0 + (dx1 - dx0) * j / n) / M.ATLAS
        u1 = (dx0 + (dx1 - dx0) * (j + 1) / n) / M.ATLAS
        quad = [r0[j], r0[k], r1[k], r1[j]]
        uvs = [(u0, dy0 / M.ATLAS), (u1, dy0 / M.ATLAS),
               (u1, dy1 / M.ATLAS), (u0, dy1 / M.ATLAS)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        rad = ctr - np.array([cx, cy, ctr[2]])
        if np.dot(nrm, rad) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)


def rot_box(p, center, size, yaw_deg, pitch_deg, zone):
    """Fallen ancient block: axis box rotated (yaw about Y, pitch about X)."""
    cx, cy, cz = center
    hw, hh, hd = size[0] / 2, size[1] / 2, size[2] / 2
    ya, pa = np.radians(yaw_deg), np.radians(pitch_deg)
    Ry = np.array([[np.cos(ya), 0, np.sin(ya)], [0, 1, 0],
                   [-np.sin(ya), 0, np.cos(ya)]])
    Rx = np.array([[1, 0, 0], [0, np.cos(pa), -np.sin(pa)],
                   [0, np.sin(pa), np.cos(pa)]])
    R = Ry @ Rx
    c = np.array([cx, cy, cz])
    corners = {}
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                corners[(sx, sy, sz)] = tuple(
                    c + R @ np.array([sx * hw, sy * hh, sz * hd]))
    faces = [
        ([(1, -1, -1), (1, -1, 1), (1, 1, 1), (1, 1, -1)], (1, 0, 0)),
        ([(-1, -1, 1), (-1, -1, -1), (-1, 1, -1), (-1, 1, 1)], (-1, 0, 0)),
        ([(-1, 1, -1), (1, 1, -1), (1, 1, 1), (-1, 1, 1)], (0, 1, 0)),
        ([(-1, -1, 1), (1, -1, 1), (1, -1, -1), (-1, -1, -1)], (0, -1, 0)),
        ([(-1, -1, 1), (-1, 1, 1), (1, 1, 1), (1, -1, 1)], (0, 0, 1)),
        ([(1, -1, -1), (1, 1, -1), (-1, 1, -1), (-1, -1, -1)], (0, 0, -1)),
    ]
    for keys, axis in faces:
        quad = [corners[k] for k in keys]
        outward = tuple(R @ np.asarray(axis, float))
        P.quad_out(p, quad, outward, zone)


# ─────────────────────────────────────────────────────────── body pieces

def build_body():
    p = Part('body')

    Zf, Zs, Zt = L.Z_WALL_F, L.Z_WALL_S, L.Z_WALL_T
    Zb, Zbs, Zbc = L.Z_BAY, L.Z_BAY_S, L.Z_BAY_C

    # ── stylobate (the grand step the whole facade sits on) ──
    chamfer_box(p, (0.0, L.PLINTH_Y / 2, 1.0), (35.0, L.PLINTH_Y, 10.0), 0.22,
                {'+y': Zt, '-z': Zf, '+z': Zs, '+x': Zs, '-x': Zs},
                skip=('-y',))

    # ── wall blocks flanking the portal bay ──
    wy = (L.PLINTH_Y + L.WALL_TOP) / 2.0
    wh = L.WALL_TOP - L.PLINTH_Y
    wz = (L.WALL_Z0 + L.WALL_Z1) / 2.0
    wd = L.WALL_Z1 - L.WALL_Z0
    lx0, lx1 = -L.FACADE_HW, L.PORTAL_CX - L.PORTAL_HW      # -17.0 .. -7.5
    rx0, rx1 = L.PORTAL_CX + L.PORTAL_HW, L.FACADE_HW       #   5.5 .. 17.0
    chamfer_box(p, ((lx0 + lx1) / 2, wy, wz), (lx1 - lx0, wh, wd), 0.28,
                {'+y': Zt, '-z': Zf, '+z': Zs, '-x': Zs, '+x': Zbs},
                skip=('-y',))
    chamfer_box(p, ((rx0 + rx1) / 2, wy, wz), (rx1 - rx0, wh, wd), 0.28,
                {'+y': Zt, '-z': Zf, '+z': Zs, '+x': Zs, '-x': Zbs},
                skip=('-y',))
    # header spanning the bay
    hh = L.WALL_TOP - L.PORTAL_TOP
    chamfer_box(p, (L.PORTAL_CX, (L.PORTAL_TOP + L.WALL_TOP) / 2, wz),
                (2 * L.PORTAL_HW, hh, wd), 0.24,
                {'+y': Zt, '-z': Zf, '+z': Zs, '-y': Zbc}, skip=('+x', '-x'))
    # bay back wall (the chamber the door uncovers)
    bh = L.PORTAL_TOP - L.PLINTH_Y
    chamfer_box(p, (L.PORTAL_CX, (L.PLINTH_Y + L.PORTAL_TOP) / 2,
                    (L.BAY_Z + L.WALL_Z1) / 2),
                (2 * L.PORTAL_HW, bh, L.WALL_Z1 - L.BAY_Z), 0.20,
                {'-z': Zb}, skip=('+x', '-x', '+y', '-y', '+z'))
    # bay iris: proud cyan ring on the back wall, revealed when the door rolls
    annulus_z(p, L.PORTAL_CX, L.PLINTH_Y + L.DOOR_R, L.BAY_Z - 0.06,
              L.IRIS_R - 0.45, L.IRIS_R, L.IRIS_N, Zb, forward=True)

    # ── set-back upper mass + cyclopean cantilevered architrave ──
    chamfer_box(p, (0.0, (L.WALL_TOP + L.UPPER_TOP) / 2, 3.3),
                (30.0, L.UPPER_TOP - L.WALL_TOP, 5.4), 0.30,
                {'+y': Zt, '-z': Zf, '+z': Zs, '+x': Zs, '-x': Zs},
                skip=('-y',))
    chamfer_box(p, L.ARCH_C, L.ARCH_S, 0.30,
                {'+y': Zt, '-y': Zt, '-z': Zf, '+z': Zf, '+x': Zs, '-x': Zs})

    # ── proud portal collar (frame around the bay mouth) ──
    cd = L.COLLAR_D
    czc = L.WALL_Z0 - cd / 2
    czones = {'+y': Zt, '-y': Zt, '-z': Zf, '+x': Zs, '-x': Zs}
    for sx in (-1, 1):
        chamfer_box(p, (L.PORTAL_CX + sx * (L.PORTAL_HW + cd / 2),
                        (L.PLINTH_Y + L.PORTAL_TOP + cd) / 2, czc),
                    (cd, L.PORTAL_TOP + cd - L.PLINTH_Y, cd), 0.12,
                    czones, skip=('+z',))
    chamfer_box(p, (L.PORTAL_CX, L.PORTAL_TOP + cd / 2, czc),
                (2 * (L.PORTAL_HW + cd), cd, cd), 0.12, czones, skip=('+z',))

    # ── pilaster fins: proud vertical seam ribs on the wall field ──
    for fx in L.FIN_X:
        chamfer_box(p, (fx, wy, L.WALL_Z0 - L.FIN_S[2] / 2),
                    L.FIN_S, 0.11,
                    {'+y': Zt, '-z': Zf, '+x': Zs, '-x': Zs},
                    skip=('-y', '+z'))

    # ── two smaller sealed doors (dormant) ──
    for (sx, sy) in L.SMALL_DOORS:
        zsd = Zone(L.SD_RECT, ('x', 'y'),
                   ((sx - L.SD_WIN_HW, sx + L.SD_WIN_HW),
                    (sy + L.SD_WIN_HW, sy - L.SD_WIN_HW)))
        n = L.SD_N
        annulus_z(p, sx, sy, L.WALL_Z0 - 0.02, L.SD_R, L.SD_R + L.SD_COLLAR,
                  n, zsd, forward=True)
        ring_wall(p, sx, sy, L.SD_ZF, L.WALL_Z0 - 0.02, L.SD_R, n, L.R_RIM_S)
        annulus_z(p, sx, sy, L.SD_ZF, L.SD_RH, L.SD_R, n, zsd, forward=True)
        ring_wall(p, sx, sy, L.SD_ZBOSS, L.SD_ZF, L.SD_RH, n, L.R_RIM_S)
        disc_z(p, sx, sy, L.SD_ZBOSS, L.SD_RH, n, zsd, forward=True)

    # ── door track rail ──
    chamfer_box(p, L.RAIL_C, L.RAIL_S, 0.08,
                {'+y': Zt, '-z': L.Z_TRACK, '+z': L.Z_TRACK}, skip=('-y',))

    # ── approach causeway + descending steps ──
    chamfer_box(p, L.DECK_C, L.DECK_S, 0.24,
                {'+y': L.Z_DECK, '-z': L.Z_STEP, '+x': L.Z_STEP_S,
                 '-x': L.Z_STEP_S}, skip=('-y', '+z'))
    for (c, s) in L.STEPS:
        chamfer_box(p, c, s, 0.10,
                    {'+y': L.Z_DECK, '-z': L.Z_STEP, '+z': L.Z_STEP,
                     '+x': L.Z_STEP_S, '-x': L.Z_STEP_S}, skip=('-y',))

    # ── flanking monolith pylons with floating cap slabs ──
    for px in L.PYLON_X:
        zpf = Zone(L.PYL_FRECT, ('x', 'y'),
                   ((px - L.PYL_WIN_HW, px + L.PYL_WIN_HW), (11.8, 0.6)))
        zps, zpt = L.Z_PYL_S, L.Z_DECK
        _, bh_, _ = L.PYLON_BASE
        _, sh, _ = L.PYLON_SHAFT
        _, chh, _ = L.PYLON_CAP
        y0 = L.PLINTH_Y
        chamfer_box(p, (px, y0 + bh_ / 2, L.PYLON_Z), L.PYLON_BASE, 0.16,
                    {'+y': zpt, '-z': zpf, '+z': zpf, '+x': zps, '-x': zps},
                    skip=('-y',))
        chamfer_box(p, (px, y0 + bh_ + sh / 2, L.PYLON_Z), L.PYLON_SHAFT, 0.14,
                    {'+y': zpt, '-z': zpf, '+z': zpf, '+x': zps, '-x': zps},
                    skip=('-y',))
        # cap floats 0.7 m clear of the shaft — ancient tech, no support
        chamfer_box(p, (px, y0 + bh_ + sh + 0.7 + chh / 2, L.PYLON_Z),
                    L.PYLON_CAP, 0.12,
                    {'+y': zpt, '-y': zpt, '-z': zpf, '+z': zpf,
                     '+x': zps, '-x': zps})

    # ── collapsed overburden fan at the -X corner ──
    for a, b in zip(L.OVER, L.OVER[1:]):
        (s0, m0, t0), (s1, m1, t1) = a, b
        P.quad_out(p, [s0, s1, m1, m0], (-0.4, 0.6, -1.0), L.Z_RUBBLE)
        P.quad_out(p, [m0, m1, t1, t0], (-0.3, 0.7, -1.0), L.Z_RUBBLE)
    for (ctr, size, yaw, pitch) in L.BLOCKS:
        zrk = Zone(L.ROCK_RECT, ('x', 'y'),
                   ((ctr[0] - L.ROCK_WIN_HW, ctr[0] + L.ROCK_WIN_HW),
                    (ctr[1] + L.ROCK_WIN_HW, ctr[1] - L.ROCK_WIN_HW)))
        rot_box(p, ctr, size, yaw, pitch, zrk)

    # ── rear talus: the massif falling away behind the facade ──
    cz, cy = L.TALUS_CREST_Z, L.TALUS_Y
    for (xa, za), (xb, zb) in zip(L.TALUS, L.TALUS[1:]):
        P.quad_out(p, [(xa, cy, cz), (xb, cy, cz), (xb, 0.0, zb),
                       (xa, 0.0, za)], (0, 0.7, 1.0), L.Z_TALUS)
    for (xe, ze), sgn in ((L.TALUS[0], -1), (L.TALUS[-1], 1)):
        P.quad_out(p, [(xe, cy, cz), (xe, 0.0, ze), (xe, 0.0, cz)],
                   (sgn, 0, 0), L.Z_TALUS)
    return p


def build_door():
    """MAIN vault door — segmented disc, three stepped tiers, piece-local."""
    p = Part('door')
    n = L.DOOR_N
    disc_z(p, 0, 0, L.DOOR_ZB, L.DOOR_R, n, L.Z_DOORF, forward=False)
    ring_wall(p, 0, 0, L.DOOR_ZF, L.DOOR_ZB, L.DOOR_R, n, L.R_RIM_D)
    annulus_z(p, 0, 0, L.DOOR_ZF, L.DOOR_RB, L.DOOR_R, n, L.Z_DOORF)
    ring_wall(p, 0, 0, L.DOOR_ZBOSS, L.DOOR_ZF, L.DOOR_RB, n, L.R_RIM_B)
    annulus_z(p, 0, 0, L.DOOR_ZBOSS, L.DOOR_RH, L.DOOR_RB, n, L.Z_DOORF)
    ring_wall(p, 0, 0, L.DOOR_ZHUB, L.DOOR_ZBOSS, L.DOOR_RH, n, L.R_RIM_H)
    disc_z(p, 0, 0, L.DOOR_ZHUB, L.DOOR_RH, n, L.Z_DOORF)
    return p


def build_all():
    return [dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
            dict(name='door', parent=0, offset=L.DOOR_OFF, part=build_door())]


def build_clips():
    """`open`: the disc rolls aside along the track, then rolls back.

    Roll = -135 deg about +Z with translation +11.781 m along +X, i.e. pure
    rolling (dx = -theta * r) over exactly three of the eight segments, so the
    open pose is indistinguishable from the closed pose and the last key
    repeats the first — seamless at both ends.
    """
    ox, oy, oz = L.DOOR_OFF
    a = L.DOOR_ROLL
    q_open = (0.0, 0.0, math.sin(a / 2.0), math.cos(a / 2.0))
    q_shut = (0.0, 0.0, 0.0, 1.0)
    p_open = (ox + L.DOOR_DX, oy, oz)
    p_shut = (ox, oy, oz)
    return [{'name': 'open', 'channels': [
        ('door', 'translation', [(0.0, p_shut), (4.0, p_open),
                                 (6.0, p_open), (10.0, p_shut)]),
        ('door', 'rotation', [(0.0, q_shut), (4.0, q_open),
                              (6.0, q_open), (10.0, q_shut)]),
    ]}]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    for pc in pieces:
        print(f"  {pc['name']:6s} {pc['part'].tri_count():5d} tris")
    print(f'[gen_{STEM}] total tris: {total}')
