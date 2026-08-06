"""gen_ms_anc_interdictor — assemble ms_anc_interdictor and export .gltf/.bin.

ANCIENT REGISTER, 24 m. Dead-zone ash circle bounded by a perfect
inscribed rim; three burial mounds; three curved monolithic buttress
legs that sweep up and inward and STOP short of a suspended faceted
core; three cantilever emitter blades aimed at that core from the leg
inner faces; three free-standing resonator pylons; and a broken halo
antenna (piece `halo`) tilted 16 deg so its seamless Y rotation reads as
an irregular precession. Never team-owned.
Run: python3 gen_ms_anc_interdictor.py -> out/ms_anc_interdictor{,_png}.gltf
"""
import numpy as np

import ms_anc_interdictor_layout as F   # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part
from gltf_export import export

STEM = 'ms_anc_interdictor'
OUT = 'out'
YV = np.array([0.0, 1.0, 0.0])


# ── low-level helpers ────────────────────────────────────────────────────

def newell(vs):
    n = np.zeros(3)
    for i in range(len(vs)):
        c, x = np.asarray(vs[i]), np.asarray(vs[(i + 1) % len(vs)])
        n[0] += (c[1] - x[1]) * (c[2] + x[2])
        n[1] += (c[2] - x[2]) * (c[0] + x[0])
        n[2] += (c[0] - x[0]) * (c[1] + x[1])
    ln = np.linalg.norm(n)
    return n / ln if ln > 1e-12 else n


def face_out(part, verts, ref, zone=None, uvs=None):
    """add_face wound so its flat normal agrees with `ref`."""
    flip = float(np.dot(newell(verts), np.asarray(ref, dtype=float))) < 0.0
    part.add_face(list(verts), zone=zone, uvs=uvs, flip=flip)


def _uv(rect, fu, fv):
    x0, y0, x1, y1 = rect
    return ((x0 + (x1 - x0) * fu) / F.ATLAS, (y0 + (y1 - y0) * fv) / F.ATLAS)


def loft_sides(part, rings, rects, closed=True):
    """Skin consecutive equal-length vertex rings. Face j of every span is
    UV'd into rects[j] (or rects itself if a single rect): u = station
    fraction, v = fraction across that rect. Winding is taken radially
    outward from the ring-centre axis."""
    nr, n = len(rings), len(rings[0])
    per_side = isinstance(rects, (list, tuple)) and isinstance(rects[0], (list, tuple))
    ctrs = [np.mean(np.asarray(r, dtype=float), axis=0) for r in rings]
    lim = n if closed else n - 1
    for i in range(nr - 1):
        fa, fb = i / (nr - 1), (i + 1) / (nr - 1)
        axis_pt = (ctrs[i] + ctrs[i + 1]) / 2.0
        for j in range(lim):
            k = (j + 1) % n
            quad = [rings[i][j], rings[i][k], rings[i + 1][k], rings[i + 1][j]]
            # per-side rects: the face owns its whole rect vertically;
            # one shared rect: the faces stack as n v-bands inside it.
            rect = rects[j] if per_side else rects
            va, vb = (0.0, 1.0) if per_side else (j / n, (j + 1) / n)
            uvs = [_uv(rect, fa, va), _uv(rect, fa, vb),
                   _uv(rect, fb, vb), _uv(rect, fb, va)]
            ctr = np.mean(np.asarray(quad, dtype=float), axis=0)
            ref = ctr - axis_pt
            if np.linalg.norm(ref) < 1e-9:
                continue
            flip = float(np.dot(newell(quad), ref)) < 0.0
            if flip:
                quad, uvs = quad[::-1], uvs[::-1]
            part.add_face(quad, uvs=uvs)


def cap_disc(part, ring, rect, ref):
    """End cap for a ring, UV'd as a disc inside `rect`, wound toward ref."""
    x0, y0, x1, y1 = rect
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    rr = min(x1 - x0, y1 - y0) * 0.40
    n = len(ring)
    uvs = [((cx + rr * np.cos(2 * np.pi * i / n)) / F.ATLAS,
            (cy + rr * np.sin(2 * np.pi * i / n)) / F.ATLAS) for i in range(n)]
    face_out(part, ring, ref, uvs=uvs)


def ring_xz(cx, cy, cz, r, n, phase=0.0):
    return [(cx + r * np.cos(phase + 2 * np.pi * i / n), cy,
             cz + r * np.sin(phase + 2 * np.pi * i / n)) for i in range(n)]


# ── dead-zone apron: profile of revolution ───────────────────────────────

