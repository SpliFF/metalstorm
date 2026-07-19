"""carrier_layout — zones + dims for fable_carrier (FCV-8 Bastion).

Sci-fi fleet carrier, ~102 m (a shade over the s4 ship row — it has to
operate the 15 m FA-6): full-length flight deck with TWO EM catapult
lanes at the bow (glowing rails), a ~2° angled recovery strip with
arrestor wires aft, painted parking for 2 fighters + 1 compact bomber
+ 4 helo spads, and a working port deck-edge elevator — separate piece
riding guide rails past a recessed hangar mouth, cycling down/up in
the idle clip with a deck-park fighter on it.  Starboard island with
rotating `radar`, aimable PDC chain turret/barrel/muzzle on the bow
sponson.  Landing-pad empties pad1–pad7 per the engine QueryLandingPad
contract (game gadget + pad_count customparam, ZK shipcarrier
pattern).  Keel Y=0, bow -Z, 2048² atlas.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
C_HULL   = Zone((0,    0,    2048, 288),  ('z', 'y'), ((-52.0, 52.0), (8.2, -0.1)))
C_DECK   = Zone((0,    288,  2048, 928),  ('z', 'x'), ((-52.0, 52.0), (-16.0, 16.0)))
C_ISL    = Zone((0,    928,  768,  1312), ('z', 'y'), ((-4.0, 15.0), (20.5, 7.9)))
C_ISL_F  = Zone((0,    928,  768,  1312), ('x', 'y'), ((-13.6, -7.4), (20.5, 7.9)))
C_STERN  = Zone((768,  928,  1152, 1312), ('x', 'y'), ((8.0, -8.0), (8.0, 0.4)))
C_ELEV   = Zone((1152, 928,  1664, 1312), ('z', 'x'), ((-8.4, 8.4), (-5.7, 5.7)))
C_PLANE  = Zone((1664, 928,  2048, 1120), ('z', 'x'), ((-8.0, 8.0), (-6.5, 6.5)))
C_HANGAR = Zone((0,    1312, 512,  1504), ('z', 'y'), ((11.5, 28.5), (7.4, 3.3)))
C_TUR    = Zone((512,  1312, 896,  1504), ('z', 'y'), ((-2.6, 2.6), (2.0, -0.6)))
C_BARREL = (896, 1312, 1280, 1440)       # parametric PDC tube wrap
C_RADAR  = Zone((1280, 1312, 1664, 1440), ('x', 'y'), ((-2.4, 2.4), (1.1, -0.5)))
C_JBD    = Zone((1664, 1312, 1920, 1440), ('x', 'y'), ((-7.0, 7.0), (10.0, 7.9)))
C_TRIM   = Zone((1920, 1312, 2048, 1440), ('z', 'y'), ((-45, 45), (25, -5)))
C_DARK   = Zone((0,    1504, 128,  1632), ('x', 'z'), ((-45, 45), (-45, 45)))
C_NAVP   = Zone((128,  1504, 256,  1632), ('z', 'y'), ((-45, 45), (25, -5)))
C_NAVS   = Zone((256,  1504, 384,  1632), ('z', 'y'), ((-45, 45), (25, -5)))
C_GLOW   = Zone((384,  1504, 512,  1632), ('x', 'y'), ((-45, 45), (25, -5)))
C_SPONSON= Zone((512,  1504, 896,  1632), ('z', 'y'), ((-45, 45), (25, -5)))

# ── dims (world metres; keel Y=0, bow -Z) ────────────────────────────────
# hull loft: (z, y_bot, y_waist, w_bot, w_waist, w_top)  — deck top 7.25
HULL_TOP = 7.25
HULL_SECTIONS = [
    (-50.5, 3.2, 4.6, 0.05, 0.30, 0.50),
    (-43.0, 1.2, 2.6, 0.50, 2.20, 3.40),
    (-33.0, 0.3, 1.7, 1.70, 4.40, 5.80),
    (-18.0, 0.1, 1.5, 2.40, 5.60, 7.20),
    (0.0,   0.1, 1.5, 2.60, 5.90, 8.00),
    (18.0,  0.1, 1.5, 2.50, 5.80, 7.90),
    (32.0,  0.3, 1.6, 2.10, 5.00, 7.20),
    (43.0,  0.8, 2.1, 1.50, 3.80, 6.40),
    (49.5,  1.6, 2.6, 0.90, 2.60, 5.60),
]
WATERLINE = (1.30, 1.90)

# flight deck slab loft: (z, w_port(+x), w_starboard(-x)); slab 7.2→8.15,
# port notch z 12–28 makes room for the deck-edge elevator
DECK_Y = 8.15
DECK_SECTIONS = [                    # flat runway bow, straight segments
    (-51.0, 5.5, 5.5),
    (-40.0, 11.0, 11.0),
    (-24.0, 14.6, 14.6),
    (-6.0,  15.0, 15.0),
    (11.99, 15.0, 14.9),
    (12.01, 8.8, 14.9),
    (27.99, 8.8, 14.5),
    (28.01, 14.3, 14.5),
    (40.0,  14.0, 14.0),
    (51.0,  12.6, 12.6),
]

# twin islands (starboard −x): fwd = navigation, aft = flight control
ISL_BASE   = (-10.5, 9.65, 7.0, 4.6, 3.0, 14.0)   # x, ycen, zcen, w, h, d
ISL_MID    = (-10.5, 12.55, 6.0, 3.8, 2.8, 9.0)
ISL_BRIDGE = (-10.5, 15.05, 4.5, 4.6, 2.2, 6.0)
ISL_MAST   = (-10.5, 16.15, 6.5)                  # base of mast (top y 19.4)
RADAR_OFF  = (-10.5, 19.7, 6.5)                   # rotating radar piece
SENSOR_DOME = (-10.5, 16.6, 2.2)
ISL2_BASE  = (-11.0, 9.4, 34.0, 4.0, 2.5, 7.0)
ISL2_TOWER = (-11.0, 11.95, 33.5, 3.2, 2.6, 4.6)
ISL2_MAST  = (-11.0, 13.25, 34.5)                 # top y 15.6
ISL2_DOME  = (-11.0, 13.5, 32.2)

# elevator (separate piece; local origin at platform centre, rest y 7.7)
ELEV_OFF   = (14.2, 7.70, 20.0)
ELEV_SIZE  = (10.6, 0.45, 15.6)                   # local slab (top ≈ deck)
ELEV_DROP  = 4.5                                  # travel down to hangar
ELEV_RAILS = [12.35, 27.65]                       # guide rail z (on body)
HANGAR     = (7.45, 5.35, 20.0, 1.2, 3.7, 15.6)   # inset mouth box (body)

# catapults + jet blast deflectors
CATS       = [-3.5, 3.5]                          # lane centre x
CAT_Z      = (-49.0, -15.0)
JBD_Z      = -13.5                                # plate foot z
JBD_W      = 5.0

# PDC chain (aimable) on starboard bow sponson + aft-port CIWS dome
SPONSON    = (-8.9, 6.65, -30.0, 3.2, 1.2, 4.5)
TURRET_OFF = (-8.9, 7.25, -30.0)
BARREL_OFF = (0.0, 0.78, -1.15)                   # turret-local
MUZZLE_OFF = (0.0, 0.0, -2.45)                    # barrel-local
TUBE_X     = 0.34
CIWS       = (10.8, DECK_Y, 40.0)

# recovery strip: centreline (z0,x0)→(z1,x1), width; wires at WIRES z
STRIP      = (50.0, 2.0, -4.0, 5.6, 9.0)
WIRES      = [36.0, 39.0, 42.0]

# parking (pad empties pad1..pad7 at y just above deck)
PADS_HELO  = [(10.5, -34.0), (10.5, -25.0), (10.5, -16.0), (10.5, -7.0)]
PADS_FIGHT = [(-10.2, 21.0), (-9.8, -27.0)]       # angled herringbone spots
PAD_BOMBER = (-9.0, 46.0)
BOMBER_ANG = 45.0                                 # herringbone angle (paint)

NAV_P      = (14.6, 7.9, -6.0)                    # port deck edge (red)
NAV_S      = (-14.6, 7.9, -6.0)                   # starboard (green)
EXHAUST_OFF = (0.0, 8.5, 49.0)
WHIPS      = [(13.5, -20.0), (-13.5, -34.0), (12.8, 44.0), (-12.6, 46.0)]
