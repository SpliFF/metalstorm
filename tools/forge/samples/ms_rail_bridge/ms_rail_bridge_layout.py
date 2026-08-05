"""ms_rail_bridge_layout — zones + dims for ms_rail_bridge.

Terrain feature: 24 m deck-truss rail bridge SEGMENT, tileable end to
end.  Deck, girders, chords and rails all run EXACTLY z -12..12 with no
end chamfer so copies placed 24 m apart butt seamlessly.  Track on top:
two rails on a 1.5 m gauge (rail centrelines x = ±0.75).  Truss lives
BELOW the deck (deck-truss): side girders, bottom chords, verticals +
diagonals, cross beams.  Two concrete pier footings at z = ±6 carry the
bottom chords to the ground.  Static, single `body` piece, no clips, no
team colour.  World frame: forward -Z, up +Y, ground Y=0, 1 u = 1 m.

NOTE for integrators: rail head tops out at RAIL_Y1 (4.15 m); spawn
rolling stock with +RAIL_Y1 y offset over ground level at the bridge, or
sink the bridge so the deck meets the abutment grade.  Tiling: place
copies at 24 m intervals along z (segment spans z ±12 exactly).
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
Z_DECK   = Zone((0,    0,    1536, 288),  ('z', 'x'), ((-12.0, 12.0), (-2.1, 2.1)))
Z_UNDER  = Zone((0,    288,  1536, 480),  ('z', 'x'), ((-12.0, 12.0), (-2.1, 2.1)))
Z_GIRD   = Zone((0,    480,  1536, 576),  ('z', 'y'), ((-12.0, 12.0), (3.85, 2.85)))
Z_CHORD  = Zone((0,    576,  1536, 640),  ('z', 'y'), ((-12.0, 12.0), (1.65, 1.1)))
Z_KERB   = Zone((0,    640,  1536, 688),  ('z', 'y'), ((-12.0, 12.0), (4.2, 3.75)))
Z_TRUSS  = Zone((1536, 0,    1792, 256),  ('z', 'y'), ((-14, 14), (5, -1)))
Z_DARK   = Zone((1792, 0,    2048, 128),  ('x', 'z'), ((-14, 14), (-14, 14)))
Z_RAILT  = Zone((1536, 256,  2048, 320),  ('z', 'x'), ((-12.0, 12.0), (0.6, 0.9)))
Z_RAIL   = Zone((1536, 320,  2048, 384),  ('z', 'y'), ((-12.0, 12.0), (4.16, 3.9)))
Z_SLEEP  = Zone((1536, 384,  2048, 448),  ('z', 'x'), ((-14, 14), (-1.4, 1.4)))
Z_PIER   = Zone((1536, 448,  2048, 832),  ('x', 'y'), ((-2.3, 2.3), (1.4, -0.1)))
Z_PIERT  = Zone((1536, 832,  2048, 960),  ('x', 'z'), ((-2.3, 2.3), (-1.3, 1.3)))

# ── deck (all z extents EXACT ±12 — tileable, no end chamfer) ────────────
SEG_Z0, SEG_Z1 = -12.0, 12.0
DECK_W   = 4.0                       # deck slab width (x -2..2)
DECK_Y0, DECK_Y1 = 3.4, 3.8          # slab bottom / top
KERB_X   = 1.85                      # kerb strip centreline
KERB_W, KERB_H = 0.3, 0.35           # kerb section (top at 4.15)

# ── side girders + truss below the deck ─────────────────────────────────
GIRD_X   = 1.85                      # girder/truss plane
GIRD_Y0, GIRD_Y1 = 2.9, 3.4          # girder web (under deck edge)
GIRD_W   = 0.3
CHORD_X  = 1.8
CHORD_Y0, CHORD_Y1 = 1.15, 1.6       # bottom chord box
CHORD_W  = 0.32
VERT_Z   = [-10.5, -7.5, -4.5, -1.5, 1.5, 4.5, 7.5, 10.5]  # panel points
VERT_R   = 0.10                      # vertical member radius
DIAG_R   = 0.085
XBEAM    = (0.3, 0.28)               # cross-beam w(x-section), h

# ── track (1.5 m gauge) ─────────────────────────────────────────────────
GAUGE    = 1.5
RAIL_X   = GAUGE / 2                 # rail centrelines ±0.75
RAIL_W   = 0.22
RAIL_Y0, RAIL_Y1 = 3.93, 4.15        # rail web bottom / head top
SLEEP_W  = 2.6                       # sleeper length across track
SLEEP_H  = 0.14
SLEEP_D  = 0.5
SLEEP_ZS = [x * 1.6 - 11.2 for x in range(15)]   # 15 sleepers, ends clear of ±12

# ── pier footings ───────────────────────────────────────────────────────
PIER_Z   = [-6.0, 6.0]
PIER     = (3.9, 1.2, 1.5)           # pier w, h (0..1.2), d
FOOT     = (4.4, 0.35, 2.1)          # spread footing w, h, d
