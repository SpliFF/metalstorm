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
    # ----------------------------------------------------------------------
    # The two coverage clusters (full-coverage war, 2026-08-18)
    # ----------------------------------------------------------------------
    # These exist because eleven shipped building defs were placeable by
    # nothing. The town/outpost/base/mine mix above plus town_templates.py
    # reaches 24 of the 35 buildings ms_defs.load() knows; the leftovers were
    # the support tail (buildings_support.lua) and the naval yard, and a def
    # no template names is a def no generated war can ever show — which is
    # exactly the gap the full-coverage directive is about.
    #
    # Both are ordinary cluster kinds, not a special case: they go through
    # place_cluster like every other kind, they take a `--works` / `--harbour`
    # count on the CLI, and `--coverage` merely turns them on. Adding a fourth
    # cluster kind was always meant to be a table entry (module docstring), so
    # this is that mechanism being used rather than extended.
    #
    # `min` is 1 on every coverage def deliberately: a weighted draw makes
    # coverage probabilistic, and "the war usually contains a comms relay" is
    # not a coverage guarantee. place_cluster is still best-effort per
    # building (it drops one it cannot site), so the guarantee is completed by
    # gate_full_coverage in scenariogen.py, which REFUSES rather than shipping
    # a war that quietly missed a def.
    "works": {
        "label": "Support Works",
        "radius": 460,
        # A rear-area depot complex: it wants the same buildable flats a base
        # does, and it is the one cluster that reads as logistics rather than
        # as a fight.
        "prefers": ["buildzone", "plain"],
        "buildings": [
            ("ms_command_post",     3, 1, 1),
            ("ms_field_workshop",   3, 1, 2),
            ("ms_comms_relay",      2, 1, 1),
            ("ms_rail_platform",    2, 1, 1),
            # Both min 1 rather than 0. A supply dump is what a support works
            # IS, and its `0` made it the last def a coverage war could miss
            # (measured on scorched_crossing seed 3 and meridian seed 3, where
            # ms_supply_dump was the single absent def); ms_staticdefense_s1 is
            # here because the light gun nest is otherwise a town-template draw
            # only, and a planned township does not go through this table's
            # override path at all.
            ("ms_supply_dump",      2, 1, 2),
            ("ms_staticdefense_s1", 1, 1, 2),
        ],
        "garrison": [
            ("ms_engineers_s1", 3, 1, 2),
            ("ms_supply_truck", 3, 1, 2),
            ("ms_fuel_tanker",  2, 0, 1),
            ("ms_militia",      1, 0, 1),
        ],
    },
    "harbour": {
        "label": "Harbour Works",
        "radius": 420,
        # KNOWN COSMETIC LIMIT, recorded rather than papered over: a harbour
        # here is not on the water. Two independent reasons, and neither is
        # worth breaking to fix.
        #   1. `prefers` cannot ask for a coast. scenariogen's `candidates()`
        #      SKIPS every region tagged water or island outright, so a
        #      water-first preference list would be dead data — hence the dry
        #      tags below.
        #   2. Only ms_port_crane grades itself against the water mask
        #      (SITE_TEMPLATES.needs_water); shipyard, wharf and mast declare
        #      no such requirement, so the placer has nothing to gate on.
        # Water-gating the three would mean a coverage war refuses to generate
        # on any map without a coast — a worse trade for a harness whose job is
        # to put every def on screen. The port crane still lands on a real
        # berth, via the site layer, so the water case is covered there.
        "prefers": ["buildzone", "plain", "chokepoint"],
        "buildings": [
            ("ms_shipyard",       3, 1, 1),
            ("ms_pontoon_wharf",  2, 1, 1),
            ("ms_mooring_mast",   2, 1, 2),
            # The crane is ALSO a SITE_TEMPLATES entry, and that is the copy
            # that stands on a real berth (`needs_water`, graded against the
            # mask). This one is the coverage fallback: the site layer draws
            # last and competes for regions with every cluster, so on a map
            # whose region budget runs out before ms_port_crane's turn the
            # crane is simply absent — measured on techno_lands, which came
            # 66/67 with the crane the only miss. A harbour that has one
            # anyway costs nothing and takes the crane off the region budget.
            ("ms_port_crane",     2, 1, 1),
            ("ms_depot",          1, 0, 1),
        ],
        "garrison": [
            ("ms_civilians",  3, 1, 2),
            ("ms_civtruck",   2, 1, 1),
            ("ms_militia",    2, 0, 1),
        ],
    },
    "shanty": {
        "label": "Shanty Camp",
        "radius": 400,
        "prefers": ["plain", "buildzone", "chokepoint"],
        # The informal settlement, and the answer to a measured problem rather
        # than an invented flavour. Six shipped defs — shanty block, market
        # stalls, meeting hall, water works, watchtower, barricade set — were
        # placeable ONLY by the town planner, and only then when the seeded
        # town happened to draw the archetype and wall tier that use them. On
        # meridian_basin at seed 11 all six were absent from a war with three
        # planned towns in it, which is exactly the class of miss the coverage
        # directive is about: not "rare", but "not reachable on purpose".
        #
        # Put together, those six ARE a settlement: a walled block of
        # self-built housing with a market, a hall to argue in, a standpipe and
        # somebody watching the road. That is a Township's opposite number and
        # a thing the setting wants anyway, so this is an ordinary cluster kind
        # a war may ask for, not a fixture that only exists to satisfy a test.
        #
        # Every min is 1 because that is the whole point — a weighted draw here
        # would put the six defs back exactly where they started.
        "buildings": [
            ("ms_shanty_block",     5, 1, 3),
            ("ms_market_stalls",    3, 1, 2),
            ("ms_meeting_hall",     2, 1, 1),
            ("ms_water_works",      2, 1, 1),
            ("ms_watchtower",       2, 1, 2),
            ("ms_barricade_set",    2, 1, 3),
        ],
        "garrison": [
            ("ms_civilians", 4, 1, 3),
            ("ms_militia",   3, 1, 2),
            ("ms_civbus",    1, 0, 1),
        ],
    },
}

