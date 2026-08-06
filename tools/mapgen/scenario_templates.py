#!/usr/bin/env python3
"""scenario_templates.py — the content half of the scenario generator.

Pure data, no logic (PLAN-metalstorm-scenariogen.md §5, task 1). Adding a
fourth cluster kind ("listening post", "shipyard town") must be a table entry
here, not a new code path in scenariogen.py.

TOWN vs OUTPOST IS AN ASSET MIX, NOT TWO FUNCTIONS. The user's definition is
literally about proportions — "the primary difference being the mix of civilian
and military assets; outposts are more likely to have strong defenses and
barrages" — so the mix is the data. Read the civilian↔military axis straight
off the weights below rather than trying to recover it from control flow.

Every def named here exists in data/games/metalstorm/units/ and is checked
against the real content at generation time (ms_defs.verify). The COMPLETE
shipped inventory a cluster can draw on is:

    civilian buildings   ms_habitat, ms_depot, ms_transit_hub,
                         ms_meeting_hall, ms_shanty_block, ms_market_stalls
    military buildings   ms_command_nexus, ms_garrison, ms_foundry,
                         ms_airbase, ms_shipyard
    support buildings    ms_command_post, ms_watchtower, ms_comms_relay,
                         ms_field_workshop, ms_supply_dump, ms_water_works,
                         ms_rail_platform, ms_pontoon_wharf, ms_mooring_mast,
                         ms_barricade_set
    resource sites       ms_grain_silo, ms_oil_derrick, ms_tank_farm,
                         ms_timber_yard, ms_metal_pit, ms_port_crane
    defenses             ms_staticdefense_s1..s4
    mobile               ms_civilians, ms_militia, ms_civbus, ms_civtruck,
                         ms_technical, ms_scout_buggy, ms_supply_truck,
                         ms_courier_car, ms_fuel_tanker, ms_expedition_rig,
                         ms_command_s2, plus the ms_<class>_s<1..4> families
    features (§M3)       ms_colossus_wreck, ms_tank_wreck, ms_train_wreck,
                         ms_road_bridge, ms_rail_bridge, ms_vault_door,
                         ms_dig_site, ms_monolith_spire

THE CONTENT GAPS ARE CLOSED (2026-08-06, PLAN-metalstorm-model-integration §M4).
The note that used to sit here said there was no mine, port, road or bridge def
and no resource-site concept at all. There now is: §M2 shipped
units/buildings_sites.lua (six capturable Gaia resource sites, each carrying its
own `customparams.site_kind`) and §M3 shipped data/games/metalstorm/features/
(wrecks, road/rail bridge spans, ancient-tech relics). What each gap turned into:

  * mines   → the `mine` template still exists, but a generated scenario no
              longer has to mime one with a depot: SITE_TEMPLATES below places
              a real `ms_metal_pit` headframe, named after its region.
  * ports   → shippable, and the old blocker was diagnosed one level too high.
              It was never about region TAGS: `ms_port_crane` needs water under
              the berth, and water is a property of the HEIGHTMAP, which every
              map has and which this generator already reads for every other
              decision it makes. `SITE_TEMPLATES['ms_port_crane']['needs_water']`
              is graded against the mask, exactly like passability.
  * roads / bridges → bridges are FEATURES now, not units and not terrain, so
              they neither change the passability mask nor need terragen. See
              BRIDGE_SPANS below and §M3's finding that a span belongs over a
              WATER gap: `floating = true` keeps a chain level on water, while
              over dry ground the engine's unconditional ground clamp still
              steps each segment with the terrain.
"""

# --------------------------------------------------------------------------
# Cluster templates
# --------------------------------------------------------------------------
# buildings / garrison entries are (def, weight, min, max):
#   min   always placed
#   max   ceiling on the seeded draw
#   weight relative odds of each extra draw beyond `min`
#
# `prefers` is a ranked tag preference resolved against the map's region graph;
# a template whose preferred tags do not occur on a map falls back to any
# buildzone region rather than failing (§1.6: generated graphs only ever emit
# home/island/water/highland/plain/buildzone/chokepoint, and in practice only
# the last five).

