-- objectives/attribution.lua — reward-attribution math (PLAN-metalstorm-objectives.md §5).
-- Plain library module (NOT a gadget, NOT a Spring/GG caller) — pure functions
-- over a participation table so the split policy (absent contributors' shares
-- go to the team pool; zero-participation completions pay 100% team) is
-- busted-testable without mocking Spring. Included by game_objectives.lua,
-- which owns the actual Spring.GetUnitRulesParam/Spring.GetPlayerInfo scans
-- and hands the results here as plain tables/predicates.

local M = {}

--- New empty participation table: playerID -> weight.
function M.newParticipation()
    return {}
end

--- Credit `weight` onto `playerID`'s running participation total. No-op if
--- playerID is nil (unstamped last_commander — e.g. a unit that never
--- received a charged order) or weight is non-positive.
function M.credit(participation, playerID, weight)
    if not playerID or not weight or weight <= 0 then return end
    participation[playerID] = (participation[playerID] or 0) + weight
end

--- Split a participation table into an Award{split}-ready shape:
---   weights    — playerID -> weight, for players `isPlayerActive` accepts
---   teamWeight — sum of weight belonging to players `isPlayerActive` rejects
--- (teams §"absent contributors' shares go to the team pool" — a departed
--- player's accumulated weight is redirected team-ward at split time, not
--- banked for them and not dropped).
--- @tparam function isPlayerActive(playerID) -> bool
function M.splitWeights(participation, isPlayerActive)
    local weights, teamWeight = {}, 0
    for playerID, w in pairs(participation) do
        if w and w > 0 then
            if isPlayerActive(playerID) then
                weights[playerID] = w
            else
                teamWeight = teamWeight + w
            end
        end
    end
    return weights, teamWeight
end

--- True if a participation table has no positive-weight entries at all
--- (objectives §5 "zero-participation completions... pay 100% to the team
--- pool" — the caller uses this to skip the split machinery entirely and
--- award the team pool directly, since Award{split} treats a zero total
--- weight as a no-op, not "give it all to the team").
function M.isEmpty(participation)
    for _, w in pairs(participation) do
        if w and w > 0 then return false end
    end
    return true
end

return M
