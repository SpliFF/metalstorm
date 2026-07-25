"""nexus_layout — zones + dims for ms_command_nexus (Command Nexus).

The team command centre: 12×12 footprint → 23×23 m fortified pad, a
two-tier keep rising to an octagonal comms tower with a lit war-room
band, rotating dish, corner bastions and a gated front ramp. Tallest
military building (mast tip 23.2 m > factory stacks 17.8) — it is THE
landmark the starting camera frames, so the roofscape (what the RTS
camera actually sees) gets the atlas density.
World frame: gate faces -Z, up +Y, ground Y=0. All static geometry on
`body`; only `dish` animates (idle clip, factory-dish precedent).
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
# Column A — pad + tier1 + gate
N_PAD     = Zone((0,    0,    1024, 900),  ('x', 'z'), ((-11.5, 11.5), (-11.5, 11.5)))
N_PADS    = Zone((0,    900,  1024, 960),  ('z', 'y'), ((-11.5, 11.5), (1.35, -0.05)))
N_PADS_F  = Zone((0,    900,  1024, 960),  ('x', 'y'), ((-11.5, 11.5), (1.35, -0.05)))
N_T1_SIDE = Zone((0,    960,  1024, 1340), ('z', 'y'), ((-7.4, 7.4), (7.5, 1.1)))
N_T1_FR   = Zone((0,    1340, 1024, 1720), ('x', 'y'), ((7.4, -7.4), (7.5, 1.1)))
N_GATE    = Zone((0,    1720, 512,  2048), ('x', 'y'), ((3.3, -3.3), (5.9, 1.2)))
N_RAMP    = Zone((512,  1720, 1024, 2048), ('x', 'z'), ((-4.2, 4.2), (-15.9, -11.3)))

# Column B — tier2 + tower + roofs + bastions + details
N_T2_SIDE = Zone((1024, 0,    1792, 320),  ('z', 'y'), ((-5.2, 5.2), (12.7, 7.2)))
N_T2_FR   = Zone((1024, 320,  1792, 640),  ('x', 'y'), ((5.2, -5.2), (12.7, 7.2)))
N_TOWER   = (1024, 768,  2048, 1200)   # parametric octagon wrap
N_BAND    = (1024, 1200, 2048, 1400)   # war-room glass band wrap (emissive)
N_T1_ROOF = Zone((1024, 1400, 1536, 1720), ('x', 'z'), ((-7.4, 7.4), (-7.4, 7.4)))
N_T2_ROOF = Zone((1536, 1400, 2048, 1720), ('x', 'z'), ((-5.2, 5.2), (-5.2, 5.2)))
N_CROWN   = Zone((1024, 1720, 1280, 1976), ('x', 'z'), ((-3.8, 3.8), (-3.8, 3.8)))
N_BASTION = Zone((1280, 1720, 1792, 1976), ('z', 'y'), ((-1.7, 1.7), (4.9, 1.2)))
N_BASTION_F = Zone((1280, 1720, 1792, 1976), ('x', 'y'), ((-1.7, 1.7), (4.9, 1.2)))
N_BASTION_TOP = Zone((1792, 1720, 2048, 1976), ('x', 'z'), ((-1.7, 1.7), (-1.7, 1.7)))
N_VENT    = Zone((1280, 1976, 1792, 2048), ('x', 'y'), ((-0.9, 0.9), (0.55, -0.55)))

# Details strip
N_DISH    = Zone((1792, 0,    2048, 256),  ('x', 'z'), ((-1.0, 1.0), (-1.0, 1.0)))
N_MAST    = (1792, 256,  2048, 384)    # parametric mast/limb wrap
N_TRIM    = (1792, 384,  2048, 512)    # parametric trim/bracket wrap
N_DARK    = Zone((1792, 512,  2048, 640),  ('x', 'z'), ((-1, 1), (-1, 1)))
N_PIPE    = (1792, 640,  2048, 768)    # parametric pipe wrap
N_CROWN_W = (1024, 1976, 1280, 2048)   # crown parapet wrap (team band)
N_TRIM_Z  = Zone((1792, 384, 2048, 512), ('x', 'y'), ((-3.4, 3.4), (6.2, 1.0)))
N_BEACON  = Zone((1536, 1976, 1664, 2048), ('x', 'y'), ((-0.16, 0.16), (0.17, -0.17)))

# ── dims (world metres, ground Y=0) ──────────────────────────────────────
PAD       = (0.0, 0.65, 0.0, 23.0, 1.3, 23.0)   # x,y,z,w,h,d plinth
PAD_TOP   = 1.3
TIER1     = (0.0, PAD_TOP + 3.0, 0.0, 14.4, 6.0, 14.4)
T1_TOP    = PAD_TOP + 6.0                        # 7.3
TIER2     = (0.0, T1_TOP + 2.6, 0.0, 10.2, 5.2, 10.2)
T2_TOP    = T1_TOP + 5.2                         # 12.5
TOWER_R   = 3.3
TOWER_TOP = 18.6
BAND      = (16.6, 18.2, 3.45)                   # y0, y1, r (proud glass band)
CROWN_R   = 3.6
CROWN_TOP = 19.4
MAST_TOP  = 23.2
BASTIONS  = [(-9.2, -9.2), (9.2, -9.2), (-9.2, 9.2), (9.2, 9.2)]
BASTION_SZ = (3.2, 3.6, 3.2)                     # w,h,d — centred y PAD_TOP+1.8
GATE      = (0.0, PAD_TOP + 2.35, -7.45, 6.6, 4.7, 0.7)   # doorframe on -Z wall
RAMP_W    = 8.4
RAMP_Z0   = -11.5                                # pad edge
RAMP_Z1   = -15.7                                # ground contact
VENTS     = [(-4.6, T1_TOP, 3.6), (4.6, T1_TOP, 4.6)]   # x, ytop-of-tier1, z
PIPE_X    = 7.0                                  # pipe run down +x tier1 wall
DISH_OFF  = (2.45, 19.05, 0.0)                   # dish piece offset (crown edge)
