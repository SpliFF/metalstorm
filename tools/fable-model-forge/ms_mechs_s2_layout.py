"""ms_mechs_s2_layout — dimensions, atlas zones and clip keyframes for the
Metalstorm scale-2 LINE mech ("MW-5 Bulwark").

MANNED, upright TWO-LEGGED walker with a FORWARD-BENDING (anthropoid) knee,
a glazed armoured cockpit head and a medium autocannon on a big right-shoulder
hardpoint.  Deliberately the opposite silhouette to the s1 quadruped scout
(low/wide/4-legged/sensor head/chin gun) and to the s3 fable_mech
(reverse-joint chicken walker with a slim arm railgun).

Frame: RH, FORWARD is -Z, up +Y, left +X, ground plane Y=0, 1 unit = 1 m.
Rotation about +X: positive swings a limb's -Y (downward) end forward (-Z).

Rig (pivots ARE the joints, identity rest rotations everywhere):
  body (root, pelvis @ hip y = 2.62)
   |- turret  (torso yaw)              offset (0, 2.94, 0)
   |   |- barrel (shoulder autocannon) offset (-1.06, 1.62, 0.06)
   |   |   \- muzzle (empty)           offset (0, 0, -1.50)
   |   \- exhaust (empty, rear vents)  offset (0, 0.44, 0.82)
   |- thigh_l offset (+0.46, 2.62, 0) -> knee at thigh-local (0,-1.02,-0.28)
   |   \- shin_l  offset = KNEE       -> ankle at shin-local (0,-1.14,+0.28)
   |       \- foot_l offset = ANKLE   (sole at foot-local y = -0.46 -> ground)
   \- thigh_r / shin_r / foot_r (x-mirrored)

KNEE z is NEGATIVE = ahead of the hip; ANKLE z is POSITIVE = behind the knee.
That is a human/forward-folding knee, not fable_mech's reverse joint.
"""
import meshlib
meshlib.ATLAS = 1024

from meshlib import Zone

W = 1024

# ---- atlas zones (1024^2, v down) --------------------------------------
M_TORSO_FRONT = Zone((0,   0,   240, 208), ('x', 'y'), ((-1.10, 1.10), (1.25, -0.05)))
M_TORSO_SIDE  = Zone((240, 0,   480, 208), ('z', 'y'), ((-0.80, 0.75), (1.25, -0.05)))
M_TORSO_REAR  = Zone((480, 0,   720, 208), ('x', 'y'), ((1.10, -1.10), (1.25, -0.05)))
M_TORSO_TOP   = Zone((720, 0,   960, 208), ('x', 'z'), ((-1.10, 1.10), (-0.80, 1.15)))
M_DARK        = Zone((960, 0,  1024, 64),  ('x', 'z'), ((-1.0, 1.0), (-1.0, 1.0)))
M_ANTENNA     = (960, 64, 1024, 112)                       # limb wrap (rect)
M_HATCH       = Zone((960, 112, 1024, 208), ('x', 'z'), ((-0.30, 0.30), (-0.16, 0.36)))

M_PELVIS      = Zone((0,   208, 224, 360), ('z', 'y'), ((-0.42, 0.42), (3.06, 2.34)))
M_COCKPIT_F   = Zone((224, 208, 448, 360), ('x', 'y'), ((-0.48, 0.48), (1.58, 0.70)))
M_COCKPIT_S   = Zone((448, 208, 672, 360), ('z', 'y'), ((-1.06, -0.16), (1.58, 0.70)))
M_COCKPIT_T   = Zone((672, 208, 880, 360), ('x', 'z'), ((-0.48, 0.48), (-1.06, -0.16)))
M_JOINT_CAP   = Zone((880, 208, 944, 272), ('z', 'y'), ((-0.22, 0.22), (0.22, -0.22)))
M_STEP        = Zone((944, 208, 1024, 272), ('z', 'y'), ((-0.36, -0.04), (0.20, -0.04)))
M_BROW        = Zone((880, 272, 1024, 360), ('x', 'y'), ((-0.48, 0.48), (1.60, 1.36)))

M_THIGH       = (0,   360, 256, 456)                       # limb wrap (rect)
M_SHIN        = (256, 360, 512, 456)                       # limb wrap (rect)
M_JOINT       = (512, 360, 640, 424)                       # joint stub wrap
M_CHUTE       = (512, 424, 640, 472)                       # ammo belt wrap
M_FOOT_SIDE   = Zone((640, 360, 880, 456), ('z', 'y'), ((-0.60, 0.38), (0.14, -0.52)))
M_PAULDRON    = Zone((880, 360, 1024, 456), ('z', 'y'), ((-0.52, 0.52), (1.54, 1.00)))

