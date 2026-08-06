"""ms_anc_harvester_layout — zones + dims for ms_anc_harvester.

ANCIENT REGISTER. Harvester crawler, s3 resource unit, 18.0 m nose-to-tail
(drum lip z=-9.15 .. discharge lip z=+8.85). A monolithic crawler hull riding
on two SEALED track skirts (tracks implied by geometry only — no axles, no
road wheels, no bogies), a face-wide rotating extraction drum slung under a
grand cantilevered hood, a dorsal ore hopper with cyan sort-lines, and a
discharge chute cantilevered aft over open air.

Nothing bolted, nothing patched: large unbroken surfaces divided by clean
recessed seams. Emissive CYAN only — ACTIVE (this machine still works), so
the tracery flows rather than smoulders. Weathering is geological: soil
burial at the skirts, dust drifts on horizontal ledges, scorch by the drum.

Pieces: body / skirt_l / skirt_r / drum / hopper / chute.
CAPTURABLE — the team mask lives in one continuous band around the hopper.

World frame: forward=-Z, up=+Y, left=+X, ground Y=0, 1 unit = 1 m.
Single source of truth for BOTH the geometry generator (UV projection)
and the texture painter.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

W = 2048

# ── atlas zones (2048²; v down) ─────────────────────────────────────────
# rect = (x0, y0, x1, y1) px; axes/win = planar projection window.
# Rects marked "parametric" are raw tuples consumed by limb()/custom UVs.

# left column ------------------------------------------------------------
A_HULL_TOP     = Zone((0, 0, 620, 1300),      ('x', 'z'), ((-3.10, 3.10), (-6.60, 6.40)))
A_HOPPER_FRONT = Zone((0, 1300, 620, 1600),   ('x', 'y'), ((-3.10, 3.10), (5.15, 2.45)))
A_HOPPER_REAR  = Zone((0, 1600, 620, 1900),   ('x', 'y'), ((3.10, -3.10), (5.15, 2.45)))
A_HULL_FRONT   = Zone((0, 1900, 620, 2048),   ('x', 'y'), ((-2.95, 2.95), (3.25, 0.90)))

# long horizontal strips -------------------------------------------------
A_HULL_SIDE    = Zone((620, 0, 1920, 260),    ('z', 'y'), ((-6.60, 6.40), (3.25, 0.85)))
A_SKIRT_SIDE   = Zone((620, 260, 1920, 520),  ('z', 'y'), ((-6.70, 6.60), (1.95, -0.05)))
A_SKIRT_WRAP   = (620, 520, 1920, 610)        # parametric (arc length x half-width)
A_SKIRT_TOP    = Zone((620, 610, 1920, 700),  ('z', 'x'), ((-6.70, 6.60), (-0.62, 0.62)))

# mid band ---------------------------------------------------------------
A_HOPPER_SIDE  = Zone((620, 700, 1520, 1000), ('z', 'y'), ((-4.30, 4.10), (5.15, 2.45)))
A_ARM_OUT      = Zone((1520, 700, 1900, 1000), ('z', 'y'), ((-8.85, -5.35), (3.55, 0.55)))
A_ARM_TRIM     = Zone((1900, 700, 2048, 1000), ('z', 'y'), ((-8.85, -5.35), (3.55, 0.55)))

A_HOPPER_TOP   = Zone((620, 1000, 1180, 1620), ('x', 'z'), ((-2.85, 2.85), (-4.15, 3.95)))
A_HULL_REAR    = Zone((620, 1620, 1180, 1900), ('x', 'y'), ((2.95, -2.95), (3.25, 0.90)))
A_CHUTE_SIDE   = Zone((620, 1900, 1180, 2048), ('z', 'y'), ((-0.20, 5.45), (0.75, -1.95)))

A_HOOD_OUT     = (1180, 1000, 1800, 1200)     # parametric (arc length x width)
A_HOOD_IN      = (1180, 1200, 1800, 1360)     # parametric
A_HOOD_EDGE    = (1180, 1360, 1800, 1440)     # parametric
A_DRUM_BARREL  = (1180, 1440, 1800, 1760)     # parametric (ONE flute period x width)
A_CHUTE_EDGE   = (1180, 1760, 1240, 2048)     # parametric (thin rim wrap)
A_CHUTE_IN     = Zone((1240, 1760, 1800, 2048), ('x', 'z'), ((-1.70, 1.70), (-0.20, 5.45)))

# right column -----------------------------------------------------------
A_DRUM_CAP     = Zone((1800, 1000, 2048, 1248), ('z', 'y'), ((-1.80, 1.80), (1.80, -1.80)))
A_CHUTE_OUT    = Zone((1800, 1248, 2048, 1440), ('x', 'z'), ((-1.70, 1.70), (-0.20, 5.45)))
A_DARK         = Zone((1800, 1440, 1924, 1564), ('x', 'z'), ((-3.10, 3.10), (-6.60, 6.40)))
# A_CORE — the hopper's inner rim channel (lit cyan sort-throat)
A_CORE         = Zone((1924, 1440, 2048, 1564), ('x', 'z'), ((-2.95, 2.95), (-4.15, 3.95)))
# A_TRIM_BOX — the forward core disc's rim band
A_TRIM_BOX     = Zone((1800, 1564, 1924, 1688), ('x', 'y'), ((-0.90, 0.90), (3.10, 2.80)))
A_TRIM         = (1924, 1564, 2048, 1688)     # parametric wrap (spare)
# A_GLYPH — the forward core disc face (window centred on the disc)
A_GLYPH        = Zone((1800, 1688, 2048, 2048), ('x', 'z'), ((-1.00, 1.00), (-5.95, -3.95)))

# ── design constants ────────────────────────────────────────────────────

LENGTH = 18.03                         # -9.18 (drum lip) .. +8.85 (chute lip)

# hull loft sections, 10-point ring:
# (z, y_bot, y_waist, y_shoulder, y_deck, y_top,
#     w_bot, w_waist, w_shoulder, w_deck, w_top)
HULL_SECTIONS = [
    (-5.80, 1.28, 1.75, 2.20, 2.55, 2.78, 2.25, 2.80, 2.86, 2.62, 1.85),
    (-4.20, 1.08, 1.65, 2.20, 2.62, 2.86, 2.58, 3.00, 3.06, 2.80, 2.05),
    (-1.20, 0.98, 1.58, 2.18, 2.66, 2.92, 2.70, 3.06, 3.10, 2.86, 2.15),
    (2.20,  0.98, 1.58, 2.18, 2.64, 2.90, 2.70, 3.06, 3.10, 2.86, 2.15),
    (4.60,  1.06, 1.66, 2.20, 2.58, 2.82, 2.55, 2.96, 3.00, 2.76, 2.02),
    (6.20,  1.40, 1.90, 2.24, 2.48, 2.66, 2.10, 2.50, 2.55, 2.32, 1.70),
]

# dorsal plinth the hopper sinks into (unbroken collar, body geometry)
PLINTH = (0.0, 2.98, -0.20, 5.10, 0.36, 8.40)      # x,y,z, w,h,d

# forward core disc — perfect circle, ancient tracery, ACTIVE cyan
CORE_DISC = (0.0, 2.86, -4.95)
CORE_R    = 0.74
CORE_H    = 0.16
CORE_N    = 16

# ── sealed track skirts (piece-local; mirrored for skirt_r) ─────────────
SKIRT_OFF   = (3.08, 0.0, 0.0)
SKIRT_HALF_W = 0.52
SKIRT_PROFILE = [                       # local (z, y), CCW in the z/y plane
    (-6.55, 1.05), (-6.05, 0.32), (-5.20, 0.04), (4.90, 0.04),
    (5.90, 0.32), (6.45, 1.05),
    (6.45, 1.74), (5.60, 1.88), (-5.60, 1.88), (-6.45, 1.74),
]
SKIRT_FAIRING = (0.0, 1.90, 0.0, 1.12, 0.10, 11.60)   # x,y,z, w,h,d (local)

# ── extraction drum (piece `drum`; idle slow rotation about X) ──────────
DRUM_OFF   = (0.0, 1.78, -7.50)
DRUM_R     = 1.58
DRUM_N     = 24                        # 12 flutes -> 12-fold symmetric paint
DRUM_FLUTE = 0.90                      # inner radius factor on odd vertices
DRUM_HALF  = 3.20                      # UV normalisation half-width
# (x station, radius scale)
DRUM_STATIONS = [(-3.20, 0.72), (-2.92, 1.00), (-0.56, 1.00), (-0.48, 1.06),
                 (0.48, 1.06), (0.56, 1.00), (2.92, 1.00), (3.20, 0.72)]

# ── cantilevered hood over the drum (body geometry) ────────────────────
HOOD_CTR    = (1.78, -7.50)            # (y, z) — concentric with the drum
HOOD_R_OUT  = 2.06
HOOD_R_IN   = 1.79
# stops short of the drum's crown so the cutting face stays readable
HOOD_ANGLES = [-62.0, -34.0, -8.0, 16.0, 34.0]  # deg from +Y toward -Z
HOOD_HALF_W = 3.05

# ── drum bearing cantilevers (body geometry, one per side, +X shown) ────
ARM_BOX   = (3.46, 2.38, -6.60, 0.42, 1.46, 2.20)  # x,y,z, w,h,d
BOSS_CTR  = (3.52, 1.78, -7.50)
BOSS_R    = 1.06
BOSS_HALF = 0.17
BOSS_N    = 16                         # perfect circle read

# ── dorsal ore hopper (piece `hopper`) ─────────────────────────────────
HOPPER_OFF = (0.0, 2.50, -0.10)
# (y_local, half_x, z0, z1, corner_cut)
HOPPER_RINGS = [
    (0.00, 2.30, -3.50, 3.30, 0.50),
    (1.30, 2.80, -3.95, 3.75, 0.55),
    (2.55, 2.90, -4.05, 3.85, 0.55),
]
HOPPER_LIP = (2.42, 2.58, -3.72, 3.52, 0.48)       # inner rim -> ore surface
HOPPER_TEAM_Y = (4.30, 4.88)           # world y band, CAPTURABLE team mask
HOPPER_SORT_Z = [-3.1, -2.2, -1.3, -0.4, 0.5, 1.4, 2.3, 3.1]   # cyan sort-lines

# ── discharge chute (piece `chute`, cantilevered aft) ──────────────────
CHUTE_OFF   = (0.0, 3.55, 3.60)
CHUTE_LEN   = 5.25                     # local z 0 .. 5.25 (world 3.60 .. 8.85)
CHUTE_DROP  = 1.45                     # local y 0 .. -1.45
CHUTE_HW0   = 1.62                     # half width at the root
CHUTE_HW1   = 1.20                     # half width at the lip
CHUTE_WALL  = 0.62                     # wall height at the root
CHUTE_WALL1 = 0.44                     # wall height at the lip
CHUTE_TH    = 0.14                     # floor thickness
