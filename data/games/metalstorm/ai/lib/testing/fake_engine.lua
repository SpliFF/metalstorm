-- lib/testing/fake_engine.lua — a test double for the AI VM.
--
-- Reproduces the EXACT surface rts/Server/AI/AIScriptContext.cpp registers
-- (names, argument shapes, return shapes) plus the sim-thread drain's
-- validation (StateStreamer::ApplyAICommands): same-batch group-token
-- resolution, group ownership, the §8 E6 rate clamp, the AllowDirectiveCreate
-- charge (via lib/authority — the real formula against a real pool), and the
-- 16-per-batch LuaMsg budget. So any AI can be spec'd and evaluated headless
-- against what the engine would actually have done with its commands, not
-- against a sink that records everything.
--
-- Usage:
--   local FE = require('lib.testing.fake_engine')
--   local fe = FE.new{ teamId = 0, playerId = 7, regions = <decoded regions.json>,
--                      power = { defs = {...} }, pool = 2000 }
--   fe:install()                       -- _G.AI = fe.AI
--   fe:setOwnUnits{ {id=1, defId=101, x=.., z=.., health=1.0, hasCommands=false} }
--   fe:setEnemies{ ... }; fe:setBlips{ ... }
--   fe:setRulesParam('game', 'region_home_team', 0)
--   fe:step(300, onUpdate)             -- advance 300 frames, calling onUpdate every 10
--   fe.applied / fe.refused / fe.violations / fe.log / fe.spent
--
-- `AI.issueCommand` is registered here and ONLY here: since 2026-09-16 the
-- production VM does not register it at all (AIScriptContext.cpp
-- `exposeIssueCommandForTests`), so directives are the only actuation path.
-- The double keeps the verb for exactly the reason the C++ harness does — to
-- catch an AI reaching for it: any call lands in `fe.violations`. Pass
-- `exposeIssueCommand = false` to model the production VM, in which the verb
-- is simply absent (`Engine.caps().unitCommand == false`).

local Authority = require('lib.authority')

local FE = {}
FE.__index = FE

FE.TICK_INTERVAL     = 10     -- AIRuntimePool::tickInterval
FE.LUAMSG_MAX_BYTES  = 2048   -- kAILuaMsgMaxBytes
FE.LUAMSG_PER_DRAIN  = 16     -- kAILuaMsgPerDrain

function FE.new(cfg)
    cfg = cfg or {}
    local self = setmetatable({}, FE)
    self.teamId   = cfg.teamId or 0
    self.playerId = cfg.playerId == nil and 7 or cfg.playerId
    self.mapW, self.mapH = cfg.mapWidth or 2048, cfg.mapHeight or 2048
    self.frame    = cfg.frame or 0
    self.params   = { game = {}, team = {} }
    -- Game params are LOS-masked on the way into the snapshot (2026-09-16,
    -- AIStateSnapshot.cpp F11): only RULESPARAMLOS_PUBLIC entries cross the
    -- side boundary. Non-public game params are held here, unreadable through
    -- the surface, so a spec can prove an AI never sees them.
    self.maskedParams = {}
    self.exposeIssueCommand = cfg.exposeIssueCommand ~= false
    self.mapData  = { ['regions.json'] = cfg.regions }
    self.defExport = { ['power.json'] = cfg.power }
    self.ownUnits, self.enemies, self.blips = {}, {}, {}
    self.queue    = {}          -- pushed AICommands, drain order
    self.journal  = {}          -- every push, with frame (never cleared)
    self.applied  = {}          -- commands the drain accepted
    self.refused  = {}          -- { cmd, reason }
    self.violations = {}        -- issueCommand calls
    self.log      = {}          -- AI.log lines
    self.messages = {}          -- delivered LuaMsg payloads
    self.groups   = {}          -- id → { team, members, echelon, posture }
    self.nextGroupId = 1
    self.nextToken   = 1
    self.spent    = 0
    self.pool     = cfg.pool or 0
    self.costScale = cfg.costScale == nil and 1.0 or cfg.costScale
    self.ms       = 0
    self:setRulesParam('game', 'authority_cost_scale', self.costScale)
    self:syncPool()
    self.AI = self:buildSurface()
    return self
end

function FE:syncPool()
    self.params.team['authority_player_' .. math.floor(self.playerId)] = self.pool
    self.params.team['authority_pool'] = self.params.team['authority_pool'] or 0
end

-- ── state setters ────────────────────────────────────────────────────────
function FE:setFrame(f) self.frame = f end
function FE:setOwnUnits(list) self.ownUnits = list or {} end
function FE:setEnemies(list)  self.enemies = list or {} end
function FE:setBlips(list)    self.blips = list or {} end
--- Publish a rulesParam. `los` (game scope only) mirrors the snapshot's mask:
-- nil / 'public' travels; anything else ('private', 'allied', 'team') is
-- withheld exactly as the engine withholds it. Team scope is the AI's OWN
-- team, which is private-readable by its owner — never masked.
function FE:setRulesParam(scope, key, value, los)
    if scope == 'game' and los ~= nil and los ~= 'public' then
        self.params.game[key] = nil
        self.maskedParams[key] = value
        return
    end
    if scope == 'game' then self.maskedParams[key] = nil end
    self.params[scope][key] = value
