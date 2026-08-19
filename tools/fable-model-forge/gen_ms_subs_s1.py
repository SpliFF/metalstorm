"""gen_ms_subs_s1 — build ms_subs_s1 (coastal sub pack boat).

Subs s1 (18 m): stubby teardrop hull of revolution on the y=0 axis
datum, exposed free-flooding deck casing, tall narrow vertical-sided
fin well forward (tier identity), fixed bow planes, cruciform stern
planes, single open screw. No clips (squad def). Pieces: body +
`muzzle` empty at the bow torpedo tube tip.

Usage: python3 gen_ms_subs_s1.py
"""
from __future__ import annotations
import numpy as np

import ms_subs_s1_layout as S           # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, loft, chamfer_box, ngon_ring, limb
from gltf_export import export

STEM = 'ms_subs_s1'
OUT = 'out'
RNG = np.random.default_rng(90210)

_ZS = [s[0] for s in S.HULL_STATIONS]
_RS = [s[1] for s in S.HULL_STATIONS]


def hull_r(z):
    return float(np.interp(z, _ZS, _RS))


# ── helpers ──────────────────────────────────────────────────────────────

def quad_out(p, verts, outward, zone):
    """Polygon wound so its normal points along `outward`."""
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(list(verts) if np.dot(n, outward) > 0 else list(verts)[::-1],
               zone=zone)


def fan_to_point(p, ring, tip, outward_z, zone):
    """Cone fan from a ring to a tip point, faces wound outward."""
    n = len(ring)
    for j in range(n):
        k = (j + 1) % n
        mx = (ring[j][0] + ring[k][0]) / 2
        my = (ring[j][1] + ring[k][1]) / 2
        quad_out(p, [tip, ring[j], ring[k]], (mx, my, outward_z), zone)


def dside(p, quad, zone):
    """Double-sided non-planar quad: explicit tris, SAME diagonal both
    sides (reversed quads fan the other diagonal — pitfall)."""
    a, b, c, d = quad
    for tri in ((a, b, c), (a, c, d)):
        p.add_face(list(tri), zone=zone)
    for tri in ((c, b, a), (d, c, a)):
        p.add_face(list(tri), zone=zone)


