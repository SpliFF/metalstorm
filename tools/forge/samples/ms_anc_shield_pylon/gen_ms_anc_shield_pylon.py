"""gen_ms_anc_shield_pylon — assemble ms_anc_shield_pylon and export .gltf/.bin.

ANCIENT-TECH shield emitter pylon, 18 m tall:
  body    — half-buried ground pad, plinth drum, monolithic tapering
            triangular shaft (chamfered-triangle section: three broad
            unbroken flanks + three narrow corner edges carrying the cyan
            charge-lines), five clean RECESSED seams, three cantilevered
            anchor vanes, a three-arm focusing corona with cyan lens
            nodes, and a perfect-circle cantilevered focus plate.
  emitter — floating crystal 0.6 m clear of the shaft cap with three
            orbiting shards; slow idle rotation about Y plus a subtle bob
            (ABSOLUTE translation keys), seamless loop.

Run: python3 gen_ms_anc_shield_pylon.py -> out/ms_anc_shield_pylon{,_png}.gltf
"""
import numpy as np

import ms_anc_shield_pylon_layout as F   # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, chamfer_box, limb, ngon_ring
from gltf_export import export

STEM = 'ms_anc_shield_pylon'
OUT = 'out'
A = float(F.ATLAS)


def uv(px):
    return (px[0] / A, px[1] / A)


# ── shaft cross-section: equilateral triangle with cut corners ───────────

def tri_ring(y, r):
    """Six verts: [P0, Q1, P1, Q2, P2, Q0]. Even bands = broad flanks,
    odd bands = narrow corner edges (the charge-line strips)."""
    T = [np.array([r * np.cos(a), y, r * np.sin(a)]) for a in F.CORNER_AZ]
    c = F.SH_CUT
    P = [T[k] + c * (T[(k + 1) % 3] - T[k]) for k in range(3)]
    Q = [T[k] + c * (T[(k - 1) % 3] - T[k]) for k in range(3)]
    return [P[0], Q[1], P[1], Q[2], P[2], Q[0]]


def band(part, ra, rb, ya, yb):
    """One band between two tri_rings; outward-wound, zone by band parity."""
    for j in range(6):
        k = (j + 1) % 6
        quad = [ra[j], ra[k], rb[k], rb[j]]
        rect = F.R_FACE if j % 2 == 0 else F.R_EDGE
        uvs = [uv(F.shaft_px(rect, 0.0, ya)), uv(F.shaft_px(rect, 1.0, ya)),
               uv(F.shaft_px(rect, 1.0, yb)), uv(F.shaft_px(rect, 0.0, yb))]
        ctr = np.mean(np.array(quad), axis=0)
        nrm = np.cross(quad[1] - quad[0], quad[3] - quad[0])
        if np.dot(nrm, np.array([ctr[0], 0.0, ctr[2]])) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        part.add_face([tuple(v) for v in quad], uvs=uvs)


def build_shaft(p):
    st = F.shaft_stations()
    rings = [tri_ring(y, r) for (y, r) in st]
    for i in range(len(rings) - 1):
        band(p, rings[i], rings[i + 1], st[i][0], st[i + 1][0])
    p.add_face([tuple(v) for v in rings[-1]], zone=F.R_CAP, flip=True)


# ── base drums (perfect circles, half buried) ───────────────────────────

def drum(p, r, y0, y1, n, side_rect, top_zone):
    lo = ngon_ring((0, y0, 0), r, n, 'y')
    hi = ngon_ring((0, y1, 0), r, n, 'y')
    for j in range(n):
        k = (j + 1) % n
        quad = [lo[j], lo[k], hi[k], hi[j]]
        u0, u1 = j / n, (j + 1) / n
        uvs = [uv(F.wrap_px(side_rect, u0, 1.0)),
               uv(F.wrap_px(side_rect, u1, 1.0)),
               uv(F.wrap_px(side_rect, u1, 0.0)),
               uv(F.wrap_px(side_rect, u0, 0.0))]
        ctr = np.mean(np.array(quad), axis=0)
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        if np.dot(nrm, np.array([ctr[0], 0.0, ctr[2]])) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)
    p.add_face(hi, zone=top_zone, flip=True)


