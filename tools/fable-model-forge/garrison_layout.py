"""garrison_layout — zones + dims for ms_garrison (Infantry muster).

Footprint 10×10 → 20×20 m walled compound: perimeter blast wall with a
-Z gatehouse, two barracks halls (left/right), armory block, watchtower
with rotating sensor (`dish`, idle clip), muster yard with formation
markings, flag mast, sandbag posts, crate/tank props. Building doctrine
(§21): texture-led, everything on `body` except the sensor.
World frame: gate faces -Z, up +Y, ground Y=0. 2048² atlas.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── dims (world metres) ──────────────────────────────────────────────────
PAD_HALF   = 10.4            # concrete pad half-extent (slight overhang ok)
WALL_HALF  = 9.6             # perimeter wall centreline half-extent
WALL_H     = 2.6
WALL_T     = 0.5
GATE_W     = 3.4             # gate opening half-width = GATE_W/2
GATE_H     = 3.4             # gatehouse tower height
# barracks halls: (cx, cz, w, d, wall_h, ridge_h)
BK1 = (-5.6, 0.6, 6.2, 11.0, 3.4, 4.6)
BK2 = (5.6, 2.6, 6.2, 9.0, 3.4, 4.6)
# armory block (rear-centre; clear of both halls)
ARM = (0.0, 7.9, 4.6, 2.6, 3.0)
# fuel tank (front-left corner, axis z)
TANK_X, TANK_Z = -7.8, -6.8
# watchtower (front-right corner)
TWR_X, TWR_Z = 6.9, -6.6
TWR_H = 7.6                  # cab floor
TWR_TOP = 9.4                # roof
DISH_OFF = (TWR_X, TWR_TOP + 0.1, TWR_Z)
FLAG_X, FLAG_Z = -1.6, -4.2

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
G_PAD    = Zone((0,    0,    900,  900), ('x', 'z'), ((-10.4, 10.4), (-10.4, 10.4)))
# perimeter wall bands (outer+inner share; world-anchored)
G_WALL   = Zone((900,  0,    2048, 170), ('x', 'y'), ((-10.4, 10.4), (2.75, -0.05)))
G_WALL_Z = Zone((900,  0,    2048, 170), ('z', 'y'), ((-10.4, 10.4), (2.75, -0.05)))
G_WALLTOP= Zone((900,  170,  2048, 210), ('x', 'z'), ((-10.4, 10.4), (-10.4, 10.4)))
# barracks: side (±x faces, z along u) / end (±z faces) / roof slopes
G_BK_S1  = Zone((0,    900,  760,  1130), ('z', 'y'), ((-4.9, 6.1), (3.6, -0.05)))
G_BK_S2  = Zone((0,    900,  760,  1130), ('z', 'y'), ((-1.9, 7.1), (3.6, -0.05)))
G_BK_E1  = Zone((760,  900,  1180, 1130), ('x', 'y'), ((-8.7, -2.5), (3.6, -0.05)))
G_BK_E2  = Zone((760,  900,  1180, 1130), ('x', 'y'), ((2.5, 8.7), (3.6, -0.05)))
G_BK_R1  = Zone((0,    1130, 760,  1470), ('x', 'z'), ((-8.7, -2.5), (-4.9, 6.1)))
G_BK_R2  = Zone((0,    1130, 760,  1470), ('x', 'z'), ((2.5, 8.7), (-1.9, 7.1)))
# armory
G_ARM_S  = Zone((1180, 900,  1660, 1090), ('x', 'y'), ((2.3, -2.3), (3.1, -0.05)))
G_ARM_SZ = Zone((1180, 900,  1660, 1090), ('z', 'y'), ((6.6, 9.2), (3.1, -0.05)))
G_ARM_R  = Zone((1180, 1090, 1660, 1280), ('x', 'z'), ((-2.3, 2.3), (6.6, 9.2)))
# watchtower
G_TWR    = (900,  210,  1240, 420)   # parametric leg/mast wrap
G_TWR_CAB= Zone((1240, 210,  1704, 420), ('x', 'y'), ((TWR_X - 1.3, TWR_X + 1.3), (9.5, 7.4)))
G_TWR_CABZ=Zone((1240, 210,  1704, 420), ('z', 'y'), ((TWR_Z - 1.3, TWR_Z + 1.3), (9.5, 7.4)))
G_TWR_TOP= Zone((1704, 210,  1948, 420), ('x', 'z'), ((TWR_X - 1.3, TWR_X + 1.3), (TWR_Z - 1.3, TWR_Z + 1.3)))
# gatehouse towers
G_GATE   = Zone((900,  420,  1350, 640), ('x', 'y'), ((3.2, -3.2), (3.5, -0.05)))
G_GATE_Z = Zone((900,  420,  1350, 640), ('z', 'y'), ((-10.4, -6.8), (3.5, -0.05)))
G_GATE_T = Zone((1350, 420,  1600, 640), ('x', 'z'), ((-3.2, 3.2), (-10.4, -6.8)))
# props
G_CRATE  = Zone((1600, 640,  1900, 900), ('x', 'y'), ((-0.6, 0.6), (0.9, -0.1)))
G_TANKW  = (900,  640,  1240, 780)   # parametric fuel-tank wrap
G_DISH   = Zone((1240, 640,  1560, 860), ('x', 'z'), ((-0.9, 0.9), (-0.9, 0.9)))
G_DISH_B = Zone((1240, 860,  1560, 900), ('x', 'z'), ((-0.9, 0.9), (-0.9, 0.9)))
G_FLAG   = (1900, 640,  2048, 780)   # parametric mast wrap
G_LIGHT  = Zone((1900, 780,  2048, 900), ('x', 'y'), ((-0.1, 0.1), (0.1, -0.1)))
G_DARK   = Zone((1948, 420,  2048, 520), ('x', 'z'), ((-30, 30), (-30, 30)))
G_DOOR   = Zone((1660, 900,  1860, 1140), ('x', 'y'), ((-0.8, 0.8), (2.4, 0.0)))
