"""ms_anc_reactor_layout — zones + dims for ms_anc_reactor.

ANCIENT REGISTER. Geothermal core tap: a 25 m dome-and-shaft reactor.
A hemispherical containment dome sunk into a recessed crater apron, a ring
of monolithic radiator fins on the apron shelf, four cantilevered buttress
pylons sweeping from shelf to a flared crown, an exposed CYAN core column
running the full shaft, a floating capstone emitter, and two independent
floating gyroscopic rings (pieces `ring` / `ring2`, tilt baked into the
geometry, counter-rotating slow idle) around the core.
ACTIVE: the cyan flows. Seamless — no rivets, no bolts, no patches.
Weathering is geological: dust drift, soil burial at the base, scorch.
Dominant dim 25 m -> ATLAS 2048. No team colour.
World frame: RH, -Z forward, +Y up, ground Y=0.
"""
import numpy as np

import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
N_APRON   = 20            # apron / crater n-gon
N_DOME    = 20            # dome latitude ring n-gon
N_CORE    = 12            # core column n-gon
N_CROWN   = 12            # crown n-gon (must match N_CORE — shared seam)

# crater apron: outer skirt buried in soil, flat shelf, recessed step down
APRON_R_OUT = 11.30       # skirt radius
APRON_R_LIP = 11.20       # shelf outer edge (after the chamfer)
APRON_R_IN  = 9.52        # shelf inner edge
APRON_R_STEP= 9.40        # crater step wall radius (after the chamfer)
APRON_Y_BOT = -1.10       # skirt bottom (buried)
APRON_Y_CH  = 0.40        # skirt/chamfer break
APRON_Y_TOP = 0.55        # shelf top
CRATER_Y    = -0.90       # crater floor (dome springs here)
CRATER_R    = 8.20        # crater floor inner edge == dome base radius

# containment dome: true hemisphere, truncated at the oculus
DOME_R      = 8.20
DOME_CY     = CRATER_Y    # sphere centre height
DOME_OCU_R  = 3.06        # oculus radius
DOME_TH_MAX = float(np.arccos(DOME_OCU_R / DOME_R))
DOME_TOP_Y  = DOME_CY + DOME_R * float(np.sin(DOME_TH_MAX))   # ~6.71
DOME_BANDS  = 5

# dome meridian ribs (8, between the pylons) — proud seam ribs
RIB_N       = 8
RIB_AZ0     = 22.5
RIB_TH      = [0.05, 0.42, 0.80, None]     # None -> DOME_TH_MAX
RIB_R       = [0.34, 0.30, 0.25, 0.20]
RIB_PROUD   = 0.17        # ride this far outside the sphere

# collar lip above the oculus (recessed seam, then a flare)
COLLAR_Y0   = DOME_TOP_Y
COLLAR_Y1   = DOME_TOP_Y + 0.55
COLLAR_Y2   = DOME_TOP_Y + 1.05
COLLAR_R0   = DOME_OCU_R
COLLAR_R1   = DOME_OCU_R + 0.34

# exposed cyan core column
CORE_Y0     = DOME_TOP_Y - 0.40
CORE_Y1     = 21.00
CORE_R0     = 1.34
CORE_R1     = 1.08
CORE_RIBS   = [9.60, 13.90, 18.20]   # containment collar heights
CORE_RIB_D  = 0.24        # collar radial proudness

# flared crown head
CROWN = [                 # (y, radius)
    (21.00, 1.08),
    (21.55, 3.25),        # sharp cantilever flare
    (23.10, 3.25),
    (23.70, 2.60),
]
# floating capstone emitter (gap bridged only by a thin cyan rod)
BEAM_Y0     = 23.70
BEAM_Y1     = 24.18
BEAM_R      = 0.20
CAP_Y0      = 24.18
CAP_MID_Y   = 24.58
CAP_TOP_Y   = 25.00
CAP_R       = 1.05
CAP_N       = 8

# four cantilevered buttress pylons (45 deg azimuths)
PYLON_AZ    = [45.0, 135.0, 225.0, 315.0]
PYLON_BASE  = (9.60, 0.43)                   # (radius, y)
PYLON_KNEE  = (9.00, 9.00)
PYLON_TOP   = (3.25, 21.55)
PYLON_R     = (1.10, 0.86, 0.58)             # base, knee, top radii
PYLON_COLLAR_R = 0.98                        # knee collar bulge

