"""factory_layout — zones + dims for fable_factory (generic factory).

Scale is relative to the shipped units: colossus 15 m tall → hall ridge
13.8 m, stacks 17.8 m, on a 30×24 m concrete pad (footprint 15×12).
Same 2048² atlas discipline; big surfaces run lower px/m (like the
heavy's hull) while doors/hatches/details stay near unit density.
World frame: door faces -Z, up +Y, ground Y=0. All geometry lives on
`body` (world = piece-local); only `dish` and `fan` animate (idle clip).
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
F_SIDE     = Zone((0,    0,    1024, 464),  ('z', 'y'), ((-8.4, 10.4), (11.4, 1.0)))
F_ROOF_S   = Zone((0,    464,  1024, 720),  ('x', 'z'), ((-10.4, 6.4), (-8.6, 11.6)))
F_SKY      = Zone((0,    720,  1024, 848),  ('x', 'y'), ((6.4, -10.4), (13.4, 11.0)))
F_PAD      = Zone((0,    848,  1024, 1104), ('x', 'z'), ((-15.2, 15.2), (-12.2, 12.2)))
F_PADS     = Zone((0,    1104, 1024, 1200), ('z', 'y'), ((-15.2, 15.2), (1.35, -0.05)))
F_PADS_F   = Zone((0,    1104, 1024, 1200), ('x', 'y'), ((-15.2, 15.2), (1.35, -0.05)))
F_STACK    = (0, 1200, 512, 1392)     # parametric stack wrap
F_STACK_TOP= Zone((512,  1200, 640,  1328), ('x', 'z'), ((-1.15, 1.15), (-1.15, 1.15)))
F_TANK_TOP = Zone((512,  1328, 640,  1456), ('x', 'z'), ((-1.85, 1.85), (-1.85, 1.85)))
F_TANK     = (640, 1200, 1024, 1392)  # parametric silo wrap
F_VENT     = Zone((0,    1392, 256,  1584), ('z', 'y'), ((-1.0, 1.0), (0.8, -0.8)))
F_CRATE    = Zone((256,  1392, 512,  1584), ('x', 'y'), ((-0.85, 0.85), (0.85, -0.85)))
F_LIGHT    = Zone((0,    1584, 256,  1776), ('x', 'y'), ((-0.5, 0.5), (0.5, -0.5)))
F_DISH     = Zone((256,  1584, 512,  1776), ('x', 'z'), ((-0.85, 0.85), (-0.85, 0.85)))
F_FAN      = Zone((512,  1456, 768,  1712), ('x', 'y'), ((-1.45, 1.45), (1.45, -1.45)))
F_FANH     = (768, 1456, 1024, 1584)  # parametric fan housing wrap
F_CRANE    = Zone((512,  1712, 1024, 1840), ('z', 'y'), ((-13.0, -5.6), (12.6, 11.4)))
F_RAIL     = Zone((0,    1776, 512,  1904), ('z', 'y'), ((-9.0, 9.0), (1.3, -0.1)))
F_TRIM     = Zone((0,    1904, 512,  2032), ('z', 'y'), ((-2.5, 2.5), (0.3, -0.3)))
F_DARK     = Zone((512,  1904, 640,  2032), ('x', 'z'), ((-1, 1), (-1, 1)))
F_TRAFO    = Zone((640,  1904, 1024, 2032), ('z', 'y'), ((-1.3, 1.3), (1.2, -1.2)))

F_FRONT    = Zone((1024, 0,    1792, 464),  ('x', 'y'), ((6.4, -10.4), (11.4, 1.0)))
F_REAR     = Zone((1024, 464,  1792, 928),  ('x', 'y'), ((6.4, -10.4), (11.4, 1.0)))
F_LADDER   = Zone((1792, 0,    2048, 464),  ('z', 'y'), ((-0.6, 0.6), (11.5, 1.0)))
F_DOOR     = Zone((1024, 928,  1536, 1408), ('x', 'y'), ((2.9, -6.9), (9.2, 1.0)))
F_OFFICE   = Zone((1536, 928,  2048, 1272), ('z', 'y'), ((-4.4, 4.4), (7.9, 1.0)))
F_OFFICE_F = Zone((1536, 928,  2048, 1272), ('x', 'y'), ((-4.4, 4.4), (7.9, 1.0)))
F_OFF_ROOF = Zone((1536, 1272, 1792, 1408), ('x', 'z'), ((-4.4, 4.4), (-4.4, 4.4)))
F_HTANK    = (1792, 1272, 2048, 1400)  # horizontal tank wrap
F_PIPE     = (1024, 1408, 1536, 1536)  # parametric pipe wrap
F_HOOK     = Zone((1536, 1408, 2048, 1536), ('x', 'y'), ((-0.6, 0.6), (1.2, -1.2)))

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
PAD        = (0.0, 0.6, 0.0, 30.0, 1.2, 24.0)    # x,y,z,w,h,d plinth
PAD_TOP    = 1.2
HALL       = (-2.0, PAD_TOP + 5.0, 1.0, 16.4, 10.0, 18.4)
HALL_TOP   = PAD_TOP + 10.0                       # 11.2
TEETH      = 4                                    # sawtooth roof segments
TOOTH_D    = 18.4 / TEETH                         # 4.6
RIDGE      = 13.2
DOOR_Z     = 1.0 - 9.2                            # front wall plane (-8.2)
DOOR_FRAME = (-2.0, PAD_TOP + 3.7, DOOR_Z - 0.15, 9.6, 7.8, 0.7)
OFFICE     = (10.4, PAD_TOP + 3.25, -3.0, 8.0, 6.5, 8.6)
OFF_TOP    = PAD_TOP + 6.5                        # 7.7
STACKS     = [(-7.0, 8.0, 1.05, 17.8), (-4.3, 7.0, 0.90, 16.4)]  # x,z,r,top
SILOS      = [(12.2, 7.4), (12.2, 2.2)]           # x,z; r/h below
SILO_R, SILO_TOP = 1.7, 9.7
HTANK      = (-11.8, 2.6, -4.0, 1.35, 6.0)       # x,y,z, r, length (axis z)
MAST       = (13.2, -6.4)                         # office-roof mast x,z
DISH_OFF   = (13.2, OFF_TOP + 2.35, -6.4)         # dish piece offset
FAN_OFF    = (-2.0, 8.4, 10.30)                   # fan piece offset (rear wall)
FAN_R      = 1.30
EXHAUST_OFF = (-7.0, 18.0, 8.0)                   # FX empty at stack 1 tip
