"""gen_ms_dig_site — assemble ms_dig_site and export .gltf/.bin.

Ancient-tech cache dig site (map prop, no team): ground ring at Y=0 with
a 1.6 m excavation pit, timber scaffold frame over the pit, animated
`hoist` (pulley block + cable + skip bucket; idle raise/lower clip,
ABSOLUTE translation keys, seamless), spoil heaps, crates of finds,
string-line survey grid, two warm work lights.
Run: $PY gen_ms_dig_site.py -> out/ms_dig_site{,_png}.gltf + .bin
"""
import numpy as np

import ms_dig_site_layout as F     # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, Zone, chamfer_box, limb
from gltf_export import export
import parts as P

STEM = 'ms_dig_site'
OUT = 'out'
RNG = np.random.default_rng(90210)


def build_body():
    p = Part('body')
    G, H, D = F.G_HALF, F.P_HALF, F.P_DEPTH

    # ── ground ring at Y=0 (4 trapezoid strips around the pit) ───────────
    strips = [((-G, -G), (G, -H)),   # north  (z -G..-H, full x)
              ((-G, H), (G, G)),     # south
              ((-G, -H), (-H, H)),   # west
              ((H, -H), (G, H))]     # east
    for (x0, z0), (x1, z1) in strips:
        P.quad_out(p, [(x0, 0, z0), (x1, 0, z0), (x1, 0, z1), (x0, 0, z1)],
                   (0, 1, 0), F.R_GROUND)

    # ── pit walls (face inward) + floor ──────────────────────────────────
    P.quad_out(p, [(-H, 0, -H), (H, 0, -H), (H, -D, -H), (-H, -D, -H)],
               (0, 0, 1), F.R_PITW_X)     # north wall faces +z
    P.quad_out(p, [(-H, 0, H), (H, 0, H), (H, -D, H), (-H, -D, H)],
               (0, 0, -1), F.R_PITW_X)    # south wall faces -z
    P.quad_out(p, [(-H, 0, -H), (-H, 0, H), (-H, -D, H), (-H, -D, -H)],
               (1, 0, 0), F.R_PITW_Z)     # west wall faces +x
    P.quad_out(p, [(H, 0, -H), (H, 0, H), (H, -D, H), (H, -D, -H)],
               (-1, 0, 0), F.R_PITW_Z)    # east wall faces -x
    P.quad_out(p, [(-H, -D, -H), (H, -D, -H), (H, -D, H), (-H, -D, H)],
               (0, 1, 0), F.R_PITF)       # pit floor

    # half-exposed ancient slab corner proud of the pit floor (texture-led)
    chamfer_box(p, (0.45, -D + 0.09, 0.25), (2.0, 0.18, 1.5), 0.03,
                {'+y': F.R_PITF, '+x': F.R_PITW_X, '-x': F.R_PITW_X,
                 '+z': F.R_PITW_X, '-z': F.R_PITW_X}, skip=('-y',))

    # ── timber scaffold frame over the pit ───────────────────────────────
    for sx in (-1, 1):
        for sz in (-1, 1):
            limb(p, (sx * F.LEG_B, 0, sz * F.LEG_B),
                 (sx * F.LEG_T, F.FRAME_Y, sz * F.LEG_T),
                 0.09, 0.075, F.R_WOOD, n=4)
    t = F.LEG_T
    tops = [(-t, F.FRAME_Y, -t), (t, F.FRAME_Y, -t),
            (t, F.FRAME_Y, t), (-t, F.FRAME_Y, t)]
    for i in range(4):
        limb(p, tops[i], tops[(i + 1) % 4], 0.07, 0.07, F.R_WOOD, n=4)
    # hoist rail cross beam (hoist hangs from its centre)
    limb(p, (-t, F.BEAM_Y, 0), (t, F.BEAM_Y, 0), 0.08, 0.08, F.R_WOOD, n=4)
    # diagonal braces on the ±x faces
    for sx in (-1, 1):
        b = F.LEG_B * 0.96
        limb(p, (sx * b, 0.15, -b), (sx * t, F.FRAME_Y - 0.1, t),
             0.05, 0.05, F.R_WOOD, n=4)
        limb(p, (sx * b, 0.15, b), (sx * t, F.FRAME_Y - 0.1, -t),
             0.05, 0.05, F.R_WOOD, n=4)

    # ── spoil heaps (4-sided dirt mounds) ────────────────────────────────
    for (cx, cy, cz, bh, hh), zone in ((F.SPOIL_A, F.R_SPOIL1),
                                       (F.SPOIL_B, F.R_SPOIL2)):
        base = [(cx - bh, 0, cz - bh), (cx + bh, 0, cz - bh),
                (cx + bh, 0, cz + bh), (cx - bh, 0, cz + bh)]
        apex = (cx + 0.15, hh, cz - 0.1)
        for i in range(4):
            a, b = base[i], base[(i + 1) % 4]
            n = np.cross(np.subtract(b, a), np.subtract(apex, a))
            p.add_face([a, b, apex] if n[1] > 0 else [b, a, apex], zone=zone)

    # ── crates of finds ──────────────────────────────────────────────────
    cx, cy, cz, s = F.CRATE_A
    P.crate(p, (cx, cy, cz), size=s, zone=F.R_CRATE)
    cx, cy, cz, s = F.CRATE_B
    P.crate(p, (cx, cy, cz), size=s, zone=F.R_CRATE)

    # ── string-line survey grid: 8 stakes + perimeter + 2 cross strings ──
    r, sy = F.STAKE_R, F.STRING_Y
    ring = [(-r, -r), (0, -r), (r, -r), (r, 0), (r, r), (0, r), (-r, r), (-r, 0)]
    for (x, z) in ring:
        limb(p, (x, 0, z), (x, F.STAKE_H, z), 0.022, 0.018, F.R_WOOD, n=3)
    for i in range(8):
        x0, z0 = ring[i]
        x1, z1 = ring[(i + 1) % 8]
        limb(p, (x0, sy, z0), (x1, sy, z1), 0.012, 0.012, F.R_STRING, n=3)
    limb(p, (0, sy, -r), (0, sy, r), 0.012, 0.012, F.R_STRING, n=3)
    limb(p, (-r, sy, 0), (r, sy, 0), 0.012, 0.012, F.R_STRING, n=3)

    # ── work lights: post + head, emissive faces aimed at the pit ────────
    for (lx, lz), inward in ((F.LAMP_A, ('+x', '-z')),
                             (F.LAMP_B, ('-x', '+z'))):
        limb(p, (lx, 0, lz), (lx, F.LAMP_H, lz), 0.05, 0.04, F.R_STEEL, n=4)
        zones = {f: (F.R_LAMP if f in inward else F.R_LAMPBOX)
                 for f in ('+x', '-x', '+y', '-y', '+z', '-z')}
        chamfer_box(p, (lx, F.LAMP_H + 0.1, lz), (0.30, 0.24, 0.24),
                    0.03, zones)
    return p


