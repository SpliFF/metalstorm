"""ms_fighters_s2_layout — zones + dims for ms_fighters_s2.

s2 = the first MANNED fighter tier: a conventional single-engine,
single-fin light day fighter (F-86/MiG-15/F-5 adjacency, patched-up
salvage register). 9.0 m span tip-to-tip, ~10.4 m nose-to-muzzle-tip,
~3.4 m to the fin cap. One nose annular intake feeding ONE nozzle, a
real bubble canopy well forward (the manned cue s1 lacks), moderately
swept mid wing, single vertical fin + low tailplane, chin gun tray with
a stub barrel, one underwing AA missile rail per side, tricycle gear as
separate fixed pieces (gear_n / gear_l / gear_r).

Frame: -Z forward, +Y up, wheels at Y=0, 1 unit = 1 m. 1024 atlas.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas zones (1024²; v down) ─────────────────────────────────────────
# three world-anchored body bands at uniform chord-wise density; wings,
# tailplane and fuselage top share F_TOP so spanwise seams / codes stay
# continuous across the wing-root joint.
F_SIDE = Zone((0, 0, 1024, 192), ('z', 'y'), ((-5.5, 5.2), (2.30, 0.70)))
F_TOP = Zone((0, 192, 1024, 672), ('z', 'x'), ((-5.5, 5.2), (-4.7, 4.7)))
F_BOT = Zone((0, 672, 1024, 880), ('z', 'x'), ((-5.5, 5.2), (-4.7, 4.7)))

F_CANOPY = Zone((0, 880, 320, 1008), ('z', 'y'), ((-3.60, -1.20),
                                                  (2.60, 1.90)))
F_FIN = Zone((320, 880, 576, 1008), ('z', 'y'), ((2.45, 4.70), (3.55, 1.60)))

F_MISSILE = (576, 880, 704, 944)          # parametric missile-body wrap
F_NOZZLE = (704, 880, 832, 944)           # parametric nozzle wrap
F_BURNER = Zone((832, 880, 896, 944), ('x', 'y'), ((-45, 45), (25, -5)))
F_GEAR = Zone((896, 880, 960, 944), ('z', 'y'), ((-45, 45), (25, -5)))
F_TRIM = Zone((960, 880, 1024, 944), ('z', 'y'), ((-45, 45), (25, -5)))
F_DARK = Zone((576, 944, 640, 1008), ('x', 'z'), ((-45, 45), (-45, 45)))
F_NAVP = Zone((640, 944, 704, 1008), ('z', 'y'), ((-45, 45), (25, -5)))
F_NAVS = Zone((704, 944, 768, 1008), ('z', 'y'), ((-45, 45), (25, -5)))
F_DUCT = Zone((768, 944, 832, 1008), ('z', 'y'), ((-45, 45), (25, -5)))

# ── fuselage loft: (z, w_chine, half_w_top, y_top, y_bot, y_chine) ──────
# first section is the OPEN nose intake lip; the duct loft closes it.
FUS_SECTIONS = [
    (-5.05, 0.36, 0.20, 1.70, 1.10, 1.40),
    (-4.30, 0.50, 0.28, 1.86, 0.98, 1.40),
    (-3.10, 0.60, 0.34, 1.98, 0.88, 1.40),
    (-1.40, 0.64, 0.36, 2.04, 0.84, 1.42),
    (0.60, 0.62, 0.34, 2.00, 0.86, 1.44),
    (2.50, 0.52, 0.28, 1.88, 1.00, 1.46),
    (4.30, 0.36, 0.18, 1.72, 1.22, 1.48),
]
INTAKE_Z = -4.55          # inner throat plane of the nose intake
INTAKE_SCALE = 0.55       # inner-lip shrink about the duct centre
INTAKE_Y = 1.40           # duct centre height

# dorsal spine fairing (canopy deck to fin root): (z, half_w, y_bot, y_top)
SPINE_SECTIONS = [
    (-1.20, 0.22, 1.96, 2.18),
    (0.80, 0.22, 1.92, 2.14),
    (2.60, 0.16, 1.80, 2.02),
    (4.00, 0.10, 1.66, 1.86),
]

# bubble canopy arch, well forward: (z, half_w, y_base, y_top)
CAN_SECTIONS = [
    (-3.50, 0.10, 1.94, 2.06),
    (-3.05, 0.34, 1.94, 2.42),
    (-2.40, 0.38, 1.94, 2.52),
    (-1.75, 0.32, 1.94, 2.34),
    (-1.30, 0.14, 1.94, 2.10),
]

# ── lifting surfaces: (span_x, y, z_le, z_te, thickness) ────────────────
# moderately swept mid wing; tip at exactly |x| = 4.50 ⇒ span 9.0 m.
# extra spanwise stations keep each top/bottom quad small so the impostor
# baker cannot flood a half-wing from one panel colour.
WING = [
    (0.45, 1.440, -1.75, 1.05, 0.26),
    (1.40, 1.455, -1.36, 0.95, 0.21),
    (2.40, 1.470, -0.95, 0.85, 0.16),
    (3.45, 1.485, -0.52, 0.72, 0.11),
    (4.50, 1.500, -0.08, 0.60, 0.07),
]
FIN = [                                   # single vertical fin; th along x
    (0.0, 1.70, 2.55, 4.60, 0.16),
    (0.0, 2.75, 3.45, 4.55, 0.10),
    (0.0, 3.40, 3.95, 4.50, 0.06),
]
TAILPLANE = [                             # low-set tailplane
    (0.28, 1.42, 3.35, 4.55, 0.14),
    (1.90, 1.45, 3.90, 4.50, 0.07),
]

# comms blade antenna on the spine: z0, z1, y_base, y_tip, sweep
BLADE = (-1.05, -0.75, 2.16, 2.50, 0.14)

# ── single nozzle: stations (z, radius, y) aft → fwd ────────────────────
NOZZLE_Y = 1.45
NOZZLE = [(4.90, 0.26, NOZZLE_Y), (4.55, 0.33, NOZZLE_Y),
          (4.10, 0.31, NOZZLE_Y)]
EXHAUST_OFF = (0.0, NOZZLE_Y, 4.94)

# ── chin gun tray + stub barrel (slot 1 autocannon) ─────────────────────
GUN_FAIRING = ((0.24, 1.02, -4.35), (0.26, 0.24, 1.10))   # center, size
GUN_X, GUN_Y = 0.24, 1.02
GUN_BARREL = [(-4.95, 0.050), (-5.30, 0.042)]             # (z, r)
GUN_MUZZLE = (GUN_X, GUN_Y, -5.34)

# ── stores: one AA missile rail per side (slot 2) ───────────────────────
# (span_x, pylon y_top, pylon y_bot, missile y, missile r, z_nose, z_tail)
PYLONS = [
    (2.20, 1.42, 1.22, 1.10, 0.13, -1.45, 0.75),
]
MUZZLE2 = (2.20, 1.10, -1.45)             # port (+x) rail tip

# wingtip nav boxes (±x)
NAV_TIP = (4.38, 1.50, 0.22)

# ── landing gear: (attach x,y,z), strut drop, wheel r, wheel half-width ─
# drop puts the wheel n-gon flat on Y=0: centre y = r·cos(π/8)
GEAR_N = ((0.0, 0.95, -3.40), 0.7467, 0.22, 0.08)
GEAR_M = ((1.30, 1.42, 0.30), 1.1798, 0.26, 0.10)         # mirrored for right

# amber formation-light strip on each wingtip upper skin (z0, z1, x0, x1)
TIP_LIGHT = (-0.02, 0.52, 4.28, 4.46)
