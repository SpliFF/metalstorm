"""layout — shared atlas zones + design constants for fable_tank.

Single source of truth for BOTH the geometry generator (UV projection)
and the texture painter (what to draw where). All world coords in
metres, model frame: forward=-Z, up=+Y, left=+X, ground Y=0.
"""
from meshlib import Zone

# ── atlas zones (1024²; v down) ──────────────────────────────────────────
# rect = (x0, y0, x1, y1) px; axes/win = planar projection window.

Z_HULL_TOP    = Zone((0,   0,   512, 232), ('x', 'z'), ((-1.75, 1.75), (-4.55, 4.55)))
Z_GLACIS      = Zone((512, 0,   736, 168), ('x', 'y'), ((-1.75, 1.75), (2.05, 0.15)))
Z_HULL_REAR   = Zone((736, 0,   960, 168), ('x', 'y'), ((1.75, -1.75), (2.05, 0.15)))
Z_DARK        = Zone((960, 0,  1024, 168), ('x', 'z'), ((-1.75, 1.75), (-4.55, 4.55)))
Z_HULL_SIDE   = Zone((0,   232, 512, 344), ('z', 'y'), ((-4.55, 4.55), (2.05, 0.15)))
Z_TRACK_SIDE  = Zone((0,   344, 512, 480), ('z', 'y'), ((-4.45, 4.45), (1.62, 0.02)))
Z_TRACK_WRAP  = (0, 480, 512, 544)   # parametric (arc-length) — rect only
Z_TURRET_TOP  = Zone((512, 168, 848, 400), ('x', 'z'), ((-1.5, 1.5), (-1.85, 2.35)))
Z_TURRET_SIDE = Zone((848, 168, 1024, 300), ('z', 'y'), ((-1.85, 2.35), (1.25, -0.05)))
Z_TURRET_FRONT= Zone((848, 300, 936, 400), ('x', 'y'), ((-1.1, 1.1), (1.2, -0.05)))
Z_TURRET_REAR = Zone((936, 300, 1024, 400), ('x', 'y'), ((1.1, -1.1), (1.2, -0.05)))
Z_BARREL_WRAP = (512, 400, 1024, 500)  # parametric tube rect
# detail cells (each painted once, mapped onto specific greeble faces)
Z_HATCH       = Zone((0,   544, 96,  640), ('x', 'z'), ((-0.34, 0.34), (-0.34, 0.34)))
Z_INTAKE      = Zone((96,  544, 288, 640), ('x', 'z'), ((-0.88, 0.88), (-0.58, 0.58)))
Z_EXHAUST     = Zone((288, 544, 384, 640), ('x', 'y'), ((-0.30, 0.30), (0.30, -0.30)))
Z_SENSOR      = Zone((384, 544, 512, 608), ('x', 'y'), ((-0.70, 0.70), (0.12, -0.12)))
Z_POD         = Zone((0,   640, 128, 736), ('z', 'y'), ((-0.32, 0.32), (0.20, -0.20)))
Z_SIGHT       = (128, 640, 256, 704)   # parametric drum wrap rect
Z_SIGHT_TOP   = Zone((256, 640, 320, 704), ('x', 'z'), ((-0.22, 0.22), (-0.22, 0.22)))
Z_BUSTLE      = Zone((320, 640, 512, 736), ('x', 'y'), ((-0.78, 0.78), (0.24, -0.24)))
Z_SMOKE       = Zone((0,   736, 96,  800), ('z', 'y'), ((-0.26, 0.26), (0.12, -0.12)))
Z_BREECH      = Zone((96,  736, 224, 800), ('x', 'y'), ((-0.30, 0.30), (0.30, -0.30)))
Z_BRAKE       = Zone((224, 736, 352, 800), ('x', 'y'), ((-0.30, 0.30), (0.28, -0.28)))
Z_HUB         = (352, 736, 448, 800)   # parametric stub wrap rect
Z_HUB_CAP     = Zone((448, 736, 512, 800), ('z', 'y'), ((-0.36, 0.36), (0.36, -0.36)))
Z_FENDER      = Zone((0,   800, 512, 872), ('z', 'x'), ((-4.45, 4.45), (-0.65, 0.65)))
Z_CAP_RING    = (0, 872, 256, 936)     # parametric capacitor ring wrap
Z_RAIL_SIDE   = Zone((256, 872, 512, 936), ('z', 'y'), ((-4.05, -1.75), (0.20, -0.20)))
Z_TUBE_CAP    = Zone((512, 500, 576, 564), ('x', 'y'), ((-0.32, 0.32), (0.32, -0.32)))

