#!/usr/bin/env lua
-- tools/ai-eval/driver.lua — run ONE AI plugin against ONE fixture and print
-- what the engine would have done with its commands, as JSON.
--
--   lua tools/ai-eval/driver.lua --ai data/games/metalstorm/ai/garrison \
--                               --fixture tools/ai-eval/fixtures/contact-reaction.json
--
-- WHY A SEPARATE PROCESS PER (AI, FIXTURE): an AI plugin's entry point is a
-- set of GLOBALS (`onUpdate`, and whatever else it leaks) exactly as the real
-- VM loads it. Two plugins in one Lua state would share `onUpdate`; a plugin
-- run twice would keep last run's cross-tick memory. One process per cell is
-- the only honest isolation, and it is what run-eval.mjs spawns.
--
-- THE SEAM is ai/lib/testing/fake_engine.lua: the same double the lib and
-- garrison suites assert against, which reproduces the sim-thread drain
-- (same-batch group-token resolution, the §8 E6 area clamp, the real
-- AllowDirectiveCreate charge through lib/authority, the 16-per-batch LuaMsg
-- budget, and a violations channel for the per-unit verb the production VM no
-- longer even registers). So a directive counted here is a directive the sim
-- would have created, and authority "spent" is what the sim would have
-- charged — not a tally of what the AI wished for.
--
-- The driver imitates the runtime, not a test: it reads the plugin's own
-- `ai.config.lua` / `ai.config.json` manifest for the entry buffer, gives the
-- plugin a plugin-rooted `require` (AIScriptContext::l_require), and calls the
-- global `onUpdate(frame)` every 10 frames. It never reaches inside the AI.

local function scriptDir()
    local src = debug.getinfo(1, 'S').source:sub(2)
    return src:match('^(.*)[/\\][^/\\]*$') or '.'
end

local HERE = scriptDir()
local REPO = HERE .. '/../..'

package.path = HERE .. '/?.lua;' .. package.path
local json = require('json')

-- ── args ─────────────────────────────────────────────────────────────────

local function usage(msg)
    io.stderr:write((msg and ('ai-eval driver: ' .. msg .. '\n') or '')
        .. 'usage: lua driver.lua --ai <plugin dir> --fixture <fixture.json>\n'
        .. '                      [--lib-root <dir>] [--out <file>] [--pretty]\n')
    os.exit(64)
end

local opts = { libRoot = REPO .. '/data/games/metalstorm/ai' }
local i = 1
while i <= #arg do
    local a = arg[i]
    if a == '--ai' then opts.ai = arg[i + 1]; i = i + 2
    elseif a == '--fixture' then opts.fixture = arg[i + 1]; i = i + 2
    elseif a == '--lib-root' then opts.libRoot = arg[i + 1]; i = i + 2
    elseif a == '--out' then opts.out = arg[i + 1]; i = i + 2
    elseif a == '--pretty' then opts.pretty = true; i = i + 1
    else usage('unknown argument ' .. tostring(a)) end
end
if not opts.ai or not opts.fixture then usage('--ai and --fixture are required') end
opts.ai = opts.ai:gsub('/+$', '')

local fixture = json.decodeFile(opts.fixture)
local aiId = opts.ai:match('([^/\\]+)$')

-- ── the plugin's manifest + module root ──────────────────────────────────
--
-- AIDiscovery::ConfigReader probes `ai.config.lua` then `ai.config.json`; a
-- plugin with neither is not an AI. `entry` is the single buffer the VM loads.

local function readManifest(dir)
    local chunk = loadfile(dir .. '/ai.config.lua')
    if chunk then
        local ok, cfg = pcall(chunk)
        if ok and type(cfg) == 'table' then return cfg, 'ai.config.lua' end
    end
    local f = io.open(dir .. '/ai.config.json', 'r')
    if f then
        local text = f:read('*a')
        f:close()
        return json.decode(text, dir .. '/ai.config.json'), 'ai.config.json'
    end
    return nil
end

local manifest, manifestFile = readManifest(opts.ai)
if not manifest then usage('no ai.config.lua / ai.config.json in ' .. opts.ai) end
local entry = manifest.entry or 'main.lua'

-- Plugin-scoped module root (the real `l_require` resolves only under the
-- plugin folder; garrison's `lib` symlink is how ai/lib is reachable at all —
-- see docs/ai-players.md F3/P3). The lib root is appended ONLY so the driver
-- itself can load the fake engine; a plugin that reaches it would not run on
-- the real runtime, which is a finding the harness should surface, so we
-- record whether the plugin's own root could have served each module.
package.path = opts.ai .. '/?.lua;' .. opts.ai .. '/?/init.lua;'
            .. opts.libRoot .. '/?.lua;' .. package.path

local FE      = require('lib.testing.fake_engine')
local Regions = require('lib.regions')
local Directives = require('lib.directives')

-- ── stage the engine ─────────────────────────────────────────────────────

--- A fixture may inline a table or name a repo-relative JSON file (the world
-- files under fixtures/world/ are shared by every fixture, so a graph change
-- is one edit, not six).
local function loadTable(spec)
    if type(spec) == 'string' then return json.decodeFile(REPO .. '/' .. spec) end
    return spec
end

local regionsJson = loadTable(fixture.regions)
local fe = FE.new({
    teamId    = fixture.team or 0,
    playerId  = fixture.player or 7,
    regions   = regionsJson,
    power     = loadTable(fixture.power),
    pool      = fixture.pool or 100,
    costScale = fixture.costScale,
    mapWidth  = fixture.map and fixture.map.width,
    mapHeight = fixture.map and fixture.map.height,
    -- The production VM does not register the per-unit verb at all
    -- (2026-09-16). The double keeps it so that an AI reaching for it is
    -- RECORDED as a violation instead of merely erroring — which is the whole
    -- point of scoring the strategic floor.
    exposeIssueCommand = true,
})
fe:install()

