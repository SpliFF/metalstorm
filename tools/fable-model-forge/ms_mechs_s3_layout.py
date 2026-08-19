"""ms_mechs_s3_layout — dimensions, atlas zones and clip keyframes for the
Metalstorm scale-3 mech: HW-9 "Warden", a MANNED heavy assault walker.

REVERSE-JOINT (chicken-walker) biped: knee BEHIND the hip, ankle forward —
the opposite leg grammar to the s2 forward-knee anthropoid and the s1
quadruped. NO glazed canopy anywhere: the head is a heavy ARMOURED casemate
slab with a painted vision slit and a sensor block. Slot 1 is a right-arm
heavy autocannon (turret/barrel/muzzle); slot 2 is an AA missile rack on a
LOW REAR PELVIS PEDESTAL (turret2 chain parented to body, below the torso's
yaw arc so the swinging torso clears it).

Frame: RH, FORWARD is -Z, up +Y, left +X, ground plane Y = 0, 1 unit = 1 m.
Height: 7.50 m to the casemate roof (antenna excluded, tip ~7.97).

Rig (pivots ARE the joints, identity rest rotations everywhere):
  body (root, pelvis @ hip y = 3.90)
   |- turret  (torso yaw)               offset (0, 4.42, 0)
   |   |- barrel (right-arm autocannon) offset (-1.42, 1.85, 0.10)
   |   |   \- muzzle (empty)            offset (0, 0, -2.60)
   |   \- exhaust (empty, rear vents)   offset (0, 1.05, 1.25)
   |- turret2 (AA pod yaw drum)         offset (0, 3.80, 1.32)
   |   \- turret2_barrel (missile rack) offset (0, 0.32, 0)
   |       \- turret2_muzzle (empty)    offset (0, 0.05, -0.75)
   |- thigh_l offset (+1.00, 3.90, 0) -> knee thigh-local (0,-1.70,+0.80)
   |   \- shin_l  offset = KNEE       -> ankle shin-local (0,-1.66,-1.10)
   |       \- foot_l offset = ANKLE   (sole at foot-local y = -0.54)
   \- thigh_r / shin_r / foot_r (x-mirrored)

KNEE z is POSITIVE = BEHIND the hip; ANKLE z is NEGATIVE = ahead of the
knee. That is fable_mech's reverse joint, scaled way up — NOT s2's layout.
"""
import meshlib
meshlib.ATLAS = 1024

from meshlib import Zone

W = 1024


def mir(z):
    """Mirrored twin of a planar zone (u-window reversed) so the far side of
    a two-sided projection samples the same pixels un-mirrored."""
    (a0, a1), b = z.win
    return Zone(z.rect, z.axes, ((a1, a0), b))


# ---- atlas zones (1024^2, v down) --------------------------------------
# torso loft, turret-local
M_TORSO_FRONT = Zone((0,   0, 250, 210), ('x', 'y'), ((-1.35, 1.35), (2.40, -0.15)))
M_TORSO_SIDE  = Zone((250, 0, 500, 210), ('z', 'y'), ((-1.20, 1.00), (2.40, -0.15)))
M_TORSO_REAR  = Zone((500, 0, 750, 210), ('x', 'y'), ((1.35, -1.35), (2.40, -0.15)))
M_TORSO_TOP   = Zone((750, 0, 1000, 210), ('x', 'z'), ((-1.35, 1.35), (-1.20, 1.00)))
M_DARK        = Zone((1000, 0, 1024, 64), ('x', 'z'), ((-1.0, 1.0), (-1.0, 1.0)))

M_PELVIS  = Zone((0,   210, 220, 330), ('z', 'y'), ((-0.85, 1.05), (4.45, 3.45)))
H_FRONT   = Zone((220, 210, 420, 330), ('x', 'y'), ((-0.72, 0.72), (3.12, 2.18)))
H_SIDE    = Zone((420, 210, 620, 330), ('z', 'y'), ((-1.50, 0.10), (3.12, 2.18)))
H_TOP     = Zone((620, 210, 800, 330), ('x', 'z'), ((-0.72, 0.72), (-1.40, 0.10)))
H_REAR    = Zone((800, 210, 960, 330), ('x', 'y'), ((0.72, -0.72), (3.12, 2.18)))
M_SENSOR  = Zone((960, 210, 1024, 274), ('x', 'y'), ((-0.30, 0.30), (2.55, 2.20)))
M_BROW    = Zone((960, 274, 1024, 330), ('x', 'y'), ((-0.60, 0.60), (2.95, 2.78)))

