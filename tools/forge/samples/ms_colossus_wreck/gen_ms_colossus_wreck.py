"""gen_ms_colossus_wreck — assemble ms_colossus_wreck and export .gltf/.bin.

Fallen fable_colossus as static terrain.  Each sub-assembly (torso hulk,
head, pelvis, pack, gun, pauldron, stack, foot) is built in its own
UPRIGHT local frame — so every Zone projection lands inside its window —
then rigid-transformed (rotate verts + normals, translate) and merged
into the single `body` part.  Leg limbs, bearings and hoses are built
directly in world coordinates with rect-parametric primitives (limb),
which are pose-safe; their caps get per-instance zones.

Simplifications vs gen_colossus (budget 5000): no pistons/greeble hoses
on limbs, plates without floating rim slabs, 3-tube rotary cluster, no
radiator fins; torn ends get jagged shard crowns instead.
Run: python3 gen_ms_colossus_wreck.py -> out/ms_colossus_wreck{,_png}.gltf
"""
import numpy as np

import ms_colossus_wreck_layout as F   # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, chamfer_box, ngon_ring, loft, limb
from gltf_export import export

STEM = 'ms_colossus_wreck'
OUT = 'out'
RNG = np.random.default_rng(90210)


# ── transforms ───────────────────────────────────────────────────────────

def _rot(axis, deg):
    a = np.radians(deg)
    c, s = np.cos(a), np.sin(a)
    if axis == 'x':
        return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])
    if axis == 'y':
        return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def rot_of(spec):
    """Compose [('y',-15),('x',25),('z',-90)] -> Ry@Rx@Rz (right-to-left)."""
    R = np.eye(3)
    for axis, deg in spec:
        R = R @ _rot(axis, deg)
    return R


def merge(dst: Part, src: Part, R=None, t=(0.0, 0.0, 0.0)):
    """Append src geometry into dst under rigid transform R,t (UVs kept)."""
    R = np.eye(3) if R is None else np.asarray(R)
    t = np.asarray(t, dtype=float)
    base = len(dst.pos)
    for p in src.pos:
        dst.pos.append(tuple(R @ np.asarray(p) + t))
    for n in src.nrm:
        dst.nrm.append(tuple(R @ np.asarray(n)))
    dst.uv.extend(src.uv)
    dst.idx.extend(base + i for i in src.idx)


def xf(spec, t):
    return rot_of(spec), np.asarray(t, dtype=float)


# ── shared cell helpers (from the ms_supply_dump pattern) ────────────────

def _uv(px, py):
    return (px / M.ATLAS, py / M.ATLAS)


_FACES = {
    '+y': ([(-1, 1, -1), (-1, 1, 1), (1, 1, 1), (1, 1, -1)],
           [(0, 0), (0, 1), (1, 1), (1, 0)]),
    '-y': ([(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)],
           [(0, 0), (1, 0), (1, 1), (0, 1)]),
    '+x': ([(1, -1, -1), (1, 1, -1), (1, 1, 1), (1, -1, 1)],
           [(0, 1), (0, 0), (1, 0), (1, 1)]),
    '-x': ([(-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1)],
           [(0, 1), (1, 1), (1, 0), (0, 0)]),
    '-z': ([(-1, -1, -1), (-1, 1, -1), (1, 1, -1), (1, -1, -1)],
           [(0, 1), (0, 0), (1, 0), (1, 1)]),
    '+z': ([(-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)],
           [(0, 1), (1, 1), (1, 0), (0, 0)]),
}


