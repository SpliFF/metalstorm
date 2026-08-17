"""gen_ms_staticdefense_s3 — assemble ms_staticdefense_s3 and export.

'Defense Battery': hardened railgun emplacement. Stepped concrete plinth
(pad / tier / armoured casemate) + hazard slew ring on `body`; heavy
cradle `turret` (capacitor drums, whip antenna to 6 m); `barrel` = breech
block + boxy accelerator sleeve tapering to a narrow emitter tube,
`muzzle` empty at the tip. `turret2` = open twin flak mount on a
rear-right shelf with ammo boxes. No clips — the aim controller owns the
turret/barrel chains (slot 1 MS_RAILGUN_S3, slot 2 MS_FLAK_S2).
Run: $PY gen_ms_staticdefense_s3.py -> out/ms_staticdefense_s3{,_png}.gltf
"""
import numpy as np

import ms_staticdefense_s3_layout as F   # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, chamfer_box, limb, tube
from gltf_export import export
import parts as P

STEM = 'ms_staticdefense_s3'
OUT = 'out'


def build_body():
    p = Part('body')

    # stepped concrete plinth: pad, tier, casemate
    x, y, z, w, h, d = F.PAD
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+y': F.R_PAD_T, '+x': F.R_PAD_S, '-x': F.R_PAD_S,
                 '+z': F.R_PAD_SZ, '-z': F.R_PAD_SZ}, skip=('-y',))
    x, y, z, w, h, d = F.TIER
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+y': F.R_TIER_T, '+x': F.R_TIER_S, '-x': F.R_TIER_S,
                 '+z': F.R_TIER_SZ, '-z': F.R_TIER_SZ}, skip=('-y',))
    x, y, z, w, h, d = F.CASE
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+y': F.R_CASE_T, '+x': F.R_CASE_S, '-x': F.R_CASE_S,
                 '+z': F.R_CASE_SZ, '-z': F.R_CASE_SZ}, skip=('-y',))

    # hazard slew ring under the turret
    P.drum(p, (0, F.RING_Y0, 0), r=F.RING_R, h=F.RING_H, zone=F.R_RING, n=16)

    # flak shelf on the rear-right tier roof + ammo boxes
    x, y, z, w, h, d = F.SHELF
    P.box6(p, (x, y, z), (w, h, d), F.R_SHELF_Z, ch=0.03, skip=('-y',))
    cx, cy, cz, s = F.CRATE_A
    P.crate(p, (cx, cy, cz), s, F.R_CRATE)
    cx, cy, cz, s = F.CRATE_B
    P.crate(p, (cx, cy, cz), s, F.R_CRATE)
    return p


def dress_turret(tur):
    """Replace the prefab's generic gunhouse (kept: ring, names, pivots):
    heavy cradle box, capacitor drums on the cheeks, whip antenna to the
    6 m mark. Turret-local, pivot at origin, rest rotation identity."""
    x, y, z, w, h, d = F.GUNHOUSE
    chamfer_box(tur, (x, y, z), (w, h, d), 0.05,
                {'+x': F.R_TURRET, '-x': F.R_TURRET, '+z': F.R_TURRETZ,
                 '-z': F.R_TURRETZ, '+y': F.R_TURRET_T}, skip=('-y',))
    for sx in (-1, 1):
        P.drum(tur, (sx * F.CAP_X, F.CAP_Y, F.CAP_Z),
               r=F.CAP_R, h=F.CAP_H, zone=F.R_CAP, n=8)
    bx, by, bz = F.ANT_BASE
    limb(tur, (bx, by, bz), (bx, F.ANT_TOP_Y, bz), 0.03, 0.015, F.R_TRIM, n=4)
    return tur


def build_barrel():
    """Railgun, barrel-local: pitch pivot at origin, gun along -Z.
    Breech block behind the pivot, boxy rail-accelerator sleeve over the
    rear half, tapering narrow emitter tube to the muzzle."""
    p = Part('barrel')
    x, y, z, w, h, d = F.BREECH
    P.box6(p, (x, y, z), (w, h, d), F.R_BREECH, ch=0.05)
    x, y, z, w, h, d = F.SLEEVE
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+x': F.R_SLV_S, '-x': F.R_SLV_S, '+y': F.R_SLV_T,
                 '-y': F.R_SLV_T, '+z': F.R_BREECH, '-z': F.R_BREECH})
    tube(p, F.TUBE_STATIONS, F.R_BARREL, n=8, axis='z',
         cap_end=F.R_BREECH)
    return p


def build_all():
    pieces = [dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body())]

    # railgun chain: turret(1) -> barrel(2) -> muzzle(3)
    t = P.turret_parts(body_index=0, mount=F.TURRET_MOUNT, ring_r=F.TUR_RING_R,
                       barrel_len=4.2, barrel_r=0.09,
                       body_zone=F.R_TURRET, barrel_rect=F.R_BARREL)
    # rebuild the turret piece: keep the slew ring, drop the prefab's
    # generic gunhouse (it swallowed the accelerator sleeve)
    tur = M.Part('turret')
    rings = [M.ngon_ring((0, 0, 0), F.TUR_RING_R, n=8, axis='y'),
             M.ngon_ring((0, 0.18, 0), F.TUR_RING_R, n=8, axis='y')]
    P._ring_solid(tur, rings, F.R_TURRET, cap_last=True)
    dress_turret(tur)
    t[0]['part'] = tur
    t[1]['part'] = build_barrel()
    t[1]['offset'] = F.BARREL_OFF
    t[2]['offset'] = F.MUZZLE_OFF
    base = len(pieces)
    t[1]['parent'] = base
    t[2]['parent'] = base + 1
    pieces.extend(t)

    # flak chain: turret2(4) -> turret2_barrel(5) -> turret2_muzzle(6)
    t2 = P.turret_parts(body_index=0, mount=F.TURRET2_MOUNT,
                        ring_r=F.FLAK_RING_R, barrel_len=F.FLAK_LEN,
                        barrel_r=0.07, twin=True, body_zone=F.R_FLAK,
                        barrel_rect=F.R_FLAKB, prefix='turret2')
    base = len(pieces)
    t2[1]['parent'] = base
    t2[2]['parent'] = base + 1
    pieces.extend(t2)
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
