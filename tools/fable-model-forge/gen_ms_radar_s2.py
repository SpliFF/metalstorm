"""gen_ms_radar_s2 — assemble ms_radar_s2 and export .gltf/.bin.

Sector Tracking Station (radar s2, STYLE.md: 6 m): thin anchored pad, a
squat poured blockhouse (door, vent louvre bank, corner cable conduit,
stencilled ID panel), a heavy drum pedestal + slew ring on the roof, and a
SOLID multi-ring parabolic dish on an elevation yoke with a tripod feed arm
and a counterweight box.  UNARMED building — no turret/barrel/muzzle chain;
`dish` is the only animated piece (idle clip, 360 deg about Y in 10 s).

Run: python3 gen_ms_radar_s2.py  -> out/ms_radar_s2{,_png}.gltf + .bin
"""
import numpy as np

import ms_radar_s2_layout as F        # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, Zone, chamfer_box, ngon_ring, limb
import parts as PT
from gltf_export import export

STEM = 'ms_radar_s2'
OUT = 'out'
RNG = np.random.default_rng(90210)

# ── dish frame: U across, V up-in-plane, B = boresight (25 deg skyward) ──
_t = np.radians(F.DISH_TILT)
U = np.array([1.0, 0.0, 0.0])
V = np.array([0.0, np.cos(_t), np.sin(_t)])
B = np.cross(V, U)                    # (0, sin t, -cos t) -> up and forward
HUB = np.array([0.0, F.HUB_Y, 0.0])
NSEG = 20
RINGS = [0.0, 0.325, 0.65, 0.975, F.DISH_R]


def _depth(r):
    """Paraboloid sag: the vertex sits at HUB, the rim stands out along B."""
    return r * r / (4.0 * F.DISH_F)


def dish_pt(r, a, off=0.0):
    return HUB + r * (np.cos(a) * U + np.sin(a) * V) + (_depth(r) + off) * B


def box_zone(rect, center, size, pad=0.02):
    """Zone whose world window exactly frames a small box (x -> u, y -> v,
    v down) so its UVs stay inside `rect` — the fix for the batch-1 habit of
    reusing a fixed-window light zone on boxes parked far off the origin."""
    cx, cy = center[0], center[1]
    hx, hy = size[0] / 2 + pad, size[1] / 2 + pad
    return Zone(rect, ('x', 'y'), ((cx - hx, cx + hx), (cy + hy, cy - hy)))


def dish_uv(rect, r, a):
    x0, y0, x1, y1 = rect
    fx = 0.5 + 0.5 * r * np.cos(a) / F.DISH_R
    fy = 0.5 - 0.5 * r * np.sin(a) / F.DISH_R
    return ((x0 + fx * (x1 - x0)) / F.ATLAS, (y0 + fy * (y1 - y0)) / F.ATLAS)


