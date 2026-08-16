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
    -- ── War-end disposition (PLAN-metalstorm-wars.md §7, task 4) ──────────
    --
    -- The rule §7 states and §7.2 recorded as unimplemented: at war end a
    -- staked bounty on an UNMET objective returns to the staker's TEAM pool,
    -- "never to individuals, never to the enemy". The ordinary 'expired' rule
    -- is not a rounding of it — it routes to the player when they are still
    -- connected, which makes the disposition depend on who had a browser tab
    -- open at the final frame.

    it("war_end refunds an ACTIVE staker to their team pool, not to them", function()
        local state = Escrow.newState()
        Escrow.add(state, 1, 10, 100, 25)
        local refunds = Escrow.settle(state, 1, Escrow.WAR_END, function() return true end)
        assert.are.equal(1, #refunds)
        assert.are.equal(100, refunds[1].team)
        assert.is_nil(refunds[1].player)
        assert.are.equal(25, refunds[1].amount)
    end)

    it("war_end ignores isPlayerActive entirely", function()
        local state = Escrow.newState()
        Escrow.add(state, 1, 10, 100, 25)
        local asked = false
        Escrow.settle(state, 1, Escrow.WAR_END, function()
            asked = true
            return true
        end)
        assert.is_false(asked)
    end)

    it("war_end sends every staker of a mixed set team-ward", function()
        local state = Escrow.newState()
        Escrow.add(state, 1, 10, 100, 25)   -- active, team 100
        Escrow.add(state, 1, 11, 200, 15)   -- gone,   team 200
        local refunds = Escrow.settle(state, 1, Escrow.WAR_END, function(pid) return pid == 10 end)
        assert.are.equal(2, #refunds)
        for _, r in ipairs(refunds) do
            assert.is_nil(r.player)
            assert.is_truthy(r.team)
        end
    end)

    it("war_end still pays nothing on 'complete' (the reward already folded it in)", function()
        local state = Escrow.newState()
        Escrow.add(state, 1, 10, 100, 25)
        assert.are.same({}, Escrow.settle(state, 1, 'complete', function() return true end))
    end)

    it("refundsTeamward is true only for war_end", function()
        assert.is_true(Escrow.refundsTeamward(Escrow.WAR_END))
        assert.is_false(Escrow.refundsTeamward('expired'))
        assert.is_false(Escrow.refundsTeamward('failed'))
        assert.is_false(Escrow.refundsTeamward('complete'))
    end)

    -- Synced code adds each refund into a pool one at a time, and
    -- floating-point addition is not associative — a `pairs`-ordered refund
    -- list makes the resulting pool depend on hash layout. The visible half is
    -- the refund event order the client renders.
    it("returns refunds in ascending playerID order, whatever pairs does", function()
        local state = Escrow.newState()
        for _, pid in ipairs({ 41, 7, 19, 3, 28 }) do
            Escrow.add(state, 1, pid, 100 + pid, pid)
        end
        local refunds = Escrow.settle(state, 1, 'expired', function() return true end)
        local got = {}
        for i, r in ipairs(refunds) do got[i] = r.player end
        assert.are.same({ 3, 7, 19, 28, 41 }, got)
    end)

    it("orders war_end refunds the same way (team rows carry no player id)", function()
        local state = Escrow.newState()
        for _, pid in ipairs({ 41, 7, 19 }) do
            Escrow.add(state, 1, pid, 500 + pid, pid)
        end
        local refunds = Escrow.settle(state, 1, Escrow.WAR_END, nil)
        local got = {}
        for i, r in ipairs(refunds) do got[i] = r.team end
        assert.are.same({ 507, 519, 541 }, got)
    end)
end)
