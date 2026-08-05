"""gen_ms_anc_harvester — assemble ms_anc_harvester and export .gltf/.bin.

ANCIENT REGISTER harvester crawler (s3 resource unit, 18.0 m). Monolithic
lofted hull on two sealed track skirts (no axles, no road wheels — the track
is implied by the skirt's ground-run geometry and its paint), a face-wide
fluted extraction drum (piece `drum`, idle slow rotation about X) slung under
a grand cantilevered hood between two perfect-circle bearing bosses, a dorsal
ore hopper (piece `hopper`) whose inner rim is a lit cyan sort-throat, and a
discharge chute (piece `chute`) cantilevered aft over open air.

Run: python3 gen_ms_anc_harvester.py  → out/ms_anc_harvester{,_png}.gltf+.bin
"""
from __future__ import annotations
import os
import numpy as np

import ms_anc_harvester_layout as L   # sets meshlib.ATLAS = 2048
from meshlib import Part, loft, chamfer_box, mirror_x, ATLAS
from gltf_export import export

STEM = 'ms_anc_harvester'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
A = float(ATLAS)


# ── helpers ─────────────────────────────────────────────────────────────

def _newell(vs):
    n = np.zeros(3)
    for i in range(len(vs)):
        c, nx = np.asarray(vs[i], float), np.asarray(vs[(i + 1) % len(vs)], float)
        n[0] += (c[1] - nx[1]) * (c[2] + nx[2])
        n[1] += (c[2] - nx[2]) * (c[0] + nx[0])
        n[2] += (c[0] - nx[0]) * (c[1] + nx[1])
    return n


def face_out(p, verts, outward, zone=None, uvs=None):
    """Add a polygon wound so its flat normal points along `outward`."""
    if np.dot(_newell(verts), np.asarray(outward, float)) < 0:
        verts = verts[::-1]
        if uvs is not None:
            uvs = uvs[::-1]
    p.add_face(list(verts), zone=zone, uvs=uvs)


def px(rect, fu, fv):
    """Parametric rect (px) -> normalised gltf UV."""
    x0, y0, x1, y1 = rect
    return ((x0 + (x1 - x0) * fu) / A, (y0 + (y1 - y0) * fv) / A)


def hull_ring(sec):
    z, yb, yw, ysh, yd, yt, wb, ww, ws, wd, wt = sec
    return [(wb, yb, z), (ww, yw, z), (ws, ysh, z), (wd, yd, z), (wt, yt, z),
            (-wt, yt, z), (-wd, yd, z), (-ws, ysh, z), (-ww, yw, z),
            (-wb, yb, z)]


def slab_ring(y, hx, z0, z1, c):
    """8-point chamfered rectangle in the XZ plane at height y, wound so a
    vertical loft (rings stacked in +Y) faces outward."""
    return [(hx, y, z1 - c), (hx, y, z0 + c), (hx - c, y, z0),
            (-hx + c, y, z0), (-hx, y, z0 + c), (-hx, y, z1 - c),
            (-hx + c, y, z1), (hx - c, y, z1)]


def disc_solid(p, centre, r, half, n, axis, side_zone, cap_a, cap_b):
    """Perfect-circle disc (n-gon) about `axis` — the ancient bearing read."""
    ai = 'xyz'.index(axis)
    rings = []
    for s in (-1, 1):
        ring = []
        for i in range(n):
            a = np.pi / n + 2 * np.pi * i / n
            pt = [centre[0], centre[1], centre[2]]
            pt[ai] += s * half
            u_ax = (ai + 1) % 3
            v_ax = (ai + 2) % 3
            pt[u_ax] += r * np.cos(a)
            pt[v_ax] += r * np.sin(a)
            ring.append(tuple(pt))
        rings.append(ring)
    for j in range(n):
        k = (j + 1) % n
        quad = [rings[0][j], rings[0][k], rings[1][k], rings[1][j]]
        c = np.mean(np.array(quad), axis=0)
        rad = c - np.asarray(centre, float)
        rad[ai] = 0.0
        face_out(p, quad, rad, zone=side_zone)
    out = np.zeros(3)
    out[ai] = -1.0
    face_out(p, rings[0], out, zone=cap_a)
    face_out(p, rings[1], -out, zone=cap_b)