def cell_box(p, center, size, cells, yaw=0.0, skip=()):
    """Plain box, each face UV-mapped onto a full cell rect.  cells is
    either one rect (all faces) or dict face->rect with 'side'/'top'
    fallbacks.  yaw rotates about +Y (UVs face-local, rotation free)."""
    cx, cy, cz = center
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    a = np.radians(yaw)
    ca, sa = np.cos(a), np.sin(a)

    def T(sx, sy, sz):
        lx, ly, lz = sx * hx, sy * hy, sz * hz
        return (cx + lx * ca + lz * sa, cy + ly, cz - lx * sa + lz * ca)

    for key, (signs, uvp) in _FACES.items():
        if key in skip:
            continue
        if isinstance(cells, dict):
            cell = cells.get(key) or (cells.get('top') if key in ('+y', '-y')
                                      else cells.get('side'))
        else:
            cell = cells
        x0, y0, x1, y1 = cell
        us, vs = (x0, x1), (y0, y1)
        verts = [T(*s) for s in signs]
        uvs = [_uv(us[i], vs[j]) for (i, j) in uvp]
        p.add_face(verts, uvs=uvs)


def box_zones(center, size, side_cell, top_cell):
    """Per-item local-window Zones for chamfer_box (axis-aligned only)."""
    x, y, z = center
    w, h, d = size
    sv = (y + h / 2, y - h / 2)
    return {
        '+y': Zone(top_cell, ('x', 'z'), ((x - w / 2, x + w / 2),
                                          (z - d / 2, z + d / 2))),
        '-y': Zone(top_cell, ('x', 'z'), ((x - w / 2, x + w / 2),
                                          (z + d / 2, z - d / 2))),
        '+x': Zone(side_cell, ('z', 'y'), ((z - d / 2, z + d / 2), sv)),
        '-x': Zone(side_cell, ('z', 'y'), ((z + d / 2, z - d / 2), sv)),
        '-z': Zone(side_cell, ('x', 'y'), ((x - w / 2, x + w / 2), sv)),
        '+z': Zone(side_cell, ('x', 'y'), ((x + w / 2, x - w / 2), sv)),
    }


def cap_zone_at(center, r, axis_dir, rect):
    """Per-instance Zone for a ring cap at world `center` whose plane is
    perpendicular to axis_dir: project along the two non-dominant axes."""
    d = np.abs(np.asarray(axis_dir, dtype=float))
    order = np.argsort(d)          # two smallest components = projection axes
    names = 'xyz'
    au, av = names[order[0]], names[order[1]]
    c = np.asarray(center, dtype=float)
    iu, iv = order[0], order[1]
    return Zone(rect, (au, av), ((c[iu] - r, c[iu] + r), (c[iv] - r, c[iv] + r)))


# ── world-frame primitives ───────────────────────────────────────────────

def bearing(p, c, axis_dir, r, hw):
    """Joint drum + collar rings along arbitrary axis (world coords)."""
    d = np.asarray(axis_dir, dtype=float)
    d = d / np.linalg.norm(d)
    c = np.asarray(c, dtype=float)
    limb(p, c - d * hw, c + d * hw, r, r, F.JOINT_W, n=8,
         cap_start=cap_zone_at(c - d * hw, r, d, F.JOINT_CAP),
         cap_end=cap_zone_at(c + d * hw, r, d, F.JOINT_CAP))
    for s in (-1, 1):
        cc = c + d * (s * hw)
        limb(p, cc - d * 0.06, cc + d * 0.06, r * 1.16, r * 1.16,
             F.JOINT_W, n=8,
             cap_start=cap_zone_at(cc - d * 0.06, r * 1.16, d, F.JOINT_CAP),
             cap_end=cap_zone_at(cc + d * 0.06, r * 1.16, d, F.JOINT_CAP))


def hose(p, pts, r, collars=True):
    """Corrugated flex hose along a polyline (world coords)."""
    for i in range(len(pts) - 1):
        limb(p, pts[i], pts[i + 1], r, r, F.HOSE_W, n=6)
    if collars:
        for i in range(1, len(pts) - 1):
            a, b = np.asarray(pts[i - 1]), np.asarray(pts[i])
            d = b - a
            d = d / max(1e-9, np.linalg.norm(d))
            limb(p, tuple(b - d * 0.10), tuple(b + d * 0.10),
                 r * 1.32, r * 1.32, F.HOSE_W, n=6)


