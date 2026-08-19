"""ms_artillery_s4_layout — zones + dims for ms_artillery_s4.

"Continental gun": the army's single siege piece, hour-glass range.
Super-heavy crawler: twin parallel track units per side, a girder carriage
deck spanning over them, and a colossal ~9.5 m howitzer with multi-baffle
muzzle brake on a rotating ring mount amidships, huge counterweight/breech
house behind the trunnions. Rear deck: shell hoist A-frame, oversized shell
rack, giant anchor spades. Pieces: body / tracks_l / tracks_r / turret /
barrel / muzzle. Length ~15 m dominant; atlas 2048; <=3000 tris.

World frame: forward=-Z, up=+Y, left=+X, ground Y=0, 1 unit = 1 m.
Single source of truth for BOTH geometry (UV projection) and painter.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

ATLAS = 2048

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
C_DECK_TOP   = Zone((0, 0, 420, 1230), ('x', 'z'), ((-3.5, 3.5), (-5.65, 6.55)))
C_HOUSE_SIDE = Zone((440, 0, 960, 290), ('z', 'y'), ((0.2, 2.8), (1.85, 0.45)))
C_HOUSE_FRONT = Zone((980, 0, 1230, 290), ('x', 'y'), ((-1.3, 1.3), (1.85, 0.45)))
C_HOUSE_REAR = Zone((1250, 0, 1500, 290), ('x', 'y'), ((1.3, -1.3), (1.85, 0.45)))
C_HOUSE_TOP  = Zone((1520, 0, 1790, 270), ('x', 'z'), ((-1.3, 1.3), (0.2, 2.8)))
C_RING       = (1810, 0, 2040, 110)      # parametric ring-drum wrap
C_RING_TOP   = Zone((1810, 130, 2040, 360), ('x', 'z'), ((-2.0, 2.0), (-2.0, 2.0)))
C_TRUNNION   = Zone((1520, 290, 1790, 420), ('z', 'y'), ((-1.1, 1.7), (1.7, 0.1)))
C_BARREL     = (440, 310, 1440, 420)     # inner tube wrap (u along tube)
C_BRAKE      = (1460, 310, 1800, 420)    # muzzle brake wrap
C_RECUP      = (440, 440, 740, 530)      # recuperator/cradle wrap
C_BREECH     = (760, 440, 1060, 530)     # breech jacket wrap
C_CAP_F      = Zone((1080, 440, 1155, 530), ('x', 'y'), ((-0.6, 0.6), (3.6, 4.9)))
C_CAP_R      = Zone((1165, 440, 1240, 530), ('x', 'y'), ((-0.6, 0.6), (-0.1, -1.4)))
C_DECK_FRONT = Zone((1260, 440, 1580, 550), ('x', 'y'), ((-3.5, 3.5), (2.35, 1.75)))
C_DECK_REAR  = Zone((1600, 440, 1920, 550), ('x', 'y'), ((3.5, -3.5), (2.35, 1.75)))
C_DECK_SIDE  = Zone((0, 1240, 900, 1330), ('z', 'y'), ((-5.65, 6.55), (2.35, 1.75)))
C_GIRDER     = (920, 1240, 1230, 1330)   # parametric: hoist frame, spade arms
C_GANTRY     = (1250, 1240, 1450, 1330)  # parametric: ladder/railings
C_TRIM       = (1470, 1240, 1610, 1330)  # parametric small limbs
C_TRIM_BOX   = Zone((1630, 1240, 1790, 1330), ('x', 'y'), ((-3.6, 3.6), (6.2, -0.2)))
C_LIGHT      = Zone((1810, 1240, 1910, 1330), ('x', 'y'), ((-3.4, 3.4), (5.0, 2.0)))
C_DARK       = Zone((1930, 1240, 2040, 1330), ('x', 'z'), ((-3.6, 3.6), (-5.7, 6.6)))
C_TRACK_SIDE = Zone((0, 1350, 880, 1560), ('z', 'y'), ((-4.45, 4.45), (1.75, 0.0)))
C_SKIRT      = Zone((900, 1350, 1460, 1500), ('z', 'y'), ((-4.3, 4.3), (1.7, 0.8)))
C_SHELL      = (1480, 1350, 1960, 1440)  # shell body wrap (u along shell)
C_SPADE      = Zone((1480, 1460, 1780, 1600), ('x', 'y'), ((-2.4, 2.4), (0.95, 0.0)))
C_BANNER     = Zone((1800, 1460, 2040, 1720), ('z', 'y'), ((-2.75, -0.25), (2.2, 0.9)))
C_GIRDER_BOX = Zone((900, 1520, 1460, 1600), ('z', 'y'), ((-5.4, 5.4), (1.8, 1.1)))
C_TRACK_WRAP = (0, 1580, 880, 1650)      # parametric (arc-length) track wrap
C_BARREL2    = (900, 1620, 1460, 1730)   # outer tube wrap (team ring stripe)
C_FENDER     = Zone((0, 1670, 880, 1830), ('z', 'x'), ((-4.35, 4.35), (-1.05, 1.05)))
C_CAB_SIDE   = Zone((0, 1850, 260, 1990), ('z', 'y'), ((-5.4, -3.8), (3.3, 2.3)))
C_CAB_FRONT  = Zone((280, 1850, 480, 1990), ('x', 'y'), ((0.5, 2.1), (3.3, 2.3)))
C_CAB_TOP    = Zone((500, 1850, 700, 1990), ('x', 'z'), ((0.5, 2.1), (-5.4, -3.8)))

# ── design constants ─────────────────────────────────────────────────────
import numpy as np

# carriage deck (girder slab spanning over the track pods, railway-gun style)
DECK_C   = (0.0, 2.05, 0.45)
DECK_SZ  = (7.0, 0.6, 12.2)              # deck y 1.75..2.35, z -5.65..6.55
DECK_TOP_Y = 2.35

# longitudinal girder beams under the deck
GIRDERS  = [(1.2, 1.45, 0.4), (-1.2, 1.45, 0.4)]     # x, y, z centers
GIRDER_SZ = (0.5, 0.6, 10.6)

# twin-run track pod (piece-local; mirrored for tracks_r)
TRACK_OFF = (2.5, 0.0, 0.2)
RUN_X     = 0.55                          # run centres at +-RUN_X
RUN_HW    = 0.38                          # half width of each run
TRACK_PROFILE = [                         # local (z, y), outer loop
    (-4.45, 0.80), (-3.30, 0.12), (3.30, 0.12), (4.45, 0.80),
    (4.35, 1.42), (2.70, 1.58), (-2.70, 1.58), (-4.35, 1.42),
]
SKIRT_C  = (0.99, 1.25, 0.0)
SKIRT_SZ = (0.10, 0.90, 8.5)
FENDER_C = (0.0, 1.66, 0.0)
FENDER_SZ = (2.0, 0.16, 8.8)
ROAD_WHEELS = [-3.3 + 1.1 * i for i in range(7)]     # painted, C_TRACK_SIDE

# driver cab (front-left on the deck)
CAB_C  = (1.3, 2.80, -4.6)
CAB_SZ = (1.5, 0.9, 1.5)

# exhaust stacks behind the cab
STACKS = [(0.9, -3.6), (1.7, -3.6)]       # x, z; y from deck to STACK_TOP
STACK_TOP = 4.1
MUFFLER_SZ = (0.30, 0.5, 0.30)

# floodlight masts (amber deck floods)
FLOODS = [(3.2, 1.6), (-3.2, 1.6)]        # x, z
FLOOD_TOP = 4.6
FLOOD_BOX = (0.26, 0.22, 0.26)

# team banner plates hung on the deck sides
BANNER_C  = (3.53, 1.55, -1.5)            # +x side; mirrored to -x
BANNER_SZ = (0.08, 1.20, 2.40)

# rear deck: shell rack + shells (transverse, along x)
RAIL_CS  = [(0.85, 2.44, 5.3), (-0.85, 2.44, 5.3)]
RAIL_SZ  = (0.22, 0.18, 1.9)
SHELL_Y  = 2.72
SHELL_R  = 0.26
SHELL_ZS = [4.75, 5.35, 5.95]
SHELL_X  = (-1.05, 1.05)                  # body span; nose to +x
SHELL_NOSE = 1.45

# shell hoist A-frame over the rack
HOIST_FEET = [(2.4, 3.4), (2.4, 4.8), (-2.4, 3.4), (-2.4, 4.8)]  # x, z
HOIST_APEX = (1.6, 5.2, 4.1)              # +-x, y, z of beam ends
HOOK_Y = 3.45

# rear anchor spades
SPADE_ARM = [((1.6, 1.90, 6.20), (1.6, 0.50, 7.05)),
             ((-1.6, 1.90, 6.20), (-1.6, 0.50, 7.05))]
SPADE_C  = [(1.6, 0.35, 7.15), (-1.6, 0.35, 7.15)]
SPADE_SZ = (1.15, 0.60, 0.70)

# crew gantry
LADDER = ((0.0, 0.25, 6.68), (0.0, 2.30, 6.68))
RAILS  = [((3.3, 2.35, 3.0), (3.3, 2.35, 6.35)),
          ((-3.3, 2.35, 3.0), (-3.3, 2.35, 6.35)),
          ((2.9, 2.35, 6.45), (-2.9, 2.35, 6.45))]

# turret (ring mount + counterweight house); piece offset on the deck
TURRET_OFF = (0.0, 2.35, 0.8)
RING_R0, RING_R1, RING_H = 1.95, 1.88, 0.52
HOUSE_C  = (0.0, 1.15, 1.5)
HOUSE_SZ = (2.6, 1.4, 2.6)
VENTS = [(0.6, 1.92, 1.9), (-0.6, 1.92, 1.9)]
VENT_SZ = (0.8, 0.14, 0.6)
CHEEK_CS = [(1.08, 0.90, -0.1), (-1.08, 0.90, -0.1)]
CHEEK_SZ = (0.30, 1.30, 1.50)

# barrel (piece-local; pivot at the trunnions, rest elevation baked in)
BARREL_OFF = (0.0, 1.35, -0.1)            # turret-local trunnion point
ELEV = np.radians(27.0)
D = np.array([0.0, np.sin(ELEV), -np.cos(ELEV)])     # along the tube
P_UP = np.array([0.0, np.cos(ELEV), np.sin(ELEV)])   # perpendicular, up
MUZZLE_OFF = tuple(np.round(9.45 * D, 3))            # barrel-local tip
BAFFLES = [(8.35, 8.68), (8.72, 9.05), (9.09, 9.42)]