# ── body ────────────────────────────────────────────────────────────────

def hull_zone(c, n):
    if n[1] < -0.45:
        return L.A_DARK
    if abs(n[0]) > 0.50:
        return L.A_HULL_SIDE
    if n[2] < -0.55:
        return L.A_HULL_FRONT
    if n[2] > 0.55:
        return L.A_HULL_REAR
    return L.A_HULL_TOP


def hood_points():
    cy, cz = L.HOOD_CTR
    out, inn = [], []
    for deg in L.HOOD_ANGLES:
        a = np.radians(deg)
        out.append((cy + L.HOOD_R_OUT * np.cos(a),
                    cz - L.HOOD_R_OUT * np.sin(a)))
        inn.append((cy + L.HOOD_R_IN * np.cos(a),
                    cz - L.HOOD_R_IN * np.sin(a)))
    return out, inn


def build_hood(p):
    """Cantilevered shell arcing over the drum — one unbroken surface."""
    out, inn = hood_points()
    hw = L.HOOD_HALF_W
    cy, cz = L.HOOD_CTR
    n = len(out)
    # arc-length parameters for UV u
    def params(pts):
        d = [0.0]
        for i in range(1, len(pts)):
            d.append(d[-1] + float(np.hypot(pts[i][0] - pts[i - 1][0],
                                            pts[i][1] - pts[i - 1][1])))
        return [t / d[-1] for t in d]
    tu = params(out)

    for i in range(n - 1):
        for pts, rect, sgn in ((out, L.A_HOOD_OUT, 1.0), (inn, L.A_HOOD_IN, -1.0)):
            (y0, z0), (y1, z1) = pts[i], pts[i + 1]
            quad = [(hw, y0, z0), (-hw, y0, z0), (-hw, y1, z1), (hw, y1, z1)]
            uvs = [px(rect, tu[i], 0.0), px(rect, tu[i], 1.0),
                   px(rect, tu[i + 1], 1.0), px(rect, tu[i + 1], 0.0)]
            mid = ((y0 + y1) / 2 - cy, (z0 + z1) / 2 - cz)
            face_out(p, quad, (0.0, sgn * mid[0], sgn * mid[1]), uvs=uvs)
        # side edge strips
        for s in (1, -1):
            (oy0, oz0), (oy1, oz1) = out[i], out[i + 1]
            (iy0, iz0), (iy1, iz1) = inn[i], inn[i + 1]
            quad = [(s * hw, oy0, oz0), (s * hw, oy1, oz1),
                    (s * hw, iy1, iz1), (s * hw, iy0, iz0)]
            uvs = [px(L.A_HOOD_EDGE, tu[i], 0.0), px(L.A_HOOD_EDGE, tu[i + 1], 0.0),
                   px(L.A_HOOD_EDGE, tu[i + 1], 1.0), px(L.A_HOOD_EDGE, tu[i], 1.0)]
            face_out(p, quad, (s, 0.0, 0.0), uvs=uvs)
    # end caps (rear root + forward lip)
    for i, sgn in ((0, -1.0), (n - 1, 1.0)):
        (oy, oz), (iy, iz) = out[i], inn[i]
        quad = [(hw, oy, oz), (-hw, oy, oz), (-hw, iy, iz), (hw, iy, iz)]
        tan = np.array([0.0, -(oz - cz), (oy - cy)]) * sgn
        uvs = [px(L.A_HOOD_EDGE, 0.0, 0.0), px(L.A_HOOD_EDGE, 1.0, 0.0),
               px(L.A_HOOD_EDGE, 1.0, 1.0), px(L.A_HOOD_EDGE, 0.0, 1.0)]
        face_out(p, quad, tan, uvs=uvs)