# ── body ────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')

    # anchored pad
    x, y, z, w, h, d = F.PAD
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+y': F.Z_PAD, '+x': F.Z_PADS, '-x': F.Z_PADS,
                 '+z': F.Z_PADS_F, '-z': F.Z_PADS_F}, skip=('-y',))

    # blockhouse cabin
    chamfer_box(p, (0.0, F.BLK_Y, 0.0), (F.BLK_W, F.BLK_H, F.BLK_D), 0.06,
                {'+x': F.Z_BLK_PX, '-x': F.Z_BLK_NX, '-z': F.Z_BLK_FZ,
                 '+z': F.Z_BLK_BZ, '+y': F.Z_BLK_T}, skip=('-y',))

    # door step / threshold slab on the pad in front of the door
    chamfer_box(p, (0.0, F.PAD_H + 0.09, -(F.BLK_HZ + 0.22)),
                (1.10, 0.18, 0.44), 0.03,
                {'+y': F.Z_STEP, '+x': F.Z_STEP, '-x': F.Z_STEP,
                 '+z': F.Z_STEP, '-z': F.Z_STEP}, skip=('-y',))

    # vent louvre bank, proud of the rear wall
    chamfer_box(p, (0.0, 1.62, F.BLK_HZ + 0.08), (1.60, 0.78, 0.18), 0.03,
                {'+z': F.Z_VENT, '-z': F.Z_VENT, '+x': F.Z_VENT,
                 '-x': F.Z_VENT, '+y': F.Z_VENT, '-y': F.Z_VENT})

    # cable conduit up the +x/+z corner, then in to the pedestal
    cx, cz = F.BLK_HX - 0.14, F.BLK_HZ - 0.14
    limb(p, (cx + 0.10, F.PAD_H, cz + 0.10), (cx, F.BLK_TOP + 0.16, cz),
         0.12, 0.10, F.R_TRIM, n=6)
    limb(p, (cx, F.BLK_TOP + 0.14, cz), (0.40, F.BLK_TOP + 0.20, 0.34),
         0.10, 0.08, F.R_TRIM, n=5)

    # heavy pedestal drum + slew ring collar
    PT.drum(p, (0.0, F.BLK_TOP - 0.02, 0.0), F.PED_R, F.PED_H + 0.02,
            F.Z_PED, n=14)
    PT.drum(p, (0.0, F.PED_TOP, 0.0), F.SLEW_R, F.SLEW_H, F.Z_SLEW, n=14)

    # amber status lamp high on the front wall
    lamp_c, lamp_s = (0.92, F.BLK_TOP - 0.30, -(F.BLK_HZ + 0.09)), (0.22, 0.22, 0.20)
    zl = box_zone(F.R_LIGHT, lamp_c, lamp_s)
    chamfer_box(p, lamp_c, lamp_s, 0.03,
                {'+y': zl, '-y': zl, '+x': zl, '-x': zl, '+z': zl, '-z': zl})
    return p


# ── dish (rotating assembly) ────────────────────────────────────────────

