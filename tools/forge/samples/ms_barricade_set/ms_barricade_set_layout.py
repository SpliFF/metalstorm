"""ms_barricade_set_layout — zones + dims for the staging-post barricade kit.

THREE elements as separate root pieces in ONE glTF (ms_barricade_set):
  wall       — 8 m scrap-plate wall segment on an earthwork berm
  corner     — 90° corner: two 4 m arms (+X facing -Z, +Z facing -X) around
               a corner post with a watch platform
  gate_frame — 8 m gateway: two pylons + hazard lintel; child piece `gate`
               (5.1 m scrap leaf, hinge at the -X pylon, clip `open` swings
               it inward through ~104°)
All three share one 1024² texture set (dominant dim 8 m < 15 m).
Elements sit on Y=0, forward -Z, 1 unit = 1 m.  Root offsets fan the kit
out along X purely so pieces don't z-fight when the whole model renders;
integrators placing single pieces should zero the root offset.
"""
from meshlib import Zone

# ── atlas zones (1024²) ─────────────────────────────────────────────────
# wall runs along X (front faces ±Z)
WALL_F    = Zone((0,     0,  512,  224), ('x', 'y'), ((-4.35, 4.35), (3.35, -0.15)))
# wall runs along Z (corner Z-arm, front faces ±X)
WALLZ_F   = Zone((0,   224,  512,  448), ('z', 'y'), ((-4.35, 4.35), (3.35, -0.15)))
WALL_TOP  = Zone((0,   448,  512,  496), ('x', 'z'), ((-4.35, 4.35), (-0.7, 0.7)))
WALLZ_TOP = Zone((0,   496,  512,  544), ('z', 'x'), ((-4.35, 4.35), (-0.7, 0.7)))
EARTH     = Zone((0,   544,  512,  672), ('x', 'y'), ((-4.45, 4.45), (1.35, -0.1)))
EARTH_Z   = Zone((0,   672,  512,  800), ('z', 'y'), ((-4.45, 4.45), (1.35, -0.1)))
EARTH_TOP = Zone((0,   800,  512,  896), ('x', 'z'), ((-4.45, 4.45), (-1.3, 1.3)))
EARTH_TOP_Z = Zone((0, 896,  512,  992), ('z', 'x'), ((-4.45, 4.45), (-1.3, 1.3)))
GATE_LEAF = Zone((512,   0,  896,  224), ('x', 'y'), ((-0.1, 5.3), (2.95, -0.05)))
PYLON     = Zone((896,   0, 1024,  224), ('x', 'y'), ((-4.2, 4.2), (3.7, -0.1)))
PYLON_Z   = Zone((896, 224, 1024,  448), ('z', 'y'), ((-0.95, 0.95), (3.7, -0.1)))
LINTEL    = Zone((512, 224,  896,  300), ('x', 'y'), ((-3.3, 3.3), (3.75, 2.95)))
LINTEL_TOP= Zone((512, 300,  896,  360), ('x', 'z'), ((-3.3, 3.3), (-0.4, 0.4)))
TOPS      = Zone((512, 360,  640,  448), ('x', 'z'), ((-1.0, 1.0), (-1.0, 1.0)))
SAND      = Zone((640, 360,  896,  448), ('x', 'y'), ((-45, 45), (25, -5)))
TRIM      = Zone((512, 448,  640,  512), ('x', 'y'), ((-45, 45), (25, -5)))
DARK      = Zone((640, 448,  768,  512), ('x', 'z'), ((-45, 45), (-45, 45)))

# ── shared construction dims ────────────────────────────────────────────
SEG_HALF   = 4.0          # wall segment: 8 m along X
BERM_HB    = 1.15         # earth berm half-width at ground
BERM_HT    = 0.58         # earth berm half-width at crest
BERM_H     = 1.15         # earth berm height
PLATE_T    = 0.18         # scrap plate thickness
PLATE_Y0   = 0.70         # plates bedded into the berm crest
POST_H     = 2.95
POST_Z     = 0.30         # posts run up the back (+Z) of the plates
BRACE_FOOT = 1.45         # rear diagonal braces: foot z

# wall segment: (cx, width, top_y, z_offset) per scrap plate
WALL_PLATES = [(-3.0, 1.95, 2.72, 0.05), (-1.0, 1.95, 2.94, -0.04),
               (1.0, 1.95, 2.62, 0.06), (3.0, 1.95, 2.86, -0.05)]
WALL_POSTS  = [-3.95, -2.0, 0.0, 2.0, 3.95]
WALL_BRACES = [-2.6, 0.6, 3.2]
# sandbag row on the front toe: (cx, cz, length)
WALL_BAGS   = [(-2.1, -1.35, 2.5), (1.9, -1.30, 2.1)]

# corner: two arms 0.7..ARM_LEN, mound + post + platform at the junction
ARM_LEN    = 4.0
ARM_PLATES = [(1.75, 1.9, 2.78, 0.05), (3.3, 1.35, 2.60, -0.04)]   # (c, w, top, off)
ARM_PLATES_Z = [(1.75, 1.9, 2.66, 0.05), (3.3, 1.35, 2.88, -0.04)]
CPOST_SIZE = (0.95, 3.15, 0.95)
CPLAT_SIZE = (1.55, 0.16, 1.55)
CPLAT_Y    = 3.32
MOUND_SIZE = (2.35, 1.05, 2.35)

# gate: pylons at ±PYLON_X, opening between inner faces = 5.2 m
PYLON_X    = 3.3
PYLON_SIZE = (1.4, 3.4, 1.5)
CAP_SIZE   = (1.6, 0.22, 1.7)
LINTEL_BOX = (0.0, 3.32, 0.0, 6.0, 0.45, 0.55)   # x,y,z, w,h,d
GATE_BAGS  = [(-3.05, -1.15, 1.5), (3.05, -1.15, 1.5)]
# gate leaf (piece `gate`, hinge = piece origin at gate_frame x = -2.6)
HINGE_X    = -2.6
LEAF_W     = 5.10         # local x 0.05 .. 5.15
LEAF_H     = 2.70         # local y 0.15 .. 2.85
LEAF_T     = 0.16
LEAF_LATCH = (5.02, 1.45, 0.0)

# root piece offsets (display fan-out only — see module docstring)
WALL_OFF   = (0.0, 0.0, 0.0)
CORNER_OFF = (-10.0, 0.0, 0.0)
GATE_OFF   = (10.0, 0.0, 0.0)