M_THIGH     = (0,   330, 240, 430)                    # limb wrap (rect)
M_SHIN      = (240, 330, 480, 430)                    # limb wrap (rect)
M_JOINT     = (480, 330, 600, 394)                    # joint stub wrap
M_JOINT_CAP = Zone((600, 330, 664, 394), ('z', 'y'), ((-0.30, 0.30), (0.30, -0.30)))
M_PAULDRON  = Zone((664, 330, 860, 430), ('z', 'y'), ((-0.62, 0.62), (2.22, 1.48)))
M_ROOF      = Zone((860, 330, 1000, 430), ('x', 'z'), ((-0.56, 0.56), (-1.30, -0.14)))

M_FOOT_SIDE   = Zone((0, 430, 260, 540), ('z', 'y'), ((-1.30, 1.10), (0.18, -0.56)))
M_FOOT_WRAP   = (260, 430, 500, 494)                  # arc-length wrap
M_POD_T       = Zone((260, 494, 500, 540), ('x', 'z'), ((-0.48, 0.48), (-0.52, 0.36)))
M_GUN_WRAP    = (500, 430, 840, 530)                  # tube parametric
M_MUZZLE_CELL = Zone((840, 430, 940, 530), ('x', 'y'), ((-0.24, 0.24), (0.24, -0.24)))
M_ANTENNA     = (940, 430, 1024, 478)                 # limb wrap (rect)

M_RECEIVER   = Zone((0, 540, 210, 660), ('z', 'y'), ((-0.40, 0.90), (0.34, -0.32)))
M_RECEIVER_M = mir(M_RECEIVER)
M_MAG   = Zone((210, 540, 400, 660), ('z', 'y'), ((0.02, 0.82), (-0.08, -0.80)))
M_POD   = Zone((400, 540, 600, 660), ('z', 'y'), ((-0.50, 0.34), (0.18, -0.18)))
M_POD_M = mir(M_POD)
M_POD_F = Zone((600, 540, 740, 660), ('x', 'y'), ((-0.48, 0.48), (0.18, -0.18)))
M_PED   = Zone((740, 540, 880, 660), ('z', 'y'), ((0.72, 1.62), (3.84, 3.28)))
M_DRUM  = Zone((880, 540, 1000, 620), ('x', 'z'), ((-0.32, 0.32), (-0.32, 0.32)))
M_TIP   = Zone((880, 620, 1000, 656), ('x', 'y'), ((-0.08, 0.08), (0.08, -0.08)))

M_CHUTE          = (0, 660, 140, 708)                 # ammo belt wrap
M_SHINPLATE      = Zone((140, 660, 340, 790), ('z', 'y'),
                        ((-1.55, -0.05), (0.45, -1.60)))
M_SHINPLATE_WRAP = (340, 660, 540, 724)
M_AMMO_BIN = Zone((540, 660, 800, 790), ('x', 'y'), ((-0.55, 0.55), (2.25, 1.30)))
M_VENTS    = Zone((800, 660, 1000, 770), ('x', 'y'), ((-0.48, 0.48), (1.42, 0.72)))

M_HATCH  = Zone((0, 790, 140, 890), ('x', 'z'), ((-0.34, 0.34), (0.16, 0.78)))
M_TOE    = Zone((140, 790, 260, 890), ('z', 'y'), ((-1.26, -0.70), (-0.16, -0.56)))
M_PISTON = (260, 790, 420, 842)                       # hip actuator wrap

# ---- skeleton (offsets) ------------------------------------------------
TURRET_OFF    = (0.0, 4.42, 0.0)
BARREL_OFF    = (-1.42, 1.85, 0.10)      # turret-local, RIGHT shoulder (-X)
MUZZLE_OFF    = (0.0, 0.0, -2.60)        # barrel-local, pure translation
EXHAUST_OFF   = (0.0, 1.05, 1.25)        # turret-local, rear vents
TURRET2_OFF   = (0.0, 3.80, 1.32)        # body-local, rear pelvis pedestal
T2_BARREL_OFF = (0.0, 0.32, 0.0)         # turret2-local, rack pivot
T2_MUZZLE_OFF = (0.0, 0.05, -0.75)       # rack-local, pure translation
HIP_X, HIP_Y = 1.00, 3.90
KNEE  = (0.0, -1.70, 0.80)               # thigh-local: knee BEHIND hip
ANKLE = (0.0, -1.66, -1.10)              # shin-local: ankle AHEAD of knee

