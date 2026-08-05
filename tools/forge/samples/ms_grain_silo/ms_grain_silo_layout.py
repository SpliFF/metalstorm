"""ms_grain_silo_layout — zones + dims for ms_grain_silo (grain silo cluster).

Named resource site: three corrugated grain silos (tallest 15 m, per the
spec — also the model's max height: the elevator head house tops out at
exactly 15.0 m), bucket-elevator leg with head house, overhead conveyor
gallery across the two shorter silo roofs with a truck load-out spout and
an exposed head-pulley roller (piece `belt`, idle spin), weigh shed +
weighbridge on a concrete pad. Civilian-tan / concrete palette register
(STYLE.md atlas row 3). 2048² atlas (dominant dim >= 15 m).
World frame: front = -Z, up = +Y, ground Y = 0. All geometry lives on
`body` except the `belt` roller (idle clip) and the `loadout` FX empty.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
# left block
Z_SILO     = (0, 0, 1280, 560)        # parametric silo wall wrap (shared ×3)
Z_PAD      = Zone((0,    560,  1024, 1200), ('x', 'z'), ((-13.5, 13.5), (-8.25, 8.25)))
Z_LEG      = Zone((1024, 560,  1280, 1104), ('z', 'y'), ((1.95, 3.25), (13.75, 0.3)))
Z_LEG_F    = Zone((1024, 560,  1280, 1104), ('x', 'y'), ((-5.35, -3.85), (13.75, 0.3)))
Z_SPOUT    = (1024, 1104, 1280, 1200)  # parametric spout/pipe wrap
Z_PADS     = Zone((0,    1200, 1024, 1264), ('z', 'y'), ((-13.5, 13.5), (0.45, -0.1)))
Z_PADS_F   = Zone((0,    1200, 1024, 1264), ('x', 'y'), ((-13.5, 13.5), (0.45, -0.1)))
Z_GAL_SIDE = Zone((0,    1264, 1280, 1392), ('x', 'y'), ((-3.8, 10.1), (14.15, 12.95)))
Z_GAL_TOP  = Zone((0,    1392, 1280, 1504), ('x', 'z'), ((-3.8, 10.1), (1.95, 3.25)))
Z_BRIDGE   = Zone((0,    1504, 256,  2032), ('x', 'z'), ((-6.2, -2.8), (-8.3, -0.3)))
Z_GRATE    = Zone((256,  1504, 512,  1728), ('x', 'z'), ((-5.9, -3.3), (-0.5, 1.9)))
Z_TRIM     = (512, 1504, 768, 1632)   # parametric trim wrap (rails/posts)
Z_TRIMZ    = Zone((512,  1504, 768,  1632), ('x', 'y'), ((-14.0, 14.0), (15.5, -0.5)))
Z_DARK     = Zone((512,  1632, 640,  1728), ('x', 'z'), ((-1.0, 1.0), (-1.0, 1.0)))
# right block
Z_CONE     = (1280, 0, 1792, 256)     # parametric silo roof-cone wrap
Z_EAVE     = (1792, 0, 2048, 64)      # parametric eave band wrap
Z_HATCH    = (1792, 64, 1920, 128)    # parametric roof-hatch drum wrap
Z_HATCH_TOP= (1920, 64, 2048, 192)    # hatch lid cap rect (Zone built per silo)
Z_HEAD     = Zone((1280, 256,  1600, 456),  ('z', 'y'), ((1.55, 3.65), (15.1, 13.4)))
Z_HEAD_F   = Zone((1280, 256,  1600, 456),  ('x', 'y'), ((-5.7, -3.5), (15.1, 13.4)))
Z_HEAD_ROOF= Zone((1600, 256,  1792, 456),  ('x', 'z'), ((-5.7, -3.5), (1.55, 3.65)))
Z_GAL_END  = Zone((1280, 456,  1408, 584),  ('z', 'y'), ((1.9, 3.3), (14.15, 12.95)))
Z_ROLLER   = (1408, 456, 1664, 584)   # parametric belt-roller drum wrap
Z_ROLLER_CAP = (1664, 456, 1792, 584) # roller cap rect (Zone built piece-local)
Z_SHED_SIDE  = Zone((1280, 584, 1792, 832),  ('z', 'y'), ((-6.95, -3.05), (3.6, 0.25)))
Z_SHED_FRONT = Zone((1280, 832, 1792, 1080), ('x', 'y'), ((-11.35, -6.45), (3.6, 0.25)))
Z_SHED_ROOF  = Zone((1792, 584, 2048, 832),  ('x', 'z'), ((-11.6, -6.2), (-7.1, -2.9)))

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
PAD        = (0.0, 0.175, 0.0, 27.0, 0.35, 16.5)  # x,y,z,w,h,d plinth
PAD_TOP    = 0.35

SILO_N     = 10                                   # drum facets
# (x, z, r, eave_y, apex_y) — silo A is the spec's 15 m tallest
SILOS      = [(-8.6, 2.6, 2.9, 13.4, 15.0),
              (-0.4, 2.6, 2.6, 11.5, 12.9),
              (5.4,  2.6, 2.6, 11.5, 12.9)]
HATCH_R    = 0.28                                 # roof hatch drum radius
HATCH_OFF  = 0.9                                  # hatch offset from apex axis

# bucket-elevator leg between silo A and silo B
LEG_X, LEG_Z = -4.6, 2.6
LEG_TRUNK  = (LEG_X, (PAD_TOP + 13.6) / 2, LEG_Z, 1.0, 13.6 - PAD_TOP, 1.0)
LEG_BOOT   = (LEG_X, 1.15, LEG_Z, 1.8, 1.6, 1.5)
HEAD       = (LEG_X, 14.25, LEG_Z, 2.0, 1.5, 1.9)  # top = 15.0 m exactly

# overhead gallery (belt conveyor housing), axis +X off the head house
GALLERY    = (2.65, 13.55, LEG_Z, 12.5, 0.9, 1.1)  # x,y,z,w,h,d
GAL_X1     = 8.9                                   # closed housing east end
GAL_FLOOR_Y = 13.12                                # open head-end deck
GAL_OPEN_X1 = 9.9
GAL_RAIL_TOP = 13.55
# gallery railing (on the housing roof)
RAIL_POST_XS = (-3.0, 0.0, 3.0, 6.0, 8.5)
RAIL_Y0, RAIL_Y1 = 14.0, 14.7

# spouts (grain always flows downhill)
SPOUT_A    = ((-5.5, 14.5, LEG_Z), (-7.15, 14.1, LEG_Z))   # head -> silo A cone
SPOUT_B    = ((-1.1, 13.15, LEG_Z), (-1.1, 12.55, LEG_Z))  # gallery -> silo B
SPOUT_C    = ((4.7, 13.15, LEG_Z), (4.7, 12.55, LEG_Z))    # gallery -> silo C
GAL_POSTS  = (0.4, 6.1)          # roof posts onto silo B/C cones
GAL_COLUMN = 8.6                 # ground column under the gallery head end

# head pulley roller — the `belt` piece (idle spin about local Z)
BELT_OFF   = (10.05, 13.35, LEG_Z)
ROLLER_R   = 0.34
ROLLER_HL  = 0.45                # half-length along Z
# truck load-out spout + telescoping sleeve, off the open deck
LOADOUT_X  = 9.35
LOADOUT_OFF = (LOADOUT_X, 5.2, LEG_Z)   # FX/dressing empty at the tip

# weigh shed + weighbridge (front apron), truck lane along Z at x=-4.5
SHED       = (-8.9, 1.85, -5.0, 4.6, 3.0, 3.4)
SHED_ROOF  = (-8.9, 3.5, -5.0, 5.1, 0.3, 3.9)
BRIDGE     = (-4.5, PAD_TOP + 0.09, -4.3, 3.4, 0.18, 7.8)
BOLLARDS   = ((-6.4, -8.0), (-2.6, -8.0), (-6.4, -0.6), (-2.6, -0.6))
PIT        = (-4.6, PAD_TOP + 0.1, 0.7, 2.6, 0.2, 2.2)  # receiving grate