# ── local-frame builders ─────────────────────────────────────────────────

def drum_y(p, cx, cz, ybase, ytop, r, wrap_rect, cap_zone=None, n=8):
    """Vertical n-gon drum (local frame): parametric side wrap + lid."""
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
        p.add_face(ngon_ring((cx, ytop, cz), r, n=n, axis='y'), zone=zc,
                   flip=True)


def torn_crown(p, cx, cy, cz, r, h, n=8, rng=RNG):
    """Jagged ring of torn-metal shards pointing +Y (local frame).
    Double-sided planar triangles into TORN_CELL."""
    ring = ngon_ring((cx, cy, cz), r, n=n, axis='y')
    x0, y0, x1, y1 = F.TORN_CELL
    for j in range(n):
        k = (j + 1) % n
        a, b = np.asarray(ring[j]), np.asarray(ring[k])
        mid = (a + b) / 2
        out = mid - np.array([cx, mid[1], cz])
        out = out / max(1e-9, np.linalg.norm(out))
        apex = mid + np.array([0, h * rng.uniform(0.45, 1.0), 0]) \
            + out * rng.uniform(-0.06, 0.14)
        u0 = (x0 + (x1 - x0) * j / n) / M.ATLAS
        u1 = (x0 + (x1 - x0) * (j + 1) / n) / M.ATLAS
        um = (u0 + u1) / 2
        uvs = [(u0, y1 / M.ATLAS), (u1, y1 / M.ATLAS), (um, y0 / M.ATLAS)]
        p.add_face([tuple(a), tuple(b), tuple(apex)], uvs=uvs)
        p.add_face([tuple(b), tuple(a), tuple(apex)], uvs=[uvs[1], uvs[0], uvs[2]])


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


def extrude_profile(p, prof, half_w, side_zone, wrap_rect, off=(0.0, 0.0)):
    """Extrude a (z,y) profile along X (from gen_colossus, + y/z offset)."""
    oy, oz = off
    prof = [(z + oz, y + oy) for (z, y) in prof]
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


def ring8_y(y, zc, hw, hd):
    wc, dc = hw * 0.55, hd * 0.55
    return [
        (hw, y, zc - dc), (hw, y, zc + dc), (wc, y, zc + hd), (-wc, y, zc + hd),
        (-hw, y, zc + dc), (-hw, y, zc - dc), (-wc, y, zc - hd), (wc, y, zc - hd),
    ]


def torso_zone(c, n):
    if n[1] < -0.6:
        return F.C_DARK
    if abs(n[0]) > 0.62:
        return F.C_TORSO_SIDE
    if n[2] < -0.55:
        return F.C_TORSO_FRONT
    if n[2] > 0.55:
        return F.C_TORSO_REAR
    return F.C_TORSO_TOP


def head_zone(c, n):
    if n[1] < -0.6:
        return F.C_DARK
    if abs(n[0]) > 0.6:
        return F.C_HEAD_SIDE
    if n[2] < -0.5:
        return F.C_HEAD_FRONT
    return F.C_HEAD_TOP