end

--- The value the sim holds for a masked game param (never visible to the AI).
function FE:maskedValue(key) return self.maskedParams[key] end
function FE:setMapData(name, tbl)   self.mapData[name] = tbl end
function FE:setDefExport(name, tbl) self.defExport[name] = tbl end
function FE:setPool(v) self.pool = v; self:syncPool() end
function FE:install() _G.AI = self.AI; return self end
function FE.uninstall() _G.AI = nil end

-- ── the surface ──────────────────────────────────────────────────────────
function FE:buildSurface()
    local fe = self
    local AI = {}
    function AI.getFrame()    return fe.frame end
    function AI.getMapSize()  return fe.mapW, fe.mapH end
    function AI.getTeamId()   return fe.teamId end
    function AI.getPlayerId() return fe.playerId end
    function AI.nowMs() fe.ms = fe.ms + 0.01; return fe.ms end
    function AI.log(msg) fe.log[#fe.log + 1] = tostring(msg) end
    function AI.getRulesParam(scope, key)
        local store = (scope == 'team') and fe.params.team or fe.params.game
        return store[key]
    end
    local function sandboxed(root, api)
        return function(name)
            if type(name) ~= 'string' or name == '' or name:find('..', 1, true)
                    or name:find('[/\\]') then
                error(api .. ': illegal file name ' .. tostring(name))
            end
            return root[name]
        end
    end
    AI.getMapData   = sandboxed(fe.mapData, 'AI.getMapData')
    AI.getDefExport = sandboxed(fe.defExport, 'AI.getDefExport')
    local function copyUnits(list, full)
        local out = {}
        for i, u in ipairs(list) do
            out[i] = full
                and { id = u.id, defId = u.defId, x = u.x, y = u.y or 0, z = u.z,
                      health = u.health, hasCommands = u.hasCommands and true or false }
                or  { id = u.id, defId = u.defId, x = u.x, z = u.z, health = u.health }
        end
        return out
    end
    function AI.getOwnUnits()       return copyUnits(fe.ownUnits, true) end
    function AI.getVisibleEnemies() return copyUnits(fe.enemies, false) end
    function AI.getRadarBlips()
        local out = {}
        for i, b in ipairs(fe.blips) do out[i] = { id = b.id, x = b.x, z = b.z } end
        return out
    end

    local function push(cmd)
        cmd.frame = fe.frame
        cmd.teamId, cmd.playerId = fe.teamId, fe.playerId
        fe.queue[#fe.queue + 1] = cmd
        fe.journal[#fe.journal + 1] = cmd
    end
    function AI.createGroup(squadIds, echelon)
        assert(type(squadIds) == 'table', 'createGroup: table expected')
        local tok = fe.nextToken
        fe.nextToken = tok + 1
        local ids = {}
        for i, v in ipairs(squadIds) do ids[i] = math.floor(tonumber(v) or 0) end
        push({ kind = 'createGroup', token = tok, squadIds = ids,
               echelon = math.floor(echelon or 1) })
        return -tok
    end
    function AI.issueDirective(handle, spec)
        assert(type(spec) == 'table', 'issueDirective: spec table expected')
        local cmd = { kind = 'issueDirective',
                      type = math.floor(tonumber(spec.type) or 0),
                      priority = math.floor(tonumber(spec.priority) or 0),
                      shape = math.floor(tonumber(spec.shape) or 0),
                      requestedStrength = math.floor(tonumber(spec.requestedStrength) or 0),
                      expiresInFrames = math.floor(tonumber(spec.expiresInFrames) or 0),
                      -- lua_toboolean: absent/false/nil ⇒ false, everything
                      -- else (including 0) ⇒ true.
                      idleOnly = (spec.idleOnly ~= nil and spec.idleOnly ~= false),
                      params = {} }
        for i, v in ipairs(spec.params or {}) do cmd.params[i] = tonumber(v) or 0 end
        if type(spec.within) == 'table' then
            cmd.within = { x = spec.within.x or 0, z = spec.within.z or 0,
                           radius = spec.within.radius or 0 }
        end
        local h = math.floor(tonumber(handle) or 0)
        if h < 0 then cmd.refToken = -h elseif h > 0 then cmd.groupId = h end
        push(cmd)
        return true
    end
    function AI.setPosture(handle, json)
        local h = math.floor(tonumber(handle) or 0)
        local cmd = { kind = 'setPosture', text = tostring(json) }
        if h < 0 then cmd.refToken = -h elseif h > 0 then cmd.groupId = h end
        push(cmd)
        return true
    end
    function AI.sendMessage(msg)
        msg = tostring(msg)
        if #msg > FE.LUAMSG_MAX_BYTES then return false end
        push({ kind = 'luaMsg', text = msg })
        return true
    end
    -- The generic per-unit verb. The production VM does NOT register it
    -- (2026-09-16); this double keeps it, like the C++ test harness, purely
    -- so that an AI reaching for it is RECORDED rather than merely erroring.
    if fe.exposeIssueCommand then
        function AI.issueCommand(unitId, cmdId, ...)
            fe.violations[#fe.violations + 1] = { frame = fe.frame, unitId = unitId,
                                                  cmdId = cmdId, params = { ... } }
        end
    end
    return AI
end

-- ── the drain (StateStreamer::ApplyAICommands) ───────────────────────────
local function clampKey(cmd, groupId)
    if groupId and groupId ~= 0 then return 'g' .. groupId end
    if #cmd.params >= 3 then
        return math.floor(cmd.params[1] / 256 + 0.5) .. ':' .. math.floor(cmd.params[3] / 256 + 0.5)
    end
    return 'area'
end

function FE:charge(cmd, groupId)
    local base, scope = 0, 'area'
    if groupId and groupId ~= 0 then
        scope = 'group'
        local g = self.groups[groupId]
        local power = self.defExport['power.json'] and self.defExport['power.json'].defs or {}
        local byId = {}
        for _, u in ipairs(self.ownUnits) do byId[u.id] = u end
        for _, uid in ipairs(g and g.members or {}) do
            local u = byId[uid]
            base = base + Authority.unitBase(u and power[tostring(u.defId)])
        end
    end
    return Authority.directiveCost({ scope = scope, baseSum = base, costScale = self.costScale })
end

function FE:drain()
    local batch = self.queue
    self.queue = {}
    local tokenToGroup, keys, luaMsgs = {}, {}, 0
    local out = {}
    for _, cmd in ipairs(batch) do
        local reason = nil
        if cmd.kind == 'createGroup' then
            local gid = self.nextGroupId
            self.nextGroupId = gid + 1
            self.groups[gid] = { id = gid, team = cmd.teamId, members = cmd.squadIds,
                                 echelon = cmd.echelon, posture = nil, createdFrame = self.frame }
            tokenToGroup[cmd.token] = gid
            cmd.groupId = gid
        elseif cmd.kind == 'issueDirective' or cmd.kind == 'setPosture' then
            local gid = cmd.groupId or 0
            if cmd.refToken then
                gid = tokenToGroup[cmd.refToken] or 0
                if gid == 0 then reason = 'group create failed' end
            end
            if not reason and gid ~= 0 then
                local g = self.groups[gid]
                if not g or g.team ~= cmd.teamId then reason = 'foreign or unknown group' end
            end
            if not reason and cmd.kind == 'setPosture' then
                if gid == 0 then reason = 'posture needs a real group'
                else self.groups[gid].posture = cmd.text end
            elseif not reason then
                local key = clampKey(cmd, gid)
                if keys[key] then reason = 'E6 rate clamp'
                else
                    keys[key] = true
                    local cost = self:charge(cmd, gid)
                    if cost > self.pool then reason = 'authority veto'
                    else
                        self.pool = self.pool - cost
                        self.spent = self.spent + cost
                        cmd.cost = cost
                        self:syncPool()
                    end
                end
            end
            cmd.resolvedGroup = gid
        elseif cmd.kind == 'luaMsg' then
            if luaMsgs >= FE.LUAMSG_PER_DRAIN then reason = 'LuaMsg budget'
            else
                luaMsgs = luaMsgs + 1
                self.messages[#self.messages + 1] = { frame = self.frame, text = cmd.text }
            end
        end
        if reason then
            self.refused[#self.refused + 1] = { cmd = cmd, reason = reason }
        else
            self.applied[#self.applied + 1] = cmd
            out[#out + 1] = cmd
        end
    end
    return out
end

--- Advance `frames`, calling `onUpdate(frame)` every TICK_INTERVAL (like
-- AIRuntimePool::Tick) and draining after each call (like TickAI). Errors
-- raised by onUpdate are collected in fe.errors, not propagated, mirroring
-- the runtime's pcall around onUpdate.
function FE:step(frames, onUpdate)
    self.errors = self.errors or {}
    local target = self.frame + frames
    while self.frame < target do
        self.frame = self.frame + 1
        if self.frame % FE.TICK_INTERVAL == 0 then
            local ok, err = pcall(onUpdate, self.frame)
            if not ok then self.errors[#self.errors + 1] = { frame = self.frame, err = err } end
            self:drain()
        end
    end
end

--- Applied directives only (the usual assertion target).
function FE:directives()
    local out = {}
    for _, c in ipairs(self.applied) do
        if c.kind == 'issueDirective' then out[#out + 1] = c end
    end
    return out
end

return FE
