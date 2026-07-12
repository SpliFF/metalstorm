"""fighter_layout — zones + dims for fable_fighter (FA-6 Shrike).

s3 fighter per art/STYLE.md: 12 m wingspan, ~15 m nose-to-nozzle.
Chined hex-loft fuselage, bubble canopy, twin flank intakes, cranked
trapezoid wings with underwing pylon + wingtip rail AA missiles, twin
canted fins, twin afterburner nozzles. Fixed landing gear as separate
pieces (gear_n / gear_l / gear_r — a future unit script can Hide()
them in flight). Rests on its wheels at Y=0. forward -Z, 2048² atlas.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
F_SIDE   = Zone((0,    0,    2048, 384),  ('z', 'y'), ((-7.8, 8.2), (3.15, 0.15)))
F_TOP    = Zone((0,    384,  2048, 1152), ('z', 'x'), ((-7.8, 8.2), (-6.4, 6.4)))
F_BOT    = Zone((0,    1152, 2048, 1664), ('z', 'x'), ((-7.8, 8.2), (-6.4, 6.4)))
F_CANOPY = Zone((0,    1664, 512,  1856), ('z', 'y'), ((-4.6, -1.7), (3.15, 2.1)))
F_FIN    = Zone((512,  1664, 1024, 1856), ('z', 'y'), ((4.9, 7.6), (4.05, 1.9)))
F_MISSILE= (1024, 1664, 1280, 1792)      # parametric missile-body wrap
F_NOZZLE = (1280, 1664, 1664, 1792)      # parametric nozzle wrap
F_BURNER = Zone((1664, 1664, 1792, 1792), ('x', 'y'), ((-45, 45), (25, -5)))
F_GEAR   = Zone((1792, 1664, 1920, 1792), ('z', 'y'), ((-45, 45), (25, -5)))
F_TRIM   = Zone((1920, 1664, 2048, 1792), ('z', 'y'), ((-45, 45), (25, -5)))
F_NAVP   = Zone((1024, 1792, 1152, 1856), ('z', 'y'), ((-45, 45), (25, -5)))
F_NAVS   = Zone((1152, 1792, 1280, 1856), ('z', 'y'), ((-45, 45), (25, -5)))
F_DARK   = Zone((1280, 1792, 1408, 1856), ('x', 'z'), ((-45, 45), (-45, 45)))

# ── dims (world metres; wheels at Y=0, nose -Z) ──────────────────────────
# fuselage loft sections: (z, w_chine, half_w_top, y_top, y_bot, y_chine)
FUS_SECTIONS = [
    (-7.30, 0.10, 0.05, 1.62, 1.46, 1.54),
    (-6.20, 0.44, 0.20, 1.98, 1.26, 1.58),
    (-4.60, 0.74, 0.36, 2.28, 1.05, 1.62),
    (-2.80, 0.98, 0.48, 2.42, 0.90, 1.60),
    (-0.80, 1.12, 0.54, 2.38, 0.85, 1.55),
    (1.60,  1.15, 0.56, 2.32, 0.85, 1.50),
    (4.00,  1.06, 0.52, 2.22, 0.90, 1.46),
    (6.00,  0.95, 0.46, 2.06, 0.96, 1.45),
    (7.20,  0.74, 0.36, 1.86, 1.06, 1.45),
]
# canopy arch sections: (z, w, y_base, y_top)
CAN_SECTIONS = [
    (-4.45, 0.10, 2.26, 2.34),
    (-4.10, 0.36, 2.30, 2.78),
    (-3.30, 0.44, 2.36, 2.96),
    (-2.45, 0.40, 2.40, 2.86),
    (-1.90, 0.30, 2.42, 2.58),
]
# intake duct loft (right side): (z, x_in, x_out, y_bot, y_top)
# inner wall buried deep in the fuselage (§23 rule); roof tucks under
# the shoulder-mounted wing root
INTAKE_SECTIONS = [
    (-2.70, 0.55, 1.74, 1.02, 1.80),
    (-0.60, 0.55, 1.78, 0.96, 1.84),
    (1.40,  0.55, 1.60, 0.94, 1.84),
]
SPLITTER = (0.99, -2.75, 1.44, 1.06, 1.76)   # x, z0, z1, y0, y1 (plate)

# blade surfaces: stations of (span_x, y, z_le, z_te, thickness)
# shoulder-mounted: root rides over the intake trunks, F/A-18 style
WING = [
    (0.70, 2.02, -0.90, 4.30, 0.34),
    (2.40, 2.02, 0.35,  4.15, 0.24),
    (5.95, 2.05, 2.55,  3.95, 0.13),
]
FIN = [                                   # canted; thickness along x
    (0.82, 2.05, 5.05, 7.30, 0.18),
    (1.42, 3.85, 6.15, 7.45, 0.09),
]
STAB = [
    (0.68, 1.50, 5.30, 7.35, 0.20),
    (3.05, 1.56, 6.40, 7.40, 0.09),
]

# stores
PYLON_X   = 3.40                          # underwing pylon span station
PYLON     = (1.30, 3.30, 1.96, 1.48)      # z0, z1, y_top, y_bot
MSL_R     = 0.15
MSL_PYLON = (1.30, 0.55, 3.25)            # y, z_nose, z_tail (at PYLON_X)
TIP_RAIL  = (6.18, 1.98, 2.45, 4.15)      # x, y, z0, z1 (rail box)
MSL_TIP   = (1.80, 1.75, 4.30)            # y, z_nose, z_tail (at TIP_RAIL x)

# engines
NOZZLE_X  = 0.38                          # twin nozzle x offset
NOZZLE    = [(8.05, 0.29, 1.50), (7.70, 0.37, 1.50), (7.05, 0.34, 1.47)]
EXHAUST_OFF = (0.0, 1.5, 8.2)

# landing gear: (attach x, y, z), strut drop, wheel r, wheel half-width
GEAR_N = ((0.0, 1.04, -4.70), 0.66, 0.34, 0.10)
GEAR_M = ((1.05, 0.88, 2.70), 0.52, 0.36, 0.13)   # mirrored for left

# greebles
NAV_L     = (6.05, 2.08, 2.62)            # wingtip nav boxes (±x)
PITOT     = (0.0, 1.56, -7.28)
ANTENNAS  = [(0.0, 2.32, -0.2), (0.0, 2.24, 3.4)]
GUN_MUZZLE = (0.52, 1.28, -5.30)          # chin autocannon port
MUZZLE2    = (-3.40, 0.82, 0.40)          # left pylon missile tip
