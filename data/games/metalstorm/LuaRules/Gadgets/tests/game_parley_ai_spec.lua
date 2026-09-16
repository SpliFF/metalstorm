-- tests/game_parley_ai_spec.lua — the AI-facing half of game_parley.lua's
-- wire (PLAN-metalstorm-interaction.md §6.2 / §7 "Humans and AIs use the
-- SAME synced entry points"; PLAN-ai-synced-write §2.3 option A).
--
-- An AI virtual player's `AI.sendMessage(msg)` drains into
-- `gadget:RecvLuaMsg(msg, aiPlayerID)` — this file drives that exact entry
-- with the exact strings ai/strategos/actuators.lua encodes, against the real
-- gadget, and asserts the proposal/response materialises with the AI's own
-- playerID as attribution (fee from ITS pool, escrow in ITS name).
--
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets && busted tests/

package.path = './?.lua;' .. package.path

local mock = require('tests.parley_mock')
local Wire = require('parley.wire')

local function newWorld()
    local world, gadgetObj = mock.new('./game_parley.lua')
    world.setPlayer(1, 10)        -- human on team 10
    world.setAIPlayer(8, 20)      -- AI virtual player on team 20
    world.setTeamPool(10, 1000)
    world.setTeamPool(20, 1000)
    world.setPlayerPool(1, 500)
    world.setPlayerPool(8, 500)
    return world, gadgetObj
end

describe("wire demand with an inner kind (one flat field set)", function()
    it("validates the wrapped kind's terms off the same fields and publishes them", function()
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('parley.propose', {
            toTeam = 20, kind = 'demand', innerKind = 'tribute',
            amount = 200, payer = 'to', orElse = 'raid',
        }), 1)
        local p = GG.Parley.Get(1)
        assert.is_table(p)
        assert.are.equal('demand', p.kind)
        assert.are.equal('tribute', p.terms.innerKind)
        assert.are.equal(200, p.terms.innerTerms.amount)
        assert.are.equal('to', p.terms.innerTerms.payer)
        assert.is_nil(p.terms.innerTerms.innerKind)      -- not nested again
        -- Published flat, so an AI's Picture reads the inner amount as `amount`.
        assert.are.equal(200, world.rp('parley_1_amount'))
        assert.are.equal('tribute', world.rp('parley_1_innerKind'))
    end)

    it("still refuses a wrapped kind whose required term is missing", function()
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('parley.propose', {
            toTeam = 20, kind = 'demand', innerKind = 'tribute', orElse = 'raid',
        }), 1)
        assert.is_nil(GG.Parley.Get(1))
    end)

    it("accepting the demand applies the wrapped tribute (payer = the accepting side)", function()
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('parley.propose', {
            toTeam = 20, kind = 'demand', innerKind = 'tribute', amount = 200, payer = 'to',
        }), 1)
        -- The AI on team 20 accepts through the same funnel.
        gadgetObj:RecvLuaMsg(Wire.encode('parley.respond', { id = 1, decision = 'accept' }), 8)
        assert.are.equal('fulfilled', GG.Parley.Get(1).state)
        assert.are.equal(800, world.authorityPools[20])   -- team 20 paid 200
        assert.are.equal(1200, world.authorityPools[10])  -- team 10 received it
    end)
end)

describe("an AI virtual player on the human funnel", function()
    it("its parley.respond is attributed to its team (accept lands)", function()
        local world, gadgetObj = newWorld()
        assert.is_number(GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 1800 }))
        gadgetObj:RecvLuaMsg(Wire.encode('parley.respond', { id = 1, decision = 'accept' }), 8)
        assert.are.equal('active', GG.Parley.Get(1).state)
    end)

    it("cannot answer a proposal addressed to another team", function()
        local world, gadgetObj = newWorld()
        world.setPlayer(2, 30)
        GG.Parley.Propose(10, 1, 30, 'ceasefire', { duration = 1800 })
        gadgetObj:RecvLuaMsg(Wire.encode('parley.respond', { id = 1, decision = 'accept' }), 8)
        assert.are.equal('offered', GG.Parley.Get(1).state)
    end)

    it("its parley.propose pays the spam-guard fee from ITS OWN pool", function()
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('parley.propose', {
            toTeam = 10, kind = 'ceasefire', duration = 1800, regionKey = 'north_ridge',
        }), 8)
        local p = GG.Parley.Get(1)
        assert.is_table(p)
        assert.are.equal(20, p.fromTeam)
        assert.are.equal(8, p.fromPlayer)
        assert.are.equal('north_ridge', p.terms.regionKey)
        assert.are.equal(485, world.playerPools[8])       -- 500 - PROPOSE_FEE(15)
        assert.are.equal(1000, world.authorityPools[20])  -- team pool untouched
    end)

    it("a 'pay' tribute it offers is escrowed in its own name", function()
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('parley.propose', {
            toTeam = 10, kind = 'tribute', amount = 100, payer = 'from',
        }), 8)
        local p = GG.Parley.Get(1)
        assert.are.equal(100, p.escrow)
        assert.are.equal(1, #world.stakes[1].entries)
        assert.are.equal(8, world.stakes[1].entries[1].playerID)
    end)

    it("accepts the plan's 'counterTerms' spelling as a counter", function()
        local world, gadgetObj = newWorld()
        GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 1800 })
        gadgetObj:RecvLuaMsg(Wire.encode('parley.respond', { id = 1, decision = 'counterTerms' }), 8)
        assert.are.equal('countered', GG.Parley.Get(1).state)
        local counter = GG.Parley.Get(2)
        assert.is_table(counter)
        assert.are.equal(1, counter.counterOf)
        assert.are.equal(20, counter.fromTeam)
        assert.are.equal(10, counter.toTeam)
    end)

    it("a counter may restate the TERMS, not only the kind", function()
        -- The AI's evaluator counters a tribute it cannot afford with one it
        -- can (ai/strategos/planner.lua). GG.Parley.Respond defaults
        -- `extra.terms` to the ORIGINAL proposal's, so if the wire dropped the
        -- terms the counter would repeat the very amount it was objecting to.
        local world, gadgetObj = newWorld()
        GG.Parley.Propose(10, 1, 20, 'tribute', { amount = 500, payer = 'to', duration = 1800 })
        gadgetObj:RecvLuaMsg(Wire.encode('parley.respond', {
            id = 1, decision = 'counter', kind = 'tribute',
            amount = 50, payer = 'to', duration = 1800,
        }), 8)
        assert.are.equal('countered', GG.Parley.Get(1).state)
        local counter = GG.Parley.Get(2)
        assert.is_table(counter)
        assert.are.equal(50, counter.terms.amount, 'the counter states its own number')
        assert.are.equal('to', counter.terms.payer)
        assert.are.equal(20, counter.fromTeam)
    end)

    it("a counter with no terms still falls back to the original's", function()
        local world, gadgetObj = newWorld()
        GG.Parley.Propose(10, 1, 20, 'tribute', { amount = 500, payer = 'to', duration = 1800 })
        gadgetObj:RecvLuaMsg(Wire.encode('parley.respond', { id = 1, decision = 'counter' }), 8)
        assert.are.equal(500, GG.Parley.Get(2).terms.amount)
    end)

end)
