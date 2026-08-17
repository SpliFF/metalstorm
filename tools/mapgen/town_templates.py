#!/usr/bin/env python3
"""town_templates.py — the content half of the town planner.

Pure data, no logic, exactly as `scenario_templates.py` is pure data for the
scenario generator. Adding a fourth street archetype or a fifth lot role must
be a table entry here plus a builder in `town_planner.py`, never a new branch
threaded through the planner's control flow.

ROLES ARE NOT DEF NAMES, AND THAT IS THE POINT.
The planner emits a graph of LOTS carrying a *role* — the five in ROLE_ORDER
below. (Street-edge clutter is NOT a role: it is a separate list of decoration
SLOTS carrying a `kind`, because whether a crate becomes a feature, a
supply-dump prop or nothing at all is the consuming step's call.) Resolving a
role to an actual unit def is a separate, late step (`resolve_roles` below),
because the roster this lane was briefed against does not exist yet:

    briefed (model-integration M2/M3, NOT in units/ as of 2026-08-06)
        ms_shanty_block, ms_market_stalls, ms_meeting_hall, ms_water_works,
        ms_grain_silo, ms_barricade_set, ms_watchtower
    shipped today (data/games/metalstorm/units/)
        ms_habitat, ms_depot, ms_transit_hub, ms_staticdefense_s1..s4,
        ms_civilians, ms_militia, ms_civbus, ms_civtruck

Verified 2026-08-06: `grep -rn ms_shanty_block --include=*.lua .` matches
nothing — the models exist under tools/forge/samples/ but no unit def does.
So every role lists its briefed def FIRST and its shipped stand-in after, and
`resolve_roles` picks the first candidate the content actually ships. A town
graph planned today places habitats; the same graph, same seed, places shanty
blocks the day M2 lands, with no change here beyond the defs appearing.

LOT SIZES ARE SET BY THE REAL FOOTPRINTS, AND THAT IS NOT A DETAIL.
Measured 2026-08-06 via `ms_defs.load('data/games/metalstorm')`, a Metalstorm
civilian building is ENORMOUS in elmos: ms_habitat is footprint 12x12, and
`xsize = footprintx * SPRING_FOOTPRINT_SCALE` at 8 elmos a square makes that
192 elmos across. ms_depot and ms_transit_hub are 160; ms_foundry is 256.
Every `lot_size` below is therefore ~200 elmos, not the ~120 that "a house
plot" intuitively suggests, and `town_planner._block_pitch` derives the
distance between parallel streets from those numbers rather than from a
hand-picked spacing. The first cut of this file used 120x96 lots on a 260
block; two rows of lots overlapped by 28 elmos, and three lots in five were
silently thrown away by the overlap test. A town's density is a consequence of
the content's footprints, so it is computed from them.

That said, a lot is still a PARCEL, not a footprint check. Whoever stages
units into these lots must re-verify yardmap clearance against `ms_defs` —
this table cannot make a building fit.
"""

from __future__ import annotations

# --------------------------------------------------------------------------
# Street archetypes
# --------------------------------------------------------------------------
# Three patterns, chosen per-site by terrain (see `archetype_weights` in
# town_planner.py) and then distorted by it. The knobs are all lengths in
# elmos except where noted.
#
#   spacing        FLOOR on the distance between parallel streets, and the
#                  interval at which side lanes hang off a spine. The distance
#                  actually used between parallel streets is
#                  `town_planner._block_pitch`, which raises this until two
#                  rows of lots fit back to back — see the header.
#   frontage       how much street a single lot occupies
#   main_width     carriageway width of the town's primary street
#   lane_width     carriageway width of everything else
#   setback        gap between the carriageway edge and the lot boundary
#   lot_depth      how far back from the street a lot reaches
#   wander         how far (radians) a street may swing per step chasing flat
#                  ground; 0 would ignore the terrain entirely
#   jitter         seeded noise added to the flatness cost, so two runs on the
#                  same terrain and different seeds do not trace one line

