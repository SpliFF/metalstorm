"""ms_barricade_wall_layout — zones + dims for the 8 m barricade wall segment.

One of the three models the `ms_barricade_set` kit sheet was split into
(units-assets review 2026-09-10, task 2(c)): the kit shipped its three
elements as root pieces fanned out along X, which the client can only render
all at once, so town-planner §T3 (wall runs, corners at corners, gate on the
main street) could not place them individually. This model is the WALL
element alone, root offset zeroed as the kit layout's own docstring told
integrators to do.

8 m scrap-plate wall segment on an earthwork berm, one `body` piece, on
Y=0, forward -Z, 1 unit = 1 m (gltf_export converts to elmos at write time).
Zone rects are inherited unchanged from ms_barricade_set_layout so the three
split models keep one texture language; zones the wall does not use are gone.
"""
import meshlib
from meshlib import Zone

meshlib.ATLAS = 1024

# ── atlas zones (1024²) ─────────────────────────────────────────────────
WALL_F    = Zone((0,     0,  512,  224), ('x', 'y'), ((-4.35, 4.35), (3.35, -0.15)))
WALL_TOP  = Zone((0,   448,  512,  496), ('x', 'z'), ((-4.35, 4.35), (-0.7, 0.7)))
EARTH     = Zone((0,   544,  512,  672), ('x', 'y'), ((-4.45, 4.45), (1.35, -0.1)))
EARTH_Z   = Zone((0,   672,  512,  800), ('z', 'y'), ((-4.45, 4.45), (1.35, -0.1)))
EARTH_TOP = Zone((0,   800,  512,  896), ('x', 'z'), ((-4.45, 4.45), (-1.3, 1.3)))
SAND      = Zone((640, 360,  896,  448), ('x', 'y'), ((-45, 45), (25, -5)))
TRIM      = Zone((512, 448,  640,  512), ('x', 'y'), ((-45, 45), (25, -5)))

# ── construction dims (metres) ──────────────────────────────────────────
SEG_HALF   = 4.0          # wall segment: 8 m along X
BERM_HB    = 1.15         # earth berm half-width at ground
BERM_HT    = 0.58         # earth berm half-width at crest
BERM_H     = 1.15         # earth berm height
PLATE_T    = 0.18         # scrap plate thickness
PLATE_Y0   = 0.70         # plates bedded into the berm crest
POST_H     = 2.95
POST_Z     = 0.30         # posts run up the back (+Z) of the plates
BRACE_FOOT = 1.45         # rear diagonal braces: foot z

# (cx, width, top_y, z_offset) per scrap plate
WALL_PLATES = [(-3.0, 1.95, 2.72, 0.05), (-1.0, 1.95, 2.94, -0.04),
               (1.0, 1.95, 2.62, 0.06), (3.0, 1.95, 2.86, -0.05)]
WALL_POSTS  = [-3.95, -2.0, 0.0, 2.0, 3.95]
WALL_BRACES = [-2.6, 0.6, 3.2]
# sandbag row on the front toe: (cx, cz, length)
WALL_BAGS   = [(-2.1, -1.35, 2.5), (1.9, -1.30, 2.1)]
# team ID patch on the wall face, in WALL_F world coords (a0, b0, a1, b1)
TEAM_PATCH  = (2.45, 2.15, 3.25, 2.6)
