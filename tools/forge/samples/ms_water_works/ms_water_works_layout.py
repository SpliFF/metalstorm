"""ms_water_works_layout — zones + dims for ms_water_works (named resource site).

16 m riveted water tower on four braced legs + walking-beam pumphouse
(STYLE.md buildings row: footprint-driven, flat-shaded, functional greeble
only). Dominant dim 16 m -> 2048 atlas (same discipline as fable_factory:
big surfaces run lower px/m, house/pump details stay near unit density).
World frame: pumphouse door faces -Z, up +Y, ground Y=0, 1 unit = 1 m.
All static geometry lives on `body`; only `pump` (walking beam) animates
(idle stroke clip, rocking about its local X pivot).
"""
import numpy as np

import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
W_PAD      = Zone((0,    0,    1152, 768),  ('x', 'z'), ((-11.2, 11.2), (-8.2, 8.2)))
W_PADS     = Zone((0,    768,  1152, 848),  ('z', 'y'), ((-11.2, 11.2), (1.15, -0.05)))
W_PADS_F   = Zone((0,    768,  1152, 848),  ('x', 'y'), ((-11.2, 11.2), (1.15, -0.05)))
W_TANK     = (0, 848, 1152, 1296)     # parametric riveted-tank wrap (u around)
W_ROOF     = Zone((1152, 0,    1600, 448),  ('x', 'z'), ((-8.3, -0.9), (-3.1, 4.3)))
W_TANK_BOT = Zone((1600, 0,    1856, 256),  ('x', 'z'), ((-8.0, -1.2), (-2.8, 4.0)))
W_CATWALK  = Zone((1152, 448,  1600, 896),  ('x', 'z'), ((-8.9, -0.3), (-3.7, 4.9)))
W_LADDER   = Zone((1856, 0,    1952, 448),  ('x', 'y'), ((-3.45, -2.75), (10.1, 0.8)))
W_DARK     = Zone((1952, 0,    2048, 128),  ('x', 'z'), ((-1.0, 1.0), (-1.0, 1.0)))

W_HOUSE_S  = Zone((1152, 896,  1728, 1280), ('z', 'y'), ((-0.5, 5.3), (4.75, 0.85)))
W_HOUSE_F  = Zone((1728, 896,  2048, 1280), ('x', 'y'), ((7.95, 2.85), (4.75, 0.85)))
W_HOUSE_R  = Zone((1728, 1280, 2048, 1664), ('x', 'y'), ((2.85, 7.95), (4.75, 0.85)))
W_HOUSE_RF = Zone((1152, 1280, 1728, 1600), ('x', 'z'), ((2.7, 8.1), (-0.6, 5.4)))

W_BEAM     = Zone((1024, 1664, 1600, 1856), ('z', 'y'), ((-2.9, 1.8), (0.8, -0.8)))
W_HEAD     = Zone((1600, 1664, 1792, 1856), ('z', 'y'), ((-2.95, -2.0), (0.8, -1.0)))
W_WEIGHT   = Zone((1792, 1664, 1984, 1856), ('z', 'y'), ((0.75, 1.85), (0.85, -0.65)))
W_WELL     = Zone((1600, 1856, 1792, 2016), ('x', 'y'), ((4.8, 6.0), (2.1, 0.9)))
W_VALVE    = Zone((1792, 1856, 1984, 2016), ('x', 'y'), ((-1.2, 0.2), (2.5, 0.9)))

W_LEG      = (0,   1296, 512,  1424)  # parametric leg wrap (u along limb)
W_BRACE    = (0,   1424, 512,  1520)  # parametric brace wrap
W_PIPE     = (0,   1520, 512,  1648)  # parametric pipe wrap
W_TRIM     = (512, 1296, 1024, 1424)  # parametric small fittings
W_STACK    = (512, 1424, 768,  1552)  # pumphouse stack wrap
W_DRUM     = (512, 1552, 768,  1680)  # barrel wrap
W_DRUM_TOP = Zone((768,  1424, 896,  1552), ('x', 'z'), ((-0.55, 0.55), (-0.55, 0.55)))
W_RAIL     = (768, 1552, 1024, 1648)  # catwalk railing wrap

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
PAD        = (0.0, 0.5, 0.0, 22.4, 1.0, 16.4)     # x,y,z, w,h,d plinth
PAD_TOP    = 1.0

