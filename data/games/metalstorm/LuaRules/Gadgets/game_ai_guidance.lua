-- game_ai_guidance.lua — team-scoped AI guidance store (PLAN-metalstorm-interaction.md §6). STUB.
--
-- Cooperative human→AI guiding as a SYNCED, team-scoped store the strategic
-- AI treats as BINDING: stance, region paint, asset locks, objective
-- delegation, funding, ROE, veto. This gadget owns the store + validation;
-- the AI planner reads it (never writes), the ai-command-panel widget and
-- the command composer write into it.
--
-- LOAD ORDER CONTRACT: layer -44 — with the interaction pair (parley -45),
-- before civilians (-40). (Layer proposed by PLAN-metalstorm-structure.md —
-- interaction plan does not pin one; keep the pair adjacent.)
--
-- Cross-plan contracts:
--   * PLAN-metalstorm-ai.md        — planner treats guidance as hard
--                                    constraints (§3 effects); intent report
--                                    + veto flow back through the store.
--                                    ai §5.1 was REVISED by interaction §6 —
--                                    interaction OWNS this design (review A14).
--   * PLAN-metalstorm-scripting.md — command-composer compiles
--                                    subject="the AI" sentences into this store
--   * PLAN-metalstorm-wire.md      — guidance fields ride team rulesParams;
--                                    team-privacy is engine ask I2
--                                    (losAccess-filtered param streaming)

function gadget:GetInfo()
    return {
        name    = "AI Guidance",
        desc    = "Team-scoped synced guidance store: stance, paint, locks, delegation, funding, veto",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = -44,             -- adjacent to game_parley (-45)
        enabled = false,           -- STUB — flip when PLAN-metalstorm-interaction §6 lands
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

-- Public surface (proposed):
--   GG.AIGuidance.Get(teamID) -> { stance, region_paint = {key=paint},
--                                  asset_locks = {groupId=true},
--                                  delegated = {objectiveId=true},
--                                  funding, roe, veto = {goalId=true} }
--   writers arrive as validated LuaRules messages from the UI widgets

return false
