"""ms_anc_archive_layout — zones + dims for ms_anc_archive.

ANCIENT REGISTER. Data archive / knowledge objective site, 22 m:
a sunken circular court on a monolithic 16-gon plinth, five LEANING
monolithic data-stacks rising from precise octagonal footings around
it, and a floating tilted `index` ring threading between them (very
slow seamless idle orbit about Y) carrying twelve index tablets.
Cyan glyph-line tracery runs the stack faces in horizontal rows —
library stacks of light. Nothing bolted, nothing patched: large
unbroken surfaces cut by clean recessed seams. Weathering is
geological (soil burial, dust drift, scorch), never mechanical.

Dominant dim 22 m -> ATLAS 2048. No team colour.
World frame: RH, -Z forward, +Y up, ground Y=0, 1 unit = 1 m.
"""
import numpy as np

import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

W = 2048

# ── planar zones ─────────────────────────────────────────────────────────
# sunken court floor (glyph rosette), altar cap — both centred on origin
R_COURT     = Zone((0, 0, 940, 940), ('x', 'z'), ((-7.1, 7.1), (-7.1, 7.1)))
R_ALTAR_TOP = Zone((952, 0, 1300, 348), ('x', 'z'), ((-1.4, 1.4), (-1.4, 1.4)))

# ── parametric wrap rects (u = around / along, v = across the band) ──────
# left column: the court body
W_SKIRT  = (0,  952, 940, 1000)   # buried soil skirt
W_PLINTH = (0, 1012, 940, 1180)   # outer plinth flank
W_CHAM   = (0, 1192, 940, 1236)   # outer top chamfer
W_SHELF  = (0, 1248, 940, 1400)   # walkway annulus (u around, v radial)
W_RIM    = (0, 1412, 940, 1456)   # inner rim chamfer
W_INNER  = (0, 1468, 940, 1600)   # inner court wall (faces the court)
W_FCHAM  = (0, 1612, 940, 1656)   # floor chamfer
W_PAD    = (0, 1668, 940, 1780)   # stack footing flank
W_ALTAR  = (0, 1792, 940, 1900)   # central altar flank
W_NODE   = (0, 1912, 940, 2000)   # floating data-node shards

# right column: caps + the tall stack wraps + the index ring
R_STKCAP = (1320,    0, 1540,  220)   # stack crown lens (parametric disc)
R_TABCAP = (1560,    0, 1700,  140)   # tablet cap
R_PADTOP = (1720,    0, 2000,  280)   # footing top ring
R_DARK   = (1320,  250, 1540,  340)   # unseen/dark filler
STACK_H  = 188                        # each stack wrap: 4 face bands
W_STACK  = [(952, 356 + 200 * i, 2048, 356 + 200 * i + STACK_H)
            for i in range(5)]
W_RING   = (952, 1376, 2048, 1728)    # 8 profile bands x 44 px
W_TABLET = (952, 1748, 2048, 1868)    # 4 face bands x 30 px

# ── court dims (world metres, ground Y=0) ───────────────────────────────
COURT_N     = 16          # 16-gon: a near-perfect ancient circle
COURT_RINGS = [           # (y, radius) bottom -> top, outer -> inner
    (-0.35, 10.30),       # buried skirt foot
    ( 0.00, 10.05),
    ( 1.30,  9.60),       # plinth crown
    ( 1.48,  9.32),       # outer chamfer
    ( 1.48,  7.62),       # walkway annulus inner edge
    ( 1.30,  7.44),       # inner rim chamfer
    ( 0.30,  7.26),       # inner wall foot
    ( 0.15,  7.04),       # floor chamfer
]
COURT_BANDS = [           # (ring_a, ring_b, rect, outward mode)
    (0, 1, W_SKIRT,  'radial'),
    (1, 2, W_PLINTH, 'radial'),
    (2, 3, W_CHAM,   'radial'),
    (3, 4, W_SHELF,  '+y'),
    (4, 5, W_RIM,    '-radial'),
    (5, 6, W_INNER,  '-radial'),
    (6, 7, W_FCHAM,  '-radial'),
]
FLOOR_Y = 0.15

# central altar (the objective interaction point)
ALTAR_N  = 8
ALTAR_R0, ALTAR_R1 = 1.62, 1.36
ALTAR_Y0, ALTAR_Y1 = FLOOR_Y, 1.10
# floating keystone shard above the altar
KEY_Y, KEY_R, KEY_H = 3.30, 0.42, 0.62

# ── the five data-stacks ────────────────────────────────────────────────
PAD_N   = 8               # precise octagonal footings
PAD_R0, PAD_R1 = 2.05, 1.78
PAD_Y0, PAD_Y1 = FLOOR_Y, 0.95

STACK_RING_R = 5.20        # footing/stack centres on this radius
# (theta_deg, top_y, lean_k, lean_phi_deg)
# lean_k = horizontal top drift per metre of rise; phi rotates the lean off
# pure-radial for the wrong-angle ancient read. +lean = tops converge.
STACKS = [
    (  90.0, 22.00, 0.098, -22.0),
    ( 162.0, 19.00, 0.086,  16.0),
    ( 234.0, 16.20, 0.104, -31.0),
    ( 306.0, 20.40, 0.079,  27.0),
    (  18.0, 13.80, 0.112,  -9.0),
]
STK_HW0, STK_HW1 = 1.44, 0.62   # half-width of the two broad (radial) faces
STK_HD0, STK_HD1 = 0.80, 0.37   # half-depth (narrow tangential faces)


def _seam(t, w=0.020, s=0.78):
    """Clean recessed seam at parameter t (no bolts, no patches)."""
    return [(t - w, 1.00), (t - w, s), (t + w, s), (t + w, 1.00)]


# five slab blocks cut by four recessed seams; (t, cross-section scale)
STK_SEAMS = (0.265, 0.475, 0.665, 0.840)
STK_STATIONS = ([(0.00, 1.00)]
                + [st for t in STK_SEAMS for st in _seam(t)]
                + [(1.00, 1.00)])
# floating data-node shard above each crown
NODE_GAP, NODE_R, NODE_H = 0.78, 0.44, 0.74

# ── the floating index ring (piece `index`) ─────────────────────────────
RING_Y     = 11.50         # piece pivot on the court axis
RING_PIVOT = (0.0, RING_Y, 0.0)
RING_R     = 6.30          # ring radius
RING_TILT  = np.radians(14.0)
RING_SEGS  = 24
RING_PW    = 0.16          # half-thickness, radial
RING_PT    = 0.42          # half-height, along the ring normal
RING_PWC   = RING_PW * 0.55
RING_PTC   = RING_PT * 0.62
# 8-point chamfered-rectangle profile in the (N, B) plane.
# edge 0 = OUTER face, edge 2 = +B face, edge 4 = INNER face.
RING_PROFILE = [
    ( RING_PW, -RING_PTC), ( RING_PW,  RING_PTC),
    ( RING_PWC, RING_PT),  (-RING_PWC, RING_PT),
    (-RING_PW,  RING_PTC), (-RING_PW, -RING_PTC),
    (-RING_PWC, -RING_PT), ( RING_PWC, -RING_PT),
]
# index tablets standing off the ring's +B face
TAB_EVERY = 2              # one per 2 ring stations -> 12 tablets
TAB_HW, TAB_HD, TAB_H = 0.17, 0.06, 0.78

IDLE_PERIOD = 150.0        # s per revolution — very slow orbit
