"""gen_ms_anc_barge — build ms_anc_barge (ancient gravity barge) + clips.

ANCIENT REGISTER, s3 transport, 30 m. One 22-point section ring lofted over
eleven stations makes the whole monolith in a single unbroken skin: flat
cargo deck, a forward deck CANTILEVER that overhangs the skirt, a continuous
recessed groove ringing the hull (the cyan lift-field line lives in it), and
a concave keel-less plenum underneath whose lowest edge is the 2 m ride
height. Five perfect-circle emitter discs sit in the plenum, four cradle pads
on the deck carry link1..link4. Two perfect circles thread the slab — a 6.6 m
prow ring and a 5.6 m stern ring the low raked control fin passes through —
and a sensor ring floats above the fin and yaws (clip `idle`).

Usage: python3 gen_ms_anc_barge.py
"""
from __future__ import annotations
import numpy as np

import ms_anc_barge_layout as S       # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, loft, limb
from gltf_export import export

STEM = 'ms_anc_barge'
OUT = 'out'


# ── helpers ──────────────────────────────────────────────────────────────

def orient_face(p, verts, outward, zone=None, uvs=None):
    """Add a convex polygon wound so its flat normal points along `outward`."""
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    vs, uu = list(verts), (list(uvs) if uvs is not None else None)
    if np.dot(n, np.asarray(outward, dtype=float)) < 0:
        vs = vs[::-1]
        if uu is not None:
            uu = uu[::-1]
    p.add_face([tuple(v) for v in vs], zone=zone, uvs=uu)


def rect_uv(rect, fu, fv):
    x0, y0, x1, y1 = rect
    return ((x0 + (x1 - x0) * fu) / M.ATLAS, (y0 + (y1 - y0) * fv) / M.ATLAS)


def torus(p, center, R, r, nm, nn, rect, e1=(1, 0, 0), e2=(0, 1, 0),
          e3=(0, 0, 1)):
    """Perfect-circle ring (major radius R, tube radius r) in the e1/e2 plane.
    UV: u wraps the major circle, v wraps the tube — v band nn//2 is the
    INBOARD face, which the painter lights cyan."""
    c = np.asarray(center, float)
    e1, e2, e3 = (np.asarray(v, float) for v in (e1, e2, e3))
    majors = []
    for i in range(nm + 1):
        a = 2 * np.pi * i / nm
        er = np.cos(a) * e1 + np.sin(a) * e2
        C = c + R * er
        majors.append(([C + r * np.cos(2 * np.pi * j / nn) * er
                        + r * np.sin(2 * np.pi * j / nn) * e3
                        for j in range(nn + 1)], er))
    for i in range(nm):
        r0, er0 = majors[i]
        r1, _ = majors[i + 1]
        u0, u1 = i / nm, (i + 1) / nm
        for j in range(nn):
            b = 2 * np.pi * (j + 0.5) / nn
            nrm = np.cos(b) * er0 + np.sin(b) * e3
            quad = [r0[j], r0[j + 1], r1[j + 1], r1[j]]
            uvs = [rect_uv(rect, u0, j / nn), rect_uv(rect, u0, (j + 1) / nn),
                   rect_uv(rect, u1, (j + 1) / nn), rect_uv(rect, u1, j / nn)]
            orient_face(p, quad, nrm, uvs=uvs)


def disc_solid(p, cx, cz, y_base, h, r, n, band_rect, face_rect, up=True):
    """Shallow perfect-circle disc — deck cradle pad (up) or belly emitter
    (down). Rim band + one flat face; the face gets its own atlas cell."""
    ang = [2 * np.pi * (i + 0.5) / n for i in range(n)]
    y_face = y_base + h if up else y_base - h
    rf = r * (0.93 if up else 0.90)
    base = [(cx + r * np.cos(a), y_base, cz + r * np.sin(a)) for a in ang]
    face = [(cx + rf * np.cos(a), y_face, cz + rf * np.sin(a)) for a in ang]
    for i in range(n):
        k = (i + 1) % n
        quad = [base[i], base[k], face[k], face[i]]
        uvs = [rect_uv(band_rect, i / n, 0.94),
               rect_uv(band_rect, (i + 1) / n, 0.94),
               rect_uv(band_rect, (i + 1) / n, 0.06),
               rect_uv(band_rect, i / n, 0.06)]
        rad = np.array([np.cos(ang[i] + np.pi / n), 0.0,
                        np.sin(ang[i] + np.pi / n)])
        orient_face(p, quad, rad, uvs=uvs)
    fuv = [rect_uv(face_rect, 0.5 + 0.5 * (v[0] - cx) / rf,
                   0.5 + 0.5 * (v[2] - cz) / rf) for v in face]
    orient_face(p, face, (0, 1, 0) if up else (0, -1, 0), uvs=fuv)


def hull_zone(c, n):
    """Deck / belly / recess-wall / flank — the whole monolith, four zones."""
    if abs(n[1]) > 0.55:
        if c[1] > 4.20:
            return S.Z_DECK
        if c[1] < 2.75:
            return S.Z_BELLY
        return S.Z_DARK            # the two groove walls only
    return S.Z_HULL


