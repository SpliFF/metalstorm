"""ms_bombers_s4_layout — zones + dims for ms_bombers_s4.

s4 bomber per DESIGN-GUIDE (bombers span row: 8 / 12 / 16 / 22 -> 22 m).
"Strategic bomber — single high-altitude platform", squad_size 1.

SILHOUETTE: a PURE TAILLESS FLYING WING.  No vertical fins, no tail, no
distinct fuselage — the centrebody IS the wing, thickening smoothly to a
broad blended centre section (t = 1.80 m on the centreline, 0.11 m at the
tip).  Straight 35 deg swept leading edges meeting at a pointed centre
apex; a sawtooth / W trailing edge broken into six straight segments per
side (two clear sawteeth).  22.00 m span over 13.2 m length — far wider
than long, which is the tier tell against the s3 medium bomber's
conventional near-square planform and the s1 V-tail drone.

Buried engines with OVER-WING inlets: one flush raised intake ramp per
side on the upper surface either side of the centreline, exhausting
through a shielded slot nozzle let into the upper aft surface ahead of
the trailing edge (not podded nacelles, not a dorsal scoop).

TWO weapons bays in the centrebody underside, fore and aft, each a closed
box with painted doors and a red ARM outline:
  slot 1 MS_MISSILE_CRUISE_S2 -> `muzzle`  at the FORWARD bay centre (FIXED)
  slot 2 MS_BOMB_S3           -> `muzzle2` at the AFT bay centre (FIXED)
  slot 3 MS_FLAK_S1           -> a REAL traversing dorsal flak ring:
      turret3 (yawing barbette) -> turret3_barrel (pitching twin flak gun)
      -> turret3_muzzle (empty at the barrel tip).  DESIGN-MODEL-BUILDING
      section 16c; a slot-3-only chain is valid (matchAimSlots keys slots
      into a Map, missing slots 1/2 are simply absent).

frame: forward -Z, +Y up, wheels at Y=0, 1 unit = 1 m.  2048^2 hero atlas.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048^2; v down) ─────────────────────────────────────────
# The upper surface is the hero canvas, so F_TOP/F_BOT are PLANFORM zones
# (u = x across the span, v = z nose-to-tail) — near-isotropic px/m and a
# natural nose-up blueprint orientation.  Port and starboard map to
# DIFFERENT u, so the wing halves are independently paintable (no mirror
# ambiguity) — at the cost of painting both sides in an s-loop.
F_SIDE   = Zone((0,    0,    2048, 200),  ('z', 'y'), ((-6.60, 6.60), (2.95, 0.35)))
F_TOP    = Zone((0,    200,  2048, 1240), ('x', 'z'), ((-11.20, 11.20), (-6.60, 6.60)))
F_BOT    = Zone((0,    1240, 2048, 1792), ('x', 'z'), ((-11.20, 11.20), (-6.60, 6.60)))

# ── detail band (y 1792..2048) ───────────────────────────────────────────
F_CANOPY = Zone((0,    1792, 512,  1920), ('z', 'y'), ((-5.98, -3.82), (2.44, 1.56)))
F_INTK   = Zone((512,  1792, 704,  1920), ('x', 'y'), ((-45, 45), (25, -5)))
F_SLOT   = Zone((704,  1792, 896,  1920), ('x', 'y'), ((-45, 45), (25, -5)))
F_GEAR   = Zone((896,  1792, 1024, 1920), ('z', 'y'), ((-45, 45), (25, -5)))
F_TRIM   = Zone((1024, 1792, 1152, 1920), ('z', 'y'), ((-45, 45), (25, -5)))
F_DARK   = Zone((1152, 1792, 1280, 1920), ('x', 'z'), ((-45, 45), (-45, 45)))
F_NAVP   = Zone((1280, 1792, 1408, 1920), ('z', 'y'), ((-45, 45), (25, -5)))
F_NAVS   = Zone((1408, 1792, 1536, 1920), ('z', 'y'), ((-45, 45), (25, -5)))
F_BAYSD  = Zone((1536, 1792, 1792, 1920), ('z', 'y'), ((-45, 45), (25, -5)))
T_BARREL = (1792, 1792, 2048, 1856)       # parametric flak-barrel wrap
T_DARK   = Zone((1792, 1856, 1920, 1920), ('x', 'z'), ((-45, 45), (-45, 45)))
T_TRIM   = Zone((1920, 1856, 2048, 1920), ('z', 'y'), ((-45, 45), (25, -5)))
# dorsal flak mount is PIECE-LOCAL (it slews) -> its own local zones
T_TOP    = Zone((0,    1920, 768,  2048), ('x', 'z'), ((-1.25, 1.25), (-1.25, 1.25)))
T_SIDE   = Zone((768,  1920, 1536, 2048), ('z', 'y'), ((-1.80, 1.10), (0.95, -0.55)))
F_RAM    = Zone((1536, 1920, 2048, 2048), ('x', 'z'), ((-45, 45), (-45, 45)))

VERT_ZONES = [F_SIDE, F_CANOPY, F_INTK, T_SIDE]   # for weathering

# ── the wing (the whole aircraft) ────────────────────────────────────────
# stations: (span_x, z_le, z_te, y_centre, thickness)
# LE: straight, 35 deg sweep (dz/dx = 0.700) from the centre apex z=-6.30.
# TE: sawtooth W — breaks at x = 0 / 2.70 / 4.50 / 6.30 / 8.10 / 10.85,
#     alternating forward notch and aft peak.  This planform tell is what
#     reads in a top-down impostor cell.
WING = [
    (0.00,  -6.300,  6.300, 1.580, 1.80),
    (0.90,  -5.670,  5.333, 1.580, 1.72),
    (1.80,  -5.040,  4.367, 1.578, 1.52),
    (2.70,  -4.410,  3.400, 1.575, 1.28),   # notch (fwd)
    (3.60,  -3.780,  4.175, 1.572, 1.18),
    (4.50,  -3.150,  4.950, 1.570, 1.08),   # sawtooth peak (aft)
    (5.40,  -2.520,  4.000, 1.566, 0.88),
    (6.30,  -1.890,  3.050, 1.562, 0.66),   # notch (fwd)
    (7.20,  -1.260,  3.625, 1.558, 0.58),
    (8.10,  -0.630,  4.200, 1.554, 0.52),   # sawtooth peak (aft)
    (9.00,   0.000,  3.496, 1.548, 0.40),
    (9.70,   0.490,  2.949, 1.543, 0.30),
    (10.30,  0.910,  2.480, 1.537, 0.20),
    (10.85,  1.295,  2.050, 1.530, 0.11),
]
# chordwise section shape: (chord fraction, thickness fraction of y_c)
# 9 points: sharp LE, cambered crown, blunt TE, flat-ish underside.
SECTION = [
    (0.00,  0.00),          # LE point
    (0.14,  0.40),
    (0.34,  0.50),
    (0.62,  0.44),
    (1.00,  0.06),          # TE top
    (1.00, -0.06),          # TE bottom
    (0.62, -0.30),
    (0.34, -0.34),
    (0.14, -0.26),
]

SPAN = 22.00

# ── low, wide, 3-bow side-by-side canopy, blended into the LE apex ───────
# (z, half_w, y_base, y_top)
CAN_SECTIONS = [
    (-5.95, 0.14, 1.62, 1.80),
    (-5.55, 0.50, 1.64, 2.06),
    (-5.05, 0.82, 1.70, 2.26),
    (-4.55, 0.86, 1.80, 2.34),
    (-4.15, 0.52, 1.92, 2.32),
    (-3.85, 0.20, 2.02, 2.30),
]

# ── over-wing intake ramps (right side; mirrored) ────────────────────────
# (z, x_in, x_out, y_bot, y_top) — flush shallow ramp, mouth faces -Z,
# fairs back under the skin aft.  Roots INSIDE a surface tapering in x and z.
INTAKE_SECTIONS = [
    (-1.40, 1.10, 2.70, 2.04, 2.52),
    (-0.30, 1.10, 2.68, 2.04, 2.54),
    (1.10,  1.08, 2.48, 1.96, 2.34),
    (2.30,  1.05, 2.20, 1.84, 2.06),
]

# ── shielded slot nozzles let into the upper aft surface (right side) ────
NOZZLE_SECTIONS = [
    (2.50, 0.40, 1.55, 1.90, 2.42),
    (3.30, 0.41, 1.52, 1.80, 2.28),
    (4.00, 0.44, 1.47, 1.68, 2.14),
    (4.35, 0.46, 1.42, 1.60, 2.02),   # aft cap = the slot exit
]
EXHAUST_OFF = (0.0, 1.90, 4.50)

# ── two weapons bays in the centrebody underside ─────────────────────────
# (centre xyz, size xyz) — closed boxes, '+y' skipped (flush into the belly)
BAY_FWD  = ((0.0, 0.75, -2.60), (2.20, 0.36, 3.20))
BAY_AFT  = ((0.0, 0.76, 1.40),  (2.40, 0.36, 3.60))
MUZZLE_OFF  = (0.0, 0.60, -2.60)     # slot 1, forward cruise-missile bay
MUZZLE2_OFF = (0.0, 0.61, 1.40)      # slot 2, aft bomb bay

# ── dorsal flak ring (slot 3, REAL aim chain per section 16c) ────────────
TUR3_OFF    = (0.0, 2.20, -2.30)     # barbette on the spine (child of body)
TUR3_RING   = (1.00, 0.86, 0.40)     # r_base, r_top, height
TUR3_CHEEK  = (0.54, 0.20, 0.56, -0.44, 0.44)   # x, y0, y1, z0, z1
BARREL_OFF  = (0.0, 0.52, 0.0)       # elevation pivot (child of turret3)
BARREL_BOX  = ((0.0, 0.0, -0.30), (0.88, 0.34, 1.30))
DRUM        = ((0.50, 0.02, 0.18), (0.22, 0.30, 0.66))
FLAK_X      = 0.22
FLAK_TUBE   = [(-0.52, 0.105, 0.0), (-0.92, 0.088, 0.0), (-1.56, 0.076, 0.0)]
MUZZLE3_OFF = (0.0, 0.0, -1.62)      # barrel tips (child of turret3_barrel)

# ── landing gear: heavy. (attach xyz), drop, wheel r, wheel half-width ───
# wheels are 8-gons: centre y = r*cos(pi/8) so the flat rests on Y=0
GEAR_N = ((0.0, 1.10, -4.75), 0.786, 0.34, 0.13)   # twin-wheel nose leg
GEAR_M = ((3.30, 1.18, 1.40), 0.755, 0.46, 0.18)   # tandem main bogie

# ── greebles ─────────────────────────────────────────────────────────────
NAV_TIP   = (10.93, 1.532, 1.60)                   # wingtip nav pod (+-x)
ANTENNAS  = [(0.0, 2.36, 0.40), (0.0, 2.26, 2.00)]  # dorsal blade antennae
SENSOR    = (0.60, 1.45, -5.20)                    # chin targeting blister
CHAFF     = (1.90, 1.20, 2.60)                     # belly dispensers (+-x)
