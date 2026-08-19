"""ms_ships_s1_layout — zones + dims for ms_ships_s1 (patrol boat flotilla).

Metalstorm ships row scale 1: a 20 m hard-chine planing fast attack craft,
squad of 4. Order register — formal haze-grey topsides, hull number stencil
on the bow flare, team colour only on small ID panels.

SILHOUETTE: OPEN AND LOW. No enclosed superstructure block, no funnel. A
wedge of open deck you can see across end to end: fine bow entry, chine
running the length with spray rails, flat run aft to a wide transom, an
open circular splinter-shield gun tub on the foredeck, and a minimal
wheelhouse amidships no taller than 1.6 m above the deck.

Waterline at Y = 0 (preamble §4); hull runs down to -1.4 m draft, deck top
~1.6 m, masthead ~5.5 m. Bow at -Z. 2048 atlas (20 m dominant dim).
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048 sq; v down) ───────────────────────────────────────
S_HULL_SIDE = Zone((0,    0,    2048, 340),  ('z', 'y'), ((-10.3, 10.3), (1.85, -1.5)))
S_DECK      = Zone((0,    340,  2048, 620),  ('z', 'x'), ((-10.3, 10.3), (-2.5, 2.5)))
S_BELLY     = Zone((0,    620,  2048, 880),  ('z', 'x'), ((-10.3, 10.3), (-2.5, 2.5)))
S_STERN     = Zone((0,    880,  460,  1200), ('x', 'y'), ((2.5, -2.5), (1.6, -1.4)))
S_WH_SIDE   = Zone((460,  880,  980,  1160), ('z', 'y'), ((-1.4, 1.9), (3.30, 1.40)))
S_WH_FRONT  = Zone((980,  880,  1400, 1160), ('x', 'y'), ((1.25, -1.25), (3.30, 1.40)))
S_WH_TOP    = Zone((1400, 880,  1820, 1160), ('x', 'z'), ((-1.25, 1.25), (-1.4, 1.9)))
S_TUB       = Zone((0,    1200, 560,  1440), ('x', 'y'), ((-1.3, 1.3), (2.25, 1.40)))
S_TUB_FLOOR = Zone((560,  1200, 1000, 1440), ('x', 'z'), ((-1.3, 1.3), (-7.35, -4.75)))
S_TURRET    = Zone((1000, 1200, 1420, 1440), ('x', 'y'), ((-0.9, 0.9), (1.05, -0.30)))
S_RACK      = Zone((1420, 1200, 1900, 1440), ('x', 'y'), ((-1.9, 1.9), (2.95, 1.35)))
S_DRUM      = Zone((0,    1460, 380,  1660), ('x', 'y'), ((0.45, 1.35), (2.55, 1.40)))
S_TRIM      = Zone((400,  1460, 700,  1660), ('z', 'y'), ((-11, 11), (6, -2)))
S_DARK      = Zone((720,  1460, 900,  1660), ('x', 'z'), ((-60, 60), (-60, 60)))
S_LIGHT     = Zone((920,  1460, 1080, 1620), ('x', 'z'), ((-60, 60), (-60, 60)))
S_BARREL    = (0,    1700, 512,  1830)   # parametric barrel wrap  (rect)
S_MAST      = (520,  1700, 900,  1830)   # mast / spray-rail wrap  (rect)
S_RAIL      = (910,  1700, 1290, 1830)   # railing wrap            (rect)
S_JET       = (1300, 1700, 1680, 1830)   # waterjet tunnel mouths  (rect)

# ── dims (world metres; waterline Y = 0, bow -Z) ────────────────────────
LENGTH = 20.0
# hard-chine sections: (z, y_keel, y_chine, y_deck, w_keel, w_chine, w_deck)
HULL_SECTIONS = [
    (-10.0,  0.35, 0.78, 1.72, 0.04, 0.07, 0.11),   # fine entry at the stem
    (-8.6,  -0.30, 0.34, 1.66, 0.30, 0.80, 1.02),
    (-6.6,  -0.85, 0.10, 1.62, 0.62, 1.50, 1.78),
    (-4.0,  -1.20, -0.02, 1.58, 0.92, 2.05, 2.28),
    (-0.5,  -1.38, -0.08, 1.56, 1.10, 2.30, 2.40),
    (3.5,   -1.40, -0.09, 1.54, 1.16, 2.36, 2.40),
    (7.0,   -1.34, -0.06, 1.52, 1.16, 2.36, 2.40),
    (10.0,  -1.22, -0.02, 1.50, 1.12, 2.32, 2.38),  # wide transom
]
WATERLINE = (-0.20, 0.34)      # boot-top band (below, above) — straddles Y=0
DECK_Y    = 1.56               # nominal deck height amidships

# spray rails: chine knuckle runs (z spans, mirrored to both sides)
SPRAY_RUNS = [(-8.4, -3.0), (-5.0, 4.0), (3.0, 9.6)]

# forward gun tub (open circular splinter shield) + autocannon
TUB_C      = (0.0, -6.0)       # x, z of the tub centre on the foredeck
TUB_R      = 1.15
TUB_FLOOR  = 1.60
TUB_TOP    = 2.12              # splinter-shield rim (low: deck stays visible)
TURRET_OFF = (0.0, 1.74, -6.0)
BARREL_LEN = 2.40
BARREL_R   = 0.085

# minimal wheelhouse amidships (roof 1.6 m above deck, no more)
WH_C       = (0.0, 2.36, 0.25)     # centre
WH_SIZE    = (2.20, 1.60, 2.50)    # w, h, d  -> z -1.0 .. +1.5
WH_ROOF_Y  = 3.16

# whip mast (plain pole) just aft of the wheelhouse + small nav radar
MAST_FOOT  = (0.0, 3.16, 1.85)
MAST_TOP   = (0.0, 5.18, 1.72)
RADAR_C    = (0.0, 5.34, 1.72)
RADAR_SZ   = (0.62, 0.30, 0.18)

# aft working deck: stowage + stern railing
RAIL_RUNS  = [((-2.05, 1.53, 4.4), (-2.05, 1.50, 9.4)),
              ((2.05, 1.53, 4.4), (2.05, 1.50, 9.4)),
              ((-2.05, 1.50, 9.4), (2.05, 1.50, 9.4))]

# waterjet tunnel mouths in the transom
JETS = [(-0.95, -0.62), (0.95, -0.62)]   # x, y
JET_R = 0.38
