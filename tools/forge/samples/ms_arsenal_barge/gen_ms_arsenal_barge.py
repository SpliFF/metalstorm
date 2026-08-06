"""gen_ms_arsenal_barge — build ms_arsenal_barge + clips.

Resistance arsenal barge, ships-row s3 (55 m): flat-decked barge loft
(waterline Y=0, draft below), aft deckhouse, aim chain turret (slewing
mount) -> barrel (elevating rack of 8 launch tubes) -> muzzle (empty at
the tube mouths), sandbagged crew positions, tarped ammo crates, drums,
improvised plate shields on the deck edges. Clip: idle (subtle rack
breathe, seamless).

Usage: python3 gen_ms_arsenal_barge.py
"""
from __future__ import annotations
import numpy as np

import ms_arsenal_barge_layout as S  # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, loft, chamfer_box, tube, ngon_ring, limb
from gltf_export import export
import parts as PR

STEM = 'ms_arsenal_barge'
OUT = 'out'
RNG = np.random.default_rng(90210)


def ring_from_section(sec):
    z, yb, wb, wd = sec
    yk = yb + 0.9 if yb < 0 else yb + 0.4     # knuckle above the bilge
    return [
        (wd, S.DECK_Y, z), (wd, yk, z), (wb, yb, z),
        (-wb, yb, z), (-wd, yk, z), (-wd, S.DECK_Y, z),
    ]


def hull_zone(c, n):
    if n[1] < -0.55:
        return S.S_BELLY
    return S.S_HULL_SIDE


# ── body ─────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    rings = [ring_from_section(s) for s in S.HULL_SECTIONS]
    loft(p, rings, hull_zone, close=False)

    # deck strips between section top edges
    for a, b in zip(S.HULL_SECTIONS, S.HULL_SECTIONS[1:]):
        za, _, _, wa = a
        zb, _, _, wb = b
        PR.quad_out(p, [(-wa, S.DECK_Y, za), (wa, S.DECK_Y, za),
                        (wb, S.DECK_Y, zb), (-wb, S.DECK_Y, zb)],
                    (0, 1, 0), S.S_DECK)

    # raked bow / stern end faces
    for sec, nrm, zone in ((S.HULL_SECTIONS[0], (0, 0.3, -1), S.S_BOW),
                           (S.HULL_SECTIONS[-1], (0, 0.3, 1), S.S_STERN)):
        z, yb, wb, wd = sec
        PR.quad_out(p, [(-wd, S.DECK_Y, z), (wd, S.DECK_Y, z),
                        (wb, yb, z), (-wb, yb, z)], nrm, zone)

    # aft deckhouse + mast + antenna
    x, y, z, w, h, d = S.HOUSE
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+x': S.S_HOUSE_S, '-x': S.S_HOUSE_S, '+z': S.S_HOUSE_F,
                 '-z': S.S_HOUSE_F, '+y': S.S_HOUSE_T}, skip=('-y',))
    limb(p, S.MAST_FOOT, S.MAST_TOP, 0.06, 0.04, S.S_MAST, n=4)
    limb(p, (S.MAST_TOP[0] - 0.85, 7.6, S.MAST_TOP[2]),
         (S.MAST_TOP[0] + 0.85, 7.6, S.MAST_TOP[2]), 0.035, 0.035,
         S.S_MAST, n=3)
    PR.antenna(p, (-1.8, 5.2, 20.0), h=2.4)

    # sandbagged crew positions
    for a, b in S.SANDBAGS:
        PR.sandbag_wall(p, a, b, h=0.6, zone=S.S_SANDBAG)

    # ammo crates (big block tarped) + drums
    for (orig, rows, cols, tiers) in S.CRATES:
        PR.crate_stack(p, orig, rows=rows, cols=cols, tiers=tiers, size=0.95,
                       zone=S.S_CRATE, rng=RNG)
    PR.tarp_over(p, (S.TARP[0], S.TARP[1], S.TARP[2]),
                 (S.TARP[3], S.TARP[4], S.TARP[5]), zone=S.S_TARP)
    PR.drum_row(p, S.DRUMS, count=3, zone=S.S_DRUM, n=6)

    # improvised plate shields leaning at the deck edges
    for (sx, pz, pw, ph) in S.PLATES:
        wd = 6.25 if abs(pz) < 14 else 6.0
        px = sx * (wd - 0.35)
        chamfer_box(p, (px, S.DECK_Y + ph / 2, pz), (0.12, ph, pw), 0.02,
                    {k: S.S_PLATE for k in ('+x', '-x', '+y', '+z', '-z')},
                    skip=('-y',))
    # mooring bitts on both deck edges
    for bz in S.BOLLARDS:
        for sx in (1, -1):
            limb(p, (sx * 5.8, S.DECK_Y, bz), (sx * 5.8, S.DECK_Y + 0.45, bz),
                 0.10, 0.10, S.S_MAST, n=4)
    return p


