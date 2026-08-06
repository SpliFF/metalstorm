"""ms_ferry_layout — zones + dims for ms_ferry (double-ended vehicle ferry).

s2 civilian ferry, ships row (35 m), beam ~9 m with pontoon sponsons.
Waterline at Y=0 per ship convention: hull draft to -0.9 midship, deck
at Y=1.8. Double-ended: symmetric about z=0, ramps hinged at both ends
(`ramp` at -z, `ramp2` at +z; clip `unload` lowers both). Four link
empties link1..link4 in two lanes per the landing-ship convention.
Pilot house rides a gantry frame spanning the deck at z=5.5 so vehicles
pass beneath. Civilian register, faded safety paint, no team colour.
2048 atlas (35 m dominant dim >= 15 m).
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048 sq; v down) ────────────────────────────────────────
S_HULL     = Zone((0,    0,    2048, 210),  ('z', 'y'), ((-17.5, 17.5), (1.9, -1.0)))
S_DECK     = Zone((0,    210,  2048, 500),  ('z', 'x'), ((-17.5, 17.5), (-3.6, 3.6)))
S_BELLY    = Zone((0,    500,  2048, 700),  ('z', 'x'), ((-17.5, 17.5), (-3.6, 3.6)))
S_SPON     = Zone((0,    700,  1024, 860),  ('z', 'y'), ((-11.5, 11.5), (1.5, -0.6)))
S_END      = Zone((1024, 700,  1440, 920),  ('x', 'y'), ((3.5, -3.5), (1.9, -1.0)))
S_RAMP_OUT = Zone((0,    920,  552,  1200), ('x', 'y'), ((2.6, -2.6), (2.8, -0.2)))
S_RAMP_IN  = Zone((552,  920,  1104, 1200), ('x', 'y'), ((-2.6, 2.6), (2.8, -0.2)))
S_CAB_S    = Zone((1104, 920,  1616, 1120), ('z', 'y'), ((3.8, 7.2), (7.15, 5.2)))
S_CAB_F    = Zone((1104, 1120, 1616, 1320), ('x', 'y'), ((1.8, -1.8), (7.15, 5.2)))
S_CAB_TOP  = Zone((1616, 920,  1968, 1120), ('x', 'z'), ((-1.8, 1.8), (4.2, 6.9)))
S_TRIM     = Zone((1616, 1120, 1872, 1320), ('z', 'y'), ((-40, 40), (20, -5)))
S_DARK     = Zone((1968, 920,  2048, 1000), ('x', 'z'), ((-1, 1), (-1, 1)))
S_RING     = Zone((1968, 1000, 2048, 1080), ('x', 'y'), ((-0.42, 0.42), (0.42, -0.42)))
S_GANTRY   = (1440, 700, 1696, 920)     # parametric limb wrap: gantry frame
S_DRUM     = Zone((1696, 700,  1952, 920),  ('z', 'y'), ((-1.2, 1.2), (1.2, -1.2)))
S_POST     = (1952, 700, 2048, 920)     # bollards / small posts (limb wrap)

# ── dims (world metres; waterline Y=0, symmetric double-ended) ───────────
# Hull sections: (z, y_bot, y_knuckle, y_deck, w_bot, w_knuckle, w_deck)
HULL_SECTIONS = [
    (-15.6,  1.05, 1.35, 1.80, 2.10, 2.85, 3.20),
    (-13.0,  0.00, 0.80, 1.80, 2.90, 3.30, 3.40),
    (-7.0,  -0.90, 0.50, 1.80, 3.20, 3.45, 3.45),
    (0.0,   -0.90, 0.50, 1.80, 3.25, 3.45, 3.45),
    (7.0,   -0.90, 0.50, 1.80, 3.20, 3.45, 3.45),
    (13.0,   0.00, 0.80, 1.80, 2.90, 3.30, 3.40),
    (15.6,   1.05, 1.35, 1.80, 2.10, 2.85, 3.20),
]
DECK_Y     = 1.80
WATERLINE  = (-0.15, 0.40)          # painted boot-top band about Y=0

# pontoon sponsons (box6, one per side)
SPON_C     = (4.05, 0.45, 0.0)      # +x center (mirror for -x)
SPON_SZ    = (1.30, 1.80, 22.0)

# ramps — piece origin ON the hinge line at deck level, both ends
RAMP_W     = 5.00
RAMP_H     = 2.60                   # plate length hinge->lip (raised = up)
RAMP_T     = 0.22
RAMP_HINGE  = (0.0, DECK_Y, -15.6)  # ramp  (bow, -z)
RAMP2_HINGE = (0.0, DECK_Y, 15.6)   # ramp2 (stern, +z)
RAMP_DROP  = -100.0                 # unload: ramp rotates about X (deg);
                                    # ramp2 uses the opposite sign

# transport links — two lanes, landing-ship convention
LINKS      = [(-1.55, 2.00, -3.2), (1.55, 2.00, -3.2),
              (-1.55, 2.00, 3.2),  (1.55, 2.00, 3.2)]   # link1..link4

# gantry + pilot house
GANTRY_Z   = 5.5
GANTRY_LEG_X = 3.0
GANTRY_TOP_Y = 5.30
CABIN      = (0.0, 6.15, 5.5, 3.2, 1.7, 2.4)   # x,y,z,w,h,d
MAST_TOP   = (0.0, 8.1, 5.5)
BEACON_C   = (0.0, 7.35, 4.6)

# clutter
DRUMS      = (2.55, DECK_Y, 6.6)    # drum pair origin at a gantry leg
RING_C     = (3.02, 4.3, 5.5)       # life ring on +x gantry leg (faces x)
BOLLARD_Z  = (-14.6, 14.6)
