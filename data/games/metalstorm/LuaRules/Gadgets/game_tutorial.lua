-- game_tutorial.lua — scripted tutorial beats (PLAN-metalstorm-onboarding.md §2). STUB.
--
-- Drives the first-session ramp INSIDE a scenario world: the tutorial is
-- scenarios/tutorial_01.lua (real backbone objectives chained via parentId
-- — PLAN-metalstorm-objectives §4.7), not a separate mode. This gadget only
-- sequences the beats (waits, hints, next-objective posts) and NO-OPs
-- unless the loaded scenario declares `tutorial = true`.
--
-- Cross-plan contracts:
--   * PLAN-persistence.md §5          — scenario format + game_scenario loader
--   * PLAN-metalstorm-objectives.md   — beats are real objectives (chaining)
--   * PLAN-metalstorm-ai.md           — mentor co-commander profile
--                                       (ai/strategos/profiles/mentor.lua)
--   * PLAN-native-ui.md §3            — progressive disclosure via revealOn
--   * PLAN-quickstart.md              — ?direct=tutorial boot; ephemeral room

function gadget:GetInfo()
    return {
        name    = "Tutorial Director",
        desc    = "Sequences tutorial beats over the scenario's objective chain",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = -30,             -- after the whole backbone + civilians
        enabled = false,           -- STUB — flip when PLAN-metalstorm-onboarding lands
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

-- TODO (PLAN-metalstorm-onboarding.md §2): beat table keyed by completed
-- objective id → next objective post + hint event; mentor-mode handoff.

return false
