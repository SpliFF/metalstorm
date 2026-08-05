"""gen_ms_meeting_hall — assemble ms_meeting_hall and export .gltf/.bin.

Civilian gabled meeting hall (18x12 m): timber walls with gable ends,
double-sided roof slopes with overhang, front porch (deck, posts, shed
roof, steps), noticeboard, and a bell tower whose `bell` piece carries
a small idle sway clip. Everything else lives on `body`.
Run: build.sh . ms_meeting_hall 1500 bell --no-team
"""
import numpy as np

import ms_meeting_hall_layout as F      # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, chamfer_box, limb
from gltf_export import export

STEM = 'ms_meeting_hall'
OUT = 'out'


def zbox(rect, center, size, m=0.06):
    """Anchored 6-face zone dict for a prop box (see ms_command_post)."""
    cx, cy, cz = center
    hx, hy, hz = size[0] / 2 + m, size[1] / 2 + m, size[2] / 2 + m
    return {
        '+x': Zone(rect, ('z', 'y'), ((cz - hz, cz + hz), (cy + hy, cy - hy))),
        '-x': Zone(rect, ('z', 'y'), ((cz - hz, cz + hz), (cy + hy, cy - hy))),
        '+z': Zone(rect, ('x', 'y'), ((cx - hx, cx + hx), (cy + hy, cy - hy))),
        '-z': Zone(rect, ('x', 'y'), ((cx - hx, cx + hx), (cy + hy, cy - hy))),
        '+y': Zone(rect, ('x', 'z'), ((cx - hx, cx + hx), (cz - hz, cz + hz))),
        '-y': Zone(rect, ('x', 'z'), ((cx - hx, cx + hx), (cz - hz, cz + hz))),
    }


def dbl(p, quad, zone):
    """Double-sided planar quad."""
    p.add_face(quad, zone=zone)
    p.add_face(quad, zone=zone, flip=True)


