"""ms_subs_s4_layout — zones + dims for ms_subs_s4 (missile leviathan).

s4 strategic boomer, 65.0 m exactly (nose z=-32.5, shroud trailing edge
z=+32.5). SUBMARINE DATUM: hull longitudinal axis at y=0 — the boat is a
free-floating body of revolution, nothing rests on the ground plane, no
waterline band (runs submerged, continuous dark anti-foul finish).

Grammar (tier identity): broad LOW wide-footed sail set forward, and behind
it a raised slab-sided TURTLEBACK MISSILE DECK (~26 m ≈ 40% of hull length)
carrying a 2×6 grid of big square VLS hatches with raised coamings.
One large shrouded screw (`prop` piece) at the stern.
2048² atlas (65 m dominant dim ≥ 15 m).
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
S_HULL_SIDE = Zone((0,    0,    2048, 360),  ('z', 'y'), ((-32.5, 32.5), (4.4, -4.6)))
S_HULL_TOP  = Zone((0,    360,  2048, 600),  ('z', 'x'), ((-32.5, 32.5), (-4.3, 4.3)))
S_HULL_BOT  = Zone((0,    600,  2048, 840),  ('z', 'x'), ((-32.5, 32.5), (-4.3, 4.3)))
S_CASE_SIDE = Zone((0,    840,  2048, 1010), ('z', 'y'), ((-11.0, 21.0), (5.3, 0.8)))
S_CASE_TOP  = Zone((0,    1010, 2048, 1250), ('z', 'x'), ((-11.0, 21.0), (-3.8, 3.8)))
S_SAIL_SIDE = Zone((0,    1250, 620,  1460), ('z', 'y'), ((-21.0, -9.0), (6.4, 2.6)))
S_SAIL_TOP  = Zone((620,  1250, 1000, 1400), ('z', 'x'), ((-18.6, -11.6), (-1.9, 1.9)))
S_SAIL_END  = Zone((1000, 1250, 1220, 1460), ('x', 'y'), ((-2.9, 2.9), (6.4, 2.6)))
S_TRIM      = Zone((1220, 1250, 1500, 1460), ('z', 'y'), ((-40, 40), (30, -30)))
S_DARK      = Zone((1500, 1250, 1640, 1460), ('x', 'z'), ((-2, 2), (-2, 2)))
S_FIN       = Zone((0,    1460, 560,  1680), ('z', 'y'), ((22.0, 30.0), (6.0, -6.0)))
S_FIN_PLAN  = Zone((560,  1460, 1120, 1680), ('z', 'x'), ((-28.0, 30.0), (-6.0, 6.0)))
S_SHROUD    = Zone((1120, 1460, 1740, 1680), ('z', 'y'), ((29.5, 33.0), (2.2, -2.2)))
S_BLADE     = Zone((1740, 1460, 2000, 1680), ('x', 'y'), ((-1.6, 1.6), (-1.6, 1.6)))
S_PROP      = (0,    1680, 300,  1840)   # raw rect: hub / shaft wrap
S_MAST      = (300,  1680, 560,  1840)   # raw rect: periscope masts / struts

# ── dims (world metres; axis datum y=0, bow -Z) ──────────────────────────
LENGTH   = 65.0
NOSE_Z   = -32.5
TAIL_Z   = 32.5
HULL_R   = 4.0                    # beam 8.0
N_SEG    = 16                     # hull-of-revolution segments

# hull of revolution stations (z, radius); capped both ends
HULL_STATIONS = [
    (-32.5, 0.35), (-31.6, 1.30), (-29.8, 2.40), (-26.5, 3.20),
    (-22.5, 3.75), (-17.0, 4.00), (-9.0, 4.00), (0.0, 4.00),
    (9.0, 4.00), (15.0, 4.00), (19.5, 3.75), (23.5, 3.10),
    (26.5, 2.30), (28.5, 1.60), (30.0, 1.00),
]

# turtleback missile casing sections (z, w_bot, w_top, y_top); bottom edge
# of each ring sits at CASE_Y0 (inside the hull), knuckle 0.9 below y_top
CASE_Y0 = 1.0
CASE_SECTIONS = [
    (-10.5, 2.60, 1.90, 4.15),
    (-8.5,  3.20, 2.55, 4.70),
    (-6.0,  3.40, 2.90, 5.10),
    (0.0,   3.40, 2.90, 5.10),
    (8.0,   3.40, 2.90, 5.10),
    (14.0,  3.40, 2.90, 5.10),
    (17.0,  3.30, 2.80, 5.00),
    (19.5,  2.90, 2.10, 4.50),
    (20.8,  2.30, 1.40, 4.05),
]
DECK_Y = 5.10                    # turtleback flat top

# VLS hatch grid: 2 rows x 6, raised coamings on the deck top
HATCH_ROWS = (-1.5, 1.5)         # row centre x
HATCH_Z    = [-3.5, 0.0, 3.5, 7.0, 10.5, 14.0]
HATCH_W    = 2.40                # square
COAM_H     = 0.18
VLS_CENTRE = (0.0, DECK_Y, 5.25) # muzzle2 empty (centre of hatch field)

# sail: broad, low, wide-footed, set forward.  Loft rings bottom->top:
# (y, half_width, z_front, z_back)
SAIL_RINGS = [
    (3.20, 2.80, -20.8, -9.4),   # flared foot, buried in the hull
    (4.60, 2.30, -20.0, -10.0),
    (5.60, 1.85, -19.0, -11.2),
    (6.10, 1.55, -18.4, -11.8),  # low top
]
SAIL_TOP_Y = 6.10

# bow planes on the hull near the nose (NOT on the sail)
BOWPLANE_Z  = -25.5
BOWPLANE_Y  = 0.60
BOWPLANE_TIP = 5.40              # half-span
BOWPLANE_CH = (1.9, 1.1)         # root/tip chord

# cruciform stern planes
STERN_Z    = 26.5
STERN_TIP  = 4.60                # extent from axis
STERN_CH   = (2.4, 1.4)          # root/tip chord
STERN_T    = 0.30

# shrouded screw
SHROUD_Z0, SHROUD_Z1 = 30.4, 32.5
SHROUD_RO, SHROUD_RI = 1.85, 1.45
SHAFT_Z0, SHAFT_Z1   = 30.0, 30.7
PROP_OFF   = (0.0, 0.0, 31.0)    # prop piece origin on the shaft line
PROP_HUB_R = 0.42
PROP_BLADE_R = 1.32
PROP_BLADES  = 5

# periscope / snorkel masts on the sail top
MASTS = [(-0.45, -16.6, 1.15), (0.35, -14.8, 0.90), (0.0, -13.2, 0.70)]
# (x, z, height above sail top)

# sonar blister under the bow
BLISTER = (0.0, -2.9, -27.5, 2.2, 1.1, 3.6)   # x,y,z, w,h,d

MUZZLE_OFF  = (0.0, -0.8, -32.5)  # bow torpedo tube tip
