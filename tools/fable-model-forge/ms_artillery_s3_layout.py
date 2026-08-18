"""ms_artillery_s3_layout — zones + dims for ms_artillery_s3 (heavy SPG).

Heavy open-mount self-propelled gun, artillery-row s3, 10.5 m hull.
Where ms_artillery_s2 is a closed casemate SPG, s3 is an open gun deck:
long low tracked chassis (8 road wheels), engine block forward with twin
exhaust stacks, and amidships/rear a bare pedestal mount carrying a very
long high-velocity howitzer behind a gun shield plate (no turret house).
Recoil spades folded on the rear plate, ammo lockers on the rear deck
flanks, small loading-crane arm as stowage. Read: "the long-gun one,
crew in the open". Pieces: body / tracks_l / tracks_r / turret / barrel
/ muzzle. <= 2000 tris.

World frame: forward=-Z, up=+Y, left=+X, ground Y=0, 1 unit = 1 m.
Single source of truth for BOTH the geometry generator (UV projection)
and the texture painter.
"""
import numpy as np
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas zones (1024²; v down) ──────────────────────────────────────────

C_HULL_TOP    = Zone((0,   0,   512, 120), ('z', 'x'), ((-5.25, 5.25), (-1.12, 1.12)))
C_HULL_SIDE   = Zone((0,   120, 512, 220), ('z', 'y'), ((-5.25, 5.25), (1.36, 0.05)))
C_TRACK_SIDE  = Zone((0,   220, 512, 330), ('z', 'y'), ((-5.10, 5.10), (1.20, 0.00)))
C_TRACK_WRAP  = (0, 330, 512, 384)     # parametric (arc-length) track wrap
C_FENDER      = Zone((0,   384, 512, 436), ('z', 'x'), ((-4.95, 5.00), (-0.55, 0.55)))
C_GLACIS      = Zone((512, 0,   704, 140), ('x', 'y'), ((-1.12, 1.12), (1.36, 0.05)))
C_HULL_REAR   = Zone((704, 0,   896, 140), ('x', 'y'), ((1.12, -1.12), (1.36, 0.05)))
C_DARK        = Zone((896, 0,   1024, 64), ('x', 'z'), ((-1.0, 1.0), (-1.0, 1.0)))
C_LIGHT       = Zone((896, 64,  960, 128), ('x', 'y'), ((-0.08, 0.08), (0.08, -0.08)))
C_TRIM        = (960, 64, 1024, 128)   # parametric small-part wrap
C_TRIM_BOX    = Zone((960, 64, 1024, 128), ('x', 'y'), ((-0.10, 0.10), (0.10, -0.10)))
C_PED         = (896, 128, 1024, 256)  # parametric pedestal wrap
C_ENGINE_TOP  = Zone((512, 140, 704, 260), ('z', 'x'), ((-4.38, -2.42), (-0.98, 0.98)))
C_ENGINE_SIDE = Zone((704, 140, 896, 260), ('z', 'y'), ((-4.38, -2.42), (2.06, 1.28)))
C_ENGINE_FACE = Zone((704, 260, 832, 340), ('x', 'y'), ((-0.98, 0.98), (2.06, 1.28)))
C_STACK       = (832, 260, 896, 340)   # parametric exhaust-stack wrap
C_MOUNT       = Zone((512, 260, 704, 340), ('z', 'y'), ((-0.60, 0.80), (1.25, 0.30)))
C_SHIELD_F    = Zone((0,   436, 320, 620), ('x', 'y'), ((-1.15, 1.15), (1.62, 0.18)))
C_SHIELD_B    = Zone((320, 436, 640, 620), ('x', 'y'), ((1.15, -1.15), (1.62, 0.18)))
C_BREECH      = (640, 436, 768, 540)   # parametric breech wrap
C_BRAKE       = (768, 436, 896, 540)   # parametric muzzle-brake wrap
C_RECUP       = (896, 436, 1024, 540)  # parametric recuperator wrap
C_BARREL      = (640, 540, 1024, 600)  # parametric long-tube wrap
C_LOCKER_S    = Zone((0,   620, 192, 700), ('z', 'y'), ((3.22, 4.58), (1.86, 1.30)))
C_LOCKER_T    = Zone((192, 620, 384, 700), ('z', 'x'), ((3.22, 4.58), (-1.15, 1.15)))
C_LOCKER_E    = Zone((384, 620, 448, 700), ('x', 'y'), ((-1.15, 1.15), (1.86, 1.30)))
C_SPADE       = Zone((448, 620, 576, 760), ('x', 'y'), ((-1.05, 1.05), (1.25, 0.30)))

# ── design constants ────────────────────────────────────────────────────

