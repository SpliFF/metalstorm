"""gen_ms_anc_bridge_span — build ms_anc_bridge_span (36 m ancient bridge).

ANCIENT REGISTER.  A single monolithic span with no supports between its
two plinths: the deck is dead level, the soffit sweeps up in one shallow
parabolic arc so the section thins from a 3.20 m haunch at the footings to
a 0.65 m blade at mid-span, and the blade is waisted inboard of the deck
fascia so the roadway cantilevers past it on both sides.  Down the centre
of the deck runs a recessed guide channel (cyan in the paint).  At
mid-span a perfect circle of alloy — inner radius 5.50 m, just clear of
the 5.40 m deck half width — is threaded around the span and touches
nothing: it hangs 0.80 m off the ground and rises 6.20 m over the deck.

TILEABLE: the loft cross-section at z = -18 and z = +18 is identical and
full width, and each end carries HALF a plinth (z 16.50..18.00), so two
chained segments merge into one 3.0 m pier.

Single static `body` piece, no clips, no team.  Forward -Z, up +Y, ground
Y=0, 1 u = 1 m.  Deterministic (no RNG in geometry).

Usage: python3 gen_ms_anc_bridge_span.py
"""
from __future__ import annotations
import numpy as np

import ms_anc_bridge_span_layout as L    # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, chamfer_box
from gltf_export import export

STEM = 'ms_anc_bridge_span'
OUT = 'out'
TAU = 2.0 * np.pi


# ── helpers ──────────────────────────────────────────────────────────────

def pbox(p, center, size, zones, skip=(), ch=0.0):
    if isinstance(zones, Zone):
        zones = {k: zones for k in ('+y', '-y', '+x', '-x', '+z', '-z')}
    chamfer_box(p, center, size, ch, zones, skip=skip)


def uvs_of(rect, us, vs):
    """Explicit per-vertex UVs inside an atlas rect; us/vs are 0..1."""
    x0, y0, x1, y1 = rect
    return [((x0 + u * (x1 - x0)) / M.ATLAS,
             (y0 + v * (y1 - y0)) / M.ATLAS) for u, v in zip(us, vs)]


# ── the arc: cross-section ring at a station z ───────────────────────────

def section(z):
    """Closed CCW (in XY) cross-section of the span at station z.

    CCW in XY, lofted toward +z, yields outward face normals.  Ten points:
    soffit corner, fascia foot, deck edge, guide-channel notch (4), deck
    edge, fascia foot, soffit corner.
    """
    t = abs(z) / L.Z1
    ys = L.DTOP - (L.T_MIN + (L.T_MAX - L.T_MIN) * t * t)   # soffit height
    bw = L.BW_END - L.BW_DIP * (1.0 - t * t)                # soffit half width
    dt, ed, cw, cd = L.DTOP, L.EDGE, L.CHW, L.CH
    return [
        (bw,     ys,      z),        # 0  soffit, right
        (L.HW,   dt - ed, z),        # 1  fascia foot, right
        (L.HW,   dt,      z),        # 2  deck edge, right
        (cw,     dt,      z),        # 3  channel lip, right
        (cw,     dt - cd, z),        # 4  channel floor, right
        (-cw,    dt - cd, z),        # 5  channel floor, left
        (-cw,    dt,      z),        # 6  channel lip, left
        (-L.HW,  dt,      z),        # 7  deck edge, left
        (-L.HW,  dt - ed, z),        # 8  fascia foot, left
        (-bw,    ys,      z),        # 9  soffit, left
    ]


# edge j -> j+1 of the section maps to this zone
EDGE_ZONES = ['Z_HAUNCH', 'Z_FASCIA', 'Z_DECK', 'Z_GUIDEW', 'Z_GUIDE',
              'Z_GUIDEW', 'Z_DECK', 'Z_FASCIA', 'Z_HAUNCH', 'Z_SOFFIT']


