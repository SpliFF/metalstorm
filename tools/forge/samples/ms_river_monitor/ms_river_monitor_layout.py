"""ms_river_monitor_layout — zones + dims for ms_river_monitor.

s2 ships-row (35 m) armoured riverine gunboat: shallow draft, low
freeboard, sloped casemate armour amidships, single twin-gun main
turret forward on the casemate roof (turret/barrel/muzzle chain, twin
barrels on the one barrel piece), armoured wheelhouse with emissive
slit windows aft on the casemate, stub raked funnel, nav radar bar
(idle clip). Waterline at Y=0, flat bottom ~1.15 m below (shallow
draft), painted boot-top band astride the waterline. Forward -Z.
2048 atlas (35 m dominant dim >= 15 m). Order register: uniform
panels, hull number stencil, team colour on hull ID panels only.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
S_HULL_SIDE = Zone((0,    0,    2048, 300),  ('z', 'y'), ((-17.5, 17.5), (2.1, -1.3)))
S_DECK      = Zone((0,    300,  2048, 540),  ('z', 'x'), ((-17.5, 17.5), (-3.7, 3.7)))
S_BELLY     = Zone((0,    540,  2048, 760),  ('z', 'x'), ((-17.5, 17.5), (-3.1, 3.1)))
S_CASE_S    = Zone((0,    760,  1408, 980),  ('z', 'y'), ((-9.0, 9.0), (3.35, 1.4)))
S_CASE_TOP  = Zone((1408, 760,  2048, 980),  ('z', 'x'), ((-7.4, 7.4), (-2.5, 2.5)))
S_CASE_END  = Zone((0,    980,  352,  1180), ('x', 'y'), ((3.4, -3.4), (3.35, 1.4)))
S_WH_S      = Zone((352,  980,  768,  1180), ('z', 'y'), ((1.9, 5.2), (5.0, 3.1)))
S_WH_F      = Zone((768,  980,  1056, 1180), ('x', 'y'), ((1.6, -1.6), (5.0, 3.1)))
S_WH_TOP    = Zone((1056, 980,  1344, 1180), ('x', 'z'), ((-1.6, 1.6), (1.9, 5.2)))
S_TUR_S     = Zone((1344, 980,  1792, 1180), ('z', 'y'), ((-2.3, 2.3), (1.75, -0.35)))
S_TUR_F     = Zone((1792, 980,  2048, 1180), ('x', 'y'), ((2.0, -2.0), (1.75, -0.35)))
S_TUR_T     = Zone((0,    1180, 448,  1380), ('x', 'z'), ((-1.9, 1.9), (-2.2, 2.2)))
S_BARREL    = (448,  1180, 640,  1380)   # parametric barrel wrap
S_MAST      = (640,  1180, 768,  1380)   # parametric mast/post/bollard wrap
S_FUNNEL    = (768,  1180, 1024, 1380)   # parametric funnel wrap
S_TRIM      = Zone((1024, 1180, 1280, 1380), ('z', 'y'), ((-45, 45), (25, -5)))
S_DARK      = Zone((1280, 1180, 1408, 1380), ('x', 'z'), ((-1, 1), (-1, 1)))
S_BOW       = Zone((1408, 1180, 1664, 1420), ('x', 'y'), ((2.6, -2.6), (2.1, -0.6)))
S_STERN     = Zone((1664, 1180, 1920, 1420), ('x', 'y'), ((2.6, -2.6), (1.7, -0.5)))
S_RADAR     = Zone((0,    1380, 256,  1500), ('x', 'y'), ((-1.0, 1.0), (0.55, -0.25)))
S_HATCH     = Zone((256,  1380, 576,  1560), ('x', 'z'), ((-1.1, 1.1), (-1.1, 1.1)))
S_RAFT      = (576,  1380, 768,  1500)   # life-raft canister wrap

# ── dims (world metres; waterline Y=0, bow -Z) ───────────────────────────
# Hull sections: (z, y_bot, y_knuckle, y_deck, w_bot, w_knuckle, w_deck)
# Flat bottom (shallow draft); low freeboard deck ~1.55 m; sheer at the bow.
HULL_SECTIONS = [
    (-17.3, 0.45, 0.85, 2.00, 0.35, 0.65, 0.80),
    (-14.5, -0.45, 0.30, 1.80, 1.70, 2.45, 2.65),
    (-10.0, -1.05, 0.20, 1.60, 2.65, 3.30, 3.50),
    (-4.0,  -1.15, 0.20, 1.55, 2.85, 3.45, 3.60),
    (4.0,   -1.15, 0.20, 1.55, 2.85, 3.45, 3.60),
    (10.0,  -1.05, 0.20, 1.55, 2.70, 3.30, 3.45),
    (14.5,  -0.65, 0.20, 1.55, 2.10, 2.75, 2.95),
    (17.2,  -0.25, 0.20, 1.55, 1.40, 2.05, 2.25),
]
WATERLINE  = (-0.10, 0.40)          # boot-top band (painted, astride Y=0)
DECK_Y     = 1.55

# sloped casemate armour (amidships, on deck)
CASE_Z0, CASE_Z1   = -8.6, 8.7      # base footprint
CASE_TZ0, CASE_TZ1 = -7.0, 7.2      # roof footprint (sloped ends)
CASE_WB, CASE_WT   = 3.15, 2.30     # base / roof half-width (sloped sides)
CASE_TOP_Y         = 3.20

# main turret (on the casemate roof, forward)
TUR_MOUNT   = (0.0, 3.20, -3.6)     # piece offset on body
TUR_RING_R  = 1.85                  # base ring radius
BAR_OFF     = (0.0, 0.95, -1.35)    # barrel piece offset local to turret
BAR_LEN     = 5.6                   # barrel length (pivot -> muzzle)
BAR_R       = 0.17
BAR_SPACING = 0.48                  # twin barrel half-spacing
MUZ_OFF     = (0.0, 0.0, -BAR_LEN)  # muzzle empty local to barrel

# wheelhouse (armoured, aft on the casemate roof)
WH          = (0.0, 4.05, 3.55, 2.9, 1.7, 3.2)     # x,y,z centre + w,h,d
WH_SLIT_Y   = 4.55                  # slit window strip height (world)

# stub funnel (raked, aft of the wheelhouse)
FUNNEL_BASE = (0.0, 3.20, 6.4)
FUNNEL_TOP  = (0.0, 4.75, 6.75)
FUNNEL_R0, FUNNEL_R1 = 0.52, 0.44

# mast + radar on the wheelhouse roof
MAST_FOOT   = (0.0, 4.90, 3.0)
MAST_TOP    = (0.0, 6.55, 3.0)
YARD_HW     = 0.75                  # crosstree half-width at y=6.1
RADAR_OFF   = (0.0, 6.70, 3.0)      # radar piece pivot

# deck fittings
BOLLARDS    = [(-13.6, 1), (-13.6, -1), (13.8, 1), (13.8, -1)]  # z, side
HATCHES     = [(-11.5,), (11.6,)]   # deck hatch coamings fore + aft
RAFTS       = [(2.62, 1.5), (-2.62, 1.5)]   # x, z canisters on casemate side
RAFT_R, RAFT_LEN = 0.26, 1.4
EXHAUST_OFF = (0.0, 4.85, 6.75)     # FX empty at the funnel mouth
