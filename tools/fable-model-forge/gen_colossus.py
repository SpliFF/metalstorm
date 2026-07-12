"""gen_colossus — build fable_colossus (FW-15 Fenrir) geometry + clips.

15 m hunched bipedal war robot. Detail language (per titan-class refs):
layered armor plates with rim trims floating over dark machinery, drum
bearings with collar rings at every joint, corrugated hoses, multi-tube
rotary cannon + ammo drum, flamer with tanked fuel + hose, articulated
toe pieces, breakoff parts for the death fall.

Usage: python3 gen_colossus.py [png]
"""
from __future__ import annotations
import numpy as np

import colossus_layout as C        # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, loft, chamfer_box, tube, ngon_ring, limb, mirror_x
from gltf_export import export

STEM = 'fable_colossus'
OUT = 'out'


# ── helpers ──────────────────────────────────────────────────────────────

def joint_stub(p, center, r, half_w, rect=None, cap_zone=None):
    """8-gon axle drum along X."""
    rect = rect or C.C_JOINT
    cx0, cy0, cx1, cy1 = rect
    r0 = ngon_ring((center[0] - half_w, center[1], center[2]), r, n=8, axis='x')
    r1 = ngon_ring((center[0] + half_w, center[1], center[2]), r, n=8, axis='x')
    for j in range(8):
        k = (j + 1) % 8
        u0 = (cx0 + (cx1 - cx0) * j / 8) / M.ATLAS
        u1 = (cx0 + (cx1 - cx0) * (j + 1) / 8) / M.ATLAS
        quad = [r0[j], r0[k], r1[k], r1[j]]
        uvs = [(u0, cy0 / M.ATLAS), (u1, cy0 / M.ATLAS),
               (u1, cy1 / M.ATLAS), (u0, cy1 / M.ATLAS)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        rad = ctr - np.array([ctr[0], center[1], center[2]])
        if np.dot(nrm, rad) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)
    for (ring, sign) in ((r1, 1.0), (r0, -1.0)):
        p.add_face(list(ring), zone=cap_zone or C.C_JOINT_CAP, flip=(sign < 0))


def bearing(p, center, r, half_w):
    """Joint drum + raised collar rings on both rims (titan-style)."""
    joint_stub(p, center, r, half_w)
    for s in (-1, 1):
        joint_stub(p, (center[0] + s * half_w, center[1], center[2]),
                   r * 1.16, 0.06)


def hose(p, pts, r, rect=None, collars=True):
    """Corrugated flex hose along a polyline: thin segments + fat collars."""
    rect = rect or C.C_HOSE.rect
    for i in range(len(pts) - 1):
        limb(p, pts[i], pts[i + 1], r, r, rect, n=6)
    if collars:
        for i in range(1, len(pts) - 1):
            a, b = np.asarray(pts[i - 1]), np.asarray(pts[i])
            d = b - a
            d = d / max(1e-9, np.linalg.norm(d))
            c0 = tuple(b - d * 0.10)
            c1 = tuple(b + d * 0.10)
            limb(p, c0, c1, r * 1.32, r * 1.32, rect, n=6)


def extrude_profile(p, prof, half_w, side_zone, wrap_rect):
    n = len(prof)
    area = sum(prof[i][0] * prof[(i + 1) % n][1]
               - prof[(i + 1) % n][0] * prof[i][1] for i in range(n))
    ccw_zy = area > 0
    outer = [(half_w, y, z) for (z, y) in prof]
    inner = [(-half_w, y, z) for (z, y) in prof]
    p.add_face(outer, zone=side_zone, flip=ccw_zy)
    p.add_face(inner, zone=side_zone, flip=not ccw_zy)
    x0, y0, x1, y1 = wrap_rect
    seg = [np.hypot(prof[(i + 1) % n][0] - prof[i][0],
                    prof[(i + 1) % n][1] - prof[i][1]) for i in range(n)]
    total = sum(seg)
    acc = 0.0
    centroid = np.array([0.0, sum(y for _, y in prof) / n,
                         sum(z for z, _ in prof) / n])
    for i in range(n):
        j = (i + 1) % n
        u0 = (x0 + (x1 - x0) * acc / total) / M.ATLAS
        acc += seg[i]
        u1 = (x0 + (x1 - x0) * acc / total) / M.ATLAS
        quad = [(half_w, prof[i][1], prof[i][0]), (-half_w, prof[i][1], prof[i][0]),
                (-half_w, prof[j][1], prof[j][0]), (half_w, prof[j][1], prof[j][0])]
        uvs = [(u0, y0 / M.ATLAS), (u0, y1 / M.ATLAS),
               (u1, y1 / M.ATLAS), (u1, y0 / M.ATLAS)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        if np.dot(nrm, ctr - centroid) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)


def drum(p, cx, cz, ybase, ytop, r, wrap_rect, cap_zone=None, n=8):
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
        zc = Zone(cap_zone.rect, ('x', 'z'), ((cx - r, cx + r), (cz - r, cz + r)))
        p.add_face(ngon_ring((cx, ytop, cz), r, n=n, axis='y'), zone=zc, flip=True)


