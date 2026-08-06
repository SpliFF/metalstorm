"""ms_anc_interdictor_layout — zones + dims for ms_anc_interdictor.

ANCIENT REGISTER. EM interdiction emitter, 24 m — the machine behind the
Static. Three curved monolithic buttress legs sweep up out of a burial
mound each, converge without touching, and cradle a SUSPENDED faceted
core that floats in the throat between the leg tips. A broken halo
antenna (piece `halo`, tilted so its Y-spin reads as an irregular
precession) sweeps around the core. Cyan interference tracery lives on
the leg INNER faces; three free-standing resonator pylons stand on a
perfect inscribed ring that bounds the dead-zone ash circle.

Seamless, monolithic, precise — no bolts, no patches, no scrap. ACTIVE:
the cyan flows. Dominant dim 24 m -> ATLAS 2048. Never team-owned.
World frame: RH, -Z forward, +Y up, ground Y=0, 1 unit = 1 m.
"""
import numpy as np
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

ATLAS = 2048

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
# dead-zone ash circle + the inscribed rim: one planar x/z projection, so
# painted radii land at exactly the world radius the geometry expects.
R_ASH      = Zone((0, 0, 1200, 1200), ('x', 'z'), ((-11.4, 11.4), (-11.4, 11.4)))
# parametric wraps (u = along the sweep, v = around the cross-section)
R_RIM_S    = (0, 1200, 1200, 1264)     # rim outer face (u = angle)
R_HALO     = (0, 1264, 1200, 1520)     # halo bar, 4 v-bands of 64
R_PYLON    = (0, 1520, 1200, 1808)     # resonator pylon, 6 v-bands of 48
R_MOUND    = (0, 1808, 1200, 2048)     # burial mound, 8 v-bands of 30
R_LEG_IN   = (1200, 0, 2048, 700)      # leg INNER face — interference tracery
R_LEG_OUT  = (1200, 700, 2048, 1000)   # leg outer face
R_LEG_SIDE = (1200, 1000, 2048, 1128)  # leg flank faces (2 sides share)
R_LEG_CH   = (1200, 1128, 2048, 1192)  # leg chamfer facets (4 sides share)
R_CORE     = (1200, 1192, 2048, 1704)  # suspended core wrap
R_CANT     = (1200, 1704, 2048, 1864)  # mid-leg cantilever emitter blades
R_LENS     = (1200, 1864, 1624, 2048)  # cyan emitter lens caps
R_DIRT     = (1624, 1864, 2048, 2048)  # mound caps

# ── dead-zone apron: profile of revolution, (radius, y) ──────────────────
BASE_N     = 32
ASH_Y      = 0.14
BASE_PROFILE = [
    (0.00,  ASH_Y),        # ash pad
    (2.60,  ASH_Y),
    (5.40,  ASH_Y),
    (8.00,  ASH_Y),
    (10.40, ASH_Y),        # inner foot of the inscribed rim
    (10.75, 0.46),         # rim inner slope (carries the cyan groove)
    (11.05, 0.46),         # rim crown
    (11.05, 0.00),         # rim outer face (vertical -> parametric zone)
]
RIM_GROOVE_R = (10.42, 10.72)   # world radii of the cyan inscribed groove

# ── legs: cubic Bezier centreline in the (radius, height) plane ──────────
LEG_THETAS = (90.0, 210.0, 330.0)      # azimuths, degrees
LEG_BEZ = ((7.40, -0.45),              # buried foot
           (7.70,  9.50),
           (6.10, 19.60),
           (2.10, 21.65))              # tip, cradling the core
LEG_STATIONS = 19
LEG_HW = (1.45, 0.50)      # half-width, tangential  (foot -> tip)
LEG_HD = (1.35, 0.62)      # half-depth, radial
LEG_CH = (0.32, 0.15)      # profile chamfer
# profile side index -> which rect paints it (8-gon flattened box section)
LEG_SIDE_RECTS = (R_LEG_OUT, R_LEG_CH, R_LEG_SIDE, R_LEG_CH,
                  R_LEG_IN, R_LEG_CH, R_LEG_SIDE, R_LEG_CH)
LEG_INNER_SIDE = 4         # the face that stares at the core

# ── burial mounds (geological weathering: soil swallowed the feet) ───────
MOUND_N    = 8
MOUND_R    = (2.60, 1.70)
MOUND_H    = 0.78

# ── suspended core (piece `core`, pivot on the axis) ─────────────────────
CORE_Y     = 22.00
CORE_N     = 8
# (y relative to CORE_Y, radius) — top lands on 24.00, and the widest belt
# passes just inside the leg tips (0.50 m of clear air: it is SUSPENDED)
CORE_RINGS = [(-2.00, 0.00), (-1.15, 1.12), (0.00, 2.05),
              (1.15, 1.12), (2.00, 0.00)]
CORE_PIVOT = (0.0, CORE_Y, 0.0)

# ── mid-leg cantilever emitter blades ────────────────────────────────────
CANT_T     = 0.58          # bezier parameter of the attachment
CANT_LEN   = 3.20
CANT_HALF  = (0.42, 0.16)  # half-width -> tip half-width

# ── free-standing resonator pylons on the inscribed ring ─────────────────
PYLON_N    = 6
PYLON_THETAS = (30.0, 150.0, 270.0)
PYLON_R    = 6.20          # stand radius
PYLON_RINGS = [(0.00, 0.88, 0.00), (4.20, 0.70, 0.30), (6.60, 0.36, 0.52)]
#              (height, radius, outward lean offset)

# ── broken halo antenna (piece `halo`, pivot = core centre) ──────────────
HALO_R     = 4.75
HALO_TILT  = 16.0          # degrees about local X — makes the Y-spin wobble
HALO_ARC   = 292.0         # degrees of ring present; 68 deg is the break
HALO_SEGS  = 26
HALO_HR    = 0.38          # half-extent, radial
HALO_HH    = 0.26          # half-extent, axial
HALO_END_TAPER = 0.42      # cross-section scale at the broken ends
HALO_INNER_SIDE = 1        # v-band of the bar face that looks at the core
HALO_SPUR_PHI = (22.0, 130.0, 246.0)
HALO_SPUR_LEN = 1.30
HALO_PIVOT = (0.0, CORE_Y, 0.0)

# ── idle clip: slow, irregular-feeling, seamless ─────────────────────────
HALO_STEP_SECS = (8.4, 5.2, 7.1, 4.4, 8.8, 5.0, 7.6, 4.5)   # 45 deg each
IDLE_LEN   = float(sum(HALO_STEP_SECS))                      # 51.0 s
CORE_PULSE_CYCLES = 5
CORE_PULSE_AMP = 0.032