# ── anchor vanes (cantilevered buttress slabs) ─────────────────────────

def vane(p, az, face_rect):
    d = np.array([np.cos(az), 0.0, np.sin(az)])
    t = np.array([-np.sin(az), 0.0, np.cos(az)])
    prof = [np.array(q, dtype=float) for q in F.VANE_PROFILE]
    c = np.mean(np.array(prof), axis=0)
    b = F.VANE_BEVEL
    inset = []
    for q in prof:
        v = q - c
        n = np.linalg.norm(v)
        inset.append(c + v * max(0.0, 1.0 - b / n))
    half = F.VANE_T / 2

    def ring(prof2d, s):
        return [d * q[0] + np.array([0.0, q[1], 0.0]) + t * s for q in prof2d]

    layers = [(inset, -half), (prof, -half + b), (prof, half - b),
              (inset, half)]
    rings = [ring(pr, s) for (pr, s) in layers]
    n = len(prof)

    # perimeter bands (bevel / rim / bevel)
    for i in range(3):
        va = 0.5 * i / 3.0
        vb = 0.5 * (i + 1) / 3.0
        for j in range(n):
            k = (j + 1) % n
            quad = [rings[i][j], rings[i][k], rings[i + 1][k], rings[i + 1][j]]
            u0, u1 = j / n, (j + 1) / n
            uvs = [uv(F.wrap_px(F.R_VANE_EDGE, u0, va)),
                   uv(F.wrap_px(F.R_VANE_EDGE, u1, va)),
                   uv(F.wrap_px(F.R_VANE_EDGE, u1, vb)),
                   uv(F.wrap_px(F.R_VANE_EDGE, u0, vb))]
            ctr = np.mean(np.array(quad), axis=0)
            nrm = np.cross(quad[1] - quad[0], quad[3] - quad[0])
            out = ctr - (d * c[0] + np.array([0.0, c[1], 0.0]))
            if np.dot(nrm, out) < 0:
                quad, uvs = quad[::-1], uvs[::-1]
            p.add_face([tuple(v) for v in quad], uvs=uvs)

    # the two broad slab faces
    for (rg, pr, flip) in ((rings[0], inset, False), (rings[3], inset, True)):
        uvs = [uv(F.vane_px(face_rect, q[0], q[1])) for q in pr]
        p.add_face([tuple(v) for v in rg], uvs=uvs, flip=flip)


# ── focusing corona + focus plate ──────────────────────────────────────

def build_corona(p):
    for az in F.FLANK_AZ:
        d = np.array([np.cos(az), 0.0, np.sin(az)])
        p0 = tuple(d * F.ARM_R0 + np.array([0.0, F.ARM_Y0, 0.0]))
        p1 = tuple(d * F.ARM_R1 + np.array([0.0, F.ARM_Y1, 0.0]))
        limb(p, p0, p1, F.ARM_TH0, F.ARM_TH1, F.R_ARM, n=6)
        s = F.NODE_SIZE
        chamfer_box(p, p1, (s, s, s), 0.055,
                    {k: F.R_NODE for k in ('+x', '-x', '+y', '-y', '+z', '-z')})


def build_plate(p):
    n = 12
    ys = (F.PLATE_Y - F.PLATE_HALF, F.PLATE_Y, F.PLATE_Y + F.PLATE_HALF)
    rs = (F.PLATE_RIM, F.PLATE_R, F.PLATE_RIM)
    rings = [ngon_ring((0, y, 0), r, n, 'y') for y, r in zip(ys, rs)]
    for i in range(2):
        va, vb = 0.5 * i, 0.5 * (i + 1)
        for j in range(n):
            k = (j + 1) % n
            quad = [rings[i][j], rings[i][k], rings[i + 1][k], rings[i + 1][j]]
            u0, u1 = j / n, (j + 1) / n
            uvs = [uv(F.wrap_px(F.R_PLATE, u0, va)),
                   uv(F.wrap_px(F.R_PLATE, u1, va)),
                   uv(F.wrap_px(F.R_PLATE, u1, vb)),
                   uv(F.wrap_px(F.R_PLATE, u0, vb))]
            ctr = np.mean(np.array(quad), axis=0)
            nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                           np.asarray(quad[3]) - np.asarray(quad[0]))
            if np.dot(nrm, np.array([ctr[0], 0.0, ctr[2]])) < 0:
                quad, uvs = quad[::-1], uvs[::-1]
            p.add_face(quad, uvs=uvs)
    p.add_face(rings[2], zone=F.R_PLATE_TOP, flip=True)
    p.add_face(rings[0], zone=F.R_PLATE_TOP)


