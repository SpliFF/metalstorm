"""ms_ships_s2_layout — zones + dims for ms_ships_s2 (Destroyer, 35 m).

Metalstorm ships row scale 2: seagoing line destroyer, squadded x2.
Silhouette identity for this tier = a STACKED ARMOURED CASEMATE
amidships plus THE ONLY FUNNEL IN THE SHIP LINE (raked aft ~15 deg,
cap grille, steam-pipe stubs, soot fan). Pronounced sheer with a
raised fo'c'sle carrying the enclosed main gunhouse, knuckle amidships,
cruiser stern, open quarterdeck with flak tub, depth-charge racks and
davits.

Waterline at Y=0 (preamble section 4); hull runs down to -2.2 m,
main deck 2.6 m, casemate roof 5.9 m, funnel top 9.0 m, masthead
~11.95 m. Bow at -Z. 2048 atlas (35 m dominant dim).
Order register: uniform haze-grey topsides, hull number stencil,
team colour on small ID panels only.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ─────────────────────────────────────────
S_HULL_SIDE = Zone((0,    0,    2048, 340),  ('z', 'y'), ((-17.5, 17.5), (4.7, -2.4)))
S_DECK      = Zone((0,    340,  2048, 570),  ('z', 'x'), ((-17.5, 17.5), (-3.95, 3.95)))
S_BELLY     = Zone((0,    570,  2048, 760),  ('z', 'x'), ((-17.5, 17.5), (-2.0, 2.0)))
S_CASE_S    = Zone((0,    760,  1360, 990),  ('z', 'y'), ((-12.7, 9.1), (6.1, 2.4)))
S_CASE_TOP  = Zone((1360, 760,  2048, 990),  ('z', 'x'), ((-5.6, 7.6), (-3.5, 3.5)))
S_CASE_END  = Zone((0,    990,  360,  1180), ('x', 'y'), ((-3.5, 3.5), (6.1, 2.4)))
S_WH_S      = Zone((360,  990,  790,  1180), ('z', 'y'), ((-3.4, 0.6), (7.9, 5.7)))
S_WH_F      = Zone((790,  990,  1090, 1180), ('x', 'y'), ((-2.1, 2.1), (7.9, 5.7)))
S_WH_TOP    = Zone((1090, 990,  1380, 1180), ('x', 'z'), ((-3.0, 3.0), (-3.4, 0.6)))
S_TUR_S     = Zone((1380, 990,  1830, 1180), ('z', 'y'), ((-2.7, 2.7), (2.1, -0.5)))
S_TUR_F     = Zone((1830, 990,  2048, 1180), ('x', 'y'), ((-2.3, 2.3), (2.1, -0.5)))
S_TUR_T     = Zone((0,    1180, 430,  1370), ('x', 'z'), ((-2.1, 2.1), (-2.7, 2.7)))
S_FLAK      = Zone((430,  1180, 780,  1370), ('z', 'y'), ((-1.8, 1.8), (1.5, -0.6)))
S_BARREL    = (780,  1180, 960,  1370)     # parametric gun-tube wrap
S_MAST      = (960,  1180, 1090, 1370)     # parametric mast/post/rail wrap
S_FUNNEL    = (1090, 1180, 1400, 1370)     # parametric funnel wrap
S_DARK      = Zone((1400, 1180, 1500, 1370), ('x', 'z'), ((-60, 60), (-60, 60)))
S_TRIM      = Zone((1500, 1180, 1640, 1370), ('z', 'y'), ((-60, 60), (60, -60)))
S_BOW       = Zone((1640, 1180, 1860, 1420), ('x', 'y'), ((-2.0, 2.0), (4.7, -1.0)))
S_STERN     = Zone((1860, 1180, 2048, 1420), ('x', 'y'), ((-2.4, 2.4), (3.2, -1.0)))
S_HATCH     = Zone((0,    1370, 300,  1570), ('x', 'z'), ((-60, 60), (-60, 60)))
S_DC        = (300,  1370, 470,  1520)     # depth-charge drum wrap
S_RADAR     = Zone((470,  1370, 760,  1500), ('x', 'y'), ((-1.4, 1.4), (12.05, 11.55)))

# ── hull (world metres; waterline Y=0, bow -Z) ──────────────────────────
# (z, y_bottom, y_knuckle, y_deck, w_bottom, w_knuckle, w_deck)
# Sheer: deck 4.35 m at the stem, 2.60 m amidships, 2.85 m at the stern.
# Flare: w_deck > w_knuckle forward. Step at z=-6 = fo'c'sle break.
HULL_SECTIONS = [
    (-17.45, -0.55, 1.30, 4.35, 0.15, 0.45, 0.85),
    (-16.00, -1.35, 0.95, 4.05, 0.55, 1.30, 1.95),
    (-13.50, -2.00, 0.70, 3.75, 1.15, 2.30, 3.00),
    (-10.00, -2.20, 0.55, 3.50, 1.60, 3.05, 3.58),
    (-6.20,  -2.20, 0.50, 3.35, 1.75, 3.32, 3.74),
    (-6.00,  -2.20, 0.50, 2.60, 1.75, 3.33, 3.75),
    (0.00,   -2.20, 0.50, 2.60, 1.80, 3.35, 3.75),
    (6.00,   -2.15, 0.50, 2.62, 1.70, 3.25, 3.65),
    (11.00,  -1.90, 0.55, 2.68, 1.35, 2.85, 3.25),
    (14.50,  -1.45, 0.60, 2.76, 0.95, 2.30, 2.75),
    (17.45,  -0.55, 0.75, 2.85, 0.45, 1.45, 1.95),
]
WATERLINE = (-0.20, 0.34)        # painted boot-top band astride Y=0
DECK_Y = 2.60
FOCSLE_Y = 3.50                  # fo'c'sle deck datum (used for mounts)

# ── stacked casemate amidships (two sloped-armour tiers) ────────────────
C1_Z0, C1_Z1 = -5.00, 7.00       # tier 1 base footprint (on deck)
C1_TZ0, C1_TZ1 = -4.40, 6.50     # tier 1 roof footprint
C1_WB, C1_WT = 3.25, 2.72        # base / top half-width (armour slope)
C1_TOP_Y = 4.40
C2_Z0, C2_Z1 = -3.60, 5.20       # tier 2 base
C2_TZ0, C2_TZ1 = -3.20, 4.90     # tier 2 roof
C2_WB, C2_WT = 2.42, 1.98
C2_TOP_Y = 5.90

# ── armoured wheelhouse on the casemate roof ────────────────────────────
WH = (0.0, 6.75, -1.40, 3.50, 1.70, 3.00)   # x,y,z centre + w,h,d
WH_SLIT_Y = 7.15

# ── THE FUNNEL (tier signature) — raked aft ~15 deg ─────────────────────
FUN_BASE = (0.0, 5.85, 2.50)
FUN_TOP = (0.0, 9.40, 3.45)      # rake aft: dz/dy = 0.85/3.15 ≈ 15.1 deg
FUN_R0, FUN_R1 = 1.02, 0.86
FUN_CAP_R = 1.00                 # cap grille ring (slightly proud)
STEAM_PIPES = [(0.74, 0.30), (-0.74, -0.22)]   # x offset, phase along side

# ── mast + nav radar on the wheelhouse roof ─────────────────────────────
MAST_FOOT = (0.0, 7.60, -0.55)
MAST_TOP = (0.0, 11.55, -0.15)
YARD_Y = 10.10
YARD_HW = 1.15
RADAR_C = (0.0, 11.80, -0.12)    # nav radar bar centre (air draft)

# ── slot 1: MS_AC_S3 main gunhouse on the fo'c'sle ──────────────────────
TUR_MOUNT = (0.0, 3.44, -11.00)
TUR_RING_R = 1.55
BAR_OFF = (0.0, 1.02, -1.15)     # barrel pivot local to turret
BAR_LEN = 4.20
BAR_R = 0.20
MUZ_OFF = (0.0, 0.0, -BAR_LEN)

# ── slot 2: MS_FLAK_S1 tub on the after bandstand ───────────────────────
BAND_Z, BAND_Y = 7.75, 3.42      # bandstand top (raised off the deck)
TUR2_MOUNT = (0.0, BAND_Y, BAND_Z)
TUR2_RING_R = 1.05
BAR2_OFF = (0.0, 0.62, -0.30)
BAR2_LEN = 1.70
BAR2_R = 0.10
BAR2_SPACING = 0.20
MUZ2_OFF = (0.0, 0.0, -BAR2_LEN)

# ── slot 3: MS_DEPTHCHARGE_S1 — stern rack, no traverse ─────────────────
DC_RAILS = [(1.35, 12.6, 16.9), (-1.35, 12.6, 16.9)]   # x, z0, z1
DC_Y = 2.96
DC_R, DC_LEN = 0.30, 0.60
MUZ3_OFF = (0.0, 2.95, 16.30)

# ── deck fittings ───────────────────────────────────────────────────────
BOLLARDS = [(-15.0, 1), (-15.0, -1), (15.4, 1), (15.4, -1)]
HATCHES = [(-8.4,), (10.2,)]
DAVITS = [(2.85, 9.4), (-2.85, 9.4)]        # x, z boat davits
RAIL_RUNS = [                                # (x, z0, z1) quarterdeck rails
    (3.30, 8.6, 16.6), (-3.30, 8.6, 16.6),
]
FOC_RAILS = [(3.15, -15.6, -8.0), (-3.15, -15.6, -8.0)]
RAIL_Y = 0.95                                # rail height above local deck
