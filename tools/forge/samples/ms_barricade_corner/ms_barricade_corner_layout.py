"""ms_barricade_corner_layout — zones + dims for the 90° barricade corner.

Second of the three models the `ms_barricade_set` kit sheet was split into
(units-assets review 2026-09-10, task 2(c)) so town-planner §T3 can place a
corner AT a corner instead of stamping the whole 25 m kit sheet. Root offset
zeroed, per the kit layout's own instruction to integrators.

Two 4 m arms — one along +X facing -Z, one along +Z facing -X — around a
corner post with a watch platform. One `body` piece, Y=0, forward -Z,
1 unit = 1 m. Zone rects inherited from ms_barricade_set_layout.
"""
import meshlib
from meshlib import Zone

meshlib.ATLAS = 1024

# ── atlas zones (1024²) ─────────────────────────────────────────────────
WALL_F      = Zone((0,     0,  512,  224), ('x', 'y'), ((-4.35, 4.35), (3.35, -0.15)))
WALLZ_F     = Zone((0,   224,  512,  448), ('z', 'y'), ((-4.35, 4.35), (3.35, -0.15)))
WALL_TOP    = Zone((0,   448,  512,  496), ('x', 'z'), ((-4.35, 4.35), (-0.7, 0.7)))
WALLZ_TOP   = Zone((0,   496,  512,  544), ('z', 'x'), ((-4.35, 4.35), (-0.7, 0.7)))
EARTH       = Zone((0,   544,  512,  672), ('x', 'y'), ((-4.45, 4.45), (1.35, -0.1)))
EARTH_Z     = Zone((0,   672,  512,  800), ('z', 'y'), ((-4.45, 4.45), (1.35, -0.1)))
EARTH_TOP   = Zone((0,   800,  512,  896), ('x', 'z'), ((-4.45, 4.45), (-1.3, 1.3)))
EARTH_TOP_Z = Zone((0,   896,  512,  992), ('z', 'x'), ((-4.45, 4.45), (-1.3, 1.3)))
PYLON       = Zone((896,   0, 1024,  224), ('x', 'y'), ((-4.2, 4.2), (3.7, -0.1)))
PYLON_Z     = Zone((896, 224, 1024,  448), ('z', 'y'), ((-0.95, 0.95), (3.7, -0.1)))
TOPS        = Zone((512, 360,  640,  448), ('x', 'z'), ((-1.0, 1.0), (-1.0, 1.0)))
TRIM        = Zone((512, 448,  640,  512), ('x', 'y'), ((-45, 45), (25, -5)))
DARK        = Zone((640, 448,  768,  512), ('x', 'z'), ((-45, 45), (-45, 45)))

# ── construction dims (metres) ──────────────────────────────────────────
BERM_HB    = 1.15
BERM_HT    = 0.58
BERM_H     = 1.15
PLATE_T    = 0.18
PLATE_Y0   = 0.70
POST_H     = 2.95
POST_Z     = 0.30
BRACE_FOOT = 1.45

ARM_LEN      = 4.0
ARM_PLATES   = [(1.75, 1.9, 2.78, 0.05), (3.3, 1.35, 2.60, -0.04)]  # (c,w,top,off)
ARM_PLATES_Z = [(1.75, 1.9, 2.66, 0.05), (3.3, 1.35, 2.88, -0.04)]
CPOST_SIZE = (0.95, 3.15, 0.95)
CPLAT_SIZE = (1.55, 0.16, 1.55)
CPLAT_Y    = 3.32
MOUND_SIZE = (2.35, 1.05, 2.35)
# team band on the corner post, in PYLON/PYLON_Z world coords (y0, y1)
TEAM_BAND  = (2.95, 3.35)
