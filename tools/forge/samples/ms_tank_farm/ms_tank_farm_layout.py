"""ms_tank_farm_layout — zones + dims for ms_tank_farm (fuel tank farm).

Named resource site: three 8 m-diameter storage tanks in a sloped
concrete bund wall on a 32.4 x 16.8 m pad, front pipe header + export
line running -Z toward the paired ms_oil_derrick, two valve stations,
spiral stairs on the outer tanks, hazard placards at the apron. Same
2048² atlas discipline as fable_factory / fable_civkit; big surfaces run
lower px/m, greebles stay near unit density. World frame: export flange
faces -Z, up +Y, ground Y=0. All geometry lives on `body` (world =
piece-local); only `vent` (roof turbine on tank B) animates (idle clip);
`fumes` is an empty FX attachment above it.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
TANKW      = (0, 0, 1536, 560)        # parametric tank shell wrap (u around)
ROOFW      = (1536, 0, 2048, 96)      # parametric roof-slope wrap
TANK_TOP   = Zone((1536, 96, 1888, 448), ('x', 'z'), ((-2.4, 2.4), (-2.4, 2.4)))
VENTW      = (1888, 96, 2048, 192)    # parametric vent turbine wrap
VENT_TOP   = Zone((1888, 192, 2048, 320), ('x', 'z'), ((-0.5, 0.5), (-0.5, 0.5)))
HATCH      = Zone((1536, 448, 1728, 576), ('x', 'z'), ((-0.7, 0.7), (-0.7, 0.7)))
SKIRTW     = (0, 560, 768, 648)       # parametric foundation-skirt wrap
GIRDW      = (768, 560, 1536, 648)    # parametric wind-girder wrap

PADT       = Zone((0, 656, 1024, 1168), ('x', 'z'), ((-16.2, 16.2), (-8.4, 8.4)))
PADS       = Zone((0, 1176, 1024, 1224), ('z', 'y'), ((-16.5, 16.5), (0.45, -0.05)))
PADS_F     = Zone((0, 1176, 1024, 1224), ('x', 'y'), ((-16.5, 16.5), (0.45, -0.05)))
BUND_OX    = Zone((1024, 656, 2048, 776), ('z', 'y'), ((-8.3, 8.3), (2.3, 0.2)))
BUND_OZ    = Zone((1024, 656, 2048, 776), ('x', 'y'), ((-15.5, 15.5), (2.3, 0.2)))
BUND_TOP   = Zone((1024, 784, 2048, 848), ('x', 'z'), ((-15.5, 15.5), (-6.2, 8.6)))

PIPEW      = (1024, 856, 1536, 976)   # parametric pipe wrap
WHEELW     = (1664, 856, 1792, 904)   # valve handwheel rim wrap
WHEELC     = (1536, 856, 1664, 984)   # handwheel top cap rect (local zone)
STAIR      = (1536, 1056, 2048, 1184) # spiral ribbon: treads top, rail below
PLACARD    = (1792, 856, 1984, 1048)  # hazard placard board front (explicit UV)
CAB        = Zone((640, 1232, 896, 1360), ('x', 'y'), ((1.05, 2.35), (1.95, 0.25)))
TRIM       = Zone((0, 1232, 512, 1360), ('z', 'y'), ((-2.5, 2.5), (1.5, -1.5)))
DARK       = Zone((512, 1232, 640, 1360), ('x', 'z'), ((-1.0, 1.0), (-1.0, 1.0)))
STEP       = Zone((0, 1400, 512, 1560), ('z', 'y'), ((-6.9, -2.9), (2.6, -0.6)))
LAND       = (512, 1400, 768, 1560)   # stair roof-landing plate (local zones)

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
PAD        = (0.0, 0.175, 0.0, 32.4, 0.35, 16.8)  # x,y,z,w,h,d plinth
PAD_TOP    = 0.35

# bund wall ring (sloped outer face, flat coping): x half / z extents
BUND_IN_X, BUND_IN_Z0, BUND_IN_Z1 = 14.3, -4.7, 7.1
BUND_TO_X, BUND_TO_Z0, BUND_TO_Z1 = 14.7, -5.1, 7.5    # top outer
BUND_BO_X, BUND_BO_Z0, BUND_BO_Z1 = 15.4, -5.8, 8.2    # base outer
BUND_H     = 2.1                                        # coping height (abs Y)

TANK_R     = 4.0                                  # 8 m diameter
TANK_N     = 10                                   # facets
TANK_TOP_Y = PAD_TOP + 6.6                        # shell top (6.95)
ROOF_R     = 2.2                                  # roof cap ring radius
ROOF_Y     = TANK_TOP_Y + 0.6                     # cap plate height (7.55)
TANKS      = [(-9.5, 1.2), (0.0, 1.2), (9.5, 1.2)]  # x,z centres
SKIRT_R    = 4.12                                 # foundation skirt
SKIRT_Y1   = PAD_TOP + 0.5
GIRD_R     = 4.15                                 # wind girder band
GIRD_Y0, GIRD_Y1 = 6.25, 6.55

HEADER_Y, HEADER_Z, HEADER_R = 0.55, -3.7, 0.34   # front collection header
OUTLET_Y, OUTLET_R = 1.15, 0.26                   # tank nozzle stubs
EXPORT_X   = 0.0                                  # export line runs -Z at x=0
EXPORT_TOP = 2.55                                 # over-bund crossing height
EXPORT_WZ  = -6.6                                 # descent past the wall
EXPORT_Y   = 0.75                                 # apron run height
EXPORT_END = -8.3                                 # flange at pad edge (derrick)
VALVE_HDR  = [(-4.75, 1.35), (4.75, 1.35)]        # header valves: x, wheel y
VALVE_EXP  = (0.0, 1.45, -7.3)                    # export valve x, wheel y, z
WHEEL_R    = 0.42
CAB_POS    = (1.7, -6.6)                          # control cabinet x,z
CAB_SIZE   = (1.1, 1.5, 0.7)

STAIR_RI, STAIR_RO = 4.05, 4.75                   # spiral tread radii
STAIR_SEGS = 10
STAIR_RAIL = 1.0
# tank A winds CW ending front-right; tank C mirrors, ending front-left
STAIR_A    = (90.0, 330.0)                        # start/end angle (deg)
STAIR_C    = (90.0, -150.0)

CROSS_X    = 6.5                                  # bund crossover stair x
PLACARDS   = [(-3.4, -6.05), (7.8, -6.05)]        # board posts x,z (face -Z)
PLACARD_Y  = 1.45                                 # board centre height
PLACARD_S  = 0.95                                 # board edge size
BOLLARDS   = [(-1.7, -7.7), (1.7, -7.7), (3.0, -6.9)]

VENT_OFF   = (0.0, ROOF_Y, 1.2)                   # vent piece @ tank B apex
VENT_R, VENT_H = 0.42, 0.5
FUMES_OFF  = (0.0, ROOF_Y + VENT_H + 0.15, 1.2)   # FX empty
