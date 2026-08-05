"""ms_courier_car_layout — atlas zones + design constants for ms_courier_car.

Fast armoured courier car — the Static-fiction dispatch runner. 5.5 m
long, low silhouette, sloped plates, satchel racks on the rear deck +
flank panniers, single unmanned MG ring (remote weapon station),
spinnable axle_f/axle_r pieces (engine Spin API, same contract as the
civkit truck/bus). Single source of truth for BOTH the geometry
generator (UV projection) and the texture painter. All world coords in
metres, model frame: forward=-Z, up=+Y, left=+X, ground Y=0.
"""
from meshlib import Zone

# ── atlas zones (1024²; v down) ──────────────────────────────────────────
# rect = (x0, y0, x1, y1) px; axes/win = planar projection window.

Z_HULL_TOP   = Zone((0,   0,   384, 320), ('x', 'z'), ((-1.12, 1.12), (-2.80, 2.80)))
Z_HULL_SIDE  = Zone((384, 0,   896, 160), ('z', 'y'), ((-2.80, 2.80), (1.60, 0.20)))
Z_GLACIS     = Zone((896, 0,   1024, 160), ('x', 'y'), ((-1.12, 1.12), (1.60, 0.20)))
Z_HULL_REAR  = Zone((896, 160, 1024, 320), ('x', 'y'), ((1.12, -1.12), (1.60, 0.20)))
Z_WHEEL_WRAP = (384, 160, 832, 224)   # parametric tread wrap — rect only
Z_HUB        = Zone((384, 224, 480, 320), ('z', 'y'), ((-0.46, 0.46), (0.46, -0.46)))
Z_DARK       = Zone((480, 224, 576, 320), ('x', 'z'), ((-1.2, 1.2), (-2.9, 2.9)))
Z_RING       = (0, 320, 256, 376)     # parametric MG-ring drum wrap
Z_PED        = (0, 376, 128, 416)     # parametric pedestal wrap
Z_RING_TOP   = Zone((256, 320, 384, 448), ('x', 'z'), ((-0.45, 0.45), (-0.45, 0.45)))
Z_MG_TOP     = Zone((384, 320, 512, 384), ('x', 'z'), ((-0.20, 0.20), (-0.30, 0.46)))
Z_MG_SIDE    = Zone((384, 384, 512, 448), ('z', 'y'), ((-0.30, 0.46), (0.16, -0.16)))
Z_MG_END     = Zone((512, 384, 576, 448), ('x', 'y'), ((-0.20, 0.20), (0.16, -0.16)))
Z_MG_WRAP    = (576, 320, 832, 368)   # parametric MG barrel wrap
Z_TUBE_CAP   = Zone((832, 320, 896, 384), ('x', 'y'), ((-0.08, 0.08), (0.08, -0.08)))
Z_AMMO       = Zone((576, 368, 704, 448), ('z', 'y'), ((-0.15, 0.35), (0.15, -0.15)))
Z_SATCH_TOP  = Zone((0,   448, 320, 608), ('x', 'z'), ((-1.05, 1.05), (0.75, 2.65)))
Z_SATCH_SIDE = Zone((320, 448, 640, 544), ('z', 'y'), ((0.75, 2.65), (2.00, 1.30)))
Z_SATCH_END  = Zone((640, 448, 768, 544), ('x', 'y'), ((-1.05, 1.05), (2.00, 1.30)))
Z_PAN_SIDE   = Zone((640, 544, 832, 608), ('z', 'y'), ((-0.55, 0.95), (1.45, 0.45)))
Z_CANVAS     = Zone((832, 544, 896, 608), ('x', 'y'), ((-8.0, 8.0), (8.0, -8.0)))
Z_HATCH      = Zone((768, 448, 896, 576), ('x', 'z'), ((-0.35, 0.35), (-0.10, 0.60)))
Z_VISOR      = Zone((896, 448, 1024, 512), ('x', 'y'), ((-0.55, 0.55), (1.52, 1.20)))
Z_EXHAUST    = Zone((896, 512, 1024, 576), ('z', 'y'), ((2.10, 3.05), (1.05, 0.55)))
Z_BUMPER     = Zone((0,   608, 256, 672), ('x', 'y'), ((-0.80, 0.80), (0.72, 0.38)))
Z_RACK       = Zone((256, 608, 512, 672), ('z', 'y'), ((0.70, 2.70), (1.72, 1.40)))
Z_ANT        = (512, 608, 576, 640)   # parametric antenna wrap

