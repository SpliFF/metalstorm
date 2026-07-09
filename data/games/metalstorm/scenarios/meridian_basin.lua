-- scenarios/meridian_basin.lua — the default beta opening. STUB.
--
-- Scenario file (PLAN-persistence.md §5 format, loaded by game_scenario.lua)
-- for the purpose-built beta map "Meridian Basin"
-- (PLAN-metalstorm-beta-map.md §3 task 5): pre-seeded region ownership,
-- starting squads per side, initial objectives, civilian convoy schedules.
-- Doubles as the systems-showcase artifact and a war template
-- (PLAN-metalstorm-wars.md: "a scenario file IS a war template").
--
-- The map package itself lives OUTSIDE the game folder
-- (content/maps/meridian_basin/ → processed into data/maps/); its
-- mapdata/regions.lua region graph and this scenario are co-designed —
-- region keys used here must exist in the map's graph.

return {
    version   = 1,
    name      = 'Meridian Basin — Standard War',
    tutorial  = false,
    ephemeral = false,           -- persistent war (hibernates when empty)

    world = {
        map     = 'meridian_basin',
        regions = {},            -- TODO: pre-set ownership from the layout graph
    },

    sides = {
        -- TODO (wars §3): faction side slots + capacity for the beta war shape
    },

    units      = {},             -- TODO: starting squads per side (beta-units roster)
    orders     = {},
    objectives = {},             -- TODO: opening objective set (beta-map §3)
    convoys    = {},             -- TODO: civilian district convoy schedule
}