STREET_ARCHETYPES = {
    # Flat, open, low-relief ground: a surveyed quarter. Regular blocks, two
    # perpendicular axes, shear rather than wander as the distortion.
    "grid_quarter": {
        "label": "Grid Quarter",
        "spacing": 260,
        "frontage": 210,
        "main_width": 80,
        "lane_width": 56,
        "setback": 34,
        "lot_depth": 200,
        "wander": 0.10,
        "jitter": 1.5,
        "max_shear": 0.22,          # radians at the town edge, scaled by distortion
        # A surveyed quarter on open ground is the archetype most likely to have
        # been laid out behind a line: see DEFENSE_TIERS.
        "defense_odds": {"open": 0.55, "stockade": 0.30, "fortified": 0.15},
    },
    # A valley floor, a ridge shoulder, a shoreline: one spine following the
    # contour, short lanes hanging off it. The archetype that reads as a road
    # someone built a town along, rather than a town someone drew streets on.
    "main_street": {
        "label": "Main Street",
        "spacing": 300,
        "frontage": 200,
        "main_width": 88,
        "lane_width": 52,
        "setback": 32,
        "lot_depth": 190,
        "wander": 0.34,
        "jitter": 3.0,
        "side_lane_len": (240, 520),   # seeded draw per lane
        "back_lane_odds": 0.55,
        # A town strung along a road is the hardest shape to wall — the
        # perimeter is long and thin for the ground it encloses — and mostly
        # nobody bothered.
        "defense_odds": {"open": 0.70, "stockade": 0.22, "fortified": 0.08},
    },
    # Broken, rolling or waterlogged ground: no survey survived it. A plaza,
    # radials that wander around what they cannot climb, part-rings that only
    # connect the radials they can reach.
    "organic_cluster": {
        "label": "Organic Cluster",
        "spacing": 280,
        "frontage": 190,
        "main_width": 76,
        "lane_width": 50,
        "setback": 30,
        "lot_depth": 180,
        "wander": 0.55,
        "jitter": 5.0,
        "plaza_radius": 170,
        "radials": (5, 8),             # seeded draw
        "rings": (1, 2),
        # Broken ground, a compact footprint and a plaza to defend: the
        # archetype that most often reads as a holdout.
        "defense_odds": {"open": 0.40, "stockade": 0.38, "fortified": 0.22},
    },
}

ARCHETYPES = sorted(STREET_ARCHETYPES)


# --------------------------------------------------------------------------
# Lot roles
# --------------------------------------------------------------------------
# `cap` is the ceiling on how many lots in one town may take the role;
# `unique = True` means EXACTLY one, which is the meeting hall's whole
# contract — it is the parley venue the scenario layer points objectives at,
# so a town with two of them or none is a bug, not a variation.
#
# `tier` is the RARITY the role reads as in play, and it is the reason the
# roles exist in tiers at all: `common` is the bulk a town is mostly made of,
# `uncommon` is a thing you notice, `unique` is a landmark you navigate by.
# The planner's own `SCARCE_SHARE` budget is what actually enforces the
# proportion; `tier` is the label that lets a consumer (and a debug dump) say
# which is which without re-deriving it from the budget.
#
# `roster` is the weighted content the STAGER draws from — several defs may
# express one role, and drawing between them is what stops a town's four
# dwelling rows from being one building repeated. `defs` below stays the
# ordered first-available LADDER (see `resolve_roles`); `roster` is the
# preference within it. A roster entry that the shipped content does not have
# simply loses, so this table can name the briefed roster before it exists.
#
# `distinct` means: prefer NOT to repeat a def within one town. The two
# utility lots should be the water works and the grain silo, not two water
# works — the roles are one role but the buildings are two different promises
# to the player about what this town does.
#
# `wants` is the siting preference the planner resolves against the lots it
# actually carved. Each is a scoring key implemented in town_planner.py:
#   central     small distance to the town centre
#   main        fronts a street of kind "main"
#   plaza       fronts the plaza (organic_cluster only; falls back to central)
#   low         low ground — the water works goes downhill of the town
#   water       near the site's water adjacency, if it has any
#   edge        far from the centre — silos and yards sit on the outskirts
#   corner      a lot near the perimeter hull, where walls and towers meet

