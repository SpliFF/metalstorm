-- objectives/extract.lua — extraction objective type (PLAN-metalstorm-objectives.md §4.5).
-- Library module included by game_objectives.lua. Two phases:
--   'secure' — eligible team's strength inside pickupArea exceeds threshold
--              for holdFrames, then the payload is moved (fromLua, free)
--              toward extractArea and the objective advances to 'evac'.
--   'evac'   — >= quorum surviving payload units inside extractArea → complete.
-- Fails in either phase once the whole payload is dead.
local extract = {}

local PARTICIPATION_RADIUS_MULT = 1.0   -- participation area = the active phase's area radius

local function dist2(x1, z1, x2, z2)
    local dx, dz = x1 - x2, z1 - z2
    return dx * dx + dz * dz
end

local function validArea(a)
    return type(a) == 'table' and type(a.x) == 'number' and type(a.z) == 'number'
       and type(a.r) == 'number' and a.r > 0
end

function extract.validateParams(params)
    if type(params) ~= 'table' then return false, 'params required' end
    if type(params.payloadUnitIDs) ~= 'table' or #params.payloadUnitIDs == 0 then
        return false, 'payloadUnitIDs required'
    end
    if not validArea(params.pickupArea) then return false, 'pickupArea {x,z,r} required' end
    if not validArea(params.extractArea) then return false, 'extractArea {x,z,r} required' end
    if type(params.holdFrames) ~= 'number' or params.holdFrames <= 0 then
        return false, 'holdFrames must be a positive number'
    end
    if type(params.threshold) ~= 'number' or params.threshold < 0 then
        return false, 'threshold must be a non-negative number'
    end
    return true
end

function extract.init(o, ctx)
    local aliveCount = 0
    for _, id in ipairs(o.params.payloadUnitIDs) do
        if ctx.unitAlive(id) then aliveCount = aliveCount + 1 end
    end
    if aliveCount == 0 then return false, 'payload already dead' end
    o.data = {
        phase = 'secure',
        quorum = o.params.quorum or 1,
        secureSince = nil,
    }
    return true
end

local function alivePayload(o, ctx)
    local out = {}
    for _, id in ipairs(o.params.payloadUnitIDs) do
        if ctx.unitAlive(id) then out[#out + 1] = id end
    end
    return out
end

local function checkSecurePhase(o, ctx)
    local strength = ctx.teamStrengthInArea(o.params.pickupArea.x, o.params.pickupArea.z,
                                             o.params.pickupArea.r, o.forTeam)
    if strength <= o.params.threshold then
        o.data.secureSince = nil
        return nil
    end
    if not o.data.secureSince then o.data.secureSince = ctx.frame end
    if (ctx.frame - o.data.secureSince) < o.params.holdFrames then return nil end

    -- Secured: move the surviving payload toward extractArea (§4.5, issued
    -- through the civilians module, fromLua, free — ctx.issueMove).
    local alive = alivePayload(o, ctx)
    if #alive == 0 then return 'failed' end
    ctx.issueMove(alive, o.params.extractArea.x, o.params.extractArea.z)
    o.data.phase = 'evac'
    o.data.secureSince = nil
    return nil
end

local function checkEvacPhase(o, ctx)
    local alive = alivePayload(o, ctx)
    if #alive == 0 then return 'failed' end
    local inside = 0
    local area = o.params.extractArea
    for _, id in ipairs(alive) do
        local x, _, z = ctx.unitPos(id)
        if x and dist2(x, z, area.x, area.z) <= area.r * area.r then
            inside = inside + 1
        end
    end
    if inside >= o.data.quorum then return 'complete', o.forTeam end
    return nil
end

function extract.check(o, ctx)
    if o.data.phase == 'secure' then return checkSecurePhase(o, ctx) end
    return checkEvacPhase(o, ctx)
end

function extract.onUnitDestroyed(o, unitID, attackerTeam, ctx)
    local isPayload = false
    for _, id in ipairs(o.params.payloadUnitIDs) do
        if id == unitID then isPayload = true break end
    end
    if not isPayload then return nil end
    if #alivePayload(o, ctx) == 0 then return 'failed' end
    return nil
end

--- Phase-weighted: 0..0.5 securing, 0.5..1 evacuating (drives the UI's
--- "SECURING 2/3 -> EVACUATING" label, §4.5).
function extract.progress(o, ctx)
    if o.data.phase == 'secure' then
        if not o.data.secureSince then return 0 end
        local frac = (ctx.frame - o.data.secureSince) / o.params.holdFrames
        return 0.5 * math.max(0, math.min(1, frac))
    end
    local alive = alivePayload(o, ctx)
    if #alive == 0 then return 0.5 end
    local inside = 0
    local area = o.params.extractArea
    for _, id in ipairs(alive) do
        local x, _, z = ctx.unitPos(id)
        if x and dist2(x, z, area.x, area.z) <= area.r * area.r then inside = inside + 1 end
    end
    return 0.5 + 0.5 * math.max(0, math.min(1, inside / o.data.quorum))
end

function extract.participants(o, ctx)
    local area = (o.data.phase == 'secure') and o.params.pickupArea or o.params.extractArea
    return ctx.unitsInArea(area.x, area.z, area.r * PARTICIPATION_RADIUS_MULT)
end

--- The units this objective is defined in terms of — see kill.lua's
--- unitRefs for why the type module answers this (task 4's DefsReconciled).
function extract.unitRefs(o)
    return o.params.payloadUnitIDs
end

function extract.describe(o)
    return (o.data and o.data.phase == 'evac') and 'Extract: evacuating' or 'Extract: securing'
end

return extract
