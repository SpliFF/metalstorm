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
    },

    sides = {                    -- informational only; team/slot assignment
        { faction = 'compact', team = 0 },   -- is the direct-start manifest's job
        { faction = 'union',   team = 1 },
    },

    units = {
        { def = 'ms_tanks_s2', team = 0, x = 4352, z = 4352, facing = 'east', count = 2, spacing = 150,
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
