-- scenario_references_spec.lua — the dangling-reference sweep.
--
-- EVERY shipped scenario, checked against the things it names: unit defs,
-- feature defs, command names, its map, and that map's region keys. It is the
-- regression net the 2026-09-10 battle-flow review asked for (Task 3), and the
-- reason it exists is that a scenario is a pile of STRINGS the loader resolves
-- at GameStart, on a machine nobody is watching:
--
--   * an unknown `units[].def` is counted and dropped by game_scenario.lua's
--     validate() — the war stages, one column short, and says so in a log line
--     that scrolls past;
--   * an unknown `arrivals[].cargo[].def` drops the WHOLE wave;
--   * a region key the map does not publish makes
--     GG.Regions.SetControllingTeam a no-op — the side "owns" nothing and a
--     `control` objective on that key can never complete, which is a war that
--     cannot end;
--   * a `world.map` with no map directory is a war the lobby offers and cannot
--     stage.
--
-- None of those is a crash, and that is exactly why a test has to look.
--
-- RUN FROM THE GAME ROOT, like every other scenario spec:
--   cd data/games/metalstorm && busted LuaRules/Gadgets/tests/scenario_references_spec.lua
-- From LuaRules/Gadgets it reports "cannot open scenarios/..." — a wrong cwd,
-- not a real failure.
--
-- ============================================================================
-- EVERY ID BELOW COMES FROM ITS PRODUCER. That rule is the whole design, and
-- it is a reaction to how the other gadget specs mock: `_G.CMD = { FIGHT = 16,
-- MOVE = 10, GUARD = 25 }`, a hand-written fixture keyspace that agrees with
-- the engine only by luck and cannot notice when the engine gains or loses a
-- command. A sweep whose universe is hand-written can only ever prove that a
-- scenario agrees with the sweep.
--
--   unit defs     <- dofile of units/*.lua with a VFS.Include stub
--                    (units/_builder.lua generates the scale curves, so the
--                    list cannot be transcribed — it has to be EXECUTED).
--   feature defs  <- dofile of features/*.lua, same stub.
--   command names <- #define CMD_<NAME> in
--                    rts/Sim/Units/CommandAI/Command.h, the C++ header the
--                    engine's own CMD table is built from.
--   region keys   <- the MAP's mapdata/regions.lua.
--   maps          <- the directories under data/maps/.
--
-- data/maps is gitignored (PLAN-maps.md: shipped map assets are large external
-- content), so the map-dependent half of this spec is PENDING rather than
-- failing when it is absent — a fresh worktree has no maps and must not read
-- as a broken repo. Point it at a checkout that has them with
-- SPRINGRTS_MAPS_DIR=/path/to/springrts-web/data/maps.

local lfsOK = pcall(require, 'lfs')

--- Shell out rather than require lfs: busted here runs on a stock Lua with no
--- filesystem module, and `ls` is the same tool every sibling spec's fixtures
--- are generated with.
local function listFiles(glob)
    local out, p = {}, io.popen('ls ' .. glob .. ' 2>/dev/null')
    if not p then return out end
    for line in p:lines() do out[#out + 1] = line end
    p:close()
    return out
end

local function isDir(path)
    local p = io.popen('test -d "' .. path .. '" && echo yes 2>/dev/null')
    if not p then return false end
    local r = p:read('*l'); p:close()
    return r == 'yes'
end

local function readFile(path)
    local f = io.open(path, 'r')
    if not f then return nil end
    local s = f:read('*a'); f:close()
    return s
end

-- ---------------------------------------------------------------------------
-- The def universe, executed out of the producer
-- ---------------------------------------------------------------------------

--- units/*.lua and features/*.lua are not tables on disk; most of units/ is
--- `return mk{...}` over units/_builder.lua, which mints the four scale tiers
--- from one class description. The only honest way to know what ships is to
--- run them — with `VFS.Include` stubbed to a plain dofile, which is all the
--- engine's VFS does for a path that exists.
local function loadDefs(dir)
    local savedVFS = _G.VFS
    _G.VFS = { Include = function(p) return dofile(p) end,
               DirList = function() return {} end }
    local defs, failures = {}, {}
    for _, file in ipairs(listFiles(dir .. '/*.lua')) do
        local ok, t = pcall(dofile, file)
        if not ok then
            failures[#failures + 1] = file .. ': ' .. tostring(t)
        elseif type(t) == 'table' then
            for name, def in pairs(t) do defs[name] = def end
        end
    end
    _G.VFS = savedVFS
    return defs, failures
end

--- The engine's command ids, parsed out of the C++ header they are defined in.
--- Returns nil when the header is not reachable (this spec may be run from a
--- content-only checkout), which the tests below turn into a `pending`.
local function loadCommandNames()
    local text = readFile('../../../rts/Sim/Units/CommandAI/Command.h')
    if not text then return nil end
    local names = {}
    for name in text:gmatch('#define%s+CMD_([%u%d_]+)%s') do names[name] = true end
    if next(names) == nil then return nil end
    return names
end

--- data/maps, wherever it is on this machine.
local function mapsRoot()
    local env = os.getenv('SPRINGRTS_MAPS_DIR')
    if env and env ~= '' and isDir(env) then return env end
    if isDir('../../../data/maps') then return '../../../data/maps' end
    return nil
end

--- A map's published region graph: key -> true. Returns nil when the map ships
--- no mapdata/regions.lua at all, which is legal — game_regions.lua then falls
--- back to the fixed 2048-elmo grid and keys read "gridX:gridZ".
local function regionKeys(root, map)
    local path = root .. '/' .. map .. '/mapdata/regions.lua'
    local ok, data = pcall(dofile, path)
    if not ok or type(data) ~= 'table' or type(data.regions) ~= 'table' then return nil end
    local keys = {}
    for _, r in ipairs(data.regions) do
        if type(r.key) == 'string' then keys[r.key] = true end
    end
    return keys
end

--- A grid-provider key, for a map with no named graph: "3:5".
local function isGridKey(key)
    return type(key) == 'string' and key:match('^%d+:%d+$') ~= nil
end

-- ---------------------------------------------------------------------------
-- Slot arithmetic, mirroring game_transports.lua
-- ---------------------------------------------------------------------------

--- game_transports.lua slotCost, minus the engine-only `xsize` branch (xsize
--- is footprintx * 2 at runtime, so the two agree by construction).
local function slotCost(def)
    if not def then return 1 end
    local fp = tonumber(def.footprintX or def.footprintx)
    if fp and fp > 0 then return math.floor(fp) end
    local cp = def.customParams or def.customparams or {}
    local scale = tonumber(cp.ms_scale)
    if scale and scale >= 1 then return math.floor(scale) end
    return 1
end

-- ---------------------------------------------------------------------------

local UNIT_DEFS, UNIT_FAILURES = loadDefs('units')
local FEATURE_DEFS, FEATURE_FAILURES = loadDefs('features')
local CMD_NAMES = loadCommandNames()
local MAPS_ROOT = mapsRoot()

local SCENARIOS = {}
for _, path in ipairs(listFiles('scenarios/*.lua')) do
    local ok, scn = pcall(dofile, path)
    SCENARIOS[#SCENARIOS + 1] = { path = path, ok = ok, scn = ok and scn or nil, err = not ok and scn or nil }
end

--- Every def name a scenario names, with the context that names it, so a
--- failure says WHERE. Deliberately exhaustive over the schema rather than
--- over the shipped files: a field that no scenario currently uses is exactly
--- the field the next scenario will get wrong.
local function unitRefs(scn)
    local refs = {}
    local function add(name, where) if name ~= nil then refs[#refs + 1] = { name = name, where = where } end end
    for i, u in ipairs(scn.units or {}) do add(u.def, 'units[' .. i .. ']') end
    for i, c in ipairs(((scn.civilians or {}).units) or {}) do add(c.def, 'civilians.units[' .. i .. ']') end
    for i, a in ipairs(scn.arrivals or {}) do
        add(a.def, 'arrivals[' .. i .. '].def')
        for j, c in ipairs(a.cargo or {}) do
            add(c.def, 'arrivals[' .. i .. '].cargo[' .. j .. ']')
        end
    end
    for i, o in ipairs(scn.objectives or {}) do
        local m = o._populateUnitsFrom
        for j, d in ipairs((m and m.defs) or {}) do
            add(d, 'objectives[' .. i .. ']._populateUnitsFrom.defs[' .. j .. ']')
        end
    end
    for i, t in ipairs(scn.towns or {}) do
        add(t.hall, 'towns[' .. i .. '].hall')
        for j, b in ipairs(t.buildings or {}) do add(b.def, 'towns[' .. i .. '].buildings[' .. j .. ']') end
    end
    return refs
end

local function featureRefs(scn)
    local refs = {}
    for i, f in ipairs(((scn.world or {}).features) or {}) do
        if f.def ~= nil then refs[#refs + 1] = { name = f.def, where = 'world.features[' .. i .. ']' } end
    end
    return refs
end

local function commandRefs(scn)
    local refs = {}
    for i, u in ipairs(scn.units or {}) do
        for j, o in ipairs(u.orders or {}) do
            if type(o.cmd) == 'string' then
                refs[#refs + 1] = { name = o.cmd, where = 'units[' .. i .. '].orders[' .. j .. ']' }
            end
        end
    end
    for i, a in ipairs(scn.arrivals or {}) do
        if a.order and type(a.order.cmd) == 'string' then
            refs[#refs + 1] = { name = a.order.cmd, where = 'arrivals[' .. i .. '].order' }
        end
    end
    return refs
end

local function regionRefs(scn)
    local refs = {}
    for i, r in ipairs(((scn.world or {}).regions) or {}) do
        if r.key ~= nil then refs[#refs + 1] = { name = r.key, where = 'world.regions[' .. i .. ']' } end
    end
    for i, o in ipairs(scn.objectives or {}) do
        local key = o.region or (o.params or {}).regionKey
        if key ~= nil then refs[#refs + 1] = { name = key, where = 'objectives[' .. i .. '].region' } end
    end
    return refs
end

describe('scenario references', function()

    it('executes every unit and feature def file', function()
        -- If this fails, every check below is measuring a hole in the def
        -- universe rather than a hole in a scenario.
        assert.same({}, UNIT_FAILURES)
        assert.same({}, FEATURE_FAILURES)
        assert.is_true(next(UNIT_DEFS) ~= nil)
        assert.is_true(next(FEATURE_DEFS) ~= nil)
    end)

    it('finds at least one scenario to sweep', function()
        -- A sweep over nothing passes forever. Same reason
        -- verify_scenario_maps.py exits 2 on an empty scenarios dir.
        assert.is_true(#SCENARIOS > 0)
    end)

    for _, entry in ipairs(SCENARIOS) do
        describe(entry.path, function()
            local scn = entry.scn

            it('parses with a bare lua_State', function()
                -- ScenarioDiscovery::LoadOne has no VFS, no Spring.*, no
                -- require. A scenario that needs any of them does not fail
                -- loudly — it silently vanishes from the Create Game list.
                assert.is_true(entry.ok, tostring(entry.err))
                assert.is_table(scn)
            end)

            it('names only unit defs that exist', function()
                if not scn then return end
                local missing = {}
                for _, ref in ipairs(unitRefs(scn)) do
                    if UNIT_DEFS[ref.name] == nil then
                        missing[#missing + 1] = ref.where .. ' -> "' .. tostring(ref.name) .. '"'
                    end
                end
                assert.same({}, missing)
            end)

            it('names only feature defs that exist', function()
                if not scn then return end
                local missing = {}
                for _, ref in ipairs(featureRefs(scn)) do
                    if FEATURE_DEFS[ref.name] == nil then
                        missing[#missing + 1] = ref.where .. ' -> "' .. tostring(ref.name) .. '"'
                    end
                end
                assert.same({}, missing)
            end)

            it('names only commands the engine defines', function()
                if not scn then return end
                if CMD_NAMES == nil then
                    pending('rts/Sim/Units/CommandAI/Command.h not reachable from this cwd')
                    return
                end
                local missing = {}
                for _, ref in ipairs(commandRefs(scn)) do
                    if not CMD_NAMES[ref.name] then
                        missing[#missing + 1] = ref.where .. ' -> "' .. tostring(ref.name) .. '"'
                    end
                end
                assert.same({}, missing)
            end)

            it("carries cargo its carrier can actually lift", function()
                if not scn then return end
                -- game_transports.lua validateArrival drops the WHOLE wave
                -- when the arithmetic fails, so an over-loaded manifest is a
                -- reinforcement that silently never comes. `transportsize` is
                -- the per-passenger limit and is NOT checked at load by the
                -- gadget — the engine simply refuses the attach, which is the
                -- `fable_train_troop` bug this review found out of lane.
                local problems = {}
                for i, a in ipairs(scn.arrivals or {}) do
                    local carrier = UNIT_DEFS[a.def]
                    if carrier then
                        local capacity = math.floor(tonumber(carrier.transportcapacity) or 0)
                        local size = math.floor(tonumber(carrier.transportsize) or 0)
                        local slots = 0
                        for _, c in ipairs(a.cargo or {}) do
                            local cd = UNIT_DEFS[c.def]
                            local n = math.max(1, math.floor(tonumber(c.count) or 1))
                            slots = slots + slotCost(cd) * n
                            local fp = cd and math.floor(tonumber(cd.footprintx) or 0) or 0
                            if cd and size > 0 and fp > size then
                                problems[#problems + 1] = string.format(
                                    'arrivals[%d] (%s): %s is footprint %d but %s carries size %d',
                                    i, tostring(a.id), c.def, fp, a.def, size)
                            end
                        end
                        if slots > capacity then
                            problems[#problems + 1] = string.format(
                                'arrivals[%d] (%s): cargo needs %d slot(s) but %s carries %d',
                                i, tostring(a.id), slots, a.def, capacity)
                        end
                    end
                end
                assert.same({}, problems)
            end)

            it('targets a map that exists, and region keys that map publishes', function()
                if not scn then return end
                local map = (scn.world or {}).map
                if map == nil then return end          -- tutorials may declare none
                if MAPS_ROOT == nil then
                    pending('data/maps is gitignored and absent — set SPRINGRTS_MAPS_DIR')
                    return
                end
                assert.is_true(isDir(MAPS_ROOT .. '/' .. map),
                               'world.map "' .. map .. '" has no directory under ' .. MAPS_ROOT)

                local keys = regionKeys(MAPS_ROOT, map)
                local missing = {}
                for _, ref in ipairs(regionRefs(scn)) do
                    if keys == nil then
                        -- No named graph: game_regions.lua uses the fixed
                        -- 2048-elmo grid, so only "x:z" keys can resolve.
                        if not isGridKey(ref.name) then
                            missing[#missing + 1] = ref.where .. ' -> "' .. tostring(ref.name) ..
                                '" (map ships no mapdata/regions.lua; only grid keys resolve)'
                        end
                    elseif not keys[ref.name] then
                        missing[#missing + 1] = ref.where .. ' -> "' .. tostring(ref.name) .. '"'
                    end
                end
                assert.same({}, missing)
            end)
        end)
    end
end)
