"""civkit_layout — shared zones + dims for the civilian prop kit.

FIVE models for the already-shipped civilian unitdefs (which had no
models): ms_habitat, ms_transit_hub, ms_depot, ms_civtruck, ms_civbus.
All five share ONE 2048² texture set (stem `fable_civkit`) — each
exported glTF has its image URIs rewritten to the shared files, so the
whole kit costs one model's texture weight.  Civilian palette breaks
from the military grey: warm concrete, muted teal/rust panels, lit
windows.  Buildings sit on Y=0; vehicles rest wheels at Y=0,
forward -Z.  Static bodies; vehicle axles are separate pieces (the
script API — a future script can Spin them).
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── habitat block ────────────────────────────────────────────────────────
H_SIDE  = Zone((0,    0,    768,  320),  ('z', 'y'), ((-14.0, 14.0), (21.0, -0.5)))
H_FRONT = Zone((768,  0,    1280, 320),  ('x', 'y'), ((13.0, -13.0), (21.0, -0.5)))
H_ROOF  = Zone((1280, 0,    1664, 256),  ('x', 'z'), ((-13.0, 13.0), (-13.0, 13.0)))
# ── transit hub ──────────────────────────────────────────────────────────
T_SIDE  = Zone((0,    320,  768,  576),  ('z', 'y'), ((-16.0, 16.0), (9.5, -0.5)))
T_FRONT = Zone((768,  320,  1280, 576),  ('x', 'y'), ((12.5, -12.5), (9.5, -0.5)))
T_ROOF  = Zone((1280, 256,  1664, 512),  ('x', 'z'), ((-12.5, 12.5), (-16.0, 16.0)))
T_CANOPY= Zone((1664, 0,    2048, 256),  ('x', 'z'), ((-14.0, 14.0), (2.0, 18.0)))
T_SIGN  = Zone((1408, 1088, 1792, 1216), ('x', 'y'), ((5.2, -5.2), (9.1, 7.5)))
# ── depot ────────────────────────────────────────────────────────────────
D_SIDE  = Zone((0,    576,  768,  832),  ('z', 'y'), ((-12.0, 12.0), (8.5, -0.5)))
D_FRONT = Zone((768,  576,  1280, 832),  ('x', 'y'), ((11.5, -11.5), (8.5, -0.5)))
D_ROOF  = Zone((1280, 512,  1664, 768),  ('x', 'z'), ((-11.5, 11.5), (-12.0, 12.0)))
CRATE   = Zone((1664, 256,  1920, 512),  ('z', 'y'), ((-45, 45), (25, -5)))
TANKW   = (1664, 512, 1920, 640)         # parametric fuel-tank wrap
# ── vehicles ─────────────────────────────────────────────────────────────
B_SIDE  = Zone((0,    832,  1024, 1088), ('z', 'y'), ((-5.6, 5.6), (3.6, 0.0)))
B_FRONT = Zone((1024, 832,  1408, 1088), ('x', 'y'), ((1.45, -1.45), (3.6, 0.0)))
B_ROOF  = Zone((1408, 832,  1792, 960),  ('x', 'z'), ((-1.45, 1.45), (-5.6, 5.6)))
K_SIDE  = Zone((0,    1088, 1024, 1344), ('z', 'y'), ((-4.3, 4.3), (3.6, 0.0)))
K_FRONT = Zone((1024, 1088, 1408, 1344), ('x', 'y'), ((1.35, -1.35), (3.6, 0.0)))
K_ROOF  = Zone((1408, 960,  1792, 1088), ('x', 'z'), ((-1.35, 1.35), (-4.3, 4.3)))
WHEEL   = Zone((1664, 640,  1920, 768),  ('z', 'y'), ((-45, 45), (25, -5)))
HUB     = Zone((1920, 896,  2048, 1024), ('x', 'z'), ((-45, 45), (-45, 45)))
# ── shared cells ─────────────────────────────────────────────────────────
TRIMC   = Zone((1920, 512,  2048, 640),  ('z', 'y'), ((-45, 45), (25, -5)))
DARKC   = Zone((1920, 640,  2048, 768),  ('x', 'z'), ((-45, 45), (-45, 45)))
GLOWC   = Zone((1920, 768,  2048, 896),  ('x', 'y'), ((-45, 45), (25, -5)))

# ── dims ─────────────────────────────────────────────────────────────────
HAB_A   = (-2.0, 10.0, -6.0, 22.0, 20.0, 12.0)   # slab A: x,y,z,w,h,d
HAB_B   = (6.0, 9.0, 5.5, 13.0, 18.0, 11.0)      # slab B (L-corner)
HAB_STAIR = (-8.0, 21.1, -6.0, 4.5, 2.2, 4.0)
HAB_TANK  = (2.5, -8.5)                           # roof water tank (x,z)
HAB_PORCH = (-2.0, 1.6, -12.6, 6.0, 0.35, 1.6)
HAB_BALCONY_Y = [3.2, 6.2, 9.2, 12.2, 15.2, 18.2]

HUB_HALL  = (0.0, 4.5, -4.0, 24.0, 9.0, 14.0)
HUB_CANOPY= (0.0, 4.8, 9.5, 26.0, 0.45, 11.0)
HUB_COLS  = [(-11.0, 5.5), (0.0, 5.5), (11.0, 5.5),
             (-11.0, 13.5), (0.0, 13.5), (11.0, 13.5)]
HUB_PLAT  = (0.0, 0.25, 9.5, 26.0, 0.5, 11.5)
HUB_PYLON = (-10.5, 5.0, -9.5, 1.8, 10.0, 1.8)
HUB_SIGN  = (0.0, 8.05, -11.25, 10.4, 1.5, 0.5)

DEP_HALL  = (0.0, 3.6, -3.4, 19.0, 7.2, 13.2)
DEP_RIDGE = 2.2                                   # gable rise
DEP_DOCK  = (0.0, 0.55, 7.6, 18.0, 1.1, 4.4)
DEP_TANK  = (10.6, 1.7, -5.5, 1.55, 6.0)          # x,y,z, r, len (yard side)
DEP_CRATES = [(-8.5, 1.0, 6.2, 2.0), (-6.2, 0.85, 5.4, 1.7),
              (-7.6, 2.6, 6.0, 1.3), (7.0, 0.9, 10.6, 1.8),
              (5.0, 0.75, 10.2, 1.5)]
DEP_POLES = [(-10.2, -9.5), (10.2, 3.0)]

TRK_CAB   = (0.0, 1.95, -2.75, 2.3, 1.9, 1.7)
TRK_BOX   = (0.0, 2.1, 0.95, 2.4, 2.6, 5.0)
TRK_CHASSIS = (0.0, 0.8, -0.2, 1.9, 0.5, 6.9)
TRK_AXLES = [(-2.45, 0.46), (1.9, 0.46)]          # z, wheel r
BUS_BODY  = (0.0, 2.0, 0.0, 2.5, 2.4, 10.4)
BUS_AC    = (0.0, 3.4, 0.4, 1.8, 0.42, 5.2)
BUS_AXLES = [(-3.1, 0.44), (2.9, 0.44)]
WHEEL_HW  = 0.16                                  # wheel half-width
