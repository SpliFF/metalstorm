"""ms_tank_wreck_layout — zones + dims for ms_tank_wreck.

Burned-out fable_tank derivative wreck (static map prop, no team, no
clips).  Hull + attached left track rebuilt simplified from the tank's
layout dims; turret dismounted and half-slid off the left hull side,
barrel bent; right track thrown, lying flat beside the hull; scattered
armour-plate debris + one loose road wheel.  Fire-scorched repaint:
soot, bare rust, no team colour, nothing glows.
World frame: up +Y, forward -Z, ground Y=0, 1 unit = 1 m.  Budget 1500.

Atlas rects are lifted from the fable_tank layout so the wreck reads as
the same vehicle; windows match the local build frames in gen.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas cells (1024²; v down) ─────────────────────────────────────────
Z_HULL_TOP    = Zone((0,   0,   512, 232), ('x', 'z'), ((-1.75, 1.75), (-4.55, 4.55)))
Z_GLACIS      = Zone((512, 0,   736, 168), ('x', 'y'), ((-1.75, 1.75), (2.05, 0.15)))
Z_HULL_REAR   = Zone((736, 0,   960, 168), ('x', 'y'), ((1.75, -1.75), (2.05, 0.15)))
Z_DARK        = Zone((960, 0,  1024, 168), ('x', 'z'), ((-1.75, 1.75), (-4.55, 4.55)))
Z_HULL_SIDE   = Zone((0,   232, 512, 344), ('z', 'y'), ((-4.55, 4.55), (2.05, 0.15)))
Z_TRACK_SIDE  = Zone((0,   344, 512, 480), ('z', 'y'), ((-4.45, 4.45), (1.62, 0.02)))
TRACK_WRAP    = (0, 480, 512, 544)          # parametric (arc-length) rect
Z_TURRET_TOP  = Zone((512, 168, 848, 400), ('x', 'z'), ((-1.5, 1.5), (-1.85, 2.35)))
Z_TURRET_SIDE = Zone((848, 168, 1024, 300), ('z', 'y'), ((-1.85, 2.35), (1.25, -0.05)))
Z_TURRET_FRONT= Zone((848, 300, 936, 400), ('x', 'y'), ((-1.1, 1.1), (1.2, -0.05)))
Z_TURRET_REAR = Zone((936, 300, 1024, 400), ('x', 'y'), ((1.1, -1.1), (1.2, -0.05)))
BARREL_WRAP   = (512, 400, 1024, 500)       # parametric tube rect
Z_TUBE_CAP    = Zone((512, 500, 576, 564), ('x', 'y'), ((-0.32, 0.32), (0.32, -0.32)))
Z_HATCH       = Zone((0,   544, 96,  640), ('x', 'z'), ((-0.34, 0.34), (-0.34, 0.34)))
Z_INTAKE      = Zone((96,  544, 288, 640), ('x', 'z'), ((-0.88, 0.88), (-0.58, 0.58)))
Z_EXHAUST     = Zone((288, 544, 384, 640), ('x', 'y'), ((-0.30, 0.30), (0.30, -0.30)))
Z_BREECH      = Zone((96,  736, 224, 800), ('x', 'y'), ((-0.30, 0.30), (0.30, -0.30)))
# wreck-only cells (full-cell UV mapping, painted once, shared)
PLATE_S       = (384, 544, 512, 592)        # debris armour-plate edge band
PLATE_T       = (384, 592, 512, 720)        # debris armour-plate face
HUB_CAP       = (448, 736, 512, 800)        # loose road-wheel face
WHEEL_WRAP    = (352, 736, 448, 800)        # loose road-wheel tread wrap

# ── hull dims (from fable_tank layout, simplified) ──────────────────────
# (z, y_bot, y_waist, y_shoulder, y_deck, w_bot, w_waist, w_deck, w_top)
HULL_SECTIONS = [
    (-4.35, 0.78, 0.92, 1.04, 1.10, 0.34, 0.62, 0.50, 0.32),
    (-3.30, 0.34, 0.98, 1.30, 1.40, 0.90, 1.32, 1.08, 0.80),
    (-1.55, 0.24, 1.12, 1.68, 1.86, 1.06, 1.46, 1.28, 1.04),
    (0.85,  0.24, 1.12, 1.72, 1.86, 1.06, 1.46, 1.30, 1.06),
    (2.85,  0.24, 1.08, 1.62, 1.76, 1.02, 1.42, 1.24, 1.00),
    (4.40,  0.44, 0.92, 1.32, 1.42, 0.84, 1.20, 1.00, 0.78),
]
HULL_DECK_Y = 1.86
SETTLE = -0.08                      # whole wreck settled into the ground

HATCH_OPEN = (0.62, -0.85)          # (x, z) hatch left open (dark bore)
HATCH_SHUT = (-0.62, -0.85)
HATCH_SIZE = (0.62, 0.09, 0.62)
INTAKE = (0.0, 1.80, 2.45, 1.66, 0.10, 1.08)    # x,y,z, w,h,d
EXHAUSTS = [(0.80, 1.60, 3.92), (-0.80, 1.60, 3.92)]
EXHAUST_SIZE = (0.52, 0.44, 0.66)

# ── tracks ──────────────────────────────────────────────────────────────
TRACK_PROFILE = [                    # local (z, y), outer loop
    (-4.30, 0.82), (-3.05, 0.10), (3.05, 0.10), (4.30, 0.80),
    (4.20, 1.30), (2.55, 1.44), (-2.55, 1.44), (-4.15, 1.28),
]
TRACK_HALF_W = 0.575
TRACK_L_OFF = (1.875, SETTLE, 0.05)  # attached left track
# thrown right track: rolled flat (side up), yawed, beside the hull
THROWN_OFF = (-3.85, 0.575, 1.30)
THROWN_YAW = 24.0
THROWN_ROLL = -90.0

# ── turret (dismounted) ─────────────────────────────────────────────────
TURRET_SECTIONS = [
    (-1.70, -0.05, 0.14, 0.50, 0.58, 0.30, 0.54, 0.44, 0.30),
    (-0.85, -0.05, 0.16, 0.86, 0.96, 0.82, 1.06, 0.90, 0.66),
    (0.45,  -0.04, 0.18, 1.00, 1.12, 1.08, 1.38, 1.12, 0.86),
    (1.35,  -0.04, 0.18, 0.94, 1.04, 0.98, 1.24, 1.00, 0.78),
    (2.10,  0.00, 0.16, 0.80, 0.88, 0.74, 0.98, 0.80, 0.60),
]
BUSTLE = (0.0, 0.66, 1.90, 1.50, 0.44, 0.66)     # turret-local x,y,z,w,h,d
TURRET_POS = (-1.55, 1.52, 1.05)     # world; half over deck, half off left
TURRET_YAW = 138.0                   # spun as it slid
TURRET_PITCH = 6.0
TURRET_ROLL = -16.0                  # dips off the hull edge onto the fender

# ── barrel (bent) ───────────────────────────────────────────────────────
BARREL_OFF = (0.0, 0.66, -1.15)      # turret-local
BREECH = (0.0, -0.03, 0.42, 0.55, 0.55, 0.88)
TUBE_STATIONS = [(-0.28, 0.295), (-1.92, 0.295), (-1.92, 0.205), (-4.00, 0.205)]
BEND_Z = -2.05                       # barrel-local: bend everything beyond
BEND_PITCH = -17.0                   # droop
BEND_YAW = 9.0                       # sideways kink

# ── debris field ────────────────────────────────────────────────────────
# armour plates: (cx, cy, cz, w, h, d, yaw_deg)
PLATES = [
    (3.05, 0.05, -3.35, 1.30, 0.10, 0.95,  32.0),
    (-3.30, 0.05, -1.60, 0.95, 0.09, 0.70, -21.0),
    (2.45, 0.05, 2.60, 0.80, 0.08, 1.10,  75.0),
]
# blown hatch lid, landed ahead of the glacis
HATCH_LID = (1.30, 0.045, -5.30, 0.62, 0.09, 0.62, 48.0)
# loose road wheel lying flat near the thrown track
WHEEL = (-3.10, 3.05, 0.36, 0.20)    # cx, cz, radius, thickness
