-- authority/attribute.lua — player-pool-first, team-pool-fallback charge
-- attribution (PLAN-metalstorm-authority.md §3.2 "Attribution & fallback").
--
-- Pure decision: drains the issuing player's pool first, then the team pool
-- for the remainder — a broke player can still act while the team is
-- solvent. Refuses (no debit at all, either pool) if neither combination
-- covers the cost. `cost` is assumed already integer (formula.lua ceils it).

local M = {}

--- @treturn allowed, spentFromPlayer, spentFromTeam
function M.attribute(playerPool, teamPool, cost)
    if cost <= 0 then return true, 0, 0 end
    if playerPool >= cost then
        return true, cost, 0
    end
    local remainder = cost - playerPool
    if teamPool >= remainder then
        return true, playerPool, remainder
    end
    return false, 0, 0
end

return M
