"""gen_ms_radar_s3 — assemble ms_radar_s3 (Coastal Surveillance Array).

Radar s3, STYLE.md height 8 m, budget <=2000 tris. Combined air/sea watch
post: anchored pad + low equipment plinth, two salvaged container cabins
(ladder up one, sonar winch drum + fairlead + stowed hydrophone head on the
roofs), a heavy braced tower with a caged ladder, and — the piece that makes
this tier unmistakable — a rotating flat PLANAR ARRAY BAR (`dish`) on a slew
collar at the tower head. UNARMED: no turret/barrel/muzzle chain.
Run: python3 gen_ms_radar_s3.py -> out/ms_radar_s3{,_png}.gltf + .bin
"""
import numpy as np

import ms_radar_s3_layout as F      # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, Zone, chamfer_box, limb
import parts as P
from gltf_export import export

STEM = 'ms_radar_s3'
OUT = 'out'
RNG = np.random.default_rng(90210)

ALL = ('+y', '-y', '+x', '-x', '+z', '-z')


def lightbox(p, centre, size=0.20):
    chamfer_box(p, centre, (size, size, size), size * 0.16,
                {k: F.R_LIGHT for k in ALL}, skip=('-y',))


def pin_uvs():
    x0, y0, x1, y1 = F.PIN
    A = M.ATLAS
    return [(x0 / A, y0 / A), (x0 / A, y1 / A), (x1 / A, y1 / A), (x1 / A, y0 / A)]


def quad(p, verts, outward, uvs):
    a, b, c = [np.asarray(v, float) for v in verts[:3]]
    n = np.cross(b - a, c - a)
    if float(np.dot(n, np.asarray(outward, float))) < 0:
        verts, uvs = verts[::-1], uvs[::-1]
    p.add_face(verts, uvs=uvs)


def slot_box(p, cx, cy, zf, w, h, d):
    """Shallow array-element box protruding toward -Z from the panel face.
    Front quad samples R_ARRAY_F (so the painted element cell lines up);
    the four thin side walls are pinned to a flat dark UV square."""
    x0, x1 = cx - w / 2, cx + w / 2
    y0, y1 = cy - h / 2, cy + h / 2
    z1 = zf - d
    p.add_face([(x0, y0, z1), (x0, y1, z1), (x1, y1, z1), (x1, y0, z1)],
               zone=F.R_ARRAY_F)
    u = pin_uvs()
    quad(p, [(x0, y1, zf), (x0, y1, z1), (x1, y1, z1), (x1, y1, zf)], (0, 1, 0), u)
    quad(p, [(x0, y0, zf), (x0, y0, z1), (x1, y0, z1), (x1, y0, zf)], (0, -1, 0), u)
    quad(p, [(x0, y0, zf), (x0, y0, z1), (x0, y1, z1), (x0, y1, zf)], (-1, 0, 0), u)
    quad(p, [(x1, y0, zf), (x1, y0, z1), (x1, y1, z1), (x1, y1, zf)], (1, 0, 0), u)


