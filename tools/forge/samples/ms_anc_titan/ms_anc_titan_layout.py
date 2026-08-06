"""ms_anc_titan_layout — zones + dims for ms_anc_titan (Titan warframe).

ANCIENT REGISTER. s4 HERO, ~26 m quadruped dormant war machine: a
cathedral hull carried on four columnar legs, dorsal main lance on the
standard turret/barrel/muzzle chain, chin repeater on turret2/barrel2/
muzzle2, a command spire at the stern under a floating halo ring, and
cyan power veins that run the whole length of the hull as RAISED RAILS
(their own geometry + emissive zone) so they read from the horizon.

Nothing bolted, nothing patched: unbroken monolithic surfaces divided by
clean recessed seams. Weathering is geological — dust drift, soil burial
at the feet, scorch at the emitter. Team read = a recessed banner panel
on BOTH flanks (capturable hero).

World frame: forward=-Z, up=+Y, left=+X, ground Y=0, 1 unit = 1 m.
Single source of truth for BOTH the geometry generator and the painter.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

W = 2048

# ── atlas zones (2048²; v down) ─────────────────────────────────────────
# rect = (x0, y0, x1, y1) px.  Zone objects for boxes/lofts/faces;
# raw rects for limb()/tube() parametric wraps.

C_HULL_SIDE  = Zone((0,    0,    1024, 448),  ('z', 'y'), ((-11.2, 11.2), (15.8, 8.4)))
C_HULL_TOP   = Zone((1024, 0,    2048, 448),  ('x', 'z'), ((-5.2, 5.2), (-11.2, 11.2)))
C_UNDER      = Zone((0,    448,  512,  896),  ('x', 'z'), ((-5.2, 5.2), (-11.2, 11.2)))
C_PROW       = Zone((512,  448,  1024, 896),  ('x', 'y'), ((-3.4, 3.4), (15.6, 8.6)))
C_HULL_REAR  = Zone((1024, 448,  1536, 896),  ('x', 'y'), ((3.4, -3.4), (15.4, 8.6)))
C_SHOULDER   = Zone((1536, 448,  2048, 896),  ('x', 'z'), ((-6.4, 6.4), (-9.0, 9.0)))
C_BANNER     = Zone((0,    896,  512,  1344), ('z', 'y'), ((-2.6, 3.6), (13.5, 9.7)))
C_DECK       = Zone((512,  896,  1024, 1344), ('x', 'z'), ((-3.0, 3.0), (-8.0, 9.0)))
C_TRACERY    = Zone((1024, 896,  1536, 1344), ('x', 'z'), ((-2.6, 2.6), (-3.4, 3.4)))
C_LEG_PLATE  = Zone((1536, 896,  1856, 1216), ('z', 'y'), ((-2.0, 2.0), (2.8, -2.8)))
C_JOINT_CAP  = Zone((1856, 896,  2048, 1216), ('z', 'y'), ((-1.8, 1.8), (1.8, -1.8)))
C_GLYPH      = Zone((1536, 1216, 2048, 1344), ('z', 'y'), ((-4.2, 4.2), (0.95, -0.95)))
C_FOOT_SIDE  = Zone((0,    1344, 512,  1600), ('z', 'y'), ((-2.5, 2.5), (0.15, -1.20)))
C_FOOT_TOP   = Zone((512,  1344, 896,  1600), ('x', 'z'), ((-1.8, 1.8), (-2.5, 2.5)))
C_YOKE       = Zone((896,  1344, 1408, 1600), ('x', 'y'), ((-4.2, 4.2), (4.4, -1.8)))
C_RECEIVER   = Zone((1408, 1344, 2048, 1600), ('z', 'y'), ((-6.5, 3.5), (2.3, -2.3)))
C_SPIRE_SIDE = Zone((0,    1600, 384,  1856), ('z', 'y'), ((-1.9, 1.9), (7.6, -0.4)))
C_SPIRE_TOP  = Zone((384,  1600, 640,  1856), ('x', 'z'), ((-2.1, 2.1), (-2.1, 2.1)))
C_HALO       = Zone((640,  1600, 1024, 1856), ('x', 'z'), ((-3.6, 3.6), (-3.6, 3.6)))
C_CORE       = Zone((1024, 1600, 1280, 1856), ('x', 'y'), ((-2.1, 2.1), (2.1, -2.1)))
C_EMITTER    = Zone((1280, 1600, 1536, 1856), ('x', 'y'), ((-1.4, 1.4), (1.4, -1.4)))
C_LENS       = Zone((1536, 1600, 1792, 1856), ('x', 'y'), ((-1.1, 1.1), (1.1, -1.1)))
C_REP_BODY   = Zone((1792, 1600, 2048, 1856), ('x', 'y'), ((-1.7, 1.7), (1.5, -1.5)))

C_THIGH      = (0,    1856, 384,  1984)     # parametric column wrap
C_SHIN       = (384,  1856, 768,  1984)
C_LANCE      = (768,  1856, 1408, 1984)     # main-lance tube wrap
C_REP_WRAP   = (1408, 1856, 1664, 1984)     # repeater tube wrap
C_VEIN       = (1664, 1856, 1920, 1984)     # CYAN power-vein rail wrap
C_JOINT      = (1920, 1856, 2048, 1984)     # joint-drum wrap

C_FLUTE      = (0,    1984, 256,  2048)     # column flute wrap
C_RIB        = (256,  1984, 512,  2048)     # flying-rib wrap
C_TRIM       = (512,  1984, 768,  2048)     # small-part wrap
C_TRIM_BOX   = Zone((512,  1984, 768,  2048), ('x', 'y'), ((-0.7, 0.7), (0.7, -0.7)))
C_DARK       = Zone((768,  1984, 1024, 2048), ('x', 'z'), ((-1.0, 1.0), (-1.0, 1.0)))
C_SOLE       = Zone((1024, 1984, 1536, 2048), ('x', 'z'), ((-1.8, 1.8), (-2.5, 2.5)))
C_FILAMENT   = (1536, 1984, 2048, 2048)     # spire filament wrap

# ── hull: cathedral loft ────────────────────────────────────────────────
# (z, y_keel, y_low, y_waist, y_shoulder, y_upper, y_deck,
#     w_keel, w_low, w_waist, w_shoulder, w_upper, w_deck)
HULL_SECTIONS = [
    (-11.00, 11.80, 12.10, 12.50, 13.00, 13.50, 13.90, 0.30, 0.50, 0.65, 0.60, 0.45, 0.28),
    (-9.40, 10.80, 11.30, 12.00, 13.00, 13.80, 14.40, 0.90, 1.45, 1.90, 1.80, 1.35, 0.85),
    (-7.40, 9.80, 10.50, 11.40, 13.00, 14.20, 14.90, 1.65, 2.60, 3.35, 3.20, 2.45, 1.55),
    (-4.80, 9.10, 9.90, 11.00, 13.00, 14.60, 15.30, 2.30, 3.60, 4.50, 4.30, 3.30, 2.05),
    (-1.80, 8.80, 9.60, 10.80, 13.00, 14.80, 15.60, 2.55, 3.95, 4.90, 4.70, 3.60, 2.25),
    (1.60, 8.80, 9.60, 10.80, 13.00, 14.80, 15.60, 2.55, 3.95, 4.90, 4.70, 3.60, 2.25),
    (4.60, 9.10, 9.90, 11.00, 12.90, 14.50, 15.20, 2.40, 3.75, 4.65, 4.45, 3.40, 2.10),
    (7.20, 9.80, 10.50, 11.50, 12.60, 13.80, 14.50, 1.85, 2.90, 3.65, 3.45, 2.65, 1.65),
    (9.40, 10.80, 11.30, 12.00, 12.60, 13.30, 13.90, 1.10, 1.75, 2.20, 2.10, 1.60, 1.00),
    (11.00, 11.80, 12.10, 12.50, 12.90, 13.30, 13.60, 0.40, 0.65, 0.80, 0.75, 0.55, 0.32),
]
LEVELS = ('keel', 'low', 'waist', 'shoulder', 'upper', 'deck')

# dorsal spine ridge (one unbroken bar down the deck) x,y,z,w,h,d
SPINE = (0.0, 15.85, -1.00, 1.55, 1.15, 17.20)
# deck tracery plate (recessed mandala panel forward of the spire)
DECK_PANEL = (0.0, 15.62, 1.00, 4.10, 0.22, 6.60)
# prow ram wedge: (z, y_bot, y_top, half_w) sections, hull frame
PROW_WEDGE = [
    (-8.60, 10.40, 12.80, 1.90),
    (-10.60, 11.10, 12.70, 1.25),
    (-12.30, 11.80, 12.35, 0.42),
]
# forward-raked cathedral crest over the prow (+x side, mirrored)
PROW_HORNS = [((1.90, 15.30, -3.00), (2.70, 14.85, -6.30),
               (1.55, 15.85, -9.90))]
HORN_R = 0.42
# prow core lens housing + disc
CORE_HOUSING = (0.0, 12.10, -8.10, 3.20, 2.40, 0.70)
CORE_DISC = (0.0, 12.10, -8.50)
CORE_R = 1.35
# ventral core (belly, dormant)
BELLY_DISC = (0.0, 8.76, 1.40)
BELLY_R = 1.10

# leg shoulder buttresses (cantilevered blocks) x,y,z
BUTTRESS = [(4.70, 10.55, -6.20), (-4.70, 10.55, -6.20),
            (4.70, 10.55, 6.00), (-4.70, 10.55, 6.00)]
BUTTRESS_SIZE = (2.40, 2.90, 3.90)

# banner recess plates (team read) — BOTH flanks, symmetric
BANNER_PLATE = [(4.62, 11.60, 0.50), (-4.62, 11.60, 0.50)]
BANNER_SIZE = (0.42, 3.40, 5.80)

# flying ribs: (start, mid, end) hull->buttress arcs, +x side (mirrored)
RIBS = [
    ((2.10, 15.20, -4.40), (3.90, 13.60, -5.20), (4.40, 11.90, -6.10)),
    ((2.25, 15.55, -1.20), (4.20, 13.90, -3.40), (4.60, 12.00, -5.40)),
    ((2.25, 15.55, 1.80), (4.25, 13.90, 3.60), (4.55, 12.00, 5.40)),
    ((2.05, 15.10, 4.60), (3.85, 13.55, 5.30), (4.35, 11.90, 6.20)),
]
RIB_R = 0.42

# stern vanes (twin cantilevered fins) x,y,z
VANES = [(1.55, 13.60, 10.20), (-1.55, 13.60, 10.20)]
VANE_SIZE = (0.34, 2.60, 2.60)

# ── power veins ─────────────────────────────────────────────────────────
# Rails ride the loft surface: (level, outward scale, dy).
VEIN_RAILS = [('deck', 0.50, 0.16), ('upper', 1.06, 0.05), ('waist', 1.05, 0.0)]
VEIN_R = 0.24
# cross veins dropping from the waist rail into each buttress
VEIN_DROPS = [((4.95, 10.85, -6.20), (4.80, 9.70, -6.20)),
              ((4.90, 10.85, 6.00), (4.75, 9.70, 6.00))]

# ── legs (quadruped; piece-local metres) ────────────────────────────────
HIP_X = 4.50
HIP_Y = 10.00
HIP_Z_F = -6.20
HIP_Z_H = 6.00
KNEE_F = (0.45, -4.60, -0.25)     # thigh-local, front
KNEE_H = (0.45, -4.60, 0.30)      # thigh-local, hind
ANKLE_F = (0.35, -4.30, 0.40)     # shin-local, front
ANKLE_H = (0.35, -4.30, -0.45)    # shin-local, hind
THIGH_R0, THIGH_R1 = 1.48, 1.22
SHIN_R0, SHIN_R1 = 1.16, 0.94
FLUTE_N, FLUTE_R = 6, 0.21
HIP_DRUM = (1.62, 0.86)           # radius, half-width
KNEE_DRUM = (1.32, 0.72)
ANKLE_DRUM = (1.04, 0.60)
THIGH_PLATE = (0.0, -2.30, -0.20, 2.70, 3.60, 2.00)   # x,y,z,w,h,d
SHIN_PLATE = (0.0, -2.10, 0.10, 2.16, 3.10, 1.62)
# foot: three stacked monolithic plinths (ankle-local; bottom at -1.10)
FOOT_STACK = [(0.0, -0.22, 0.0, 2.35, 0.60, 3.10),
              (0.0, -0.64, 0.0, 3.35, 0.52, 4.60),
              (0.0, -0.94, 0.0, 3.05, 0.32, 4.10)]
FOOT_BOTTOM = -1.10
FOOT_Z_SPAN = 2.05                # |z| sampled for the ground solve

# ── dorsal main lance (turret / barrel / muzzle) ────────────────────────
TURRET_OFF = (0.0, 15.58, -0.60)
RING_R, RING_H, RING_N = 2.80, 0.48, 16
YOKE_BASE = (0.0, 0.80, 0.10, 4.05, 1.25, 3.65)     # turret-local
YOKE_ARMS = [(2.00, 2.05, 0.10), (-2.00, 2.05, 0.10)]
YOKE_ARM_SIZE = (0.88, 2.75, 3.00)
TRUNNION_R, TRUNNION_HW = 1.18, 0.46
TRUNNION_Y = 2.85                                    # turret-local

BARREL_OFF = (0.0, 2.85, -1.40)                      # turret-local (trunnion)
LANCE_RECEIVER = (0.0, 0.0, 1.35, 2.95, 2.70, 4.20)  # barrel-local
LANCE_TUBE = [(2.10, 1.25), (0.20, 1.36), (-4.40, 1.18),
              (-8.40, 0.98), (-11.40, 0.82), (-12.10, 0.66)]
LANCE_N = 10
LANCE_RINGS = [(-1.10, -1.80, 1.62), (-5.20, -5.90, 1.44),
               (-9.20, -9.80, 1.20)]                # z0, z1, radius
LANCE_RAILS = [(1.42, 0.0), (-1.42, 0.0)]            # x, y of side rails
LANCE_RAIL_SIZE = (0.44, 0.66, 11.60)
LANCE_RAIL_Z = -4.60
EMITTER_PRONGS = 4
EMITTER_BASE_Z = -11.60
EMITTER_TIP_Z = -12.90
EMITTER_R0, EMITTER_R1 = 0.88, 0.44
EMITTER_RING_R = 0.80
MUZZLE_OFF = (0.0, 0.0, -13.20)                      # barrel-local

# ── chin repeater (turret2 / barrel2 / muzzle2) ─────────────────────────
TURRET2_OFF = (0.0, 10.35, -8.30)
REP_BALL_R, REP_BALL_H, REP_BALL_N = 1.05, 1.20, 12
REP_HOUSING = (0.0, 0.10, -0.55, 1.85, 1.30, 1.30)   # turret2-local
BARREL2_OFF = (0.0, -0.28, -0.85)                    # turret2-local
REP_BLOCK = (0.0, 0.0, 0.55, 1.55, 1.10, 1.50)       # barrel2-local
REP_TUBES = [(0.0, 0.30), (0.62, -0.26), (-0.62, -0.26)]   # x, y
REP_TUBE = [(0.10, 0.24), (-1.40, 0.22), (-2.70, 0.20), (-3.05, 0.26)]
REP_N = 6
MUZZLE2_OFF = (0.0, 0.0, -3.35)

# ── command spire + floating halo ───────────────────────────────────────
SPIRE_OFF = (0.0, 14.10, 8.10)
SPIRE_PLINTH = (0.0, 0.28, 0.0, 3.90, 0.60, 3.90)    # spire-local
# tapered obelisk: (y, half_w) sections, spire-local
SPIRE_SECTIONS = [(0.56, 1.78), (2.10, 1.52), (4.00, 1.18),
                  (5.60, 0.84), (6.70, 0.52), (7.30, 0.20)]
SPIRE_N = 8
SPIRE_VANES = [(0.0, 2.70, -1.55), (0.0, 2.70, 1.55),
               (1.55, 2.70, 0.0), (-1.55, 2.70, 0.0)]
SPIRE_VANE_SIZE = (1.45, 3.70, 0.36)
SPIRE_LENS_Y = 5.30
SPIRE_LENS_R = 0.82
SPIRE_FILAMENTS = [(0.95, 5.30, 0.0), (-0.95, 5.30, 0.0),
                   (0.0, 5.30, 0.95), (0.0, 5.30, -0.95)]

HALO_OFF = (0.0, 20.20, 8.10)
HALO_R_OUT, HALO_R_IN, HALO_H, HALO_N = 2.95, 2.30, 0.40, 20

# ── animation ───────────────────────────────────────────────────────────
# 16 unique keys + repeat; lateral-sequence quadruped walk. Leg phase
# offsets in KEY INDICES: FL 0, HR 4, FR 8, HL 12 (quarter cycle each).
WALK_T = 4.6
WALK_KEYS = 16
WALK_THIGH = [10.0, 8.0, 6.0, 4.0, 2.0, 0.0, -2.0, -4.0,
              -6.0, -8.0, -10.0, -5.5, -0.5, 4.0, 7.5, 9.4]
WALK_SHIN = [0.0, -1.0, -2.0, -3.0, -4.0, -5.0, -6.0, -7.5,
             -9.5, -13.0, -19.0, -24.0, -25.0, -17.0, -8.0, -2.5]
WALK_FOOT_COMP, WALK_FOOT_CLAMP = 0.80, 22.0
PHASE = {'fl': 0, 'hr': 4, 'fr': 8, 'hl': 12}
WALK_BODY_YAW = [0.0, 0.5, 0.9, 1.1, 0.9, 0.5, 0.0, -0.5,
                 -0.9, -1.1, -0.9, -0.5, 0.0, 0.4, 0.7, 0.5]
WALK_BODY_ROLL = [0.0, 0.7, 1.1, 0.9, 0.4, -0.2, -0.8, -1.1,
                  -1.0, -0.6, 0.0, 0.5, 0.9, 1.0, 0.7, 0.3]
WALK_TURRET_YAW = [0.0, -0.8, -1.4, -1.6, -1.3, -0.7, 0.0, 0.7,
                   1.4, 1.6, 1.3, 0.7, 0.0, -0.5, -0.9, -0.6]
WALK_LANCE_PITCH = [0.0, -0.6, -1.0, -0.8, -0.3, 0.2, 0.7, 1.0,
                    0.8, 0.4, -0.1, -0.6, -0.9, -0.7, -0.3, 0.0]
WALK_SPIRE_YAW = [0.0, 2.0, 3.4, 3.8, 3.0, 1.6, 0.0, -1.6,
                  -3.0, -3.8, -3.4, -2.0, 0.0, 1.2, 2.2, 1.4]
WALK_HALO_YAW = [-360.0 * i / 16.0 for i in range(16)]

# IDLE — dormant: the spire scans, the halo turns, the frame breathes.
IDLE_KEYS = [0.0, 2.0, 4.0, 6.0, 8.0, 10.0, 12.0, 14.0, 16.0]
IDLE_SPIRE_YAW = [0.0, -18.0, -34.0, -22.0, 0.0, 22.0, 34.0, 18.0, 0.0]
IDLE_SPIRE_PITCH = [0.0, -1.6, -2.6, -1.4, 0.0, 1.4, 2.6, 1.6, 0.0]
IDLE_HALO_YAW = [-45.0 * i for i in range(9)]
IDLE_BODY_Y = [0.0, -0.035, -0.055, -0.030, 0.0, 0.030, 0.050, 0.028, 0.0]
IDLE_TURRET_YAW = [0.0, 1.2, 2.0, 1.2, 0.0, -1.2, -2.0, -1.2, 0.0]
IDLE_LANCE_PITCH = [0.0, -0.5, -0.9, -0.5, 0.0, 0.5, 0.9, 0.5, 0.0]