def build_body():
    p = Part('body')

    # monolithic lofted hull
    rings = [hull_ring(s) for s in L.HULL_SECTIONS]
    loft(p, rings, hull_zone, cap_start=L.A_HULL_FRONT, cap_end=L.A_HULL_REAR)

    # dorsal plinth the hopper grows out of (one unbroken collar)
    x, y, z, w, h, d = L.PLINTH
    chamfer_box(p, (x, y, z), (w, h, d), 0.09,
                {'+y': L.A_HULL_TOP, '+x': L.A_HULL_SIDE, '-x': L.A_HULL_SIDE,
                 '+z': L.A_HULL_REAR, '-z': L.A_HULL_FRONT}, skip=('-y',))

    # forward core disc — a perfect circle set into the foredeck
    disc_solid(p, L.CORE_DISC, L.CORE_R, L.CORE_H / 2, L.CORE_N, 'y',
               L.A_TRIM_BOX, L.A_TRIM_BOX, L.A_GLYPH)

    # grand cantilevered hood over the drum
    build_hood(p)

    # drum bearing cantilevers: arm slab + perfect-circle boss, both sides
    for s in (1, -1):
        ax, ay, az, aw, ah, ad = L.ARM_BOX
        chamfer_box(p, (s * ax, ay, az), (aw, ah, ad), 0.08,
                    {k: L.A_ARM_TRIM for k in
                     ('+x', '-x', '+y', '-y', '+z', '-z')})
        bx, by, bz = L.BOSS_CTR
        disc_solid(p, (s * bx, by, bz), L.BOSS_R, L.BOSS_HALF, L.BOSS_N, 'x',
                   L.A_ARM_TRIM,
                   L.A_ARM_OUT if s < 0 else L.A_ARM_TRIM,
                   L.A_ARM_OUT if s > 0 else L.A_ARM_TRIM)
    return p


# ── sealed track skirt ──────────────────────────────────────────────────

def build_skirt_l():
    p = Part('skirt_l')
    prof = L.SKIRT_PROFILE
    w = L.SKIRT_HALF_W
    n = len(prof)

    outer = [(w, y, z) for (z, y) in prof]
    inner = [(-w, y, z) for (z, y) in prof]
    p.add_face(outer, zone=L.A_SKIRT_SIDE, flip=True)   # CCW profile -> -X raw
    p.add_face(inner, zone=L.A_SKIRT_SIDE)

    # sealed ground run: arc-length parametric wrap (the implied track)
    seg = [float(np.hypot(prof[(i + 1) % n][0] - prof[i][0],
                          prof[(i + 1) % n][1] - prof[i][1])) for i in range(n)]
    total = sum(seg)
    centroid = np.array([0.0, sum(y for _, y in prof) / n,
                         sum(z for z, _ in prof) / n])
    acc = 0.0
    for i in range(n):
        j = (i + 1) % n
        u0, u1 = acc / total, (acc + seg[i]) / total
        acc += seg[i]
        quad = [(w, prof[i][1], prof[i][0]), (-w, prof[i][1], prof[i][0]),
                (-w, prof[j][1], prof[j][0]), (w, prof[j][1], prof[j][0])]
        uvs = [px(L.A_SKIRT_WRAP, u0, 0.0), px(L.A_SKIRT_WRAP, u0, 1.0),
               px(L.A_SKIRT_WRAP, u1, 1.0), px(L.A_SKIRT_WRAP, u1, 0.0)]
        ctr = np.mean(np.array(quad), axis=0)
        face_out(p, quad, ctr - centroid, uvs=uvs)

    # fairing lip that seals the skirt into the hull (unbroken, proud 40 mm)
    fx, fy, fz, fw, fh, fd = L.SKIRT_FAIRING
    chamfer_box(p, (fx, fy, fz), (fw, fh, fd), 0.03,
                {'+y': L.A_SKIRT_TOP, '+x': L.A_SKIRT_SIDE,
                 '-x': L.A_SKIRT_SIDE, '+z': L.A_SKIRT_SIDE,
                 '-z': L.A_SKIRT_SIDE}, skip=('-y',))
    return p


