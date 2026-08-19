"""ms_fighters_s3_layout — zones + dims for the s3 Heavy Fighter.

Twin-engine, twin-boom heavy interceptor. 12 m span, ~14.5 m nose-to-nozzle,
4.0 m to the fin tips. Two widely-separated nacelle booms at |x| = 2.20 each
with its own intake mouth and nozzle, a short central pod between them with a
big single-piece bubble canopy well forward, a pointed radome, a dorsal spine
fairing, a trapezoidal shoulder wing with forward-swept inboard trailing edge,
twin outward-canted fins (one per boom) joined by a tailplane, two underwing
missile pylons per side, wide-track landing gear (mains in the booms).

Frame: -Z forward, +Y up, wheels at Y=0, 1 unit = 1 m. 1024 atlas.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas zones (1024²; v down) ─────────────────────────────────────────
# three world-anchored body bands, uniform chord-wise density
F_SIDE = Zone((0, 0, 1024, 208), ('z', 'y'), ((-8.4, 6.6), (4.30, 0.10)))
F_TOP = Zone((0, 208, 1024, 672), ('z', 'x'), ((-8.4, 6.6), (-6.4, 6.4)))
F_BOT = Zone((0, 672, 1024, 880), ('z', 'x'), ((-8.4, 6.6), (-6.4, 6.4)))

F_CANOPY = Zone((0, 880, 320, 1008), ('z', 'y'), ((-6.75, -3.85), (3.35, 2.45)))
F_FIN = Zone((320, 880, 576, 1008), ('z', 'y'), ((2.95, 5.75), (4.15, 2.25)))

F_MISSILE = (576, 880, 704, 944)          # parametric missile-body wrap
F_NOZZLE = (704, 880, 832, 944)           # parametric nozzle wrap
F_BURNER = Zone((832, 880, 896, 944), ('x', 'y'), ((-45, 45), (25, -5)))
F_GEAR = Zone((896, 880, 960, 944), ('z', 'y'), ((-45, 45), (25, -5)))
F_TRIM = Zone((960, 880, 1024, 944), ('z', 'y'), ((-45, 45), (25, -5)))
F_DARK = Zone((576, 944, 640, 1008), ('x', 'z'), ((-45, 45), (-45, 45)))
F_NAVP = Zone((640, 944, 704, 1008), ('z', 'y'), ((-45, 45), (25, -5)))
F_NAVS = Zone((704, 944, 768, 1008), ('z', 'y'), ((-45, 45), (25, -5)))
F_DUCT = Zone((768, 944, 832, 1008), ('z', 'y'), ((-45, 45), (25, -5)))

# ── central pod loft: (z, w_chine, half_w_top, y_top, y_bot, y_chine) ──
POD_SECTIONS = [
    (-8.00, 0.08, 0.04, 2.30, 2.18, 2.24),
    (-7.10, 0.36, 0.16, 2.48, 1.96, 2.22),
    (-6.20, 0.62, 0.30, 2.66, 1.78, 2.22),
    (-5.00, 0.76, 0.38, 2.76, 1.66, 2.22),
    (-3.40, 0.80, 0.40, 2.80, 1.60, 2.20),
    (-1.40, 0.78, 0.38, 2.76, 1.62, 2.18),
    (0.80, 0.72, 0.35, 2.68, 1.70, 2.14),
    (2.60, 0.60, 0.28, 2.54, 1.86, 2.10),
    (4.60, 0.40, 0.18, 2.36, 2.06, 2.06),
]

# dorsal spine fairing: (z, half_w, y_bot, y_top)
SPINE_SECTIONS = [
    (-3.60, 0.30, 2.58, 2.86),
    (-1.00, 0.32, 2.56, 2.94),
    (2.00, 0.28, 2.46, 2.80),
    (5.00, 0.16, 2.26, 2.52),
]

# bubble canopy arch: (z, half_w, y_base, y_top)
CAN_SECTIONS = [
    (-6.60, 0.10, 2.60, 2.66),
    (-6.10, 0.42, 2.66, 3.05),
    (-5.40, 0.52, 2.72, 3.22),
    (-4.60, 0.50, 2.76, 3.18),
    (-4.00, 0.34, 2.78, 2.92),
]

# ── engine booms (right-hand side; mirrored) ───────────────────────────
BOOM_X = 2.20
# (z, w_chine, half_w_top, y_top, y_bot, y_chine) in boom-local x
BOOM_SECTIONS = [
    (-4.70, 0.60, 0.42, 2.52, 1.42, 1.97),
    (-3.60, 0.66, 0.46, 2.62, 1.36, 1.99),
    (-1.00, 0.68, 0.48, 2.66, 1.32, 1.99),
    (1.80, 0.66, 0.46, 2.64, 1.34, 1.99),
    (4.00, 0.62, 0.44, 2.62, 1.42, 1.99),
    (5.20, 0.50, 0.34, 2.56, 1.60, 1.99),
]
INTAKE_Z = -4.15          # inner lip plane of the intake funnel
INTAKE_SCALE = 0.62       # inner-lip shrink about the duct centre
INTAKE_Y = 1.97

# nozzle tube stations (aft -> fwd), y offset = boom centreline
NOZZLE = [(6.10, 0.30, 1.99), (5.75, 0.38, 1.99), (5.10, 0.46, 1.99)]
EXHAUST_OFF = (0.0, 1.99, 6.40)

# ── lifting surfaces: (span_x, y, z_le, z_te, thickness) ───────────────
WING = [
    (0.45, 2.45, -2.60, 1.10, 0.34),
    (2.20, 2.46, -2.05, 0.40, 0.28),
    (4.10, 2.48, -1.50, -0.10, 0.18),
    (6.00, 2.50, -0.95, -0.20, 0.10),
]
FIN = [                                   # canted; thickness along x
    (2.15, 2.40, 3.10, 5.60, 0.20),
    (2.78, 4.00, 4.00, 5.55, 0.09),
]
TAILPLANE = [                             # spans boom-to-boom
    (0.00, 2.44, 4.30, 5.50, 0.22),
    (2.30, 2.46, 4.35, 5.45, 0.16),
]

# ── stores: two pylons per side ────────────────────────────────────────
# (span_x, pylon y_top, pylon y_bot, missile y, missile r, z_nose, z_tail)
PYLONS = [
    (3.05, 2.36, 2.22, 2.08, 0.15, -2.60, 0.55),
    (4.75, 2.42, 2.28, 2.14, 0.13, -2.25, 0.45),
]
MUZZLE2 = (3.05, 2.08, -2.60)             # port (+x) forward rail tip

# wingtip nav boxes (±x)
NAV_TIP = (5.92, 2.50, -0.55)

# ── nose gun ───────────────────────────────────────────────────────────
GUN_FAIRING = ((0.40, 1.62, -6.10), (0.36, 0.34, 1.60))
GUN_MUZZLE = (0.40, 1.62, -6.95)

# ── landing gear: (attach, strut drop, wheel r, wheel half-width) ──────
GEAR_N = ((0.0, 1.66, -4.40), 1.4198, 0.26, 0.09)
GEAR_M = ((BOOM_X, 1.34, 0.60), 1.0259, 0.34, 0.12)

# ── greebles ───────────────────────────────────────────────────────────
PITOT = (0.0, 2.24, -7.95)
CHAFF = (0.0, 1.74, 3.40)
