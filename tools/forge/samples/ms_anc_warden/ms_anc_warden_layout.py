"""ms_anc_warden_layout — zones + dims for ms_anc_warden (Warden automaton).

ANCIENT REGISTER. A 12 m guardian biped left behind by the world-before:
monolithic limb columns, a gyro-sphere hip girdled by two free-standing
halo rings, a sensor cowl with a cyan visor slit, and a shoulder-mounted
lance on the standard turret/barrel/muzzle chain.  Nothing bolted,
nothing patched — large unbroken surfaces cut by clean recessed seams
that carry the cyan tracery.  Gaia-owned but CAPTURABLE, so a small
team-mask sigil sits on each cowl cheek and on the cowl crown.

World frame: forward=-Z, up=+Y, left=+X, ground Y=0, 1 unit = 1 m.
Single source of truth for BOTH the geometry generator (UV projection)
and the texture painter.  Dominant dimension 12.2 m -> ATLAS 2048 (spec).

Atlas convention: `Zone` cells carry a world window (loft/profile faces
that must stay glued to world coordinates); plain 4-tuple RECT cells are
either parametric wraps or box faces fitted by gen's box_zones(), and the
painter dresses those by fraction of the cell.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

A = 2048

# ── skeleton anchors (world / piece-local) ──────────────────────────────
HIP_Y      = 7.55          # gyro-sphere centre, hip pivot height
HIP_X      = 1.70          # hip pivot half-separation
KNEE       = (0.0, -3.00, -0.18)   # thigh-local
ANKLE      = (0.0, -3.30,  0.22)   # shin-local (ankle world y = 1.25)
SOLE_Y     = -1.25                 # foot-local sole (world y = 0)

TORSO_OFF  = (0.0, 8.30, 0.0)      # `turret` pivot (body-local == world)
GYRO_OFF   = (0.0, HIP_Y, 0.0)     # `gyro` pivot
HEAD_OFF   = (0.0, 2.48, -0.20)    # turret-local -> world (0, 10.78, -0.20)
LANCE_OFF  = (2.02, 2.15, -0.05)   # turret-local -> world (2.02, 10.45, -0.05)
MUZZLE_OFF = (0.0, 0.0, -5.15)     # barrel-local

# ── atlas cells (2048²; v runs down) ────────────────────────────────────
# row 1 -------------------------------------------------- torso monolith
A_TORSO_F  = Zone((   0,    0,  448,  448), ('x', 'y'), ((-1.90, 1.90), ( 2.85, 0.10)))
A_TORSO_B  = Zone(( 448,    0,  896,  448), ('x', 'y'), (( 1.90,-1.90), ( 2.85, 0.10)))
A_TORSO_S  = Zone(( 896,    0, 1408,  448), ('z', 'y'), ((-1.15, 1.35), ( 2.85, 0.10)))
A_TORSO_T  = Zone((1408,    0, 1856,  320), ('x', 'z'), ((-1.90, 1.90), (-1.15, 1.35)))
A_DARK     = Zone((1856,    0, 2048,  192), ('x', 'z'), ((-1.00, 1.00), (-1.00, 1.00)))
A_LENS     =      (1856,  192, 2048,  384)     # chest core lens face
A_TORSO_BT = Zone((1408,  320, 1856,  448), ('x', 'z'), ((-1.90, 1.90), (-1.15, 1.35)))

# row 2 ---------------------------------- gyro sphere, halo rings, joints
A_HIP_F    = Zone((   0,  448,  448,  896), ('x', 'y'), ((-1.60, 1.60), (HIP_Y + 1.60, HIP_Y - 1.60)))
A_HIP_B    = Zone(( 448,  448,  896,  896), ('x', 'y'), (( 1.60,-1.60), (HIP_Y + 1.60, HIP_Y - 1.60)))
A_HIP_CAP  = Zone(( 896,  448, 1152,  704), ('x', 'z'), ((-1.60, 1.60), (-1.60, 1.60)))
A_JOINT    =      (1152,  448, 1536,  576)     # big joint-disc wrap   (parametric)
A_JOINT2   =      (1152,  576, 1536,  704)     # small joint-disc wrap (parametric)
A_JCAP     =      (1536,  448, 1728,  640)     # big disc face   (disc_zone())
A_JCAP2    =      (1728,  448, 1920,  640)     # small disc face (disc_zone())
A_CYAN     =      (1920,  448, 2048,  576)     # pure tracery cell
A_RING_O   =      ( 896,  704, 1664,  768)     # halo outer band
A_RING_I   =      ( 896,  768, 1664,  832)     # halo inner band (cyan tracery)
A_RING_E   =      ( 896,  832, 1664,  896)     # halo rim faces
A_TRIM     =      (1664,  704, 1920,  832)     # small parametric wrap

# row 3 ----------------------------------------------------- sensor cowl
A_COWL_S   =      (   0,  896,  448, 1216)     # cowl hood sides
A_COWL_F   =      ( 448,  896,  768, 1216)     # cowl hood front / rear
A_COWL_T   =      ( 768,  896, 1152, 1216)     # cowl hood crown (team sigil)
A_CREST    =      (1152,  896, 1600, 1216)     # crest fin
A_VISOR    =      (1600,  896, 2048, 1088)     # visor slit block
A_SIGIL    =      (1600, 1088, 2048, 1216)     # team sigil plate

# row 4 ------------------------------------------------------ limbs, feet
A_LIMB_TH  =      (   0, 1216,  384, 1344)     # thigh column wrap
A_LIMB_SH  =      (   0, 1344,  384, 1472)     # shin column wrap
A_PLATE_S  =      ( 384, 1216,  832, 1472)     # limb plate sides
A_PLATE_F  =      ( 832, 1216, 1152, 1472)     # limb plate front / rear
A_FOOT_S   = Zone((1152, 1216, 1664, 1472), ('z', 'y'), (( 1.15,-2.15), ( 0.25,-1.30)))
A_FOOT_W   =      (1152, 1472, 1664, 1568)     # foot wrap (arc-length)
A_FOOT_T   =      (1664, 1216, 2048, 1536)     # instep plate
A_LANCE_W  =      (   0, 1472,  832, 1568)     # lance tube wrap (parametric)

# row 5 ------------------------------------------------ lance, shoulders
A_LANCE_S  =      (   0, 1568,  896, 1760)     # dorsal tracery channel sides
A_LANCE_T  =      (   0, 1760,  896, 1952)     # dorsal tracery channel top
A_WAIST    =      (   0, 1952,  896, 2048)     # waist drum wrap (parametric)
A_BREECH   =      ( 896, 1568, 1216, 1760)     # lance breech block
A_BOOM     =      ( 896, 1760, 1216, 1952)     # rear cantilever block
A_PAULD_S  =      (1216, 1568, 1664, 1824)     # pauldron sides
A_PAULD_T  =      (1664, 1568, 2048, 1824)     # pauldron crown
A_EMIT     =      (1216, 1824, 1536, 2048)     # muzzle emitter cell
A_SPARE    =      (1536, 1824, 2048, 2048)     # reserve

# ── gyro-sphere hip (`body` piece; body-local == world) ─────────────────
SPHERE_C   = (0.0, HIP_Y, 0.0)
SPHERE_N   = 12
SPHERE_RINGS = [(-1.50, 0.46), (-1.22, 0.98), (-0.68, 1.38), (0.0, 1.52),
                (0.68, 1.38), (1.22, 0.98), (1.50, 0.46)]   # (dy, radius)
HIP_COLLAR = (1.46, 1.04, 0.22)      # (|x| centre, radius, half-width)

# ── floating halo rings (`gyro` piece; gyro-local, origin at the hip) ───
# (centre_along_axis, radius, radial_thickness, extent_along_axis, segments)
HALO_UPPER = ( 0.15, 2.45, 0.26, 0.46, 16)
HALO_LOWER = (-1.30, 2.85, 0.20, 0.34, 16)
# orrery pylons standing on the upper halo (break the ring's symmetry so
# the spin reads); (angle deg, radius, height, n)
PYLONS = [(90.0, 0.24, 0.72, 8), (210.0, 0.24, 0.72, 8), (330.0, 0.24, 0.72, 8)]

# ── torso monolith (`turret` piece; turret-local) ───────────────────────
WAIST_R    = 0.95
WAIST_Y    = (-1.35, 0.45)
WAIST_N    = 12
# loft cross-sections: (z, y_bot, y_waist, y_shoulder, y_top,
#                       w_bot, w_waist, w_shoulder, w_top)
TORSO_SECTIONS = [
    (-1.05, 0.58, 1.15, 2.18, 2.52, 0.55, 0.95, 1.10, 0.62),
    (-0.32, 0.28, 1.02, 2.42, 2.80, 0.92, 1.58, 1.86, 1.08),
    ( 0.46, 0.28, 1.02, 2.36, 2.74, 0.94, 1.60, 1.88, 1.12),
    ( 1.22, 0.55, 1.08, 2.02, 2.36, 0.60, 1.00, 1.15, 0.66),
]
PAULDRON   = (1.92, 2.10, 0.02, 0.68, 1.24, 1.86)   # x,y,z, w,h,d (mirrored)
LENS_C     = (0.0, 1.72, -1.02)     # chest core lens centre, faces -Z
LENS_R     = 0.62
LENS_D     = 0.16                   # boss depth (proud of the chest)
LENS_N     = 12
SOCKET_C   = (2.12, 2.15, -0.05)    # lance shoulder socket ring
SOCKET_R, SOCKET_W = 0.60, 0.16
BOOM_A     = (0.0, 2.30, 1.15)      # rear cantilever counterweight
BOOM_B     = (0.0, 3.05, 2.55)
BOOM_R     = (0.30, 0.22)
BOOM_BLOCK = (0.0, 3.08, 2.78, 0.86, 0.62, 0.72)

# ── sensor cowl (`head` piece; head-local) ──────────────────────────────
COWL_HOOD  = (0.0,  0.36, -0.36, 2.46, 1.00, 1.76)   # x,y,z, w,h,d
COWL_VISOR = (0.0,  0.30, -1.30, 2.06, 0.34, 0.22)
COWL_CREST = (0.0,  0.94,  0.16, 0.44, 0.86, 1.58)   # crown at world 12.15
COWL_SIGIL = (0.0,  0.88, -0.96, 0.54, 0.06, 0.46)   # team plate on the crown

# ── limbs ───────────────────────────────────────────────────────────────
THIGH_R    = (0.80, 0.66)
SHIN_R     = (0.66, 0.54)
HIP_DISC   = (-0.12, 0.92, 0.32)     # (x centre, radius, half-width)
KNEE_DISC  = (0.0, 0.74, 0.26)
ANKL_DISC  = (0.0, 0.58, 0.22)
DISC_N     = 12
THIGH_PLATE = (0.0, -1.52, -0.46, 1.32, 2.24, 0.54)  # thigh-local
SHIN_PLATE  = (0.0, -1.66,  0.40, 1.10, 2.32, 0.48)  # shin-local

FOOT_HALF_W = 1.04
FOOT_PROFILE = [    # (z, y) ankle-local, extruded ±FOOT_HALF_W in x
    ( 1.15, -0.35), ( 1.15, -1.25), (-1.55, -1.25), (-2.15, -0.90),
    (-2.05, -0.40), (-1.20,  0.05), ( 0.10,  0.18), ( 0.90,  0.05),
]
FOOT_PLATE = (0.0, 0.08, -0.62, 1.30, 0.34, 2.10)

# ── lance (`barrel` piece; barrel-local, points -Z) ─────────────────────
YOKE       = (-0.20, 0.56, 0.28)     # (x centre, radius, half-width)
LANCE_BREECH  = (0.0, 0.02, 0.40, 0.98, 0.98, 0.96)
LANCE_TUBE = [(0.55, 0.40), (0.10, 0.44), (-1.60, 0.36),
              (-4.20, 0.26), (-4.92, 0.20)]
LANCE_CHANNEL = (0.0, 0.42, -1.95, 0.34, 0.20, 4.70)   # dorsal cyan tracery
EMITTER    = (-4.55, 0.44, 0.10, 0.24, 12)   # (z, R, radial_th, extent, n)

# ── clips ───────────────────────────────────────────────────────────────
# walk: authored quadruple-beat cycle (contact / down / passing / up per
# half-stride), 9 keys over 2.4 s, last key == first -> seamless wrap.
# Angles in degrees about +X; positive swings the limb's -Y end forward.
WALK_T = 2.4
WALK_THIGH = [ 21,  12,   2, -10, -21, -12,   3,  16,  21]
WALK_SHIN  = [  3,  10,   5,  -4, -13, -34, -27,  -5,   3]   # -ve folds the knee back
WALK_FOOT_COMP  = 0.72
WALK_FOOT_CLAMP = 22.0
WALK_BODY_Y = [0.0, -0.15, -0.03, 0.10, 0.0, -0.15, -0.03, 0.10, 0.0]
WALK_BODY_X = [0.0,  0.07,  0.09, 0.05, 0.0, -0.07, -0.09, -0.05, 0.0]
WALK_TORSO_YAW   = [ 5,  3,  0, -3, -5, -3,  0,  3,  5]
WALK_HEAD_YAW    = [-3, -2,  0,  2,  3,  2,  0, -2, -3]
WALK_LANCE_PITCH = [-2, -1,  0,  1,  2,  1,  0, -1, -2]
WALK_GYRO_SPIN   = [0, -45, -90, -135, -180, -225, -270, -315, -360]

# idle: the cowl sweeps the horizon, the halos drift the other way.
IDLE_T = 6.0
IDLE_KEYS        = [0.0, 1.5, 3.0, 4.5, 6.0]
IDLE_HEAD_YAW    = [0, 27, 0, -27, 0]
IDLE_HEAD_PITCH  = [0, -4, -1, -4, 0]
IDLE_TORSO_YAW   = [0, 7, 0, -7, 0]
IDLE_BODY_Y      = [0.0, -0.035, -0.010, -0.035, 0.0]
IDLE_GYRO_SPIN   = [0, 90, 180, 270, 360]
IDLE_LANCE_PITCH = [0, -2, 0, -2, 0]
