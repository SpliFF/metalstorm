"""ms_anc_aqueduct_layout — zones + dims for ms_anc_aqueduct.

ANCIENT-REGISTER terrain feature: a 30 m tall monumental aqueduct section
carrying a sealed channel.  Two tiers of perfect arches (2 great arches
below, 6 small ones above), a single cantilevered cornice, and a sealed
channel capped by a projecting rim that carries the cyan pulse line.
Monolithic pale stone: large unbroken surfaces cut only by clean recessed
seams and perfect circles — no rivets, no bolted patches, no scrap.

TILEABLE along z: the piers of BOTH arcades sit centred on z = -15 and
z = +15 and are clipped there, so two chained segments make one whole
pier; the cornice, channel and rim run the full length at full section.
Bay pitches (15 m lower, 5 m upper) divide 30 m exactly.

One upper arch (bay centre z = +2.5) is BREACHED: its whole crown wedge is
gone, the channel above spans the gap unsupported, and a fossilised
calcite flow spills out of the ruptured channel floor, drapes the cornice
and the pier at z = 0 and pools on the ground.

Static, single `body` piece, no clips, no team colour.
Frame: forward -Z, up +Y, ground Y = 0, 1 u = 1 m.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

ATLAS = 2048

# ── tileable envelope ────────────────────────────────────────────────────
Z0, Z1 = -15.0, 15.0
H_TOTAL = 30.0

# ── lower arcade: 2 great arches ─────────────────────────────────────────
LP_Z = [-15.0, 0.0, 15.0]            # pier centres (ends are half piers)
LP_W = 3.2                            # pier width along z
LP_HX = 2.8                           # pier half thickness in x
L_TOP = 20.0                          # top of the lower tier wall
L_SPRING = 12.0                       # springing line
L_R = 5.9                             # arch radius = clear half span
L_BAYS = [-7.5, 7.5]
L_N = 16                              # arch segments

# stepped base course (grand plinth) + soil drift
BASE_H = 2.0
BASE_HX = 3.15
BASE_DZ = 1.4                         # extra z length beyond the pier
BERM_H = 1.1
BERM_HX = 3.6
BERM_DZ = 2.6

# impost blocks at the springing line (lower piers only)
IMP_Y0, IMP_Y1 = 11.9, 12.85
IMP_HX = 3.05
IMP_DZ = 1.2

# keystones straddling the two great crowns
KEY_HX = 3.05
KEY_DZ = 2.4                          # z length of the keystone block

# ── cornice: one unbroken cantilevered band ──────────────────────────────
COR_Y0, COR_Y1 = 20.0, 21.0
COR_HX = 3.3

# ── upper arcade: 6 small arches ─────────────────────────────────────────
UP_Z = [-15.0, -10.0, -5.0, 0.0, 5.0, 10.0, 15.0]
UP_W = 1.8
UP_HX = 2.2
U_Y0, U_TOP = 21.0, 26.5
U_SPRING = 23.4
U_R = 1.6
U_BAYS = [-12.5, -7.5, -2.5, 2.5, 7.5, 12.5]
U_N = 10
BREACH_BAY = 2.5                      # which bay is breached
BREACH_A, BREACH_B = 0.3, 0.7         # break window, fractions of pi

# ── sealed channel + rim ─────────────────────────────────────────────────
CH_Y0, CH_Y1 = 26.5, 29.2
CH_HX = 1.9
RIM_Y0, RIM_Y1 = 29.2, 30.0
RIM_HX = 2.2
RIM_LINE_Y = 29.62                    # cyan pulse line height

# rupture in the channel floor above the breached bay
RUP_Z0, RUP_Z1 = 1.7, 3.3
RUP_HX = 1.3
RUP_Y = 27.2                          # calcite plug plate seen through it

# ── perfect-circle motif on the lower piers ──────────────────────────────
DISC_Y = 6.0
DISC_R = 1.5                          # < LP_W/2 so it never spills the pier

# ── atlas zones (2048²; v runs down) ─────────────────────────────────────
# The elevation zone is ISOTROPIC (30 m over 1280 px on both axes) so that
# painted circles stay perfect circles.  x 1280..1408 is a guard band that
# absorbs the half-discs drawn at the tile ends.
Z_ELEV = Zone((0, 0, 1280, 1280), ('z', 'y'), ((-15.0, 15.0), (30.0, 0.0)))
Z_TOP = Zone((0, 1300, 1280, 1580), ('z', 'x'), ((-15.0, 15.0), (-3.3, 3.3)))
Z_SOIL = Zone((0, 1600, 1280, 1760), ('z', 'y'), ((-15.0, 15.0), (2.2, -0.2)))
Z_STONE = Zone((1408, 0, 1664, 512), ('x', 'y'), ((-3.3, 3.3), (30.0, 0.0)))
Z_CORE = Zone((1664, 0, 1920, 256), ('x', 'y'), ((-3.3, 3.3), (30.0, 0.0)))
Z_SOFF = Zone((1408, 512, 1920, 768), ('x', 'y'), ((-3.3, 3.3), (30.0, 0.0)))
Z_CALC = Zone((1408, 768, 1920, 1280), ('x', 'y'), ((-3.3, 3.3), (30.0, 0.0)))
