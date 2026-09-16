-- scenarios/scenario_smoke_test.lua — the scenario FORMAT's own test fixture
-- (PLAN-persistence.md §5, task 5). Exercises every section of the schema
-- against real, shipped content (green_flat_x34_v3 + the metalstorm unit
-- roster) so the loader (game_scenario.lua) has something concrete to run
-- against, independent of any other plan's roster/beat-table decisions —
-- see scenarios/meridian_basin.lua / tutorial_01.lua for those.
--
-- Boot with a direct-start manifest naming this scenario, e.g.:
--   { "map": "green_flat_x34_v3", "game": "metalstorm", "scenario": "scenario_smoke_test",
--     "players": [{"username": "test1", "team": 0}],
--     "aiSlots": [{"aiId": "null", "team": 1}] }
--
-- Region keys use the grid model (GG.Regions.KeyAt(x, z), REGION_SIZE 2048
-- elmos — see game_regions.lua): "2:2" covers team 0's start position
-- (4352, 4352), "6:6" covers team 1's (13056, 13056), "4:4" is the
-- (uncontested) map centre. The metalstorm-backbone region rewrite (named
-- map-authored graph, commit 0838b8066b) has landed, but it only takes
-- effect for maps that ship a mapdata/regions.lua — green_flat_x34_v3 does
-- not, so game_regions.lua falls back to the grid here and these keys stay
-- correct as-is. See scenarios/meridian_basin.lua for a scenario on a map
-- that DOES ship a named graph, and the FILE-SCOPE NOTE in
-- game_scenario.lua for how a scenario's region keys must match whichever
-- provider its map actually uses.

