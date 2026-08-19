"""ms_road_bridge_layout — zones + dims for ms_road_bridge.

Terrain feature: 24 m road bridge segment.  Riveted steel truss sides,
cracked concrete deck slabs, pier footings.  TILEABLE along z: the deck
runs exactly z = -12 .. +12 at full width at both ends so segments chain
seamlessly (truss end posts sit just inside the ends so chained posts
pair up instead of z-fighting).  Static, single `body` piece, no clips,
no team colour.  Frame: forward -Z, up +Y, 1 u = 1 m.

NOTE for integrators: the SHIPPED mesh has y = 0 AT THE ROADWAY, not at
the pier base — see DECK_ORIGIN_Y below.  Every dimension in this file
is in the original pier-base frame and the shift is applied once at the
end of gen's build_all(), so subtract DECK_ORIGIN_Y (1.5) from any
constant here to get a shipped y: the roadway ships at 0.00, the kerb
tops at 0.22, the model floor at -1.50.
"""
import meshlib
meshlib.ATLAS = 2048
from meshlib import Zone

# ── tileable envelope ────────────────────────────────────────────────────
Z0, Z1     = -12.0, 12.0
DECK_W     = 8.0                     # roadway x -4 .. +4
DECK_TOP   = 1.5                     # deck surface height
DECK_BOT   = 0.9                     # deck slab underside
KERB_W     = 0.45
KERB_TOP   = 1.72

# ── ORIGIN AT THE DECK (PLAN-maps.md §2j option A, 2026-08-19) ───────────
# Everything below is authored in the ORIGINAL frame, whose y = 0 is the
# pier base, because every atlas Zone above maps a world y to a v and
# re-basing the constants would re-base the UVs with them.  The whole part
# is translated down by DECK_ORIGIN_Y once, in gen's `build_all()`, AFTER
# the UVs are assigned — so the shipped mesh has y = 0 AT THE ROADWAY
# SURFACE and the substructure runs negative, where an abutment buries it.
#
# WHY: `CFeature::UpdatePosition` clamps a feature's y UP to the ground and
# never down, so a span authored origin-at-pier-base always decked
# DECK_TOP above the terrain a unit drives on, and raising the terrain
# raised the span with it — the gap was invariant under every earthwork.
# With the origin at the deck the two coincide, on any terrain.
# `features/bridges.lua` publishes the matching `customparams.deck_top`
# (now 0 — the deck IS the origin); if you ever move this, move that.
DECK_ORIGIN_Y = DECK_TOP             # 1.5 — the surface that becomes y = 0

# ── truss (riveted steel, both sides at x = ±TRUSS_X) ────────────────────
TRUSS_X    = 4.28                    # truss plane, outboard of the kerb
BC_Y       = 1.25                    # bottom chord centre y
BC_SZ      = (0.36, 0.55)            # bottom chord (x, y) section
TC_Y       = 4.32                    # top chord centre y
TC_SZ      = (0.30, 0.40)            # top chord (x, y) section
POST_Y0, POST_Y1 = 1.52, 4.10        # vertical member run
POSTS_Z    = [-11.62, -9.0, -6.0, -3.0, 0.0, 3.0, 6.0, 9.0, 11.62]
SWAYS_Z    = [-9.0, -3.0, 3.0, 9.0]  # overhead sway braces (portal beams)
SWAY_Y     = 4.32

# ── deck structure ───────────────────────────────────────────────────────
FLOORB_Z   = [-9.0, -6.0, -3.0, 0.0, 3.0, 6.0, 9.0]  # floor beams under deck
FLOORB_SZ  = (0.28, 0.5)             # beam (y, z) section, spans full width

# ── pier footings (concrete, under the floor system) ─────────────────────
PIERS_Z    = [-6.0, 6.0]
PIER_SZ    = (8.9, 0.9, 1.7)         # w, h, d — skip -y

# ── atlas zones (2048²; v down) ──────────────────────────────────────────
Z_DECK   = Zone((0,    0,    1536, 512),  ('z', 'x'), ((-12.0, 12.0), (-4.35, 4.35)))
Z_DECKS  = Zone((0,    512,  1536, 600),  ('z', 'y'), ((-12.0, 12.0), (1.55, 0.85)))
Z_DECKB  = Zone((0,    600,  1536, 728),  ('z', 'x'), ((-12.0, 12.0), (-4.35, 4.35)))
Z_KERB   = Zone((0,    728,  1536, 792),  ('z', 'y'), ((-12.0, 12.0), (1.78, 1.42)))
# chord side faces: one tall v window covers both chord heights; rivet rows
# are painted at the correct v for each chord in the painter.
Z_CHORD  = Zone((0,    792,  1536, 920),  ('z', 'y'), ((-12.0, 12.0), (4.75, 0.75)))
Z_PIER   = Zone((1536, 0,    1980, 256),  ('x', 'y'), ((-4.7, 4.7), (1.0, -0.1)))
Z_STEEL  = Zone((1536, 256,  1792, 448),  ('z', 'y'), ((-45, 45), (25, -5)))
Z_DARK   = Zone((1792, 256,  1920, 384),  ('x', 'z'), ((-45, 45), (-45, 45)))
