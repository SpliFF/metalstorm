"""heavy_layout — atlas zones + design constants for fable_heavy.

Extra-heavy tank: 2× fable_tank length (~19.7 m overall), twin-tube main
turret, independent secondary turret on the front-LEFT (+X) sponson.
Atlas is 2048² so texel density matches fable_tank (same px/m ⇒ same
world-scale seams/bolts/wear) — this is a physically larger unit, not a
scale-up.  All world coords in metres, forward=-Z, up=+Y, left=+X.
"""
import meshlib
meshlib.ATLAS = 2048          # must be set before any Zone.uv() call
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
# column x 0..1024: hull + running gear + hull detail cells
Z_HULL_TOP    = Zone((0,    0,    1024, 464),  ('x', 'z'), ((-2.35, 2.35), (-8.25, 8.25)))
Z_HULL_SIDE   = Zone((0,    464,  1024, 688),  ('z', 'y'), ((-8.25, 8.25), (3.15, 0.25)))
Z_TRACK_SIDE  = Zone((0,    688,  1024, 928),  ('z', 'y'), ((-7.95, 7.95), (2.44, 0.02)))
Z_TRACK_WRAP  = (0, 928, 1024, 1056)     # parametric (arc-length)
Z_FENDER      = Zone((0,    1056, 1024, 1200), ('z', 'x'), ((-7.90, 7.90), (-1.05, 1.05)))
Z_HATCH       = Zone((0,    1200, 192,  1392), ('x', 'z'), ((-0.42, 0.42), (-0.42, 0.42)))
Z_INTAKE      = Zone((192,  1200, 576,  1392), ('x', 'z'), ((-1.80, 1.80), (-1.85, 1.85)))
Z_EXHAUST     = Zone((576,  1200, 768,  1392), ('x', 'y'), ((-0.40, 0.40), (0.55, -0.55)))
Z_SENSOR      = Zone((768,  1200, 1024, 1328), ('x', 'y'), ((-1.05, 1.05), (0.15, -0.15)))
Z_STOW        = Zone((0,    1392, 256,  1584), ('z', 'y'), ((-1.10, 1.10), (0.25, -0.25)))
Z_DRUM        = (256, 1392, 512, 1520)   # parametric drum wrap
Z_DRUM_CAP    = Zone((512,  1392, 640,  1520), ('x', 'z'), ((-0.42, 0.42), (-0.42, 0.42)))
Z_SPARE       = Zone((640,  1392, 896,  1520), ('x', 'z'), ((-0.38, 0.38), (-0.27, 0.27)))
Z_ANT         = Zone((896,  1392, 1024, 1520), ('x', 'y'), ((-0.18, 0.18), (0.30, -0.30)))
Z_SPONSON     = Zone((0,    1584, 384,  1776), ('z', 'y'), ((-1.35, 1.35), (0.40, -0.40)))
Z_MUDFLAP     = Zone((384,  1584, 576,  1776), ('x', 'y'), ((-0.88, 0.88), (0.45, -0.45)))
Z_HUB         = (576, 1584, 768, 1712)   # parametric stub wrap
Z_HUB_CAP     = Zone((768,  1584, 928,  1744), ('z', 'y'), ((-0.62, 0.62), (0.62, -0.62)))
Z_T2_WRAP     = (0, 1776, 384, 1904)     # parametric turret2 drum wrap
Z_T2_TOP      = Zone((384,  1776, 576,  1968), ('x', 'z'), ((-0.92, 0.92), (-0.92, 0.92)))
Z_B2_WRAP     = (576, 1776, 960, 1876)   # parametric barrel2 tube
Z_B2_CELL     = Zone((0,    1904, 128,  2032), ('x', 'y'), ((-0.28, 0.28), (0.28, -0.28)))

