"""arty_layout — zones + dims for ms_artillery_s2 (Howitzer battery SPG).

STYLE.md artillery row: s2 length = 7.5 m, ≤2000 tris. Tracked
self-propelled howitzer: low hull, rear-set boxy casemate turret, long
elevated howitzer with a double-baffle muzzle brake, rear recoil spade.
Same faction language as fable_tank (blue-grey armor, cyan energy
plumbing on the recuperators). Forward -Z, up +Y, ground Y=0, 1u=1m.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas zones (1024²; v down) ──────────────────────────────────────────
A_HULL_TOP   = Zone((0,   0,   448, 224), ('x', 'z'), ((-1.45, 1.45), (-3.85, 3.85)))
A_GLACIS     = Zone((448, 0,   672, 152), ('x', 'y'), ((-1.45, 1.45), (1.80, 0.10)))
A_HULL_REAR  = Zone((672, 0,   896, 152), ('x', 'y'), ((1.45, -1.45), (1.80, 0.10)))
A_DARK       = Zone((896, 0,   1024, 128), ('x', 'z'), ((-9, 9), (-9, 9)))
A_HULL_SIDE  = Zone((0,   224, 448, 328), ('z', 'y'), ((-3.85, 3.85), (1.80, 0.10)))
A_TRACK_SIDE = Zone((0,   328, 448, 448), ('z', 'y'), ((-3.70, 3.70), (1.45, 0.00)))
A_TRACK_WRAP = (0, 448, 448, 508)      # parametric arc-length wrap
A_CAB_SIDE   = Zone((448, 152, 832, 356), ('z', 'y'), ((-1.35, 1.95), (1.42, -0.05)))
A_CAB_FRONT  = Zone((832, 152, 1024, 356), ('x', 'y'), ((-1.20, 1.20), (1.42, -0.05)))
A_CAB_REAR   = Zone((832, 152, 1024, 356), ('-x', 'y'), ((-1.20, 1.20), (1.42, -0.05)))
A_CAB_TOP    = Zone((448, 356, 832, 620), ('x', 'z'), ((-1.20, 1.20), (-1.40, 2.00)))
A_TUBE       = (0, 508, 448, 580)      # parametric tube wrap
A_BRAKE      = Zone((448, 620, 576, 748), ('x', 'y'), ((-0.30, 0.30), (0.30, -0.30)))
A_BREECH     = Zone((576, 620, 704, 748), ('x', 'y'), ((-0.32, 0.32), (0.34, -0.34)))
A_RECUP      = Zone((704, 620, 832, 700), ('x', 'y'), ((-0.26, 0.26), (0.20, -0.20)))
A_SPADE      = Zone((0,   580, 224, 700), ('x', 'y'), ((-1.30, 1.30), (0.85, -0.05)))
A_HATCH      = Zone((832, 356, 928, 452), ('x', 'z'), ((-0.30, 0.30), (-0.30, 0.30)))
A_INTAKE     = Zone((832, 452, 1024, 548), ('x', 'z'), ((-0.80, 0.80), (-0.50, 0.50)))
A_EXHAUST    = Zone((928, 356, 1024, 452), ('x', 'y'), ((-0.26, 0.26), (0.26, -0.26)))
A_HUB        = (224, 580, 320, 644)    # parametric hub wrap
A_HUB_CAP    = Zone((320, 580, 384, 644), ('z', 'y'), ((-0.30, 0.30), (0.30, -0.30)))
A_FENDER     = Zone((0,   700, 448, 764), ('z', 'x'), ((-3.70, 3.70), (-0.56, 0.56)))
A_TUBE_CAP   = Zone((384, 580, 448, 644), ('x', 'y'), ((-0.26, 0.26), (0.26, -0.26)))
A_CRANE      = (224, 644, 320, 700)    # parametric small-limb wrap
A_LIGHT      = Zone((896, 560, 1024, 640), ('x', 'y'), ((-0.1, 0.1), (0.1, -0.1)))
A_AMMO       = Zone((832, 700, 1024, 892), ('x', 'y'), ((-0.45, 0.45), (0.55, -0.15)))

# ── design constants ─────────────────────────────────────────────────────
HULL_LEN    = (-3.65, 3.85)            # 7.5 m
HULL_DECK_Y = 1.62
# (z, y_bot, y_waist, y_shoulder, y_deck, w_bot, w_waist, w_deck, w_top)
HULL_SECTIONS = [
    (-3.62, 0.66, 0.80, 0.94, 1.00, 0.30, 0.56, 0.46, 0.28),
    (-2.70, 0.30, 0.86, 1.16, 1.24, 0.80, 1.18, 0.96, 0.72),
    (-1.20, 0.22, 0.98, 1.50, 1.62, 0.94, 1.30, 1.14, 0.92),
    (0.90,  0.22, 0.98, 1.52, 1.62, 0.94, 1.30, 1.16, 0.94),
    (2.45,  0.22, 0.94, 1.44, 1.56, 0.90, 1.26, 1.10, 0.88),
    (3.82,  0.40, 0.82, 1.16, 1.26, 0.74, 1.06, 0.88, 0.68),
]
TRACK_OFF   = (1.62, 0.0, 0.05)
TRACK_PROFILE = [
    (-3.60, 0.72), (-2.55, 0.09), (2.55, 0.09), (3.60, 0.70),
    (3.52, 1.14), (2.15, 1.26), (-2.15, 1.26), (-3.48, 1.12),
]
TRACK_HALF_W = 0.50
HUB_FRONT   = (-3.28, 0.84, 0.25)
HUB_REAR    = (3.30, 0.82, 0.23)
FENDER      = ((-3.55, 3.60), 1.26, 0.10, 1.08)

TURRET_OFF  = (0.0, HULL_DECK_Y - 0.06, 0.95)   # rear-set casemate
# casemate loft (turret-local): tall boxy superstructure
# (z, y_bot, y_waist, y_shoulder, y_deck, w_bot, w_waist, w_deck, w_top)
CAB_SECTIONS = [
    (-1.32, -0.05, 0.10, 0.78, 0.90, 0.72, 0.94, 0.84, 0.62),
    (-0.55, -0.05, 0.12, 1.10, 1.26, 1.02, 1.22, 1.10, 0.88),
    (0.75,  -0.05, 0.12, 1.14, 1.30, 1.04, 1.24, 1.12, 0.92),
    (1.90,  -0.02, 0.10, 0.98, 1.10, 0.88, 1.08, 0.96, 0.76),
]
BARREL_OFF  = (0.0, 0.88, -0.95)       # trunnion (turret-local)
BARREL_ELEV = 14.0                     # baked elevation, degrees
TUBE_LEN    = 3.55                     # trunnion → muzzle tip
SPADE       = (0.0, 0.42, 3.78, 2.5, 0.72, 0.18)  # rear recoil spade blade
EXHAUST_OFF = (-1.05, 1.68, 3.30)
