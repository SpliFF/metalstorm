"""ms_anc_custodian_layout — zones + dims for ms_anc_custodian.

ANCIENT REGISTER. A Custodian automaton: a maintenance drone of the
world-before. s1 scale (4.5 m dominant length, tanks row). Monolithic
hovering wedge chassis — no wheels, no tracks, no bolts. It floats 0.80 m
clear of the ground on four perfect-circle underside emitter plates, each
with a detached inner disc hanging free beneath it. Two folded manipulator
arms are stowed against the flanks. A perfect ring `dish` gyro floats,
unattached, around a slender pylon, inside a second detached halo ring;
it turns forever (idle scan). Cyan tracery runs the belly keel and the
dorsal spine; a circular core well on the deck is capped by a floating
lens. Team ownership shows on one chip per shoulder (CAPTURABLE).

World frame: forward -Z, up +Y, left +X, ground Y=0, 1 unit = 1 m.
"""
import math
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas zones (1024²; v down) ─────────────────────────────────────────
# Row 0 — the two big unbroken planes.
A_TOP    = Zone((0,   0,   512, 320),  ('x', 'z'), ((-1.30, 1.30), (-2.30, 2.30)))
A_BELLY  = Zone((512, 0,   1024, 320), ('x', 'z'), ((-1.30, 1.30), (-2.30, 2.30)))
# Row 1 — flanks and ends.
A_SIDE   = Zone((0,   320, 512, 512),  ('z', 'y'), ((-2.30, 2.30), (1.95, 0.60)))
A_FRONT  = Zone((512, 320, 704, 448),  ('x', 'y'), ((-1.30, 1.30), (1.95, 0.60)))
A_REAR   = Zone((704, 320, 896, 448),  ('x', 'y'), ((1.30, -1.30), (1.95, 0.60)))
A_TRIM   = (896, 320, 1024, 448)                  # parametric small-part wrap
A_TRIMZ  = Zone((896, 320, 1024, 448), ('z', 'y'), ((-4.0, 4.0), (4.0, -4.0)))
A_EMIT   = (512, 448, 896, 512)                   # emitter / core collar band
A_SPINE  = Zone((896, 448, 1024, 512), ('x', 'z'), ((-0.22, 0.22), (-0.62, 1.78)))
# Row 2 — the ring gyro, the emitters, the arms.
A_DISH_F = (0,   512, 256, 768)                   # rect; Zone built in gen
A_DISH_B = (256, 512, 512, 768)
A_EMIT_F = (512, 512, 640, 640)                   # per-pad Zone built in gen
A_LENS   = (640, 512, 768, 640)                   # per-pad Zone built in gen
A_ARM_C  = Zone((768, 512, 896, 640), ('z', 'y'), ((-0.26, 0.26), (0.26, -0.26)))
A_CORE   = Zone((896, 512, 1024, 640), ('x', 'z'), ((-0.44, 0.44), (0.98, 1.86)))
A_CHIP   = Zone((512, 640, 640, 736),  ('z', 'y'), ((-0.82, 0.10), (1.68, 1.20)))
A_TOOL   = Zone((640, 640, 768, 736),  ('x', 'y'), ((0.00, 0.42), (-0.40, -0.76)))
A_HALO   = (768, 640, 896, 704)                   # halo rim band (parametric)
A_GLOW   = Zone((896, 640, 1024, 704), ('x', 'y'), ((-8.0, 8.0), (8.0, -8.0)))
A_HALO_F = Zone((768, 704, 896, 768),  ('x', 'z'), ((-0.52, 0.52), (0.03, 1.07)))
A_ARM    = (896, 704, 1024, 768)                  # arm-segment wrap
# Row 3 — lenses, dark cell, core well.
A_LENS_D = (0,   768, 192, 960)                   # dish floating lens (Zone in gen)
A_DARK   = Zone((192, 768, 320, 896), ('x', 'z'), ((-1.30, 1.30), (-2.30, 2.30)))
A_CORE_L = Zone((320, 768, 512, 960), ('x', 'z'), ((-0.30, 0.30), (1.12, 1.72)))
A_DISH_R = (512, 768, 896, 832)                   # ring rim wrap

# ── hull (metres). Hover clearance 0.80 m; total length 4.50 m. ─────────
HOVER = 0.80

