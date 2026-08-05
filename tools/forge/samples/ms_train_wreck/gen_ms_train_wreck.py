"""gen_ms_train_wreck — assemble ms_train_wreck and export .gltf/.bin.

Wreck set: derailed fable_train cargo car (dims/gauge from
$TOOLKIT/train_layout.py) tipped onto its side at an angle beside a
torn-up track section — ballast bed, sleepers, straight rails that
stop at a gap where bent rail segments curl up and outward — with
spilled crates (parts.crate_stack + loose rolled singles), buckled
torn hull plates and (painted) scorch.  Static: one `body` piece,
no clips, no team colour.
Run: $PY gen_ms_train_wreck.py → out/ms_train_wreck{,_png}.gltf + .bin
"""
import numpy as np

import ms_train_wreck_layout as F      # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, ngon_ring, limb
from gltf_export import export
import parts as PP

STEM = 'ms_train_wreck'
OUT = 'out'


# ── rotated-box helper (face-local UVs, so any pose is free) ────────────

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


def rot(yaw=0.0, pitch=0.0, roll=0.0):
    """R = Ry(yaw) @ Rx(pitch) @ Rz(roll), degrees."""
    a, b, c = np.radians([yaw, pitch, roll])
    Ry = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0],
                   [-np.sin(a), 0, np.cos(a)]])
    Rx = np.array([[1, 0, 0], [0, np.cos(b), -np.sin(b)],
                   [0, np.sin(b), np.cos(b)]])
    Rz = np.array([[np.cos(c), -np.sin(c), 0],
                   [np.sin(c), np.cos(c), 0], [0, 0, 1]])
    return Ry @ Rx @ Rz


def make_xf(R, t):
    R = np.asarray(R)
    t = np.asarray(t, dtype=float)

    def xf(v):
        return tuple(R @ np.asarray(v, dtype=float) + t)
    return xf


def tbox(p, xf, center, size, side_cell, top_cell=None, skip=()):
    """Box authored in local coords, pushed through xf; face-local UVs
    onto full cells, so all instances share painted cells regardless of
    pose."""
    top_cell = top_cell or side_cell
    cx, cy, cz = center
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    for key, (signs, uvp) in _FACES.items():
        if key in skip:
            continue
        cell = top_cell if key in ('+y', '-y') else side_cell
        x0, y0, x1, y1 = cell
        us, vs = (x0, x1), (y0, y1)
        verts = [xf((cx + sx * hx, cy + sy * hy, cz + sz * hz))
                 for (sx, sy, sz) in signs]
        uvs = [_uv(us[i], vs[j]) for (i, j) in uvp]
        p.add_face(verts, uvs=uvs)


def twheel(p, xf, center, r, hw, n=8):
    """8-gon wheel, axis local X, pushed through xf."""
    cx, cy, cz = center
    ra = [xf(v) for v in ngon_ring((cx - hw, cy, cz), r, n=n, axis='x')]
    rb = [xf(v) for v in ngon_ring((cx + hw, cy, cz), r, n=n, axis='x')]
    wx0, wy0, wx1, wy1 = F.WHEEL_W
    ctr_a = np.mean(np.array(ra), axis=0)
    ctr_b = np.mean(np.array(rb), axis=0)
    for j in range(n):
        k = (j + 1) % n
        quad = [ra[j], ra[k], rb[k], rb[j]]
        u0 = (wx0 + (wx1 - wx0) * j / n) / M.ATLAS
        u1 = (wx0 + (wx1 - wx0) * (j + 1) / n) / M.ATLAS
        uvs = [(u0, wy1 / M.ATLAS), (u1, wy1 / M.ATLAS),
               (u1, wy0 / M.ATLAS), (u0, wy0 / M.ATLAS)]
        cq = np.mean(np.array(quad), axis=0)
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        if np.dot(nrm, cq - (ctr_a + ctr_b) / 2) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)
    # hub caps mapped onto the full HUB cell
    hx0, hy0, hx1, hy1 = F.HUB
    for ring, ctr, out_local in ((ra, ctr_a, (-1, 0, 0)),
                                 (rb, ctr_b, (1, 0, 0))):
        out = np.asarray(xf(np.asarray(center) + out_local)) - \
            np.asarray(xf(center))
        uvs = []
        for i in range(len(ring)):
            t = 2 * np.pi * (i + 0.5) / len(ring)
            uvs.append(_uv((hx0 + hx1) / 2 + (hx1 - hx0) * 0.48 * np.cos(t),
                           (hy0 + hy1) / 2 + (hy1 - hy0) * 0.48 * np.sin(t)))
        nrm = np.cross(np.asarray(ring[1]) - np.asarray(ring[0]),
                       np.asarray(ring[2]) - np.asarray(ring[0]))
        if np.dot(nrm, out) < 0:
            ring = ring[::-1]
            uvs = uvs[::-1]
        p.add_face(list(ring), uvs=uvs)


