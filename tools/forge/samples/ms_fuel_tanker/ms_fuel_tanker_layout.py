"""ms_fuel_tanker_layout — zones + dims for the armoured fuel tanker.

7.5 m wheeled logistics hauler (between the 6 m ms_civtruck and the
s2 artillery row of STYLE.md's class-scale table).  1024² atlas
(dominant dim < 15 m).  Forward -Z, up +Y, ground Y=0, 1 unit = 1 m.

Pieces: body (root) + hose_reel (spins about +X, civkit axle
convention) + axle_f / axle_m / axle_r (spinnable wheel pairs) +
nozzle (empty FX/dressing mount at the rear valve cabinet).
Unarmed — no turret/barrel/muzzle chain.
"""
from meshlib import Zone

# ── atlas zones (1024) ──────────────────────────────────────────────────
CAB_SIDE  = Zone((0,    0,   288, 160), ('z', 'y'), ((-3.8, -2.0), (2.7, 0.8)))
CAB_FRONT = Zone((288,  0,   544, 160), ('x', 'y'), ((1.3, -1.3), (2.7, 0.8)))
CAB_ROOF  = Zone((544,  0,   800, 128), ('x', 'z'), ((-1.3, 1.3), (-3.8, -2.0)))
TRIMZ     = Zone((800,  0,   928, 128), ('z', 'y'), ((-45, 45), (25, -5)))
DARKZ     = Zone((928,  0,  1024, 128), ('x', 'z'), ((-45, 45), (-45, 45)))
TANKW     = (0, 192, 768, 448)        # parametric tank wrap: u along z, v around
TANK_CAP  = Zone((768, 160,  960, 352), ('x', 'y'), ((1.1, -1.1), (3.0, 0.8)))
VALVEZ    = Zone((768, 384, 1024, 512), ('x', 'y'), ((1.0, -1.0), (1.6, 0.4)))
WHEELZ    = Zone((0,   480,  256, 608), ('z', 'y'), ((-45, 45), (25, -5)))
HUBZ      = Zone((256, 480,  384, 608), ('x', 'z'), ((-45, 45), (-45, 45)))
SKIRT     = Zone((384, 480,  768, 560), ('z', 'y'), ((-3.75, 3.75), (1.6, 0.4)))
REELZ     = Zone((0,   640,  128, 768), ('z', 'y'), ((-1, 1), (1, -1)))
REEL_DRUM = Zone((128, 640,  256, 768), ('z', 'y'), ((-1, 1), (1, -1)))

# ── dims (x, y, z centre + w, h, d) ─────────────────────────────────────
CAB       = (0.0, 1.72, -2.95, 2.3, 1.55, 1.55)
CHASSIS   = (0.0, 0.85, 0.0, 1.8, 0.45, 7.3)
BUMPER_F  = (0.0, 0.72, -3.60, 2.35, 0.55, 0.26)
VALVE_BOX = (0.0, 1.00, 3.45, 1.6, 0.8, 0.5)
PEDESTAL  = (0.0, 1.42, 3.33, 0.72, 0.38, 0.32)   # hose-reel mount
SADDLE_Z  = (-1.1, 2.3)
SADDLE_Y  = 1.15
SADDLE    = (1.7, 0.7, 0.5)
TANK_R    = 0.95
TANK_CY   = 1.90
TANK_Z0   = -1.85                                  # front (cab side)
TANK_Z1   = 3.20                                   # rear
TANK_STATIONS = [(TANK_Z1, 0.80, TANK_CY), (TANK_Z1 - 0.18, TANK_R, TANK_CY),
                 (TANK_Z0 + 0.18, TANK_R, TANK_CY), (TANK_Z0, 0.80, TANK_CY)]
WALKWAY   = (0.0, 2.92, 0.65, 0.7, 0.09, 3.4)      # spine walkway on tank top
HATCH_Z   = (0.0, 1.5)                             # filler manhole domes
EXHAUST   = (1.0, -2.05)                           # x, z; runs y 2.5 -> 3.1
FENDERS   = [(2.22, 2.4)]                          # z centre, length (tandem)
FENDER_Y  = 1.26
HAZBANDS  = [(2.85, 2.45), (-1.15, -1.55)]         # z hi, z lo stripe rings
TEAM_BAND = (1.95, 1.70)                           # team-colour ring
WELD_Z    = (2.2, 0.9, -0.4)                       # shell plate welds
RING_Z    = (3.02, -1.67)                          # end flange rings
REEL_OFF  = (0.0, 2.05, 3.33)
REEL_FL_X = 0.45                                   # flange centre |x|
REEL_FL_R = 0.42
REEL_FL_HW = 0.035
REEL_DR_X = 0.38                                   # drum half-width
REEL_DR_R = 0.28
AXLES     = [('axle_f', -2.55), ('axle_m', 1.60), ('axle_r', 2.85)]
WHEEL_R   = 0.52
WHEEL_HW  = 0.18
WHEEL_X   = 1.02
NOZZLE_OFF = (0.0, 1.0, 3.72)                      # empty: unload FX / hose tip