def spike(p, base_c, base_w, base_d, apex, zone):
    bx, by, bz = base_c
    corners = [(bx - base_w / 2, by, bz - base_d / 2),
               (bx + base_w / 2, by, bz - base_d / 2),
               (bx + base_w / 2, by, bz + base_d / 2),
               (bx - base_w / 2, by, bz + base_d / 2)]
    ap = (bx + apex[0], by + apex[1], bz + apex[2])
    for i in range(4):
        a, b = corners[i], corners[(i + 1) % 4]
        c = np.mean([a, b, ap], axis=0)
        out = np.asarray(c) - np.asarray([bx, by, bz])
        n = np.cross(np.asarray(b) - np.asarray(a), np.asarray(ap) - np.asarray(a))
        p.add_face([a, b, ap] if np.dot(n, out) > 0 else [b, a, ap], zone=zone)


def piston(p, p0, p1, zone_rect=None):
    zone_rect = zone_rect or C.C_PISTON
    limb(p, p0, p1, 0.09, 0.09, zone_rect, n=6)
    mid = tuple((np.asarray(p0) + np.asarray(p1)) / 2)
    limb(p, p0, mid, 0.16, 0.15, zone_rect, n=6)


def plate(p, center, size, zone, rim_zone=None, rim=0.10, ch=0.05):
    """Floating armor plate + slightly larger thin rim slab behind it —
    the layered look: bright plate face, dark trim border."""
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone})
    if rim_zone is not None:
        w, h, d = size
        thin = min(w, h, d)
        if thin == w:      # plate faces ±X
            rs, off = (w * 0.5, h + rim * 2, d + rim * 2), (w * 0.28, 0, 0)
        elif thin == h:    # faces ±Y
            rs, off = (w + rim * 2, h * 0.5, d + rim * 2), (0, h * 0.28, 0)
        else:              # faces ±Z
            rs, off = (w + rim * 2, h + rim * 2, d * 0.5), (0, 0, d * 0.28)
        cx, cy, cz = center
        chamfer_box(p, (cx + off[0], cy + off[1], cz + off[2]), rs, 0.04,
                    {'+y': rim_zone, '-y': rim_zone, '+x': rim_zone,
                     '-x': rim_zone, '+z': rim_zone, '-z': rim_zone})


def ring8_y(y, zc, hw, hd):
    wc, dc = hw * 0.55, hd * 0.55
    return [
        (hw, y, zc - dc), (hw, y, zc + dc), (wc, y, zc + hd), (-wc, y, zc + hd),
        (-hw, y, zc + dc), (-hw, y, zc - dc), (-wc, y, zc - hd), (wc, y, zc - hd),
    ]


def torso_zone(c, n):
    if n[1] < -0.6:
        return C.C_DARK
    if abs(n[0]) > 0.62:
        return C.C_TORSO_SIDE
    if n[2] < -0.55:
        return C.C_TORSO_FRONT
    if n[2] > 0.55:
        return C.C_TORSO_REAR
    return C.C_TORSO_TOP


def head_zone(c, n):
    if n[1] < -0.6:
        return C.C_DARK
    if abs(n[0]) > 0.6:
        return C.C_HEAD_SIDE
    if n[2] < -0.5:
        return C.C_HEAD_FRONT
    return C.C_HEAD_TOP


# ── pieces ───────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    x, y, z, w, h, d = C.PELVIS
    chamfer_box(p, (x, y, z), (w, h, d), 0.10,
                {'+y': C.C_PELVIS, '-y': C.C_DARK, '+x': C.C_PELVIS,
                 '-x': C.C_PELVIS, '+z': C.C_PELVIS, '-z': C.C_PELVIS})
    # hanging armor skirts (front / rear / sides) with rims
    plate(p, (0, 7.45, -1.42), (2.0, 1.5, 0.22), C.C_PELVIS, C.C_TRIM)
    plate(p, (0, 7.50, 1.42), (1.8, 1.3, 0.22), C.C_PELVIS, C.C_TRIM)
    for sx in (1, -1):
        plate(p, (sx * 1.72, 7.40, 0.0), (0.22, 1.5, 1.7), C.C_PELVIS, C.C_TRIM)
    # crotch guard
    chamfer_box(p, (0, 6.95, -1.15), (1.15, 1.0, 0.5), 0.06,
                {'+y': C.C_DARK, '-y': C.C_DARK, '+x': C.C_PELVIS,
                 '-x': C.C_PELVIS, '+z': C.C_PELVIS, '-z': C.C_PELVIS})
    # waist bearing drum (exposed machinery between pelvis and carapace)
    drum(p, 0.0, 0.15, 8.30, 8.78, 1.12, C.C_JOINT, n=10)
    # hip bearings with collars
    for sx in (1, -1):
        bearing(p, (sx * (C.HIP_X - 0.05), C.HIP_Y, 0.0), 0.66, 0.30)
    # diagonal support struts pelvis -> waist bearing
    for sx in (1, -1):
        limb(p, (sx * 1.35, 7.15, 0.9), (sx * 0.8, 8.45, 0.35), 0.10, 0.09,
             C.C_PISTON, n=6)
    # service port boxes along the pelvis flanks
    for sx in (1, -1):
        for pz in (-0.7, 0.1, 0.9):
            chamfer_box(p, (sx * 1.66, 7.35, pz), (0.14, 0.34, 0.5), 0.02,
                        {'+x': C.C_VENT, '-x': C.C_VENT, '+y': C.C_VENT,
                         '-y': C.C_DARK, '+z': C.C_VENT, '-z': C.C_VENT})
    return p


