"""ms_ancient_hulk_layout — zones + dims for ms_ancient_hulk.

UNIQUE ~100 m terrain feature: monolithic ancient-tech warship beached
at a permanent list, bow (-Z) driven up onto land, stern (+Z) toward
water. Authored UPRIGHT (keel y=0, like a floating hull) so the planar
zone projections stay clean, then the whole body is baked through a
roll(list) + pitch(bow-up) + sink transform in gen. Berm, bow mound and
ground shards are added AFTER the transform, in world frame, so they
sit on the world ground plane Y=0.

Ancient register: smooth segmented monolith (segment steps in the loft,
no rivets), cyan tracery on the -X flank only (the flank the list tilts
up toward the horizon), hull breach on that same flank revealing a
glowing chamber, collapsed masts, sand berm on the grounded +X side.
Static: single `body` piece, no clips, no team. 2048 atlas (100 m).
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
S_HULL_HI = Zone((0,    0,    2048, 300),  ('z', 'y'), ((-50, 50), (14.8, -0.5)))
S_HULL_LO = Zone((0,    300,  2048, 600),  ('z', 'y'), ((-50, 50), (14.8, -0.5)))
S_DECK    = Zone((0,    600,  2048, 850),  ('z', 'x'), ((-50, 50), (-7.7, 7.7)))
S_BELLY   = Zone((0,    850,  2048, 1050), ('z', 'x'), ((-50, 50), (-7.2, 7.2)))
S_BOW     = Zone((0,    1050, 300,  1350), ('x', 'y'), ((7, -7), (15.2, -0.5)))
S_STERN   = Zone((300,  1050, 600,  1350), ('x', 'y'), ((-7, 7), (15.2, -0.5)))
S_FIN     = Zone((600,  1050, 1360, 1350), ('z', 'y'), ((4, 34), (21.5, 10.5)))
S_CHAMBER = Zone((1360, 1050, 1760, 1350), ('z', 'y'), ((-1, 16), (12.5, 3.5)))
S_CORE    = Zone((1760, 1050, 1908, 1200), ('z', 'y'), ((5.5, 9.1), (7.8, 5.4)))
S_DK      = Zone((1948, 1050, 2048, 1150), ('x', 'z'), ((-1, 1), (-1, 1)))
S_MAST    = (1760, 1200, 2048, 1350)     # parametric limb wrap: masts/spars
S_BERM    = Zone((0,    1350, 2048, 1720), ('z', 'x'), ((-58, 30), (-12, 17)))
S_SHARD   = (0,    1720, 360,  1900)     # parametric limb wrap: hull shards

# ── the hulk pose (baked into the geometry by gen) ───────────────────────
ROLL_DEG  = -13.0     # list about Z: +X flank goes DOWN (grounded side)
PITCH_DEG = 3.5       # about X: bow (-Z) rides UP onto the land
SINK      = 2.2       # world drop: keel buries below ground plane Y=0

# ── hull sections (upright frame; keel y=0, bow -Z) ──────────────────────
# (z, yk, ybl, ym, yt, yd, yc, wbl, wm, wt, wd)
# ring: keel centre -> +x bilge/chine/shoulder/deck edge -> crown -> -x …
# Paired stations 0.6 m apart with x0.955 widths are the SEGMENT STEPS
# (segmented-monolith silhouette; no rivet greeble in this register).
HULL_SECTIONS = [
    (-50.0, 3.2, 4.4, 6.8, 10.2, 13.6, 14.4, 0.12, 0.22, 0.26, 0.20),
    (-46.0, 1.1, 2.3, 5.5, 9.3,  13.0, 13.8, 0.90, 1.90, 2.20, 1.80),
    (-38.0, 0.2, 1.3, 4.6, 8.6,  12.3, 13.1, 2.20, 4.10, 4.50, 3.70),
    (-30.0, 0.0, 1.0, 4.3, 8.4,  11.9, 12.7, 3.10, 5.50, 6.10, 5.10),
    (-29.4, 0.0, 1.0, 4.3, 8.4,  11.9, 12.7, 2.96, 5.25, 5.83, 4.87),
    (-20.0, 0.0, 1.0, 4.2, 8.3,  11.7, 12.5, 3.60, 6.30, 6.90, 5.80),
    (-19.4, 0.0, 1.0, 4.2, 8.3,  11.7, 12.5, 3.44, 6.02, 6.59, 5.54),
    (-10.0, 0.0, 1.0, 4.2, 8.3,  11.6, 12.4, 3.90, 6.80, 7.40, 6.20),
    (-9.4,  0.0, 1.0, 4.2, 8.3,  11.6, 12.4, 3.72, 6.49, 7.07, 5.92),
    (0.0,   0.0, 1.0, 4.2, 8.3,  11.6, 12.4, 4.00, 7.00, 7.60, 6.30),
    (0.6,   0.0, 1.0, 4.2, 8.3,  11.6, 12.4, 3.82, 6.69, 7.26, 6.02),
    (14.0,  0.0, 1.0, 4.2, 8.3,  11.6, 12.4, 3.90, 6.85, 7.45, 6.20),
    (14.6,  0.0, 1.0, 4.2, 8.3,  11.6, 12.4, 3.72, 6.54, 7.11, 5.92),
    (24.0,  0.0, 1.0, 4.3, 8.4,  11.7, 12.5, 3.60, 6.30, 6.80, 5.70),
    (24.6,  0.0, 1.0, 4.3, 8.4,  11.7, 12.5, 3.44, 6.02, 6.49, 5.44),
    (34.0,  0.1, 1.2, 4.5, 8.5,  11.9, 12.7, 3.00, 5.30, 5.80, 4.80),
    (42.0,  0.5, 1.6, 4.7, 8.7,  12.1, 12.8, 2.20, 4.00, 4.40, 3.60),
    (48.0,  1.1, 2.1, 5.0, 8.8,  12.2, 12.9, 1.30, 2.50, 2.80, 2.30),
]
SEG_Z = [-29.4, -19.4, -9.4, 0.6, 14.6, 24.6]   # segment boundaries (steps)
CHINES = (4.2, 8.3, 11.6)                        # chine shelf lines (paint)

# ── breach (hole in the -x flank between the two stations below) ─────────
BREACH_GAP = 10          # index of z=0.6 station; skip -x faces j=6,7 here
BR_Z0, BR_Z1 = 0.6, 14.0
BR_Y_TOP, BR_Y_BOT = 11.6, 4.2
MOUTH_X = -4.6           # breach funnel throat plane (inboard of the skin)
BACK_X  = -2.4           # chamber back wall plane
CHAMBER_C = (7.6, 7.3)   # (y, z) centre the funnel converges toward
CORE_C  = (-3.3, 6.6, 7.3)      # glowing core block inside the chamber
CORE_SZ = (1.2, 1.6, 2.6)

# ── fin (monolithic swept superstructure blade, upright frame) ───────────
# (z, y_top, y_mid, half_width); base embedded below deck at FIN_BASE_Y
FIN_SECTIONS = [
    (6.0,  13.5, 12.5, 0.50),
    (10.0, 19.5, 15.0, 1.30),
    (20.0, 20.5, 15.4, 1.50),
    (28.0, 15.5, 13.2, 1.00),
    (32.0, 12.6, 12.0, 0.50),
]
FIN_BASE_Y = 11.0
FIN_TIP = ((0.5, 12.1, 33.0), (2.5, 12.5, 38.0), 0.90, 0.25)  # snapped tip

# ── deck spine ridges (broken run of segmented dorsal conduit) ───────────
SPINES = [((0.0, 12.9, -27.0), (1.8, 1.4, 14.0)),
          ((0.0, 12.85, -8.0), (1.8, 1.3, 12.0))]

# ── collapsed masts (upright frame; fall toward the grounded +x side) ────
STUMPS = [((1.0, 12.4, -24.0), (1.4, 17.5, -24.5), 0.60, 0.45),
          ((-1.6, 12.4, -34.0), (-1.8, 14.6, -34.2), 0.50, 0.40)]
SPARS = [((0.8, 12.2, -23.5), (9.6, 3.2, -28.5), 0.50, 0.35),
         ((-1.5, 12.3, -33.5), (8.5, 2.0, -27.0), 0.45, 0.30),
         ((0.4, 12.0, 24.0), (10.8, 0.8, 30.5), 0.50, 0.32)]

# ── berm + mound + shards (WORLD frame, added after the pose bake) ───────
# (z, x_crest, y_crest, x_toe): crest is embedded ~1 m inside the hull skin
BERM = [
    (-54.0, 1.5, 0.30, 5.0),
    (-46.0, 4.5, 1.80, 11.0),
    (-38.0, 6.0, 2.60, 13.5),
    (-28.0, 7.0, 3.20, 14.5),
    (-18.0, 7.8, 3.60, 15.0),
    (-8.0,  8.2, 3.40, 14.0),
    (2.0,   8.3, 2.80, 12.5),
    (12.0,  8.2, 2.00, 10.5),
    (20.0,  7.6, 0.90, 9.0),
    (26.0,  6.5, 0.20, 7.2),
]
MOUND_APEX = (0.7, 3.0, -48.5)   # plough mound under the raised prow
MOUND_BASE = (0.7, -46.0, 10.0)  # (x, z, radius) of the ground ring
MOUND_N = 8
SHARDS = [((11.0, 0.9, -19.0), (14.5, 0.15, -13.0), 1.20, 0.70),
          ((9.5, 0.7, -40.0), (13.0, 0.20, -35.0), 0.95, 0.55),
          ((9.5, 0.5, 29.0), (12.8, 0.10, 34.0), 0.80, 0.45)]

# world waterline for the stern-half scum band (paint): world y where the
# still water sits against the listed hull; painter maps it back into the
# upright frame per flank.
WATER_Y = 0.8
