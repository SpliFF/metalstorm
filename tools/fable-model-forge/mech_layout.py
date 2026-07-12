"""mech_layout — dimensions, atlas zones and clip keyframes for fable_mech.

MW-3 "Strider": reverse-joint (chicken-walker) recon mech, total height
3.18 m — deliberately identical to fable_tank's height for side-by-side
judging. Forward −Z, up +Y, left +X, ground Y=0, 1 unit = 1 m.

Rig (pieces, parent-relative offsets; pivots ARE the joints):
  body (root, pelvis @ y≈1.62)
   ├─ turret  (torso yaw)        offset (0, 1.92, 0)
   │   └─ barrel (arm railgun)   offset (−0.66, 0.46, 0.02)  [right shoulder]
   │       └─ muzzle (empty)     offset (0, 0, −1.55)
   ├─ exhaust (empty, back vents; child of turret)
   ├─ thigh_l offset (+0.44, 1.55, 0) → knee at local (0, −0.62, +0.30)
   │   └─ shin_l  offset = knee → ankle at local (0, −0.63, −0.42)
   │       └─ foot_l offset = ankle (sole local y −0.30 → ground)
   └─ thigh_r / shin_r / foot_r (x-mirrored)
"""
from meshlib import Zone

# ── atlas zones (1024², v down) ──────────────────────────────────────────
M_TORSO_FRONT = Zone((0,   0,   224, 224), ('x', 'y'), ((-0.75, 0.75), (1.30, -0.05)))
M_TORSO_SIDE  = Zone((224, 0,   448, 224), ('z', 'y'), ((-0.65, 0.65), (1.30, -0.05)))
M_TORSO_REAR  = Zone((448, 0,   672, 224), ('x', 'y'), ((0.75, -0.75), (1.30, -0.05)))
M_TORSO_TOP   = Zone((672, 0,   896, 160), ('x', 'z'), ((-0.75, 0.75), (-0.65, 0.65)))
M_PELVIS      = Zone((896, 0,  1024, 160), ('z', 'y'), ((-0.45, 0.45), (1.95, 1.30)))
M_HEAD        = Zone((0,   224, 192, 352), ('x', 'y'), ((-0.30, 0.30), (1.32, 0.88)))
M_THIGH       = (192, 224, 384, 304)   # limb wrap (parametric)
M_SHIN        = (192, 304, 384, 384)   # limb wrap
M_FOOT_SIDE   = Zone((384, 224, 576, 304), ('z', 'y'), ((-0.70, 0.36), (0.16, -0.34)))
M_FOOT_WRAP   = (384, 304, 576, 368)   # arc-length wrap
M_JOINT       = (576, 224, 704, 288)   # joint stub wrap
M_JOINT_CAP   = Zone((704, 224, 768, 288), ('z', 'y'), ((-0.20, 0.20), (0.20, -0.20)))
M_SHOULDER    = Zone((576, 288, 768, 352), ('z', 'y'), ((-0.35, 0.35), (0.92, 0.30)))
M_GUN_WRAP    = (0,   384, 448, 480)   # tube parametric
M_RAIL        = Zone((448, 384, 704, 448), ('z', 'y'), ((-1.30, -0.30), (0.13, -0.13)))
M_RECEIVER    = Zone((704, 384, 896, 480), ('z', 'y'), ((-0.38, 0.55), (0.18, -0.20)))
M_MUZZLE_CELL = Zone((896, 384, 1024, 448), ('x', 'y'), ((-0.14, 0.14), (0.15, -0.15)))
M_VENTS       = Zone((0,   480, 160, 576), ('x', 'y'), ((-0.30, 0.30), (0.80, 0.30)))
M_DARK        = Zone((960, 160, 1024, 224), ('x', 'z'), ((-0.5, 0.5), (-0.5, 0.5)))

# ── skeleton (offsets) ───────────────────────────────────────────────────
TURRET_OFF = (0.0, 1.92, 0.0)
BARREL_OFF = (-0.92, 0.46, 0.02)
MUZZLE_OFF = (0.0, 0.0, -1.55)
EXHAUST_OFF = (0.0, 0.62, 0.66)          # turret-local
HIP_X, HIP_Y = 0.44, 1.55
KNEE = (0.0, -0.62, 0.30)                 # thigh-local (reverse joint: back)
ANKLE = (0.0, -0.63, -0.42)               # shin-local (down-forward)

