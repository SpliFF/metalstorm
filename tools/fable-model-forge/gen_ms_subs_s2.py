"""gen_ms_subs_s2 — attack sub pair boat (subs row s2, 30.0 m).

Single mesh piece `body` (subs have no traversing weapons): 12-segment
teardrop hull of revolution on the y=0 centreline, faired teardrop sail
with SAIL-MOUNTED DIVE PLANES (tier signature), cruciform stern planes,
single open five-blade screw, periscope/snorkel stubs, flank sonar
blisters. `muzzle` empty at the bow torpedo tube tip. No clips (squad
def — rest pose only).

Usage: python gen_ms_subs_s2.py
"""
from __future__ import annotations
import numpy as np

import ms_subs_s2_layout as S      # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, loft, ngon_ring, limb, tube
from gltf_export import export
import parts as PT

STEM = 'ms_subs_s2'
OUT = 'out'


# ── hull zone chooser ────────────────────────────────────────────────────

def hull_zone(c, n):
    if n[1] > 0.45:
        return S.S_TOP
    if n[1] < -0.45:
        return S.S_BELLY
    return S.S_HULL_SIDE


def sail_zone(c, n):
    if n[1] > 0.6:
        return S.S_SAIL_T
    # port (-x) faces read the base zone correctly; starboard gets the twin
    return S.S_SAIL if n[0] < 0 else S.S_SAIL_M


def sail_ring(y, zle, zte, w):
    """Teardrop plan outline, ordered nose -> -x side -> tail -> +x side
    (outward winding for a bottom-to-top loft)."""
    c = zte - zle
    pts = [(0.0, y, zle)]
    for t, f in S.SAIL_PROF:
        pts.append((-w * f, y, zle + t * c))
    pts.append((0.0, y, zte))
    for t, f in reversed(S.SAIL_PROF):
        pts.append((w * f, y, zle + t * c))
    return pts


def cyl(r, a, z):
    return (r * np.cos(a), r * np.sin(a), z)


# ── body ─────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')

    # hull of revolution (blunt bow cap = torpedo door face; stern cap
    # hidden behind the screw hub)
    rings = [ngon_ring((0.0, 0.0, z), r, n=S.SEGS, axis='z')
             for (z, r) in S.STATIONS]
    loft(p, rings, hull_zone, cap_start=S.S_BOW, cap_end=S.S_DARK)

    # faired teardrop sail + top cap
    srings = [sail_ring(*sr) for sr in S.SAIL_RINGS]
    loft(p, srings, sail_zone)
    p.add_face(list(srings[-1]), zone=S.S_SAIL_T)   # top cap (+y)

    # sail-mounted dive planes — tier signature
    cx, cy, cz = S.SAILPLANE_C
    for sx in (1, -1):
        PT.box6(p, (sx * cx, cy, cz), S.SAILPLANE_S, S.S_FIN, ch=0.03)

    # cruciform stern planes
    PT.box6(p, (0.0, 0.0, S.STERN_Z), S.STERNPLANE_H, S.S_SFIN, ch=0.03)
    PT.box6(p, (0.0, 0.0, S.STERN_Z), S.STERNPLANE_V, S.S_VFIN, ch=0.03)

    # single open screw: hub cone + 5 raked blades (double-sided tris,
    # same diagonal both sides)
    tube(p, S.HUB_STATIONS, S.S_HUB, n=6, axis='z', cap_start=S.S_DARK)
    for k in range(S.BLADE_N):
        a = 2 * np.pi * k / S.BLADE_N
        rl = cyl(S.BLADE_R0, a - 0.30, S.BLADE_Z - 0.12)
        rt = cyl(S.BLADE_R0, a + 0.30, S.BLADE_Z + 0.12)
        tl = cyl(S.BLADE_R1, a - 0.14, S.BLADE_Z - 0.06)
        tt = cyl(S.BLADE_R1, a + 0.14, S.BLADE_Z + 0.06)
        for tri in ((rl, tl, tt), (rl, tt, rt)):
            p.add_face(list(tri), zone=S.S_PROP)
            p.add_face(list(tri)[::-1], zone=S.S_PROP)

    # periscope / snorkel mast stubs on the sail top
    for (p0, p1, r0, r1) in (S.PERISCOPE, S.SNORKEL):
        limb(p, p0, p1, r0, r1, S.S_MAST, n=4, cap_end=S.S_DARK)

    # flank sonar blisters
    bx, by, bz = S.BLISTER_C
    for sx in (1, -1):
        PT.box6(p, (sx * bx, by, bz), S.BLISTER_S, S.S_BLIST, ch=0.05)

    return p


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='muzzle', parent=0, offset=S.MUZZLE_OFF, part=None),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = []
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'TOTAL: {total} tris')