CLUSTER_TEMPLATES = {
    "town": {
        "label": "Township",
        "radius": 420,
        "prefers": ["plain", "buildzone"],
        # Civilian-leaning: three civilian buildings to at most one token gun
        # nest. A town that can defend itself is an outpost.
        "buildings": [
            ("ms_habitat",          5, 1, 3),
            ("ms_depot",            3, 0, 2),
            ("ms_transit_hub",      2, 0, 1),
            ("ms_staticdefense_s1", 1, 0, 1),
        ],
        "garrison": [
            ("ms_civilians", 4, 1, 3),
            ("ms_militia",   2, 0, 2),
        ],
    },
    "outpost": {
        "label": "Outpost",
        "radius": 380,
        "prefers": ["chokepoint", "highland", "buildzone"],
        # Military-leaning, and the literal answer to "strong defenses and
        # barrages": s2/s3 carry autocannon/railgun plus flak, and s4 is the
        # Bastion gun carrying MS_HOWITZER_S4 (units/staticdefense.lua).
        "buildings": [
            ("ms_garrison",         5, 1, 2),
            ("ms_staticdefense_s2", 4, 1, 3),
            ("ms_staticdefense_s3", 2, 0, 2),
            ("ms_staticdefense_s4", 1, 0, 1),
            ("ms_depot",            1, 0, 1),
        ],
        # An outpost's mobile half is a raider picket, and §M1's gun truck is
        # exactly that silhouette (worldbuilding §4: the Anarchic archetype's
        # signature). The buggy is its eyes — cheap, fast, unarmed, and the one
        # thing on the board whose wheels visibly spin when it moves.
        "garrison": [
            ("ms_soldiers_s1",  3, 1, 3),
            ("ms_technical",    3, 1, 2),
            ("ms_scout_buggy",  2, 0, 1),
            ("ms_artillery_s2", 1, 0, 1),
        ],
    },
    "base": {
        "label": "Forward Base",
        "radius": 600,
        "prefers": ["buildzone", "plain"],
        "buildings": [
            ("ms_command_nexus",    3, 1, 1),
            ("ms_foundry",          3, 0, 1),
            ("ms_airbase",          2, 0, 1),
            ("ms_garrison",         3, 1, 2),
            ("ms_staticdefense_s3", 4, 2, 4),
            ("ms_staticdefense_s4", 2, 0, 2),
        ],
        # A forward base is the one cluster with a supply tail worth drawing:
        # the truck and the command track are what distinguish it from a big
        # outpost. Both are §M1 defs.
        "garrison": [
            ("ms_tanks_s2",     3, 1, 3),
            ("ms_soldiers_s2",  3, 1, 3),
            ("ms_supply_truck", 2, 1, 2),
            ("ms_command_s2",   1, 0, 1),
        ],
    },
    # The "strategic resource" the shipped inventory can actually express.
    # See the CONTENT GAPS note above: this is a depot on high ground, not an
    # extractor — nothing in PLAN-metalstorm-economy.md produces from it.
    "mine": {
        "label": "Extraction Site",
        "radius": 300,
        "prefers": ["highland", "plain"],
        "buildings": [
            ("ms_depot",            4, 1, 2),
            ("ms_transit_hub",      2, 0, 1),
            ("ms_staticdefense_s2", 2, 0, 2),
        ],
        "garrison": [
            ("ms_civilians",    3, 1, 2),
            ("ms_militia",      2, 0, 1),
            ("ms_supply_truck", 2, 0, 1),   # ore has to leave somehow
        ],
    },
}

# --------------------------------------------------------------------------
# Resource sites (§M4 — PLAN-metalstorm-worldbuilding.md decision 1)
# --------------------------------------------------------------------------
# A site is ONE named building on Gaia, not a cluster. It is the thing the
# setting's economy is about — the silo, the derrick, the sawmill — and the
# thing the command language points at ("hold the Raven Basin silos"). Income
# stays Authority (worldbuilding decision 3): a site is worth taking because it
# is an objective anchor and a place the story names, not because it pays.
#
# `prefers` is ranked against the region's tags, the same convention
# CLUSTER_TEMPLATES uses. `needs_water` sends the placer looking for a berth
# instead of a clearing — the port crane is the only one, and it is why the
# old "ports cannot ship" note is retired (see the module docstring).
#
# `noun` is the display half of the minted name. The other half is the REGION'S
# OWN name, so a site inherits the register `name_for()` already established for
# the map and a player can find it from a name they have already seen on the
# overlay. Nothing here invents a second naming vocabulary.
SITE_TEMPLATES = {
    "ms_timber_yard": {
        "noun": "Timber Yard", "prefers": ["plain", "buildzone"],
        "needs_water": False,
    },
    "ms_metal_pit": {
        "noun": "Metal Pit", "prefers": ["highland", "chokepoint"],
        "needs_water": False,
    },
    "ms_grain_silo": {
        "noun": "Grain Silo", "prefers": ["plain", "buildzone"],
        "needs_water": False,
    },
    "ms_oil_derrick": {
        "noun": "Oil Derrick", "prefers": ["highland", "plain"],
        "needs_water": False,
    },
    "ms_tank_farm": {
        "noun": "Tank Farm", "prefers": ["buildzone", "plain"],
        "needs_water": False,
    },
    "ms_port_crane": {
        "noun": "Port Crane", "prefers": ["water", "island", "plain"],
        "needs_water": True,
    },
}