LOT_ROLES = {
    "unique": {
        "label": "Meeting Hall",
        "unique": True,
        "tier": "unique",
        "wants": ["plaza", "main", "central"],
        "lot_size": (320, 280),
        "defs": ["ms_meeting_hall", "ms_transit_hub", "ms_habitat"],
        "roster": [("ms_meeting_hall", 1.0)],
    },
    "poi": {
        "label": "Point of Interest",
        "cap": 3,
        "tier": "uncommon",
        # "Market stalls as plaza anchors" — the brief's words, so the plaza
        # leads. The meeting hall still draws first and takes the best square
        # frontage; the market takes the next, which puts the two of them on
        # the same open space and gives an organic town a centre you can stand
        # in. On the two archetypes with no plaza this key is a constant across
        # every lot and contributes nothing, so `main` still decides — the
        # ranking is unchanged there, only its magnitude.
        "wants": ["plaza", "main", "central"],
        "lot_size": (280, 240),
        "defs": ["ms_market_stalls", "ms_transit_hub", "ms_depot"],
        # The market is what a POI lot is FOR — the plaza anchor the brief
        # names. The transit hub is here as texture at a fifth of the weight,
        # so a three-POI town reads as "a market and something else" rather
        # than as three identical stalls; it is not a second market.
        "roster": [("ms_market_stalls", 5.0), ("ms_transit_hub", 1.0)],
        "distinct": True,
    },
    "utility": {
        "label": "Utility",
        "cap": 2,
        "tier": "uncommon",
        "wants": ["low", "water", "edge"],
        "lot_size": (260, 240),
        "defs": ["ms_water_works", "ms_grain_silo", "ms_depot"],
        # Equal weights and `distinct`: a two-utility town gets one of each.
        "roster": [("ms_water_works", 1.0), ("ms_grain_silo", 1.0)],
        "distinct": True,
    },
    "defense": {
        "label": "Defensive Post",
        "cap": 4,
        "tier": "uncommon",
        "wants": ["corner", "edge"],
        "lot_size": (150, 140),
        "defs": ["ms_watchtower", "ms_staticdefense_s1"],
        # A town's own posts are watchtowers; a hard point is the scenario
        # layer's call, not the planner's, so staticdefense is a fallback
        # here and not a roll. T3 owns the perimeter's towers.
        "roster": [("ms_watchtower", 1.0)],
    },
    "bulk": {
        "label": "Dwellings",
        "tier": "common",
        "wants": [],
        "lot_size": (210, 190),
        "defs": ["ms_shanty_block", "ms_habitat"],
        # Six to one. A shanty town is shanty blocks; the occasional habitat
        # is the one house on the row that was built properly, and at this
        # weight a nine-lot town usually has one and sometimes none.
        "roster": [("ms_shanty_block", 6.0), ("ms_habitat", 1.0)],
    },
}

# The rarity ladder, coarse to fine. Ordered, because it is a ladder — a
# consumer sorting by rarity must not have to sort strings alphabetically and
# get common/unique/uncommon.
TIERS = ["common", "uncommon", "unique"]

# Drawn in this order when a town is populated, so the scarce roles claim the
# good lots before "bulk" takes what is left. Iterated as a list because dict
# order must never reach output (RULES OF DETERMINISM, scenariogen.py).
#
# `defense` is drawn ahead of `utility` even though it is the less important
# role, because it is the only one that wants ground nobody else does (corner
# and edge lots). Drawing it last meant the shared budget below was always
# spent by then and a town never got a gun inside its own wall — the towers on
# the perimeter kit were carrying the whole of "defenses" on their own.
ROLE_ORDER = ["unique", "poi", "defense", "utility", "bulk"]

# The share of a town's lots the non-dwelling roles may take, TOTAL. The `cap`
# values above are per-role ceilings for a town big enough to want them; this
# is what keeps a small town small in character.
#
# Measured before it existed: across 103 towns planned on four shipped maps,
# 76 had more special buildings than dwellings — a ten-lot village came out
# with a meeting hall, two markets, a silo AND a watchtower, which reads as a
# regional capital, not a shanty town. The brief's word is "occasional", and
# occasional is a proportion, not a count.
SCARCE_SHARE = 0.35


# --------------------------------------------------------------------------
# Defense tiers
# --------------------------------------------------------------------------
# The brief's ladder, in one table: "open hamlet (none) -> stockaded town
# (barricade wall/corner segments, gate on the main street) -> fortified
# compound (+ watchtowers at corners/entries, existing staticdefense at
# gates)". A town's tier is drawn per-seed from its archetype's `defense_odds`
# above, then gated on SIZE (`town_planner.choose_defense`) — a seven-lot
# hamlet is not a fortified compound however the dice fall.
#
# The tier decides WHAT is on the perimeter, never WHERE: the wall line, the
# gates and the terrain skips are pure geometry and identical across the two
# walled tiers, so the same town at `stockade` and at `fortified` has the same
# outline and the same gateways, with guns or without. That separation is what
# makes "three tiers" a content ladder a scenario author can reason about
# rather than three unrelated towns.
#
#   towers     watchtowers at every corner and beside every gateway, plus one
#              every `tower_every` wall pieces so a long straight run is not
#              blind. Emplacements, NOT wall pieces — see PERIMETER below.
#   gate_guns  one existing staticdefense beside each gateway, inside the line.
#
# Terrain is deliberately NOT an input to the tier. The archetype already
# carries the terrain read (organic_cluster is what broken ground chooses), and
# what the brief asks terrain to change is the wall's GEOMETRY — where it skips
# and where it anchors — which is `town_planner._build_perimeter`'s job.