def build_torso():
    p = Part('turret')
    rings = [ring8_y(*s) for s in C.TORSO_SECTIONS]
    z0 = C.TORSO_SECTIONS[0][1]
    zt = C.TORSO_SECTIONS[-1][1]
    bot = Zone(C.C_DARK.rect, ('x', 'z'), ((-1.55, 1.55), (z0 - 1.3, z0 + 1.3)))
    top = Zone(C.C_TORSO_TOP.rect, ('x', 'z'), ((-2.05, 2.05), (zt - 1.5, zt + 1.5)))
    loft(p, rings, torso_zone, cap_start=bot, cap_end=top)
    # layered carapace roof slab + brow of the hull
    plate(p, (0, 4.05, -1.55), (3.4, 0.35, 2.6), C.C_TORSO_TOP, C.C_TRIM)
    # cowl over the head root
    chamfer_box(p, (0, 3.92, -2.75), (2.7, 0.5, 1.6), 0.06,
                {'+y': C.C_TORSO_TOP, '-y': C.C_DARK, '+x': C.C_TORSO_SIDE,
                 '-x': C.C_TORSO_SIDE, '-z': C.C_TORSO_FRONT, '+z': C.C_TORSO_TOP})
    # floating side armor plates
    for sx in (1, -1):
        plate(p, (sx * 2.18, 2.45, -0.85), (0.26, 1.7, 2.3), C.C_TORSO_SIDE,
              C.C_TRIM)
    # sloped chest plate + rim
    x, y, z, w, h, d = C.CHEST_PLATE
    plate(p, (x, y, z), (w, h, d), C.C_TORSO_FRONT, C.C_TRIM, ch=0.08)
    # collar guard
    x, y, z, w, h, d = C.COLLAR
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+y': C.C_COLLAR, '-y': C.C_DARK, '+x': C.C_COLLAR,
                 '-x': C.C_COLLAR, '-z': C.C_COLLAR, '+z': C.C_COLLAR})
    # fixed right pauldron (+ horn) with rim
    px, py, pz = C.PAULDRON_R
    w, h, d = C.PAULDRON_SIZE
    plate(p, (px, py, pz), (w, h, d), C.C_PAULDRON, C.C_TRIM, ch=0.09)
    hx, hy, hz = C.PAULDRON_HORN
    spike(p, (px - hx, py + h / 2 - 0.05, pz + hz), 0.48, 0.6,
          (-0.18, hy + 0.45, -0.25), C.C_HORN)
    # side vent pods
    for sx in (1, -1):
        chamfer_box(p, (sx * 2.0, 1.9, -0.6), (0.6, 0.9, 1.15), 0.05,
                    {'+y': C.C_TORSO_TOP, '-y': C.C_DARK, '+x': C.C_VENT,
                     '-x': C.C_VENT, '-z': C.C_VENT, '+z': C.C_VENT})
    # belly hoses running up into the pack
    for sx in (0.7, -0.7):
        hose(p, [(sx, 0.25, 1.35), (sx + 0.1 * np.sign(sx), 1.5, 1.85),
                 (sx, 2.75, 2.0)], 0.15)
    # rear radiator fins
    for i in range(5):
        fx = -1.0 + i * 0.5
        chamfer_box(p, (fx, 1.55, 1.62), (0.08, 1.1, 0.55), 0.015,
                    {'+y': C.C_VENT, '+x': C.C_VENT, '-x': C.C_VENT,
                     '+z': C.C_VENT, '-z': C.C_VENT}, skip=('-y',))
    # waist hose collars
    for sx in (1.1, -1.1):
        joint_stub(p, (sx, 0.15, 0.6), 0.24, 0.14, cap_zone=C.C_DARK)
    # maintenance ladder up the rear-right flank (building-scale cue)
    lx, lz = -1.35, 1.42
    for rx_ in (lx - 0.22, lx + 0.22):
        chamfer_box(p, (rx_, 1.25, lz), (0.06, 2.6, 0.06), 0.01,
                    {'+x': C.C_TRIM, '-x': C.C_TRIM, '+z': C.C_TRIM,
                     '-z': C.C_TRIM, '+y': C.C_TRIM, '-y': C.C_TRIM})
    for i in range(6):
        chamfer_box(p, (lx, 0.25 + i * 0.44, lz), (0.5, 0.05, 0.05), 0.01,
                    {'+x': C.C_TRIM, '-x': C.C_TRIM, '+z': C.C_TRIM,
                     '-z': C.C_TRIM, '+y': C.C_TRIM, '-y': C.C_TRIM})
    # pauldron support struts
    for sx in (1, -1):
        limb(p, (sx * 1.85, 2.75, -1.2), (sx * 2.85, 3.45, -1.2), 0.10, 0.09,
             C.C_PISTON, n=6)
    # chest intake grilles (recessed dark ports)
    for sx in (1, -1):
        chamfer_box(p, (sx * 1.35, 0.75, -1.72), (0.62, 0.5, 0.18), 0.02,
                    {'-z': C.C_VENT, '+z': C.C_DARK, '+x': C.C_VENT,
                     '-x': C.C_VENT, '+y': C.C_VENT, '-y': C.C_DARK})
    # wire conduits along the carapace side edges
    for sx in (1, -1):
        hose(p, [(sx * 2.05, 3.45, 0.6), (sx * 2.3, 3.6, -0.7),
                 (sx * 2.15, 3.7, -1.9)], 0.09)
    # rear service ports under the radiator
    for px_ in (-0.9, 0.0, 0.9):
        chamfer_box(p, (px_, 0.35, 1.42), (0.5, 0.36, 0.14), 0.02,
                    {'+z': C.C_VENT, '-z': C.C_DARK, '+x': C.C_VENT,
                     '-x': C.C_VENT, '+y': C.C_VENT, '-y': C.C_DARK})
    return p


