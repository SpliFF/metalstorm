"""ms_fishing_trawler_layout — zones + dims for ms_fishing_trawler.

s1 civilian fishing trawler, ~18 m LOA, beam ~5.2 m. Waterline at Y=0
(hull draws to ~-1.1 m), painted boot-top band per ship convention.
Forward = -Z (high sheer bow; fo'c'sle deck steps down to the aft
working deck). Wheelhouse forward with warm lit windows, A-frame
stern gantry carrying the animated `boom` piece (idle sway) with a
hung net + floats, trawl winch, stacked fish crates, side-draped net.
Civilian register: NO team colour. 2048 atlas (18 m >= 15 m).
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

W = 2048

# ── atlas zones (2048; v down) ───────────────────────────────────────────
S_HULL_SIDE = Zone((0,    0,    2048, 360),  ('z', 'y'), ((-9.2, 9.2), (2.7, -1.2)))
S_DECK      = Zone((0,    360,  2048, 640),  ('z', 'x'), ((-9.2, 9.2), (-2.7, 2.7)))
S_BELLY     = Zone((0,    640,  2048, 860),  ('z', 'x'), ((-9.2, 9.2), (-1.6, 1.6)))
S_BOW       = Zone((0,    880,  320,  1160), ('x', 'y'), ((0.8, -0.8), (2.7, -0.2)))
S_STERN     = Zone((320,  880,  640,  1160), ('x', 'y'), ((1.9, -1.9), (1.5, -0.5)))
S_WH_S      = Zone((640,  880,  1100, 1160), ('z', 'y'), ((-4.7, -1.7), (4.3, 1.9)))
S_WH_F      = Zone((1100, 880,  1560, 1160), ('x', 'y'), ((1.5, -1.5), (4.3, 1.9)))
S_WH_TOP    = Zone((1560, 880,  1900, 1160), ('x', 'z'), ((-1.5, 1.5), (-4.7, -1.7)))
S_MAST      = (1900, 880, 2048, 1160)        # parametric mast/leg/post wrap
S_NET       = Zone((0,    1160, 512,  1640), ('x', 'y'), ((-1.6, 1.6), (0.0, -3.4)))
S_NET_SIDE  = Zone((0,    1160, 512,  1640), ('z', 'y'), ((2.0, 6.5), (2.1, 0.6)))
S_FLOAT     = Zone((512,  1160, 704,  1352), ('x', 'z'), ((-0.25, 0.25), (-0.25, 0.25)))
S_CRATE     = Zone((704,  1160, 1024, 1480), ('x', 'y'), ((-0.35, 0.35), (0.35, -0.35)))
S_TRIM      = Zone((1024, 1160, 1280, 1480), ('z', 'y'), ((-10, 10), (6, -2)))
S_DARK      = Zone((1280, 1160, 1408, 1288), ('x', 'z'), ((-1, 1), (-1, 1)))
S_WINCH     = (1408, 1160, 1664, 1352)       # winch drum wrap (limb rect)
S_RAIL      = (1664, 1160, 1920, 1352)       # rails/gantry legs (limb rect)
S_BOOM      = (512,  1352, 1024, 1500)       # boom spar wrap (limb rect)

# ── hull sections: (z, y_keel, y_knuckle, y_deck, w_keel, w_knuckle, w_deck)
HULL_SECTIONS = [
    (-9.0, 0.55, 1.60, 2.55, 0.10, 0.40, 0.52),
    (-7.2, -0.20, 1.10, 2.35, 0.70, 1.55, 1.85),
    (-4.5, -0.90, 0.55, 2.05, 1.25, 2.15, 2.45),
    (-1.5, -1.10, 0.40, 1.45, 1.45, 2.35, 2.60),
    (2.5,  -1.10, 0.40, 1.30, 1.45, 2.35, 2.60),
    (6.0,  -0.85, 0.50, 1.30, 1.20, 2.10, 2.35),
    (8.8,  -0.35, 0.75, 1.30, 0.80, 1.55, 1.80),
]
WATERLINE = (-0.18, 0.38)            # boot-top band (painted)
DECK_AFT_Y = 1.30                    # working deck
DECK_FWD_Y = 2.05                    # fo'c'sle

# wheelhouse
WH = (0.0, 3.05, -3.2, 2.8, 2.0, 2.6)    # x,y,z, w,h,d (center y)
WH_WIN_Y = (3.35, 3.85)                  # window band, world y
MAST_FOOT = (0.0, 4.10, -3.6)
MAST_TOP  = (0.0, 6.60, -3.6)
STACK     = (0.9, 4.10, -2.4)            # exhaust stub on the roof
STACK_TOP = 5.05

# A-frame gantry (aft); apex crossbar carries the boom pivot
GANTRY_FEET = [(1.85, 1.30, 5.55), (1.85, 1.30, 6.85),
               (-1.85, 1.30, 5.55), (-1.85, 1.30, 6.85)]
GANTRY_TOP  = [(1.45, 4.70, 6.20), (-1.45, 4.70, 6.20)]

# boom piece — pivot at the gantry crossbar centre
BOOM_PIVOT = (0.0, 4.70, 6.20)
BOOM_TIP   = (0.0, -1.10, -2.45)         # piece-local tip (forward-down over deck)
BOOM_SWAY  = 3.0                         # idle sway, deg about Z

# deck clutter
WINCH = ((-0.95, 1.95, 4.35), (0.95, 1.95, 4.35), 0.34)   # a, b, r
CRATES = (0.9, 1.30, 1.6)                # fish crate stack origin
RAIL_RUNS = [((2.42, 1.42, -0.4), (1.75, 1.42, 8.6)),
             ((-2.42, 1.42, -0.4), (-1.75, 1.42, 8.6))]
BOLLARDS = [(2.15, 1.30, 0.2), (-2.15, 1.30, 0.2),
            (1.55, 1.30, 8.3), (-1.55, 1.30, 8.3)]
NET_SIDE_Z = (2.2, 6.3)                  # draped net on the port bulwark
FLOATS_SIDE = [(2.55, 1.35, 3.0), (2.5, 1.30, 4.1), (2.55, 1.32, 5.2)]
