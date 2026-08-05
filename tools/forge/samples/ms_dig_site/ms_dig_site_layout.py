"""ms_dig_site_layout — zones + dims for ms_dig_site (ancient-tech cache).

Archaeological dig site, 12 x 12 m footprint: outer ground ring at Y=0,
excavation pit dug below grade (1.6 m) exposing an ancient monolithic slab
(cyan tracery = the ONLY cyan on the model), timber scaffold frame over
the pit, animated `hoist` (pulley block + cable + skip bucket, idle
raise/lower translation clip), spoil heaps, crates of finds, string-line
survey grid on stakes, and two warm work lights.
World frame: +Y up, ground Y=0. 1024 atlas (dominant dim 12 m < 15 m).
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── dims (world metres) ──────────────────────────────────────────────────
G_HALF   = 6.0          # outer ground ring half-size (12 m footprint)
P_HALF   = 2.2          # pit half-size
P_DEPTH  = 1.6          # pit depth below grade
LEG_B    = 2.75         # scaffold leg foot half-spread
LEG_T    = 2.5          # scaffold leg top half-spread
FRAME_Y  = 3.3          # scaffold top-ring height
BEAM_Y   = 3.42         # cross-beam (hoist rail) height
HOIST_OFF = (0.0, 3.42, 0.0)   # hoist piece pivot: centre of the cross beam
HOIST_DROP = 1.1        # clip half-amplitude (total lower = 2.2 m)
STAKE_H  = 0.32         # survey stake height
STRING_Y = 0.28         # string-line height
STAKE_R  = 3.3          # survey ring half-size
SPOIL_A  = (4.3, 0.0, 2.8, 1.6, 0.95)    # cx, cy, cz, base-half, height
SPOIL_B  = (-4.3, 0.0, -3.3, 1.35, 0.75)
CRATE_A  = (-4.1, 0.325, 1.6, 0.65)      # cx, cy, cz, size
CRATE_B  = (-4.15, 0.20, 2.45, 0.40)
LAMP_A   = (-3.9, 3.9)  # x, z — work light posts (head faces the pit)
LAMP_B   = (3.9, -3.9)
LAMP_H   = 2.3

# ── atlas zones (1024; v down) ───────────────────────────────────────────
R_GROUND  = Zone((0, 0, 512, 512), ('x', 'z'), ((-6.0, 6.0), (-6.0, 6.0)))
R_PITF    = Zone((512, 0, 768, 256), ('x', 'z'), ((-2.2, 2.2), (-2.2, 2.2)))
R_SPOIL1  = Zone((768, 0, 1024, 256), ('x', 'z'), ((2.7, 5.9), (1.2, 4.4)))
R_SPOIL2  = Zone((768, 0, 1024, 256), ('x', 'z'), ((-5.65, -2.95), (-4.65, -1.95)))
R_PITW_X  = Zone((512, 256, 1024, 384), ('x', 'y'), ((-2.2, 2.2), (0.0, -1.6)))
R_PITW_Z  = Zone((512, 256, 1024, 384), ('z', 'y'), ((-2.2, 2.2), (0.0, -1.6)))
R_WOOD    = (0, 512, 256, 640)      # parametric timber wrap (scaffold, stakes)
R_STEEL   = (256, 512, 512, 640)    # parametric steel wrap (cable, posts)
R_STRING  = (512, 512, 640, 576)    # parametric string-line wrap
R_CRATE   = Zone((512, 384, 704, 512), ('x', 'y'), ((-4.5, -3.7), (0.7, -0.1)))
R_HOIST   = Zone((640, 512, 832, 640), ('x', 'y'), ((-0.35, 0.35), (0.1, -1.5)))
R_LAMP    = Zone((704, 384, 832, 512), ('x', 'y'), ((-30, 30), (30, -30)))
R_LAMPBOX = Zone((832, 384, 960, 512), ('x', 'y'), ((-30, 30), (30, -30)))
R_DARK    = Zone((896, 512, 1024, 640), ('x', 'z'), ((-30, 30), (-30, 30)))
