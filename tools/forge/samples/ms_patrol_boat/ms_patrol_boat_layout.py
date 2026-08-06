"""ms_patrol_boat_layout — zones + dims for ms_patrol_boat (PB Vigil).

s1 ships-row 20 m fast patrol launch, beam ~4.6 m. Order register:
crisp haze-grey topsides, numbered, uniform. Waterline at Y=0 (hull
runs below to ~0.9 m draft), painted boot-top band per ms_landing_ship.
Forward = -Z (bow). Planing hull: hard chine loft with spray rails,
open gun ring forward carrying the standard turret/barrel/muzzle
autocannon chain, small wheelhouse midships (emissive window band),
mast + `flag` whip aft of the wheelhouse (idle clip sway), rear
equipment rack (crates, drums, tarp) inside a stern railing.
2048 atlas (20 m dominant dim >= 15 m).
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048 sq; v down) ───────────────────────────────────────
S_HULL_SIDE = Zone((0,    0,    2048, 300),  ('z', 'y'), ((-10.2, 10.2), (1.8, -1.0)))
S_DECK      = Zone((0,    300,  2048, 560),  ('z', 'x'), ((-10.2, 10.2), (-2.4, 2.4)))
S_BELLY     = Zone((0,    560,  2048, 800),  ('z', 'x'), ((-10.2, 10.2), (-2.4, 2.4)))
S_STERN     = Zone((0,    800,  420,  1100), ('x', 'y'), ((2.2, -2.2), (1.3, -0.9)))
S_WH_SIDE   = Zone((420,  800,  1000, 1100), ('z', 'y'), ((-1.3, 2.1), (3.25, 1.15)))
S_WH_FRONT  = Zone((1000, 800,  1420, 1100), ('x', 'y'), ((1.3, -1.3), (3.25, 1.15)))
S_WH_TOP    = Zone((1420, 800,  1840, 1100), ('x', 'z'), ((-1.3, 1.3), (-1.4, 2.2)))
S_TURRET    = Zone((0,    1100, 420,  1400), ('x', 'y'), ((-0.9, 0.9), (1.0, -0.3)))
S_RING      = Zone((420,  1100, 760,  1400), ('x', 'z'), ((-1.1, 1.1), (-1.1, 1.1)))
S_RACK      = Zone((760,  1100, 1180, 1400), ('x', 'y'), ((-1.6, 1.6), (1.4, -0.2)))
S_TRIM      = Zone((1180, 1100, 1480, 1400), ('z', 'y'), ((-11, 11), (4, -2)))
S_DARK      = Zone((1480, 1100, 1620, 1400), ('x', 'z'), ((-1, 1), (-1, 1)))
S_FLAG      = Zone((1620, 1100, 1900, 1300), ('z', 'y'), ((-0.05, 0.75), (0.55, 0.05)))
S_LIGHT     = Zone((1900, 1100, 2028, 1230), ('x', 'z'), ((-40, 40), (-25, 25)))
S_BARREL    = (0,    1420, 512,  1560)   # parametric barrel/limb wrap
S_MAST      = (512,  1420, 900,  1560)   # parametric mast/post wrap
S_RAIL      = (900,  1420, 1280, 1560)   # railing wrap
S_DRUM      = Zone((1280, 1420, 1660, 1560), ('x', 'y'),
                   ((0.4, 1.1), (2.1, 1.1)))   # drum cell (flat fill)

# ── dims (world metres; waterline Y=0, bow -Z) ──────────────────────────
# hull sections: (z, y_keel, y_chine, y_deck, w_keel, w_chine, w_deck)
HULL_SECTIONS = [
    (-10.0,  0.40, 0.80, 1.72, 0.05, 0.09, 0.13),
    (-8.5,  -0.10, 0.42, 1.55, 0.50, 0.95, 1.15),
    (-6.0,  -0.55, 0.12, 1.38, 1.00, 1.70, 1.95),
    (-2.0,  -0.85, 0.00, 1.24, 1.35, 2.10, 2.30),
    (3.0,   -0.90, 0.00, 1.18, 1.40, 2.15, 2.30),
    (8.0,   -0.85, 0.02, 1.12, 1.30, 2.05, 2.20),
    (10.0,  -0.80, 0.05, 1.10, 1.20, 1.95, 2.10),
]
WATERLINE  = (-0.12, 0.35)          # boot-top paint band
DECK_Y     = 1.24                   # nominal main deck height amidships

# spray rails: chine knuckle runs (z spans, both sides)
SPRAY_RUNS = [(-8.2, -1.0), (-6.5, 5.5)]

# gun ring + autocannon (standard chain)
RING_C     = (0.0, 1.40, -5.6)       # ring platform centre (on foredeck)
RING_R     = 1.05                    # ring platform radius
TURRET_OFF = (0.0, 1.55, -5.6)       # turret piece offset (mount)
BARREL_LEN = 2.3
BARREL_R   = 0.075

# wheelhouse
WH         = (0.0, 2.18, 0.40, 2.60, 2.05, 3.40)   # x,y,z,w,h,d (centre)
WH_ROOF_Y  = 3.25

# mast + flag whip (aft of wheelhouse roof)
MAST_FOOT  = (0.0, 3.25, 1.75)
MAST_TOP   = (0.0, 5.15, 1.55)
FLAG_OFF   = (0.0, 4.95, 1.58)       # flag piece pivot on the mast
FLAG_W     = 0.70                    # flag cloth length (aft +z)
FLAG_H     = 0.45

# rear equipment rack
RACK_C     = (0.0, 1.16, 6.4)        # rack area centre on the aft deck
RAIL_RUNS  = [((-1.85, 1.14, 4.6), (-1.85, 1.10, 8.9)),
              ((1.85, 1.14, 4.6), (1.85, 1.10, 8.9)),
              ((-1.85, 1.10, 8.9), (1.85, 1.10, 8.9))]
EXHAUST_OFF = (0.9, 1.30, 9.6)       # FX empty at the transom