# Ranked order the site layer draws in, so a scenario asked for three sites gets
# a spread of KINDS rather than three silos. Explicit rather than sorted(dict)
# because the order is a design decision (the two most legible silhouettes
# first) and because nothing that reaches output may iterate a dict.
SITE_DRAW_ORDER = ["ms_grain_silo", "ms_metal_pit", "ms_oil_derrick",
                   "ms_timber_yard", "ms_tank_farm", "ms_port_crane"]


# --------------------------------------------------------------------------
# Ancient-tech prize sites (§M4 — worldbuilding directive 4)
# --------------------------------------------------------------------------
# These are FEATURES, not units: features/ancient.lua ships them, and §M3
# established that a feature is placed history — it blocks, it is named, and it
# does not animate (FeatureRenderer thin-instances one mesh per def, so the
# spire's authored ring orbit goes unplayed; recorded in that def's
# customParams.static_clip_unplayed).
#
# The PRIZE is therefore not the relic itself but the ground it stands on: the
# site layer pairs each relic with a tactical control objective on its region
# and, optionally, a guardian band. That is the only shape available without
# promoting these three to capturable Gaia unitdefs, which §M3 recorded as the
# escape hatch and which is deliberately NOT taken here — two new unitdefs to
# animate two props is the wrong trade.
ANCIENT_SITES = {
    "ms_vault_door": {"noun": "Vault"},
    "ms_dig_site":   {"noun": "Dig"},
    "ms_monolith_spire": {"noun": "Spire"},
}
ANCIENT_DRAW_ORDER = ["ms_monolith_spire", "ms_vault_door", "ms_dig_site"]

# The band squatting on a relic. Anarchic archetype (worldbuilding §4 amendment,
# the Reaver garrison/raid/toll template), which is what ms_technical is FOR —
# a scrap gun truck is the signature of a gang that found something valuable and
# is sitting on it, in a way a line tank never reads as.
ANCIENT_GUARDIANS = [
    ("ms_technical",   2, 1, 2),
    ("ms_militia",     2, 1, 3),
    ("ms_soldiers_s1", 1, 0, 2),
]


# --------------------------------------------------------------------------
# Features: wreck fields and bridge spans (§M4)
# --------------------------------------------------------------------------
# Wrecks are scattered where a war has already been fought — the contested
# ground both armies are now marching toward. Weighted so a field reads as
# skirmish debris with the occasional heavy loss, not a scrapyard: many tank
# hulls, one train, rarely a colossus.
#
# THEY BLOCK. features/wrecks.lua sets `blocking = true` (that is what makes a
# wreck cover rather than scenery), so the generator stamps every placed wreck
# into the passability mask and RE-RUNS the reachability gate afterwards. A
# wreck field that walls off the crossing it decorates is the same class of bug
# as a bridge that does — see scenariogen.gate_reachability.
WRECK_FIELD = [
    ("ms_tank_wreck",     6),
    ("ms_train_wreck",    2),
    ("ms_colossus_wreck", 1),
]

# NOTE — there is deliberately no wreck-extent table here. How much ground a
# wreck blocks is a featuredef fact, and scenariogen reads it straight out of
# features/*.lua (`load_feature_facts`). A copy in this file would be a copy of
# a number the reachability gate depends on, and a stale copy of a gate's input
# disarms the gate instead of failing it — the same argument ms_defs.py's
# docstring makes about unit footprints. The first draft of this file DID
# tabulate it, in metres, and packed five wrecks into 180 elmos because the
# engine blocks in footprint squares, not metres.

