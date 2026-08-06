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
        "walled_odds": 0.45,
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
        "walled_odds": 0.30,
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
        "walled_odds": 0.60,
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
# Perimeter kit
# --------------------------------------------------------------------------
# Walls are carried as segments, corners and gates rather than as individual
# building slots, because the briefed def is a KIT (`ms_barricade_set`) whose
# pieces are not yet separable here. A consumer that has the kit stamps a
# piece per `span`; a consumer that does not can read `segments` as a fence
# polyline and draw nothing.

PERIMETER = {
    "span": 110,              # elmos of wall one kit piece covers
    "margin": 150,            # gap between the outermost lot and the wall
    "tower_every": 4,         # a tower every N spans, plus every corner
    "gate_width": 150,        # opening where a street leaves town
    "defs": {
        "wall": ["ms_barricade_set"],
        "corner": ["ms_barricade_set"],
        "gate": ["ms_barricade_set"],
        "tower": ["ms_watchtower", "ms_staticdefense_s1"],
    },
}


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
    """Same contract as `resolve_roles`, for the wall kit. Keys of PERIMETER['defs']."""
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


def resolve_landmarks(available) -> list[dict]:
    """The LANDMARKS rows whose feature def `available` has, order preserved.

    `available` here is a FEATURE roster, not `ms_defs.load()`'s unit facts —
    the two channels are separate all the way down (model-integration §M3).
    Callers with no feature roster at all pass an empty container and get an
    empty list, which is the correct behaviour in a clone where the featuredefs
    have not landed: no landmarks, rather than six units named after wrecks.
    """
    return [row for row in LANDMARKS if row["def"] in available]
