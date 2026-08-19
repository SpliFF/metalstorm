-- tests/tick_wiring_spec.lua — the WIRING from main.lua's tick to the engine
-- verbs, driven end to end through the real modules (no module stubbed but
-- `_G.AI` itself). Run from the plugin root: busted tests/ (cwd = ai/strategos/).
--
-- Why this file exists (endtoend D68): every unit in this suite passed while the
-- AI shipped three defects that only met each other on the way OUT to the
-- engine — a demand cap stated in the wrong scale, an idle gate the AI could not
-- clear, and a directive with no expiry. Each module was locally correct. So
-- this spec asserts on the SPEC TABLE that actually reaches
-- `AI.issueDirective`, from a real Picture built off the real runtime shapes
-- (`unit.health` a 0-1 ratio, `power.json` hp), through the real planner.
--
-- The fixtures are the same regions.json + power-table shapes picture_spec uses,
-- for the same reason: a fixture that invents its own scale tests arithmetic the
-- runtime never performs.

package.path = './?.lua;' .. package.path

local dkjson = require('dkjson')

local function readFixtureFile(name)
    local f = assert(io.open('tests/fixtures/' .. name, 'r'))
    local content = f:read('*a')
    f:close()
    return content
end

local regionsFixtureJSON = readFixtureFile('regions.json')

--- The whole VM surface a real full-side AI boots against, with a sink on every
-- write verb. `ownUnits` health values are RATIOS (AIStateSnapshot.cpp:45).
local function stageVM()
    local log = { directives = {}, chats = {}, messages = {} }
    _G.AI = {
        getFrame    = function() return 0 end,
        getMapSize  = function() return 2048, 2048 end,
        getTeamId   = function() return 0 end,
        getPlayerId = function() return 7 end,
        -- A funded AI: the governor turtles on an empty pool and issues nothing,
        -- so the pool is part of the fixture. `authority_player_<playerID>` is
        -- the AI's own pool (AI3), keyed off getPlayerId above.
        getRulesParam = function(scope, key)
            if scope == 'team' and key == 'authority_player_7' then return 2000 end
            if scope == 'team' and key == 'authority_pool' then return 2000 end
            -- We hold the region the tanks stand in; its neighbours are neutral,
            -- which is what gives the planner something to want.
            if scope == 'game' and key == 'region_north_ridge_team' then return 0 end
            return nil
        end,
        getMapData  = function(name)
            if name == 'regions.json' then return (dkjson.decode(regionsFixtureJSON)) end
            return nil
        end,
        getDefExport = function(name)
            if name == 'power.json' then
                return { defs = {
                    ['101'] = { name = 'ms_tank_s1', dps = 40, hp = 1200, class = 'tanks' },
                } }
            end
            return nil
        end,
        -- Three undamaged 1 200 hp tanks in one region: 3 force, 3 600 hitpoints.
        getOwnUnits = function()
            return {
                { id = 1, x = 512, y = 0, z = 512, health = 1.0, defId = 101, hasCommands = true },
                { id = 2, x = 520, y = 0, z = 520, health = 1.0, defId = 101, hasCommands = true },
                { id = 3, x = 530, y = 0, z = 530, health = 1.0, defId = 101, hasCommands = true },
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
        chat = function(msg) log.chats[#log.chats + 1] = tostring(msg) end,
        log  = function(msg) log.chats[#log.chats + 1] = tostring(msg) end,
        issueCommand = function() error('the strategic floor was breached') end,
    }
    return log
end

--- Boot main.lua fresh and run one strategic tick. `dofile` because that is how
-- the AI VM loads it (a global `onUpdate`, not a module return).
local function tickOnce()
    for _, m in ipairs({ 'picture', 'planner', 'actuators', 'slate', 'lod',
                         'roles', 'graph', 'config', 'wire', 'scripted' }) do
        package.loaded[m] = nil
    end
    local log = stageVM()
    dofile('main.lua')
    assert(type(_G.onUpdate) == 'function', 'onUpdate global not defined')
    _G.onUpdate(150)          -- boots + first strategic tick
    return log
end

describe("main tick -> engine verbs (D68 wiring)", function()
    it("issues at least one directive from a real Picture", function()
        local log = tickOnce()
        assert.is_true(#log.directives >= 1)
    end)

    it("every directive that goes out is capped in hitpoints and is mortal", function()
        local log = tickOnce()
        for _, d in ipairs(log.directives) do
            -- The cap is the package priced in hitpoints. Three 1 200 hp tanks
            -- is 3 600 — and emphatically not 3, which is what the head count
            -- would have sent and what shut the cap on the first recruit.
            assert.are.equal(3600, d.spec.requestedStrength)
            -- Mortal: 2 x the LOD-0 tick period (150), never 0 = forever.
            assert.are.equal(300, d.spec.expiresInFrames)
        end
    end)

    it("the narration still speaks in force, not hitpoints", function()
        local log = tickOnce()
        local said = table.concat(log.chats, "\n")
        assert.is_truthy(said:find("%[strategos%]"))
        assert.is_nil(said:find("3600 force", 1, true))
    end)
end)
