"""ms_anc_shield_pylon_layout — zones + dims for ms_anc_shield_pylon.

ANCIENT-TECH shield emitter pylon, 18 m. Monolithic tapering triangular
shaft (chamfered-triangle cross-section: three broad unbroken flanks +
three narrow corner edges that carry the cyan charge-lines), three
cantilevered anchor vanes at the base, a three-arm focusing corona and
cantilevered focus plate near the top, and a FLOATING emitter crystal
(`emitter` piece) hovering 0.6 m clear of the shaft cap — slow idle
rotation about Y plus a subtle bob (ABSOLUTE translation keys).

Capturable defense infrastructure: one small inlaid team panel on the
forward (-Z) anchor vane. Everything else is seamless — no rivets, no
bolted patches, no scrap. Weathering is geological: soil burial, dust
drift, faint scorch.

Dominant dim 18 m -> ATLAS 2048.
World frame: RH, -Z forward, +Y up, ground Y=0, 1 unit = 1 m.
"""
import numpy as np

import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

ATLAS = 2048

# ── shaft profile ────────────────────────────────────────────────────────
SH_Y0 = 0.85            # shaft springs from the plinth top
SH_Y1 = 15.40           # shaft cap
SH_R0 = 1.72            # circumradius of the triangle at the base
SH_R1 = 0.50            # circumradius at the cap
SH_EASE = 1.15          # >1 -> slightly concave (grand) taper
SH_CUT = 0.135          # corner chamfer as a fraction of the triangle edge
# clean recessed seams (world y of each groove start)
SH_GROOVES = (3.30, 6.60, 9.60, 12.20, 14.10)
GROOVE_H = 0.30         # total height of the recessed seam
GROOVE_D = 0.115        # radial depth of the recess


def shaft_r(y):
    """Circumradius of the triangular cross-section at world height y."""
    t = (y - SH_Y0) / (SH_Y1 - SH_Y0)
    t = min(max(t, 0.0), 1.0) ** SH_EASE
    return SH_R0 + (SH_R1 - SH_R0) * t


def shaft_stations():
    """(y, radius) rings bottom->top, grooves inserted as recessed seams."""
    # first ring is buried inside the plinth so the shaft/plinth join is
    # a real intersection, never a coplanar seam
    st = [(0.45, SH_R0), (SH_Y0, shaft_r(SH_Y0))]
    for gy in SH_GROOVES:
        st.append((gy, shaft_r(gy)))
        st.append((gy + 0.075, shaft_r(gy + 0.075) - GROOVE_D))
        st.append((gy + GROOVE_H - 0.075,
                   shaft_r(gy + GROOVE_H - 0.075) - GROOVE_D))
        st.append((gy + GROOVE_H, shaft_r(gy + GROOVE_H)))
    st.append((SH_Y1, shaft_r(SH_Y1)))
    return st


# corner azimuths (the three charge-line edges) and flank azimuths
CORNER_AZ = [np.radians(-90 + 120 * k) for k in range(3)]
FLANK_AZ = [np.radians(-30 + 120 * k) for k in range(3)]

# ── base ─────────────────────────────────────────────────────────────────
PAD_R, PAD_Y = 5.55, 0.26        # broad half-buried ground pad (16-gon)
PLINTH_R, PLINTH_Y = 2.35, 0.85  # plinth drum the shaft springs from
NGON_BASE = 16

# anchor vanes — flying-buttress slabs at the three corner azimuths
VANE_T = 0.46                    # thickness
VANE_BEVEL = 0.075               # rim bevel inset
VANE_PROFILE = [                 # (radial r, world y), CONVEX closed polygon
    (0.95, 4.40),                # top, buried in the shaft
    (1.90, 3.60),                # near-straight sweep: a blade, not a skirt,
    (3.20, 2.10),                # so the three vanes stay legible at zoom
    (4.60, 0.40),                # outer foot (pad rim stands 0.95 m clear)
    (4.60, 0.00),
    (0.95, 0.00),
]
VANE_R0, VANE_R1, VANE_YT = 0.90, 4.70, 4.55   # UV window for the vane faces
TEAM_VANE = 0                    # forward (-Z) vane carries the team panel

