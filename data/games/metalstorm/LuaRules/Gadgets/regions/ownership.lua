-- regions/ownership.lua — ownership hysteresis state machine
-- (PLAN-metalstorm-regions.md §3).
--
-- Pure Lua: one `step(state, scores)` call per eval tick. Locked constants:
--
--   neutral --(team leads by >= DOMINANCE for FLIP_TICKS consecutive ticks)--> owned(team)
--   owned(T) --(other team leads by >= DOMINANCE for FLIP_TICKS)--> owned(other)  (through contested)
--   owned(T) --(region empty)--> owned(T)                       -- sticky
--   owned(T) --(empty for DECAY_TICKS)--> neutral                -- eventually forgotten
--   any state, >=2 teams each >= CONTEST_FLOOR --> contested = true (orthogonal to owner)
--
-- leadTicks streaks reset whenever a team loses the lead (no partial credit
-- carries across a flicker) — this is also what makes control-objective
-- `heldSince` meaningful rather than flickery.

local M = {}

M.DOMINANCE     = 1.5   -- leader must exceed runner-up by 50%
M.FLIP_TICKS    = 3     -- consecutive dominant ticks to flip (15s @ 5s eval period)
M.CONTEST_FLOOR = 200   -- strength threshold to count as "present" for contest
M.DECAY_TICKS   = 60    -- eval ticks empty before a sticky owner reverts to neutral (~5 min @ 5s/tick)

function M.newState()
    return {}   -- [regionKey] = { owner=nil, leadTicks={[team]=n}, contested=false, emptyTicks=0 }
end

local function newRegionState()
    return { owner = nil, leadTicks = {}, contested = false, emptyTicks = 0 }
end

--- Leader (highest score) and runner-up score among present teams.
local function leaderAndRunnerUp(byTeam)
    local leader, leaderScore, runnerUpScore = nil, 0, 0
    for team, score in pairs(byTeam) do
        if score > leaderScore then
            runnerUpScore = leaderScore
            leader, leaderScore = team, score
        elseif score > runnerUpScore then
            runnerUpScore = score
        end
    end
    return leader, leaderScore, runnerUpScore
end

--- Step one region. `byTeam` is `scores[regionKey]` for this tick, or nil/empty
--- if no unit is present. Mutates and returns `rs`, plus whether owner or
--- contested changed (publish-on-change, §5).
local function stepRegion(rs, byTeam, constants)
    rs = rs or newRegionState()
    constants = constants or M
    local prevOwner, prevContested = rs.owner, rs.contested

    local presentTeams = 0
    if byTeam then
        for _, score in pairs(byTeam) do
            if score >= constants.CONTEST_FLOOR then
                presentTeams = presentTeams + 1
            end
        end
    end
    rs.contested = presentTeams >= 2

    local hasAny = byTeam ~= nil and next(byTeam) ~= nil
    if not hasAny then
        -- Empty: sticky owner, decay after DECAY_TICKS (E4: dead-team
        -- ownership persists the same way — this state machine doesn't
        -- distinguish "empty because the owner left" from any other empty).
        rs.emptyTicks = (rs.emptyTicks or 0) + 1
        rs.leadTicks = {}
        if rs.owner ~= nil and rs.emptyTicks >= constants.DECAY_TICKS then
            rs.owner = nil
        end
        local changed = (rs.owner ~= prevOwner) or (rs.contested ~= prevContested)
        return rs, changed
    end
    rs.emptyTicks = 0

    local leader, leaderScore, runnerUpScore = leaderAndRunnerUp(byTeam)
    if leader and leaderScore >= runnerUpScore * constants.DOMINANCE then
        rs.leadTicks[leader] = (rs.leadTicks[leader] or 0) + 1
        for team in pairs(rs.leadTicks) do
            if team ~= leader then rs.leadTicks[team] = 0 end
        end
        if leader ~= rs.owner and rs.leadTicks[leader] >= constants.FLIP_TICKS then
            rs.owner = leader
        end
    else
        -- No clear dominant leader this tick — flicker doesn't flip: reset
        -- every team's streak rather than letting a near-miss carry over.
        for team in pairs(rs.leadTicks) do
            rs.leadTicks[team] = 0
        end
    end

    local changed = (rs.owner ~= prevOwner) or (rs.contested ~= prevContested)
    return rs, changed
end

--- Step every region present in `state` or `scores` this tick. Returns the
--- (mutated) state and a list of region keys whose owner or contested flag
--- changed this tick (candidates for rulesParams publish + regions_rev bump).
function M.step(state, scores, constants)
    local keys = {}
    for k in pairs(state) do keys[k] = true end
    for k in pairs(scores) do keys[k] = true end

    local changedKeys = {}
    for key in pairs(keys) do
        local rs, changed = stepRegion(state[key], scores[key], constants)
        state[key] = rs
        if changed then changedKeys[#changedKeys + 1] = key end
    end
    return state, changedKeys
end

return M
