"""ms_expedition_rig_layout — zones + dims for ms_expedition_rig.

6-wheel expedition truck, ~7 m (STYLE.md vehicle budget: <= 2000 tris,
1024^2 texture set — dominant dim < 15 m).  ONE chassis (`body`) carries
FOUR interchangeable mission modules, all present in the glTF as separate
sibling pieces mounted at the same deck socket (MOD_OFF) — the engine
hides the unused ones:

  mod_survey — instrument skid: core-drill derrick + pedestal carrying
               the rotating `dish` child piece (idle clip)
  mod_envoy  — parley canopy on posts, table, flagstaff w/ team pennant
  mod_repair — knuckle crane + spares rack (crates, jerry cans, spare wheel)
  mod_mast   — telescoping antenna array (3 tapering segments + yards)

Spinnable axle pieces: axle_f / axle_m / axle_r (script API, like the
civkit vehicles).  World frame: forward -Z, up +Y, ground Y=0,
1 unit = 1 m.  Modules are authored in PIECE-LOCAL coords (origin at the
deck socket), so their zone windows below are local too.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas zones (1024²; v down) ──────────────────────────────────────────
CAB_SIDE  = Zone((0,   0,   384,  224), ('z', 'y'), ((-3.6, -1.5), (2.75, 0.55)))
CAB_FRONT = Zone((384, 0,   672,  224), ('x', 'y'), ((1.25, -1.25), (2.75, 0.55)))
CAB_ROOF  = Zone((672, 0,   896,  144), ('x', 'z'), ((-1.25, 1.25), (-3.6, -1.5)))
BED_END   = Zone((672, 144, 896,  224), ('x', 'y'), ((1.3, -1.3), (1.5, 0.4)))
GLOWZ     = Zone((896, 0,   1024, 128), ('x', 'y'), ((-8.0, 8.0), (8.0, -8.0)))
DARKZ     = Zone((896, 128, 1024, 224), ('x', 'z'), ((-8.0, 8.0), (-8.0, 8.0)))
BED_SIDE  = Zone((0,   224, 448,  368), ('z', 'y'), ((-1.6, 3.5), (1.55, 0.45)))
BED_TOP   = Zone((448, 224, 832,  368), ('x', 'z'), ((-1.3, 1.3), (-1.7, 3.4)))
TANKZ     = Zone((832, 224, 1024, 352), ('z', 'y'), ((-1.1, 1.1), (1.25, 0.4)))
WHEELZ    = Zone((0,   368, 224,  592), ('z', 'y'), ((-0.62, 0.62), (0.62, -0.62)))
HUBZ      = Zone((224, 368, 448,  592), ('z', 'y'), ((-0.6, 0.6), (0.6, -0.6)))
MODBASE   = Zone((448, 368, 832,  528), ('x', 'z'), ((-1.1, 1.1), (-1.8, 1.8)))
MODSIDE   = Zone((832, 352, 1024, 480), ('z', 'y'), ((-1.8, 1.8), (2.2, 0.0)))
CANOPY    = Zone((448, 528, 832,  688), ('x', 'z'), ((-1.2, 1.2), (-1.7, 1.7)))
DISH_F    = Zone((0,   592, 224,  816), ('x', 'y'), ((-0.62, 0.62), (0.84, -0.4)))
DISH_B    = Zone((224, 592, 448,  816), ('x', 'y'), ((-0.62, 0.62), (0.84, -0.4)))
FLAGZ     = Zone((832, 480, 1024, 608), ('z', 'y'), ((1.4, 2.25), (3.15, 2.7)))
CRATEZ    = Zone((832, 608, 1024, 736), ('z', 'y'), ((-1.0, 1.0), (1.1, -0.1)))
BULLZ     = Zone((832, 736, 1024, 800), ('x', 'y'), ((1.2, -1.2), (1.5, 0.6)))
MASTW     = (0,   816, 384,  944)   # parametric mast/pedestal wrap
TRIMW     = (384, 816, 640,  944)   # parametric small-steel wrap
DRILLW    = (640, 816, 832,  944)   # parametric equipment-orange wrap
EXHW      = (832, 816, 1024, 944)   # parametric exhaust wrap (sooty top)

# ── chassis dims (world metres, ground Y=0, forward -Z) ──────────────────
CAB      = (0.0, 1.72, -2.55, 2.4, 1.7, 1.95)     # cab-over: z -3.53..-1.58
CHASSIS  = (0.0, 0.78, 0.1, 1.9, 0.5, 6.6)        # frame rails
DECK     = (0.0, 1.18, 0.95, 2.5, 0.28, 4.7)      # flatbed, top Y=1.32
HEADBOARD= (0.0, 1.62, -1.32, 2.4, 0.6, 0.14)     # cab-guard at deck front
BULLBAR  = (0.0, 1.05, -3.64, 2.3, 0.85, 0.22)    # nose z ~ -3.75 (len ~7.1)
REARBAR  = (0.0, 0.78, 3.42, 2.3, 0.35, 0.18)
LIGHTBAR = (0.0, 2.66, -2.9, 1.7, 0.16, 0.3)      # cab roof, emissive amber
SUNVISOR = (0.0, 2.52, -3.58, 2.2, 0.1, 0.35)
TANKS    = [(-1.22, 0.82, 0.15, 0.4, 0.62, 1.7),
            (1.22, 0.82, 0.15, 0.4, 0.62, 1.7)]
STEPS    = [(-1.28, 0.62, -2.55, 0.16, 0.08, 1.0),
            (1.28, 0.62, -2.55, 0.16, 0.08, 1.0)]
EXH      = (1.02, -1.45)                          # stack x,z; y 1.35->2.62

# ── running gear ─────────────────────────────────────────────────────────
WHEEL_R  = 0.56
WHEEL_GROUND = 0.5174                             # r·cos(π/8): 8-gon flat rests on Y=0
WHEEL_HW = 0.18                                   # wheel half-width
WHEEL_X  = 1.06                                   # track half-spacing
AXLES    = [('axle_f', -2.45), ('axle_m', 1.55), ('axle_r', 2.75)]
AXLE_BAR = (2.3, 0.24, 0.24)

# ── module socket (all four modules mount here; engine shows one) ────────
MOD_OFF  = (0.0, 1.32, 1.0)                       # deck-top socket

# mod_survey (local)
SUR_SKID    = (0.0, 0.09, 0.0, 1.9, 0.18, 3.4)
SUR_HOUSE   = (0.55, 0.62, 1.05, 0.9, 0.9, 1.0)   # drill power pack
SUR_DERRICK = (0.55, 1.05)                        # x,z; A-frame to y 2.0
SUR_BLOCK   = (0.55, 2.08, 1.05, 0.32, 0.26, 0.32)
SUR_PED     = (0.0, -1.0)                         # dish pedestal x,z
DISH_OFF    = (0.0, 1.05, -1.0)                   # `dish` pivot (local)
DISH_R      = 0.62
DISH_TILT   = 30.0                                # degrees skyward

# mod_envoy (local)
ENV_PLAT   = (0.0, 0.09, 0.0, 2.1, 0.18, 3.2)
ENV_POSTS  = [(-0.9, -1.35), (0.9, -1.35), (-0.9, 1.35), (0.9, 1.35)]
ENV_CANOPY = (0.0, 1.95, 0.0, 2.3, 0.14, 3.2)
ENV_TABLE  = (0.0, 0.43, 0.1, 1.2, 0.5, 0.8)
ENV_STAFF  = (0.85, 1.45)                         # x,z; y 0.18 -> 3.1
ENV_PENNANT= [(0.85, 3.05, 1.45), (0.85, 2.75, 1.45), (0.85, 2.9, 2.15)]

# mod_repair (local)
REP_BASE   = (0.0, 0.09, 0.0, 1.9, 0.18, 3.3)
REP_PED    = (0.55, 0.55, -0.9, 0.8, 0.75, 0.8)
REP_POST   = ((0.55, 0.9, -0.9), (0.55, 1.5, -0.9))
REP_BOOM   = ((0.55, 1.42, -0.9), (0.55, 2.3, 0.95))
REP_CABLE  = ((0.55, 2.26, 0.9), (0.55, 1.62, 0.9))
REP_HOOK   = (0.55, 1.52, 0.9, 0.14, 0.2, 0.14)
REP_RACK   = (-0.55, 0.53, 0.85, 0.85, 0.7, 1.3)  # crate stack
REP_CRATES = [(-0.5, 1.03, 0.6, 0.55, 0.3, 0.6),
              (0.45, 0.35, 0.35, 0.55, 0.34, 0.6)]
REP_CANS   = [(0.62, 0.42, 1.35, 0.34, 0.46, 0.22),
              (0.24, 0.42, 1.42, 0.34, 0.46, 0.22)]
REP_SPARE  = (-0.55, 0.32, -0.75, 0.5, 0.13)      # x,y,z, r, half-h (flat)

# mod_mast (local)
MAST_CAB   = (-0.45, 0.55, -0.75, 1.0, 0.9, 1.1)  # transceiver cabinet
MAST_XZ    = (0.3, 0.3)
MAST_SEGS  = [(0.15, 1.8, 0.13), (1.8, 3.3, 0.09), (3.3, 4.62, 0.055)]
MAST_YARDY = 3.28                                 # yard-arm height
MAST_YARDS = 0.58                                 # yard half-span
MAST_WHISK = 0.5                                  # dipole whisker height
MAST_BEACON= (0.3, 4.72, 0.3, 0.13, 0.16, 0.13)   # emissive tip
