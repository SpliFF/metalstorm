"""ms_pontoon_wharf_layout — zones + dims for ms_pontoon_wharf.

Transport terminus: 30 m floating pontoon wharf sized for the 35 m
landing ship (s2 ship row).  Three deck sections riding six visible
pontoon floats, berthing face on -X (fenders + cleats), pedestal crane
(`crane` piece, idle slew) near the seaward end, railed walkway running
+Z to shore with its own float and a shore ramp plate.  Pontoon bottoms
at Y=0 (keel convention, same as fable_carrier — the sim sets the
floating depth), deck top 2.1 m, seaward end -Z.  2048² atlas
(dominant dim ~40 m incl. walkway), v down.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
W_DECK     = Zone((0,    0,    2048, 672),  ('z', 'x'), ((-15.3, 15.3), (-3.35, 3.35)))
W_WALK     = Zone((0,    672,  1024, 928),  ('z', 'x'), ((14.7, 25.3), (-1.5, 1.5)))
W_DECKSIDE = Zone((1024, 672,  2048, 800),  ('z', 'y'), ((-15.3, 15.3), (2.25, 1.35)))
W_DECKEND  = Zone((1024, 800,  1280, 928),  ('x', 'y'), ((-3.35, 3.35), (2.25, 1.35)))
W_PONT     = Zone((0,    928,  1536, 1216), ('z', 'y'), ((-15.5, 24.5), (1.7, -0.1)))
W_PONT_F   = Zone((1536, 928,  1792, 1216), ('x', 'y'), ((-3.3, 3.3), (1.7, -0.1)))
W_PONT_TOP = Zone((1792, 928,  2048, 1056), ('z', 'x'), ((-15.5, 24.5), (-3.3, 3.3)))
W_CRANE    = Zone((0,    1216, 512,  1536), ('z', 'y'), ((-1.6, 2.0), (2.9, -0.3)))
W_CRANE_F  = Zone((512,  1216, 768,  1536), ('x', 'y'), ((-0.95, 0.95), (2.9, -0.3)))
W_BOOM     = (768, 1216, 1536, 1344)   # parametric boom/limb wrap
W_PED      = (768, 1344, 1280, 1408)   # parametric pedestal wrap
W_RAIL     = (768, 1408, 1280, 1472)   # parametric rail/post wrap
W_CLEAT    = (768, 1472, 1280, 1536)   # parametric cleat/fitting wrap
W_FENDER   = (1536, 1216, 1792, 1472)  # parametric fender wrap (u along, v around)
W_CRATE    = Zone((0,    1536, 320,  1856), ('x', 'y'), ((-0.85, 0.85), (0.95, -0.95)))
W_LIGHT    = (320, 1536, 448, 1664)    # parametric beacon-mast lamp wrap
W_HOOK     = Zone((448,  1536, 704,  1728), ('x', 'y'), ((-0.35, 0.35), (0.45, -0.45)))
W_DARK     = Zone((320,  1664, 448,  1792), ('x', 'z'), ((-1.0, 1.0), (-1.0, 1.0)))

# ── dims (world metres; pontoon bottom Y=0, seaward -Z, berth -X) ────────
DECK_TOP   = 2.10                      # wharf deck walking surface
DECK_W     = 6.4                       # wharf width
SECTIONS   = [-10.0, 0.0, 10.0]        # deck section centres (z)
SECT_L     = 9.7                       # section length (0.3 m gaps)
SECT_H     = 0.6                       # deck slab thickness (y 1.5..2.1)
PONT_SIZE  = (2.6, 1.5, 5.2)           # pontoon float w,h,d (y 0..1.5)
PONT_X     = 1.9                       # pontoon pair offset from centreline
WATERLINE  = 0.85                      # painted boot-top height on pontoons

# walkway to shore (+Z) with its own float and shore ramp plate
WALK_Z     = (15.0, 23.6)              # slab z extent
WALK_W     = 2.6
WALK_TOP   = 2.00                      # slab y 1.55..2.0 (floating step-down)
WALK_PONT  = (0.0, 0.75, 19.5, 1.8, 1.5, 4.6)   # x,y,z, w,h,d
RAMP_Z     = (23.6, 25.0)              # shore ramp plate
RAMP_Y     = (2.00, 2.42)
RAIL_H     = 1.0                       # walkway handrail height
RAIL_X     = 1.28                      # handrail offset from centreline
RAIL_POSTS = [15.5, 17.6, 19.7, 21.8, 23.4]

# berth fittings (-X face)
CLEATS     = [-12.0, -6.0, 0.0, 6.0, 12.0]      # z positions, x=-2.95
CLEAT_X    = -2.95
FENDERS_B  = [-9.0, -3.0, 3.0, 9.0]             # berth-face fenders, x=-3.38
FENDERS_S  = [-6.0, 6.0]                        # spare fenders on +X face
FENDER_R   = 0.33
FENDER_Y   = (2.05, 0.90)                       # hang from deck edge down

# pedestal crane (slew piece) near the seaward end, landward (+X) side
PED_XZ     = (2.0, -8.0)
PED_R      = (0.80, 0.72)                       # base/top radius
PED_TOP    = 2.70                               # bearing height = crane origin
CRANE_OFF  = (2.0, 2.70, -8.0)                  # piece offset (parent body)
BOOM_TIP   = (0.0, 3.25, -6.6)                  # crane-local boom tip
HOOK_Z     = -5.9                               # crane-local hook drop z

# beacon mast at the seaward starboard corner
MAST_XZ    = (2.6, -14.5)
MAST_TOP   = 5.15

# supply crates staged near the walkway junction
CRATES     = [(1.7, 12.6, 1.30), (0.45, 13.15, 1.05)]   # x, z, size

# attachment empties
BERTH_OFF  = (-5.2, 0.0, 0.0)          # landing-ship berth marker (-X side)
SHORE_OFF  = (0.0, 2.2, 25.0)          # walkway shore-end marker
