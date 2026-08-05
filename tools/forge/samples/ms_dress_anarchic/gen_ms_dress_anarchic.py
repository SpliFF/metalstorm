"""gen_ms_dress_anarchic — Anarchic dressing kit (Mad-Max salvage register).

Six elements as separate ROOT pieces in one glTF, sized against the
fable_tank / fable_heavy hulls (dims in the layout docstring):
  plates / prow / trophies / totem / brazier (+child `flame`) / streamer
Clip `idle`: flame flicker (scale channel on `flame`, seamless loop).
Deterministic: geometry from ms_dress_anarchic_layout constants only.
Also writes out/README.txt with per-element mount offsets.
Run: python3 gen_ms_dress_anarchic.py -> out/ms_dress_anarchic{,_png}.gltf
"""
import numpy as np

import ms_dress_anarchic_layout as L
from meshlib import Part, chamfer_box, limb, ngon_ring
from gltf_export import export
import parts as P

STEM = 'ms_dress_anarchic'
OUT = 'out'


def dquad(p, verts, zone):
    """Double-sided planar quad: explicit triangles, SAME diagonal on both
    sides (forge pitfall: reversed quads fan the other diagonal)."""
    v0, v1, v2, v3 = verts
    p.add_face([v0, v1, v2], zone=zone)
    p.add_face([v0, v2, v3], zone=zone)
    p.add_face([v0, v2, v1], zone=zone)
    p.add_face([v0, v3, v2], zone=zone)


# ── plates: welded scrap plate set ──────────────────────────────────────

def build_plates():
    p = Part('plates')
    for (cx, w, y0, top, zoff) in L.PLATE_SET:
        h = top - y0
        chamfer_box(p, (cx, y0 + h / 2, zoff), (w, h, L.PLATE_T), L.PLATE_CH,
                    {'-z': L.PLATES_F, '+z': L.PLATES_B, '+y': L.PLATES_TOP,
                     '-y': L.TRIM, '+x': L.TRIM, '-x': L.TRIM})
    return p


# ── prow: spike/ram V-plow ──────────────────────────────────────────────

def build_prow():
    p = Part('prow')
    nz, tz = L.PROW_NOSE_Z, L.PROW_TAIL_Z
    y0, y1, t = L.PROW_Y0, L.PROW_Y1, L.PROW_T
    for sx in (-1, 1):
        nx = sx * L.PROW_NOSE_HX
        tx = sx * L.PROW_TAIL_X
        d = np.array([tx - nx, 0.0, tz - nz])
        nrm = np.array([d[2], 0.0, -d[0]])
        nrm = nrm / np.linalg.norm(nrm)
        if nrm[2] > 0:               # outward = forward (-Z) side
            nrm = -nrm
        off = nrm * -t               # inner face pushed back
        o = [(nx, y0, nz), (tx, y0, tz), (tx, y1, tz), (nx, y1, nz)]
        i = [tuple(np.asarray(v) + off) for v in o]
        P.quad_out(p, o, tuple(nrm), L.PROW_F)                    # outer
        P.quad_out(p, i, tuple(-nrm), L.PROW_F)                   # inner
        P.quad_out(p, [o[3], o[2], i[2], i[3]], (0, 1, 0), L.PROW_TOP)  # top
        P.quad_out(p, [o[1], o[2], i[2], i[1]], (sx, 0, 1), L.TRIM)     # tail
        # spikes off the outer face, tilted up
        for (ft, by) in L.PROW_SPIKES:
            base = np.array([nx, 0, nz]) + d * ft
            base[1] = by
            sdir = nrm + np.array([0.0, L.SPIKE_UP, 0.0])
            sdir = sdir / np.linalg.norm(sdir)
            limb(p, tuple(base - nrm * t * 0.4),
                 tuple(base + sdir * L.SPIKE_LEN), L.SPIKE_R0, 0.008,
                 L.SPIKE_R, n=3)
    # blunt nose plate closing the apex gap
    P.quad_out(p, [(-L.PROW_NOSE_HX, y0, nz), (L.PROW_NOSE_HX, y0, nz),
                   (L.PROW_NOSE_HX, y1, nz), (-L.PROW_NOSE_HX, y1, nz)],
               (0, 0, -1), L.PROW_F)
    return p