def build_span(p):
    zs = np.linspace(L.Z0, L.Z1, L.STATIONS)
    rings = [section(float(z)) for z in zs]
    zones = [getattr(L, n) for n in EDGE_ZONES]
    n = len(rings[0])
    for i in range(len(rings) - 1):
        r0, r1 = rings[i], rings[i + 1]
        for j in range(n):
            k = (j + 1) % n
            p.add_face([r0[j], r0[k], r1[k], r1[j]], zone=zones[j])
    # tile-end caps (coincident, opposite-facing between chained segments,
    # so backface culling keeps them from z-fighting)
    p.add_face(list(rings[0]), zone=L.Z_DARK, flip=True)
    p.add_face(list(rings[-1]), zone=L.Z_DARK)


# ── parapets: unbroken monolithic walls set in from the deck edge ────────

def build_parapets(p):
    yc = L.DTOP + L.PARA_H / 2.0
    for sx, ztop in ((1, L.Z_PARAT_R), (-1, L.Z_PARAT_L)):
        pbox(p, (sx * L.PARA_XC, yc, 0.0),
             (L.PARA_W, L.PARA_H, L.Z1 - L.Z0),
             {'+y': ztop, '+x': L.Z_PARA, '-x': L.Z_PARA,
              '+z': L.Z_DARK, '-z': L.Z_DARK},
             skip=('-y',), ch=0.06)


# ── plinth footings: half a pier hugging each tile end ───────────────────

def build_plinths(p):
    for sz, zx in ((1, L.Z_PIERX_P), (-1, L.Z_PIERX_N)):
        # pier shaft — narrower than the blade, so its top is buried in it
        pbox(p, (0.0, L.PIER_H / 2.0, sz * L.PIER_ZC),
             (L.PIER_W, L.PIER_H, L.PIER_D),
             {'+y': L.Z_DARK, '+x': zx, '-x': zx,
              '+z': L.Z_PIERF, '-z': L.Z_PIERF},
             skip=('-y',), ch=0.10)
        # ground pad — broader, part-buried in soil in the paint
        pbox(p, (0.0, L.PAD_H / 2.0, sz * L.PAD_ZC),
             (L.PAD_W, L.PAD_H, L.PAD_D), L.Z_PLINTH,
             skip=('-y',), ch=0.08)


# ── mid-span ring: a perfect circle that touches nothing ─────────────────

def build_ring(p):
    n, ri, ro = L.RING_N, L.RING_RI, L.RING_RO
    zf, zb = L.RING_D / 2.0, -L.RING_D / 2.0

    def pt(r, a, z):
        return (r * np.cos(a), L.RING_CY + r * np.sin(a), z)

    for i in range(n):
        a0, a1 = TAU * i / n, TAU * (i + 1) / n
        u0, u1 = i / n, (i + 1) / n
        # outer band (normal points away from the ring centre)
        p.add_face([pt(ro, a0, zf), pt(ro, a0, zb),
                    pt(ro, a1, zb), pt(ro, a1, zf)],
                   uvs=uvs_of(L.R_RING_O, (u0, u0, u1, u1), (0, 1, 1, 0)))
        # inner band — the glowing rim
        p.add_face([pt(ri, a0, zb), pt(ri, a0, zf),
                    pt(ri, a1, zf), pt(ri, a1, zb)],
                   uvs=uvs_of(L.R_RING_I, (u0, u0, u1, u1), (0, 1, 1, 0)))
        # annulus faces, +z then -z
        p.add_face([pt(ri, a0, zf), pt(ro, a0, zf),
                    pt(ro, a1, zf), pt(ri, a1, zf)],
                   uvs=uvs_of(L.R_RING_F, (u0, u0, u1, u1), (0, 1, 1, 0)))
        p.add_face([pt(ro, a0, zb), pt(ri, a0, zb),
                    pt(ri, a1, zb), pt(ro, a1, zb)],
                   uvs=uvs_of(L.R_RING_F, (u0, u0, u1, u1), (1, 0, 0, 1)))


def build_body():
    p = Part('body')
    build_span(p)
    build_parapets(p)
    build_plinths(p)
    build_ring(p)
    return p


def build_all():
    return [dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body())]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=[],
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=[],
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    lo, hi = pieces[0]['part'].bounds()
    print(f'[gen_{STEM}] total tris: {total}')
    print(f'[gen_{STEM}] bounds min {tuple(round(v, 2) for v in lo)} '
          f'max {tuple(round(v, 2) for v in hi)}')