def build_base(p):
    prof = F.BASE_PROFILE
    n = F.BASE_N
    rings = [ring_xz(0, y, 0, r, n) for (r, y) in prof]
    # flat centre pad
    face_out(p, rings[1], (0, 1, 0), zone=F.R_ASH)
    for i in range(1, len(prof) - 1):
        (r0, y0), (r1, y1) = prof[i], prof[i + 1]
        dr, dy = r1 - r0, y1 - y0
        vertical = abs(dr) < 1e-6
        for j in range(n):
            k = (j + 1) % n
            quad = [rings[i][j], rings[i][k], rings[i + 1][k], rings[i + 1][j]]
            ctr = np.mean(np.asarray(quad, dtype=float), axis=0)
            rad = np.array([ctr[0], 0.0, ctr[2]])
            rad = rad / max(np.linalg.norm(rad), 1e-9)
            ref = rad * (-dy) + YV * dr          # outward for this profile
            if vertical:
                uvs = [_uv(F.R_RIM_S, j / n, 0.0), _uv(F.R_RIM_S, (j + 1) / n, 0.0),
                       _uv(F.R_RIM_S, (j + 1) / n, 1.0), _uv(F.R_RIM_S, j / n, 1.0)]
                flip = float(np.dot(newell(quad), ref)) < 0.0
                if flip:
                    quad, uvs = quad[::-1], uvs[::-1]
                p.add_face(quad, uvs=uvs)
            else:
                face_out(p, quad, ref, zone=F.R_ASH)


# ── legs ─────────────────────────────────────────────────────────────────

def bez(t, pts):
    (a, b, c, d) = [np.asarray(q, dtype=float) for q in pts]
    m = 1.0 - t
    return (m ** 3) * a + 3 * m * m * t * b + 3 * m * t * t * c + (t ** 3) * d


def dbez(t, pts):
    (a, b, c, d) = [np.asarray(q, dtype=float) for q in pts]
    m = 1.0 - t
    return 3 * m * m * (b - a) + 6 * m * t * (c - b) + 3 * t * t * (d - c)


def leg_frame(t, theta_deg):
    """Return (centre, tangential axis T, in-plane outward axis N)."""
    th = np.radians(theta_deg)
    R = np.array([np.cos(th), 0.0, np.sin(th)])
    T = np.array([-np.sin(th), 0.0, np.cos(th)])
    r, y = bez(t, F.LEG_BEZ)
    dr, dy = dbez(t, F.LEG_BEZ)
    ln = np.hypot(dr, dy)
    dr, dy = dr / ln, dy / ln
    return R * r + YV * y, T, R * dy + YV * (-dr)


def leg_profile(hw, hd, c):
    return [(hw - c, hd), (-(hw - c), hd), (-hw, hd - c), (-hw, -(hd - c)),
            (-(hw - c), -hd), (hw - c, -hd), (hw, -(hd - c)), (hw, hd - c)]


def build_leg(p, theta_deg):
    rings = []
    for i in range(F.LEG_STATIONS):
        t = i / (F.LEG_STATIONS - 1)
        C, T, N = leg_frame(t, theta_deg)
        hw = F.LEG_HW[0] + (F.LEG_HW[1] - F.LEG_HW[0]) * t
        hd = F.LEG_HD[0] + (F.LEG_HD[1] - F.LEG_HD[0]) * t
        ch = F.LEG_CH[0] + (F.LEG_CH[1] - F.LEG_CH[0]) * t
        rings.append([tuple(C + T * u + N * v) for (u, v) in leg_profile(hw, hd, ch)])
    loft_sides(p, rings, list(F.LEG_SIDE_RECTS))
    # tip cap: a cyan emitter lens aimed into the throat
    C0, _, _ = leg_frame(1.0 - 1e-3, theta_deg)
    C1, _, _ = leg_frame(1.0, theta_deg)
    cap_disc(p, rings[-1], F.R_LENS, C1 - C0)


def build_mound(p, theta_deg):
    th = np.radians(theta_deg)
    r0 = F.LEG_BEZ[0][0]
    cx, cz = r0 * np.cos(th), r0 * np.sin(th)
    a = ring_xz(cx, 0.0, cz, F.MOUND_R[0], F.MOUND_N)
    b = ring_xz(cx, F.MOUND_H, cz, F.MOUND_R[1], F.MOUND_N)
    loft_sides(p, [a, b], F.R_MOUND)
    cap_disc(p, b, F.R_DIRT, (0, 1, 0))


def build_cantilever(p, theta_deg):
    t = F.CANT_T
    C, T, N = leg_frame(t, theta_deg)
    hd = F.LEG_HD[0] + (F.LEG_HD[1] - F.LEG_HD[0]) * t
    start = C + N * (-hd * 0.85)
    aim = np.array([0.0, F.CORE_Y, 0.0]) - start
    aim /= np.linalg.norm(aim)
    up = np.cross(aim, T)
    up /= np.linalg.norm(up)
    rings = []
    for (dist, half) in ((0.0, F.CANT_HALF[0]), (F.CANT_LEN * 0.62, F.CANT_HALF[0] * 0.72),
                         (F.CANT_LEN, F.CANT_HALF[1])):
        c = start + aim * dist
        h = half
        rings.append([tuple(c + T * h + up * h), tuple(c - T * h + up * h),
                      tuple(c - T * h - up * h), tuple(c + T * h - up * h)])
    loft_sides(p, rings, F.R_CANT)
    cap_disc(p, rings[-1], F.R_LENS, aim)


