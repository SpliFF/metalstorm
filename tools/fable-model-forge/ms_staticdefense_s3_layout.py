"""ms_staticdefense_s3_layout — zones + dims for ms_staticdefense_s3.

'Defense Battery' — scale-3 hardened RAILGUN emplacement, 6 m to the
turret-rear whip antenna. Stepped concrete plinth (pad + tier + armoured
casemate with bolted plates, vents, cable trunking, entry door), hazard
slew ring, heavy cradle turret with capacitor drums on the cheeks and ONE
long railgun: boxy accelerator sleeve (amber charge-strip emissive) over
the rear half tapering to a narrow emitter tube. Secondary open flak
mount (turret2, twin short tubes) on a rear-right shelf with ammo boxes.
World frame: guns face -Z at rest, up +Y, ground Y=0. 1024 atlas.
Aim chains: turret->barrel->muzzle (MS_RAILGUN_S3, weapon slot 1),
turret2->turret2_barrel->turret2_muzzle (MS_FLAK_S2, slot 2).
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# -- dims (world metres, ground Y=0) --------------------------------------
PAD   = (0.0, 0.30, 0.0, 5.8, 0.60, 5.8)     # cx,cy,cz,w,h,d — y 0.0..0.6
TIER  = (0.0, 1.35, 0.0, 4.8, 1.50, 4.8)     # y 0.6..2.1
CASE  = (0.0, 3.15, 0.0, 3.8, 2.10, 3.8)     # y 2.1..4.2
RING_R, RING_Y0, RING_H = 1.5, 4.2, 0.30     # slew ring drum, y 4.2..4.5

TURRET_MOUNT = (0.0, 4.5, 0.0)               # turret yaw pivot (world)
TUR_RING_R   = 1.3
GUNHOUSE     = (0.0, 0.575, 0.50, 2.3, 0.85, 1.8)   # turret-local cradle box
CAP_X, CAP_Z = 1.30, 0.35                    # capacitor drum centres (local)
CAP_R, CAP_H, CAP_Y = 0.34, 0.95, 0.18
ANT_BASE     = (0.9, 1.0, 1.1)               # whip antenna (turret-local)
ANT_TOP_Y    = 1.5                           # tip -> world 6.0 (dominant dim)

BARREL_OFF   = (0.0, 0.72, -0.3)             # barrel pitch pivot (turret-local)
BREECH       = (0.0, 0.0, 0.45, 0.55, 0.55, 0.70)   # barrel-local, z 0.1..0.8
SLEEVE       = (0.0, 0.0, -1.25, 0.62, 0.60, 2.30)  # accelerator, z -0.1..-2.4
TUBE_STATIONS = [(-2.35, 0.19), (-3.40, 0.145), (-3.52, 0.115), (-4.20, 0.095)]
MUZZLE_OFF   = (0.0, 0.0, -4.2)              # barrel-local muzzle empty

SHELF        = (1.7, 2.175, 1.7, 1.6, 0.15, 1.6)    # flak shelf, top 2.25
TURRET2_MOUNT = (1.7, 2.25, 1.7)
FLAK_RING_R  = 0.42
FLAK_LEN     = 1.4
CRATE_A      = (1.18, 2.45, 1.18, 0.40)      # ammo box on the shelf corner
CRATE_B      = (2.12, 2.325, -0.30, 0.45)    # ammo box on the tier strip

# -- atlas zones (1024 sq; v down) ----------------------------------------
R_PAD_T   = Zone((0, 0, 320, 320), ('x', 'z'), ((-2.9, 2.9), (-2.9, 2.9)))
R_PAD_S   = Zone((0, 320, 320, 368), ('x', 'y'), ((-2.9, 2.9), (0.62, -0.02)))
R_PAD_SZ  = Zone((0, 320, 320, 368), ('z', 'y'), ((-2.9, 2.9), (0.62, -0.02)))
R_TIER_S  = Zone((320, 0, 704, 120), ('x', 'y'), ((-2.42, 2.42), (2.12, 0.58)))
R_TIER_SZ = Zone((320, 0, 704, 120), ('z', 'y'), ((-2.42, 2.42), (2.12, 0.58)))
R_TIER_T  = Zone((704, 0, 1024, 120), ('x', 'z'), ((-2.42, 2.42), (-2.42, 2.42)))
R_CASE_S  = Zone((320, 120, 704, 336), ('x', 'y'), ((-1.92, 1.92), (4.22, 2.08)))
R_CASE_SZ = Zone((320, 120, 704, 336), ('z', 'y'), ((-1.92, 1.92), (4.22, 2.08)))
R_CASE_T  = Zone((704, 120, 928, 336), ('x', 'z'), ((-1.92, 1.92), (-1.92, 1.92)))
R_RING    = Zone((0, 368, 320, 416), ('x', 'y'), ((-1.55, 1.55), (4.52, 4.18)))
# turret-local zones
R_TURRET  = Zone((320, 336, 704, 480), ('x', 'y'), ((-1.35, 1.35), (1.10, -0.05)))
R_TURRETZ = Zone((320, 336, 704, 480), ('z', 'y'), ((-1.35, 1.35), (1.10, -0.05)))
R_TURRET_T = Zone((704, 336, 928, 480), ('x', 'z'), ((-1.25, 1.25), (-0.80, 1.50)))
R_CAP     = Zone((0, 416, 320, 544), ('x', 'y'), ((-1.70, 1.70), (1.20, 0.10)))
# barrel-local zones
R_BREECH  = Zone((0, 544, 192, 672), ('x', 'y'), ((-0.40, 0.40), (0.40, -0.40)))
R_SLV_S   = Zone((320, 480, 704, 544), ('z', 'y'), ((-0.05, -2.45), (0.34, -0.34)))
R_SLV_T   = Zone((320, 544, 704, 608), ('z', 'x'), ((-0.05, -2.45), (-0.34, 0.34)))
R_BARREL  = (704, 480, 896, 544)      # rect — emitter tube wrap (u = along)
R_TRIM    = (704, 544, 896, 608)      # rect — antenna / small limbs
# flak (turret2-local) + clutter
R_FLAK    = Zone((0, 672, 192, 800), ('x', 'y'), ((-0.62, 0.62), (0.80, -0.05)))
R_FLAKB   = (704, 608, 896, 672)      # rect — flak tube wrap
R_CRATE   = Zone((192, 544, 320, 672), ('x', 'y'), ((-2.6, 2.6), (2.75, 1.95)))
R_SHELF_Z = Zone((928, 120, 1024, 216), ('x', 'y'), ((0.85, 2.55), (2.30, 2.05)))
R_DARK    = Zone((896, 448, 1024, 576), ('x', 'z'), ((-30, 30), (-30, 30)))
