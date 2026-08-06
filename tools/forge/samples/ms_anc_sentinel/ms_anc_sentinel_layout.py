"""ms_anc_sentinel_layout — zones + dims for ms_anc_sentinel (ancient watcher drone).

ANCIENT REGISTER.  A lens-eyed oblate disc 3.48 m across: one unbroken
seamless hull of pale ancient alloy, segmented only by clean recessed
concentric seams, a thin cyan equatorial light line at the rim, three
folded stabiliser vanes swept down and under the belly, a central `eye`
pod slung in the underside well (idle scan rotation about +Y), and a
free-floating `halo` ring hovering clear above the crown (counter-scan).
Nothing bolted, nothing patched: cyan tracery is the only ornament.

FLYER — no ground contact.  The model origin is the HOVER reference and
sits at the hull's mid-plane (Y=0); the unitdef supplies the altitude.
Geometry extents: y in [-1.10, +1.03], x/z in +/-1.74.

World frame: forward -Z, up +Y, 1 unit = 1 m.  Dominant dim 3.48 m -> 1024.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

ATLAS = 1024

# ── atlas zones (1024²; v down) ──────────────────────────────────────────
# The disc is projected from directly above / below, so concentric ring
# seams and radial cyan tracery painted in these two square cells land
# exactly on the lofted hull bands.  1 m = 142.22 px.
Z_TOP  = Zone((0,   0,   512, 512),  ('x', 'z'), ((-1.80, 1.80), (-1.80, 1.80)))
Z_BOT  = Zone((512, 0,  1024, 512),  ('x', 'z'), ((-1.80, 1.80), ( 1.80, -1.80)))
# thin equatorial light line (rim cylinder band, traversed twice — a plain
# horizontal stripe, so the double wrap is invisible)
Z_EQ   = Zone((0,   512, 1024, 568), ('x', 'y'), ((-1.75, 1.75), ( 0.05, -0.05)))
# eye pod: rings lie in XY planes about the Z axis -> concentric projection
Z_EYE  = Zone((720, 568,  912, 760), ('x', 'y'), ((-0.36, 0.36), ( 0.22, -0.50)))
Z_IRIS = Zone((720, 760,  912, 952), ('x', 'y'), ((-0.30, 0.30), ( 0.16, -0.44)))
Z_DARK = Zone((912, 568, 1008, 664), ('x', 'z'), ((-4.0, 4.0), (-4.0, 4.0)))
Z_TRIM = Zone((912, 664, 1024, 776), ('x', 'y'), ((-1.0, 1.0), ( 1.0, -1.0)))
# parametric cells (explicit UVs — see gen): u = chord/major, v = span/minor
R_VANE = (0,   568, 336, 856)    # u = chord, v = span (root 0 -> tip 1)
R_HALO = (336, 568, 720, 664)    # u = major angle, v = minor angle

# ── hull (oblate disc, lofted about +Y, rings ordered top -> bottom) ─────
HULL_N = 24                      # facets — a deliberately perfect circle
HULL_RINGS = [                   # (y, radius)
    ( 0.50, 0.32),               # crown plateau  (capped, Z_TOP)
    ( 0.47, 0.50),               # crown step
    ( 0.41, 0.86),
    ( 0.31, 1.26),
    ( 0.16, 1.58),
    ( 0.04, 1.74),               # ┐ equatorial light line: pure cylinder
    (-0.04, 1.74),               # ┘ band, normal.y == 0 -> Z_EQ
    (-0.16, 1.60),
    (-0.30, 1.30),
    (-0.42, 0.86),
    (-0.46, 0.26),               # underside well mouth (capped, Z_DARK)
]
EQ_BAND = (0.04, -0.04)          # the cyan line's world y range

# ── stabiliser vanes (3, folded down + inward under the belly) ───────────
# Blades stand tangentially: chord along the local tangent, span sweeping
# down-and-in, flat faces pointing radially out/in — a broad read from any
# horizontal angle.  Root is buried in the hull flank.
VANE_AZ = (90.0, 210.0, 330.0)   # deg; 90 = aft (+Z), the other two forward
VANE_ST = [                      # (radius, y, half-chord, half-thickness)
    (1.66, -0.10, 0.54, 0.100),
    (1.60, -0.44, 0.45, 0.085),
    (1.38, -0.78, 0.34, 0.060),
    (1.02, -1.04, 0.23, 0.035),
]
VANE_SP = (0.00, 0.34, 0.68, 1.00)   # span fraction -> v in R_VANE
VANE_TEAM_V = 0.78               # team mask covers v in [0.78, 1.0] = the tip

# ── eye pod (piece `eye`; spheroid about the Z axis, iris at -Z) ─────────
EYE_OFF = (0.0, -0.46, 0.0)      # pivot: the underside well mouth
EYE_CY  = -0.14                  # pod axis height in piece-local coords
EYE_N   = 16
EYE_RINGS = [                    # (z, radius)
    (-0.30, 0.235),              # iris ring (capped, Z_IRIS)
    (-0.24, 0.300),
    (-0.10, 0.360),
    ( 0.08, 0.355),
    ( 0.24, 0.270),
    ( 0.36, 0.120),              # capped, Z_DARK
]

# ── halo (piece `halo`; free-floating ring, no contact with the hull) ────
HALO_OFF = (0.0, 0.94, 0.0)      # 0.44 m clear above the crown plateau
HALO_R, HALO_T = 1.06, 0.085     # major / minor radius
HALO_NU, HALO_NV = 24, 6

# ── idle clip ────────────────────────────────────────────────────────────
IDLE_T = 14.0                    # loop length, seconds
EYE_TURNS = 1                    # eye scans +1 full turn per loop
HALO_TURNS = -1                  # halo counter-rotates
HALO_BOB = 0.055                 # floating breath, +/- m, 2 cycles per loop
