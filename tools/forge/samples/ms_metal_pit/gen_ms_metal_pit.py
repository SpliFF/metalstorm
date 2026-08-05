"""gen_ms_metal_pit — assemble ms_metal_pit and export .gltf/.bin.

Named resource site (spec: 15 m mine headframe with winding wheel, inclined
conveyor to a spoil heap, ore hopper, winch house, <=1800 tris, no team).
Two pieces: static `body` and the spinning `wheel` (idle spin clip, one full
turn about local +X per period).
Run: $PY gen_ms_metal_pit.py  -> out/ms_metal_pit{,_png}.gltf + .bin
"""
import numpy as np

import ms_metal_pit_layout as F        # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, chamfer_box, limb
from gltf_export import export
import parts as P

STEM = 'ms_metal_pit'
OUT = 'out'


def box(p, center, size, zone, ch=0.04, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def fhalf(y):
    """Headframe half-width at height y (legs splay base -> top)."""
    t = (y - F.PLATE_TOP) / (F.TOP_Y - F.PLATE_TOP)
    return F.BASE_H + (F.TOP_H - F.BASE_H) * t


def build_headframe(p):
    cx, cz = F.FRAME_C
    h0, h1 = fhalf(F.PLATE_TOP), fhalf(F.TOP_Y)
    # 4 splayed corner legs
    for sx in (-1, 1):
        for sz in (-1, 1):
            limb(p, (cx + sx * h0, F.PLATE_TOP, cz + sz * h0),
                 (cx + sx * h1, F.TOP_Y, cz + sz * h1),
                 F.LEG_R0, F.LEG_R1, F.R_LATTICE, n=4)
    # horizontal girt rings
    for gy in F.GIRT_YS:
        h = fhalf(gy)
        corners = [(cx - h, gy, cz - h), (cx + h, gy, cz - h),
                   (cx + h, gy, cz + h), (cx - h, gy, cz + h)]
        for i in range(4):
            limb(p, corners[i], corners[(i + 1) % 4],
                 F.GIRT_R, F.GIRT_R, F.R_LATTICE, n=4)
    # X-braces on all 4 faces of every bay
    levels = [F.PLATE_TOP + 0.05] + list(F.GIRT_YS) + [F.TOP_Y]
    for y0, y1 in zip(levels[:-1], levels[1:]):
        ha, hb = fhalf(y0), fhalf(y1)
        for ax, s in (('x', 1), ('x', -1), ('z', 1), ('z', -1)):
            def corner(y, h, side):
                if ax == 'z':
                    return (cx + side * h, y, cz + s * h)
                return (cx + s * h, y, cz + side * h)
            for d in (1, -1):
                limb(p, corner(y0, ha, d), corner(y1, hb, -d),
                     F.BRACE_R, F.BRACE_R, F.R_LATTICE, n=4)
    # raking back legs toward the winch house (+X), classic headgear read
    rtx, rty = F.RAKE_TOP
    for rz in F.RAKE_FOOT_ZS:
        limb(p, (F.RAKE_FOOT_X, F.PLATE_TOP, rz),
             (rtx, rty, cz + (rz - cz) * 0.12),
             F.RAKE_R0, F.RAKE_R1, F.R_STRUT, n=4)
    # cross tie between the rakes mid-height
    mt = 0.5
    ya = F.PLATE_TOP + (rty - F.PLATE_TOP) * mt
    xa = F.RAKE_FOOT_X + (rtx - F.RAKE_FOOT_X) * mt
    za0 = cz + (F.RAKE_FOOT_ZS[0] - cz) * (1 - mt * 0.88)
    za1 = cz + (F.RAKE_FOOT_ZS[1] - cz) * (1 - mt * 0.88)
    limb(p, (xa, ya, za0), (xa, ya, za1), 0.05, 0.05, F.R_STRUT, n=4)
    # wheel deck + axle bearing blocks
    x, y, z, w, h, d = F.DECK
    chamfer_box(p, (x, y, z), (w, h, d), 0.04,
                {'+y': F.R_DECK_T, '-y': F.R_DECK_T, '+x': F.R_DECK_S,
                 '-x': F.R_DECK_S, '+z': F.R_DECK_S, '-z': F.R_DECK_S})
    for sx in (-1, 1):
        box(p, (x + sx * F.AXLE_W / 2, 13.95, z), (0.22, 0.32, 0.5),
            F.R_STEELG, ch=0.03)
    # shaft collar under the tower
    box(p, F.COLLAR[:3], F.COLLAR[3:], F.R_COLLAR, ch=0.05, skip=('-y',))


def build_winch_house(p):
    x, y, z, w, h, d = F.WINCH
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+y': F.R_WINCH_R, '+x': F.R_WINCH_S, '-x': F.R_WINCH_S,
                 '+z': F.R_WINCH_F, '-z': F.R_WINCH_F}, skip=('-y',))
    x, y, z, w, h, d = F.WINCH_ROOF
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': F.R_WINCH_R, '-y': F.R_WINCH_R, '+x': F.R_WINCH_S,
                 '-x': F.R_WINCH_S, '+z': F.R_WINCH_F, '-z': F.R_WINCH_F})
    vx, vz = F.WINCH_VENT
    limb(p, (vx, 2.7, vz), (vx, 3.3, vz), 0.07, 0.07, F.R_TRIM,
         n=4, cap_end=F.R_DARK)
    # cable drum on the tower side (-X wall), axis Z
    dx, dy, dz = F.DRUM_C
    limb(p, (dx, dy, dz - F.DRUM_W / 2), (dx, dy, dz + F.DRUM_W / 2),
         F.DRUM_R, F.DRUM_R, F.R_CABLE, n=8,
         cap_start=F.R_DARK, cap_end=F.R_DARK)
    # drum cradle
    box(p, (dx, 0.62, dz), (0.5, 0.68, 1.1), F.R_STEELG, ch=0.03)
    # hoist cable: drum top -> wheel rim tangent, then down into the shaft
    wx, wy, wz = F.WHEEL_OFF
    limb(p, (dx, dy + F.DRUM_R * 0.9, dz),
         (wx + 0.35, wy + F.WHEEL_R * 0.92, wz),
         F.CABLE_R, F.CABLE_R, F.R_CABLE, n=3)
    limb(p, (wx - 0.3, wy + F.WHEEL_R * 0.9, wz),
         (wx - 0.35, 0.9, wz), F.CABLE_R, F.CABLE_R, F.R_CABLE, n=3)