def build_head():
    p = Part('head')
    rings = []
    for (z, yb, yt, hw) in C.HEAD_SNOUT:
        rings.append([
            (hw * 0.6, yb, z), (hw, yb + 0.10, z), (hw, yt - 0.12, z),
            (hw * 0.55, yt, z), (-hw * 0.55, yt, z), (-hw, yt - 0.12, z),
            (-hw, yb + 0.10, z), (-hw * 0.6, yb, z),
        ])
    loft(p, rings, head_zone,
         cap_start=Zone(C.C_HEAD_TOP.rect, ('x', 'y'), ((-1.15, 1.15), (1.0, -0.7))),
         cap_end=C.C_HEAD_FRONT)
    x, y, z, w, h, d = C.BROW
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+y': C.C_HEAD_TOP, '-y': C.C_DARK, '+x': C.C_HEAD_SIDE,
                 '-x': C.C_HEAD_SIDE, '-z': C.C_HEAD_FRONT, '+z': C.C_HEAD_TOP})
    for (cx, cy, cz) in C.CHEEKS:
        chamfer_box(p, (cx, cy, cz), C.CHEEK_SIZE, 0.04,
                    {'+y': C.C_HEAD_TOP, '-y': C.C_DARK, '+x': C.C_HEAD_SIDE,
                     '-x': C.C_HEAD_SIDE, '-z': C.C_HEAD_SIDE, '+z': C.C_HEAD_SIDE})
    # jaw block
    chamfer_box(p, (0, -0.72, -0.85), (1.15, 0.4, 1.35), 0.05,
                {'+y': C.C_DARK, '-y': C.C_HEAD_SIDE, '+x': C.C_HEAD_SIDE,
                 '-x': C.C_HEAD_SIDE, '-z': C.C_HEAD_FRONT, '+z': C.C_DARK})
    # backswept ear horns off the brow ends
    for sx in (1, -1):
        spike(p, (sx * 1.0, 1.05, -0.45), 0.35, 0.5, (sx * 0.22, 0.55, 0.75),
              C.C_HORN)
    return p


def build_arm_upper(name):
    p = Part(name)
    bearing(p, (0.0, 0.0, 0.0), 0.62, 0.36)
    limb(p, (0, -0.1, 0.0), C.ELBOW, C.ARM_R0, C.ARM_R1, C.C_ARM)
    # armor sleeve plate on the outer face (+X; mirrored for the right arm)
    plate(p, (0.72, -1.25, -0.30), (0.22, 1.5, 1.15), C.C_SHINGUARD, C.C_TRIM)
    piston(p, (0, -0.5, -0.62), (C.ELBOW[0], C.ELBOW[1] + 0.4, C.ELBOW[2] - 0.4))
    piston(p, (0.35, -0.5, 0.45), (C.ELBOW[0] + 0.3, C.ELBOW[1] + 0.5,
                                   C.ELBOW[2] + 0.35))
    bearing(p, C.ELBOW, 0.52, 0.32)
    return p


def build_gun():
    p = Part('barrel')
    x, y, z, w, h, d = C.GUN_RECEIVER
    chamfer_box(p, (x, y, z), (w, h, d), 0.08,
                {'+y': C.C_RECEIVER, '-y': C.C_RECEIVER, '+x': C.C_RECEIVER,
                 '-x': C.C_RECEIVER, '-z': C.C_RECEIVER, '+z': C.C_RECEIVER})
    # side cheek plates
    for sx in (1, -1):
        plate(p, (sx * 0.82, 0.05, -0.7), (0.16, 1.1, 1.9), C.C_RECEIVER,
              C.C_TRIM)
    # ammo drum on the outer flank + feed chute
    joint_stub(p, (-1.05, 0.42, 0.15), 0.58, 0.30, rect=C.C_TANK,
               cap_zone=C.C_TANK_CAP)
    chamfer_box(p, (-0.85, 0.72, -0.25), (0.5, 0.35, 0.9), 0.04,
                {'+y': C.C_RECEIVER, '-y': C.C_DARK, '+x': C.C_RECEIVER,
                 '-x': C.C_RECEIVER, '-z': C.C_RECEIVER, '+z': C.C_RECEIVER})
    # rotary cluster: centre bore + 4 orbit tubes + muzzle collar
    tube(p, [(-2.3, 0.26, -0.18), (-3.75, 0.26, -0.18)], C.C_GUN_WRAP, n=8)
    for (ox, oy) in ((0.30, -0.18), (-0.30, -0.18), (0.0, 0.12), (0.0, -0.48)):
        tube(p, [(-2.4, 0.155, oy), (-3.80, 0.155, oy)], C.C_GUN_WRAP, n=6,
             xoff=ox, cap_end=C.C_MUZZLE_CELL)
    tube(p, [(-3.45, 0.52, -0.18), (-3.72, 0.52, -0.18)], C.C_NOZZLE, n=8,
         cap_start=C.C_MUZZLE_CELL, cap_end=C.C_MUZZLE_CELL)
    # missile box with divider ribs
    x, y, z, w, h, d = C.MISSILE_BOX
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+y': C.C_MISSILE_BOX, '-y': C.C_DARK, '+x': C.C_RECEIVER,
                 '-x': C.C_RECEIVER, '-z': C.C_MUZZLE_CELL, '+z': C.C_RECEIVER})
    for rz in (-1.55, -0.35):
        chamfer_box(p, (x, y + h / 2 + 0.03, rz), (w + 0.08, 0.08, 0.14), 0.015,
                    {'+y': C.C_TRIM, '+x': C.C_TRIM, '-x': C.C_TRIM,
                     '-z': C.C_TRIM, '+z': C.C_TRIM}, skip=('-y',))
    # knuckle guard
    x, y, z, w, h, d = C.KNUCKLE
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+y': C.C_DARK, '-y': C.C_KNUCKLE, '+x': C.C_KNUCKLE,
                 '-x': C.C_KNUCKLE, '-z': C.C_KNUCKLE, '+z': C.C_KNUCKLE})
    # feed hose along the inner flank (stays on this piece: no joint shear)
    hose(p, [(0.8, 0.35, 0.55), (0.95, -0.15, -0.3), (0.8, -0.5, -1.1)], 0.12)
    # sighting wire bundle along the receiver roof
    hose(p, [(0.25, 0.74, 0.4), (0.3, 0.78, -0.8), (0.2, 0.72, -1.9)], 0.055,
         collars=False)
    chamfer_box(p, (0.45, 0.72, -2.15), (0.28, 0.2, 0.3), 0.02,
                {'+y': C.C_VENT, '+x': C.C_VENT, '-x': C.C_VENT,
                 '-z': C.C_VENT, '+z': C.C_VENT, '-y': C.C_DARK})
    piston(p, (0.62, 0.55, 0.3), (0.62, 0.1, -1.5))
    return p


