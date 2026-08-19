"""ms_bombers_s1_layout — zones + dims for ms_bombers_s1 (UB-12 "Shrike-B").

s1 strike DRONE per DESIGN-GUIDE bombers row (8.0 m wingspan, ~7.0 m
nose-to-ruddervator — deliberately SHORTER than its span so it reads
squat and wide, the opposite of a fighter).  Signature is the V-TAIL:
two ruddervators in a shallow ~40 deg V on short aft booms, no vertical
fin and no horizontal tailplane — nothing else in the Metalstorm air
line has one.  NO cockpit: a shallow faceted hexagonal sensor blister
pair (chin + dorsal) sits where a canopy would be, plus a short comms
blade.  Wide flattened flat-bottomed fuselage (chine half-width 0.82),
straight-taper mid-mounted wing at ~20 deg LE sweep with squared tips,
a bulged closed belly weapons bay (the class tell, `muzzle` release
empty at its centre), one flush dorsal spine intake feeding ONE
shielded nozzle riding over/between the tail booms, short wide-track
fixed gear as separate hideable pieces.

Rests on its wheels at Y=0.  forward -Z, 1024 atlas.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas zones (1024²; v down) ──────────────────────────────────────────
# World-anchored body bands shared by fuselage, wings, booms, ruddervators
# AND the belly bay, so seams / codes / camo stay continuous across every
# joint for free.  The V-tail is more horizontal than vertical at 40 deg
# dihedral, so its surfaces project cleanly through F_TOP / F_BOT — and it
# occupies a z-range (1.75..3.45) the wing never reaches, so no overlap.
F_SIDE = Zone((0, 0,   1024, 144), ('z', 'y'), ((-3.75, 3.55), (1.75, 0.30)))
F_TOP  = Zone((0, 144, 1024, 704), ('z', 'x'), ((-3.75, 3.55), (-4.15, 4.15)))
F_BOT  = Zone((0, 704, 1024, 928), ('z', 'x'), ((-3.75, 3.55), (-4.15, 4.15)))

# small cells (flat huge-window projections → near-uniform swatches)
F_NOZZLE = (0, 928, 224, 1008)                     # parametric nozzle wrap
F_BURNER = Zone((224, 928, 320, 1024), ('x', 'y'), ((-45, 45), (25, -5)))
F_GEAR   = Zone((320, 928, 448, 1024), ('z', 'y'), ((-45, 45), (25, -5)))
F_TRIM   = Zone((448, 928, 608, 1024), ('z', 'y'), ((-45, 45), (25, -5)))
F_DARK   = Zone((608, 928, 704, 1024), ('x', 'z'), ((-45, 45), (-45, 45)))
F_BLIST  = Zone((704, 928, 864, 1024), ('z', 'y'), ((-3.30, -1.85),
                                                    (1.55, 0.62)))
F_BAY    = Zone((864, 928, 1024, 1024), ('z', 'x'), ((-1.00, 1.70),
                                                     (-0.62, 0.62)))

# ── dims (world metres; wheels at Y=0, nose -Z) ──────────────────────────
# fuselage loft sections: (z, w_chine, half_w_top, y_top, y_bot, y_chine)
# WIDE and FLAT — chine half-width to 0.82 on a 7 m frame (the §26 bomber
# ratio scaled down from fable_bomber's 1.8 on 11 m).
FUS_SECTIONS = [
    (-3.60, 0.10, 0.05, 1.06, 0.98, 1.02),
    (-3.00, 0.38, 0.21, 1.22, 0.90, 1.03),
    (-2.20, 0.64, 0.38, 1.34, 0.84, 1.04),
    (-1.10, 0.80, 0.50, 1.40, 0.80, 1.03),
    (0.30,  0.82, 0.52, 1.40, 0.80, 1.02),
    (1.50,  0.70, 0.44, 1.34, 0.84, 1.02),
    (2.20,  0.50, 0.32, 1.27, 0.90, 1.03),
    (2.75,  0.30, 0.18, 1.20, 0.96, 1.04),
]

# straight-taper mid-mounted wing, ~20 deg LE sweep, SQUARED tips:
# (span_x, y, z_le, z_te, thickness).  Root x 0.50 is buried well inside
# the chine (0.80..0.82) per the bury rule; extra spanwise stations keep
# each quad small so the impostor baker cannot flood a half-wing.
WING = [
    (0.50, 1.10, -1.30, 1.55, 0.28),
    (1.40, 1.11, -0.97, 1.48, 0.22),
    (2.30, 1.12, -0.64, 1.41, 0.17),
    (3.15, 1.13, -0.33, 1.35, 0.12),
    (4.00, 1.14, -0.02, 1.30, 0.08),
]

# short aft tail booms (right side): (z, x_in, x_out, y_bot, y_top).
# Front end z 1.05 is buried INSIDE the wing skin (wing at x 0.60..1.00
# spans y 0.97..1.24 there); inner wall x 0.60 is inside the chine at the
# forward stations too.
BOOM_SECTIONS = [
    (1.05, 0.60, 1.00, 1.00, 1.42),
    (2.00, 0.60, 0.98, 1.02, 1.44),
    (2.90, 0.62, 0.92, 1.06, 1.40),
    (3.45, 0.66, 0.86, 1.10, 1.32),
]

# ── THE SIGNATURE ── V-tail ruddervator, ~40 deg dihedral, thickness axis
# 'y' (the fighters-s1 anhedral-tip precedent).  Root (x 0.78, y 1.20) is
# buried inside the boom box (x 0.60..0.98, y 1.02..1.44).
VTAIL = [
    (0.78, 1.20, 1.75, 3.40, 0.18),
    (1.26, 1.61, 1.95, 3.37, 0.13),
    (1.75, 2.02, 2.15, 3.34, 0.09),
    (2.23, 2.42, 2.35, 3.30, 0.06),
]

# single flush DORSAL intake scoop on the spine: (z, half_w, y_bot, y_top)
INTAKE_SECTIONS = [
    (-0.90, 0.14, 1.30, 1.36),
    (-0.20, 0.30, 1.32, 1.58),
    (0.70,  0.30, 1.30, 1.56),
    (1.30,  0.20, 1.24, 1.42),
]

# faceted hexagonal sensor blisters — this drone has NO canopy.
# dorsal pair member: (z, half_w, y_bot, y_top)
BLISTER_D = [
    (-3.18, 0.06, 1.10, 1.16),
    (-2.90, 0.18, 1.12, 1.36),
    (-2.40, 0.22, 1.16, 1.46),
    (-1.95, 0.12, 1.20, 1.34),
]
# chin (EO) member — hangs under the nose
BLISTER_C = [
    (-3.15, 0.06, 0.86, 0.94),
    (-2.88, 0.18, 0.72, 0.94),
    (-2.40, 0.22, 0.68, 0.92),
    (-2.08, 0.10, 0.76, 0.90),
]

# comms blade antenna: base z0/z1, y_base, y_tip, sweep
BLADE = (-1.72, -1.42, 1.36, 1.76, 0.12)

# bulged belly weapons bay (closed box, painted doors + red ARM outline).
# (cx, cy, cz, w, h, d) — reads in the side silhouette; a bomber carries
# its load.  `muzzle` release empty sits at its centre.
BAY = (0.0, 0.62, 0.35, 1.00, 0.46, 2.40)
MUZZLE_OFF = (0.0, 0.42, 0.35)

# ONE shielded nozzle riding over / between the tail booms
NOZZLE_Y = 1.34
NOZZLE = [(3.05, 0.24, NOZZLE_Y), (2.70, 0.31, NOZZLE_Y),
          (2.15, 0.28, NOZZLE_Y)]
EXHAUST_OFF = (0.0, NOZZLE_Y, 3.20)

# short WIDE-TRACK fixed gear: (attach x, y, z), strut drop, wheel r, half-w
GEAR_N = ((0.0, 0.84, -1.85), 0.68, 0.16, 0.05)
GEAR_M = ((1.05, 0.98, 0.95), 0.82, 0.17, 0.06)          # mirrored for left

# amber formation-light strip on each ruddervator outboard panel
# (world z0, z1, x0, x1) — read in F_TOP
TAIL_LIGHT = (2.40, 3.20, 1.80, 2.16)
SERIAL = 'UB-12'
