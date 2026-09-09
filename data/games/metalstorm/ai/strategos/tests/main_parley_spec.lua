-- tests/main_parley_spec.lua — main.lua's crank: the parley ledger + poll,
-- the co-commander deference/hand-back flip, tick-error backoff, the
-- boot-retry gate and the `ai.health` line (2026-09-10 review, tasks 2/4/5).
-- Run from the plugin root: busted tests/ (cwd = ai/strategos/).
--
-- Same discipline as tick_wiring_spec.lua: the REAL modules end to end, only
-- `_G.AI` staged. The staged rulesParams table is MUTABLE so a test can put a
-- proposal on the board between ticks and flip team_active_humans.

package.path = './?.lua;' .. package.path

local dkjson = require('dkjson')
local Wire   = require('wire')

local function readFixtureFile(name)
    local f = assert(io.open('tests/fixtures/' .. name, 'r'))
    local content = f:read('*a')
    f:close()
    return content
end
local regionsFixtureJSON = readFixtureFile('regions.json')

--- Stage the VM. Returns log + the mutable params table + a `frame` cell.
local function stageVM()
    local log = { directives = {}, chats = {}, messages = {}, rulesParamCalls = 0 }
    local params = {
        ['team:authority_player_7'] = 2000,
        ['team:authority_pool'] = 2000,
        ['game:region_north_ridge_team'] = 0,
    }
    local vm = { log = log, params = params, frame = 0 }
    _G.AI = {
        getFrame    = function() return vm.frame end,
        getMapSize  = function() return 2048, 2048 end,
        getTeamId   = function() return 0 end,
        getPlayerId = function() return 7 end,
        getRulesParam = function(scope, key)
            log.rulesParamCalls = log.rulesParamCalls + 1
            return params[scope .. ':' .. key]
        end,
        getMapData  = function(name)
            if name == 'regions.json' then return (dkjson.decode(regionsFixtureJSON)) end
        end,
        getDefExport = function(name)
            if name == 'power.json' then
                return { defs = { ['101'] = { name = 'ms_tank_s1', dps = 40, hp = 1200, class = 'tanks' } } }
            end
        end,
        getOwnUnits = function()
            return {
                { id = 1, x = 512, y = 0, z = 512, health = 1.0, defId = 101, hasCommands = true },
                { id = 2, x = 520, y = 0, z = 520, health = 1.0, defId = 101, hasCommands = true },
            }
        end,
        getVisibleEnemies = function()
            return { { id = 9, x = 1536, z = 512, health = 1.0, defId = 101 } }
        end,
        createGroup = function() return -1 end,
        issueDirective = function(handle, spec)
            log.directives[#log.directives + 1] = { handle = handle, spec = spec }
            return true
        end,
        setPosture  = function() return true end,
        sendMessage = function(msg) log.messages[#log.messages + 1] = msg; return true end,
        log = function(msg) log.chats[#log.chats + 1] = tostring(msg) end,
        issueCommand = function() error('the strategic floor was breached') end,
    }
    return vm
end

local function bootMain()
    for _, m in ipairs({ 'picture', 'planner', 'actuators', 'slate', 'lod',
                         'roles', 'graph', 'config', 'wire', 'scripted' }) do
        package.loaded[m] = nil
    end
    local vm = stageVM()
    _G.AI_STRATEGOS_BOOT_ERROR = nil
    dofile('main.lua')
    return vm
end

local function tick(vm, frame)
    vm.frame = frame
    _G.onUpdate(frame)
end

--- Put a pending proposal addressed to team 0 on the board.
local function offer(vm, id, kind, fromTeam)
    local p = 'game:parley_' .. id .. '_'
    vm.params['game:parley_count'] = math.max(vm.params['game:parley_count'] or 0, id)
    vm.params[p .. 'kind']     = kind
    vm.params[p .. 'from']     = fromTeam or 5
    vm.params[p .. 'to']       = 0
    vm.params[p .. 'state']    = 'offered'
    vm.params[p .. 'deadline'] = vm.frame + 1800
    if kind == 'ceasefire' then vm.params[p .. 'duration'] = 1800 end
    if kind == 'intel' then vm.params[p .. 'regionKeys'] = 'north_ridge' end
end

local function messagesOf(vm, cmd)
    local out = {}
    for _, msg in ipairs(vm.log.messages) do
        local c, fields = Wire.decode(msg)
        if c == cmd then out[#out + 1] = fields end
    end
    return out
end

local function chatsContaining(vm, needle)
    local n = 0
    for _, c in ipairs(vm.log.chats) do if c:find(needle, 1, true) then n = n + 1 end end
    return n
end

describe("main — parley response is bounded and answered exactly once", function()
    it("answers a pending intel offer on the tick, and not again while it drains", function()
        local vm = bootMain()
        offer(vm, 1, 'intel')
        tick(vm, 150)
        local responses = messagesOf(vm, 'parley.respond')
        assert.are.equal(1, #responses)
        assert.are.equal('1', responses[1].id)
        assert.are.equal('accept', responses[1].decision)
        -- Next tick: the board still says 'offered' (message not drained yet).
        tick(vm, 300)
        assert.are.equal(1, #messagesOf(vm, 'parley.respond'))
        assert.are.equal(1, chatsContaining(vm, 'parley #1'))
    end)

    it("the poll forces a tick for a new proposal even while backed off after an error", function()
        local vm = bootMain()
        tick(vm, 150)                                   -- boot + tick 1, healthy
        local Planner = require('planner')
        local realPlan = Planner.plan
        Planner.plan = function() error('injected planner fault') end
        tick(vm, 300)                                   -- tick 2 throws → backoff x2 (period 300)
        Planner.plan = realPlan
        local before = #messagesOf(vm, 'parley.respond')
        tick(vm, 450)                                   -- gated: 150 < 300; poll sees nothing
        assert.are.equal(before, #messagesOf(vm, 'parley.respond'))
        offer(vm, 1, 'intel')
        tick(vm, 500)                                   -- poll gate (150 frames) not yet due
        assert.are.equal(before, #messagesOf(vm, 'parley.respond'))
        tick(vm, 600)                                   -- poll due → pending → forced tick
        assert.are.equal(before + 1, #messagesOf(vm, 'parley.respond'))
        -- and the health line shows the recovery: errors=1, backoff back to 1.
        local health = messagesOf(vm, 'ai.health')
        local last = health[#health]
        assert.are.equal('1', last.errors)
        assert.are.equal('1', last.backoff)
        assert.is_truthy(tostring(last.error):find('injected planner fault', 1, true))
    end)
end)

describe("main — co-commander deference and the caretaker hand-back", function()
    it("with a human present it defers a binding proposal; when they leave it answers", function()
        local vm = bootMain()
        vm.params['team:team_active_humans'] = 1        -- a human is on our team
        offer(vm, 1, 'ceasefire')
        tick(vm, 150)
        assert.are.equal(0, #messagesOf(vm, 'parley.respond'))
        assert.are.equal(1, chatsContaining(vm, 'deferred to my team'))
        tick(vm, 300)                                   -- still deferred, narrated ONCE
        assert.are.equal(0, #messagesOf(vm, 'parley.respond'))
        assert.are.equal(1, chatsContaining(vm, 'deferred to my team'))
        -- Every directive it issued as co-commander stated the idle rule.
        for _, d in ipairs(vm.log.directives) do assert.is_true(d.spec.idleOnly) end

        vm.params['team:team_active_humans'] = 0        -- last human left → caretaker
        tick(vm, 450)
        assert.are.equal(1, chatsContaining(vm, 'role -> full_side'))
        assert.are.equal(1, #messagesOf(vm, 'parley.respond'))
    end)

    it("hand-back: a human rejoining flips the next tick to co-commander (idleOnly on the wire)", function()
        local vm = bootMain()
        vm.params['team:team_active_humans'] = 0
        tick(vm, 150)
        local n = #vm.log.directives
        assert.is_true(n >= 1)
        assert.is_false(vm.log.directives[n].spec.idleOnly)
        vm.params['team:team_active_humans'] = 1
        tick(vm, 300)
        assert.are.equal(1, chatsContaining(vm, 'role -> co_commander'))
        for i = n + 1, #vm.log.directives do
            assert.is_true(vm.log.directives[i].spec.idleOnly)
        end
    end)
end)

describe("main — health line and boot-retry gate", function()
    it("sends one ai.health message per tick with the documented fields", function()
        local vm = bootMain()
        tick(vm, 150)
        tick(vm, 300)
        local health = messagesOf(vm, 'ai.health')
        assert.are.equal(2, #health)
        local h = health[2]
        assert.are.equal('2', h.ticks)
        assert.are.equal('0', h.errors)
        assert.are.equal('1', h.backoff)
        assert.are.equal('300', h.frame)
        assert.is_truthy(tonumber(h.issued))
        assert.is_truthy(tonumber(h.planned))
        assert.is_nil(h.error)
    end)

    it("a failed boot is retried on a gate, not on every callin", function()
        local vm = bootMain()
        local realGet = _G.AI.getRulesParam
        _G.AI.getRulesParam = function() error('rulesParams not ready') end
        tick(vm, 10)
        assert.is_truthy(tostring(_G.AI_STRATEGOS_BOOT_ERROR):find('rulesParams not ready', 1, true))
        local calls = 0
        _G.AI.getRulesParam = function() calls = calls + 1; error('rulesParams not ready') end
        tick(vm, 20)                                    -- inside the 300-frame gate
        tick(vm, 200)
        assert.are.equal(0, calls)
        _G.AI.getRulesParam = realGet
        tick(vm, 320)                                   -- gate open → boots and ticks
        assert.are.equal(1, #messagesOf(vm, 'ai.health'))
        assert.are.equal(1, chatsContaining(vm, 'online'))
    end)
end)
