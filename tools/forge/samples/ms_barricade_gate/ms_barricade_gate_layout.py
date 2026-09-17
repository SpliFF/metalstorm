"""ms_barricade_gate_layout — zones + dims for the 8 m barricade gateway.

Third of the three models the `ms_barricade_set` kit sheet was split into
(units-assets review 2026-09-10, task 2(c)) so town-planner §T3 can put a gate
on the main street without stamping the whole 25 m kit sheet. Root offset
zeroed, per the kit layout's own instruction to integrators.

Two pylons + hazard lintel (`body`) with a 5.1 m scrap leaf child piece
(`gate`), hinged at the -X pylon; clip `open` swings it inward through ~104°.
Y=0, forward -Z, 1 unit = 1 m. Zone rects inherited from ms_barricade_set.
"""
import meshlib
from meshlib import Zone

meshlib.ATLAS = 1024

# ── atlas zones (1024²) ─────────────────────────────────────────────────
GATE_LEAF  = Zone((512,   0,  896,  224), ('x', 'y'), ((-0.1, 5.3), (2.95, -0.05)))
PYLON      = Zone((896,   0, 1024,  224), ('x', 'y'), ((-4.2, 4.2), (3.7, -0.1)))
PYLON_Z    = Zone((896, 224, 1024,  448), ('z', 'y'), ((-0.95, 0.95), (3.7, -0.1)))
LINTEL     = Zone((512, 224,  896,  300), ('x', 'y'), ((-3.3, 3.3), (3.75, 2.95)))
LINTEL_TOP = Zone((512, 300,  896,  360), ('x', 'z'), ((-3.3, 3.3), (-0.4, 0.4)))
TOPS       = Zone((512, 360,  640,  448), ('x', 'z'), ((-1.0, 1.0), (-1.0, 1.0)))
SAND       = Zone((640, 360,  896,  448), ('x', 'y'), ((-45, 45), (25, -5)))
TRIM       = Zone((512, 448,  640,  512), ('x', 'y'), ((-45, 45), (25, -5)))
DARK       = Zone((640, 448,  768,  512), ('x', 'z'), ((-45, 45), (-45, 45)))

# ── construction dims (metres) ──────────────────────────────────────────
# pylons at ±PYLON_X; opening between the inner faces = 5.2 m
PYLON_X    = 3.3
PYLON_SIZE = (1.4, 3.4, 1.5)
CAP_SIZE   = (1.6, 0.22, 1.7)
LINTEL_BOX = (0.0, 3.32, 0.0, 6.0, 0.45, 0.55)   # x,y,z, w,h,d
GATE_BAGS  = [(-3.05, -1.15, 1.5), (3.05, -1.15, 1.5)]
# gate leaf (piece `gate`, hinge = piece origin at body x = -2.6)
HINGE_X    = -2.6
LEAF_W     = 5.10         # local x 0.05 .. 5.15
LEAF_H     = 2.70         # local y 0.15 .. 2.85
LEAF_T     = 0.16
# `open` clip: slow start, firm stop, small settle. Non-looping.
OPEN_KEYS  = [(0.0, 0.0), (0.5, -8.0), (1.6, -60.0), (2.8, -106.0),
              (3.2, -104.0)]
