-- garrison/main.lua — runtime entry for the Metalstorm Garrison AI.
--
-- The orchestrator: owns cross-tick memory, turns the crank
--     picture:refresh() → Brain.decide() → actuator:directive()
-- and nothing else. Everything that decides lives in brain.lua (pure);
-- everything that reads/writes the engine lives in ai/lib.
--
-- The runtime calls the global `onUpdate(frame)` every 10 sim frames
-- (AIRuntimePool::tickInterval), synchronously on the sim thread. The
-- scheduler throttles that to one strategic tick per 150 frames at full
-- alert, stretching to 1 800 frames when nothing is in contact (lib/scheduler).
--
-- `lib/` is a symlink to `../lib` (the AI VM's require is plugin-scoped —
-- docs/ai-players.md F3/P3).

local function need(name)
    if type(require) ~= 'function' then
        error("[garrison] no module loader in AI VM — cannot require '" .. name .. "'", 0)
    end
    return require(name)
end

local Engine     = need('lib.engine')
local Picture    = need('lib.picture')
local Authority  = need('lib.authority')
local Directives = need('lib.directives')
local Actuator   = need('lib.actuator')
local Scheduler  = need('lib.scheduler')
local Reporter   = need('lib.reporter')
local Brain      = need('brain')

local PROFILES = { sentinel = true, skittish = true, stalwart = true }   -- allow-list
local DEFAULT_PROFILE = 'sentinel'

local self = {
    booted = false, profile = nil, settings = nil, state = nil,
    picture = nil, actuator = nil, scheduler = nil, reporter = nil,
    playerId = -1, teamId = -1,
}

local function resolveProfile()
    local hint = Picture.profileHint(Engine.playerId())
    local name, rejected = DEFAULT_PROFILE, nil
    if hint then
        if PROFILES[hint] then name = hint else rejected = hint end
    end
    local ok, profile = pcall(need, 'profiles.' .. name)
    if not ok or type(profile) ~= 'table' then profile = need('profiles.' .. DEFAULT_PROFILE) end
    return profile, rejected
end

local function boot()
    self.profile, self.rejected = resolveProfile()
    self.settings  = Brain.settings(self.profile)
    self.state     = Brain.newState()
    self.playerId  = Engine.playerId()
    self.teamId    = Engine.teamId()
    self.picture   = Picture.new({})
    self.actuator  = Actuator.new({ name = 'garrison', maxPerTick = 6 })
    self.scheduler = Scheduler.new({ base = 150, floor = self.settings.lodFloor,
                                     ceil = self.settings.lodCeil })
    self.reporter  = Reporter.new({ name = 'garrison', every = 6, actuator = self.actuator })
    Authority.load()
    self.booted = true
    self.reporter:event('online', { profile = self.profile.id, player = self.playerId,
                                    team = self.teamId, costSpec = Authority.source() })
    if self.rejected then
        self.reporter:event('warning', { unknownProfile = self.rejected, using = self.profile.id })
    end
end

local function strategicTick(frame)
    local t0 = Engine.nowMs()
    local picture = self.picture:refresh(frame)
    local ttl = self.scheduler:period() * 2
    local budget, pool = Brain.budget(picture, self.settings)
    local costScale = picture.economy.costScale
    local decision = Brain.decide(picture, self.profile, self.state, {
        budget = budget, ttl = ttl,
        costOf = function(scope) return Authority.directiveCost({ scope = scope, costScale = costScale }) end,
    })

    -- Write. Objective orders carry an `ai.intent` tag BEFORE their directive
    -- (same codec + ordering contract as strategos, so game_ai_guidance.lua's
    -- intent panel / veto loop annotate the garrison's spend too).
    self.actuator:beginTick(frame, { budget = budget, ttlFrames = ttl, costScale = costScale })
    for _, o in ipairs(decision.orders) do
        local target = o.anchor or picture.regions[o.region]
        local spec = Directives.build({ type = o.directive, region = o.anchor == nil and target or nil,
                                        anchor = o.anchor, priority = o.priority, ttl = ttl })
        if spec then
            if o.goalId then
                self.actuator:message('ai.intent', { goalId = o.goalId, dt = spec.type, region = o.region })
            end
            local ok, why = self.actuator:directive(spec, { kind = o.kind, region = o.region,
                                                            reason = o.reason, goalId = o.goalId },
                                                    { force = o.force })
            if ok and (o.kind == 'WITHDRAW' or o.kind == 'DEFEND_FRONT' or o.kind == 'OBJECTIVE') then
                self.reporter:event(o.kind:lower(), { region = o.region, reason = o.reason })
            elseif not ok and why ~= 'rate clamp' then
                self.reporter:event('refused', { kind = o.kind, region = o.region, why = why })
            end
        end
    end

    -- LOD for the next period: contact hops, contested home pins tier 0.
    local contested = false
    for key in pairs(decision.home or {}) do
        local r = picture.regions[key]
        if r and r.contested then contested = true end
    end
    local tier = self.scheduler:observe(frame, { hops = picture.contactHops, contested = contested })

    local st = self.actuator:stats()
    local ms = t0 and Engine.nowMs() and (Engine.nowMs() - t0) or nil
    self.reporter:tick(frame, {
        tier = tier, period = self.scheduler:period(), orders = #decision.orders,
        issued = st.tick.issued, spent = st.tick.spent, pool = pool, budget = budget,
        idle = decision.idle or 0, errors = st.total.errors, computeMs = ms,
        home = (function() local n = 0; for _ in pairs(decision.home or {}) do n = n + 1 end; return n end)(),
    })
end

function onUpdate(frame)
    if not self.booted then
        local ok, err = pcall(boot)
        if not ok then
            AI_GARRISON_BOOT_ERROR = tostring(err)
            Engine.log('[garrison] boot error: ' .. tostring(err))
            return
        end
    end
    if not self.scheduler:due(frame) then return end
    local ok, err = pcall(strategicTick, frame)
    if not ok then
        -- A crashing tick must not wedge the AI: log and try again next tick.
        self.reporter:event('error', { frame = frame, err = tostring(err) })
    end
end

-- Aspirational event callins (never dispatched by the runtime today — F4).
function onUnitCreated(unitID, unitDefID, teamID) end   -- luacheck: ignore
function onUnitDestroyed(unitID, attackerID) end        -- luacheck: ignore
function onRelease(reason) end                          -- luacheck: ignore

--- Test/eval hook: the instance table (read-only by convention).
function GARRISON_STATE() return self end
