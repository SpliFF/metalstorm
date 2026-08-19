"""ms_subs_s3_layout — zones + dims for ms_subs_s3 (hunter-killer pair).

45.0 m attack submarine, subs-row s3. Datum: the hull's longitudinal
axis lies at y=0 (free-floating body of revolution — NOT ground-planted,
NOT waterline-based). Nose at z=-22.5, stern at z=+22.5, forward = -Z.
Beam 5.4 m (hull radius 2.7). Tier grammar: LOW RAKED BLENDED sail
(half-ellipse loft faired into a dorsal hump, no vertical sides, no
masts, no sail planes), X-form stern planes (four diagonal fins),
pump-jet shroud ring instead of an open screw. Retractable bow planes
flush on the forward hull, long shallow sonar blister strips on the
flanks. 2048 atlas (45 m >= 15 m).
"""
import numpy as np
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── dims (world metres; axis datum y=0, bow -Z) ──────────────────────────
LENGTH   = 45.0
NOSE_Z   = -22.5
STERN_Z  = 22.5
RADIUS   = 2.7            # max hull radius (beam 5.4)
SEG      = 12             # body-of-revolution segments (flat top/sides)
COSF     = float(np.cos(np.pi / SEG))   # flat-centre factor 0.966

# hull of revolution stations (z, radius) — 14 stations, blunt sonar nose
STATIONS = [
    (-22.5, 0.55), (-21.2, 1.45), (-19.2, 2.05), (-16.5, 2.45),
    (-13.0, 2.65), (-8.0, 2.70), (-2.0, 2.70), (4.0, 2.65),
    (9.0, 2.50), (13.0, 2.20), (16.5, 1.75), (19.3, 1.25),
    (21.3, 0.75), (22.5, 0.30),
]
ST_Z = [s[0] for s in STATIONS]
ST_R = [s[1] for s in STATIONS]


def hull_r(z):
    return float(np.interp(z, ST_Z, ST_R))


def flat_x(z):
    """x of the side facet centre (12-gon flat) at station z."""
    return COSF * hull_r(z)


def top_y(z):
    """y of the top facet centre at station z."""
    return COSF * hull_r(z)

# blended sail / dorsal hump — half-ellipse sections sunk into the hull.
# (z, height above hull top surface, halfwidth). Raked leading edge:
# height ramps over ~6 m; tail fairs into a dorsal hump running aft.
SAIL_PROF = [
    (-9.5, -0.08, 0.30), (-7.8, 0.45, 0.72), (-6.0, 1.10, 1.05),
    (-4.2, 1.60, 1.25), (-2.4, 1.72, 1.28), (-0.6, 1.62, 1.18),
    (1.4, 1.28, 1.00), (3.6, 0.82, 0.75), (6.5, 0.38, 0.50),
    (10.0, 0.10, 0.34), (13.5, -0.08, 0.22),
]
SAIL_SINK = 0.45          # ellipse centre sits this far below the hull top
SAIL_PTS  = 9             # points per half-ellipse ring

# X-form stern planes: four fins at 45/135/225/315 deg
FIN_ANGLES = (45.0, 135.0, 225.0, 315.0)
FIN_ROOT_S, FIN_TIP_S = 0.70, 2.90        # radial span (root buried)
FIN_RL_Z, FIN_RT_Z = 17.0, 20.3           # root chord (leading, trailing)
FIN_TL_Z, FIN_TT_Z = 18.9, 20.7           # tip chord (swept)
FIN_TH_ROOT, FIN_TH_TIP = 0.22, 0.08      # thickness taper

# pump-jet shroud ring (annular duct around the tail cone)
SHR_Z0, SHR_Z1 = 19.6, 21.4
SHR_RO0, SHR_RO1 = 1.60, 1.42             # outer radius, converging
SHR_RI0, SHR_RI1 = 1.28, 1.18             # inner (duct) radius
VANE_Z = 20.5                              # stator vanes at 0/90/180/270

# retractable bow planes — flush blisters on the forward side flats
PLANE_Z0, PLANE_Z1 = -17.4, -14.6
PLANE_Y0, PLANE_Y1 = 0.05, 0.65
PLANE_PROUD, PLANE_INSET = 0.14, 0.15

# sonar flank arrays — long shallow blister strips on the side flats
SONAR_Z0, SONAR_Z1 = -7.0, 7.0
SONAR_Y0, SONAR_Y1 = -0.62, -0.05
SONAR_PROUD, SONAR_INSET = 0.12, 0.15

# weapon empty: bow torpedo tube tip
MUZZLE = (0.0, -0.5, -22.5)

# ── atlas zones (2048 sq; v down) ────────────────────────────────────────
S_SIDE    = Zone((0, 0, 2048, 420), ('z', 'y'), ((-22.5, 22.5), (2.85, -2.85)))
S_TOP     = Zone((0, 420, 2048, 640), ('z', 'x'), ((-22.5, 22.5), (-2.85, 2.85)))
S_BELLY   = Zone((0, 640, 2048, 860), ('z', 'x'), ((-22.5, 22.5), (-2.85, 2.85)))
S_SAIL    = Zone((0, 860, 1400, 1180), ('z', 'y'), ((-10.0, 14.0), (4.6, 1.9)))
S_SAILTOP = Zone((1400, 860, 2048, 1020), ('z', 'x'), ((-10.0, 14.0), (-1.4, 1.4)))
S_FIN     = Zone((1400, 1020, 1800, 1180), ('z', 'y'), ((16.5, 21.2), (3.0, -3.0)))
S_SHROUD  = Zone((0, 1180, 600, 1340), ('z', 'y'), ((19.4, 21.6), (1.7, -1.7)))
S_DARKR   = (600, 1180, 760, 1340)     # raw rect: vanes, dark caps
S_DARKZ   = Zone(S_DARKR, ('x', 'y'), ((-1.0, 1.0), (1.0, -1.0)))
S_NOSE    = Zone((760, 1180, 920, 1340), ('x', 'y'), ((0.6, -0.6), (0.6, -0.6)))
S_PLANE   = Zone((920, 1180, 1400, 1340), ('z', 'y'), ((-17.6, -14.4), (0.75, -0.05)))
S_SONAR   = Zone((0, 1340, 2048, 1500), ('z', 'y'), ((-7.2, 7.2), (0.05, -0.72)))


def mir(z):
    """Mirror twin of a planar zone for faces on the reversing (-x) side:
    same atlas rect, u-window reversed. Never paint through the twin."""
    (a0, a1), b = z.win
    return Zone(z.rect, z.axes, ((a1, a0), b))


S_SAIL_M = mir(S_SAIL)
