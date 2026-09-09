-- lib/engine.lua — the ONE place an AI player touches the AI VM surface.
--
-- Every read the engine exposes (rts/Server/AI/AIScriptContext.cpp
-- RegisterAPI) is wrapped here behind a feature-detect + pcall, so an AI
-- built on this library keeps running on an older/newer runtime, in a busted
-- process with no `AI` global at all, or against the test double
-- (lib/testing/fake_engine.lua). Absent surface degrades to "unknown" (nil /
-- empty table), never to an error — a blind AI does nothing rash.
--
-- WRITES are deliberately NOT here. They live in lib/actuator.lua so the
-- rate-limit / charge / containment policy is unavoidable, and so that the
-- generic per-unit `AI.issueCommand` the runtime still registers is reachable
-- from NO module of this library (the strategic floor, structurally).
--
-- Engine-agnostic: nothing below assumes Metalstorm. The rulesParam names
-- Metalstorm publishes are the business of lib/picture.lua.

local Engine = {}

local function api()
    local AI = rawget(_G, 'AI')
    if type(AI) == 'table' then return AI end
    return nil
end

local function has(name)
    local AI = api()
    return AI ~= nil and type(AI[name]) == 'function'
end

--- Capability table: which reads/writes does THIS runtime expose? Cheap;
-- recompute freely (a test may install a different double mid-run).
function Engine.caps()
    return {
        present        = api() ~= nil,
        -- reads
        ownUnits       = has('getOwnUnits'),
        visibleEnemies = has('getVisibleEnemies'),
        radarBlips     = has('getRadarBlips'),
        alliedUnits    = has('getAlliedUnits'),      -- NOT on the surface today (gap G1)
        frame          = has('getFrame'),
        mapSize        = has('getMapSize'),
        teamId         = has('getTeamId'),
        playerId       = has('getPlayerId'),
        rulesParam     = has('getRulesParam'),
        mapData        = has('getMapData'),
        defExport      = has('getDefExport'),
        lod            = has('getLODLevel'),         -- NOT on the surface today (gap G3)
        nowMs          = has('nowMs'),
        log            = has('log'),
        -- writes (reported only; lib/actuator.lua is the caller)
        createGroup    = has('createGroup'),
        issueDirective = has('issueDirective'),
        setPosture     = has('setPosture'),
        sendMessage    = has('sendMessage'),
        chat           = has('chat') or has('sendChat'),
        -- the per-unit verb this library refuses to call (documented so a
        -- health report can say whether the floor is engine-enforced or not)
        unitCommand    = has('issueCommand'),
    }
end

--- Guarded call: returns the call's results, or `fallback` when the verb is
-- absent or raised. Never propagates an engine error into the AI's tick.
local function guarded(name, fallback, ...)
    local AI = api()
    if not AI or type(AI[name]) ~= 'function' then return fallback end
    local ok, a, b = pcall(AI[name], ...)
    if not ok then return fallback end
    if a == nil then return fallback, b end
    return a, b
end

function Engine.frame()        return guarded('getFrame', 0) end
function Engine.teamId()       return guarded('getTeamId', -1) end
function Engine.playerId()     return guarded('getPlayerId', -1) end
function Engine.nowMs()        return guarded('nowMs', nil) end

--- Map size in elmos: width, height (0, 0 when unknown).
function Engine.mapSize()
    local w, h = guarded('getMapSize', 0)
    return tonumber(w) or 0, tonumber(h) or 0
end

--- getRulesParam(scope, key) → number | string | nil. `scope` is 'game'
-- (public mirror) or 'team' (own team only — the snapshot never carries
-- another team's params; fog-honest by construction).
function Engine.rulesParam(scope, key)
    return guarded('getRulesParam', nil, scope, key)
end

function Engine.rulesNumber(scope, key)
    return tonumber(Engine.rulesParam(scope, key))
end

--- Sandboxed JSON file reads (AI4). Both roots are FLAT; a name with any path
-- separator raises in the engine, which `guarded` turns into nil here.
function Engine.mapData(name)   return guarded('getMapData', nil, name) end
function Engine.defExport(name) return guarded('getDefExport', nil, name) end

--- Unit lists. Own units: { id, defId, x, y, z, health (0-1 RATIO, not
-- hitpoints — AIStateSnapshot.cpp:45), hasCommands }. Enemies: { id, defId,
-- x, z, health } (LOS only). Blips: { id, x, z } (radar, no type).
function Engine.ownUnits()       return guarded('getOwnUnits', {}) or {} end
function Engine.visibleEnemies() return guarded('getVisibleEnemies', {}) or {} end
function Engine.radarBlips()     return guarded('getRadarBlips', {}) or {} end
function Engine.alliedUnits()    return guarded('getAlliedUnits', {}) or {} end

--- Server-log narration. NOTICE level in the engine; a headless AI's only
-- observability channel. Never raises. Returns true when something took it.
function Engine.log(msg)
    local AI = api()
    if not AI then return false end
    local fn = AI.log or AI.chat or AI.sendChat
    if type(fn) ~= 'function' then return false end
    local ok = pcall(fn, tostring(msg))
    return ok
end

--- Raw access for the actuator ONLY (it needs the write verbs). Kept as a
-- function so grepping `Engine.raw()` finds every write site in a codebase.
function Engine.raw() return api() end

return Engine