def build_hopper(p):
    x, y, z, w, h, d = F.HOP_BIN
    box(p, (x, y, z), (w, h, d), F.R_HOP_S, ch=0.05)
    # ore fill visible at the bin top
    box(p, (x, y + h / 2 + 0.03, z), (w * 0.8, 0.1, d * 0.8), F.R_ORE,
        ch=0.02, skip=('-y',))
    # 4 legs
    for sx in (-1, 1):
        for sz in (-1, 1):
            limb(p, (x + sx * (w / 2 - 0.15), F.PLATE_TOP,
                     z + sz * (d / 2 - 0.15)),
                 (x + sx * (w / 2 - 0.15), y - h / 2 + 0.1,
                  z + sz * (d / 2 - 0.15)),
                 F.HOP_LEG_R, F.HOP_LEG_R, F.R_STRUT, n=4)
    # discharge chute
    box(p, F.HOP_CHUTE[:3], F.HOP_CHUTE[3:], F.R_HOP_S, ch=0.03)


def inclined_box(p, p0, p1, w, h, top_zone, side_zone):
    """Axis-oriented box from p0 to p1 (width w across, height h thick)."""
    a, b = np.asarray(p0, float), np.asarray(p1, float)
    d = b - a
    dn = d / np.linalg.norm(d)
    side = np.cross((0.0, 1.0, 0.0), dn)
    side /= np.linalg.norm(side)
    up = np.cross(dn, side)
    S, U = side * (w / 2), up * (h / 2)
    c = [a - S - U, a + S - U, a + S + U, a - S + U,
         b - S - U, b + S - U, b + S + U, b - S + U]
    c = [tuple(v) for v in c]
    p.add_face([c[3], c[2], c[6], c[7]], zone=top_zone)            # top
    p.add_face([c[1], c[0], c[4], c[5]], zone=top_zone)            # bottom
    p.add_face([c[0], c[3], c[7], c[4]], zone=side_zone)           # -side
    p.add_face([c[2], c[1], c[5], c[6]], zone=side_zone)           # +side
    p.add_face([c[0], c[1], c[2], c[3]], zone=side_zone)           # tail end
    p.add_face([c[5], c[4], c[7], c[6]], zone=side_zone)           # head end