M_FOOT_WRAP   = (0,   456, 256, 520)                       # arc-length wrap
M_GUN_WRAP    = (256, 456, 704, 552)                       # tube parametric
M_RECEIVER    = Zone((704, 456, 896, 552), ('z', 'y'), ((-0.32, 0.62), (0.24, -0.24)))
M_MUZZLE_CELL = Zone((896, 456, 1024, 552), ('x', 'y'), ((-0.18, 0.18), (0.18, -0.18)))

M_MAG         = Zone((0,   552, 224, 648), ('z', 'y'), ((0.00, 0.64), (0.26, -0.26)))
M_AMMO_BIN    = Zone((224, 552, 512, 648), ('x', 'y'), ((-0.44, 0.44), (1.12, 0.48)))
M_VENTS       = Zone((512, 552, 672, 648), ('x', 'y'), ((-0.40, 0.40), (0.66, 0.22)))

# ---- skeleton (offsets) ------------------------------------------------
TURRET_OFF  = (0.0, 2.94, 0.0)
BARREL_OFF  = (-1.06, 1.62, 0.06)        # turret-local, RIGHT shoulder (-X)
MUZZLE_OFF  = (0.0, 0.0, -1.50)          # barrel-local, pure translation
EXHAUST_OFF = (0.0, 0.44, 0.82)          # turret-local, rear vents
HIP_X, HIP_Y = 0.46, 2.62
KNEE  = (0.0, -1.02, -0.28)              # thigh-local: knee AHEAD of hip
ANKLE = (0.0, -1.14, 0.28)               # shin-local: ankle BEHIND knee

# ---- geometry constants ------------------------------------------------
PELVIS = (0.0, 2.70, 0.02, 0.92, 0.64, 0.72)          # x,y,z,w,h,d  (top 3.02)
PELVIS_SKIRT = (0.0, 2.36, -0.30, 0.78, 0.24, 0.18)   # front crotch plate

# torso loft: (z, yb, yw, ys, yd, wb, ww, wd, wt) turret-local
TORSO_SECTIONS = [
    (-0.70, 0.14, 0.42, 0.86, 1.14, 0.42, 0.62, 0.66, 0.46),
    (-0.28, 0.02, 0.36, 0.84, 1.20, 0.56, 0.86, 1.02, 0.72),
    (0.20,  0.00, 0.34, 0.82, 1.20, 0.58, 0.90, 1.05, 0.74),
    (0.66,  0.12, 0.40, 0.80, 1.10, 0.44, 0.66, 0.72, 0.50),
]
# cockpit head loft, same section format
HEAD_SECTIONS = [
    (-1.02, 1.00, 1.10, 1.26, 1.36, 0.17, 0.29, 0.31, 0.21),
    (-0.86, 0.86, 0.98, 1.34, 1.48, 0.29, 0.41, 0.43, 0.29),
    (-0.58, 0.78, 0.92, 1.36, 1.52, 0.35, 0.46, 0.46, 0.33),
    (-0.20, 0.76, 0.90, 1.34, 1.50, 0.35, 0.46, 0.46, 0.33),
]
BROW      = (0.0, 1.50, -0.92, 0.70, 0.10, 0.28)      # heavy eyebrow lip
HATCH     = (0.0, 1.22, 0.10, 0.52, 0.07, 0.44)       # torso roof hatch
AMMO_BIN  = (0.0, 0.80, 0.86, 0.80, 0.56, 0.46)       # backpack magazine bin
VENT_BOX  = (0.0, 0.44, 0.74, 0.70, 0.34, 0.18)       # rear exhaust vents
PAULDRON_R = (-1.06, 1.28, 0.0, 0.44, 0.44, 0.94)     # gun hardpoint block
PAULDRON_L = (1.10, 1.22, 0.0, 0.28, 0.36, 0.82)
STEP_BLOCK = (0.90, 0.10, -0.20, 0.28, 0.09, 0.30)    # crew step
RAIL_A = (0.99, 0.52, -0.34)                          # grab rail endpoints
RAIL_B = (0.99, 0.52, 0.10)
CHUTE_A = (0.10, 1.06, 0.78)                          # ammo belt: bin -> gun
CHUTE_B = (-0.74, 1.54, 0.32)
ANT_A = (0.62, 1.16, 0.60)
ANT_B = (0.68, 2.10, 0.64)                            # tip -> world y 5.04
SHOULDER_BOSS = (-0.90, 1.62, 0.06)

