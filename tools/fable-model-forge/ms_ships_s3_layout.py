"""ms_ships_s3_layout — zones + dims for ms_ships_s3.

Ships-row scale 3: 55 m heavy missile/railgun cruiser, single-unit def
(squad_size 1 -> clips render).  WATERLINE AT Y=0 (hull below to a 3.2 m
draft, deck at ~4.0 m), bow at -Z.

Silhouette identity for the tier: ONE MONOLITHIC FACETED TUMBLEHOME
PYRAMID amidships (z -6 .. +14, rising to a flat roof at 11 m) and NO
FUNNEL — bridge, uptakes and mast base are all inside the one wedge.
The hull itself is tumblehome too: deck edge (half 3.6) is narrower than
the waterline half-beam (4.75), with a wave-piercing raked stem and a
transom stern.  Short, angular section list: straight runs, hard breaks.

Rig: turret->barrel->muzzle (railgun, fo'c'sle), turret2->turret2_barrel
->muzzle2 (CIWS on the deckhouse roof aft), bare muzzle3 at the centre of
the flush VLS block (a VLS has nothing to traverse), `radar` bar on the
masthead (idle clip, full Y turn).  2048 atlas (55 m dominant dim).
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v runs DOWN the image) ───────────────────────────
S_HULL_SIDE = Zone((0,    0,    2048, 340),  ('z', 'y'), ((-27.5, 27.5), (4.9, -3.4)))
S_DECK      = Zone((0,    340,  2048, 620),  ('z', 'x'), ((-27.5, 27.5), (-5.0, 5.0)))
S_BELLY     = Zone((0,    620,  2048, 780),  ('z', 'x'), ((-27.5, 27.5), (-5.0, 5.0)))
S_BOW       = Zone((0,    780,  300,  1060), ('x', 'y'), ((-4.0, 4.0), (5.0, -3.4)))
S_STERN     = Zone((300,  780,  640,  1060), ('x', 'y'), ((-4.6, 4.6), (4.6, -2.6)))
S_DH_SIDE   = Zone((640,  780,  1560, 1060), ('z', 'y'), ((-6.5, 14.5), (11.4, 3.8)))
S_DH_END    = Zone((1560, 780,  1900, 1060), ('x', 'y'), ((-3.6, 3.6), (11.4, 3.8)))
S_DH_ROOF   = Zone((0,    1060, 760,  1340), ('z', 'x'), ((-6.5, 14.5), (-3.6, 3.6)))
S_WIN_SIDE  = Zone((760,  1060, 1300, 1145), ('z', 'y'), ((-6.5, 4.5), (9.6, 8.1)))
S_WIN_END   = Zone((1300, 1060, 1560, 1145), ('x', 'y'), ((-3.3, 3.3), (9.6, 8.1)))
S_VLS_TOP   = Zone((1560, 1060, 2048, 1340), ('z', 'x'), ((-17.2, -8.3), (-2.9, 2.9)))
S_VLS_SIDE  = Zone((760,  1150, 1300, 1250), ('z', 'y'), ((-17.4, -8.1), (4.75, 3.85)))
S_TUR       = Zone((0,    1340, 420,  1620), ('x', 'z'), ((-2.0, 2.0), (-2.0, 2.0)))
S_TUR_SIDE  = Zone((420,  1340, 760,  1620), ('z', 'y'), ((-2.2, 2.2), (2.2, -0.2)))
S_TUR2      = Zone((760,  1340, 1060, 1620), ('x', 'z'), ((-1.3, 1.3), (-1.3, 1.3)))
S_RADAR     = Zone((1060, 1340, 1500, 1620), ('x', 'y'), ((-2.7, 2.7), (0.8, -0.8)))
# flat-colour greeble cells: HUGE windows so every world point lands inside
S_DARK      = Zone((1500, 1340, 1620, 1460), ('x', 'y'), ((-90, 90), (-90, 90)))
S_GREY      = Zone((1620, 1340, 1740, 1460), ('x', 'y'), ((-90, 90), (-90, 90)))
S_GREEB     = Zone((1740, 1340, 1900, 1460), ('x', 'y'), ((-90, 90), (-90, 90)))
S_HAZ       = Zone((1900, 1340, 2048, 1460), ('x', 'y'), ((-90, 90), (-90, 90)))
S_NAV_P     = Zone((1500, 1460, 1560, 1520), ('x', 'y'), ((-90, 90), (-90, 90)))
S_NAV_S     = Zone((1560, 1460, 1620, 1520), ('x', 'y'), ((-90, 90), (-90, 90)))

R_MAST      = (1620, 1460, 1900, 1560)   # rect: mast, posts, bollards
R_BARREL    = (0,    1620, 700,  1800)   # rect: railgun tube + rails
R_CAP       = (700,  1620, 900,  1800)   # rect: CYAN capacitor rings
R_GAT       = (900,  1620, 1120, 1800)   # rect: CIWS gatling barrels
R_RAIL      = (1120, 1620, 1300, 1720)   # rect: deck railings
R_PIPE      = (1120, 1720, 1300, 1800)   # rect: small pipework / ladders

# ── hull (world metres; WATERLINE Y=0, bow -Z) ───────────────────────────
# section: (z, y_keel, w_keel, y_bilge, w_bilge, w_wl, y_deck, w_deck)
# w_deck < w_wl everywhere == TUMBLEHOME topsides.
HULL_SECTIONS = [
    (-27.5, -1.20, 0.14, -0.70, 0.30, 0.46, 4.70, 0.34),   # wave-piercing stem
    (-24.0, -2.45, 0.50, -1.60, 1.50, 2.25, 4.45, 1.90),
    (-18.0, -3.10, 1.10, -2.00, 3.20, 4.15, 4.05, 3.30),
    (-8.0,  -3.20, 1.50, -2.00, 4.10, 4.75, 4.00, 3.60),
    (6.0,   -3.20, 1.50, -2.00, 4.10, 4.75, 4.00, 3.60),
    (18.0,  -3.05, 1.42, -1.90, 3.92, 4.62, 4.00, 3.52),
    (24.0,  -2.62, 1.32, -1.72, 3.62, 4.32, 4.05, 3.42),
    (27.5,  -2.20, 1.24, -1.50, 3.34, 4.02, 4.10, 3.34),   # transom
]
BOOT_TOP = (-0.35, 0.30)        # painted boot-top band straddling Y=0
DECK_Y = 4.00

# ── the wedge: ONE monolithic faceted tumblehome deckhouse, NO funnel ────
# level: (y, half_x, z_fwd, z_aft, corner_cut)
DH_LEVELS = [
    (4.00, 3.40, -6.00, 14.00, 1.20),
    (8.20, 2.58, -4.80, 13.20, 0.98),   # under the bridge window belt
    (9.50, 2.42, -4.50, 13.00, 0.90),   # over the belt
    (11.00, 2.15, -4.20, 12.60, 0.78),  # roof
]
DH_WIN_Y = (8.20, 9.50)         # the window band (belt between levels 1-2)
DH_WIN_Z = 4.20                 # windows only forward of this z
DH_ROOF_Y = 11.00

# ── flush VLS cell block (slot 3 — no traverse, bare muzzle3) ────────────
VLS_Z = (-17.0, -8.5)
VLS_HX = 2.70
VLS_TOP = 4.42                  # coaming top
VLS_LID = 4.46                  # lid plates
VLS_COLS, VLS_ROWS = 6, 4       # 6 along z, 4 across x
VLS_OPEN = ((1, 1), (4, 2))     # (col,row) cells with the lid flung open
MUZZLE3 = (0.0, VLS_LID + 0.12, -12.75)

# ── weapon mounts ────────────────────────────────────────────────────────
TUR_MOUNT = (0.0, 4.22, -20.0)          # railgun barbette on the fo'c'sle
TUR_PIVOT = (0.0, 1.25, -1.00)          # barrel pivot, turret-local
BARREL_LEN = 5.50                       # tip lands at world z -26.5
CAP_RINGS = (-0.55, -1.55, -2.55, -3.55, -4.55)   # cyan capacitor rings
TUR2_MOUNT = (0.0, DH_ROOF_Y, 11.00)    # CIWS on the wedge roof, aft
TUR2_PIVOT = (0.0, 0.82, -0.55)
GAT_LEN = 1.35

# ── mast + radar (masthead ~19 m air draft) ──────────────────────────────
MAST_Z = 2.00
MAST_BASE_Y = DH_ROOF_Y
MAST_TOP_Y = 18.30
MAST_YARD_Y = 15.40
MAST_YARD_HX = 1.65
RADAR_OFF = (0.0, 18.40, MAST_Z)
RADAR_SPAN = 5.20               # bar length (x)

# ── deck furniture ───────────────────────────────────────────────────────
BREAKWATER_Z = -18.4
RAIL_FWD = (-26.0, -18.0)
RAIL_AFT = (15.0, 26.0)
BOLLARD_Z = (-23.0, -18.6, 16.5, 24.5)
CAPSTAN = (0.0, 25.3)           # x, z
LOCKER = (0.0, 20.0)            # x, z of the aft deck locker