def end_cap(p, z, outward, zone):
    """Bow / stern transom, built as convex bands so the groove notch stays
    a real notch (a fan over the concave outline would self-overlap)."""
    wd, wm = S.wd_at(z), S.wm_at(z)
    wb, wp = S.wb_at(z), S.wp_at(z)
    wg = max(0.20, wm - S.GROOVE_IN)

    def V(x, y):
        return (x, y, z)

    bands = [
        [V(wd, S.Y_DECK), V(wm, S.Y_KNEE), V(-wm, S.Y_KNEE), V(-wd, S.Y_DECK)],
        [V(wm, S.Y_KNEE), V(wm, S.Y_G_TOP), V(-wm, S.Y_G_TOP), V(-wm, S.Y_KNEE)],
        [V(wm, S.Y_G_TOP), V(wg, S.Y_G_HI), V(-wg, S.Y_G_HI), V(-wm, S.Y_G_TOP)],
        [V(wg, S.Y_G_HI), V(wg, S.Y_G_LO), V(-wg, S.Y_G_LO), V(-wg, S.Y_G_HI)],
        [V(wg, S.Y_G_LO), V(wm, S.Y_G_BOT), V(-wm, S.Y_G_BOT), V(-wg, S.Y_G_LO)],
        [V(wm, S.Y_G_BOT), V(wm, S.Y_CHINE), V(-wm, S.Y_CHINE), V(-wm, S.Y_G_BOT)],
        [V(wm, S.Y_CHINE), V(wb, S.Y_BELLY), V(-wb, S.Y_BELLY), V(-wm, S.Y_CHINE)],
        [V(wb, S.Y_BELLY), V(wp, S.Y_PLEN), V(-wp, S.Y_PLEN), V(-wb, S.Y_BELLY)],
    ]
    for band in bands:
        orient_face(p, band, outward, zone=zone)


# ── body ─────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')

    rings = [[(x, y, z) for (x, y) in S.ring_at(z)] for z in
             [s[0] for s in S.SECTIONS]]
    loft(p, rings, hull_zone, close=True, flip_side=True)
    end_cap(p, S.SECTIONS[0][0], (0, 0, -1), S.Z_BOW)
    end_cap(p, S.SECTIONS[-1][0], (0, 0, 1), S.Z_STERN)

    # the two perfect circles that thread the slab
    for spec in (S.PROW_RING, S.STERN_RING):
        torus(p, spec['center'], spec['R'], spec['r'], spec['nm'], spec['nn'],
              S.R_RING)

    # belly emitter discs (keel-less plenum, ACTIVE cyan faces)
    for (ex, ez, er) in S.EMITTERS:
        disc_solid(p, ex, ez, S.Y_PLEN, S.EMIT_DEPTH, er, 16,
                   S.R_EMITBAND, S.Z_EMIT, up=False)

    # deck cradle pads under link1..link4
    for (px, pz) in S.PADS:
        disc_solid(p, px, pz, S.Y_DECK, S.PAD_H, S.PAD_R, 14,
                   S.R_PADBAND, S.Z_PAD, up=True)
    return p


# ── aft control fin (+ the sensor stub) ──────────────────────────────────

def _fin_ring(x, inset):
    pts = np.array(S.FIN_PROFILE, dtype=float)
    ctr = pts.mean(axis=0)
    out = []
    for (pz, py) in pts:
        d = np.array([pz, py]) - ctr
        n = np.linalg.norm(d)
        d = d / n * max(0.0, n - inset) if n > 1e-9 else d
        out.append((x, ctr[1] + d[1], ctr[0] + d[0]))
    return out


def fin_zone(c, n):
    if n[2] < -0.35:
        return S.Z_FINLEAD        # raked leading edge — the lit rim
    if n[1] < -0.35:
        return S.Z_DARK           # buried footing
    return S.Z_TRIM


def build_fin():
    p = Part('fin')
    rings = [_fin_ring(x, S.FIN_CHAMFER if abs(x) > 0.30 else 0.0)
             for x in S.FIN_X]
    loft(p, rings, fin_zone, close=True, flip_side=False)
    orient_face(p, rings[0], (-1, 0, 0), zone=S.Z_FIN)
    orient_face(p, rings[-1], (1, 0, 0), zone=S.Z_FIN)
    limb(p, S.PYLON[0], S.PYLON[1], 0.17, 0.14, S.R_PYLON, n=6)
    return p


def build_sensor():
    p = Part('sensor')
    torus(p, (0, 0, 0), S.SENSOR['R'], S.SENSOR['r'], S.SENSOR['nm'],
          S.SENSOR['nn'], S.R_SENS)
    return p


# ── clips ────────────────────────────────────────────────────────────────

def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    T = S.IDLE_PERIOD
    return [{
        'name': 'idle',
        'channels': [('sensor', 'rotation',
                      [(T * i / 4, qy(90.0 * i)) for i in range(5)])],
    }]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='fin', parent=0, offset=S.FIN_OFF, part=build_fin()),
        dict(name='sensor', parent=1, offset=S.SENSOR_OFF, part=build_sensor()),
    ]
    for i, off in enumerate(S.LINKS):
        pieces.append(dict(name=f'link{i + 1}', parent=0, offset=off,
                           part=None))
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_{STEM}] total tris: {total}')
