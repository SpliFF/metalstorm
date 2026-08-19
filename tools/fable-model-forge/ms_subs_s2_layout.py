"""ms_subs_s2_layout — zones + dims for ms_subs_s2 (attack sub pair boat).

s2 line submarine, 30.0 m exactly (nose z=-15, stern z=+15). SUBMARINE
DATUM: the hull centreline lies at y=0 (free-floating body of revolution;
the engine submerges the origin) — nothing rests on the ground plane.

Tier identity: classic faired TEARDROP SAIL amidships carrying
SAIL-MOUNTED DIVE PLANES (horizontal fins from the sail sides — this
tier's signature). Clean flush hull, no deck casing. 12-segment body of
revolution, beam ~4.2 m, cruciform stern planes, single open screw,
periscope/snorkel mast stubs on the sail top. 2048 atlas (30 m >= 15 m).
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048 px; v down) ────────────────────────────────────────
S_HULL_SIDE = Zone((0,    0,    2048, 340),  ('z', 'y'), ((-15.0, 15.0), (2.3, -2.3)))
S_TOP       = Zone((0,    340,  2048, 560),  ('z', 'x'), ((-15.0, 15.0), (-2.3, 2.3)))
S_BELLY     = Zone((0,    560,  2048, 780),  ('z', 'x'), ((-15.0, 15.0), (2.3, -2.3)))
# sail flank: text/team zone — needs a mirrored twin for the reversing side
S_SAIL      = Zone((0,    780,  1000, 1030), ('z', 'y'), ((-4.6, 2.9), (4.3, 1.6)))
S_SAIL_T    = Zone((1000, 780,  1500, 1030), ('z', 'x'), ((-4.6, 2.9), (-0.9, 0.9)))
S_FIN       = Zone((1500, 780,  1900, 1030), ('x', 'z'), ((-3.1, 3.1), (-3.0, -1.0)))
S_SFIN      = Zone((0,    1030, 500,  1230), ('x', 'z'), ((-2.8, 2.8), (12.0, 13.8)))
S_VFIN      = Zone((500,  1030, 900,  1230), ('z', 'y'), ((12.0, 13.8), (2.6, -2.6)))
S_BOW       = Zone((900,  1030, 1100, 1230), ('x', 'y'), ((0.6, -0.6), (0.6, -0.6)))
S_DARK      = Zone((1100, 1030, 1250, 1230), ('x', 'y'), ((-1, 1), (1, -1)))
S_MAST      = (1250, 1030, 1500, 1230)   # parametric limb wrap (masts)
S_HUB       = (1500, 1030, 1700, 1230)   # parametric tube wrap (screw hub)
S_PROP      = Zone((1700, 1030, 1950, 1230), ('x', 'y'), ((-1.2, 1.2), (1.2, -1.2)))
S_BLIST     = Zone((0,    1230, 400,  1400), ('z', 'y'), ((-10.4, -7.6), (0.7, -1.1)))


def mir(z):
    """Mirrored twin for the reversing side of a planar text zone."""
    (a0, a1), b = z.win
    return Zone(z.rect, z.axes, ((a1, a0), b))


S_SAIL_M = mir(S_SAIL)

# ── dims (metres; centreline y=0, bow -Z) ────────────────────────────────
# body of revolution: (z, radius); 12 segments around. Blunt bow cap at
# z=-15 (torpedo door face); stern cone hands over to the screw hub.
STATIONS = [
    (-15.0, 0.50), (-14.3, 1.10), (-13.2, 1.58), (-11.5, 1.90),
    (-9.0, 2.05), (-5.5, 2.10), (-1.0, 2.10), (3.0, 2.00),
    (6.5, 1.82), (9.5, 1.52), (11.8, 1.12), (13.3, 0.72), (14.3, 0.40),
]
SEGS = 12
HULL_R = 2.10                      # max radius (beam ~4.2)

# faired teardrop sail: (y, z_leading, z_trailing, half_width) loft rings
SAIL_RINGS = [
    (1.90, -4.30, 2.60, 0.85),     # fairing root, buried in the hull
    (2.45, -3.90, 1.90, 0.62),
    (3.30, -3.75, 1.55, 0.58),
    (4.05, -3.55, 1.15, 0.48),     # top (capped)
]
SAIL_PROF = [(0.10, 0.50), (0.28, 0.88), (0.50, 1.00),
             (0.72, 0.82), (0.90, 0.45)]   # (chord frac, width frac)

# sail-mounted dive planes — the tier signature
SAILPLANE_C = (1.70, 2.75, -2.00)  # +x fin centre (mirrored to -x)
SAILPLANE_S = (2.30, 0.16, 1.15)

# cruciform stern planes
STERN_Z     = 12.90
STERNPLANE_H = (5.20, 0.18, 1.35)  # horizontal pair (one box through hull)
STERNPLANE_V = (0.18, 4.90, 1.35)  # vertical rudders

# single open screw
HUB_STATIONS = [(15.0, 0.10), (14.72, 0.26), (14.32, 0.36)]  # z max -> min
BLADE_N     = 5
BLADE_Z     = 14.56
BLADE_R0, BLADE_R1 = 0.24, 1.10

# masts on the sail top (periscope + snorkel stubs)
PERISCOPE   = ((0.15, 3.90, -2.70), (0.15, 4.45, -2.70), 0.075, 0.060)
SNORKEL     = ((-0.25, 3.90, -1.80), (-0.25, 4.32, -1.80), 0.095, 0.080)

# flank sonar blisters
BLISTER_C   = (2.00, -0.20, -9.00)
BLISTER_S   = (0.35, 0.90, 2.60)

MUZZLE_OFF  = (0.0, -0.4, -15.0)   # bow torpedo tube tip (weapon slot 1)
