-- scenarios/tutorial_01.lua — the first-session tutorial world. STUB.
--
-- A scenario file in the PLAN-persistence.md §5 declarative format, loaded
-- by LuaRules/Gadgets/game_scenario.lua. The tutorial IS a scenario
-- (PLAN-metalstorm-onboarding.md §2): beats are real backbone objectives
-- chained via parentId, sequenced by game_tutorial.lua. Boots via
-- quickstart direct-start (?direct=tutorial); room is EPHEMERAL (never
-- hibernates — onboarding §6 E1).
--
-- FORMAT NOTE: the schema below is the proposed shape; PLAN-persistence §5
-- owns the format — reconcile there before first real use.

return {
    version   = 1,
    name      = 'Basic Training',
    tutorial  = true,            -- activates game_tutorial.lua
    ephemeral = true,            -- no hibernation / persistence

    world = {
        map     = 'meridian_basin',   -- or a dedicated small training map
        regions = {},                 -- pre-set ownership: { [key] = teamID }
    },

    sides = {
        -- { faction = 'compact', ai = nil,       slots = 1 },  -- the player
        -- { faction = 'union',   ai = 'default', slots = 0 },  -- sparring AI
    },

    units = {
        -- { def = 'ms_engineers_s1', x = 0, z = 0, team = 0, facing = 'south' },
    },

    orders     = {},   -- standing orders / directives pre-installed
    objectives = {
        -- beat 1: move a squad (control objective, parentId chain — see
        -- PLAN-metalstorm-onboarding §2 beat table)
    },
    convoys    = {},   -- civilian convoy schedules (GG.Civilians)
}
