"""ms_engineers_s4_layout — zones + dims for ms_engineers_s4.

Mobile fabrication platform: single vast tracked crawler (ENGINEERS s4).
Two full-length bagger-style track pods, fabrication deck between/above
them, enclosed glazed crew cab forward, open-sided fabrication bay
amidships (amber welding glow), slewing crane aft (crane_base →
crane_boom), stowage, gas bottles, floodlights, amber beacon.
Family read: hi-vis + hazard + tools. Unarmed — no turret* names.

World frame: forward=-Z, up=+Y, ground Y=0, 1 unit = 1 m.
Single source of truth for the generator (UV projection) and painter.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone


def _mir(z):
    """Mirrored twin zone (same atlas rect, u-window reversed) for text
    read on the reversing side of a two-sided planar zone."""
    (a0, a1), b = z.win
    return Zone(z.rect, z.axes, ((a1, a0), b))


# ── atlas zones (2048²; v down) ──────────────────────────────────────────

Z_DECK      = Zone((0, 0, 546, 1024), ('x', 'z'), ((-5.25, 5.25), (-9.95, 9.95)))
Z_CAB_SIDE  = Zone((560, 0, 860, 420), ('z', 'y'), ((-9.45, -6.55), (7.4, 3.3)))
Z_CAB_SIDE_M = _mir(Z_CAB_SIDE)          # +x cab face (text mirror twin)
Z_CAB_FRONT = Zone((860, 0, 1550, 420), ('x', 'y'), ((3.45, -3.45), (7.4, 3.3)))
Z_CAB_REAR  = Zone((1550, 0, 2040, 340), ('x', 'y'), ((-3.45, 3.45), (7.4, 3.3)))
Z_CAB_TOP   = Zone((560, 810, 1020, 1020), ('x', 'z'), ((-3.6, 3.6), (-9.85, -6.5)))

Z_ROOF_TOP  = Zone((560, 430, 1020, 800), ('x', 'z'), ((-4.6, 4.6), (-4.6, 2.8)))
Z_ROOF_BOT  = Zone((1030, 430, 1260, 620), ('x', 'z'), ((-4.6, 4.6), (-4.6, 2.8)))
Z_ROOF_EDGE = Zone((1030, 630, 1260, 680), ('z', 'y'), ((-4.7, 2.9), (7.3, 6.8)))

# crane zones are crane_base PIECE-LOCAL
Z_CRANE_SIDE = Zone((1270, 430, 1530, 640), ('z', 'y'), ((-1.75, 2.6), (2.5, 0.0)))
Z_CRANE_SIDE_M = _mir(Z_CRANE_SIDE)      # +x house face (text mirror twin)
Z_CRANE_FACE = Zone((1540, 430, 1790, 640), ('x', 'y'), ((1.3, -1.3), (2.5, 0.0)))
Z_CRANE_REAR = Zone((1800, 430, 2040, 640), ('x', 'y'), ((-1.3, 1.3), (2.5, 0.0)))
Z_CRANE_TOP  = Zone((1910, 650, 2040, 760), ('x', 'z'), ((-1.3, 1.3), (-1.25, 2.65)))

# parametric wrap rects (limb/tube take raw rects)
Z_TRIM = (1030, 650, 1130, 760)
Z_MAST = (1140, 650, 1240, 760)
Z_EXH  = (1250, 650, 1340, 760)
Z_BOOM = (1350, 650, 1900, 760)

Z_CRATE  = Zone((1030, 770, 1180, 930), ('x', 'y'), ((-4.75, -2.25), (4.5, 3.2)))
Z_TARP   = Zone((1190, 770, 1330, 930), ('x', 'y'), ((-4.5, -2.3), (4.3, 3.2)))
Z_BOTTLE = Zone((1340, 770, 1450, 930), ('x', 'y'), ((4.2, 4.9), (5.0, 3.2)))
Z_WORK   = Zone((1460, 770, 1580, 930), ('x', 'y'), ((-0.8, 1.4), (4.6, 3.2)))
Z_FLOOD  = Zone((1590, 770, 1690, 870), ('x', 'y'), ((-4.8, 4.8), (8.1, 6.4)))
Z_LIGHT  = Zone((1700, 770, 1780, 850), ('x', 'y'), ((-0.3, 0.3), (8.2, 7.7)))
Z_HOOK   = Zone((1790, 770, 1890, 930), ('x', 'y'), ((-0.4, 0.4), (4.4, -0.4)))  # boom-local
Z_DARK   = Zone((1900, 770, 2000, 870), ('x', 'z'), ((-5.3, 5.3), (-10.0, 10.0)))
Z_WORK_TOP = Zone((1030, 940, 1150, 1020), ('x', 'z'), ((-0.8, 1.4), (-2.8, 0.4)))

Z_POD_SIDE  = Zone((0, 1040, 1024, 1210), ('z', 'y'), ((-9.7, 9.7), (3.0, 0.0)))
Z_POD_WRAP  = (0, 1220, 1024, 1310)      # arc-length parametric track wrap
Z_DECK_EDGE = Zone((0, 1320, 1024, 1372), ('z', 'y'), ((-9.95, 9.95), (3.3, 2.9)))
Z_HULL_END  = Zone((1040, 1040, 1560, 1340), ('x', 'y'), ((-5.25, 5.25), (3.3, 0.6)))
Z_BELLY     = Zone((1570, 1040, 2040, 1140), ('z', 'y'), ((-9.3, 9.3), (2.9, 0.7)))

# ── design constants ─────────────────────────────────────────────────────

# track pods (bagger crawler): profile is (z, y), pod is a mirrored pair
POD_CX = 3.70
POD_HW = 1.55                             # pod half-width → outer edge ±5.25
POD_PROFILE = [                           # outer loop, CCW in (z, y)
    (-9.7, 1.55), (-7.2, 0.12), (7.2, 0.12), (9.7, 1.55),
    (9.1, 2.65), (6.2, 3.0), (-6.2, 3.0), (-9.1, 2.65),
]

# deck + belly hull
DECK_C = (0.0, 3.1, 0.0)
DECK_S = (10.5, 0.4, 19.9)                # y 2.9..3.3, z ±9.95, x ±5.25
BELLY_C = (0.0, 1.85, 0.0)
BELLY_S = (4.3, 2.1, 18.6)

# crew cab (forward, glazed)
CAB_C = (0.0, 5.35, -8.0)
CAB_S = (6.9, 4.1, 2.9)                   # y 3.3..7.4, z -9.45..-6.55
VISOR_C = (0.0, 7.0, -9.55)
VISOR_S = (7.1, 0.16, 0.5)

# beacon + floodlights (all heads inside Z_FLOOD / Z_LIGHT windows)
BEACON_MAST = ((0.0, 7.4, -8.9), (0.0, 7.82, -8.9))
BEACON_C = (0.0, 7.97, -8.9)
BEACON_SZ = 0.34
CAB_FLOODS = [(2.9, 7.75, -9.2), (-2.9, 7.75, -9.2)]
FLOOD_SZ = (0.42, 0.32, 0.34)
BAY_LIGHTS = [(4.05, 6.62, -2.6), (-4.05, 6.62, -2.6),
              (4.05, 6.62, 0.7), (-4.05, 6.62, 0.7)]
BAY_LIGHT_SZ = (0.34, 0.3, 0.3)

# exhaust stacks
EXHAUSTS = [(2.95, -6.2), (-2.95, -6.2)]  # (x, z), y 3.25 → 7.9
EXH_TOP = 7.9

# fabrication bay (open-sided, amidships)
ROOF_C = (0.0, 7.05, -0.9)
ROOF_S = (9.2, 0.4, 7.4)                  # y 6.85..7.25, z -4.6..2.8
COL_X = 4.35
COL_Z = (-4.4, -0.9, 2.5)
COL_TOP = 6.85
WORK_C = (0.3, 3.9, -1.2)                 # workpiece slab being welded
WORK_S = (2.0, 1.2, 3.0)

# stowage
CRATE_ORIGIN = (-3.5, 3.3, 4.4)
TARP_C = (-3.4, 3.3, 6.6)
TARP_S = (1.9, 0.8, 1.6)
BOTTLE_X = 4.55                           # gas bottle rack, +x side aft
BOTTLE_Z = [3.5, 4.1, 4.7, 5.3, 5.9]
BOTTLE_R = 0.27
BOTTLE_H = 1.5
LADDER = ((2.6, 3.4, -6.5), (2.6, 7.3, -6.5))
RAIL_REAR = ((-4.9, 3.3, 9.8), (4.9, 3.3, 9.8))
RAIL_SIDES = [((5.05, 3.3, 3.2), (5.05, 3.3, 9.8)),
              ((-5.05, 3.3, 3.2), (-5.05, 3.3, 9.8))]

# crane (crane_base piece-local; boom is crane_boom piece-local)
CRANE_OFF = (0.0, 3.3, 6.5)
PED_R = 1.15
PED_H = 0.45
HOUSE_C = (0.0, 1.35, 0.35)
HOUSE_S = (2.4, 1.7, 3.0)
CWT_C = (0.0, 1.3, 2.1)
CWT_S = (2.0, 1.2, 0.95)
BOOM_OFF = (0.0, 2.3, -1.2)               # relative to crane_base
BOOM_TIP = (0.0, 4.15, -4.45)             # boom-local (≈42° elevation)
