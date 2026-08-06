"""ms_anc_gate_layout — zones + dims for ms_anc_gate.

ANCIENT REGISTER. A 30 m free-standing circular portal frame: stepped
monolithic plinth (two broad steps + a central dais), two colossal
inward-tapering uprights whose INNER faces share one unbroken plane,
cantilevered yoke brackets carrying open cradle arcs, and a seamless
segmented ring that floats inside the cradles with a visible 0.20 m air
gap (piece `ring`, VERY slow idle rotation about its own +Z axis).
Dormant cyan tracery on the inner rim; a floating keystone hangs
unsupported above the ring apex; four half-buried conduit stubs flank
the approach. Nothing bolted, nothing patched — seams are recessed,
weathering is dust/soil/scorch only.

Dominant dim 30.6 m -> ATLAS 2048. Never team-owned.
World frame: RH, -Z forward (portal axis), +Y up, ground Y=0.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone


def at(rect, axes, ranges, center):
    """Zone whose window is `ranges` (per axis) offset to world `center`.
    Lets one atlas cell serve four scattered copies of the same prop."""
    off = {'x': center[0], 'y': center[1], 'z': center[2]}
    win = tuple((r[0] + off[a], r[1] + off[a]) for a, r in zip(axes, ranges))
    return Zone(rect, axes, win)


# ── dims (world metres, ground Y=0) ──────────────────────────────────────
# stepped plinth: (cx, cy, cz, w, h, d)
T1   = (0.0, 0.70, 0.0, 30.6, 1.40, 12.6)   # broad lower step  y 0.0..1.4
T2   = (0.0, 2.00, 0.0, 27.6, 1.20, 10.8)   # upper step        y 1.4..2.6
DAIS = (0.0, 3.00, 0.0, 13.0, 0.80,  7.0)   # central dais      y 2.6..3.4
PL_T2_TOP = 2.60
PL_TOP    = 3.40

# uprights — RIGHT side; the left pair mirrors x. Inner faces all at x=9.8
# (one unbroken plane); the taper is entirely on the outboard side.
# (x_in, x_out, y0, y1, depth_z)
UPRIGHTS = [
    (9.8, 13.4,  2.60,  9.40, 5.00),
    (9.8, 12.9,  9.40, 16.40, 4.40),
    (9.8, 12.5, 16.40, 24.40, 3.80),
]
UP_CH = 0.16

# ring (piece-local geometry, pivot on the portal axis)
RING_CY  = 18.60
RING_RO  = 8.80
RING_RI  = 7.50
RING_D   = 2.30
RING_CH  = 0.32
RING_N   = 72
BOSS_MOD = 9        # 8 raised nodes: stations where i%9 in (0,1)
BOSS_DR  = 0.55     # node outer-radius swell
BOSS_DD  = 0.40     # node depth swell
RING_PIVOT = (0.0, RING_CY, 0.0)

# cradle arcs (body): open arcs hugging the ring with a 0.20 m air gap
CRA_RO   = 9.55
CRA_RI   = 9.00
CRA_D    = 3.30
CRA_CH   = 0.14
CRA_HALF = 23.0     # degrees either side of the horizontal
CRA_N    = 14

# yoke brackets — the cantilever from upright inner face out to the cradle
YOKE = (9.80, 16.80, 20.40, 1.30, 3.30)   # (cx, y0, y1, w, depth)

# floating keystone (unsupported, hangs above the ring apex)
KEY = (0.0, 29.25, 0.0, 3.60, 1.50, 2.80)   # y 28.50..30.00 -> total H 30.0

# half-buried conduit stubs: (start_underground, end_exposed) for +x/+z;
# the generator mirrors both signs.
CON_A = (7.90, -0.90, 10.60)
CON_B = (6.00,  1.50,  8.40)
CON_R0, CON_R1 = 0.95, 0.80
COL_C = (7.19, 0.25, 9.78)                  # collar plate at ground crossing
COL_S = (2.60, 0.50, 2.60)

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
# plinth
R_PL_TOP = Zone((0,   0,   704, 320),  ('x', 'z'), ((-15.3, 15.3), (-6.3, 6.3)))
R_PL_SX  = Zone((0,   320, 704, 400),  ('x', 'y'), ((-15.3, 15.3), (3.4, 0.0)))
R_PL_SZ  = Zone((0,   400, 704, 480),  ('z', 'y'), ((-6.3, 6.3),   (3.4, 0.0)))
# upright top shelves (one cell, two mirrored windows)
R_UP_TR  = Zone((0,   480, 704, 880),  ('x', 'z'), ((9.6, 13.6),   (-2.6, 2.6)))
R_UP_TL  = Zone((0,   480, 704, 880),  ('x', 'z'), ((-9.6, -13.6), (-2.6, 2.6)))
# yoke brackets
R_YK_X   = Zone((0,   880, 352, 1120), ('z', 'y'), ((-1.65, 1.65), (20.4, 16.8)))
R_YK_ZR  = Zone((352, 880, 704, 1120), ('x', 'y'), ((9.15, 10.45), (20.4, 16.8)))
R_YK_ZL  = Zone((352, 880, 704, 1120), ('x', 'y'), ((-9.15, -10.45), (20.4, 16.8)))
R_YK_YR  = Zone((0,  1120, 352, 1280), ('x', 'z'), ((9.15, 10.45), (-1.65, 1.65)))
R_YK_YL  = Zone((0,  1120, 352, 1280), ('x', 'z'), ((-9.15, -10.45), (-1.65, 1.65)))
# keystone
R_KEY_Z  = Zone((352, 1120, 704, 1280), ('x', 'y'), ((-1.8, 1.8),  (30.0, 28.5)))
R_KEY_X  = Zone((0,   1280, 352, 1440), ('z', 'y'), ((-1.4, 1.4),  (30.0, 28.5)))
R_KEY_Y  = Zone((352, 1280, 704, 1440), ('x', 'z'), ((-1.8, 1.8),  (-1.4, 1.4)))
# uprights (tall flanks)
R_UP_X   = Zone((704, 0,   960,  1408), ('z', 'y'), ((-2.6, 2.6),  (25.0, 2.2)))
R_UP_ZR  = Zone((960, 0,   1216, 1408), ('x', 'y'), ((9.6, 13.6),  (25.0, 2.2)))
R_UP_ZL  = Zone((960, 0,   1216, 1408), ('x', 'y'), ((-9.6, -13.6),(25.0, 2.2)))
# conduits (parametric limb wrap + per-stub cells)
R_CON     = (704, 1408, 1216, 1536)
R_CON_CAP = (1216, 1152, 1408, 1344)
R_COL_TOP = (704, 1536, 1088, 1792)
R_COL_SD  = (704, 1792, 1088, 1856)
# ring + cradle: parametric (u = angle around the circle, v = across profile)
R_RING_OUT  = (1216, 0,    2048, 224)
R_RING_IN   = (1216, 224,  2048, 448)
R_RING_SIDE = (1216, 448,  2048, 800)
R_CRA_OUT   = (1216, 800,  2048, 896)
R_CRA_IN    = (1216, 896,  2048, 976)
R_CRA_SIDE  = (1216, 976,  2048, 1152)
R_DARK   = Zone((1408, 1152, 1664, 1408), ('x', 'z'), ((-1, 1), (-1, 1)))

# ring profile: v-fractions of each profile edge inside its rect.
# profile pts (r,z): 0=(Ro-ch,-d/2) 1=(Ro,-d/2+ch) 2=(Ro,d/2-ch) 3=(Ro-ch,d/2)
#                    4=(Ri+ch,d/2)  5=(Ri,d/2-ch)  6=(Ri,-d/2+ch) 7=(Ri+ch,-d/2)
PROFILE_EDGES = [
    (0, 1, 'out',  0.00, 0.18),
    (1, 2, 'out',  0.18, 0.82),
    (2, 3, 'out',  0.82, 1.00),
    (3, 4, 'side', 0.00, 1.00),
    (4, 5, 'in',   0.82, 1.00),
    (5, 6, 'in',   0.18, 0.82),
    (6, 7, 'in',   0.00, 0.18),
    (7, 0, 'side', 1.00, 0.00),
]
