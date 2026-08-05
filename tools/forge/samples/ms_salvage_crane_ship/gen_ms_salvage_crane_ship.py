"""gen_ms_salvage_crane_ship — build ms_salvage_crane_ship + clips.

Salvage crane ship, ships-row s3 (50 m): barge hull loft (waterline
Y=0, draft below), heavy lattice A-frame (lattice_tower idiom, its own
static piece so the origin-centred prefab lands at TOWER_Z) carrying a
laced boom cantilevered over the stern, travelling `trolley` piece with
cable-hung hook block (idle traverse clip, ABSOLUTE translation keys,
seamless), scrap heap + salvaged turret shell on the foredeck,
cutting-torch gantry, workshop cabin with stack, deck clutter.

Usage: python3 gen_ms_salvage_crane_ship.py [png]
"""
from __future__ import annotations
import numpy as np

import ms_salvage_crane_ship_layout as S  # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, loft, chamfer_box, ngon_ring, limb
from gltf_export import export
import parts as PT

STEM = 'ms_salvage_crane_ship'
OUT = 'out'
RNG = np.random.default_rng(90210)


def ring_from_section(sec):
    z, yb, yk, wb, wk, wd = sec
    yd = S.DECK_Y
    return [
        (wb, yb, z), (wk, yk, z), (wd, yd, z),
        (-wd, yd, z), (-wk, yk, z), (-wb, yb, z),
    ]


def hull_zone(c, n):
    if n[1] < -0.55:
        return S.S_BELLY
    if n[1] > 0.55:
        return S.S_DECK
    return S.S_HULL_SIDE


def box(p, center, size, zone, ch=0.04, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


# ── body ─────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    rings = [ring_from_section(s) for s in S.HULL_SECTIONS]
    loft(p, rings, hull_zone)

    # bow / stern end faces
    for sec, zone, outward in ((S.HULL_SECTIONS[0], S.S_BOW, (0, 0, -1)),
                               (S.HULL_SECTIONS[-1], S.S_STERN, (0, 0, 1))):
        z, yb, yk, wb, wk, wd = sec
        yd = S.DECK_Y
        PT.quad_out(p, [(-wb, yb, z), (wb, yb, z), (wk, yk, z),
                        (-wk, yk, z)], outward, zone)
        PT.quad_out(p, [(-wk, yk, z), (wk, yk, z), (wd, yd, z),
                        (-wd, yd, z)], outward, zone)

    # workshop cabin + stack
    x, y, z, w, h, d = S.CABIN
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+x': S.S_CABIN_S, '-x': S.S_CABIN_S, '+z': S.S_CABIN_F,
                 '-z': S.S_CABIN_F, '+y': S.S_CABIN_R}, skip=('-y',))
    limb(p, (1.6, S.DECK_Y + 2.0, -20.3), (S.EXHAUST_OFF[0], S.STACK_TOP,
         S.EXHAUST_OFF[2]), 0.22, 0.19, S.S_MAST, n=6, cap_end=S.S_DARK)

    # scrap heap: base mound + crushed plates + salvaged turret shell
    z0, z1 = S.SCRAP_Z
    box(p, (0.0, S.DECK_Y + 0.5, (z0 + z1) / 2), (6.4, 1.0, z1 - z0),
        S.S_SCRAP, ch=0.10, skip=('-y',))
    for i in range(6):
        px = float(RNG.uniform(-2.4, 2.4))
        pz = float(RNG.uniform(z0 + 1.2, z1 - 1.2))
        pw = float(RNG.uniform(1.2, 2.4))
        pd = float(RNG.uniform(1.0, 2.2))
        py = S.DECK_Y + 1.0 + float(RNG.uniform(0.0, 0.5))
        box(p, (px, py, pz), (pw, 0.16, pd), S.S_SCRAP, ch=0.02)
    tx, tz = S.TURRET_POS
    ty = S.DECK_Y + 1.55
    box(p, (tx, ty, tz), (2.6, 1.0, 2.8), S.S_TURRET, ch=0.10)
    limb(p, (tx, ty + 0.1, tz - 1.3), (tx, ty - 0.35, tz - 3.6),
         0.16, 0.13, S.S_MAST, n=4)     # drooping salvaged barrel

    # cutting-torch gantry: portal frame across the deck
    for sx in (1, -1):
        limb(p, (sx * S.GANTRY_HX, S.DECK_Y, S.GANTRY_Z),
             (sx * S.GANTRY_HX, S.GANTRY_H, S.GANTRY_Z), 0.12, 0.10,
             S.S_MAST, n=4)
    limb(p, (-S.GANTRY_HX, S.GANTRY_H, S.GANTRY_Z),
         (S.GANTRY_HX, S.GANTRY_H, S.GANTRY_Z), 0.11, 0.11, S.S_MAST, n=4)
    # torch carriage + head (emissive-zoned tip)
    box(p, (-1.2, S.GANTRY_H - 0.45, S.GANTRY_Z), (0.9, 0.7, 0.6),
        S.S_DARK, ch=0.04)
    limb(p, (-1.2, S.GANTRY_H - 0.8, S.GANTRY_Z),
         (-1.2, S.GANTRY_H - 1.9, S.GANTRY_Z), 0.05, 0.04, S.S_CABLE, n=3)
    box(p, (-1.2, S.GANTRY_H - 2.1, S.GANTRY_Z), (0.24, 0.4, 0.24),
        S.S_TORCH, ch=0.02)

    # deck railings (both edges)
    for (rz0, rz1) in S.RAIL_RUNS:
        for sx in (1, -1):
            PT.railing(p, (sx * S.RAIL_X, S.DECK_Y, rz0),
                       (sx * S.RAIL_X, S.DECK_Y, rz1), h=0.9,
                       post_step=3.0, r=0.045, zone=S.S_RAIL)

    # deck clutter: crates + drums by the gantry
    PT.crate_stack(p, (3.4, S.DECK_Y, 1.0), rows=2, cols=2, tiers=1,
                   size=1.1, zone=S.S_CRATE, rng=RNG)
    PT.drum_row(p, (-3.9, S.DECK_Y, 3.5), count=3, r=0.34, h=1.0,
                zone=S.S_DRUM, n=6)
    # mooring bollards
    for bz in (-14.0, 6.0, 20.0):
        for sx in (1, -1):
            limb(p, (sx * 5.0, S.DECK_Y, bz), (sx * 5.0, S.DECK_Y + 0.5, bz),
                 0.12, 0.12, S.S_MAST, n=4)
    return p


