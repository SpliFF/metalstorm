"""ms_artillery_s1_layout — zones + dims for ms_artillery_s1.

Light wheeled MORTAR CARRIER (artillery row, s1: STYLE.md length = 4.5 m,
tri budget 2000, aim ~1200). Deliberately a lighter read than the tracked
s2 SPG: a small 4-wheel flatbed utility truck of the same blue-grey army —
half-cab up front, rear bed with rail lip, and on the bed a heavy mortar
on a ring turntable: short stubby tube at ~65 deg resting elevation,
baseplate, bipod arms, ammo crates + tarp stowage. Aim chain
turret -> barrel -> muzzle; spinnable axle_f / axle_r.
World frame: forward -Z, up +Y, left +X, ground Y=0, 1 unit = 1 m.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone
import numpy as np

# ── atlas zones (1024²; v down) ──────────────────────────────────────────
S_TOP    = Zone((0,    0,   384, 448), ('x', 'z'), ((-0.80, 0.80), (-2.25, 2.25)))
S_SIDE   = Zone((384,  0,   896, 160), ('z', 'y'), ((-2.25, 2.25), (1.62, 0.30)))
S_FRONT  = Zone((896,  0,   1024, 128), ('x', 'y'), ((-0.80, 0.80), (1.12, 0.30)))
S_REAR   = Zone((896,  128, 1024, 256), ('x', 'y'), ((0.80, -0.80), (1.12, 0.30)))
S_WINDS  = Zone((896,  256, 1024, 352), ('x', 'y'), ((-0.70, 0.70), (1.64, 1.02)))
S_WHEEL  = (0,   448, 512, 544)          # parametric tyre tread wrap
S_HUB    = Zone((512,  448, 640, 576), ('z', 'y'), ((-0.44, 0.44), (0.44, -0.44)))
S_FIT    = Zone((640,  448, 832, 544), ('x', 'y'), ((-0.70, 0.70), (1.40, 0.60)))
S_TUBE   = (832, 448, 1024, 512)         # parametric mortar-tube wrap
S_TRIM   = (832, 512, 1024, 560)         # parametric small steel wrap
S_BREECH = Zone((832,  560, 960, 656), ('x', 'y'), ((-0.20, 0.20), (0.20, -0.20)))
S_CRATE  = Zone((0,    544, 160, 704), ('x', 'y'), ((-0.35, 0.35), (0.35, -0.35)))
S_TARP   = Zone((160,  544, 352, 672), ('x', 'z'), ((-0.55, 0.55), (-0.35, 0.35)))
S_RING_W = (352, 544, 608, 592)          # parametric turntable ring wrap
S_MOUNT  = Zone((352,  592, 512, 752), ('x', 'y'), ((-0.40, 0.40), (0.85, 0.05)))
S_RING_T = Zone((512,  592, 704, 784), ('x', 'z'), ((-0.55, 0.55), (-0.55, 0.55)))
S_PLATE  = Zone((704,  592, 832, 720), ('x', 'z'), ((-0.38, 0.38), (-0.38, 0.38)))
S_DARK   = Zone((896,  832, 1024, 960), ('x', 'z'), ((-1.0, 1.0), (-2.25, 2.25)))

# ── dims (metres; forward -Z, ground Y=0) ────────────────────────────────
BODY_LEN = (-2.25, 2.25)                 # 4.5 m dominant dim (artillery s1)

# hull loft sections: (z, y_bot, y_waist, y_shoulder, y_deck,
#                      w_bot, w_waist, w_deck, w_top)
# half-cab truck: hood -> windscreen slope -> short cab roof -> flat bed
BODY_SECTIONS = [
    (-2.25, 0.46, 0.62, 0.96, 1.02, 0.50, 0.68, 0.64, 0.56),   # grille
    (-1.62, 0.40, 0.60, 1.04, 1.10, 0.56, 0.76, 0.72, 0.64),   # hood rear
    (-1.18, 0.40, 0.60, 1.48, 1.58, 0.56, 0.76, 0.70, 0.58),   # roof front
    (-0.52, 0.40, 0.60, 1.48, 1.58, 0.56, 0.76, 0.70, 0.58),   # roof rear
    (-0.30, 0.40, 0.60, 0.94, 1.00, 0.56, 0.76, 0.72, 0.66),   # cab back
    (2.25,  0.46, 0.60, 0.94, 1.00, 0.52, 0.72, 0.68, 0.62),   # bed rear
]
DECK_Y = 1.00                             # flat bed top

# wheels / axles (piece-local origin at axle centre; 8-gon flats grounded)
WHEEL_R  = 0.44
WHEEL_N  = 8
WHEEL_HW = 0.16                           # tyre half-width
TRACK_X  = 0.80                           # wheel centre |x|
AXLE_Y   = WHEEL_R * float(np.cos(np.pi / WHEEL_N))
AXLE_F_Z = -1.50
AXLE_R_Z = 1.35
AXLE_BAR = (1.90, 0.15, 0.15)             # connecting bar w,h,d

# bed furniture (model frame)
RAIL_X    = 0.60                          # side rail |x|
RAIL_BOX  = (0.07, 0.18, 2.40)            # side rail w,h,d
RAIL_Z    = 1.00                          # rail centre z
RAIL_Y    = DECK_Y + 0.09
GATE_BOX  = (1.26, 0.18, 0.07)            # tailgate w,h,d
GATE_Z    = 2.20
CRATES    = [(-0.36, -0.02, 0.44), (0.34, 0.02, 0.38)]   # (x, z, size)
TARP_CTR  = (0.02, DECK_Y, 1.92)          # tarp roll at bed rear
TARP_SIZE = (1.05, 0.26, 0.52)
EXH_BASE  = (-0.82, 0.78, -0.06)          # exhaust stack base
EXH_TOP_Y = 1.78
EXH_R     = 0.055
MIRROR_X  = 0.86                          # cab mirror arms

# mortar turntable (`turret` piece; offset places it on the bed)
TUR_OFF   = (0.0, DECK_Y, 0.90)
RING_R    = 0.52
RING_H    = 0.11
PLATE_R   = 0.36                          # octagonal baseplate on the ring
PLATE_H   = 0.07
PED_BOX   = (0.34, 0.20, 0.34)            # pedestal block c=(0, .28, .04)
BIPOD_FOOT = (0.30, RING_H + PLATE_H, -0.36)   # |x|, y, z of each leg foot
TRUNNION  = (0.0, 0.56, -0.12)            # barrel pivot, turret-local

# mortar tube (`barrel` piece; local origin = trunnion)
ELEV_DEG  = 65.0
TUBE_R0   = 0.105                         # breech-end radius
TUBE_R1   = 0.088                         # muzzle-end radius
TUBE_BACK = 0.42                          # breech length behind pivot
TUBE_FWD  = 1.02                          # length pivot -> muzzle
MUZZ_RING = 0.115                         # muzzle collar radius
BREECH_BOX = (0.24, 0.22, 0.20)           # recoil/breech housing
