"""gen_ms_anc_obelisk_field — resonant obelisk kit (ancient register).

Three elements as separate ROOT pieces in one glTF:
  obelisk_a (root)  9.0 m upright monolith, twisted octagonal shaft, two
                    recessed collars, obliquely sliced crown, soil drift
  obelisk_b (root)  6.0 m monolith leaning 13.5° out of a soil heave
  obelisk_c (root)  4.3 m monolith snapped at 1.7 m — stump AND the fallen
                    tip (rigidly transformed into the SAME piece), the two
                    fracture surfaces generated once so they interlock

No animation clips (static scenario dressing) and no team colour.
Deterministic: seed 90210, geometry from ms_anc_obelisk_field_layout only.
Run: python3 gen_ms_anc_obelisk_field.py → out/ms_anc_obelisk_field{,_png}.gltf
"""
import numpy as np

import ms_anc_obelisk_field_layout as L
from meshlib import Part
from gltf_export import export

STEM = 'ms_anc_obelisk_field'
OUT = 'out'
RNG = np.random.default_rng(90210)
OCT = 0.41421356237          # half-side / apothem of a regular octagon


# ── section + loft ──────────────────────────────────────────────────────

def section(w, groove=True):
    """Regular octagon of apothem w (flat faces on ±x/±z), optionally with
    the resonance channel cut into the -Z face.  Vertex order is chosen so
    that the loft quads wind outward (normal ∝ (-dz, 0, dx))."""
    a = OCT * w
    if not groove:
        pts = [(a, -w), (-a, -w), (-w, -a), (-w, a),
               (-a, w), (a, w), (w, a), (w, -a)]
        tags = ['face', 'chamf', 'side', 'chamf',
                'back', 'chamf', 'side', 'chamf']
        return pts, tags
    g, d = L.GROOVE_HW, L.GROOVE_D
    pts = [(a, -w), (g, -w), (g, -w + d), (-g, -w + d), (-g, -w), (-a, -w),
           (-w, -a), (-w, a), (-a, w), (a, w), (w, a), (w, -a)]
    tags = ['face', 'gwall', 'gfloor', 'gwall', 'face', 'chamf',
            'side', 'chamf', 'back', 'chamf', 'side', 'chamf']
    return pts, tags


def ring(y, w, tw, groove=True):
    """Section lifted to height y and twisted tw radians about +Y."""
    pts, tags = section(w, groove)
    c, s = np.cos(tw), np.sin(tw)
    return [(x * c + z * s, y, -x * s + z * c) for (x, z) in pts], tags


def shaft_rings(profile, twist_spec, groove=True):
    out, tags = [], None
    for (y, w) in profile:
        r, tags = ring(y, w, L.twist_at(twist_spec, y), groove)
        out.append(r)
    return out, tags


def loft(part, rings, tags, zmap):
    for i in range(len(rings) - 1):
        r0, r1 = rings[i], rings[i + 1]
        n = len(r0)
        for j in range(n):
            k = (j + 1) % n
            part.add_face([r0[j], r0[k], r1[k], r1[j]], zone=zmap[tags[j]])


def crown_ring(base, crown):
    """Oblique slice: y is an affine function of (x, z) so the cap stays
    planar — an exact, confident cut, not a pyramid."""
    yc, kz, kx, w = crown
    return [(x, yc - kz * (z / w) + kx * (x / w), z) for (x, _y, z) in base]


def cap(part, r, zone, up=True):
    part.add_face(list(r), zone=zone, flip=not up)


def frac_ring(y, w, tw, jit, rng):
    """Ragged break surface: per-vertex height noise on a normal section."""
    r, tags = ring(y, w, tw)
    out = []
    for i, (x, _y, z) in enumerate(r):
        out.append((x, y + float(rng.uniform(-jit, jit * 0.75)), z))
    return out, tags


def frac_cap(part, r, zone, up=True):
    """Fan a ragged break surface from its centroid (each triangle planar)."""
    c = tuple(np.mean(np.array(r), axis=0))
    n = len(r)
    for j in range(n):
        k = (j + 1) % n
        tri = [c, r[j], r[k]] if up else [c, r[k], r[j]]
        part.add_face(tri, zone=zone)


# ── soil ────────────────────────────────────────────────────────────────

def mound(part, spec, zone, n=16, center=(0.0, 0.0), rng=None, lipfn=None,
          scale=(1.0, 1.0)):
    """Geological drift/heave: concentric n-gon rings lofted outward.
    spec = [(y, radius)] from the outer ground ring inward/upward."""
    rings = []
    jitter = ([1.0 + float(rng.uniform(-0.09, 0.09)) for _ in range(n)]
              if rng is not None else [1.0] * n)
    for i, (y, r) in enumerate(spec):
        pts = []
        for j in range(n):
            a = 0.19 - 2 * np.pi * j / n          # decreasing → outward wind
            dy, dr = lipfn(a, i) if lipfn else (0.0, 0.0)
            rr = r * (1.0 + dr) * (jitter[j] if i == 0 else 1.0)
            pts.append((center[0] + rr * scale[0] * np.cos(a),
                        y + dy,
                        center[1] + rr * scale[1] * np.sin(a)))
        rings.append(pts)
    for i in range(len(rings) - 1):
        r0, r1 = rings[i], rings[i + 1]
        for j in range(n):
            k = (j + 1) % n
            part.add_face([r0[j], r0[k], r1[k], r1[j]], zone=zone)


# ── rigid transforms (UVs are baked upright, THEN the piece is moved) ───

def rx(t):
    c, s = np.cos(t), np.sin(t)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def ry(t):
    c, s = np.cos(t), np.sin(t)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rz(t):
    c, s = np.cos(t), np.sin(t)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def xform(part, R, t=(0.0, 0.0, 0.0)):
    t = np.asarray(t, dtype=float)
    part.pos = [tuple(R @ np.asarray(v) + t) for v in part.pos]
    part.nrm = [tuple(R @ np.asarray(v)) for v in part.nrm]


