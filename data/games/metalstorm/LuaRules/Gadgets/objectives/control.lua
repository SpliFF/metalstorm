-- objectives/control.lua — area-control objective type (PLAN-metalstorm-objectives.md §4.1).
-- Library module included by game_objectives.lua. Hold a region continuously
-- for `holdFrames`; open race when forTeam is nil — whichever team currently
-- owns the region accumulates, first to reach the threshold wins.
--
-- Pure: takes a `ctx` facade (regionOwner/unitsInRegion/unitTeam) instead of
-- calling Spring/GG directly, so this is busted-testable with a fake ctx
-- (§9 "the type-module split exists precisely so these need no engine").
local control = {}

function control.validateParams(params)
    if type(params) ~= 'table' then return false, 'params required' end
    if type(params.regionKey) ~= 'string' or params.regionKey == '' then
        return false, 'regionKey required'
    end
    if type(params.holdFrames) ~= 'number' or params.holdFrames <= 0 then
        return false, 'holdFrames must be a positive number'
    end
    if params.notBefore ~= nil and
       (type(params.notBefore) ~= 'number' or params.notBefore < 0) then
        return false, 'notBefore must be a non-negative number'
    end
    return true
end

--- Open-race delay (PLAN-metalstorm-wars.md §7.5a). The hold clock does not
--- begin accruing before `notBefore`, so completion is always at or after
--- `notBefore + holdFrames` no matter how early a team took the region. This
--- is what makes "the war ended before the sides could meet" unrepresentable
--- rather than merely unlikely: a scenario states the frame at which its prize
--- becomes winnable, and no staging or pathing change can undercut it.
---
--- Clamping the START (rather than gating the completion test) is deliberate.
--- Gating completion would let a team that walked in at frame 60 bank the whole
--- hold and win on the tick `notBefore` passes — the delay would buy no time to
--- contest, which is the entire point of having it.
local function accrualStart(o, since)
    local notBefore = o.params.notBefore or 0
    if since < notBefore then return notBefore end
    return since
end

--- Create-time setup. A bogus regionKey (unknown to the region graph) fails
--- Create (E1) — checked via ctx.regionExists, not just regionOwner (an
--- unowned-but-real region also returns nil from regionOwner).
function control.init(o, ctx)
    if not ctx.regionExists(o.params.regionKey) then
        return false, 'unknown region ' .. tostring(o.params.regionKey)
    end
    o.data = { heldSince = {} }   -- team -> frame it became the current owner
    return true
end

--- Region flip resets the losing team's clock (hysteresis lives in
--- regions/ownership.lua — control just reacts to the published owner).
local function pruneFlippedTeams(held, owner)
    for team in pairs(held) do
        if team ~= owner then held[team] = nil end
    end
end

-- Eligibility gate: forTeam (if set) OR forTeam2 (PLAN-metalstorm-interaction.md
-- §1 joint_objective — GG.Objectives.WidenEligibility widens a scoped
-- control objective to a second team). nil forTeam = open race, always true.
local function eligible(o, team)
    return (not o.forTeam) or team == o.forTeam or (o.forTeam2 and team == o.forTeam2)
end

function control.check(o, ctx)
    local owner = ctx.regionOwner(o.params.regionKey)
    local held = o.data.heldSince
    pruneFlippedTeams(held, owner)
    if not owner then return nil end
    if not eligible(o, owner) then return nil end   -- not an eligible team

    if not held[owner] then held[owner] = ctx.frame end
    if (ctx.frame - accrualStart(o, held[owner])) >= o.params.holdFrames then
        return 'complete', owner
    end
    return nil
end

function control.progress(o, ctx)
    local owner = ctx.regionOwner(o.params.regionKey)
    if not owner or not eligible(o, owner) then return 0 end
    local since = o.data.heldSince[owner]
    if not since then return 0 end
    local held = ctx.frame - accrualStart(o, since)
    if held <= 0 then return 0 end   -- holding, but the race hasn't opened yet
    return math.min(1, held / o.params.holdFrames)
end

--- Participation credit: the currently-accumulating team's units inside the
--- region (§5 "ordering units that act near the objective").
function control.participants(o, ctx)
    local owner = ctx.regionOwner(o.params.regionKey)
    if not owner or not eligible(o, owner) then return {} end
    local out = {}
    for _, unitID in ipairs(ctx.unitsInRegion(o.params.regionKey)) do
        if ctx.unitTeam(unitID) == owner then out[#out + 1] = unitID end
    end
    return out
end

function control.describe(o)
    return 'Control ' .. tostring(o.params.regionKey)
end

return control
