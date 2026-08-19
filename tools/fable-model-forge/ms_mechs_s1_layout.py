"""ms_mechs_s1_layout — dimensions, atlas zones and clip keyframes for the
Metalstorm scale-1 mech: RW-1 "Tick", an UNMANNED four-legged recon walker.

Low-slung QUADRUPED, reverse-jointed (knees fold backward), faceted SENSOR
head (no cockpit, no glazing anywhere), chin/under-slung medium MG.
Overall standing height 3.00 m (mast tip); stance ~2.8 m wide.

Frame: forward −Z, up +Y, left +X, ground plane Y = 0, 1 unit = 1 m.

Rig (17 pieces; pivots ARE the joints, rest rotations identity):
  body (root, chassis)
   ├─ turret  (sensor head, yaw)      offset (0, 1.40, −0.62)
   │   ├─ barrel (chin MG, pitch)     offset (0, −0.34, −0.30)
   │   │   └─ muzzle (EMPTY)          offset (0, 0, −0.84)
   │   └─ exhaust (EMPTY, head vents) offset (0, −0.14, 0.44)
   ├─ thigh_fl → shin_fl → foot_fl    hip (+0.92, 1.05, −0.40)
   ├─ thigh_fr → shin_fr → foot_fr    hip (−0.92, 1.05, −0.40)
   ├─ thigh_rl → shin_rl → foot_rl    hip (+0.92, 1.05, +0.95)
   └─ thigh_rr → shin_rr → foot_rr    hip (−0.92, 1.05, +0.95)
"""
import meshlib
meshlib.ATLAS = 1024

from meshlib import Zone  # noqa: E402

# ── atlas zones (1024², v down) ──────────────────────────────────────────
# body frame == world frame (body offset is the origin)
B_TOP     = Zone((0,   0,   320, 192), ('x', 'z'), ((-0.95, 0.95), (-0.62, 1.28)))
B_SIDE    = Zone((320, 0,   600, 192), ('z', 'y'), ((-0.70, 1.32), (1.56, 0.88)))
B_FRONT   = Zone((600, 0,   800, 192), ('x', 'y'), ((-1.00, 1.00), (1.56, 0.88)))
B_REAR    = Zone((800, 0,  1000, 192), ('x', 'y'), ((1.00, -1.00), (1.56, 0.88)))

B_SPONSON = Zone((0,   192, 200, 320), ('z', 'y'), ((-0.65, 1.20), (1.28, 0.84)))
# turret-local frame
H_MAIN    = Zone((200, 192, 440, 352), ('x', 'y'), ((-0.52, 0.52), (0.72, -0.08)))
H_TOP     = Zone((440, 192, 640, 320), ('x', 'z'), ((-0.46, 0.46), (-0.62, 0.40)))
H_LENS    = Zone((640, 192, 768, 320), ('x', 'y'), ((-0.38, 0.38), (0.48, 0.10)))
H_SIDE    = Zone((0,   640, 224, 800), ('z', 'y'), ((-0.62, 0.40), (0.72, -0.08)))
H_PANEL   = Zone((768, 192, 928, 320), ('x', 'z'), ((-0.36, 0.36), (-0.26, 0.30)))
B_DARK    = Zone((928, 192,1024, 288), ('x', 'z'), ((-0.5, 0.5), (-0.5, 0.5)))

M_THIGH     = (0,   352, 224, 432)          # limb wrap (parametric)
M_SHIN      = (0,   432, 224, 512)          # limb wrap
M_JOINT     = (224, 352, 352, 416)          # joint stub wrap
M_JOINT_CAP = Zone((352, 352, 416, 416), ('z', 'y'), ((-0.20, 0.20), (0.20, -0.20)))
MAST        = (416, 352, 608, 416)          # mast/comms-blade wrap
M_FOOT_SIDE = Zone((608, 352, 800, 432), ('z', 'y'), ((-0.50, 0.30), (0.12, -0.24)))
M_FOOT_WRAP = (800, 352,1000, 416)          # arc-length wrap

# barrel-local frame
G_BODY   = Zone((0,   512, 256, 640), ('z', 'y'), ((-0.46, 0.42), (0.22, -0.26)))
G_WRAP   = (256, 512, 608, 608)             # MG tube parametric
G_TIP    = Zone((608, 512, 720, 608), ('x', 'y'), ((-0.10, 0.10), (0.10, -0.10)))
H_VENT   = Zone((720, 512, 880, 608), ('x', 'y'), ((-0.42, 0.42), (0.18, -0.06)))

# ── skeleton (parent-relative offsets) ───────────────────────────────────
TURRET_OFF  = (0.0, 1.40, -0.62)
BARREL_OFF  = (0.0, -0.34, -0.30)      # turret-local: below AND forward
MUZZLE_OFF  = (0.0, 0.0, -0.84)        # barrel-local, pure translation
EXHAUST_OFF = (0.0, -0.14, 0.44)       # turret-local, rear louvres

HIP_X  = 0.92
HIP_Y  = 1.05
HIP_ZF = -0.40                          # front hips
HIP_ZR = 0.95                           # rear hips
# thigh-local: knee sits BACK (+z, reverse joint) and OUTBOARD (+x, splay)
KNEE  = (0.18, -0.44, 0.26)
# shin-local: ankle down-forward, further outboard
ANKLE = (0.12, -0.42, -0.30)

