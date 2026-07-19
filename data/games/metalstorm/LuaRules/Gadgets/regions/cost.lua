-- regions/cost.lua — order-cost region modifier (PLAN-metalstorm-regions.md §4,
-- PLAN-metalstorm-authority.md §3).
--
-- Pure decision, no Spring API: given who owns the region a unit stands in and
-- whether that owner is allied to the ordering team, return the authority
-- order-cost multiplier. Kept out of the gadget so it's testable with busted
-- and NO Spring/GG mocking (regions/tests/cost_spec.lua), same convention as
-- control.lua / ownership.lua / partition.lua.
--
-- ALLIANCE-AWARE by ruling (2026-07-19, PLAN-metalstorm-regions gate): an
-- allied owner is friendly territory (0.5), matching the "cheap in friendly
-- territory" authority pillar and the client mirror's `isAllied` hook
-- (ui/lib/regions.js costModifierAt). NOT an exact-teamID match — allies pay
-- friendly rates in each other's territory. The alliance test itself lives at
-- the call site (Spring.AreTeamsAllied on the sim; the isAllied predicate on
-- the client) and is passed in as `allied`.

local M = {}

M.MOD_FRIENDLY = 0.5   -- owner allied to the ordering team (incl. same team)
M.MOD_NEUTRAL  = 1.0   -- region unowned / owner unknown
M.MOD_ENEMY    = 2.0   -- owner present and NOT allied

--- ownerTeam: controlling team of the region, or nil if unowned/neutral.
--- allied:    result of the alliance check between ownerTeam and the ordering
---            unit's team (ignored when ownerTeam is nil).
function M.orderModifier(ownerTeam, allied)
    if ownerTeam == nil then return M.MOD_NEUTRAL end
    if allied then return M.MOD_FRIENDLY end
    return M.MOD_ENEMY
end

return M
