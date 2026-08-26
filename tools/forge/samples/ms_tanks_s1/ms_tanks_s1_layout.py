"""ms_tanks_s1_layout — zones + dims for ms_tanks_s1 (tankette pack).

Tanks-row s1 (STYLE.md length 4.5 m): fast, thin-skinned wheeled tankette —
the real replacement for the WZ2100 `wz_wheeled` placeholder that tanks.lua
s1 has been borrowing. Armoured-car read: low lofted hull with a sloped
glacis, four exposed wheels on spinnable `axle_f`/`axle_r` pieces, a small
autocannon turret (standard turret/barrel/muzzle aim chain for MS_AC_S1),
mudguards, rear stowage, whip aerial. ≤ 1500 tris.

World frame: forward=-Z, up=+Y, left=+X, ground Y=0, 1 unit = 1 m.
Single source of truth for BOTH the geometry generator and the painter.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas zones (1024²; v down) ──────────────────────────────────────────
T_TOP    = Zone((0,   0,   384, 448), ('x', 'z'), ((-0.90, 0.90), (-2.25, 2.25)))
T_SIDE   = Zone((384, 0,   896, 176), ('z', 'y'), ((-2.25, 2.25), (1.06, 0.22)))
T_GLACIS = Zone((896, 0,   1024, 144), ('x', 'y'), ((-0.90, 0.90), (1.06, 0.22)))
T_REAR   = Zone((896, 144, 1024, 288), ('x', 'y'), ((0.90, -0.90), (1.06, 0.22)))
T_DARK   = Zone((896, 880, 1024, 1008), ('x', 'z'), ((-1.0, 1.0), (-2.25, 2.25)))
# one square cell per wheel solid (caps project the hub; tread edges sample
# the cell rim — keep the rim rubber-dark)
T_WHEEL  = Zone((0,   448, 176, 624), ('z', 'y'), ((-0.46, 0.46), (0.46, -0.46)))
T_TURRET = Zone((384, 176, 704, 384), ('x', 'z'), ((-0.36, 0.36), (-0.45, 0.45)))
T_BARREL = (704, 176, 832, 304)        # parametric barrel wrap (rect)
T_TRIM   = (832, 176, 960, 304)        # parametric small-part wrap (rect)
T_STOW   = Zone((0,   624, 224, 752), ('x', 'y'), ((-0.50, 0.50), (0.40, -0.40)))
T_FENDER = Zone((224, 448, 624, 528), ('z', 'x'), ((-2.00, 2.00), (-0.20, 0.20)))
T_HATCH  = Zone((224, 528, 352, 656), ('x', 'z'), ((-0.24, 0.24), (-0.24, 0.24)))

# ── dims (metres; forward -Z, ground Y=0) ────────────────────────────────
BODY_LEN = (-2.25, 2.25)               # 4.5 m dominant dim (STYLE.md s1)

# hull loft sections: (z, y_bot, y_waist, y_shoulder, y_deck,
#                      w_bot, w_waist, w_deck, w_top)
HULL_SECTIONS = [
    (-2.25, 0.50, 0.62, 0.78, 0.84, 0.30, 0.58, 0.50, 0.36),
    (-1.45, 0.30, 0.60, 0.94, 1.00, 0.62, 0.86, 0.78, 0.62),
    (-0.50, 0.28, 0.60, 0.98, 1.04, 0.66, 0.90, 0.82, 0.68),
    (0.55,  0.28, 0.60, 0.96, 1.02, 0.66, 0.90, 0.82, 0.68),
    (1.50,  0.30, 0.58, 0.90, 0.96, 0.62, 0.86, 0.76, 0.62),
    (2.25,  0.42, 0.58, 0.80, 0.86, 0.44, 0.68, 0.58, 0.44),
]

# wheels / axles (piece-local origin at axle centre; n-gon flats ground rule:
# axle y = r*cos(pi/n))
WHEEL_R  = 0.44
WHEEL_W  = 0.26
WHEEL_N  = 10
TRACK_W  = 1.56                        # inner faces gap (centres at ±0.91)
AXLE_Y   = 0.44 * 0.9510565            # r*cos(pi/10)
AXLE_F_Z = -1.35
AXLE_R_Z = 1.35

# mudguards over the wheels (body geometry): (x, y, z, w, h, d)
FENDERS = [(0.91, 0.99, -1.35, 0.36, 0.07, 1.30),
           (-0.91, 0.99, -1.35, 0.36, 0.07, 1.30),
           (0.91, 0.99, 1.35, 0.36, 0.07, 1.30),
           (-0.91, 0.99, 1.35, 0.36, 0.07, 1.30)]

# turret (aim chain; MS_AC_S1 autocannon)
TURRET_MOUNT = (0.0, 1.02, -0.30)
TURRET_RING  = 0.40
BARREL_LEN   = 1.55
BARREL_R     = 0.055

# greebles (model frame)
DRIVER_HATCH = (-0.42, 1.04, -1.05, 0.46, 0.06, 0.46)   # x,y,z,w,h,d
STOW_BOX     = (0.0, 1.06, 1.55, 0.96, 0.30, 0.70)
EXHAUSTS     = [((0.52, 0.62, 2.25), (0.52, 0.62, 2.50)),
                ((-0.52, 0.62, 2.25), (-0.52, 0.62, 2.50))]
EXHAUST_R    = 0.055
AERIAL       = (0.62, 0.96, 1.20)
AERIAL_TOP   = 2.35
