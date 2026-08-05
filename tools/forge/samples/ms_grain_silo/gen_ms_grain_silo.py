"""gen_ms_grain_silo — build ms_grain_silo (grain silo cluster) + idle clip.

Named resource site: three corrugated silos (tallest 15 m), bucket
elevator leg + head house, overhead conveyor gallery over the shorter
silo roofs with distribution spouts, exposed head-pulley roller
(piece `belt` — the only animated piece, idle roller spin), truck
load-out spout with a `loadout` FX empty, weigh shed + weighbridge on
a concrete pad. Tri budget <= 1500.

Usage: python3 gen_ms_grain_silo.py
"""
from __future__ import annotations
import numpy as np

import ms_grain_silo_layout as L   # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, chamfer_box, ngon_ring, limb
from gltf_export import export

STEM = 'ms_grain_silo'
OUT = '/private/tmp/claude-501/-Users-shannon-WarriorHut-Projects-springrts-web/a3af7b17-2167-4d4d-9b46-0cec735eddd1/scratchpad/forge/ms_grain_silo/out'


# ── helpers (forge patterns, per gen_factory.py) ─────────────────────────

def drum_y(p, cx, cz, ybase, ytop, r, wrap_rect, cap_zone=None, n=8):
    """Vertical n-gon drum with parametric wrap UVs (factory pattern)."""
    r0 = ngon_ring((cx, ybase, cz), r, n=n, axis='y')
    r1 = ngon_ring((cx, ytop, cz), r, n=n, axis='y')
    dx0, dy0, dx1, dy1 = wrap_rect
    for j in range(n):
        k = (j + 1) % n
        u0 = (dx0 + (dx1 - dx0) * j / n) / M.ATLAS
        u1 = (dx0 + (dx1 - dx0) * (j + 1) / n) / M.ATLAS
        quad = [r0[j], r0[k], r1[k], r1[j]]
        uvs = [(u0, dy1 / M.ATLAS), (u1, dy1 / M.ATLAS),
               (u1, dy0 / M.ATLAS), (u0, dy0 / M.ATLAS)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        rad = ctr - np.array([cx, ctr[1], cz])
        if np.dot(nrm, rad) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)
    if cap_zone is not None:
        zc = Zone(cap_zone, ('x', 'z'), ((cx - r, cx + r), (cz - r, cz + r)))
        p.add_face(ngon_ring((cx, ytop, cz), r, n=n, axis='y'), zone=zc,
                   flip=True)


def cone_y(p, cx, cz, ybase, ytop, r, wrap_rect, n=10):
    """Conical silo roof: eave ring -> apex, parametric wrap UVs
    (u = facet, v = downslope: v-down == world-down for rain streaks)."""
    ring = ngon_ring((cx, ybase, cz), r, n=n, axis='y')
    apex = (cx, ytop, cz)
    dx0, dy0, dx1, dy1 = wrap_rect
    for j in range(n):
        k = (j + 1) % n
        u0 = (dx0 + (dx1 - dx0) * j / n) / M.ATLAS
        u1 = (dx0 + (dx1 - dx0) * (j + 1) / n) / M.ATLAS
        tri = [ring[j], ring[k], apex]
        uvs = [(u0, dy1 / M.ATLAS), (u1, dy1 / M.ATLAS),
               ((u0 + u1) / 2, dy0 / M.ATLAS)]
        nrm = np.cross(np.asarray(tri[1]) - np.asarray(tri[0]),
                       np.asarray(tri[2]) - np.asarray(tri[0]))
        ctr = np.mean(np.array(tri), axis=0)
        rad = ctr - np.array([cx, ctr[1], cz])
        if np.dot(nrm, rad) < 0:
            tri, uvs = tri[::-1], uvs[::-1]
        p.add_face(tri, uvs=uvs)