def build_flamer():
    p = Part('flamer')
    x, y, z, w, h, d = C.FLAME_RECEIVER
    chamfer_box(p, (x, y, z), (w, h, d), 0.08,
                {'+y': C.C_RECEIVER, '-y': C.C_RECEIVER, '+x': C.C_RECEIVER,
                 '-x': C.C_RECEIVER, '-z': C.C_RECEIVER, '+z': C.C_RECEIVER})
    plate(p, (0.78, 0.05, -0.7), (0.16, 1.0, 1.8), C.C_RECEIVER, C.C_TRIM)
    tube(p, [(s[0], s[1], -0.12) for s in C.FLAME_TUBE], C.C_FLAMER_WRAP, n=8)
    tube(p, [(s[0], s[1], -0.12) for s in C.NOZZLE], C.C_NOZZLE, n=8,
         cap_end=C.C_MUZZLE_CELL)
    # pilot burner nub under the bell
    chamfer_box(p, (0, -0.5, -3.35), (0.16, 0.3, 0.3), 0.02,
                {'+y': C.C_DARK, '-y': C.C_KNUCKLE, '+x': C.C_KNUCKLE,
                 '-x': C.C_KNUCKLE, '-z': C.C_KNUCKLE, '+z': C.C_KNUCKLE})
    # fuel tanks with clamp collars
    for (tx, ty, tz) in C.TANKS:
        tube(p, [(tz - C.TANK_LEN / 2, C.TANK_R, ty), (tz + C.TANK_LEN / 2, C.TANK_R, ty)],
             C.C_TANK, n=8, xoff=tx, cap_start=C.C_TANK_CAP, cap_end=C.C_TANK_CAP)
        for cz in (tz - 0.55, tz + 0.55):
            tube(p, [(cz - 0.07, C.TANK_R * 1.14, ty), (cz + 0.07, C.TANK_R * 1.14, ty)],
                 C.C_TANK, n=8, xoff=tx)
    # fuel hose: tanks manifold -> receiver front
    hose(p, [(0.0, 0.95, -0.75), (-0.35, 0.7, -1.5), (-0.2, 0.35, -2.2)], 0.13)
    x, y, z, w, h, d = C.SHIELD
    plate(p, (x, y, z), (w, h, d), C.C_KNUCKLE, C.C_TRIM)
    piston(p, (-0.6, 0.55, 0.3), (-0.6, 0.1, -1.4))
    # igniter wire pair along the flank to the pilot burner
    hose(p, [(-0.68, 0.4, -0.6), (-0.6, -0.1, -1.8), (-0.3, -0.42, -3.0)],
         0.05, collars=False)
    return p


