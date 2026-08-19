"""ms_radar_s3_layout — zones + dims for ms_radar_s3 (Coastal Surveillance Array).

STYLE.md radar row: s3 height = 8 m; spec tri budget <= 2000. Immobile
building, ground plane Y=0, everything on its own anchored pad.

Design language follows ms_radar_s1 (pad + cabinet + mast + rotating `dish`)
two tiers up, but the SILHOUETTE deliberately breaks from the dish family:
a tall braced tower carrying a wide flat PLANAR ARRAY BAR — a rotating
billboard, not a dish. This tier gains sonar, so the base reads as a
combined air/sea watch post: two salvaged container cabins, a horizontal
sonar cable winch with a wound-cable drum + fairlead, and a ribbed
hydrophone head stowed on a cradle.

World frame: cabins face -Z, up +Y, ground Y=0. RNG seed 90210.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
PAD        = (0.0, 0.175, 0.0, 5.6, 0.35, 5.6)   # cx,cy,cz,w,h,d
PAD_TOP    = 0.35
PLINTH     = (0.0, 0.465, 1.85, 5.4, 0.23, 1.6)
PLINTH_TOP = 0.58

CAB_W, CAB_H, CAB_D = 2.4, 1.6, 1.30
CAB_CZ     = 1.85
CAB_CY     = PLINTH_TOP + CAB_H / 2            # 1.38
CAB_TOP    = PLINTH_TOP + CAB_H                # 2.18
CAB_AX     = -1.25                             # left cabin (ladder + hydrophone)
CAB_BX     = 1.25                              # right cabin (sonar winch)

TOWER_BASE = PAD_TOP
TOWER_TOP  = 5.60
TOWER_HB   = 1.15                              # half-width at the pad
TOWER_HT   = 0.50                              # half-width at the head

# sonar winch (on cabin B roof)
WINCH_Y    = CAB_TOP + 0.44                    # drum axis height
DRUM_R     = 0.34
CABLE_R    = 0.28
DRUM_X0, DRUM_X1 = 0.60, 1.90
FAIRLEAD   = (1.25, CAB_TOP + 0.14, 2.42)

# hydrophone head + cradle (on cabin A roof), long axis +Z
HYD_X      = CAB_AX
HYD_Y      = CAB_TOP + 0.24
HYD_STA    = ((1.22, 0.05), (1.38, 0.15), (1.54, 0.17), (1.62, 0.20),
              (1.70, 0.17), (1.92, 0.17), (2.00, 0.20), (2.08, 0.17),
              (2.24, 0.15), (2.38, 0.06))

# rotating planar array (`dish` piece, local coords about the tower head)
DISH_OFF   = (0.0, TOWER_TOP, 0.0)
COLLAR_TOP = 0.30
ARR_W, ARR_H, ARR_T = 3.4, 1.6, 0.25
ARR_CY     = 1.16                              # panel centre, piece-local
ARR_Y0     = ARR_CY - ARR_H / 2                # 0.36  → world 5.96
ARR_Y1     = ARR_CY + ARR_H / 2                # 1.96  → world 7.56
WHIP_X     = 1.45
WHIP_TOP   = 2.40                              # world 8.00 — dominant dim
ELEM_COLS, ELEM_ROWS = 6, 2
ELEM_W, ELEM_H, ELEM_D = 0.46, 0.58, 0.05
ELEM_X0, ELEM_X1 = -1.55, 1.55
ELEM_ROW_Y = (0.82, 1.50)

# ── atlas zones (1024²; v down) ──────────────────────────────────────────
R_PAD     = Zone((0,   0,   384, 384),  ('x', 'z'), ((-2.9, 2.9), (-2.9, 2.9)))
R_PADS    = Zone((0,   384, 384, 440),  ('z', 'y'), ((-2.9, 2.9), (0.37, -0.02)))
R_PADS_F  = Zone((0,   384, 384, 440),  ('x', 'y'), ((-2.9, 2.9), (0.37, -0.02)))
R_PLI     = Zone((0,   440, 384, 496),  ('z', 'y'), ((-2.9, 2.9), (0.60, 0.33)))
R_PLI_F   = Zone((0,   440, 384, 496),  ('x', 'y'), ((-2.9, 2.9), (0.60, 0.33)))
R_TOWER   = (0,   496, 384, 624)        # parametric leg/brace wrap
R_TRIM    = (0,   624, 384, 688)        # parametric small-part wrap
R_CABLE   = (0,   688, 384, 752)        # wound sonar cable / cable runs
R_DRUM    = (0,   752, 384, 816)        # winch drum flanges
R_HYD     = (0,   816, 384, 880)        # hydrophone body
R_ARR_TB  = Zone((0,   880, 384, 944),  ('x', 'z'), ((-1.75, 1.75), (-0.14, 0.14)))
R_ARR_LR  = Zone((0,   944, 384, 1008), ('z', 'y'), ((-0.14, 0.14), (1.98, 0.34)))

R_CAB_F   = Zone((384, 0,   1024, 224), ('x', 'y'), ((-2.6, 2.6), (2.30, 0.50)))
R_ARRAY_F = Zone((384, 224, 896,  448), ('x', 'y'), ((-1.75, 1.75), (1.98, 0.34)))
R_LIGHT   = Zone((896, 224, 1024, 288), ('x', 'y'), ((-0.12, 0.12), (0.12, -0.12)))
R_DARK    = Zone((896, 288, 1024, 352), ('x', 'z'), ((-1, 1), (-1, 1)))
R_COLLAR  = (896, 352, 1024, 448)       # slew-collar wrap
R_ARRAY_B = Zone((384, 448, 896,  672), ('x', 'y'), ((-1.75, 1.75), (1.98, 0.34)))
R_CAB_S   = Zone((896, 448, 1024, 704), ('z', 'y'), ((1.15, 2.55), (2.30, 0.50)))
R_CAB_T   = Zone((384, 672, 896,  896), ('x', 'z'), ((-2.6, 2.6), (1.15, 2.55)))
R_SPARE   = (384, 896, 896, 1024)       # flat dark filler / slot-side pin

# pinned UV square for the slot-box side walls (inside R_DARK, flat colour)
PIN = (930, 305, 990, 335)
