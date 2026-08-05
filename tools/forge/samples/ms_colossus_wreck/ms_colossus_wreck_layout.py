"""ms_colossus_wreck_layout — zones + dims + scene poses for ms_colossus_wreck.

Fallen FW-15 "Fenrir" colossus as static terrain: the hulk collapsed on
its LEFT side (spine along +X, chest facing -Z and tipped ~25 deg
skyward), head slumped chin-down ahead of the neck, one leg still
attached and crumpled behind the pelvis, the OTHER leg torn off and
lying apart to the north, pack hump half-crushed on the ground side,
gun arm sprawled with the rotary cannon flat in the dirt, breakoff
scatter (pauldron, snapped exhaust stack, armor plates, rubble) around a
scorched ash pad.  Rust/soot repaint; the only emissive is a small warm
ember glow in the cracked furnace chest.  Static terrain: single body
piece, no clips, no team colour.

World frame: up +Y, forward -Z, ground Y=0, 1 unit = 1 m.  Atlas 2048
(wreck footprint ~16 m).  Budget 5000.  Seed 90210.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas cells (2048 px; v down) ───────────────────────────────────────
# column A — torso / head / pack / fittings (Zones window LOCAL frames)
C_TORSO_FRONT = Zone((0,    0,    512,  448),  ('x', 'y'), ((-2.35, 2.35), (4.30, -0.20)))
C_TORSO_SIDE  = Zone((512,  0,    1024, 448),  ('z', 'y'), ((-3.10, 2.20), (4.30, -0.20)))
C_TORSO_REAR  = Zone((0,    448,  448,  832),  ('x', 'y'), ((2.35, -2.35), (4.30, -0.20)))
C_TORSO_TOP   = Zone((448,  448,  896,  832),  ('x', 'z'), ((-2.35, 2.35), (-3.10, 2.20)))
PELVIS_CELL   = (896,  448,  1024, 704)   # cell-mapped pelvis faces
C_HEAD_TOP    = Zone((0,    832,  256,  1088), ('x', 'z'), ((-1.25, 1.25), (-1.95, 1.05)))
C_HEAD_SIDE   = Zone((256,  832,  512,  1088), ('z', 'y'), ((-1.95, 1.05), (1.45, -0.80)))
C_HEAD_FRONT  = Zone((0,    1088, 192,  1280), ('x', 'y'), ((-1.15, 1.15), (1.15, -0.80)))
C_PACK        = Zone((512,  832,  1024, 1216), ('x', 'y'), ((-2.15, 2.15), (1.25, -1.25)))
C_PACK_TOP    = Zone((512,  1216, 896,  1280), ('x', 'z'), ((-2.15, 2.15), (-1.20, 1.20)))
STACK_W       = (384,  1280, 640,  1408)  # stack side wrap (rect)
C_STACK_TOP   = Zone((640,  1280, 768,  1408), ('x', 'z'), ((-0.40, 0.40), (-0.40, 0.40)))
C_PAULDRON    = Zone((0,    1536, 448,  1856), ('x', 'z'), ((-1.10, 1.10), (-1.60, 1.60)))
C_PAULDRON_S  = Zone((448,  1856, 896,  1984), ('z', 'y'), ((-1.60, 1.60), (0.60, -0.60)))
FURNACE_CELL  = (448,  1536, 704,  1728)  # cracked furnace grille + embers
HOSE_W        = (704,  1536, 896,  1728)  # corrugated hose wrap (rect)
COLLAR_CELL   = (0,    1856, 448,  1984)  # neck-guard cell
JOINT_W       = (896,  1408, 1024, 1536)  # joint/bearing drum wrap (rect)
JOINT_CAP     = (896,  1536, 1024, 1664)  # bearing cap cell (per-instance zone)
C_DARK        = Zone((896,  1664, 1024, 1728), ('x', 'z'), ((-1.0, 1.0), (-1.0, 1.0)))
DARK_CELL     = (896,  1664, 1024, 1728)
C_HORN        = Zone((896,  1728, 1024, 1856), ('x', 'y'), ((-0.70, 0.70), (1.75, 0.15)))
PISTON_W      = (448,  1728, 704,  1856)  # chrome piston wrap (rect)
C_TRIM        = Zone((704,  1728, 896,  1856), ('z', 'y'), ((-1.60, 1.60), (0.20, -0.20)))
TRIM_CELL     = (704,  1728, 896,  1856)

# column B — limbs / weapons / scatter / ground
LIMB_W        = (1024, 0,    1408, 384)   # thigh+shin wrap (rect)
C_FOOT_SIDE   = Zone((1408, 0,    1664, 256),  ('z', 'y'), ((-2.25, 1.25), (0.15, -1.50)))
FOOT_W        = (1024, 384,  1536, 512)   # foot perimeter wrap (rect)
PLATE_CELL    = (1536, 384,  1792, 576)   # armor plate cell (scatter + guards)
ARM_W         = (1024, 512,  1408, 832)   # upper-arm wrap (rect)
RECEIVER_CELL = (1408, 576,  1792, 832)   # gun receiver cell-mapped
GUN_W         = (1024, 832,  1536, 960)   # gun tube wrap (rect)
C_MUZZLE      = Zone((1536, 832,  1728, 1024), ('x', 'y'), ((-0.60, 0.60), (0.60, -0.60)))
TANK_W        = (1728, 1152, 1984, 1280)  # ammo drum wrap (rect)
C_TANK_CAP    = Zone((1728, 1024, 1856, 1152), ('z', 'y'), ((-0.62, 0.62), (0.62, -0.62)))
RUBBLE_CELL   = (1856, 1024, 2048, 1152)  # scorched debris chunk cell
PAD_T         = (1024, 1280, 1664, 1920)  # ash/scorched-earth pad top
PAD_S         = (1024, 1920, 1664, 1984)  # pad edge band
TORN_CELL     = (1664, 1280, 1920, 1536)  # torn-metal jag cell

Z_PAD_T = Zone(PAD_T, ('x', 'z'), ((-9.0, 9.0), (-6.5, 6.5)))

# ── component dims (local upright frames, from the fable_colossus tables,
#    simplified for a 5000-tri static wreck) ────────────────────────────
PAD = (17.5, 0.07, 12.5)              # w, h, d
PAD_C = (-0.3, 0.1)                   # centre (x, z)

# torso Y-loft sections (spine-local): (y, z_center, half_w, half_d)
TORSO_SECTIONS = [
    (-0.10, 0.10, 1.55, 1.30),
    (0.90,  -0.05, 1.75, 1.50),
    (2.00, -0.75, 2.05, 1.70),
    (3.00, -1.40, 2.25, 1.80),
    (3.90, -1.80, 2.05, 1.50),
]
COLLAR = (0.0, 3.00, -2.30, 2.8, 0.65, 1.3)       # torso-local neck guard
FURNACE_BOX = (0.0, 1.90, -2.42, 2.4, 1.6, 0.55)  # cracked chest furnace
PAULDRON_FIX = (-3.25, 3.70, -1.20)               # fixed pauldron (now up-fin)
PAULDRON_SIZE = (2.1, 0.7, 3.1)
PAULDRON_HORN = (0.60, 0.80, -1.00)

HEAD_SNOUT = [   # z-loft sections head-local: (z, y_bot, y_top, half_w)
    (0.95, -0.62, 0.92, 1.15),
    (-0.25, -0.66, 1.02, 1.06),
    (-1.20, -0.46, 0.62, 0.82),
    (-1.80, -0.26, 0.34, 0.60),
]
BROW = (0.0, 0.98, -0.85, 2.4, 0.42, 1.35)
JAW = (0.0, -0.72, -0.85, 1.15, 0.4, 1.35)

PELVIS_SIZE = (3.2, 1.7, 2.6)
PELVIS_LOCAL_OFF = (0.0, -0.80, -0.15)  # pelvis centre, torso(spine)-local
HIP_LOCAL_UP = (-1.30, -0.15, -0.05)    # pelvis-local socket facing UP

THIGH_R0, THIGH_R1 = 0.95, 0.76
SHIN_R0, SHIN_R1 = 0.84, 0.60
FOOT_HALF_W = 0.95
FOOT_PROFILE = [
    (-1.10, -1.33), (0.95, -1.33), (1.10, -0.84),
    (0.55, -0.34), (-0.55, -0.09), (-1.10, -0.62),
]
TOE_OFF = (0.0, -0.95, -1.05)
TOE_PROFILE = [(0.10, -0.38), (-0.72, -0.38), (-0.98, -0.16), (-0.10, 0.14)]

PACK_SIZE = (4.1, 2.2, 2.2)
PACK_OFF = (0.0, 3.55, 1.30)          # torso-local
RACK = (0.0, 1.20, -0.35, 3.2, 0.55, 2.0)
STACK_L_OFF = (1.15, 0.95, 0.55)      # surviving stack, pack-local
STACK_R_OFF = (-1.05, 0.95, 0.55)     # torn stub, pack-local
STACK_R, STACK_H = 0.34, 1.90

ARM_OFF = (-2.95, 3.30, -1.25)        # torso-local shoulder (up side)
ARM_R0, ARM_R1 = 0.74, 0.62
GUN_RECEIVER = (0.0, 0.05, -1.0, 1.45, 1.45, 3.0)  # gun-local
GUN_TUBE = [(-2.3, 0.30, -0.10), (-3.95, 0.30, -0.10)]
GUN_ORBITS = [(0.32, -0.10), (-0.32, -0.10), (0.0, 0.22)]
AMMO_DRUM = (-1.05, 0.42, 0.15)       # gun-local flank

# ── scene poses (rotation specs applied right-to-left; degrees) ─────────
HULK_ROT = [('y', -15), ('x', 25), ('z', -90)]
HULK_T = (-1.2, 1.62, 0.2)

HEAD_ROT = [('y', -30), ('x', -32), ('z', 38)]
HEAD_T = (3.05, 0.88, -2.55)

# attached (right) leg — crumpled, sprawled south of the pelvis (world)
LEG_A_KNEE = (-4.55, 1.15, 1.75)
LEG_A_ANKLE = (-3.70, 0.50, 4.25)
FOOT_A_ROT = [('y', 150), ('z', 70)]

# torn-off (left) leg — lying apart, north side (world)
LEG_B_HIP = (1.40, 0.78, -3.65)       # torn stub end
LEG_B_KNEE = (-1.70, 0.60, -4.35)
LEG_B_ANKLE = (-4.50, 0.52, -4.80)
FOOT_B_ROT = [('y', -100), ('z', -80)]

GUN_ROT = [('y', -35), ('z', 14)]
GUN_T = (3.15, 0.66, -1.45)

STACK_FREE_ROT = [('y', 35), ('x', 82)]
STACK_FREE_T = (5.15, 0.36, 2.75)

PAULDRON_FREE_ROT = [('y', 55), ('x', -32), ('z', 8)]
PAULDRON_FREE_T = (0.25, 0.38, -3.65)

# scattered armor plates: (cx, cy, cz, w, h, d, rot)
SCATTER_PLATES = [
    (4.85, 0.14, 0.75, 1.50, 0.18, 1.95, [('y', 20), ('x', -12)]),
    (-0.70, 0.16, 4.05, 1.30, 0.16, 1.70, [('y', -42), ('x', 9)]),
    (-5.60, 0.10, -1.90, 1.15, 0.15, 1.45, [('y', 72), ('z', -7)]),
]
# rubble chunks: (cx, cy, cz, w, h, d, yaw_deg)
RUBBLE = [
    (2.30, 0.16, -3.30, 0.80, 0.45, 0.65, 25),
    (-2.90, 0.14, -2.60, 0.65, 0.40, 0.55, -40),
    (0.40, 0.12, 3.30, 0.55, 0.34, 0.45, 60),
    (4.10, 0.10, -2.45, 0.45, 0.30, 0.40, -15),
    (-4.90, 0.12, 2.30, 0.60, 0.36, 0.50, 105),
    (-0.15, 0.10, -4.85, 0.42, 0.28, 0.38, 8),
    (5.85, 0.09, 0.90, 0.38, 0.26, 0.34, -70),
]
