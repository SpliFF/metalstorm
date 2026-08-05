"""ms_technical_layout — zones + dims for ms_technical.

Anarchic technical (archetype signature unit): civilian pickup-truck
silhouette — hood + cab forward, open flatbed rear — up-armoured with
improvised scrap plates, welded gun ring on the bed carrying an aimable
autocannon (turret/barrel/muzzle chain), spinnable axle_f/axle_r, and a
rag pennant on a rear-corner pole (flag piece, idle flutter).
Scrap-and-spikes register: mismatched panel colours, bolted plate edges,
ram bar with welded spikes.  Team colour ONLY in the team mask R channel
(resprayed door panel + pennant).  Rests wheels at Y=0, forward -Z,
1 u = 1 m.  ~4.8 m long (s1 ground vehicle).  Tri budget <= 1500;
textures 1024^2 (dominant dim < 15 m).
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── atlas zones (1024²; v down) ──────────────────────────────────────────
# Body sides are L/R-shared (mirror-safe: no text, symmetric patching).
CAB_SIDE  = Zone((0,   0,   352, 224), ('z', 'y'), ((-2.45, -0.10), (1.80, 0.20)))
BED_SIDE  = Zone((352, 0,   704, 224), ('z', 'y'), ((-0.15, 2.45),  (1.80, 0.20)))
FRONT     = Zone((704, 0,   896, 224), ('x', 'y'), ((0.95, -0.95),  (1.80, 0.20)))
REAR      = Zone((704, 224, 896, 448), ('x', 'y'), ((-0.95, 0.95),  (1.80, 0.20)))
HOOD_TOP  = Zone((0,   224, 192, 400), ('x', 'z'), ((-0.85, 0.85),  (-2.45, -1.15)))
CAB_ROOF  = Zone((192, 224, 384, 400), ('x', 'z'), ((-0.85, 0.85),  (-1.30, -0.15)))
BED_FLOOR = Zone((384, 224, 704, 448), ('z', 'x'), ((-0.15, 2.45),  (-0.90, 0.90)))
# generic cells (small parts sample near cell centre — civkit convention)
WHEEL     = Zone((0,   448, 224, 576), ('z', 'y'), ((-45, 45), (25, -5)))
HUB       = Zone((224, 448, 352, 576), ('x', 'z'), ((-45, 45), (-45, 45)))
SCRAP_A   = Zone((0,   576, 128, 704), ('z', 'y'), ((-45, 45), (25, -5)))  # rust-red plate
SCRAP_B   = Zone((128, 576, 256, 704), ('z', 'y'), ((-45, 45), (25, -5)))  # grey-blue plate
SCRAP_C   = Zone((256, 576, 384, 704), ('z', 'y'), ((-45, 45), (25, -5)))  # bare gunmetal
TRIM      = Zone((384, 576, 512, 704), ('z', 'y'), ((-45, 45), (25, -5)))  # ram bar/spikes/pole
DARK      = Zone((512, 576, 640, 704), ('x', 'z'), ((-45, 45), (-45, 45)))  # chassis/undersides
GUN       = Zone((640, 576, 832, 704), ('z', 'y'), ((-45, 45), (25, -5)))  # turret body
CARGO     = Zone((352, 448, 512, 576), ('z', 'y'), ((-45, 45), (25, -5)))  # crate/stowage
PENNANT   = Zone((512, 448, 640, 576), ('z', 'y'), ((-45, 45), (25, -5)))  # rag flag (team)
GUN_BARR  = (896, 0, 1024, 128)        # parametric barrel wrap (rect)
POLE      = (896, 128, 1024, 192)      # parametric pole/spike wrap (rect)

# ── dims (world metres, ground Y=0, forward -Z) ──────────────────────────
LENGTH    = 4.8                                    # ram bar -2.4 .. rear +2.4
WHEEL_R   = 0.40
WHEEL_HW  = 0.15
WHEEL_X   = 0.80
AXLE_Y    = 0.3696                                 # r*cos(pi/8): flats rest flat
AXLES     = [('axle_f', -1.55), ('axle_r', 1.45)]

CHASSIS   = (0.0, 0.52, 0.0, 1.45, 0.28, 4.30)     # x,y,z, w,h,d
HOOD      = (0.0, 0.97, -1.80, 1.55, 0.60, 1.20)   # engine hood, top 1.27
CAB       = (0.0, 1.24, -0.70, 1.65, 1.02, 1.10)   # cab, roof 1.75
BED_FLR   = (0.0, 0.83, 1.15, 1.80, 0.18, 2.50)    # flatbed deck, top 0.92
BED_WALL_H= 0.42                                   # bed side wall height
BED_WALL  = (0.855, 1.13, 1.15, 0.09, BED_WALL_H, 2.50)  # per side (+-x)
TAILGATE  = (0.0, 1.13, 2.355, 1.62, BED_WALL_H, 0.09)
BUMPER_R  = (0.0, 0.62, 2.32, 1.70, 0.22, 0.16)    # rear bumper
# improvised armour plates (mismatched, standoff)
PLATE_CABL= (-0.87, 1.15, -0.70, 0.07, 0.75, 0.95) # cab side plate (SCRAP_B)
PLATE_CABR= (0.87, 1.05, -0.55, 0.07, 0.62, 0.80)  # cab side plate (SCRAP_A) — offset vs L
PLATE_BEDL= (-0.925, 1.28, 0.55, 0.06, 0.60, 1.05) # bed wall plate (SCRAP_A)
PLATE_BEDL2=(-0.925, 1.22, 1.80, 0.06, 0.48, 0.85) # bed wall plate (SCRAP_C)
PLATE_BEDR= (0.925, 1.32, 0.90, 0.06, 0.68, 1.15)  # bed wall plate (SCRAP_B)
PLATE_BEDR2=(0.925, 1.18, 2.00, 0.06, 0.42, 0.70)  # bed wall plate (SCRAP_A)
PLATE_HOOD= (0.28, 1.30, -1.85, 0.75, 0.05, 0.85)  # scrap sheet lashed on hood (SCRAP_C)
WINDSCR_PL= (0.0, 1.52, -1.28, 1.30, 0.42, 0.06)   # welded visor slit plate (SCRAP_C)
# ram bar + spikes (front)
RAM_BAR_Y = (0.55, 1.05)                           # lower/upper bar heights
RAM_BAR_X = 0.82                                   # half-width of bars
RAM_POST_X= 0.55                                   # posts at +-x
RAM_Z     = -2.32                                  # bar plane
SPIKE_LEN = 0.38                                   # welded spikes, forward
SPIKES    = [(-0.72, 1.05), (-0.24, 1.05), (0.24, 1.05), (0.72, 1.05)]  # x, y
EXHAUST   = (0.92, 0.55, 1.65, 0.55)               # x, y0, y1, z (side stack)
# gun ring + pedestal (turret chain mounts here)
PED_BASE  = (0.0, 0.92, 0.90)                      # pedestal foot on bed deck
TUR_MOUNT = (0.0, 1.42, 0.90)                      # turret piece offset (ring base)
RING_R    = 0.34
BARREL_LEN= 1.55
BARREL_R  = 0.055
# bed dressing
CRATE_POS = (-0.45, 1.10, 1.95)                    # ammo crate in bed corner
CRATE_SZ  = 0.36
# pennant pole (flag piece) — rear-left bed corner
FLAG_BASE = (-0.78, 1.34, 2.28)                    # piece offset (pole foot)
FLAG_H    = 1.15                                   # pole height above base
