"""ms_anc_barge_layout — zones + dims for ms_anc_barge (ancient gravity barge).

ANCIENT REGISTER. A 30 m monolithic flat-deck gravity barge from the
world-before: one unbroken lofted slab, segmented only by clean recessed
seams — no rivets, no bolted patches, no scrap. It HOVERS: there is no keel
and no waterline; the underside is a concave plenum whose lowest geometry
sits at Y = 2.05 m (the 2 m ride height), carrying recessed emitter channels
and five perfect-circle emitter discs. A continuous recessed groove rings the
whole hull at the skirt and carries the cyan lift-field line (ACTIVE — the
thing is flying). Two perfect circles thread the monolith: a 6.6 m prow ring
forward and a 5.6 m stern ring that the low aft control fin passes through.
A sensor ring floats above the fin on a stub and yaws slowly (clip `idle`).

Frame: RH, -Z forward (bow), +Y up, 1 unit = 1 m, ground plane Y=0.
Atlas 2048 (dominant dimension 30 m >= 15 m).
"""
import numpy as np

import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
# Three hero surfaces get whole atlas bands: deck, hull flank, belly.
Z_DECK  = Zone((0,    0,    2048, 768),  ('z', 'x'), ((-16.0, 16.0), (-6.2, 6.2)))
Z_HULL  = Zone((0,    768,  2048, 1152), ('z', 'y'), ((-16.0, 16.0), (4.50, 1.90)))
Z_BELLY = Zone((0,    1152, 2048, 1536), ('z', 'x'), ((-16.0, 16.0), (-6.2, 6.2)))

Z_DARK    = Zone((0,    1536, 128,  1664), ('x', 'z'), ((-1, 1), (-1, 1)))
Z_BOW     = Zone((128,  1536, 384,  1792), ('x', 'y'), ((1.6, -1.6), (4.60, 1.90)))
Z_STERN   = Zone((384,  1536, 704,  1792), ('x', 'y'), ((3.6, -3.6), (4.60, 1.90)))
Z_FIN     = Zone((704,  1536, 1216, 1792), ('z', 'y'), ((8.40, 15.60), (6.90, 4.20)))
Z_TRIM    = Zone((1216, 1536, 1472, 1792), ('z', 'y'), ((-45, 45), (25, -5)))
Z_FINLEAD = Zone((1472, 1536, 1600, 1792), ('z', 'y'), ((-45, 45), (25, -5)))
Z_PAD     = (1600, 1536, 1856, 1792)   # deck cradle-pad face (explicit uvs)
Z_EMIT    = (1856, 1536, 2048, 1728)   # belly emitter face  (explicit uvs)

R_RING     = (0,    1792, 512,  1920)  # prow/stern ring torus wrap
R_SENS     = (512,  1792, 768,  1920)  # sensor ring wrap
R_PYLON    = (768,  1792, 896,  1920)  # sensor stub
R_PADBAND  = (896,  1792, 1152, 1920)  # cradle-pad rim
R_EMITBAND = (1152, 1792, 1408, 1920)  # emitter rim

# ── hull sections (z, deck half-width, skirt half-width) ─────────────────
# The deck OVERHANGS the skirt forward of midships — the ancient cantilever.
SECTIONS = [
    (-15.0, 1.30, 1.10),
    (-13.6, 2.55, 2.05),
    (-12.0, 3.55, 2.80),
    (-10.0, 4.45, 3.55),
    (-7.0,  5.25, 4.45),
    (-3.0,  5.70, 5.15),
    (1.0,   5.75, 5.45),
    (5.0,   5.65, 5.35),
    (9.0,   5.20, 4.95),
    (12.5,  4.30, 4.10),
    (15.0,  3.30, 3.15),
]
_ZS = [s[0] for s in SECTIONS]

# section heights — one flat deck, one deep recessed groove, one plenum
Y_DECK   = 4.35     # monolithic flat deck (cargo surface)
Y_KNEE   = 4.00     # deck-edge bevel bottom
Y_G_TOP  = 3.62     # groove upper lip
Y_G_HI   = 3.55     # groove floor top
Y_G_LO   = 3.24     # groove floor bottom
Y_G_BOT  = 3.17     # groove lower lip
Y_CHINE  = 2.60     # skirt bottom
Y_BELLY  = 2.05     # outer belly edge = LOWEST geometry = ride height
Y_PLEN   = 2.55     # concave plenum floor (keel-less)
GROOVE_IN = 0.20    # groove recess depth
TUCK      = 0.35    # skirt -> belly-edge tuck
PLEN_IN   = 1.80    # skirt -> plenum-lip inset