# ───────────────────────────────────────────────────────────── body ──────
def build_body():
    p = Part('body')

    # anchored pad + low equipment plinth
    x, y, z, w, h, d = F.PAD
    chamfer_box(p, (x, y, z), (w, h, d), 0.07,
                {'+y': F.R_PAD, '+x': F.R_PADS, '-x': F.R_PADS,
                 '+z': F.R_PADS_F, '-z': F.R_PADS_F}, skip=('-y',))
    x, y, z, w, h, d = F.PLINTH
    chamfer_box(p, (x, y, z), (w, h, d), 0.04,
                {'+y': F.R_PAD, '+x': F.R_PLI, '-x': F.R_PLI,
                 '+z': F.R_PLI_F, '-z': F.R_PLI_F}, skip=('-y',))

    # two salvaged container cabins bolted side by side
    for cx in (F.CAB_AX, F.CAB_BX):
        chamfer_box(p, (cx, F.CAB_CY, F.CAB_CZ), (F.CAB_W, F.CAB_H, F.CAB_D), 0.05,
                    {'+x': F.R_CAB_S, '-x': F.R_CAB_S, '+z': F.R_CAB_F,
                     '-z': F.R_CAB_F, '+y': F.R_CAB_T}, skip=('-y',))
    # roof-access ladder up cabin A's front face
    P.ladder(p, (F.CAB_AX - 0.55, F.PLINTH_TOP, F.CAB_CZ - F.CAB_D / 2 - 0.07),
             (F.CAB_AX - 0.55, F.CAB_TOP + 0.10, F.CAB_CZ - F.CAB_D / 2 - 0.07),
             width=0.44, zone=F.R_TRIM)
    # amber status lamp on each cabin roof edge
    lightbox(p, (F.CAB_AX - 0.95, F.CAB_TOP + 0.10, F.CAB_CZ - 0.42), 0.20)
    lightbox(p, (F.CAB_BX + 0.95, F.CAB_TOP + 0.10, F.CAB_CZ - 0.42), 0.20)

    # ── sonar winch on cabin B's roof: side frames, drum, wound cable ────
    for fx in (F.DRUM_X0 - 0.10, F.DRUM_X1 + 0.10):
        chamfer_box(p, (fx, F.CAB_TOP + 0.22, F.CAB_CZ), (0.14, 0.44, 0.62), 0.03,
                    {'+x': F.R_CAB_S, '-x': F.R_CAB_S, '+z': F.R_CAB_F,
                     '-z': F.R_CAB_F, '+y': F.R_CAB_T}, skip=('-y',))
    y = F.WINCH_Y
    limb(p, (F.DRUM_X0, y, F.CAB_CZ), (F.DRUM_X0 + 0.09, y, F.CAB_CZ),
         F.DRUM_R, F.DRUM_R, F.R_DRUM, n=10, cap_start=F.R_DARK)
    limb(p, (F.DRUM_X0 + 0.09, y, F.CAB_CZ), (F.DRUM_X1 - 0.09, y, F.CAB_CZ),
         F.CABLE_R, F.CABLE_R, F.R_CABLE, n=10)
    limb(p, (F.DRUM_X1 - 0.09, y, F.CAB_CZ), (F.DRUM_X1, y, F.CAB_CZ),
         F.DRUM_R, F.DRUM_R, F.R_DRUM, n=10, cap_end=F.R_DARK)
    # fairlead at the roof lip + the cable running out through it
    fx, fy, fz = F.FAIRLEAD
    chamfer_box(p, (fx, fy, fz), (0.56, 0.26, 0.22), 0.04,
                {'+x': F.R_CAB_S, '-x': F.R_CAB_S, '+z': F.R_CAB_F,
                 '-z': F.R_CAB_F, '+y': F.R_CAB_T, '-y': F.R_CAB_T})
    for rx in (-0.20, 0.20):
        limb(p, (fx + rx, fy - 0.11, fz), (fx + rx, fy + 0.11, fz),
             0.05, 0.05, F.R_TRIM, n=4)
    limb(p, (fx, y - 0.24, F.CAB_CZ + 0.10), (fx, fy + 0.04, fz - 0.06),
         0.035, 0.035, F.R_CABLE, n=3)

    # ── hydrophone head stowed on a cradle on cabin A's roof ────────────
    for i in range(len(F.HYD_STA) - 1):
        (z0, r0), (z1, r1) = F.HYD_STA[i], F.HYD_STA[i + 1]
        limb(p, (F.HYD_X, F.HYD_Y, z0), (F.HYD_X, F.HYD_Y, z1),
             max(r0, 0.02), max(r1, 0.02), F.R_HYD, n=6)
    for cz in (1.48, 2.10):
        chamfer_box(p, (F.HYD_X, F.CAB_TOP + 0.09, cz), (0.44, 0.22, 0.16), 0.03,
                    {'+x': F.R_CAB_S, '-x': F.R_CAB_S, '+z': F.R_CAB_F,
                     '-z': F.R_CAB_F, '+y': F.R_CAB_T}, skip=('-y',))

    # ── braced tower: four converging legs, ring + X bracing ────────────
    P.lattice_tower(p, F.TOWER_BASE, F.TOWER_TOP, F.TOWER_HB, F.TOWER_HT,
                    leg_r=0.135, brace_r=0.058, bands=3,
                    leg_zone=F.R_TOWER, brace_zone=F.R_TOWER)

    # caged ladder up the tower's -Z face
    lb = (0.0, F.TOWER_BASE, -1.20)
    lt = (0.0, 4.60, -0.70)
    P.ladder(p, lb, lt, width=0.46, rung_step=0.42, zone=F.R_TRIM)
    hoops = []
    for t in (0.22, 0.44, 0.66, 0.88):
        hy = lb[1] + (lt[1] - lb[1]) * t
        hz = lb[2] + (lt[2] - lb[2]) * t
        pts = [(-0.36, hy, hz + 0.06), (-0.26, hy, hz - 0.26),
               (0.26, hy, hz - 0.26), (0.36, hy, hz + 0.06)]
        for a, b in zip(pts, pts[1:]):
            limb(p, a, b, 0.03, 0.03, F.R_TRIM, n=3)
        hoops.append(pts)
    for i in (1, 2):
        for a, b in zip(hoops, hoops[1:]):
            limb(p, a[i], b[i], 0.026, 0.026, F.R_TRIM, n=3)

    # signal cable run: cabin A -> tower base
    limb(p, (F.CAB_AX + 0.9, F.PLINTH_TOP + 0.10, F.CAB_CZ - 0.55),
         (-0.55, F.PAD_TOP + 0.16, 1.05), 0.07, 0.07, F.R_CABLE, n=4)
    return p


