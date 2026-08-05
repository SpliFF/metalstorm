"""ms_oil_derrick_layout — zones + dims for ms_oil_derrick (resource site).

Named resource site: 18 m lattice oil derrick + beam-balanced nodding-donkey
pump (`beam` is the only animated piece — idle nod clip), wellhead manifold,
small doghouse shed, oil-stained ground plate. Tri budget 1500.
World frame: forward -Z, up +Y, ground Y=0. Derrick stands left (-X), pump
right (+X) with the horsehead over the wellhead at the front (-Z).
Dominant dim >= 15 m -> 2048 atlas (civkit precedent).
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
R_PLATE_T  = Zone((0,    0,    1152, 832),  ('x', 'z'), ((-7.2, 7.2), (-5.2, 5.2)))
R_PLATE_SX = Zone((0,    832,  1152, 896),  ('z', 'y'), ((-5.2, 5.2), (0.30, -0.02)))
R_PLATE_SZ = Zone((0,    896,  1152, 960),  ('x', 'y'), ((-7.2, 7.2), (0.30, -0.02)))
R_LATTICE  = (1152, 0,    1664, 192)   # parametric derrick leg/girt/brace wrap
R_POST     = (1152, 192,  1664, 320)   # parametric samson-post / skid wrap
R_PIPE     = (1152, 320,  1664, 448)   # parametric manifold pipe wrap
R_WELL     = (1152, 448,  1664, 576)   # parametric wellhead stack wrap
R_DOG_S    = Zone((0,    960,  640,  1280), ('z', 'y'), ((2.6, 5.0), (2.95, 0.1)))
R_DOG_F    = Zone((640,  960,  1152, 1280), ('x', 'y'), ((-4.7, -1.3), (2.95, 0.1)))
R_DOG_R    = Zone((1152, 960,  1600, 1280), ('x', 'z'), ((-4.85, -1.15), (2.45, 5.15)))
R_CROWN_S  = Zone((1664, 0,    1920, 128),  ('z', 'y'), ((-1.0, 1.0), (18.1, 17.2)))
R_CROWN_F  = Zone((1664, 0,    1920, 128),  ('x', 'y'), ((-4.2, -2.2), (18.1, 17.2)))
R_CROWN_T  = Zone((1664, 128,  1920, 256),  ('x', 'z'), ((-4.2, -2.2), (-1.0, 1.0)))
R_BEAM_S   = Zone((0,    1280, 768,  1408), ('z', 'y'), ((-3.1, 2.3), (0.5, -0.55)))
R_BEAM_T   = Zone((0,    1408, 768,  1472), ('z', 'x'), ((-3.1, 2.3), (-0.25, 0.25)))
R_HEAD     = Zone((768,  1280, 1024, 1472), ('z', 'y'), ((-3.1, -2.3), (0.65, -0.9)))
R_CWT      = Zone((1024, 1280, 1280, 1472), ('z', 'y'), ((1.45, 2.25), (0.75, -0.65)))
R_VALVE    = Zone((1664, 256,  1920, 384),  ('z', 'y'), ((-45, 45), (25, -5)))
R_GEAR     = Zone((1664, 384,  1920, 512),  ('z', 'y'), ((-45, 45), (25, -5)))
R_STEELG   = Zone((1664, 512,  1920, 640),  ('z', 'y'), ((-45, 45), (25, -5)))
R_TRIM     = (1920, 0,    2048, 128)   # parametric small-part wrap
R_DARK     = Zone((1920, 128,  2048, 256),  ('x', 'z'), ((-45, 45), (-45, 45)))

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
PLATE     = (0.0, 0.14, 0.0, 14.4, 0.28, 10.4)   # oil-stained ground plate
PLATE_TOP = 0.28

# derrick: square lattice tower, legs splay base->top; crown tops out at 18 m
DERRICK_C = (-3.2, 0.0)                # x, z of tower axis
BASE_H, TOP_H = 2.3, 0.55              # half-widths at base / top
TOP_Y     = 17.3                       # leg top (crown platform sits above)
GIRT_YS   = (4.6, 9.0, 13.2)           # horizontal girt levels
LEG_R0, LEG_R1 = 0.15, 0.09
GIRT_R, BRACE_R = 0.055, 0.045
CROWN     = (-3.2, 17.5, 0.0, 1.6, 0.4, 1.6)     # crown platform box
SHEAVE    = (-3.2, 17.85, 0.0, 0.5, 0.3, 0.95)   # crown-block sheave housing (top = 18.0)

# nodding-donkey pump (beam-balanced): samson post + pivoting walking beam
PUMP_X, POST_Z = 3.4, -0.2
POST_TOP  = 2.55                       # A-frame apex
BEAM_OFF  = (3.4, 2.72, -0.2)          # `beam` piece pivot (saddle bearing)
BEAM_BOX  = (0.0, 0.08, -0.3, 0.34, 0.5, 4.5)    # beam-local
HEAD_BOX  = (0.0, -0.12, -2.7, 0.5, 1.2, 0.6)    # horsehead (front, -Z)
CWT_BOX   = (0.0, 0.05, 1.85, 0.95, 1.15, 0.6)   # tail counterweight
BEARING   = (0.0, -0.22, 0.0, 0.42, 0.3, 0.55)
GEAR_SKID = (3.4, 0.37, 1.7, 1.6, 0.18, 1.9)
GEARBOX   = (3.4, 1.0, 1.55, 1.1, 0.8, 1.2)
MOTOR     = (2.95, 0.72, 2.3, 0.55, 0.5, 0.75)

# wellhead + manifold (under the horsehead)
WELL_X, WELL_Z = 3.4, -2.75
HEADER_X  = 5.0                        # manifold header line
RISER_ZS  = (WELL_Z - 0.45, WELL_Z + 0.45)

# doghouse shed (rear-left corner of the plate)
DOG       = (-3.0, 1.53, 3.8, 3.2, 2.5, 2.2)
DOG_ROOF  = (-3.0, 2.86, 3.8, 3.5, 0.16, 2.5)
DOG_STEP  = (-3.0, 0.37, 2.55, 1.0, 0.18, 0.5)
DOG_VENT  = (-4.1, 4.4)                # roof vent pipe x, z

# idle nod clip
NOD_PERIOD, NOD_AMP = 6.0, 6.0         # seconds, degrees about +X