DEFENSE_TIERS = {
    "open": {
        "label": "Open",
        "wall": False,
        "towers": False,
        "gate_guns": False,
    },
    "stockade": {
        "label": "Stockaded",
        "wall": True,
        "towers": False,
        "gate_guns": False,
    },
    "fortified": {
        "label": "Fortified",
        "wall": True,
        "towers": True,
        "gate_guns": True,
        "tower_every": 5,      # ...on top of one per corner and per gateway
    },
}

# Ordered weakest to strongest, because it is a ladder. Iterated as a list
# wherever a tier reaches output (RULES OF DETERMINISM, scenariogen.py).
DEFENSE_ORDER = ["open", "stockade", "fortified"]

# Below this many lots a town is a hamlet and cannot be `fortified` at all;
# at or above the second it draws the fortified weight at full strength, and
# in between the weight ramps. Measured over 96 towns on the six demo terrains:
# lots run 7..24 with a median of 17, so this makes the bottom fifth of the
# range hamlets and the top half eligible for a compound.
HAMLET_LOTS = 10
COMPOUND_LOTS = 16


# --------------------------------------------------------------------------
# Perimeter kit
# --------------------------------------------------------------------------
# Walls are carried as segments, corners and gates rather than as individual
# building slots, because the briefed def is a KIT (`ms_barricade_set`) whose
# pieces are not yet separable here. A consumer that has the kit stamps a
# piece per `span`; a consumer that does not can read the pieces as a fence
# polyline and draw nothing.
#
# TWO KINDS OF PIECE, AND THEY ARE NOT INTERCHANGEABLE.
#   the LINE      wall / corner / gate / anchor. These tile the wall's ring
#                 arc-for-arc: every elmo of the ring is covered by exactly one
#                 piece or by exactly one declared gap, which is what
#                 `town_planner.validate_perimeter` means by continuity.
#   EMPLACEMENTS  tower / gun. These sit INSIDE the line, on no arc at all, and
#                 are drawn only by the tiers that ask for them. Keeping them
#                 out of the line is what lets continuity be an equality rather
#                 than an "allowing for towers" — a spec with an exception in it
#                 is a spec nobody reads.
#
# THERE IS NO WALL IN THIS GAME TODAY, AND THERE IS NO STAND-IN EITHER.
# `ms_barricade_set` is model-integration M2 content that has not landed in
# this clone (verified 2026-08-06, same check as this file's header). Unlike a
# dwelling, a wall has no honest substitute in the shipped roster: the only
# things that would tile a line are the staticdefense turrets, and a stockade
# built out of gun turrets does not read as a stockade, it reads as the
# fortified tier — which would destroy the exact distinction this table exists
# to draw. So `wall`, `corner` and `gate` resolve to NOTHING today and say so
# by name (`StagedTown.gaps`), on the same principle as PROPS below, while
# `tower` and `gun` resolve to shipped staticdefense and are visible now.

