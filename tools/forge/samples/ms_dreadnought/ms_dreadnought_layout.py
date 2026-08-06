"""ms_dreadnought_layout — zones + dims for ms_dreadnought (Leviathan).

UNIQUE s4 hero ship, ~80 m Anarchic salvage dreadnought welded from
three old warship hulls. Waterline at Y=0 (hull extends below to a
2.8 m draft), painted boot-top band, forward -Z. Three aimable main
gun chains per the fable_battleship convention: turret/barrel/muzzle
(A fore), turret3/... (B superfiring fore), turret2/... (C aft,
geometry baked facing +Z). Battle `flag` standard on the mainmast
waves in the idle clip. 2048 atlas (80 m dominant dim >= 15 m).
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
S_HULL    = Zone((0,    0,    2048, 300),  ('z', 'y'), ((-38.0, 38.0), (5.9, -2.9)))
S_BELLY   = Zone((0,    300,  2048, 440),  ('z', 'x'), ((-38.0, 38.0), (-7.2, 7.2)))
S_DECK    = Zone((0,    440,  2048, 740),  ('z', 'x'), ((-38.0, 38.0), (-7.2, 7.2)))
S_SUP_S   = Zone((0,    740,  1024, 980),  ('z', 'y'), ((-17.0, 17.0), (12.6, 4.0)))
S_SUP_F   = Zone((1024, 740,  1560, 980),  ('x', 'y'), ((-4.6, 4.6),   (12.6, 4.0)))
S_SUP_T   = Zone((1560, 740,  2048, 980),  ('x', 'z'), ((-4.6, 4.6),   (-17.0, 17.0)))
S_TUR_S   = Zone((0,    980,  440,  1180), ('z', 'y'), ((-3.7, 3.7),   (2.7, -0.3)))
S_TUR_F   = Zone((440,  980,  880,  1180), ('x', 'y'), ((-3.3, 3.3),   (2.7, -0.3)))
S_TUR_T   = Zone((880,  980,  1320, 1180), ('x', 'z'), ((-3.3, 3.3),   (-3.7, 3.7)))
S_MANTLET = Zone((1320, 980,  1600, 1180), ('x', 'y'), ((-3.3, 3.3),   (2.1, -1.3)))
S_BARREL  = (1600, 980, 1860, 1180)        # parametric tube wrap (u along)
S_TUBECAP = Zone((1860, 980,  2048, 1180), ('x', 'y'), ((-0.6, 0.6),   (0.6, -0.6)))
S_BOW     = Zone((0,    1200, 360,  1480), ('x', 'y'), ((2.4, -2.4),   (6.2, -1.2)))
S_STERN   = Zone((360,  1200, 760,  1480), ('x', 'y'), ((5.0, -5.0),   (5.0, -1.8)))
S_RAM     = Zone((760,  1200, 1100, 1480), ('z', 'y'), ((-42.0, -36.0), (2.2, -1.4)))
S_FUNNEL  = (1100, 1200, 1420, 1480)       # parametric limb wrap (u along)
S_MAST    = (1420, 1200, 1620, 1480)       # masts / posts / crane steel
S_CHAIN   = (1620, 1200, 1760, 1480)       # dark iron chain + rail runs
S_TROPHY  = Zone((1760, 1200, 2048, 1480), ('x', 'y'), ((-0.7, 0.7),   (0.9, -0.9)))
S_FLAG    = Zone((0,    1480, 420,  1760), ('z', 'y'), ((0.0, 2.9),    (1.9, -0.1)))
S_DARK    = Zone((420,  1480, 560,  1760), ('x', 'z'), ((-1.5, 1.5),   (-1.5, 1.5)))
S_PLATE   = Zone((560,  1480, 1080, 1760), ('z', 'y'), ((-45.0, 45.0), (25.0, -5.0)))
S_BARB    = Zone((1080, 1480, 1400, 1760), ('z', 'y'), ((-4.0, 4.0),   (8.5, 3.5)))

# ── hull (world metres; waterline Y=0, bow -Z) ───────────────────────────
# sections: (z, y_bot, y_knuckle, y_deck, w_bot, w_knuckle, w_deck)
HULL_SECTIONS = [
    (-37.5, -0.6, 1.6, 5.7, 0.7, 1.5, 1.9),
    (-33.0, -1.6, 1.0, 5.3, 2.1, 3.4, 4.0),
    (-26.0, -2.4, 0.5, 4.8, 3.6, 5.2, 5.8),
    (-16.0, -2.8, 0.4, 4.45, 4.6, 6.2, 6.6),
    (-4.0,  -2.8, 0.4, 4.35, 4.8, 6.5, 6.9),
    (8.0,   -2.8, 0.4, 4.35, 4.8, 6.5, 6.9),
    (20.0,  -2.8, 0.4, 4.35, 4.6, 6.3, 6.7),
    (30.0,  -2.4, 0.5, 4.45, 3.8, 5.4, 5.9),
    (37.5,  -1.4, 0.7, 4.55, 2.6, 4.0, 4.6),
]
BOOTTOP    = (-0.45, 0.45)          # painted waterline band (Y=0 waterline)
DRAFT      = -2.8

# riveted ram prow (welded spur at the waterline)
RAM_BOX    = (0.0, 0.2, -39.1, 1.6, 2.8, 3.4)    # x,y,z,w,h,d (tip z=-40.8)
RAM_WEDGE  = (0.0, 0.1, -40.6, 0.9, 1.6, 1.4)
RAM_SPIKES = [((0.0, 1.4, -40.7), (0.0, 2.0, -42.0)),
              ((0.9, 1.1, -39.9), (1.9, 1.7, -41.0)),
              ((-0.9, 1.1, -39.9), (-1.9, 1.7, -41.0))]

# ── turret chains (battleship convention) ────────────────────────────────
TURRET_A   = (0.0, 5.65, -24.0)     # fore, low
TURRET_B   = (0.0, 7.55, -13.5)     # superfiring fore (on the step block)
TURRET_C   = (0.0, 5.65, 26.0)      # aft — geometry baked facing +Z
BARREL_OFF = (0.0, 1.05, -2.3)      # turret-local; C uses +2.3
MUZZLE_OFF = (0.0, 0.0, -8.7)       # barrel-local tube tip; C uses +8.7
TUR_SLAB   = (5.9, 2.3, 6.4)        # welded slab turret w,h,d
TUBE_X     = 0.85                   # twin gun spacing
TUBE_STATIONS = [(-0.4, 0.40), (-1.1, 0.34), (-6.9, 0.28), (-7.3, 0.36),
                 (-8.1, 0.34), (-8.4, 0.26)]   # (z, r) breech->muzzle
BARB_R, BARB_H = 3.1, 1.3           # barbette drums under A and C
STEP_BOX   = (0.0, 5.25, -13.0, 7.6, 2.1, 7.0)  # B barbette step (x,y,z,w,h,d)

# ── superstructure (scrap-armoured) ──────────────────────────────────────
MAIN_BLOCK = (0.0, 6.7, 7.0, 8.8, 5.0, 12.0)    # x,y,z,w,h,d
BRIDGE     = (0.0, 10.3, 3.8, 6.4, 2.2, 5.2)
SPONSONS   = [(4.85, 6.2, 9.5), (-4.85, 6.2, 9.5)]   # scrap armour bulges
SPONSON_SZ = (1.1, 2.2, 4.6)
FUNNELS    = [((0.0, 9.2, 8.6),  (0.0, 15.1, 9.1), 1.30, 1.05),
              ((0.0, 9.2, 12.2), (0.0, 14.5, 12.7), 1.15, 0.95)]
FUNNEL_CAP_Y = 15.1
EXHAUST_OFF  = (0.0, 15.2, 9.1)     # FX empty at the fore funnel mouth

# mainmast + battle standard
MAST_FOOT  = (0.0, 4.35, 15.8)
MAST_TOP   = (0.0, 16.2, 15.2)
YARD_Y, YARD_HW = 13.6, 1.6
FLAG_OFF   = (0.0, 14.6, 15.35)     # flag piece pivot (hoist at the mast)
FLAG_W, FLAG_H = 2.9, 1.8           # panel extends +Z (trails aft)

# salvage crane derrick (port quarter)
CRANE_FOOT = (3.6, 4.4, 34.0)
CRANE_TOP  = (3.6, 10.6, 34.0)
BOOM_TIP   = (5.6, 7.4, 39.4)
HOOK_Y     = 4.6

# trophy rails: posts + sagging chains + hung trophy plates
RAIL_SPANS = [(-31.0, -17.5, 5), (17.5, 31.5, 6)]   # (z0, z1, n_posts) both sides
POST_H     = 1.05
RAIL_INSET = 0.35

# deck clutter
CRATES_AT  = (2.2, 4.35, 19.5)
DRUMS_AT   = (-3.4, 4.35, 17.5)
TARP_AT    = (-2.6, 4.35, 21.5)
ANCHORS    = [(1, -30.0), (-1, -30.0)]   # (side, z) hawse plates on the bow
