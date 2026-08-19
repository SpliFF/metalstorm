"""ms_fighters_s4_layout — zones + dims for ms_fighters_s4.

s4 fighter per DESIGN-GUIDE (16 m span, ~17.4 m nose-to-nozzle, ~5.1 m tall).
"Air-dominance gunship — single heavy frame": a BLENDED-WING-BODY heavy
gunship. Broad cranked-arrow planform (55 deg inboard LE cranking to 32 deg
outboard), no hard wing/body join, a full-length dorsal weapons/avionics
spine, tandem two-seat canopy far forward over a broad flat-bottomed
forebody with a chin gun trough, twin outward-canted fins mounted on the
wing cranks, four buried engines (two shoulder intakes per side, four
nozzles in a row across a broad tail deck), heavy landing gear (twin-wheel
nose leg, two-wheel main bogies in belly sponsons).

Armament: slot 1 = fixed-forward chin autocannon (`muzzle` empty only);
slot 2 = a REAL traversing dorsal AA missile mount (turret2 ->
turret2_barrel -> turret2_muzzle), authored at rest pointing forward/level.

forward -Z, +Y up, wheels at Y=0, 2048^2 atlas.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048^2; v down) ─────────────────────────────────────────
# world-anchored body bands (uniform chord-wise density)
F_SIDE   = Zone((0,    0,    2048, 400),  ('z', 'y'), ((-9.6, 8.8), (3.90, 0.60)))
F_TOP    = Zone((0,    400,  2048, 1360), ('z', 'x'), ((-9.6, 8.8), (-8.30, 8.30)))
F_BOT    = Zone((0,    1360, 2048, 1760), ('z', 'x'), ((-9.6, 8.8), (-8.30, 8.30)))

# detail band (y 1760..2048)
F_CANOPY = Zone((0,    1760, 640,  1952), ('z', 'y'), ((-7.35, -4.30), (3.62, 2.55)))
F_FIN    = Zone((640,  1760, 1152, 1984), ('z', 'y'), ((2.40, 6.60), (5.15, 2.20)))
F_MISSILE= (1152, 1760, 1408, 1856)       # parametric missile-body wrap
F_NOZZLE = (1408, 1760, 1792, 1856)       # parametric nozzle wrap
F_BURNER = Zone((1792, 1760, 1920, 1856), ('x', 'y'), ((-45, 45), (25, -5)))
F_GEAR   = Zone((1920, 1760, 2048, 1856), ('z', 'y'), ((-45, 45), (25, -5)))
F_TRIM   = Zone((1152, 1856, 1280, 1952), ('z', 'y'), ((-45, 45), (25, -5)))
F_DARK   = Zone((1280, 1856, 1408, 1952), ('x', 'z'), ((-45, 45), (-45, 45)))
F_NAVP   = Zone((1408, 1856, 1536, 1952), ('z', 'y'), ((-45, 45), (25, -5)))
F_NAVS   = Zone((1536, 1856, 1664, 1952), ('z', 'y'), ((-45, 45), (25, -5)))
F_INTK   = Zone((1664, 1856, 1920, 1952), ('z', 'y'), ((-45, 45), (25, -5)))
F_TAIL   = Zone((1920, 1856, 2048, 1952), ('x', 'y'), ((-45, 45), (25, -5)))
# dorsal mount pieces are PIECE-LOCAL (they slew) -> their own local zones
T_SIDE   = Zone((0,    1952, 512,  2048), ('z', 'y'), ((-2.30, 0.90), (0.95, -0.45)))
T_TOP    = Zone((512,  1952, 1024, 2048), ('z', 'x'), ((-2.30, 0.90), (-0.95, 0.95)))
T_RAIL   = (1024, 1952, 1408, 2048)       # parametric dorsal-missile wrap
T_DARK   = Zone((1408, 1952, 1536, 2048), ('x', 'z'), ((-45, 45), (-45, 45)))
T_TRIM   = Zone((1536, 1952, 1664, 2048), ('z', 'y'), ((-45, 45), (25, -5)))

VERT_ZONES = [F_SIDE, F_CANOPY, F_FIN, F_INTK, T_SIDE]   # for weathering

# ── fuselage loft: (z, w_chine, half_w_top, y_top, y_bot, y_chine) ───────
# broad flat-bottomed BWB centre body — no hard join to the wing
FUS_SECTIONS = [
    (-9.00, 0.12, 0.06, 2.30, 2.10, 2.20),
    (-7.60, 0.85, 0.45, 2.65, 1.80, 2.20),
    (-5.80, 1.55, 0.85, 3.00, 1.55, 2.25),
    (-3.40, 2.20, 1.25, 3.15, 1.42, 2.25),
    (-0.80, 2.60, 1.45, 3.20, 1.38, 2.20),
    (2.00,  2.70, 1.50, 3.15, 1.38, 2.15),
    (4.60,  2.45, 1.35, 3.00, 1.45, 2.10),
    (6.60,  2.10, 1.15, 2.85, 1.55, 2.05),
    (7.90,  1.80, 1.00, 2.70, 1.70, 2.00),
]

# ── dorsal weapons/avionics spine: (z, half_w, y_top, y_bot) ─────────────
SPINE_SECTIONS = [
    (-4.60, 0.45, 3.30, 2.80),
    (-3.00, 0.85, 3.55, 2.80),
    (-0.50, 0.95, 3.66, 2.85),
    (2.20,  0.95, 3.66, 2.85),
    (4.80,  0.80, 3.48, 2.80),
    (7.20,  0.55, 3.15, 2.70),
]

# ── tandem two-seat canopy: (z, half_w, y_base, y_top) — two bows in line ─
CAN_SECTIONS = [
    (-7.20, 0.10, 2.63, 2.72),
    (-6.85, 0.46, 2.68, 3.28),
    (-6.45, 0.60, 2.76, 3.50),   # front bow crest
    (-6.05, 0.62, 2.84, 3.42),
    (-5.80, 0.58, 2.88, 3.30),   # dip between the bows
    (-5.50, 0.62, 2.92, 3.52),   # rear bow
    (-5.10, 0.66, 2.98, 3.54),
    (-4.75, 0.60, 3.04, 3.38),
    (-4.40, 0.26, 3.08, 3.18),
]

# ── blade surfaces: stations of (span_x, y, z_le, z_te, thickness) ───────
# CRANKED ARROW: 55 deg inboard LE -> 32 deg outboard panel. Root buried
# deep in the centre body (x 1.60, where the body is 1.55 m thick).
# extra intermediate stations keep the quads small enough that the impostor
# baker's per-triangle flat shading does not flood whole panels.
WING = [
    (1.60, 2.30, -4.40, 6.90, 0.90),
    (3.00, 2.31, -2.40, 6.62, 0.71),
    (4.60, 2.32, -0.12, 6.30, 0.50),   # the crank
    (5.90, 2.28,  0.69, 5.68, 0.37),
    (7.10, 2.24,  1.44, 5.10, 0.24),
    (8.00, 2.18,  2.00, 4.30, 0.12),
]
# twin fins on the wing cranks, canted ~25 deg outboard (thickness along x)
FIN = [
    (4.60, 2.35, 2.60, 6.20, 0.34),
    (5.40, 4.00, 3.60, 6.40, 0.20),
    (5.85, 5.00, 4.30, 6.45, 0.10),
]

# ── shoulder intakes: two mouths per side (cx, cy, cz, sx, sy, sz) ───────
INTAKES = [
    (1.95, 2.98, -0.40, 0.80, 0.60, 4.20),
    (3.05, 2.90,  0.50, 0.72, 0.56, 3.80),
]

# ── engines: broad aft deck + four nozzles in a row ──────────────────────
TAIL_DECK   = ((0.0, 2.10, 7.40), (4.05, 0.90, 1.80))
NOZZLE_XS   = (0.55, 1.55)                     # mirrored -> four nozzles
NOZZLE      = [(8.35, 0.30, 2.10), (8.05, 0.38, 2.10), (7.45, 0.35, 2.10)]
EXHAUST_OFF = (0.0, 2.10, 8.45)

# ── chin autocannon (slot 1, FIXED forward) ──────────────────────────────
GUN_TROUGH = ((0.0, 1.55, -6.00), (1.00, 0.56, 2.20))
GUN_TUBE   = [(-7.02, 0.13, 1.48), (-7.30, 0.115, 1.48), (-7.62, 0.10, 1.48)]
GUN_MUZZLE = (0.0, 1.48, -7.70)

# ── dorsal AA missile mount (slot 2, REAL aim chain) ─────────────────────
TUR2_OFF    = (0.0, 3.60, 1.10)     # ring mount on the spine (child of body)
TUR2_RING   = (0.88, 0.80, 0.36)    # r_base, r_top, height
TUR2_CHEEK  = (0.56, 0.30, 0.72, -0.55, 0.55)   # x, y0, y1, z0, z1
BARREL_OFF  = (0.0, 0.64, 0.0)      # elevation pivot (child of turret2)
BARREL_BOX  = ((0.0, 0.02, -0.62), (1.34, 0.46, 2.30))
RAIL_X      = 0.44
RAIL_MSL    = [(0.58, 0.15, 0.30), (0.35, 0.19, 0.30), (-1.55, 0.19, 0.30),
               (-1.86, 0.11, 0.30), (-1.98, 0.03, 0.30)]
MUZZLE2_OFF = (0.0, 0.30, -2.05)    # rail tips (child of turret2_barrel)

# ── landing gear: heavy. (attach xyz), drop, wheel r, half-width ─────────
# wheels are 8-gons: centre y = r*cos(pi/8) so the flat rests on Y=0
GEAR_N = ((0.0, 1.62, -5.60), 1.232, 0.42, 0.15)   # twin wheel nose leg
GEAR_M = ((2.00, 1.30, 2.10), 0.838, 0.50, 0.19)   # two-wheel main bogie
SPONSON = ((2.00, 1.70, 2.10), (1.10, 1.05, 3.70)) # belly gear fairing

# ── greebles ─────────────────────────────────────────────────────────────
PITOT     = (0.0, 2.20, -9.00)
ANTENNAS  = [(0.0, 3.66, -1.60), (0.0, 3.60, 4.20)]
NAV_TIP   = (7.85, 2.20, 3.10)                     # wingtip nav box (+-x)
CHAFF     = (0.0, 1.40, 5.60)
