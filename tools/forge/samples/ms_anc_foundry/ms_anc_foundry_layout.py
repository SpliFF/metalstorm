"""ms_anc_foundry_layout — zones + dims for ms_anc_foundry.

ANCIENT REGISTER. Automated foundry of the world-before: a 40 m stepped
ziggurat of five monolithic tiers, cantilevered casting halls thrown clear
of the mass with nothing under them, a monumental circular pour-gate, rows
of clean recessed vents, two gantry arms frozen mid-task, and a central
core shaft (piece `core`) that breathes — slow idle rise/fall, ABSOLUTE
translation keys, seamless. Slag spill at the foot has gone to glass.
DORMANT: cyan tracery is dim embers, never dead. No bolts, no patches, no
team colour. Dominant dim 40 m -> ATLAS 2048.
World frame: RH, -Z forward, +Y up, ground Y=0.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

W = 2048

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
# Tier flanks: ONE continuous world-projected zone per axis pair, so the
# recessed seams and tracery run unbroken across every tier — monolithic.
R_TIER_X = Zone((0,    0,    700,  1200), ('z', 'y'), ((-16, 16), (34.0, 0.0)))
R_TIER_Z = Zone((700,  0,    1400, 1200), ('x', 'y'), ((-16, 16), (34.0, 0.0)))

# right column: parametric cells stretched over each object (raw rects)
R_HALL_SIDE = (1400, 0,    2048, 300)
R_HALL_END  = (1400, 300,  2048, 470)
R_HALL_TOP  = (1400, 470,  2048, 770)
R_PYLON     = (1400, 770,  2048, 1070)
R_VENT      = (1400, 1370, 2048, 1570)
R_SHAFT     = (1400, 1570, 2048, 1830)   # core tube wrap (limb rect)
R_COLLAR    = (1400, 1830, 2048, 1910)   # floating collar bar wrap (rect)
R_ARM       = (1400, 1910, 2048, 1990)   # gantry limb wrap (rect)
R_GATERING  = (1400, 1990, 2048, 2048)   # pour-gate annulus wrap (rect)
# cornice band: projected on x/z so every cornice height reuses one cell
R_CORNICE   = Zone((1400, 1070, 2048, 1370), ('x', 'z'), ((-17, 17), (-17, 17)))

# bottom block
R_GLASS_TOP = Zone((0,    1200, 760,  1960), ('x', 'z'), ((-34, 34), (-34, 34)))
R_GLASS_S   = Zone((0,    1960, 760,  2020), ('x', 'y'), ((-34, 34), (0.7, -0.1)))
R_GLASS_SZ  = Zone((0,    1960, 760,  2020), ('z', 'y'), ((-34, 34), (0.7, -0.1)))
R_SHELF     = Zone((760,  1200, 1360, 1800), ('x', 'z'), ((-16, 16), (-16, 16)))
R_GATE      = Zone((760,  1800, 1040, 2048), ('x', 'y'), ((-4.4, 4.4), (9.9, 1.1)))
R_LENS_R    = (1040, 1800, 1240, 2000)
R_LENS      = Zone(R_LENS_R, ('x', 'z'), ((-3.2, 3.2), (-3.2, 3.2)))
R_DARK      = Zone((1240, 1800, 1360, 1920), ('x', 'z'), ((-1, 1), (-1, 1)))

TIER_ZONES = {'+x': R_TIER_X, '-x': R_TIER_X,
              '+z': R_TIER_Z, '-z': R_TIER_Z, '+y': R_SHELF}


def face_zones(center, size, rect_x, rect_z, rect_y):
    """Per-object planar zones: stretch one atlas cell over each face pair.
    rect_x -> ±X faces (z,y), rect_z -> ±Z faces (x,y), rect_y -> ±Y (x,z)."""
    cx, cy, cz = center
    w, h, d = size
    zx = Zone(rect_x, ('z', 'y'), ((cz - d / 2, cz + d / 2),
                                   (cy + h / 2, cy - h / 2)))
    zz = Zone(rect_z, ('x', 'y'), ((cx - w / 2, cx + w / 2),
                                   (cy + h / 2, cy - h / 2)))
    zy = Zone(rect_y, ('x', 'z'), ((cx - w / 2, cx + w / 2),
                                   (cz - d / 2, cz + d / 2)))
    return {'+x': zx, '-x': zx, '+z': zz, '-z': zz, '+y': zy, '-y': zy}


# ── dims (world metres, ground Y=0) ──────────────────────────────────────

# soil/glass apron: geological burial, not a plinth
APRON      = ((0.0, 0.25, 0.0), (36.0, 0.50, 34.0))
APRON_TOP  = 0.50

# stepped ziggurat tiers: (center, size)
TIERS = [
    ((0.0,  4.0,  0.0), (32.0, 7.0,  30.0)),   # y 0.5 – 7.5
    ((0.0, 10.75, 0.0), (26.5, 6.5,  25.0)),   # y 7.5 – 14.0
    ((0.0, 16.9,  0.0), (21.0, 5.8,  20.0)),   # y 14.0 – 19.8
    ((0.0, 22.4,  0.0), (16.0, 5.2,  15.0)),   # y 19.8 – 25.0
    ((0.0, 27.25, 0.0), (11.5, 4.5,  11.0)),   # y 25.0 – 29.5
]
TIER_TOPS = [7.5, 14.0, 19.8, 25.0, 29.5]
# thin overhanging cornice lip at every step
CORNICES = [
    ((0.0,  7.15, 0.0), (33.4, 0.70, 31.4)),
    ((0.0, 13.65, 0.0), (27.9, 0.70, 26.4)),
    ((0.0, 19.45, 0.0), (22.4, 0.70, 21.4)),
    ((0.0, 24.65, 0.0), (17.4, 0.70, 16.4)),
    ((0.0, 29.15, 0.0), (12.9, 0.70, 12.4)),
]

# cantilevered casting halls: (center, size, long axis)
HALLS = [
    ((17.5,  16.9,   4.5), (18.0, 5.0, 9.5),  'x'),   # thrown clear over T1-T2
    ((-3.0,  16.9, -17.0), (10.0, 5.6, 16.0), 'z'),   # -Z, 7 m of clear air
    ((-19.5, 10.75, -3.5), (16.0, 4.6, 8.5),  'x'),   # -X off tier 2
]

# clean vent hoods: (center, size)
VENTS = ([((16.15, 5.4, z), (0.70, 1.30, 3.40)) for z in (-10, -5, 0, 5, 10)] +
         [((-16.15, 5.4, z), (0.70, 1.30, 3.40)) for z in (-10, -5, 0, 5, 10)] +
         [((x, 11.6, 12.65), (3.00, 1.10, 0.60)) for x in (-7.5, -2.5, 2.5, 7.5)] +
         [((x, 11.6, -12.65), (3.00, 1.10, 0.60)) for x in (-7.5, -2.5, 2.5, 7.5)])

# crown: four pylons around the core, tops flared out over the void
PYL_R      = 4.6
PYLONS     = [((sx * PYL_R, 32.25, sz * PYL_R), (2.6, 5.5, 2.6))
              for sx in (-1, 1) for sz in (-1, 1)]
BEAKS      = [((sx * 6.2, 35.9, sz * 6.2), (3.0, 1.4, 3.0))
              for sx in (-1, 1) for sz in (-1, 1)]

# monumental pour gate (perfect circle) on the -Z face of tier 1
GATE_C      = (0.0, 5.5, -15.0)
GATE_R      = 3.6
GATE_RING_R = 4.35
GATE_BAR    = 0.30
GATE_N      = 16

# gantry arms, frozen mid-task
ARM_A_SHOULDER = ((8.6, 23.6, 4.5), (3.4, 3.4, 3.4))
ARM_A_BOOM     = ((8.6, 23.6, 4.5), (24.0, 20.2, 4.5), 1.00, 0.55)
ARM_A_HANG     = ((23.4, 20.3, 4.5), (23.4, 15.6, 4.5), 0.22, 0.22)
ARM_A_LADLE    = ((23.4, 15.5, 4.5), (24.6, 13.3, 5.1), 1.70, 1.25)
ARM_B_SHOULDER = ((-3.0, 23.0, -7.4), (3.0, 3.2, 3.0))
ARM_B_BOOM     = ((-3.0, 23.0, -7.4), (-3.0, 26.6, -22.0), 0.95, 0.50)
ARM_B_STRUT    = ((-3.0, 26.2, -21.8), (-3.0, 22.4, -21.8), 0.30, 0.30)
ARM_B_HEAD     = ((-3.0, 26.6, -22.6), (2.0, 2.0, 2.4))

# core shaft (piece `core`) — pivot on the ziggurat axis at the crown line
CORE_PIVOT = (0.0, 29.5, 0.0)
# (local y, radius) stations; world y = local + 29.5 -> 22.0 .. 40.0
CORE_STATIONS = [(-7.5, 3.20), (0.5, 3.05), (5.5, 2.85), (9.0, 2.45),
                 (10.5, 1.80)]
COLLAR_Y   = 8.0          # local (world 37.5) — floats free, clear of all
COLLAR_R   = 5.20
COLLAR_BAR = 0.34
COLLAR_N   = 12
STUD_N     = 4
STUD_SIZE  = (0.60, 0.60, 0.60)

# slag spill gone to glass: (center, radius, n)
POOLS = [((0.0, 0.18, -25.0), 9.0, 18),
         ((-9.5, 0.14, -30.0), 6.5, 14),
         ((7.5, 0.22, -28.0), 5.5, 14)]

# idle: core breathes 1.6 m peak-to-peak over 26 s, seamless
IDLE_T     = 26.0
IDLE_RISE  = 0.80