# ── trophies: chained trophy rack ───────────────────────────────────────

def build_trophies():
    p = Part('trophies')
    for sx in (-1, 1):
        limb(p, (sx * L.RACK_HX, 0.0, 0.0), (sx * L.RACK_HX, L.RACK_H, 0.0),
             0.055, 0.045, L.POLE_R, n=4, cap_end=L.TRIM)
    limb(p, (-L.RACK_HX, L.RACK_BAR_Y, 0.0), (L.RACK_HX, L.RACK_BAR_Y, 0.0),
         0.05, 0.05, L.BAR_R, n=4)
    zones = (L.TROPHY_A, L.TROPHY_B, L.TROPHY_C)
    for (cx, cy, size, ch, top), zone in zip(L.TROPHY_DEFS, zones):
        limb(p, (cx, L.RACK_BAR_Y - 0.02, 0.0), (cx, top, 0.0),
             L.CHAIN_R0, L.CHAIN_R0, L.CHAIN_R, n=3)
        P.box6(p, (cx, cy, 0.0), size, zone, ch=ch)
    return p


# ── totem: skull-and-bolts totem pole ───────────────────────────────────

def build_totem():
    p = Part('totem')
    limb(p, (0.0, 0.0, 0.0), (0.0, L.POLE_H, 0.0), L.POLE_R0, L.POLE_R1,
         L.POLE_R, n=6, cap_end=L.DARK)
    chamfer_box(p, L.SKULL_C, L.SKULL_SIZE, L.SKULL_CH,
                {'-z': L.SKULL_F, '+z': L.SKULL_S, '+x': L.SKULL_S,
                 '-x': L.SKULL_S, '+y': L.SKULL_TOP, '-y': L.DARK})
    for sx in (-1, 1):
        bx, by, bz = L.HORN_BASE
        tx, ty, tz = L.HORN_TIP
        limb(p, (sx * bx, by, bz), (sx * tx, ty, tz), 0.045, 0.012,
             L.HORN_R, n=3)
    limb(p, (-L.XBAR_HX, L.XBAR_Y, 0.0), (L.XBAR_HX, L.XBAR_Y, 0.0),
         L.XBAR_R, L.XBAR_R, L.BAR_R, n=4, cap_start=L.TRIM, cap_end=L.TRIM)
    for sx in (-1, 1):
        x = sx * L.TOKEN_X
        hw = L.TOKEN_W / 2
        dquad(p, [(x - hw, L.TOKEN_Y1, 0.02), (x + hw, L.TOKEN_Y1, 0.02),
                  (x + hw * 0.8, L.TOKEN_Y0, 0.10),
                  (x - hw * 0.8, L.TOKEN_Y0, 0.10)], L.TOKEN)
    return p


# ── brazier: flame-drum + child flame ───────────────────────────────────

def build_brazier():
    p = Part('brazier')
    rings = [ngon_ring((0.0, y, 0.0), r, n=L.DRUM_N, axis='y')
             for (y, r) in L.DRUM_RINGS]
    for i in range(len(rings) - 1):
        r0, r1 = rings[i], rings[i + 1]
        for j in range(L.DRUM_N):
            k = (j + 1) % L.DRUM_N
            quad = [r0[j], r0[k], r1[k], r1[j]]
            c = np.mean(np.array(quad), axis=0)
            P.quad_out(p, quad, (c[0], 0.0, c[2]), L.DRUM)
    p.add_face(list(rings[-1]), zone=L.COALS)   # coals cap at the rim
    return p


def build_flame():
    p = Part('flame')
    for axis in ('x', 'z'):
        w0, w1, h = L.FLAME_HW0, L.FLAME_HW1, L.FLAME_H
        if axis == 'x':
            verts = [(-w0, 0.0, 0.0), (w0, 0.0, 0.0),
                     (w1, h, 0.0), (-w1, h, 0.0)]
        else:
            verts = [(0.0, 0.0, -w0), (0.0, 0.0, w0),
                     (0.0, h, w1), (0.0, h, -w1)]
        dquad(p, verts, L.FLAME)
    return p


# ── streamer: team rag on a mast ────────────────────────────────────────

