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

--=============================================================================
-- AI funding (§6.2 funding row; decided in PLAN-metalstorm-ai.md §5.2).
-- Regression gate for endtoend D32: a co-commanded Strategos spent its opening
-- allocation and the panel's FUNDING control could not revive it, because the
-- one-shot awarded the TEAM pool that an own_pool_only AI may never spend.
--=============================================================================
describe("AI funding — the one-shot gift (§5.2, D32)", function()
    -- Team 10: one human funder (1) and one AI co-commander (8).
    local function fundedWorld()
        local world, gadgetObj = newWorld()
        world.setAIPlayer(8, 10)
        world.setPlayerPool(1, 100)
        world.setTeamPool(10, 600)
        return world, gadgetObj
    end

    it("credits the AI's OWN pool, not the team pool", function()
        local world, gadgetObj = fundedWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.fund', { amount = 40 }), 1)
        -- This is the exact live measurement D32 recorded, with the one number
        -- that was wrong put right: the human still pays 100 → 60, but the 40
        -- lands on the AI instead of on authority_pool (which stays at 600).
        assert.are.equal(60,  world.playerPools[1])
        assert.are.equal(40,  world.playerPools[8])
        assert.are.equal(600, world.authorityPools[10])
    end)

    it("is tagged ai_funding so the ledger classes it as a move, not a mint", function()
        local world, gadgetObj = fundedWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.fund', { amount = 40 }), 1)
        assert.are.equal(1, #world.transferLog)
        assert.are.equal('ai_funding', world.transferLog[1].reason)
        -- Never Award: Award mints, and funding must be net-zero.
        assert.are.equal(0, #world.awardLog)
    end)

    it("takes the funder's OWN pool only — no team fallback", function()
        local world, gadgetObj = fundedWorld()
        world.setPlayerPool(1, 30)               -- team pool has 600 to spare
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.fund', { amount = 40 }), 1)
        -- Routing this through ChargeOrder would have let the human draw 10
        -- from the team pool and hand it to an own_pool_only AI — rejected
        -- option (c) via the back door. Nothing moves.
        assert.are.equal(30,  world.playerPools[1])
        assert.are.equal(0,   world.playerPools[8] or 0)
        assert.are.equal(600, world.authorityPools[10])
    end)

    it("refuses when the team has no AI instead of donating to the team pool", function()
        local world, gadgetObj = newWorld()       -- no AI on team 10
        world.setPlayerPool(1, 100)
        world.setTeamPool(10, 600)
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.fund', { amount = 40 }), 1)
        assert.are.equal(100, world.playerPools[1])   -- charged nothing
        assert.are.equal(600, world.authorityPools[10])
    end)

    it("splits evenly across several AIs on the team", function()
        local world, gadgetObj = fundedWorld()
        world.setAIPlayer(9, 10)                  -- a second co-commander
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.fund', { amount = 40 }), 1)
        assert.are.equal(60, world.playerPools[1])
        assert.are.equal(20, world.playerPools[8])
        assert.are.equal(20, world.playerPools[9])
    end)

    it("a split the funder can't cover in full pays NOTHING (no half-success)", function()
        local world, gadgetObj = fundedWorld()
        world.setAIPlayer(9, 10)
        world.setPlayerPool(1, 30)                -- covers AI #1's share, not both
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.fund', { amount = 40 }), 1)
        assert.are.equal(30, world.playerPools[1])
        assert.are.equal(0,  world.playerPools[8] or 0)
        assert.are.equal(0,  world.playerPools[9] or 0)
    end)

    it("says so in the log when it refuses (never a silent no-op)", function()
        local world, gadgetObj = fundedWorld()
        world.setPlayerPool(1, 5)
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.fund', { amount = 40 }), 1)
        assert.are.equal(1, #world.echoes)
        assert.is_truthy(world.echoes[1]:find('insufficient_authority', 1, true))
    end)

    it("ignores AI slots on other teams", function()
        local world, gadgetObj = fundedWorld()
        world.setAIPlayer(9, 20)                  -- someone else's AI
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.fund', { amount = 40 }), 1)
        assert.are.equal(40, world.playerPools[8])
        assert.are.equal(0,  world.playerPools[9] or 0)
    end)
end)

describe("AI funding — the standing allowance drip (§5.2 option d)", function()
    local function cappedWorld(cap)
        local world, gadgetObj = newWorld()
        world.setAIPlayer(8, 10)
        world.setTeamPool(10, 600)
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.fund', { rateCap = cap }), 1)
        return world, gadgetObj
    end

    it("moves rateCap from the team pool to the AI once a game-minute", function()
        local world, gadgetObj = cappedWorld(50)
        gadgetObj:GameFrame(1800)
        assert.are.equal(50,  world.playerPools[8])
        assert.are.equal(550, world.authorityPools[10])
        gadgetObj:GameFrame(3600)
        assert.are.equal(100, world.playerPools[8])
        assert.are.equal(500, world.authorityPools[10])
    end)

    it("does nothing on frames that aren't the period boundary", function()
        local world, gadgetObj = cappedWorld(50)
        gadgetObj:GameFrame(1799)
        gadgetObj:GameFrame(1801)
        assert.are.equal(0,   world.playerPools[8] or 0)
        assert.are.equal(600, world.authorityPools[10])
    end)

    it("is opt-in: no cap set drips nothing", function()
        local world, gadgetObj = newWorld()
        world.setAIPlayer(8, 10)
        world.setTeamPool(10, 600)
        gadgetObj:GameFrame(1800)
        assert.are.equal(0,   world.playerPools[8] or 0)
        assert.are.equal(600, world.authorityPools[10])
    end)

    it("pays what the team pool has when it can't cover the full cap", function()
        local world, gadgetObj = cappedWorld(50)
        world.setTeamPool(10, 20)
        gadgetObj:GameFrame(1800)
        -- Partial, deliberately: an allowance that silently stopped when the
        -- team got poor would starve the AI exactly when it matters most.
        assert.are.equal(20, world.playerPools[8])
        assert.are.equal(0,  world.authorityPools[10])
    end)

    it("splits the allowance across several AIs and tags it ai_allowance", function()
        local world, gadgetObj = cappedWorld(50)
        world.setAIPlayer(9, 10)
        gadgetObj:GameFrame(1800)
        assert.are.equal(25, world.playerPools[8])
        assert.are.equal(25, world.playerPools[9])
        assert.are.equal('ai_allowance', world.transferLog[#world.transferLog].reason)
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
