"""ms_airbase_layout — zones + dims for ms_airbase (air-forces factory).

Spread-out airfield structure, 39.5 m (x) x 27.5 m (z) footprint on a flat
concrete apron slab: painted runway strip along x with centreline dashes and
threshold bars, two hard-stand pad circles, a big painted team roundel, an
open-front corrugated Nissen-style hangar along the +z edge (open front
faces -z, dark interior with an amber work glow), a lattice control tower at
the +x/+z corner with a glazed cab, red-amber beacon and a spinning `dish`
radar panel (idle = one 360-degree yaw / 8 s), plus windsock, fuel drums,
bowser and two floodlight masts. Ground Y=0, -Z forward, 2048 atlas.
"""
import math
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ---- footprint (20x14 cells -> 40x28 m, stay a touch inside) --------------
APRON_W = 39.5          # along x
APRON_D = 27.5          # along z
SLAB_H = 0.30           # apron slab thickness (top at y = 0.30)
SLAB_CH = 0.06
GRID_NX, GRID_NZ = 20, 14   # apron-top quad grid (bake fidelity for markings)

# ---- hangar (open front faces -z, along the +z long edge) -----------------
HANG_Z0 = 4.9           # open front plane
HANG_Z1 = 13.6          # back wall plane
INNER_SCALE = 0.97      # inner shell = outer profile scaled about origin
# arch profile (x, y): vertical wall, arc, flat-ish ridge at 10.3 m
PROF = [(-10.2, 0.0), (-10.2, 5.4), (-7.6, 8.8), (-2.8, 10.3),
        (2.8, 10.3), (7.6, 8.8), (10.2, 5.4), (10.2, 0.0)]
_seg = [math.dist(PROF[i], PROF[i + 1]) for i in range(len(PROF) - 1)]
ARC_TOT = sum(_seg)
ARC_F = [0.0]
for _s in _seg:
    ARC_F.append(ARC_F[-1] + _s / ARC_TOT)   # cumulative arc fractions 0..1

JAMB_X = 9.7            # hazard-banded door jamb columns at the opening
JAMB_SIZE = (0.75, 4.8, 0.7)
JAMB_Z = 5.3

# ---- control tower (piece `tower`, local frame, offset places it) ---------
TOWER_OFF = (17.0, 0.0, 10.5)
T_PAD = (0.0, 0.14, 0.0, 3.8, 0.28, 3.8)
T_LAT_BASE_Y, T_LAT_TOP_Y = 0.28, 10.4
T_LAT_HB, T_LAT_HT = 1.7, 1.05
T_FLOOR = (0.0, 10.56, 0.0, 3.1, 0.32, 3.1)   # y 10.40..10.72
T_CAB = (0.0, 11.66, 0.0, 2.7, 1.88, 2.7)     # y 10.72..12.60
T_ROOF = (0.0, 12.775, 0.0, 3.1, 0.35, 3.1)   # y 12.60..12.95
MAST_Y0, MAST_Y1 = 12.95, 13.62
DISH_OFF = (0.0, 13.55, 0.0)                  # dish piece offset (tower-local)
BEACON_XZ = 1.25
BEACON_MAST_Y1 = 13.8
BEACON_C = (BEACON_XZ, 13.92, BEACON_XZ)
BEACON_S = 0.26

# ---- clutter (all on `base`) -----------------------------------------------
DRUM_ROW = (11.6, 0.0, 9.6)     # 4 drums
DRUM_ROW2 = (11.9, 0.0, 8.6)    # 2 drums
BOWSER = (12.9, 0.7, 6.9, 2.6, 1.3, 1.5)
FLOOD_A = (-18.6, 12.6)         # floodlight mast bases (x, z)
FLOOD_B = (18.6, -12.7)
FLOOD_H = 7.2
SOCK_BASE = (-17.6, 0.0, -12.7)
SOCK_H = 5.5

# ---- painted airfield markings (world coords on the apron top) ------------
RUN_Z0, RUN_Z1 = -11.5, -3.5    # runway strip band (full x length)
PAD_A = (-13.5, 0.8)            # hard-stand pad circle centres (x, z)
PAD_B = (-4.5, 0.8)
PAD_R = 3.4
ROUNDEL = (5.0, 0.6, 3.1)       # cx, cz, r  (team roundel)

