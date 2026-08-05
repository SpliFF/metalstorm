"""ms_dress_order_layout — zones + dims for the Order dressing kit.

Accessory kit: attachment pieces sized to mount on fable_tank and
fable_heavy hulls (dims read from toolkit layout.py / heavy_layout.py:
tank half-width 1.75, deck y 1.86, hull z -4.40..4.40; heavy half-width
2.35, deck y 3.02, hull z -8.10..8.10).

FOUR kit elements, each its own ROOT piece in ONE glTF (ms_dress_order):
  applique   — three uniform applique plates (side / glacis / numbered ID
               panel; the ID panel carries the team mask)
  staff      — 2.6 m pennant staff; child piece `flag` (numbered swallow-
               tail pennant, team-masked field, seamless `idle` wave clip)
  lightbar   — formation light bar, four amber emissive lenses
  stowage    — regimented stowage rack: tray + posts + three matched crates
All share one 1024² texture set (dominant dim ~5 m < 15 m). Elements sit
on Y=0, forward -Z, 1 unit = 1 m. Root offsets fan the kit out along X
for display only; integrators zero the root offset and use the mount
offsets in out/README.txt.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas zones (1024²) ─────────────────────────────────────────────────
# applique plate fronts/backs (plates stand upright, faces ±Z)
PLATES_F = Zone((0,   0, 512, 168), ('x', 'y'), ((-2.62, 2.62), (1.08, -0.04)))
# pennant cloth, front (-Z side) and back (+Z side, u flipped so the
# numeral reads correctly on both sides)
PEN_F    = Zone((512,   0, 832, 144), ('x', 'y'), ((-0.02, 1.02), (0.21, -0.21)))
PEN_B    = Zone((512, 144, 832, 288), ('x', 'y'), ((1.02, -0.02), (0.21, -0.21)))
# formation light bar
BAR_F    = Zone((0, 224, 384, 304), ('x', 'y'), ((-0.68, 0.68), (0.72, 0.52)))
BAR_TOP  = Zone((0, 304, 384, 352), ('x', 'z'), ((-0.68, 0.68), (-0.10, 0.10)))
# stowage rack
CRATE    = Zone((512, 288, 896, 472), ('x', 'y'), ((-0.82, 0.82), (0.70, 0.05)))
TRAY     = Zone((0, 352, 384, 424), ('x', 'z'), ((-0.88, 0.88), (-0.38, 0.38)))
# shared trim / dark cells
TRIM     = Zone((832,   0, 960,  96), ('x', 'y'), ((-3.5, 3.5), (3.0, -0.5)))
DARK     = Zone((832,  96, 960, 160), ('x', 'z'), ((-3.0, 3.0), (-3.0, 3.0)))

# ── applique plates (cx, cy, w, h); thickness PLATE_T, stand on Y=0 ─────
PLATE_T   = 0.10
PLATE_CH  = 0.03
PLATE_SIDE   = (-1.55, 0.50, 2.00, 1.00)   # hull-side plate
PLATE_GLACIS = ( 0.45, 0.45, 1.50, 0.90)   # glacis plate
PLATE_ID     = ( 2.00, 0.45, 1.10, 0.90)   # numbered ID / team panel

# ── pennant staff ───────────────────────────────────────────────────────
STAFF_H     = 2.60
STAFF_R0    = 0.035
STAFF_R1    = 0.026
FLANGE      = (0.16, 0.06, 0.16)           # base mount flange
FINIAL      = (0.09, 0.12, 0.09)
FLAG_OFF    = (0.0, 2.32, 0.0)             # `flag` child offset on staff
# pennant cloth (flag-local): hoist x=0.045, kink at PEN_KINK, tip x=PEN_TIP
PEN_HOIST_X = 0.045
PEN_KINK    = 0.55
PEN_TIP     = 0.98
PEN_HH      = 0.17                          # half-height at hoist
PEN_HT      = 0.04                          # half-height at tip

# ── formation light bar ─────────────────────────────────────────────────
BAR_SIZE    = (1.30, 0.16, 0.18)           # w, h, d
BAR_CY      = 0.62                          # bar centre height (on stubs)
BAR_STUB_X  = 0.42                          # stub x offset (pair)
BAR_STUB_R  = 0.030
LENS_XS     = (-0.48, -0.16, 0.16, 0.48)   # lens centres along the bar
LENS_W      = 0.20
LENS_H      = 0.10

# ── regimented stowage rack ─────────────────────────────────────────────
TRAY_SIZE   = (1.70, 0.14, 0.72)
POST_XZ     = (0.80, 0.32)                 # post footprint (±x, ±z)
POST_H      = 0.78
POST_R      = 0.035
RAIL_Y      = 0.74
RAIL_R      = 0.028
CRATE_S     = 0.50
CRATE_XS    = (-0.55, 0.0, 0.55)
CRATE_Y     = 0.14 + 0.25                  # tray top + half crate

# ── display fan-out root offsets (see module docstring) ─────────────────
APPLIQUE_OFF = (-4.2, 0.0, 0.0)
STAFF_OFF    = (-1.6, 0.0, 0.0)
LIGHTBAR_OFF = ( 0.9, 0.0, 0.0)
STOWAGE_OFF  = ( 3.4, 0.0, 0.0)