# Bridge spans. Both chain on their local Z at a 24.0 m pitch published by the
# def itself (`customParams.chain_pitch`), so a scenario never restates it —
# game_scenario.lua's featureChainPitch reads the def.
#
# ROAD, NOT RAIL, is the default and the only one placed automatically: a rail
# span implies a rail line, and nothing in a generated scenario lays one. The
# rail span stays available for hand-authored scenarios.
BRIDGE_SPANS = {
    "road": "ms_road_bridge",
    "rail": "ms_rail_bridge",
}
BRIDGE_NOUN = "Crossing"

# A span is 24 m of deck. Chaining more than this many segments across one gap
# means the "gap" is open water, not a river, and a 40-span causeway is not a
# bridge — it is a landfill. The placer looks for another crossing instead.
MAX_BRIDGE_SPANS = 24


# --------------------------------------------------------------------------
# Army rosters
# --------------------------------------------------------------------------
# One entry per staged `units` row: (def, count, spacing). The loader spreads
# `count` copies on a square-ish grid itself (game_scenario.lua gridOffsets), so
# this is one row rather than N — and it is the shape stagedForceByTeam's
# count-weighted centroid already understands.
#
# The roster deliberately mixes movement classes: ms_tanks_s3 is HEAVY (24 deg
# max slope), soldiers are INFANTRY (45 deg). The generator verifies BOTH masks,
# because a roster graded only on VEH reproduces the Meridian failure one class
# down — that is invariant 5, not a nicety.

ARMY_ROSTERS = {
    "standard": [
        ("ms_tanks_s2",     4, 150),
        ("ms_tanks_s3",     2, 180),   # HEAVY — forces the strict mask check
        ("ms_soldiers_s1",  6, 100),
        ("ms_artillery_s2", 2, 160),
        ("ms_engineers_s1", 2, 120),
        # §M1 wheeled natives. Neither changes the contestability arithmetic:
        # that reads the SLOWEST staged unit, and ms_artillery_s2 (35.7
        # elmos/s) is slower than both the buggy (126) and the truck (78). They
        # are here because a landing party without eyes or a supply tail is a
        # roster, not a force — and because they are the two units in the game
        # whose wheels visibly turn, which makes them the live proof that
        # wheel-spin-driver.ts is wired.
        ("ms_scout_buggy",  2, 130),
        ("ms_supply_truck", 2, 140),
        ("ms_radar_s1",     1, 0),     # immobile: staged, but never a path gate
    ],
    "light": [
        ("ms_tanks_s1",    4, 140),
        ("ms_soldiers_s1", 6, 100),
        ("ms_engineers_s1", 1, 120),
    ],
}

# --------------------------------------------------------------------------
# Naming
# --------------------------------------------------------------------------
# The region half of a generated name comes from regions_from_map.py's
# `name_for()` — reused rather than reinvented so generated scenarios sit in the
# same register as the hand-authored map ("Meridian Basin — Standard War") and
# as the names the AI debug output and client overlay already surface.
SCENARIO_SUFFIXES = [
    "Standoff", "Gambit", "Crossing", "Reckoning", "Vigil", "Ultimatum",
    "Bulwark", "Salient", "Interdiction", "Watchfire", "Encirclement", "Redoubt",
]

# Faction keys for the two playable sides. `gamedata/sidedata.lua` is still an
# inert stub — factions are not mechanically differentiated yet — so these are
# labels, exactly as meridian_basin.lua and scenario_smoke_test.lua use them.
# They must not contain ',' or ':': ScenarioDiscovery::EncodeWarSides packs
# them into the `war_sides` modoption split on both, and drops any side whose
# faction key would reshape the list.
PLAYABLE_FACTIONS = ["compact", "union", "syndicate", "covenant",
                     "concord", "remnant"]

# The NPC faction that owns hostile clusters. One team, declared in `sides` and
# `ai`, exactly as meridian_basin.lua does for the Basin Reavers: every non-Gaia
# team is its own ally team (Simulation.cpp "each non-Gaia team is its own ally
# team"), so it is hostile to both players with no extra configuration.
HOSTILE_FACTION = "marauders"

# `ai.slate.kinds` is validated hard by the loader against AI_SLATE_KINDS
# (game_scenario.lua:60) — a typo produces an AI that boots and then silently
# never acts, so only these three names are legal.
HOSTILE_SLATE_KINDS = ["garrison", "raid"]