# ── aim chain ────────────────────────────────────────────────────────────

def build_turret():
    """Slewing mount: ring base + trunnion cheeks. Origin on the deck."""
    p = Part('turret')
    rings = [ngon_ring((0, 0, 0), 1.45, n=8, axis='y'),
             ngon_ring((0, 0.35, 0), 1.35, n=8, axis='y')]
    PR._ring_solid(p, rings, S.S_MOUNT, cap_last=True)
    for sx in (1, -1):
        chamfer_box(p, (sx * 1.0, 0.85, 0.4), (0.16, 1.1, 1.5), 0.03,
                    {k: S.S_TRIM for k in ('+x', '-x', '+y', '+z', '-z')},
                    skip=('-y',))
    return p


def build_barrel():
    """Elevating rack, piece-local: trunnion at origin, tubes run -Z."""
    p = Part('barrel')
    zf, zb = -S.RACK_L + 0.4, 0.9              # front / back of frame
    # cheek side plates (team panel painted on the S_RACK_SIDE zone)
    for sx in (1, -1):
        chamfer_box(p, (sx * S.CHEEK_X, 0.39, (zf + zb) / 2),
                    (0.10, 1.85, zb - zf), 0.03,
                    {k: S.S_RACK_SIDE for k in ('+x', '-x', '+y', '+z', '-z')})
    # top cover plate + rear blast plate
    chamfer_box(p, (0, 1.38, (zf + zb) / 2), (2 * S.CHEEK_X, 0.12, zb - zf),
                0.03, {'+y': S.S_RACK_TOP, '-y': S.S_RACK_TOP,
                       '+x': S.S_TRIM, '-x': S.S_TRIM,
                       '+z': S.S_TRIM, '-z': S.S_TRIM})
    chamfer_box(p, (0, 0.39, zb), (2 * S.CHEEK_X, 1.85, 0.10), 0.03,
                {k: S.S_RACK_FACE for k in ('+x', '-x', '+y', '+z', '-z')})
    # 4x2 launch tubes
    for ty in S.TUBE_YS:
        for tx in S.TUBE_XS:
            tube(p, [(-S.RACK_L + 0.05, S.TUBE_R, ty),
                     (0.55, S.TUBE_R, ty)], S.S_TUBE, n=6,
                 xoff=tx, cap_start=S.S_DARK)
    return p


# ── clips ────────────────────────────────────────────────────────────────

def qx(deg):
    r = np.radians(deg) / 2
    return (float(np.sin(r)), 0.0, 0.0, float(np.cos(r)))


def build_clips():
    T = 6.0
    breathe = [(0.0, qx(0.0)), (T * 0.25, qx(-1.2)), (T * 0.5, qx(0.0)),
               (T * 0.75, qx(-0.6)), (T, qx(0.0))]
    return [{'name': 'idle', 'channels': [('barrel', 'rotation', breathe)]}]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='turret', parent=0, offset=S.TURRET_OFF, part=build_turret()),
        dict(name='barrel', parent=1, offset=S.BARREL_OFF, part=build_barrel()),
        dict(name='muzzle', parent=2, offset=S.MUZZLE_OFF, part=None),
    ]
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_arsenal_barge] total tris: {total}')
