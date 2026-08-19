"""ms_bombers_s3_layout — zones + dims for the s3 Medium Level Bomber.

The ONE orthodox airframe in the bomber line: a conventional-tail manned
medium bomber. 16.0 m span, ~16.5 m nose-to-tailcone, 5.6 m to the fin tip.
Long slab fuselage with the §26 WIDE flattened cross-section (chine half-width
1.80, flat-bottomed, constant-section over the bay run), a LOW 3-bow
side-by-side canopy set into the forward deck with a glazed bomb-aimer chin
panel beneath the nose, a shoulder-mounted straight-taper wing (~27° LE sweep,
unswept trailing edge) carrying TWO podded underwing engine nacelles (own
intake lip forward of the LE, own nozzle aft of the TE, on visible pylons), a
single tall centreline fin plus a horizontal tailplane on the real aft
fuselage, a long ventral weapons bay running 5.6 m of the belly, a fixed
ventral MG blister aft of the bay, and a dorsal spine aft of the canopy.

s1 is a V-tail drone and s4 is a tailless flying wing — this tier is the
recognisably "classic bomber" shape in the middle.

Frame: -Z forward, +Y up, wheels at Y=0, 1 unit = 1 m. 2048 atlas.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ─────────────────────────────────────────
# three world-anchored body bands at uniform chord-wise density
B_SIDE = Zone((0, 0, 2048, 448), ('z', 'y'), ((-9.0, 8.2), (3.60, 1.00)))
B_TOP = Zone((0, 448, 2048, 1344), ('z', 'x'), ((-9.0, 8.2), (-8.4, 8.4)))
B_BOT = Zone((0, 1344, 2048, 1856), ('z', 'x'), ((-9.0, 8.2), (-8.4, 8.4)))

B_CANOPY = Zone((0, 1856, 512, 2048), ('z', 'y'), ((-7.60, -5.10),
                                                   (3.45, 2.50)))
B_FIN = Zone((512, 1856, 1024, 2048), ('z', 'y'), ((4.10, 7.50), (5.80, 2.40)))

B_NAC = (1024, 1856, 1408, 1920)          # parametric nacelle-body wrap
B_BURNER = Zone((1408, 1856, 1536, 1920), ('x', 'y'), ((-45, 45), (25, -5)))
B_DUCT = Zone((1536, 1856, 1664, 1920), ('z', 'y'), ((-45, 45), (25, -5)))
B_GEAR = Zone((1664, 1856, 1792, 1920), ('z', 'y'), ((-45, 45), (25, -5)))
B_TRIM = Zone((1792, 1856, 1920, 1920), ('z', 'y'), ((-45, 45), (25, -5)))
B_DARK = Zone((1920, 1856, 2048, 1920), ('x', 'z'), ((-45, 45), (-45, 45)))
B_NAVP = Zone((1024, 1920, 1152, 1984), ('z', 'y'), ((-45, 45), (25, -5)))
B_NAVS = Zone((1152, 1920, 1280, 1984), ('z', 'y'), ((-45, 45), (25, -5)))
B_GLASS = Zone((1280, 1920, 1536, 1984), ('z', 'y'), ((-45, 45), (25, -5)))
B_BARREL = (1536, 1920, 1664, 1984)       # parametric MG barrel wrap
B_BAYIN = Zone((1664, 1920, 1920, 1984), ('z', 'x'), ((-45, 45), (-45, 45)))

# ── fuselage loft: (z, w_chine, half_w_top, y_top, y_bot, y_chine) ─────
# Flat-bottomed, broad-shouldered, CONSTANT SECTION over the bay run
# (z -4.20 .. +2.20) — the slab that makes the side view read "bomber".
FUS_SECTIONS = [
    (-8.60, 0.16, 0.08, 2.30, 2.10, 2.20),
    (-8.00, 0.52, 0.28, 2.46, 1.90, 2.16),
    (-7.20, 1.02, 0.60, 2.70, 1.68, 2.15),
    (-6.30, 1.44, 0.88, 2.90, 1.53, 2.15),
    (-5.40, 1.68, 1.04, 3.02, 1.46, 2.15),
    (-4.20, 1.80, 1.12, 3.05, 1.43, 2.15),
    (-2.60, 1.80, 1.12, 3.06, 1.42, 2.14),
    (-0.60, 1.80, 1.12, 3.06, 1.42, 2.14),
    (1.20, 1.80, 1.12, 3.06, 1.42, 2.14),
    (2.20, 1.78, 1.11, 3.05, 1.43, 2.14),
    (3.40, 1.68, 1.05, 3.01, 1.50, 2.15),
    (4.60, 1.52, 0.95, 2.95, 1.62, 2.17),
    (5.80, 1.28, 0.80, 2.87, 1.80, 2.21),
    (7.00, 0.94, 0.58, 2.76, 2.05, 2.30),
    (7.90, 0.52, 0.32, 2.66, 2.28, 2.44),
]

# dorsal spine fairing aft of the canopy: (z, half_w, y_bot, y_top)
SPINE_SECTIONS = [
    (-5.00, 0.36, 2.88, 3.16),
    (-2.00, 0.38, 2.92, 3.22),
    (1.60, 0.34, 2.90, 3.18),
    (4.60, 0.26, 2.78, 3.02),
    (6.40, 0.16, 2.62, 2.84),
]

# LOW 3-bow side-by-side canopy: (z, half_w, y_base, y_top)
# bases sit BELOW the deck at every station (bury rule) — the crown only
# clears the fuselage top by ~0.25 m, so it reads stepped, not bubble.
CAN_SECTIONS = [
    (-7.40, 0.30, 2.56, 2.72),
    (-7.00, 0.74, 2.66, 3.18),
    (-6.40, 0.96, 2.78, 3.32),
    (-5.80, 0.92, 2.84, 3.28),
    (-5.30, 0.58, 2.90, 3.06),
]

# glazed bomb-aimer chin panel (buried into the forward belly)
AIMER = ((0.0, 1.70, -7.10), (0.90, 0.48, 1.30))

# ── lifting surfaces: (span_x, y, z_le, z_te, thickness) ───────────────
# shoulder-mounted straight-taper wing; ~27° LE sweep, unswept TE.
WING = [
    (0.80, 2.86, -3.20, 1.70, 0.46),
    (2.40, 2.88, -2.40, 1.70, 0.38),
    (4.60, 2.92, -1.30, 1.70, 0.26),
    (6.40, 2.95, -0.40, 1.70, 0.17),
    (8.00, 2.98, 0.40, 1.70, 0.09),
]
# single tall centreline fin: thickness along x, root BURIED at y 2.55
# (deck is 2.66..2.95 over the fin's z range, so the root is genuinely inside)
FIN = [
    (0.00, 2.55, 4.30, 7.30, 0.36),
    (0.00, 3.60, 4.65, 7.28, 0.28),
    (0.00, 4.70, 5.05, 7.22, 0.18),
    (0.00, 5.60, 5.45, 7.14, 0.09),
]
# horizontal tailplane on the aft fuselage; root x 0.40 sits inside the
# ~0.82 m half-width the loft actually carries at y 2.70 there.
TAILPLANE = [
    (0.40, 2.70, 5.55, 7.35, 0.30),
    (1.90, 2.74, 5.85, 7.30, 0.22),
    (3.20, 2.78, 6.15, 7.25, 0.11),
]

# ── podded underwing engine nacelles ───────────────────────────────────
NAC_X = 3.70
NAC_Y = 1.95
# tube stations aft (z max) -> forward (z min); cap_start = nozzle exit
NACELLE = [(2.95, 0.40, NAC_Y), (2.60, 0.50, NAC_Y), (1.70, 0.56, NAC_Y),
           (-1.40, 0.58, NAC_Y), (-2.70, 0.54, NAC_Y), (-3.20, 0.50, NAC_Y)]
INTAKE_Z = -3.20          # lip plane, forward of the wing LE (-1.75 there)
INTAKE_R = 0.50
THROAT_Z = -2.72
THROAT_R = 0.30
# pylon fairing bridging nacelle crown (2.51) to wing underside (~2.76)
NAC_PYLON = (2.62, 0.46, -1.10, 1.90)     # y_centre, height, z0, z1

EXHAUST_OFF = (0.0, 2.10, 3.40)

# ── ventral weapons bay + fixed MG blister ─────────────────────────────
# (x, y, z, w, h, d) — 5.60 m of belly, the class signature in side view
BAY = (0.0, 1.36, 0.20, 1.54, 0.30, 5.60)
MUZZLE_OFF = (0.0, 1.16, 0.20)            # bomb release, bay centre

MG_FAIRING = ((0.0, 1.40, 3.80), (0.60, 0.42, 0.92))
MG_BARREL = [(4.62, 0.055, 1.22), (4.30, 0.075, 1.24), (4.16, 0.11, 1.26)]
MUZZLE2_OFF = (0.0, 1.22, 4.66)           # ventral MG blister, fixed mount

# ── landing gear: (attach, strut drop, wheel r, wheel half-width) ──────
GEAR_N = ((0.0, 1.56, -5.80), 1.2828, 0.30, 0.10)
GEAR_M = ((NAC_X, 1.45, 1.30), 1.0804, 0.40, 0.14)

# ── greebles ───────────────────────────────────────────────────────────
NAV_TIP = (7.92, 2.98, 0.95)
ANTENNAS = [(0.0, 3.14, -3.60), (0.0, 3.08, 2.60)]
CHAFF = ((0.0, 1.66, 5.20), (0.90, 0.20, 0.60))
PITOT = (0.0, 2.20, -8.55)                # nose boom tip
TAILCONE = ((0.0, 2.46, 8.05), (0.44, 0.36, 0.60))   # aft ECM fairing