# ---- geometry constants ------------------------------------------------
PELVIS       = (0.0, 4.00, 0.0, 1.55, 0.85, 1.30)     # x,y,z,w,h,d
PELVIS_SKIRT = (0.0, 3.72, -0.72, 1.05, 0.52, 0.26)   # front crotch plate
SHELF        = (0.0, 3.55, 1.18, 0.95, 0.50, 0.85)    # rear pod pedestal
HIP_STUB_X, HIP_STUB_R, HIP_STUB_HW = 0.85, 0.42, 0.14

# torso loft: (z, yb, yw, ys, yd, wb, ww, wd, wt) turret-local
TORSO_SECTIONS = [
    (-1.15, 0.30, 0.75, 1.55, 2.05, 0.55, 0.85, 0.95, 0.65),
    (-0.45, 0.02, 0.55, 1.50, 2.28, 0.80, 1.15, 1.30, 0.95),
    (0.30, -0.08, 0.50, 1.45, 2.30, 0.82, 1.18, 1.32, 0.98),
    (0.95, 0.15, 0.60, 1.35, 2.05, 0.55, 0.85, 0.95, 0.62),
]
# armoured casemate head — chamfer boxes, NO glazing
HEAD_MAIN = (0.0, 2.60, -0.62, 1.35, 0.72, 1.30)      # roof of loft y 2.30
HEAD_ROOF = (0.0, 3.01, -0.72, 1.05, 0.14, 1.10)      # top = 3.08 -> world 7.50
BROW      = (0.0, 2.86, -1.33, 1.15, 0.12, 0.22)      # lip over the slit
SENSOR    = (0.0, 2.38, -1.33, 0.50, 0.24, 0.20)      # chin sensor block
HATCH     = (0.0, 2.36, 0.45, 0.62, 0.10, 0.55)       # crew hatch, rear deck
AMMO_BIN  = (0.0, 1.78, 1.18, 1.00, 0.80, 0.55)       # backpack magazine bin
VENT_BOX  = (0.0, 1.02, 1.10, 0.85, 0.55, 0.30)       # rear exhaust vents
PAULDRON_R = (-1.42, 1.85, 0.0, 0.55, 0.65, 1.15)     # gun-side shoulder
PAULDRON_L = (1.42, 1.85, 0.0, 0.55, 0.65, 1.15)
SHOULDER_BOSS = (-1.20, 1.85, 0.10)
ANT_A = (0.78, 2.28, 0.70)
ANT_B = (0.90, 3.55, 0.82)                            # tip -> world y 7.97
CHUTE_A = (-0.45, 1.90, 1.05)                         # ammo belt: bin -> gun
CHUTE_B = (-1.30, 1.95, 0.40)

THIGH_R0, THIGH_R1 = 0.44, 0.34
SHIN_R0, SHIN_R1 = 0.30, 0.23
STUB_HIP = (0.40, 0.22)
STUB_KNEE = (0.34, 0.20)
STUB_ANKLE = (0.26, 0.16)
PISTON_A = (0.0, -0.08, -0.50)                        # exposed hip actuator
PISTON_B = (0.0, -1.20, 0.25)
PISTON_R0, PISTON_R1 = 0.10, 0.08
# armoured shin plate, extruded band ahead of the shin strut (shin-local z,y)
SHINPLATE_PROFILE = [
    (-0.36, 0.30), (-0.62, 0.10), (-1.34, -1.10), (-1.50, -1.42),
    (-1.22, -1.52), (-0.98, -1.10), (-0.30, 0.00), (-0.10, 0.32),
]
SHINPLATE_HALF_W = 0.36

FOOT_PROFILE = [   # (z, y) ankle-local; toe AHEAD (-z), heel BEHIND (+z)
    (-0.85, -0.20), (-0.82, -0.44), (-0.72, -0.54), (0.60, -0.54),
    (0.72, -0.42), (0.74, -0.16), (0.48, 0.06), (-0.05, 0.14), (-0.55, 0.02),
]
FOOT_HALF_W = 0.52
TOE_BOX  = (0.27, -0.36, -0.98, 0.30, 0.36, 0.52)     # +-x pair, splayed toes
HEEL_BOX = (0.0, -0.32, 0.85, 0.44, 0.40, 0.40)       # rear spur