def build_torso_local():
    """Torso hulk in spine-local frame (+Y spine, -Z chest)."""
    p = Part('torso')
    rings = [ring8_y(*s) for s in F.TORSO_SECTIONS]
    z0 = F.TORSO_SECTIONS[0][1]
    zt = F.TORSO_SECTIONS[-1][1]
    bot = Zone(F.C_DARK.rect, ('x', 'z'), ((-1.55, 1.55), (z0 - 1.3, z0 + 1.3)))
    top = Zone(F.C_TORSO_TOP.rect, ('x', 'z'), ((-2.05, 2.05), (zt - 1.5, zt + 1.5)))
    loft(p, rings, torso_zone, cap_start=bot, cap_end=top)
    # cracked furnace chest: recessed box, ember grille on the -z face
    x, y, z, w, h, d = F.FURNACE_BOX
    cell_box(p, (x, y, z), (w, h, d),
             {'-z': F.FURNACE_CELL, 'side': F.TRIM_CELL, 'top': F.TRIM_CELL})
    # collar guard
    x, y, z, w, h, d = F.COLLAR
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                box_zones((x, y, z), (w, h, d), F.COLLAR_CELL, F.COLLAR_CELL))
    # fixed pauldron — the up-facing fin of the wreck silhouette
    px, py, pz = F.PAULDRON_FIX
    w, h, d = F.PAULDRON_SIZE
    chamfer_box(p, (px, py, pz), (w, h, d), 0.09,
                {'+y': Zone(F.C_PAULDRON.rect, ('x', 'z'),
                            ((px - w / 2, px + w / 2), (pz - d / 2, pz + d / 2))),
                 '-y': F.C_DARK,
                 '+x': F.C_PAULDRON_S, '-x': F.C_PAULDRON_S,
                 '+z': F.C_PAULDRON_S, '-z': F.C_PAULDRON_S})
    hx, hy, hz = F.PAULDRON_HORN
    spike(p, (px + hx, py + h / 2 - 0.05, pz + hz), 0.48, 0.6,
          (-0.18, hy + 0.45, -0.25), F.C_HORN)
    # up-side (local -X) service hatch boxes — read from above
    for (ly, lz) in ((1.3, -0.3), (2.4, -1.1)):
        cell_box(p, (-2.05, ly, lz), (0.35, 0.75, 0.95),
                 {'side': F.TRIM_CELL, 'top': F.TRIM_CELL})
    return p


def build_head_local():
    p = Part('head')
    rings = []
    for (z, yb, yt, hw) in F.HEAD_SNOUT:
        rings.append([
            (hw * 0.6, yb, z), (hw, yb + 0.10, z), (hw, yt - 0.12, z),
            (hw * 0.55, yt, z), (-hw * 0.55, yt, z), (-hw, yt - 0.12, z),
            (-hw, yb + 0.10, z), (-hw * 0.6, yb, z),
        ])
    loft(p, rings, head_zone,
         cap_start=Zone(F.C_HEAD_TOP.rect, ('x', 'y'), ((-1.15, 1.15), (1.0, -0.7))),
         cap_end=F.C_HEAD_FRONT)
    x, y, z, w, h, d = F.BROW
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+y': F.C_HEAD_TOP, '-y': F.C_DARK, '+x': F.C_HEAD_SIDE,
                 '-x': F.C_HEAD_SIDE, '-z': F.C_HEAD_FRONT, '+z': F.C_HEAD_TOP})
    x, y, z, w, h, d = F.JAW
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+y': F.C_DARK, '-y': F.C_HEAD_SIDE, '+x': F.C_HEAD_SIDE,
                 '-x': F.C_HEAD_SIDE, '-z': F.C_HEAD_FRONT, '+z': F.C_DARK})
    for sx in (1, -1):     # backswept ear horns
        spike(p, (sx * 1.0, 1.05, -0.45), 0.35, 0.5, (sx * 0.22, 0.55, 0.75),
              F.C_HORN)
    return p


def build_pelvis_local():
    """Pelvis in its own local frame (centre = origin)."""
    p = Part('pelvis')
    w, h, d = F.PELVIS_SIZE
    chamfer_box(p, (0, 0, 0), (w, h, d), 0.10,
                box_zones((0, 0, 0), (w, h, d), F.PELVIS_CELL, F.PELVIS_CELL))
    # hanging skirt plates
    for (c, s) in (((0, -0.3, -1.42), (2.0, 1.5, 0.22)),
                   ((0, -0.25, 1.42), (1.8, 1.3, 0.22)),
                   ((1.72, -0.35, 0.0), (0.22, 1.5, 1.7))):
        cell_box(p, c, s, F.PLATE_CELL)
    # waist bearing drum toward the torso (local +Y)
    drum_y(p, 0.0, 0.1, 0.85, 1.15, 1.12, F.JOINT_W, n=10)
    return p


