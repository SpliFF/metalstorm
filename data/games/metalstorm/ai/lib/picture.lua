-- lib/picture.lua — the Picture builder: everything an AI knows, refreshed
-- each strategic tick from PLAYER-VISIBLE data only.
--
-- The Picture is one plain table so a decision core can take it as a single
-- input and be tested with hand-built fixtures (no engine). Its shape is
-- deliberately compatible with ai/strategos/picture.lua's (regions, board,
-- economy, ledger, intel, power, script) so strategos' pure planner could run
-- on it — with two additions any AI wants: per-region idle counts in the
-- ledger, and a per-region threat summary in `threat`.
--
-- Reads are Metalstorm's published rulesParams (game_regions / game_objectives
-- / game_authority / game_teams / game_scenario / game_transports). Each
-- reader feature-detects and degrades to "unknown" — a blind AI stays calm.
--
-- ⚠ `unit.health` from the runtime is a 0-1 RATIO (AIStateSnapshot.cpp:45).
-- ledger.strength is therefore an effective HEAD COUNT; ledger.health is
-- Σ ratio × def hp (absolute hitpoints — the engine's `requestedStrength`
-- scale). Only `health` may cross into a directive's demand cap (D68).

local Engine  = require('lib.engine')
local Regions = require('lib.regions')

local Picture = {}
Picture.__index = Picture

Picture.DEFAULTS = {
    INTEL_DECAY_FRAMES = 5400,   -- ~3 min @ 30 Hz: confidence 1 → 0
    INTEL_FORGET_BELOW = 0.05,
    BLIP_CONFIDENCE    = 0.35,
    BLIP_STRENGTH      = 0.5,
    NOMINAL_UNIT_HP    = 1000,   -- when power.json cannot price a def
}

-- Mirrors game_objectives.lua's PUBLISHED_FIELDS (same list ui/lib/objectives.js polls).
Picture.BOARD_FIELDS = {
    'type', 'scope', 'state', 'reward', 'team', 'team2', 'progress',
    'phase', 'stage', 'expire', 'region', 'x', 'z', 'r', 'suggested', 'source',
    'victory',
}

--- cfg: { config = overrides of DEFAULTS, name = 'ai' }
function Picture.new(cfg)
    cfg = cfg or {}
    local self = setmetatable({}, Picture)
    self.config = {}
    for k, v in pairs(Picture.DEFAULTS) do self.config[k] = v end
    for k, v in pairs(cfg.config or {}) do self.config[k] = v end
    self.regions = nil      -- static geometry, loaded once
    self.power   = nil      -- def → { name, dps, hp, class, scale }, loaded once
    self.memory  = { intel = {} }
    self.warnedHp = false
    return self
end

--- Static loads (once). Both re-try on later ticks if the first read came
-- back empty (a sandbox root configured late, or a test installing data).
function Picture:loadStatic()
    if not self.regions or next(self.regions) == nil then
        self.regions = Regions.load(Engine.mapData('regions.json'))
    end
    if not self.power or next(self.power) == nil then
        self.power = {}
        local data = Engine.defExport('power.json')
        if type(data) == 'table' and type(data.defs) == 'table' then
            for sid, entry in pairs(data.defs) do
                self.power[tonumber(sid) or sid] = entry
            end
        end
    end
end

local function readBoard()
    local board = {}
    local count = Engine.rulesNumber('game', 'objective_count') or 0
    for id = 1, count do
        local p = 'objective_' .. id .. '_'
        local o = {}
        for _, field in ipairs(Picture.BOARD_FIELDS) do
            o[field] = Engine.rulesParam('game', p .. field)
        end
        if o.type ~= nil then
            o.id = id
            o.reward = tonumber(o.reward) or 0
            o.progress = tonumber(o.progress) or 0
            if o.x ~= nil then o.pos = { x = o.x, z = o.z, r = o.r } end
            board[id] = o
        end
    end
    return board
end

local function readEconomy(playerId)
    local econ = {
        teamPool  = Engine.rulesNumber('team', 'authority_pool') or 0,
        ownPool   = 0,
        costScale = Engine.rulesNumber('game', 'authority_cost_scale') or 1.0,
        humans    = Engine.rulesNumber('team', 'team_active_humans'),   -- nil = unknown
    }
    if playerId and playerId >= 0 then
        econ.ownPool = Engine.rulesNumber('team', 'authority_player_' .. math.floor(playerId)) or 0
    end
    return econ
