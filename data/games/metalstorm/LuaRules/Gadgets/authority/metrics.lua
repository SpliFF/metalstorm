-- authority/metrics.lua — health metrics from ledger counters
-- (PLAN-metalstorm-economy.md §2).
--
-- Computes four health metrics that detect long-horizon economy failure:
--   • Velocity: burn/min ÷ mint/min (EMA over 30 min) — detects inflation/starvation
--   • Pool ratio: (team+player pools) ÷ typical army cost — detects dead anti-CPS lever
--   • Gini: inequality across a team's player pools — social-design smell
--   • Dead-team time: minutes a team can't afford its cheapest posture order
--
-- Pure functions, no Spring/GG API — feeds gm-tools dashboard (not yet built).

local M = {}

-- EMA alpha for 30-minute half-life at 30 Hz (§2: "EMA over 30 min").
-- Formula: alpha = 1 - exp(ln(0.5) / (30 min × 60 s/min × 30 frames/s))
-- = 1 - exp(-0.693147 / 54000) ≈ 0.0000128
local VELOCITY_EMA_ALPHA = 0.0000128

--- Create a new metrics state (per-team EMA accumulators + dead-time counters).
function M.newState()
    return {
        teams = {},  -- [teamID] = {velocity_ema=N, dead_frames=F}
    }
end

--- Update velocity EMA for one team (called every frame, from ledger deltas).
--- `mintDelta` and `burnDelta` are the amounts added to mint/burn counters
--- since the last call (typically zero most frames, nonzero only when an
--- award/charge happened). Returns the updated velocity EMA.
function M.updateVelocity(state, teamID, mintDelta, burnDelta)
    local team = state.teams[teamID]
    if not team then
        team = { velocity_ema = 1.0, dead_frames = 0 }
        state.teams[teamID] = team
    end

    -- Convert frame deltas to per-minute rates (30 Hz → 1800 frames/min)
    local mintRate = mintDelta * 1800
    local burnRate = burnDelta * 1800
    local instantVelocity = (mintRate > 0) and (burnRate / mintRate) or team.velocity_ema

    -- EMA update: v_new = α·instant + (1-α)·v_old
    team.velocity_ema = VELOCITY_EMA_ALPHA * instantVelocity
                      + (1 - VELOCITY_EMA_ALPHA) * team.velocity_ema

    return team.velocity_ema
end

--- Get current velocity EMA for a team (read-only).
function M.velocity(state, teamID)
    local team = state.teams[teamID]
    return team and team.velocity_ema or 1.0
end

--- Pool ratio: (team_pool + Σ player_pools) ÷ typical_army_cost (§2).
--- `totalPools` = team pool + sum of all player pools for this team.
--- `typicalArmyCost` = a representative command cost (e.g., sum of base costs
--- for a mid-size army × neutral region mod × micro order mod) — caller computes
--- this from the def set and cost formula, passed in here.
function M.poolRatio(totalPools, typicalArmyCost)
    if typicalArmyCost <= 0 then return 0 end
    return totalPools / typicalArmyCost
end

--- Gini coefficient: inequality across a team's player pools (§2).
--- `playerPools` = array of player pool values (all players on one team).
--- Returns a number in [0, 1]: 0 = perfect equality, 1 = one player has everything.
function M.gini(playerPools)
    local n = #playerPools
    if n == 0 or n == 1 then return 0 end

    -- Sort pools ascending
    local sorted = {}
    for i = 1, n do sorted[i] = playerPools[i] end
    table.sort(sorted)

    local sum = 0
    for i = 1, n do sum = sum + sorted[i] end
    if sum == 0 then return 0 end

    -- Gini = (2 * Σ(i * x_i) / (n * Σx_i)) - (n+1)/n
    local weightedSum = 0
    for i = 1, n do
        weightedSum = weightedSum + i * sorted[i]
    end
    return (2 * weightedSum) / (n * sum) - (n + 1) / n
end

--- Record one frame of dead-team time if the team can't afford `cheapestCost`.
--- `totalPools` = team pool + sum of player pools.
--- `cheapestCost` = the cheapest order the team can issue (typically a posture
--- toggle, the lowest order_class mod × smallest unit base cost).
function M.recordDeadFrame(state, teamID, totalPools, cheapestCost)
    if totalPools < cheapestCost then
        local team = state.teams[teamID]
        if not team then
            team = { velocity_ema = 1.0, dead_frames = 0 }
            state.teams[teamID] = team
        end
        team.dead_frames = team.dead_frames + 1
    end
end

--- Get dead-team time in minutes (§2: "minutes a team spends unable to afford
--- its cheapest posture order"). Returns 0 if the team was never dead.
function M.deadTimeMinutes(state, teamID)
    local team = state.teams[teamID]
    if not team then return 0 end
    return team.dead_frames / (30 * 60)  -- 30 Hz × 60 s/min
end

return M
