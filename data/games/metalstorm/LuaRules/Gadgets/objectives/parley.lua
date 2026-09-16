-- objectives/parley.lua — agreement objective type (PLAN-beta.md "Vocabulary":
-- a Mission is not always a battle; a diplomacy Mission ends on a pact).
-- Library module included by game_objectives.lua. Pure: reads the pacts
-- game_parley.lua publishes (`parley_count`, `parley_<id>_{kind,from,to,state}`)
-- through `ctx.gameRulesParam`, never GG.
--
-- params: { kind = 'intel' | 'ceasefire' | … (optional), withTeam = n (optional) }
-- Completes for the objective's team once a matching proposal involving it is
-- accepted ('active' or 'fulfilled'). An open race (forTeam nil) completes for
-- whichever team proposed the accepted pact.
local parley = {}

local KINDS = {
    ceasefire = true, tribute = true, safe_passage = true,
    joint_objective = true, demand = true, intel = true,
}

local ACCEPTED = { active = true, fulfilled = true }

function parley.validateParams(params)
    if type(params) ~= 'table' then return false, 'params required' end
    if params.kind ~= nil and not KINDS[params.kind] then
        return false, 'unknown parley kind "' .. tostring(params.kind) .. '"'
    end
    if params.withTeam ~= nil and type(params.withTeam) ~= 'number' then
        return false, 'withTeam must be a team number'
    end
    return true
end

function parley.init(o, ctx)
    if type(ctx.gameRulesParam) ~= 'function' then return false, 'ctx.gameRulesParam missing' end
    o.data = { sinceProposal = tonumber(ctx.gameRulesParam('parley_count')) or 0 }
    return true
end

local function eligible(o, from, to)
    local other = o.params.withTeam
    local mine = o.forTeam
    if mine == nil then
        return other == nil or from == other or to == other
    end
    if from == mine then return other == nil or to == other end
    if to == mine then return other == nil or from == other end
    return false
end

--- Walk the published proposals newer than the objective. Returns the first
--- matching proposal in `state` (a set), or nil.
local function find(o, ctx, states)
    local n = tonumber(ctx.gameRulesParam('parley_count')) or 0
    local kind = o.params.kind
    for id = (o.data and o.data.sinceProposal or 0) + 1, n do
        local p = 'parley_' .. id .. '_'
        local state = ctx.gameRulesParam(p .. 'state')
        if state and states[state] and (kind == nil or ctx.gameRulesParam(p .. 'kind') == kind) then
            local from = tonumber(ctx.gameRulesParam(p .. 'from'))
            local to = tonumber(ctx.gameRulesParam(p .. 'to'))
            if eligible(o, from, to) then return { id = id, from = from, to = to } end
        end
    end
    return nil
end

function parley.check(o, ctx)
    local p = find(o, ctx, ACCEPTED)
    if not p then return nil end
    return 'complete', o.forTeam or p.from
end

--- Half credit while a matching proposal is on the table.
function parley.progress(o, ctx)
    if find(o, ctx, ACCEPTED) then return 1 end
    if find(o, ctx, { offered = true, countered = true }) then return 0.5 end
    return 0
end

function parley.describe(o)
    local what = o.params.kind and ('a ' .. tostring(o.params.kind):gsub('_', ' ') .. ' pact') or 'a pact'
    if o.params.withTeam then return 'Agree ' .. what .. ' with team ' .. o.params.withTeam end
    return 'Agree ' .. what
end

return parley
