"""ms_meeting_hall_layout — zones + dims for ms_meeting_hall (civic hall).

Civilian estate: 18x12 m gabled meeting hall, the parley venue. Timber
and salvage but the ONE cared-for building in town: straight lines,
cleaner paint. Porch with posts on the -Z front, twin front doors,
tall lit windows (warm emissive), noticeboard, small bell tower with
the `bell` piece (idle sway clip). Dominant dim 18 m >= 15 -> 2048^2.
World frame: doors face -Z, up +Y, ground Y=0. No team colour.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
# hall body: x -9..9, z -3.5..6.0 (porch fills z -6..-3.5 -> 18x12 total)
HALL_W   = 18.0
HALL_Z0, HALL_Z1 = -3.5, 6.0
EAVE_Y   = 4.2
RIDGE_Y  = 6.85
RIDGE_Z  = (HALL_Z0 + HALL_Z1) / 2          # 1.25
OVER     = 0.45                              # roof overhang
ROOF_X0, ROOF_X1 = -9.0 - OVER, 9.0 + OVER
# porch (front, -Z): floor slab + 4 posts + shed roof
PORCH_Z0, PORCH_Z1 = -6.0, HALL_Z0
PORCH_FLOOR_Y = 0.28                         # top of the deck
PORCH_ROOF_LO = 3.30                         # front edge height
PORCH_ROOF_HI = 3.85                         # wall edge height
PORCH_POST_X  = (-7.6, -2.6, 2.6, 7.6)
PORCH_POST_Z  = -5.6
# twin front doors (painted on the front wall)
DOOR_W  = 2.4                                # both leaves together
DOOR_H  = 2.5
DOOR_X  = 0.0
# noticeboard box on the front wall, right of the doors
NOTICE  = (4.1, 1.75, HALL_Z0 - 0.10, 2.2, 1.3, 0.14)   # cx,cy,cz,w,h,d
# bell tower: square shaft through the roof at the front-left corner
TWR_X, TWR_Z = -6.6, -2.5
TWR_SZ  = 1.7
TWR_TOP = 8.3                                # top of the closed shaft
BELFRY_TOP = 9.35                            # top of the corner posts
CAP_APEX  = 10.15                            # pyramid cap apex
CAP_HALF  = 1.05                             # cap base half-width
BELL_OFF  = (TWR_X, BELFRY_TOP - 0.10, TWR_Z)  # `bell` piece origin (pivot)

# ── atlas zones (2048^2; v down) ─────────────────────────────────────────
# roof: both slopes project in plan; front z -4..1.25, rear 1.25..6.5
C_ROOF   = Zone((0, 0, 1024, 640), ('x', 'z'),
                ((-9.6, 9.6), (-4.1, 6.6)))
C_WALL_F = Zone((0, 640, 1024, 1100), ('x', 'y'),
                ((9.4, -9.4), (4.45, -0.05)))
C_WALL_R = Zone((1024, 640, 2048, 1100), ('x', 'y'),
                ((-9.4, 9.4), (4.45, -0.05)))
C_WALL_S = Zone((1024, 0, 2048, 640), ('z', 'y'),
                ((-4.0, 6.5), (7.1, -0.05)))
C_PORCHF = Zone((0, 1100, 512, 1300), ('x', 'z'),
                ((-9.2, 9.2), (-6.2, -3.3)))
C_PROOF  = Zone((512, 1100, 1024, 1300), ('x', 'z'),
                ((-9.5, 9.5), (-6.5, -3.2)))
C_MAST   = (1024, 1100, 1216, 1180)          # posts / limbs wrap (rect)
C_TOWER  = (1216, 1100, 1560, 1500)          # tower shaft (zbox rect)
C_TROOF  = (1560, 1100, 1800, 1340)          # belfry pyramid cap (rect)
C_BELL   = (1800, 1100, 1960, 1260)          # bell wrap (rect)
C_NOTICE = (0, 1300, 320, 1500)              # noticeboard (zbox rect)
C_STEP   = (320, 1300, 640, 1380)            # porch steps / skirt (zbox rect)
C_DARK   = Zone((1900, 1900, 2048, 2048), ('x', 'z'), ((-30, 30), (-30, 30)))