def build_body():
    p = Part('body')
    drum(p, F.PAD_R, 0.0, F.PAD_Y, F.NGON_BASE, F.R_PAD_SIDE, F.R_PAD_TOP)
    drum(p, F.PLINTH_R, 0.0, F.PLINTH_Y, F.NGON_BASE, F.R_PLINTH_SIDE,
         F.R_PLINTH_TOP)
    build_shaft(p)
    for i, az in enumerate(F.CORNER_AZ):
        vane(p, az, F.R_VANE0 if i == F.TEAM_VANE else F.R_VANE)
    build_corona(p)
    build_plate(p)
    return p


# ── floating emitter crystal (piece-local, pivot at world EMIT_Y) ───────

def build_emitter():
    p = Part('emitter')
    n = 6
    rings = [ngon_ring((0, y, 0), r, n, 'y') for (y, r) in F.EMIT_RINGS]
    nr = len(rings)
    for i in range(nr - 1):
        va, vb = i / (nr - 1), (i + 1) / (nr - 1)
        for j in range(n):
            k = (j + 1) % n
            quad = [rings[i][j], rings[i][k], rings[i + 1][k], rings[i + 1][j]]
            u0, u1 = j / n, (j + 1) / n
            uvs = [uv(F.wrap_px(F.R_EMIT, u0, va)),
                   uv(F.wrap_px(F.R_EMIT, u1, va)),
                   uv(F.wrap_px(F.R_EMIT, u1, vb)),
                   uv(F.wrap_px(F.R_EMIT, u0, vb))]
            ctr = np.mean(np.array(quad), axis=0)
            nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                           np.asarray(quad[3]) - np.asarray(quad[0]))
            if np.dot(nrm, np.array([ctr[0], 0.0, ctr[2]])) < 0:
                quad, uvs = quad[::-1], uvs[::-1]
            p.add_face(quad, uvs=uvs)
    p.add_face(rings[-1], zone=F.R_DARK, flip=True)
    p.add_face(rings[0], zone=F.R_DARK)

    # three orbiting shards
    for az, y in zip(F.SHARD_AZ, F.SHARD_Y):
        d = np.array([np.cos(az), 0.0, np.sin(az)])
        a = tuple(d * F.SHARD_R0 + np.array([0.0, y, 0.0]))
        b = tuple(d * F.SHARD_R1 + np.array([0.0, y + 0.12, 0.0]))
        limb(p, a, b, F.SHARD_T0, F.SHARD_T1, F.R_SHARD, n=4,
             cap_start=F.R_DARK)
    return p


# ── clips ──────────────────────────────────────────────────────────────

def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    T = F.IDLE_T
    rot = [(T * i / 4.0, qy(90.0 * i)) for i in range(5)]
    steps = int(round(T / F.BOB_PERIOD)) * 4        # 4 keys per bob cycle
    bob = []
    for i in range(steps + 1):
        t = T * i / steps
        y = F.EMIT_Y + F.BOB_AMP * float(np.sin(2 * np.pi * t / F.BOB_PERIOD))
        bob.append((t, (0.0, y, 0.0)))
    bob[-1] = (T, bob[0][1])                        # seamless
    return [{'name': 'idle',
             'channels': [('emitter', 'rotation', rot),
                          ('emitter', 'translation', bob)]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='emitter', parent=0, offset=(0.0, F.EMIT_Y, 0.0),
             part=build_emitter()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    for pc in pieces:
        print(f"  {pc['name']:8s} {pc['part'].tri_count():5d} tris")
    print(f'{STEM}: {total} tris')
