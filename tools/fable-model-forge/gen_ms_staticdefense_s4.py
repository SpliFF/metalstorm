"""gen_ms_staticdefense_s4 — assemble ms_staticdefense_s4 and export.

'Defense Battery' — THE bastion gun (static defense s4, 8 m, ~6x6 m):
stepped battered concrete bastion (base tier, mid tier, octagonal
barbette), corner buttresses, armoured ammo-lift housing, access ladder,
sandbag revetment, crates, ready-ammo lockers, aerial to the 8 m mark,
two amber beacons. Weapon slot 1: turret->barrel->muzzle — huge faceted
gun bastion turret with mantlet + rear bustle and a 4.95 m howitzer
(recoil sleeve over the breech half, multi-baffle muzzle brake). Weapon
slot 2: turret2->turret2_barrel->turret2_muzzle — open twin flak ring on
a low corner bastion drum. Rest rotations identity; no clips (the §16c
aim controller owns the chains).
Run: $PY gen_ms_staticdefense_s4.py -> out/ms_staticdefense_s4{,_png}.gltf
"""
import numpy as np

import ms_staticdefense_s4_layout as F   # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, Zone, chamfer_box, ngon_ring, limb, tube
from gltf_export import export
import parts as P

STEM = 'ms_staticdefense_s4'
OUT = 'out'
RNG = np.random.default_rng(90210)


def build_body():
    p = Part('body')

    # base tier (battered read painted; chamfer softens the crest)
    x, y, z, w, h, d = F.BASE
    chamfer_box(p, (x, y, z), (w, h, d), 0.10,
                {'+x': F.R_BASE_S, '-x': F.R_BASE_S, '+z': F.R_BASE_SF,
                 '-z': F.R_BASE_SF, '+y': F.R_BASE_T}, skip=('-y',))

    # mid tier
    x, y, z, w, h, d = F.MID
    chamfer_box(p, (x, y, z), (w, h, d), 0.08,
                {'+x': F.R_MID_S, '-x': F.R_MID_S, '+z': F.R_MID_SF,
                 '-z': F.R_MID_SF, '+y': F.R_MID_T}, skip=('-y',))

    # four battered corner buttresses hugging the base->mid step
    for sx in (-1, 1):
        for sz in (-1, 1):
            bx = F.MID[0] + sx * (F.MID[3] / 2 - 0.10)
            bz = F.MID[2] + sz * (F.MID[5] / 2 - 0.10)
            limb(p, (bx + sx * 0.18, F.BASE_TOP - 0.02, bz + sz * 0.18),
                 (bx, F.MID_TOP - 0.15, bz), 0.20, 0.15, F.R_TRIM, n=4)

    # octagonal barbette drum, hazard slew ring painted on the top cap
    cx, cz = F.BARB_C
    rings = [ngon_ring((cx, F.BARB_Y0 - 0.05, cz), F.BARB_R0, n=8, axis='y'),
             ngon_ring((cx, F.BARB_Y1, cz), F.BARB_R1, n=8, axis='y')]
    P._ring_solid(p, rings, F.R_BARB, cap_last=True, axis='y')
    # replace generic cap zone: re-add top cap with the slew-ring zone
    p.add_face(list(rings[-1]), zone=F.R_BARB_T, flip=False)

    # armoured ammo-lift housing (blast doors painted on +x face)
    x, y, z, w, h, d = F.HOUSE
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+x': F.R_HOUSE_F, '-x': F.R_HOUSE_F, '+z': F.R_HOUSE,
                 '-z': F.R_HOUSE, '+y': F.R_MID_T}, skip=('-y',))

    # access ladder up the front face to the base-tier crest
    P.ladder(p, (F.LADDER_X, 0.0, F.LADDER_Z),
             (F.LADDER_X, F.BASE_TOP + 0.35, F.LADDER_Z),
             width=0.44, zone=F.R_TRIM)

    # aerial to the 8 m mark
    limb(p, F.ANT_BASE, (F.ANT_BASE[0], F.ANT_TOP, F.ANT_BASE[2]),
         0.045, 0.018, F.R_TRIM, n=3)

    # sandbag revetment along the west wall foot
    P.sandbag_wall(p, F.SAND_A, F.SAND_B, h=0.62, zone=F.R_SAND)

    # crate stowage near the ladder
    P.crate_stack(p, F.CRATES, rows=1, cols=2, tiers=2, size=0.72,
                  zone=F.R_CRATE)

    # ready-ammo lockers for the flak mount, against the south wall
    for c in (F.LOCKER1, F.LOCKER2):
        chamfer_box(p, c, F.LOCKER_SZ, 0.05,
                    {k: F.R_CRATE for k in ('+x', '-x', '+y', '+z', '-z')},
                    skip=('-y',))

    # flak corner bastion drum (octagon, ground -> shelf)
    fx, fz = F.FDRUM_C
    frings = [ngon_ring((fx, 0.0, fz), F.FDRUM_R, n=8, axis='y'),
              ngon_ring((fx, F.FDRUM_TOP - 0.18, fz), F.FDRUM_R, n=8, axis='y'),
              ngon_ring((fx, F.FDRUM_TOP, fz), F.FDRUM_R * 0.88, n=8, axis='y')]
    P._ring_solid(p, frings, F.R_DRUM, axis='y')
    p.add_face(list(frings[-1]), zone=F.R_DRUM_T, flip=False)

    # amber warning beacons (emissive zone)
    P.beacon(p, F.BEACON1, size=0.16, glow_zone=F.R_BEACON)
    P.beacon(p, F.BEACON2, size=0.16, glow_zone=F.R_BEACON)
    return p