# ── focusing corona (three cantilevered arms + lens nodes) ───────────────
ARM_Y0, ARM_Y1 = 12.85, 13.70
ARM_R0, ARM_R1 = 0.30, 2.10
ARM_TH0, ARM_TH1 = 0.235, 0.125
NODE_SIZE = 0.38

# cantilevered focus plate just below the cap
PLATE_Y = 14.80
PLATE_HALF = 0.105
PLATE_R = 1.42
PLATE_RIM = 1.26

# ── floating emitter crystal (piece `emitter`) ──────────────────────────
EMIT_Y = 17.00                   # piece pivot (world); shaft cap is 15.40
EMIT_RINGS = [                   # (local y, radius) — asymmetric crystal
    (-1.00, 0.09),
    (-0.42, 0.72),
    (0.12, 0.88),
    (0.98, 0.13),
]
SHARD_AZ = [np.radians(30 + 120 * k) for k in range(3)]
SHARD_R0, SHARD_R1 = 1.02, 1.85
SHARD_Y = (0.26, -0.18, 0.06)    # per-shard local height
SHARD_T0, SHARD_T1 = 0.155, 0.045

# clip timing
IDLE_T = 60.0                    # one emitter revolution
BOB_PERIOD = 12.0
BOB_AMP = 0.16

# ── atlas zones (2048²; v down) ─────────────────────────────────────────
# shaft: two tall strips, v = world height, u = across the face
R_FACE = (0, 0, 448, 2048)          # three broad monolithic flanks
R_EDGE = (464, 0, 592, 2048)        # three corner edges — cyan charge-lines
SH_VT, SH_VB = 16.0, 0.0            # world-y window of the shaft strips

R_PAD_TOP = Zone((608, 0, 1360, 752), ('x', 'z'),
                 ((-PAD_R - 0.05, PAD_R + 0.05), (-PAD_R - 0.05, PAD_R + 0.05)))
R_PAD_SIDE = (608, 768, 1360, 816)
R_PLINTH_TOP = Zone((608, 832, 1120, 1344), ('x', 'z'),
                    ((-PLINTH_R - 0.05, PLINTH_R + 0.05),
                     (-PLINTH_R - 0.05, PLINTH_R + 0.05)))
R_PLINTH_SIDE = (608, 1360, 1360, 1424)
R_VANE0 = (608, 1440, 1360, 1740)   # forward vane (carries the team panel)
R_VANE = (608, 1756, 1360, 2048)    # the other two vanes

R_CAP = Zone((1376, 0, 1632, 256), ('x', 'z'), ((-0.62, 0.62), (-0.62, 0.62)))
R_PLATE_TOP = Zone((1648, 0, 1904, 256), ('x', 'z'), ((-1.5, 1.5), (-1.5, 1.5)))
# node zone spans the whole corona so world-space projection lands inside:
# a bright cyan equator band across the middle reads as a glowing lens
R_NODE = Zone((1920, 0, 2048, 160), ('x', 'y'), ((-2.4, 2.4), (14.05, 13.35)))
R_ARM = (1376, 272, 2048, 400)
R_PLATE = (1376, 416, 2048, 512)
R_EMIT = (1376, 528, 2048, 912)
R_SHARD = (1376, 928, 2048, 1024)
R_VANE_EDGE = (1376, 1040, 2048, 1104)
R_DARK = Zone((1376, 1120, 1632, 1376), ('x', 'z'), ((-2, 2), (-2, 2)))


# ── shared UV parametrisations (gen emits, painter draws into) ──────────

def shaft_px(rect, fu, y):
    """Pixel (x, v) inside a shaft strip: fu across the face, y world."""
    x0, y0, x1, y1 = rect
    fv = (SH_VT - y) / (SH_VT - SH_VB)
    return (x0 + fu * (x1 - x0), y0 + fv * (y1 - y0))


def vane_px(rect, r, y):
    """Pixel (x, v) inside a vane face zone: r radial, y world."""
    x0, y0, x1, y1 = rect
    fu = (r - VANE_R0) / (VANE_R1 - VANE_R0)
    fv = (VANE_YT - y) / VANE_YT
    return (x0 + fu * (x1 - x0), y0 + fv * (y1 - y0))


def wrap_px(rect, fu, fv):
    """Pixel inside a parametric wrap rect (fu around, fv along)."""
    x0, y0, x1, y1 = rect
    return (x0 + fu * (x1 - x0), y0 + fv * (y1 - y0))