# ── design constants (geometry anchors the painter also needs) ──────────
HULL_LEN   = (-4.40, 4.40)
HULL_DECK_Y = 1.86
TRACK_OFF  = (1.875, 0.0, 0.05)       # tracks_l piece offset (x mirrored for _r)
TRACK_PROFILE = [                      # local (z, y), outer loop
    (-4.30, 0.82), (-3.05, 0.10), (3.05, 0.10), (4.30, 0.80),
    (4.20, 1.30), (2.55, 1.44), (-2.55, 1.44), (-4.15, 1.28),
]
TRACK_HALF_W = 0.575
HUB_FRONT  = (-3.92, 0.95, 0.28)      # local (z, y, radius) sprocket
HUB_REAR   = (3.95, 0.94, 0.26)       # idler
FENDER     = ((-4.20, 4.30), 1.44, 0.12, 1.24)  # (zspan, ytop_base, h, width)
SKIRT      = (0.60, 1.08, 0.09, 0.58, -3.55, 3.85)  # x,y,w,h,z0,z1 (pod-local)

TURRET_OFF = (0.0, 1.80, 0.30)
BARREL_OFF = (0.0, 0.66, -1.15)       # relative to turret
MUZZLE_OFF = (0.0, 0.0, -4.62)        # relative to barrel
EXHAUST_OFF = (0.0, 1.92, 4.12)

# hull loft sections: (z, y_bot, y_waist, y_shoulder, y_deck,
#                      w_bot, w_waist, w_deck, w_top)
HULL_SECTIONS = [
    (-4.35, 0.78, 0.92, 1.04, 1.10, 0.34, 0.62, 0.50, 0.32),
    (-3.30, 0.34, 0.98, 1.30, 1.40, 0.90, 1.32, 1.08, 0.80),
    (-1.55, 0.24, 1.12, 1.68, 1.86, 1.06, 1.46, 1.28, 1.04),
    (0.85,  0.24, 1.12, 1.72, 1.86, 1.06, 1.46, 1.30, 1.06),
    (2.85,  0.24, 1.08, 1.62, 1.76, 1.02, 1.42, 1.24, 1.00),
    (4.40,  0.44, 0.92, 1.32, 1.42, 0.84, 1.20, 1.00, 0.78),
]

# turret loft sections (local frame, y0 = ring base)
TURRET_SECTIONS = [
    (-1.70, -0.05, 0.14, 0.50, 0.58, 0.30, 0.54, 0.44, 0.30),
    (-0.85, -0.05, 0.16, 0.86, 0.96, 0.82, 1.06, 0.90, 0.66),
    (0.45,  -0.04, 0.18, 1.00, 1.12, 1.08, 1.38, 1.12, 0.86),
    (1.35,  -0.04, 0.18, 0.94, 1.04, 0.98, 1.24, 1.00, 0.78),
    (2.10,  0.00, 0.16, 0.80, 0.88, 0.74, 0.98, 0.80, 0.60),
]

# greeble anchors (model/local frames as noted)
HATCHES    = [(0.62, -0.85), (-0.62, -0.85)]      # (x, z) on hull deck
HATCH_SIZE = (0.62, 0.09, 0.62)
SENSOR_BAR = (0.0, 1.50, -2.55, 1.32, 0.13, 0.20)  # x,y,z, w,h,d
INTAKE     = (0.0, 1.80, 2.45, 1.66, 0.10, 1.08)
EXHAUSTS   = [(0.80, 1.60, 3.92), (-0.80, 1.60, 3.92)]
EXHAUST_SIZE = (0.52, 0.44, 0.66)
SIGHT_DRUM = (-0.55, 0.92, 0.20, 0.42)  # turret-local x,z, radius, height (from y 0.96)
SENSOR_POD = (0.74, 0.66, -0.50, 0.40, 0.34, 0.58)   # turret-local x,y,z,w,h,d
BUSTLE     = (0.0, 0.66, 1.90, 1.50, 0.44, 0.66)
SMOKES     = [(1.02, 0.54, -0.70), (-1.02, 0.54, -0.70)]  # turret-local
SMOKE_SIZE = (0.30, 0.22, 0.48)

# barrel assembly (barrel-local, bore axis = local origin y)
BREECH     = (0.0, -0.03, 0.42, 0.55, 0.55, 0.88)
TUBE_STATIONS = [(-0.28, 0.295), (-1.92, 0.295), (-1.92, 0.205), (-4.00, 0.205)]
CAP_RING   = ((-0.98, -1.36), 0.345)     # zspan, radius
RAILS      = [(0.245, 0.09, 0.36), (-0.245, 0.09, 0.36)]  # xcenter, w, h
RAIL_ZSPAN = (-1.80, -4.00)
BRAKE      = (0.0, 0.0, -4.24, 0.56, 0.50, 0.60)
TIP_STUB   = ((-4.54, -4.62), 0.13)
