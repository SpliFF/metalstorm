"""ms_anc_storm_caster_layout — zones + dims for the Ancient storm caster.

An arc-projector of the world-before: 16.4 m across, 10.55 m to the vane
tips. A flared monolithic apron rises from a ring of scorched, glassed
earth; a seamless compression ring shrouds the collar and floats a
six-petal hemispheric shell (R 4.20) over the discharge array. The iris
petals hinge on the equator and part outward 56 deg on `open`, exposing
the array floor and the cyan tesla core — pedestal, column, a FLOATING
faceted crystal, and a needle spire that runs up through the shell's
oculus, through a floating halo ring (`idle`: slow precession), to a
finial at 9.23 m. Four grounded lightning vanes stand at 0/90/180/270
deg, rooted in the apron flare; the front vane (-Z) carries the
team-mask capture tab.

Ancient register: no rivets, no bolts, no patches — large unbroken
surfaces cut by clean recessed seams; emissive CYAN only; weathering is
geological (dust drift, soil burial, scorch), never rust.
World frame: RH, -Z forward, +Y up, ground Y=0. 2048 atlas.
"""
import numpy as np
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── ground / scorched earth ─────────────────────────────────────────────
SCORCH_Y = 0.03
SCORCH_R = (4.62, 6.40, 8.20)      # 16.4 m dominant dimension
N_BIG = 32                          # segments on every "perfect circle"

# ── apron (flared monolithic plinth) ────────────────────────────────────
APRON_Y0, APRON_Y1 = 0.0, 1.35
APRON_R0, APRON_R1 = 4.62, 5.18     # cantilevered flare, base -> rim

# ── collar + inner recess + discharge-array floor ───────────────────────
COLLAR_Y0, COLLAR_Y1 = 1.35, 2.15
COLLAR_R = 4.06
RECESS_R = 3.62
ARRAY_Y = 1.98
ARRAY_R = (1.50, 2.55, 3.62)

# ── dome: compression ring + six iris petals ────────────────────────────
DOME_Y = 2.20                        # sphere centre / hinge plane (world)
DOME_R = 4.20
DR_Y0, DR_Y1 = -0.60, 0.02           # dome-local compression-ring band
DR_OUT, DR_IN = 4.46, 4.20
PETAL_TH = 0.24
LAT0, LAT1 = np.radians(4.0), np.radians(76.0)           # oculus r = 1.016
PETAL_HALF = np.radians(30.0)
PETAL_A = [np.radians(-90.0 + 60.0 * k) for k in range(6)]
NU, NV = 6, 5
OPEN_DEG = 56.0
APEX_Y = DOME_Y + DOME_R * np.sin(LAT1)                  # 6.28

# ── tesla core (core-local; piece offset = (0, ARRAY_Y, 0)) ─────────────
PED_Y0, PED_Y1 = 0.00, 0.62
PED_R0, PED_R1 = 1.62, 1.44
COL_Y0, COL_Y1 = 0.62, 2.10
COL_R0, COL_R1 = 0.60, 0.42
CRY_LO, CRY_MID, CRY_HI = 2.55, 3.05, 4.05               # floats over the column
CRY_R, CRY_N = 1.00, 10
NEEDLE = [(3.60, 0.22), (4.55, 0.15), (5.70, 0.09), (6.60, 0.045)]
FIN_LO, FIN_MID, FIN_HI = 6.45, 6.75, 7.25
FIN_R = 0.26
HALO_OFF = (0.0, 5.62, 0.0)                              # world y 7.60
HALO_R, HALO_W, HALO_H, HALO_N = 1.35, 0.26, 0.11, 16
HALO_TILT = np.radians(22.0)
CORE_RISE = 0.45                                         # `open` core lift

# ── lightning vanes (grounded, leaning out of the apron flare) ──────────
VANE_A = [0.0, 90.0, 180.0, 270.0]   # deg; 270 = front (-Z) = capture tab
TAB_VANE = 3
#           y      radius  half-width(tangential)  half-thickness(radial)
VANE = [(-0.35,  4.95, 1.34, 0.64),
        ( 1.35,  5.30, 1.22, 0.56),
        ( 4.20,  5.95, 1.04, 0.46),
        ( 7.20,  6.75, 0.80, 0.34),
        ( 9.60,  7.45, 0.48, 0.20),
        (10.55,  7.80, 0.14, 0.07)]
TAB_Y0, TAB_Y1 = 2.50, 3.85
TAB_HW = 0.50
TAB_PROUD = 0.10


def vane_at(y):
    """(radius, half_width, half_thickness) of a vane at world height y."""
    ys = [s[0] for s in VANE]
    return tuple(float(np.interp(y, ys, [s[i] for s in VANE])) for i in (1, 2, 3))


# ── atlas zones (2048; v runs DOWN the image) ───────────────────────────
# planar (x,z) cells
R_SCORCH = Zone((0, 0, 720, 720), ('x', 'z'), ((-8.4, 8.4), (-8.4, 8.4)))
R_DISC = Zone((740, 0, 1460, 720), ('x', 'z'), ((-5.4, 5.4), (-5.4, 5.4)))
# parametric wraps: u = around, v = along
R_APRON_W = (0, 740, 1300, 900)
R_COLLAR_W = (0, 920, 1300, 1010)
R_RECESS_W = (0, 1030, 1300, 1080)
R_DRING_O = (0, 1100, 1300, 1200)
R_DRING_T = (0, 1220, 1300, 1270)
R_DRING_I = (0, 1290, 1300, 1360)
R_VANE = (0, 1390, 1300, 1560)
R_CORE = (0, 1590, 900, 1710)
R_CRYST = (0, 1730, 900, 1870)
R_NEEDLE = (0, 1890, 900, 1950)
R_HALO = (940, 1590, 2040, 1710)
# petal cells
R_PETAL_O = (1480, 0, 2040, 700)
R_PETAL_I = (1480, 720, 2040, 1120)
R_PETAL_E = (1480, 1140, 2040, 1220)     # 4 stacked rim strips
# team tab (front vane faces -Z; project x across, y down)
R_TAB = Zone((1480, 1250, 1800, 1530), ('x', 'y'),
             ((-TAB_HW - 0.06, TAB_HW + 0.06), (TAB_Y1 + 0.06, TAB_Y0 - 0.06)))
R_DARK = Zone((1840, 1250, 1960, 1370), ('x', 'z'), ((-40, 40), (-40, 40)))
