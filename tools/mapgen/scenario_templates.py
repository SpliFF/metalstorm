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

    civilian buildings   ms_habitat, ms_depot, ms_transit_hub
    military buildings   ms_command_nexus, ms_garrison, ms_foundry,
                         ms_airbase, ms_shipyard
    defenses             ms_staticdefense_s1..s4
    mobile               ms_civilians, ms_militia, ms_civbus, ms_civtruck,
                         plus the ms_<class>_s<1..4> families

CONTENT GAPS (PLAN-metalstorm-scenariogen.md §9 — for a content lane, NOT this
one). There is no mine, port, road or bridge def, and no resource-site concept
at all. Per the plan's mapping decision:
  * mines   → the `mine` template below: ms_depot on highland, "Extraction
              Site" in the display name only. Cosmetic — it produces nothing,
              but it is a legitimate capture target today.
  * ports   → NOT SHIPPED. Two blockers: ms_shipyard is a factory, not a port,
              and (decisively) no target map's region graph carries a `water`
              tag, so there is no region a port could be placed in. Measured:
              `grep -l '"water"' data/maps/*/mapdata/regions.lua` matches
              meridian_basin only, the one map this lane must not target.
  * roads / bridges → terrain, not units. They would change the passability
              mask and therefore the region graph, so they belong upstream of
              scenario generation (terragen), not inside it.
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
        "garrison": [
            ("ms_soldiers_s1",  3, 1, 3),
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
        "garrison": [
            ("ms_tanks_s2",    3, 1, 3),
            ("ms_soldiers_s2", 3, 1, 3),
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
            ("ms_civilians", 3, 1, 2),
            ("ms_militia",   2, 0, 1),
        ],
    },
}

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
