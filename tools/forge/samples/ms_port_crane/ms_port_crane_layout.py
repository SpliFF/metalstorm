"""ms_port_crane_layout — zones + dims for ms_port_crane (resource site).

Named resource site: 20 m rail-mounted port gantry crane — portal legs on
rail bogies, box-girder jib over the water (-Z), traversing `trolley` piece
(idle clip: ABSOLUTE translation keys along the jib, seamless loop), hook
block hanging from the trolley, operator cab with emissive warm windows,
A-frame apex + tie rods, machinery house on the backreach. Map prop, no
team colour. Tri budget 1800.
World frame: forward -Z, up +Y, ground Y=0. Rails run along X; the jib
reaches waterside at -Z. Dominant dim >= 15 m -> 2048 atlas.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

BIG = ((-60, 60), (60, -60))           # huge world window -> flat swatch

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
R_BOOM_S  = Zone((0,    0,    1600, 128),  ('z', 'y'), ((-13.2, 5.2), (14.75, 13.45)))
R_BOOM_T  = Zone((0,    128,  1600, 224),  ('z', 'x'), ((-13.2, 5.2), (-1.0, 1.0)))
R_LEG     = (1600, 0,    1856, 192)    # parametric portal-leg wrap
R_TIE     = (1600, 192,  1856, 256)    # parametric tie-rod / apex wrap
R_SILL    = (1600, 256,  1856, 320)    # parametric sill-beam / brace wrap
R_CABLE   = (1600, 320,  1856, 352)    # hoist-cable wrap
R_HOUSE_S = Zone((0,    224,  640,  448),  ('z', 'y'), ((1.8, 5.0), (16.5, 14.6)))
R_HOUSE_F = Zone((640,  224,  1088, 448),  ('x', 'y'), ((-1.35, 1.35), (16.5, 14.6)))
R_HOUSE_T = Zone((1088, 224,  1536, 352),  ('z', 'x'), ((1.8, 5.0), (-1.35, 1.35)))
R_CAB_F   = Zone((0,    448,  384,  704),  ('x', 'y'), ((1.05, 2.75), (13.7, 11.55)))
R_CAB_S   = Zone((384,  448,  832,  704),  ('z', 'y'), ((-6.4, -4.0), (13.7, 11.55)))
R_CAB_T   = Zone((1088, 352,  1408, 448),  ('z', 'x'), BIG)
R_PORTAL  = Zone((832,  448,  1216, 576),  ('z', 'y'), BIG)
R_BOGIE   = Zone((832,  576,  1216, 704),  ('x', 'y'), BIG)
R_RAIL    = Zone((1216, 448,  1600, 512),  ('x', 'y'), BIG)
R_TROLLEY = Zone((0,    704,  384,  832),  ('z', 'y'), BIG)
R_HOOK    = Zone((384,  704,  640,  832),  ('z', 'y'), BIG)
R_MECH    = Zone((640,  704,  896,  832),  ('z', 'y'), BIG)
R_DARK    = Zone((896,  704,  1152, 832),  ('x', 'z'), BIG)
R_BEACON  = Zone((1152, 704,  1280, 832),  ('x', 'z'), BIG)
R_STEELG  = Zone((1280, 704,  1536, 832),  ('z', 'y'), BIG)

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
RAIL_Z    = 3.0                        # two rails at z = ±RAIL_Z, along X
RAIL_LEN  = 15.0                       # x -7.5 .. 7.5
RAIL_H    = 0.30
RAIL_W    = 0.40
STOP_X    = 7.2                        # rail end-stop blocks

BOGIE_X   = 4.2                        # bogie centres at (±BOGIE_X, ±RAIL_Z)
BOGIE     = (2.4, 0.75, 0.75)          # size; centre y = RAIL_H + h/2
BOGIE_CY  = RAIL_H + 0.375

LEG_TOP_X, LEG_TOP_Z = 2.2, 2.5        # legs taper inward toward portal top
LEG_TOP_Y = 13.0
LEG_R0, LEG_R1 = 0.42, 0.32
SILL_R    = 0.16                       # sill beams linking bogies along X
BRACE_R   = 0.08

PORTAL    = (0.95, 0.8, 5.8)           # portal top beams at x=±LEG_TOP_X
PORTAL_CY = 13.25

BOOM      = (0.0, 14.1, -4.0, 1.8, 1.1, 18.0)   # box girder, z -13 .. +5
BOOM_BOT  = 13.55
BOOM_TIP_Z = -13.0

APEX      = (0.0, 19.7, 1.0, 0.65, 0.5, 0.65)   # apex block, top ~19.95
APEX_R0, APEX_R1 = 0.20, 0.14
TIE_R     = 0.07

HOUSE     = (0.0, 15.45, 3.4, 2.5, 1.6, 3.0)    # machinery house on backreach
STACK     = (0.85, 3.9)                # exhaust stub x, z (top of house)

CAB       = (1.9, 12.6, -5.2, 1.6, 2.0, 2.2)    # operator cab, hangs off +x
CAB_WIN_Y = (13.35, 12.25)             # window band (world y hi, lo)

# trolley piece (parent body) — rides under the boom girder
TROLLEY_OFF = (0.0, 13.4, -2.0)        # rest position (pivot on boom underside)
TR_FRAME  = (0.0, 0.05, 0.0, 1.9, 0.5, 1.6)     # trolley-local
TR_SHEAVE = 0.45                       # sheave housings at x=±TR_SHEAVE
HOOK_Y    = -4.1                       # cable bottom (trolley-local)
HOOK_BLK  = (0.0, -4.35, 0.0, 0.6, 0.7, 0.35)

# idle traverse clip — ABSOLUTE translation keys along the jib (z)
TRAV_PERIOD = 16.0                     # seconds
TRAV_AMP    = 5.5                      # ± about rest z -> z in [-7.5, +3.5]