def build_streamer():
    p = Part('streamer')
    limb(p, (0.0, 0.0, 0.0), (0.0, L.MAST_H, 0.0), L.MAST_R0, L.MAST_R1,
         L.MAST_R, n=4, cap_end=L.DARK)
    e = L.RAG_EDGES
    for (a, b) in zip(e, e[1:]):
        ax, at, ab, az = a
        bx, bt, bb, bz = b
        dquad(p, [(ax, at, az), (bx, bt, bz), (bx, bb, bz), (ax, ab, az)],
              L.RAG)
    return p


# ── clips ───────────────────────────────────────────────────────────────

def build_clips():
    # idle: flame flicker — scale about the rim mount; seamless loop
    keys = [(0.00, (1.00, 1.00, 1.00)),
            (0.28, (1.12, 0.92, 1.12)),
            (0.55, (0.94, 1.08, 0.94)),
            (0.82, (1.07, 0.96, 1.07)),
            (1.10, (1.00, 1.00, 1.00))]
    return [{'name': 'idle', 'channels': [('flame', 'scale', keys)]}]


def build_all():
    return [
        dict(name='plates', parent=-1, offset=L.PLATES_OFF,
             part=build_plates()),
        dict(name='prow', parent=-1, offset=L.PROW_OFF, part=build_prow()),
        dict(name='trophies', parent=-1, offset=L.RACK_OFF,
             part=build_trophies()),
        dict(name='totem', parent=-1, offset=L.TOTEM_OFF, part=build_totem()),
        dict(name='brazier', parent=-1, offset=L.BRAZIER_OFF,
             part=build_brazier()),
        dict(name='flame', parent=4, offset=(0.0, L.RIM_Y, 0.0),
             part=build_flame()),
        dict(name='streamer', parent=-1, offset=L.STREAMER_OFF,
             part=build_streamer()),
    ]


README = """ms_dress_anarchic — Anarchic dressing kit (mount offsets)

Kit pieces are authored piece-local, ground Y=0, forward -Z, 1 unit = 1 m.
Root offsets in this glTF fan the kit out along X for display ONLY —
zero the root offset when mounting a single element.  Hull dims used
(from toolkit layout.py / heavy_layout.py):
  fable_tank : hull z -4.40..4.40, half-width 1.75, side y 0.15..2.05, deck y 1.86
  fable_heavy: hull z -8.10..8.10, half-width 2.35, side y 0.25..3.15, deck y 3.02

plates  (scrap skirt, 3.9 m x 1.7 m, faces -Z, base y 0)
  fable_tank side : yaw ±90° about Y, offset (±1.87, 0.10, 0.0)
  fable_heavy side: yaw ±90° about Y, offset (±2.47, 0.30, ∓2.0) and (±2.47, 0.30, ±1.9)
                    (two sets fore/aft cover the 16 m hull)
plates rear: no yaw, offset (0, 0.10, +4.46) tank / (0, 0.30, +8.16) heavy
prow    (V-ram, apex local z -1.18, wing tails z +0.06)
  fable_tank glacis : offset (0, 0.15, -3.40)  -> apex at world z -4.58
  fable_heavy glacis: scale 1.30, offset (0, 0.30, -6.95)
trophies (rack 1.7 m wide x 2.15 m)
  deck mount tank  : offset (0, 1.86, +2.6), any yaw
  deck mount heavy : offset (0, 3.02, +5.5)
totem   (2.7 m pole; skull top y 2.57)
  ground prop at any position, or deck: (±0.9, 1.86, +3.4) tank,
  (±1.3, 3.02, +6.8) heavy
brazier (fire drum r 0.37, rim y 0.92; child piece `flame` at (0, 0.92, 0),
  clip `idle` = flicker)  ground prop, or heavy rear deck (0, 3.02, +7.2)
streamer (1.85 m mast, rag flies +X; team colour via team mask)
  turret/deck corner: (±1.5, 1.86, +3.9) tank, (±2.1, 3.02, +7.6) heavy;
  yaw to taste (rag reads best cross-wind)

Engine-radius note: the display fan-out (x -8.2..+8.6) inflates the
whole-model radius; per-element radii are <= 2.2 m once re-rooted.
"""


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    with open(f'{OUT}/README.txt', 'w') as f:
        f.write(README)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_dress_anarchic] {total} tris')