def box(p, center, size, zone, ch=0.03, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def hull_zone(c, n):
    if n[1] > 0.6:
        return S.Z_TOP
    if n[1] < -0.6:
        return S.Z_BELLY
    return S.Z_FLANK


def cas_zone(c, n):
    if abs(n[1]) > 0.6:
        return S.Z_CAS_TOP
    return S.Z_CAS_SIDE


def sail_zone(c, n):
    if n[1] > 0.6:
        return S.Z_SAIL_TOP
    if n[0] > 0.35:
        return S.Z_SAIL_S
    if n[0] < -0.35:
        return S.Z_SAIL_S_M
    return S.Z_SAIL_WRAP


# ── body ─────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')

    # hull of revolution (teardrop, axis y=0)
    rings = [ngon_ring((0, 0, z), r, n=S.SEG, axis='z')
             for (z, r) in S.HULL_STATIONS]
    loft(p, rings, hull_zone)
    fan_to_point(p, rings[0], S.NOSE, -0.7, S.Z_FLANK)      # bow tip
    fan_to_point(p, rings[-1], S.TAIL, 0.7, S.Z_FLANK)      # stern cone

    # free-flooding deck casing (flat-topped strip on the crown)
    cas = []
    for z in S.CAS_Z:
        r = hull_r(z)
        w = S.CAS_W_MAX * float(np.sqrt(r / S.R_MAX))
        yt = min(r + S.CAS_LIP, S.CAS_TOP_CAP)
        yb = r * S.CAS_SINK
        cas.append([(w, yb, z), (w, yt, z), (-w, yt, z), (-w, yb, z)])
    loft(p, cas, cas_zone)
    quad_out(p, cas[0], (0, 0.3, -1), S.Z_CAS_SIDE)         # fwd end face
    quad_out(p, cas[-1], (0, 0.3, 1), S.Z_CAS_SIDE)         # aft end face

    # sail: tall narrow vertical-sided fin, well forward
    def sail_ring(y, le, te):
        hw = S.SAIL_HW
        return [(hw, y, te), (hw, y, le + 0.30), (0.0, y, le - 0.12),
                (-hw, y, le + 0.30), (-hw, y, te)]

    lb, tb = S.SAIL_CHORD_BASE
    lt, tt = S.SAIL_CHORD_TOP
    ym = (S.SAIL_BASE + S.SAIL_TOP) / 2
    srings = [sail_ring(S.SAIL_BASE, lb, tb),
              sail_ring(ym, (lb + lt) / 2, (tb + tt) / 2),
              sail_ring(S.SAIL_TOP, lt, tt)]
    loft(p, srings, sail_zone)
    quad_out(p, srings[-1], (0, 1, 0), S.Z_SAIL_TOP)        # top cap

    # masts: periscope (emissive head dot lives in Z_PERI) + snorkel
    limb(p, S.PERI_BASE, S.PERI_TOP, 0.055, 0.05, S.Z_PERI, n=4,
         cap_end=S.Z_DARK)
    limb(p, S.SNORK_BASE, S.SNORK_TOP, 0.075, 0.065, S.Z_MAST, n=4,
         cap_end=S.Z_DARK)

    # fixed bow planes (single through-box near the nose)
    bp = S.BOWPLANE
    box(p, (0.0, bp['y'], bp['z']), (bp['span'], bp['th'], bp['chord']),
        S.Z_PLANE_H, ch=0.03)

    # cruciform stern planes
    sh, sv = S.STERN_H, S.STERN_V
    box(p, (0.0, 0.0, sh['z']), (sh['span'], sh['th'], sh['chord']),
        S.Z_PLANE_H, ch=0.03)
    box(p, (0.0, 0.0, sv['z']), (sv['th'], sv['span'], sv['chord']),
        S.Z_PLANE_V, ch=0.03)

    # single open screw: hub + 4 pitched blades (double-sided quads)
    limb(p, (0, 0, S.HUB_Z0), (0, 0, S.HUB_Z1), S.HUB_R0, S.HUB_R1,
         S.Z_HUB, n=6, cap_end=S.Z_DARK)
    hub_c = np.array([0.0, 0.0, S.BLADE_Z])
    for a in np.radians([45.0, 135.0, 225.0, 315.0]):
        rd = np.array([np.cos(a), np.sin(a), 0.0])
        td = np.array([-np.sin(a), np.cos(a), 0.0])
        zd = np.array([0.0, 0.0, 1.0])
        c0 = hub_c + rd * S.BLADE_R0 - zd * S.BLADE_CH0 + td * S.BLADE_PITCH
        c1 = hub_c + rd * S.BLADE_R0 + zd * S.BLADE_CH0 - td * S.BLADE_PITCH
        c2 = hub_c + rd * S.BLADE_R1 + zd * S.BLADE_CH1 - td * S.BLADE_PITCH * 1.6
        c3 = hub_c + rd * S.BLADE_R1 - zd * S.BLADE_CH1 + td * S.BLADE_PITCH * 1.6
        dside(p, [tuple(c0), tuple(c1), tuple(c2), tuple(c3)], S.Z_PROP)

    # casing cleats (towing bollards): post + crossbar, both flanks
    for (cz,) in S.CLEATS:
        r = hull_r(cz)
        yt = min(r + S.CAS_LIP, S.CAS_TOP_CAP)
        w = S.CAS_W_MAX * float(np.sqrt(r / S.R_MAX))
        for sx in (1, -1):
            px = sx * (w - 0.10)
            limb(p, (px, yt - 0.05, cz), (px, yt + 0.26, cz), 0.055, 0.05,
                 S.Z_MAST, n=4)
            limb(p, (px, yt + 0.20, cz - 0.16), (px, yt + 0.20, cz + 0.16),
                 0.045, 0.045, S.Z_MAST, n=4, cap_start=S.Z_DARK,
                 cap_end=S.Z_DARK)

    # bow sonar blister (functional greeble, low forward)
    box(p, (0.0, -1.02, -6.9), (0.55, 0.40, 1.00), S.Z_BELLY, ch=0.06)

    return p


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='muzzle', parent=0, offset=S.MUZZLE_OFF, part=None),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = []          # s1 squad def: zero clips
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'TOTAL: {total} tris')