# water tower
TWR_X, TWR_Z = -4.6, 0.6
TANK_R     = 3.3
TANK_N     = 10                                    # facets (flat-top phase)
TANK_Y0, TANK_Y1 = 9.9, 14.6
ROOF_Y     = 15.5                                  # cone apex ring
ROOF_R     = 0.45
FINIAL_Y   = 16.0                                  # spec: 16 m water tower
LEG_OFF_B  = 2.83                                  # per-axis base offset (4.0 m radial)
LEG_OFF_T  = 1.63                                  # per-axis top offset  (2.3 m radial)
LEG_Y0, LEG_Y1 = PAD_TOP, 10.0
BRACE_Y    = (4.0, 7.2)                            # ring-brace levels
CAT_Y      = 9.85                                  # catwalk plate height
CAT_RO, CAT_RI = 4.0, 3.25
RAIL_H     = 1.0
LADDER_X, LADDER_Z = TWR_X + 1.5, TWR_Z - 3.75

# overflow (the staining feature): u fraction around the W_TANK wrap.
# drum phase pi/TANK_N; world angle below. 0.7 -> dead front (z = TWR_Z - r),
# landing exactly on a facet seam so the leak reads as a failed joint.
OVER_F     = 0.7
OVER_A     = np.pi / TANK_N + 2 * np.pi * OVER_F
OVER_STAND = 0.45                                  # pipe standoff from shell
OVER_Y0    = 10.3                                  # open end (above catwalk)

# pumphouse
HOUSE      = (5.4, PAD_TOP + 1.45, 2.4, 4.6, 2.9, 5.2)  # cx,cy,cz,w,h,d
HOUSE_X0, HOUSE_X1 = 3.1, 7.7
HOUSE_Z0, HOUSE_Z1 = -0.2, 5.0
EAVE_Y     = PAD_TOP + 2.9                         # 3.9
RIDGE_Y    = 4.55
ROOF_OVER  = 0.25                                  # eave overhang
ROOF_TH    = 0.12                                  # roof slab thickness
STACK      = (6.6, 4.05, 4.0)                      # base x,y,z (top 5.6)
STACK_TOP  = 5.6

# walking-beam pump (piece `pump`, local origin at the pivot).
# Apex z -2.1 (was -1.5): beam tail + counterweight clear the house
# front wall (z -0.2) through the whole stroke.
SAMSON_APEX = (5.4, 4.5, -2.1)                     # pump piece offset
PUMP_OFF   = SAMSON_APEX
BEAM_BOX   = (0.0, 0.05, -0.25, 0.34, 0.44, 3.9)   # local cx,cy,cz,w,h,d
HEAD_Z0, HEAD_Z1 = -2.15, -2.8                     # horsehead prism span
WEIGHT_BOX = (0.0, 0.1, 1.35, 0.85, 0.95, 0.65)    # counterweight
ROD_Z      = -2.45                                 # pump rod hangs here
PITMAN_Z   = 0.8                                   # pitman rods hang here
WELL_X, WELL_Z = 5.4, -4.55                        # wellhead under the head
CRANK_BOX  = (5.4, PAD_TOP + 0.75, -1.35, 1.3, 1.5, 1.1)  # gear housing

# pump idle stroke
STROKE_T   = 8.0                                   # seconds per stroke
STROKE_DEG = 7.0                                   # beam amplitude

# delivery standpipe (the "named resource" tap point)
STAND_X, STAND_Z = -0.5, -6.0
PIPE_Y     = 1.3                                   # ground pipe-run height

# barrels behind the house
DRUMS      = [(6.9, 6.0), (7.9, 6.35)]
DRUM_R, DRUM_H = 0.45, 1.1