def build_hoist():
    """Hoist, piece-local frame: pivot at the cross-beam centre. Pulley
    block at the origin, cable down to a hook and a skip bucket. The idle
    clip translates the whole piece down into the pit and back."""
    p = Part('hoist')
    # pulley block hanging just under the beam
    chamfer_box(p, (0, -0.14, 0), (0.24, 0.30, 0.16), 0.03,
                {f: F.R_HOIST for f in ('+x', '-x', '+y', '-y', '+z', '-z')})
    # cable
    limb(p, (0, -0.28, 0), (0, -0.86, 0), 0.018, 0.018, F.R_STEEL, n=3)
    # hook (two short limbs give the crook read)
    limb(p, (0, -0.86, 0), (0, -1.0, 0.05), 0.03, 0.025, F.R_STEEL, n=4)
    limb(p, (0, -1.0, 0.05), (0, -0.98, -0.04), 0.025, 0.02, F.R_STEEL, n=4)
    # skip bucket of finds on the hook
    chamfer_box(p, (0, -1.22, 0), (0.55, 0.36, 0.42), 0.04,
                {f: F.R_HOIST for f in ('+x', '-x', '+y', '-y', '+z', '-z')})
    # sling straps from bucket rim up to the hook
    for sx in (-1, 1):
        limb(p, (sx * 0.24, -1.05, 0), (0, -0.88, 0), 0.015, 0.015,
             F.R_STEEL, n=3)
    return p


def build_clips():
    """10 s raise/lower: ABSOLUTE translation keys around the rest offset
    (0, BEAM_Y, 0); sine-eased, seamless (last key repeats the first)."""
    T = 10.0
    keys = []
    for i in range(9):
        t = T * i / 8
        y = F.BEAM_Y - F.HOIST_DROP * (1 - np.cos(2 * np.pi * t / T))
        keys.append((t, (0.0, float(y), 0.0)))
    return [{'name': 'idle', 'channels': [('hoist', 'translation', keys)]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='hoist', parent=0, offset=F.HOIST_OFF, part=build_hoist()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=build_clips(), normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=build_clips(), normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
