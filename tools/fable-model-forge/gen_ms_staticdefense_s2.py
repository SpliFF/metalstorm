"""gen_ms_staticdefense_s2 — assemble ms_staticdefense_s2 and export.

'Defense Battery' (static defense s2, 4.5 m, ~6x6 m footprint): stepped
poured-concrete casemate, riveted slew plinth, armoured gunhouse turret
with TWIN heavy autocannon (turret→barrel→muzzle, slot 1) and a small
open flak pintle mount on the rear-right roof corner (turret2→
turret2_barrel→turret2_muzzle, slot 2). Sandbags, crates, vent, ammo
hatch, aerial, amber beacon. No clips — the aim controller owns both
turret chains.
Run: $PY gen_ms_staticdefense_s2.py → out/ms_staticdefense_s2{,_png}.gltf
"""
import numpy as np

import ms_staticdefense_s2_layout as F     # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, chamfer_box, limb, tube
from gltf_export import export
import parts as P

STEM = 'ms_staticdefense_s2'
OUT = 'out'
RNG = np.random.default_rng(90210)


def build_body():
    p = Part('body')

    # stepped casemate: lower slab + set-back upper block
    x, y, z, w, h, d = F.CASE_LO
    chamfer_box(p, (x, y, z), (w, h, d), 0.15,
                {'+x': F.R_WALL_LO, '-x': F.R_WALL_LO,
                 '+z': F.R_WALL_LO_F, '-z': F.R_WALL_LO_F,
                 '+y': F.R_LEDGE}, skip=('-y',))
    x, y, z, w, h, d = F.CASE_UP
    chamfer_box(p, (x, y, z), (w, h, d), 0.12,
                {'+x': F.R_WALL_UP, '-x': F.R_WALL_UP,
                 '+z': F.R_WALL_UP_F, '-z': F.R_WALL_UP_F,
                 '+y': F.R_ROOF}, skip=('-y',))

    # riveted slew plinth under the turret
    P.drum(p, F.PLINTH_C, r=F.PLINTH_R, h=F.PLINTH_H, zone=F.R_PLINTH, n=8)

    # roof furniture: cooling vent + ammo hatch
    x, y, z, w, h, d = F.VENT
    chamfer_box(p, (x, y, z), (w, h, d), 0.04,
                {k: F.R_VENT for k in ('+x', '-x', '+y', '+z', '-z')},
                skip=('-y',))
    x, y, z, w, h, d = F.HATCH
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {k: F.R_HATCH for k in ('+x', '-x', '+y', '+z', '-z')},
                skip=('-y',))

    # aerial to the 4.5 m mark + amber beacon on the front-right corner
    bx, by, bz = F.ANT_BASE
    P.antenna(p, (bx, by, bz), h=F.ANT_TOP - by, r=0.035, zone=F.R_TRIM)
    P.beacon(p, F.BEACON_C, size=0.16, glow_zone=F.R_BEACON)

    # ground clutter: front sandbag run + crates at the front-left corner
    P.sandbag_wall(p, F.SAND_A, F.SAND_B, h=F.SAND_H, zone=F.R_SAND)
    P.crate_stack(p, F.CRATE_O, rows=2, cols=1, tiers=1, size=0.6,
                  zone=F.R_CRATE, rng=RNG)
    return p


def build_turret():
    """Armoured gunhouse, turret-local: slew ring at the origin (yaw pivot),
    boxy gunhouse with a bevelled mantlet plate on the front face."""
    p = Part('turret')
    P.drum(p, (0, 0, 0), r=F.RING_R, h=F.RING_H, zone=F.R_RING, n=8)
    x, y, z, w, h, d = F.GH
    chamfer_box(p, (x, y, z), (w, h, d), 0.10,
                {'+x': F.R_GH, '-x': F.R_GH, '+z': F.R_GH_F, '-z': F.R_GH_F,
                 '+y': F.R_GH_T}, skip=('-y',))
    x, y, z, w, h, d = F.MANT
    chamfer_box(p, (x, y, z), (w, h, d), 0.08,
                {'+x': F.R_MANT, '-x': F.R_MANT, '+y': F.R_MANT,
                 '-y': F.R_MANT, '+z': F.R_MANT, '-z': F.R_MANT})
    return p


