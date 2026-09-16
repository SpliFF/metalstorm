-- Capture AI — never commands anything; dumps AIStateSnapshot data as JSON
-- to the server log, one line per sample, for tools/ai-eval/capture.mjs to
-- turn into a RECORDED tools/ai-eval fixture (see that script's header and
-- tools/ai-eval/README.md "Writing a fixture").
--
-- Every line this plugin logs is prefixed MARKER so the capture script can
-- grep it out of a `--headless-run`'s stdout without caring about whatever
-- else is on the log (tick summaries from the real AI on the other team,
-- engine warnings, ...).

local json = require('json')

local MARKER       = 'AICAPTURE '
local SAMPLE_EVERY = 30     -- 1 game-second @ 30 Hz — a fixture's own
                             -- `timeline` only needs a handful of frames, so
                             -- oversampling here just costs log volume.
local BOARD_FIELDS = {
    'type', 'scope', 'state', 'reward', 'team', 'team2', 'progress',
    'phase', 'stage', 'expire', 'region', 'x', 'z', 'r', 'suggested', 'source',
    'victory',
}
-- Bounded scan: no "list every team" rulesParam capability exists (same
-- honest limit ai/strategos/picture.lua documents for parley counterparties),
-- so departure zones are polled for a fixed small set of team ids rather than
-- enumerated. Eight covers every scenario this repo's manifests use.
local MAX_TEAMS = 8

local staticDumped = false
local regionKeys = nil   -- discovered once from the static regions.json export

local function log(tag, data)
    local AI = _G.AI
    if type(AI) ~= 'table' or type(AI.log) ~= 'function' then return end
    AI.log(MARKER .. tag .. ' ' .. json.encode(data))
end

--- The region graph + power table, once — the fixture's `regions`/`power`
-- fields (see README "Writing a fixture": a fixture may inline a table).
-- Also remembers the region keys so per-tick sampling knows which
-- `region_<key>_team` rulesParams to poll (AI.getRulesParam has no
-- enumeration form — see picture.lua's own readRegions for the same limit).
local function dumpStaticOnce()
    if staticDumped then return end
    staticDumped = true
    local AI = _G.AI
    if type(AI) ~= 'table' then return end

    if type(AI.getMapData) == 'function' then
        local ok, regions = pcall(AI.getMapData, 'regions.json')
        if ok and type(regions) == 'table' then
            log('regions', regions)
            if type(regions.regions) == 'table' then
                regionKeys = {}
                for _, r in ipairs(regions.regions) do
                    if r.key then regionKeys[#regionKeys + 1] = r.key end
                end
            end
        end
    end
    if type(AI.getDefExport) == 'function' then
        local ok, power = pcall(AI.getDefExport, 'power.json')
        if ok and type(power) == 'table' and type(power.defs) == 'table' then
            -- SLOG truncates a long line silently (measured ~8 KB) and a
            -- real game's power.json is hundreds of defs — one line per def
            -- is too chatty, one line for the whole table gets cut off
            -- mid-object. Chunk it: CHUNK defs per 'power' line, so
            -- capture.mjs can just concatenate every chunk's `defs`.
            local CHUNK = 20
            local keys = {}
            for k in pairs(power.defs) do keys[#keys + 1] = k end
            table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
            for start = 1, #keys, CHUNK do
                local chunk = {}
                for i = start, math.min(start + CHUNK - 1, #keys) do
                    chunk[keys[i]] = power.defs[keys[i]]
                end
                log('power', { defs = chunk })
            end
        end
    end
end

--- game-scope params worth polling every sample: region ownership + the
-- objective board (game_regions.lua / game_objectives.lua's own publish
-- lists — see ai/strategos/picture.lua's readRegions/readBoard, which this
-- mirrors so a capture reads the SAME keys the AIs under test read).
local function sampleParams(AI)
    local out = json.array({})
    for _, key in ipairs(regionKeys or {}) do
        local team = AI.getRulesParam('game', 'region_' .. key .. '_team')
        if team ~= nil then
            out[#out + 1] = { scope = 'game', key = 'region_' .. key .. '_team', value = team }
        end
        local contested = AI.getRulesParam('game', 'region_' .. key .. '_contested')
        if contested ~= nil then
            out[#out + 1] = { scope = 'game', key = 'region_' .. key .. '_contested', value = contested }
        end
    end

    local count = tonumber(AI.getRulesParam('game', 'objective_count')) or 0
    out[#out + 1] = { scope = 'game', key = 'objective_count', value = count }
    for id = 1, count do
        local prefix = 'objective_' .. id .. '_'
        for _, field in ipairs(BOARD_FIELDS) do
            local v = AI.getRulesParam('game', prefix .. field)
            if v ~= nil then out[#out + 1] = { scope = 'game', key = prefix .. field, value = v } end
        end
    end

    for teamId = 0, MAX_TEAMS - 1 do
        local prefix = 'ms_departure_' .. teamId .. '_'
        local x = AI.getRulesParam('team', prefix .. 'x')
        if x ~= nil then
            out[#out + 1] = { scope = 'team', key = prefix .. 'x', value = x }
            out[#out + 1] = { scope = 'team', key = prefix .. 'z',
                               value = AI.getRulesParam('team', prefix .. 'z') }
            out[#out + 1] = { scope = 'team', key = prefix .. 'r',
                               value = AI.getRulesParam('team', prefix .. 'r') }
        end
    end
    return out
end

local function sampleUnit(u)
    -- Same fields the ai-eval fixture DSL's `initial.own`/timeline `own`
    -- entries carry (driver.lua -> fake_engine.lua's setOwnUnits contract).
    return { id = u.id, defId = u.defId, x = u.x, y = u.y, z = u.z,
             health = u.health, hasCommands = u.hasCommands and true or false }
end

local function sampleEnemy(e)
    return { id = e.id, defId = e.defId, x = e.x, z = e.z, health = e.health }
end

function onUpdate(frame)
    local AI = _G.AI
    if type(AI) ~= 'table' then return end
    if frame % SAMPLE_EVERY ~= 0 then return end

    dumpStaticOnce()
    if type(AI.getRulesParam) ~= 'function' then return end

    local own, enemies = json.array({}), json.array({})
    if type(AI.getOwnUnits) == 'function' then
        for _, u in ipairs(AI.getOwnUnits() or {}) do own[#own + 1] = sampleUnit(u) end
    end
    if type(AI.getVisibleEnemies) == 'function' then
        for _, e in ipairs(AI.getVisibleEnemies() or {}) do enemies[#enemies + 1] = sampleEnemy(e) end
    end

    log('sample', { frame = frame, own = own, enemies = enemies, params = sampleParams(AI) })
end

function onUnitCreated(unitID, unitDefID, teamID)   -- luacheck: ignore
end

function onUnitDestroyed(unitID, attackerID)         -- luacheck: ignore
end