def build_pack_local():
    p = Part('pack')
    w, h, d = F.PACK_SIZE
    chamfer_box(p, (0, 0, 0), (w, h, d), 0.12,
                {'+y': F.C_PACK_TOP, '-y': F.C_DARK, '+x': F.C_PACK,
                 '-x': F.C_PACK, '-z': F.C_PACK, '+z': F.C_PACK})
    x, y, z, w, h, d = F.RACK
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+y': Zone(F.C_PACK_TOP.rect, ('x', 'z'),
                            ((x - w / 2, x + w / 2), (z - d / 2, z + d / 2))),
                 '-y': F.C_DARK, '+x': F.C_PACK, '-x': F.C_PACK,
                 '-z': F.C_PACK, '+z': F.C_PACK})
    # surviving stack (now horizontal in the wreck) + collar
    sx, sy, sz = F.STACK_L_OFF
    drum_y(p, sx, sz, sy - 0.1, sy + F.STACK_H, F.STACK_R, F.STACK_W,
           cap_zone=F.C_STACK_TOP)
    drum_y(p, sx, sz, sy + 0.5, sy + 0.72, F.STACK_R * 1.18, F.STACK_W)
    # torn stub of the other stack + shard crown
    sx, sy, sz = F.STACK_R_OFF
    drum_y(p, sx, sz, sy - 0.1, sy + 0.28, F.STACK_R + 0.04, F.STACK_W)
    torn_crown(p, sx, sy + 0.28, sz, F.STACK_R + 0.04, 0.22, n=8)
    return p


def build_gun_local():
    """Rotary cannon forearm, gun-local (-Z toward muzzle)."""
    p = Part('gun')
    x, y, z, w, h, d = F.GUN_RECEIVER
    chamfer_box(p, (x, y, z), (w, h, d), 0.08,
                box_zones((x, y, z), (w, h, d), F.RECEIVER_CELL, F.RECEIVER_CELL))
    # cheek plates
    for sx in (1, -1):
        cell_box(p, (sx * 0.82, 0.05, -0.7), (0.16, 1.1, 1.9), F.PLATE_CELL)
    # ammo drum on the flank (8-gon drum along X via limb in local coords)
    ax, ay, az = F.AMMO_DRUM
    limb(p, (ax - 0.30, ay, az), (ax + 0.30, ay, az), 0.58, 0.58, F.TANK_W,
         n=8, cap_start=F.C_TANK_CAP, cap_end=F.C_TANK_CAP)
    # rotary cluster: centre bore + 3 orbit tubes, muzzle caps
    from meshlib import tube
    tube(p, F.GUN_TUBE, F.GUN_W, n=8, cap_end=F.C_MUZZLE)
    for (ox, oy) in F.GUN_ORBITS:
        tube(p, [(-2.4, 0.16, oy), (-3.90, 0.16, oy)], F.GUN_W, n=6,
             xoff=ox, cap_end=F.C_MUZZLE)
    return p


def build_pauldron_free_local():
    p = Part('pauldron_free')
    w, h, d = F.PAULDRON_SIZE
    chamfer_box(p, (0, 0, 0), (w, h, d), 0.09,
                {'+y': F.C_PAULDRON, '-y': F.C_DARK,
                 '+x': F.C_PAULDRON_S, '-x': F.C_PAULDRON_S,
                 '+z': F.C_PAULDRON_S, '-z': F.C_PAULDRON_S})
    hx, hy, hz = F.PAULDRON_HORN
    spike(p, (hx, h / 2 - 0.05, hz), 0.48, 0.6, (0.18, hy + 0.45, -0.25),
          F.C_HORN)
    return p


