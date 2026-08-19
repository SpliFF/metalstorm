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

    -- Briefing (S2): lobby/client display only; the sim ignores it. Must stay
    -- a pure table literal — a computed value here makes the whole scenario
    -- vanish from the lobby list. No parTimeSec and no image on purpose: this
    -- stub is the living proof that every briefing field is optional.
    briefing = {
        title    = 'Basic Training',
        subtitle = 'Command School — First Session',
        story    = [[Welcome to command school, officer. Before anyone trusts you with a war, you will learn to move a column across open country without losing it.

This exercise runs on the Scorched Crossing proving grounds. No enemy contact is scheduled. That has been said before.]],
        tips     = {
            'Left-click selects a squad; right-click orders it to move.',
            'Drag with the left button to select everything in a box.',
            'Hold the camera at mid-height: close enough to read the fight, far enough to see the flanks.',
            'Orders queue — shift-click to chain waypoints instead of micromanaging each leg.',
        },
    },

    world = {
        -- Was 'meridian_basin' until 2026-08-06. That map is unplayable — its
        -- start positions sit in three disconnected components of the VEH and
        -- HEAVY passability masks (PLAN-metalstorm-wars.md §7.6), so a
        -- tutorial teaching a player to move a squad could have taught them a
        -- squad that cannot get anywhere. scorched_crossing_v2.4 passes
        -- `regions_from_map.py --verify` for all three movement classes.
        --
        -- Nothing else in this stub is coordinate-bound, so this is a genuine
        -- one-line rebind rather than a port. When the tutorial gets real
        -- beats, size them against this map's 4x4 / 1792-elmo region graph
        -- (data/maps/scorched_crossing_v2.4/mapdata/regions.lua) — or against
        -- a dedicated small training map, which is still the better answer.
        map     = 'scorched_crossing_v2.4',
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
