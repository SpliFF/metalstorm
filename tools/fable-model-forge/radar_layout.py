"""radar_layout — zones + dims for ms_radar_s1 (Field sensor mast).

STYLE.md radar row: s1 height (mast+dish) = 4 m, ≤2000 tris. Immobile
footprint-2 building: small anchored pad, equipment cabinet with status
lights, guyed lattice mast, rotating open dish on a yoke (the `dish`
piece — the only animated part, idle clip).
World frame: cabinet faces -Z, up +Y, ground Y=0.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas zones (1024²; v down) ──────────────────────────────────────────
R_PAD    = Zone((0,   0,   448,  448), ('x', 'z'), ((-1.9, 1.9), (-1.9, 1.9)))
R_PADS   = Zone((0,   448, 448,  512), ('z', 'y'), ((-1.9, 1.9), (0.28, -0.02)))
R_PADS_F = Zone((0,   448, 448,  512), ('x', 'y'), ((-1.9, 1.9), (0.28, -0.02)))
R_CAB    = Zone((448, 0,   832,  320), ('z', 'y'), ((-0.65, 0.65), (1.45, 0.25)))
R_CAB_F  = Zone((448, 0,   832,  320), ('x', 'y'), ((-0.65, 0.65), (1.45, 0.25)))
R_CAB_T  = Zone((832, 0,   1024, 192), ('x', 'z'), ((-0.65, 0.65), (-0.65, 0.65)))
R_MAST   = (448, 320, 832,  448)   # parametric mast/strut wrap
R_DISH   = Zone((0,   512, 448,  960), ('x', 'z'), ((-0.75, 0.75), (-0.75, 0.75)))
R_DISH_B = Zone((448, 512, 896,  960), ('x', 'z'), ((-0.75, 0.75), (-0.75, 0.75)))
R_YOKE   = (832, 192, 1024, 320)   # parametric yoke/feed wrap
R_TRIM   = (896, 512, 1024, 640)   # parametric small-part wrap
R_DARK   = Zone((896, 640, 1024, 768), ('x', 'z'), ((-1, 1), (-1, 1)))
R_LIGHT  = Zone((896, 768, 1024, 896), ('x', 'y'), ((-0.1, 0.1), (0.1, -0.1)))

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
PAD      = (0.0, 0.13, 0.0, 3.8, 0.26, 3.8)
PAD_TOP  = 0.26
CABINET  = (0.55, PAD_TOP + 0.6, -0.55, 1.3, 1.2, 1.3)
MAST_X, MAST_Z = -0.55, 0.45
MAST_TOP = 3.30                     # yoke pivot height; dish tip reaches ~4.0
DISH_R   = 0.75
DISH_OFF = (MAST_X, MAST_TOP, MAST_Z)