def box(p, center, size, zone, ch=0.04, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


# ── the site ─────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    # concrete pad
    x, y, z, w, h, d = L.PAD
    chamfer_box(p, (x, y, z), (w, h, d), 0.1,
                {'+y': L.Z_PAD, '+x': L.Z_PADS, '-x': L.Z_PADS,
                 '+z': L.Z_PADS_F, '-z': L.Z_PADS_F}, skip=('-y',))
    # three silos: wall drum + eave band + roof cone + offset hatch
    for (sx, sz, sr, eave, apex) in L.SILOS:
        drum_y(p, sx, sz, L.PAD_TOP - 0.05, eave, sr, L.Z_SILO, n=L.SILO_N)
        drum_y(p, sx, sz, eave - 0.15, eave + 0.1, sr + 0.07, L.Z_EAVE,
               n=L.SILO_N)
        cone_y(p, sx, sz, eave + 0.1, apex, sr + 0.07, L.Z_CONE, n=L.SILO_N)
        # roof hatch drum on the cone flank
        hy = apex - (L.HATCH_OFF / sr) * (apex - eave)
        cap = Zone(L.Z_HATCH_TOP, ('x', 'z'),
                   ((sx + L.HATCH_OFF - L.HATCH_R, sx + L.HATCH_OFF + L.HATCH_R),
                    (sz - L.HATCH_R, sz + L.HATCH_R)))
        limb(p, (sx + L.HATCH_OFF, hy - 0.2, sz),
             (sx + L.HATCH_OFF, hy + 0.3, sz),
             L.HATCH_R, L.HATCH_R, L.Z_HATCH, n=4, cap_end=cap)
    # elevator leg: boot, trunk, head house
    x, y, z, w, h, d = L.LEG_BOOT
    box(p, (x, y, z), (w, h, d), L.Z_TRIMZ, ch=0.06, skip=('-y',))
    x, y, z, w, h, d = L.LEG_TRUNK
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+x': L.Z_LEG, '-x': L.Z_LEG, '+z': L.Z_LEG_F,
                 '-z': L.Z_LEG_F, '+y': L.Z_TRIMZ}, skip=('-y',))
    x, y, z, w, h, d = L.HEAD
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+x': L.Z_HEAD, '-x': L.Z_HEAD, '+z': L.Z_HEAD_F,
                 '-z': L.Z_HEAD_F, '+y': L.Z_HEAD_ROOF, '-y': L.Z_HEAD_ROOF})
    # conveyor gallery housing (west face flush against the head house)
    x, y, z, w, h, d = L.GALLERY
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+z': L.Z_GAL_SIDE, '-z': L.Z_GAL_SIDE, '+y': L.Z_GAL_TOP,
                 '-y': L.Z_GAL_TOP, '+x': L.Z_GAL_END}, skip=('-x',))
    # open head-end deck: floor (double-sided) + two low side rails
    fz0, fz1 = L.LEG_Z - 0.45, L.LEG_Z + 0.45
    fy = L.GAL_FLOOR_Y
    floor = [(L.GAL_X1, fy, fz0), (L.GAL_X1, fy, fz1),
             (L.GAL_OPEN_X1, fy, fz1), (L.GAL_OPEN_X1, fy, fz0)]
    p.add_face(floor, zone=L.Z_GAL_TOP)
    p.add_face(floor, zone=L.Z_GAL_TOP, flip=True)
    for rz in (fz0, fz1):
        rail = [(L.GAL_X1, fy, rz), (L.GAL_X1, L.GAL_RAIL_TOP, rz),
                (L.GAL_OPEN_X1, L.GAL_RAIL_TOP, rz), (L.GAL_OPEN_X1, fy, rz)]
        p.add_face(rail, zone=L.Z_GAL_SIDE)
        p.add_face(rail, zone=L.Z_GAL_SIDE, flip=True)
    # roller bearing hangers under the deck lip
    for hz in (fz0 + 0.05, fz1 - 0.05):
        box(p, (L.GAL_OPEN_X1 + 0.1, L.GAL_RAIL_TOP, hz), (0.5, 0.5, 0.14),
            L.Z_TRIMZ, ch=0.02)
    # gallery roof railing (both sides)
    for rz in (L.LEG_Z - 0.55, L.LEG_Z + 0.55):
        for rx in L.RAIL_POST_XS:
            limb(p, (rx, L.RAIL_Y0, rz), (rx, L.RAIL_Y1, rz), 0.035, 0.035,
                 L.Z_TRIM, n=4)
        limb(p, (-3.2, L.RAIL_Y1, rz), (8.7, L.RAIL_Y1, rz), 0.04, 0.04,
             L.Z_TRIM, n=4)
    # spouts: head -> silo A, gallery -> silos B/C
    limb(p, *L.SPOUT_A, 0.28, 0.24, L.Z_SPOUT, n=6)
    limb(p, *L.SPOUT_B, 0.26, 0.22, L.Z_SPOUT, n=6)
    limb(p, *L.SPOUT_C, 0.26, 0.22, L.Z_SPOUT, n=6)
    # gallery supports: posts onto the B/C cones + ground column at the head
    for px in L.GAL_POSTS:
        limb(p, (px, 13.15, L.LEG_Z), (px, 12.45, L.LEG_Z), 0.1, 0.1,
             L.Z_TRIM, n=4)
    limb(p, (L.GAL_COLUMN, L.PAD_TOP, L.LEG_Z),
         (L.GAL_COLUMN, 13.1, L.LEG_Z), 0.22, 0.16, L.Z_TRIM, n=6)
    # truck load-out spout + telescoping sleeve off the open deck
    limb(p, (L.LOADOUT_X, 13.1, L.LEG_Z), (L.LOADOUT_X, 9.6, L.LEG_Z),
         0.30, 0.26, L.Z_SPOUT, n=6)
    limb(p, (L.LOADOUT_X, 9.6, L.LEG_Z), (L.LOADOUT_X, 5.4, L.LEG_Z),
         0.21, 0.19, L.Z_SPOUT, n=6)
    # weigh shed + roof slab
    x, y, z, w, h, d = L.SHED
    chamfer_box(p, (x, y, z), (w, h, d), 0.08,
                {'+x': L.Z_SHED_SIDE, '-x': L.Z_SHED_SIDE,
                 '+z': L.Z_SHED_FRONT, '-z': L.Z_SHED_FRONT,
                 '+y': L.Z_SHED_ROOF}, skip=('-y',))
    x, y, z, w, h, d = L.SHED_ROOF
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+y': L.Z_SHED_ROOF, '-y': L.Z_SHED_ROOF,
                 '+x': L.Z_TRIMZ, '-x': L.Z_TRIMZ,
                 '+z': L.Z_TRIMZ, '-z': L.Z_TRIMZ})
    # weighbridge deck + corner bollards
    x, y, z, w, h, d = L.BRIDGE
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': L.Z_BRIDGE, '+x': L.Z_TRIMZ, '-x': L.Z_TRIMZ,
                 '+z': L.Z_TRIMZ, '-z': L.Z_TRIMZ}, skip=('-y',))
    for (bx, bz) in L.BOLLARDS:
        limb(p, (bx, L.PAD_TOP, bz), (bx, L.PAD_TOP + 0.7, bz), 0.09, 0.09,
             L.Z_TRIM, n=4,
             cap_end=Zone(L.Z_TRIM, ('x', 'z'),
                          ((bx - 0.09, bx + 0.09), (bz - 0.09, bz + 0.09))))
    # receiving pit grate at the leg boot
    x, y, z, w, h, d = L.PIT
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': L.Z_GRATE, '+x': L.Z_TRIMZ, '-x': L.Z_TRIMZ,
                 '+z': L.Z_TRIMZ, '-z': L.Z_TRIMZ}, skip=('-y',))
    return p