# The cluster kinds a war places by default, in the order the CLI counts them.
# The coverage kinds are deliberately absent: an ordinary war should not grow a
# shipyard because the generator learned how to place one.
DEFAULT_CLUSTER_KINDS = ["town", "outpost", "base", "mine"]
COVERAGE_CLUSTER_KINDS = ["works", "harbour", "shanty"]

# Minimums a --coverage war raises on templates it shares with ordinary wars.
# A DATA OVERRIDE rather than an edit to the templates themselves, because the
# two callers want different things and only one of them is a harness: an
# ordinary Forward Base draws its foundry and airbase (both min 0 above), and
# that variation is the difference between four generated bases and one base
# generated four times. A coverage war cannot afford the draw, so it says so
# here — in one table a reader can diff against the templates — instead of
# flattening the variation for everybody.
COVERAGE_MIN_OVERRIDES = {
    "base":    {"ms_foundry": 1, "ms_airbase": 1},
    "mine":    {"ms_transit_hub": 1},
    "outpost": {"ms_staticdefense_s3": 1, "ms_staticdefense_s4": 1},
    "town":    {"ms_staticdefense_s1": 1, "ms_depot": 1},
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
# as a bridge that does — see scenariogen.gate_reachability. On a PLAYER
# scenario (scenariogen's `test_scenario=False`) the re-run asks the narrower
# question, because a map already split by water is not a defect there: a field
# may not BURY a labelled point, and may not sever two points that shared a
# component before it was placed. Decoration still may not decide the war.
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
# Roadside yards (roads R4)
# --------------------------------------------------------------------------
# What `road_frontage.stage_frontage` may stand on a published road link. One
# entry is one yard: a building set back from the carriageway with an apron in
# front of it and vehicles parked on the apron.
#
# `classes` IS THE BRIEF'S "required frontage class" and it is the whole of the
# content decision here. R2 planned a hierarchy — highway 0, road 1, track 2
# (terragen/roads.ROAD_CLASS_NAMES) — precisely so a consumer could ask for a
# road of a given standard, and a fuel depot on a mountain track is the defect
# that asking prevents. Ordered specs, first-fit: the placer walks this list in
# order and drops what does not fit, so the entry a map is most likely to be
# able to carry goes first.
#
# `parked` DRAWS FROM THE SHIPPED ROSTER ONLY (units/civvehicles.lua,
# units/logistics.lua), the same discipline town_templates.resolve_roles keeps:
# a spec naming a def this game does not ship is refused by name in the
# scenario summary rather than silently producing an empty yard.
#
# The sizes are the footprints', not a designer's: ms_depot is 10x10 build
# squares = 160 elmos across (town_stager.SQUARE_ELMOS), so a `frontage` under
# ~400 leaves a parking row nowhere to go, and `yard_depth` is stated in the
# units a lorry occupies — two rows of ~105 elmos plus the gate.
ROAD_FRONTAGE = [
    {
        "def": "ms_depot", "label": "Supply Depot",
        "classes": (0, 1),                 # highway or road: convoys come here
        "yard_depth": 240, "frontage": 460,
        "parked": ["ms_civtruck", "ms_supply_truck", "ms_civbus"],
        "rows": 2, "per_row": 3, "min_parked": 2,
    },
    {
        "def": "ms_field_workshop", "label": "Roadside Workshop",
        "classes": (1, 2),                 # a workshop serves the back roads
        "yard_depth": 200, "frontage": 400,
        "parked": ["ms_civtruck", "ms_courier_car"],
        "rows": 2, "per_row": 2, "min_parked": 1,
    },
    {
        "def": "ms_tank_farm", "label": "Fuel Stop",
        "classes": (0,),                   # highway only: this is a rest stop
        "yard_depth": 260, "frontage": 480,
        "parked": ["ms_fuel_tanker", "ms_civtruck"],
        "rows": 2, "per_row": 2, "min_parked": 1,
    },
]

# How many roadside yards one scenario may carry. Low on purpose: these are
# landmarks on a road, and a yard every 300 elmos is a ribbon development, not
# a frontier highway. Also a cost ceiling — every yard is a blocking building
# the war-fightability gate must then clear.
MAX_ROAD_FRONTAGE = 3


# --------------------------------------------------------------------------
# Layby dressing — what stands on a pad NOTHING was built on (roads R4c)
# --------------------------------------------------------------------------
# A map publishes more prepared pads than a scenario has buildings for
# (terragen.yards.YardParams.max_pads is 6, MAX_ROAD_FRONTAGE above is 3), and
# that is by design: a pad the placer does not take is a LAYBY. But an empty one
# is a rectangle of tarmac with nothing on it, which reads as unfinished ground
# rather than as somewhere a convoy stops — the pad's whole visual claim is that
# somebody made this place for a reason, and an empty one withdraws it.
#
# ORDERED BANDS, ROAD EDGE LAST. The layout rule is the one thing here that is
# not a taste call: the half of a pad nearest the carriageway is the PULL-IN and
# stays empty (`road_frontage.PULLIN_FRACTION`), because a layby you cannot pull
# into is a decorated obstacle. Everything below stands in the back band, and
# `band` is where in that band it goes: `back` hugs the rear edge, `mid` stands
# in front of it.
#
# `along` is the item's offset ACROSS the pad in units of its own width — the
# stager multiplies it out — so a kind can be repeated at ±1 without the table
# knowing how wide the def is.
#
# THE HONEST STATE OF THIS TABLE, 2026-08-15 (the same discipline
# town_templates.PROPS keeps, and the same reason): **this game ships no sign
# and no standalone drum**, so `sign` resolves to NOTHING, visibly, and is
# reported by name in the scenario summary rather than being substituted. The
# three kinds that do resolve are real content doing the job they were modelled
# for: `ms_barricade_set` is a 25 m scrap-plate run (a fence), `ms_supply_dump`
# is an open crate/drum/tarpaulin stack 1.6 m tall (the flattest thing in the
# roster — it dresses without walling), and a parked civilian lorry is what a
# rest stop looks like when someone is resting at it. A roadside sign is a real
# ask on the model lane; it is not something this table can invent.
PAD_DRESSING = [
    {"kind": "fence", "defs": ["ms_barricade_set"], "band": "back",
     "along": (0.0,), "odds": 0.75},
    {"kind": "stack", "defs": ["ms_supply_dump"], "band": "back",
     "along": (-1.6, 1.6), "odds": 0.6},
    {"kind": "sign", "defs": [], "band": "mid",
     "along": (0.0,), "odds": 1.0},
    {"kind": "standing", "defs": ["ms_civtruck", "ms_fuel_tanker",
                                  "ms_supply_truck"], "band": "mid",
     "along": (-1.2, 1.2), "odds": 0.7},
]

# How many laybys one scenario dresses. Above MAX_ROAD_FRONTAGE because these
# are cheap — a stack and a lorry, not a building programme — but still bounded:
# every pad on the map wearing the same three props is a fixture, and the odds
# above are what keep two dressed laybys from being the same picture.
MAX_PAD_DRESSING = 4


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
    # ----------------------------------------------------------------------
    # full — every mobile def the generator can address, one roster (2026-08-18)
    # ----------------------------------------------------------------------
    # The full-coverage directive's unit half: each side fields at least one of
    # every unit type. "Every unit type" means ms_defs.load()'s catalog, which
    # is 32 mobile defs plus the four radar masts, and NOT the whole of
    # data/games/metalstorm/units/ — ships.lua, subs.lua, fighters.lua and
    # bombers.lua are not in ms_defs' read set at all (see its `load` docstring:
    # "the naval/air classes are not scenario-generator content"), and
    # transports.lua is excluded by name because ms_landing_ship is
    # movementclass SHIP and the generator has no water placement. So the naval
    # constraint the roster was expected to hit never arises: there is no def
    # here the placer could be asked to beach. That is a real answer about the
    # roster/map pair, not a weakened invariant — invariant 5 still grades every
    # mask this roster contains, which is now all three of VEH, HEAVY and
    # INFANTRY rather than the two `standard` reaches.
    #
    # Counts are deliberately small. This is a coverage harness, not a battle:
    # 36 entries at `standard`'s counts would be ~250 units at one landing zone,
    # and every extra copy is more ground `usable()` has to find clear. Tiers
    # taper 3/2/1/1 because an s4 is a 5x5-to-6x6 footprint and two of them cost
    # more room than three s1s.
    #
    # The radar masts are immobile (spacing 0, speed 0): staged, published, and
    # never a path gate — the same shape `standard` already uses for
    # ms_radar_s1. They are units_ rows rather than cluster buildings because
    # radar is a SIDE's asset; a coverage war that only ever showed a radar mast
    # as neutral scenery would not have covered the player-facing case.
    "full": [
        # -- line armour: VEH, VEH, HEAVY, HEAVY -------------------------
        ("ms_tanks_s1",       3, 130),
        ("ms_tanks_s2",       2, 150),
        ("ms_tanks_s3",       1, 170),   # HEAVY — forces the strict mask check
        ("ms_tanks_s4",       1, 190),   # HEAVY
        # -- walkers: VEH x3 then HEAVY ----------------------------------
        ("ms_mechs_s1",       2, 130),
        ("ms_mechs_s2",       2, 150),
        ("ms_mechs_s3",       1, 170),
        ("ms_mechs_s4",       1, 190),   # HEAVY
        # -- infantry: the INFANTRY mask, 45 deg where HEAVY gets 24 -----
        ("ms_soldiers_s1",    3, 100),
        ("ms_soldiers_s2",    2, 120),
        ("ms_soldiers_s3",    1, 140),
        ("ms_soldiers_s4",    1, 160),
        # -- indirect fire. ms_artillery_s4 (23 elmos/s) is the slowest
        #    staged unit in this roster and therefore the one the
        #    contestability arithmetic reads — see the `worst` computation in
        #    scenariogen.generate, which takes the MINIMUM staged speed.
        ("ms_artillery_s1",   2, 140),
        ("ms_artillery_s2",   1, 160),
        ("ms_artillery_s3",   1, 180),   # HEAVY
        ("ms_artillery_s4",   1, 200),   # HEAVY
        # -- engineers (INFANTRY) ----------------------------------------
        ("ms_engineers_s1",   2, 110),
        ("ms_engineers_s2",   1, 130),
        ("ms_engineers_s3",   1, 150),
        ("ms_engineers_s4",   1, 170),
        # -- recon, command and the logistics tail -----------------------
        ("ms_scout_buggy",    2, 130),
        ("ms_courier_car",    1, 120),
        ("ms_obs_balloon",    1, 140),
        ("ms_command_s2",     1, 150),
        ("ms_supply_truck",   1, 140),
        ("ms_fuel_tanker",    1, 140),
        ("ms_expedition_rig", 1, 150),
        ("ms_technical",      1, 130),
        # -- the civilian rolling stock and population. On a player team
        #    rather than in a town on purpose: these defs are otherwise only
        #    ever staged as neutral township residents, so a coverage war that
        #    skipped them here would leave their team-coloured case unshown.
        #    They do NOT go through the civilian registry (that is the
        #    `civilians` block's job, and a `units` row is invisible to it) —
        #    which is also why the objective layer's area queries are anchored
        #    on towns and sites, never on a landing zone.
        ("ms_civtruck",       1, 130),
        ("ms_civbus",         1, 140),
        ("ms_civilians",      2, 100),
        ("ms_militia",        2, 110),
        # -- static: staged, but never a path gate (speed 0) -------------
        ("ms_radar_s1",       1, 0),
        ("ms_radar_s2",       1, 0),
        ("ms_radar_s3",       1, 0),
        ("ms_radar_s4",       1, 0),
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
