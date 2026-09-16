-- lib/reporter.lua — health / status reporting for a headless AI.
--
-- An AI has no HUD and no chat wire. Its observability channels are:
--   1. AI.log(line) → the server log under the AI's section (NOTICE level);
--   2. AI.sendMessage(wire) → gadget:RecvLuaMsg with the AI's playerID, which
--      a synced gadget may republish as team rulesParams the panel reads.
-- The AI CANNOT write a rulesParam itself (no such verb — deliberate: the
-- synced side owns published state). This module emits a compact, greppable
-- health line on channel 1 every N strategic ticks and, when the message verb
-- exists, the same fields as an `ai.health` command on channel 2. No gadget
-- consumes `ai.health` today — that is proposal P4 in docs/ai-players.md
-- (game_ai_guidance.lua would republish it as `ai_health_<player>_*`).
--
-- Fields are whatever the AI passes; a few are standardised so tooling can
-- rely on them: tick, frame, tier, issued, refused, spent, pool, errors.

local Engine = require('lib.engine')
local Wire   = require('lib.vendor.wire')

local Reporter = {}
Reporter.__index = Reporter

--- cfg: { name = 'garrison', every = 6 (ticks), actuator = Actuator | nil }
function Reporter.new(cfg)
    cfg = cfg or {}
    local self = setmetatable({}, Reporter)
    self.name     = cfg.name or 'ai'
    self.every    = math.max(1, cfg.every or 6)
    self.actuator = cfg.actuator
    self.ticks    = 0
    self.last     = nil
    return self
end

local function fmt(fields)
    local keys = {}
    for k in pairs(fields) do keys[#keys + 1] = k end
    table.sort(keys)
    local parts = {}
    for _, k in ipairs(keys) do
        local v = fields[k]
        if type(v) == 'number' then
            v = (v == math.floor(v)) and string.format('%d', v) or string.format('%.3f', v)
        end
        parts[#parts + 1] = k .. '=' .. tostring(v)
    end
    return table.concat(parts, ' ')
end

--- Call once per strategic tick with the fields worth publishing. Emits on
-- every `every`-th tick (and always on the first). Returns true when it did.
function Reporter:tick(frame, fields)
    self.ticks = self.ticks + 1
    local due = (self.ticks == 1) or (self.ticks % self.every == 0)
    local f = {}
    for k, v in pairs(fields or {}) do f[k] = v end
    f.tick, f.frame = self.ticks, frame
    self.last = f
    if not due then return false end
    Engine.log(string.format('[%s] health %s', self.name, fmt(f)))
    if self.actuator then
        self.actuator:message('ai.health', f)
    end
    return true
end

--- Immediate, always-emitted line for a notable event (boot, role flip,
-- withdraw, error). Returns the line.
function Reporter:event(kind, fields)
    local line = string.format('[%s] %s %s', self.name, tostring(kind), fmt(fields or {}))
    Engine.log(line)
    return line
end

--- The last fields reported (tests / eval).
function Reporter:lastFields() return self.last end

--- Encode fields the way a gadget would receive them (for tests).
function Reporter.encode(cmd, fields) return Wire.encode(cmd, fields) end

return Reporter
