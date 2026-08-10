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
    o.data = {
        heldSince  = {},   -- team -> frame its clock started (observability)
        heldFrames = {},   -- team -> frames actually accrued (the clock)
        lastSeen   = {},   -- team -> frame it was last seen holding the region
    }
    return true
end

--- Region flip resets the losing team's clock (hysteresis lives in
--- regions/ownership.lua — control just reacts to the published owner).
local function pruneFlippedTeams(d, owner)
    for _, tbl in pairs({ d.heldSince, d.heldFrames, d.lastSeen }) do
        for team in pairs(tbl) do
            if team ~= owner then tbl[team] = nil end
        end
    end
end

--- D57 (endtoend fire 29): **control requires occupation, not just ownership.**
--- `regions/ownership.lua` keeps an owner sticky for `DECAY_TICKS = 60` eval
--- ticks (9 000 frames — longer than most wars) so a region does not flicker
--- to neutral when a patrol steps out. Composed with a hold clock that read
--- only the published owner, that meant the war's terminal objective could be
--- won by an army that had walked away: measured twice in one war, the owner's
--- progress climbed 0.38 → 0.60 and 0.40 → complete with ZERO of its units in
--- the region, while the player — who had to *stay* to own it — banked 0.38 for
--- a 2 100-frame occupation. Neither half is wrong alone; the composition is.
---
--- The fix is here rather than in `ownership.lua` because the stickiness is
--- load-bearing for the strategic map and for every other owner-reader; only
--- the hold clock wants the stricter test. An absence **pauses** the clock, it
--- does not reset it — the reset event stays "an opponent arrived and took the
--- region", which is the only thing that means you lost it.
local function ownerPresent(o, ctx, owner)
    for _, unitID in ipairs(ctx.unitsInRegion(o.params.regionKey)) do
        if ctx.unitTeam(unitID) == owner then return true end
    end
    return false
end

--- Frames the owner's clock has banked, in-flight segment excluded (the caller
--- decides whether to count the open interval — `check` accrues it, `progress`
--- previews it).
local function accrue(o, ctx, owner)
    local d = o.data
    if not ownerPresent(o, ctx, owner) then
        d.lastSeen[owner] = nil      -- pause; the next present tick reopens it
        return d.heldFrames[owner] or 0
    end

    local last = d.lastSeen[owner]
    if last then
        local from, to = accrualStart(o, last), ctx.frame
        if to > from then
            d.heldFrames[owner] = (d.heldFrames[owner] or 0) + (to - from)
        end
    end
    d.lastSeen[owner] = ctx.frame
    if not d.heldSince[owner] then
        d.heldSince[owner] = accrualStart(o, ctx.frame)
    end
    return d.heldFrames[owner] or 0
end

-- Eligibility gate: forTeam (if set) OR forTeam2 (PLAN-metalstorm-interaction.md
-- §1 joint_objective — GG.Objectives.WidenEligibility widens a scoped
-- control objective to a second team). nil forTeam = open race, always true.
local function eligible(o, team)
    return (not o.forTeam) or team == o.forTeam or (o.forTeam2 and team == o.forTeam2)
end

function control.check(o, ctx)
    local owner = ctx.regionOwner(o.params.regionKey)
    pruneFlippedTeams(o.data, owner)
    if not owner then return nil end
    if not eligible(o, owner) then return nil end   -- not an eligible team

    if accrue(o, ctx, owner) >= o.params.holdFrames then
        return 'complete', owner
    end
    return nil
end

function control.progress(o, ctx)
    local owner = ctx.regionOwner(o.params.regionKey)
    if not owner or not eligible(o, owner) then return 0 end
    local d = o.data
    local held = d.heldFrames[owner] or 0

    -- Preview the open interval so progress reads the same whether or not
    -- `check` has already run this frame (it runs first on the eval tick, so
    -- in the gadget the two agree exactly). Read-only: no mutation here.
    local last = d.lastSeen[owner]
    if last and ownerPresent(o, ctx, owner) then
        local from = accrualStart(o, last)
        if ctx.frame > from then held = held + (ctx.frame - from) end
    end

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