# ── track section ───────────────────────────────────────────────────────

def build_track(p):
    ident = make_xf(np.eye(3), (0, 0, 0))
    # ballast bed
    tbox(p, ident, (0, F.BAL_H / 2, 0), (F.BAL_W, F.BAL_H, F.TRACK_L),
         F.BAL_S, F.BAL_T, skip=('-y',))
    # sleepers — ripped sideways/tilted inside the tear
    sw, sh, sd = F.SLEEP_SZ
    rng = np.random.default_rng(90210)
    for i in range(F.N_SLEEP):
        z = F.SLEEP_Z0 + i * F.SLEEP_DZ
        torn = F.TEAR_Z0 - 0.7 < z < F.TEAR_Z1 + 0.7
        yaw = rng.uniform(-24, 24) if torn else rng.uniform(-1.5, 1.5)
        pit = rng.uniform(-10, 14) if torn else 0.0
        dx = rng.uniform(-0.8, 0.8) if torn else 0.0
        dy = rng.uniform(0.0, 0.22) if torn else 0.0
        xf = make_xf(rot(yaw=yaw, pitch=pit), (dx, 0, 0))
        tbox(p, xf, (0, F.BAL_H + sh / 2 + dy, z), (sw, sh, sd),
             F.SLEEP_T, F.SLEEP_T, skip=('-y',))
    # straight rails outside the tear
    rw, rh = F.RAIL_SZ
    ry = F.BAL_H + sh + rh / 2
    for sx in (-F.RAIL_X, F.RAIL_X):
        for (z0, z1) in ((-F.TRACK_L / 2, F.TEAR_Z0),
                         (F.TEAR_Z1, F.TRACK_L / 2)):
            tbox(p, ident, (sx, ry, (z0 + z1) / 2), (rw, rh, z1 - z0),
                 F.RAIL_S, F.RAIL_S, skip=('-y',))
    # bent rail ends curling up/outward into the gap (toward the car side)
    for (sx, segs) in (
        (F.RAIL_X, [((0, 0), 12, 22, 1.9), ((0, 0), 34, 48, 1.7),
                    ((0, 0), 55, 70, 1.4)]),
        (-F.RAIL_X, [((0, 0), 8, -14, 1.8), ((0, 0), 22, -30, 1.5)]),
    ):
        base = np.array([sx, ry, F.TEAR_Z0])
        for (_, pit, yaw, ln) in segs:
            R = rot(yaw=yaw, pitch=-pit)
            xf = make_xf(R, base)
            tbox(p, xf, (0, 0, ln / 2), (rw, rh, ln), F.RAIL_S, F.RAIL_S)
            base = base + R @ np.array([0, 0, ln])
    # one short bent stub from the far end of the tear
    R = rot(yaw=195, pitch=-18)
    tbox(p, make_xf(R, (F.RAIL_X, ry, F.TEAR_Z1)), (0, 0, 1.0),
         (rw, rh, 2.0), F.RAIL_S, F.RAIL_S)


# ── the derailed cargo car ──────────────────────────────────────────────

def car_extreme_points():
    """Local-frame sample points that can touch the ground once posed."""
    pts = []
    for sx in (-F.HULL_W / 2, F.HULL_W / 2):
        for sy in (F.HULL_BOT, F.CARGO_WALL):
            for sz in (-F.CAR_HL, F.CAR_HL):
                pts.append((sx, sy, sz))
    for az in F.CAR_AXLES:
        for sx in (-F.WHEEL_X - F.WHEEL_HW, F.WHEEL_X + F.WHEEL_HW):
            for (dy, dz) in ((-F.WHEEL_R, 0), (F.WHEEL_R, 0),
                             (0, -F.WHEEL_R), (0, F.WHEEL_R)):
                pts.append((sx, F.WHEEL_R + dy, az + dz))
    for sz in (-F.CAR_HL - 0.85, F.CAR_HL + 0.85):
        pts.append((0, F.LINK_Y, sz))
    return np.array(pts, dtype=float)


