"""ms_comms_relay_layout — zones + dims for ms_comms_relay (Comms relay mast).

STYLE.md radar row: s2 height (mast+dish) = 6 m; spec tri budget ≤1200.
Follows ms_radar_s1 design language one size up: larger anchored pad,
walk-in equipment shelter, guyed lattice mast (three splayed legs + three
guy cables), and a rotating twin-dish cross-arm at the mast head (the
`dish` piece — the only animated part, idle clip) under an amber
aircraft-warning beacon (the only emissive, per spec).
World frame: shelter faces -Z, up +Y, ground Y=0.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas zones (1024²; v down) ──────────────────────────────────────────
R_PAD    = Zone((0,   0,   448,  448), ('x', 'z'), ((-2.5, 2.5), (-2.5, 2.5)))
R_PADS   = Zone((0,   448, 448,  512), ('z', 'y'), ((-2.5, 2.5), (0.32, -0.02)))
R_PADS_F = Zone((0,   448, 448,  512), ('x', 'y'), ((-2.5, 2.5), (0.32, -0.02)))
R_CAB    = Zone((448, 0,   832,  320), ('z', 'y'), ((-0.85, 0.85), (1.90, 0.28)))
R_CAB_F  = Zone((448, 0,   832,  320), ('x', 'y'), ((-0.85, 0.85), (1.90, 0.28)))
R_CAB_T  = Zone((832, 0,   1024, 192), ('x', 'z'), ((-0.85, 0.85), (-0.85, 0.85)))
R_MAST   = (448, 320, 832,  448)   # parametric mast/leg wrap
R_DISH   = Zone((0,   512, 448,  960), ('z', 'y'), ((-0.66, 0.66), (0.90, -0.46)))
R_DISH_B = Zone((448, 512, 896,  960), ('z', 'y'), ((-0.66, 0.66), (0.90, -0.46)))
R_YOKE   = (832, 192, 1024, 320)   # parametric sleeve/cross-arm wrap
R_TRIM   = (896, 512, 1024, 640)   # parametric small-part wrap
R_GUY    = (896, 640, 1024, 704)   # parametric guy-cable wrap
R_DARK   = Zone((896, 704, 1024, 832), ('x', 'z'), ((-1, 1), (-1, 1)))
R_LIGHT  = Zone((896, 832, 1024, 960), ('x', 'y'), ((-0.15, 0.15), (0.15, -0.15)))

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
PAD      = (0.0, 0.15, 0.0, 5.0, 0.30, 5.0)
PAD_TOP  = 0.30
CABINET  = (0.85, PAD_TOP + 0.775, -0.85, 1.7, 1.55, 1.7)
MAST_X, MAST_Z = -0.75, 0.65
MAST_TOP = 5.70                     # pole top; beacon tip reaches ~5.94
LEG_R    = 0.75                     # leg splay radius at the pad
LEG_TOP  = 3.10                     # legs meet the pole here
BRACE_Y  = 1.95                     # cross braces meet the pole here
GUY_Y    = 4.40                     # guy-cable collar on the pole
GUY_R    = 2.30                     # guy anchor radius (clamped to pad)
DISH_R   = 0.60                     # link-dish radius
ARM_HALF = 0.85                     # cross-arm half-length
DISH_OFF = (MAST_X, 4.95, MAST_Z)   # dish-piece pivot (mast head)
BEACON_Y = 5.82                     # beacon centre height
