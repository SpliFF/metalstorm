"""ms_command_post_layout — zones + dims for ms_command_post (Prefab command post).

Staging-post kit: prefab command building on a 12x8 m footprint pad
(dominant dim 12 m < 15 m -> 1024^2 atlas), sandbag skirt with a door
gap, rooftop command module carrying the antenna cluster, flag on a
ground-mounted pole (`flag` is the only animated piece — idle wave
clip), lit doorway + window band (emissive). Building doctrine:
texture-led, everything on `body` except the flag cloth.
World frame: door faces -Z, up +Y, ground Y=0. 1024^2 atlas.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
PAD      = (0.0, 0.1, 0.0, 12.0, 0.2, 8.0)     # x,y,z, w,h,d
PAD_TOP  = 0.2
# main prefab hall (door on -Z face)
HALL     = (0.8, PAD_TOP + 1.5, 0.2, 8.8, 3.0, 5.6)
HALL_TOP = PAD_TOP + 3.0                        # 3.2
# rooftop command module (carries the antenna cluster)
UP       = (2.7, HALL_TOP + 0.8, 0.9, 4.2, 1.6, 3.4)
UP_TOP   = HALL_TOP + 1.6                       # 4.8
# doorway (painted on the front wall; canopy geometry above it)
DOOR_X   = -1.6
DOOR_W   = 1.3
DOOR_H   = 2.2
DOOR_Z   = HALL[2] - HALL[5] / 2                # front wall plane (-2.6)
CANOPY   = (DOOR_X, 2.62, DOOR_Z - 0.38, 1.9, 0.12, 0.75)
# sandbag skirt: ring segments (cx, cz, w, d) at SAND_H tall, door gap
# in the front run between GAP_X0..GAP_X1
SAND_H   = 0.75
SAND_T   = 0.7                                  # bag wall thickness
GAP_X0, GAP_X1 = -2.7, -0.5
SAND_SEGS = [
    (-3.7, -3.4, 2.0, SAND_T),                  # front-left
    (2.75, -3.4, 6.5, SAND_T),                  # front-right
    (-4.3, 0.15, SAND_T, 6.4),                  # left run
    (5.65, 0.15, SAND_T, 6.4),                  # right run
    (0.675, 3.7, 10.65, SAND_T),                # rear run
]
SAND_POSTS = [(-2.55, -3.5), (-0.65, -3.5)]     # door-gap shoulder posts
POST_SZ  = (0.9, 0.85, 1.2)
# flag pole (front-left of the pad, outside the sandbag ring)
FLAG_X, FLAG_Z = -5.2, -3.0
POLE_TOP = 6.4
FLAG_OFF = (FLAG_X, POLE_TOP - 0.25, FLAG_Z)    # `flag` piece origin
FLAG_W, FLAG_H = 1.75, 1.1                      # cloth fly x drop
# antenna cluster (on the command-module roof)
MAST_X, MAST_Z = 3.6, 2.0
MAST_TOP = 7.6
WHIP1 = (1.4, 0.2, 6.7)                         # x, z, tip height
WHIP2 = (2.3, 2.3, 6.1)
PANEL_C = (MAST_X, 6.7, MAST_Z)                 # tilted array on the mast
# props
GEN   = (-5.2, PAD_TOP + 0.5, 2.8, 1.6, 1.0, 1.1)   # genset (rear-left)
CABI  = (4.4, HALL_TOP + 0.45, -1.6, 0.9, 0.9, 0.7) # comms cabinet, hall roof
ACV   = (-1.4, HALL_TOP + 0.32, 1.8, 1.4, 0.64, 1.0) # AC/vent unit, hall roof
BEACON = (MAST_X, MAST_TOP + 0.07, MAST_Z)      # mast-tip light, 0.14 cube

# ── atlas zones (1024^2; v down) ─────────────────────────────────────────
C_PAD    = Zone((0,   0,   640, 448),  ('x', 'z'), ((-6.2, 6.2), (-4.2, 4.2)))
C_ROOF   = Zone((640, 0,   1024, 256), ('x', 'z'), ((-3.9, 5.5), (-2.9, 3.3)))
C_WALL_S = Zone((640, 256, 1024, 480), ('z', 'y'), ((-3.3, 3.7), (3.45, 0.05)))
C_WALL_F = Zone((0,   448, 640, 672),  ('x', 'y'), ((5.4, -3.8), (3.45, 0.05)))
C_WALL_R = Zone((0,   672, 640, 896),  ('x', 'y'), ((-3.8, 5.4), (3.45, 0.05)))
C_UP_S   = Zone((640, 480, 1024, 608), ('z', 'y'), ((-1.2, 3.0), (5.05, 2.95)))
C_UP_F   = Zone((640, 608, 1024, 736), ('x', 'y'), ((0.2, 5.2), (5.05, 2.95)))
C_UP_R   = Zone((640, 736, 832, 864),  ('x', 'z'), ((0.3, 5.1), (-1.1, 2.9)))
C_PADS   = Zone((0,   896, 640, 948),  ('x', 'y'), ((-6.2, 6.2), (0.3, -0.06)))
C_PADS_Z = Zone((0,   896, 640, 948),  ('z', 'y'), ((-6.2, 6.2), (0.3, -0.06)))
C_SAND   = Zone((0,   952, 512, 1024), ('x', 'y'), ((-6.3, 6.3), (1.08, -0.06)))
C_SAND_Z = Zone((0,   952, 512, 1024), ('z', 'y'), ((-6.3, 6.3), (1.08, -0.06)))
C_SAND_T = Zone((512, 952, 896, 1024), ('x', 'z'), ((-6.3, 6.3), (-4.3, 4.3)))
C_FLAG   = Zone((640, 864, 832, 1024), ('x', 'y'), ((-0.05, 1.85), (0.0, -1.25)))
C_CANOPY = Zone((832, 736, 1024, 772), ('x', 'z'), ((-2.7, -0.5), (-3.5, -2.4)))
C_MAST   = (832, 772, 1024, 800)      # parametric mast/pole/whip wrap
C_PROP   = (832, 800, 1024, 896)      # generic equipment box (zbox-anchored)
C_PANEL  = (832, 896, 896, 952)       # antenna array plate
C_ACV    = (896, 896, 1024, 952)      # AC/vent unit (zbox-anchored)
C_LIGHT  = (832, 952, 896, 1024)      # beacon (zbox-anchored)
C_DARK   = Zone((896, 952, 1024, 1024), ('x', 'z'), ((-30, 30), (-30, 30)))
