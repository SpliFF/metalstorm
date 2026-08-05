"""ms_supply_truck_layout — zones + dims for ms_supply_truck.

Armoured military supply truck (logistics unit): 7 m cab-over, plated
cargo box with standoff applique plates, side skirts, brush guard,
roof stowage (tarp roll, spare wheel, hatch), 6x6 running gear on
three spinnable axle pieces (axle_f/axle_m/axle_r — script Spin API,
same contract as ms_civtruck's axles).  Distinct from ms_civtruck
(6 m, white/teal civilian livery) by armour geometry and an olive-drab
military palette.  Rests wheels at Y=0, forward -Z, 1 u = 1 m.
Tri budget <= 1200 (spec); textures 1024² (dominant dim < 15 m).
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas zones (1024²; v down) ──────────────────────────────────────────
# Cargo box side is L/R-shared (mirror-safe: symmetric emblem, no text).
BOX_SIDE  = Zone((0,   0,   640,  256), ('z', 'y'), ((-1.7, 3.6), (3.3, 0.4)))
CAB_SIDE  = Zone((640, 0,   1024, 256), ('z', 'y'), ((-3.7, -1.6), (3.3, 0.4)))
CAB_FRONT = Zone((0,   256, 320,  512), ('x', 'y'), ((1.35, -1.35), (3.3, 0.4)))
BOX_REAR  = Zone((320, 256, 640,  512), ('x', 'y'), ((-1.35, 1.35), (3.3, 0.4)))
BOX_ROOF  = Zone((640, 256, 1024, 464), ('z', 'x'), ((-1.6, 3.5), (-1.35, 1.35)))
CAB_ROOF  = Zone((640, 464, 896,  640), ('x', 'z'), ((-1.3, 1.3), (-3.6, -1.7)))
# generic cells (small parts sample near cell centre — civkit convention)
WHEEL     = Zone((0,   512, 256,  640), ('z', 'y'), ((-45, 45), (25, -5)))
HUB       = Zone((256, 512, 384,  640), ('x', 'z'), ((-45, 45), (-45, 45)))
TRIM      = Zone((0,   640, 256,  768), ('z', 'y'), ((-45, 45), (25, -5)))
DARK      = Zone((256, 640, 384,  768), ('x', 'z'), ((-45, 45), (-45, 45)))
STOW      = Zone((384, 512, 640,  640), ('z', 'y'), ((-45, 45), (25, -5)))
TARP      = Zone((384, 640, 640,  768), ('z', 'y'), ((-45, 45), (25, -5)))
EXH       = (896, 464, 1024, 592)      # parametric exhaust-stack wrap

# ── dims (world metres, ground Y=0, forward -Z) ──────────────────────────
LENGTH    = 7.0                                   # bumper -3.5 .. box +3.5
CAB       = (0.0, 1.95, -2.60, 2.45, 1.75, 1.50)  # cab-over: x,y,z,w,h,d
VISOR     = (0.0, 2.66, -3.28, 2.35, 0.16, 0.44)  # armoured windshield visor
BOX       = (0.0, 2.05, 0.95, 2.55, 2.15, 4.90)   # plated cargo box
CHASSIS   = (0.0, 0.72, 0.0, 1.90, 0.45, 6.60)
BUMPER    = (0.0, 0.85, -3.36, 2.50, 0.55, 0.28)  # front face at z=-3.5
GUARD_X   = 0.75                                  # brush-guard posts +-x
GUARD_Z   = -3.44
GUARD_Y   = (1.05, 2.05)                          # post bottom..top
GUARD_BAR = 1.62                                  # cross-bar height
PLATE     = (1.325, 2.10, 0.95, 0.10, 1.25, 4.50) # applique plate (per side)
SKIRT     = (1.24, 0.85, -0.55, 0.08, 0.55, 2.60) # skirt seg between axles
FENDER_F  = (1.05, 1.16, -2.55, 0.55, 0.12, 1.50)
FENDER_R  = (1.05, 1.16, 2.10, 0.55, 0.12, 2.60)  # covers rear tandem
TOOLBOX_R = (1.12, 0.78, -0.90, 0.32, 0.50, 1.10)
TOOLBOX_L = (-1.12, 0.78, -0.30, 0.32, 0.50, 0.90)
TARP_ROLL = (0.0, 2.99, -2.60, 1.90, 0.34, 0.95)  # lashed roll on cab roof
SPARE     = (-0.62, 3.19, -0.90, 0.50, 0.13)      # x,y,z, r, half-w (axis y)
HATCH     = (0.60, 3.18, 1.60, 0.70, 0.12, 0.70)  # box-roof access hatch
EXHAUST   = (1.14, 1.05, 3.00, -1.68)             # x, y0, y1, z (stack)
ANTENNA   = (-1.05, 2.80, 4.05, -2.00)            # x, y0, y1, z

WHEEL_R   = 0.52
WHEEL_HW  = 0.20
WHEEL_X   = 1.05
AXLES     = [('axle_f', -2.55), ('axle_m', 1.45), ('axle_r', 2.75)]
