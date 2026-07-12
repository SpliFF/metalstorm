"""colossus_layout — zones + dims + animation tables for fable_colossus.

FW-15 "Fenrir": 15 m hunched bipedal war robot. Human-jointed legs
(knee forward), werewolf lope, flamethrower left arm, rotary cannon +
missile box right arm, back missile hump with exhaust stacks. Breakoff
pieces (pauldron_l, stack_r) detach during the death clip.

Atlas 2048² (texel parity with fable_tank/heavy). forward=-Z, up=+Y,
left=+X, ground Y=0, 1 unit = 1 m.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
# column A: torso / head / pack / shoulder / joints
C_TORSO_FRONT = Zone((0,    0,    512,  448),  ('x', 'y'), ((-2.35, 2.35), (4.05, -0.15)))
C_TORSO_SIDE  = Zone((512,  0,    1024, 448),  ('z', 'y'), ((-3.10, 2.20), (4.05, -0.15)))
C_TORSO_REAR  = Zone((0,    448,  448,  832),  ('x', 'y'), ((2.35, -2.35), (4.05, -0.15)))
C_TORSO_TOP   = Zone((448,  448,  896,  832),  ('x', 'z'), ((-2.35, 2.35), (-3.10, 2.20)))
C_PELVIS      = Zone((896,  448,  1024, 704),  ('x', 'y'), ((-1.70, 1.70), (8.75, 6.55)))
C_HEAD_TOP    = Zone((0,    832,  256,  1088), ('x', 'z'), ((-1.25, 1.25), (-1.95, 1.05)))
C_HEAD_SIDE   = Zone((256,  832,  512,  1088), ('z', 'y'), ((-1.95, 1.05), (1.45, -0.80)))
C_HEAD_FRONT  = Zone((0,    1088, 192,  1280), ('x', 'y'), ((-1.15, 1.15), (1.15, -0.80)))
C_PACK        = Zone((512,  832,  1024, 1216), ('x', 'y'), ((-2.15, 2.15), (1.25, -1.25)))
C_PACK_TOP    = Zone((512,  1216, 896,  1280), ('x', 'z'), ((-2.15, 2.15), (-1.2, 1.2)))
C_RACK        = Zone((0,    1280, 384,  1536), ('x', 'z'), ((-1.70, 1.70), (-1.10, 1.10)))
C_STACK       = (384, 1280, 640, 1408)   # parametric stack wrap
C_STACK_TOP   = Zone((640,  1280, 768,  1408), ('x', 'z'), ((-0.34, 0.34), (-0.34, 0.34)))
C_PAULDRON    = Zone((0,    1536, 448,  1856), ('x', 'z'), ((-1.10, 1.10), (-1.6, 1.6)))
C_PAULDRON_S  = Zone((448,  1856, 896,  1984), ('z', 'y'), ((-1.6, 1.6), (0.6, -0.6)))
C_VENT        = Zone((448,  1536, 704,  1728), ('z', 'y'), ((-0.58, 0.58), (0.45, -0.45)))
C_HOSE        = Zone((704,  1536, 896,  1728), ('z', 'y'), ((-0.5, 0.5), (0.45, -0.45)))
C_COLLAR      = Zone((0,    1856, 448,  1984), ('x', 'y'), ((-1.45, 1.45), (0.36, -0.36)))
C_JOINT       = (896, 1408, 1024, 1536)  # parametric joint-stub wrap
C_JOINT_CAP   = Zone((896,  1536, 1024, 1664), ('z', 'y'), ((-0.6, 0.6), (0.6, -0.6)))
C_PISTON      = (448, 1728, 704, 1856)   # chrome piston wrap
C_CLAW        = Zone((704,  1728, 896,  1856), ('x', 'y'), ((-0.6, 0.6), (-0.25, -1.45)))
C_HORN        = Zone((896,  1728, 1024, 1856), ('x', 'y'), ((-0.7, 0.7), (1.75, 0.15)))
C_DARK        = Zone((896,  1664, 1024, 1728), ('x', 'z'), ((-1, 1), (-1, 1)))

# column B: legs / arms / weapons
C_THIGH       = (1024, 0, 1408, 384)     # parametric limb wrap
C_SHIN        = (1408, 0, 1792, 384)
C_FOOT_SIDE   = Zone((1792, 0,    2048, 256),  ('z', 'y'), ((-2.15, 1.20), (-0.05, -1.40)))
C_FOOT_WRAP   = (1024, 384, 1536, 512)
C_SHINGUARD   = Zone((1536, 384,  1792, 576),  ('x', 'y'), ((-0.70, 0.70), (1.30, -1.30)))
C_ARM         = (1024, 512, 1408, 832)   # upper-arm limb wrap
C_RECEIVER    = Zone((1408, 576,  1792, 832),  ('z', 'y'), ((-2.60, 0.60), (0.80, -0.80)))
C_GUN_WRAP    = (1024, 832, 1536, 960)
C_MUZZLE_CELL = Zone((1536, 832,  1728, 1024), ('x', 'y'), ((-0.52, 0.52), (0.52, -0.52)))
C_MISSILE_BOX = Zone((1024, 960,  1408, 1152), ('x', 'z'), ((-0.78, 0.78), (-2.05, 0.15)))
C_FLAMER_WRAP = (1024, 1152, 1536, 1280)
C_NOZZLE      = (1536, 1152, 1728, 1280) # bell wrap
C_TANK        = (1728, 1152, 1984, 1280) # fuel tank wrap
C_TANK_CAP    = Zone((1728, 1024, 1856, 1152), ('x', 'z'), ((-0.4, 0.4), (-0.4, 0.4)))
C_KNUCKLE     = Zone((1856, 1024, 2048, 1152), ('x', 'y'), ((-0.85, 0.85), (0.60, -1.20)))
C_TRIM        = Zone((1792, 256,  2048, 384),  ('z', 'y'), ((-1.6, 1.6), (0.2, -0.2)))

# ── skeleton dims (world/parent-local metres) ────────────────────────────
HIP_X, HIP_Y = 1.30, 7.60
KNEE   = (0.0, -3.25, -0.50)      # thigh-local (human knee: slightly fwd)
ANKLE  = (0.0, -3.00, 0.72)       # shin-local (shin rakes back)
THIGH_R0, THIGH_R1 = 0.95, 0.76
SHIN_R0, SHIN_R1 = 0.84, 0.60
FOOT_HALF_W = 0.95
FOOT_PROFILE = [   # local (z, y): foot base, ends at the toe joint (ball)
    (-1.10, -1.33), (0.95, -1.33), (1.10, -0.84),
    (0.55, -0.34), (-0.55, -0.09), (-1.10, -0.62),
]
TOE_OFF = (0.0, -0.95, -1.05)      # toe piece pivot (ball of foot)
TOE_PROFILE = [                     # toe-local wedge
    (0.10, -0.38), (-0.72, -0.38), (-0.98, -0.16), (-0.10, 0.14),
]
PELVIS = (0.0, 7.75, 0.05, 3.2, 1.7, 2.6)   # x,y,z,w,h,d

TURRET_OFF  = (0.0, 8.55, 0.20)   # torso pivot (spine base)
# torso Y-loft sections (turret-local): (y, z_center, half_w, half_d)
TORSO_SECTIONS = [
    (-0.10, 0.10, 1.55, 1.30),
    (0.90,  -0.05, 1.75, 1.50),
    (2.00, -0.75, 2.05, 1.70),
    (3.00, -1.40, 2.25, 1.80),
    (3.90, -1.80, 2.05, 1.50),
]
HEAD_OFF    = (0.0, 2.90, -3.70)  # parent turret: juts forward, below hump
ARM_R_OFF   = (-2.95, 3.30, -1.25)
ARM_L_OFF   = (2.95, 3.30, -1.25)
ELBOW       = (0.0, -2.70, -0.60)  # arm-local
BARREL_OFF  = ELBOW                # right forearm = 'barrel'
MUZZLE_OFF  = (0.0, -0.18, -4.00)  # barrel-local (cannon tip)
FLAMER_OFF  = ELBOW
MUZZLE2_OFF = (0.0, -0.12, -3.70)  # flamer-local (nozzle tip)
ARM_R0, ARM_R1 = 0.74, 0.62
PACK_OFF    = (0.0, 3.55, 1.30)   # parent turret
PAULDRON_L_OFF = (3.25, 3.70, -1.20)   # BREAKOFF piece
STACK_R_OFF = (-1.05, 0.95, 0.55)      # parent pack; BREAKOFF piece
EXHAUST_OFF = (0.0, 3.10, 2.10)

# greebles
HEAD_SNOUT = [   # z-loft sections head-local: (z, y_bot, y_top, half_w)
    (0.95, -0.62, 0.92, 1.15),
    (-0.25, -0.66, 1.02, 1.06),
    (-1.20, -0.46, 0.62, 0.82),
    (-1.80, -0.26, 0.34, 0.60),
]
BROW = (0.0, 0.98, -0.85, 2.4, 0.42, 1.35)      # head-local x,y,z,w,h,d
CHEEKS = [(1.05, -0.10, -0.55), (-1.05, -0.10, -0.55)]
CHEEK_SIZE = (0.32, 0.72, 1.25)
COLLAR = (0.0, 3.00, -2.30, 2.8, 0.65, 1.3)    # turret-local neck guard
PAULDRON_R = (-3.25, 3.70, -1.20)              # turret-local (fixed side)
PAULDRON_SIZE = (2.1, 0.7, 3.1)
PAULDRON_HORN = (0.60, 0.80, -1.00)            # pauldron-local horn wedge
CHEST_PLATE = (0.0, 1.95, -2.55, 3.0, 1.9, 0.6)  # turret-local sloped plate
SPINE_PIPES = [(0.65, 'l'), (-0.65, 'r')]      # x offsets, torso rear pipes
PACK_SIZE   = (4.1, 2.2, 2.2)
RACK        = (0.0, 1.20, -0.35, 3.2, 0.55, 2.0)  # pack-local VLS deck
STACK_L_OFF = (1.15, 0.95, 0.55)               # fixed stack, pack-local
STACK_R, STACK_H = 0.34, 1.90
GUN_RECEIVER = (0.0, 0.05, -1.0, 1.45, 1.45, 3.0)  # barrel-local
GUN_TUBE = [(-2.3, 0.45), (-3.6, 0.45), (-3.6, 0.34), (-3.85, 0.34)]
GUN_TIP  = ((-3.85, -4.05), 0.40)
MISSILE_BOX = (0.0, 0.98, -0.95, 1.45, 0.62, 2.1)  # atop right forearm
KNUCKLE = (0.0, -0.92, -1.65, 1.3, 0.42, 1.3)
FLAME_RECEIVER = (0.0, 0.05, -1.0, 1.35, 1.35, 2.9)
FLAME_TUBE = [(-2.3, 0.34), (-3.3, 0.34), (-3.3, 0.26), (-3.5, 0.26)]
NOZZLE = [(-3.45, 0.26), (-3.72, 0.46), (-3.80, 0.48)]  # flaring bell
TANKS = [(0.52, 0.92, 0.1), (-0.52, 0.92, 0.1)]  # flamer-local fuel drums
TANK_R, TANK_LEN = 0.36, 2.0
SHIELD = (0.0, -0.20, -1.55, 1.55, 1.5, 0.34)  # flamer knuckle shield
SHINGUARD = (0.0, -1.55, -0.95, 1.35, 2.4, 0.45)  # shin-local plate
CLAWS = [(-0.55, 0.0), (0.0, -0.10), (0.55, 0.0)]  # toe claws (x, dz)
CLAW_SIZE = (0.42, 0.5, 0.95)

# ── animation tables ─────────────────────────────────────────────────────
# WALK: 17 keys (every 6.25%) so timing asymmetry lives in the VALUES
# while the key grid stays uniform (right leg = index shift by 8 = half
# period). Slow deliberate lift (k9-k12 barely move), fast heavy descent
# (k13-k16 big deltas), then a loading dip + rebound right after each
# contact (k0-k2 / k8-k10 on the other side) — the machine visibly
# compresses under its own weight at every footfall.
WALK_T = 2.3
WALK_THIGH = [26, 25, 23, 18, 11, 3, -6, -16, -26, -24, -18, -8, 2, 9, 15, 21,
              26]
WALK_SHIN = [-6, -19, -13, -8, -7, -8, -14, -26, -38, -50, -58, -56, -50, -40,
             -27, -13, -6]
WALK_FOOT_ADD = [8, 0, -1, 0, -2, -8, -14, -30, -24, -8, 0, 0, 0, 0, 2, 6, 8]
WALK_FOOT_COMP, WALK_FOOT_CLAMP = 0.75, 26.0
WALK_TOE = [0, 2, 0, 2, 5, 14, 24, 34, 28, 10, 4, 2, 0, 0, 0, 0, 0]
WALK_BODY_X = [0.05, 0.16, 0.24, 0.30, 0.32, 0.28, 0.20, 0.10, -0.05, -0.16,
               -0.24, -0.30, -0.32, -0.28, -0.20, -0.10, 0.05]
# extra load-dip after each contact, added on top of the FK ground solve
WALK_BODY_Y_EXTRA = [0.0, -0.14, 0.03, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -0.14,
                     0.03, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
# filled by solve_ground.py (per-key FK: lowest stance corner at ground)
WALK_BODY_Y = [-0.323, -0.593, -0.34, -0.214, -0.097, 0.187, 0.182, -0.192, -0.323, -0.593, -0.34, -0.214, -0.097, 0.187, 0.182, -0.192, -0.323]
WALK_PELVIS_YAW = [5, 4.7, 4.2, 3.2, 1.8, 0, -1.8, -3.5, -5, -4.7, -4.2, -3.2,
                   -1.8, 0, 1.8, 3.5, 5]
WALK_PELVIS_ROLL = [0, 4.5, 3.0, 3.8, 3.5, 3.0, 2.2, 1.2, 0, -4.5, -3.0, -3.8,
                    -3.5, -3.0, -2.2, -1.2, 0]
WALK_TORSO_YAW = [-9, -8.5, -7.5, -5.5, -3, 0, 3, 6, 9, 8.5, 7.5, 5.5, 3, 0,
                  -3, -6, -9]
WALK_TORSO_PITCH = [-2, -7, -1, -2.5, -3, -2.5, -2, -2.5, -2, -7, -1, -2.5,
                    -3, -2.5, -2, -2.5, -2]
WALK_HEAD_YAW = [4, 3.8, 3.3, 2.4, 1.3, 0, -1.3, -2.6, -4, -3.8, -3.3, -2.4,
                 -1.3, 0, 1.3, 2.6, 4]
WALK_HEAD_PITCH = [0, -6, 1, -1, -1.5, -1, -0.5, -1, 0, -6, 1, -1, -1.5, -1,
                   -0.5, -1, 0]
WALK_ARM = [16, 15.5, 14, 11, 7, 2, -4, -10, -16, -15.5, -14, -11, -7, -2, 4,
            10, 16]
WALK_FOREARM = [3, 10, 2, 4, 3, 2, 1, 0, -3, -10, -2, -4, -3, -2, -1, 0, 3]

IDLE_KEYS = [0.0, 0.8, 1.6, 2.4, 3.2, 4.0]
IDLE_BODY_Y   = [0.0, -0.07, -0.02, -0.08, -0.03, 0.0]
IDLE_TORSO_YAW = [0, -7, -3, 6, 3, 0]
IDLE_HEAD_YAW  = [0, -15, -6, 13, 5, 0]
IDLE_ARM       = [0, 2, 1, -2, -1, 0]

# DEATH: stagger back (+pitch = backward), buckle to a knees-down kneel
# (shins folded flat, toes tucked), held beat, then a forward topple
# (NEGATIVE body pitch) pivoting at the knees; chest slams, arms end
# pinned alongside the wreck. Body Y comes from solve_death.py.
DEATH_KEYS = [0.0, 0.30, 0.60, 0.85, 1.05, 1.35, 1.70, 2.05, 2.45, 2.75, 3.10]
DEATH_BODY = [  # (x, y, z) — y from solve_death.py (contact-exact)
    (0.00, 0.09, 0.00), (0.05, 0.06, 0.25), (0.02, -0.43, 0.15),
    (-0.04, -1.49, 0.00), (0.00, -2.10, -0.10), (0.03, -1.92, -0.12),
    (0.00, -1.63, -0.30), (0.00, -0.25, -1.00), (0.00, 1.41, -1.70),
    (0.00, 0.76, -1.65), (0.00, 0.87, -1.65),
]
DEATH_BODY_PITCH = [0, 8, -5, -10, -15, -12, -22, -45, -62, -58, -60]
DEATH_BODY_YAW   = [0, 2, 3, 2, 0, -2, -3, -4, -6, -6, -6]
DEATH_THIGH  = [0, -4, 4, 10, 15, 13, 18, 15, 12, 12, 12]
DEATH_SHIN   = [-6, -10, -45, -66, -78, -75, -72, -48, -28, -30, -29]
DEATH_FOOT   = [0, 2, -18, -14, -11, -10, -10, -12, -9, -9, -9]
DEATH_TOE    = [0, 0, 16, 28, 31, 30, 29, 22, 6, 6, 6]
DEATH_TORSO_PITCH = [-2, 10, -8, -12, -20, -14, -18, -14, -6, -4, -5]
DEATH_TORSO_YAW   = [0, 4, 6, 3, -2, -4, -6, -8, -10, -10, -10]
DEATH_HEAD_PITCH  = [0, 12, -10, -14, -20, -10, -14, -18, -24, -22, -23]
DEATH_HEAD_YAW    = [0, 5, 8, 4, 0, 6, 4, -6, -10, -12, -12]
DEATH_ARM   = [0, -20, 5, 10, 18, 10, 15, 40, 30, 28, 28]
DEATH_FOREARM = [0, -15, -5, 5, 8, 6, -10, -20, -15, -13, -13]
# breakoff flights (node-local absolute translations; rest until launch)
PAULDRON_FLY = {   # launches at knee impact (k4)
    'launch': 4,
    'path': [(3.35, 4.60, -1.30), (4.30, 4.30, -1.80), (5.10, 1.10, -2.40),
             (5.30, 0.35, -2.55), (5.30, 0.30, -2.55), (5.30, 0.30, -2.55),
             (5.30, 0.30, -2.55)],
    'spin': [0, -35, -95, -150, -170, -170, -170],
}
STACK_FLY = {      # launches at chest slam (k8)
    'launch': 8,
    'path': [(-1.60, 1.75, -0.45), (-2.30, 1.20, -1.60), (-2.60, 0.30, -2.10)],
    'spin': [0, -70, -150],
}
