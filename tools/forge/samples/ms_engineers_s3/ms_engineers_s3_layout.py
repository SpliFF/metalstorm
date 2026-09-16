"""ms_engineers_s3_layout — zones + dims for the engineers-s3 construction rig.

WHY THIS MODEL EXISTS. `units/engineers.lua` scale 3 is a "Heavy construction
rig pair" — VEH movedef, LAND MOBILE VEHICLE, footprint 3 — but the shipped
ms_engineers_s3.gltf was a 1.89 m PERSON off the shared infantry body plan, so
a squad of two rigs rendered as two figures in hard hats (units-assets review
2026-09-10, "Decide ms_engineers_s3: either a rig model or revert the def to
INFANTRY"). This is the rig. One squad MEMBER = one rig; the def's squad of
two is the "pair".

6.0 m tracked works rig, hi-vis engineer register (the family read
ms_engineers_s4 carries onto a vehicle): dozer/grader blade forward, glazed
crew cab, open fabrication deck with gas bottles, crates and a tool bin, and a
folded A-frame lifting jib over the tail. Pieces body / tracks_l / tracks_r,
no clips (squad_size > 1 at s3 — the client's clip player only drives the
single-hull tiers). Budget 2000 tris, 1024² (dominant dim < 15 m).

World frame: forward -Z, up +Y, left +X, ground Y=0, 1 unit = 1 m
(gltf_export multiplies by 8 at write time — never pre-scale here).
Pattern: ms_command_s2 (tracked hull + track pods + deck dressing).
"""
import meshlib
from meshlib import Zone

meshlib.ATLAS = 1024

# ── atlas zones (1024²; v down) ─────────────────────────────────────────
HULL_SIDE  = Zone((0,     0,  448, 160), ('z', 'y'), ((-2.75, 2.85), (1.55, 0.25)))
HULL_TOP   = Zone((0,   160,  448, 352), ('x', 'z'), ((-1.30, 1.30), (-2.75, 2.85)))
HULL_FRONT = Zone((448,   0,  640, 160), ('x', 'y'), ((-1.30, 1.30), (1.55, 0.25)))
HULL_REAR  = Zone((640,   0,  832, 160), ('x', 'y'), ((1.30, -1.30), (1.55, 0.25)))
CAB_SIDE   = Zone((448, 160,  704, 352), ('z', 'y'), ((-2.55, -0.85), (2.72, 1.38)))
CAB_FRONT  = Zone((704, 160,  896, 352), ('x', 'y'), ((-0.90, 0.90), (2.72, 1.38)))
CAB_REAR   = Zone((832,   0, 1024, 160), ('x', 'y'), ((0.90, -0.90), (2.72, 1.38)))
CAB_TOP    = Zone((704, 352,  896, 512), ('x', 'z'), ((-0.90, 0.90), (-2.55, -0.85)))
TRACK_SIDE = Zone((0,   352,  448, 480), ('z', 'y'), ((-2.70, 2.80), (1.18, 0.00)))
TRACK_WRAP = (0, 480, 448, 528)        # parametric arc-length wrap (raw rect)
FENDER     = Zone((0,   528,  448, 592), ('z', 'x'), ((-2.70, 2.80), (-0.48, 0.48)))
BLADE_F    = Zone((448, 352,  704, 448), ('x', 'y'), ((-1.45, 1.45), (1.15, 0.05)))
BLADE_T    = Zone((448, 448,  704, 512), ('x', 'z'), ((-1.45, 1.45), (-0.16, 0.16)))
DECK       = Zone((0,   592,  448, 784), ('x', 'z'), ((-1.30, 1.30), (0.10, 2.85)))
BOTTLE     = (896, 160, 1024, 352)     # gas-bottle wrap (raw rect)
CRATE_S    = Zone((448, 512,  576, 592), ('x', 'y'), ((-0.55, 0.55), (0.55, -0.15)))
CRATE_T    = Zone((576, 512,  704, 592), ('x', 'z'), ((-0.55, 0.55), (-0.55, 0.55)))
BIN_S      = Zone((704, 512,  832, 592), ('z', 'y'), ((-0.85, 0.85), (0.45, -0.15)))
BIN_T      = Zone((832, 512,  960, 592), ('x', 'z'), ((-0.45, 0.45), (-0.85, 0.85)))
MAST       = (448, 592, 512, 784)      # jib-leg wrap (raw rect)
TRIM       = (512, 592, 576, 784)      # small-part wrap (raw rect)
TRIM_BOX   = Zone((512, 592,  576, 784), ('x', 'y'), ((-0.22, 0.22), (0.22, -0.22)))
HAZARD     = Zone((576, 592,  832, 688), ('x', 'y'), ((-1.45, 1.45), (0.30, -0.30)))
LIGHT      = Zone((832, 592,  896, 656), ('x', 'y'), ((-0.12, 0.12), (0.12, -0.12)))
DARK       = Zone((896, 592,  960, 656), ('x', 'z'), ((-45, 45), (-45, 45)))

