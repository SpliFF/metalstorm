"""gen_infantry — seven low-poly infantry bodies on one shared atlas.

The s1 tier plus civilians: soldier (ms_soldiers_s1), engineer
(ms_engineers_s1), civilian (ms_civilians), militia (ms_militia). Then the
three heavy soldier tiers added 2026-08-18: line infantry (ms_soldiers_s2),
heavy weapons team (ms_soldiers_s3), exo-assault trooper (ms_soldiers_s4).
Each is ONE static `body` piece (≤ 800 tris, no rig — a walk cycle is
fx-offload X2 territory; a static pose at close range is the accepted M1
limitation, per the plan). All seven write to the shared `fable_infantry_*`
texture set (URIs rewritten after export, exactly like gen_civkit).

M1 of PLAN-metalstorm-impostors.md — geometry only; the def rewire
(drop impostorOnly, add impostorDistance + objectname) is M4, and the
impostor bake off these models is M2.

The four s1-tier bodies pass the layout MODULE as their dims and so are
byte-identical to what shipped before the s2/s3/s4 work — `out/<stem>.bin`
compares equal against data/games/metalstorm/models/. Keep it that way:
ms_soldiers_s1's def carries impostor metrics (impostorSize 2.3615,
impostorCentreY 0.7650) that were measured in-game against THIS geometry,
and its shipped impostor sheets were baked from it.

Note the s2/s3/s4 tiers ship WITHOUT impostor atlases. That is deliberate and
safe: squad-render-backend sets impostorDist = Infinity for a def with a body
and no atlas, so they draw the model tier at every range (squad sizes are
8/4/2 against s1's 16, so per-squad tri cost is LOWER than s1's). Baking
sheets for them needs the measured size/centreY pass — a separate job.

Usage: python3 gen_infantry.py    (then `node encode.mjs fable_infantry`)
"""
from __future__ import annotations
import json
from types import SimpleNamespace

import numpy as np

import infantry_layout as L          # sets meshlib.ATLAS = 512
from meshlib import Part, chamfer_box, limb, loft
from gltf_export import export

OUT = 'out'
TEX_STEM = 'fable_infantry'

# Joint names the shared humanoid helpers read off a dims namespace. `L` itself
# satisfies this interface, which is why the four s1-tier bodies keep passing
# the module and stay byte-identical.
_JOINTS = ('HIP_X', 'HIP_Y', 'KNEE', 'ANKLE', 'FOOT_C', 'FOOT_SZ',
           'PELVIS_C', 'PELVIS_SZ', 'TORSO_RINGS', 'NECK_C', 'NECK_SZ',
           'HEAD_C', 'HEAD_SZ', 'SHOULDER', 'SHO_Y', 'ARM_SIDES', 'ARM_GRIP',
           'ARM_R0', 'ARM_R1', 'LEG_R0', 'LEG_R1', 'LEG_R2')


def _scaled(v, k):
    """Multiply a joint value by k, whatever shape the layout declared it in."""
    if isinstance(v, (int, float)):
        return v * k
    if isinstance(v, tuple):
        return tuple(_scaled(x, k) for x in v)
    if isinstance(v, list):
        return [_scaled(x, k) for x in v]
    if isinstance(v, dict):
        return {name: _scaled(x, k) for name, x in v.items()}
    raise TypeError(f'unscalable joint value {v!r}')


def dims(height=1.845, bulk=1.0, **over):
    """A dims namespace for a taller/bulkier tier.

    `height` scales every joint uniformly off the s1 body (1.845 m as built —
    the helmet crown, not the 1.8 m nominal). `bulk` additionally fattens the
    limb radii only, which is what separates a powered suit from a tall man.
    Anything in `over` replaces the scaled value outright.
    """
    k = height / 1.845
    d = {name: _scaled(getattr(L, name), k) for name in _JOINTS}
    for name in ('ARM_R0', 'ARM_R1', 'LEG_R0', 'LEG_R1', 'LEG_R2'):
        d[name] *= bulk
    d['BULK'] = bulk
    d['K'] = k
    d.update(over)
    return SimpleNamespace(**d)