def build_belt():
    """Exposed head-pulley roller: n-gon drum along local Z, spins in idle."""
    p = Part('belt')
    n = 6
    r0 = ngon_ring((0, 0, -L.ROLLER_HL), L.ROLLER_R, n=n, axis='z')
    r1 = ngon_ring((0, 0, L.ROLLER_HL), L.ROLLER_R, n=n, axis='z')
    dx0, dy0, dx1, dy1 = L.Z_ROLLER
    for j in range(n):
        k = (j + 1) % n
        v0 = (dy0 + (dy1 - dy0) * j / n) / M.ATLAS
        v1 = (dy0 + (dy1 - dy0) * (j + 1) / n) / M.ATLAS
        quad = [r0[j], r0[k], r1[k], r1[j]]
        uvs = [(dx0 / M.ATLAS, v0), (dx0 / M.ATLAS, v1),
               (dx1 / M.ATLAS, v1), (dx1 / M.ATLAS, v0)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        rad = np.array([ctr[0], ctr[1], 0.0])
        if np.dot(nrm, rad) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)
    capz = Zone(L.Z_ROLLER_CAP, ('x', 'y'),
                ((-L.ROLLER_R, L.ROLLER_R), (L.ROLLER_R, -L.ROLLER_R)))
    p.add_face(list(r0), zone=capz, flip=True)   # -z cap
    p.add_face(list(r1), zone=capz)              # +z cap
    return p


# ── clips ────────────────────────────────────────────────────────────────

def qz(deg):
    r = np.radians(deg) / 2
    return (0.0, 0.0, float(np.sin(r)), float(np.cos(r)))


def build_clips():
    # idle roller spin: full turn / 2.4 s about local Z; top of the drum
    # runs toward +X (the discharge) so the belt reads as feeding the spout.
    T = 2.4
    belt_keys = [(T * i / 4, qz(-90.0 * i)) for i in range(5)]
    idle = {
        'name': 'idle',
        'channels': [('belt', 'rotation', belt_keys)],
    }
    return [idle]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='belt', parent=0, offset=L.BELT_OFF, part=build_belt()),
        dict(name='loadout', parent=0, offset=L.LOADOUT_OFF, part=None),
    ]
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_grain_silo] total tris: {total}')
