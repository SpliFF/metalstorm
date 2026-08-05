"""ms_monolith_spire_layout — zones + dims for ms_monolith_spire.

Ancient-tech landmark: 20 m alien-industrial antenna spire. Tapering
segmented monolith (five slab segments + 4-gon spike tip), floating
offset ring collar (`ring` piece, very slow idle rotation about Y),
emissive CYAN tracery, scorched base apron. Seamless — nothing bolted,
nothing patched. Dominant dim 20 m -> ATLAS 2048. No team colour.
World frame: RH, -Z forward, +Y up, ground Y=0.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
# scorched apron top + side
R_APRON   = Zone((0,    0,    768,  768),  ('x', 'z'), ((-4.5, 4.5), (-4.5, 4.5)))
R_APRON_S = Zone((0,    768,  768,  832),  ('x', 'y'), ((-4.5, 4.5), (0.55, -0.05)))
R_APRON_SZ= Zone((0,    768,  768,  832),  ('z', 'y'), ((-4.5, 4.5), (0.55, -0.05)))
# monolith flanks: one tall zone per axis pair, full 0..20 m height window
R_SEG_X   = Zone((768,  0,    1152, 2048), ('z', 'y'), ((-1.7, 1.7), (20.0, 0.0)))
R_SEG_Z   = Zone((1152, 0,    1536, 2048), ('x', 'y'), ((-1.7, 1.7), (20.0, 0.0)))
# segment top shoulders (annular shelves where the taper steps in)
R_SHELF   = Zone((0,    832,  512,  1344), ('x', 'z'), ((-1.7, 1.7), (-1.7, 1.7)))
# ring collar: parametric wraps for limb-built octagon + studs
R_RING    = (1536, 0,   2048, 256)    # ring bar wrap
R_STUD    = (1536, 256, 2048, 384)    # stud/emitter wrap (rect)
R_STUD_Z  = Zone(R_STUD, ('x', 'y'), ((-3.0, 3.0), (0.25, -0.25)))  # stud faces (ring-local)
R_TIP     = (1536, 384, 2048, 512)    # spike-tip wrap
R_DARK    = Zone((1536, 512, 2048, 768), ('x', 'z'), ((-1, 1), (-1, 1)))

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
APRON     = (0.0, 0.25, 0.0, 8.4, 0.50, 8.4)     # scorched base apron
APRON_TOP = 0.50
# segments: (cx, cz, y0, y1, width) — slight alternating offsets: wrong-angle
SEGS = [
    ( 0.00,  0.00, APRON_TOP, 5.0, 2.90),
    ( 0.12, -0.08, 5.0,       9.0, 2.30),
    (-0.10,  0.10, 9.0,      12.5, 1.80),
    ( 0.08, -0.06, 12.5,     15.5, 1.38),
    (-0.06,  0.06, 15.5,     18.0, 1.00),
]
TIP_BASE  = 18.0
TIP_TOP   = 20.0
TIP_R     = 0.60
# floating ring collar
RING_Y    = 12.5          # piece pivot height on the spire axis
RING_R    = 2.35          # octagon radius
RING_BAR  = 0.16          # bar radius
RING_OFF  = (0.45, 0.0, 0.25)   # geometry offset inside the piece (off-axis float)
RING_PIVOT = (0.0, RING_Y, 0.0) # piece offset: pivot on the spire axis
