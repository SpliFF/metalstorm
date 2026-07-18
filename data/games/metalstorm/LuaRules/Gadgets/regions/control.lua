-- regions/control.lua — control score v2 (PLAN-metalstorm-regions.md §2).
--
-- Pure Lua: takes a plain list of unit snapshots + a partition provider,
-- returns per-region per-team scores. ONE bucketing pass over the unit list
-- (§6 perf note — no per-region queries).
--
--   score(team) = presence + structures
--   presence    = Σ (unit strength inside)          -- strength = current health
--   structures  = Σ (building strength inside) × 3   -- buildings anchor
--
-- Civilians (Gaia) never score (excluded by the caller before calling in, or
-- via `excludeTeam`). Air counts at half weight — a per-move-class multiplier
-- table, tunable.

local M = {}

M.STRUCTURE_WEIGHT = 3
M.DEFAULT_MOVE_CLASS_WEIGHTS = {
    air = 0.5,
}

--- units: list of { x, z, team, hp, isBuilding, moveClass }.
--- `moveClass` is looked up in `moveClassWeights` (default air=0.5, anything
--- else / nil = 1.0 — ground and water units score at full weight).
--- Returns scores[regionKey][team] = aggregate weighted strength.
function M.computeScores(units, provider, excludeTeam, moveClassWeights)
    moveClassWeights = moveClassWeights or M.DEFAULT_MOVE_CLASS_WEIGHTS
    local scores = {}

    for _, u in ipairs(units) do
        if u.team ~= excludeTeam and u.hp and u.hp > 0 then
            local key = provider.at(u.x, u.z)
            local weight = 1.0
            if u.isBuilding then
                weight = weight * M.STRUCTURE_WEIGHT
            end
            if u.moveClass and moveClassWeights[u.moveClass] then
                weight = weight * moveClassWeights[u.moveClass]
            end

            local byTeam = scores[key]
            if not byTeam then
                byTeam = {}
                scores[key] = byTeam
            end
            byTeam[u.team] = (byTeam[u.team] or 0) + u.hp * weight
        end
    end

    return scores
end

return M
