"""ms_shanty_block_layout — zones + dims for ms_shanty_block (civilian shanty block).

16x16 m stacked shanty block: corrugated shacks piled 2-3 storeys with
offset footprints, external stairs + ladders, water drums, laundry line
(piece `line`, idle sway), stove-pipe chimneys, sparse lit windows.
Civilian estate register, mismatched panels. No team colour.
World frame: -Z forward, +Y up, ground Y=0. 2048^2 atlas (16 m >= 15 m).
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
PAD = (0.0, 0.05, 0.0, 16.0, 0.1, 16.0)         # packed-earth base slab
PAD_TOP = 0.1

# shacks: (cx, cy, cz, w, h, d) — storey 1
A = (-3.6, PAD_TOP + 1.25, -3.2, 7.2, 2.5, 6.4)   # top 2.6
B = (3.4,  PAD_TOP + 1.30, -2.4, 5.6, 2.6, 7.2)   # top 2.7
C = (-2.6, PAD_TOP + 1.20, 3.8, 8.0, 2.4, 5.6)    # top 2.5
D = (5.2,  PAD_TOP + 1.10, 4.6, 4.0, 2.2, 4.4)    # top 2.3
# storey 2 (offset footprints)
E = (-4.2, 2.6 + 1.15, -2.4, 5.6, 2.3, 5.2)       # on A, top 4.9
F = (3.9,  2.7 + 1.20, -3.0, 4.8, 2.4, 5.2)       # on B, top 5.1
G = (-1.8, 2.5 + 1.10, 3.4, 5.2, 2.2, 4.4)        # on C, top 4.7
# storey 3
H = (3.2,  5.1 + 1.00, -3.6, 3.4, 2.0, 3.6)       # on F, top 7.1
SHACKS_1 = (A, B, C, D)
SHACKS_2 = (E, F, G)
SHACKS_3 = (H,)
ROOF_LIP = 0.5                                    # roof slab overhang (total)
ROOF_T = 0.08

# external stairs (west face of A), landing + railing
STAIR_BASE = (-7.5, PAD_TOP, 1.4)
STAIR_TOP = (-7.5, 2.6, -0.6)
STAIR_W = 1.0
LANDING = (-7.5, 2.65, -1.35, 1.2, 0.1, 1.5)
RAIL_A = (-8.02, 2.7, -2.05)
RAIL_B = (-8.02, 2.7, 1.5)

# ladders: ground -> B roof, B roof -> F roof
LAD1 = ((6.28, PAD_TOP, 0.2), (6.28, 2.7, 0.2))
LAD2 = ((6.38, 2.7, -3.0), (6.38, 5.1, -3.0))

# water drums (yard gap between B and D)
DRUM_ORIGIN = (4.8, PAD_TOP, 1.8)
DRUM_N = 3
DRUM_R = 0.30
DRUM_H = 0.92

# stove-pipe chimneys: (x, base_y, z, top_y)
CHIMNEYS = [(-5.4, 4.90, -3.6, 6.2),
            (-3.0, 4.70, 4.4, 5.9),
            (2.2, 7.10, -4.6, 8.4)]
CHIM_R = 0.07

# laundry line (piece `line`): pole1 -> pole2 along +X, yard south edge
POLE1 = (1.0, 7.3)                                # x, z (base at PAD_TOP)
POLE2 = (6.4, 7.3)
POLE_H = 2.25                                     # pole top y = PAD_TOP + H
LINE_OFF = (POLE1[0], PAD_TOP + POLE_H, POLE1[1]) # piece origin (pole1 top)
LINE_SPAN = POLE2[0] - POLE1[0]                   # 5.4, local +X
LINE_SAG = 0.10
CLOTH_XS = (0.7, 1.55, 2.5, 3.45, 4.45)           # local hang positions
CLOTH_W = (0.65, 0.5, 0.8, 0.55, 0.7)
CLOTH_H = (0.75, 0.55, 0.85, 0.6, 0.7)

# ── atlas zones (2048^2; v down) ─────────────────────────────────────────
C_PAD = Zone((0, 0, 896, 896), ('x', 'z'), ((-8.2, 8.2), (-8.2, 8.2)))
# wall bands per storey — X-facing and Z-facing variants share one rect
W1R = (896, 0, 2048, 352)
W2R = (896, 352, 2048, 704)
W3R = (896, 704, 2048, 1056)
C_W1X = Zone(W1R, ('z', 'y'), ((-8.2, 8.2), (2.85, -0.05)))
C_W1Z = Zone(W1R, ('x', 'y'), ((-8.2, 8.2), (2.85, -0.05)))
C_W2X = Zone(W2R, ('z', 'y'), ((-8.2, 8.2), (5.25, 2.35)))
C_W2Z = Zone(W2R, ('x', 'y'), ((-8.2, 8.2), (5.25, 2.35)))
C_W3X = Zone(W3R, ('z', 'y'), ((-8.2, 8.2), (7.25, 4.95)))
C_W3Z = Zone(W3R, ('x', 'y'), ((-8.2, 8.2), (7.25, 4.95)))
C_ROOF = Zone((0, 896, 896, 1792), ('x', 'z'), ((-8.4, 8.4), (-8.4, 8.4)))
# stairs / landing
C_TREAD = Zone((896, 1056, 1408, 1184), ('x', 'z'), ((-8.2, -6.8), (-2.2, 1.6)))
C_SIDE = Zone((896, 1184, 1408, 1312), ('z', 'y'), ((-2.2, 1.6), (2.9, -0.05)))
C_MAST = (1408, 1056, 2048, 1120)                 # pipes/poles/ladders (rect)
C_DRUM = Zone((1408, 1120, 1664, 1312), ('x', 'y'),
              ((4.4, 6.6), (1.15, -0.05)))
C_CLOTH = Zone((1408, 1312, 1920, 1536), ('x', 'y'),
               ((-0.1, 5.5), (0.05, -1.0)))       # line-piece LOCAL coords
C_DARK = Zone((1920, 1312, 2048, 1440), ('x', 'z'), ((-30, 30), (-30, 30)))