# ---- atlas zones (2048 sq; v down) -----------------------------------------
R_APRON = Zone((0, 0, 1480, 1030), ('x', 'z'),
               ((-19.75, 19.75), (-13.75, 13.75)))
R_APRON_SX = Zone((0, 1038, 1480, 1066), ('x', 'y'),
                  ((-19.75, 19.75), (0.34, -0.02)))
R_APRON_SZ = Zone((0, 1072, 740, 1100), ('z', 'y'),
                  ((-13.75, 13.75), (0.34, -0.02)))
R_BACK = Zone((0, 1108, 764, 1504), ('x', 'y'), ((-10.3, 10.3), (10.5, -0.2)))
R_GLOW = Zone((772, 1108, 1536, 1504), ('x', 'y'), ((-10.3, 10.3), (10.5, -0.2)))

R_JAMB_A = Zone((0, 1512, 90, 1868), ('x', 'y'), ((9.31, 10.09), (5.05, -0.05)))
R_JAMB_B = Zone((98, 1512, 188, 1868), ('x', 'y'),
                ((-10.09, -9.31), (5.05, -0.05)))
R_PADT = Zone((200, 1512, 400, 1712), ('x', 'z'), ((-1.95, 1.95), (-1.95, 1.95)))
R_PADS = Zone((410, 1512, 660, 1556), ('x', 'y'), ((-1.95, 1.95), (0.31, -0.02)))
R_PADS_F = Zone((410, 1512, 660, 1556), ('z', 'y'), ((-1.95, 1.95), (0.31, -0.02)))
R_SLAB = Zone((410, 1564, 660, 1608), ('z', 'y'), ((-1.6, 1.6), (10.78, 10.34)))
R_SLAB_F = Zone((410, 1564, 660, 1608), ('x', 'y'), ((-1.6, 1.6), (10.78, 10.34)))
R_ROOFE = Zone((410, 1616, 660, 1660), ('z', 'y'), ((-1.6, 1.6), (12.99, 12.55)))
R_ROOFE_F = Zone((410, 1616, 660, 1660), ('x', 'y'), ((-1.6, 1.6), (12.99, 12.55)))
R_DARKZ = Zone((680, 1564, 780, 1664), ('x', 'z'), ((-40, 40), (-40, 40)))
R_BOWSER = Zone((800, 1512, 1100, 1656), ('x', 'y'), ((11.4, 14.4), (1.5, 0.0)))
R_SOCK = (1120, 1512, 1260, 1632)      # rect: windsock cone wrap
R_DISHR = (1280, 1512, 1420, 1632)     # rect: dish hub/brace limbs
R_DISHP = Zone((800, 1680, 1240, 1830), ('x', 'y'), ((-1.35, 1.35), (1.08, 0.02)))
R_BEACON = Zone((1280, 1680, 1400, 1800), ('x', 'y'),
                ((1.07, 1.43), (14.10, 13.74)))
R_FLOOD_A = Zone((0, 1900, 300, 2040), ('x', 'y'),
                 ((-19.15, -18.05), (7.75, 7.15)))
R_FLOOD_B = Zone((0, 1900, 300, 2040), ('x', 'y'),
                 ((18.05, 19.15), (7.75, 7.15)))

R_ARCH = (1488, 0, 2044, 540)          # rect: hangar shell outer (explicit uvs)
R_INT = (1488, 548, 1756, 668)         # rect: hangar shell inner (dark)
R_RIM = (1764, 548, 2044, 668)         # rect: front rim fascia
R_LEG = (1488, 676, 1700, 796)         # rect: lattice legs
R_TRIM = (1708, 676, 1920, 796)        # rect: braces/masts/misc steel
R_DRUM = Zone((1488, 804, 1764, 924), ('x', 'y'), ((11.2, 14.2), (1.18, -0.05)))
R_CAB = Zone((1488, 932, 1900, 1092), ('z', 'y'), ((-1.6, 1.6), (12.72, 10.62)))
R_CAB_F = Zone((1488, 932, 1900, 1092), ('x', 'y'), ((-1.6, 1.6), (12.72, 10.62)))
R_CAB_T = Zone((1908, 932, 2044, 1068), ('x', 'z'), ((-1.65, 1.65), (-1.65, 1.65)))
