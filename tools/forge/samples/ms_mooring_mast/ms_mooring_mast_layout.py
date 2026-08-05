"""ms_mooring_mast_layout — zones + dims for ms_mooring_mast.

Airship mooring mast (transport terminus): 20 m total height, sized
against the 65 m fable_airship (nose spike root r=0.55, gen_airship —
the head's receiver cone mouth is 1.05 m so the spike seats inside).
Concrete anchor pad + equipment hut, four-leg tapering lattice tower on
footing blocks, external constant-radius spiral boarding stair with
handrail + support struts, railed top platform (parapet gap at the -Z
stair arrival), and a rotating mooring head (`head` piece, idle clip:
slow 360° weathervane) carrying the receiver cone, boarding gangway,
counterweight and the red aviation beacon (`beacon` piece, emissive).
`dock` is an empty attachment piece at the cone mouth.
World frame: gangway/dock faces -Z at rest, up +Y, ground Y=0.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
R_PAD     = Zone((0,    0,    704,  704),  ('x', 'z'), ((-5.4, 5.4), (-5.4, 5.4)))
R_PADS    = Zone((0,    704,  704,  768),  ('z', 'y'), ((-5.4, 5.4), (0.55, -0.05)))
R_PADS_F  = Zone((0,    704,  704,  768),  ('x', 'y'), ((-5.4, 5.4), (0.55, -0.05)))
R_HUT     = Zone((704,  0,    1152, 320),  ('z', 'y'), ((1.85, 4.35), (2.3, 0.4)))
R_HUT_F   = Zone((704,  0,    1152, 320),  ('x', 'y'), ((1.75, 4.45), (2.3, 0.4)))
R_HUT_T   = Zone((1152, 0,    1408, 192),  ('x', 'z'), ((1.85, 4.35), (1.95, 4.25)))
R_TRIM    = (1152, 192, 1408, 320)   # parametric small-part wrap
R_PLAT    = Zone((1408, 0,    1920, 512),  ('x', 'z'), ((-3.3, 3.3), (-3.3, 3.3)))
R_BEACON  = Zone((1920, 0,    2048, 128),  ('x', 'y'), ((-0.25, 0.25), (0.7, 0.2)))
R_DARK    = Zone((1920, 128,  2048, 256),  ('x', 'z'), ((-1, 1), (-1, 1)))
R_ANCHOR  = Zone((1920, 256,  2048, 384),  ('x', 'z'), ((-0.45, 0.45), (-0.45, 0.45)))
R_TOWER   = (704,  320, 1152, 448)   # parametric lattice wrap (legs/braces/rings)
R_STAIR   = (704,  448, 1152, 704)   # parametric stair ribbon (u along, v bands)
R_RIM     = (1408, 512, 1920, 640)   # parametric platform rim + parapet wrap
R_HEAD    = (0,    768, 512,  896)   # parametric head drum wrap (u = height)
R_HEAD_T  = Zone((0,    896,  256,  1152), ('x', 'z'), ((-1.0, 1.0), (-1.0, 1.0)))
R_CONE    = (512,  768, 1024, 896)   # parametric cone wrap (u = along, mouth right)
R_CONE_IN = (512,  896, 1024, 1024)  # parametric cone interior
R_GANG    = Zone((1024, 768,  1472, 1024), ('z', 'y'), ((-2.75, -0.65), (0.95, -0.05)))
R_GANG_F  = Zone((1024, 768,  1472, 1024), ('x', 'y'), ((-0.62, 0.62), (0.95, -0.05)))
R_GANG_T  = Zone((1472, 768,  1728, 896),  ('x', 'z'), ((-0.62, 0.62), (-2.75, -0.65)))
R_CW      = Zone((1728, 768,  1984, 1024), ('z', 'y'), ((0.85, 1.95), (0.95, 0.05)))
R_CW_F    = Zone((1728, 768,  1984, 1024), ('x', 'y'), ((-0.55, 0.55), (0.95, 0.05)))
R_CW_T    = Zone((1472, 896,  1728, 1024), ('x', 'z'), ((-0.55, 0.55), (0.9, 1.9)))

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
PAD       = (0.0, 0.25, 0.0, 10.8, 0.5, 10.8)
PAD_TOP   = 0.5
HUT       = (3.1, 1.35, 3.1, 2.4, 1.7, 2.2)          # x,y,z,w,h,d

LEG_BASE_W, LEG_TOP_W = 1.85, 0.95     # half-width of the leg square
TOWER_TOP  = 17.5
LEG_R0, LEG_R1 = 0.11, 0.07
RINGS      = (3.4, 6.3, 9.2, 12.1, 15.0)             # ring-frame heights
BAY_BOUNDS = (0.5, 3.4, 6.3, 9.2, 12.1, 15.0, 17.5)  # X-brace bays
FOOTINGS   = [(LEG_BASE_W, LEG_BASE_W), (-LEG_BASE_W, LEG_BASE_W),
              (-LEG_BASE_W, -LEG_BASE_W), (LEG_BASE_W, -LEG_BASE_W)]
FOOTING_SZ = (0.8, 0.4, 0.8)             # sits on the pad under each leg

STAIR_Y0, STAIR_Y1 = 0.5, 17.9
STAIR_TURNS = 2.25
STAIR_A1    = -1.5707963267948966       # ends facing -Z (gangway side)
STAIR_A0    = STAIR_A1 - STAIR_TURNS * 6.283185307179586
STAIR_SEGS  = 30
STAIR_R     = 2.75                       # helix centreline radius
STAIR_W     = 0.95                       # ribbon width
STAIR_TH    = 0.4                        # ribbon depth
RAIL_H      = 1.0                        # handrail top above tread
RAIL_BAND   = 0.12                       # rail ribbon height
RAIL_POST_EVERY = 3                      # segs between rail posts
STRUT_EVERY = 5                          # segs between tower support struts

PLAT_R     = 3.15                        # octagon deck radius
PLAT_Y0, PLAT_Y1 = 17.5, 17.9            # deck slab bottom/top
PARAPET_TOP = 18.35
PARAPET_R_IN = 2.95

HEAD_OFF   = (0.0, 17.9, 0.0)            # head piece pivot (rotates in idle)
DRUM_R0, DRUM_R1, DRUM_H = 0.92, 0.82, 1.3
CONE_Y     = 0.75                        # cone axis height (head-local)
CONE_Z0, CONE_R0 = -0.85, 0.28           # attach end (buried in the drum)
CONE_Z1, CONE_R1 = -2.6, 1.05            # mouth (catches the airship nose)
CONE_R_IN  = 0.85                        # inner mouth radius
CONE_APEX_Z = -1.5                       # interior cup apex
GANGWAY    = (0.0, 0.45, -1.7, 1.1, 0.9, 1.9)
CW         = (0.0, 0.5, 1.4, 1.0, 0.9, 1.0)
BEACON_OFF = (0.0, 1.3, 0.0)             # beacon piece origin (head-local)
BEACON_POST_H = 0.25
BEACON_BOX = (0.0, 0.45, 0.0, 0.42, 0.4, 0.42)
BEACON_TIP = 0.8                         # finial top → world 20.0 m
DOCK_OFF   = (0.0, CONE_Y, -2.7)         # empty: airship nose attach point