def merge(dst, src):
    base = len(dst.pos)
    dst.pos += src.pos
    dst.nrm += src.nrm
    dst.uv += src.uv
    dst.idx += [i + base for i in src.idx]


# ── elements ────────────────────────────────────────────────────────────

def zmap_for(face, side, back):
    return {'face': face, 'gfloor': face, 'back': back,
            'side': side, 'chamf': side, 'gwall': L.GWALL}


def build_obelisk_a():
    p = Part('obelisk_a')
    zm = zmap_for(L.A_FACE, L.A_SIDE, L.A_BACK)
    rings, tags = shaft_rings(L.A_PROFILE, L.A_TWIST)
    rings.append(crown_ring(rings[-1], L.A_CROWN))
    loft(p, rings, tags, zm)
    cap(p, rings[-1], L.A_TOP, up=True)
    mound(p, L.A_SOIL, L.SOIL, n=16, rng=RNG,
          lipfn=lambda a, i: (0.0, 0.10 * np.cos(a - 0.9) if i == 0 else 0.0))
    return p


def build_obelisk_b():
    shaft = Part('obelisk_b_shaft')
    zm = zmap_for(L.B_FACE, L.B_SIDE, L.B_BACK)
    rings, tags = shaft_rings(L.B_PROFILE, L.B_TWIST)
    rings.append(crown_ring(rings[-1], L.B_CROWN))
    loft(shaft, rings, tags, zm)
    cap(shaft, rings[-1], L.B_TOP, up=True)
    deg, piv = L.B_LEAN
    R = rz(np.radians(deg))
    pv = np.array([0.0, piv, 0.0])
    xform(shaft, R, pv - R @ pv)

    p = Part('obelisk_b')
    merge(p, shaft)
    # soil heave: ridge shouldered up on the -X side (the compression side
    # the monolith has toppled away from), the +X side collapsed away
    def lip(a, i):
        if i == 0:
            return (0.0, 0.06 * np.cos(a))
        if i == 1:
            return (L.B_HEAVE * max(0.0, -np.cos(a)) ** 1.3
                    - 0.10 * max(0.0, np.cos(a)), 0.0)
        return (0.0, 0.0)
    mound(p, L.B_SOIL, L.SOIL_B, n=16, rng=RNG, lipfn=lip)
    return p


def build_obelisk_c():
    zm = zmap_for(L.C_FACE, L.C_SIDE, L.C_BACK)
    # the ONE break surface, generated once and shared by stump and tip
    fr, tags = frac_ring(L.C_FRAC_Y, L.C_FRAC_W,
                         L.twist_at(L.C_TWIST, L.C_FRAC_Y),
                         L.C_FRAC_JIT, RNG)

    stump = Part('obelisk_c_stump')
    rings, tags = shaft_rings(L.C_PROFILE, L.C_TWIST)
    rings.append(fr)
    loft(stump, rings, tags, zm)
    frac_cap(stump, fr, L.C_FRAC, up=True)

    tip = Part('obelisk_c_tip')
    trings = [fr] + [ring(y, w, L.twist_at(L.C_TWIST, y))[0]
                     for (y, w) in L.C_TIP_PROFILE]
    trings.append(crown_ring(trings[-1], L.C_CROWN))
    loft(tip, trings, tags, zm)
    frac_cap(tip, fr, L.C_FRAC, up=False)
    cap(tip, trings[-1], L.C_TOP, up=True)
    R = (ry(np.radians(L.C_TIP_YAW)) @ rx(np.radians(L.C_TIP_PITCH))
         @ ry(np.radians(L.C_TIP_SPIN)))
    xform(tip, R)
    fr_c = R @ np.mean(np.array(fr), axis=0)
    miny = min(v[1] for v in tip.pos)
    xform(tip, np.eye(3), (L.C_TIP_AT[0] - fr_c[0],
                           -L.C_TIP_SINK - miny,
                           L.C_TIP_AT[1] - fr_c[2]))

    p = Part('obelisk_c')
    merge(p, stump)
    merge(p, tip)
    mound(p, L.C_SOIL, L.SOIL, n=16, rng=RNG,
          lipfn=lambda a, i: (0.0, 0.08 * np.cos(a + 1.7) if i == 0 else 0.0))
    for (cxz, r) in L.C_HUMMOCKS:
        mound(p, [(0.0, r), (0.16 * r / 0.88, r * 0.62), (0.40 * r / 0.88,
                                                          r * 0.09)],
              L.SOIL, n=10, center=cxz, rng=RNG, scale=(1.25, 0.85))
    return p


def build_all():
    return [
        dict(name='obelisk_a', parent=-1, offset=L.A_OFF,
             part=build_obelisk_a()),
        dict(name='obelisk_b', parent=-1, offset=L.B_OFF,
             part=build_obelisk_b()),
        dict(name='obelisk_c', parent=-1, offset=L.C_OFF,
             part=build_obelisk_c()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    tex = ('diffuse', 'orm', 'emissive')       # never team-owned
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True,
           texture_maps=tex)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True,
           texture_maps=tex)
    for pc in pieces:
        b0, b1 = pc['part'].bounds()
        print(f"  {pc['name']:<10} {pc['part'].tri_count():>4} tris  "
              f"bounds ({b0[0]:.2f},{b0[1]:.2f},{b0[2]:.2f}) .. "
              f"({b1[0]:.2f},{b1[1]:.2f},{b1[2]:.2f})")
    total = sum(pc['part'].tri_count() for pc in pieces)
    print(f'[gen_{STEM}] total tris: {total}')