def build_barrel_twin():
    """Twin heavy autocannon tubes, barrel-local: pivot at the origin,
    tubes along -Z (xoff = twin spacing) with muzzle brakes as radius
    steps near the tip, cross-yoke behind the mantlet."""
    p = Part('barrel')
    stations = [(0.35, 0.100), (-1.45, 0.085), (-1.75, 0.070),
                (-1.80, 0.115), (-2.10, 0.115), (-F.BAR_LEN, 0.075)]
    for sx in (-F.BAR_X, F.BAR_X):
        tube(p, stations, F.R_BARREL, n=6,
             cap_start=F.R_CAP, cap_end=F.R_CAP, axis='z', xoff=sx)
    # cross-yoke between the tubes behind the mantlet
    limb(p, (-F.BAR_X, 0, 0.25), (F.BAR_X, 0, 0.25), 0.06, 0.06, F.R_TRIM, n=4)
    return p


def build_flak_mount():
    """Open flak pintle, turret2-local: base ring, pedestal, U-yoke arms,
    side ammo drum."""
    p = Part('turret2')
    P.drum(p, (0, 0, 0), r=0.34, h=0.12, zone=F.R_FLAK, n=8)
    limb(p, (0, 0.1, 0), (0, 0.62, 0), 0.085, 0.07, F.R_TRIM, n=6)
    for sx in (-1, 1):
        limb(p, (sx * 0.10, 0.5, 0), (sx * 0.17, 0.74, 0), 0.04, 0.035,
             F.R_TRIM, n=4)
    P.drum(p, (0.32, 0.34, 0.08), r=0.14, h=0.30, zone=F.R_FLAK, n=6)
    return p


def build_flak_barrel():
    """Single short flak tube, barrel-local: breech block at the pivot,
    tube along -Z with a conical flash hider as radius steps."""
    p = Part('turret2_barrel')
    chamfer_box(p, (0, 0, 0.14), (0.24, 0.22, 0.5), 0.04,
                {k: F.R_FLAK for k in ('+x', '-x', '+y', '-y', '+z', '-z')})
    tube(p, [(-0.1, 0.055), (-0.75, 0.050), (-0.95, 0.042),
             (-1.0, 0.075), (-1.12, 0.075), (-F.FLK_LEN, 0.05)],
         F.R_FLAKB, n=6, cap_start=F.R_CAP, cap_end=F.R_CAP, axis='z')
    return p


def build_all():
    pieces = [dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body())]

    # slot 1: twin heavy autocannon turret (standard aimable chain)
    t = P.turret_parts(body_index=0, mount=F.TUR_MOUNT, ring_r=F.RING_R,
                       barrel_len=F.BAR_LEN, twin=True)
    t[0]['part'] = build_turret()
    t[1]['part'] = build_barrel_twin()
    t[1]['offset'] = F.BAR_OFF
    t[2]['offset'] = F.MUZ_OFF
    base = len(pieces)
    t[1]['parent'] = base           # barrel under turret
    t[2]['parent'] = base + 1       # muzzle under barrel
    pieces.extend(t)

    # slot 2: light flak pintle (turret2 chain)
    f = P.turret_parts(body_index=0, mount=F.FLK_MOUNT, ring_r=0.34,
                       barrel_len=F.FLK_LEN, prefix='turret2')
    f[0]['part'] = build_flak_mount()
    f[1]['part'] = build_flak_barrel()
    f[1]['offset'] = F.FLK_BAR_OFF
    f[2]['offset'] = F.FLK_MUZ
    base = len(pieces)
    f[1]['parent'] = base
    f[2]['parent'] = base + 1
    pieces.extend(f)
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=None, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=None, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