end

--- Scenario-authored slot parameters (game_scenario.lua stageAI) + the
-- profile hint (per-player key first, then team-wide).
local function splitList(v)
    local out = {}
    if not v or v == '' then return out end
    for item in tostring(v):gmatch('[^,]+') do out[#out + 1] = item end
    return out
end

function Picture.profileHint(playerId)
    if playerId and playerId >= 0 then
        local v = Engine.rulesParam('team', 'ai_profile_' .. math.floor(playerId))
        if type(v) == 'string' and v ~= '' then return v end
    end
    local v = Engine.rulesParam('team', 'ai_profile')
    if type(v) == 'string' and v ~= '' then return v end
    return nil
end

local function readScript()
    local kinds = Engine.rulesParam('team', 'ai_slate_kinds')
    if type(kinds) ~= 'string' or kinds == '' then return nil end
    return {
        kinds   = splitList(kinds),
        home    = Engine.rulesParam('team', 'ai_slate_home'),
        targets = splitList(Engine.rulesParam('team', 'ai_slate_targets')),
        route   = splitList(Engine.rulesParam('team', 'ai_slate_route')),
        reach   = Engine.rulesNumber('team', 'ai_slate_reach'),
    }
end

--- Departure zone for our team, if the transports gadget publishes one
-- (it does NOT today — gap G6; the key names below are the proposal), else
-- nil. The AI falls back to Regions.nearestEdgePoint from its home ground.
local function readDeparture(teamId)
    if teamId == nil or teamId < 0 then return nil end
    local x = Engine.rulesNumber('team', 'ms_departure_' .. teamId .. '_x')
    local z = Engine.rulesNumber('team', 'ms_departure_' .. teamId .. '_z')
    if x == nil or z == nil then return nil end
    return { x = x, z = z,
             radius = Engine.rulesNumber('team', 'ms_departure_' .. teamId .. '_r') or 700 }
end

function Picture:hpOf(defId)
    local entry = self.power and self.power[defId]
    local hp = entry and tonumber(entry.hp)
    if hp and hp > 0 then return hp end
    if not self.warnedHp then
        self.warnedHp = true
        Engine.log(string.format('[picture] AI-STANDIN: no power.json hp for def %s; '
            .. 'pricing force at a nominal %d hp', tostring(defId), self.config.NOMINAL_UNIT_HP))
    end
    return self.config.NOMINAL_UNIT_HP
end

function Picture:classOf(defId)
    local entry = self.power and self.power[defId]
    return (entry and entry.class) or '_unclassed'
end

function Picture:buildLedger(units)
    local ledger = {}
    for _, u in ipairs(units) do
        local key = Regions.regionOf(u.x, u.z, self.regions) or '_all'
        local b = ledger[key]
        if not b then
            b = { strength = 0, health = 0, count = 0, idle = 0, byClass = {}, units = {} }
            ledger[key] = b
        end
        local ratio = tonumber(u.health) or 0
        b.strength = b.strength + ratio
        b.health   = b.health + ratio * self:hpOf(u.defId)
        b.count    = b.count + 1
        if not u.hasCommands then b.idle = b.idle + 1 end
        local class = self:classOf(u.defId)
        b.byClass[class] = (b.byClass[class] or 0) + ratio
        b.units[#b.units + 1] = u.id
    end
    return ledger
end

function Picture:updateIntel(frame, enemies, blips)
    local cfg, intel = self.config, self.memory.intel
    -- 1. decay
    for key, mem in pairs(intel) do
        local age = frame - (mem.lastSeenFrame or frame)
        local conf = 1 - (age / cfg.INTEL_DECAY_FRAMES)
        if conf <= cfg.INTEL_FORGET_BELOW then intel[key] = nil else mem.confidence = conf end
    end
    -- 2. retract last tick's blip contribution (blips are observations, not memory)
    for _, mem in pairs(intel) do
        if mem.blipStrength then
            mem.strength = math.max(0, (mem.strength or 0) - mem.blipStrength)
            if mem.byClass then mem.byClass._blip = nil end
            mem.blipStrength = nil
        end
    end
    -- 3. fresh sightings REPLACE a region's remembered strength
    local resighted = {}
    for _, e in ipairs(enemies) do
        local key = Regions.regionOf(e.x, e.z, self.regions) or '_all'
        local mem = intel[key] or { strength = 0, byClass = {} }
        if not resighted[key] then
            mem.strength, mem.byClass, mem.count = 0, {}, 0
            resighted[key] = true
        end
        local ratio = tonumber(e.health) or 0
        mem.strength = (mem.strength or 0) + ratio
        mem.count = (mem.count or 0) + 1
        local class = self:classOf(e.defId)
        mem.byClass[class] = (mem.byClass[class] or 0) + ratio
        mem.lastSeenFrame, mem.confidence = frame, 1.0
        intel[key] = mem
    end
    -- 4. radar blips: low-confidence, unknown-type presence
    for _, b in ipairs(blips) do
        local key = Regions.regionOf(b.x, b.z, self.regions) or '_all'
        local mem = intel[key] or { strength = 0, byClass = {} }
        mem.byClass = mem.byClass or {}
        mem.strength     = (mem.strength or 0) + cfg.BLIP_STRENGTH
        mem.blipStrength = (mem.blipStrength or 0) + cfg.BLIP_STRENGTH
        mem.byClass._blip = (mem.byClass._blip or 0) + cfg.BLIP_STRENGTH
        if mem.lastSeenFrame ~= frame then
            local conf = math.max(mem.confidence or 0, cfg.BLIP_CONFIDENCE)
            mem.confidence = conf
            mem.lastSeenFrame = frame - math.floor((1 - conf) * cfg.INTEL_DECAY_FRAMES)
        end
        intel[key] = mem
    end
    return intel
end

--- Per-region threat summary: for every region we hold or occupy, the
-- strongest (confidence-weighted) enemy presence in it or next door, and
-- the hop distance to the nearest known enemy.
function Picture:buildThreat(picture, teamId)
    local threat = {}
    local regions, intel, ledger = picture.regions, picture.intel, picture.ledger
    local ours = {}
    for key in pairs(ledger) do if regions[key] then ours[key] = true end end
    for key in pairs(Regions.ownedBy(regions, teamId)) do ours[key] = true end
    local enemyKeys = {}
    for key, mem in pairs(intel) do
        if (mem.strength or 0) > 0 and regions[key] then enemyKeys[key] = true end
    end
    local dist = Regions.hops(regions, enemyKeys)
    for key in pairs(ours) do
        local here = intel[key]
        local inside = here and (here.strength or 0) * (here.confidence or 1) or 0
        local adjacent = 0
        for _, nkey in ipairs(Regions.neighbors(regions, key)) do
            local m = intel[nkey]
            if m then adjacent = math.max(adjacent, (m.strength or 0) * (m.confidence or 1)) end
        end
        threat[key] = { inside = inside, adjacent = adjacent, hops = dist[key],
                        contested = regions[key] and regions[key].contested or false }
    end
    picture.contactHops = Regions.minHops(regions, ours, enemyKeys)
    return threat
end

--- Build this tick's Picture.
function Picture:refresh(frame)
    self:loadStatic()
    local teamId, playerId = Engine.teamId(), Engine.playerId()
    local w, h = Engine.mapSize()
    Regions.overlay(self.regions, function(key) return Engine.rulesParam('game', key) end)

    local picture = {
        frame     = frame or Engine.frame(),
        caps      = Engine.caps(),
        config    = self.config,
        teamId    = teamId,
        playerId  = playerId,
        mapWidth  = w,
        mapHeight = h,
        regions   = self.regions,
        power     = self.power,
        board     = readBoard(),
        economy   = readEconomy(playerId),
        script    = readScript(),
        profile   = Picture.profileHint(playerId),
        departure = readDeparture(teamId),
        ledger    = self:buildLedger(Engine.ownUnits()),
        intel     = self:updateIntel(frame or Engine.frame(), Engine.visibleEnemies(),
                                     Engine.radarBlips()),
    }
    picture.threat = self:buildThreat(picture, teamId)
    return picture
end

--- Total own strength / idle across the ledger (convenience).
function Picture.totals(picture)
    local strength, health, count, idle = 0, 0, 0, 0
    for _, b in pairs(picture.ledger or {}) do
        strength, health = strength + (b.strength or 0), health + (b.health or 0)
        count, idle = count + (b.count or 0), idle + (b.idle or 0)
    end
    return { strength = strength, health = health, count = count, idle = idle }
end

return Picture
