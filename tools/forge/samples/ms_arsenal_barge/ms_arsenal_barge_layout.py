"""ms_arsenal_barge_layout — zones + dims for ms_arsenal_barge.

Resistance arsenal barge, ships-row s3 (55 m): flat-decked cargo barge
conversion carrying an elevating rocket-rack battery. Waterline Y=0,
hull runs below to its draft (-1.7 m), boot-top paint band per the
ms_landing_ship ship convention. Forward = -Z (bow). Standard aim
chain: `turret` (slewing mount) -> `barrel` (elevating rack of launch
tubes) -> `muzzle` (empty at the tube mouths). Deck clutter: sandbagged
crew positions, ammo crates under tarps, drums, improvised plate
shields on the deck edges, aft deckhouse. 2048 atlas (55 m >= 15 m).
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
S_HULL_SIDE = Zone((0,    0,    2048, 300),  ('z', 'y'), ((-27.5, 27.5), (2.55, -1.85)))
S_DECK      = Zone((0,    300,  2048, 640),  ('z', 'x'), ((-27.5, 27.5), (-6.4, 6.4)))
S_BELLY     = Zone((0,    640,  2048, 900),  ('z', 'x'), ((-27.5, 27.5), (-6.3, 6.3)))
S_BOW       = Zone((0,    900,  420,  1150), ('x', 'y'), ((6.0, -6.0), (2.6, -0.4)))
S_STERN     = Zone((420,  900,  840,  1150), ('x', 'y'), ((-6.0, 6.0), (2.6, -0.4)))
S_HOUSE_S   = Zone((840,  900,  1400, 1150), ('z', 'y'), ((18.4, 24.0), (5.2, 2.4)))
S_HOUSE_F   = Zone((840,  900,  1400, 1150), ('x', 'y'), ((2.6, -2.6), (5.2, 2.4)))
S_HOUSE_T   = Zone((1400, 900,  1750, 1150), ('x', 'z'), ((-2.6, 2.6), (18.4, 24.0)))
S_MOUNT     = Zone((1750, 900,  2048, 1150), ('x', 'z'), ((-1.6, 1.6), (-1.6, 1.6)))
S_RACK_SIDE = Zone((0,    1150, 700,  1420), ('z', 'y'), ((-6.9, 0.9), (1.75, -0.75)))
S_RACK_FACE = Zone((700,  1150, 1050, 1420), ('x', 'y'), ((1.6, -1.6), (1.35, -0.55)))
S_RACK_TOP  = Zone((1050, 1150, 1500, 1420), ('x', 'z'), ((-1.6, 1.6), (-6.9, 0.9)))
S_TUBE      = (1500, 1150, 1800, 1420)   # parametric launch-tube wrap
S_DARK      = Zone((1800, 1150, 1920, 1420), ('x', 'z'), ((-1, 1), (-1, 1)))
S_PLATE     = Zone((1920, 1150, 2048, 1420), ('z', 'y'), ((-1.2, 1.2), (1.5, 0.0)))
S_CRATE     = Zone((0,    1420, 300,  1700), ('x', 'y'), ((-0.6, 0.6), (0.6, -0.6)))
S_TARP      = Zone((300,  1420, 700,  1700), ('z', 'x'), ((-2.2, 2.2), (-2.2, 2.2)))
S_SANDBAG   = Zone((700,  1420, 1000, 1700), ('x', 'z'), ((-0.5, 0.5), (-0.5, 0.5)))
S_DRUM      = Zone((1000, 1420, 1250, 1700), ('x', 'z'), ((-0.5, 0.5), (-0.5, 0.5)))
S_TRIM      = Zone((1250, 1420, 1500, 1700), ('z', 'y'), ((-3, 3), (3, -3)))
S_MAST      = (1500, 1420, 1750, 1700)   # parametric post/bitt wrap

# ── dims (world metres; waterline Y=0, bow -Z) ───────────────────────────
LENGTH   = 55.0
DECK_Y   = 2.4                      # flat cargo deck
DRAFT_Y  = -1.7                     # hull bottom
WATERLINE = (-0.35, 0.55)           # boot-top paint band
# hull loft sections: (z, y_bottom, w_bottom, w_deck)
HULL_SECTIONS = [
    (-27.5, 0.55, 4.4, 5.7),
    (-23.0, -1.70, 6.0, 6.25),
    (-14.0, -1.70, 6.25, 6.25),
    (14.0, -1.70, 6.25, 6.25),
    (23.5, -1.70, 6.0, 6.25),
    (27.5, 0.45, 4.4, 5.7),
]

# aim chain
TURRET_OFF = (0.0, DECK_Y, -3.0)    # slewing mount ring on deck
BARREL_OFF = (0.0, 1.30, 0.4)       # rack trunnion rel turret (pivot aft)
MUZZLE_OFF = (0.0, 0.39, -6.55)     # empty at the tube mouths rel barrel
RACK_L     = 6.6                    # launch-tube length
TUBE_R     = 0.34
TUBE_XS    = (-1.05, -0.35, 0.35, 1.05)   # 4 columns
TUBE_YS    = (0.0, 0.78)                  # 2 rows
CHEEK_X    = 1.52                   # rack side-plate half-spacing

# deckhouse aft
HOUSE = (0.0, 3.8, 21.2, 5.2, 2.8, 5.6)   # x,y,z,w,h,d (center y)
MAST_FOOT = (1.6, 5.2, 22.6)
MAST_TOP  = (1.6, 8.4, 22.6)

# deck clutter
SANDBAGS = [((-1.2, DECK_Y, -13.5), (1.2, DECK_Y, -13.5)),
            ((4.6, DECK_Y, 6.8), (4.6, DECK_Y, 9.2))]
CRATES   = [((0.0, DECK_Y, 9.5), 2, 3, 2), ((-3.2, DECK_Y, 14.5), 2, 2, 1)]
TARP     = (0.0, DECK_Y + 1.9, 9.5, 3.9, 0.5, 4.9)   # over the big crate block
DRUMS    = (2.4, DECK_Y, 14.2)
# improvised plate shields on the deck edges: (x_side, z, w, h)
PLATES   = [(-1, -8.5, 2.2, 1.5), (-1, -20.0, 2.0, 1.4), (-1, 12.0, 2.2, 1.5),
            (1, -8.5, 2.2, 1.5), (1, -20.0, 2.0, 1.4), (1, 12.0, 2.2, 1.5)]
BOLLARDS = [-25.0, -2.0, 16.5]                    # z; bitts both deck edges
TEAM_DECK = (0.0, -18.5, 3.0, 3.0)                # deck ID panel x,z,w,d