# ── extraction drum ─────────────────────────────────────────────────────

def drum_ring(x, scale):
    pts = []
    for i in range(L.DRUM_N):
        a = np.pi / L.DRUM_N + 2 * np.pi * i / L.DRUM_N
        r = L.DRUM_R * scale * (1.0 if i % 2 == 0 else L.DRUM_FLUTE)
        pts.append((x, r * np.cos(a), r * np.sin(a)))
    return pts


def build_drum():
    """Face-wide fluted cutting drum. Every flute maps to the SAME atlas
    cell, so the paint is exactly 12-fold symmetric and the idle spin
    never shows a seam."""
    p = Part('drum')
    st = L.DRUM_STATIONS
    rings = [drum_ring(x, s) for (x, s) in st]
    n = L.DRUM_N
    H = L.DRUM_HALF

    for i in range(len(rings) - 1):
        r0, r1 = rings[i], rings[i + 1]
        v0 = (st[i][0] + H) / (2 * H)
        v1 = (st[i + 1][0] + H) / (2 * H)
        for j in range(n):
            k = (j + 1) % n
            fu0 = (j % 2) / 2.0
            fu1 = fu0 + 0.5
            quad = [r0[j], r0[k], r1[k], r1[j]]
            uvs = [px(L.A_DRUM_BARREL, fu0, v0), px(L.A_DRUM_BARREL, fu1, v0),
                   px(L.A_DRUM_BARREL, fu1, v1), px(L.A_DRUM_BARREL, fu0, v1)]
            c = np.mean(np.array(quad), axis=0)
            face_out(p, quad, (0.0, c[1], c[2]), uvs=uvs)

    face_out(p, rings[0], (-1, 0, 0), zone=L.A_DRUM_CAP)
    face_out(p, rings[-1], (1, 0, 0), zone=L.A_DRUM_CAP)
    return p


# ── dorsal ore hopper ───────────────────────────────────────────────────

def hopper_zone(c, n):
    if abs(n[0]) > 0.55:
        return L.A_HOPPER_SIDE
    if n[2] < -0.55:
        return L.A_HOPPER_FRONT
    if n[2] > 0.55:
        return L.A_HOPPER_REAR
    return L.A_HOPPER_SIDE


def build_hopper():
    p = Part('hopper')
    rings = [slab_ring(*r) for r in L.HOPPER_RINGS]
    loft(p, rings, hopper_zone)
    lip = slab_ring(*L.HOPPER_LIP)
    loft(p, [rings[-1], lip], lambda c, n: L.A_CORE)   # lit sort-throat
    p.add_face(list(lip), zone=L.A_HOPPER_TOP)          # ore surface (+Y)
    return p


# ── discharge chute (cantilevered aft) ─────────────────────────────────