def build_pylon(p, theta_deg):
    th = np.radians(theta_deg)
    ux, uz = np.cos(th), np.sin(th)
    rings = []
    for (h, r, lean) in F.PYLON_RINGS:
        rings.append(ring_xz((F.PYLON_R + lean) * ux, h, (F.PYLON_R + lean) * uz,
                             r, F.PYLON_N))
    loft_sides(p, rings, F.R_PYLON)
    cap_disc(p, rings[-1], F.R_LENS, (0, 1, 0))


def build_body():
    p = Part('body')
    build_base(p)
    for th in F.LEG_THETAS:
        build_mound(p, th)
        build_leg(p, th)
        build_cantilever(p, th)
    for th in F.PYLON_THETAS:
        build_pylon(p, th)
    return p


# ── suspended core (piece-local, pivot at its own centre) ────────────────

def build_core():
    p = Part('core')
    rings = [ring_xz(0.0, y, 0.0, max(r, 1e-4), F.CORE_N) for (y, r) in F.CORE_RINGS]
    loft_sides(p, rings, F.R_CORE)
    return p


# ── broken halo antenna (piece-local, pivot at the core centre) ──────────

def build_halo():
    p = Part('halo')
    tl = np.radians(F.HALO_TILT)
    ct, st = np.cos(tl), np.sin(tl)

    def tilt(v):
        x, y, z = v
        return np.array([x, y * ct - z * st, y * st + z * ct])

    arc = np.radians(F.HALO_ARC)
    rings = []
    for i in range(F.HALO_SEGS + 1):
        f = i / F.HALO_SEGS
        phi = arc * f
        rad = np.array([np.cos(phi), 0.0, np.sin(phi)])
        # taper the cross-section toward both broken ends
        k = F.HALO_END_TAPER + (1.0 - F.HALO_END_TAPER) * np.sin(np.pi * f) ** 0.45
        hr, hh = F.HALO_HR * k, F.HALO_HH * k
        c = rad * F.HALO_R
        rings.append([tuple(tilt(c + rad * hr + YV * hh)),    # 0 top
                      tuple(tilt(c - rad * hr + YV * hh)),    # 1 inner
                      tuple(tilt(c - rad * hr - YV * hh)),    # 2 bottom
                      tuple(tilt(c + rad * hr - YV * hh))])   # 3 outer
    loft_sides(p, rings, F.R_HALO)
    d0 = np.asarray(rings[0][0]) - np.asarray(rings[1][0])
    d1 = np.asarray(rings[-1][0]) - np.asarray(rings[-2][0])
    cap_disc(p, rings[0], F.R_LENS, d0)
    cap_disc(p, rings[-1], F.R_LENS, d1)

    # outward emitter spurs
    for phid in F.HALO_SPUR_PHI:
        phi = np.radians(phid)
        rad = np.array([np.cos(phi), 0.0, np.sin(phi)])
        tan = np.array([-np.sin(phi), 0.0, np.cos(phi)])
        base = rad * (F.HALO_R + F.HALO_HR * 0.6)
        srings = []
        for (dist, h) in ((0.0, 0.20), (F.HALO_SPUR_LEN * 0.7, 0.15),
                          (F.HALO_SPUR_LEN, 0.08)):
            c = base + rad * dist
            srings.append([tuple(tilt(c + tan * h + YV * h)),
                           tuple(tilt(c - tan * h + YV * h)),
                           tuple(tilt(c - tan * h - YV * h)),
                           tuple(tilt(c + tan * h - YV * h))])
        loft_sides(p, srings, F.R_CANT)
        cap_disc(p, srings[-1], F.R_LENS, tilt(rad))
    return p


# ── clips ────────────────────────────────────────────────────────────────

def qy(deg):
    r = np.radians(deg) / 2.0
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    # halo: one revolution per 51 s, uneven 45 deg steps -> irregular sweep,
    # but the key set closes exactly on 360 deg so the loop is seamless.
    keys, t = [(0.0, qy(0.0))], 0.0
    for i, dt in enumerate(F.HALO_STEP_SECS):
        t += dt
        keys.append((round(t, 3), qy(45.0 * (i + 1))))
    # core: slow breath, 5 cycles across the same clip length, ends where it began
    n = 20
    ck = []
    for i in range(n + 1):
        f = i / n
        s = 1.0 + F.CORE_PULSE_AMP * (0.5 - 0.5 * np.cos(2 * np.pi * F.CORE_PULSE_CYCLES * f))
        ck.append((round(F.IDLE_LEN * f, 3), (float(s), float(s), float(s))))
    return [{'name': 'idle', 'channels': [('halo', 'rotation', keys),
                                          ('core', 'scale', ck)]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='core', parent=0, offset=F.CORE_PIVOT, part=build_core()),
        dict(name='halo', parent=0, offset=F.HALO_PIVOT, part=build_halo()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    for pc in pieces:
        print(f"  {pc['name']:6s} {pc['part'].tri_count():5d} tris")
    print(f'{STEM}: {total} tris')
