"""ms_vault_door_layout — zones + dims for ms_vault_door (ancient vault door).

Ancient-tech cache site: 10 m circular vault door, half-buried, set into a
rock/earth berm. Segmented monolithic door with emissive CYAN seam glow
(ancient-tech register — nothing bolted, nothing patched), toppled masonry
blocks, half-buried conduit run, scorched ground apron. Static site: one
piece `body`, no clips, no team colour. 1024² atlas (dominant dim < 15 m).
World frame: front = -Z, up = +Y, ground Y = 0.
"""
import meshlib
meshlib.ATLAS = 1024
from meshlib import Zone

# ── door dims (world metres) ─────────────────────────────────────────────
DOOR_R    = 5.0          # 10 m diameter
DOOR_CY   = 0.8          # centre height -> top at 5.8 m, lower 4.2 m buried
DOOR_Z0   = -0.9         # front face z
DOOR_Z1   = 0.3          # back face z (into the berm)
DOOR_N    = 20           # rim facets
HUB_R     = 1.7          # raised central hub disc
HUB_Z0    = -1.25        # hub front face (proud of the door)
COLLAR_R  = 5.45         # stone collar ring proud of the berm face
COLLAR_Z0 = -0.55
COLLAR_Z1 = 0.5

# ── berm loft stations (x, crest_h, z_front_toe, z_crest, z_back_toe) ───
BERM = [(-10.0, 0.5, -2.5, 2.0, 5.0),
        (-7.0,  4.0, -1.8, 2.0, 6.2),
        (-4.2,  6.4, -0.35, 2.0, 7.0),
        (4.2,   6.4, -0.35, 2.0, 7.0),
        (7.0,   4.0, -1.8, 2.0, 6.2),
        (10.0,  0.5, -2.5, 2.0, 5.0)]

# ── toppled masonry blocks: (center xyz, size whd, yaw deg, pitch deg) ──
BLOCKS = [((-6.9, 0.55, -3.4), (2.6, 1.3, 1.5), 24.0, 7.0),
          ((-4.6, 0.4, -5.6), (1.9, 1.0, 1.2), -38.0, -5.0),
          ((6.3, 0.6, -4.1), (2.9, 1.4, 1.6), -17.0, 9.0),
          ((7.9, 0.35, -6.6), (1.6, 0.9, 1.1), 52.0, -6.0),
          ((2.9, 0.3, -7.4), (1.5, 0.8, 1.0), 11.0, 4.0)]

# ── half-buried conduit run: door base -> out along the apron ───────────
CONDUIT_R = 0.22
CONDUIT   = [(2.6, 0.55, -1.3), (3.4, 0.28, -3.2), (3.1, 0.2, -5.8),
             (4.0, 0.12, -8.4)]
CONDUIT2  = [(-2.4, 0.5, -1.35), (-3.0, 0.22, -3.6), (-2.7, 0.14, -6.4)]

# ── scorched ground apron (thin quad at y=0.02) ─────────────────────────
APRON = (-9.5, -9.0, 9.5, -0.5)   # x0, z0, x1, z1

# ── atlas zones (1024²; v down) ─────────────────────────────────────────
Z_DOOR   = Zone((0, 0, 600, 600), ('x', 'y'),
                ((-DOOR_R - 0.2, DOOR_R + 0.2),
                 (DOOR_CY + DOOR_R + 0.2, DOOR_CY - DOOR_R - 0.2)))
Z_RIM    = (600, 0, 1024, 96)          # parametric door rim wrap
Z_HUBRIM = (600, 96, 1024, 152)        # parametric hub rim wrap
Z_COLLAR = (600, 152, 1024, 232)       # parametric collar wrap
Z_ROCK   = Zone((600, 232, 1024, 560), ('x', 'y'),
                ((-1.6, 1.6), (1.6, -1.6)))   # masonry blocks (shared)
Z_PIPE   = (600, 560, 1024, 624)       # conduit wrap
Z_BERM_F = Zone((0, 600, 1024, 800), ('x', 'y'),
                ((-10.0, 10.0), (6.6, -0.2)))  # front slope (planar x/y)
Z_BERM_B = Zone((0, 800, 1024, 928), ('x', 'z'),
                ((-10.0, 10.0), (1.8, 7.2)))   # back slope (planar x/z)
Z_GROUND = Zone((0, 928, 1024, 1024), ('x', 'z'),
                ((-9.5, 9.5), (-9.0, -0.5)))   # scorched apron
