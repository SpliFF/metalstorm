-- scenarios/meridian_basin.lua — the default beta opening
-- (PLAN-metalstorm-beta-map.md §3 task 5).
--
-- Scenario file (PLAN-persistence.md §5 format, loaded by game_scenario.lua)
-- for the purpose-built beta map "Meridian Basin": pre-seeded region
-- ownership, starting squads per side, opening control objectives,
-- civilian convoy schedules. Doubles as the systems-showcase artifact and
-- a war template (PLAN-metalstorm-wars.md: "a scenario file IS a war
-- template").
--
-- The map package itself lives OUTSIDE the game folder
-- (content/maps/meridian_basin/ → processed into data/maps/); its
-- mapdata/regions.lua region graph, mapdata/civilians.lua site/convoy
-- data, and this scenario are co-designed from the same source graph
-- (tools/mapgen/meridian_layout.json) — region keys named in comments
-- below match that graph's canonical keys.
--
-- REGION ADDRESSING (see the FILE-SCOPE NOTE in game_scenario.lua): meridian_
-- basin ships content/maps/meridian_basin/mapdata/regions.lua, so
-- game_regions.lua auto-selects the named 24-region graph provider (not the
-- fixed 2048-elmo grid). world.regions/objectives region keys below are the
-- graph's named keys (e.g. "cinder_forge") straight from that file — one
-- entry per named region, not per grid cell.

return {
    version   = 1,
    name      = 'Meridian Basin — Standard War',
    tutorial  = false,
    ephemeral = false,           -- persistent war (hibernates when empty)

    world = {
        map     = 'meridian_basin',
        -- Home + valley rows start owned; the contested band (ridge rows
        -- C/E, the three river passes, the lakes) starts uncontrolled —
        -- early game is expansion through neutral ground, matching the
        -- layout graph's scenario_ownership block and the "start is
        -- 3 region-hops from the basin" design invariant.
        regions = {
            -- north (team 0)
            { key = "cinder_forge",  team = 0 },
            { key = "ash_habitat",   team = 0 },
            { key = "northgate",     team = 0 },
            { key = "granary_vale",  team = 0 },
            { key = "northwatch",    team = 0 },
            { key = "north_market",  team = 0 },

            -- south (team 4)
            { key = "slag_forge",    team = 4 },
            { key = "shale_habitat", team = 4 },
            { key = "southgate",     team = 4 },
            { key = "sorghum_vale",  team = 4 },
            { key = "southwatch",    team = 4 },
            { key = "south_market",  team = 4 },

            -- Deliberately absent (neutral at kickoff): ridge rows
            -- (west_scarp_n/s, hollow_overlook_n, gulch_overlook_s,
            -- east_bluffs_n/s), the river band (west_narrows, west_pass,
            -- meridian_basin, east_pass, still_mere, heron_ait).
        },
    },

    sides = {
        -- Informational only — team/slot assignment is the direct-start
        -- manifest's job (see manifests/meridian_basin_direct.json). Faction
        -- keys per gamedata/sidedata.lua's design draft (that file is still
        -- an inert stub — factions aren't mechanically differentiated yet,
        -- same as scenario_smoke_test.lua's usage).
        { faction = 'compact', team = 0 },
        { faction = 'compact', team = 1 },
        { faction = 'compact', team = 2 },
        { faction = 'compact', team = 3 },
        { faction = 'union',   team = 4 },
        { faction = 'union',   team = 5 },
        { faction = 'union',   team = 6 },
        { faction = 'union',   team = 7 },
    },

    -- Starting garrison at each side's primary drop-in (northgate/southgate,
    -- start_positions[1] in the layout graph) plus a radar picket at the
    -- flank home region (northwatch/southwatch, tagged "radar_high").
    units = {
        { def = 'ms_tanks_s2', team = 0, x = 6600, z = 1200, facing = 'south', count = 4, spacing = 150,
          orders = { { cmd = 'FIGHT', params = { 8192, 0, 7600 } } } },
        { def = 'ms_soldiers_s1', team = 0, x = 6400, z = 1400, facing = 'south', count = 6, spacing = 100 },
        { def = 'ms_engineers_s1', team = 0, x = 6200, z = 1200, facing = 'south', count = 2, spacing = 120 },
        { def = 'ms_radar_s1', team = 0, x = 13184, z = 1200, facing = 'south', count = 1 },

        { def = 'ms_tanks_s2', team = 4, x = 6600, z = 15184, facing = 'north', count = 4, spacing = 150,
          orders = { { cmd = 'FIGHT', params = { 8192, 0, 8784 } } } },
        { def = 'ms_soldiers_s1', team = 4, x = 6400, z = 14984, facing = 'north', count = 6, spacing = 100 },
        { def = 'ms_engineers_s1', team = 4, x = 6200, z = 15184, facing = 'north', count = 2, spacing = 120 },
        { def = 'ms_radar_s1', team = 4, x = 13184, z = 15184, facing = 'north', count = 1 },
    },

    -- Ambient civilian presence at the two habitat districts (the market
    -- districts are seeded via mapdata/civilians.lua's site data once
    -- spawn.seed is implemented — see that file's schema doc — this
    -- section is a small always-on population independent of that TODO).
    --
    -- x is offset +220 from the habitat's exact centre (2700): ms_habitat's
    -- footprint (12x12 → 96-elmo half-extent per axis) blocks ground out to
    -- ~96 elmos, so spawning directly on the centre point traps the unit
    -- inside the building's blocked yardmap — GiveOrderToUnit "succeeds" but
    -- the unit can never leave (found + fixed 2026-07-26, civilian idle-tail
    -- investigation — these two were 2 of the population's stuck static
    -- civilians).
    civilians = {
        units = {
            { def = 'ms_civilians', x = 2920, z = 3900, facing = 'south', role = 'ambient' }, -- ash_habitat
            { def = 'ms_civilians', x = 2920, z = 12484, facing = 'north', role = 'ambient' }, -- shale_habitat
        },
    },

    -- Opening objective set: a real story with escort/protect/extract
    -- objectives tied to civilian populations and convoys.
    --
    -- STORY: "The Meridian Evacuation"
    -- Both civilian habitats (ash_habitat and shale_habitat) are under
    -- threat as forces close in on the strategic Meridian Basin. The
    -- civilian populations need protection while supply convoys attempt
    -- emergency runs to the market districts. Intelligence suggests enemy
    -- forces will push through the ridge passes — securing these corridors
    -- is crucial for evacuation routes.
    --
    -- Phase 1: Initial protection and convoy escort
    -- Phase 2: Strategic control of the basin
    -- Phase 3: Final evacuation extraction
    objectives = {
        -- STRATEGIC: Control the basin (the endgame objective)
        { type = 'control', scope = 'strategic', forTeam = nil, region = 'meridian_basin', reward = 300,
          expiresAtFrame = nil }, -- open-ended, the war's focal point

        -- TACTICAL Phase 1: Protect the civilian districts
        -- North habitat protection (ash_habitat grid cells)
        { type = 'protect', scope = 'tactical', forTeam = 0,
          params = {
              targetUnitIDs = {},  -- Populated at runtime via _populateTargetsFrom
              quorum = 1,          -- At least one civilian must survive
          },
          _populateTargetsFrom = { x = 2700, z = 3900, r = 600, role = 'ambient' },
          reward = 120,
          expiresAtFrame = 9000 },  -- 5 minutes (30 Hz * 60 * 5)

        -- South habitat protection (shale_habitat)
        { type = 'protect', scope = 'tactical', forTeam = 4,
          params = {
              targetUnitIDs = {},  -- Populated at runtime via _populateTargetsFrom
              quorum = 1,
          },
          _populateTargetsFrom = { x = 2700, z = 12484, r = 600, role = 'ambient' },
          reward = 120,
          expiresAtFrame = 9000 },

        -- TACTICAL Phase 1: Convoy escort missions
        -- payloadUnitIDs starts empty — the convoy vehicle doesn't exist at
        -- scenario-load time (civilians/convoy.lua staggers its first spawn
        -- 0-60s past GameStart). _populatePayloadFrom.route names the
        -- mapdata/civilians.lua convoy route; game_scenario.lua queues this
        -- objective and civilians/convoy.lua's spawn path
        -- (GG.Scenario.NotifyConvoySpawn) fires it — with the spawned
        -- vehicle as payload — the first time that route's convoy spawns.

        -- North convoy: ash_habitat → north_market via granary_vale
        { type = 'escort', scope = 'tactical', forTeam = 0,
          params = {
              payloadUnitIDs = {},
              -- Route terminus (north_market site pos = the route's last
              -- waypoint). Must cover where the truck actually stops —
              -- convoy.lua despawns it on route completion, so a destArea
              -- offset from the terminus can never be satisfied.
              destArea = { x = 13492, z = 3900, r = 400 },
              quorum = 1,
          },
          _populatePayloadFrom = { route = 'convoy_north' },
          reward = 100,
          expiresAtFrame = 18000 },  -- 10 minutes

        -- South convoy: shale_habitat → south_market via sorghum_vale
        { type = 'escort', scope = 'tactical', forTeam = 4,
          params = {
              payloadUnitIDs = {},
              -- Route terminus (south_market site pos), same as the north run.
              destArea = { x = 13492, z = 12484, r = 400 },
              quorum = 1,
          },
          _populatePayloadFrom = { route = 'convoy_south' },
          reward = 100,
          expiresAtFrame = 18000 },

        -- TACTICAL Phase 2: Secure the ridge passes
        { type = 'control', scope = 'tactical', forTeam = nil, region = 'west_pass', reward = 110,
          expiresAtFrame = nil },
        { type = 'control', scope = 'tactical', forTeam = nil, region = 'east_pass', reward = 110,
          expiresAtFrame = nil },

        -- TACTICAL Phase 3: Emergency extraction from threatened habitats
        -- North extraction: secure ash_habitat, evacuate to northgate
        { type = 'extract', scope = 'tactical', forTeam = 0,
          params = {
              payloadUnitIDs = {},  -- Populated at runtime via _populatePayloadFrom
              pickupArea = { x = 2700, z = 3900, r = 500 },    -- ash_habitat center
              extractArea = { x = 6600, z = 1200, r = 400 },    -- northgate garrison
              holdFrames = 300,     -- 10 seconds of security required
              threshold = 5000,     -- Minimum friendly strength to secure
              quorum = 1,
          },
          _populatePayloadFrom = { x = 2700, z = 3900, r = 600, role = 'ambient' },
          reward = 150,
          expiresAtFrame = 27000 },  -- 15 minutes

        -- South extraction: secure shale_habitat, evacuate to southgate
        { type = 'extract', scope = 'tactical', forTeam = 4,
          params = {
              payloadUnitIDs = {},  -- Populated at runtime via _populatePayloadFrom
              pickupArea = { x = 2700, z = 12484, r = 500 },   -- shale_habitat center
              extractArea = { x = 6600, z = 15184, r = 400 },   -- southgate garrison
              holdFrames = 300,
              threshold = 5000,
              quorum = 1,
          },
          _populatePayloadFrom = { x = 2700, z = 12484, r = 600, role = 'ambient' },
          reward = 150,
          expiresAtFrame = 27000 },
    },

    orders = {},

    -- Convoy schedule (informational — see mapdata/civilians.lua for the
    -- authoritative route data this mirrors; game_scenario.lua's
    -- stageObjectives/stageUnits/stageCivilians do not yet read this field,
    -- so it has no runtime effect today. Declared for forward-compatibility
    -- and so this scenario documents the intended opening state in one
    -- place rather than splitting it silently across two files).
    convoys = {
        { id = 'convoy_north', side = 'north', from = 'ash_habitat', to = 'north_market',
          via = { 'granary_vale' }, intervalSec = 300 },
        { id = 'convoy_south', side = 'south', from = 'shale_habitat', to = 'south_market',
          via = { 'sorghum_vale' }, intervalSec = 300 },
    },
}