PERIMETER = {
    "span": 110,              # elmos of wall one kit piece covers
    "thickness": 24,          # how much ground a wall piece takes across the line
    "margin": 150,            # gap between the outermost lot and the wall
    "post_span": 44,          # a gate post / cliff anchor, at a run's end
    "corner_span": 80,        # a corner post, straddling a vertex of the line

    # How many vertices the wall line may have, drawn per town. The lots' own
    # convex hull has 7 to 27 of them (measured, 96 towns) and is effectively a
    # circle, on which "a corner" means nothing and a fortified town would get
    # twenty watchtowers. `town_planner._simplify_hull` cuts it down to this by
    # extending edges OUTWARD to meet, so the line still contains every lot.
    "vertices": (5, 9),

    # Where a street leaves town. The opening is derived from the street it
    # serves and not fixed, because a fixed one is not wide enough: a gate post
    # flanking an 88-elmo main street at the old 150-elmo opening stood 75
    # elmos off the centreline, and `town_stager._Site.off_the_carriageway`
    # correctly refused it — the post was inside the carriageway's own
    # clearance. `gate_margin` is the room each post needs beside the road.
    "gate_width": 150,        # FLOOR on the opening
    "gate_margin": 72,        # ...plus this much either side of the street

    # WHICH STREETS LEAVE TOWN. A gateway is not put wherever a carriageway
    # happens to run out: `lane` is a side lane off a spine, `ring` is an
    # internal circuit and `plaza` is the square itself, and a wall with a hole
    # in it for each of those is not a wall. `main` and `street` are the through
    # routes, which is also what makes "a gate on the main street" true by
    # construction rather than by luck.
    "gate_kinds": ["main", "street"],
    # How close a through-street's END may be to the line and still count as a
    # road leaving town. MEASURED over 26 walled towns: `main` and `street` ends
    # sit 80 to 250 elmos inside the line at the quartiles, because T1's streets
    # terminate at the outermost LOTS and the line stands `margin` beyond them —
    # so a wall built only where a carriageway physically crosses it got no gate
    # at all in 20 of 34 walled towns. Sealed. `plaza` ends are never closer
    # than 488, which is the separation this number is set against.
    "gate_reach": 320,
    # Derived gateways only (a street that genuinely crosses the line always
    # gets one, or the road dead-ends into masonry). Four holes is a defended
    # town; eight is a colonnade.
    "max_gates": 4,

    "tower_inset": 96,        # a tower stands this far inside the line
    "gun_inset": 96,          # ...and a gate gun this far inside its gateway
    "gun_offset": 0.42,       # ...and this fraction of the opening off to one side
    # Nominal ground an emplacement takes, for the planner's own clearance
    # arithmetic only: the planner may not read a def, and the stager replaces
    # this with the real footprint the moment it knows which def it is placing.
    # 64 elmos is `ms_staticdefense_s2`, the largest thing `defs` below can
    # resolve a tower or a gun to.
    "emplacement_span": 64,
    # Towers, total. See `town_planner._emplacements`: without a cap a 6300-elmo
    # ring wants 22 of them, which is a fortress and not a town.
    "max_towers": 8,

    # Arc-length stride for the terrain scan along the line. Fine enough that a
    # single unbuildable heightmap sample (8 elmos) cannot hide between two
    # probes, coarse enough that a 6300-elmo ring is a few hundred samples.
    "probe_step": 8,

    # A surviving stretch of wall shorter than this is not a wall, it is a
    # stub between two cliffs. Skipped whole and reported as terrain, which is
    # what "cliff-anchor" means at the small end.
    "min_run": 200,

    "defs": {
        "wall": ["ms_barricade_set"],
        "corner": ["ms_barricade_set"],
        "gate": ["ms_barricade_set"],
        "anchor": ["ms_barricade_set"],
        "tower": ["ms_watchtower", "ms_staticdefense_s1"],
        # "existing staticdefense at gates" — the brief's own words, so this
        # one names shipped defs on purpose and has no briefed head. s2 over s1
        # because a gate gun should out-rank the town's own watchtowers.
        "gun": ["ms_staticdefense_s2", "ms_staticdefense_s1"],
    },
}

# The parts that tile the ring, in the order a reader should think about them,
# and the parts that do not. Asserted to partition `PERIMETER["defs"]` at
# import, so adding a part without deciding which kind it is fails loudly here
# rather than quietly falling out of the continuity spec.
LINE_PARTS = ["wall", "corner", "gate", "anchor"]
EMPLACEMENT_PARTS = ["tower", "gun"]

assert sorted(LINE_PARTS + EMPLACEMENT_PARTS) == sorted(PERIMETER["defs"]), (
    "every PERIMETER part must be declared either a line part or an "
    "emplacement: " + repr(sorted(PERIMETER["defs"])))


# --------------------------------------------------------------------------
# Street-edge decoration
# --------------------------------------------------------------------------
# Clutter is emitted as SLOTS, not as units or features: whether a crate ends
# up a feature, a supply-dump-style prop, or nothing at all is the consuming
# step's call. The planner's job is to say where the street edge has room.

DECOR = {
    "every": 180,             # elmos between candidate slots along a street
    "offset": 26,             # beyond the carriageway edge
    "odds": 0.55,             # seeded keep-rate, so edges are not metronomic
    "kinds": ["crate", "drum", "tarp", "barrel_stack", "cart"],
}


# --------------------------------------------------------------------------
# Props — what a decoration SLOT becomes
# --------------------------------------------------------------------------
# The staging half of DECOR above. A slot carries a kind; this says what
# content can express that kind, best first, and `resolve_props` keeps only
# what ships — same contract as `resolve_roles`.
#
# THE HONEST STATE OF THIS TABLE, 2026-08-06: there is no crate, no drum, no
# tarp and no cart in this game, and none is coming from the lanes that have
# landed. model-integration §M3 shipped the game's first eight featuredefs and
# they are three wrecks, two bridges and three ancient-tech relics — nothing
# street-scale. So four of the five kinds resolve to NOTHING, on purpose and
# visibly (`StagedTown.prop_gaps` reports them by name), and the fifth uses
# the brief's own escape hatch: "supply-dump-style dressing". `ms_supply_dump`
# is a real M2 building that reads as stacked goods, which is what a crate
# slot wants to be.
#
# One dump per street corner would be absurd, so `odds` here multiplies the
# slot's own keep-rate: a street gets an occasional pile, not a depot every
# 180 elmos. The real fix is three or four street-clutter featuredefs — that
# is an ask on the model lane, recorded via tasks_note, not something this
# table can invent.
PROPS = {
    "odds": 0.30,             # per-slot, ON TOP of DECOR["odds"]
    "defs": {
        "crate": ["ms_supply_dump"],
        "barrel_stack": ["ms_supply_dump"],
        "drum": [],
        "tarp": [],
        "cart": [],
    },
}