# ── design constants ─────────────────────────────────────────────────────
HULL_LEN = (-2.75, 2.75)              # 5.5 m dominant dim (spec)
DECK_Y = 1.52                         # cab roof height (low silhouette)

# hull loft sections: (z, y_bot, y_waist, y_shoulder, y_deck,
#                      w_bot, w_waist, w_deck, w_top) — sloped plates:
# narrow keel -> flared waist -> tucked shoulder -> narrow roof.
HULL_SECTIONS = [
    (-2.75, 0.62, 0.78, 0.88, 0.92, 0.30, 0.52, 0.40, 0.26),   # nose tip
    (-2.15, 0.44, 0.80, 1.10, 1.16, 0.66, 0.94, 0.76, 0.56),   # glacis base
    (-0.95, 0.38, 0.82, 1.42, 1.52, 0.78, 1.06, 0.88, 0.66),   # cab front
    (0.70,  0.38, 0.82, 1.42, 1.52, 0.78, 1.06, 0.88, 0.66),   # cab rear
    (1.95,  0.38, 0.80, 1.32, 1.40, 0.76, 1.02, 0.84, 0.62),   # deck drop
    (2.75,  0.50, 0.76, 1.06, 1.12, 0.56, 0.88, 0.68, 0.48),   # tail
]

# ── running gear (axle pieces — engine spins them) ───────────────────────
WHEEL_R = 0.40                        # wheel radius; axle offset y = WHEEL_R
WHEEL_HW = 0.17                       # wheel half-width
WHEEL_X = 0.95                        # wheel centre |x|
AXLE_F_Z = -1.75
AXLE_R_Z = 1.75
AXLE_BAR = (1.55, 0.16, 0.16)         # connecting bar w,h,d

# ── MG ring (unmanned RWS) ───────────────────────────────────────────────
TURRET_OFF = (0.0, DECK_Y, -0.55)     # ring centre on the cab roof
RING_R = 0.40
RING_H = 0.16
PED_R = 0.16
PED_SPAN = (0.16, 0.36)               # pedestal y0..y1 (turret-local)
BARREL_OFF = (0.0, 0.34, 0.0)         # elevation pivot (turret-local)
RECEIVER = (0.0, 0.0, 0.06, 0.30, 0.26, 0.66)   # barrel-local x,y,z,w,h,d
AMMO_BOX = (-0.27, -0.01, 0.10, 0.20, 0.24, 0.42)  # belt box, left flank
TUBE_STATIONS = [(-0.30, 0.055), (-1.14, 0.042)]   # (z, r) MG barrel
MUZZLE_OFF = (0.0, 0.0, -1.18)        # barrel-local

# ── satchel racks (the courier's cargo) ──────────────────────────────────
RACK_SLAB = (0.0, 1.51, 1.45, 1.24, 0.06, 1.20)   # x,y,z, w,h,d platform
RACK_RAIL = (0.0, 1.60, 2.02, 1.24, 0.14, 0.07)   # rear retaining rail
SATCHELS = [(-0.40, 1.42), (0.0, 1.42), (0.40, 1.42)]  # (x, z) on the slab
SATCHEL_SIZE = (0.38, 0.34, 0.80)
SATCHEL_Y = 1.54 + 0.17               # slab top + half height
PANNIERS = [(1.06, 1.02, 0.30), (-1.06, 1.02, 0.30)]   # flank satchel bags
PANNIER_SIZE = (0.24, 0.55, 0.95)

# ── greebles (functional only) ───────────────────────────────────────────
HATCH = (0.0, 1.555, 0.25)            # crew hatch behind the ring
HATCH_SIZE = (0.55, 0.09, 0.55)
VISOR = (0.0, 1.38, -1.52, 0.95, 0.16, 0.28)   # driver vision block
BUMPER = (0.0, 0.55, -2.83, 1.30, 0.26, 0.20)  # bull bar
EXHAUSTS = [(0.70, 0.85, 2.62), (-0.70, 0.85, 2.62)]
EXHAUST_SIZE = (0.22, 0.22, 0.75)
ANT_BASE = (-0.60, 1.20, 2.30)        # whip antenna (dispatch radio)
ANT_TOP = (-0.60, 2.40, 2.28)
ANT_R = (0.035, 0.012)
