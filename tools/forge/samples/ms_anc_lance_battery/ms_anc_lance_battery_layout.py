"""ms_anc_lance_battery_layout — zones + dims for the ancient particle lance battery.

ANCIENT REGISTER. A 20 m fixed emplacement from the world-before: a monolithic
soil-buried drum base (24-gon, perfect circle, unbroken wall cut only by clean
recessed seams), a stepped plinth, and — with a 0.95 m AIR GAP, nothing
touching — a floating yoke ring that carries two forward-cantilevered arms.
Slung between them is a 14.0 m particle lance: a dark alloy shaft beaded with
six cyan acceleration rings, ringed by two free-floating field collars, ending
in a four-prong emitter around a cyan core.

Emissive cyan is the only light on the model (ancient-tech signature, ACTIVE:
it flows brighter toward the emitter). No bolts, no rivets, no patches, no
rust — weathering is geological: soil burial at the drum foot, dust drift up
the wall, scorch at the emitter.

CAPTURABLE: four team-mask chevron plaques on the base drum (+Z/-Z/+X/-X).

World frame: RH, lance points -Z at rest, +Y up, ground Y=0. 2048^2 atlas.
Dominant dimension 19.70 m (skirt rear z=+7.30 -> prong tip z=-12.40).
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

ATLAS = 2048

# ── segment counts ───────────────────────────────────────────────────────
N_DRUM = 24        # base drum / plinth / yoke ring — reads as a true circle
N_RING = 24
N_TUBE = 12        # lance shaft
N_COLLAR = 12
N_PRONG = 4

# ── base drum (body, world metres, ground Y=0) ───────────────────────────
# skirt = the soil-buried flare; drum = the monolith; plinth = the stepped cap
SKIRT_RINGS = [(1.10, 6.80), (0.00, 7.35)]                 # (y, r) top -> down
# The crown tracery ring and the base course get their OWN geometry rows: a
# painted band inside a 5 m-tall quad row would flat-shade into a sawtooth.
CROWN_Y0, CROWN_Y1 = 5.98, 5.80
DRUM_RINGS = [(6.40, 6.25), (CROWN_Y0, 6.50), (CROWN_Y1, 6.60), (5.60, 6.72),
              (4.60, 6.80), (2.60, 6.80), (1.45, 6.80), (1.10, 6.80)]
DRUM_TOP_Y = 6.40
DRUM_TOP_R = 6.25
# crown shelf, concentric rows at DRUM_TOP_Y (outer -> inner)
SHELF_RINGS = [6.25, 5.35, 5.05, 4.10]
PLINTH_RINGS = [(8.10, 3.75), (7.50, 3.95), (6.40, 4.10)]
PLINTH_TOP_Y = 8.10
PLINTH_TOP_R = 3.75
# levitation dais, concentric rows at PLINTH_TOP_Y (outer -> inner) + a cap
DAIS_RINGS = [3.75, 3.05, 2.75, 1.35, 0.95]
DAIS_CAP_R = 0.95

DRUM_Y_TOP, DRUM_Y_BOT = 6.40, 1.10        # v-window of the drum wall wrap
PLINTH_Y_TOP, PLINTH_Y_BOT = 8.10, 6.40
SKIRT_Y_TOP, SKIRT_Y_BOT = 1.10, 0.00

# team-mask chevron plaques, one per cardinal facet of the 24-gon
PLAQ_Y = 3.30
PLAQ_W, PLAQ_H, PLAQ_T = 1.50, 2.40, 0.20
PLAQ_FACE = 6.80 * 0.991445            # r * cos(pi/24) — facet plane distance
PLAQ_OFF = PLAQ_FACE + PLAQ_T / 2 - 0.03

# ── floating yoke ring (piece `turret`) ──────────────────────────────────
AIR_GAP = 0.95                          # plinth top -> ring underside
RING_Y = PLINTH_TOP_Y + AIR_GAP + 0.35  # 9.40 — piece origin (ring mid-plane)
RING_RO, RING_RI, RING_HH = 4.60, 3.40, 0.35     # outer r, inner r, half-height

# yoke arms: cantilevered FORWARD off the ring (-Z) — the lance hangs ahead
ARM_FOOT = (3.30, 0.35, -1.10)          # ring-local, x mirrored
ARM_KNEE = (2.55, 1.85, -1.45)
TRUN = (2.15, 2.95, -1.60)              # ring-local trunnion centre
TRUN_R, TRUN_HL = 0.85, 0.45
ARM_A0, ARM_B0 = 0.34, 0.72             # blade half-thickness (X), half-width (Z)
ARM_A1, ARM_B1 = 0.30, 0.62
ARM_A2, ARM_B2 = 0.26, 0.52

# ── lance (piece `barrel`), local frame: pivot at origin, -Z forward ─────
L_ZMAX = 3.20                            # breech face
L_ZMIN = -9.90                           # end of the shaft tube
PRONG_TIP = -10.80                       # emitter prong tips  (14.00 m overall)
LANCE_LEN = L_ZMAX - PRONG_TIP           # 14.00

CORE_R0, CORE_R1 = 0.48, 0.38            # shaft radius, breech -> muzzle
ACC_R0, ACC_R1 = 0.80, 0.70              # acceleration-ring radius
ACC_Z = [1.50, -0.10, -1.70, -3.30, -4.90, -6.50]   # ring centres
ACC_HALF, ACC_SHOULDER = 0.13, 0.20

COLLAR_Z = [-0.90, -4.10]                # free-floating field collars
COLLAR_RO, COLLAR_RI, COLLAR_HH = 1.45, 1.05, 0.18

PRONG_Z0, PRONG_R0 = -9.30, 0.50
PRONG_Z1, PRONG_R1 = PRONG_TIP, 0.95
PRONG_T0, PRONG_T1 = 0.20, 0.14
CORE_DISC_Z, CORE_DISC_R = -9.94, 0.62   # emitter core, faces -Z


def lance_stations():
    """(z, r) stations for the shaft tube, breech -> muzzle."""
    st = [(L_ZMAX, 0.62), (3.00, 0.95), (2.30, 0.95), (2.16, CORE_R0)]
    n = len(ACC_Z)
    for i, c in enumerate(ACC_Z):
        f = i / (n - 1)
        rc = CORE_R0 + (CORE_R1 - CORE_R0) * f
        ra = ACC_R0 + (ACC_R1 - ACC_R0) * f
        st += [(c + ACC_SHOULDER, rc), (c + ACC_HALF, ra),
               (c - ACC_HALF, ra), (c - ACC_SHOULDER, rc)]
    st += [(-7.60, 0.36), (-7.85, 0.56), (-8.45, 0.56),
           (-8.65, 0.34), (-9.40, 0.31), (L_ZMIN, 0.27)]
    return st


# ── atlas: wrap RECTS (parametric u = around, v = along) ─────────────────
R_SHELF = (1536, 0, 2048, 200)           # crown shelf, v = outer -> inner
R_DAIS = (1536, 208, 2048, 408)          # levitation dais, v = outer -> inner
R_SKIRT = (0, 0, 1536, 160)
R_DRUM = (0, 160, 1536, 800)
R_PLINTH = (0, 800, 1536, 960)
R_RING_O = (0, 960, 1536, 1056)
R_RING_I = (0, 1056, 1536, 1152)
R_RING_T = (0, 1152, 1536, 1216)
R_RING_B = (0, 1216, 1536, 1280)
R_ARM = (0, 1280, 512, 1376)
R_TRUN = (512, 1280, 896, 1376)
R_LANCE = (0, 1408, 2048, 1664)          # u ALONG the lance (meshlib.tube)
R_COL_O = (0, 1664, 768, 1728)
R_COL_I = (0, 1728, 768, 1792)
R_COL_F = (768, 1664, 1536, 1728)
R_COL_B = (768, 1728, 1536, 1792)
R_PRONG = (0, 1792, 512, 1856)

# ── atlas: planar ZONES ──────────────────────────────────────────────────
Z_DAIS = Zone((1536, 416, 1664, 544), ('x', 'z'), ((-1.1, 1.1), (-1.1, 1.1)))
Z_PLAQ_Z = Zone((1536, 896, 1856, 1408), ('x', 'y'), ((-0.85, 0.85), (4.65, 1.95)))
Z_PLAQ_X = Zone((1536, 896, 1856, 1408), ('z', 'y'), ((-0.85, 0.85), (4.65, 1.95)))
Z_TRIM = Zone((1856, 896, 1920, 960), ('x', 'y'), ((-1.0, 1.0), (1.0, -1.0)))
Z_BREECH = Zone((1920, 896, 2048, 1024), ('x', 'y'), ((-0.7, 0.7), (0.7, -0.7)))
Z_TIP = Zone((1920, 1024, 2048, 1152), ('x', 'y'), ((-0.35, 0.35), (0.35, -0.35)))
Z_CORE = Zone((1920, 1152, 2048, 1280), ('x', 'y'), ((-0.7, 0.7), (0.7, -0.7)))
Z_DARK = Zone((1984, 1280, 2048, 1344), ('x', 'z'), ((-40, 40), (-40, 40)))


# ── wrap coordinate helpers (shared by generator and painter) ────────────
def wrap_u(rect, n, j):
    """Atlas px for facet-boundary index j (0..n) of an n-gon wrap."""
    x0, _, x1, _ = rect
    return x0 + (x1 - x0) * j / n


def wrap_v(rect, y, y_top, y_bot):
    """Atlas px for world height y in a wall wrap (v runs down = world down)."""
    _, y0, _, y1 = rect
    return y0 + (y1 - y0) * (y_top - y) / (y_top - y_bot)


def lance_u(z):
    """Atlas px for a lance-local z in R_LANCE (u runs breech -> muzzle)."""
    x0, _, x1, _ = R_LANCE
    return x0 + (x1 - x0) * (L_ZMAX - z) / (L_ZMAX - L_ZMIN)