# --------------------------------------------------------------------------
# Landmarks — the occasional unique decoration
# --------------------------------------------------------------------------
# "Occasional unique decorations ... with low probability so towns surprise."
# These are FEATURES, not units (model-integration §M3): they stage through
# `world.features`, a different channel from a town's buildings, and a
# consumer without that channel drops them rather than spawning them as units.
#
# `where` is the siting rule, and the two are deliberately different reads:
#   yard  — inside a lot, BEHIND the building, in the space the frontage rule
#           leaves over. A tank wreck in someone's back yard is a story about
#           this town.
#   edge  — outside the outermost lots but inside the town hull. A dig site
#           on the outskirts is a story about the ground the town is on.
#
# `metres` is the measured glTF bound from model-integration's M3 note
# (rounded up), and it is here because a FEATURE has no `footprintx` this
# toolchain can read — `ms_defs.load` reads units/, and features live in
# features/*.lua behind a def channel that does not exist in this clone. The
# stager needs *some* honest number to clear ground with, so it converts these
# the same way M2 derived its building footprints (§M2 finding 5):
#
#     footprint squares = metres / 2        (DESIGN-MODEL-BUILDING §4)
#     elmos             = squares * 16      (ms_defs.FOOTPRINT_SCALE * 8)
#     therefore  elmos  = metres * 8        (`town_stager.METRES_TO_ELMOS`)
#
# So this is a DERIVED clearance, not a read one, and it is deliberately the
# model's full bound rather than its ground contact — a landmark is dressing
# and over-clearing it costs a town nothing. When the featuredefs become
# readable, replace the derivation with the def's own footprint and delete
# this column; `test_town_stager` pins the arithmetic so that swap is safe.
LANDMARKS = [
    {"def": "ms_tank_wreck",     "where": "yard", "weight": 3.0, "metres": (9, 11)},
    {"def": "ms_train_wreck",    "where": "edge", "weight": 1.0, "metres": (14, 21)},
    {"def": "ms_colossus_wreck", "where": "edge", "weight": 0.6, "metres": (18, 13)},
    {"def": "ms_dig_site",       "where": "edge", "weight": 1.5, "metres": (12, 12)},
    {"def": "ms_monolith_spire", "where": "edge", "weight": 0.8, "metres": (9, 9)},
    {"def": "ms_vault_door",     "where": "edge", "weight": 0.4, "metres": (20, 16)},
]

# Chance a town has ANY landmark, then how many it may have. Tuned so that
# across a run of seeds most towns have none — a surprise every town is not a
# surprise, it is a fixture.
LANDMARK_ODDS = 0.35
LANDMARK_MAX = 2


# --------------------------------------------------------------------------
# Populace — who is actually out on the streets
# --------------------------------------------------------------------------
# The one table in this file whose content ALL SHIPS. Unlike the wall kit and
# four of the five prop kinds, every def named below exists in
# data/games/metalstorm/units/ today (civilians.lua, civvehicles.lua), so a town
# populated from this table is visible in the client right now, on any map, with
# nothing gated behind model-integration.
#
# A populace entry is a KIND, not a def, for the same reason a lot carries a
# role: `residents` is "the people who live on this row", and whether that is a
# civilian group, a family or an ox-cart is the content's call. `resolve_populace`
# filters to what ships, exactly as `resolve_roles`/`resolve_props` do.
#
# THE FIVE KINDS AND WHERE EACH ONE GOES. The brief asks for "civilian units,
# vehicles ... civilians in streets/market, vehicles parked or on roads", and
# `where` below is that sentence made mechanical. Each value is a siting rule
# implemented in town_populace.py:
#
#   frontage     on the strip between a lot's frontage line and the carriageway
#                — the shoulder. Walked OUTWARD toward the road until the point
#                clears the building's real rectangle (see town_populace's
#                header: on a diagonal street the frontage line is INSIDE the
#                axis-aligned footprint, so a fixed offset does not exist).
#   yard         behind the building, in the depth the frontage rule leaves over
#                — the same ground `LANDMARKS['where'] = 'yard'` uses.
#   carriageway  ON the road, on its centreline. The one kind that WANTS the
#                carriageway every other placement rule in this toolchain
#                refuses.
#   gateway      at a hole in the wall, stepped in toward the town centre.
#
# `registry_role` is the role `GG.Civilians.Register` records, and it is the
# difference between population and guards. `ambient` is what
# civilians/routines.lua wanders and what estate.lua counts as a district's
# population; `garrison` is skipped by both, so militia hold their post at the
# gate instead of strolling off it. The role is a free string in the registry
# (game_civilians.lua), so `garrison` needs no gadget change to be honoured —
# only for the two consumers to keep filtering on `ambient`, which they do.