def build_pack():
    p = Part('pack')
    w, h, d = C.PACK_SIZE
    chamfer_box(p, (0, 0, 0), (w, h, d), 0.12,
                {'+y': C.C_PACK_TOP, '-y': C.C_DARK, '+x': C.C_PACK,
                 '-x': C.C_PACK, '-z': C.C_PACK, '+z': C.C_PACK})
    x, y, z, w, h, d = C.RACK
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+y': C.C_RACK, '-y': C.C_DARK, '+x': C.C_PACK,
                 '-x': C.C_PACK, '-z': C.C_PACK, '+z': C.C_PACK})
    # rack frame ribs
    for rx in (-0.55, 0.55):
        chamfer_box(p, (rx, y + h / 2 + 0.02, z), (0.09, 0.09, d + 0.1), 0.015,
                    {'+y': C.C_TRIM, '+x': C.C_TRIM, '-x': C.C_TRIM,
                     '-z': C.C_TRIM, '+z': C.C_TRIM}, skip=('-y',))
    # fixed stack with collar
    sx, sy, sz = C.STACK_L_OFF
    drum(p, sx, sz, sy - 0.1, sy + C.STACK_H, C.STACK_R, C.C_STACK,
         cap_zone=C.C_STACK_TOP)
    drum(p, sx, sz, sy + 0.5, sy + 0.72, C.STACK_R * 1.18, C.C_STACK)
    # torn-off stub base for stack_r
    sx, sy, sz = C.STACK_R_OFF
    drum(p, sx, sz, sy - 0.1, sy + 0.15, C.STACK_R + 0.05, C.C_STACK)
    # rear radiator block
    plate(p, (0, -0.15, 1.18), (2.4, 1.3, 0.25), C.C_VENT, C.C_TRIM)
    # comms mast + dish on the left shoulder of the hump
    limb(p, (-1.65, 0.9, -0.55), (-1.65, 2.9, -0.55), 0.07, 0.05,
         C.C_PISTON, n=6)
    chamfer_box(p, (-1.65, 2.45, -0.30), (0.05, 0.05, 0.6), 0.01,
                {'+x': C.C_TRIM, '-x': C.C_TRIM, '+z': C.C_TRIM,
                 '-z': C.C_TRIM, '+y': C.C_TRIM, '-y': C.C_TRIM})
    drum(p, -1.65, -0.55, 2.86, 2.98, 0.34, C.C_JOINT, cap_zone=C.C_STACK_TOP,
         n=8)
    return p


def build_stack_r():
    p = Part('stack_r')
    drum(p, 0, 0, 0.0, C.STACK_H, C.STACK_R, C.C_STACK, cap_zone=C.C_STACK_TOP)
    drum(p, 0, 0, 0.5, 0.72, C.STACK_R * 1.18, C.C_STACK)
    return p


def build_pauldron_l():
    p = Part('pauldron_l')
    w, h, d = C.PAULDRON_SIZE
    plate(p, (0, 0, 0), (w, h, d), C.C_PAULDRON, C.C_TRIM, ch=0.09)
    hx, hy, hz = C.PAULDRON_HORN
    spike(p, (hx, h / 2 - 0.05, hz), 0.48, 0.6, (0.18, hy + 0.45, -0.25),
          C.C_HORN)
    return p


def build_thigh_l():
    p = Part('thigh_l')
    bearing(p, (0.0, 0.0, 0.0), 0.66, 0.34)
    limb(p, (0, -0.05, 0.0), C.KNEE, C.THIGH_R0, C.THIGH_R1, C.C_THIGH)
    # front armor plate + outer side plate
    plate(p, (0, -1.55, -1.02), (1.2, 2.0, 0.24), C.C_SHINGUARD, C.C_TRIM)
    plate(p, (0.82, -1.45, -0.25), (0.2, 1.7, 1.1), C.C_SHINGUARD, C.C_TRIM)
    # hydraulic supply pipes down the outer flank (with clamp collars)
    for dz in (-0.15, 0.15):
        hose(p, [(0.78, -0.6, dz), (0.9, -1.7, dz - 0.1),
                 (0.72, -2.7, dz - 0.25)], 0.075)
    # twin knee pistons
    piston(p, (-0.28, -0.5, -0.7), (C.KNEE[0] - 0.26, C.KNEE[1] + 0.6, C.KNEE[2] - 0.4))
    piston(p, (0.28, -0.5, -0.7), (C.KNEE[0] + 0.26, C.KNEE[1] + 0.6, C.KNEE[2] - 0.4))
    bearing(p, C.KNEE, 0.58, 0.32)
    return p


def build_shin_l():
    p = Part('shin_l')
    limb(p, (0, 0.0, 0.0), C.ANKLE, C.SHIN_R0, C.SHIN_R1, C.C_SHIN)
    x, y, z, w, h, d = C.SHINGUARD
    plate(p, (x, y, z), (w, h, d), C.C_SHINGUARD, C.C_TRIM, ch=0.06)
    # calf plate
    plate(p, (0, -1.15, 0.78), (1.0, 1.5, 0.2), C.C_SHINGUARD, C.C_TRIM)
    # coolant pipe pair down the calf
    for dx in (-0.5, 0.5):
        hose(p, [(dx, -0.4, 0.62), (dx * 0.9, -1.5, 0.78),
                 (dx * 0.75, -2.5, 0.85)], 0.07)
    # twin ankle pistons
    piston(p, (-0.3, -0.6, 0.5), (C.ANKLE[0] - 0.28, C.ANKLE[1] + 0.5, C.ANKLE[2] + 0.2))
    piston(p, (0.3, -0.6, 0.5), (C.ANKLE[0] + 0.28, C.ANKLE[1] + 0.5, C.ANKLE[2] + 0.2))
    bearing(p, C.ANKLE, 0.46, 0.28)
    return p


def build_foot_l():
    p = Part('foot_l')
    extrude_profile(p, C.FOOT_PROFILE, C.FOOT_HALF_W, C.C_FOOT_SIDE, C.C_FOOT_WRAP)
    # heel spur (rear claw)
    spike(p, (0, -0.80, 0.82), 0.66, 0.5, (0.0, -0.15, 0.95), C.C_CLAW)
    # toe joint axle across the ball
    joint_stub(p, (0.0, C.TOE_OFF[1], C.TOE_OFF[2]), 0.26, 0.85,
               cap_zone=C.C_DARK)
    return p