# ── geometry constants ───────────────────────────────────────────────────
HULL    = (0.0, 1.19, 0.325, 1.44, 0.46, 1.85)   # x,y,z,w,h,d
STOWAGE = (-0.14, 1.47, 0.80, 0.62, 0.14, 0.52)  # aerial/kit box on the deck
SPONSON = (0.34, 0.34, 0.40)                     # hip fairing size (per corner)
SPONSON_X = 0.82

# turret-local sensor head
COLLAR  = (0.0, 0.06, 0.02, 0.80, 0.16, 0.70)
SENSOR  = (0.0, 0.28, -0.06, 0.70, 0.32, 0.66)
BLISTER = (0.22, 0.30, -0.42, 0.24, 0.24, 0.18)  # ±x pair, EO/IR
PANEL   = (0.0, 0.49, 0.06, 0.62, 0.10, 0.44)    # flat scanner plate
MAST_P0 = (0.16, 0.52, 0.16)
MAST_P1 = (0.06, 1.57, 0.22)                     # world tip y = 1.40+1.57 ≈ 3.0
MAST_R0, MAST_R1 = 0.075, 0.030

# barrel-local chin MG
GUN_YOKE = (0.0, 0.02, 0.10, 0.34, 0.30, 0.34)
GUN_AMMO = (0.21, 0.05, 0.20, 0.22, 0.22, 0.30)
GUN_TUBE = [(-0.12, 0.055), (-0.62, 0.048)]
GUN_SHROUD = [(-0.60, 0.075), (-0.80, 0.072)]

# legs (front slightly slimmer than rear so four legs read as four)
THIGH_RF = (0.132, 0.104)
THIGH_RR = (0.150, 0.118)
SHIN_RF = (0.112, 0.084)
SHIN_RR = (0.126, 0.094)
STUB_HIP = (0.150, 0.090)
STUB_KNEE = (0.115, 0.075)
STUB_ANKLE = (0.095, 0.062)
FOOT_PROFILE = [   # (z, y) ankle-local, extruded x ±FOOT_HALF_W; sole y=-0.19
    (0.26, -0.01), (0.26, -0.15), (0.20, -0.19), (-0.30, -0.19),
    (-0.44, -0.13), (-0.46, -0.05), (-0.22, 0.04), (-0.08, 0.08), (0.12, 0.08),
]
FOOT_HALF_W = 0.16

# ── clip keyframes ───────────────────────────────────────────────────────
# WALK — 1.2 s DIAGONAL TROT. thigh_fl + thigh_rr share the base phase;
# thigh_fr + thigh_rl are shifted half a cycle. Shorter, quicker stride than
# the biped (±18° vs ±27°), and the body bobs FOUR times per cycle at a tiny
# 0.02 m amplitude — a low quadruped is a stable sensor platform.
WALK_T = 1.2
WALK_THIGH = [18, 11, 2, -9, -18, -11, 5, 15, 18]
WALK_SHIN  = [-4, -11, -5, 3, 10, 27, 23, 4, -4]
WALK_FOOT_COMP = 0.75
WALK_FOOT_CLAMP = 25.0
WALK_BODY_Y = [0.0, -0.020, 0.0, -0.020, 0.0, -0.020, 0.0, -0.020, 0.0]
WALK_HEAD_YAW = [3, 1, 0, -1, -3, -1, 0, 1, 3]
WALK_GUN_PITCH = [-1.5, -0.8, 0, 0.8, 1.5, 0.8, 0, -0.8, -1.5]

# IDLE — 3.6 s. No breathing bob (it is a drone): the SENSOR HEAD is the idle,
# a slow scanning yaw sweep with a small barrel nod and a faint chassis settle.
IDLE_T = 3.6
IDLE_KEYS = [0.0, 0.7, 1.4, 2.2, 2.9, 3.6]
IDLE_HEAD_YAW = [0, 20, 35, 0, -30, 0]
IDLE_GUN_PITCH = [0, -3, -5, -1, -4, 0]
IDLE_BODY_Y = [0.0, -0.004, -0.006, -0.003, -0.005, 0.0]

# DEATH — 1.8 s legs-splay-out collapse onto the belly. EVERY channel commits
# to one direction: down + nose-forward. Ends settled, belly on the deck.
DEATH_T = 1.8
DEATH_KEYS = [0.0, 0.25, 0.6, 1.1, 1.8]
DEATH_BODY = [(0, 0, 0), (0, -0.09, 0.0), (0, -0.32, 0.02),
              (0, -0.60, 0.04), (0, -0.70, 0.05)]
DEATH_BODY_PITCH = [0, -2, -6, -11, -12]      # −x = nose down
DEATH_HEAD_PITCH = [0, -4, -14, -26, -30]     # sensor head slumps forward
DEATH_HEAD_YAW = [0, -3, -9, -15, -16]
DEATH_GUN = [0, -8, -22, -38, -42]            # chin MG droops
DEATH_THIGH = [0, 4, 12, 20, 22]              # all four buckle the same way
DEATH_SHIN = [0, -6, -18, -28, -30]
DEATH_SPLAY = [0, 8, 24, 38, 42]              # ±z roll: legs sprawl outboard
