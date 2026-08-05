"""ms_metal_pit_layout — zones + dims for ms_metal_pit (resource site).

Named resource site: 15 m mine headframe with winding wheel (piece `wheel`,
idle spin clip), inclined conveyor to a spoil heap, ore hopper, winch house.
World frame: forward -Z, up +Y, ground Y=0. Headframe stands left (-X),
winch house right (+X); conveyor climbs to the spoil heap at the rear-right.
Dominant dim >= 15 m -> 2048 atlas. Map prop, no team colour.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
R_PLATE_T  = Zone((0,    0,    1152, 832),  ('x', 'z'), ((-7.2, 7.2), (-5.2, 5.2)))
R_PLATE_SX = Zone((0,    832,  1152, 896),  ('z', 'y'), ((-5.2, 5.2), (0.30, -0.02)))
R_PLATE_SZ = Zone((0,    896,  1152, 960),  ('x', 'y'), ((-7.2, 7.2), (0.30, -0.02)))
R_LATTICE  = (1152, 0,    1664, 192)   # parametric headframe leg/girt/brace wrap
R_STRUT    = (1152, 192,  1664, 320)   # parametric raking back-leg / support wrap
R_CABLE    = (1152, 320,  1664, 384)   # parametric hoist-cable wrap
R_COLLAR   = Zone((1152, 384, 1664, 512), ('x', 'z'), ((-4.4, -1.2), (-2.2, 1.0)))
R_WINCH_S  = Zone((0,    960,  640,  1280), ('z', 'y'), ((-1.95, 0.75), (2.75, 0.1)))
R_WINCH_F  = Zone((640,  960,  1152, 1280), ('x', 'y'), ((2.2, 5.4),   (2.75, 0.1)))
R_WINCH_R  = Zone((1152, 960,  1600, 1280), ('x', 'z'), ((2.05, 5.55), (-2.05, 0.85)))
R_DECK_S   = Zone((1664, 0,    1920, 128),  ('z', 'y'), ((-1.9, 0.7),  (14.0, 13.3)))
R_DECK_T   = Zone((1664, 128,  1920, 256),  ('x', 'z'), ((-4.1, -1.5), (-1.9, 0.7)))
R_WHEEL_S  = Zone((0,    1280, 512,  1792), ('z', 'y'), ((-1.45, 1.45), (1.45, -1.45)))
R_WHEEL_RIM= Zone((512,  1280, 768,  1408), ('z', 'y'), ((-45, 45), (25, -5)))
R_HOP_S    = Zone((768,  1280, 1152, 1536), ('x', 'z'), ((-45, 45), (25, -5)))
R_BELT_T   = Zone((0,    1792, 1024, 1920), ('z', 'x'), ((-0.5, 7.6), (-0.55, 0.55)))
R_BELT_S   = Zone((0,    1920, 1024, 2048), ('z', 'y'), ((-0.5, 7.6), (0.30, -0.30)))
R_HEAP     = Zone((1152, 1536, 1664, 2048), ('x', 'z'), ((1.9, 7.3),  (0.5, 5.9)))
R_ORE      = Zone((1664, 1536, 1920, 1792), ('x', 'z'), ((-45, 45), (25, -5)))
R_STEELG   = Zone((1664, 256,  1920, 384),  ('z', 'y'), ((-45, 45), (25, -5)))
R_MACH     = Zone((1664, 384,  1920, 512),  ('z', 'y'), ((-45, 45), (25, -5)))
R_TRIM     = (1920, 0,    2048, 128)   # parametric small-part wrap
R_DARK     = Zone((1920, 128,  2048, 256),  ('x', 'z'), ((-45, 45), (-45, 45)))

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
PLATE     = (0.0, 0.14, 0.0, 14.4, 0.28, 10.4)   # ore-stained ground plate
PLATE_TOP = 0.28

# headframe: square lattice tower over the shaft; wheel tops out at ~15 m
FRAME_C   = (-2.8, -0.6)               # x, z of tower axis
BASE_H, TOP_H = 2.2, 0.72              # half-widths at base / top
TOP_Y     = 13.3                       # leg top (wheel deck sits above)
GIRT_YS   = (3.6, 7.0, 10.3)           # horizontal girt levels
LEG_R0, LEG_R1 = 0.15, 0.09
GIRT_R, BRACE_R = 0.055, 0.045
DECK      = (-2.8, 13.55, -0.6, 1.3, 0.5, 1.3)   # wheel-deck box atop legs
# raking back legs (headgear rake toward the winch house, +X)
RAKE_FOOT_X, RAKE_FOOT_ZS = 1.2, (-1.7, 0.5)
RAKE_TOP  = (-2.05, 13.35)             # x, y where rakes meet the deck edge
RAKE_R0, RAKE_R1 = 0.12, 0.08

# winding wheel — its own piece, spins about local +X
WHEEL_OFF = (-2.8, 14.05, -0.6)        # piece pivot (axle centre)
WHEEL_R   = 1.15                       # rim radius -> top ~15.2 m
WHEEL_W   = 0.26
WHEEL_N   = 12
AXLE_R    = 0.09
AXLE_W    = 1.0                        # axle span across the deck bearings

# shaft collar under the tower
COLLAR    = (-2.8, 0.55, -0.6, 1.5, 0.55, 1.5)   # box over the pit mouth

# winch house (right, +X): cable runs from its drum up to the wheel
WINCH     = (3.8, 1.43, -0.6, 3.0, 2.3, 2.5)
WINCH_ROOF= (3.8, 2.66, -0.6, 3.3, 0.16, 2.8)
WINCH_VENT= (4.6, 0.2)                 # roof vent pipe x, z
DRUM_C    = (2.1, 1.35, -0.6)          # cable drum outside the -X wall
DRUM_R, DRUM_W = 0.45, 0.9
CABLE_R   = 0.045

# ore hopper (front of tower, -Z side): box bin on 4 legs + chute
HOP_BIN   = (-2.8, 3.05, -3.55, 2.0, 1.3, 1.4)
HOP_LEG_R = 0.08
HOP_CHUTE = (-2.8, 1.95, -4.1, 0.9, 0.55, 0.7)

# inclined conveyor: from beside the hopper up over the spoil heap
BELT_P0   = (-1.6, 1.15, 2.0)          # tail (low) end
BELT_P1   = (4.35, 4.55, 3.35)         # head (high) end, over the heap
BELT_W, BELT_H = 1.1, 0.44             # belt truss cross-section
BELT_LEG_TS = (0.24, 0.52, 0.80)       # support-leg stations along the run

# spoil heap: faceted cone, rear-right corner
HEAP_C    = (4.6, 3.2)                 # x, z
HEAP_R    = 2.55
HEAP_H    = 3.3
HEAP_N    = 9

# idle spin clip — wheel turns once per period about +X
SPIN_PERIOD = 5.0
