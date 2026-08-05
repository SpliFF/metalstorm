"""ms_salvage_crane_ship_layout — zones + dims for ms_salvage_crane_ship.

s3 ships-row salvage crane ship, 50 m barge hull, beam ~11 m.
Waterline at Y=0 (hull extends below to its ~1.6 m draft), forward -Z.
Heavy lattice A-frame crane amidships-aft with a laced boom cantilevered
over the stern; travelling `trolley` piece (idle traverse clip, absolute
translation keys) with cable-hung hook block. Scrap heap + salvaged
turret shell forward, cutting-torch gantry midships, workshop cabin
(emissive windows) at the bow. Scavenger-industry register, NO team
colour. 2048 atlas (50 m dominant dim).
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
S_HULL_SIDE = Zone((0,    0,    2048, 300),  ('z', 'y'), ((-25.0, 25.0), (2.8, -1.7)))
S_DECK      = Zone((0,    300,  2048, 600),  ('z', 'x'), ((-25.0, 25.0), (-5.6, 5.6)))
S_BELLY     = Zone((0,    600,  2048, 800),  ('z', 'x'), ((-25.0, 25.0), (-5.6, 5.6)))
S_BOW       = Zone((0,    800,  360,  1080), ('x', 'y'), ((4.0, -4.0), (2.8, -0.4)))
S_STERN     = Zone((360,  800,  720,  1080), ('x', 'y'), ((-4.6, 4.6), (2.8, -0.7)))
S_CABIN_S   = Zone((720,  800,  1240, 1080), ('z', 'y'), ((-21.5, -17.0), (5.4, 2.6)))
S_CABIN_F   = Zone((720,  800,  1240, 1080), ('x', 'y'), ((2.3, -2.3), (5.4, 2.6)))
S_CABIN_R   = Zone((1240, 800,  1560, 1080), ('x', 'z'), ((-2.3, 2.3), (-21.5, -17.0)))
S_SCRAP     = Zone((1560, 800,  2048, 1080), ('x', 'z'), ((-4.0, 4.0), (-18.0, -6.0)))
S_TURRET    = Zone((0,    1080, 320,  1300), ('x', 'z'), ((-1.6, 1.6), (-1.6, 1.6)))
S_TROLLEY   = Zone((320,  1080, 640,  1300), ('x', 'y'), ((-1.2, 1.2), (0.6, -0.6)))
S_HOOK      = Zone((640,  1080, 880,  1300), ('x', 'y'), ((-0.6, 0.6), (0.7, -0.7)))
S_DARK      = Zone((880,  1080, 1000, 1300), ('x', 'z'), ((-1, 1), (-1, 1)))
S_TORCH     = Zone((1000, 1080, 1120, 1300), ('x', 'z'), ((-1, 1), (-1, 1)))
S_CRATE     = Zone((1120, 1080, 1400, 1300), ('x', 'y'), ((-0.8, 0.8), (0.8, -0.8)))
S_DRUM      = Zone((1400, 1080, 1680, 1300), ('x', 'y'), ((-0.5, 0.5), (0.6, -0.6)))
S_LATTICE   = (1680, 1080, 1936, 1300)   # rect: lattice legs/braces (limbs)
S_BOOM      = (0,    1300, 512,  1450)   # rect: boom chords/lacing
S_RAIL      = (512,  1300, 768,  1450)   # rect: deck railings
S_CABLE     = (768,  1300, 896,  1450)   # rect: hoist cables / stays
S_MAST      = (896,  1300, 1152, 1450)   # rect: posts, gantry, stack

# ── dims (world metres; waterline Y=0, bow -Z) ───────────────────────────
# sections: (z, y_bot, y_knuckle, w_bot, w_knuckle, w_deck); deck y const
DECK_Y  = 2.6
KNUCK_Y = 0.5
HULL_SECTIONS = [
    (-25.0, -0.10, 0.60, 1.10, 2.20, 3.20),
    (-21.0, -1.10, 0.50, 3.40, 4.40, 4.90),
    (-15.0, -1.60, 0.50, 4.60, 5.20, 5.50),
    (-5.0,  -1.60, 0.50, 4.80, 5.30, 5.50),
    (8.0,   -1.60, 0.50, 4.80, 5.30, 5.50),
    (18.0,  -1.60, 0.50, 4.60, 5.20, 5.45),
    (23.0,  -1.10, 0.50, 3.80, 4.70, 5.10),
    (25.0,  -0.50, 0.55, 3.00, 4.00, 4.55),
]
WATERLINE = (-0.35, 0.55)          # boot-top band (painted)

# crane A-frame (lattice_tower idiom) astride the deck at z=TOWER_Z
TOWER_Z    = 11.5
TOWER_BASE = DECK_Y
TOWER_TOP  = 14.2
TOWER_HB   = 3.1                    # half-base
TOWER_HT   = 0.85                   # half-top

# boom over the stern (two laced chord pairs)
BOOM_Z0, BOOM_Z1 = 9.8, 29.0        # tip overhangs the 25 m stern
BOOM_YLO, BOOM_YHI = 13.1, 14.15
BOOM_HX  = 0.72                     # chord half-spacing
LACE_STEP = 3.2
BACKSTAY_FOOT = (0.0, DECK_Y, 2.0)

# trolley (piece) — rides under the low chords
TROLLEY_REST = (0.0, 12.9, 24.0)    # piece offset (rest pose, near tip)
TROLLEY_IN_Z = 14.5                 # inner end of traverse
HOOK_DROP    = 5.6                  # cable length carriage->hook block

# deck furniture
CABIN   = (0.0, DECK_Y + 1.4, -19.2, 4.6, 2.8, 4.4)   # x,y,z,w,h,d
STACK_TOP = 7.2
SCRAP_Z = (-18.0, -6.0)             # scrap heap span
TURRET_POS = (0.8, -8.6)            # x,z of salvaged turret shell on the heap
GANTRY_Z = -2.0
GANTRY_H = 7.0
GANTRY_HX = 4.6
RAIL_RUNS = [(-16.5, 7.5)]          # z spans, both deck edges
RAIL_X = 5.15
EXHAUST_OFF = (1.6, 7.2, -20.3)     # FX empty at cabin stack top
