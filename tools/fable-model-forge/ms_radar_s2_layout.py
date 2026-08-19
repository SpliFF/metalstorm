"""ms_radar_s2_layout — zones + dims for ms_radar_s2 (Sector Tracking Station).

STYLE.md radar row: s2 height = 6 m, tri budget <=2000. Immobile, unarmed
building — no aim chain, the only moving part is `dish`.

Design language follows ms_radar_s1 (same faction sensor family) one tier
up, but trades s1's open lattice mast + open ring dish for a squat poured
blockhouse, a heavy drum pedestal / slew ring, and a SOLID parabolic dish
on an elevation yoke: read from far away = one big round dish, low and wide.

World frame: RH, blockhouse door faces -Z, up +Y, ground Y=0, 1u = 1 m.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

ATLAS = 1024

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
PAD_H     = 0.24
PAD_HALF  = 2.30                      # 4.6 x 4.6 anchored pad
PAD       = (0.0, PAD_H / 2, 0.0, PAD_HALF * 2, PAD_H, PAD_HALF * 2)

BLK_W, BLK_H, BLK_D = 2.60, 2.00, 2.60
BLK_Y     = PAD_H + BLK_H / 2         # blockhouse centre
BLK_TOP   = PAD_H + BLK_H             # 2.24
BLK_HX    = BLK_W / 2
BLK_HZ    = BLK_D / 2

PED_R     = 0.62                      # heavy pedestal drum
PED_H     = 1.00
PED_TOP   = BLK_TOP + PED_H           # 3.24
SLEW_R    = 0.74                      # slew ring collar
SLEW_H    = 0.10
SLEW_TOP  = PED_TOP + SLEW_H          # 3.34

DISH_OFF  = (0.0, SLEW_TOP, 0.0)      # `dish` piece pivot (pedestal top)

# — dish piece, PIECE-LOCAL (origin = DISH_OFF) —
TURN_R    = 0.56                      # rotating turntable on the slew ring
TURN_H    = 0.20
YOKE_X    = 0.46                      # trunnion arm half-spacing
HUB_Y     = 1.25                      # dish vertex height above the pivot
DISH_R    = 1.30                      # 2.6 m across
DISH_F    = 0.95                      # paraboloid focal length
DISH_TILT = 25.0                      # degrees of skyward elevation
SHELL_T   = 0.07                      # shell thickness (back surface offset)
LIP_H     = 0.10                      # rim lip standing proud of the front
FEED_R    = 1.14                      # tripod feet radius on the dish face
CWT       = (0.0, 1.098, 0.326)       # counterweight box centre (local)
CWT_SIZE  = (0.72, 0.48, 0.42)
# dish tip (rim top) lands at world y = 6.00

# ── atlas zones (1024²; v down) ──────────────────────────────────────────
Z_PAD     = Zone((0,   0,   384, 384), ('x', 'z'),
                 ((-PAD_HALF, PAD_HALF), (-PAD_HALF, PAD_HALF)))
Z_PADS    = Zone((0,   384, 384, 448), ('z', 'y'),
                 ((-PAD_HALF, PAD_HALF), (PAD_H + 0.02, -0.02)))
Z_PADS_F  = Zone((0,   384, 384, 448), ('x', 'y'),
                 ((-PAD_HALF, PAD_HALF), (PAD_H + 0.02, -0.02)))

_BV = (BLK_TOP + 0.02, PAD_H - 0.02)          # shared vertical window
Z_BLK_FZ  = Zone((384, 0,   704,  256), ('x', 'y'), ((-BLK_HX, BLK_HX), _BV))
Z_BLK_BZ  = Zone((704, 0,   1024, 256), ('x', 'y'), ((-BLK_HX, BLK_HX), _BV))
Z_BLK_PX  = Zone((384, 256, 704,  512), ('z', 'y'), ((-BLK_HZ, BLK_HZ), _BV))
Z_BLK_NX  = Zone((704, 256, 1024, 512), ('z', 'y'), ((-BLK_HZ, BLK_HZ), _BV))
Z_BLK_T   = Zone((0,   448, 256,  704), ('x', 'z'),
                 ((-BLK_HX, BLK_HX), (-BLK_HZ, BLK_HZ)))

R_PED     = (256, 448, 320, 704)      # pedestal drum wrap
R_TRIM    = (320, 448, 384, 704)      # parametric conduit/small-part wrap
R_DISH_F  = (384, 512, 768, 896)      # dish front (explicit UVs)
R_DISH_B  = (768, 512, 1024, 768)     # dish back  (explicit UVs)
R_RIB     = (0,   704, 256, 768)      # parametric rib wrap
R_YOKE    = (0,   768, 256, 832)      # parametric yoke/trunnion wrap
R_LIP     = (0,   832, 256, 896)      # rim lip band (explicit UVs)
R_SLEW    = (320, 704, 384, 768)      # slew-ring collar
R_TURN    = (320, 768, 384, 832)      # rotating turntable
R_STEP    = (256, 832, 384, 896)      # door threshold slab
R_CWT     = (0,   896, 256, 1024)     # counterweight box
R_FEED    = (256, 896, 384, 1024)     # feed horn
R_LIGHT   = (896, 768, 1024, 896)     # amber status lamps
R_VENT    = (768, 896, 1024, 1024)    # vent louvre bank

Z_PED     = Zone(R_PED,  ('x', 'y'), ((-PED_R, PED_R), (PED_TOP + 0.02, BLK_TOP - 0.04)))
Z_SLEW    = Zone(R_SLEW, ('x', 'y'), ((-SLEW_R, SLEW_R), (SLEW_TOP + 0.02, PED_TOP - 0.02)))
Z_TURN    = Zone(R_TURN, ('x', 'y'), ((-TURN_R, TURN_R), (TURN_H + 0.02, -0.02)))
Z_VENT    = Zone(R_VENT, ('x', 'y'), ((-0.85, 0.85), (2.06, 1.18)))
Z_STEP    = Zone(R_STEP, ('x', 'z'), ((-0.60, 0.60), (-1.78, -1.26)))
