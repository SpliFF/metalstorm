"""ms_shipyard_layout — zones + dims for ms_shipyard (naval factory).

Floating graving dock: two ballast caissons (dock walls) running the
full 46 m along Z, an open wet basin between them at the water surface,
a covered ribbed ship hall over the aft half with a half-submerged
arched SUBMARINE PEN mouth in its aft wall, an open fitting-out basin
forward with deck clutter, and a travelling gantry crane (`crane`
piece) riding rails along the caisson decks.

WATERLINE AT Y = 0 (preamble §4) — caisson bottoms -2.6, deck top +3.0,
hall eaves +9.6, roof ridge +14.0, gantry top +16.0.  Bow convention
-Z = seaward / open end.  Buildbox: footprint 18 x 24 cells -> 36 x 48 m,
so nothing may exceed |x| 18.0 or |z| 24.0.  2048² atlas, v down.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── principal dimensions (world metres) ──────────────────────────────────
Z_FWD, Z_AFT = -23.0, 23.0          # caisson ends (46.0 m overall)
CAIS_XC = 14.5                      # caisson centreline |x|
CAIS_W = 5.0                        # caisson width  -> |x| 12.0 .. 17.0
CAIS_IN = CAIS_XC - CAIS_W / 2      # 12.0 basin edge
CAIS_OUT = CAIS_XC + CAIS_W / 2     # 17.0 outboard face
CAIS_BOT = -2.6                     # keel of the ballast caissons
DECK_Y = 3.0                        # main deck top

GATE_Z = (-23.0, -21.6)             # seaward gate sill (submerged, top +0.6)
GATE_TOP = 0.6

XCROSS_Z = (21.6, 23.0)             # aft cross caisson (split by the pen)
PEN_HW = 5.0                        # pen mouth half-width
PEN_BACK = 19.4                     # dark back wall inside the pen
PEN_SILL = -2.6

HALL_Z = (1.5, 21.6)                # covered ship hall extent
EAVE_Y = 9.6                        # hall side-wall top / eaves
RIDGE_Y = 14.0                      # roof ridge
ROOF_OVER = 0.45                    # roof overhang past the walls
DOOR_HW = (8.0, 12.5)               # sliding leaves park between these |x|
DOOR_TOP = 9.2
RIB_Z = (3.5, 8.0, 12.5, 17.0, 21.0)
STACK_Z = (6.0, 12.0, 18.0)         # extract stacks on the ridge
STACK_TOP = 15.4

# ── forward deck fittings (fitting-out basin, z -23 .. +1.5) ─────────────
RAIL_X = 12.25                      # deck-edge railing (inboard)
RAIL_Z = (-21.5, 0.8)
RAIL_H = 1.05
CRANE_RAIL_X = 16.0                 # gantry rails on the caisson decks
BOLLARD_Z = (-19.0, -12.0, -5.0, 0.0)
FENDER_Z = (-20.0, -14.0, -8.0, -2.0)
CHAIN_Z = (-17.0, -9.0, -1.0)
LADDER_Z = (-16.0, 4.0)

SLIP_X = (-12.0, -8.2)              # slipway ramp, starboard caisson
SLIP_Z = (-17.0, -9.5)
SLIP_Y = (DECK_Y, -0.7)

OFFICE = (13.5, -19.3, (2.7, 2.7, 4.0))     # x, z, (w,h,d) — port deck
PLATES = [(13.6, -13.0, (2.5, 0.85, 3.4)),  # stacked plate steel
          (13.6, -8.6, (2.5, 0.62, 3.0)),
          (-13.6, -4.0, (2.5, 0.75, 3.2))]
SKIPS = [(-13.5, -20.0, (2.2, 1.35, 2.6)),
         (13.5, -3.4, (2.1, 1.25, 2.4))]
RACKS = [(-13.5, -13.2), (13.6, -1.2)]          # gas-bottle racks (x, z)
REELS = [(-13.4, -0.6), (13.4, -16.0)]          # cable reels (x, z)

# ── gantry crane (piece `crane`, PIECE-LOCAL coords) ─────────────────────
CRANE_OFF = (0.0, DECK_Y, -11.0)    # rest offset on the body
CR_LEG_X = CRANE_RAIL_X             # rail centreline
CR_SPAN = 17.4                      # bridge girder half-span (local x)
CR_BRIDGE_Y = 11.0                  # girder centre (world 14.0)
CR_TOP = 13.0                       # machinery house top (world 16.0)
CR_TROLLEY_Y = 9.9
CR_HOOK_Y = 5.4
CRANE_Z0, CRANE_Z1 = -20.0, -2.0    # travel limits (absolute node z)

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
W_DECK     = Zone((0, 0, 2048, 512),        ('z', 'x'), ((-23.5, 23.5), (-17.5, 17.5)))
W_CAIS_OUT = Zone((0, 512, 2048, 768),      ('z', 'y'), ((-23.5, 23.5), (3.2, -2.8)))
W_CAIS_IN  = Zone((0, 768, 2048, 960),      ('z', 'y'), ((-23.5, 23.5), (3.2, -2.8)))
W_WALL     = Zone((0, 960, 1408, 1216),     ('z', 'y'), ((1.0, 23.5), (9.8, 2.8)))
W_WALL_IN  = Zone((1408, 960, 2048, 1216),  ('z', 'y'), ((1.0, 23.5), (9.8, 2.8)))
W_ROOF     = Zone((0, 1216, 1408, 1536),    ('z', 'x'), ((1.0, 23.5), (-17.5, 17.5)))
W_ROOF_IN  = Zone((1408, 1216, 2048, 1408), ('z', 'x'), ((1.0, 23.5), (-17.5, 17.5)))
W_END      = Zone((1408, 1408, 2048, 1536), ('x', 'y'), ((-17.5, 17.5), (3.2, -2.8)))
W_GABLE    = Zone((0, 1536, 768, 1856),     ('x', 'y'), ((-17.5, 17.5), (14.5, 2.8)))
W_AFT      = Zone((768, 1536, 1408, 1856),  ('x', 'y'), ((-17.5, 17.5), (14.5, -2.8)))
W_PEN      = Zone((1408, 1536, 1664, 1792), ('x', 'y'), ((-6.0, 6.0), (3.4, -2.8)))
W_DOOR     = Zone((1664, 1536, 2048, 1792), ('x', 'y'), ((-13.0, 13.0), (9.6, 2.8)))
W_CR_TOP   = Zone((1408, 1792, 2048, 1856), ('x', 'z'), ((-18.0, 18.0), (-1.3, 1.3)))
W_CRANE    = Zone((0, 1856, 768, 2048),     ('z', 'y'), ((-3.6, 3.6), (13.6, -0.6)))
W_CRANE_F  = Zone((768, 1856, 1024, 2048),  ('x', 'y'), ((-18.0, 18.0), (13.6, -0.6)))
W_OFFICE   = Zone((1024, 1856, 1280, 2048), ('x', 'y'),
                  ((OFFICE[0] - 2.2, OFFICE[0] + 2.2), (DECK_Y + 3.4, DECK_Y - 0.4)))
W_OBJ      = Zone((1280, 1856, 1536, 2048), ('x', 'y'), ((-2.2, 2.2), (2.2, -2.2)))
W_DARK     = Zone((1920, 1856, 2048, 1920), ('x', 'y'), ((-60.0, 60.0), (60.0, -60.0)))

# parametric (limb/tube) rects
W_GIRDER = (1536, 1856, 1792, 1920)
W_RAIL   = (1536, 1920, 1792, 1984)
W_FENDER = (1536, 1984, 1792, 2048)
W_CHAIN  = (1792, 1856, 1920, 1920)
W_ROPE   = (1792, 1920, 1920, 1984)
W_LAMP   = (1792, 1984, 1920, 2048)
W_STACK  = (1920, 1920, 2048, 1984)
W_REEL   = (1920, 1984, 2048, 2048)
W_RIB    = (1792, 1856, 1920, 1920)   # roof purlin ribs (shares W_CHAIN cell)


def mir(z):
    """Mirrored TWIN of a zone: same atlas rect, same painted pixels, u-axis
    window reversed.

    A planar zone is sampled by faces on BOTH sides of its projection axis.
    On one side screen-right runs WITH the u axis, on the other AGAINST it,
    so PIL lettering painted into the cell reads mirrored on that second
    side (preamble §7).  For an ('x','y') zone the reversed side is every
    -Z-facing face; for a ('z','y') zone it is every +X-facing face.  Handing
    those faces this twin flips their u lookup, so one painted cell reads
    correctly from both sides.  Nothing is painted THROUGH a twin, so the
    flipped-window PIL corner-order trap never applies.
    """
    (a0, a1), b = z.win
    return Zone(z.rect, z.axes, ((a1, a0), b))