GUN_STUB = ((0.12, 0.0, 0.05), 0.30, 0.18)
GUN_RECEIVER = (0.0, 0.02, 0.28, 0.52, 0.55, 1.15)
GUN_MAG  = (0.30, -0.44, 0.42, 0.42, 0.64, 0.75)      # big box magazine
GUN_TUBE = [(-0.55, 0.20), (-1.35, 0.185), (-1.45, 0.15), (-2.10, 0.145)]
GUN_BRAKE = (0.0, 0.0, -2.26, 0.44, 0.40, 0.36)       # muzzle brake
GUN_TIP = ((-2.44, -2.58), 0.12)

DRUM = (0.0, 0.11, 0.0, 0.60, 0.22, 0.60)             # turret2 yaw drum
RACK = (0.0, 0.0, -0.08, 0.90, 0.30, 0.78)            # turret2_barrel box
TIP_XS = (-0.20, 0.20)                                # missile tip stubs
TIP_YS = (-0.075, 0.075)
TIP_BOX = (0.14, 0.14, 0.20)                          # size; center z -0.53
TIP_Z = -0.53

# ---- clip keyframes ----------------------------------------------------
# WALK — contact/down/passing/up doctrine, 1.2 s, keys every 12.5 %, last
# key == first. REVERSE joint: the shin's POSITIVE fold during recovery
# (fable_mech's sign convention) gives the knee-back silhouette. Heavier,
# wider gait than s2: modest bob (mass), same 1.2 s military cadence.
WALK_T = 1.2
WALK_THIGH = [22, 13, 2, -11, -22, -13, 5, 17, 22]
WALK_SHIN  = [-5, -14, -7, 4, 12, 34, 28, 5, -5]
WALK_FOOT_COMP = 0.75
WALK_FOOT_CLAMP = 25.0
WALK_BODY_Y = [0.0, -0.060, -0.015, 0.030, 0.0, -0.060, -0.015, 0.030, 0.0]
WALK_TORSO_YAW = [4, 2, 0, -2, -4, -2, 0, 2, 4]
WALK_GUN_PITCH = [-2, -1, 0, 1, 2, 1, 0, -1, -2]

# IDLE — a MANNED gun platform settling on its actuators: breathing bob and
# a slow torso scan, plus a lazy AA-pod sweep. No sensor-head theatrics.
IDLE_T = 3.6
IDLE_KEYS = [0.0, 0.9, 1.8, 2.7, 3.6]
IDLE_BODY_Y = [0.0, -0.030, -0.012, -0.026, 0.0]
IDLE_TORSO_YAW = [0, 4, 1, -3, 0]
IDLE_GUN_PITCH = [0, -3, -5, -2, 0]
IDLE_THIGH = [0, 2.0, 0.8, 1.6, 0]
IDLE_SHIN  = [0, 3.5, 1.4, 3.0, 0]        # reverse knee settles POSITIVE
IDLE_POD_YAW = [0, -6, -2, 5, 0]

# DEATH — forward knee-drop collapse; EVERY channel commits forward+down.
DEATH_T = 1.8
DEATH_KEYS = [0.0, 0.3, 0.7, 1.2, 1.8]
DEATH_BODY = [(0, 0, 0), (0, -0.20, -0.05), (0, -0.85, -0.20),
              (0, -1.70, -0.40), (0, -1.90, -0.46)]
DEATH_TORSO_PITCH = [0, -7, -22, -40, -46]    # -x = slump FORWARD
DEATH_TORSO_YAW = [0, -2, -6, -11, -12]
DEATH_GUN = [0, -4, -12, -20, -22]            # muzzle droops to the dirt
DEATH_THIGH_L = [0, 8, 22, 36, 40]            # legs sprawl forward
DEATH_THIGH_R = [0, 6, 18, 31, 35]
DEATH_SHIN_L = [0, 6, 17, 27, 30]             # reverse knee folds POSITIVE
DEATH_SHIN_R = [0, 4, 13, 23, 26]
DEATH_POD_YAW = [0, -4, -10, -16, -17]
DEATH_POD_PITCH = [0, -3, -8, -14, -15]