# ── hull (metres) ───────────────────────────────────────────────────────
HULL       = (0.0, 0.90, 0.05, 2.20, 1.10, 5.30)   # x,y,z, w,h,d
DECK_PLATE = (0.0, 1.50, 0.55, 2.62, 0.10, 4.20)   # deck over the pods, aft
DECK_Y     = 1.55

# track pods (piece-local; x mirrored for tracks_r)
TRACK_OFF     = (1.05, 0.0, 0.0)
TRACK_HALF_W  = 0.40
TRACK_PROFILE = [                      # local (z, y) outer loop
    (-2.62, 0.58), (-1.80, 0.00), (1.90, 0.00), (2.70, 0.56),
    (2.62, 1.02), (1.55, 1.16), (-1.55, 1.16), (-2.54, 1.00),
]
FENDER_SPAN = ((-2.55, 2.65), 1.14, 0.09, 0.96)    # (zspan, y_base, h, width)

# crew cab, forward over the blade arms
CAB        = (0.0, 2.05, -1.70, 1.66, 1.30, 1.56)  # x,y,z, w,h,d
CAB_VISOR  = (0.0, 2.74, -2.34, 1.70, 0.09, 0.42)  # sun visor over the screen
BEACON     = (0.55, 2.78, -1.15)                   # amber rotating beacon
FLOODS     = [(-0.62, 2.74, -2.36), (0.62, 2.74, -2.36)]
FLOOD_SIZE = (0.26, 0.18, 0.12)

# dozer / grader blade + push arms
BLADE      = (0.0, 0.62, -2.98, 2.76, 0.86, 0.20)
BLADE_LIP  = (0.0, 0.20, -3.02, 2.76, 0.16, 0.26)
ARMS       = [(-0.78, 0.72, -1.55, -0.78, 0.66, -2.88),
              (0.78, 0.72, -1.55, 0.78, 0.66, -2.88)]

# fabrication deck dressing
BOTTLES    = [(-0.82, 1.90), (-0.52, 2.02), (-0.22, 1.88)]   # (cx, cz)
BOTTLE_R, BOTTLE_H = 0.17, 0.92
CRATES     = [(0.72, 1.62, 0.78, 0.52, 0.66, 12),            # cx,cz,w,h,d,yaw
              (0.66, 2.34, 0.62, 0.44, 0.58, -8)]
TOOL_BIN   = (0.0, 1.78, 1.02, 1.05, 0.46, 1.10)             # x,y,z, w,h,d
BENCH      = (-0.72, 1.78, 0.62, 0.70, 0.42, 0.90)

# A-frame lifting jib over the tail (body geometry, folded/stowed)
JIB_FEET   = [(-0.86, 1.56, 2.35), (0.86, 1.56, 2.35)]
JIB_PEAK   = (0.0, 3.32, 0.62)
JIB_BRACE_Y = 2.40
HOOK       = (0.0, 2.66, 0.62, 0.22, 0.30, 0.22)   # hanging hook block
WINCH      = (0.0, 1.86, 1.92, 0.62, 0.34, 0.40)

# team surfaces (world coords in the named zone): cab side door panel,
# hull-side ID square, deck ID square.
TEAM_CAB   = (-2.05, 2.45, -1.35, 1.95)     # CAB_SIDE (z0, y0, z1, y1)
TEAM_HULL  = (1.55, 1.35, 2.35, 0.95)       # HULL_SIDE (z0, y0, z1, y1)
