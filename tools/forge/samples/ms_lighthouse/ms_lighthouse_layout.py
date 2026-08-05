"""ms_lighthouse_layout — zones + dims for ms_lighthouse (coastal lighthouse).

Building, ~22 m tapered masonry-and-steel tower on a rock plinth: gallery +
lamp room at the top with rotating light (piece `light`, very slow Y idle
loop), keeper hut at the base, prefab ladder + gallery railing. Weathered
whitewash with a faded stripe band; team colour on a door panel + one stripe
segment. World frame: door faces -Z, up +Y, ground Y=0. ATLAS 2048 (22 m).
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
R_ROCK_T  = Zone((0,    0,    600,  600),  ('x', 'z'), ((-4.3, 4.3), (-4.3, 4.3)))
R_ROCK_S  = Zone((600,  0,    1400, 220),  ('x', 'y'), ((-4.3, 4.3), (1.35, -0.05)))
R_ROCK_S2 = Zone((600,  0,    1400, 220),  ('z', 'y'), ((-4.3, 4.3), (1.35, -0.05)))
R_HUT_S   = Zone((0,    600,  560,  900),  ('z', 'y'), ((-2.1, 0.4), (3.35, 1.25)))
R_HUT_F   = Zone((0,    900,  560,  1200), ('x', 'y'), ((1.3, 4.1), (3.35, 1.25)))
R_HUT_T   = Zone((560,  600,  1060, 1000), ('x', 'z'), ((1.0, 4.4), (-2.5, 0.8)))
R_TOW_LO  = (0,    1300, 1024, 1750)   # tower lower wrap (whitewash)
R_TOW_MID = (0,    1750, 1024, 1930)   # tower stripe band wrap (faded stripe)
R_TOW_UP  = (1024, 1300, 2048, 1650)   # tower upper wrap (whitewash)
R_GALL    = (1024, 1650, 1648, 1780)   # gallery drum rim wrap
R_GALL_T  = Zone((1060, 600,  1560, 1100), ('x', 'z'), ((-1.95, 1.95), (-1.95, 1.95)))
R_GLASS   = (600,  220,  1500, 520)    # lamp-room glazing wrap
R_ROOF    = (1024, 1780, 1900, 1960)   # roof cone wrap
R_TRIMR   = (1560, 600,  2048, 720)    # ladder / railing / mast galvanised wrap
R_DARK    = Zone((1560, 720,  1800, 900),  ('x', 'z'), ((-1, 1), (-1, 1)))
R_HOUS    = Zone((1560, 900,  1800, 1140), ('x', 'y'), ((-0.4, 0.4), (0.5, -0.4)))
R_LENS    = Zone((1560, 1140, 1860, 1440), ('x', 'y'), ((-0.3, 0.3), (0.35, -0.35)))
R_RED     = Zone((1860, 900,  2010, 1050), ('x', 'y'), ((-0.12, 0.12), (0.12, -0.12)))

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
ROCK_LO   = (0.0, 0.45, 0.0, 8.6, 0.90, 8.6)     # lower plinth block
ROCK_HI   = (0.15, 1.05, -0.2, 7.6, 0.55, 7.6)   # upper plinth block
PLINTH_Y  = 1.30                                 # plinth top surface
HUT       = (2.70, 2.25, -0.90, 2.4, 1.9, 2.2)   # keeper hut (door -Z)
HUT_ROOF  = (2.70, 3.28, -0.90, 2.8, 0.18, 2.6)
TOW_BASE_Y, TOW_MID0_Y, TOW_MID1_Y, TOW_TOP_Y = 1.20, 10.0, 13.5, 17.8
TOW_R = {1.20: 2.00, 10.0: 1.45, 13.5: 1.28, 17.8: 1.15}
GALL_R, GALL_Y0, GALL_Y1 = 1.85, 17.8, 18.2      # gallery drum
RAIL_R, RAIL_H = 1.70, 0.95                      # gallery railing octagon
GLASS_Y0, GLASS_Y1 = 18.2, 20.0                  # lamp room glazing
ROOF_Y0, ROOF_Y1 = 20.0, 21.35                   # roof cone
BEACON_Y = 21.55                                 # red aux beacon centre
LIGHT_OFF = (0.0, 19.10, 0.0)                    # rotating light pivot
LADDER_BASE = (-2.35, 1.30, 0.0)
LADDER_TOP  = (-1.55, 17.8, 0.0)
