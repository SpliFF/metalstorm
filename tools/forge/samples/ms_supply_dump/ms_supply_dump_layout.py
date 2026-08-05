"""ms_supply_dump_layout — zones + dims for ms_supply_dump (staging-post kit).

10x10 m supply dump: dirt pad, crate stacks (wood + olive ammo), drum
clusters, fuel bladders, pallet rows, one draped tarp (`tarp` piece —
the only animated part, subtle idle flap).  Ground-clutter silhouette
variety is the read; everything is low, scattered, and rotated.
World frame: up +Y, forward -Z, ground Y=0, 1 unit = 1 m.  Budget 1200.

Cells are painted once and reused by every instance of that prop class
(cell_box maps each face onto the full cell; chamfered boxes get
per-item world-window Zones from gen's box_zones helper).
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas cells (1024²; v down; plain px rects) ─────────────────────────
PAD_T    = (0,   0,   384,  384)    # gravel/dirt pad top
PAD_S    = (0,   384, 384,  416)    # pad edge band
CRATE_S  = (384, 0,   576,  160)    # wood crate side
CRATE_T  = (576, 0,   768,  160)    # wood crate top
AMMO_S   = (384, 160, 576,  288)    # olive ammo-box side
AMMO_T   = (576, 160, 768,  288)    # olive ammo-box top
DRUM_W   = (768, 0,   1024, 160)    # drum side wrap (u around, v height)
DRUM_T   = (768, 160, 1024, 288)    # drum lid (x/z window per drum)
PALLET_S = (384, 288, 768,  320)    # pallet slat band
PALLET_T = (384, 320, 768,  416)    # pallet deck planks
TARP_TOP = (0,   416, 448,  800)    # tarp canvas top (piece-local x/z)
TARP_UND = (448, 416, 576,  544)    # tarp underside
BLAD_S   = (576, 416, 832,  544)    # fuel bladder flank
BLAD_T   = (576, 544, 832,  672)    # fuel bladder top
PIPE_W   = (832, 416, 1024, 544)    # pipe stack wrap
CONC_S   = (832, 544, 1024, 672)    # concrete barrier side
CONC_T   = (832, 672, 1024, 736)    # concrete barrier top
DARK     = (0,   960, 128,  1024)   # ground-contact / open-pipe dark

# generic dark zone for pipe bores etc.
Z_DARK = Zone(DARK, ('z', 'y'), ((-6.0, 6.0), (6.0, -6.0)))

# tarp zones are piece-local (tarp pivot frame)
Z_TARP_T = Zone(TARP_TOP, ('x', 'z'), ((-1.45, 1.45), (-1.15, 1.15)))
Z_TARP_U = Zone(TARP_UND, ('x', 'z'), ((-1.45, 1.45), (-1.15, 1.15)))

# ── dims (world metres, ground Y=0) ─────────────────────────────────────
PAD = (9.8, 0.06, 9.8)              # w, h, d, centred on origin
PAD_TOP_Y = 0.06

# wood crates: (cx, cy, cz, w, h, d, yaw_deg, chamfered)
WOOD_CRATES = [
    # stack A (under the tarp, SW)
    (-2.60, PAD_TOP_Y + 0.36, 2.60, 2.00, 0.72, 1.60,   0, False),
    (-2.75, PAD_TOP_Y + 1.04, 2.50, 1.35, 0.52, 1.15,   8, False),
    # stack B (SE)
    (3.55,  PAD_TOP_Y + 0.45, -2.30, 1.60, 0.90, 1.40,  0, True),
    (3.40,  PAD_TOP_Y + 1.20, -2.45, 1.05, 0.60, 0.95, 14, False),
    # stack C (NW)
    (-3.45, PAD_TOP_Y + 0.40, -1.50, 1.50, 0.80, 1.25,  0, True),
    (-3.30, PAD_TOP_Y + 1.07, -1.60, 0.95, 0.55, 0.90, -12, False),
    # loose singles
    (0.70,  PAD_TOP_Y + 0.33, -2.85, 1.10, 0.66, 1.00,  20, False),
    (-0.95, PAD_TOP_Y + 0.31, 0.90,  1.05, 0.62, 0.95, -15, False),
    (2.35,  PAD_TOP_Y + 0.30, -0.95, 1.00, 0.60, 0.90,  33, False),
    # on pallet 2
    (-2.50, PAD_TOP_Y + 0.14 + 0.34, -3.90, 1.15, 0.68, 1.00, 6, False),
]

# olive ammo boxes: (cx, cy, cz, w, h, d, yaw_deg)
AMMO_BOXES = [
    (-0.95, PAD_TOP_Y + 0.14 + 0.21, -4.05, 0.75, 0.42, 0.55,   0),
    (-0.45, PAD_TOP_Y + 0.14 + 0.21, -3.72, 0.75, 0.42, 0.55,  10),
    (-0.85, PAD_TOP_Y + 0.14 + 0.42 + 0.20, -3.98, 0.70, 0.40, 0.50, -6),
    (4.15,  PAD_TOP_Y + 0.24, -3.85, 0.80, 0.48, 0.60,  28),
    (2.90,  PAD_TOP_Y + 0.22, 3.90,  0.75, 0.44, 0.55, -18),
    (0.45,  PAD_TOP_Y + 0.21, -1.15, 0.75, 0.42, 0.55,  40),
]

# pallets: (cx, cz); shared size
PALLETS = [(-0.70, -3.90), (-2.50, -3.90), (-4.05, -3.90)]
PALLET_SIZE = (1.70, 0.14, 1.30)

# upright drums: (cx, cz, h); shared radius
DRUM_R = 0.32
DRUMS = [
    (3.50, 3.30, 0.95), (4.20, 3.45, 0.95),         # cluster 1 (2x2)
    (3.60, 4.05, 0.95), (4.25, 4.18, 0.95),
    (1.35, 4.10, 0.95), (2.05, 4.22, 0.95),         # cluster 2 (row + runts)
    (1.70, 3.52, 0.72), (2.75, 3.85, 0.95),
    (0.75, 3.72, 0.72),
]
# lying drum: (cx, cy, cz, half_len, r) — axis along X
DRUM_LYING = (0.35, PAD_TOP_Y + 0.30, 4.25, 0.45, 0.30)

# fuel bladders: (cx, cz, rx, rz, yaw_deg); profile (y, radius-factor)
BLADDERS = [(3.45, 0.55, 1.00, 1.55, 10), (1.35, 1.15, 0.90, 1.35, -14)]
BLAD_PROFILE = [(0.05, 1.00), (0.42, 0.94), (0.72, 0.58)]

# pipe stack: axis along X. (cy, cz) per pipe; shared half-len + r
PIPE_HL, PIPE_R = 1.20, 0.155
PIPE_CX = -0.40
PIPES = [(PAD_TOP_Y + PIPE_R, -1.55), (PAD_TOP_Y + PIPE_R, -1.87),
         (PAD_TOP_Y + 2 * PIPE_R + 0.13, -1.71)]

# concrete barrier blocks: (cx, cy, cz, w, h, d)
CONC_BLOCKS = [(-4.35, PAD_TOP_Y + 0.35, 0.60, 1.00, 0.70, 1.80),
               (4.40,  PAD_TOP_Y + 0.35, -0.90, 1.00, 0.70, 1.80)]

# ── tarp (piece-local frame; pivot above stack A) ───────────────────────
TARP_OFF = (-2.60, 1.42, 2.55)
# cross-section profile (x, y) hem→ridge→hem; drape baked per station
TARP_PROFILE = [(-1.35, -1.00), (-0.72, -0.04), (0.72, -0.01), (1.35, -0.95)]
TARP_STATIONS = [-1.08, -0.38, 0.36, 1.08]          # local z
# per-station (ridge_sag, hem_lift_l, hem_lift_r) cloth irregularity
TARP_JITTER = [(0.00, 0.06, -0.03), (-0.05, -0.02, 0.02),
               (-0.03, 0.03, -0.04), (0.01, -0.05, 0.05)]

# idle flap: amplitude (deg) and period (s)
TARP_FLAP_DEG = 1.3
TARP_FLAP_T = 4.8
