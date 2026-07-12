"""airship_layout — zones + dims for fable_airship (FT-2 Pelican).

Large rigid dirigible transport: 65 m envelope, twin ventral cargo bays
sized for s2 MBTs (8.5 m) with ZK-style transport attachment pieces —
`link1`/`link2` empties under the bays (Hercules pattern: the unit
script's QueryTransport returns a link piece, AttachUnit snaps the
passenger to it and lowers it by unit height). Four nacelle props spin
in the idle clip. Rests on gondola skids + cradle frames at Y≈0.15.
forward -Z, 2048² atlas.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
A_SIDE     = Zone((0,    0,    2048, 320),  ('z', 'y'), ((-33.5, 33.5), (16.8, 1.2)))
A_TOP      = Zone((0,    320,  2048, 576),  ('z', 'x'), ((-33.5, 33.5), (-7.6, 7.6)))
A_BELLY    = Zone((0,    576,  2048, 832),  ('z', 'x'), ((-33.5, 33.5), (-7.6, 7.6)))
A_FIN      = Zone((0,    832,  512,  1088), ('z', 'y'), ((25.0, 34.0), (17.5, 2.0)))
A_FIN_H    = Zone((512,  832,  1024, 1088), ('z', 'x'), ((25.0, 34.0), (-8.5, 8.5)))
A_GONDOLA  = Zone((1024, 832,  1664, 1088), ('z', 'y'), ((-25.0, -12.0), (4.5, 0.0)))
A_GONDOLA_F= Zone((1024, 832,  1664, 1088), ('x', 'y'), ((3.3, -3.3), (4.5, 0.0)))
A_NACELLE  = (1664, 832, 2048, 960)      # parametric pod wrap
A_PROP     = Zone((1664, 960,  1920, 1216), ('x', 'y'), ((-1.7, 1.7), (1.7, -1.7)))
A_CRADLE   = Zone((0,    1088, 512,  1280), ('z', 'y'), ((-13.0, 14.0), (2.8, -3.4)))
A_WINCH    = Zone((512,  1088, 768,  1280), ('x', 'y'), ((-45, 45), (25, -5)))
A_TRIM     = Zone((768,  1088, 1024, 1280), ('z', 'y'), ((-45, 45), (25, -5)))
A_NAVP     = Zone((0,    1280, 128,  1408), ('z', 'y'), ((-45, 45), (25, -5)))
A_NAVS     = Zone((128,  1280, 256,  1408), ('z', 'y'), ((-45, 45), (25, -5)))
A_LIGHT    = Zone((256,  1280, 384,  1408), ('x', 'z'), ((-45, 45), (-25, 25)))
A_DARK     = Zone((384,  1280, 512,  1408), ('x', 'z'), ((-45, 45), (-45, 45)))
A_MOOR     = (512, 1280, 768, 1408)      # nose mooring cone wrap

# ── dims (world metres; rests at Y≈0.15, bow -Z) ─────────────────────────
# envelope sections: (z, cy, r)
ENV_SECTIONS = [
    (-32.0, 9.2, 0.9),
    (-28.0, 9.2, 3.5),
    (-22.0, 9.2, 5.8),
    (-14.0, 9.2, 6.9),
    (-4.0,  9.2, 7.3),
    (6.0,   9.2, 7.2),
    (14.0,  9.2, 6.6),
    (22.0,  9.2, 5.2),
    (28.0,  9.2, 3.4),
    (32.5,  9.2, 1.1),
]
ENV_N      = 12                       # ring facets
GONDOLA    = (0.0, 2.15, -18.5, 5.6, 3.3, 11.0)   # x,y,z,w,h,d
SKIDS      = [(-2.2, -21.5), (2.2, -21.5), (-2.2, -15.5), (2.2, -15.5)]
BAYS       = [-6.0, 8.0]              # cargo bay centres (z)
BAY_LEN    = 9.6                       # fits an 8.5 m s2 MBT
KEEL_Y     = 1.95                      # envelope belly line at the bays
LINKS      = [(0.0, 1.05, -6.0), (0.0, 1.05, 8.0)]   # link1/link2 empties
NACELLES   = [(8.4, 8.6, -10.0), (-8.4, 8.6, -10.0),
              (8.0, 8.6, 12.0), (-8.0, 8.6, 12.0)]
POD_R, POD_LEN = 0.78, 3.8
PROP_R     = 1.55
# tapered cruciform fins, roots buried in the envelope (r≈3.1 at FIN_Z,
# faceted half-width ≈3.0) — root anchor well inside the surface
FIN_Z      = 28.5                     # root chord centre (z)
FIN_SWEEP  = 1.0                      # tip chord centre aft-shift
CHORD_ROOT, CHORD_TIP = 7.0, 3.8
FIN_TH     = (0.45, 0.22)             # thickness root → tip
FIN_H_ROOT, FIN_H_TIP = 2.2, 7.8      # |x| span, horizontal pair
FIN_VT_ROOT, FIN_VT_TIP = 11.4, 16.4  # y span, dorsal fin
FIN_VB_ROOT, FIN_VB_TIP = 6.9, 3.3    # y span, ventral fin
MOOR_TIP   = (0.0, 9.2, -33.6)        # nose mooring spike
EXHAUST_OFF = (0.0, 8.6, 13.8)        # FX empty at an aft nacelle line