# ── geometry helpers (everything lands in one `body` Part) ───────────────

def boxp(p, center, size, zone, ch=0.03, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def oct_ring(y, wx, wz):
    """8-vertex octagon in the XZ plane at height y (flat-front phase)."""
    c = 0.5522
    return [(wx, y, 0.0), (wx * c, y, wz * c), (0.0, y, wz), (-wx * c, y, wz * c),
            (-wx, y, 0.0), (-wx * c, y, -wz * c), (0.0, y, -wz), (wx * c, y, -wz * c)]


def torso(p, rings, zone):
    r = [oct_ring(*s) for s in rings]
    loft(p, r, lambda c, n: zone, cap_start=zone, cap_end=zone)


def seg(p, a, b, r0, r1, zone, n=6):
    """Tapered n-gon limb segment a→b (open ends — joints embed)."""
    limb(p, a, b, r0, r1, zone.rect, n=n)


def mirror_pt(pt):
    return (-pt[0], pt[1], pt[2])


def leg(p, sx, pants, boot, d=L):
    """One leg: thigh + shin limbs, foot box. sx=+1 left, -1 right."""
    hip = (sx * d.HIP_X, d.HIP_Y, 0.0)
    knee = (sx * d.KNEE[0], d.KNEE[1], d.KNEE[2])
    ankle = (sx * d.ANKLE[0], d.ANKLE[1], d.ANKLE[2])
    seg(p, hip, knee, d.LEG_R0, d.LEG_R1, pants)
    seg(p, knee, ankle, d.LEG_R1, d.LEG_R2, pants)
    fc = (sx * d.FOOT_C[0], d.FOOT_C[1], d.FOOT_C[2])
    boxp(p, fc, d.FOOT_SZ, boot, ch=0.03)


def arm(p, sx, pose, sleeve, hand_zone, d=L):
    sho = (sx * d.SHOULDER, d.SHO_Y, 0.0)
    elb = (sx * pose['elbow'][0], pose['elbow'][1], pose['elbow'][2])
    hnd = (sx * pose['hand'][0], pose['hand'][1], pose['hand'][2])
    seg(p, sho, elb, d.ARM_R0, d.ARM_R1, sleeve)
    seg(p, elb, hnd, d.ARM_R1, d.ARM_R1 * 0.92, sleeve)
    hb = 0.075 * getattr(d, 'K', 1.0) * getattr(d, 'BULK', 1.0)
    boxp(p, hnd, (hb, hb * 1.2, hb), hand_zone, ch=0.02)


def rifle(p, zone_body, zone_mag):
    """Rifle held diagonally across the chest (butt low-right, muzzle
    high-left-front), matching the impostor-sprite read."""
    boxp(p, (0.03, 1.17, -0.20), (0.055, 0.09, 0.44), zone_body, ch=0.02)
    boxp(p, (0.06, 1.04, -0.12), (0.045, 0.14, 0.06), zone_mag, ch=0.015)
    # muzzle tip forward-up
    seg(p, (0.03, 1.24, -0.40), (0.05, 1.30, -0.52), 0.018, 0.014, zone_body, n=6)


def wrench(p, sx, zone):
    """Heavy wrench hanging from a hand at the side."""
    hx = sx * L.ARM_SIDES['hand'][0]
    boxp(p, (hx, 0.80, 0.07), (0.05, 0.30, 0.05), zone, ch=0.015)
    boxp(p, (hx, 0.63, 0.07), (0.14, 0.07, 0.06), zone, ch=0.015)


# ── the four variants ────────────────────────────────────────────────────

def build_soldier():
    p = Part('body')
    leg(p, 1, L.Z_LEG, L.Z_RUBBER)
    leg(p, -1, L.Z_LEG, L.Z_RUBBER)
    boxp(p, L.PELVIS_C, L.PELVIS_SZ, L.Z_STEELD, ch=0.03)
    torso(p, L.TORSO_RINGS, L.Z_TORSO_T)           # team-coloured plate
    arm(p, 1, L.ARM_GRIP, L.Z_ARMOR, L.Z_GLOVE)
    arm(p, -1, L.ARM_GRIP, L.Z_ARMOR, L.Z_GLOVE)
    boxp(p, L.NECK_C, L.NECK_SZ, L.Z_STEELD, ch=0.02)
    boxp(p, L.HEAD_C, L.HEAD_SZ, L.Z_SKIN, ch=0.03)
    # helmet dome (team) + visor slit
    boxp(p, (0.0, 1.78, 0.005), (0.20, 0.13, 0.21), L.Z_HELM_T, ch=0.04,
         skip=('-y',))
    boxp(p, (0.0, 1.66, -0.095), (0.13, 0.045, 0.03), L.Z_GLASS, ch=0.01)
    rifle(p, L.Z_STEELD, L.Z_STEEL)
    return p


def build_engineer():
    p = Part('body')
    leg(p, 1, L.Z_LEG, L.Z_RUBBER)
    leg(p, -1, L.Z_LEG, L.Z_RUBBER)
    boxp(p, L.PELVIS_C, L.PELVIS_SZ, L.Z_STEELD, ch=0.03)
    torso(p, L.TORSO_RINGS, L.Z_YELLOW)            # hi-vis vest
    # team stripe down the vest front
    boxp(p, (0.0, 1.26, -0.135), (0.07, 0.34, 0.02), L.Z_TORSO_T, ch=0.01)
    # back tank over the right shoulder
    boxp(p, (-0.12, 1.32, 0.14), (0.16, 0.30, 0.10), L.Z_STEEL, ch=0.03)
    arm(p, 1, L.ARM_SIDES, L.Z_ARMOR, L.Z_GLOVE)
    arm(p, -1, L.ARM_SIDES, L.Z_ARMOR, L.Z_GLOVE)
    boxp(p, L.NECK_C, L.NECK_SZ, L.Z_STEELD, ch=0.02)
    boxp(p, L.HEAD_C, L.HEAD_SZ, L.Z_SKIN, ch=0.03)
    # hard hat: dome + brim
    boxp(p, (0.0, 1.78, 0.01), (0.20, 0.11, 0.20), L.Z_YELLOW, ch=0.04,
         skip=('-y',))
    boxp(p, (0.0, 1.735, -0.11), (0.22, 0.03, 0.09), L.Z_YELLOW, ch=0.01)
    wrench(p, -1, L.Z_STEEL)
    return p


def build_civilian(hair=True):
    p = Part('body')
    leg(p, 1, L.Z_PANTS, L.Z_CIVBOOT)
    leg(p, -1, L.Z_PANTS, L.Z_CIVBOOT)
    boxp(p, L.PELVIS_C, L.PELVIS_SZ, L.Z_PANTS, ch=0.03)
    # longer, softer coat torso (extends below the waist)
    rings = [(0.94, 0.15, 0.115)] + L.TORSO_RINGS
    torso(p, rings, L.Z_COAT)
    # open collar showing the shirt
    boxp(p, (0.0, 1.40, -0.125), (0.10, 0.14, 0.03), L.Z_SHIRT, ch=0.01)
    arm(p, 1, L.ARM_SIDES, L.Z_COAT, L.Z_SKIN)
    arm(p, -1, L.ARM_SIDES, L.Z_COAT, L.Z_SKIN)
    boxp(p, L.NECK_C, L.NECK_SZ, L.Z_SKIN, ch=0.02)
    boxp(p, L.HEAD_C, L.HEAD_SZ, L.Z_SKIN, ch=0.03)
    # hair cap
    if hair:
        boxp(p, (0.0, 1.755, 0.01), (0.185, 0.09, 0.20), L.Z_HAIR, ch=0.04,
             skip=('-y',))
    return p


def build_militia():
    p = build_civilian(hair=False)   # armed volunteer — knit cap replaces hair
    # chest rig strap (mask-free)
    boxp(p, (0.02, 1.20, -0.135), (0.055, 0.34, 0.02), L.Z_RUBBER, ch=0.01)
    # team armband on the left upper arm
    boxp(p, (0.215, 1.28, 0.02), (0.075, 0.06, 0.075), L.Z_BAND_T, ch=0.01)
    # knit cap with a team band
    boxp(p, (0.0, 1.77, 0.01), (0.185, 0.09, 0.20), L.Z_HAIR, ch=0.04,
         skip=('-y',))
    boxp(p, (0.0, 1.725, 0.01), (0.19, 0.035, 0.205), L.Z_BAND_T, ch=0.01)
    # slung rifle
    rifle(p, L.Z_STEELD, L.Z_STEEL)
    return p


# ── heavy soldier tiers (s2/s3/s4) ───────────────────────────────────────
#
# The class-scale table (forge DESIGN-GUIDE) puts soldiers at 1.8 / 1.85 / 1.9
# / 2.1 m, so height alone separates the tiers by only 2–14% — far too little
# to read at strategic zoom. Silhouette does the work instead: s2 adds
# pauldrons and a pack, s3 a drum-fed autocannon plus a slung mortar tube, s4 a
# sealed powered shell with a shoulder missile pod. Each stays one static
# `body` piece under the 800-tri infantry budget.

def pauldrons(p, d, zone):
    """Shoulder plates — the cheapest silhouette tell that a trooper is armoured."""
    for sx in (1, -1):
        boxp(p, (sx * d.SHOULDER, d.SHO_Y + 0.03 * d.K, 0.0),
             (0.13 * d.K, 0.075 * d.K, 0.20 * d.K), zone, ch=0.025)


def backpack(p, d, zone, size=(0.24, 0.30, 0.13), y=1.28, z=0.155):
    boxp(p, (0.0, y * d.K, z * d.K),
         tuple(s * d.K for s in size), zone, ch=0.03)


def helmet(p, d, dome_zone, visor_zone, crown=1.78, brim=False):
    boxp(p, (0.0, crown * d.K, 0.005 * d.K),
         (0.20 * d.K, 0.13 * d.K, 0.21 * d.K), dome_zone, ch=0.04, skip=('-y',))
    boxp(p, (0.0, (crown - 0.12) * d.K, -0.095 * d.K),
         (0.13 * d.K, 0.045 * d.K, 0.03 * d.K), visor_zone, ch=0.01)
    if brim:
        boxp(p, (0.0, (crown - 0.07) * d.K, -0.115 * d.K),
             (0.21 * d.K, 0.03 * d.K, 0.08 * d.K), dome_zone, ch=0.01)


def long_gun(p, d, zbody, zmag, k=1.0):
    """Shoulder-fired weapon across the chest, `k`x the s1 rifle's bulk."""
    boxp(p, (0.03, 1.17 * d.K, -0.20), (0.055 * k, 0.09 * k, 0.44 * k),
         zbody, ch=0.02)
    boxp(p, (0.06, 1.04 * d.K, -0.12), (0.045 * k, 0.14 * k, 0.06 * k),
         zmag, ch=0.015)
    seg(p, (0.03, 1.24 * d.K, -0.40 * k), (0.05, 1.30 * d.K, -0.52 * k),
        0.018 * k, 0.014 * k, zbody, n=6)


def drum_autocannon(p, d, zbody, zdrum):
    """Belt-fed autocannon: heavy receiver, side drum, muzzle brake.

    No bipod: a folded stub under the barrel is ~1 cm of silhouette at 15 m and
    cost 8 tris of an 800-tri body, so the DESIGN-GUIDE greeble test cuts it.
    """
    boxp(p, (0.03, 1.16 * d.K, -0.22), (0.085, 0.115, 0.52), zbody, ch=0.02)
    # side-mounted ammo drum (the s3 read at distance)
    boxp(p, (0.13, 1.13 * d.K, -0.10), (0.075, 0.17, 0.17), zdrum, ch=0.03)
    # heavy barrel + two-baffle muzzle brake
    seg(p, (0.03, 1.22 * d.K, -0.46), (0.05, 1.29 * d.K, -0.70),
        0.026, 0.020, zbody, n=6)
    boxp(p, (0.05, 1.29 * d.K, -0.70), (0.045, 0.045, 0.07), zbody, ch=0.012)


def mortar_tube(p, d, ztube):
    """Disassembled mortar slung diagonally across the back.

    The diagonal is the whole point — it breaks the vertical torso line, which
    is what tells s3 apart from s2 in a squad seen from any angle.
    """
    seg(p, (-0.20, 1.52 * d.K, 0.17), (0.16, 1.02 * d.K, 0.21),
        0.048, 0.048, ztube, n=6)


def missile_pod(p, d, sx, zone):
    """Shoulder AA pod — a block with two protruding tubes (MS_MISSILE_AA_S1).

    Two tubes, not four: at 15 m the pair already reads as "tubes", and the
    block behind them carries the shape.
    """
    boxp(p, (sx * 0.235 * d.K, 1.60 * d.K, 0.06 * d.K),
         (0.10, 0.13, 0.19), zone, ch=0.02)
    for dz in (-0.05, 0.05):
        seg(p, (sx * 0.235 * d.K + dz, 1.60 * d.K, -0.04 * d.K),
            (sx * 0.235 * d.K + dz, 1.60 * d.K, -0.11 * d.K),
            0.024, 0.024, zone, n=5)


def build_soldier_s2():
    """Line infantry — s1's trooper with real armour: pauldrons, pack, LMG."""
    d = dims(height=1.85)
    p = Part('body')
    leg(p, 1, L.Z_LEG, L.Z_RUBBER, d)
    leg(p, -1, L.Z_LEG, L.Z_RUBBER, d)
    boxp(p, d.PELVIS_C, d.PELVIS_SZ, L.Z_STEELD, ch=0.03)
    torso(p, d.TORSO_RINGS, L.Z_TORSO_T)
    backpack(p, d, L.Z_CANVAS)
    pauldrons(p, d, L.Z_ARMORD)
    arm(p, 1, d.ARM_GRIP, L.Z_ARMOR, L.Z_GLOVE, d)
    arm(p, -1, d.ARM_GRIP, L.Z_ARMOR, L.Z_GLOVE, d)
    boxp(p, d.NECK_C, d.NECK_SZ, L.Z_STEELD, ch=0.02)
    boxp(p, d.HEAD_C, d.HEAD_SZ, L.Z_SKIN, ch=0.03)
    helmet(p, d, L.Z_HELM_T, L.Z_GLASS)
    long_gun(p, d, L.Z_STEELD, L.Z_STEEL, k=1.12)
    return p


def build_soldier_s3():
    """Heavy weapons team — drum autocannon + slung mortar tube."""
    d = dims(height=1.90, bulk=1.08)
    p = Part('body')
    leg(p, 1, L.Z_LEG, L.Z_RUBBER, d)
    leg(p, -1, L.Z_LEG, L.Z_RUBBER, d)
    boxp(p, d.PELVIS_C, d.PELVIS_SZ, L.Z_STEELD, ch=0.03)
    # broader chest than s2 — a weapons carrier, not a rifleman
    rings = [(y, hx * 1.10, hz * 1.12) for (y, hx, hz) in d.TORSO_RINGS]
    torso(p, rings, L.Z_TORSO_T)
    mortar_tube(p, d, L.Z_STEEL)
    pauldrons(p, d, L.Z_ARMORD)
    arm(p, 1, d.ARM_GRIP, L.Z_ARMOR, L.Z_GLOVE, d)
    arm(p, -1, d.ARM_GRIP, L.Z_ARMOR, L.Z_GLOVE, d)
    boxp(p, d.NECK_C, d.NECK_SZ, L.Z_STEELD, ch=0.02)
    boxp(p, d.HEAD_C, d.HEAD_SZ, L.Z_SKIN, ch=0.03)
    helmet(p, d, L.Z_HELM_T, L.Z_GLASS)
    drum_autocannon(p, d, L.Z_STEELD, L.Z_STEEL)
    return p


def build_soldier_s4():
    """Exo-assault trooper — one sealed powered suit, 2.1 m.

    No skin anywhere: the head is an armoured cowl with an amber optic band,
    which is the tier's whole silhouette argument at distance.
    """
    d = dims(height=2.205, bulk=1.32)   # lands the built crown on the 2.10 m table value
    p = Part('body')
    leg(p, 1, L.Z_ARMORD, L.Z_STEELD, d)
    leg(p, -1, L.Z_ARMORD, L.Z_STEELD, d)
    boxp(p, d.PELVIS_C, d.PELVIS_SZ, L.Z_STEELD, ch=0.03)
    # armoured shell: wider and deeper than flesh, team plate on the chest
    rings = [(y, hx * 1.28, hz * 1.30) for (y, hx, hz) in d.TORSO_RINGS]
    torso(p, rings, L.Z_TORSO_T)
    # dorsal powerpack with exhaust stubs
    backpack(p, d, L.Z_STEEL, size=(0.30, 0.34, 0.17), y=1.30, z=0.185)
    # one exhaust stack, offset — asymmetry reads as "machine", and a mirrored
    # pair would not survive the tri budget alongside the missile pod
    seg(p, (0.10 * d.K, 1.50 * d.K, 0.26 * d.K),
        (0.10 * d.K, 1.64 * d.K, 0.24 * d.K),
        0.034, 0.028, L.Z_STEELD, n=5)
    pauldrons(p, d, L.Z_ARMORD)
    missile_pod(p, d, -1, L.Z_STEELD)
    arm(p, 1, d.ARM_GRIP, L.Z_ARMORD, L.Z_STEELD, d)
    arm(p, -1, d.ARM_SIDES, L.Z_ARMORD, L.Z_STEELD, d)
    boxp(p, d.NECK_C, d.NECK_SZ, L.Z_STEELD, ch=0.02)
    # Sealed cowl instead of a head. The amber optic is the cowl's own FRONT
    # FACE rather than a separate band box: same read at 15 m, 48 tris cheaper,
    # and it cannot drift out of alignment with the cowl it sits on.
    chamfer_box(p, d.HEAD_C, tuple(s * 1.06 for s in d.HEAD_SZ), 0.03,
                {'+y': L.Z_ARMORD, '-y': L.Z_ARMORD,
                 '+x': L.Z_ARMORD, '-x': L.Z_ARMORD,
                 '+z': L.Z_ARMORD, '-z': L.Z_VISOR})
    # suit-mounted autocannon on the right arm
    drum_autocannon(p, d, L.Z_STEELD, L.Z_STEEL)
    return p


MODELS = {
    'ms_soldiers_s1':  (build_soldier,  True),
    'ms_soldiers_s2':  (build_soldier_s2, True),
    'ms_soldiers_s3':  (build_soldier_s3, True),
    'ms_soldiers_s4':  (build_soldier_s4, True),
    'ms_engineers_s1': (build_engineer, True),
    'ms_civilians':    (build_civilian, False),   # gaia — no team mask
    'ms_militia':      (build_militia,  True),
}


def rewrite_uris(stem):
    for suffix in ('', '_png'):
        path = f'{OUT}/{stem}{suffix}.gltf'
        doc = json.load(open(path))
        for img in doc.get('images', []):
            for kind in ('diffuse', 'orm', 'emissive', 'team', 'normals'):
                if kind in img['uri']:
                    ext = 'png' if suffix else 'ktx2'
                    img['uri'] = f'{TEX_STEM}_{kind}.{ext}'
        json.dump(doc, open(path, 'w'), separators=(',', ':'))


if __name__ == '__main__':
    for stem, (fn, _team) in MODELS.items():
        body = fn()
        pieces = [dict(name='body', parent=-1, offset=(0, 0, 0), part=body)]
        export(pieces, stem, texmode='ktx2', outdir=OUT, normal_map=False)
        export(pieces, stem, texmode='png', outdir=OUT, normal_map=False)
        rewrite_uris(stem)
        print(f'[gen_infantry] {stem}: {body.tri_count()} tris')