def build_conveyor(p):
    p0, p1 = np.asarray(F.BELT_P0), np.asarray(F.BELT_P1)
    inclined_box(p, F.BELT_P0, F.BELT_P1, F.BELT_W, F.BELT_H,
                 F.R_BELT_T, F.R_BELT_S)
    # head/tail pulley drums (axis across the belt)
    for e, ext in ((p0, -0.25), (p1, 0.25)):
        limb(p, (e[0] - F.BELT_W / 2, e[1], e[2] - 0.05),
             (e[0] + F.BELT_W / 2, e[1], e[2] - 0.05),
             0.16, 0.16, F.R_TRIM, n=6, cap_start=F.R_DARK, cap_end=F.R_DARK)
    # A-frame support legs down to the plate
    for t in F.BELT_LEG_TS:
        s = p0 + (p1 - p0) * t
        for sx in (-1, 1):
            limb(p, (s[0] + sx * (F.BELT_W / 2 + 0.15), F.PLATE_TOP,
                     s[2] + 0.1),
                 (s[0] + sx * F.BELT_W * 0.3, s[1] - F.BELT_H / 2, s[2]),
                 0.07, 0.06, F.R_STRUT, n=4)


def build_heap(p):
    hx, hz = F.HEAP_C
    limb(p, (hx, F.PLATE_TOP - 0.02, hz), (hx, F.PLATE_TOP + F.HEAP_H, hz),
         F.HEAP_R, 0.2, F.R_HEAP.rect, n=F.HEAP_N, cap_end=F.R_ORE)
    # spill skirt: a low wide frustum ring at the base
    limb(p, (hx, F.PLATE_TOP - 0.02, hz), (hx, F.PLATE_TOP + 0.5, hz),
         F.HEAP_R * 1.25, F.HEAP_R * 0.92, F.R_HEAP.rect, n=F.HEAP_N)


def build_body():
    p = Part('body')
    x, y, z, w, h, d = F.PLATE
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+y': F.R_PLATE_T, '+x': F.R_PLATE_SX, '-x': F.R_PLATE_SX,
                 '+z': F.R_PLATE_SZ, '-z': F.R_PLATE_SZ}, skip=('-y',))
    build_headframe(p)
    build_winch_house(p)
    build_hopper(p)
    build_conveyor(p)
    build_heap(p)
    return p


def build_wheel():
    p = Part('wheel')
    P.wheel(p, (0.0, 0.0, 0.0), r=F.WHEEL_R, w=F.WHEEL_W,
            zone=F.R_WHEEL_S, n=F.WHEEL_N)
    # axle stubs through the deck bearings
    limb(p, (-F.AXLE_W / 2 - 0.06, 0, 0), (F.AXLE_W / 2 + 0.06, 0, 0),
         F.AXLE_R, F.AXLE_R, F.R_TRIM, n=4,
         cap_start=F.R_DARK, cap_end=F.R_DARK)
    return p


def qx(deg):
    r = np.radians(deg) / 2
    return (float(np.sin(r)), 0.0, 0.0, float(np.cos(r)))


def build_clips():
    T, N = F.SPIN_PERIOD, 12
    keys = [(T * i / N, qx(360.0 * i / N)) for i in range(N + 1)]
    # q(360) == -identity == identity pose: loop is seamless
    return [{'name': 'idle', 'channels': [('wheel', 'rotation', keys)]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='wheel', parent=0, offset=F.WHEEL_OFF, part=build_wheel()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=build_clips(),
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=build_clips(),
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