return {
    version   = 1,
    name      = 'Scenario Format Smoke Test',
    tutorial  = false,
    ephemeral = true,            -- a fixture, not a persistent war

    world = {
        map     = 'green_flat_x34_v3',
        regions = {
            { key = '2:2', team = 0 },   -- team 0's home bastion, preset friendly
            { key = '6:6', team = 1 },   -- team 1's home bastion, preset friendly
            -- '4:4' (map centre) intentionally left uncontrolled — the
            -- control objective below contests it.
        },

        -- Every featuredef Metalstorm ships, exactly once
        -- (PLAN-metalstorm-model-integration §M3 acceptance: "a test scenario
        -- spawns every feature via Spring.CreateFeature"). This list is
        -- ASSERTED COMPLETE by LuaRules/Gadgets/tests/game_features_spec.lua —
        -- adding a def to features/ without adding it here fails that spec,
        -- which is the point: the format fixture is only a smoke test if it
        -- keeps covering the whole roster.
        --
        -- Laid out in a row on the empty flat between the two bastions
        -- (4352,4352 and 13056,13056), clear of the '4:4' centre region the
        -- control objective contests (8192..10240 on both axes) and clear of
        -- the staged units' fight/move lines. green_flat is flat and
        -- featureless, so nothing here contests anything — these exist to be
        -- spawned, drawn and inspected.
        features = {
            -- Wrecks: blocking + reclaimable, spread so each one's footprint
            -- is visibly its own.
            { def = 'ms_colossus_wreck', x = 7000, z = 6000, facing = 'east'  },
            { def = 'ms_tank_wreck',     x = 7400, z = 6000, facing = 'south' },
            { def = 'ms_train_wreck',    x = 7800, z = 6000, facing = 'north' },

            -- Bridges: chained, which is the §M3 acceptance ("bridge segments
            -- chain without z-fighting"). Four spans at the def's own
            -- 24 m chain_pitch, centred on (x, z) — so the road run covers
            -- 96 m of local Z about 7000,7000.
            --
            -- `y = 0` puts the deck at the waterline, which is where a span
            -- over a water gap belongs. It holds because features/bridges.lua
            -- sets `floating` — a feature's y is a SPAWN height that gravity
            -- otherwise settles out of. Read stageFeatures' Y-handling note
            -- before changing either number.
            { def = 'ms_road_bridge', x = 7000, z = 7000, facing = 'north', chain = 4, y = 0 },
            { def = 'ms_rail_bridge', x = 7300, z = 7000, facing = 'north', chain = 4, y = 0 },

            -- Ancient tech: blocking, indestructible, unsalvageable.
            { def = 'ms_vault_door',     x = 8200, z = 6000, facing = 'south' },
            { def = 'ms_monolith_spire', x = 8600, z = 6000 },
            { def = 'ms_dig_site',       x = 9000, z = 6000, facing = 'west'  },

            -- Batch-04 relics + the batch-03 hulk (features/ancient.lua, the
            -- 2026-09-17 wave). A second row south of the first, stepped by
            -- each footprint so no two shadows touch: the foundry alone is
            -- 54 x 52 m (432 x 416 elmos), the hulk 24 x 105 m. Still clear
            -- of the '4:4' centre region (8192..10240 on both axes) — this
            -- row runs z = 5000, x = 4000..7700 — and of the fight lines.
            { def = 'ms_anc_foundry',        x = 4000, z = 5000 },
            { def = 'ms_anc_vault_complex',  x = 4500, z = 5000, facing = 'south' },
            { def = 'ms_anc_gate',           x = 4900, z = 5000 },
            { def = 'ms_anc_reactor',        x = 5250, z = 5000 },
            { def = 'ms_anc_archive',        x = 5550, z = 5000 },
            { def = 'ms_anc_interdictor',    x = 5850, z = 5000 },
            { def = 'ms_anc_siege_platform', x = 6150, z = 5000, facing = 'east' },
            { def = 'ms_anc_storm_caster',   x = 6400, z = 5000 },
            { def = 'ms_anc_lance_battery',  x = 6650, z = 5000, facing = 'south' },
            { def = 'ms_anc_beacon',         x = 6880, z = 5000 },
            { def = 'ms_anc_shield_pylon',   x = 7080, z = 5000 },
            { def = 'ms_anc_obelisk_field',  x = 7380, z = 5000 },
            -- A two-segment run of arcade: the aqueduct publishes its own
            -- 30 m chain_pitch (features/ancient.lua), exactly as the spans do.
            { def = 'ms_anc_aqueduct',       x = 7700, z = 5000, facing = 'north', chain = 2 },
            -- The hulk is 105 m along its local Z; laid east-west on its own
            -- row so its shadow (24 x 104 m) crosses nothing.
            { def = 'ms_ancient_hulk',       x = 6000, z = 4400, facing = 'east' },

            -- The ancient span (features/bridges.lua): chained at its own 36 m
            -- pitch, y = 0 like the two steel spans — and unlike them it is
            -- SEATED (positive deck_top), so the same y holds on dry ground.
            { def = 'ms_anc_bridge_span', x = 7600, z = 7000, facing = 'north', chain = 2, y = 0 },

            -- Civilian landmark (features/landmarks.lua).
            { def = 'ms_lighthouse', x = 9400, z = 6000 },
        },
    },

    sides = {                    -- informational only; team/slot assignment
        { faction = 'compact', team = 0 },   -- is the direct-start manifest's job
        { faction = 'union',   team = 1 },
    },

    units = {
        { def = 'ms_tanks_s2', team = 0, x = 4352, z = 4352, facing = 'east', count = 2, spacing = 290,
          orders = { { cmd = 'FIGHT', params = { 8704, 0, 8704 } } } },
        { def = 'ms_engineers_s2', team = 0, x = 4200, z = 4500, facing = 'east', count = 1 },

        { def = 'ms_soldiers_s1', team = 1, x = 13056, z = 13056, facing = 'west', count = 3, spacing = 120,
          orders = { { cmd = 'MOVE', params = { 8704, 0, 8704 } } } },
        { def = 'ms_radar_s1', team = 1, x = 13300, z = 12900, facing = 'west', count = 1 },
    },

    civilians = {
        units = {
            { def = 'ms_civilians', x = 9200, z = 8400, facing = 'south', role = 'ambient' },
        },
    },

    objectives = {
        { type = 'control', scope = 'tactical',  forTeam = 0,   region = '2:2', reward = 60 },
        { type = 'control', scope = 'strategic', forTeam = nil, region = '4:4', reward = 150 },
    },

    orders   = {},   -- no standalone standing orders in this fixture
    convoys  = {},   -- no civilian convoy schedule in this fixture
}
