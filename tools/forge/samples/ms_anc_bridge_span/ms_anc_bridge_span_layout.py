"""ms_anc_bridge_span_layout — zones + dims for ms_anc_bridge_span.

ANCIENT REGISTER terrain feature: a 36 m self-supporting monolithic bridge
segment from the world-before.  One impossible shallow arc — the deck runs
dead level while the soffit sweeps UP toward mid-span, thinning the whole
structure from a 3.2 m haunch at the plinths to a 0.65 m blade at the
centre, with nothing under it.  Seamless deck plates with a recessed cyan
guide-line down the centre; a perfect circle of alloy threads around the
span at mid-span, touching nothing.  No rivets, no bolts, no patches.

TILEABLE along z: the deck cross-section at z = -18 and z = +18 is
identical and full width, and the plinth footings are HALF piers hugging
each end (z 16.5..18.0) so two chained segments merge into one 3.0 m pier.

Static, single `body` piece, no clips, no team colour.
Frame: forward -Z, up +Y, ground Y=0, 1 u = 1 m.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── tileable envelope ────────────────────────────────────────────────────
Z0, Z1     = -18.0, 18.0             # exact tile ends
HW         = 5.4                     # deck half width (10.8 m overall)
DTOP       = 7.0                     # deck running surface
EDGE       = 0.55                    # deck fascia depth (cantilever lip)

# ── the impossible arc: soffit rises toward mid-span ─────────────────────
T_MIN      = 0.55                    # blade thickness at mid-span
T_MAX      = 3.60                    # haunch thickness at the plinths
BW_END     = 4.30                    # soffit half width at the ends
BW_DIP     = 0.60                    # extra inset at mid-span (waisted blade)
STATIONS   = 41                      # loft stations across z (step 0.9 m)

# ── centre guide channel (recessed, cyan) ────────────────────────────────
CHW        = 0.40                    # channel half width
CH         = 0.12                    # channel depth

# ── parapets: unbroken monolithic walls, inset from the deck edge ────────
PARA_XC    = 4.60
PARA_W     = 0.70                    # x 4.25 .. 4.95, leaves a 0.45 m ledge
PARA_H     = 1.35                    # top at y 8.35
SEAM_Z     = [-13.5, -9.0, -4.5, 0.0, 4.5, 9.0, 13.5]   # recessed seam lines

# ── plinth footings: HALF piers at each tile end ─────────────────────────
PIER_ZC    = 17.25                   # z 16.5 .. 18.0
PIER_D     = 1.50
PIER_W     = 8.20                    # narrower than the blade -> top buried
PIER_H     = 4.30
PAD_ZC     = 17.175                  # z 16.35 .. 18.0
PAD_D      = 1.65
PAD_W      = 10.40
PAD_H      = 0.85

# ── mid-span ring: a perfect circle threaded around the span ─────────────
RING_CY    = 7.0                     # centre at deck level, z = 0
RING_RI    = 5.55                    # clears the 5.4 deck half width
RING_RO    = 6.45
RING_D     = 1.10                    # z -0.55 .. +0.55
RING_N     = 56                      # segments (perfect-circle read)
# bottom of the ring sits at y = 0.55 — it touches nothing.

# ── atlas zones (2048²; v runs down) ─────────────────────────────────────
# column A — the long z-running surfaces
Z_DECK    = Zone((0,    0,    1600, 480),  ('z', 'x'), ((Z0, Z1), (-5.4, 5.4)))
Z_GUIDE   = Zone((0,    488,  1600, 528),  ('z', 'x'), ((Z0, Z1), (-0.40, 0.40)))
Z_GUIDEW  = Zone((0,    536,  1600, 560),  ('z', 'y'), ((Z0, Z1), (7.00, 6.88)))
Z_FASCIA  = Zone((0,    568,  1600, 640),  ('z', 'y'), ((Z0, Z1), (7.00, 6.45)))
Z_HAUNCH  = Zone((0,    648,  1600, 828),  ('z', 'y'), ((Z0, Z1), (6.55, 3.30)))
Z_SOFFIT  = Zone((0,    836,  1600, 1100), ('z', 'x'), ((Z0, Z1), (-4.35, 4.35)))
Z_PARA    = Zone((0,    1108, 1600, 1220), ('z', 'y'), ((Z0, Z1), (8.36, 6.98)))
Z_PARAT_R = Zone((0,    1228, 1600, 1276), ('z', 'x'), ((Z0, Z1), (4.95, 4.25)))
Z_PARAT_L = Zone((0,    1228, 1600, 1276), ('z', 'x'), ((Z0, Z1), (-4.25, -4.95)))

# column B — plinths, ring bands, dark ends
Z_PIERF   = Zone((1610, 0,    1990, 148),  ('x', 'y'), ((-5.6, 5.6), (4.45, -0.15)))
Z_PIERX_P = Zone((1610, 158,  1680, 306),  ('z', 'y'), ((16.30, 18.10), (4.45, -0.15)))
Z_PIERX_N = Zone((1610, 158,  1680, 306),  ('z', 'y'), ((-16.30, -18.10), (4.45, -0.15)))
Z_PLINTH  = Zone((1690, 158,  1990, 306),  ('x', 'y'), ((-6.5, 6.5), (0.95, -0.15)))
Z_DARK    = Zone((1610, 480,  1740, 610),  ('x', 'z'), ((-60, 60), (-60, 60)))

# ring cells take explicit per-vertex UVs (u = angle, v = across the band)
R_RING_O  = (1610, 316, 1990, 376)   # outer band
R_RING_I  = (1610, 386, 1990, 446)   # inner band — the glowing rim
R_RING_F  = (1750, 480, 1990, 700)   # front/back annulus faces (v = radius)
