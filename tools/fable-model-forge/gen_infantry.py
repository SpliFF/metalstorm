"""gen_infantry — four low-poly infantry bodies on one shared atlas.

soldier (ms_soldiers_s1), engineer (ms_engineers_s1), civilian
(ms_civilians), militia (ms_militia). Each is ONE static `body` piece
(≤ 800 tris, no rig — a walk cycle is fx-offload X2 territory; a static
pose at close range is the accepted M1 limitation, per the plan). All
four write to the shared `fable_infantry_*` texture set (URIs rewritten
after export, exactly like gen_civkit).

M1 of PLAN-metalstorm-impostors.md — geometry only; the def rewire
(drop impostorOnly, add impostorDistance + objectname) is M4, and the
impostor bake off these models is M2.

Usage: python3 gen_infantry.py    (then `node encode.mjs fable_infantry`)
"""
from __future__ import annotations
import json
import numpy as np

import infantry_layout as L          # sets meshlib.ATLAS = 512
from meshlib import Part, chamfer_box, limb, loft
from gltf_export import export

OUT = 'out'
TEX_STEM = 'fable_infantry'


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


def leg(p, sx, pants, boot):
    """One leg: thigh + shin limbs, foot box. sx=+1 left, -1 right."""
    hip = (sx * L.HIP_X, L.HIP_Y, 0.0)
    knee = (sx * L.KNEE[0], L.KNEE[1], L.KNEE[2])
    ankle = (sx * L.ANKLE[0], L.ANKLE[1], L.ANKLE[2])
    seg(p, hip, knee, L.LEG_R0, L.LEG_R1, pants)
    seg(p, knee, ankle, L.LEG_R1, L.LEG_R2, pants)
    fc = (sx * L.FOOT_C[0], L.FOOT_C[1], L.FOOT_C[2])
    boxp(p, fc, L.FOOT_SZ, boot, ch=0.03)


def arm(p, sx, pose, sleeve, hand_zone):
    sho = (sx * L.SHOULDER, L.SHO_Y, 0.0)
    elb = (sx * pose['elbow'][0], pose['elbow'][1], pose['elbow'][2])
    hnd = (sx * pose['hand'][0], pose['hand'][1], pose['hand'][2])
    seg(p, sho, elb, L.ARM_R0, L.ARM_R1, sleeve)
    seg(p, elb, hnd, L.ARM_R1, L.ARM_R1 * 0.92, sleeve)
    boxp(p, hnd, (0.075, 0.09, 0.075), hand_zone, ch=0.02)


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


MODELS = {
    'ms_soldiers_s1':  (build_soldier,  True),
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