THIGH_R0, THIGH_R1 = 0.235, 0.175
SHIN_R0, SHIN_R1 = 0.185, 0.135
FOOT_PROFILE = [   # (z, y) ankle-local; heel BEHIND (+z), toe AHEAD (-z)
    (-0.54, -0.16), (-0.52, -0.40), (-0.44, -0.46), (0.24, -0.46),
    (0.32, -0.38), (0.32, -0.14), (0.20, 0.06), (-0.16, 0.10), (-0.34, 0.02),
]
FOOT_HALF_W = 0.17

GUN_RECEIVER = (0.0, 0.0, 0.16, 0.34, 0.40, 0.80)
GUN_MAG      = (0.26, 0.0, 0.32, 0.28, 0.46, 0.58)    # box magazine, inboard
GUN_TUBE = [(-0.16, 0.155), (-0.62, 0.145), (-0.66, 0.115), (-1.20, 0.11)]
GUN_BRAKE = (0.0, 0.0, -1.30, 0.30, 0.28, 0.22)       # muzzle brake
GUN_TIP = ((-1.41, -1.46), 0.085)

# ---- clip keyframes ----------------------------------------------------
# WALK — contact / down / passing / up doctrine, 1.2 s, keys every 12.5 %,
# last key == first (clip player loops in [from, to)).  Angles in degrees
# about +X; positive swings the limb's -Y end forward (-Z).
WALK_T = 1.2
WALK_THIGH = [27, 16, 3, -13, -27, -16, 7, 22, 27]
# FORWARD (human) knee: flexion moves the ankle REARWARD, i.e. NEGATIVE.
# i0 contact/heel-strike (near-extended), i1 down (weight accept, flex),
# i2 passing (light flex under body), i3 up (drive, extending), i4 toe-off,
# i5 early swing = MAX flexion (heel tucks toward the buttock), i6 mid swing,
# i7 late swing (extending to reach), i8 == i0.
WALK_SHIN = [-4, -18, -10, -3, -14, -55, -46, -16, -4]
WALK_FOOT_COMP = 0.75
WALK_FOOT_CLAMP = 25.0
WALK_BODY_Y = [0.0, -0.050, -0.012, 0.032, 0.0, -0.050, -0.012, 0.032, 0.0]
WALK_TORSO_YAW = [4, 2, 0, -2, -4, -2, 0, 2, 4]
WALK_GUN_PITCH = [-2, -1, 0, 1, 2, 1, 0, -1, -2]

# IDLE — a MANNED idle: the machine settling on its actuators.
IDLE_T = 3.6
IDLE_KEYS = [0.0, 0.9, 1.8, 2.7, 3.6]
IDLE_BODY_Y = [0.0, -0.028, -0.010, -0.024, 0.0]
IDLE_THIGH = [0, 2.5, 1.0, 2.0, 0]
IDLE_SHIN = [0, -5.0, -2.0, -4.2, 0]
IDLE_TORSO_YAW = [0, 5, 2, -4, 0]
IDLE_GUN_PITCH = [0, -5, -7, -3, 0]

# DEATH — backward sit-down collapse; EVERY channel commits one direction.
DEATH_T = 1.8
DEATH_KEYS = [0.0, 0.3, 0.7, 1.2, 1.8]
DEATH_BODY = [(0, 0, 0), (0, -0.14, 0.08), (0, -0.58, 0.28),
              (0, -1.06, 0.50), (0, -1.15, 0.55)]
DEATH_TORSO_PITCH = [0, 9, 30, 53, 58]      # +x = lean BACK
DEATH_TORSO_YAW = [0, 3, 9, 15, 16]
DEATH_GUN = [0, 6, 16, 26, 28]              # + = muzzle swings UP
DEATH_THIGH_L = [0, 12, 44, 79, 84]         # knees buckle up and forward
DEATH_THIGH_R = [0, 8, 36, 70, 76]
DEATH_SHIN_L = [0, -10, -40, -73, -78]      # forward knee folds NEGATIVE
DEATH_SHIN_R = [0, -7, -33, -66, -71]