def build_dish():
    p = Part('dish')

    # rotating turntable riding the slew ring
    PT.drum(p, (0.0, 0.0, 0.0), F.TURN_R, F.TURN_H, F.Z_TURN, n=14)

    # elevation yoke: two trunnion arms up to the dish hub
    for s in (-1.0, 1.0):
        limb(p, (s * F.YOKE_X, F.TURN_H - 0.04, 0.02),
             (s * (F.YOKE_X - 0.06), F.HUB_Y - 0.02, 0.0),
             0.15, 0.10, F.R_YOKE, n=5)
    # trunnion cross tie
    limb(p, (-F.YOKE_X, F.HUB_Y - 0.06, 0.0), (F.YOKE_X, F.HUB_Y - 0.06, 0.0),
         0.09, 0.09, F.R_YOKE, n=5)

    angs = np.linspace(0.0, 2.0 * np.pi, NSEG, endpoint=False)

    # front (concave) paraboloid: centre fan + concentric annuli
    inner = [dish_pt(RINGS[1], a) for a in angs]
    p.add_face(inner, uvs=[dish_uv(F.R_DISH_F, RINGS[1], a) for a in angs],
               flip=True)
    for r0, r1 in zip(RINGS[1:], RINGS[2:]):
        for j in range(NSEG):
            k = (j + 1) % NSEG
            aj, ak = angs[j], angs[k]
            quad = [dish_pt(r0, aj), dish_pt(r0, ak),
                    dish_pt(r1, ak), dish_pt(r1, aj)]
            uvs = [dish_uv(F.R_DISH_F, r0, aj), dish_uv(F.R_DISH_F, r0, ak),
                   dish_uv(F.R_DISH_F, r1, ak), dish_uv(F.R_DISH_F, r1, aj)]
            p.add_face(quad, uvs=uvs, flip=True)

    # back (convex) shell, offset by the shell thickness
    t = -F.SHELL_T
    inner = [dish_pt(RINGS[1], a, t) for a in angs]
    p.add_face(inner, uvs=[dish_uv(F.R_DISH_B, RINGS[1], a) for a in angs])
    for r0, r1 in zip(RINGS[1:], RINGS[2:]):
        for j in range(NSEG):
            k = (j + 1) % NSEG
            aj, ak = angs[j], angs[k]
            quad = [dish_pt(r0, aj, t), dish_pt(r0, ak, t),
                    dish_pt(r1, ak, t), dish_pt(r1, aj, t)]
            uvs = [dish_uv(F.R_DISH_B, r0, aj), dish_uv(F.R_DISH_B, r0, ak),
                   dish_uv(F.R_DISH_B, r1, ak), dish_uv(F.R_DISH_B, r1, aj)]
            p.add_face(quad, uvs=uvs)

    # rim lip band: closes the shell and stands proud of the dish face
    x0, y0, x1, y1 = F.R_LIP
    for j in range(NSEG):
        k = (j + 1) % NSEG
        aj, ak = angs[j], angs[k]
        quad = [dish_pt(F.DISH_R, aj, t), dish_pt(F.DISH_R, ak, t),
                dish_pt(F.DISH_R, ak, F.LIP_H), dish_pt(F.DISH_R, aj, F.LIP_H)]
        uj, uk = j / NSEG, (j + 1) / NSEG
        uvs = [((x0 + uj * (x1 - x0)) / F.ATLAS, (y1 - 1) / F.ATLAS),
               ((x0 + uk * (x1 - x0)) / F.ATLAS, (y1 - 1) / F.ATLAS),
               ((x0 + uk * (x1 - x0)) / F.ATLAS, (y0 + 1) / F.ATLAS),
               ((x0 + uj * (x1 - x0)) / F.ATLAS, (y0 + 1) / F.ATLAS)]
        p.add_face(quad, uvs=uvs, flip=True)

    # radial back ribs so the rear read isn't blank
    for i in range(6):
        a = i * np.pi / 3.0 + np.pi / 6.0
        p0 = HUB - (F.SHELL_T + 0.03) * B
        p1 = dish_pt(F.DISH_R - 0.08, a, t - 0.03)
        limb(p, tuple(p0), tuple(p1), 0.075, 0.045, F.R_RIB, n=3)

    # counterweight box behind the dish
    zc = box_zone(F.R_CWT, F.CWT, F.CWT_SIZE)
    chamfer_box(p, F.CWT, F.CWT_SIZE, 0.04,
                {'+x': zc, '-x': zc, '+y': zc, '-y': zc, '+z': zc, '-z': zc})

    # tripod feed arm -> feed horn at the focus
    focus = HUB + F.DISH_F * B
    for i in range(3):
        a = np.pi / 2.0 + i * 2.0 * np.pi / 3.0
        foot = dish_pt(F.FEED_R, a)
        limb(p, tuple(foot), tuple(focus - 0.10 * B), 0.055, 0.035,
             F.R_TRIM, n=4)
    fh = (0.28, 0.26, 0.28)
    zf = box_zone(F.R_FEED, tuple(focus), fh)
    chamfer_box(p, tuple(focus), fh, 0.04,
                {'+x': zf, '-x': zf, '+y': zf, '-y': zf, '+z': zf, '-z': zf})

    # amber status lamp clamped to the dish rim
    lamp = tuple(dish_pt(F.DISH_R - 0.02, np.radians(52.0), 0.06))
    ls = (0.20, 0.20, 0.20)
    zd = box_zone(F.R_LIGHT, lamp, ls)
    chamfer_box(p, lamp, ls, 0.03,
                {'+y': zd, '-y': zd, '+x': zd, '-x': zd, '+z': zd, '-z': zd})
    return p


def qy(deg):
    r = np.radians(deg) / 2.0
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    T = 10.0
    keys = [(T * i / 4.0, qy(90.0 * i)) for i in range(5)]
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
    lo = np.array([1e9, 1e9, 1e9])
    hi = -lo
    for pc in pieces:
        b0, b1 = pc['part'].bounds()
        off = np.asarray(pc['offset'], float)
        lo = np.minimum(lo, np.asarray(b0) + off)
        hi = np.maximum(hi, np.asarray(b1) + off)
    print(f'{STEM}: {total} tris')
    print(f'bbox min {np.round(lo, 3)} max {np.round(hi, 3)} '
          f'size {np.round(hi - lo, 3)}')