# ───────────────────────────────────────────────────────────── dish ──────
def build_dish():
    """Rotating PLANAR ARRAY BAR — a flat vertical billboard, not a dish."""
    p = Part('dish')

    # slew collar over the tower head
    limb(p, (0, -0.16, 0), (0, F.COLLAR_TOP, 0), 0.32, 0.26, F.R_COLLAR, n=8)
    limb(p, (0, F.COLLAR_TOP - 0.02, 0), (0, F.ARR_Y0 + 0.06, 0),
         0.20, 0.18, F.R_COLLAR, n=6)

    # the flat array panel
    chamfer_box(p, (0.0, F.ARR_CY, 0.0), (F.ARR_W, F.ARR_H, F.ARR_T), 0.035,
                {'-z': F.R_ARRAY_F, '+z': F.R_ARRAY_B,
                 '+y': F.R_ARR_TB, '-y': F.R_ARR_TB,
                 '+x': F.R_ARR_LR, '-x': F.R_ARR_LR})

    # grid of shallow slot/element boxes on the front (-Z) face
    zf = -F.ARR_T / 2
    span = (F.ELEM_X1 - F.ELEM_X0) / F.ELEM_COLS
    for i in range(F.ELEM_COLS):
        cx = F.ELEM_X0 + span * (i + 0.5)
        for cy in F.ELEM_ROW_Y:
            slot_box(p, cx, cy, zf, F.ELEM_W, F.ELEM_H, F.ELEM_D)

    # stiffening truss frame on the back (+Z) face
    zb = F.ARR_T / 2 + 0.05
    for bx in (-1.42, -0.71, 0.0, 0.71, 1.42):
        limb(p, (bx, F.ARR_Y0 + 0.07, zb), (bx, F.ARR_Y1 - 0.07, zb),
             0.045, 0.045, F.R_TRIM, n=3)
    for by in (F.ARR_Y0 + 0.22, F.ARR_Y1 - 0.22):
        limb(p, (-1.55, by, zb), (1.55, by, zb), 0.05, 0.05, F.R_TRIM, n=3)
    limb(p, (-1.42, F.ARR_Y0 + 0.22, zb), (1.42, F.ARR_Y1 - 0.22, zb),
         0.035, 0.035, F.R_TRIM, n=3)
    limb(p, (1.42, F.ARR_Y0 + 0.22, zb), (-1.42, F.ARR_Y1 - 0.22, zb),
         0.035, 0.035, F.R_TRIM, n=3)

    # IFF whip antenna on top + amber lamp on the opposite top corner
    limb(p, (F.WHIP_X, F.ARR_Y1 - 0.04, 0.0), (F.WHIP_X, F.WHIP_TOP, 0.02),
         0.035, 0.012, F.R_TRIM, n=3)
    lightbox(p, (-1.52, F.ARR_Y1 + 0.02, -0.18), 0.18)
    return p


def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    T = 12.0
    keys = [(T * i / 4, qy(90.0 * i)) for i in range(5)]
    return [{'name': 'idle', 'channels': [('dish', 'rotation', keys)]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='dish', parent=0, offset=F.DISH_OFF, part=build_dish()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    for pc in pieces:
        print(f"  {pc['name']}: {pc['part'].tri_count()} tris")
    print(f'{STEM}: {total} tris')