def build_turret():
    """Gun bastion turret, turret-local: yaw pivot at origin (+Y), faceted
    octagonal gunhouse, front mantlet around the barrel root, rear bustle,
    commander cupola. Rest rotation identity."""
    p = Part('turret')
    rings = [ngon_ring((0, 0.02, 0), F.TUR_R0, n=8, axis='y'),
             ngon_ring((0, 0.75, 0), F.TUR_R0 * 0.97, n=8, axis='y'),
             ngon_ring((0, F.TUR_H, 0), F.TUR_R1, n=8, axis='y')]
    P._ring_solid(p, rings, F.R_TUR, axis='y')
    p.add_face(list(rings[-1]), zone=F.R_TUR_T, flip=False)

    # mantlet block bridging gunhouse front to the barrel root
    x, y, z, w, h, d = F.MANT
    chamfer_box(p, (x, y, z), (w, h, d), 0.08,
                {'+x': F.R_MANT, '-x': F.R_MANT, '-z': F.R_MANT,
                 '+y': F.R_MANT, '-y': F.R_DARK})

    # rear bustle (ammo scuttle painted on its back face)
    x, y, z, w, h, d = F.BUSTLE
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+x': F.R_TUR_F, '-x': F.R_TUR_F, '+z': F.R_TUR,
                 '+y': F.R_TUR_T, '-y': F.R_DARK})

    # commander cupola on the roof
    x, y, z, w, h, d = F.CUPOLA
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {k: F.R_MANT for k in ('+x', '-x', '+y', '+z', '-z')},
                skip=('-y',))
    return p


def build_barrel():
    """Howitzer, barrel-local: pitch pivot (X) at origin; tube runs -Z.
    Recoil sleeve over the breech half, radius-stepped stations down the
    tube, prominent multi-baffle muzzle brake at the tip."""
    p = Part('barrel')
    # breech + recoil sleeve (thick, ribbed in paint)
    tube(p, [(0.55, 0.26), (0.45, 0.33), (-1.95, 0.33), (-2.10, 0.24)],
         F.R_SLEEVE, n=8, cap_start=F.R_DARK)
    # main tube, two stations stepping down
    tube(p, [(-2.10, 0.205), (-3.30, 0.195), (-3.35, 0.165), (-4.35, 0.155)],
         F.R_GUN, n=8)
    # multi-baffle muzzle brake: three baffle discs with slotted gaps
    tube(p, [(-4.35, 0.155), (-4.38, 0.34), (-4.52, 0.34), (-4.55, 0.20),
             (-4.62, 0.20), (-4.65, 0.34), (-4.79, 0.34), (-4.82, 0.20),
             (-4.87, 0.20), (-4.90, 0.30), (-4.95, 0.24)],
         F.R_BRAKE, n=8, cap_end=F.R_DARK)
    return p


def build_all():
    pieces = [dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
              dict(name='turret', parent=0, offset=F.TUR_OFF, part=build_turret()),
              dict(name='barrel', parent=1, offset=F.BAR_OFF, part=build_barrel()),
              dict(name='muzzle', parent=2, offset=F.MUZ_OFF, part=Part('muzzle'))]

    # slot 2: open twin flak on the corner bastion shelf (prefab chain)
    t2 = P.turret_parts(body_index=0, mount=F.T2_OFF, ring_r=0.50,
                        barrel_len=F.T2_LEN, barrel_r=0.075, twin=True,
                        body_zone=F.R_FLAK, barrel_rect=F.R_FLAKB,
                        prefix='turret2')
    base = len(pieces)
    t2[1]['parent'] = base          # turret2_barrel under turret2
    t2[2]['parent'] = base + 1      # turret2_muzzle under turret2_barrel
    pieces.extend(t2)
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
    for pc in pieces:
        print(f"  {pc['name']:16s} parent={pc['parent']:2d} off={pc['offset']}"
              f" tris={pc['part'].tri_count() if pc['part'] else 0}")
