"""gen_ms_dress_dynasty — Dynasty dressing kit (accessory multi-root).

Eight ROOT pieces + one child in one glTF (spec: dressing kit):
  banner (root)          pole + crossbar + gilt finial, mount plate at y=0
    flag (child)         heraldic hanging cloth; `idle` wave clip (rigid
                         node rotation about the crossbar, LINEAR, 3.6 s,
                         seamless loop — last key repeats the first)
  rail_l / rail_r        gilt trim rails, deck-edge runs along Z
  crest                  crest plaque, back face = mount plane
  lantern_l / lantern_r  carriage lanterns (emissive glass in paint)
  cowl_l / cowl_r        ornamented exhaust cowls, gilt trumpet lip
Deterministic: geometry from ms_dress_dynasty_layout constants only.
Run: $PY gen_ms_dress_dynasty.py → out/ms_dress_dynasty{,_png}.gltf + .bin
"""
import numpy as np

import ms_dress_dynasty_layout as L
import meshlib
from meshlib import Part, chamfer_box, limb, ngon_ring
from gltf_export import export
import parts as PP

STEM = 'ms_dress_dynasty'
OUT = 'out'


def dbl_quad(p, a, b, c, d, zone):
    """Double-sided quad as explicit triangles with the SAME diagonal a-c
    on both sides (non-planar-safe, per FORGE-GUIDE pitfall)."""
    for tri in ((a, b, c), (a, c, d)):
        p.add_face(list(tri), zone=zone)
        p.add_face(list(tri[::-1]), zone=zone)


def ring_loft(p, stations, rect, n):
    """Vertical n-gon loft along +Y with parametric UVs: u = along the
    stations (rect x span), v = around (rect y span). Radial winding
    computed in the XZ plane (tube()'s helper is Z-axis-minded)."""
    x0, y0, x1, y1 = rect
    A = meshlib.ATLAS
    ys = [s[0] for s in stations]
    ymin, ymax = min(ys), max(ys)
    rings = [ngon_ring((0.0, y, 0.0), r, n=n, axis='y')
             for (y, r) in stations]
    for i in range(len(rings) - 1):
        r0, r1 = rings[i], rings[i + 1]
        u0 = (x0 + (x1 - x0) * (stations[i][0] - ymin) / (ymax - ymin)) / A
        u1 = (x0 + (x1 - x0) * (stations[i + 1][0] - ymin) / (ymax - ymin)) / A
        for j in range(n):
            k = (j + 1) % n
            va = (y0 + (y1 - y0) * j / n) / A
            vb = (y0 + (y1 - y0) * (j + 1) / n) / A
            quad = [r0[j], r0[k], r1[k], r1[j]]
            quv = [(u0, va), (u0, vb), (u1, vb), (u1, va)]
            c = np.mean(np.asarray(quad), axis=0)
            rad = np.array([c[0], 0.0, c[2]])
            nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                           np.asarray(quad[3]) - np.asarray(quad[0]))
            if np.dot(nrm, rad) < 0:
                quad, quv = quad[::-1], quv[::-1]
            p.add_face(quad, uvs=quv)
    return rings


# ── banner + flag ───────────────────────────────────────────────────────

def build_banner():
    p = Part('banner')
    bw, bh, bd = L.POLE_BASE
    PP.box6(p, (0, bh / 2, 0), (bw, bh, bd), L.STEEL, ch=0.012, skip=('-y',))
    limb(p, (0, bh, 0), (0, L.POLE_H, 0), L.POLE_R0, L.POLE_R1,
         L.STEEL.rect, n=6)
    for by in L.POLE_BANDS:                      # gilt collar bands
        limb(p, (0, by, 0), (0, by + 0.09, 0), L.POLE_R0 + 0.012,
             L.POLE_R0 + 0.012, L.GOLD.rect, n=6)
    limb(p, (-L.BAR_HALF, L.BAR_Y, 0), (L.BAR_HALF, L.BAR_Y, 0),
         L.BAR_R, L.BAR_R, L.GOLD.rect, n=6,
         cap_start=L.GOLD, cap_end=L.GOLD)
    (y0, r0), (y1, r1), (y2, r2) = L.FINIAL      # gilt diamond finial
    limb(p, (0, y0, 0), (0, y1, 0), r0, r1, L.GOLD.rect, n=6)
    limb(p, (0, y1, 0), (0, y2, 0), r1, r2, L.GOLD.rect, n=6,
         cap_end=L.GOLD_TOP)
    return p


def build_flag():
    """Cloth banner, piece origin ON the crossbar (hinge for `idle`)."""
    p = Part('flag')
    xs = np.linspace(-L.CLOTH_HALF, L.CLOTH_HALF, L.CLOTH_COLS + 1)
    ys = np.linspace(-0.02, -L.CLOTH_DROP, L.CLOTH_ROWS + 1)

    def pt(x, y):
        t = -y / L.CLOTH_DROP
        z = L.CLOTH_SAG * t ** 1.5 + L.CLOTH_RIP * np.sin(x * 7.0 + t * 3.0) * t
        return (float(x), float(y), float(z))

    for i in range(L.CLOTH_COLS):
        for j in range(L.CLOTH_ROWS):
            dbl_quad(p, pt(xs[i], ys[j]), pt(xs[i + 1], ys[j]),
                     pt(xs[i + 1], ys[j + 1]), pt(xs[i], ys[j + 1]), L.FLAG)
    return p