# ── A-frame crane (static piece at offset (0,0,TOWER_Z)) ─────────────────

def build_aframe():
    """Piece-local coords = world minus TOWER_Z on z, so the origin-centred
    lattice_tower prefab lands astride the deck at TOWER_Z."""
    p = Part('aframe')
    dz = -S.TOWER_Z

    PT.lattice_tower(p, S.TOWER_BASE, S.TOWER_TOP, S.TOWER_HB, S.TOWER_HT,
                     leg_r=0.16, brace_r=0.06, bands=2,
                     leg_zone=S.S_LATTICE, brace_zone=S.S_LATTICE)

    # boom: two chord pairs cantilevered over the stern, laced
    z0, z1 = S.BOOM_Z0 + dz, S.BOOM_Z1 + dz
    for sx in (1, -1):
        limb(p, (sx * S.BOOM_HX, S.BOOM_YLO, z0),
             (sx * S.BOOM_HX, S.BOOM_YLO, z1), 0.10, 0.09, S.S_BOOM, n=4)
        limb(p, (sx * S.BOOM_HX, S.BOOM_YHI, z0),
             (sx * S.BOOM_HX, S.BOOM_YHI, z1 - 1.0), 0.10, 0.08,
             S.S_BOOM, n=4)
    for lz in np.arange(z0, z1 - 0.5, S.LACE_STEP):
        nz = min(lz + S.LACE_STEP, z1 - 1.0)
        for sx in (1, -1):
            limb(p, (sx * S.BOOM_HX, S.BOOM_YLO, lz),
                 (sx * S.BOOM_HX, S.BOOM_YHI, nz), 0.045, 0.045,
                 S.S_BOOM, n=3)
        limb(p, (-S.BOOM_HX, S.BOOM_YLO, lz), (S.BOOM_HX, S.BOOM_YLO, lz),
             0.05, 0.05, S.S_BOOM, n=3)
    # boom tip cap + sheave block
    box(p, (0.0, (S.BOOM_YLO + S.BOOM_YHI) / 2, z1 - 0.4),
        (1.7, 1.3, 0.8), S.S_DARK, ch=0.05)
    # backstays: tower top forward to deck anchor
    for sx in (1, -1):
        limb(p, (sx * S.TOWER_HT, S.TOWER_TOP - 0.1, 0.0),
             (sx * 2.2, S.BACKSTAY_FOOT[1], S.BACKSTAY_FOOT[2] + dz),
             0.045, 0.045, S.S_CABLE, n=3)
    return p


# ── trolley ──────────────────────────────────────────────────────────────

def build_trolley():
    """Piece-local: origin at the carriage centre on the low-chord track;
    hook block hangs HOOK_DROP below on twin cables."""
    p = Part('trolley')
    box(p, (0.0, 0.0, 0.0), (1.9, 0.7, 1.3), S.S_TROLLEY, ch=0.05)
    # track rollers
    for sz in (0.5, -0.5):
        for sx in (0.8, -0.8):
            limb(p, (sx - 0.12, 0.42, sz), (sx + 0.12, 0.42, sz),
                 0.14, 0.14, S.S_DARK.rect, n=5)
    # twin hoist cables
    for sx in (0.35, -0.35):
        limb(p, (sx, -0.3, 0.0), (sx * 0.5, -S.HOOK_DROP + 0.4, 0.0),
             0.035, 0.035, S.S_CABLE, n=3)
    # hook block + hook
    box(p, (0.0, -S.HOOK_DROP, 0.0), (0.7, 0.9, 0.45), S.S_HOOK, ch=0.05)
    limb(p, (0.0, -S.HOOK_DROP - 0.45, 0.0),
         (0.0, -S.HOOK_DROP - 0.95, 0.0), 0.07, 0.07, S.S_HOOK.rect, n=4)
    limb(p, (0.0, -S.HOOK_DROP - 0.95, 0.0),
         (0.32, -S.HOOK_DROP - 0.75, 0.0), 0.06, 0.045, S.S_HOOK.rect, n=4)
    return p


# ── clips ────────────────────────────────────────────────────────────────

def build_clips():
    rx, ry, rz = S.TROLLEY_REST
    idle = {
        'name': 'idle',
        'channels': [
            ('trolley', 'translation', [
                (0.0, (rx, ry, rz)),
                (5.0, (rx, ry, S.TROLLEY_IN_Z)),
                (6.5, (rx, ry, S.TROLLEY_IN_Z)),
                (11.5, (rx, ry, rz)),
                (12.0, (rx, ry, rz)),
            ]),
        ],
    }
    return [idle]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),   # 0
        dict(name='aframe', parent=0, offset=(0, 0, S.TOWER_Z),
             part=build_aframe()),                                           # 1
        dict(name='trolley', parent=0, offset=S.TROLLEY_REST,
             part=build_trolley()),                                          # 2
        dict(name='exhaust', parent=0, offset=S.EXHAUST_OFF, part=None),
    ]
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_salvage_crane_ship] total tris: {total}')