def build_stack_free_local():
    p = Part('stack_free')
    drum_y(p, 0, 0, 0.0, F.STACK_H, F.STACK_R, F.STACK_W, cap_zone=F.C_STACK_TOP)
    drum_y(p, 0, 0, 0.5, 0.72, F.STACK_R * 1.18, F.STACK_W)
    torn_crown(p, 0, 0.0, 0, F.STACK_R, -0.18, n=8)   # torn base shards (down)
    return p


def build_foot_local():
    """Foot + welded toes + claws, ankle at local origin."""
    p = Part('foot')
    extrude_profile(p, F.FOOT_PROFILE, F.FOOT_HALF_W, F.C_FOOT_SIDE, F.FOOT_W)
    spike(p, (0, -0.80, 0.82), 0.66, 0.5, (0.0, -0.15, 0.95), F.C_HORN)
    ox, oy, oz = F.TOE_OFF
    extrude_profile(p, F.TOE_PROFILE, F.FOOT_HALF_W - 0.02, F.C_FOOT_SIDE,
                    F.FOOT_W, off=(oy, oz))
    for cx in (-0.55, 0.0, 0.55):
        spike(p, (cx, oy - 0.20, oz - 0.78), 0.42, 0.5, (0.0, -0.19, -0.70),
              F.C_HORN)
    return p


# ── legs (world coords) ──────────────────────────────────────────────────

def build_leg(p, hip, knee, ankle, foot_rot, foot_part, torn_hip=False):
    hip = np.asarray(hip, dtype=float)
    knee = np.asarray(knee, dtype=float)
    ankle = np.asarray(ankle, dtype=float)
    td = knee - hip
    limb(p, tuple(hip), tuple(knee), F.THIGH_R0, F.THIGH_R1, F.LIMB_W, n=8,
         cap_start=cap_zone_at(hip, F.THIGH_R0, td, F.DARK_CELL) if torn_hip
         else None)
    limb(p, tuple(knee), tuple(ankle), F.SHIN_R0, F.SHIN_R1, F.LIMB_W, n=8)
    # knee bearing: axle perpendicular to the leg plane
    sd = ankle - knee
    ax = np.cross(td, sd)
    if np.linalg.norm(ax) < 1e-6:
        ax = np.array([1.0, 0.0, 0.0])
    bearing(p, knee, ax, 0.58, 0.34)
    bearing(p, ankle, ax, 0.46, 0.28)
    merge(p, foot_part, rot_of(foot_rot), ankle)
    if torn_hip:
        # shard crown around the torn thigh root, opening away from the knee
        crown = Part('crown')
        torn_crown(crown, 0, 0, 0, F.THIGH_R0 * 0.98, 0.35, n=8)
        up = -td / np.linalg.norm(td)
        ref = np.array([1.0, 0.0, 0.0]) if abs(up[0]) < 0.9 else np.array([0.0, 0.0, 1.0])
        u = np.cross(up, ref)
        u /= np.linalg.norm(u)
        v = np.cross(up, u)
        R = np.column_stack([u, up, v])
        merge(p, crown, R, hip)
        # snapped hip piston sticking out
        limb(p, tuple(hip + up * 0.1), tuple(hip + up * 0.75 + u * 0.3),
             0.11, 0.09, F.PISTON_W, n=6,
             cap_end=cap_zone_at(hip + up * 0.75 + u * 0.3, 0.11,
                                 up * 0.65 + u * 0.3, F.DARK_CELL))


