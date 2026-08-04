-- tests/escrow_spec.lua — staked-bounty escrow ledger (§2, §6).
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets/authority && busted tests/

package.path = './?.lua;' .. package.path

local Escrow = require('escrow')

describe("escrow ledger", function()
    it("accumulates stakes from multiple players onto one objective", function()
        local state = Escrow.newState()
        Escrow.add(state, 1, 10, 100, 25)
        Escrow.add(state, 1, 11, 100, 15)
        assert.are.equal(40, Escrow.total(state, 1))
    end)

    it("accumulates repeat stakes from the same player", function()
        local state = Escrow.newState()
        Escrow.add(state, 1, 10, 100, 25)
        Escrow.add(state, 1, 10, 100, 5)
        assert.are.equal(30, Escrow.total(state, 1))
    end)

    it("keeps separate objectives independent", function()
        local state = Escrow.newState()
        Escrow.add(state, 1, 10, 100, 25)
        Escrow.add(state, 2, 10, 100, 5)
        assert.are.equal(25, Escrow.total(state, 1))
        assert.are.equal(5, Escrow.total(state, 2))
    end)

    it("total is 0 for an objective with no stakes", function()
        local state = Escrow.newState()
        assert.are.equal(0, Escrow.total(state, 99))
    end)

    it("'complete' settle clears the ledger with no refunds (already folded into the payout)", function()
        local state = Escrow.newState()
        Escrow.add(state, 1, 10, 100, 25)
        local refunds = Escrow.settle(state, 1, 'complete', function() return true end)
        assert.are.same({}, refunds)
        assert.are.equal(0, Escrow.total(state, 1))
    end)

    it("'expired' settle refunds an active staker to their player pool", function()
        local state = Escrow.newState()
        Escrow.add(state, 1, 10, 100, 25)
        local refunds = Escrow.settle(state, 1, 'expired', function() return true end)
        assert.are.equal(1, #refunds)
        assert.are.equal(10, refunds[1].player)
        assert.are.equal(25, refunds[1].amount)
        assert.is_nil(refunds[1].team)
    end)

    it("'failed' settle refunds a departed staker to their recorded team pool", function()
        local state = Escrow.newState()
        Escrow.add(state, 1, 10, 100, 25)
        local refunds = Escrow.settle(state, 1, 'failed', function() return false end)
        assert.are.equal(1, #refunds)
        assert.are.equal(100, refunds[1].team)
        assert.are.equal(25, refunds[1].amount)
        assert.is_nil(refunds[1].player)
    end)

    it("settling clears the ledger (a second settle is a no-op)", function()
        local state = Escrow.newState()
        Escrow.add(state, 1, 10, 100, 25)
        Escrow.settle(state, 1, 'expired', function() return true end)
        local again = Escrow.settle(state, 1, 'expired', function() return true end)
        assert.are.same({}, again)
    end)

    it("routes multiple stakers independently by activity", function()
        local state = Escrow.newState()
        Escrow.add(state, 1, 10, 100, 25)   -- stays active
        Escrow.add(state, 1, 11, 200, 15)   -- has left
        local refunds = Escrow.settle(state, 1, 'expired', function(pid) return pid == 10 end)
        table.sort(refunds, function(a, b) return a.amount > b.amount end)
        assert.are.equal(2, #refunds)
        assert.are.equal(10, refunds[1].player)
        assert.are.equal(25, refunds[1].amount)
        assert.are.equal(200, refunds[2].team)
        assert.are.equal(15, refunds[2].amount)
    end)
end)
