"""ms_timber_yard_layout — zones + dims for ms_timber_yard (named resource site).

12x12 m timber yard: dirt pad, bark-log stacks (pyramids + loose logs),
open-sided saw shed with a circular `blade` piece (idle spin clip, hub
paint N-fold symmetric), a log crane (mast + jib + cable + hook), cut
lumber stacks, lean planks and sawdust piles.  Weathered industrial
timber register; map prop, NO team colour, no emissive.
World frame: up +Y, forward -Z, ground Y=0, 1 unit = 1 m.  Budget 1500.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas cells (1024²; v down; plain px rects) ─────────────────────────
PAD_T    = (0,   0,   384,  384)    # dirt/sawdust-strewn pad top
PAD_S    = (0,   384, 384,  416)    # pad edge band
LOG_W    = (384, 0,   768,  96)     # bark wrap (u = length, v = around)
LOG_E    = (768, 0,   864,  96)     # end grain (growth rings)
POST_W   = (864, 0,   1024, 96)     # shed post / timber beam wrap
LUMBER_S = (384, 96,  640,  192)    # cut-lumber stack side (boards+stickers)
LUMBER_T = (640, 96,  896,  192)    # cut-lumber stack top
CABLE_W  = (896, 96,  960,  192)    # crane cable wrap (dark steel rope)
BENCH_S  = (384, 192, 640,  256)    # saw bench side
BENCH_T  = (640, 192, 896,  256)    # saw bench top (with cut slot)
BLADE_C  = (384, 256, 576,  448)    # circular blade disk (both faces)
ARBOR_W  = (576, 256, 640,  320)    # blade arbor / axle wrap
MAST_W   = (640, 256, 832,  320)    # crane mast wrap (riveted steel)
JIB_W    = (640, 320, 832,  384)    # crane jib wrap
HOOK_C   = (576, 320, 640,  384)    # hook block cell
CONC_C   = (640, 384, 832,  448)    # concrete footing cell
SAWDUST  = (384, 448, 576,  640)    # sawdust pile (pale shavings)
ROOF_T   = (0,   416, 384,  640)    # corrugated roof top — LOW CONTRAST
ROOF_U   = (0,   640, 384,  704)    # roof underside
DARK     = (0,   960, 128,  1024)   # generic dark / ground-contact

Z_DARK = Zone(DARK, ('z', 'y'), ((-7.0, 7.0), (7.0, -7.0)))

# ── dims (world metres, ground Y=0) ─────────────────────────────────────
PAD = (11.8, 0.06, 11.8)            # w, h, d, centred on origin
PAD_TOP_Y = 0.06

LOG_R = 0.27                        # bark log radius
LOG_N = 6                           # n-gon logs

# log stacks: (cx, cz, yaw_deg, half_len, rows) — pyramid, bottom row
# 'rows' logs, one fewer per row above.
LOG_STACKS = [
    (-3.55,  3.30,   4, 2.30, 4),   # big stack SW
    (-3.70, -0.90,  -7, 1.90, 3),   # stack W
]
# loose logs: (cx, cz, yaw_deg, half_len)
LOOSE_LOGS = [
    (-1.10,  4.55,  24, 1.80),
    ( 0.60,  3.85, -12, 1.55),
]

# ── saw shed (open-sided, mono-pitch roof), east side ───────────────────
SHED_CX, SHED_CZ = 2.60, -0.40
SHED_W, SHED_D = 4.6, 3.6           # x span, z span (post grid)
POST_S = 0.16                       # square post side
POST_H_HI, POST_H_LO = 3.2, 2.6     # front (-z) high, back (+z) low
ROOF_TH = 0.10
ROOF_OVER = 0.45                    # roof overhang

# saw bench runs along X through the shed
BENCH_C = (SHED_CX, 0.0, SHED_CZ + 0.15)
BENCH_SIZE = (4.2, 0.78, 0.95)      # top at PAD_TOP_Y + 0.78
BENCH_LOG = (SHED_CX - 1.15, SHED_CZ + 0.15, 1.30)  # cx, cz, half_len

# circular blade: plane parallel to the X feed → disk in local X-Y plane,
# spin axis +Z.  Piece-local, centred on origin.
BLADE_R = 0.55
BLADE_TH = 0.03
BLADE_N = 16
BLADE_OFF = (SHED_CX + 0.55, PAD_TOP_Y + BENCH_SIZE[1] + 0.10,
             SHED_CZ + 0.15)
BLADE_SPIN_T = 0.9                  # seconds per revolution

# ── log crane (centre-north) ────────────────────────────────────────────
CRANE_BASE = (0.90, 1.60)           # footing centre (x, z)
CRANE_FOOT = (1.10, 0.55, 1.10)     # footing box size
MAST_H = 4.6
MAST_R = 0.14
JIB_LEN = 3.4                       # reach toward -x (over the log stacks)
JIB_R = 0.10
JIB_Y = 4.25                        # jib root height on mast
CABLE_R = 0.022
CABLE_DROP = 2.30                   # jib tip down to hook block
HOOK_SIZE = (0.22, 0.34, 0.14)

# ── cut lumber stacks: (cx, cz, yaw, w, h, d) banded board texture ──────
LUMBER_STACKS = [
    (4.55,  2.90,   6, 1.30, 0.95, 2.40),
    (4.35,  0.35,  -4, 1.10, 0.70, 2.10),
    (2.20,  3.45,  14, 1.00, 0.55, 1.90),
]

# ── sawdust piles: (cx, cz, r, h) 8-gon cones ───────────────────────────
SAWDUST_PILES = [
    (2.05, -2.55, 0.95, 0.55),
    (3.30, -2.85, 0.70, 0.42),
    (1.15, -1.30, 0.50, 0.30),
]
