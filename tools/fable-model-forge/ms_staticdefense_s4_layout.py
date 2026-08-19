"""ms_staticdefense_s4_layout — zones + dims for ms_staticdefense_s4.

THE bastion gun ('Defense Battery'): fortress howitzer emplacement, 8 m to
the aerial tip, ~6x6 m footprint (structure inside +/-3 m x/z). Stepped
battered concrete bastion (base tier + mid tier + octagonal barbette),
corner buttresses, armoured ammo-lift housing with blast doors, access
ladder, sandbag revetment, crate stowage, amber warning beacons. Aimable
chains: turret->barrel->muzzle (MS_HOWITZER_S4 fortress howitzer, ~4.95 m
tube with recoil sleeve + multi-baffle brake) and turret2->turret2_barrel->
turret2_muzzle (MS_FLAK_S2 twin flak on a low corner bastion drum).
World frame: guns face -Z at rest, up +Y, ground Y=0. 1024^2 atlas.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ---- dims (world metres, ground Y=0) ------------------------------------
BASE   = (0.0, 0.70, 0.0, 5.8, 1.40, 5.8)     # base tier: y 0..1.4
BASE_TOP = 1.40
MID    = (-0.30, 2.10, -0.30, 4.8, 1.40, 4.8)  # mid tier: y 1.4..2.8
MID_TOP = 2.80
BARB_C = (-0.30, -0.30)                        # barbette centre (x, z)
BARB_R0, BARB_R1 = 2.15, 1.90                  # octagon radii bottom/top
BARB_Y0, BARB_Y1 = 2.80, 4.10                  # barbette band
HOUSE  = (2.35, 2.35, -0.90, 1.10, 1.90, 1.60) # ammo-lift housing y 1.4..3.3
HOUSE_TOP = 3.30
LADDER_Z = -2.94                               # front face access ladder
LADDER_X = 1.60
ANT_BASE = (-2.30, MID_TOP, 1.70)              # aerial on mid-tier rear corner
ANT_TOP  = 8.00                                # dominant dim: 8 m
SAND_A, SAND_B = (-2.70, 0.0, -1.7), (-2.70, 0.0, 1.7)   # sandbag revetment
CRATES = (1.75, 0.0, -2.20)                    # stowage near the ladder
LOCKER1 = (0.95, 0.35, 2.55)                   # ready-ammo lockers (flak)
LOCKER2 = (-0.15, 0.35, 2.55)
LOCKER_SZ = (0.95, 0.70, 0.60)

# main turret ------------------------------------------------------------
TUR_OFF   = (BARB_C[0], BARB_Y1, BARB_C[1])    # yaw pivot on the barbette
TUR_R0, TUR_R1 = 2.00, 1.50                    # gunhouse octagon radii
TUR_H     = 1.50                               # gunhouse height (turret-local)
MANT      = (0.0, 0.85, -1.80, 1.60, 1.05, 0.80)   # mantlet block (local)
BUSTLE    = (0.0, 0.75, 1.55, 2.10, 0.95, 0.90)    # rear bustle (local)
CUPOLA    = (0.85, TUR_H + 0.14, 0.55, 0.62, 0.30, 0.62)
BAR_OFF   = (0.0, 0.85, -1.25)                 # barrel pivot in turret frame
BAR_LEN   = 4.95                               # pivot -> muzzle tip
MUZ_OFF   = (0.0, 0.0, -BAR_LEN)               # muzzle empty in barrel frame

# flak bastion (turret2) ---------------------------------------------------
FDRUM_C   = (2.08, 2.08)                       # corner bastion drum (x, z)
FDRUM_R   = 0.90
FDRUM_TOP = 2.85
T2_OFF    = (FDRUM_C[0], FDRUM_TOP, FDRUM_C[1])
T2_LEN    = 1.50

BEACON1 = (2.62, HOUSE_TOP + 0.07, -0.55)      # ammo-house roof beacon
BEACON2 = (-2.05, BARB_Y1 + 0.07, -1.85)       # barbette rim beacon

# ---- atlas zones (1024^2; v down) ---------------------------------------
R_BASE_S  = Zone((0, 0, 512, 168),   ('x', 'y'), ((-3.0, 3.0), (1.55, -0.05)))
R_BASE_SF = Zone((0, 0, 512, 168),   ('z', 'y'), ((-3.0, 3.0), (1.55, -0.05)))
R_MID_S   = Zone((0, 168, 512, 320), ('x', 'y'), ((-2.85, 2.35), (2.95, 1.30)))
R_MID_SF  = Zone((0, 168, 512, 320), ('z', 'y'), ((-2.85, 2.35), (2.95, 1.30)))
R_TUR     = Zone((512, 0, 896, 320), ('x', 'y'), ((-2.15, 2.15), (1.65, -0.10)))
R_TUR_F   = Zone((512, 0, 896, 320), ('z', 'y'), ((-2.15, 2.15), (1.65, -0.10)))
R_MANT    = Zone((896, 0, 1024, 160), ('x', 'y'), ((-0.90, 0.90), (1.48, 0.22)))
R_TUR_T   = Zone((896, 160, 1024, 288), ('x', 'z'), ((-1.65, 1.65), (-1.65, 1.65)))
R_BASE_T  = Zone((0, 336, 384, 720), ('x', 'z'), ((-3.0, 3.0), (-3.0, 3.0)))
R_BARB_T  = Zone((384, 336, 768, 720), ('x', 'z'), ((-2.45, 1.85), (-2.45, 1.85)))
R_BARB    = Zone((768, 320, 1024, 448), ('x', 'y'), ((-2.5, 2.5), (4.20, 2.72)))
R_MID_T   = Zone((768, 448, 1024, 576), ('x', 'z'), ((-2.75, 2.15), (-2.75, 2.15)))
R_HOUSE   = Zone((0, 720, 256, 848),  ('z', 'y'), ((-1.80, 0.00), (3.38, 1.35)))
R_HOUSE_F = Zone((0, 720, 256, 848),  ('x', 'y'), ((1.70, 3.00), (3.38, 1.35)))
R_DRUM    = Zone((256, 720, 448, 848), ('x', 'y'), ((1.0, 3.2), (2.92, -0.05)))
R_DRUM_F  = Zone((256, 720, 448, 848), ('z', 'y'), ((1.0, 3.2), (2.92, -0.05)))
R_DRUM_T  = Zone((640, 576, 768, 704), ('x', 'z'), ((1.05, 3.11), (1.05, 3.11)))
R_FLAK    = Zone((448, 720, 640, 848), ('x', 'y'), ((-0.95, 0.95), (0.95, -0.10)))
R_SAND    = Zone((0, 848, 192, 1024), ('z', 'y'), ((-1.2, 1.2), (1.3, -0.05)))
R_CRATE   = Zone((192, 848, 320, 1024), ('x', 'y'), ((-0.45, 0.45), (0.85, -0.05)))
R_BEACON  = Zone((832, 848, 896, 1024), ('x', 'y'), ((-0.12, 0.12), (0.20, -0.04)))
R_DARK    = Zone((896, 848, 1024, 1024), ('x', 'z'), ((-30, 30), (-30, 30)))
R_TRIM    = (320, 848, 448, 1024)     # rects: ladder/aerial/buttress/yoke wrap
R_SLEEVE  = (448, 848, 576, 1024)     # recoil sleeve wrap
R_GUN     = (576, 848, 704, 1024)     # main tube wrap
R_BRAKE   = (704, 848, 832, 1024)     # muzzle-brake wrap
R_FLAKB   = (640, 720, 704, 848)      # flak tube wrap