def build_car(p):
    R = rot(yaw=F.CAR_YAW, pitch=F.CAR_PITCH, roll=F.CAR_ROLL)
    # solve rest height: lowest posed sample point sits just in the dirt
    low = (R @ car_extreme_points().T).T[:, 1].min()
    cx, cz = F.CAR_POS
    xf = make_xf(R, (cx, -low - 0.06, cz))

    # hull (bed slab between HULL_BOT and CARGO_BED)
    tbox(p, xf, (0, (F.HULL_BOT + F.CARGO_BED) / 2, 0),
         (F.HULL_W, F.CARGO_BED - F.HULL_BOT, F.CAR_HL * 2),
         F.HULL_S, F.HULL_T)
    # underframe box
    tbox(p, xf, (0, F.HULL_BOT / 2 + 0.18, 0),
         (F.HULL_W - 1.4, 0.7, F.CAR_HL * 2 - 1.2), F.UNDER, F.UNDER)
    # armored stake walls (open top) — one side wall torn short + skewed
    wall_h = F.CARGO_WALL - F.CARGO_BED
    wy = (F.CARGO_BED + F.CARGO_WALL) / 2
    tbox(p, xf, (-2.0, wy, 0), (0.2, wall_h, F.CAR_HL * 2 - 0.6),
         F.HULL_S, F.HULL_S)                      # intact (ground-side) wall
    tbox(p, xf, (2.0, wy, 3.3), (0.2, wall_h, F.CAR_HL * 2 - 7.2),
         F.HULL_S, F.HULL_S)                      # torn (sky-side) wall
    Rt = R @ rot(roll=-38, yaw=9)
    xft = make_xf(Rt, xf((2.05, F.CARGO_BED + 0.1, -4.6)))
    tbox(p, xft, (0, wall_h / 2 - 0.1, 0), (0.2, wall_h, 2.6),
         F.PLATE, F.PLATE)                        # peeled wall flap
    # end walls
    for s in (1, -1):
        tbox(p, xf, (0, wy, s * (F.CAR_HL - 0.35)), (4.0, wall_h, 0.2),
             F.HULL_E, F.HULL_E)
    # stake ribs on the intact wall (silhouette)
    for rz in (-6.2, -3.1, 0.0, 3.1, 6.2):
        tbox(p, xf, (-2.12, wy, rz), (0.14, wall_h + 0.2, 0.3),
             F.UNDER, F.UNDER)
    # couplers both ends
    for s in (1, -1):
        tbox(p, xf, (0, F.LINK_Y, s * (F.CAR_HL + 0.35)), (0.6, 0.5, 0.8),
             F.COUP, F.COUP)
        tbox(p, xf, (0, F.LINK_Y, s * (F.CAR_HL + 0.05)), (1.5, 0.9, 0.4),
             F.COUP, F.COUP)
    # wheelsets + axle beams
    for az in F.CAR_AXLES:
        for sx in (-F.WHEEL_X, F.WHEEL_X):
            twheel(p, xf, (sx, F.WHEEL_R, az), F.WHEEL_R, F.WHEEL_HW)
        tbox(p, xf, (0, F.WHEEL_R, az), (3.9, 0.34, 0.34), F.UNDER, F.UNDER)
    return xf


# ── spilled cargo + debris ──────────────────────────────────────────────

def build_debris(p):
    rng = np.random.default_rng(90210)
    PP.crate_stack(p, F.CRATE_STACK_ORIGIN, rows=2, cols=3, tiers=1,
                   size=1.0, jitter=0.34, zone=F.Z_CRATE, rng=rng)
    for (cx, cz, s, yaw, roll) in F.LOOSE_CRATES:
        h = s / 2 if roll == 0 else s * 0.68
        xf = make_xf(rot(yaw=yaw, roll=roll), (cx, h, cz))
        tbox(p, xf, (0, 0, 0), (s, s, s), F.CRATE_S, F.CRATE_T)
    for (cx, cy, cz, w, d, yaw, pit, roll) in F.PLATES:
        xf = make_xf(rot(yaw=yaw, pitch=pit, roll=roll), (cx, cy + 0.1, cz))
        tbox(p, xf, (0, 0, 0), (w, 0.06, d), F.PLATE, F.PLATE)


def build_body():
    p = Part('body')
    build_track(p)
    build_car(p)
    build_debris(p)
    return p


def build_all():
    return [dict(name='body', parent=-1, offset=(0, 0, 0),
                 part=build_body())]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=[],
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=[],
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
