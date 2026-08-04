-- authority/attribute.lua — player-pool-first, team-pool-fallback charge
-- attribution (PLAN-metalstorm-authority.md §3.2 "Attribution & fallback").
--
-- Pure decision: drains the issuing player's pool first, then the team pool
-- for the remainder — a broke player can still act while the team is
-- solvent. Refuses (no debit at all, either pool) if neither combination
-- covers the cost. `cost` is assumed already integer (formula.lua ceils it).
--
-- `ownPoolOnly` (AI3 / PLAN-metalstorm-ai.md §5 co-commander invariant): when
-- true, the team-pool fallback is DISABLED — the charge draws exclusively from
-- the player's own pool and refuses if that pool can't cover the whole cost.
-- This is what makes "own pool only, never the team fallback" enforceable: a
-- co-commander AI can spend only what it was granted, never the shared team
-- savings. Full-side AIs and humans pass ownPoolOnly=false (nil) and keep the
-- normal player-first, team-fallback behaviour.

local M = {}

--- @treturn allowed, spentFromPlayer, spentFromTeam
function M.attribute(playerPool, teamPool, cost, ownPoolOnly)
    if cost <= 0 then return true, 0, 0 end
    if playerPool >= cost then
        return true, cost, 0
    end
    if ownPoolOnly then
        -- No team fallback: the own pool alone must cover the whole cost.
        return false, 0, 0
    end
    local remainder = cost - playerPool
    if teamPool >= remainder then
        return true, playerPool, remainder
    end
    return false, 0, 0
end

return M