def wd_at(z):
    """Deck half-width at z."""
    return float(np.interp(z, _ZS, [s[1] for s in SECTIONS]))


def wm_at(z):
    """Skirt half-width at z."""
    return float(np.interp(z, _ZS, [s[2] for s in SECTIONS]))


def wb_at(z):
    return max(0.30, wm_at(z) - TUCK)


def wp_at(z):
    return max(0.40, wm_at(z) - PLEN_IN)


def ring_at(z):
    """22-point closed section ring (x, y) — see gen for the ordering."""
    wd, wm = wd_at(z), wm_at(z)
    wb, wp = wb_at(z), wp_at(z)
    wg = max(0.20, wm - GROOVE_IN)
    return [
        (wd, Y_DECK), (wm, Y_KNEE), (wm, Y_G_TOP), (wg, Y_G_HI),
        (wg, Y_G_LO), (wm, Y_G_BOT), (wm, Y_CHINE), (wb, Y_BELLY),
        (wp, Y_PLEN), (0.0, Y_PLEN), (-wp, Y_PLEN), (-wb, Y_BELLY),
        (-wm, Y_CHINE), (-wm, Y_G_BOT), (-wg, Y_G_LO), (-wg, Y_G_HI),
        (-wm, Y_G_TOP), (-wm, Y_KNEE), (-wd, Y_DECK),
        (-0.45 * wd, Y_DECK), (0.0, Y_DECK), (0.45 * wd, Y_DECK),
    ]


# ── cargo deck ───────────────────────────────────────────────────────────
# Four link empties in a 2x2 grid (the 11.5 m beam takes two s2/s3 hulls
# abreast); each sits on a perfect-circle cradle pad 0.10 m proud of the deck.
PAD_R, PAD_H = 1.55, 0.10
PADS = [(-2.90, -7.00), (2.90, -7.00), (-2.90, 1.50), (2.90, 1.50)]
LINKS = [(x, Y_DECK + PAD_H, z) for (x, z) in PADS]     # link1..link4

# team-mask deck chevron (CAPTURABLE marker), pointing forward
CHEVRON = [(-12.0, 0.0), (-8.8, 2.40), (-8.8, 1.35), (-11.2, 0.0),
           (-8.8, -1.35), (-8.8, -2.40)]                # (z, x)

DECK_SEAMS = (-13.0, -4.4, 4.0, 8.5, 12.2)              # transverse, z
SPINE_HW = 0.95                                          # centre channel
SPINE_Z = (-14.2, 14.2)
DECK_LONG = (3.50,)                                      # longitudinal seams |x|

# ── belly emitters (x, z, radius) — perfect circles, ACTIVE cyan ─────────
EMIT_DEPTH = 0.15
EMITTERS = [(-1.55, -7.00, 1.05), (1.55, -7.00, 1.05),
            (0.00, -0.50, 1.45),
            (-1.95, 6.50, 1.15), (1.95, 6.50, 1.15)]
BELLY_CHANNELS = (0.0, -1.90, 1.90)                      # |x| of plenum channels
CHANNEL_Z = (-13.0, 13.4)

# ── the two perfect circles that thread the monolith ─────────────────────
PROW_RING = dict(center=(0.0, 5.65, -12.80), R=3.30, r=0.32, nm=18, nn=6)
STERN_RING = dict(center=(0.0, 5.10, 13.00), R=2.80, r=0.26, nm=16, nn=6)

# ── aft control fin (low, raked, cantilevered past the transom) ──────────
FIN_OFF = (0.0, 4.30, 11.90)                             # piece offset
FIN_PROFILE = [(-3.30, 0.00), (-1.60, 2.00), (1.30, 2.25),
               (3.50, 1.25), (3.20, 0.00)]               # local (z, y)
FIN_X = (-0.34, -0.24, 0.24, 0.34)                       # loft x stations
FIN_CHAMFER = 0.10                                       # outer-ring inset

# sensor ring — floats above the fin, yaws in clip `idle`
SENSOR_OFF = (0.0, 3.25, -0.50)                          # local to FIN_OFF
SENSOR = dict(R=0.85, r=0.12, nm=12, nn=6)
PYLON = ((0.0, 2.00, -0.50), (0.0, 2.34, -0.50))         # fin-local stub
IDLE_PERIOD = 14.0                                        # s, one revolution
