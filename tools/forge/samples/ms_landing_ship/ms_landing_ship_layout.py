"""ms_landing_ship_layout — zones + dims for ms_landing_ship (LSV Peltast).

s2 line ship per art/STYLE.md ships row: 35 m armoured landing ship,
beam ~8.6 m, footprint 10. Keel at Y=0 (viewer sits it on ground; in
water the SHIP movedef handles draft), painted boot-top waterline per
fable_battleship. Forward = -Z (bow).

One U-section loft builds hull + bulwarks + the open vehicle well deck
in a single skin; the floor rises to 3.95 m aft of z≈10.6 which forms
the raised quarterdeck the bridge sits on. Bow ramp is the animated
`ramp` piece hinged at the well-floor sill (clip `unload` lowers it
-102° about X so the lip lands ahead of and slightly below the keel
line — beaching reach). Four cradle link empties `link1..link4` on the
well centreline per the fable_airship ZK transport contract
(QueryTransport returns a link piece, AttachUnit snaps the passenger
to it). 2048² atlas (35 m dominant dim ≥ 15 m).
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
S_HULL_SIDE = Zone((0,    0,    2048, 320),  ('z', 'y'), ((-17.5, 17.5), (5.0, -0.1)))
S_WELL_FLOOR= Zone((0,    320,  2048, 576),  ('z', 'x'), ((-17.5, 17.5), (-4.2, 4.2)))
S_WELL_WALL = Zone((0,    576,  2048, 756),  ('z', 'y'), ((-17.5, 17.5), (4.8, 1.5)))
S_RIM       = Zone((0,    756,  2048, 836),  ('z', 'x'), ((-17.5, 17.5), (-4.5, 4.5)))
S_AFT_DECK  = Zone((0,    836,  640,  1092), ('z', 'x'), ((10.8, 17.5), (-4.2, 4.2)))
S_BRIDGE_S  = Zone((640,  836,  1152, 1092), ('z', 'y'), ((12.0, 17.6), (6.6, 3.8)))
S_BRIDGE_F  = Zone((640,  836,  1152, 1092), ('x', 'y'), ((3.0, -3.0), (6.6, 3.8)))
S_RAMP_OUT  = Zone((1152, 836,  1704, 1092), ('x', 'y'), ((2.7, -2.7), (3.4, -0.3)))
S_TRIM      = Zone((1704, 836,  1960, 1092), ('z', 'y'), ((-45, 45), (25, -5)))
S_DARK      = Zone((1960, 836,  2048, 1092), ('x', 'z'), ((-1, 1), (-1, 1)))
S_BOW       = Zone((0,    1092, 384,  1348), ('x', 'y'), ((3.4, -3.4), (5.1, 0.5)))
S_STERN     = Zone((384,  1092, 768,  1348), ('x', 'y'), ((3.9, -3.9), (4.6, 0.1)))
S_BRTOP     = Zone((768,  1092, 1152, 1348), ('x', 'z'), ((-3.0, 3.0), (12.4, 17.2)))
S_RAMP_IN   = Zone((1152, 1092, 1704, 1348), ('x', 'y'), ((-2.7, 2.7), (3.4, -0.3)))
S_RAIL      = (1704, 1092, 1960, 1348)   # parametric limb wrap: hazard rails
S_RADAR     = Zone((0,    1348, 256,  1476), ('x', 'y'), ((-1.1, 1.1), (0.62, -0.2)))
S_STACK     = (256, 1348, 512, 1476)     # parametric stack wrap
S_RAFT      = (512, 1348, 768, 1476)     # life-raft canister wrap
S_CRADLE    = Zone((768,  1348, 1280, 1476), ('z', 'y'), ((-45, 45), (25, -5)))
S_LIGHT     = Zone((1280, 1348, 1408, 1476), ('x', 'z'), ((-45, 45), (-25, 25)))
S_MAST      = (1408, 1348, 1664, 1476)   # parametric mast/post wrap
S_BELLY     = Zone((0,    1476, 2048, 1732), ('z', 'x'), ((-17.5, 17.5), (-4.2, 4.2)))

# ── dims (world metres; keel Y=0, bow -Z) ────────────────────────────────
# U-ring sections: (z, y_bot, y_knuckle, y_top, y_floor, w_bot, w_knuckle,
#                   w_top, w_inner)
# y_top = bulwark cap height (sheer rises at the bow); y_floor = well deck
# floor (jumps to 3.95 aft of z=10.6 -> raised quarterdeck); w_inner =
# inboard face of the 0.6 m bulwark.
HULL_SECTIONS = [
    (-16.6, 0.90, 2.40, 4.75, 1.95, 2.00, 2.90, 3.15, 2.55),
    (-14.0, 0.35, 2.20, 4.60, 1.80, 2.80, 3.50, 3.70, 3.10),
    (-10.0, 0.00, 1.90, 4.45, 1.70, 3.40, 3.95, 4.10, 3.50),
    (-4.0,  0.00, 1.80, 4.35, 1.70, 3.70, 4.15, 4.25, 3.65),
    (4.0,   0.00, 1.80, 4.30, 1.70, 3.75, 4.20, 4.30, 3.70),
    (10.0,  0.00, 1.80, 4.30, 1.70, 3.60, 4.10, 4.20, 3.60),
    (11.4,  0.02, 1.80, 4.30, 3.95, 3.55, 4.05, 4.15, 3.55),
    (14.5,  0.10, 1.90, 4.30, 3.95, 3.30, 3.90, 4.00, 3.40),
    (17.3,  0.35, 2.00, 4.30, 3.95, 2.90, 3.55, 3.70, 3.05),
]
WATERLINE   = (1.00, 1.55)          # boot-top band (painted)
FLOOR_Y     = 1.70                  # well deck floor
AFT_DECK_Y  = 3.95                  # raised quarterdeck

# bow ramp — piece origin ON the hinge line (well-floor sill at the bow)
RAMP_HINGE  = (0.0, 1.95, -16.6)    # piece offset
RAMP_W      = 5.00                  # plate width  (mouth is ±2.55)
RAMP_H      = 3.10                  # plate length hinge->lip (raised = up)
RAMP_T      = 0.28                  # plate thickness
RAMP_DROP   = -102.0                # unload clip: rotation about X (deg)

# well deck cradle (vehicle slots, s2 tank pitch ~6 m)
LINKS       = [(0.0, 2.05, -10.5), (0.0, 2.05, -4.5),
               (0.0, 2.05, 1.5),  (0.0, 2.05, 7.5)]   # link1..link4
RAIL_RUN    = (-13.0, 10.0)         # guide rails along the floor (z span)
RAIL_X      = 1.55                  # guide rail half-spacing
BEAM_W      = 5.9                   # cradle cross-beam width

# hazard rails on the bulwark caps
POST_Z0, POST_Z1, POST_N = -13.5, 10.0, 9
POST_H      = 0.85

# aft superstructure
BRIDGE      = (0.0, 5.15, 14.8, 5.6, 2.4, 4.4)     # x,y,z,w,h,d
MAST_FOOT   = (0.0, 6.35, 13.2)
MAST_TOP    = (0.0, 8.70, 13.2)
YARD_HW     = 0.95                  # crosstree half-width at y=8.1
RADAR_OFF   = (0.0, 6.72, 13.9)     # radar piece pivot on the bridge roof
STACKS      = [(2.45, 16.35), (-2.45, 16.35)]      # x,z; deck->5.85 m
STACK_TOP   = 5.85
RAFTS       = [(2.55, 15.1), (-2.55, 15.1)]        # canisters on the roof edge
RAFT_R, RAFT_LEN = 0.28, 1.5
BOLLARDS    = [(-15.0,), (9.2,)]    # z; posts go on both bulwark caps
EXHAUST_OFF = (2.45, 5.95, 16.35)   # FX empty at the starboard-side stack