# ── gilt trim rail ──────────────────────────────────────────────────────

def build_rail(name):
    p = Part(name)
    z = -L.RAIL_HALF
    while z <= L.RAIL_HALF + 1e-6:
        limb(p, (0, 0, z), (0, L.STANCH_H, z), L.STANCH_R[0], L.STANCH_R[1],
             L.STEEL.rect, n=4)
        z += L.RAIL_STEP
    over = 0.06                                   # rail ends overhang posts
    limb(p, (0, L.RAIL_TOP_Y, -L.RAIL_HALF - over),
         (0, L.RAIL_TOP_Y, L.RAIL_HALF + over), L.RAIL_TOP_R, L.RAIL_TOP_R,
         L.GOLD.rect, n=6, cap_start=L.GOLD, cap_end=L.GOLD)
    limb(p, (0, L.RAIL_MID_Y, -L.RAIL_HALF), (0, L.RAIL_MID_Y, L.RAIL_HALF),
         L.RAIL_MID_R, L.RAIL_MID_R, L.GOLD.rect, n=4,
         cap_start=L.GOLD, cap_end=L.GOLD)
    return p


# ── crest plaque ────────────────────────────────────────────────────────

def build_crest():
    p = Part('crest')
    bw, bh, bd = L.BOARD_SIZE
    PP.box6(p, (0, bh / 2, L.BOARD_CZ), (bw, bh, bd), L.GOLD, ch=0.02)
    pw, ph, pd = L.PANEL_SIZE
    chamfer_box(p, (0, ph / 2 + 0.08, L.PANEL_CZ), (pw, ph, pd), 0.015,
                {'-z': L.CREST_F, '+z': L.CREST_F, '+x': L.CREST_S,
                 '-x': L.CREST_S, '+y': L.GOLD_TOP, '-y': L.GOLD_TOP})
    return p


# ── carriage lantern ────────────────────────────────────────────────────

def build_lantern(name):
    p = Part(name)
    bw, bh, bd = L.LANT_BASE
    PP.box6(p, (0, bh / 2, 0), (bw, bh, bd), L.STEEL, ch=0.01, skip=('-y',))
    w, h, d = L.LANT_BODY
    chamfer_box(p, (0, L.LANT_BODY_Y, 0), (w, h, d), 0.015,
                {'+z': L.LANT_X, '-z': L.LANT_X, '+x': L.LANT_Z,
                 '-x': L.LANT_Z, '+y': L.LANT_TOP}, skip=('-y',))
    (ry0, rr0), (ry1, rr1) = L.LANT_ROOF          # gilt pyramid roof
    limb(p, (0, ry0, 0), (0, ry1, 0), rr0, rr1, L.GOLD.rect, n=4,
         cap_end=L.GOLD_TOP)
    return p


# ── ornamented exhaust cowl ─────────────────────────────────────────────

def build_cowl(name):
    p = Part(name)
    fw, fh, fd = L.COWL_FLANGE
    PP.box6(p, (0, fh / 2, 0), (fw, fh, fd), L.STEEL, ch=0.012, skip=('-y',))
    rings = ring_loft(p, L.COWL_STATIONS, L.COWL_WRAP, L.COWL_N)
    p.add_face(list(rings[-1]), zone=L.DARK, flip=True)   # dark throat cap
    return p


# ── clips ───────────────────────────────────────────────────────────────

def qx(deg):
    r = np.radians(deg) / 2
    return (float(np.sin(r)), 0.0, 0.0, float(np.cos(r)))


def build_clips():
    # `idle`: cloth sways about the crossbar (piece-origin X axis).
    # Seamless loop — last key repeats the first.
    keys = [(0.0, qx(0.0)), (0.9, qx(7.0)), (1.8, qx(0.0)),
            (2.7, qx(-7.0)), (3.6, qx(0.0))]
    return [{'name': 'idle', 'channels': [('flag', 'rotation', keys)]}]


def build_all():
    return [
        dict(name='banner', parent=-1, offset=L.BANNER_OFF,
             part=build_banner()),
        dict(name='flag', parent=0, offset=(0.0, L.BAR_Y, 0.0),
             part=build_flag()),
        dict(name='rail_l', parent=-1, offset=L.RAIL_L_OFF,
             part=build_rail('rail_l')),
        dict(name='rail_r', parent=-1, offset=L.RAIL_R_OFF,
             part=build_rail('rail_r')),
        dict(name='crest', parent=-1, offset=L.CREST_OFF,
             part=build_crest()),
        dict(name='lantern_l', parent=-1, offset=L.LANT_L_OFF,
             part=build_lantern('lantern_l')),
        dict(name='lantern_r', parent=-1, offset=L.LANT_R_OFF,
             part=build_lantern('lantern_r')),
        dict(name='cowl_l', parent=-1, offset=L.COWL_L_OFF,
             part=build_cowl('cowl_l')),
        dict(name='cowl_r', parent=-1, offset=L.COWL_R_OFF,
             part=build_cowl('cowl_r')),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_dress_dynasty] total tris: {total}')
