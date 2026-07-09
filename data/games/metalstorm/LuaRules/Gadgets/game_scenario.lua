-- game_scenario.lua — scenario world loader (PLAN-persistence.md §5). STUB.
--
-- Loads a declarative scenario file from scenarios/ at GameStart when the
-- room manifest names one (quickstart --direct / ?direct=<scenario>):
-- pre-set units, factions/sides, region ownership, standing orders,
-- initial objectives, convoy schedules. Pure game Lua — ungated
-- (PLAN.md lane M); the scenario FORMAT is owned by PLAN-persistence §5.
--
-- Consumers of the format:
--   * scenarios/tutorial_01.lua    — PLAN-metalstorm-onboarding §2
--   * scenarios/meridian_basin.lua — PLAN-metalstorm-beta-map §3 (default
--                                    beta opening)
--   * war templates               — PLAN-metalstorm-wars.md ("a scenario
--                                    file IS a war template")
--
-- LOAD ORDER CONTRACT: layer -90 — after authority/teams (pools exist),
-- before objectives/regions consumers seed from scenario state.

function gadget:GetInfo()
    return {
        name    = "Scenario Loader",
        desc    = "Declarative world pre-set: units, sides, orders, objectives from scenarios/",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = -90,             -- after authority (-100) / teams (-95)
        enabled = false,           -- STUB — flip when PLAN-persistence §5 lands
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

-- TODO (PLAN-persistence.md §5):
--   read scenario name from modoptions / room manifest
--   local scn = VFS.Include('scenarios/' .. name .. '.lua')
--   spawn units, set region ownership (GG.Regions), post initial
--   objectives (GG.Objectives), install standing orders, schedule convoys
--   (GG.Civilians), mark tutorial rooms ephemeral (no hibernation)

return false
