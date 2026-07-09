-- game_teams.lua — player lifecycle over team ownership (PLAN-metalstorm-teams.md). STUB.
--
-- Thin orchestration gadget for the drop-in/drop-out *deltas* over
-- Spring-native team sharing: joiner onboarding (JOIN_GRANT via
-- GG.Authority, suggested starter objective via GG.Objectives), leaver
-- handling (pool merge is game_authority's PlayerRemoved; this gadget owns
-- the social layer — toasts, leader policy, caretaker handoff), and the
-- per-player scoreboard (score_<playerID>_{earned,spent,objectives}
-- rulesParams).
--
-- LOAD ORDER CONTRACT (see PLAN-metalstorm-structure.md "Gadget layer map"):
-- layer -95 — after game_authority (-100) so GG.Authority exists at Initialize,
-- before everything that assumes players are settled.
--
-- Cross-plan contracts:
--   * PLAN-metalstorm-authority.md  — JOIN_GRANT, authority_granted_<id> guard
--   * PLAN-metalstorm-objectives.md — suggested_for hint param
--   * PLAN-metalstorm-ai.md         — ai_caretaker modoption activates the
--                                     caretaker profile when a side empties
--   * PLAN-metalstorm-wars.md       — §A8: an EMPTY side hibernates, it does
--                                     NOT accrue income (corrects teams §4.5)
--   * PLAN-quickstart.md            — detach grace window vs true leave
--                                     (wars appendix: pool preserved in grace)

function gadget:GetInfo()
    return {
        name    = "Team Lifecycle",
        desc    = "Drop-in/out deltas: joiner grants, leaver handling, leader, scoreboard",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = -95,             -- after authority (-100)
        enabled = false,           -- STUB — flip when PLAN-metalstorm-teams lands
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

-- TODO (PLAN-metalstorm-teams.md):
--   gadget:PlayerAdded(playerID)    — JOIN_GRANT (once per identity:
--                                     authority_granted_<id>), suggested
--                                     objective, join toast event
--   gadget:PlayerRemoved(playerID)  — leader reassignment, leave toast
--                                     (pool merge stays in game_authority)
--   scoreboard writers on GG.Authority award/charge hooks
--   caretaker handoff when the last human of a side leaves (ai_caretaker)

return false
