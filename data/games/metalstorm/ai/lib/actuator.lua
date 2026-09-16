-- lib/actuator.lua — the ONLY writer an AI built on this library has.
--
-- Wraps the AI VM's write verbs (AI.createGroup / issueDirective / setPosture /
-- sendMessage / log) with the policy every AI player needs and none should
-- re-implement:
--   * rate limiting — mirrors the drain's §8 E6 clamp (≤ 1 directive per
--     group, or per 256-elmo area cell, per drain batch) LOCALLY, so a refused
--     push never happens; plus a caller-set per-tick ceiling
--   * charging — previews the authority cost (lib/authority.lua, the real
--     formula) against the budget the caller hands in each tick, and refuses
--     what it cannot pay; DEFEND-class directives may be forced (the
--     always-affordable floor)
--   * containment — every engine call is pcall'd; an engine error is counted,
--     logged once, and never wedges the tick
--   * observability — stats() says what went out, what was refused and why
--
-- STRUCTURAL FLOOR: there is no `command`, `unit`, `move`, `attack` method
-- here and the module never touches `AI.issueCommand`. An AI that wants to
-- micro has no verb to reach for — the same guarantee ai/strategos/
-- actuators.lua gives, now reusable.

local Engine     = require('lib.engine')
local Authority  = require('lib.authority')
local Directives = require('lib.directives')
local Wire       = require('lib.vendor.wire')

local Actuator = {}
Actuator.__index = Actuator

Actuator.DEFEND_TYPES = {
    [Directives.Type.Defend] = true, [Directives.Type.DefendArea] = true,
    [Directives.Type.DefendFront] = true,
}

--- cfg: { name = 'garrison', maxPerTick = 8, ttlFrames = 450, verbose = false }
function Actuator.new(cfg)
    cfg = cfg or {}
    local self = setmetatable({}, Actuator)
    self.name       = cfg.name or 'ai'
    self.maxPerTick = cfg.maxPerTick or 8
    self.ttlFrames  = cfg.ttlFrames or Directives.DEFAULT_TTL_FRAMES
    self.verbose    = cfg.verbose and true or false
    self.caps       = Engine.caps()
    self.errorsSeen = {}
    self.total      = { issued = 0, refused = 0, spent = 0, errors = 0,
                        postures = 0, groups = 0, messages = 0 }
    self:beginTick(0, {})
    return self
end

