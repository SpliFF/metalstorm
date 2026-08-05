"""ms_field_workshop_layout — zones + dims for ms_field_workshop.

Staging-post kit: 14 x 10 m open-sided field workshop (STYLE.md: buildings
are footprint-driven; metres = footprint x 2). Corrugated skillion roof on
six square steel posts, a free-standing gantry crane (own portal columns +
rails, animated `crane` bridge piece), two workbenches, an engine hoist,
parts bins, drum/crate/locker/gas-bottle dressing on a thin concrete pad.
World frame: open bay faces -Z, up +Y, ground Y=0, 1 unit = 1 m. All
static geometry lives on `body`; only `crane` animates (idle traverse).
Dominant dim 14 m < 15 m -> 1024^2 atlas.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas zones (1024^2; v down) ─────────────────────────────────────────
W_ROOF_T   = Zone((0,    0,   576,  448),  ('x', 'z'), ((-7.6, 7.6), (-5.6, 5.6)))
W_ROOF_U   = Zone((576,  0,   1024, 320),  ('x', 'z'), ((-7.6, 7.6), (-5.6, 5.6)))
W_FASCIA   = Zone((576,  320, 1024, 352),  ('x', 'y'), ((-7.6, 7.6), (6.0, 4.95)))
W_FASCIA_S = Zone((576,  320, 1024, 352),  ('z', 'y'), ((-5.6, 5.6), (6.0, 4.95)))
W_RAIL     = Zone((576,  352, 1024, 400),  ('x', 'y'), ((-6.6, 6.6), (4.25, 3.65)))
W_CRANE    = Zone((576,  400, 1024, 448),  ('z', 'y'), ((-3.9, 3.9), (1.0, -0.05)))
W_PAD      = Zone((0,    448, 448,  800),  ('x', 'z'), ((-7.2, 7.2), (-5.2, 5.2)))
W_POST     = (448, 448, 576, 800)          # parametric column/brace wrap
W_PADS_F   = Zone((576,  448, 1024, 484),  ('x', 'y'), ((-7.2, 7.2), (0.34, -0.02)))
W_PADS_S   = Zone((576,  484, 1024, 520),  ('z', 'y'), ((-5.2, 5.2), (0.34, -0.02)))
W_GAS      = (576, 520, 704, 648)          # parametric gas-bottle wrap
W_RACK     = Zone((704,  520, 832,  648),  ('z', 'y'), ((2.25, 3.75), (2.15, 0.2)))
W_BEAM     = Zone((576,  648, 1024, 712),  ('x', 'y'), ((-7.1, 7.1), (6.1, 3.55)))
W_DARKP    = (576, 712, 704, 800)          # parametric cable wrap
W_DARK     = Zone((704,  712, 832,  800),  ('x', 'z'), ((-8.0, 8.0), (-6.0, 6.0)))
W_HOISTP   = (832, 712, 1024, 800)         # parametric hoist mast/boom wrap
W_TROLLEY  = Zone((0,    800, 160,  928),  ('z', 'y'), ((0.55, 1.55), (0.4, -0.5)))
W_HOOK     = Zone((160,  800, 288,  928),  ('z', 'y'), ((0.55, 1.55), (-1.2, -2.1)))
W_BENCH_S  = Zone((544,  800, 800,  896),  ('x', 'y'), ((-6.45, -5.25), (1.05, 0.2)))
W_HOIST    = Zone((0,    928, 224,  1024), ('z', 'y'), ((-4.7, -1.7), (2.45, 0.15)))
W_DRUM     = (224, 928, 416, 1024)         # parametric drum wrap
W_DRUM_T   = Zone((416,  928, 512,  1024), ('x', 'z'), ((-1, 1), (-1, 1)))  # cap (auto-window)
W_CRATE    = Zone((512,  928, 656,  1024), ('z', 'y'), ((3.45, 4.85), (1.5, 0.25)))
W_LOCKER   = Zone((656,  928, 784,  1024), ('x', 'y'), ((-7.15, -5.55), (2.35, 0.15)))
W_TRIM     = Zone((912,  928, 1024, 1024), ('z', 'y'), ((-8.0, 8.0), (8.0, -1.0)))

# per-instance zones (same painted cell, window recentred per prop)
BENCH_ZC   = [-2.0, 1.2]                   # bench centres along z (x = BENCH_X)
W_BENCH_T  = [Zone((288, 800, 544, 928), ('x', 'z'),
                   ((-6.45, -5.25), (zc - 1.5, zc + 1.5))) for zc in BENCH_ZC]
BIN_ZC     = [-1.1, 0.15, 1.4]             # bin centres along z (x = BIN_X)
W_BIN_S    = [Zone((800, 800, 1024, 896), ('z', 'y'),
                   ((zc - 0.65, zc + 0.65), (1.15, 0.2))) for zc in BIN_ZC]
W_BIN_T    = [Zone((784, 928, 912, 1024), ('x', 'z'),
                   ((5.05, 6.35), (zc - 0.65, zc + 0.65))) for zc in BIN_ZC]

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
PAD        = (0.0, 0.15, 0.0, 14.0, 0.3, 10.0)   # x,y,z,w,h,d slab
PAD_TOP    = 0.3
# skillion roof: high edge at the front (-z), low at the back
RX, RZ     = 7.4, 5.4                             # roof half extents
RY_F, RY_B = 5.9, 5.1                             # top surface y at -z / +z
RT         = 0.14                                 # slab thickness

def roof_y(z):
    return RY_F + (RY_B - RY_F) * (z + RZ) / (2 * RZ)

POST_XS    = (-6.5, 0.0, 6.5)
POST_ZS    = (-4.55, 4.55)
HEADER_H   = 0.24                                 # eave header beam section
PURLIN_ZS  = (-2.0, 2.0)                          # under-roof purlins
# gantry crane (free-standing portal: 4 columns + 2 rails along x)
GX, GZ     = 5.7, 3.15                            # column x/z
RAIL_TOP   = 4.15
RAIL_SIZE  = (12.6, 0.36, 0.30)                   # w,h,d (along x)
STOP_X     = 6.1                                  # rail end-stop x
CRANE_OFF  = (0.0, RAIL_TOP, 0.0)                 # crane piece rest offset
TRAV       = 4.6                                  # idle traverse half-range (m)
TRAV_T     = 24.0                                 # idle loop period (s)
# crane piece-local dims
TRUCK      = (1.1, 0.32, 0.5)                     # end truck (at local z ±GZ)
BRIDGE     = (0.46, 0.46, 7.3)                    # bridge beam spanning z
TROLLEY    = (0.78, 0.44, 0.8)                    # at local (0, 0.06, TROLLEY_Z)
TROLLEY_Z  = 1.05
CABLE_Y    = (-0.16, -1.32)                       # cable local y run
HOOK_BLOCK = (0.32, 0.36, 0.2)                    # at local y -1.48
# props
BENCH_X    = -5.85
BENCH_TOP  = (1.0, 0.1, 2.8)                      # top slab (y centre 0.91)
BENCH_PANEL= (0.9, 0.56, 0.12)                    # end panels (y centre 0.58)
BIN_X      = 5.75
BIN_SIZE   = (1.15, 0.72, 0.95)
RACK       = (6.05, 3.0)                          # x,z; panels + shelves
LOCKER     = (-6.35, PAD_TOP + 0.95, 4.1, 1.35, 1.9, 0.55)
CRATE      = (1.6, PAD_TOP + 0.13 + 0.425, 4.15, 0.95, 0.85, 0.9)
PALLET     = (1.6, PAD_TOP + 0.065, 4.15, 1.3, 0.13, 1.15)
DRUMS      = [(6.2, 4.3), (5.45, 4.5)]            # x,z
DRUM_R, DRUM_H = 0.33, 0.95
GAS        = [(-4.6, 4.35), (-4.25, 4.55)]        # x,z welding bottles
GAS_R, GAS_H = 0.15, 1.35
HOIST      = (3.4, -2.8)                          # x,z (boom faces -z)