# column x 1024..2048: hull ends + turret + barrel
Z_GLACIS      = Zone((1024, 0,    1472, 336),  ('x', 'y'), ((-2.35, 2.35), (3.15, 0.25)))
Z_HULL_REAR   = Zone((1472, 0,    1920, 336),  ('x', 'y'), ((2.35, -2.35), (3.15, 0.25)))
Z_DARK        = Zone((1920, 0,    2048, 336),  ('x', 'z'), ((-2.35, 2.35), (-8.25, 8.25)))
Z_TURRET_TOP  = Zone((1024, 336,  1696, 800),  ('x', 'z'), ((-2.35, 2.35), (-3.15, 3.55)))
Z_TURRET_SIDE = Zone((1696, 336,  2048, 600),  ('z', 'y'), ((-3.15, 3.55), (1.95, -0.08)))
Z_TURRET_FRONT= Zone((1696, 600,  1872, 800),  ('x', 'y'), ((-1.95, 1.95), (1.90, -0.08)))
Z_TURRET_REAR = Zone((1872, 600,  2048, 800),  ('x', 'y'), ((1.75, -1.75), (1.75, -0.05)))
Z_BARREL_WRAP = (1024, 800, 2048, 928)   # parametric tube rect (both tubes)
Z_TUBE_CAP    = Zone((1024, 928,  1152, 1056), ('x', 'y'), ((-0.45, 0.45), (0.45, -0.45)))
Z_CAP_RING    = (1152, 928, 1664, 1056)  # parametric capacitor ring wrap
Z_SLEEVE      = Zone((1664, 928,  2048, 992),  ('x', 'z'), ((-0.62, 0.62), (-1.05, 1.05)))
Z_SLEEVE_S    = Zone((1664, 992,  2048, 1056), ('x', 'y'), ((-0.62, 0.62), (0.28, -0.28)))
Z_BREECH      = Zone((1024, 1056, 1280, 1248), ('x', 'y'), ((-1.10, 1.10), (0.52, -0.52)))
Z_BRAKE       = Zone((1280, 1056, 1536, 1248), ('x', 'y'), ((-0.42, 0.42), (0.40, -0.40)))
Z_POD         = Zone((1536, 1056, 1792, 1248), ('z', 'y'), ((-0.42, 0.42), (0.26, -0.26)))
Z_BUSTLE      = Zone((1792, 1056, 2048, 1248), ('x', 'y'), ((-1.05, 1.05), (0.33, -0.33)))
Z_SMOKE       = Zone((1024, 1248, 1216, 1440), ('z', 'y'), ((-0.36, 0.36), (0.17, -0.17)))
Z_SIGHT       = (1216, 1248, 1472, 1440) # parametric sight drum wrap
Z_SIGHT_TOP   = Zone((1472, 1248, 1664, 1440), ('x', 'z'), ((-0.48, 0.48), (-0.48, 0.48)))
Z_TRIM        = Zone((1664, 1248, 2048, 1440), ('z', 'y'), ((-2.90, 2.90), (0.22, -0.22)))
Z_ENGDECK     = Zone((1024, 1440, 1536, 1728), ('z', 'y'), ((-1.85, 1.85), (0.18, -0.18)))
Z_STACK_TOP   = Zone((1536, 1440, 1728, 1632), ('x', 'z'), ((-0.38, 0.38), (-0.42, 0.42)))
Z_SPONSON_TOP = Zone((1728, 1440, 2048, 1728), ('x', 'z'), ((0.90, 3.10), (-6.75, -3.95)))

# ── design constants ─────────────────────────────────────────────────────
HULL_LEN    = (-8.10, 8.10)
HULL_DECK_Y = 3.02
TRACK_OFF   = (3.10, 0.0, 0.0)          # tracks_l offset (x mirrored for _r)
TRACK_PROFILE = [                        # local (z, y), outer loop
    (-7.85, 1.35), (-5.90, 0.16), (5.90, 0.16), (7.85, 1.32),
    (7.68, 2.12), (5.10, 2.40), (-5.10, 2.40), (-7.62, 2.10),
]
TRACK_HALF_W = 0.95
HUB_FRONT   = (-7.30, 1.52, 0.55)       # local (z, y, radius) sprocket
HUB_REAR    = (7.32, 1.50, 0.52)        # idler
FENDER      = ((-7.75, 7.85), 2.40, 0.16, 2.04)   # (zspan, ytop_base, h, width)
SKIRTS      = [                          # x,y,w,h,z0,z1 (pod-local), 2 plates
    (1.00, 1.62, 0.10, 0.92, -6.90, -0.35),
    (1.00, 1.62, 0.10, 0.92, 0.25, 7.10),
]
MUDFLAPS    = [                          # (z, tilt hint unused) front/rear
    (0.0, 0.90, -7.98), (0.0, 0.90, 7.95),
]
MUDFLAP_SIZE = (1.70, 0.80, 0.12)

TURRET_OFF  = (0.0, 3.00, -0.60)
BARREL_OFF  = (0.0, 1.02, -2.30)        # relative to turret
TUBE_X      = 0.62                       # twin tube lateral offset
MUZZLE_OFF  = (0.0, 0.0, -8.72)         # relative to barrel (bore centre)
TURRET2_OFF = (2.00, 2.70, -5.35)       # front-LEFT sponson (+X, -Z); kept
                                        # low: drum roof 3.34, sensor 3.50 —
                                        # below the main tubes' underside
                                        # (3.60) so the twin gun traverses
                                        # clear across the bow
BARREL2_OFF = (0.0, 0.32, -0.70)        # relative to turret2
MUZZLE2_OFF = (0.0, 0.0, -2.45)         # relative to barrel2
EXHAUST_OFF = (0.0, 3.55, 7.30)

# hull loft sections: (z, y_bot, y_waist, y_shoulder, y_deck,
#                      w_bot, w_waist, w_deck, w_top)
HULL_SECTIONS = [
    (-8.05, 1.30, 1.55, 1.78, 1.86, 0.60, 1.05, 0.85, 0.55),
    (-6.40, 0.55, 1.62, 2.16, 2.30, 1.55, 2.25, 1.85, 1.40),
    (-4.40, 0.40, 1.80, 2.72, 3.00, 1.80, 2.50, 2.20, 1.80),
    (-2.00, 0.40, 1.85, 2.80, 3.02, 1.85, 2.55, 2.30, 1.88),
    (0.60,  0.40, 1.85, 2.80, 3.02, 1.85, 2.55, 2.30, 1.88),
    (2.90,  0.40, 1.82, 2.74, 2.96, 1.82, 2.52, 2.26, 1.84),
    (4.90,  0.40, 1.78, 2.62, 2.85, 1.75, 2.45, 2.15, 1.72),
    (6.60,  0.45, 1.65, 2.36, 2.55, 1.50, 2.15, 1.85, 1.45),
    (8.10,  0.75, 1.50, 2.10, 2.28, 1.20, 1.85, 1.55, 1.15),
]