def build_body():
    p = Part('body')
    zc = (F.HALL_Z0 + F.HALL_Z1) / 2
    zd = F.HALL_Z1 - F.HALL_Z0

    # main hall walls up to the eave
    chamfer_box(p, (0.0, F.EAVE_Y / 2, zc), (F.HALL_W, F.EAVE_Y, zd), 0.08,
                {'+x': F.C_WALL_S, '-x': F.C_WALL_S, '-z': F.C_WALL_F,
                 '+z': F.C_WALL_R, '+y': F.C_ROOF}, skip=('-y',))

    # gable-end triangles (x = +-9), textured with the side-wall zone
    for sx, flip in ((9.0, False), (-9.0, True)):
        tri = [(sx, F.EAVE_Y - 0.02, F.HALL_Z0), (sx, F.EAVE_Y - 0.02, F.HALL_Z1),
               (sx, F.RIDGE_Y, F.RIDGE_Z)]
        p.add_face(tri, zone=F.C_WALL_S, flip=flip)

    # roof slopes (double-sided planes with overhang past the gables)
    ey = F.EAVE_Y - 0.05
    ry = F.RIDGE_Y + 0.10
    front = [(F.ROOF_X0, ey, F.HALL_Z0 - F.OVER), (F.ROOF_X1, ey, F.HALL_Z0 - F.OVER),
             (F.ROOF_X1, ry, F.RIDGE_Z), (F.ROOF_X0, ry, F.RIDGE_Z)]
    rear = [(F.ROOF_X0, ry, F.RIDGE_Z), (F.ROOF_X1, ry, F.RIDGE_Z),
            (F.ROOF_X1, ey, F.HALL_Z1 + F.OVER), (F.ROOF_X0, ey, F.HALL_Z1 + F.OVER)]
    dbl(p, front, F.C_ROOF)
    dbl(p, rear, F.C_ROOF)
    # ridge cap strip
    chamfer_box(p, (0.0, ry + 0.02, F.RIDGE_Z), (F.HALL_W + 2 * F.OVER, 0.12, 0.35),
                0.02, {'+y': F.C_ROOF, '+z': F.C_ROOF, '-z': F.C_ROOF,
                       '+x': F.C_ROOF, '-x': F.C_ROOF}, skip=('-y',))

    # ── porch: deck, steps, posts, shed roof ──
    chamfer_box(p, (0.0, F.PORCH_FLOOR_Y / 2, (F.PORCH_Z0 + F.PORCH_Z1) / 2),
                (F.HALL_W - 1.0, F.PORCH_FLOOR_Y, F.PORCH_Z1 - F.PORCH_Z0), 0.04,
                {'+y': F.C_PORCHF, '-z': zbox(F.C_STEP, (0, 0.14, -6.0), (17, 0.28, 0.4))['-z'],
                 '+x': zbox(F.C_STEP, (8.5, 0.14, -4.75), (0.4, 0.28, 2.5))['+x'],
                 '-x': zbox(F.C_STEP, (-8.5, 0.14, -4.75), (0.4, 0.28, 2.5))['-x']},
                skip=('-y', '+z'))
    # steps down at the door
    chamfer_box(p, (0.0, 0.08, F.PORCH_Z0 - 0.45), (3.4, 0.16, 0.9), 0.03,
                zbox(F.C_STEP, (0.0, 0.08, F.PORCH_Z0 - 0.45), (3.4, 0.16, 0.9)),
                skip=('-y',))
    # posts + beam + shed roof
    for px in F.PORCH_POST_X:
        limb(p, (px, F.PORCH_FLOOR_Y, F.PORCH_POST_Z),
             (px, F.PORCH_ROOF_LO + 0.05, F.PORCH_POST_Z), 0.10, 0.09,
             F.C_MAST, n=4)
    limb(p, (-8.6, F.PORCH_ROOF_LO + 0.02, F.PORCH_POST_Z),
         (8.6, F.PORCH_ROOF_LO + 0.02, F.PORCH_POST_Z), 0.09, 0.09,
         F.C_MAST, n=4)
    proof = [(-9.3, F.PORCH_ROOF_LO + 0.12, F.PORCH_Z0 - 0.35),
             (9.3, F.PORCH_ROOF_LO + 0.12, F.PORCH_Z0 - 0.35),
             (9.3, F.PORCH_ROOF_HI, F.PORCH_Z1 + 0.05),
             (-9.3, F.PORCH_ROOF_HI, F.PORCH_Z1 + 0.05)]
    dbl(p, proof, F.C_PROOF)

    # noticeboard on the front wall
    nx, ny, nz, nw, nh, nd = F.NOTICE
    chamfer_box(p, (nx, ny, nz), (nw, nh, nd), 0.02,
                zbox(F.C_NOTICE, (nx, ny, nz), (nw, nh, nd)), skip=('+z',))

    # ── bell tower ──
    chamfer_box(p, (F.TWR_X, F.TWR_TOP / 2, F.TWR_Z),
                (F.TWR_SZ, F.TWR_TOP, F.TWR_SZ), 0.05,
                zbox(F.C_TOWER, (F.TWR_X, F.TWR_TOP / 2, F.TWR_Z),
                     (F.TWR_SZ, F.TWR_TOP, F.TWR_SZ)), skip=('-y',))
    # belfry corner posts (open stage the bell hangs in)
    h = F.TWR_SZ / 2 - 0.10
    for dx in (-h, h):
        for dz in (-h, h):
            limb(p, (F.TWR_X + dx, F.TWR_TOP - 0.05, F.TWR_Z + dz),
                 (F.TWR_X + dx, F.BELFRY_TOP, F.TWR_Z + dz), 0.07, 0.06,
                 F.C_MAST, n=4)
    # pyramid cap (4 triangles + skirt underside left open)
    a = (F.TWR_X, F.CAP_APEX, F.TWR_Z)
    c = F.CAP_HALF
    by = F.BELFRY_TOP
    zt = Zone(F.C_TROOF, ('x', 'z'),
              ((F.TWR_X - c, F.TWR_X + c), (F.TWR_Z - c, F.TWR_Z + c)))
    corners = [(F.TWR_X - c, by, F.TWR_Z - c), (F.TWR_X + c, by, F.TWR_Z - c),
               (F.TWR_X + c, by, F.TWR_Z + c), (F.TWR_X - c, by, F.TWR_Z + c)]
    for i in range(4):
        p.add_face([corners[i], corners[(i + 1) % 4], a], zone=zt, flip=True)
        p.add_face([corners[i], corners[(i + 1) % 4], a], zone=zt)
    return p


def build_bell():
    """Bell cloth-of-metal: tapered rings hung from the piece origin
    (pivot at the headstock) plus a clapper stub. Piece-local coords."""
    p = Part('bell')
    # headstock bar between the belfry posts
    limb(p, (-0.35, 0.02, 0.0), (0.35, 0.02, 0.0), 0.045, 0.045,
         F.C_MAST, n=4)
    # bell: crown -> waist -> mouth flare
    limb(p, (0.0, -0.02, 0.0), (0.0, -0.24, 0.0), 0.095, 0.155,
         F.C_BELL, n=8)
    limb(p, (0.0, -0.24, 0.0), (0.0, -0.42, 0.0), 0.155, 0.235,
         F.C_BELL, n=8, cap_end=F.C_DARK)
    # clapper
    limb(p, (0.0, -0.30, 0.0), (0.0, -0.50, 0.0), 0.028, 0.05,
         F.C_MAST, n=4, cap_end=F.C_DARK)
    return p


def qz(deg):
    r = np.radians(deg) / 2
    return (0.0, 0.0, float(np.sin(r)), float(np.cos(r)))


def build_clips():
    """Idle: tiny lazy sway of the bell about Z (side to side along the
    headstock). Seamless loop, last key repeats the first."""
    T = 4.0
    angs = [0.0, 2.5, 4.0, 2.0, 0.0, -2.5, -4.0, -2.0, 0.0]
    n = len(angs)
    rot = [(T * i / (n - 1), qz(a)) for i, a in enumerate(angs)]
    return [{'name': 'idle', 'channels': [('bell', 'rotation', rot)]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='bell', parent=0, offset=F.BELL_OFF, part=build_bell()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_meeting_hall] total tris: {total}')
