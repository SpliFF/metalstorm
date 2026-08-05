"""ms_rail_platform_layout — zones + dims for ms_rail_platform.

Transport terminus: 24 x 12 m rail platform + single track spur, matched
to the fable_train gauge (rails centred TRACK_X +- 2.15 = train_layout
WHEEL_X; engine ~21 m / carriages 16 m fit the 24 m berth).  Striped
platform canopy on a rear colonnade, loading crane (yaw piece + hook),
buffer stop at the +Z track end, signal post with emissive lamps at the
-Z approach end.  World frame: forward -Z (trains arrive from -Z), up
+Y, ground Y=0, 1 u = 1 m.  Platform slab fills X -6..0; track ballast
fills X 0..6.  All static geometry lives on `body`; `crane` (yaw) and
`hook` (bob) animate in the idle clip; `berth` is an empty at the track
centreline for game-code train alignment.

NOTE for integrators: fable_train rests its wheels at Y=0; the 3D rail
head here tops out at RAIL_Y1 (0.36 m).  Spawn trains on the spur with a
+RAIL_Y1 Y offset (or sink the platform 0.36) so wheels sit on the rail.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
P_SIDE    = Zone((0,    0,    1024, 96),   ('z', 'y'), ((-12.2, 12.2), (1.25, -0.05)))
P_END     = Zone((1024, 0,    1344, 96),   ('x', 'y'), ((-6.2, 0.2), (1.25, -0.05)))
P_RAILT   = Zone((1344, 0,    1792, 64),   ('z', 'x'), ((-12.2, 12.2), (0.5, 5.5)))
P_TRIM    = Zone((1792, 0,    1920, 128),  ('z', 'y'), ((-45, 45), (25, -5)))
P_DARK    = Zone((1920, 0,    2048, 128),  ('x', 'z'), ((-45, 45), (-45, 45)))
P_LAMP    = Zone((1344, 64,   1600, 128),  ('x', 'y'), ((-45, 45), (25, -5)))
P_DECK    = Zone((0,    96,   1024, 432),  ('z', 'x'), ((-12.2, 12.2), (-6.2, 0.2)))
P_CAN_TOP = Zone((1024, 128,  1792, 432),  ('z', 'x'), ((-10.4, 4.8), (-6.3, 0.1)))
P_CAN_BOT = Zone((1024, 432,  1792, 560),  ('z', 'x'), ((-10.4, 4.8), (-6.3, 0.1)))
P_CAN_EDGE= Zone((1024, 560,  1792, 608),  ('z', 'y'), ((-10.4, 4.8), (5.85, 5.35)))
P_BAL     = Zone((0,    432,  1024, 624),  ('z', 'x'), ((-12.2, 12.2), (0.2, 6.2)))
P_BALS    = Zone((0,    624,  1024, 672),  ('z', 'y'), ((-12.2, 12.2), (0.45, -0.02)))
P_RAIL    = Zone((0,    672,  1024, 720),  ('z', 'y'), ((-12.2, 12.2), (0.45, -0.02)))
P_CRATE   = Zone((0,    720,  256,  976),  ('z', 'y'), ((-45, 45), (25, -5)))
P_KIOSK   = Zone((256,  720,  640,  976),  ('z', 'y'), ((-8.1, -5.1), (3.6, 0.9)))
P_CRANE   = Zone((1024, 608,  1536, 896),  ('x', 'y'), ((-2.0, 5.8), (5.0, -0.3)))
P_HOOK    = Zone((1536, 608,  1664, 896),  ('x', 'y'), ((-0.8, 0.8), (0.6, -3.2)))
P_BUFF    = Zone((1664, 608,  1920, 896),  ('x', 'y'), ((0.3, 5.7), (2.6, -0.1)))
P_SIGHEAD = Zone((1920, 128,  2048, 256),  ('x', 'y'), ((5.0, 6.1), (5.2, 3.5)))

# ── platform slab ────────────────────────────────────────────────────────
DECK_Y    = 1.1                            # platform coping height
SLAB      = (-3.0, DECK_Y / 2, 0.0, 6.0, DECK_Y, 24.0)   # x,y,z,w,h,d

# ── track spur (fable_train gauge) ───────────────────────────────────────
TRACK_X   = 3.0                            # spur centreline
GAUGE_X   = 2.15                           # = train_layout.WHEEL_X
RAIL_W    = 0.24
RAIL_Y0, RAIL_Y1 = 0.15, 0.36              # rail web bottom / head top
RAIL_Z0, RAIL_Z1 = -12.05, 11.0            # ends short of the buffer
BAL_TOP   = 0.15
BAL_XT0, BAL_XT1 = 0.45, 5.55              # ballast shoulder (top)
BAL_XB0, BAL_XB1 = 0.15, 5.85              # ballast toe (ground)
BAL_Z0, BAL_Z1 = -12.1, 11.9

# ── canopy (rear colonnade, cantilevered over the platform) ──────────────
COL_X     = -5.5
COLS      = [-9.4, -5.0, -0.6, 3.8]        # column z stations
COL_TOP   = 5.3
HEADER    = (COL_X, 5.42, -2.8, 0.32, 0.28, 14.6)
ROOF      = (-3.05, 5.62, -2.8, 5.7, 0.16, 14.8)
BRACE_TIP = (-0.9, 5.5)                    # x, y of brace landing

# ── loading crane (open yard, z 4.2..12) ─────────────────────────────────
PED       = (-2.2, 1.4, 7.6, 1.6, 0.6, 1.6)
CRANE_OFF = (-2.2, 1.7, 7.6)               # yaw pivot (piece offset)
JIB_LEN   = 5.6                            # local +X, reaches over the spur
HOOK_OFF  = (5.0, 3.75, 0.0)               # hook piece offset (crane-local)

# ── buffer stop (track end, +Z) ──────────────────────────────────────────
BUFF_Z    = 11.0                           # strut feet start
BUFF_BEAM = (TRACK_X, 1.35, 10.95, 4.7, 0.5, 0.35)   # beam at coupler height
BUFF_PLATE= (TRACK_X, 1.3, 10.68, 2.6, 0.9, 0.12)

# ── signal post (-Z approach, far side of the spur) ──────────────────────
SIG_X, SIG_Z = 5.55, -10.5
SIG_TOP   = 4.6
SIG_HEAD  = (SIG_X, 4.35, SIG_Z, 0.5, 1.1, 0.3)

# ── dressing ─────────────────────────────────────────────────────────────
KIOSK     = (-4.7, DECK_Y + 1.05, -6.6, 2.2, 2.1, 2.6)
LAMP_X    = -0.8
LAMPS_Z   = [5.6, 10.8]                    # yard lamp posts
LAMP_TOP  = 4.1
CRATES    = [(-4.6, 8.6, 1.0), (-3.5, 9.3, 0.8)]     # x, z, size
PALLET    = (-3.9, 7.4, 1.4, 0.12, 1.2)              # x, z, w, h, d
DRUM      = (-5.0, 10.0, 0.4, 1.1)                   # x, z, r, h
CABINET   = (4.9, -9.4, 0.7, 1.0, 0.5)               # x, z, w, h, d relay box
BERTH_OFF = (TRACK_X, 0.0, -0.5)           # train-alignment empty