# main turret loft sections (local frame, y0 = ring base)
TURRET_SECTIONS = [
    (-3.00, -0.08, 0.22, 0.85, 0.98, 0.55, 0.95, 0.75, 0.50),
    (-1.60, -0.08, 0.28, 1.45, 1.62, 1.40, 1.85, 1.55, 1.15),
    (0.60,  -0.06, 0.30, 1.70, 1.90, 1.85, 2.30, 1.95, 1.50),
    (2.10,  -0.06, 0.30, 1.60, 1.78, 1.70, 2.10, 1.75, 1.35),
    (3.30,  0.00, 0.26, 1.35, 1.50, 1.25, 1.65, 1.35, 1.00),
]

# ── greeble anchors ──────────────────────────────────────────────────────
HATCHES     = [(1.35, -3.30), (-1.05, 3.65), (0.75, 4.55)]   # (x, z) on deck
HATCH_SIZE  = (0.80, 0.12, 0.80)
SENSOR_BAR  = (0.0, 2.48, -5.55, 2.00, 0.18, 0.32)           # x,y,z,w,h,d
ENG_DECK    = (0.0, 3.12, 5.35, 3.50, 0.34, 3.55)            # raised engine deck
EXHAUST_STACKS = [(1.30, 3.70, 6.80), (-1.30, 3.70, 6.80)]   # vertical stacks
STACK_SIZE  = (0.72, 1.05, 0.80)
STOWS       = [                                              # x,y,z,w,h,d
    (2.00, 3.16, 0.60, 1.05, 0.34, 1.70),
    (-2.02, 3.16, 1.10, 1.05, 0.34, 2.20),
    (-1.92, 3.12, -3.30, 0.95, 0.30, 1.40),
]
DRUMS       = [(0.88, 2.30, 8.32), (-0.88, 2.30, 8.32)]      # vertical fuel drums
DRUM_R, DRUM_H = 0.40, 1.15
SPARES      = [(-0.85, 2.44, -6.60), (0.05, 2.40, -6.80), (0.95, 2.34, -7.00)]
SPARE_SIZE  = (0.74, 0.15, 0.52)
ANT         = (1.72, 3.32, 4.30, 0.30, 0.58, 0.30)           # antenna base
SPONSON     = (2.00, 2.35, -5.35, 2.05, 0.75, 2.60)          # turret2 pedestal
                                        # (low casemate step, merges with the
                                        # trackguard — top 2.725)

CHEEKS      = [(1.12, 0.92, -2.05), (-1.12, 0.92, -2.05)]    # turret appliqué
CHEEK_SIZE  = (0.22, 0.72, 0.95)
TOWCABLE    = (-2.25, 3.06, 1.90, 0.14, 0.12, 5.60)          # x,y,z,w,h,d
SIGHT_DRUM  = (0.85, 1.10, 0.46, 0.44)   # turret-local x,z, radius, height
SIGHT_YBASE = 1.84
SENSOR_POD  = (-1.15, 0.95, -0.50, 0.52, 0.44, 0.76)         # turret-local
BUSTLE      = (0.0, 0.72, 2.95, 2.00, 0.60, 0.92)
SMOKES      = [(1.72, 0.72, -1.15), (-1.72, 0.72, -1.15)]    # turret-local
SMOKE_SIZE  = (0.36, 0.28, 0.64)

# main barrel assembly (barrel-local, bore axis y=0; tubes at x=±TUBE_X)
BREECH      = (0.0, -0.02, 0.95, 2.05, 1.00, 1.70)
TUBE_STATIONS = [(0.10, 0.42), (-3.30, 0.42), (-3.30, 0.30), (-7.55, 0.30)]
CAP_RING    = ((-1.75, -2.40), 0.50)     # zspan, radius (per tube)
BRAKE_SIZE  = (0.80, 0.74, 0.95)
BRAKE_Z     = -7.85
TIP_STUB    = ((-8.35, -8.72), 0.185)
SLEEVE      = (0.0, 0.0, -1.55, 1.15, 0.50, 2.00)            # inter-tube cradle

# turret2 (drum) + barrel2
T2_R, T2_H  = 0.85, 0.64
T2_SENSOR   = (0.0, 0.72, -0.52, 0.34, 0.16, 0.30)           # box on t2 roof
B2_STATIONS = [(-0.05, 0.185), (-1.55, 0.185), (-1.55, 0.125), (-2.28, 0.125)]
B2_BRAKE    = (0.0, 0.0, -2.34, 0.30, 0.28, 0.26)
