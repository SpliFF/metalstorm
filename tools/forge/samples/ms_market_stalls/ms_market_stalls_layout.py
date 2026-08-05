"""ms_market_stalls_layout — zones + dims for ms_market_stalls.

Civilian market cluster (8x8 m): five timber stalls at differing heights
(2.2-3.0 m), crate tables, hanging goods, warm string lights, and ONE
`awning` piece carrying all five canvas canopies (subtle idle flap).
Map prop, --no-team.  World frame: +Y up, -Z forward, ground Y=0.
Budget 1200 tris.  Seed 90210.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas cells (1024², v down, plain px rects) ─────────────────────────
PAD_T    = (0,   0,   384, 384)     # trampled dirt/cobble plaza top
PAD_S    = (0,   384, 384, 416)     # pad edge band
POST_S   = (384, 0,   448, 256)     # weathered timber post (vertical grain)
POST_T   = (448, 0,   512, 64)      # post end grain
BEAM_S   = (448, 64,  512, 256)     # cross-beam / rail timber
CRATE_S  = (512, 0,   704, 160)     # wood crate side
CRATE_T  = (704, 0,   896, 160)     # wood crate top
COUNT_S  = (512, 160, 704, 288)     # counter/table plank front
COUNT_T  = (704, 160, 896, 288)     # counter top (produce spill painted on)
BACK_C   = (896, 0,   1024, 256)    # canvas back-wall (both sides)
# four faded mismatched awning canvases (top faces; underside shared)
AWN_A    = (0,   416, 256, 608)     # faded terracotta stripes
AWN_B    = (256, 416, 512, 608)     # washed-out teal
AWN_C    = (0,   608, 256, 800)     # sun-bleached mustard stripes
AWN_D    = (256, 608, 512, 800)     # patched off-white/grey
AWN_U    = (512, 416, 640, 544)     # awning underside (shadowed canvas)
GOODS    = (640, 416, 768, 544)     # hanging goods bundle (sacks/produce)
GOODS2   = (768, 416, 896, 544)     # hanging goods bundle 2 (cloth rolls)
LIGHT    = (896, 416, 960, 480)     # string-light bulb (warm emissive)
WIRE     = (960, 416, 1024, 448)    # light wire / lashing (dark)
DARK     = (0,   960, 128, 1024)    # ground contact / shadow

Z_DARK = Zone(DARK, ('x', 'y'), ((-5.0, 5.0), (5.0, -5.0)))

# ── dims (metres, ground Y=0) ───────────────────────────────────────────
PAD = (8.0, 0.05, 8.0)
PAD_TOP_Y = 0.05

POST = 0.12                          # square post section
BEAM = 0.10                          # crossbeam section

# stalls: (cx, cz, w, d, h_front, h_back, yaw_deg, awning_cell_key)
# awning slopes down from back (high, -z local) to front (+z local).
STALLS = [
    (-2.30,  2.30, 2.6, 1.9, 2.20, 2.60,   6, 'A'),   # SW
    ( 2.25,  2.20, 2.4, 1.8, 2.45, 2.95,  -8, 'B'),   # SE (tallest)
    (-2.45, -1.90, 2.3, 1.8, 2.05, 2.45,  -4, 'C'),   # NW (lowest)
    ( 2.35, -2.15, 2.5, 1.9, 2.30, 2.75,  10, 'D'),   # NE
    ( 0.05, -0.05, 2.2, 1.7, 2.15, 2.55, -38, 'A'),   # centre, skewed
]
COUNTER_H = 0.85                     # table top height
COUNTER_D_F = 0.55                   # counter depth fraction of stall depth

# awning piece pivot (shared; canopies authored local to this)
AWN_OFF = (0.0, 2.45, 0.0)
AWN_OVERHANG = 0.35                  # front overhang past posts
AWN_SAG = 0.10                       # mid-span sag
VALANCE = 0.22                       # front hem strip drop

# loose crates: (cx, y_base, cz, w, h, d, yaw)
CRATES = [
    (-3.20, 0.0,  0.55, 0.80, 0.55, 0.70,  14),
    (-3.05, 0.55, 0.62, 0.60, 0.42, 0.55, -10),
    ( 3.35, 0.0,  0.30, 0.75, 0.50, 0.65, -22),
    ( 0.95, 0.0,  3.30, 0.70, 0.48, 0.60,  30),
    ( 1.15, 0.0, -3.35, 0.85, 0.55, 0.70,  -6),
    ( 1.30, 0.55, -3.25, 0.55, 0.40, 0.50,  18),
    (-1.05, 0.0, -3.30, 0.65, 0.45, 0.55,  42),
    (-0.65, 0.0,  3.45, 0.72, 0.50, 0.62, -16),
]

# hanging goods: (cx, y_top, cz, w, h, d, yaw, cell#) — hang from beams
GOODS_HANG = [
    (-1.55,  1.95,  1.85, 0.28, 0.45, 0.24,  10, 1),
    (-2.30,  1.95,  1.75, 0.24, 0.55, 0.22, -15, 2),
    (-3.00,  1.95,  1.95, 0.26, 0.40, 0.24,  25, 1),
    ( 1.60,  2.15,  1.75, 0.26, 0.50, 0.24,  -8, 2),
    ( 2.90,  2.15,  1.85, 0.24, 0.42, 0.22,  18, 1),
    ( 1.75,  2.00, -1.95, 0.28, 0.48, 0.24, -20, 2),
    (-2.95,  1.80, -1.55, 0.24, 0.44, 0.22,  12, 1),
]

# string lights: sagging wire runs between stalls, bulbs along.
# ((x0,y0,z0), (x1,y1,z1), sag, n_bulbs)
LIGHT_RUNS = [
    ((-2.30, 2.55,  1.35), ( 2.25, 2.90,  1.30), 0.35, 6),
    (( 2.35, 2.70, -1.20), (-2.45, 2.40, -1.00), 0.32, 6),
    ((-1.20, 2.50,  1.60), (-1.05, 2.45, -0.95), 0.28, 4),
]
BULB_R = 0.055

# idle flap: amplitude (deg) / period (s)
FLAP_DEG = 1.4
FLAP_T = 5.2
