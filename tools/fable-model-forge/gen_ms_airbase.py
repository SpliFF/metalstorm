"""gen_ms_airbase — assemble ms_airbase and export .gltf/.bin.

Air-forces factory: a flat 39.5 x 27.5 m concrete apron (top face gridded so
painted runway markings survive the impostor bake), an open-front corrugated
hangar along the +z edge (outer shell + dark inner shell + front rim + back
wall, hazard-banded door jambs), a corner lattice control tower (glazed cab,
red-amber beacon) topped by a spinning `dish` radar panel, plus windsock,
fuel drums, bowser and floodlight masts. NO turret/barrel/muzzle names.
Clip: idle = one full 360-degree dish yaw over 8 s (final key pre-negated).
Run: $PY gen_ms_airbase.py -> out/ms_airbase{,_png}.gltf + .bin
"""
import numpy as np

import ms_airbase_layout as F        # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, chamfer_box, limb
from gltf_export import export
import parts as P

STEM = 'ms_airbase'
OUT = 'out'
RNG = np.random.default_rng(90210)
ATLAS = 2048.0


def ruv(rect, u, v):
    """Map a (u, v) in 0..1 into an atlas rect, normalised for add_face."""
    x0, y0, x1, y1 = rect
    return ((x0 + u * (x1 - x0)) / ATLAS, (y0 + v * (y1 - y0)) / ATLAS)


def poly_out(p, verts, outward, zone):
    """Polygon wound so its (fan) normal points along `outward`."""
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, np.asarray(outward, float)) > 0
               else verts[::-1], zone=zone)


def quad_uv(p, verts, uvs, outward):
    """Quad with explicit uvs wound toward `outward` (uvs reversed with it)."""
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    if np.dot(n, np.asarray(outward, float)) > 0:
        p.add_face(verts, uvs=uvs)
    else:
        p.add_face(verts[::-1], uvs=uvs[::-1])


def build_apron(p):
    # slab: sides + chamfer only; the top is an explicit quad grid
    chamfer_box(p, (0, F.SLAB_H / 2, 0), (F.APRON_W, F.SLAB_H, F.APRON_D),
                F.SLAB_CH,
                {'+z': F.R_APRON_SX, '-z': F.R_APRON_SX,
                 '+x': F.R_APRON_SZ, '-x': F.R_APRON_SZ},
                skip=('+y', '-y'))
    hx = F.APRON_W / 2 - F.SLAB_CH
    hz = F.APRON_D / 2 - F.SLAB_CH
    gx = np.linspace(-hx, hx, F.GRID_NX + 1)
    gz = np.linspace(-hz, hz, F.GRID_NZ + 1)
    y = F.SLAB_H
    for i in range(F.GRID_NX):
        for j in range(F.GRID_NZ):
            P.quad_out(p, [(gx[i], y, gz[j]), (gx[i], y, gz[j + 1]),
                           (gx[i + 1], y, gz[j + 1]), (gx[i + 1], y, gz[j])],
                       (0, 1, 0), F.R_APRON)


def build_hangar(p):
    z0, z1 = F.HANG_Z0, F.HANG_Z1
    prof = F.PROF
    inner = [(x * F.INNER_SCALE, y * F.INNER_SCALE) for x, y in prof]
    zc = (z0 + z1) / 2
    for i in range(len(prof) - 1):
        (xa, ya), (xb, yb) = prof[i], prof[i + 1]
        (qa, ra), (qb, rb) = inner[i], inner[i + 1]
        va, vb = F.ARC_F[i], F.ARC_F[i + 1]
        mid = np.array([(xa + xb) / 2, (ya + yb) / 2, zc])
        out_dir = mid - np.array([0.0, 5.2, zc])
        # outer skin
        quad_uv(p, [(xa, ya, z0), (xa, ya, z1), (xb, yb, z1), (xb, yb, z0)],
                [ruv(F.R_ARCH, 0, va), ruv(F.R_ARCH, 1, va),
                 ruv(F.R_ARCH, 1, vb), ruv(F.R_ARCH, 0, vb)], out_dir)
        # inner skin (faces the interior)
        quad_uv(p, [(qa, ra, z0), (qa, ra, z1), (qb, rb, z1), (qb, rb, z0)],
                [ruv(F.R_INT, 0, va), ruv(F.R_INT, 1, va),
                 ruv(F.R_INT, 1, vb), ruv(F.R_INT, 0, vb)], -out_dir)
        # front rim fascia (faces -z, joins outer to inner at the opening)
        quad_uv(p, [(xa, ya, z0), (xb, yb, z0), (qb, rb, z0), (qa, ra, z0)],
                [ruv(F.R_RIM, va, 0), ruv(F.R_RIM, vb, 0),
                 ruv(F.R_RIM, vb, 1), ruv(F.R_RIM, va, 1)], (0, 0, -1))
    # back wall: outer face +z, inner face -z (amber work-glow zone)
    back = [(x, y, z1) for x, y in prof]
    poly_out(p, back, (0, 0, 1), F.R_BACK)
    poly_out(p, back, (0, 0, -1), F.R_GLOW)
    # hazard-banded door jambs at the opening
    for sx, zone in ((1, F.R_JAMB_A), (-1, F.R_JAMB_B)):
        w, h, d = F.JAMB_SIZE
        chamfer_box(p, (sx * F.JAMB_X, h / 2 + F.SLAB_H, F.JAMB_Z), (w, h, d),
                    0.04, {f: zone for f in ('+x', '-x', '+y', '+z', '-z')},
                    skip=('-y',))


