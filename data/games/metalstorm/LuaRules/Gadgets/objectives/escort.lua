-- objectives/escort.lua — escort objective type (PLAN-metalstorm-objectives.md §4.3).
-- Library module included by game_objectives.lua. Convoy reaches destination
-- intact; payload units are civilian convoy units registered via
-- GG.Civilians.Register(id, 'payload'). Completes when >= quorum surviving
-- payload units are inside destArea; fails when all payload are dead.
local escort = {}

local PARTICIPATION_RADIUS = 600

local function centroid(ids, ctx)
    local sx, sz, n = 0, 0, 0
    for _, id in ipairs(ids) do
        local x, _, z = ctx.unitPos(id)
        if x then sx, sz, n = sx + x, sz + z, n + 1 end
    end
    if n == 0 then return nil end
    return sx / n, sz / n
end

local function dist2(x1, z1, x2, z2)
    local dx, dz = x1 - x2, z1 - z2
    return dx * dx + dz * dz
end

function escort.validateParams(params)
    if type(params) ~= 'table' then return false, 'params required' end
    if type(params.payloadUnitIDs) ~= 'table' or #params.payloadUnitIDs == 0 then
        return false, 'payloadUnitIDs required'
    end
    local dest = params.destArea
    if type(dest) ~= 'table' or type(dest.x) ~= 'number' or type(dest.z) ~= 'number'
       or type(dest.r) ~= 'number' or dest.r <= 0 then
        return false, 'destArea {x,z,r} required'
    end
    return true
end

--- Create-time: at least one payload unit must be alive; quorum defaults to
--- "all surviving, min 1" (§4.3). Captures the start centroid for progress.
function escort.init(o, ctx)
    local aliveCount = 0
    for _, id in ipairs(o.params.payloadUnitIDs) do
        if ctx.unitAlive(id) then aliveCount = aliveCount + 1 end
    end
    if aliveCount == 0 then return false, 'payload already dead' end

    local sx, sz = centroid(o.params.payloadUnitIDs, ctx)
    o.data = {
        quorum = o.params.quorum or 1,
        startX = sx, startZ = sz,
    }
    return true
end

local function countAliveAndArrived(o, ctx)
    local dest = o.params.destArea
    local alive, arrived = 0, 0
    for _, id in ipairs(o.params.payloadUnitIDs) do
        if ctx.unitAlive(id) then
            alive = alive + 1
            local x, _, z = ctx.unitPos(id)
            if x and dist2(x, z, dest.x, dest.z) <= dest.r * dest.r then
                arrived = arrived + 1
            end
        end
    end
    return alive, arrived
end

function escort.check(o, ctx)
    local alive, arrived = countAliveAndArrived(o, ctx)
    if alive == 0 then return 'failed' end
    if arrived >= o.data.quorum then return 'complete', o.forTeam end
    return nil
end

function escort.onUnitDestroyed(o, unitID, attackerTeam, ctx)
    local isPayload = false
    for _, id in ipairs(o.params.payloadUnitIDs) do
        if id == unitID then isPayload = true break end
    end
    if not isPayload then return nil end
    return escort.check(o, ctx)   -- immediate re-evaluation (payload loss → fail)
end

--- Route-covered fraction: distance travelled from the start centroid
--- toward destArea, relative to the initial distance.
function escort.progress(o, ctx)
    local cx, cz = centroid(o.params.payloadUnitIDs, ctx)
    if not cx then return o.progress or 0 end
    local dest = o.params.destArea
    local totalDist = math.sqrt(dist2(o.data.startX, o.data.startZ, dest.x, dest.z))
    if totalDist <= 0 then return 1 end
    local remaining = math.sqrt(dist2(cx, cz, dest.x, dest.z))
    return math.max(0, math.min(1, 1 - remaining / totalDist))
end

function escort.participants(o, ctx)
    local cx, cz = centroid(o.params.payloadUnitIDs, ctx)
    if not cx then return {} end
    return ctx.unitsInArea(cx, cz, PARTICIPATION_RADIUS)
end

function escort.describe(o)
    return 'Escort convoy to destination'
end

return escort
