"""ms_radar_s4_layout — zones + dims for ms_radar_s4 (Theatre Surveillance Complex).

STYLE.md radar row: s4 height = 11 m; spec tri budget <=2000.
Same family as ms_radar_s1 / ms_comms_relay (anchored concrete, ARMOR-grey
field hardware, galvanised mast, amber-only emissive) but a different
silhouette class: a battered bunker plinth carrying a faceted GEODESIC
RADOME beside a tall braced mast whose head carries a long rotating
SEARCH ARRAY BAR (`dish` — the only animated piece, idle clip).

World frame: blast door faces -Z, up +Y, ground Y=0.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas zones (1024²; v down) ──────────────────────────────────────────
# plinth
R_PL_TOP = Zone((0,   0,   384,  384), ('x', 'z'), ((-3.3, 3.3), (-3.3, 3.3)))
R_PL_F   = Zone((0,   384, 384,  512), ('x', 'y'), ((-3.3, 3.3), (1.80, -0.04)))
R_PL_S   = Zone((0,   512, 384,  640), ('z', 'y'), ((-3.3, 3.3), (1.80, -0.04)))
# geodesic radome facet cells: 4 cols x 3 rows of 128 px in (384,0)-(896,384)
DOME_CELL_ORIGIN = (384, 0)
DOME_CELL        = 128
DOME_COLS        = 4
DOME_ROWS        = 3
DOME_REPAIR_CELL = 11               # the one mismatched replacement panel
# parametric wraps (raw rects — limb/lattice)
R_MAST   = (896, 0,   1024, 128)
R_TRIM   = (896, 128, 1024, 256)
R_GUY    = (896, 256, 1024, 320)
R_COLLAR = (896, 320, 1024, 384)
R_SKIRT  = (384, 512, 640,  640)
R_VENT   = (896, 640, 1024, 768)
# zoned cells
R_DOOR   = Zone((384, 384, 640,  512), ('x', 'y'), ((-1.62, -0.02), (1.60, -0.02)))
R_BAG    = Zone((640, 384, 896,  512), ('x', 'y'), ((0.0, 3.0), (0.70, -0.02)))
R_NEST   = Zone((640, 512, 896,  640), ('x', 'z'), ((-0.8, 0.8), (-0.8, 0.8)))
R_DARK   = Zone((896, 384, 1024, 512), ('x', 'z'), ((-1, 1), (-1, 1)))
R_LIGHT  = Zone((896, 512, 1024, 640), ('x', 'y'), ((-0.14, 0.14), (0.14, -0.14)))
R_CONC   = Zone((896, 768, 1024, 896), ('x', 'z'), ((-1.6, 1.6), (-0.4, 0.4)))
# search array bar (piece-local coords)
R_BAR_F  = Zone((0,   640, 768,  768), ('x', 'y'), ((-1.85, 2.95), (0.82, 0.28)))
R_BAR_B  = Zone((0,   768, 768,  896), ('x', 'y'), ((-1.85, 2.95), (0.82, 0.28)))
R_BAR_T  = Zone((0,   896, 768,  960), ('x', 'z'), ((-1.85, 2.95), (-0.17, 0.17)))
R_BAR_U  = Zone((0,   960, 768, 1024), ('x', 'z'), ((-1.85, 2.95), (-0.17, 0.17)))
R_BAR_E  = Zone((768, 640, 896,  768), ('z', 'y'), ((-0.17, 0.17), (0.82, 0.28)))
R_CW     = Zone((768, 768, 896,  896), ('x', 'y'), ((-2.02, -1.36), (0.92, 0.18)))
R_SPINE  = Zone((896, 896, 1024, 1024), ('x', 'y'), ((-1.85, 2.95), (0.95, 0.26)))

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
PL_HALF_B = 3.30                    # battered plinth: half-width at ground
PL_HALF_T = 3.02                    # ... and at the top of the batter
PL_H      = 1.60                    # batter height
PL_CAP_Y  = 1.68                    # cap slab centre
PL_TOP    = 1.76                    # working deck level

DOME_X, DOME_Z = 1.15, -0.15
DOME_R    = 2.05                    # 4.1 m radome diameter
DOME_SKIRT_TOP = 2.13               # skirt band top = hemisphere equator
DOME_TOP  = DOME_SKIRT_TOP + DOME_R  # 4.18 m
DOME_LATS = (0.0, 21.0, 42.0, 63.0, 78.0)
DOME_N    = 12

MAST_X, MAST_Z = -1.95, 0.15
MAST_TOP  = 9.35                    # lattice head
MAST_HB   = 0.45                    # half-width at the deck
MAST_HT   = 0.17                    # half-width at the head
NEST_Y    = 6.90                    # crow's-nest platform
GUY_Y     = 6.75                    # guy collar on the mast
GUY_R     = 2.80                    # guy anchors, clamped onto the deck
LAMP_Y    = 9.42                    # aircraft-warning lamp at the mast head

DISH_OFF  = (MAST_X, 9.50, MAST_Z)  # slew-collar pivot
BAR_X0, BAR_X1 = -1.30, 2.80        # main beam run (local X)
BAR_Y     = 0.55                    # beam centre (local)
BAR_H, BAR_D = 0.45, 0.30
CW_X      = -1.69                   # counterweight centre (local)
WHIP_X    = 2.62                    # whip antenna base (local)
WHIP_TOP  = 1.50                    # local; world 11.00 m — dominant dim
