"""ms_anc_siege_platform_layout — zones + dims for the ancient siege mortar.

ANCIENT REGISTER. A 22 m square monolithic platform — inverted three-step
ziggurat whose 22 m deck CANTILEVERS 2.6 m clear of the buried plinth on
every side — with a perfectly circular emplacement well sunk into the deck
and a colossal breech-ring mortar standing in it. Standard aim chain:
`turret` is the rotating ring mount (annular monolith, cyan charge glyphs
banded around its outer face), `barrel` is the 8 m bore tube pivoting from
trunnion bosses on the ring's inner cheeks, `muzzle` is an empty at the
bore mouth. Two frozen loading arms cantilever off the rear deck holding a
charge shell above the breech, four corner pylons taper up to 8.2 m, and
three unsupported halo arcs float free above the deck at 6.6-7.2 m.
Nothing bolted, nothing patched: unbroken surfaces cut by clean recessed
seams, geological weathering only (soil burial at the plinth, dust drift on
the deck, muzzle scorch). CAPTURABLE — team-mask panel on the mid skirt.

World frame: RH, barrel rests along -Z, up +Y, ground Y=0. 2048² atlas.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

A = 2048

# ── platform: inverted ziggurat, cantilevered deck ───────────────────────
PLINTH = (0.0, 0.60, 0.0, 16.8, 1.20, 16.8)   # cx,cy,cz,w,h,d   y 0.00-1.20
MID    = (0.0, 1.65, 0.0, 19.4, 0.90, 19.4)   #                  y 1.20-2.10
DECK   = (0.0, 2.60, 0.0, 22.0, 1.00, 22.0)   #                  y 2.10-3.10
DECK_CH   = 0.22
DECK_TOP  = 3.10
DECK_HALF = 11.0 - DECK_CH        # deck top face half-extent (chamfer inset)
MID_TOP   = 2.10
PLINTH_TOP = 1.20

# ── emplacement well (perfect circle sunk into the deck) ─────────────────
WELL_R    = 6.30
WELL_Y    = 2.00                  # well floor
WELL_N    = 32
CURB_R    = 7.20                  # raised rim curb around the well mouth
CURB_TOP  = 3.58

# ── turret: rotating ring mount (piece-local, origin on the well floor) ──
RING_OFF   = (0.0, WELL_Y, 0.0)
RING_N     = 32
RING_FLARE_R = 6.00               # base flare radius at local y 0
RING_OUT_R = 5.50
RING_IN_R  = 4.00
RING_FLARE_H = 0.55
RING_TOP   = 2.75                 # local; world 4.75 (1.65 proud of the deck)
CHEEK_X    = 3.55                 # trunnion cheek centre |x| (inside the ring)
CHEEK_TOP  = 4.90                 # local; world 6.90
PIVOT_Y    = 4.30                 # local; world 6.30 — barrel piece offset

# ── barrel: colossal 8 m breech-ring bore tube (local, mouth at -Z) ──────
BARREL_N   = 16
BREECH_Z   = 1.30
MOUTH_Z    = -6.70                # 8.00 m breech face -> mouth
BORE_STATIONS = [(1.30, 0.74), (1.14, 1.85), (0.20, 1.85), (0.04, 1.32),
                 (-2.20, 1.26), (-4.60, 1.18), (-6.24, 1.12),
                 (-6.44, 1.40), (-6.70, 1.40)]
MUZZLE_OFF = (0.0, 0.0, MOUTH_Z)

# ── loading arms, frozen holding a charge shell (on `body`) ──────────────
ARM_BASE   = (4.20, DECK_TOP, 8.80)
ARM_MID    = (3.85, 6.10, 8.10)
ARM_GRIP   = (1.15, 8.90, 5.60)
SHELL_C    = (0.0, 8.90, 5.40)
SHELL_N    = 12
SHELL_STATIONS = [(1.60, 0.16), (1.20, 0.72), (0.20, 1.00), (-0.90, 0.94),
                  (-1.45, 0.62), (-1.60, 0.30)]

# ── corner pylons (square-section monoliths, cyan tracery slit) ──────────
PYL_XZ     = 9.45
PYL_TOP_XZ = 8.85                 # leans inboard
PYL_TOP_Y  = 9.60
PYL_R0, PYL_R1 = 1.55, 0.90

# ── floating halo arcs (unsupported, broken helix) ───────────────────────
HALO_R     = 7.70
HALO_W, HALO_H = 0.58, 0.44
HALO_SEG   = 8
HALO_ARCS  = [(  4.0, 108.0, 6.60, 6.86),
              (124.0, 228.0, 6.90, 7.14),
              (244.0, 348.0, 7.18, 6.62)]

DOMINANT   = 22.0                 # 22 m square platform


# ── atlas zones (2048²; v down) ──────────────────────────────────────────
# platform
R_DECK    = Zone((   0,    0,  896,  896), ('x', 'z'), ((-DECK_HALF, DECK_HALF),
                                                        (-DECK_HALF, DECK_HALF)))
R_DECK_S  = Zone((   0,  896,  896, 1008), ('z', 'y'), ((-11.0, 11.0), (3.14, 2.06)))
R_DECK_SF = Zone((   0,  896,  896, 1008), ('x', 'y'), ((-11.0, 11.0), (3.14, 2.06)))
R_MID_S   = Zone((   0, 1008,  896, 1120), ('z', 'y'), ((-9.7, 9.7), (2.14, 1.16)))
R_MID_SF  = Zone((   0, 1008,  896, 1120), ('x', 'y'), ((-9.7, 9.7), (2.14, 1.16)))
R_PLIN_S  = Zone((   0, 1120,  896, 1248), ('z', 'y'), ((-8.4, 8.4), (1.24, -0.10)))
R_PLIN_SF = Zone((   0, 1120,  896, 1248), ('x', 'y'), ((-8.4, 8.4), (1.24, -0.10)))
R_MID_T   = Zone(( 896,    0, 1152,  256), ('x', 'z'), ((-9.7, 9.7), (-9.7, 9.7)))
R_PLIN_T  = Zone((1152,    0, 1408,  256), ('x', 'z'), ((-8.4, 8.4), (-8.4, 8.4)))

# well
R_WELL_F  = Zone(( 896,  256, 1152,  512), ('x', 'z'), ((-WELL_R, WELL_R),
                                                        (-WELL_R, WELL_R)))
R_WELLW   = ( 896,  512, 1408,  576)      # parametric: u around, v depth

# ring mount (turret)
R_RING_T  = Zone((1408,    0, 1792,  384), ('x', 'z'), ((-RING_OUT_R, RING_OUT_R),
                                                        (-RING_OUT_R, RING_OUT_R)))
R_RING_O  = (   0, 1248, 2048, 1376)      # outer wrap — charge glyph band
R_RING_I  = (   0, 1376, 1024, 1440)      # inner wrap
R_RING_B  = (1024, 1376, 2048, 1440)      # base flare wrap
R_CHEEK   = Zone((1792,    0, 2048,  208), ('z', 'y'), ((-2.30, 2.30), (4.95, -0.45)))
R_CHEEK_F = Zone((1792,  208, 2048,  288), ('x', 'y'), ((-0.78, 0.78), (4.95, -0.45)))
R_BOSS    = (1792,  288, 2048,  352)      # trunnion boss wrap

# barrel
R_TUBE    = (   0, 1440, 2048, 1600)      # u along the bore, v around
R_BREECH  = Zone((1408,  384, 1664,  640), ('x', 'y'), ((-0.66, 0.66), (0.66, -0.66)))
R_BORE    = Zone((1664,  384, 1920,  640), ('x', 'y'), ((-1.26, 1.26), (1.26, -1.26)))

# dressing
R_ARM     = (   0, 1600, 1024, 1664)
R_PYLON   = (1024, 1600, 2048, 1664)
R_SHELL   = (   0, 1664, 1024, 1792)
R_SHELL_C = Zone((1024, 1664, 1152, 1792), ('x', 'y'), ((-0.34, 0.34), (0.34, -0.34)))
R_HALO    = (   0, 1792, 2048, 1856)
R_DARK    = Zone((1920,  384, 2048,  512), ('x', 'z'), ((-60, 60), (-60, 60)))