HULL_LEN   = (-5.20, 5.20)             # 10.4 m hull; 10.5 m read w/ spades
DECK_Y     = 1.32

# hull loft sections: (z, y_bot, y_waist, y_shoulder, y_deck,
#                      w_bot, w_waist, w_deck, w_top)
HULL_SECTIONS = [
    (-5.20, 0.55, 0.70, 0.86, 0.92, 0.35, 0.62, 0.52, 0.36),
    (-4.20, 0.26, 0.76, 1.06, 1.14, 0.80, 1.06, 0.96, 0.80),
    (-2.60, 0.20, 0.82, 1.24, 1.32, 0.90, 1.12, 1.03, 0.92),
    (0.00,  0.20, 0.82, 1.26, 1.34, 0.90, 1.12, 1.04, 0.94),
    (2.60,  0.20, 0.80, 1.22, 1.30, 0.88, 1.10, 1.02, 0.92),
    (4.20,  0.22, 0.76, 1.12, 1.20, 0.80, 1.02, 0.94, 0.82),
    (5.20,  0.40, 0.68, 0.96, 1.04, 0.60, 0.88, 0.76, 0.55),
]

# tracks (piece-local; x mirrored for tracks_r)
TRACK_OFF     = (1.55, 0.0, 0.05)
TRACK_PROFILE = [                      # local (z, y), outer loop
    (-5.05, 0.64), (-3.90, 0.10), (3.90, 0.10), (5.05, 0.62),
    (4.95, 1.00), (3.30, 1.14), (-3.30, 1.14), (-4.90, 1.00),
]
TRACK_HALF_W = 0.50
FENDER       = ((-4.95, 5.00), 1.12, 0.10, 1.05)  # (zspan, ytop_base, h, width)
ROAD_WHEELS  = [-3.60 + i * 0.95 for i in range(8)]
WHEEL_R      = 0.42
WHEEL_CY     = 0.46                    # wheel centre height (track-local)

# forward engine block + stacks
ENGINE       = (0.0, 1.66, -3.40, 1.90, 0.68, 1.90)    # x,y,z, w,h,d
STACKS       = [(0.72, -2.65), (-0.72, -2.65)]         # (x, z) bases
STACK_TOP_Y  = 3.02

# rear deck furniture (model frame)
LOCKERS      = [(0.88, 1.57, 3.90), (-0.88, 1.57, 3.90)]
LOCKER_SIZE  = (0.50, 0.50, 1.30)
CRANE_BASE   = (-0.80, 1.30, 4.55)
CRANE_TOP_Y  = 2.75
CRANE_TIP    = (-0.08, 2.28, 3.35)
LIGHT_BOX    = (-0.80, 2.84, 4.55)     # amber deck work-light on crane mast
SPADES       = [0.58, -0.58]           # plate x centres (folded on rear plate)
SPADE_HW     = 0.42                    # half width
SPADE_TOP    = (1.15, 5.26)            # (y, z) top edge
SPADE_BOT    = (0.42, 5.62)            # (y, z) bottom edge

# pedestal gun mount (piece `turret`, yaws on the deck)
PED_Z        = 2.20
TURRET_OFF   = (0.0, 1.34, PED_Z)
PED_H        = 0.62
PED_R0, PED_R1 = 0.66, 0.52
CHEEKS       = [(0.40, 0.84, 0.05), (-0.40, 0.84, 0.05)]   # turret-local
CHEEK_SIZE   = (0.16, 0.58, 0.78)
TRAY         = (0.0, 0.56, 0.62, 0.72, 0.26, 0.52)         # x,y,z, w,h,d
SHIELD_X     = 1.10                    # half width
SHIELD_BOT   = (0.25, -0.62)           # (y, z) bottom edge, turret-local
SHIELD_TOP   = (1.55, -0.38)           # (y, z) top edge

# barrel (piece `barrel`, pivot at trunnion; rest elevation baked)
BARREL_OFF   = (0.0, 0.85, 0.0)        # turret-local trunnion
ELEV_DEG     = 17.0
_e = np.radians(ELEV_DEG)
DIR  = np.array([0.0, np.sin(_e), -np.cos(_e)])   # barrel-local bore axis
PERP = np.array([0.0, -np.cos(_e), -np.sin(_e)])  # "below the tube"
BREECH_BACK, BREECH_FWD = -1.20, 0.45
TUBE_A, TUBE_B          = 0.40, 7.25
BAFFLE1 = (7.25, 7.60)
BAFFLE2 = (7.68, 8.00)
BARREL_LEN = 8.00                       # muzzle empty at DIR * this
RECUP_A, RECUP_B, RECUP_DROP = 0.50, 2.80, 0.21
