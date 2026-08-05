"""gen_ms_vault_door — build ms_vault_door (ancient vault door cache site).

10 m half-buried circular vault door in a rock/earth berm: segmented
monolithic door disc + raised hub, stone collar ring, faceted berm loft,
toppled masonry blocks (rotated), two half-buried conduit runs, scorched
ground apron. Single static piece `body`, no clips, no team.
Tri budget <= 1500.

Usage: $FORGE/venv/bin/python gen_ms_vault_door.py
"""
from __future__ import annotations
import numpy as np

import ms_vault_door_layout as L   # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, Zone, ngon_ring, limb
from gltf_export import export
import parts as P

STEM = 'ms_vault_door'
OUT = ('/private/tmp/claude-501/-Users-shannon-WarriorHut-Projects-'
       'springrts-web/a3af7b17-2167-4d4d-9b46-0cec735eddd1/scratchpad/'
       'batch2/ms_vault_door/out')

RNG = np.random.default_rng(90210)


def disc_z(p, cx, cy, z, r, n, zone, forward):
    """Fan disc in a z-plane; normal toward -Z when forward, else +Z."""
    ring = ngon_ring((cx, cy, z), r, n=n, axis='z')
    for j in range(n):
        k = (j + 1) % n
        tri = [ring[j], ring[k], (cx, cy, z)]
        nrm = np.cross(np.asarray(tri[1]) - np.asarray(tri[0]),
                       np.asarray(tri[2]) - np.asarray(tri[0]))
        want = -1.0 if forward else 1.0
        if nrm[2] * want < 0:
            tri = tri[::-1]
        p.add_face(tri, zone=zone)


def ring_wall(p, cx, cy, z0, z1, r, n, wrap_rect):
    """Outward rim wall between two z-plane rings, parametric wrap UVs."""
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
    """Toppled masonry block: axis box rotated (yaw about Y, pitch about X)."""
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
    faces = [  # (four corner keys CCW seen from outside, outward local axis)
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


def build_body():
    p = Part('body')

    # ── the door: segmented monolithic disc + raised hub ──
    cy, r, n = L.DOOR_CY, L.DOOR_R, L.DOOR_N
    disc_z(p, 0.0, cy, L.DOOR_Z0, r, n, L.Z_DOOR, forward=True)
    ring_wall(p, 0.0, cy, L.DOOR_Z0, L.DOOR_Z1, r, n, L.Z_RIM)
    disc_z(p, 0.0, cy, L.DOOR_Z1, r, n, L.Z_DOOR, forward=False)  # buried back
    # raised central hub (proud of the face)
    disc_z(p, 0.0, cy, L.HUB_Z0, L.HUB_R, 12, L.Z_DOOR, forward=True)
    ring_wall(p, 0.0, cy, L.HUB_Z0, L.DOOR_Z0, L.HUB_R, 12, L.Z_HUBRIM)

    # ── stone collar ring around the door (frames it in the berm face) ──
    ring_wall(p, 0.0, cy, L.COLLAR_Z0, L.COLLAR_Z1, L.COLLAR_R, n, L.Z_COLLAR)
    # collar front annulus: quads between door-radius ring and collar ring
    ri = ngon_ring((0.0, cy, L.COLLAR_Z0), r + 0.02, n=n, axis='z')
    ro = ngon_ring((0.0, cy, L.COLLAR_Z0), L.COLLAR_R, n=n, axis='z')
    for j in range(n):
        k = (j + 1) % n
        quad = [ri[j], ri[k], ro[k], ro[j]]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        if nrm[2] > 0:
            quad = quad[::-1]
        p.add_face(quad, zone=L.Z_DOOR)

    # ── berm loft: front slope, back slope, end caps ──
    st = L.BERM
    for (a, b) in zip(st, st[1:]):
        (xa, ha, zfa, zca, zba), (xb, hb, zfb, zcb, zbb) = a, b
        f0, f1 = (xa, 0.0, zfa), (xb, 0.0, zfb)
        c0, c1 = (xa, ha, zca), (xb, hb, zcb)
        b0, b1 = (xa, 0.0, zba), (xb, 0.0, zbb)
        P.quad_out(p, [f0, f1, c1, c0], (0, 0.5, -1), L.Z_BERM_F)
        P.quad_out(p, [c0, c1, b1, b0], (0, 0.5, 1), L.Z_BERM_B)
    # end caps (small triangles at the outermost stations)
    xa, ha, zfa, zca, zba = st[0]
    P.quad_out(p, [(xa, 0, zfa), (xa, ha, zca), (xa, 0, zba),
                   (xa, 0, zfa)][:3], (-1, 0, 0), L.Z_BERM_B)
    xa, ha, zfa, zca, zba = st[-1]
    P.quad_out(p, [(xa, 0, zfa), (xa, ha, zca), (xa, 0, zba),
                   (xa, 0, zfa)][:3], (1, 0, 0), L.Z_BERM_B)

    # ── toppled masonry blocks ──
    for (ctr, size, yaw, pitch) in L.BLOCKS:
        rot_box(p, ctr, size, yaw, pitch, L.Z_ROCK)

    # ── half-buried conduit runs ──
    P.pipe_run(p, L.CONDUIT, r=L.CONDUIT_R, zone=L.Z_PIPE, n=6)
    P.pipe_run(p, L.CONDUIT2, r=L.CONDUIT_R * 0.85, zone=L.Z_PIPE, n=6)
    # junction stub where the main conduit meets the door
    limb(p, (2.6, 0.55, -1.3), (2.6, 0.85, -1.05), 0.3, 0.3, L.Z_PIPE, n=6)

    # ── scorched ground apron ──
    x0, z0, x1, z1 = L.APRON
    P.quad_out(p, [(x0, 0.02, z0), (x1, 0.02, z0), (x1, 0.02, z1),
                   (x0, 0.02, z1)], (0, 1, 0), L.Z_GROUND)
    return p


def build_all():
    return [dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body())]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_vault_door] total tris: {total}')
