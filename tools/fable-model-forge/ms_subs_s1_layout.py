"""ms_subs_s1_layout — zones + dims for ms_subs_s1 (coastal sub pack boat).

Subs row s1: 18 m coastal pack boat. SUBMARINE DATUM: the hull's
longitudinal axis lies at y = 0 (free-floating body of revolution —
NOT keel-on-ground, NOT a waterline). Bow at z = -9, stern at z = +9.

Stubby teardrop hull of revolution (12 segments, beam 3.2 -> radius
1.6), exposed free-flooding deck casing (flat-topped strip with
painted limber holes along the flank), and the tier-identity sail: a
TALL NARROW vertical-sided fin (old-school conning tower, ~2.2 m above
the hull crown, short chord) mounted well forward at ~30% aft of the
bow (z = -3.6). Single open stern screw, cruciform stern planes, fixed
bow planes near the nose. 2048 atlas (18 m >= 15 m).
"""
import numpy as np
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
Z_FLANK    = Zone((0,    0,    2048, 360),  ('z', 'y'), ((-9.2, 9.2), (1.8, -1.8)))
Z_TOP      = Zone((0,    360,  2048, 600),  ('z', 'x'), ((-9.2, 9.2), (-1.8, 1.8)))
Z_BELLY    = Zone((0,    600,  2048, 840),  ('z', 'x'), ((-9.2, 9.2), (-1.8, 1.8)))
Z_CAS_SIDE = Zone((0,    840,  2048, 990),  ('z', 'y'), ((-8.2, 7.6), (2.0, 0.9)))
Z_CAS_TOP  = Zone((0,    990,  2048, 1140), ('z', 'x'), ((-8.2, 7.6), (-0.7, 0.7)))
# sail flank carries text (hull number) -> mirrored twin for the -x side
Z_SAIL_S   = Zone((0,    1140, 700,  1600), ('z', 'y'), ((-4.75, -2.55), (4.0, 1.4)))


def _mir(z):
    (a0, a1), b = z.win
    return Zone(z.rect, z.axes, ((a1, a0), b))


Z_SAIL_S_M = _mir(Z_SAIL_S)
Z_SAIL_WRAP= Zone((700,  1140, 1000, 1600), ('x', 'y'), ((-0.55, 0.55), (4.0, 1.4)))
Z_SAIL_TOP = Zone((1000, 1140, 1256, 1330), ('z', 'x'), ((-4.6, -2.7), (-0.5, 0.5)))
Z_PLANE_H  = Zone((1000, 1330, 1512, 1600), ('z', 'x'), ((-8.0, 8.6), (-2.2, 2.2)))
Z_PLANE_V  = Zone((1512, 1330, 2024, 1600), ('z', 'y'), ((6.9, 8.6), (1.7, -1.7)))
Z_DARK     = Zone((1256, 1140, 1384, 1268), ('x', 'z'), ((-1, 1), (-1, 1)))
Z_PROP     = Zone((1384, 1140, 1640, 1330), ('x', 'y'), ((-0.9, 0.9), (0.9, -0.9)))
Z_MAST     = (1640, 1140, 1896, 1230)   # parametric limb wrap: snorkel/cleats
Z_PERI     = (1640, 1230, 1896, 1320)   # periscope wrap (emissive head dot)
Z_HUB      = (1896, 1140, 2024, 1230)   # prop hub wrap

# ── dims (world metres; axis y=0, bow -Z) ────────────────────────────────
LENGTH  = 18.0
R_MAX   = 1.6                        # hull radius (beam 3.2)
NOSE    = (0.0, 0.0, -9.0)           # bow tip point
TAIL    = (0.0, 0.0, 8.62)           # stern cone tip (screw sits aft of it)
SEG     = 12                         # circumferential segments

# teardrop radius profile: (z, r) — max beam well forward, long taper aft
HULL_STATIONS = [
    (-8.95, 0.24),
    (-8.30, 0.78),
    (-7.20, 1.24),
    (-5.60, 1.52),
    (-3.60, 1.60),
    (-1.20, 1.57),
    (1.40,  1.44),
    (3.80,  1.20),
    (5.80,  0.90),
    (7.30,  0.58),
    (8.20,  0.30),
    (8.55,  0.16),
]

# free-flooding casing (flat-topped strip on the hull crown)
CAS_Z = [-7.8, -6.6, -4.8, -2.4, 0.4, 3.0, 5.2, 7.0]
CAS_W_MAX = 0.55                     # half-width amidships
CAS_TOP_CAP = 1.78                   # flat deck line over the midbody
CAS_LIP = 0.34                       # top rides r(z)+CAS_LIP until capped
CAS_SINK = 0.72                      # base y = r(z)*CAS_SINK (buried)

# sail (fin): tall, narrow, vertical-sided, well forward
SAIL_ZC   = -3.6                     # 30% aft of the bow
SAIL_HW   = 0.36                     # half-width (0.72 beam — narrow)
SAIL_BASE = 1.50                     # sunk into the casing
SAIL_TOP  = 3.80                     # crown 1.6 + 2.2
SAIL_CHORD_BASE = (-4.55, -2.75)     # z leading/trailing at base
SAIL_CHORD_TOP  = (-4.42, -2.92)     # slight taper at the top

PERI_BASE = (0.13, SAIL_TOP - 0.05, -3.95)
PERI_TOP  = (0.13, 4.50, -3.95)
SNORK_BASE= (-0.14, SAIL_TOP - 0.05, -3.30)
SNORK_TOP = (-0.14, 4.22, -3.30)

# planes (fixed): bow pair near the nose, cruciform aft
BOWPLANE  = dict(z=-6.9, span=4.2, chord=0.70, th=0.12, y=0.10)
STERN_H   = dict(z=7.65, span=3.4, chord=0.90, th=0.12)
STERN_V   = dict(z=7.65, span=3.2, chord=0.90, th=0.12)

# single open screw
HUB_Z0, HUB_Z1 = 8.50, 8.94
HUB_R0, HUB_R1 = 0.15, 0.06
BLADE_Z  = 8.76
BLADE_R0, BLADE_R1 = 0.13, 0.70
BLADE_CH0, BLADE_CH1 = 0.20, 0.14    # half-chords root/tip
BLADE_PITCH = 0.10                   # tangential lean of the chord

# casing cleats (towing bollards)
CLEATS = [(-6.4,), (-1.0,), (4.4,)]

MUZZLE_OFF = (0.0, -0.3, -9.0)       # bow torpedo tube tip (weapon slot 1)