def build_toes_l():
    p = Part('toes_l')
    extrude_profile(p, C.TOE_PROFILE, C.FOOT_HALF_W - 0.02, C.C_FOOT_SIDE,
                    C.C_FOOT_WRAP)
    for (cx, dz) in C.CLAWS:
        w, h, d = C.CLAW_SIZE
        spike(p, (cx, -0.20, -0.78 + dz), w, d, (0.0, -0.19, -0.70), C.C_CLAW)
    return p


# ── clips ────────────────────────────────────────────────────────────────

def qx(deg):
    r = np.radians(deg) / 2
    return (float(np.sin(r)), 0.0, 0.0, float(np.cos(r)))


def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def qz(deg):
    r = np.radians(deg) / 2
    return (0.0, 0.0, float(np.sin(r)), float(np.cos(r)))


def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz)


def foot_comp(thigh, shin, add=0.0):
    f = -(thigh + shin) * C.WALK_FOOT_COMP
    f = max(-C.WALK_FOOT_CLAMP, min(C.WALK_FOOT_CLAMP, f))
    return max(-32.0, min(32.0, f + add))


def rot_keys(times, degs, q=qx):
    return [(t, q(d)) for t, d in zip(times, degs)]


def shifted(tbl):
    n = len(tbl)
    half = (n - 1) // 2
    return [tbl[(i + half) % (n - 1)] for i in range(n - 1)] + \
           [tbl[half % (n - 1)]]