# lofted wedge sections, front (-Z) to rear (+Z):
#   (z, y_bot, y_mid, y_top, y_deck, hw_bot, hw_mid, hw_top, hw_deck)
# the deck vertex sits above the shoulder vertex -> a dorsal ridge.
HULL_SECTIONS = [
    (-2.25, 1.12, 1.16, 1.22, 1.26, 0.10, 0.14, 0.12, 0.06),
    (-1.80, 1.02, 1.10, 1.28, 1.34, 0.34, 0.46, 0.40, 0.22),
    (-1.05, 0.88, 1.02, 1.50, 1.58, 0.76, 0.98, 0.88, 0.46),
    (-0.20, 0.82, 0.98, 1.66, 1.76, 0.98, 1.20, 1.08, 0.56),
    (0.70,  0.80, 0.96, 1.70, 1.80, 1.00, 1.22, 1.10, 0.58),
    (1.55,  0.82, 0.98, 1.62, 1.72, 0.94, 1.14, 1.02, 0.54),
    (2.25,  0.90, 1.04, 1.44, 1.52, 0.70, 0.84, 0.74, 0.38),
]

# ── underside emitter plates (perfect circles, detached inner disc) ─────
# (cx, cz, radius, y_top buried in the belly, y_lip)
EMITTERS = [(0.36, -0.85, 0.26, 0.900, 0.790),
            (-0.36, -0.85, 0.26, 0.900, 0.790),
            (0.50, 1.30, 0.33, 0.845, 0.735),
            (-0.50, 1.30, 0.33, 0.845, 0.735)]
EMIT_N     = 12
EMIT_INNER = 0.55          # inner/outer radius ratio of the lip annulus
EMIT_DISC  = 0.42          # floating disc radius ratio
EMIT_GAP   = 0.050         # how far the disc hangs free below the lip

# ── belly keel (carries the cyan under-line) ────────────────────────────
KEEL_C    = (0.0, 0.80, 0.60)
KEEL_SIZE = (0.34, 0.13, 2.20)

# ── dorsal core well (circular, floating lens cap) ──────────────────────
CORE_Z      = 1.42
CORE_R      = 0.40
CORE_RI     = 0.24
CORE_N      = 12
CORE_FLOOR  = 1.66
CORE_TOP    = 1.92
CORE_LENS_Y = 1.99
CORE_LENS_R = 0.26

# ── dish pylon + detached halo ring ─────────────────────────────────────
PYLON_Z    = 0.55
PYLON_BASE = 1.68
PYLON_TOP  = 1.99
PYLON_R    = (0.17, 0.12)
HALO_Y  = 2.05
HALO_RO = 0.46
HALO_RI = 0.30
HALO_TH = 0.08
HALO_N  = 12

# ── `dish`: a perfect ring gyro floating around the pylon ───────────────
DISH_OFF  = (0.0, 2.30, PYLON_Z)
DISH_TILT = 18.0                     # degrees, nose-up about X
DISH_N    = 16
DISH_RO   = 0.54
DISH_RI   = 0.38
DISH_TH   = 0.09
DISH_LENS_R = 0.20                   # free-floating core lens at ring centre
DISH_STEM = ((0.0, -0.34, 0.0), (0.0, -0.12, 0.0), 0.12, 0.10)
# atlas windows for the ring faces: v window pre-squashed by the tilt so the
# projected circle stays a circle in the atlas.
DISH_UWIN = 0.58
DISH_VWIN = DISH_UWIN * math.cos(math.radians(DISH_TILT))

# ── cantilevered prow vanes (grand geometry; delta planform) ────────────
# corners around the planform: (x, z, y_top, y_bot); mirrored for -x.
VANE = [(0.42, -1.15, 1.330, 1.240),
        (0.34, -1.70, 1.325, 1.245),
        (0.86, -1.92, 1.300, 1.255),
        (1.02, -1.30, 1.300, 1.250)]

# ── team chips (CAPTURABLE marker), one per shoulder ────────────────────
CHIP_C    = (1.13, 1.44, -0.36)
CHIP_SIZE = (0.09, 0.36, 0.86)

# ── folded manipulator arms (piece-local; shoulder at the origin) ───────
ARM_OFF   = (1.02, 1.46, -0.30)
ARM_HUB   = (-0.10, 0.20, 0.24)      # x_in, x_out, radius (axis X)
ARM_HUB_N = 8
ARM_UPPER = ((0.14, -0.05, 0.05), (0.19, -0.24, 0.62), 0.17, 0.145)
ARM_FORE  = ((0.19, -0.24, 0.62), (0.21, -0.46, -0.06), 0.145, 0.115)
ARM_TOOL_C = (0.21, -0.56, -0.16)
ARM_TOOL_S = (0.24, 0.24, 0.34)
ARM_TIP   = (0.21, -0.56, -0.36)     # free-floating cyan tip lens
ARM_TIP_R = 0.090

# ── clips ───────────────────────────────────────────────────────────────
IDLE_T   = 12.0
BOB_UP   = 0.06
BOB_DOWN = -0.045
