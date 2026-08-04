-- objectives/kill.lua — kill objective type (PLAN-metalstorm-objectives.md §4.2).
-- Library module included by game_objectives.lua. Destroy a specific named
-- unit/building; resolves only through onUnitDestroyed (no periodic check —
-- there is nothing to poll between deaths).
local kill = {}

-- Participation radius around the target (elmos) — units acting within this
-- range of the target are credited as "working the objective" each eval tick.
local PARTICIPATION_RADIUS = 800

function kill.validateParams(params)
    if type(params) ~= 'table' then return false, 'params required' end
    if type(params.targetUnitID) ~= 'number' then
        return false, 'targetUnitID required'
    end
    return true
end

--- Create-time: the target must exist and be alive (E1 "target already dead
--- at create → generator must validate, Create returns nil").
function kill.init(o, ctx)
    if not ctx.unitAlive(o.params.targetUnitID) then
        return false, 'target already dead'
    end
    return true
end

--- No periodic completion — kill only resolves via onUnitDestroyed.
function kill.check(o, ctx)
    return nil
end

--- Binary type: no partial credit until the kill lands.
function kill.progress(o, ctx)
    return 0
end

function kill.onUnitDestroyed(o, unitID, attackerTeam, ctx)
    if unitID ~= o.params.targetUnitID then return nil end
    if attackerTeam then
        return 'complete', attackerTeam
    end
    -- Gaia/decay/self-destruct: no killer to reward (§4.2 edge).
    return 'expired'
end

function kill.participants(o, ctx)
    local x, _, z = ctx.unitPos(o.params.targetUnitID)
    if not x then return {} end
    return ctx.unitsInArea(x, z, PARTICIPATION_RADIUS)
end

function kill.describe(o)
    return 'Kill target ' .. tostring(o.params.targetUnitID)
end

return kill
