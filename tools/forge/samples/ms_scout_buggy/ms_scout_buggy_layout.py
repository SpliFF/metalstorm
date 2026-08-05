"""ms_scout_buggy_layout — zones + dims for ms_scout_buggy.

Light scout buggy (tanks row, s1: STYLE.md length = 4.5 m tankette slot,
tri budget well under the 2000 vehicle cap — spec cap 1500). Fast/fragile
read: open-frame tub, exposed wheels on spinnable `axle_f`/`axle_r`
pieces, roll cage, pintle sensor pod (`dish` piece, idle sweep clip),
two spare wheels on the rear rack, whip aerial.
World frame: forward -Z, up +Y, left +X, ground Y=0, 1 unit = 1 m.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas zones (1024²; v down) ──────────────────────────────────────────
S_TOP    = Zone((0,    0,   384, 448), ('x', 'z'), ((-0.80, 0.80), (-2.30, 2.30)))
S_SIDE   = Zone((384,  0,   896, 160), ('z', 'y'), ((-2.30, 2.30), (1.02, 0.28)))
S_FRONT  = Zone((896,  0,   1024, 128), ('x', 'y'), ((-0.80, 0.80), (1.02, 0.28)))
S_REAR   = Zone((896,  128, 1024, 256), ('x', 'y'), ((0.80, -0.80), (1.02, 0.28)))
S_CAGE   = (384, 160, 896, 224)          # parametric roll-cage tube wrap
S_WHEEL  = (0,   448, 512, 544)          # parametric tyre tread wrap
S_HUB    = Zone((512,  448, 640, 576), ('z', 'y'), ((-0.44, 0.44), (0.44, -0.44)))
S_HUB_Z  = Zone((0,    736, 128, 864), ('x', 'y'), ((-0.44, 0.44), (0.44, -0.44)))
S_SEAT   = Zone((0,    544, 128, 672), ('x', 'y'), ((-0.30, 0.30), (0.40, -0.40)))
S_DASH   = Zone((128,  544, 256, 640), ('x', 'y'), ((-0.40, 0.40), (0.20, -0.20)))
S_ENGINE = Zone((256,  544, 448, 672), ('x', 'z'), ((-0.55, 0.55), (-0.40, 0.40)))
S_SILL   = Zone((0,    672, 384, 736), ('z', 'x'), ((-0.85, 0.85), (-0.15, 0.15)))
S_POD    = Zone((448,  576, 576, 672), ('z', 'y'), ((-0.26, 0.26), (0.20, -0.20)))
S_POD_F  = Zone((576,  576, 672, 672), ('x', 'y'), ((-0.20, 0.20), (0.34, 0.06)))
S_DISH   = Zone((672,  448, 864, 640), ('x', 'z'), ((-0.24, 0.24), (-0.24, 0.24)))
S_DISH_B = Zone((672,  640, 864, 832), ('x', 'z'), ((-0.24, 0.24), (-0.24, 0.24)))
S_TRIM   = (864, 576, 1024, 704)         # parametric small-part wrap
S_STOW   = Zone((448,  672, 640, 768), ('x', 'y'), ((-0.45, 0.45), (0.30, -0.30)))
S_DARK   = Zone((896,  832, 1024, 960), ('x', 'z'), ((-1.0, 1.0), (-2.3, 2.3)))

# ── dims (metres; forward -Z, ground Y=0) ────────────────────────────────
BODY_LEN = (-2.25, 2.25)                 # 4.5 m dominant dim (STYLE.md s1)

# tub loft sections: (z, y_bot, y_waist, y_shoulder, y_deck,
#                     w_bot, w_waist, w_deck, w_top)
BODY_SECTIONS = [
    (-2.25, 0.55, 0.62, 0.70, 0.74, 0.26, 0.40, 0.36, 0.28),
    (-1.55, 0.38, 0.55, 0.80, 0.86, 0.52, 0.70, 0.64, 0.54),
    (-0.75, 0.34, 0.55, 0.94, 1.00, 0.58, 0.76, 0.70, 0.60),
    (0.15,  0.34, 0.52, 0.82, 0.88, 0.58, 0.76, 0.68, 0.58),
    (1.15,  0.34, 0.54, 0.88, 0.94, 0.56, 0.74, 0.68, 0.58),
    (2.25,  0.42, 0.56, 0.82, 0.88, 0.42, 0.60, 0.54, 0.44),
]

# wheels / axles (piece-local: origin at axle centre; offset lifts to r)
WHEEL_R   = 0.42
WHEEL_HW  = 0.14                          # tyre half-width
TRACK_X   = 0.86                          # wheel centre |x|
AXLE_F_Z  = -1.42
AXLE_R_Z  = 1.42
AXLE_BAR  = (2.02, 0.16, 0.16)            # connecting bar w,h,d

# roll cage (tube radius; hoop anchor points, model frame)
CAGE_R      = 0.055
HOOP_MAIN_Z = 0.55                        # behind seats
HOOP_MAIN   = ((0.64, 0.86), (0.50, 1.56))   # (x,y) foot -> (x,y) head
HOOP_FRONT_Z = -0.62
HOOP_FRONT  = ((0.60, 0.98), (0.48, 1.46))
BRACE_REAR  = (0.50, 0.92, 1.62)          # foot of rear brace (x,y,z)

# pintle sensor pod (`dish` piece)
DISH_OFF  = (0.0, 1.56, 0.55)             # pivot on the main-hoop cross bar
POD_BOX   = (0.0, 0.20, 0.0, 0.30, 0.20, 0.40)   # local x,y,z,w,h,d
DISH_R    = 0.21
DISH_TILT = 24.0                          # degrees skyward
DISH_CTR  = (0.0, 0.42, -0.04)            # plate centre, local

# greebles (model frame)
DASH_BOX   = (0.0, 1.02, -0.60, 0.80, 0.14, 0.34)  # cowl over the dash
SEATS      = [(0.34, -0.02), (-0.34, -0.02)]       # (x, z) seat anchors
SEAT_BASE  = (0.44, 0.16, 0.50)
SEAT_BACK  = (0.44, 0.42, 0.12)
SEAT_Y     = 0.90                                   # base centre y
ENGINE_BOX = (0.0, 1.00, 1.15, 1.06, 0.14, 0.78)   # intake hump on deck
EXHAUST    = ((0.34, 0.60, 2.25), (0.34, 0.60, 2.52))  # pipe p0 -> p1
EXHAUST_R  = 0.06
SILLS      = [(0.80, 0.44, -0.05), (-0.80, 0.44, -0.05)]  # step plate ctr
SILL_SIZE  = (0.24, 0.07, 1.70)
BUMPER_Z   = -2.36                        # brush-bar plane
BUMPER_Y   = (0.42, 0.94)                 # bar heights
BUMPER_X   = 0.55                         # upright |x|
BUMPER_R   = 0.045
SPARES     = [(0.34, 0.96, 2.16), (-0.34, 0.96, 2.16)]  # rear rack, axis z
SPARE_R    = 0.40
SPARE_HW   = 0.11
STOW_BOX   = (0.0, 0.96, 1.86, 0.88, 0.34, 0.34)   # rear rack frame
AERIAL     = (0.58, 0.92, 1.70)           # whip base (x,y,z)
AERIAL_TOP = 2.55
