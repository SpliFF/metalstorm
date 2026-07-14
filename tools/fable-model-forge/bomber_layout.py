"""bomber_layout — zones + dims for fable_bomber (FB-9 Petrel).

s2 compact strike bomber per art/STYLE.md (12 m wingspan, ~11 m long) —
the airframe the carrier's bomber spot was sized for.  Blended
flattened fuselage, wide side-by-side canopy, twin dorsal intakes,
over-tail nozzles, cranked delta wings with two chunky finned bombs on
pylons, closed belly bomb bay (painted doors), twin canted fins.
Fixed landing gear as hideable pieces (gear_n/gear_l/gear_r, §24
pattern).  Rests on its wheels at Y=0.  forward -Z, 2048² atlas.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
B_SIDE   = Zone((0,    0,    2048, 320),  ('z', 'y'), ((-6.0, 6.2), (2.9, 0.05)))
B_TOP    = Zone((0,    320,  2048, 1024), ('z', 'x'), ((-6.0, 6.2), (-6.4, 6.4)))
B_BOT    = Zone((0,    1024, 2048, 1536), ('z', 'x'), ((-6.0, 6.2), (-6.4, 6.4)))
B_CANOPY = Zone((0,    1536, 512,  1728), ('z', 'y'), ((-4.3, -1.8), (2.95, 1.9)))
B_FIN    = Zone((512,  1536, 1024, 1728), ('z', 'y'), ((2.4, 4.9), (3.2, 1.2)))
B_BOMB   = (1024, 1536, 1280, 1664)      # parametric bomb-body wrap
B_NOZZLE = (1280, 1536, 1664, 1664)      # parametric nozzle wrap
B_BURNER = Zone((1664, 1536, 1792, 1664), ('x', 'y'), ((-45, 45), (25, -5)))
B_GEAR   = Zone((1792, 1536, 1920, 1664), ('z', 'y'), ((-45, 45), (25, -5)))
B_TRIM   = Zone((1920, 1536, 2048, 1664), ('z', 'y'), ((-45, 45), (25, -5)))
B_NAVP   = Zone((1024, 1664, 1152, 1792), ('z', 'y'), ((-45, 45), (25, -5)))
B_NAVS   = Zone((1152, 1664, 1280, 1792), ('z', 'y'), ((-45, 45), (25, -5)))
B_DARK   = Zone((1280, 1664, 1408, 1792), ('x', 'z'), ((-45, 45), (-45, 45)))

# ── dims (world metres; wheels at Y=0, nose -Z) ──────────────────────────
# fuselage loft: (z, w_chine, half_w_top, y_top, y_bot, y_chine)
FUS_SECTIONS = [
    (-5.40, 0.14, 0.07, 1.55, 1.35, 1.46),
    (-4.40, 0.85, 0.45, 1.95, 1.05, 1.50),
    (-3.00, 1.45, 0.85, 2.20, 0.88, 1.50),
    (-1.20, 1.80, 1.10, 2.30, 0.80, 1.48),
    (1.00,  1.80, 1.10, 2.30, 0.80, 1.45),
    (3.00,  1.60, 1.00, 2.20, 0.85, 1.42),
    (4.60,  1.20, 0.75, 2.05, 0.95, 1.42),
    (5.60,  0.70, 0.45, 1.85, 1.10, 1.42),
]
# wide canopy arch: (z, w, y_base, y_top)
CAN_SECTIONS = [
    (-4.15, 0.16, 2.10, 2.20),
    (-3.80, 0.52, 2.16, 2.62),
    (-3.10, 0.62, 2.24, 2.76),
    (-2.50, 0.50, 2.28, 2.62),
    (-2.10, 0.36, 2.30, 2.42),
]
# dorsal intake humps (right side): (z, x_in, x_out, y_bot, y_top)
INTAKE_SECTIONS = [
    (-1.80, 0.55, 1.30, 2.15, 2.62),
    (-0.40, 0.55, 1.34, 2.18, 2.70),
    (0.80,  0.55, 1.22, 2.18, 2.64),
]

# blade surfaces: stations of (span_x, y, z_le, z_te, thickness)
WING = [
    (1.20, 1.45, -1.50, 4.60, 0.40),
    (3.20, 1.48, 0.20,  4.45, 0.26),
    (6.00, 1.52, 2.30,  4.25, 0.13),
]
FIN = [                                   # wing-mounted canted fins,
    (2.00, 1.35, 2.60, 4.50, 0.16),       # roots buried THROUGH the wing
    (2.60, 2.95, 3.55, 4.65, 0.08),
]

# stores + bay
BAY        = (0.0, 0.78, 1.2, 1.7, 0.22, 4.6)     # closed door box (x,y,z,w,h,d)
PYLON_X    = 3.00
PYLON      = (1.30, 3.10, 1.42, 1.10)             # z0, z1, y_top, y_bot
BOMB_R     = 0.28
BOMB       = (0.95, 0.85, 3.25)                   # y, z_nose, z_tail

# engines (over-tail, stealth-style)
NOZZLE_X   = 0.85
NOZZLE     = [(5.90, 0.26, 1.95), (5.50, 0.33, 1.95), (4.90, 0.31, 1.93)]
EXHAUST_OFF = (0.0, 2.0, 6.0)

# landing gear: (attach x, y, z), strut drop, wheel r, wheel half-width
GEAR_N = ((0.0, 0.95, -3.60), 0.62, 0.32, 0.10)
GEAR_M = ((1.50, 0.82, 1.90), 0.50, 0.34, 0.13)

# greebles
NAV_L      = (6.02, 1.55, 2.40)
SENSOR     = (0.35, 1.02, -4.55)                  # chin targeting ball
ANTENNAS   = [(0.0, 2.32, 0.6), (0.0, 2.26, 3.0)]
MUZZLE_OFF = (0.0, 0.70, 1.2)                     # bomb release empty
