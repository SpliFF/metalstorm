"""battleship_layout — zones + dims for fable_battleship (FNS Sovereign).

s4 capital ship per art/STYLE.md: 80 m length, beam 12 m, footprint 14.
Superstructure tops out ~17 m with the mast radar at ~19 (unit-family
heights: colossus 15, factory stacks 17.8). Keel at Y=0 (viewer sits it
on ground; in water the SHIP movedef handles draft), painted boot-top
waterline. Forward = -Z (bow), 3 aimable railgun turret chains:
turret/barrel/muzzle (A fore), turret3/… (B superfiring), turret2/…
(C aft, geometry baked facing +Z). `radar` rotates in the idle clip.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
B_HULL_SIDE = Zone((0,    0,    2048, 368),  ('z', 'y'), ((-40.5, 40.5), (6.0, -0.1)))
B_DECK      = Zone((0,    368,  2048, 624),  ('z', 'x'), ((-40.5, 40.5), (-6.2, 6.2)))
B_STERN     = Zone((0,    624,  384,  880),  ('x', 'y'), ((3.9, -3.9), (5.4, 1.6)))
B_SUPER     = Zone((384,  624,  1152, 880),  ('z', 'y'), ((-11.0, 11.0), (1.7, -1.7)))
B_SUPER_F   = Zone((384,  624,  1152, 880),  ('x', 'y'), ((5.6, -5.6), (1.7, -1.7)))
B_BRIDGE    = Zone((1152, 624,  1536, 880),  ('x', 'y'), ((3.7, -3.7), (13.5, 10.4)))
B_TOWER     = Zone((1536, 624,  1792, 880),  ('x', 'y'), ((-2.4, 2.4), (17.8, 13.2)))
B_FUNNEL    = (1792, 624, 2048, 880)     # parametric funnel wrap
B_TUR_TOP   = Zone((0,    880,  512,  1136), ('x', 'z'), ((-3.9, 3.9), (-4.8, 4.8)))
B_TUR_SIDE  = Zone((512,  880,  1024, 1136), ('z', 'y'), ((-4.8, 4.8), (2.7, -0.1)))
B_TUR_FRONT = Zone((1024, 880,  1280, 1136), ('x', 'y'), ((3.9, -3.9), (2.7, -0.1)))
B_BARREL    = (1280, 880, 2048, 1008)    # parametric tube wrap
B_CAP_RING  = (1280, 1008, 1792, 1136)   # capacitor ring wrap (cyan)
B_TUBE_CAP  = Zone((1792, 1008, 1920, 1136), ('x', 'y'), ((-2.0, 2.0), (1.6, -1.6)))
B_VLS       = Zone((0,    1136, 512,  1392), ('x', 'z'), ((-2.4, 2.4), (8.5, 13.9)))
B_HELI      = Zone((512,  1136, 1024, 1392), ('x', 'z'), ((-4.7, 4.7), (-4.7, 4.7)))
B_PDC       = Zone((1024, 1136, 1280, 1392), ('x', 'y'), ((-45, 45), (25, -5)))
B_BOAT      = (1280, 1136, 1664, 1264)   # boat hull wrap
B_BOAT_CAP  = Zone((1664, 1136, 1792, 1264), ('x', 'y'), ((-45, 45), (25, -5)))
B_RADAR     = Zone((0,    1392, 384,  1520), ('x', 'y'), ((-1.6, 1.6), (0.75, -0.15)))
B_TRIM      = Zone((384,  1392, 768,  1520), ('z', 'y'), ((-45, 45), (25, -5)))
B_STACKTOP  = Zone((768,  1392, 896,  1520), ('x', 'z'), ((-2.0, 2.0), (-1.6, 1.6)))
B_DARK      = Zone((896,  1392, 1024, 1520), ('x', 'z'), ((-1, 1), (-1, 1)))
B_DECKHOUSE = Zone((1024, 1392, 1536, 1584), ('z', 'y'), ((24.6, 32.4), (7.3, 4.9)))
B_BREAK     = Zone((1536, 1392, 1792, 1520), ('x', 'y'), ((3.4, -3.4), (6.2, 4.8)))
B_BARBETTE  = (1024, 1584, 1536, 1680)   # barbette drum wrap

# ── dims (world metres; keel Y=0, bow -Z) ────────────────────────────────
# hull loft: (z, y_bot, y_waist, y_shoulder, y_deck, w_bot, w_waist, w_deck, w_top)
HULL_SECTIONS = [
    (-40.0, 3.30, 4.10, 5.10, 5.80, 0.06, 0.30, 0.55, 0.40),
    (-32.0, 1.10, 2.50, 4.40, 5.60, 0.55, 2.10, 3.20, 3.00),
    (-22.0, 0.30, 1.60, 4.00, 5.20, 1.60, 4.00, 5.20, 4.90),
    (-10.0, 0.10, 1.40, 3.80, 5.00, 2.20, 5.00, 5.90, 5.60),
    (2.0,   0.10, 1.40, 3.80, 5.00, 2.30, 5.10, 6.00, 5.70),
    (14.0,  0.10, 1.40, 3.80, 5.00, 2.20, 5.00, 5.90, 5.60),
    (26.0,  0.30, 1.50, 3.90, 5.05, 1.90, 4.40, 5.40, 5.10),
    (34.0,  0.80, 2.00, 4.00, 5.10, 1.40, 3.40, 4.60, 4.40),
    (40.0,  1.80, 2.60, 4.20, 5.20, 0.90, 2.60, 3.80, 3.70),
]
DECK_Y      = 5.0
WATERLINE   = (1.35, 1.95)          # boot-top band (painted)

# turret chains
TURRET_A    = (0.0, 6.05, -25.0)    # piece offset (pivot at barbette top)
TURRET_B    = (0.0, 7.55, -15.5)    # superfiring
TURRET_C    = (0.0, 6.10, 20.5)     # aft, geometry faces +Z
BARREL_OFF  = (0.0, 1.15, -3.35)    # turret-local (C uses +3.35)
MUZZLE_OFF  = (0.0, 0.0, -7.90)     # barrel-local (C uses +7.90)
TUBE_X      = 1.30                   # triple gun spacing
TUR_SECTIONS = [                     # turret-local loft (fore-facing)
    (-4.4, 0.0, 0.15, 1.60, 1.80, 1.4, 2.4, 2.0, 1.5),
    (-2.0, 0.0, 0.18, 2.05, 2.35, 2.6, 3.6, 3.1, 2.4),
    (1.2,  0.0, 0.18, 2.10, 2.40, 2.7, 3.7, 3.2, 2.5),
    (4.4,  0.0, 0.15, 1.75, 2.00, 2.0, 2.9, 2.5, 1.9),
]
TUBE_STATIONS = [(-0.2, 0.44), (-4.6, 0.44), (-4.6, 0.32), (-7.3, 0.32)]
CAP_RING    = ((-2.7, -3.5), 0.54)
TIP_STUB    = ((-7.45, -7.80), 0.225)
BARBETTES   = [(-25.0, 4.0, 3.4, 6.05), (-15.5, 4.6, 3.1, 7.55),
               (20.5, 4.0, 3.4, 6.10)]  # z, ybase, r, ytop

# superstructure
LEVEL01     = (0.0, 6.5, 4.0, 11.0, 3.0, 21.0)
LEVEL02     = (0.0, 9.3, 1.5, 8.6, 2.6, 13.0)
BRIDGE      = (0.0, 12.0, -2.5, 7.2, 2.8, 5.5)
WINGS       = [(4.55, 12.5, -2.5), (-4.55, 12.5, -2.5)]
WING_SIZE   = (2.1, 0.22, 3.2)
TOWER       = (0.0, 15.3, -1.0, 3.2, 3.8, 3.4)
RANGEFINDER = (0.0, 17.45, -1.0, 4.6, 0.55, 0.8)
FUNNEL      = (0.0, 8.5, 10.6, 15.3, 1.95, 1.60)   # x,z, ybase, ytop, r0, r1
MAST_APEX   = (0.0, 18.5, 4.5)
MAST_LEGS   = [(1.3, 3.3), (-1.3, 3.3), (0.0, 5.9)]  # x,z leg feet on 02 roof
RADAR_OFF   = (0.0, 19.0, 4.5)       # radar piece offset
VLS_BOX     = (0.0, 8.15, 11.2, 4.6, 0.3, 5.2)     # on 01-level roof aft
DECKHOUSE   = (0.0, 6.1, 28.5, 7.2, 2.2, 6.8)
HELIPAD     = (0.0, 35.3)            # painted circle centre (z)
PDCS        = [(4.15, 8.35, -5.6), (-4.15, 8.35, -5.6),
               (4.15, 8.35, 13.2), (-4.15, 8.35, 13.2)]
BOATS       = [(6.05, 6.35, 17.0), (-6.05, 6.35, 17.0)]
BOAT_R, BOAT_LEN = 0.58, 3.4
BREAKWATER  = (0.0, DECK_Y + 0.5, -29.5)
EXHAUST_OFF = (0.0, 15.5, 10.6)
