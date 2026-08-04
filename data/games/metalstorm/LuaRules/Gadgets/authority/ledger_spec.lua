-- busted spec for authority/ledger.lua (PLAN-metalstorm-economy.md §7)

-- Mock Spring.Log for the unmapped-reason warning
_G.Spring = {
    Log = function() end,
}
_G.LOG = { WARNING = 'warning' }

local Ledger = require('ledger')

describe("authority ledger", function()
    local state

    before_each(function()
        state = Ledger.newState()
    end)

    it("classifies known reasons correctly", function()
        assert.are.equal('mint', Ledger.classify('objective_reward'))
        assert.are.equal('mint', Ledger.classify('stake_refund'))
        assert.are.equal('mint', Ledger.classify('join_grant'))
        assert.are.equal('mint', Ledger.classify('stipend'))
        assert.are.equal('mint', Ledger.classify('admin_grant'))

        assert.are.equal('burn', Ledger.classify('order'))
        assert.are.equal('burn', Ledger.classify('directive'))
        assert.are.equal('burn', Ledger.classify('build'))
        assert.are.equal('burn', Ledger.classify('posture'))
        assert.are.equal('burn', Ledger.classify('proposal_fee'))

        assert.are.equal('move', Ledger.classify('stake_escrow'))
        assert.are.equal('move', Ledger.classify('leaver_merge'))
        assert.are.equal('move', Ledger.classify('player_fallback'))
    end)

    it("classifies unknown reasons as unmapped", function()
        local cls, unmapped = Ledger.classify('unknown_reason')
        assert.are.equal('unmapped', cls)
        assert.is_true(unmapped)
    end)

    -- endtoend D13. distributeAward sends `'objective_' .. o.type`, never the
    -- documented 'objective_reward', so EVERY objective payout in every match
    -- landed in unmapped — including the terminal objective's 300, which is
    -- why it looked like it had paid out to nobody.
    it("classifies every objective payout reason as mint, by prefix", function()
        for _, t in ipairs({ 'control', 'kill', 'escort', 'protect', 'extract', 'infra' }) do
            local cls, unmapped = Ledger.classify('objective_' .. t)
            assert.are.equal('mint', cls)
            assert.is_false(unmapped)
            -- awardPeriodic's variant (infra income)
            assert.are.equal('mint', Ledger.classify('objective_' .. t .. '_income'))
        end
    end)

    it("classifies a standing-order charge as burn", function()
        local cls, unmapped = Ledger.classify('standing')
        assert.are.equal('burn', cls)
        assert.is_false(unmapped)
    end)

    it("still reports a genuinely unknown reason even near a prefix", function()
        assert.are.equal('unmapped', Ledger.classify('objectiv_control'))
        assert.are.equal('unmapped', Ledger.classify('some_objective_control'))
    end)

    it("accumulates awards by team and class", function()
        Ledger.tagAward(state, 1, 100, 'objective_reward')
        Ledger.tagAward(state, 1, 50, 'join_grant')
        Ledger.tagAward(state, 2, 200, 'objective_reward')

        local t1 = Ledger.counters(state, 1)
        assert.are.equal(150, t1.mint)  -- 100 + 50
        assert.are.equal(0, t1.burn)
        assert.are.equal(0, t1.move)

        local t2 = Ledger.counters(state, 2)
        assert.are.equal(200, t2.mint)
    end)

    it("accumulates charges by team and class", function()
        Ledger.tagCharge(state, 1, 30, 'build')
        Ledger.tagCharge(state, 1, 10, 'posture')
        Ledger.tagCharge(state, 1, 5, 'player_fallback')

        local t1 = Ledger.counters(state, 1)
        assert.are.equal(0, t1.mint)
        assert.are.equal(40, t1.burn)   -- 30 + 10
        assert.are.equal(5, t1.move)    -- player_fallback
    end)

    it("floors fractional amounts", function()
        Ledger.tagAward(state, 1, 10.7, 'objective_reward')
        Ledger.tagAward(state, 1, 5.2, 'objective_reward')

        local t1 = Ledger.counters(state, 1)
        assert.are.equal(15, t1.mint)  -- floor(10.7) + floor(5.2) = 10 + 5
    end)

    it("exports all teams' counters", function()
        Ledger.tagAward(state, 1, 100, 'objective_reward')
        Ledger.tagCharge(state, 1, 30, 'build')
        Ledger.tagAward(state, 2, 200, 'join_grant')
        Ledger.tagCharge(state, 2, 50, 'posture')

        local exported = Ledger.exportAll(state)
        assert.are.equal(100, exported[1].mint)
        assert.are.equal(30, exported[1].burn)
        assert.are.equal(200, exported[2].mint)
        assert.are.equal(50, exported[2].burn)
    end)

    it("returns zero counters for teams with no activity", function()
        local t = Ledger.counters(state, 99)
        assert.are.equal(0, t.mint)
        assert.are.equal(0, t.burn)
        assert.are.equal(0, t.move)
        assert.are.equal(0, t.unmapped)
    end)
end)
