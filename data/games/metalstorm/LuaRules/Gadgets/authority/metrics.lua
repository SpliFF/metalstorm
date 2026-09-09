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
local FRAMES_PER_MINUTE  = 1800

-- ── Why velocity is a RATIO OF TWO EMAs, not an EMA of a ratio (review 2026-09-10) ──
--
-- The first cut folded burn/mint into one EMA per frame: on a frame with a
-- mint it sampled `burnDelta / mintDelta`, and on every other frame it fed the
-- EMA its own previous value (a no-op). Two things follow, and together they
-- make the number meaningless:
--   * a mint frame almost never carries a burn (an award lands in one frame,
--     the orders it funds are issued over the next minutes), so every sample
--     the EMA ever took was ≈ 0;
--   * a burn-only frame — which is where ALL the spending is — was never
--     sampled at all.
-- So velocity could only ever decay toward 0, whatever a team spent. With
-- reward normalisation (§3 lever 2) that clamps `1/velocity` to ×2.0 and pins
-- every systemic reward at double, permanently — the opposite of a trim tab.
--
-- Tracking the two RATES separately (each an EMA over every frame, zeros
-- included) and dividing at read time measures what §2 defines: burn/min ÷
-- mint/min over the window.
--
-- WARM-UP. A rate EMA starts at 0 and a 30-min window needs time to fill, so
-- for the first minutes a single award would read as "mint ≫ burn" and a
-- single order as the reverse. Until `VELOCITY_WARMUP_FRAMES` have been
-- observed the metric reports the neutral 1.0 — the honest answer while the
-- window is empty, and the value that leaves normalisation at ×1.
local VELOCITY_WARMUP_FRAMES = 5 * FRAMES_PER_MINUTE
local VELOCITY_MAX           = 10.0     -- burn with (near-)zero mint reads as "starving", capped
local RATE_EPSILON           = 1e-9

local function newTeam()
    return {
        mint_ema = 0.0,       -- authority per minute, EMA
        burn_ema = 0.0,
        frames   = 0,         -- frames observed (warm-up)
        velocity_ema = 1.0,   -- kept as the READ value for snapshot/consumer compatibility
        dead_frames = 0,
    }
end

--- Create a new metrics state (per-team rate EMAs + dead-time counters).
function M.newState()
    return {
        teams = {},  -- [teamID] = { mint_ema, burn_ema, frames, velocity_ema, dead_frames }
    }
end

local function velocityOf(team)
    if team.frames < VELOCITY_WARMUP_FRAMES then return 1.0 end
    if team.mint_ema > RATE_EPSILON then
        return math.min(VELOCITY_MAX, team.burn_ema / team.mint_ema)
    end
    if team.burn_ema > RATE_EPSILON then return VELOCITY_MAX end
    return 1.0
end

--- Update the rate EMAs for one team (called every frame, from ledger deltas).
--- `mintDelta` and `burnDelta` are the amounts added to mint/burn counters
--- since the last call (zero on most frames). `frames` (optional, default 1)
--- lets a caller that samples less often than every frame — the economy
--- harness — advance the window by the frames it covered. Returns the updated
--- velocity.
function M.updateVelocity(state, teamID, mintDelta, burnDelta, frames)
    local team = state.teams[teamID]
    if not team then
        team = newTeam()
        state.teams[teamID] = team
    end
    frames = frames or 1
    -- Per-minute rates for THIS sample: the whole delta is attributed to the
    -- frames it covers.
    local mintRate = (mintDelta or 0) * FRAMES_PER_MINUTE / frames
    local burnRate = (burnDelta or 0) * FRAMES_PER_MINUTE / frames
    -- Applying the per-frame alpha `frames` times is (1-a)^frames on the old
    -- value; one closed-form step keeps the window exact for a coarse sampler.
    local keep = (1 - VELOCITY_EMA_ALPHA) ^ frames
    team.mint_ema = mintRate + (team.mint_ema - mintRate) * keep
    team.burn_ema = burnRate + (team.burn_ema - burnRate) * keep
    team.frames = team.frames + frames
    team.velocity_ema = velocityOf(team)
    return team.velocity_ema
end

--- Get current velocity for a team (read-only). 1.0 while the window is
--- still warming up or for a team the ledger has never seen.
function M.velocity(state, teamID)
    local team = state.teams[teamID]
    if not team then return 1.0 end
    -- A snapshot restored from before the rate split carries only
    -- `velocity_ema`; honour it rather than re-deriving from absent fields.
    if team.mint_ema == nil then return team.velocity_ema or 1.0 end
    return velocityOf(team)
end

--- The per-minute rate EMAs themselves (mint, burn), for telemetry.
function M.rates(state, teamID)
    local team = state.teams[teamID]
    if not team or team.mint_ema == nil then return 0, 0 end
    return team.mint_ema, team.burn_ema
end

M.VELOCITY_WARMUP_FRAMES = VELOCITY_WARMUP_FRAMES

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
            team = newTeam()
            state.teams[teamID] = team
        end
        team.dead_frames = (team.dead_frames or 0) + 1
    end
end

--- Get dead-team time in minutes (§2: "minutes a team spends unable to afford
--- its cheapest posture order"). Returns 0 if the team was never dead.
function M.deadTimeMinutes(state, teamID)
    local team = state.teams[teamID]
    if not team then return 0 end
    return (team.dead_frames or 0) / (30 * 60)  -- 30 Hz × 60 s/min
end

return M