def build_chute():
    p = Part('chute')
    LEN, DROP, TH, WI = L.CHUTE_LEN, L.CHUTE_DROP, L.CHUTE_TH, 0.16

    def st(t):
        return (L.CHUTE_HW0 + (L.CHUTE_HW1 - L.CHUTE_HW0) * t,
                -DROP * t, LEN * t,
                L.CHUTE_WALL + (L.CHUTE_WALL1 - L.CHUTE_WALL) * t)

    (h0, y0, z0, w0), (h1, y1, z1, w1) = st(0.0), st(1.0)
    fall = np.array([0.0, LEN, DROP])            # up-normal of the sloped floor
    fall = fall / np.linalg.norm(fall)

    # floor: top (ore path) and underside
    face_out(p, [(h0, y0, z0), (-h0, y0, z0), (-h1, y1, z1), (h1, y1, z1)],
             fall, zone=L.A_CHUTE_IN)
    face_out(p, [(h0, y0 - TH, z0), (-h0, y0 - TH, z0),
                 (-h1, y1 - TH, z1), (h1, y1 - TH, z1)],
             -fall, zone=L.A_CHUTE_OUT)

    for s in (1, -1):
        # outer flank: one unbroken plane, floor underside to wall top
        face_out(p, [(s * h0, y0 - TH, z0), (s * h0, y0 + w0, z0),
                     (s * h1, y1 + w1, z1), (s * h1, y1 - TH, z1)],
                 (s, 0, 0), zone=L.A_CHUTE_SIDE)
        # inner wall face
        face_out(p, [(s * (h0 - WI), y0, z0), (s * (h0 - WI), y0 + w0, z0),
                     (s * (h1 - WI), y1 + w1, z1), (s * (h1 - WI), y1, z1)],
                 (-s, 0, 0), zone=L.A_CHUTE_SIDE)
        # wall crown
        face_out(p, [(s * h0, y0 + w0, z0), (s * (h0 - WI), y0 + w0, z0),
                     (s * (h1 - WI), y1 + w1, z1), (s * h1, y1 + w1, z1)],
                 (0, 1, 0), zone=L.A_CHUTE_IN)
        # wall end at the lip
        face_out(p, [(s * h1, y1 - TH, z1), (s * h1, y1 + w1, z1),
                     (s * (h1 - WI), y1 + w1, z1), (s * (h1 - WI), y1, z1)],
                 (0, 0, 1),
                 uvs=[px(L.A_CHUTE_EDGE, 0.0, 0.0), px(L.A_CHUTE_EDGE, 1.0, 0.0),
                      px(L.A_CHUTE_EDGE, 1.0, 1.0), px(L.A_CHUTE_EDGE, 0.0, 1.0)])
    # discharge lip band
    face_out(p, [(h1 - WI, y1, z1), (-(h1 - WI), y1, z1),
                 (-(h1 - WI), y1 - TH, z1), (h1 - WI, y1 - TH, z1)],
             (0, 0, 1),
             uvs=[px(L.A_CHUTE_EDGE, 0.0, 0.0), px(L.A_CHUTE_EDGE, 1.0, 0.0),
                  px(L.A_CHUTE_EDGE, 1.0, 1.0), px(L.A_CHUTE_EDGE, 0.0, 1.0)])
    return p


# ── clips ───────────────────────────────────────────────────────────────

def qx(deg):
    r = np.radians(deg) / 2
    return (float(np.sin(r)), 0.0, 0.0, float(np.cos(r)))


def build_clips():
    T = 16.0                                   # slow, ancient, unhurried
    keys = [(T * i / 4.0, qx(90.0 * i)) for i in range(5)]
    return [{'name': 'idle', 'channels': [('drum', 'rotation', keys)]}]


# ── assembly ────────────────────────────────────────────────────────────

def build_all():
    sl = build_skirt_l()
    sr = mirror_x(sl, 'skirt_r')
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='skirt_l', parent=0, offset=L.SKIRT_OFF, part=sl),
        dict(name='skirt_r', parent=0,
             offset=(-L.SKIRT_OFF[0], L.SKIRT_OFF[1], L.SKIRT_OFF[2]), part=sr),
        dict(name='drum', parent=0, offset=L.DRUM_OFF, part=build_drum()),
        dict(name='hopper', parent=0, offset=L.HOPPER_OFF, part=build_hopper()),
        dict(name='chute', parent=0, offset=L.CHUTE_OFF, part=build_chute()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=build_clips(),
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=build_clips(),
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    for pc in pieces:
        print(f"  {pc['name']:<8} {pc['part'].tri_count():>5} tris")
    print(f'{STEM}: {total} tris')
