-- objectives/protect.lua — protection objective type (PLAN-metalstorm-objectives.md §4.4).
-- Library module included by game_objectives.lua. Keep >= quorum of
-- targetUnitIDs alive until the objective's expiresAtFrame — the one type
-- where expiry-as-success applies (expired → complete), driven centrally by
-- game_objectives.lua's onExpire dispatch. Fails immediately when quorum
-- breaks, via either the periodic check or an UnitDestroyed re-check.
local protect = {}

local PARTICIPATION_RADIUS = 700

function protect.validateParams(params)
    if type(params) ~= 'table' then return false, 'params required' end
    if type(params.targetUnitIDs) ~= 'table' or #params.targetUnitIDs == 0 then
        return false, 'targetUnitIDs required'
    end
    return true
end

--- Create-time: expiresAtFrame is mandatory (protect is defined entirely in
--- terms of "survive until expiry" — an open-ended protect has no way to
--- ever resolve). Quorum defaults to "all surviving, min 1".
function protect.init(o, ctx)
    if not o.expiresAtFrame then
        return false, 'protect objectives require expiresAtFrame'
    end
    local aliveCount = 0
    for _, id in ipairs(o.params.targetUnitIDs) do
        if ctx.unitAlive(id) then aliveCount = aliveCount + 1 end
    end
    if aliveCount == 0 then return false, 'targets already dead' end
    o.data = { quorum = o.params.quorum or aliveCount, startFrame = ctx.frame }
    return true
end

local function aliveCount(o, ctx)
    local n = 0
    for _, id in ipairs(o.params.targetUnitIDs) do
        if ctx.unitAlive(id) then n = n + 1 end
    end
    return n
end

--- Only watches for the fail condition — success is expiry-driven (onExpire).
function protect.check(o, ctx)
    if aliveCount(o, ctx) < o.data.quorum then return 'failed' end
    return nil
end

function protect.onUnitDestroyed(o, unitID, attackerTeam, ctx)
    local isTarget = false
    for _, id in ipairs(o.params.targetUnitIDs) do
        if id == unitID then isTarget = true break end
    end
    if not isTarget then return nil end
    return protect.check(o, ctx)   -- immediate re-evaluation
end

--- Expiry-as-success (§4.4): quorum held for the whole window → complete.
--- Re-verifies as a safety net in case expiry landed the same tick a fail
--- would otherwise have fired.
function protect.onExpire(o, ctx)
    if aliveCount(o, ctx) < o.data.quorum then return 'failed', nil end
    return 'complete', o.forTeam
end

function protect.progress(o, ctx)
    local total = o.expiresAtFrame - o.data.startFrame
    if total <= 0 then return 1 end
    return math.max(0, math.min(1, (ctx.frame - o.data.startFrame) / total))
end

function protect.participants(o, ctx)
    local out = {}
    for _, id in ipairs(o.params.targetUnitIDs) do
        local x, _, z = ctx.unitPos(id)
        if x then
            for _, unitID in ipairs(ctx.unitsInArea(x, z, PARTICIPATION_RADIUS)) do
                out[#out + 1] = unitID
            end
        end
    end
    return out
end

function protect.describe(o)
    return 'Protect until expiry'
end

return protect
