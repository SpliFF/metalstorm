"""ms_fighters_s1_layout — zones + dims for ms_fighters_s1.

s1 interceptor DRONE per DESIGN-GUIDE (6 m span, ~5.6 m nose-to-nozzle,
~1.6 m tall on its gear). Tailless cropped-delta blended-wing-body: NO
cockpit canopy (a flush faceted EO sensor blister sits where the glass
would be), downturned anhedral wingtip fins instead of canted tail fins,
one flush dorsal intake feeding one nozzle, chin MG fairing with a stub
barrel. Fixed landing gear as separate pieces (gear_n / gear_l / gear_r).
Rests on its wheels at Y=0. forward -Z, 1024² atlas.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas zones (1024²; v down) ──────────────────────────────────────────
# world-anchored body bands, shared by fuselage AND lifting surfaces so
# spanwise seams / codes stay continuous across the blended wing root.
F_SIDE = Zone((0, 0,   1024, 160), ('z', 'y'), ((-3.60, 2.40), (1.55, 0.35)))
F_TOP  = Zone((0, 160, 1024, 672), ('z', 'x'), ((-3.60, 2.40), (-3.20, 3.20)))
F_BOT  = Zone((0, 672, 1024, 928), ('z', 'x'), ((-3.60, 2.40), (-3.20, 3.20)))

# small cells (flat huge-window projections → near-uniform swatches)
F_NOZZLE = (0, 928, 256, 1008)                     # parametric nozzle wrap
F_BARREL = (896, 928, 1024, 1008)                  # parametric MG barrel wrap
F_BURNER = Zone((256, 928, 352, 1024), ('x', 'y'), ((-45, 45), (25, -5)))
F_GEAR   = Zone((352, 928, 480, 1024), ('z', 'y'), ((-45, 45), (25, -5)))
F_TRIM   = Zone((480, 928, 640, 1024), ('z', 'y'), ((-45, 45), (25, -5)))
F_DARK   = Zone((640, 928, 736, 1024), ('x', 'z'), ((-45, 45), (-45, 45)))
F_BLIST  = Zone((736, 928, 896, 1024), ('z', 'y'), ((-2.95, -1.45),
                                                    (1.52, 1.12)))

# ── dims (world metres; wheels at Y=0, nose -Z) ──────────────────────────
# fuselage loft sections: (z, w_chine, half_w_top, y_top, y_bot, y_chine)
FUS_SECTIONS = [
    (-3.40, 0.08, 0.04, 0.92, 0.86, 0.89),
    (-2.80, 0.34, 0.16, 1.06, 0.74, 0.90),
    (-1.90, 0.62, 0.30, 1.20, 0.62, 0.90),
    (-0.60, 0.80, 0.40, 1.28, 0.58, 0.90),
    (0.80,  0.82, 0.42, 1.26, 0.58, 0.90),
    (2.05,  0.60, 0.30, 1.14, 0.66, 0.92),
]

# cropped-delta lifting surface: (span_x, y, z_le, z_te, thickness)
# root buried inside the chine (|x| 0.50 < chine 0.62..0.82) per the bury rule
# extra spanwise stations keep each top/bottom quad small, so the impostor
# baker (flat-shades per triangle from the diffuse at its UV centroid) cannot
# flood a whole half-wing with one panel colour.
WING = [
    (0.50, 0.93, -2.20, 1.90, 0.32),
    (1.05, 0.935, -1.50, 1.845, 0.25),
    (1.55, 0.94, -0.86, 1.80, 0.20),
    (2.05, 0.945, -0.22, 1.70, 0.15),
    (2.55, 0.95, 0.42,  1.60, 0.10),
]
# downturned anhedral tip fin (~35° below horizontal) — the yaw surface.
TIPFIN = [
    (2.55, 0.95, 0.42, 1.60, 0.10),
    (2.78, 0.79, 0.57, 1.55, 0.08),
    (3.00, 0.63, 0.72, 1.50, 0.06),
]

# flush dorsal intake: (z, half_w, y_bot, y_top) — bottoms buried in the deck
INTAKE_SECTIONS = [
    (-0.95, 0.16, 1.22, 1.27),
    (-0.35, 0.32, 1.24, 1.44),
    (0.60,  0.34, 1.23, 1.45),
    (1.35,  0.24, 1.16, 1.32),
]

# faceted EO sensor blister (where a manned fighter's canopy would be):
# (z, half_w, y_bot, y_top)
BLISTER_SECTIONS = [
    (-2.86, 0.05, 1.10, 1.14),
    (-2.55, 0.20, 1.12, 1.30),
    (-2.05, 0.24, 1.16, 1.34),
    (-1.62, 0.13, 1.20, 1.26),
]

# comms blade antenna: base z0/z1, y_base, y_tip, sweep
BLADE = (-1.30, -1.02, 1.255, 1.60, 0.16)

# single nozzle: stations (z, radius) aft→fwd, centred on the spine
NOZZLE_Y = 0.90
NOZZLE = [(2.22, 0.28, NOZZLE_Y), (1.80, 0.34, NOZZLE_Y),
          (1.35, 0.31, NOZZLE_Y)]
EXHAUST_OFF = (0.0, NOZZLE_Y, 2.26)

# chin MG fairing + stub barrel
MG_BOX = ((0.0, 0.66, -2.50), (0.30, 0.22, 1.00))       # center, size
MG_BARREL = [(-2.98, 0.052), (-3.26, 0.044)]            # (z, r) at MG_Y
MG_Y = 0.63
GUN_MUZZLE = (0.0, 0.63, -3.30)

# landing gear: (attach x, y, z), strut drop, wheel r, wheel half-width
GEAR_N = ((0.0, 0.62, -1.70), 0.49, 0.15, 0.05)
GEAR_M = ((0.55, 0.72, 0.55), 0.59, 0.15, 0.06)          # mirrored for left

# formation-light strip on each downturned tip (world z span at |x| ~2.8)
TIP_LIGHT = (1.06, 1.44, 2.76, 2.97)                     # z0, z1, x0, x1
