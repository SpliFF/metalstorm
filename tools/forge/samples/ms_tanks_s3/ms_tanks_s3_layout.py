"""ms_tanks_s3_layout — zones + dims for ms_tanks_s3 (heavy tank platoon).

Tanks-row s3 (STYLE.md length 12 m): heavy tracked tank — the real
replacement for the WZ2100 `wz_tank` placeholder that tanks.lua s3 has been
borrowing. Def carries MS_RAILGUN_S2 (slot 1) + MS_MG_S2 (slot 2), so the
model ships TWO aim chains: turret/barrel/muzzle (railgun, long shrouded
barrel) and turret2/barrel2/muzzle2 (pintle MG on the rear deck) — the
scriptless-native name convention (Weapon.cpp ResolveFallbackWeaponPieces).
Pieces: body / tracks_l / tracks_r / turret / barrel / muzzle / turret2 /
barrel2 / muzzle2. ≤ 2000 tris.

World frame: forward=-Z, up=+Y, left=+X, ground Y=0, 1 unit = 1 m.
Single source of truth for BOTH the geometry generator and the painter.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas zones (1024²; v down) ──────────────────────────────────────────
H_TOP      = Zone((0,   0,   448, 384), ('x', 'z'), ((-1.30, 1.30), (-6.0, 6.0)))
H_SIDE     = Zone((0,   384, 448, 496), ('z', 'y'), ((-6.0, 6.0), (2.25, 0.30)))
H_GLACIS   = Zone((448, 0,   640, 160), ('x', 'y'), ((-1.30, 1.30), (2.25, 0.30)))
H_REAR     = Zone((640, 0,   832, 160), ('x', 'y'), ((1.30, -1.30), (2.25, 0.30)))
H_DARK     = Zone((832, 0,   960, 96), ('x', 'z'), ((-2.0, 2.0), (-6.0, 6.0)))
TRK_SIDE   = Zone((0,   496, 448, 608), ('z', 'y'), ((-5.7, 5.7), (1.70, 0.00)))
TRK_WRAP   = (0, 608, 448, 672)          # parametric (arc-length) track wrap
TRK_FENDER = Zone((0,   672, 448, 736), ('z', 'x'), ((-5.6, 5.6), (-0.52, 0.52)))
TUR_SIDE   = Zone((448, 160, 896, 320), ('z', 'y'), ((-1.70, 1.90), (1.10, 0.00)))
TUR_TOP    = Zone((448, 320, 896, 560), ('x', 'z'), ((-1.25, 1.25), (-1.70, 1.90)))
TUR_FRONT  = Zone((896, 160, 1024, 320), ('x', 'y'), ((-1.25, 1.25), (1.10, 0.00)))
TUR_REAR   = Zone((896, 320, 1024, 480), ('x', 'y'), ((1.25, -1.25), (1.10, 0.00)))
BARREL_R_  = (448, 560, 576, 688)        # railgun barrel wrap (rect)
TRIM       = (576, 560, 704, 688)        # parametric small-part wrap (rect)
TRIM_BOX   = Zone((576, 560, 704, 688), ('x', 'z'), ((-0.20, 0.20), (-0.45, 0.45)))
HATCH      = Zone((704, 560, 832, 688), ('x', 'z'), ((-0.35, 0.35), (-0.35, 0.35)))
MG_BODY    = Zone((832, 560, 960, 688), ('x', 'z'), ((-0.30, 0.30), (-0.35, 0.40)))
MG_BARREL  = (448, 688, 576, 752)        # MG barrel wrap (rect)
STOW       = Zone((576, 688, 832, 784), ('z', 'y'), ((-1.60, 1.60), (0.50, 0.00)))

# ── dims (metres; forward -Z, ground Y=0) ────────────────────────────────
HULL_LEN = (-6.0, 6.0)                   # 12 m dominant dim (STYLE.md s3)

# hull loft sections: (z, y_bot, y_waist, y_shoulder, y_deck,
#                      w_bot, w_waist, w_deck, w_top)
HULL_SECTIONS = [
    (-5.95, 0.90, 1.10, 1.35, 1.45, 0.45, 0.85, 0.70, 0.50),
    (-4.40, 0.40, 1.20, 1.80, 1.95, 0.95, 1.28, 1.15, 0.95),
    (-2.00, 0.32, 1.30, 2.05, 2.20, 1.05, 1.30, 1.20, 1.05),
    (1.50,  0.32, 1.30, 2.05, 2.20, 1.05, 1.30, 1.20, 1.05),
    (4.20,  0.36, 1.25, 1.95, 2.10, 1.00, 1.28, 1.15, 0.95),
    (6.00,  0.55, 1.10, 1.55, 1.65, 0.80, 1.10, 0.95, 0.70),
]

# track pods (piece-local; x mirrored for tracks_r)
TRACK_OFF     = (1.82, 0.0, 0.0)
TRACK_PROFILE = [                        # local (z, y), outer loop
    (-5.70, 0.85), (-4.60, 0.12), (4.60, 0.12), (5.70, 0.80),
    (5.52, 1.45), (3.90, 1.66), (-3.90, 1.66), (-5.42, 1.42),
]
TRACK_HALF_W = 0.50
FENDER       = ((-5.60, 5.60), 1.62, 0.12, 1.08)  # (zspan, ytop_base, h, width)
SKIRT        = (0.56, 1.05, 0.08, 0.62, -4.20, 4.40)  # x,y,w,h,z0,z1 (pod-local)
ROAD_WHEELS  = [-3.90 + i * 1.30 for i in range(7)]   # painted, TRK_SIDE

# main turret (piece `turret`; pivot at ring centre on the deck)
TURRET_OFF   = (0.0, 2.20, -0.90)
TURRET_RING  = 1.00
TUR_BODY     = (0.0, 0.62, 0.10, 2.45, 0.88, 3.30)    # local x,y,z,w,h,d
MANTLET      = (0.0, 0.58, -1.72, 1.05, 0.72, 0.55)
BASKET       = (0.0, 0.55, 1.72, 1.90, 0.60, 0.55)    # rear stowage basket
TUR_HATCH    = (0.55, 1.06, 0.35, 0.60, 0.07, 0.60)
SIGHT_BOX    = (-0.75, 1.06, -0.55, 0.35, 0.16, 0.45)

# railgun (piece `barrel`; pivot at the trunnion, extends -z)
BARREL_OFF   = (0.0, 0.58, -1.80)        # turret-local trunnion
SHROUD_LEN   = 1.80
SHROUD_R     = 0.20
BARREL_LEN   = 4.50                      # trunnion -> muzzle tip
BARREL_RAD   = 0.125
BRAKE        = (0.0, 0.0, -4.25, 0.34, 0.34, 0.55)    # muzzle brake box

# MG chain (piece `turret2` on the rear deck behind the turret)
MG_OFF       = (0.0, 2.20, 2.95)
MG_RING      = 0.30
MG_BARREL_L  = 1.05
MG_BARREL_RD = 0.042

# greebles (model frame)
EXHAUSTS     = [(1.05, 1.95, 3.60), (-1.05, 1.95, 3.60)]
EXHAUST_SIZE = (0.30, 0.55, 0.85)
STOW_BINS    = [(1.28, 1.75, 0.80), (-1.28, 1.75, 0.80)]
STOW_SIZE    = (0.24, 0.42, 3.20)
AERIAL       = (1.05, 1.10, 1.55)        # turret-local whip base
AERIAL_TOP   = 3.00                      # turret-local tip y
