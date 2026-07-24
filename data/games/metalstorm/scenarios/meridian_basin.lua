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
-- REGION ADDRESSING (see the FILE-SCOPE NOTE in game_scenario.lua): the
-- region-control gadget (game_regions.lua) still runs the ORIGINAL fixed
-- 2048-elmo grid, not mapdata/regions.lua's named graph — the named-graph
-- rewrite (commit 0838b8066b, "implement region control") is not yet
-- merged into this branch. So world.regions below is expressed as grid
-- keys ("gridX:gridZ", REGION_SIZE=2048), one entry per grid cell a named
-- home/valley region's footprint overlaps (computed from the layout
-- graph's bboxes) — each entry's trailing comment names which
-- mapdata/regions.lua region it belongs to, so this file can be
-- mechanically re-keyed to named graph keys once that rewrite lands. This
-- is the same provisional pattern scenarios/scenario_smoke_test.lua
-- already uses for green_flat.

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
            { key = "0:0", team = 0 }, -- cinder_forge
            { key = "1:0", team = 0 }, -- cinder_forge
            { key = "2:0", team = 0 }, -- cinder_forge
            { key = "0:1", team = 0 }, -- ash_habitat
            { key = "1:1", team = 0 }, -- ash_habitat
            { key = "2:1", team = 0 }, -- ash_habitat
            { key = "3:0", team = 0 }, -- northgate
            { key = "4:0", team = 0 }, -- northgate
            { key = "3:1", team = 0 }, -- granary_vale
            { key = "4:1", team = 0 }, -- granary_vale
            { key = "5:1", team = 0 }, -- granary_vale
            { key = "5:0", team = 0 }, -- northwatch
            { key = "6:0", team = 0 }, -- northwatch
            { key = "7:0", team = 0 }, -- northwatch
            { key = "6:1", team = 0 }, -- north_market
            { key = "7:1", team = 0 }, -- north_market

            -- south (team 4)
            { key = "0:7", team = 4 }, -- slag_forge
            { key = "1:7", team = 4 }, -- slag_forge
            { key = "2:7", team = 4 }, -- slag_forge
            { key = "0:5", team = 4 }, -- shale_habitat
            { key = "1:5", team = 4 }, -- shale_habitat
            { key = "2:5", team = 4 }, -- shale_habitat
            { key = "3:7", team = 4 }, -- southgate
            { key = "4:7", team = 4 }, -- southgate
            { key = "3:5", team = 4 }, -- sorghum_vale
            { key = "4:5", team = 4 }, -- sorghum_vale
            { key = "5:5", team = 4 }, -- sorghum_vale
            { key = "5:7", team = 4 }, -- southwatch
            { key = "6:7", team = 4 }, -- southwatch
            { key = "7:7", team = 4 }, -- southwatch
            { key = "6:5", team = 4 }, -- south_market
            { key = "7:5", team = 4 }, -- south_market

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
    civilians = {
        units = {
            { def = 'ms_civilians', x = 2700, z = 3900, facing = 'south', role = 'ambient' }, -- ash_habitat
            { def = 'ms_civilians', x = 2700, z = 12484, facing = 'north', role = 'ambient' }, -- shale_habitat
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
        { type = 'control', scope = 'strategic', forTeam = nil, region = '4:4', reward = 300,
          expiresAtFrame = nil }, -- meridian_basin — open-ended, the war's focal point

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
        -- NOTE: These placeholder objectives have empty payloadUnitIDs arrays
        -- because the actual convoy units don't exist at scenario load time.
        -- The civilians/convoy.lua gadget (when implemented) should:
        --   1. Spawn the convoy units
        --   2. Update these objective params.payloadUnitIDs with the spawned unit IDs
        --   3. Or create new escort objectives dynamically
        -- For now, these serve as story documentation and will validate but
        -- fail at init-time (no payload) — they demonstrate the intended design.

        -- North convoy: ash_habitat → north_market via granary_vale
        { type = 'escort', scope = 'tactical', forTeam = 0,
          params = {
              payloadUnitIDs = {},  -- TODO: populated by convoy spawner
              destArea = { x = 13800, z = 2500, r = 400 },  -- north_market approx center
              quorum = 1,
          },
          reward = 100,
          expiresAtFrame = 18000 },  -- 10 minutes

        -- South convoy: shale_habitat → south_market via sorghum_vale
        { type = 'escort', scope = 'tactical', forTeam = 4,
          params = {
              payloadUnitIDs = {},  -- TODO: populated by convoy spawner
              destArea = { x = 13800, z = 13900, r = 400 },  -- south_market approx center
              quorum = 1,
          },
          reward = 100,
          expiresAtFrame = 18000 },

        -- TACTICAL Phase 2: Secure the ridge passes
        { type = 'control', scope = 'tactical', forTeam = nil, region = '2:4', reward = 110,
          expiresAtFrame = nil },  -- west_pass
        { type = 'control', scope = 'tactical', forTeam = nil, region = '5:4', reward = 110,
          expiresAtFrame = nil },  -- east_pass

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
