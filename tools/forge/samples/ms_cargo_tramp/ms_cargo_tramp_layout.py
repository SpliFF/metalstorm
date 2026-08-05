"""ms_cargo_tramp_layout — zones + dims for ms_cargo_tramp.

s3 ~55 m civilian tramp freighter. Waterline at Y=0 (hull runs below to
draft ~-2.2 m), forward -Z. Raised forecastle at the bow, aft
superstructure block with funnel, two open holds amidships (coamings +
crate/drum cargo), one static deck crane between the holds, laundry
line on the poop deck (`laundry` piece, idle sway clip). Civilian
scavenger register — patched rust-streaked hull, NO team colour.
2048 atlas (55 m dominant dim).
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048², v down) ──────────────────────────────────────────
S_HULL_SIDE = Zone((0,    0,    2048, 340),  ('z', 'y'), ((-27.5, 27.5), (6.0, -2.4)))
S_BELLY     = Zone((0,    340,  2048, 540),  ('z', 'x'), ((-27.5, 27.5), (-4.8, 4.8)))
S_DECK      = Zone((0,    540,  2048, 860),  ('z', 'x'), ((-27.5, 27.5), (-4.8, 4.8)))
S_BOW       = Zone((0,    860,  320,  1100), ('x', 'y'), ((3.0, -3.0), (6.0, -0.6)))
S_STERN     = Zone((320,  860,  640,  1100), ('x', 'y'), ((3.6, -3.6), (5.0, -1.2)))
S_COAM      = Zone((640,  860,  1400, 980),  ('z', 'y'), ((-15.5, 5.5), (5.1, 4.0)))
S_COAM_TOP  = Zone((640,  980,  1400, 1040), ('z', 'x'), ((-15.5, 5.5), (-2.8, 2.8)))
S_SUPER_S   = Zone((1400, 860,  1900, 1100), ('z', 'y'), ((13.5, 22.5), (9.9, 4.1)))
S_SUPER_F   = Zone((0,    1120, 500,  1360), ('x', 'y'), ((3.4, -3.4), (9.9, 4.1)))
S_SUPER_TOP = Zone((500,  1120, 900,  1300), ('x', 'z'), ((-3.4, 3.4), (13.5, 22.5)))
S_CRATE     = Zone((900,  1120, 1160, 1380), ('x', 'y'), ((-14.0, 14.0), (12.0, -2.0)))
S_DRUM      = Zone((1160, 1120, 1420, 1380), ('x', 'y'), ((-14.0, 14.0), (12.0, -2.0)))
S_TARP      = Zone((1420, 1120, 1680, 1380), ('x', 'z'), ((-14.0, 14.0), (-14.0, 14.0)))
S_FUNNEL    = (1680, 1120, 1936, 1248)   # parametric tube wrap
S_MAST      = (1680, 1248, 1936, 1376)   # parametric mast/post/crane wrap
S_RAIL      = (1936, 1120, 2048, 1376)   # parametric rail/line wrap
S_TRIM      = Zone((256,  1400, 512,  1528), ('z', 'y'), ((-45, 45), (25, -5)))
S_DARK      = Zone((512,  1400, 640,  1528), ('x', 'z'), ((-1, 1), (-1, 1)))
S_CLOTH     = Zone((640,  1400, 1152, 1528), ('x', 'y'), ((-2.4, 2.4), (0.3, -1.1)))

# ── dims (world metres; waterline Y=0, bow -Z) ───────────────────────────
# sections: (z, y_bot, y_knuckle, y_deck, w_bot, w_knuckle, w_deck)
HULL_SECTIONS = [
    (-27.2,  0.20, 2.60, 5.80, 0.30, 1.20, 1.70),
    (-25.0, -1.00, 1.60, 5.70, 1.60, 2.90, 3.30),
    (-21.0, -1.90, 1.00, 5.50, 2.80, 3.90, 4.20),
    (-19.8, -2.00, 1.00, 4.35, 2.90, 4.00, 4.30),   # forecastle step
    (-12.0, -2.20, 0.90, 4.20, 3.40, 4.40, 4.60),
    (0.0,   -2.20, 0.90, 4.20, 3.50, 4.50, 4.70),
    (10.0,  -2.20, 0.90, 4.25, 3.40, 4.40, 4.60),
    (19.0,  -2.00, 1.00, 4.35, 2.90, 4.00, 4.30),
    (26.8,  -0.90, 1.50, 4.50, 1.60, 2.80, 3.20),
]
WATERLINE  = (-0.35, 0.55)      # boot-top band (painted)
DECK_Y     = 4.2                # main deck amidships
FC_DECK_Y  = 5.5                # forecastle deck

# holds (open, coaming-framed): (z0, z1); half-width + coaming
HOLDS      = [(-15.0, -7.0), (-3.0, 5.0)]
HOLD_HW    = 2.6                # coaming half-width
COAM_Y0, COAM_Y1 = 4.2, 4.95    # coaming wall bottom/top
COAM_T     = 0.18

# deck crane between the holds (static jib over hold 1)
CRANE_Z    = -5.0
CRANE_TOP  = 10.2
JIB_TIP    = (0.0, 7.3, -11.0)

# aft superstructure + funnel
SUPER      = (0.0, 7.0, 18.0, 6.4, 5.6, 7.0)   # x,y,z,w,h,d (y = centre)
FUNNEL     = (0.0, 20.5)        # x,z; deck house roof 9.8 -> 12.4
FUNNEL_TOP = 12.4
MAST_FOOT  = (0.0, 5.5, -23.0)
MAST_TOP   = (0.0, 10.5, -23.0)
YARD_HW    = 1.3                # crosstree half-width at y=9.6

# laundry line on the poop deck (aft of the house)
LAUNDRY_OFF   = (0.0, 6.4, 24.5)    # piece pivot = the line
LAUNDRY_HW    = 2.0                 # post spacing half-width
LAUNDRY_SWAY  = 6.0                 # idle sway (deg about X)
EXHAUST_OFF   = (0.0, 12.4, 20.5)   # FX empty at funnel top
