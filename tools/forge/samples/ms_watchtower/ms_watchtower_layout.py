"""ms_watchtower_layout — zones + dims for ms_watchtower (Staging-post kit).

Staging-post guard watchtower, 10 m to the antenna tip: anchored concrete
pad, four splayed braced legs (ring + X lattice), steel floor slab,
enclosed observation cab with a wrap-around window band, overhanging roof
slab, side ladder, and a roof-corner searchlight — `light` is the only
animated piece (12 s idle yaw sweep, emissive lens).
World frame: searchlight faces -Z at rest, up +Y, ground Y=0. 1024² atlas.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
PAD       = (0.0, 0.14, 0.0, 4.6, 0.28, 4.6)   # cx,cy,cz,w,h,d
PAD_TOP   = 0.28
LEG_BASE  = 1.85            # leg-foot half-spread on the pad
LEG_TOP   = 1.30            # leg half-spread under the floor slab
LEG_TOP_Y = 7.0             # legs meet the floor slab underside
BRACE_Y0, BRACE_Y1 = 2.5, 4.8   # horizontal ring-brace levels
FLOOR     = (0.0, 7.16, 0.0, 3.3, 0.32, 3.3)    # y 7.00..7.32
CAB       = (0.0, 8.16, 0.0, 3.0, 1.68, 3.0)    # y 7.32..9.00
ROOF      = (0.0, 9.16, 0.0, 3.5, 0.32, 3.5)    # y 9.00..9.32
LADDER_Z  = -1.75           # rails just clear of the floor-slab edge
LADDER_X  = 0.17            # rail half-spacing
ANT_X, ANT_Z = -1.45, 1.45  # antenna whip on the rear roof corner
ANT_TOP   = 10.0            # dominant dim: 10 m guard tower
LIGHT_OFF = (0.85, 9.32, -0.85)   # searchlight pivot, front-right roof corner
DRUM_R    = 0.225           # searchlight drum radius (light-local)
DRUM_Y    = 0.52            # drum axis height above the pivot


def _half_at(y):
    """Leg half-spread at height y (legs run LEG_BASE→LEG_TOP linearly)."""
    t = (y - PAD_TOP) / (LEG_TOP_Y - PAD_TOP)
    return LEG_BASE + (LEG_TOP - LEG_BASE) * t


# ── atlas zones (1024²; v down) ──────────────────────────────────────────
R_PAD      = Zone((0,   0,   384, 384), ('x', 'z'), ((-2.3, 2.3), (-2.3, 2.3)))
R_PADS     = Zone((0,   384, 384, 448), ('z', 'y'), ((-2.3, 2.3), (0.30, -0.02)))
R_PADS_F   = Zone((0,   384, 384, 448), ('x', 'y'), ((-2.3, 2.3), (0.30, -0.02)))
R_CAB      = Zone((384, 0,   832, 224), ('z', 'y'), ((-1.55, 1.55), (9.05, 7.27)))
R_CAB_F    = Zone((384, 0,   832, 224), ('x', 'y'), ((-1.55, 1.55), (9.05, 7.27)))
R_CAB_T    = Zone((832, 0,   1024, 192), ('x', 'z'), ((-1.8, 1.8), (-1.8, 1.8)))
R_ROOF_E   = Zone((384, 224, 832, 256), ('z', 'y'), ((-1.8, 1.8), (9.36, 8.96)))
R_ROOF_EF  = Zone((384, 224, 832, 256), ('x', 'y'), ((-1.8, 1.8), (9.36, 8.96)))
R_FLOOR_E  = Zone((384, 256, 832, 288), ('z', 'y'), ((-1.7, 1.7), (7.36, 6.96)))
R_FLOOR_EF = Zone((384, 256, 832, 288), ('x', 'y'), ((-1.7, 1.7), (7.36, 6.96)))
R_FLOOR_T  = Zone((768, 288, 832, 352), ('x', 'z'), ((-1.65, 1.65), (-1.65, 1.65)))
R_LEG      = (832, 192, 1024, 320)    # parametric leg wrap (u along the leg)
R_TRIM     = (832, 320, 1024, 448)    # parametric small-part wrap
R_HOUS     = (384, 288, 768, 352)     # parametric searchlight-drum wrap
R_LENS     = Zone((0,   448, 192, 640), ('x', 'y'), ((-0.20, 0.20), (0.70, 0.28)))
R_DRUM_B   = Zone((192, 448, 320, 576), ('x', 'y'), ((-0.20, 0.20), (0.70, 0.28)))
R_DARK     = Zone((896, 448, 1024, 576), ('x', 'z'), ((-30, 30), (-30, 30)))
