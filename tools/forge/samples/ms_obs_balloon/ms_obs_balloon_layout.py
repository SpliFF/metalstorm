"""ms_obs_balloon_layout — zones + dims for ms_obs_balloon (tethered aerostat).

Tethered observation balloon: ground winch trailer (`body` + spinnable
`wheel1`/`wheel2`), tether (`cable`) and a small finned envelope with a
slung sensor gondola riding at ~22 m (`envelope`). The raised envelope is
the intel TELL — silhouette + team band must read at extreme distance,
so the envelope gets the fattest atlas rows and a high-contrast nose
band/roundel. Dominant dim (envelope top ≈25.6 m) ≥15 m → 2048² atlas.
World frame: hitch/nose forward -Z, up +Y, ground Y=0, 1 unit = 1 m.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
# envelope (piece-local coords: origin at the tether confluence)
Z_ENV_SIDE  = Zone((0,    0,    2048, 512),  ('z', 'y'), ((-4.4, 4.9), (3.6, -0.15)))
Z_ENV_TOP   = Zone((0,    512,  2048, 832),  ('z', 'x'), ((-4.4, 4.9), (-1.9, 1.9)))
Z_ENV_BELLY = Zone((0,    832,  2048, 1120), ('z', 'x'), ((-4.4, 4.9), (-1.9, 1.9)))
Z_FIN       = Zone((0,    1120, 512,  1400), ('z', 'y'), ((2.2, 4.9), (4.5, -1.5)))
Z_GONDOLA   = Zone((512,  1120, 1024, 1400), ('z', 'y'), ((-1.75, -0.05), (0.05, -0.95)))
Z_GONDOLA_F = Zone((512,  1120, 1024, 1400), ('x', 'y'), ((-0.45, 0.45), (0.05, -0.95)))
Z_SENS      = Zone((1024, 1120, 1280, 1400), ('x', 'y'), ((-0.3, 0.3), (-0.3, -0.95)))
# trailer / shared
Z_WHEEL     = Zone((1280, 1120, 1520, 1360), ('z', 'y'), ((-0.62, 0.62), (0.62, -0.62)))
Z_TIRE      = (1520, 1120, 1760, 1240)   # parametric tread wrap
Z_DRUM      = (1520, 1240, 1760, 1360)   # parametric winch-drum wrap
Z_FRAME     = (1760, 1120, 2048, 1240)   # parametric strut/A-frame/axle wrap
Z_CABLEW    = (1760, 1240, 2048, 1320)   # parametric tether/rigging wrap
Z_TRIM      = Zone((1760, 1320, 2048, 1400), ('z', 'y'), ((-4.5, 4.5), (4.5, -0.5)))
Z_BED_TOP   = Zone((0,    1400, 760,  2048), ('x', 'z'), ((-1.3, 1.3), (-2.75, 3.15)))
Z_BED_SIDE  = Zone((760,  1400, 1400, 1552), ('z', 'y'), ((-2.7, 3.1), (1.35, 0.65)))
Z_BED_F     = Zone((1400, 1400, 1704, 1552), ('x', 'y'), ((-1.3, 1.3), (1.35, 0.65)))
Z_CAB       = Zone((760,  1552, 1160, 1836), ('z', 'y'), ((-2.6, -1.1), (2.5, 1.15)))
Z_CAB_F     = Zone((1160, 1552, 1560, 1836), ('x', 'y'), ((-1.05, 1.05), (2.5, 1.15)))
Z_CAB_T     = Zone((1560, 1552, 1856, 1704), ('x', 'z'), ((-1.05, 1.05), (-2.6, -1.1)))
Z_DARK      = Zone((1704, 1400, 1856, 1552), ('x', 'z'), ((-6, 6), (-6, 6)))
Z_LIGHT     = Zone((1856, 1400, 2008, 1552), ('x', 'y'), ((-0.15, 0.15), (3.30, 3.04)))

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
# winch trailer (body)
BED       = (0.0, 1.0, 0.2, 2.3, 0.5, 5.4)     # cx,cy,cz,w,h,d
BED_TOP   = 1.25
CAB       = (0.0, 1.85, -1.85, 1.95, 1.2, 1.3)  # equipment/control cabinet
WHEEL_R, WHEEL_W = 0.55, 0.32
WHEEL_POS = [(-1.32, 0.55, 1.1), (1.32, 0.55, 1.1)]
DRUM_C    = (0.0, 1.62, 0.9)                    # winch drum (axis along x)
DRUM_R, DRUM_HL = 0.42, 0.62
CRADLE    = (0.0, 1.40, 0.9, 1.5, 0.32, 0.92)   # drum cradle on the bed
MOTOR     = (-0.82, 1.62, 0.9, 0.45, 0.5, 0.72) # winch motor at the drum end
APEX      = (0.0, 3.1, 0.35)                    # A-frame apex
AFRAME    = [(-0.78, BED_TOP, 1.55), (0.78, BED_TOP, 1.55)]  # leg roots
FAIRLEAD  = (0.0, 3.12, 0.35, 0.42, 0.34, 0.5)  # cable fairlead block
OUTRIGGERS = [(-1.05, -2.2), (1.05, -2.2), (-1.05, 2.6), (1.05, 2.6)]
HITCH     = (0.0, 0.55, -3.5, 0.26, 0.3, 0.36)  # tow hitch head
DRAWBAR   = [(-0.5, 0.85, -2.55), (0.5, 0.85, -2.55)]

# tether
CABLE_OFF = (0.0, 3.2, 0.35)    # cable piece pivot (sway origin, at fairlead)
CABLE_LEN = 18.9                # pivot → envelope confluence
ENV_OFF   = (0.0, CABLE_LEN, 0.0)   # envelope origin ≈22.1 m up

# envelope (piece-local; origin = tether confluence under the belly)
ENV_CY  = 1.75                  # hull axis height above confluence
ENV_N   = 10                    # ring facets
ENV_SECTIONS = [                # (z, r) along the hull axis, nose -Z
    (-4.1, 0.30), (-3.3, 0.95), (-2.1, 1.50), (-0.6, 1.72),
    (1.0, 1.62), (2.6, 1.15), (3.9, 0.55), (4.6, 0.22),
]
FIN_DIRS = [(0.0, 1.0), (0.866, -0.5), (-0.866, -0.5)]  # inverted-Y tail
FIN_RIN, FIN_ROUT = 0.9, 2.55   # span, root buried in the hull
FIN_ZR = (2.3, 4.35)            # root chord z range
FIN_ZT = (3.35, 4.75)           # tip chord z range (swept aft)
FIN_TH = (0.14, 0.06)           # thickness root → tip
GONDOLA = (0.0, -0.35, -0.9, 0.7, 0.62, 1.4)   # slung sensor gondola
SENSOR  = (0.0, -0.62, -1.55, 0.42)            # ball housing (cx,cy,cz,size)
BEACON  = (0.0, 3.17, 1.8, 0.24, 0.22, 0.24)   # anti-collision beacon
RIGGING = [(-0.55, 0.75, -1.7), (0.55, 0.75, -1.7),
           (-0.55, 0.62, 1.3), (0.55, 0.62, 1.3)]  # confluence → belly
