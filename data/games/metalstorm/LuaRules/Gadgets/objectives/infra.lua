-- objectives/infra.lua — infrastructure objective type (PLAN-metalstorm-objectives.md §4.6).
-- Library module included by game_objectives.lua. "Running" = alive and (if
-- the unit def carries an `operational` rulesParam, e.g. transit-hub
-- throughput) operational. Two variants, distinguished by whether the
-- objective carries an expiresAtFrame:
--   timed      — behaves like protect: survive to expiry → complete.
--   open-ended — no expiry; ticks a periodic award (rewardPerMinute) via
--                income() instead of a lump-sum completion — the "income
--                building" pattern. Never resolves on its own; only fails.
local infra = {}

local PARTICIPATION_RADIUS = 700
local FRAMES_PER_MINUTE = 1800   -- GAME_SPEED 30 * 60

function infra.validateParams(params)
    if type(params) ~= 'table' then return false, 'params required' end
    if type(params.buildingUnitIDs) ~= 'table' or #params.buildingUnitIDs == 0 then
        return false, 'buildingUnitIDs required'
    end
    if params.rewardPerMinute ~= nil and (type(params.rewardPerMinute) ~= 'number' or params.rewardPerMinute < 0) then
        return false, 'rewardPerMinute must be a non-negative number'
    end
    return true
end

local function runningCount(o, ctx)
    local n = 0
    for _, id in ipairs(o.params.buildingUnitIDs) do
        if ctx.unitAlive(id) and ctx.isOperational(id) then n = n + 1 end
    end
    return n
end

function infra.init(o, ctx)
    local running = runningCount(o, ctx)
    if running == 0 then return false, 'buildings already down' end
    o.data = { quorum = o.params.quorum or #o.params.buildingUnitIDs, startFrame = ctx.frame }
    return true
end

--- Only watches for the fail condition. Timed success is expiry-driven
--- (onExpire); open-ended never succeeds outright — it just keeps paying
--- income() while running.
function infra.check(o, ctx)
    if runningCount(o, ctx) < o.data.quorum then return 'failed' end
    return nil
end

function infra.onUnitDestroyed(o, unitID, attackerTeam, ctx)
    local isTarget = false
    for _, id in ipairs(o.params.buildingUnitIDs) do
        if id == unitID then isTarget = true break end
    end
    if not isTarget then return nil end
    return infra.check(o, ctx)
end

--- Timed variant behaves like protect (§4.4): survives to expiry → complete.
--- Open-ended infra has no expiresAtFrame, so game_objectives.lua never
--- calls onExpire for it.
function infra.onExpire(o, ctx)
    if runningCount(o, ctx) < o.data.quorum then return 'failed', nil end
    return 'complete', o.forTeam
end

--- Periodic award for the open-ended variant (called every eval tick by
--- game_objectives.lua regardless of check() outcome, so it keeps paying
--- right up to the tick a failure lands). Timed infra has no rewardPerMinute
--- and this returns nil.
function infra.income(o, ctx)
    if o.expiresAtFrame or not o.params.rewardPerMinute or o.params.rewardPerMinute <= 0 then
        return nil
    end
    if runningCount(o, ctx) < o.data.quorum then return nil end
    local periodFrames = ctx.evalPeriodFrames or FRAMES_PER_MINUTE
    return o.params.rewardPerMinute * (periodFrames / FRAMES_PER_MINUTE)
end

function infra.progress(o, ctx)
    if o.expiresAtFrame then
        local total = o.expiresAtFrame - o.data.startFrame
        if total <= 0 then return 1 end
        return math.max(0, math.min(1, (ctx.frame - o.data.startFrame) / total))
    end
    -- Open-ended: progress reads as "fraction currently running" for the UI bar.
    return runningCount(o, ctx) / o.data.quorum
end

function infra.participants(o, ctx)
    local out = {}
    for _, id in ipairs(o.params.buildingUnitIDs) do
        local x, _, z = ctx.unitPos(id)
        if x then
            for _, unitID in ipairs(ctx.unitsInArea(x, z, PARTICIPATION_RADIUS)) do
                out[#out + 1] = unitID
            end
        end
    end
    return out
end

--- The units this objective is defined in terms of — see kill.lua's
--- unitRefs for why the type module answers this (task 4's DefsReconciled).
function infra.unitRefs(o)
    return o.params.buildingUnitIDs
end

function infra.describe(o)
    return o.expiresAtFrame and 'Infrastructure: hold until expiry' or 'Infrastructure: income'
end

return infra