POPULACE = {
    "residents": {
        "label": "Residents",
        "where": "frontage",
        # Every role except `defense`: a watchtower has no doorstep.
        "lot_roles": ["bulk", "unique", "utility"],
        "odds": 0.55,              # seeded keep-rate per eligible lot
        "registry_role": "ambient",
        "defs": [("ms_civilians", 1.0)],
    },
    "market": {
        "label": "Market crowd",
        "where": "frontage",
        "lot_roles": ["poi"],
        "odds": 1.0,               # a market with nobody at it is not a market
        # Extra groups on the SAME frontage, spread along it — the one place in
        # a town where people are meant to be shoulder to shoulder.
        "extra": (1, 2),
        "registry_role": "ambient",
        "defs": [("ms_civilians", 1.0)],
    },
    "parked": {
        "label": "Parked vehicles",
        # The yard behind the building if this lot has one, the kerb beside it
        # if not. MEASURED: on this content the yard usually does NOT exist —
        # `lot_size` above is derived from the footprint the lot has to hold, so
        # a 192-elmo habitat in a 190-deep parcel leaves no back yard at all,
        # and a diagonal street costs the parcel depth at both ends. A rule with
        # a 100% failure rate is not a rule, so `parking` is the pair.
        "where": "parking",
        # Where a town's work traffic actually stands: the depot yard, the
        # market's back lot, the silo. Not outside a house.
        "lot_roles": ["poi", "utility"],
        "odds": 0.7,
        "registry_role": "ambient",
        "defs": [("ms_civtruck", 3.0), ("ms_civbus", 1.0)],
    },
    "traffic": {
        "label": "Road traffic",
        "where": "carriageway",
        # Through routes only, and the same two kinds a GATEWAY is cut for
        # (PERIMETER['gate_kinds']): a lorry parked across a back lane or a
        # plaza is not traffic, it is an obstruction.
        "street_kinds": ["main", "street"],
        "odds": 0.5,               # per eligible street
        "max": 3,
        "registry_role": "ambient",
        "defs": [("ms_civtruck", 2.0), ("ms_civbus", 1.0)],
    },
    "militia": {
        "label": "Militia",
        "where": "gateway",
        # Only a town that built a wall mans it. An open hamlet's defence is
        # that nobody has come for it yet.
        "tiers": ["stockade", "fortified"],
        "odds": 1.0,               # per gateway
        "max": 4,
        # NOT `ambient`: routines.lua would walk them off the gate they were
        # posted to, and estate.lua would count armed volunteers as the
        # population a protect-objective is about.
        "registry_role": "garrison",
        "defs": [("ms_militia", 1.0)],
    },
}

# Drawn in this order, so the kinds with the fewest legal positions claim their
# ground before the ones that can go anywhere. Iterated as a list because dict
# order must never reach output (RULES OF DETERMINISM, scenariogen.py).
POPULACE_ORDER = ["militia", "market", "parked", "traffic", "residents"]

assert sorted(POPULACE_ORDER) == sorted(POPULACE), (
    "every POPULACE kind must appear in POPULACE_ORDER: " +
    repr(sorted(POPULACE)))

# A HARD CEILING on civilians per town, applied after every kind has drawn.
# `ms_civilians` carries `squad_size = 12`, so one placement is twelve rendered
# bodies: a 24-lot town drawing residents at 0.55 is thirteen groups, i.e. ~156
# people, before the market. Three towns of that size is a bigger crowd than
# either army. The cap is on PLACEMENTS, and it drops the last kinds drawn
# (`residents` — the most numerous and the least individually meaningful),
# reporting what it dropped rather than quietly thinning the town.
MAX_POPULACE = 16


