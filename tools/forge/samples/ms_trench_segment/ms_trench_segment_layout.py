"""ms_trench_segment_layout — zones + dims for the 8 m field trench.

Field-engineering content the drill-down build menu was missing (units-assets
review 2026-09-10, task 2(c)): an 8 m length of revetted trench that tiles
end-to-end along X, so a run is N copies and a corner is a 90° yaw.

The engine has no terrain cut, so the trench is read the way a real field
work reads from outside: a tall FRONT parapet (-Z) of spoil earth with a
plank-and-post revetment on its inner face and a sandbag firing course on its
crest, a lower spoil bank at the rear (+Z), and a duckboarded floor between
them at ground level. Nothing dips below Y=0.

One `body` piece, no clips, NO team surface (--no-team: earth, timber and
hessian, never sprayed). 8 m along X, forward -Z, 1 unit = 1 m.
Pattern: ms_supply_dump (painted cells reused by every instance of a prop).
"""
import meshlib
from meshlib import Zone

meshlib.ATLAS = 1024

# ── atlas zones (1024²) ─────────────────────────────────────────────────
EARTH_F   = Zone((0,     0,  512,  192), ('x', 'y'), ((-4.1, 4.1), (1.55, -0.1)))
EARTH_Z   = Zone((0,   192,  512,  384), ('z', 'y'), ((-2.6, 2.6), (1.55, -0.1)))
EARTH_TOP = Zone((0,   384,  512,  512), ('x', 'z'), ((-4.1, 4.1), (-1.4, 1.4)))
PLANK     = Zone((512,   0, 1024,  224), ('x', 'y'), ((-4.1, 4.1), (1.35, -0.05)))
BOARD     = Zone((512, 224, 1024,  416), ('x', 'z'), ((-4.1, 4.1), (-0.95, 0.95)))
SAND      = Zone((0,   512,  384,  704), ('x', 'y'), ((-4.1, 4.1), (0.62, -0.02)))
SAND_TOP  = Zone((384, 512,  768,  704), ('x', 'z'), ((-4.1, 4.1), (-0.36, 0.36)))
TIMBER    = Zone((768, 512, 1024,  640), ('x', 'y'), ((-45, 45), (25, -5)))
CORR      = (768, 640, 1024, 768)        # corrugated sheet (raw rect, limbs)
DARK      = Zone((0,   960,  128, 1024), ('x', 'z'), ((-45, 45), (-45, 45)))

# ── dims (metres, ground Y=0) ───────────────────────────────────────────
SEG_HALF   = 4.0          # 8 m along X — the tiling length
FLOOR_Z    = (-0.85, 0.85)   # duckboarded walkway between the parapets
FLOOR_Y    = 0.05

# front parapet (-Z): trapezoid berm, tallest face toward the enemy
FRONT_Z    = (-2.05, -0.85)  # outer, inner (the revetted face)
FRONT_H    = 1.30
FRONT_BATT = 0.42         # how far the outer face slopes back at the crest

# rear parapet (+Z): lower spoil bank
REAR_Z     = (0.85, 1.75)
REAR_H     = 0.80
REAR_BATT  = 0.30

# revetment: plank band on the front parapet's inner face + retaining posts
PLANK_TOP  = 1.22
POSTS_X    = [-3.6, -1.8, 0.0, 1.8, 3.6]
POST_H     = 1.46
POST_Z     = -0.83

# sandbag firing course on the front crest: (cx, length)
BAGS       = [(-2.55, 2.6), (0.35, 2.4), (3.05, 1.7)]
BAG_Z      = -1.42
BAG_SIZE   = (0.58, 0.62)    # height, depth

# firing step (ammo shelf) against the front wall
STEP       = (1.55, 0.34, 0.55)      # w, h, d
STEP_POS   = (-2.9, -0.62)           # cx, cz
# corrugated sheet leaning on the rear bank: (cx, cz, w, h)
SHEET      = (2.35, 1.02, 1.9, 0.95)
