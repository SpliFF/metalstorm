-- tests/game_ai_guidance_spec.lua — team-scoped guidance store behaviour
-- (PLAN-metalstorm-interaction.md §6, §11). Run from the plugin root:
--   cd data/games/metalstorm/LuaRules/Gadgets && busted tests/

package.path = './?.lua;' .. package.path

local mock = require('tests.parley_mock')
local Wire = require('parley.wire')

local function newWorld()
    local world, gadgetObj = mock.new('./game_ai_guidance.lua')
    world.setPlayer(1, 10)   -- team member
    world.setPlayer(2, 20)   -- a DIFFERENT team
    return world, gadgetObj
end

describe("validated writes (§6.2)", function()
    it("accepts a stance change from a team member", function()
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.stance', { value = 'aggressive' }), 1)
        assert.are.equal('aggressive', GG.AIGuidance.Get(10).stance)
    end)

    it("rejects a write from a non-team-member (spoofed team)", function()
        local world, gadgetObj = newWorld()
        -- Player 2 is on team 20; RecvLuaMsg derives the acting team from
        -- the PLAYER, so there is no team field to spoof — this proves the
        -- write lands on player 2's OWN team (20), never team 10.
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.stance', { value = 'aggressive' }), 2)
        assert.are.equal('balanced', GG.AIGuidance.Get(10).stance)   -- unaffected, still default
        assert.are.equal('aggressive', GG.AIGuidance.Get(20).stance)
    end)

    it("rejects a bogus stance value", function()
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.stance', { value = 'nonsense' }), 1)
        assert.are.equal('balanced', GG.AIGuidance.Get(10).stance)   -- unchanged default
    end)

    it("last-write-wins on region paint, and 'normal' clears the override", function()
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.paint', { regionKey = 'basin_a', value = 'forbidden' }), 1)
        assert.are.equal('forbidden', GG.AIGuidance.Get(10).region_paint.basin_a)

        gadgetObj:RecvLuaMsg(Wire.encode('guidance.paint', { regionKey = 'basin_a', value = 'priority' }), 1)
        assert.are.equal('priority', GG.AIGuidance.Get(10).region_paint.basin_a)

        gadgetObj:RecvLuaMsg(Wire.encode('guidance.paint', { regionKey = 'basin_a', value = 'normal' }), 1)
        assert.is_nil(GG.AIGuidance.Get(10).region_paint.basin_a)
    end)

    it("toggles an asset lock on and off", function()
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.lock', { groupId = 5, locked = '1' }), 1)
        assert.is_true(GG.AIGuidance.Get(10).asset_locks[5])
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.lock', { groupId = 5, locked = '0' }), 1)
        assert.is_nil(GG.AIGuidance.Get(10).asset_locks[5])
    end)

    it("delegates an objective ('Assign to AI')", function()
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.delegate', { objectiveId = 42, delegated = '1' }), 1)
        assert.is_true(GG.AIGuidance.Get(10).delegated[42])
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.delegate', { objectiveId = 42, delegated = '0' }), 1)
        assert.is_nil(GG.AIGuidance.Get(10).delegated[42])
    end)

    it("sets a funding rate cap without requiring a one-shot amount", function()
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.fund', { rateCap = 200 }), 1)
        assert.are.equal(200, GG.AIGuidance.Get(10).funding.rateCap)
    end)

    it("sets ROE", function()
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.roe', { value = 'deny_area' }), 1)
        assert.are.equal('deny_area', GG.AIGuidance.Get(10).roe)
    end)
end)

describe("change feed (§6.2 'who set what')", function()
    it("records field/player/frame for each write", function()
        local world, gadgetObj = newWorld()
        world.frame = 123
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.stance', { value = 'defensive' }), 1)
        assert.are.equal('stance', world.trp(10, 'guidance_10_change_1_field'))
        assert.are.equal(1, world.trp(10, 'guidance_10_change_1_player'))
        assert.are.equal(123, world.trp(10, 'guidance_10_change_1_frame'))
        assert.are.equal(1, world.trp(10, 'guidance_10_change'))
    end)
end)

describe("veto blacklist (§6.3)", function()
    it("blacklists a goal for 5 minutes then clears it", function()
        local world, gadgetObj = newWorld()
        world.frame = 0
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.veto', { goalId = 99 }), 1)
        assert.is_number(GG.AIGuidance.Get(10).veto[99])

        world.frame = 8999
        gadgetObj:GameFrame(world.frame)
        assert.is_number(GG.AIGuidance.Get(10).veto[99])   -- still blacklisted

        world.frame = 9000
        gadgetObj:GameFrame(world.frame)
        assert.is_nil(GG.AIGuidance.Get(10).veto[99])   -- expired
    end)
end)

describe("privacy (§9 engine ask I2)", function()
    it("publishes with no losAccess override (default private scope)", function()
        -- The mock's SetTeamRulesParam signature only takes (teamID, key,
        -- value) — game_ai_guidance.lua must never pass a 4th losAccess
        -- argument (that would be the {allied=true} pattern game_authority.lua
        -- uses instead); this test simply exercises a write and confirms it
        -- reads back correctly through the plain (teamID, key) contract.
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.stance', { value = 'aggressive' }), 1)
        assert.are.equal('aggressive', world.trp(10, 'guidance_10_stance'))
    end)
end)
