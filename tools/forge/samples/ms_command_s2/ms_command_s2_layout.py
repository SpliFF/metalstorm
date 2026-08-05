"""ms_command_s2_layout — zones + dims for ms_command_s2 (Command vehicle).

Tracked command vehicle, tanks-row s2, ~7.5 m length (spec override of the
8.5 m MBT row: command hulls run shorter than the line tank). Turretless
armoured casemate with a map-table awning over the rear porch, a whip
antenna farm, a rotating sensor head (`dish`, idle sweep) and a separate
`banner` piece (faction/team read — mask-heavy). THE commander-as-unit
body. Pieces: body / tracks_l / tracks_r / dish / banner. ≤ 2000 tris.

World frame: forward=-Z, up=+Y, left=+X, ground Y=0, 1 unit = 1 m.
Single source of truth for BOTH the geometry generator (UV projection)
and the texture painter.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas zones (1024²; v down) ──────────────────────────────────────────
# rect = (x0, y0, x1, y1) px; axes/win = planar projection window.

C_HULL_TOP    = Zone((0,   0,   448, 232), ('x', 'z'), ((-1.35, 1.35), (-3.85, 3.85)))
C_GLACIS      = Zone((448, 0,   672, 160), ('x', 'y'), ((-1.35, 1.35), (1.70, 0.05)))
C_HULL_REAR   = Zone((672, 0,   896, 160), ('x', 'y'), ((1.35, -1.35), (1.70, 0.05)))
C_ANT         = (896, 0, 960, 160)     # parametric whip-antenna wrap
C_POLE        = (960, 0, 1024, 160)    # parametric banner-pole wrap
C_DARK        = Zone((448, 160, 560, 232), ('x', 'z'), ((-1.35, 1.35), (-3.85, 3.85)))
C_LIGHT       = Zone((560, 160, 624, 232), ('x', 'y'), ((-0.08, 0.08), (0.08, -0.08)))
C_TRIM        = (624, 160, 752, 232)   # parametric small-part wrap
C_TRIM_BOX    = Zone((624, 160, 752, 232), ('x', 'y'), ((-0.10, 0.10), (0.10, -0.10)))
C_MAST        = (752, 160, 896, 232)   # parametric sensor-mast/yoke wrap
C_AWNING_EDGE = Zone((896, 160, 1024, 232), ('z', 'y'), ((1.72, 2.92), (2.60, 2.30)))
C_HULL_SIDE   = Zone((0,   232, 448, 344), ('z', 'y'), ((-3.85, 3.85), (1.70, 0.05)))
C_TRACK_SIDE  = Zone((0,   344, 448, 456), ('z', 'y'), ((-3.70, 3.70), (1.45, 0.00)))
C_TRACK_WRAP  = (0, 456, 448, 512)     # parametric (arc-length) track wrap
C_FENDER      = Zone((0,   512, 448, 568), ('z', 'x'), ((-3.55, 3.65), (-0.55, 0.55)))
C_CABIN_SIDE  = Zone((448, 232, 768, 376), ('z', 'y'), ((-1.75, 1.75), (2.52, 1.38)))
C_CABIN_FRONT = Zone((768, 232, 896, 376), ('x', 'y'), ((-1.15, 1.15), (2.52, 1.38)))
C_CABIN_REAR  = Zone((896, 232, 1024, 376), ('x', 'y'), ((1.15, -1.15), (2.52, 1.38)))
C_CABIN_TOP   = Zone((448, 376, 768, 560), ('x', 'z'), ((-1.15, 1.15), (-1.75, 1.75)))
C_AWNING_TOP  = Zone((768, 376, 1024, 560), ('x', 'z'), ((-1.15, 1.15), (1.60, 3.00)))
C_BANNER_F    = Zone((0,   568, 160, 880), ('z', 'y'), ((0.00, 0.88), (1.82, 0.58)))
C_BANNER_B    = Zone((160, 568, 320, 880), ('z', 'y'), ((0.88, 0.00), (1.82, 0.58)))
C_DISH_F      = Zone((320, 568, 480, 728), ('x', 'y'), ((-0.36, 0.36), (0.66, -0.06)))
C_DISH_B      = Zone((480, 568, 640, 728), ('x', 'y'), ((0.36, -0.36), (0.66, -0.06)))
C_AWNING_BOT  = Zone((640, 568, 896, 656), ('x', 'z'), ((-1.15, 1.15), (1.60, 3.00)))
C_INTAKE      = Zone((640, 656, 832, 752), ('x', 'z'), ((-0.70, 0.70), (-0.40, 0.40)))
C_EXHAUST     = Zone((832, 656, 928, 752), ('z', 'y'), ((-0.30, 0.30), (0.18, -0.18)))
C_SENSOR      = Zone((640, 752, 832, 816), ('x', 'y'), ((-0.56, 0.56), (0.10, -0.10)))
C_HATCH       = Zone((832, 752, 928, 848), ('x', 'z'), ((-0.28, 0.28), (-0.28, 0.28)))
C_TABLE_TOP   = Zone((320, 728, 480, 880), ('x', 'z'), ((-0.62, 0.62), (2.32, 3.18)))
C_TABLE_SIDE  = Zone((480, 728, 640, 800), ('x', 'y'), ((-0.62, 0.62), (2.06, 1.42)))
C_TABLE_SIDE2 = Zone((480, 728, 640, 800), ('z', 'y'), ((2.32, 3.18), (2.06, 1.42)))
C_STOW        = Zone((480, 800, 640, 880), ('z', 'y'), ((-1.65, -0.05), (1.64, 1.26)))
C_STOW_TOP    = Zone((0,   880, 224, 960), ('z', 'x'), ((-1.65, -0.05), (-0.30, 0.30)))

# ── design constants (geometry anchors the painter also needs) ──────────
HULL_LEN    = (-3.74, 3.74)            # ~7.5 m dominant dim
HULL_DECK_Y = 1.52

# hull loft sections: (z, y_bot, y_waist, y_shoulder, y_deck,
#                      w_bot, w_waist, w_deck, w_top)
HULL_SECTIONS = [
    (-3.72, 0.60, 0.76, 0.90, 0.96, 0.30, 0.55, 0.45, 0.30),
    (-2.80, 0.28, 0.82, 1.12, 1.22, 0.72, 1.06, 0.90, 0.70),
    (-1.30, 0.20, 0.92, 1.40, 1.50, 0.86, 1.20, 1.05, 0.88),
    (0.85,  0.20, 0.92, 1.42, 1.52, 0.86, 1.20, 1.06, 0.90),
    (2.45,  0.20, 0.90, 1.36, 1.46, 0.82, 1.16, 1.02, 0.84),
    (3.74,  0.36, 0.78, 1.08, 1.16, 0.66, 0.98, 0.82, 0.62),
]

# casemate cabin loft (model frame; turretless armoured superstructure)
CABIN_SECTIONS = [
    (-1.62, 1.42, 1.50, 1.60, 1.66, 0.78, 0.90, 0.76, 0.58),
    (-0.90, 1.42, 1.56, 2.08, 2.22, 0.98, 1.08, 0.94, 0.76),
    (0.40,  1.42, 1.58, 2.20, 2.38, 1.02, 1.12, 0.98, 0.82),
    (1.52,  1.42, 1.56, 2.12, 2.28, 0.96, 1.06, 0.92, 0.74),
]

# tracks (piece-local; x mirrored for tracks_r)
TRACK_OFF     = (1.32, 0.0, 0.05)
TRACK_PROFILE = [                      # local (z, y), outer loop
    (-3.55, 0.68), (-2.50, 0.10), (2.50, 0.10), (3.55, 0.66),
    (3.47, 1.06), (2.10, 1.20), (-2.10, 1.20), (-3.42, 1.05),
]
TRACK_HALF_W = 0.45
FENDER       = ((-3.50, 3.60), 1.18, 0.10, 1.00)   # (zspan, ytop_base, h, width)
SKIRT        = (0.50, 0.90, 0.07, 0.46, -2.90, 3.10)  # x,y,w,h,z0,z1 (pod-local)
ROAD_WHEELS  = [-2.35 + i * 0.94 for i in range(6)]   # painted, C_TRACK_SIDE

# greebles (model frame unless noted)
SENSOR_BAR   = (0.0, 1.36, -2.42, 1.05, 0.13, 0.20)   # x,y,z, w,h,d glacis visor
DRIVER_HATCH = (-0.45, 1.42, -1.85, 0.50, 0.06, 0.50)
ROOF_HATCH   = (0.35, 2.36, 0.75, 0.52, 0.06, 0.52)
INTAKE       = (0.0, 1.48, -1.55, 1.25, 0.09, 0.62)
EXHAUSTS     = [(1.00, 1.30, -2.05), (-1.00, 1.30, -2.05)]
EXHAUST_SIZE = (0.28, 0.24, 0.46)
STOW_BINS    = [(1.30, 1.44, -0.85), (-1.30, 1.44, -0.85)]
STOW_SIZE    = (0.52, 0.34, 1.55)

# map-table awning over the rear porch
AWNING_Z     = (1.72, 2.92)
AWNING_XW    = 1.08
AWNING_YF    = 2.56                    # canopy top at front edge
AWNING_YR    = 2.42                    # canopy top at rear edge
AWNING_TH    = 0.05
POSTS        = [(1.00, 1.95), (-1.00, 1.95), (1.00, 2.80), (-1.00, 2.80)]
TABLE        = (0.0, 1.71, 2.75, 1.15, 0.54, 0.86)    # x,y,z, w,h,d

# whip antenna farm: (base xyz) -> (tip xyz); rear pair get coil boxes
WHIPS = [
    ((1.02, 1.26, 3.35), (1.22, 4.02, 3.58)),
    ((-1.02, 1.26, 3.35), (-1.22, 3.76, 3.55)),
    ((0.70, 2.26, 1.30), (0.86, 3.52, 1.46)),
    ((-0.86, 2.22, 1.10), (-1.02, 3.30, 1.28)),
]
COILS = [(1.02, 1.36, 3.35), (-1.02, 1.36, 3.35)]
COIL_SIZE = (0.14, 0.20, 0.14)

# rotating sensor head (piece `dish`; mast is body geometry)
MAST_BASE  = (-0.50, 2.26, -0.55)
MAST_TOP_Y = 2.85
DISH_OFF   = (-0.50, 2.85, -0.55)      # piece offset (pivot on mast top)
DISH_R     = 0.34
DISH_TILT  = 15.0                      # deg back-tilt off vertical (scans horizon)
DISH_CTR   = (0.0, 0.30, -0.30)        # plate centre, dish-local

# banner (piece `banner`; pole base on the cabin roof, front-left)
BANNER_OFF   = (0.82, 2.14, -1.00)
POLE_H       = 1.90
GAFF_Y       = 1.84                    # crossarm height (banner-local)
GAFF_LEN     = 0.85                    # extends +z (trails aft)
CLOTH_COLS_Z = [0.08, 0.34, 0.60, 0.84]
CLOTH_WAVE_X = [0.0, 0.05, -0.04, 0.07]
CLOTH_TOP_Y  = [1.78, 1.77, 1.76, 1.74]
CLOTH_BOT_Y  = [0.66, 0.64, 0.66, 0.72]