# ── assembly ─────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')

    # scorched ash pad
    w, h, d = F.PAD
    cx, cz = F.PAD_C
    cell_box(p, (cx, h / 2, cz), (w, h, d),
             {'top': F.PAD_T, 'side': F.PAD_S}, skip=('-y',))
    # pad top gets the world-window zone (scorch ring painted in place)
    # (cell_box already mapped it; overwrite: re-add top with world window)
    # -- simpler: leave cell mapping; painter paints the whole PAD_T cell.

    R_hulk, t_hulk = xf(F.HULK_ROT, F.HULK_T)
    merge(p, build_torso_local(), R_hulk, t_hulk)

    # pelvis
    t_pelvis = t_hulk + R_hulk @ np.asarray(F.PELVIS_LOCAL_OFF)
    merge(p, build_pelvis_local(), R_hulk, t_pelvis)

    # head, slumped chin-down ahead of the neck + torn neck hoses
    R_head, t_head = xf(F.HEAD_ROT, F.HEAD_T)
    merge(p, build_head_local(), R_head, t_head)
    neck_w = t_hulk + R_hulk @ np.array([0.0, 3.2, -2.1])
    hose(p, [tuple(neck_w), (2.6, 1.6, -2.2), tuple(t_head + np.array([0, 0.25, 0.5]))],
         0.13)
    hose(p, [tuple(neck_w + np.array([0.2, -0.3, 0.2])), (3.3, 1.2, -1.9),
             tuple(t_head + np.array([0.3, 0.1, 0.6]))], 0.09)

    # pack (half-crushed on the ground side of the hulk)
    t_pack = t_hulk + R_hulk @ np.asarray(F.PACK_OFF)
    merge(p, build_pack_local(), R_hulk, t_pack)

    # attached leg from the up-facing hip
    hip_up = t_pelvis + R_hulk @ np.asarray(F.HIP_LOCAL_UP)
    hip_axis = R_hulk @ np.array([1.0, 0.0, 0.0])
    bearing(p, hip_up, hip_axis, 0.66, 0.34)
    foot = build_foot_local()
    build_leg(p, tuple(hip_up), F.LEG_A_KNEE, F.LEG_A_ANKLE, F.FOOT_A_ROT, foot)

    # torn-off leg lying apart (own foot copy — merge reuses the part safely)
    build_leg(p, F.LEG_B_HIP, F.LEG_B_KNEE, F.LEG_B_ANKLE, F.FOOT_B_ROT, foot,
              torn_hip=True)

    # gun arm: shoulder bearing on the up side, upper arm down to the
    # sprawled rotary cannon
    shoulder = t_hulk + R_hulk @ np.asarray(F.ARM_OFF)
    bearing(p, shoulder, R_hulk @ np.array([0.0, 0.0, 1.0]), 0.62, 0.36)
    R_gun, t_gun = xf(F.GUN_ROT, F.GUN_T)
    elbow = t_gun + R_gun @ np.array([0.0, 0.35, 0.65])
    limb(p, tuple(shoulder), tuple(elbow), F.ARM_R0, F.ARM_R1, F.ARM_W, n=8)
    bearing(p, elbow, np.cross(elbow - shoulder, np.array([0, 1.0, 0])),
            0.52, 0.32)
    merge(p, build_gun_local(), R_gun, t_gun)

    # breakoff scatter
    merge(p, build_pauldron_free_local(), *xf(F.PAULDRON_FREE_ROT,
                                              F.PAULDRON_FREE_T))
    merge(p, build_stack_free_local(), *xf(F.STACK_FREE_ROT, F.STACK_FREE_T))
    for (px, py, pz, w, h, d, rspec) in F.SCATTER_PLATES:
        plate = Part('plate')
        cell_box(plate, (0, 0, 0), (w, h, d), F.PLATE_CELL)
        merge(p, plate, rot_of(rspec), (px, py, pz))
    for (px, py, pz, w, h, d, yaw) in F.RUBBLE:
        cell_box(p, (px, py, pz), (w, h, d), F.RUBBLE_CELL, yaw=yaw,
                 skip=('-y',))
    return p


def build_all():
    return [dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body())]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=[], normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=[], normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
