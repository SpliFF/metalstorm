"""ms_dress_dynasty_layout — zones + dims for the Dynasty dressing kit.

Archetype accessory kit (opulent-salvage: gold trim over worn steel) sized
against the fable_tank / fable_heavy hulls:
    fable_tank : deck y 1.86, hull half-width 1.75, len -4.40..4.40
    fable_heavy: deck y 3.02, hull half-width 2.35, len -8.10..8.10

Separate ROOT pieces in ONE glTF, each authored about its own MOUNT point
(base / flange / back face at the local origin plane) so integrators can
socket them straight onto a hull. Root offsets fan the kit out along X for
display only — zero them when placing single pieces.

  banner (root) + flag (child)  heraldic hanging banner, `idle` wave clip
  rail_l / rail_r (roots)       gilt trim rails (deck-edge runs, along Z)
  crest (root)                  crest plaque (back face = mount plane)
  lantern_l / lantern_r (roots) carriage lanterns, warm emissive glass
  cowl_l / cowl_r (roots)       ornamented exhaust cowls, gilt trumpet lip

One 1024 texture set (dominant dim ~2.8 m << 15 m). Y=0 ground, -Z forward.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas zones (1024²) ─────────────────────────────────────────────────
# banner cloth, front/back share (design symmetric about the vertical axis)
FLAG      = Zone((0,     0,  352,  608), ('x', 'y'), ((-0.45, 0.45), (0.05, -1.55)))
# crest plaque front/back + edge band
CREST_F   = Zone((352,   0,  608,  304), ('x', 'y'), ((-0.55, 0.55), (1.25, -0.05)))
CREST_S   = Zone((608,   0,  672,  304), ('z', 'y'), ((-0.16, 0.16), (1.25, -0.05)))
# lantern housing sides (±z faces project x/y, ±x faces project z/y)
LANT_X    = Zone((672,   0,  800,  160), ('x', 'y'), ((-0.22, 0.22), (0.72, -0.02)))
LANT_Z    = Zone((672, 160,  800,  320), ('z', 'y'), ((-0.22, 0.22), (0.72, -0.02)))
LANT_TOP  = Zone((800,   0,  928,  128), ('x', 'z'), ((-0.25, 0.25), (-0.25, 0.25)))
# generic material cells (big windows — tone-on-tone, projection-agnostic)
GOLD      = Zone((928,   0, 1024,  128), ('x', 'y'), ((-4.0, 4.0), (4.0, -4.0)))
GOLD_TOP  = Zone((928, 128, 1024,  224), ('x', 'z'), ((-4.0, 4.0), (-4.0, 4.0)))
STEEL     = Zone((928, 224, 1024,  352), ('x', 'y'), ((-4.0, 4.0), (4.0, -4.0)))
DARK      = Zone((928, 352, 1024,  416), ('x', 'z'), ((-4.0, 4.0), (-4.0, 4.0)))
# parametric wrap for the cowl loft (u = along stations, v = around)
COWL_WRAP = (0, 608, 512, 708)

# ── banner (pole base at origin, pole up +Y, cloth faces ±Z) ────────────
POLE_H     = 2.60
POLE_R0    = 0.050
POLE_R1    = 0.034
POLE_BASE  = (0.34, 0.06, 0.34)      # mount plate
POLE_BANDS = (0.72, 1.62)            # gilt collar band heights
BAR_Y      = 2.28                    # crossbar height = flag piece origin
BAR_HALF   = 0.50
BAR_R      = 0.028
FINIAL     = ((2.60, 0.020), (2.68, 0.070), (2.78, 0.016))  # (y, r) stations
CLOTH_HALF = 0.42                    # cloth half-width (local x)
CLOTH_DROP = 1.50                    # cloth length (local y 0..-1.50)
CLOTH_COLS = 3
CLOTH_ROWS = 3
CLOTH_SAG  = 0.05                    # backward drift at the free end
CLOTH_RIP  = 0.028                   # sideways ripple amplitude

# ── gilt trim rails (run along Z, stanchion feet at y=0) ────────────────
RAIL_HALF  = 1.80                    # run: z -1.80..1.80
RAIL_STEP  = 0.90
STANCH_H   = 0.44
STANCH_R   = (0.030, 0.024)
RAIL_TOP_Y = 0.46
RAIL_TOP_R = 0.034
RAIL_MID_Y = 0.24
RAIL_MID_R = 0.020

# ── crest plaque (bottom y=0, back face +z = mount plane) ───────────────
BOARD_SIZE = (1.00, 1.20, 0.07)      # gilt backboard
BOARD_CZ   = 0.020                   # backboard centre z (back face z=+0.055)
PANEL_SIZE = (0.84, 1.04, 0.06)
PANEL_CZ   = -0.045

# ── carriage lantern (base plate bottom y=0) ────────────────────────────
LANT_BASE  = (0.28, 0.05, 0.28)
LANT_BODY  = (0.30, 0.42, 0.30)      # housing
LANT_BODY_Y = 0.26                   # housing centre y
LANT_ROOF  = ((0.47, 0.200), (0.61, 0.030))   # (y, r) limb stations, n=4

# ── exhaust cowl (flange bottom y=0, mouth up) ──────────────────────────
COWL_FLANGE = (0.42, 0.04, 0.42)
COWL_STATIONS = [(0.04, 0.160), (0.42, 0.160), (0.55, 0.135),
                 (0.68, 0.200), (0.76, 0.270)]   # (y, r) trumpet flare
COWL_N     = 6

# ── root display offsets (fan-out only — see module docstring) ──────────
BANNER_OFF  = (0.0, 0.0, 0.0)
RAIL_L_OFF  = (-2.6, 0.0, 0.0)
RAIL_R_OFF  = (2.6, 0.0, 0.0)
CREST_OFF   = (4.6, 0.0, 0.0)
LANT_L_OFF  = (-4.5, 0.0, 0.0)
LANT_R_OFF  = (-5.6, 0.0, 0.0)
COWL_L_OFF  = (6.0, 0.0, 0.0)
COWL_R_OFF  = (7.1, 0.0, 0.0)

# ── suggested hull mounts (README + integrator notes) ───────────────────
MOUNTS_TANK = {
    'banner':    (0.0, 1.86, 3.9),    # deck rear centreline
    'rail_l':    (-1.55, 1.86, 0.3),
    'rail_r':    (1.55, 1.86, 0.3),
    'crest':     (0.0, 0.95, -4.42),  # glacis/bow, back plane on hull nose
    'lantern_l': (-1.45, 1.86, -3.6),
    'lantern_r': (1.45, 1.86, -3.6),
    'cowl_l':    (-1.15, 1.86, 3.4),
    'cowl_r':    (1.15, 1.86, 3.4),
}
MOUNTS_HEAVY = {
    'banner':    (0.0, 3.02, 7.4),
    'rail_l':    (-2.10, 3.02, 0.5),
    'rail_r':    (2.10, 3.02, 0.5),
    'crest':     (0.0, 1.60, -8.12),
    'lantern_l': (-2.00, 3.02, -6.9),
    'lantern_r': (2.00, 3.02, -6.9),
    'cowl_l':    (-1.55, 3.02, 5.35),
    'cowl_r':    (1.55, 3.02, 5.35),
}