def build_clutter(p):
    # fuel dump beside the tower
    P.drum_row(p, F.DRUM_ROW, count=4, r=0.34, h=1.0, zone=F.R_DRUM)
    P.drum_row(p, F.DRUM_ROW2, count=2, r=0.34, h=1.0, zone=F.R_DRUM)
    bx, by, bz, bw, bh, bd = F.BOWSER
    P.box6(p, (bx, by + F.SLAB_H, bz), (bw, bh, bd), F.R_BOWSER, ch=0.06,
           skip=('-y',))
    # floodlight masts at two apron corners
    for (mx, mz), zone in ((F.FLOOD_A, F.R_FLOOD_A), (F.FLOOD_B, F.R_FLOOD_B)):
        limb(p, (mx, F.SLAB_H, mz), (mx, F.FLOOD_H, mz), 0.09, 0.07,
             F.R_TRIM, n=4)
        P.box6(p, (mx, F.FLOOD_H + 0.25, mz - 0.05), (0.95, 0.5, 0.4), zone,
               ch=0.03)
    # windsock mast + cone
    sx, sy, sz = F.SOCK_BASE
    limb(p, (sx, F.SLAB_H, sz), (sx, F.SOCK_H, sz), 0.06, 0.05, F.R_TRIM, n=4)
    limb(p, (sx, F.SOCK_H - 0.05, sz), (sx + 0.95, F.SOCK_H - 0.28, sz + 0.3),
         0.22, 0.11, F.R_SOCK, n=6)


def build_base():
    p = Part('base')
    build_apron(p)
    build_hangar(p)
    build_clutter(p)
    return p


def build_tower():
    t = Part('tower')
    x, y, z, w, h, d = F.T_PAD
    chamfer_box(t, (x, y, z), (w, h, d), 0.05,
                {'+y': F.R_PADT, '+x': F.R_PADS_F, '-x': F.R_PADS_F,
                 '+z': F.R_PADS, '-z': F.R_PADS}, skip=('-y',))
    P.lattice_tower(t, F.T_LAT_BASE_Y, F.T_LAT_TOP_Y, F.T_LAT_HB, F.T_LAT_HT,
                    bands=2, leg_zone=F.R_LEG, brace_zone=F.R_TRIM)
    x, y, z, w, h, d = F.T_FLOOR
    chamfer_box(t, (x, y, z), (w, h, d), 0.04,
                {'+x': F.R_SLAB, '-x': F.R_SLAB, '+z': F.R_SLAB_F,
                 '-z': F.R_SLAB_F, '+y': F.R_CAB_T, '-y': F.R_DARKZ})
    x, y, z, w, h, d = F.T_CAB
    chamfer_box(t, (x, y, z), (w, h, d), 0.04,
                {'+x': F.R_CAB, '-x': F.R_CAB, '+z': F.R_CAB_F,
                 '-z': F.R_CAB_F}, skip=('+y', '-y'))
    x, y, z, w, h, d = F.T_ROOF
    chamfer_box(t, (x, y, z), (w, h, d), 0.04,
                {'+y': F.R_CAB_T, '-y': F.R_DARKZ, '+x': F.R_ROOFE,
                 '-x': F.R_ROOFE, '+z': F.R_ROOFE_F, '-z': F.R_ROOFE_F})
    P.ladder(t, (0, F.T_LAT_BASE_Y, -1.75), (0, F.T_LAT_TOP_Y, -1.08),
             zone=F.R_TRIM)
    # radar mast (dish piece sits on top)
    limb(t, (0, F.MAST_Y0, 0), (0, F.MAST_Y1, 0), 0.07, 0.05, F.R_TRIM, n=4)
    # red-amber beacon on the roof corner
    b = F.BEACON_XZ
    limb(t, (b, 12.95, b), (b, F.BEACON_MAST_Y1, b), 0.035, 0.03, F.R_TRIM, n=3)
    P.beacon(t, F.BEACON_C, F.BEACON_S, glow_zone=F.R_BEACON)
    return t


def build_dish():
    d = Part('dish')
    # hub over the mast top
    limb(d, (0, -0.15, 0), (0, 0.14, 0), 0.09, 0.08, F.R_DISHR, n=4)
    # radar panel: planar rectangle, double-sided (same plane, both windings)
    verts = [(-1.3, 0.12, -0.02), (1.3, 0.12, -0.02),
             (1.3, 0.95, -0.16), (-1.3, 0.95, -0.16)]
    d.add_face(verts, zone=F.R_DISHP)            # one side
    d.add_face(verts[::-1], zone=F.R_DISHP)      # other side
    # support braces from the hub to the panel back
    for sxx in (-1, 1):
        limb(d, (0, 0.02, 0.02), (sxx * 0.85, 0.55, -0.09), 0.04, 0.03,
             F.R_DISHR, n=3)
    return d


def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    """idle: one full 360-degree dish yaw over 8 s. qy(360) = (0,0,0,-1) —
    the pre-negated final key, so every consecutive pair keeps a positive
    dot product and Babylon slerps forward the whole way."""
    keys = [(8.0 * i / 4, qy(90.0 * i)) for i in range(5)]
    return [{'name': 'idle', 'channels': [('dish', 'rotation', keys)]}]


def build_all():
    return [
        dict(name='base', parent=-1, offset=(0, 0, 0), part=build_base()),
        dict(name='tower', parent=0, offset=F.TOWER_OFF, part=build_tower()),
        dict(name='dish', parent=1, offset=F.DISH_OFF, part=build_dish()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=build_clips(),
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=build_clips(),
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'TOTAL: {total} tris')
