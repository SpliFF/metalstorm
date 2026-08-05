"""ms_train_wreck_layout — zones + dims for ms_train_wreck (wreck set).

Derailed fable_train cargo car tipped off a torn-up track section,
spilled crates, buckled plates, scorch.  Static map prop, no clips,
no team colour.  Car dims/gauge follow $TOOLKIT/train_layout.py
(hull 4.2 wide, car half-len 8.0, bed 2.0, walls 3.25, 8-gon wheels
r 1.05 at x ±2.15 → rail gauge 4.3 centre-to-centre).
World frame: up +Y, forward -Z, ground Y=0, 1 unit = 1 m.
Dominant dim ~19 m → 2048 atlas.  Budget 1800.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas cells (2048²; v down; plain px rects) ─────────────────────────
HULL_S   = (0,    0,    1024, 288)   # car hull/wall side (oxide steel)
HULL_E   = (1024, 0,    1408, 288)   # car end wall
HULL_T   = (1408, 0,    2048, 224)   # car deck / bed planks
WHEEL_W  = (0,    288,  256,  416)   # wheel tread wrap
HUB      = (256,  288,  512,  416)   # wheel face / hub
COUP     = (512,  288,  768,  416)   # coupler steel
UNDER    = (768,  288,  1024, 416)   # underframe dark steel
RAIL_S   = (1024, 288,  1536, 352)   # rail web/head band
SLEEP_T  = (1024, 352,  1536, 416)   # sleeper timber
BAL_T    = (0,    416,  768,  832)   # ballast gravel top
BAL_S    = (0,    832,  768,  896)   # ballast shoulder band
CRATE_S  = (768,  416,  960,  576)   # wood crate side
CRATE_T  = (960,  416,  1152, 576)   # wood crate top
PLATE    = (1152, 416,  1408, 576)   # buckled/torn hull plate
DARK     = (1408, 416,  1536, 544)   # bores / shadow boxes

# generic Zones for prefab calls (planar windows over the scatter area)
Z_DARK  = Zone(DARK, ('z', 'y'), ((-10.0, 10.0), (10.0, -10.0)))
Z_CRATE = Zone(CRATE_T, ('x', 'z'), ((5.0, 9.5), (0.5, 6.5)))

# ── track section (along Z at x=0) ──────────────────────────────────────
TRACK_L   = 19.0                     # ballast length
BAL_W     = 6.4                      # ballast width
BAL_H     = 0.28
SLEEP_SZ  = (5.4, 0.16, 0.42)        # sleeper w, h, d
SLEEP_Z0  = -8.8
SLEEP_DZ  = 1.35
N_SLEEP   = 14
RAIL_X    = 2.15                     # gauge from train_layout WHEEL_X
RAIL_SZ   = (0.16, 0.24)             # rail w, h
# torn gap in the rails (z range where straight rails stop)
TEAR_Z0, TEAR_Z1 = 0.6, 6.4

# ── car pose (derailed, tipped onto its side beside the track) ──────────
CAR_YAW   = 22.0                     # deg about +Y vs track
CAR_ROLL  = 78.0                     # deg about local forward (tipped)
CAR_PITCH = 4.0
CAR_POS   = (4.9, 2.3)               # world x/z; y solved to rest on ground

# ── car dims (from $TOOLKIT/train_layout.py) ────────────────────────────
HULL_W    = 4.2
HULL_BOT  = 1.0
CAR_HL    = 8.0
CARGO_BED = 2.0
CARGO_WALL = 3.25
WHEEL_R   = 1.05
WHEEL_HW  = 0.40
WHEEL_X   = 2.15
LINK_Y    = 1.35
CAR_AXLES = [-5.8, -2.0, 2.0, 5.8]

# ── spilled cargo / debris ──────────────────────────────────────────────
CRATE_STACK_ORIGIN = (7.6, 0.0, 4.9) # toppled stack beside the open top
# loose crates: (cx, cz, size, yaw_deg, roll_deg)
LOOSE_CRATES = [(6.3, -0.9, 1.1, 34, 0), (8.9, 2.6, 0.95, -21, 24),
                (5.0, 6.9, 1.0, 63, 0)]
# buckled plates: (cx, cy, cz, w, d, yaw, pitch, roll) — thin torn slabs
PLATES = [(2.1, 0.10, -1.6, 1.7, 1.1, 30, 8, 74),
          (3.1, 0.35, 7.4, 1.4, 1.0, -50, 26, 12),
          (1.2, 0.06, 4.9, 1.9, 1.2, 12, 4, -10),
          (7.2, 0.08, -2.3, 1.3, 0.9, -70, 6, 8)]
