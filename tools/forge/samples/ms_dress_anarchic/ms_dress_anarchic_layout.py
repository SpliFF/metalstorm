"""ms_dress_anarchic_layout — zones + dims for the Anarchic dressing kit.

Archetype accessory kit sized against the fable_tank / fable_heavy hulls
(hull dims read from toolkit layout.py / heavy_layout.py per spec):
  fable_tank : hull z -4.40..4.40, half-width 1.75, side y 0.15..2.05,
               deck y 1.86
  fable_heavy: hull z -8.10..8.10, half-width 2.35, side y 0.25..3.15,
               deck y 3.02

SIX root elements in ONE glTF (display fan-out along X only — integrators
placing single pieces zero the root offset; see out/README.txt):
  plates   — welded scrap plate set (hull-side patchwork skirt)
  prow     — spike/ram V-plow for the glacis
  trophies — chained trophy rack (helmet / jerry can / scrap plaque)
  totem    — skull-and-bolts totem pole  (required piece name)
  brazier  — flame-drum, emissive coals + child piece `flame` (idle flicker)
  streamer — tied rag on a mast, team colour via team mask
All elements ground at Y=0, forward -Z, 1 unit = 1 m.  Atlas 1024
(dominant dim ~3.9 m < 15).
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas zones (1024²) ─────────────────────────────────────────────────
PLATES_F   = Zone((0,     0,  620, 280), ('x', 'y'), ((-1.95, 1.95), (1.78, -0.02)))
PLATES_B   = Zone((0,   280,  620, 420), ('x', 'y'), ((-1.95, 1.95), (1.78, -0.02)))
PLATES_TOP = Zone((0,   420,  620, 458), ('x', 'z'), ((-1.95, 1.95), (-0.12, 0.12)))
PROW_F     = Zone((620,   0, 1024, 168), ('x', 'y'), ((-1.90, 1.90), (1.42, 0.14)))
PROW_TOP   = Zone((620, 168, 1024, 226), ('x', 'z'), ((-1.90, 1.90), (-1.25, 0.12)))
RAG        = Zone((620, 226,  860, 280), ('x', 'y'), ((0.0, 0.80), (1.85, 1.25)))
SKULL_F    = Zone((620, 280,  760, 420), ('x', 'y'), ((-0.26, 0.26), (2.60, 2.08)))
SKULL_S    = Zone((760, 280,  900, 420), ('z', 'y'), ((-0.24, 0.24), (2.60, 2.08)))
SKULL_TOP  = Zone((900, 280, 1000, 376), ('x', 'z'), ((-0.26, 0.26), (-0.22, 0.22)))
TROPHY_A   = Zone((0,   460,  140, 600), ('x', 'y'), ((-0.72, -0.28), (1.58, 1.26)))
TROPHY_B   = Zone((140, 460,  280, 600), ('x', 'y'), ((-0.12, 0.24), (1.56, 1.04)))
TROPHY_C   = Zone((280, 460,  420, 600), ('x', 'y'), ((0.38, 0.78), (1.56, 1.20)))
COALS      = Zone((420, 460,  560, 600), ('x', 'z'), ((-0.36, 0.36), (-0.36, 0.36)))
FLAME      = Zone((560, 460,  780, 640), ('x', 'y'), ((-0.28, 0.28), (0.75, 0.0)))
DRUM       = Zone((780, 460, 1024, 560), ('x', 'y'), ((-0.38, 0.38), (0.96, 0.0)))
TOKEN      = Zone((780, 560,  920, 640), ('x', 'y'), ((-0.52, 0.52), (1.70, 1.36)))
TRIM       = Zone((780, 640,  930, 700), ('x', 'y'), ((-45, 45), (25, -5)))
DARK       = Zone((930, 640, 1024, 700), ('x', 'z'), ((-45, 45), (-45, 45)))
# raw rects (limb/tube cells)
SPIKE_R    = (0,   640, 180, 700)
POLE_R     = (180, 640, 420, 700)
CHAIN_R    = (420, 640, 520, 700)
BAR_R      = (520, 640, 660, 700)
MAST_R     = (660, 640, 780, 700)
HORN_R     = (0,   700, 120, 760)

# ── plates: welded scrap plate set (4 plates along X, front -Z) ─────────
# (cx, width, y_base, y_top, z_offset)
PLATE_SET  = [(-1.38, 1.10, 0.10, 1.55,  0.05),
              (-0.36, 1.00, 0.06, 1.72, -0.04),
              ( 0.56, 0.95, 0.12, 1.42,  0.05),
              ( 1.44, 0.98, 0.08, 1.62, -0.05)]
PLATE_T    = 0.11
PLATE_CH   = 0.03

# ── prow: spike/ram V-plow (apex -Z) ────────────────────────────────────
PROW_NOSE_HX = 0.14      # half-gap of the blunt nose at the apex
PROW_TAIL_X  = 1.82      # wing tail half-span (fable_tank half-width 1.75)
PROW_NOSE_Z  = -1.18
PROW_TAIL_Z  = 0.06
PROW_Y0      = 0.22
PROW_Y1      = 1.34
PROW_T       = 0.12      # plate thickness
# spikes: (t along wing 0..1, base y);  dir = wing normal + up tilt
PROW_SPIKES  = [(0.32, 1.02), (0.72, 0.88)]
SPIKE_LEN    = 0.55
SPIKE_R0     = 0.065
SPIKE_UP     = 0.35

# ── trophies: chained trophy rack ───────────────────────────────────────
RACK_HX    = 0.85        # upright x positions
RACK_H     = 2.15
RACK_BAR_Y = 2.10
# (chain x, trophy cy, size (w,h,d), chamfer, top y, zone name)
TROPHY_DEFS = [(-0.50, 1.42, (0.40, 0.26, 0.34), 0.09, 1.55),   # helmet
               ( 0.06, 1.30, (0.34, 0.46, 0.18), 0.04, 1.53),   # jerry can
               ( 0.58, 1.38, (0.36, 0.30, 0.07), 0.03, 1.53)]   # plaque
CHAIN_R0   = 0.018

# ── totem: skull-and-bolts totem pole (piece `totem`) ───────────────────
POLE_H     = 2.20
POLE_R0    = 0.15
POLE_R1    = 0.11
SKULL_C    = (0.0, 2.34, 0.0)
SKULL_SIZE = (0.48, 0.46, 0.40)
SKULL_CH   = 0.08
HORN_BASE  = (0.24, 2.44, 0.0)
HORN_TIP   = (0.52, 2.72, -0.06)
XBAR_Y     = 1.72
XBAR_HX    = 0.62
XBAR_R     = 0.045
TOKEN_X    = 0.40        # hanging scrap tokens at ±TOKEN_X off the crossbar
TOKEN_W    = 0.20
TOKEN_Y0   = 1.38
TOKEN_Y1   = 1.68

# ── brazier: flame-drum (open fire drum, ground prop) ───────────────────
DRUM_RINGS = [(0.02, 0.30), (0.16, 0.37), (0.92, 0.34)]   # (y, radius)
DRUM_N     = 8
RIM_Y      = 0.92        # coals cap / flame piece mount
FLAME_H    = 0.72
FLAME_HW0  = 0.26        # half-width at the base
FLAME_HW1  = 0.09        # half-width at the tip

# ── streamer: team rag on a mast ────────────────────────────────────────
MAST_H     = 1.85
MAST_R0    = 0.040
MAST_R1    = 0.028
# rag segments: quads between vertical edges (planar by construction)
RAG_EDGES  = [(0.04, 1.82, 1.34, 0.00),      # (x, y_top, y_bot, z)
              (0.40, 1.74, 1.30, 0.06),
              (0.74, 1.68, 1.36, -0.03)]

# ── root piece offsets (display fan-out only) ───────────────────────────
PLATES_OFF   = (0.0, 0.0, 0.0)
PROW_OFF     = (-5.0, 0.0, 0.0)
BRAZIER_OFF  = (-8.2, 0.0, 0.0)
RACK_OFF     = (4.0, 0.0, 0.0)
TOTEM_OFF    = (6.6, 0.0, 0.0)
STREAMER_OFF = (8.6, 0.0, 0.0)
