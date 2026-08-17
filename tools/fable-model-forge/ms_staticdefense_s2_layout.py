"""ms_staticdefense_s2_layout — zones + dims for ms_staticdefense_s2.

'Defense Battery' — static defense scale 2 (4.5 m to the antenna tip,
~6x6 m footprint). A PERMANENT hardpoint one tier up from the s1 gun
nest: stepped poured-concrete casemate (hazard-striped slew ring, entry
door, vents, ammo hatches), armoured gunhouse turret with TWIN heavy
autocannon (slot 1, MS_AC_S3), and a small open flak pintle mount on the
rear-right roof corner (slot 2, MS_FLAK_S1). Sandbags + crates at the
base, aerial + amber beacon on the roof. No clips — the aim controller
owns both turret chains.
World frame: guns face -Z at rest, up +Y, ground Y=0. 1024^2 atlas.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
# stepped casemate: wide lower slab + set-back upper block
CASE_LO = (0.0, 0.55, 0.2, 5.4, 1.10, 5.4)   # cx,cy,cz,w,h,d → y 0.00..1.10
CASE_UP = (0.0, 1.45, 0.2, 4.6, 0.70, 4.6)   #                 y 1.10..1.80
ROOF_Y  = 1.80
LEDGE_Y = 1.10

# turret plinth (body) + main turret chain
PLINTH_C = (0.0, ROOF_Y, 0.4)      # drum base centre (base y, r, h below)
PLINTH_R, PLINTH_H = 1.15, 0.18
TUR_MOUNT = (0.0, ROOF_Y + PLINTH_H, 0.4)    # turret piece offset on body
RING_R, RING_H = 0.95, 0.20                  # turret-local slew ring
GH = (0.0, 0.65, 0.05, 2.0, 0.90, 2.2)       # gunhouse box (turret-local)
MANT = (0.0, 0.60, -1.15, 1.4, 0.65, 0.30)   # mantlet plate (turret-local)
BAR_OFF = (0.0, 0.60, -1.0)                  # barrel pivot (turret-local)
BAR_LEN = 2.2                                # pivot → muzzle
BAR_X   = 0.17                               # twin-tube half spacing
MUZ_OFF = (0.0, 0.0, -BAR_LEN)               # muzzle empty (barrel-local)

# flak pintle mount (turret2 chain), rear-right roof corner
FLK_MOUNT = (1.45, ROOF_Y, 1.75)             # turret2 piece offset on body
FLK_BAR_OFF = (0.0, 0.70, -0.05)             # turret2_barrel pivot
FLK_LEN = 1.2
FLK_MUZ = (0.0, 0.0, -FLK_LEN)

# roof furniture (body)
VENT   = (-1.5, ROOF_Y + 0.13, -1.2, 0.7, 0.26, 0.7)   # cooling vent box
HATCH  = (1.5, ROOF_Y + 0.09, -1.2, 0.85, 0.18, 0.85)  # ammo hatch box
BEACON_C = (1.95, ROOF_Y + 0.08, -1.75)
ANT_BASE = (-1.9, ROOF_Y, 2.2)
ANT_TOP  = 4.5                                # dominant dim: 4.5 m

# ground clutter (body)
SAND_A, SAND_B = (-1.5, 0.0, -2.72), (1.5, 0.0, -2.72)  # front sandbag run
SAND_H = 0.6
CRATE_O = (-2.05, 0.0, -2.6)                 # crates, front-left corner

# ── atlas zones (1024²; v down) ──────────────────────────────────────────
# body — casemate
R_ROOF    = Zone((0,   0,   384, 384), ('x', 'z'), ((-2.3, 2.3), (-2.1, 2.5)))
R_LEDGE   = Zone((0,   384, 256, 576), ('x', 'z'), ((-2.7, 2.7), (-2.5, 2.9)))
R_WALL_LO   = Zone((384, 0, 896, 128), ('z', 'y'), ((-2.7, 2.9), (1.12, -0.02)))
R_WALL_LO_F = Zone((384, 0, 896, 128), ('x', 'y'), ((-2.7, 2.7), (1.12, -0.02)))
R_WALL_UP   = Zone((384, 128, 896, 240), ('z', 'y'), ((-2.3, 2.5), (1.82, 1.08)))
R_WALL_UP_F = Zone((384, 128, 896, 240), ('x', 'y'), ((-2.3, 2.3), (1.82, 1.08)))
# turret (turret-local coords)
R_GH      = Zone((384, 240, 832, 368), ('z', 'y'), ((-1.15, 1.25), (1.15, 0.15)))
R_GH_F    = Zone((384, 240, 832, 368), ('x', 'y'), ((-1.05, 1.05), (1.15, 0.15)))
R_GH_T    = Zone((832, 240, 1024, 368), ('x', 'z'), ((-1.05, 1.05), (-1.15, 1.25)))
R_MANT    = Zone((0,   576, 160, 672), ('x', 'y'), ((-0.75, 0.75), (0.95, 0.25)))
R_RING    = Zone((160, 576, 352, 656), ('x', 'y'), ((-1.0, 1.0), (0.22, -0.02)))
R_PLINTH  = Zone((352, 576, 544, 656), ('x', 'y'), ((-1.25, 1.25), (2.02, 1.76)))
# rect wraps (limb/tube)
R_BARREL  = (544, 576, 736, 640)     # main gun tubes (u along the tube)
R_TRIM    = (736, 576, 896, 640)     # antenna, yoke, pedestal, small limbs
R_FLAKB   = (544, 640, 736, 688)     # flak tube wrap
# ground clutter / fittings
R_SAND    = Zone((0,   688, 320, 800), ('x', 'y'), ((-1.8, 1.8), (0.66, -0.02)))
R_CRATE   = Zone((320, 688, 448, 800), ('x', 'y'), ((-2.5, -1.5), (0.85, -0.05)))
R_FLAK    = Zone((448, 688, 576, 800), ('x', 'y'), ((-0.5, 0.5), (0.9, -0.05)))
R_VENT    = Zone((576, 688, 704, 800), ('x', 'y'), ((-2.0, -1.0), (2.1, 1.75)))
R_HATCH   = Zone((704, 688, 832, 800), ('x', 'z'), ((1.0, 2.0), (-1.7, -0.7)))
R_BEACON  = Zone((832, 688, 896, 752), ('x', 'y'), ((1.83, 2.07), (2.0, 1.78)))
R_CAP     = Zone((896, 640, 960, 704), ('x', 'y'), ((-0.15, 0.15), (0.15, -0.15)))
R_DARK    = Zone((896, 752, 1024, 880), ('x', 'z'), ((-30, 30), (-30, 30)))
