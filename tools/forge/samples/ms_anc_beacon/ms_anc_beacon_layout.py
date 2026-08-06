"""ms_anc_beacon_layout — zones + dims for ms_anc_beacon.

ANCIENT REGISTER. Summoning beacon, 26 m, articulated and purposeful
(vs the inert ms_monolith_spire). A monolithic stepped dais, part buried
in soil, carries a seamless tapering mast segmented only by clean
recessed seams. Four cantilevered vanes break the mast at mid-height and
four keystone blocks FLOAT unsupported above them. The upper third is an
unfolding petal array: a perfect-circle hub (`array` piece, slow seamless
idle rotation about Y) carrying six tapering blades (`petal1..petal6`)
that unfold ~30 deg outward about their hub-tangent hinges, each with an
emitter filament on its inner face. An intense CYAN lens crowns the axis
at 26 m. ACTIVE: the cyan flows, brightening upward toward the crown.
Guy-less — nothing is tethered, nothing is bolted, nothing is patched.
Dominant dim 26 m -> ATLAS 2048. No team colour.
World frame: RH, -Z forward, +Y up, ground Y=0.
"""
import numpy as np
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

W = 2048

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
# monolithic stepped dais; the lowest tier reads as soil-buried
DAIS = [
    # (cy, height, width, chamfer)
    (0.50, 1.00, 14.6, 0.26),
    (1.55, 1.10,  9.8, 0.20),
    (2.60, 0.80,  6.0, 0.16),
]
DAIS_TOP = 3.00

# mast: six seamless slab segments, minutely wrong-angled (ancient precision
# that is not quite our geometry).  (cx, cz, y0, y1, width)
SEGS = [
    ( 0.00,  0.00,  3.0,  6.4, 3.70),
    ( 0.04, -0.03,  6.4,  9.4, 3.60),
    (-0.03,  0.04,  9.4, 12.0, 3.10),
    ( 0.03, -0.02, 12.0, 14.2, 2.66),
    (-0.02,  0.03, 14.2, 16.2, 2.28),
    ( 0.00,  0.00, 16.2, 17.6, 1.98),
]
MAST_TOP = 17.6

# crown corbel — deliberately WIDER than the mast below it (cantilever)
CORBEL = (0.0, 18.10, 0.0, 3.30, 1.00, 3.30, 0.14)
CORBEL_TOP = 18.60

# base buttress wedges (4 @ 90 deg) — profile in (radius, y), extruded
# tangentially; a swept monolithic wedge, never a strut
BUTTRESS = [(1.72, 9.00), (1.72, 3.00), (3.15, 3.00)]
BUTTRESS_T = 0.50          # tangential thickness
BUTTRESS_N = 4

# mid-mast cantilever vanes (4 @ 45 deg offset) — flat planks projecting
# into thin air, holding nothing
VANE = [(1.40, 11.90), (4.60, 11.62), (4.60, 11.30), (1.40, 10.90)]
VANE_T = 0.70
VANE_N = 4
# floating keystones: unsupported blocks hovering over each vane tip
KEY_R = 4.20
KEY_Y = 12.95
KEY_SIZE = (0.92, 0.86, 0.74)   # (radial, vertical, tangential)

# ── the array (piece `array`, pivot on the mast axis at the corbel top) ──
ARRAY_PIVOT = (0.0, CORBEL_TOP, 0.0)
HUB_N = 12
HUB_RINGS = [(-0.12, 1.70), (0.30, 1.86), (0.84, 1.52)]   # (local y, radius)
COLUMN_N = 8
COLUMN = [(0.70, 0.50), (3.40, 0.42), (6.20, 0.34)]       # (local y, radius)
LENS_N = 8
LENS = [(6.20, 0.16), (6.70, 0.72), (7.10, 0.56), (7.40, 0.07)]
CROWN_Y = 26.0            # ARRAY_PIVOT.y + LENS[-1].y

# ── petals (pieces petal1..petal6, children of `array`) ──────────────────
PETAL_N = 6
PETAL_HINGE_R = 1.40
PETAL_HINGE_Y = 0.45      # array-local
PETAL_SECT = 8            # cross-section facets
PETAL_OPEN_DEG = 30.0
# stations: (inward offset along -radial, local y, half-width, half-thick).
# Negative offsets bulge OUTWARD: closed, the six blades read as a chalice
# with a bulged waist and six separated points, never a smooth nose cone.
PETAL = [
    ( 0.00, 0.00, 0.78, 0.32),
    (-0.10, 1.20, 0.88, 0.30),
    (-0.14, 2.60, 0.84, 0.24),
    ( 0.02, 4.00, 0.68, 0.18),
    ( 0.18, 5.20, 0.46, 0.12),
    ( 0.28, 6.20, 0.20, 0.05),
]
# emitter filament standing off each petal's inner face
FIL_STANDOFF = 0.34
FIL_N = 4
FIL = [(-0.06, 0.90, 0.090), (-0.10, 2.60, 0.078), (0.06, 4.30, 0.056),
       (0.22, 5.70, 0.028)]   # (inward offset, local y, radius)

PETAL_ANGLES = [2.0 * np.pi * i / PETAL_N for i in range(PETAL_N)]

# ── clips ────────────────────────────────────────────────────────────────
IDLE_PERIOD = 90.0        # s per array revolution (very slow, seamless)
# petal unfold cycle, as fractions of the clip period: shut -> wide -> wide
# -> shut.  Seamless (last key repeats the first).
OPEN_KEYS = (0.00, 0.20, 0.80, 1.00)
OPEN_PERIOD = 90.0        # used when the unfold ships as its own `open` clip

# ── atlas zones (2048^2; v down) ─────────────────────────────────────────
# dais
R_DAIS_TOP  = Zone((0,    0,    704,  704),  ('x', 'z'), ((-7.4, 7.4), (-7.4, 7.4)))
R_DAIS_SX   = Zone((0,    704,  704,  800),  ('x', 'y'), ((-7.4, 7.4), (3.10, -0.30)))
R_DAIS_SZ   = Zone((0,    704,  704,  800),  ('z', 'y'), ((-7.4, 7.4), (3.10, -0.30)))
# mast flanks: one tall zone per axis pair, full 0..19.2 m window
R_MAST_X    = Zone((704,  0,    1024, 2048), ('z', 'y'), ((-2.4, 2.4), (19.2, 0.0)))
R_MAST_Z    = Zone((1024, 0,    1344, 2048), ('x', 'y'), ((-2.4, 2.4), (19.2, 0.0)))
# segment shoulders / corbel top
R_SHELF     = Zone((0,    800,  448,  1248), ('x', 'z'), ((-2.4, 2.4), (-2.4, 2.4)))
# parametric wraps (RECTS, not Zones)
R_VANE      = (1344, 0,    1600, 192)
R_BUTT      = (1344, 192,  1600, 384)
R_KEY       = (1344, 384,  1600, 544)
R_HUB       = (1344, 544,  1600, 736)
R_PETAL     = (0,    1248, 704,  1760)
R_FIL       = (0,    1760, 704,  1888)
R_COLUMN    = (1600, 384,  1856, 512)
R_LENS      = (1600, 512,  1856, 768)
R_PETAL_CAP = (1600, 256,  1856, 384)
# cap zones
R_HUBCAP    = Zone((1600, 0,    1856, 256),  ('x', 'z'), ((-1.8, 1.8), (-1.8, 1.8)))
R_DARK      = Zone((1856, 0,    2048, 192),  ('x', 'z'), ((-1.0, 1.0), (-1.0, 1.0)))
# free plate reused for the buried soil skirt band
R_SOIL      = (448, 800, 704, 1248)