-- A read-only graph for resolving a directive's anchor back to a region, so
-- the score can talk about ground instead of coordinates. Never handed to the
-- AI — it loads its own from `AI.getMapData`, like the runtime.
local graph = Regions.load(regionsJson)

local function applyParams(list)
    for _, p in ipairs(list or {}) do
        fe:setRulesParam(p.scope or 'game', p.key, p.value, p.los)
    end
end

local function applyPatch(patch)
    if patch.own then fe:setOwnUnits(patch.own) end
    if patch.enemies then fe:setEnemies(patch.enemies) end
    if patch.blips then fe:setBlips(patch.blips) end
    if patch.pool then fe:setPool(patch.pool) end
    applyParams(patch.params)
end

applyParams(fixture.params)
applyPatch(fixture.initial or {})

-- ── load the plugin, exactly as the runtime loads its entry buffer ───────

-- A plugin that cannot boot is a RESULT, not a harness failure: it is recorded
-- as `booted = false` with the reason and scored like any other run (the
-- `booted` check fails, the cell goes red, the matrix still completes). Exiting
-- here instead would make a broken AI indistinguishable from a broken harness.
local bootError = nil
local loaded, loadErr = loadfile(opts.ai .. '/' .. entry)
if not loaded then
    bootError = 'cannot load ' .. entry .. ': ' .. tostring(loadErr)
else
    local bootOk, bootErr = pcall(loaded)
    if not bootOk then
        bootError = 'entry raised: ' .. tostring(bootErr)
    elseif type(_G.onUpdate) ~= 'function' then
        bootError = 'defines no global onUpdate (the ONLY callin the runtime dispatches — F4)'
    end
end

-- ── the timeline ─────────────────────────────────────────────────────────
--
-- Patches are applied at their frame, BEFORE the tick at that frame. An entry
-- may also declare an `event` — a moment the score measures reaction to
-- (the frame a contact becomes visible, an objective opens, a line breaks).

local patches, events = {}, json.array({})
for _, entryPatch in ipairs(fixture.timeline or {}) do
    local f = math.floor(entryPatch.frame or 0)
    patches[f] = patches[f] or {}
    patches[f][#patches[f] + 1] = entryPatch
    if entryPatch.event then
        events[#events + 1] = {
            frame = f,
            region = entryPatch.event.region,
            kind = entryPatch.event.kind or 'contact',
            id = entryPatch.event.id or (entryPatch.event.kind or 'contact') .. '@' .. f,
            -- Directive types that answer this event WHEREVER they are anchored
            -- (a withdrawal answers an overrun by pointing away from it).
            answeredBy = entryPatch.event.answeredBy,
        }
    end
end

local frames = math.floor(fixture.frames or 900)
local ticks = 0
if not bootError then
    for frame = 1, frames do
        for _, p in ipairs(patches[frame] or {}) do applyPatch(p) end
        fe:step(1, function(f) ticks = ticks + 1; return _G.onUpdate(f) end)
    end
end

-- ── the run record ───────────────────────────────────────────────────────

local directives = json.array({})
for _, c in ipairs(fe:directives()) do
    local region = Directives.regionOf(c, graph)
    directives[#directives + 1] = {
        frame = c.frame,
        type = c.type,
        typeName = Directives.name(c.type),
        priority = c.priority,
        shape = c.shape,
        region = region,
        x = c.params[1], z = c.params[3], radius = c.params[4],
        cost = c.cost or 0,
        idleOnly = c.idleOnly and true or false,
        ttl = c.expiresInFrames,
        requestedStrength = c.requestedStrength,
        groupScoped = (c.resolvedGroup or 0) ~= 0,
    }
end

local refused = {}
for _, r in ipairs(fe.refused) do
    refused[r.reason] = (refused[r.reason] or 0) + 1
end

local messages = {}
for _, m in ipairs(fe.messages) do
    -- The RecvLuaMsg codec (lib/vendor/wire.lua) puts the command first:
    -- `cmd=ai.health&frame=10&...`. We count by command, not by payload — the
    -- payload carries timings that would make the run non-comparable.
    local cmd = tostring(m.text):match('^cmd=([^&]+)')
    messages[cmd or '?'] = (messages[cmd or '?'] or 0) + 1
end

local violations = json.array({})
for _, v in ipairs(fe.violations) do
    violations[#violations + 1] = { frame = v.frame, unitId = v.unitId, cmdId = v.cmdId }
end

local errors = json.array({})
for _, e in ipairs(fe.errors or {}) do
    errors[#errors + 1] = { frame = e.frame, err = tostring(e.err) }
end

local run = {
    ai = aiId,
    aiName = manifest.name,
    manifest = manifestFile,
    fixture = fixture.id or opts.fixture:match('([^/\\]+)%.json$'),
    frames = frames,
    onUpdateCalls = ticks,
    events = events,
    directives = directives,
    refused = refused,
    messages = messages,
    violations = violations,
    errors = errors,
    spent = fe.spent,
    poolLeft = fe.pool,
    logLines = #fe.log,
    -- Booted = the manifest's entry buffer loaded, defined the one callin the
    -- runtime dispatches, and was called. Deliberately NOT "logged something":
    -- the no-op control AI is silent by design and is still a correct boot.
    booted = bootError == nil and ticks > 0,
    bootError = bootError,
}

local text = json.encode(run, opts.pretty and '  ' or nil) .. '\n'
if opts.out then
    local f = assert(io.open(opts.out, 'w'))
    f:write(text)
    f:close()
else
    io.write(text)
end
