"""ms_anc_obelisk_field_layout — zones + dims for the resonant obelisk kit.

ANCIENT register scenario dressing.  THREE elements as separate ROOT pieces
in ONE glTF (ms_anc_obelisk_field):

  obelisk_a  9 m  upright monolith, two recessed collars, 14 deg shaft twist,
                  obliquely sliced crown, ACTIVE cyan resonance seam
  obelisk_b  6 m  same language, leaning 13.5 deg out of a soil heave,
                  DORMANT seam (embers, one dead gap)
  obelisk_c  4.3 m original, snapped at 1.7 m: stump + the fallen tip lying
                  beside it (both in the ONE piece), seam all but dead

Shaft cross-section is a regular octagon of apothem w(y) with one rectangular
channel cut into the -Z face — that channel IS the resonance seam, so the
cyan lives in a genuine recess, not a painted stripe.  The whole section
rotates slowly about Y with height (the twist), so the seam spirals; the
painter reproduces the spiral through `groove_center_x`.

Frame: RH, -Z forward, +Y up, ground plane Y=0, 1 unit = 1 m.  Shafts are
authored below grade (y<0) so the soil drifts bury the foot with no cap.
Root offsets fan the three elements apart so they do not overlap when the
whole kit renders; an integrator placing ONE obelisk should zero the root
offset for that piece.  Never team-owned (--no-team).
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

W = 2048

# ── atlas zones (2048²) ─────────────────────────────────────────────────
# Diagonal (chamfer) facets deliberately borrow the SIDE zone — the same
# trick meshlib.chamfer_box uses — so each obelisk needs only three tall
# zones and the atlas stays at ~128 px/m.

# obelisk_a: x/z window 2.9 m, y window 10.1 m  (~128 px/m)
A_FACE = Zone((   0,   0,  371, 1293), ('x', 'y'), ((-1.45, 1.45), (9.30, -0.80)))
A_SIDE = Zone(( 375,   0,  746, 1293), ('z', 'y'), ((-1.45, 1.45), (9.30, -0.80)))
A_BACK = Zone(( 750,   0, 1121, 1293), ('x', 'y'), (( 1.45, -1.45), (9.30, -0.80)))
# obelisk_b: 2.5 m × 7.0 m
B_FACE = Zone((1128,   0, 1428,  896), ('x', 'y'), ((-1.25, 1.25), (6.20, -0.80)))
B_SIDE = Zone((1432,   0, 1732,  896), ('z', 'y'), ((-1.25, 1.25), (6.20, -0.80)))
B_BACK = Zone((1736,   0, 2036,  896), ('x', 'y'), (( 1.25, -1.25), (6.20, -0.80)))
# obelisk_c: 2.5 m × 5.25 m — stump AND fallen tip share it (the tip is
# authored upright in the un-broken frame, then rigidly transformed, so its
# UVs continue the stump's and the seam reads as one shaft).
C_FACE = Zone((1128, 902, 1428, 1532), ('x', 'y'), ((-1.25, 1.25), (4.45, -0.80)))
C_SIDE = Zone((1432, 902, 1732, 1532), ('z', 'y'), ((-1.25, 1.25), (4.45, -0.80)))
C_BACK = Zone((1736, 902, 2036, 1532), ('x', 'y'), (( 1.25, -1.25), (4.45, -0.80)))

# soil drifts / heave — top-down projection (shallow slopes, no stretch)
SOIL   = Zone((   0, 1304,  512, 1816), ('x', 'z'), ((-3.4, 3.4), (-3.4, 3.4)))
SOIL_B = Zone(( 518, 1304, 1030, 1816), ('x', 'z'), ((-3.4, 3.4), (-3.4, 3.4)))

# crowns (oblique slice caps) and the fracture faces
A_TOP  = Zone((1128, 1540, 1320, 1732), ('x', 'z'), ((-0.80, 0.80), (-0.80, 0.80)))
B_TOP  = Zone((1326, 1540, 1486, 1700), ('x', 'z'), ((-0.75, 0.75), (-0.75, 0.75)))
C_TOP  = Zone((1492, 1540, 1652, 1700), ('x', 'z'), ((-0.75, 0.75), (-0.75, 0.75)))
C_FRAC = Zone((1658, 1540, 1978, 1860), ('x', 'z'), ((-1.10, 1.10), (-1.10, 1.10)))

# groove side walls (uniform deep shadow) + generic dark cell
GWALL  = Zone((   0, 1822,   96, 2044), ('z', 'y'), ((-1.5, 1.5), (9.30, -0.80)))
DARK   = Zone(( 104, 1822,  200, 1918), ('x', 'z'), ((-45, 45), (-45, 45)))

# ── shared shaft construction ───────────────────────────────────────────
GROOVE_HW = 0.21          # resonance channel half-width (x)
GROOVE_D  = 0.18          # channel depth (into the -Z face)
NSEC      = 12            # section vertices with the channel (8-gon + 4)

# profile = [(y, apothem)] bottom→top; collar pairs make the recessed bands
A_PROFILE = [(-0.60, 1.260), (0.35, 1.190), (1.60, 1.110), (2.85, 1.005),
             (2.97, 0.905), (3.30, 0.900), (3.42, 0.990),
             (4.70, 0.915), (5.90, 0.845),
             (6.02, 0.775), (6.28, 0.772), (6.40, 0.838),
             (7.70, 0.685)]
A_TWIST = (14.0, -0.60, 9.00)          # (total deg, y0, y1)
A_CROWN = (8.47, 0.43, 0.10, 0.685)    # (y centre, z gain, x gain, w_top)
A_SOIL  = [(0.02, 2.55), (0.42, 1.86), (0.88, 1.10)]
A_COLLARS = [(2.97, 3.30), (6.02, 6.28)]

B_PROFILE = [(-0.70, 1.080), (0.30, 1.020), (1.40, 0.955), (2.45, 0.875),
             (2.57, 0.785), (2.90, 0.780), (3.02, 0.865),
             (3.90, 0.825), (5.15, 0.700)]
B_TWIST = (-9.0, -0.70, 6.00)
B_CROWN = (5.62, 0.32, 0.06, 0.700)
B_LEAN  = (-13.5, 0.20)                # (deg about +Z, pivot y) — top to +X
B_SOIL  = [(0.00, 2.10), (0.16, 1.40), (0.55, 0.860)]
B_HEAVE = 0.95                         # lip ridge height on the -X side
B_COLLARS = [(2.57, 2.90)]

C_PROFILE = [(-0.55, 1.030), (0.20, 0.975), (0.72, 0.945),
             (0.84, 0.875), (1.10, 0.872), (1.22, 0.930), (1.35, 0.912)]
C_TWIST = (11.0, -0.55, 4.30)
C_FRAC_Y = 1.70                        # nominal break height
C_FRAC_W = 0.830
C_FRAC_JIT = 0.24                      # per-vertex fracture ragging (±m)
C_TIP_PROFILE = [(2.05, 0.800), (2.85, 0.745), (3.60, 0.665)]
C_CROWN = (3.98, 0.27, 0.05, 0.665)
C_COLLARS = [(0.84, 1.10)]
# fallen tip rigid placement: spin about its own axis (chooses the resting
# facet AND turns the seam 45° skyward), tip-over, yaw, then drop to ground
C_TIP_SPIN  = 135.0
C_TIP_PITCH = -89.0
C_TIP_YAW   = -35.0
C_TIP_AT    = (1.72, -0.55)            # where the fracture end lands (x, z)
C_TIP_SINK  = 0.10
C_SOIL  = [(0.02, 1.72), (0.40, 1.28), (0.75, 0.860)]
C_HUMMOCKS = [((2.15, -1.35), 0.88), ((2.95, -2.45), 0.72)]

# root piece offsets (kit fan-out only — see module docstring)
A_OFF = (0.0, 0.0, 0.0)
B_OFF = (-10.0, 0.0, 0.0)
C_OFF = (9.5, 0.0, 0.0)


# ── shared helpers (gen AND paint use these; the seam must line up) ─────

def w_at(profile, y):
    """Apothem at height y, linear between profile rings (clamped)."""
    if y <= profile[0][0]:
        return profile[0][1]
    if y >= profile[-1][0]:
        return profile[-1][1]
    for (y0, w0), (y1, w1) in zip(profile, profile[1:]):
        if y0 <= y <= y1:
            if y1 == y0:
                return w1
            return w0 + (w1 - w0) * (y - y0) / (y1 - y0)
    return profile[-1][1]


def twist_at(spec, y):
    """Shaft twist (radians) at height y."""
    import math
    deg, y0, y1 = spec
    return math.radians(deg * (y - y0) / (y1 - y0))


def groove_center_x(profile, twist_spec, y):
    """World x of the resonance channel centreline at height y — the shaft
    twist walks the seam sideways, and the painter must follow it."""
    import math
    w = w_at(profile, y)
    return -(w - GROOVE_D * 0.5) * math.sin(twist_at(twist_spec, y))


# full profiles used by the painter for the C seam (stump + tip continue)
C_FULL_PROFILE = C_PROFILE + [(C_FRAC_Y, C_FRAC_W)] + C_TIP_PROFILE