# ── geometry constants ───────────────────────────────────────────────────
PELVIS = (0.0, 1.62, 0.04, 0.72, 0.50, 0.62)     # x,y,z,w,h,d
TORSO_SECTIONS = [  # (z, yb, yw, ys, yd, wb, ww, wd, wt) — turret-local
    (-0.58, 0.02, 0.30, 0.62, 0.72, 0.34, 0.58, 0.44, 0.30),
    (-0.25, -0.07, 0.32, 0.78, 0.90, 0.48, 0.74, 0.60, 0.44),
    (0.15,  -0.07, 0.34, 0.82, 0.94, 0.50, 0.78, 0.62, 0.46),
    (0.52,  0.02, 0.32, 0.68, 0.78, 0.40, 0.64, 0.50, 0.34),
]
HEAD = (0.0, 1.09, -0.10, 0.50, 0.34, 0.55)      # top at local 1.26 → 3.18 m
PAULDRON = (0.72, 0.60, 0.02, 0.24, 0.52, 0.62)  # left shoulder plate
BACKPACK = (0.0, 0.55, 0.56, 0.55, 0.42, 0.16)   # vent box, rear face emissive
THIGH_R0, THIGH_R1 = 0.20, 0.15
SHIN_R0, SHIN_R1 = 0.155, 0.115
FOOT_PROFILE = [  # (z, y) ankle-local, extruded x ±FOOT_HALF_W
    (0.30, -0.02), (0.30, -0.24), (0.22, -0.30), (-0.38, -0.30),
    (-0.60, -0.22), (-0.64, -0.10), (-0.30, 0.04), (-0.12, 0.10), (0.14, 0.10),
]
FOOT_HALF_W = 0.19
GUN_RECEIVER = (0.0, -0.02, 0.10, 0.28, 0.36, 0.78)
GUN_TUBE = [(-0.30, 0.105), (-1.28, 0.105)]
GUN_RAILS = [(0.14, 0.055, 0.24), (-0.14, 0.055, 0.24)]  # x, w, h
GUN_RAIL_ZSPAN = (-0.34, -1.30)
GUN_MUZZLE_BLOCK = (0.0, 0.0, -1.38, 0.20, 0.24, 0.18)
GUN_TIP = ((-1.47, -1.53), 0.07)

# ── clip keyframes ───────────────────────────────────────────────────────
# Walk: classic contact/down/passing/up cycle (Rusty Animator / AnimSchool
# doctrine), 1.2 s loop, keys every 0.15 s, last key == first (seamless
# wrap — clip player loops in [from, to)). Angles in degrees about +X
# (positive swings the limb's -Y end forward, see meshlib conventions).
WALK_T = 1.2
WALK_THIGH = [27, 16, 3, -13, -27, -16, 7, 22, 27]     # left leg; right = +½ cycle
WALK_SHIN = [-6, -16, -8, 4, 14, 40, 34, 6, -6]        # + folds the reverse knee
WALK_FOOT_COMP = 0.75                                   # sole-leveling factor
WALK_FOOT_CLAMP = 25.0
WALK_BODY_Y = [0.0, -0.045, -0.008, 0.030, 0.0, -0.045, -0.008, 0.030, 0.0]
WALK_TORSO_YAW = [4, 2, 0, -2, -4, -2, 0, 2, 4]
WALK_GUN_PITCH = [-2, -1, 0, 1, 2, 1, 0, -1, -2]

IDLE_T = 3.6
IDLE_KEYS = [0.0, 0.9, 1.8, 2.7, 3.6]
IDLE_BODY_Y = [0.0, -0.012, -0.004, -0.012, 0.0]
IDLE_TORSO_YAW = [0, 9, 9, -7, 0]
IDLE_GUN_PITCH = [0, -3, -1, -3, 0]

DEATH_T = 1.8
DEATH_KEYS = [0.0, 0.3, 0.7, 1.2, 1.8]
DEATH_BODY = [(0, 0, 0), (0, -0.10, 0.04), (0, -0.45, 0.15),
              (0, -0.85, 0.30), (0, -0.90, 0.33)]
DEATH_TORSO_PITCH = [0, 6, 22, 42, 45]      # +x = lean back
DEATH_TORSO_YAW = [0, 3, 10, 16, 17]
DEATH_GUN = [0, -18, -30, -42, -45]
DEATH_THIGH_L = [0, -8, -35, -58, -60]      # legs slide forward under the fall
DEATH_THIGH_R = [0, -4, -22, -48, -50]
DEATH_SHIN_L = [0, 6, 45, 85, 88]           # heels tuck
DEATH_SHIN_R = [0, 2, 30, 70, 74]
