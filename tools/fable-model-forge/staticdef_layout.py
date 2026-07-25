"""staticdef_layout — zones + dims for ms_staticdefense_s1 (Gun nest cluster).

STYLE.md static-defense row: s1 height (emplacement) = 3 m, ≤2000 tris.
Immobile footprint-3 building (6x6 m): octagonal concrete revetment ring
with a sandbag-topped rim, sunken floor, central armored plinth carrying a
rotating autocannon turret (twin tubes). Piece chain body → turret →
barrel → muzzle so §16c cosmetic aim drives it like any vehicle.
World frame: guns face -Z at rest, up +Y, ground Y=0.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
RING_R_OUT   = 2.95          # revetment outer radius at ground
RING_R_TOP   = 2.62          # outer radius at rim top (sloped berm)
RING_R_INR   = 2.18          # inner radius of the rim
RING_H       = 1.18          # rim top height
FLOOR_Y      = 0.16          # sunken pit floor
PLINTH_R     = 0.98
PLINTH_H     = 1.30          # plinth top = turret ring
TURRET_Y     = PLINTH_H - 0.06   # turret pivot height (embedded 6 cm, §10)
GH_W, GH_H, GH_D = 1.52, 0.74, 1.80   # gunhouse envelope (local)
TRUN_Y       = 0.48          # trunnion height above turret pivot
TRUN_Z       = -0.48         # trunnion Z (turret-local)
BARREL_LEN   = 2.55          # tube length from trunnion
BARREL_ELEV  = 8.0           # baked elevation, degrees
GUN_GAP      = 0.17          # half-distance between twin bores

# ── atlas zones (1024²; v down) ──────────────────────────────────────────
# top-down world zone: berm rim + pit floor + pad
S_TOP    = Zone((0,   0,   512, 512), ('x', 'z'), ((-3.0, 3.0), (-3.0, 3.0)))
# outer/inner revetment wall bands (world-anchored, both axes share the rect)
S_WALL   = Zone((0,   512, 512, 640), ('x', 'y'), ((-3.0, 3.0), (1.25, -0.05)))
S_WALL_Z = Zone((0,   512, 512, 640), ('z', 'y'), ((-3.0, 3.0), (1.25, -0.05)))
S_PLINTH = (512, 0, 832, 128)        # parametric drum wrap
S_PLINTH_T = Zone((832, 0, 1024, 192), ('x', 'z'), ((-1.1, 1.1), (-1.1, 1.1)))
# gunhouse (turret-local coords)
S_GH_S   = Zone((512, 128, 896, 320), ('z', 'y'), ((-1.00, 1.00), (0.80, -0.04)))
S_GH_F   = Zone((512, 320, 832, 448), ('x', 'y'), ((0.80, -0.80), (0.80, -0.04)))
S_GH_R   = Zone((512, 320, 832, 448), ('-x', 'y'), ((0.80, -0.80), (0.80, -0.04)))
S_GH_T   = Zone((0,   640, 384, 1024), ('x', 'z'), ((-0.80, 0.80), (-1.00, 1.00)))
# barrel/cradle
S_GUN    = (384, 640, 768, 736)      # parametric tube wrap
S_CRADLE = Zone((384, 736, 640, 896), ('x', 'y'), ((-0.55, 0.55), (0.35, -0.35)))
# greebles
S_AMMO   = Zone((768, 640, 960, 832), ('x', 'y'), ((-0.45, 0.45), (0.55, -0.15)))
S_SENSOR = (640, 736, 768, 832)      # parametric sensor-head wrap
S_DARK   = Zone((896, 448, 1024, 576), ('x', 'z'), ((-9, 9), (-9, 9)))
S_LIGHT  = Zone((896, 832, 1024, 960), ('x', 'y'), ((-0.1, 0.1), (0.1, -0.1)))
S_MUZZ   = Zone((832, 192, 960, 256), ('x', 'y'), ((-9, 9), (9, -9)))
# sandbag courses (world-anchored band across the rim-bag height)
S_BAGS   = Zone((832, 256, 1024, 448), ('x', 'y'), ((-3.0, 3.0), (1.56, 1.04)))
S_BAGS_Z = Zone((832, 256, 1024, 448), ('z', 'y'), ((-3.0, 3.0), (1.56, 1.04)))