--- Start a tick. opts: { budget = authority available now (nil = unlimited),
-- ttlFrames = lifetime for this tick's directives, costScale = override }.
function Actuator:beginTick(frame, opts)
    opts = opts or {}
    self.frame     = frame or 0
    self.budget    = opts.budget            -- nil ⇒ no budget gate
    self.costScale = opts.costScale
    if opts.ttlFrames then self.ttlFrames = opts.ttlFrames end
    self.tick = { issued = 0, refused = {}, spent = 0, keys = {}, log = {} }
    self.caps = Engine.caps()
end

local function refuse(self, why, spec)
    self.tick.refused[why] = (self.tick.refused[why] or 0) + 1
    self.total.refused = self.total.refused + 1
    if self.verbose then
        Engine.log(string.format('[%s] refused %s: %s', self.name,
            spec and Directives.name(spec.type) or '?', why))
    end
    return false, why
end

local function contained(self, verb, ...)
    local AI = Engine.raw()
    if not AI or type(AI[verb]) ~= 'function' then return nil, 'verb absent' end
    local ok, a = pcall(AI[verb], ...)
    if not ok then
        self.total.errors = self.total.errors + 1
        if not self.errorsSeen[verb] then
            self.errorsSeen[verb] = true
            Engine.log(string.format('[%s] engine error in %s: %s', self.name, verb, tostring(a)))
        end
        return nil, 'engine error'
    end
    return a
end

--- Issue an area/group directive. `spec` from lib/directives; `meta` is an
-- optional table kept on the tick log (goal id, region, reason) for reports.
-- opts: { handle = group handle (default 0 = area), force = bypass budget
-- (DEFEND floor only), baseSum = Σ base for group-scoped pricing }.
-- Returns true, cost | false, reason.
function Actuator:directive(spec, meta, opts)
    opts = opts or {}
    if type(spec) ~= 'table' or type(spec.type) ~= 'number' then
        return refuse(self, 'malformed spec', spec)
    end
    if not self.caps.issueDirective then return refuse(self, 'verb absent', spec) end
    if self.tick.issued >= self.maxPerTick then return refuse(self, 'tick ceiling', spec) end

    -- E6 mirror: one directive per group / area cell per batch.
    local handle = opts.handle or 0
    local key = (handle ~= 0) and ('g' .. tostring(handle)) or Directives.clampKey(spec)
    if self.tick.keys[key] then return refuse(self, 'rate clamp', spec) end

    -- Charge preview against the tick budget.
    local cost = Authority.directiveCost({
        scope = (handle ~= 0) and 'group' or 'area',
        baseSum = opts.baseSum, costScale = self.costScale,
    })
    local isFloor = Actuator.DEFEND_TYPES[spec.type] and opts.force
    if self.budget ~= nil and not isFloor and (self.tick.spent + cost) > self.budget then
        return refuse(self, 'over budget', spec)
    end

    -- Every directive is mortal.
    if not spec.expiresInFrames or spec.expiresInFrames <= 0 then
        spec.expiresInFrames = self.ttlFrames
    end

    local ok = contained(self, 'issueDirective', handle, spec)
    if not ok then return refuse(self, 'engine error', spec) end

    self.tick.keys[key] = true
    self.tick.issued = self.tick.issued + 1
    self.tick.spent  = self.tick.spent + cost
    self.total.issued = self.total.issued + 1
    self.total.spent  = self.total.spent + cost
    self.tick.log[#self.tick.log + 1] = { frame = self.frame, spec = spec,
                                          meta = meta, cost = cost, handle = handle }
    return true, cost
end

--- Create an org-group from unit ids. Returns the (negative, same-batch)
-- handle or nil. Free today (no charge callin on the AI drain).
function Actuator:group(unitIds, echelon)
    if not self.caps.createGroup then return nil end
    if type(unitIds) ~= 'table' or #unitIds == 0 then return nil end
    local h = contained(self, 'createGroup', unitIds, echelon or Directives.Echelon.Platoon)
    if type(h) == 'number' then
        self.total.groups = self.total.groups + 1
        return h
    end
    return nil
end

--- Set a posture bundle on a REAL group (handle ≠ 0; the drain drops area
-- postures). `posture` is a table (encoded here) or a ready JSON string.
function Actuator:posture(handle, posture)
    if not self.caps.setPosture then return false, 'verb absent' end
    if not handle or handle == 0 then return false, 'posture needs a group' end
    local json = type(posture) == 'table' and Directives.postureJson(posture) or tostring(posture)
    local ok = contained(self, 'setPosture', handle, json)
    if ok then self.total.postures = self.total.postures + 1 end
    return ok and true or false
end

--- Send a command into synced game Lua through the RecvLuaMsg codec (the
-- same one game_ai_guidance.lua / game_parley.lua decode). ≤ 2 KB, ≤ 16 per
-- batch in the engine; over-size returns false there and here.
function Actuator:message(cmd, fields)
    if not self.caps.sendMessage then return false, 'verb absent' end
    local msg = Wire.encode(cmd, fields)
    if #msg > 2048 then return false, 'message too large' end
    local ok = contained(self, 'sendMessage', msg)
    if ok then self.total.messages = self.total.messages + 1 end
    return ok and true or false
end

--- Narrate (server log / chat when a chat verb exists). Never raises.
function Actuator:say(msg)
    return Engine.log(string.format('[%s] %s', self.name, tostring(msg)))
end

--- Per-tick and lifetime counters, for reporters/tests.
function Actuator:stats()
    return {
        tick  = { issued = self.tick.issued, spent = self.tick.spent,
                  refused = self.tick.refused, log = self.tick.log },
        total = self.total,
    }
end

return Actuator