# radiator fins on the apron shelf (12, radial swept slabs)
FIN_N       = 12
FIN_AZ0     = 0.0
FIN_R0      = 9.62
FIN_R1      = 11.15
FIN_Y0      = 0.50
FIN_Y1_IN   = 5.60        # inner (tall) top
FIN_Y1_OUT  = 3.40        # outer (short) top — swept blade
FIN_T       = 0.62        # thickness
# fin profile (radius, height), and its normalised perimeter parameter — the
# rim atlas cell is indexed by perimeter, not radius (the two vertical rims
# would otherwise collapse to zero UV width).
FIN_PROFILE = [(FIN_R0, FIN_Y0), (FIN_R0, FIN_Y1_IN),
               (FIN_R1, FIN_Y1_OUT), (FIN_R1, FIN_Y0)]
_seg = [float(np.hypot(FIN_PROFILE[i + 1][0] - FIN_PROFILE[i][0],
                       FIN_PROFILE[i + 1][1] - FIN_PROFILE[i][1]))
        for i in range(len(FIN_PROFILE) - 1)]
FIN_PERIM = [float(sum(_seg[:i]) / sum(_seg)) for i in range(len(_seg) + 1)]

# conduit runs -> grid stubs
STUB_AZ     = [15.0, 105.0, 255.0]
STUB_R      = 12.55
STUB_Y      = 2.60
STUB_R0     = 0.95
STUB_R1     = 0.62
CONDUIT_R0  = 9.20        # leaves the crater lip
CONDUIT_R1  = STUB_R
CONDUIT_Y0  = 0.99
CONDUIT_Y1  = 1.90
CONDUIT_RAD = 0.30

# floating gyroscopic rings — tilt baked into the geometry so the Y-spin
# reads as gyroscopic precession
RING_N      = 20
RING1_PIVOT = (0.0, 11.80, 0.0)
RING1_R     = 5.00
RING1_BAR   = 0.30
RING1_TILT  = 18.0        # degrees about X
RING2_PIVOT = (0.0, 16.20, 0.0)
RING2_R     = 3.50
RING2_BAR   = 0.24
RING2_TILT  = -24.0
NODE_LEN    = 0.78        # gyro node emitter spike
NODE_R0     = 0.42
NODE_R1     = 0.07
NODE_EVERY  = 5           # a node every Nth ring vertex

# idle clip: 180 s master loop; ring +2 rev, ring2 -4 rev (both even, so the
# quaternion track lands exactly back on identity — seamless)
IDLE_T      = 180.0
RING1_REV   = 2.0
RING2_REV   = -4.0

# ── atlas zones (2048^2; v down) ─────────────────────────────────────────
# one big x/z disc: apron shelf, crater floor, collar top, stub top caps
R_DISC     = Zone((0,    0,    896,  896),  ('x', 'z'), ((-13.2, 13.2), (-13.2, 13.2)))
# apron outer skirt + crater step wall (horizontally uniform bands)
R_SKIRT    = Zone((0,    896,  896,  1088), ('x', 'y'), ((-13.2, 13.2), (1.00, -1.20)))
# fin faces / edges: explicit UVs (u = radial param, v = height / thickness)
R_FIN_FACE = (0,    1088, 896,  1472)
R_FIN_EDGE = (0,    1472, 896,  1600)
R_CROWNTOP = Zone((0,    1600, 448,  2048), ('x', 'z'), ((-3.0, 3.0), (-3.0, 3.0)))
R_STUB     = (448,  1600, 896,  1856)
R_CONDUIT  = (448,  1856, 896,  1984)
R_BEAM     = (448,  1984, 896,  2048)
# dome shell: latitude bands map straight onto v
R_DOME     = Zone((896,  0,    1792, 896),  ('x', 'y'), ((-8.6, 8.6), (7.00, -1.20)))
R_COLLAR   = Zone((896,  896,  1792, 1088), ('x', 'y'), ((-3.6, 3.6), (8.10, 6.30)))
R_CROWN    = Zone((896,  1088, 1792, 1728), ('x', 'y'), ((-3.4, 3.4), (25.20, 20.60)))
R_CAP      = Zone((896,  1728, 1472, 2048), ('x', 'y'), ((-1.15, 1.15), (25.10, 24.10)))
R_DARK     = Zone((1472, 1728, 1792, 2048), ('x', 'z'), ((-1.0, 1.0), (-1.0, 1.0)))
# the core: its own tall strip, v = world height
R_CORE     = Zone((1792, 0,    2048, 1024), ('x', 'y'), ((-1.60, 1.60), (21.20, 6.00)))
R_PYLON    = (1792, 1024, 2048, 1280)
R_RIB      = (1792, 1280, 2048, 1408)
R_RING     = (1792, 1408, 2048, 1536)
R_NODE     = (1792, 1536, 2048, 1664)
R_SPARE    = (1792, 1664, 2048, 2048)
