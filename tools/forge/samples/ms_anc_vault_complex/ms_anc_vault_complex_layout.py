"""ms_anc_vault_complex_layout — zones + dims for the ancient vault complex.

ANCIENT REGISTER. A 35 m cliff-set facility front cut into a rock massif:
a cyclopean architrave cantilevered 4.6 m clear of the wall, a monolithic
portal bay holding the MAIN vault door (a segmented 10 m disc that rolls
aside along its track — piece `door`, clip `open`), two smaller sealed
doors on the left field, a raised approach causeway with inlaid cyan guide
lines flanked by two monolith pylons carrying floating cap slabs, and a
collapsed overburden fan burying the -X corner and the outer sealed door.

Nothing bolted, nothing patched: unbroken faces segmented by clean recessed
seams. Emissive CYAN only. Weathering is geological — dust drift, soil
burial, scorch. No team colour (--no-team map prop).

World frame: RH, front = -Z, up = +Y, ground Y = 0, 1 unit = 1 m.
Dominant dimension 35 m -> 2048 atlas.
"""
import math as _m

import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

ATLAS = 2048

# ── overall envelope ────────────────────────────────────────────────────
FACADE_HW = 17.0          # wall half width  (x -17 .. 17)
PLINTH_Y = 1.0            # stylobate top / causeway deck level
WALL_TOP = 13.0           # front wall block top
WALL_Z0 = -1.0            # wall front face
WALL_Z1 = 6.0             # wall back (into the massif)
UPPER_TOP = 17.0          # set-back mass above the architrave

# ── portal bay (the gap the wall blocks leave) ──────────────────────────
PORTAL_CX = -1.0
PORTAL_HW = 6.5           # bay x  -7.5 .. 5.5
PORTAL_TOP = 11.2
BAY_Z = 1.6               # bay back-wall front face (2.6 m deep chamber)

# ── MAIN vault door (piece `door`, local coords centred on origin) ──────
DOOR_R = 5.0
DOOR_N = 32
DOOR_RB = 3.55            # raised boss radius
DOOR_RH = 1.45            # hub radius
DOOR_ZB = 0.45            # back face   (local +z)
DOOR_ZF = -0.45           # main face
DOOR_ZBOSS = -0.72
DOOR_ZHUB = -0.95
DOOR_OFF = (PORTAL_CX, PLINTH_Y + DOOR_R, -2.20)   # (-1.0, 6.0, -2.20)

# roll aside: 3 x 45 deg so the 8-fold segment pattern lands on itself
DOOR_ROLL = -3.0 * _m.pi / 4.0            # rotation about +Z, radians
DOOR_DX = -DOOR_ROLL * DOOR_R             # +11.781 m along +X

# ── two smaller sealed doors (left field, DORMANT) ──────────────────────
SD_R = 1.65
SD_N = 16
SD_RH = 0.62
SD_COLLAR = 0.42
SD_Y = 4.4
SD_ZF = -1.28
SD_ZBOSS = -1.45
SD_WIN_HW = 2.2
SMALL_DOORS = [(-10.4, SD_Y), (-14.6, SD_Y)]

# ── cyclopean architrave (cantilever) ───────────────────────────────────
ARCH_C = (PORTAL_CX, 14.2, -2.4)
ARCH_S = (27.0, 2.6, 6.4)          # z -5.6 .. 0.8  => 4.6 m clear cantilever

# ── approach causeway ───────────────────────────────────────────────────
DECK_C = (PORTAL_CX, PLINTH_Y / 2, -12.0)
DECK_S = (17.0, PLINTH_Y, 16.0)    # x -9.5..7.5, z -20.0 .. -4.0
STEPS = [((PORTAL_CX, 0.66, -20.6), (14.5, 0.66, 1.4)),
         ((PORTAL_CX, 0.30, -21.8), (12.5, 0.60, 1.4))]

# ── flanking monolith pylons (base, shaft, floating cap) ────────────────
PYLON_X = (-7.9, 5.9)
PYLON_Z = -12.6
PYLON_BASE = (2.4, 4.6, 2.4)       # y 1.0 .. 5.6
PYLON_SHAFT = (1.7, 4.6, 1.7)      # y 5.6 .. 10.2
PYLON_CAP = (3.0, 0.6, 3.0)        # floats 0.7 m clear: y 10.9 .. 11.5

# ── door track rail (front guide, runs the full travel) ─────────────────
RAIL_C = (3.6, 1.12, -3.38)
RAIL_S = (25.6, 0.34, 0.34)        # x -9.2 .. 16.4

# ── wall pilaster fins (proud vertical seam ribs) ───────────────────────
FIN_X = (-8.4, -12.5, 8.2, 12.0, 15.6)
FIN_S = (0.9, 12.0, 0.55)          # front face to z = -1.55

# ── portal collar (proud frame around the bay mouth) ────────────────────
COLLAR_D = 0.55