# --------------------------------------------------------------------------
# Naming
# --------------------------------------------------------------------------
# Deliberately the same register as regions_from_map.name_for's output, which
# the planner reuses for the town's own name — these are the qualifiers a
# street gets, so "Kessel Reach" can have a "Kiln Row" running through it.
STREET_NAMES = [
    "Kiln", "Tannery", "Ash", "Cistern", "Quarry", "Ferry", "Mill", "Salt",
    "Foundry", "Chandler", "Rope", "Gate", "Weigh", "Barrow", "Pitch",
]
STREET_SUFFIXES = ["Row", "Walk", "Way", "Lane", "Rise", "Cut", "Steps"]


def resolve_roles(available: set[str] | frozenset[str] | dict) -> dict[str, str]:
    """role -> the best def for it that `available` actually contains.

    `available` is anything supporting `in` — in practice `ms_defs.load()`'s
    dict, keyed by def name. A role whose candidates are ALL missing is left
    out of the result rather than defaulted: the caller then knows the town
    cannot express that role today, instead of silently placing a habitat
    where a meeting hall was promised and calling the objective satisfied.

    Returns a plain dict; callers that emit must iterate ROLE_ORDER, not this.
    """
    out = {}
    for role in ROLE_ORDER:
        for defname in LOT_ROLES[role]["defs"]:
            if defname in available:
                out[role] = defname
                break
    return out


def resolve_perimeter(available) -> dict[str, str]:
    """Same contract as `resolve_roles`, for the wall kit. Keys of PERIMETER['defs'].

    A part with no content is LEFT OUT, which today is every line part — see
    PERIMETER's header for why a stockade gets no stand-in. So in this clone
    this returns `{'gun': ..., 'tower': ...}` and the caller reports the rest as
    a gap, rather than tiling a town's boundary with gun turrets.
    """
    out = {}
    for part in sorted(PERIMETER["defs"]):
        for defname in PERIMETER["defs"][part]:
            if defname in available:
                out[part] = defname
                break
    return out


def role_options(available) -> dict[str, list[tuple[str, float]]]:
    """role -> the weighted defs the stager may draw from, filtered to `available`.

    The richer sibling of `resolve_roles`, and the one the staging step wants:
    `resolve_roles` answers "which ONE def is this role today", which is the
    right question for a graph dump and the wrong one for a town, where four
    dwelling lots drawing the same answer four times is the failure mode.

    Falls back to the `defs` ladder — the whole ladder, at equal weight, not
    just its head — when none of the roster's preferred defs ships. That
    fallback is what makes a town planned in THIS clone (no M2 buildings) still
    vary its dwellings between `ms_shanty_block`'s stand-ins instead of
    stamping one def down every row.

    A role with nothing available at all is omitted, exactly as
    `resolve_roles` omits it: the caller must be able to see that the town
    cannot express the role today rather than get a silent substitution.
    """
    out: dict[str, list[tuple[str, float]]] = {}
    for role in ROLE_ORDER:
        spec = LOT_ROLES[role]
        picks = [(d, w) for d, w in spec.get("roster", ()) if d in available]
        if not picks:
            picks = [(d, 1.0) for d in spec["defs"] if d in available]
        if picks:
            out[role] = picks
    return out


def resolve_props(available) -> dict[str, str]:
    """decoration kind -> the def that expresses it, for the kinds that ship.

    Kinds with no content are LEFT OUT rather than mapped to something
    approximate. See PROPS' header: four of the five have no content in this
    game and pretending otherwise would put a supply dump where a tarp was
    promised, on every street, in every town.
    """
    out = {}
    for kind in DECOR["kinds"]:
        for defname in PROPS["defs"].get(kind, ()):
            if defname in available:
                out[kind] = defname
                break
    return out


def populace_options(available) -> dict[str, list[tuple[str, float]]]:
    """kind -> the weighted defs it may draw from, filtered to `available`.

    Same contract as `role_options`, and the same reason: a town whose two
    parked vehicles are both cargo trucks reads as a depot, not as a town.
    A kind with nothing available is OMITTED rather than substituted, so the
    caller can report by name that this game cannot express it — which today is
    no kind at all, since every def POPULACE names ships.
    """
    out: dict[str, list[tuple[str, float]]] = {}
    for kind in POPULACE_ORDER:
        picks = [(d, w) for d, w in POPULACE[kind]["defs"] if d in available]
        if picks:
            out[kind] = picks
    return out


def resolve_landmarks(available) -> list[dict]:
    """The LANDMARKS rows whose feature def `available` has, order preserved.

    `available` here is a FEATURE roster, not `ms_defs.load()`'s unit facts —
    the two channels are separate all the way down (model-integration §M3).
    Callers with no feature roster at all pass an empty container and get an
    empty list, which is the correct behaviour in a clone where the featuredefs
    have not landed: no landmarks, rather than six units named after wrecks.
    """
    return [row for row in LANDMARKS if row["def"] in available]
