-- tests/game_ai_health_spec.lua — the `ai.health` line game_ai_guidance.lua
-- mirrors as ai_health_<playerID>_* team rulesParams (2026-09-10 review,
-- task 5). The strings are the exact ones ai/strategos/main.lua's
-- publishHealth encodes.
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets && busted tests/

package.path = './?.lua;' .. package.path

local mock = require('tests.parley_mock')
local Wire = require('parley.wire')

local function newWorld()
    local world, gadgetObj = mock.new('./game_ai_guidance.lua')
    world.setPlayer(1, 10)        -- human on team 10
    world.setAIPlayer(8, 10)      -- AI virtual player on team 10
    return world, gadgetObj
end

local function healthMsg(over)
    local f = { ticks = 12, errors = 1, backoff = 2, frame = 1800, issued = 9, planned = 360,
                responses = 1, proposals = 0, deferred = 2, refused = 0,
                computeMs = '1.25', lastErrorFrame = 1650, error = 'planner.lua:12: boom' }
    for k, v in pairs(over or {}) do f[k] = v end
    return Wire.encode('ai.health', f)
end

describe("ai.health → ai_health_<pid>_* (task 5)", function()
    it("publishes every documented field on the AI's team, keyed by integer playerID", function()
        local world, gadgetObj = newWorld()
        world.frame = 1800
        gadgetObj:RecvLuaMsg(healthMsg(), 8)
        local p = 'ai_health_8_'
        assert.are.equal(12,   world.trp(10, p .. 'ticks'))
        assert.are.equal(1,    world.trp(10, p .. 'errors'))
        assert.are.equal(2,    world.trp(10, p .. 'backoff'))
        assert.are.equal(1800, world.trp(10, p .. 'frame'))
        assert.are.equal(9,    world.trp(10, p .. 'issued'))
        assert.are.equal(360,  world.trp(10, p .. 'planned'))
        assert.are.equal(2,    world.trp(10, p .. 'deferred'))
        assert.are.equal(1.25, world.trp(10, p .. 'computeMs'))
        assert.are.equal(1650, world.trp(10, p .. 'lastErrorFrame'))
        assert.are.equal('planner.lua:12: boom', world.trp(10, p .. 'error'))
        -- Charged figures start at 0 (nothing charged yet).
        assert.are.equal(0, world.trp(10, p .. 'directives'))
        assert.are.equal(0, world.trp(10, p .. 'spent'))
        assert.are.equal(12, GG.AIGuidance.Health(8).ticks)
    end)

    it("a healthy line publishes error as '' (republish is total)", function()
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(healthMsg(), 8)
        gadgetObj:RecvLuaMsg(Wire.encode('ai.health', { ticks = 13, errors = 0, backoff = 1, frame = 1950 }), 8)
        assert.are.equal('', world.trp(10, 'ai_health_8_error'))
        assert.are.equal(0, world.trp(10, 'ai_health_8_errors'))
    end)

    it("a human on the funnel cannot forge an AI's health line", function()
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(healthMsg(), 1)
        assert.is_nil(world.trp(10, 'ai_health_1_ticks'))
        assert.is_nil(GG.AIGuidance.Health(1))
    end)

    it("the charged directive count and spend accrue from RecordIntent, not the self-report", function()
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(healthMsg({ issued = 9, planned = 360 }), 8)
        GG.AIGuidance.RecordIntent(10, 9, 0, 40, 8)
        GG.AIGuidance.RecordIntent(10, 10, 0, 25.5, 8)
        assert.are.equal(2,  world.trp(10, 'ai_health_8_directives'))
        assert.are.equal(65, world.trp(10, 'ai_health_8_spent'))
        assert.are.equal(9,  world.trp(10, 'ai_health_8_issued'))   -- self-report untouched
        -- A later self-report does not reset the charged figures.
        gadgetObj:RecvLuaMsg(healthMsg({ ticks = 13 }), 8)
        assert.are.equal(2, world.trp(10, 'ai_health_8_directives'))
        assert.are.equal(13, world.trp(10, 'ai_health_8_ticks'))
    end)
end)