# ── collapsed overburden fan at the -X corner ───────────────────────────
# (wall-face source, mid point, ground toe) per station
OVER = [((-17.4, 1.2, -1.0), (-18.3, 0.9, -2.4), (-19.2, 0.0, -3.8)),
        ((-17.0, 5.4, -1.0), (-18.4, 2.9, -4.2), (-19.4, 0.0, -7.0)),
        ((-15.4, 6.2, -1.0), (-16.8, 3.2, -4.8), (-17.4, 0.0, -8.4)),
        ((-13.8, 5.0, -1.0), (-14.6, 2.6, -4.4), (-14.4, 0.0, -7.8)),
        ((-12.4, 3.4, -1.0), (-12.6, 1.7, -3.6), (-12.2, 0.0, -6.2)),
        ((-11.4, 1.8, -1.0), (-11.2, 0.9, -2.6), (-10.8, 0.0, -4.2)),
        ((-10.8, 0.4, -1.0), (-10.4, 0.2, -1.8), (-10.0, 0.0, -2.6))]

# fallen ancient blocks: (centre xyz, size whd, yaw deg, pitch deg)
BLOCKS = [((-17.9, 1.1, -6.2), (3.2, 1.8, 2.2), 21.0, 8.0),
          ((-15.2, 0.9, -9.1), (2.6, 1.5, 1.9), -34.0, -6.0),
          ((-12.1, 0.8, -8.4), (2.2, 1.3, 1.7), 48.0, 5.0),
          ((-19.4, 1.3, -9.8), (3.6, 2.0, 2.4), -12.0, -4.0),
          ((-9.6, 0.6, -5.4), (1.8, 1.1, 1.4), 63.0, 7.0),
          ((-13.0, 0.5, -12.4), (1.6, 0.9, 1.3), 8.0, -5.0)]

# ── rear talus: (x, ground-toe z) stations; crest at TALUS_Y / z=6.0 ────
TALUS = [(-17.5, 10.8), (-9.0, 12.0), (0.0, 12.6), (9.0, 11.6), (17.5, 10.6)]
TALUS_CREST_Z = 6.0
TALUS_Y = UPPER_TOP

# ── bay iris (cyan ring revealed inside the bay) ────────────────────────
IRIS_R = 3.9
IRIS_N = 16

# ═══ atlas zones (2048², v down) ════════════════════════════════════════
Z_WALL_F = Zone((0, 0, 1520, 760), ('x', 'y'),
                ((-17.6, 17.6), (17.6, 0.0)))
Z_WALL_S = Zone((1520, 0, 2048, 380), ('z', 'y'),
                ((-6.4, 14.8), (17.6, 0.0)))
Z_BAY = Zone((1520, 380, 2048, 620), ('x', 'y'),
             ((-8.2, 6.2), (11.6, 0.6)))
Z_BAY_S = Zone((1520, 620, 2048, 700), ('z', 'y'),
               ((-1.2, 1.9), (11.6, 0.6)))
Z_BAY_C = Zone((1520, 700, 2048, 760), ('x', 'z'),
               ((-8.2, 6.2), (-1.2, 1.9)))
Z_WALL_T = Zone((0, 760, 1520, 1060), ('x', 'z'),
                ((-17.6, 17.6), (-6.4, 15.0)))

# MAIN vault door (PIECE-LOCAL coords, centred on origin)
Z_DOORF = Zone((0, 1060, 720, 1780), ('x', 'y'),
               ((-5.4, 5.4), (5.4, -5.4)))
R_RIM_D = (1160, 1060, 2048, 1120)     # outer rim wrap   (rect)
R_RIM_B = (1160, 1120, 2048, 1170)     # boss rim wrap    (rect)
R_RIM_H = (1160, 1170, 2048, 1220)     # hub rim wrap     (rect)
R_RIM_S = (1160, 1220, 2048, 1270)     # small-door rims  (rect)

# smaller sealed doors — one rect, per-door windows built in the generator
SD_RECT = (720, 1060, 1160, 1500)

# pylons: front/back get a per-pylon window on this rect, sides a shared zone
PYL_FRECT = (1160, 1270, 1380, 1780)
PYL_WIN_HW = 1.6
Z_PYL_S = Zone((1380, 1270, 1600, 1780), ('z', 'y'),
               ((PYLON_Z - 1.6, PYLON_Z + 1.6), (11.8, 0.6)))
ROCK_RECT = (1600, 1270, 2048, 1780)   # fallen blocks — per-block windows
ROCK_WIN_HW = 2.2

Z_TRACK = Zone((720, 1500, 1160, 1600), ('x', 'y'),
               ((-9.4, 16.6), (1.34, 0.90)))
Z_STEP = Zone((720, 1600, 1160, 1700), ('x', 'y'),
              ((-10.0, 8.0), (1.2, -0.4)))
Z_STEP_S = Zone((720, 1700, 1160, 1780), ('z', 'y'),
                ((-22.6, -3.9), (1.2, -0.4)))

Z_DECK = Zone((0, 1780, 1200, 2048), ('x', 'z'),
              ((-9.7, 7.7), (-22.6, -3.9)))
Z_RUBBLE = Zone((1200, 1780, 1650, 2048), ('x', 'y'),
                ((-19.6, -9.8), (7.0, -0.6)))
Z_TALUS = Zone((1650, 1780, 2048, 2048), ('x', 'z'),
               ((-17.6, 17.6), (5.6, 13.0)))
