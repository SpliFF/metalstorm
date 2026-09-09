-- lib/scheduler.lua — strategic-tick scheduler with LOD.  PURE.
--
-- The runtime calls `onUpdate(frame)` every AIRuntimePool::tickInterval (10
-- sim frames) and — today — SYNCHRONOUSLY ON THE SIM THREAD (AIRuntimePool.cpp
-- "process each AI synchronously for now"), so an AI that thinks every call
-- costs the whole server. This module is the throttle: it says when a
-- strategic tick is due, and stretches the period by a LOD tier so a faction
-- nobody is fighting thinks once a minute instead of every five seconds.
--
-- The tier is CONTACT-derived (region-graph hops from our ground to seen
-- enemies) because a game-shipped plugin must not read player viewports (no
-- cheating channels); when the engine ever exposes AI.getLODLevel() (gap G3),
-- pass it as `opts.engineTier` and it wins outright. Escalation is instant,
-- de-escalation waits a dwell per tier (PLAN-ai.md "LOD Transitions").

local Scheduler = {}
Scheduler.__index = Scheduler

Scheduler.TIER_FULL    = 0
Scheduler.TIER_DORMANT = 3

--- cfg: { base = 150, mult = {[0]=1,[1]=1,[2]=4,[3]=12}, floor = 0, ceil = 3,
--         dwell = {[0]=150,[1]=300,[2]=900} }
function Scheduler.new(cfg)
    cfg = cfg or {}
    local self = setmetatable({}, Scheduler)
    self.base  = cfg.base or 150
    self.mult  = cfg.mult or { [0] = 1, [1] = 1, [2] = 4, [3] = 12 }
    self.floor = cfg.floor or Scheduler.TIER_FULL
    self.ceil  = cfg.ceil  or Scheduler.TIER_DORMANT
    self.dwell = cfg.dwell or { [0] = 150, [1] = 300, [2] = 900 }
    self.tierNow = self.floor
    self.want, self.wantSince = nil, nil
    self.lastTick = nil
    self.ticks = 0
    return self
end

function Scheduler:clamp(t)
    return math.max(self.floor, math.min(self.ceil, t))
end

--- Contact hops → wanted tier. nil hops (no contact / blind) → dormant.
function Scheduler.tierForHops(hops)
    if hops == nil then return Scheduler.TIER_DORMANT end
    if hops <= 0 then return 0 end
    if hops == 1 then return 1 end
    if hops == 2 then return 2 end
    return Scheduler.TIER_DORMANT
end

--- Period (frames) at the current tier.
function Scheduler:period()
    return math.max(1, math.floor(self.base * (self.mult[self.tierNow] or 1)))
end

function Scheduler:tier() return self.tierNow end

--- Is a strategic tick due at `frame`? Marks it taken when true. The first
-- call is always due (a fresh VM thinks immediately).
function Scheduler:due(frame)
    if self.lastTick ~= nil and (frame - self.lastTick) < self:period() then
        return false
    end
    self.lastTick = frame
    self.ticks = self.ticks + 1
    return true
end

--- Feed this tick's observation. opts: { hops = contact hops | nil,
-- contested = bool (own ground under fight → tier 0), engineTier = int | nil }.
-- Returns the tier the NEXT period derives from.
function Scheduler:observe(frame, opts)
    opts = opts or {}
    if opts.engineTier ~= nil then
        self.tierNow = self:clamp(opts.engineTier)
        self.want, self.wantSince = nil, nil
        return self.tierNow
    end
    local want = opts.contested and 0 or Scheduler.tierForHops(opts.hops)
    want = self:clamp(want)
    local current = self:clamp(self.tierNow)
    if want <= current then                      -- escalate / hold: immediate
        self.tierNow, self.want, self.wantSince = want, nil, nil
        return want
    end
    if self.want ~= want then self.want, self.wantSince = want, frame end
    if (frame - (self.wantSince or frame)) >= (self.dwell[current] or 0) then
        self.tierNow = self:clamp(current + 1)  -- one tier per dwell window
        self.want, self.wantSince = nil, nil
    end
    return self.tierNow
end

return Scheduler
