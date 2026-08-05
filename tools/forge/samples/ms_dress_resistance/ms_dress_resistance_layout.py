"""ms_dress_resistance_layout — zones + dims for the Resistance dressing kit.

FIVE elements as separate ROOT pieces in ONE glTF (ms_dress_resistance):
  net   — camo net canopy (tarp_over-like draped shell + corner prop poles)
  stow  — stowage bundles (tarped bundle + lashed crates)
  rack  — jerrycan rack (welded frame + two painted 2-can blocks)
  flag  — cause-flag on a square scrap post; `idle` wave clip; team mask
  smoke — improvised smoke discharger cluster (bracket + 4 welded pipes)

Accessory kit sized against fable_tank / fable_heavy hulls (dims read from
toolkit layout.py / heavy_layout.py ONLY):
  fable_tank : deck y 1.86, hull top x ±1.75, z -4.40..4.40, turret (0,1.80,0.30)
  fable_heavy: deck y 3.02, hull top x ±2.35, z -8.10..8.10, turret (0,3.00,-0.60)
Each element is authored with its LOCAL origin at the mount plane (y=0 =
deck/attach surface).  Root offsets fan the kit out along X purely for
display; integrators placing single pieces zero the root offset and use the
mount offsets in out/README.txt.
All elements share one 1024² texture set (dominant dim < 15 m).
Forward -Z, +Y up, 1 unit = 1 m.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas zones (1024²) ─────────────────────────────────────────────────
# camo net canopy — one zone all faces (verticals stripe; camo is
# low-contrast tone-on-tone so the smear and the impostor baker both read OK)
NET     = Zone((0,     0,  512, 512), ('x', 'z'), ((-2.6, 2.6), (-3.2, 3.2)))
# stowage tarp bundle
TARP    = Zone((512,   0,  832, 256), ('x', 'z'), ((-1.05, 1.05), (-0.75, 0.95)))
# crates (window spans the crate cluster in stow-local coords)
CRATE   = Zone((832,   0, 1024, 192), ('x', 'y'), ((-1.7, -1.0), (1.1, 0.0)))
# jerrycan blocks (two 2-can blocks, rack-local)
CAN     = Zone((512, 256,  768, 448), ('x', 'y'), ((-0.45, 0.45), (0.78, 0.0)))
# cause-flag cloth (both sides share the zone)
FLAG    = Zone((768, 256, 1024, 448), ('x', 'y'), ((0.0, 1.15), (2.55, 1.65)))
# smoke discharger bracket
BRACKET = Zone((832, 448, 1024, 576), ('x', 'y'), ((-0.4, 0.4), (0.65, -0.02)))
# generic dark cap cell (wide window: any cap position lands inside)
DARK    = Zone((896, 576, 1024, 640), ('x', 'z'), ((-20, 20), (-20, 20)))
# parametric rects for limbs (u along, v around)
TRIM_R  = (0, 512, 128, 640)      # net prop poles / rack frame steel
POLE_R  = (384, 512, 512, 640)    # flag post (weathered timber/scrap)
TUBE_R  = (128, 512, 384, 640)    # smoke tubes (soot at muzzle end u=1)

# ── net (camo canopy, sized to drape a fable_tank hull) ─────────────────
NET_SIZE  = (4.6, 0.75, 5.8)      # footprint w,h,d at the mount plane
NET_SAG   = 0.28
NET_POLES = [(-2.05, -2.65), (2.05, -2.65), (-2.05, 2.65), (2.05, 2.65)]
NET_POLE_TOP = 0.58

# ── stow (bundles) ──────────────────────────────────────────────────────
STOW_TARP_C   = (0.0, 0.0, 0.15)
STOW_TARP_SZ  = (1.9, 0.55, 1.3)
STOW_CRATES   = [((-1.35, 0.275, 0.33), 0.55), ((-1.35, 0.275, -0.28), 0.55),
                 ((-1.32, 0.80, 0.02), 0.50)]

# ── rack (jerrycans) ────────────────────────────────────────────────────
RACK_POSTS  = [(-0.46, -0.17), (0.46, -0.17), (-0.46, 0.17), (0.46, 0.17)]
RACK_H      = 0.62
RACK_RAIL_Y = (0.07, 0.56)
CAN_BLOCKS  = [(-0.22, 0.36, 0.0), (0.22, 0.36, 0.0)]   # centres
CAN_BLOCK_SZ = (0.40, 0.52, 0.26)

# ── flag ────────────────────────────────────────────────────────────────
POLE_H     = 2.6
POLE_R0    = 0.038
POLE_R1    = 0.028
CLOTH_Y0, CLOTH_Y1 = 1.75, 2.45   # inner edge bottom/top
CLOTH_X_MID, CLOTH_X_END = 0.58, 1.08
CLOTH_DROOP = 0.04                # trailing edge sits lower
CLOTH_Z_MID, CLOTH_Z_END = 0.03, -0.05

# ── smoke discharger cluster ────────────────────────────────────────────
SMOKE_BRACKET = (0.7, 0.2, 0.3)   # w,h,d, base on mount plane
SMOKE_XS      = [-0.27, -0.09, 0.09, 0.27]
SMOKE_BASE    = (0.14, 0.10)      # y,z of tube root
SMOKE_TIP     = (0.56, -0.30)     # y,z of muzzle (45° up-forward)
SMOKE_TUBE_R  = 0.055

# ── root piece display fan-out (integrators zero these) ─────────────────
NET_OFF   = (0.0, 0.0, 0.0)
STOW_OFF  = (-6.0, 0.0, 0.0)
RACK_OFF  = (-9.0, 0.0, 0.0)
FLAG_OFF  = (6.0, 0.0, 0.0)
SMOKE_OFF = (9.0, 0.0, 0.0)