def build_clips():
    n = len(C.WALK_THIGH)
    wt = [C.WALK_T * i / (n - 1) for i in range(n)]

    thigh_r = shifted(C.WALK_THIGH)
    shin_r = shifted(C.WALK_SHIN)
    add_r = shifted(C.WALK_FOOT_ADD)
    toe_r = shifted(C.WALK_TOE)
    arm_l = shifted(C.WALK_ARM)
    fore_l = shifted(C.WALK_FOREARM)
    body_q = [qmul(qy(yw), qz(rl))
              for yw, rl in zip(C.WALK_PELVIS_YAW, C.WALK_PELVIS_ROLL)]
    torso_q = [qmul(qy(yw), qx(pt))
               for yw, pt in zip(C.WALK_TORSO_YAW, C.WALK_TORSO_PITCH)]
    head_q = [qmul(qy(yw), qx(pt))
              for yw, pt in zip(C.WALK_HEAD_YAW, C.WALK_HEAD_PITCH)]
    walk = {
        'name': 'walk',
        'channels': [
            ('thigh_l', 'rotation', rot_keys(wt, C.WALK_THIGH)),
            ('shin_l', 'rotation', rot_keys(wt, C.WALK_SHIN)),
            ('foot_l', 'rotation', rot_keys(
                wt, [foot_comp(a, b, c) for a, b, c in
                     zip(C.WALK_THIGH, C.WALK_SHIN, C.WALK_FOOT_ADD)])),
            ('toes_l', 'rotation', rot_keys(wt, C.WALK_TOE)),
            ('thigh_r', 'rotation', rot_keys(wt, thigh_r)),
            ('shin_r', 'rotation', rot_keys(wt, shin_r)),
            ('foot_r', 'rotation', rot_keys(
                wt, [foot_comp(a, b, c) for a, b, c in
                     zip(thigh_r, shin_r, add_r)])),
            ('toes_r', 'rotation', rot_keys(wt, toe_r)),
            ('body', 'translation', [(t, (dx, dy, 0.0)) for t, dx, dy in
                                     zip(wt, C.WALK_BODY_X, C.WALK_BODY_Y)]),
            ('body', 'rotation', list(zip(wt, body_q))),
            ('turret', 'rotation', list(zip(wt, torso_q))),
            ('head', 'rotation', list(zip(wt, head_q))),
            ('arm_r', 'rotation', rot_keys(wt, C.WALK_ARM)),
            ('arm_l', 'rotation', rot_keys(wt, arm_l)),
            ('barrel', 'rotation', rot_keys(wt, C.WALK_FOREARM)),
            ('flamer', 'rotation', rot_keys(wt, fore_l)),
        ],
    }

    it = C.IDLE_KEYS
    idle = {
        'name': 'idle',
        'channels': [
            ('body', 'translation', [(t, (0.0, dy, 0.0))
                                     for t, dy in zip(it, C.IDLE_BODY_Y)]),
            ('turret', 'rotation', rot_keys(it, C.IDLE_TORSO_YAW, q=qy)),
            ('head', 'rotation', rot_keys(it, C.IDLE_HEAD_YAW, q=qy)),
            ('arm_r', 'rotation', rot_keys(it, C.IDLE_ARM)),
            ('arm_l', 'rotation', rot_keys(it, [-a for a in C.IDLE_ARM])),
        ],
    }

    dt = C.DEATH_KEYS
    body_q = [qmul(qy(yw), qx(pt))
              for yw, pt in zip(C.DEATH_BODY_YAW, C.DEATH_BODY_PITCH)]
    torso_q = [qmul(qy(yw), qx(pt))
               for yw, pt in zip(C.DEATH_TORSO_YAW, C.DEATH_TORSO_PITCH)]
    head_q = [qmul(qy(yw), qx(pt))
              for yw, pt in zip(C.DEATH_HEAD_YAW, C.DEATH_HEAD_PITCH)]

    def fly_keys(rest, fly, spin_q):
        launch = fly['launch']
        tr, rot = [], []
        for i, t in enumerate(dt):
            if i < launch:
                tr.append((t, rest))
                rot.append((t, spin_q(0)))
            else:
                j = min(i - launch, len(fly['path']) - 1)
                tr.append((t, fly['path'][j]))
                rot.append((t, spin_q(fly['spin'][j])))
        return tr, rot

    pl_tr, pl_rot = fly_keys(C.PAULDRON_L_OFF, C.PAULDRON_FLY, qz)
    st_tr, st_rot = fly_keys(C.STACK_R_OFF, C.STACK_FLY, qx)

    death = {
        'name': 'death',
        'channels': [
            ('body', 'translation', [(t, tuple(map(float, v)))
                                     for t, v in zip(dt, C.DEATH_BODY)]),
            ('body', 'rotation', list(zip(dt, body_q))),
            ('turret', 'rotation', list(zip(dt, torso_q))),
            ('head', 'rotation', list(zip(dt, head_q))),
            ('thigh_l', 'rotation', rot_keys(dt, C.DEATH_THIGH)),
            ('thigh_r', 'rotation', rot_keys(dt, [d * 0.94 for d in C.DEATH_THIGH])),
            ('shin_l', 'rotation', rot_keys(dt, C.DEATH_SHIN)),
            ('shin_r', 'rotation', rot_keys(dt, [d * 1.05 for d in C.DEATH_SHIN])),
            ('foot_l', 'rotation', rot_keys(dt, C.DEATH_FOOT)),
            ('foot_r', 'rotation', rot_keys(dt, [d * 0.9 for d in C.DEATH_FOOT])),
            ('toes_l', 'rotation', rot_keys(dt, C.DEATH_TOE)),
            ('toes_r', 'rotation', rot_keys(dt, [d * 0.92 for d in C.DEATH_TOE])),
            ('arm_r', 'rotation', rot_keys(dt, C.DEATH_ARM)),
            ('arm_l', 'rotation', rot_keys(dt, [d * 1.1 for d in C.DEATH_ARM])),
            ('barrel', 'rotation', rot_keys(dt, C.DEATH_FOREARM)),
            ('flamer', 'rotation', rot_keys(dt, [d * 0.9 for d in C.DEATH_FOREARM])),
            ('pauldron_l', 'translation', pl_tr),
            ('pauldron_l', 'rotation', pl_rot),
            ('stack_r', 'translation', st_tr),
            ('stack_r', 'rotation', st_rot),
        ],
    }
    return [walk, idle, death]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    body = build_body()
    torso = build_torso()
    head = build_head()
    arm_l = build_arm_upper('arm_l')
    arm_r = mirror_x(arm_l, 'arm_r')
    gun = build_gun()
    flamer = build_flamer()
    pack = build_pack()
    pauldron_l = build_pauldron_l()
    stack_r = build_stack_r()
    tl = build_thigh_l()
    sl = build_shin_l()
    fl = build_foot_l()
    ol = build_toes_l()
    tr = mirror_x(tl, 'thigh_r')
    sr = mirror_x(sl, 'shin_r')
    fr = mirror_x(fl, 'foot_r')
    orr = mirror_x(ol, 'toes_r')

    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=body),            # 0
        dict(name='turret', parent=0, offset=C.TURRET_OFF, part=torso),       # 1
        dict(name='head', parent=1, offset=C.HEAD_OFF, part=head),            # 2
        dict(name='arm_r', parent=1, offset=C.ARM_R_OFF, part=arm_r),         # 3
        dict(name='barrel', parent=3, offset=C.BARREL_OFF, part=gun),         # 4
        dict(name='muzzle', parent=4, offset=C.MUZZLE_OFF, part=None),        # 5
        dict(name='arm_l', parent=1, offset=C.ARM_L_OFF, part=arm_l),         # 6
        dict(name='flamer', parent=6, offset=C.FLAMER_OFF, part=flamer),      # 7
        dict(name='muzzle2', parent=7, offset=C.MUZZLE2_OFF, part=None),      # 8
        dict(name='pack', parent=1, offset=C.PACK_OFF, part=pack),            # 9
        dict(name='pauldron_l', parent=1, offset=C.PAULDRON_L_OFF,
             part=pauldron_l),                                                # 10
        dict(name='stack_r', parent=9, offset=C.STACK_R_OFF, part=stack_r),   # 11
        dict(name='thigh_l', parent=0, offset=(C.HIP_X, C.HIP_Y, 0), part=tl),   # 12
        dict(name='shin_l', parent=12, offset=C.KNEE, part=sl),               # 13
        dict(name='foot_l', parent=13, offset=C.ANKLE, part=fl),              # 14
        dict(name='toes_l', parent=14, offset=C.TOE_OFF, part=ol),            # 15
        dict(name='thigh_r', parent=0, offset=(-C.HIP_X, C.HIP_Y, 0), part=tr),  # 16
        dict(name='shin_r', parent=16, offset=C.KNEE, part=sr),               # 17
        dict(name='foot_r', parent=17, offset=C.ANKLE, part=fr),              # 18
        dict(name='toes_r', parent=18, offset=C.TOE_OFF, part=orr),           # 19
        dict(name='exhaust', parent=1, offset=C.EXHAUST_OFF, part=None),      # 20
    ]
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_colossus] total tris: {total}')
