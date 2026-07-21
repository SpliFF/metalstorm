"""train_layout — shared zones + dims for the fable land train family.

FOUR independent units on one shared 2048² atlas (stem `fable_train`):
  fable_train_engine — ~21 m + plow; armored prow, slit cab, forward
      railgun turret chain + AA flak chain (turret2), 5 axles.
  fable_train_gun    — weapons platform; twin roof howitzer turrets
      (fore bakes -Z, aft bakes +Z per §22) + MG cupola (turret3).
  fable_train_troop  — passenger car; firing ports, MG cupola (turret)
      + flame cupola (turret2 — visual flame kit, no flame weapon
      family exists yet so it binds MS_MG_S1), troop capacity.
  fable_train_cargo  — equipment car; armored stake bed, lashed cargo,
      MG cupola pulpit.

Coupling contract: every unit ships `link_f`/`link_(r)` empties at the
coupler knuckles (y 1.35, ±L/2+0.7) — game code joins consists the
same way transports/turret attachments bind pieces (§23/§25 pattern).
Wheels are big exposed 8-gon pairs on `axle1..axleN` pieces (spin
script API).  Hulls 4.2 m wide, deck ~3.5, heavily plated.  Rests
wheels at Y=0, forward -Z, 1 u = 1 m.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
E_SIDE  = Zone((0,    0,    1024, 288),  ('z', 'y'), ((-10.8, 10.8), (5.8, -0.1)))
E_FRONT = Zone((1024, 0,    1408, 288),  ('x', 'y'), ((2.3, -2.3), (5.8, -0.1)))
E_TOP   = Zone((1408, 0,    2048, 224),  ('z', 'x'), ((-10.8, 10.8), (-2.3, 2.3)))
C_SIDE  = Zone((0,    288,  1024, 544),  ('z', 'y'), ((-8.6, 8.6), (4.7, -0.1)))
C_END   = Zone((1024, 288,  1408, 544),  ('x', 'y'), ((2.3, -2.3), (4.7, -0.1)))
C_TOP   = Zone((1408, 224,  2048, 448),  ('z', 'x'), ((-8.6, 8.6), (-2.3, 2.3)))
TURZ    = Zone((0,    544,  384,  800),  ('z', 'y'), ((-2.3, 2.3), (2.0, -0.7)))
TUR_TOP = Zone((384,  544,  640,  800),  ('x', 'z'), ((-2.0, 2.0), (-2.3, 2.3)))
BARRELW = (640, 544, 1024, 672)          # parametric main-gun wrap
CUPZ    = Zone((640,  672,  896,  800),  ('z', 'y'), ((-45, 45), (25, -5)))
CUPBW   = (896, 672, 1024, 800)          # parametric small-arms wrap
WHEELZ  = Zone((1024, 544,  1280, 672),  ('z', 'y'), ((-45, 45), (25, -5)))
HUBZ    = Zone((1024, 672,  1280, 800),  ('x', 'z'), ((-45, 45), (-45, 45)))
COUPZ   = Zone((1280, 544,  1536, 672),  ('z', 'y'), ((-45, 45), (25, -5)))
GLOWZ   = Zone((1536, 544,  1664, 672),  ('x', 'y'), ((-45, 45), (25, -5)))
DARKT   = Zone((1664, 544,  1792, 672),  ('x', 'z'), ((-45, 45), (-45, 45)))
TRIMT   = Zone((1792, 544,  1920, 672),  ('z', 'y'), ((-45, 45), (25, -5)))
CRATEZ  = Zone((1024, 800,  1216, 1056), ('z', 'y'), ((-45, 45), (25, -5)))
TARPZ   = Zone((1216, 800,  1408, 1056), ('z', 'y'), ((-45, 45), (25, -5)))

# ── shared chassis ───────────────────────────────────────────────────────
HULL_W    = 4.2
HULL_BOT  = 1.0
WHEEL_R   = 1.05
WHEEL_HW  = 0.40
WHEEL_X   = 2.15
LINK_Y    = 1.35
FENDER_Y  = 2.35

ENG_HL    = 10.5                          # engine half-length (hull)
ENG_TOP   = 4.4                           # hull deck
ENG_CAB   = (0.0, 4.95, -4.6, 3.6, 1.6, 2.8)   # raised cab
ENG_AXLES = [-7.4, -4.8, -1.0, 3.2, 7.4]
ENG_TURRET = (0.0, 3.75, -7.3)            # forward railgun chain
ENG_BARREL = (0.0, 0.62, -1.35)
ENG_MUZZLE = (0.0, 0.0, -3.6)
ENG_FLAK   = (0.0, 4.55, 0.6)             # AA chain (turret2)
ENG_FLAK_B = (0.0, 0.5, -0.7)
ENG_FLAK_M = (0.0, 0.0, -1.7)
ENG_STACKS = [2.6, 4.0]
PLOW_TIP   = -12.2

CAR_HL    = 8.0                           # carriage half-length (hull)
CAR_AXLES = [-5.8, -2.0, 2.0, 5.8]
GUN_TOP   = 3.4
GUN_TURRETS = [(-3.7, -1), (3.7, 1)]      # z, facing sign (bake dir)
GUN_BARREL  = (0.0, 0.72, -1.55)          # local (aft car flips z)
GUN_MUZZLE  = (0.0, 0.0, -2.9)
GUN_CUPOLA  = (0.0, 3.9, 0.0)             # turret3 MG cupola
TROOP_TOP = 4.35
TROOP_CUPS = [(-4.0, 'mg'), (4.0, 'flame')]
PORT_Y    = 2.65                          # painted firing-port row
CARGO_BED = 2.0
CARGO_WALL = 3.25
CUP_BAR   = (0.0, 0.28, -0.55)
CUP_MUZ   = (0.0, 0.0, -0.75)
