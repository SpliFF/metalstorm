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

        assert.are.equal('burn', Ledger.classify('micro'))
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

    -- endtoend D43 census: the two reasons the game emits that the taxonomy did
    -- not name. Both were found by enumerating the Award/Charge call sites
    -- rather than by reading a log, which is why they outlived D13 and D43 —
    -- neither had ever been seen in a warn, because the warn fires once per
    -- distinct reason per process and 'micro' fires on frame one.
    it("classifies the order class Classify.orderClass actually emits", function()
        local Classify = require('classify')   -- sibling, same cwd rule as 'ledger'
        -- Not a hardcoded 'micro': whatever the default branch returns must map.
        for _, cmdID in ipairs({ 0, 10, 20, -5 }) do
            local reason = Classify.orderClass(cmdID)
            local cls, unmapped = Ledger.classify(reason)
            assert.is_false(unmapped)
            assert.are.equal('burn', cls)
        end
    end)

    it("classifies a parley tribute payout as move", function()
        local cls, unmapped = Ledger.classify('tribute')
        assert.are.equal('move', cls)
        assert.is_false(unmapped)
    end)

    -- endtoend D62. The documented 'order' spelling is gone: a census of every
    -- Award/Charge call site found nothing emitting it, and leaving a dead
    -- reason in the table looking authoritative is what let the live spelling
    -- ('micro') go unmapped through D13 and D43 unnoticed.
    it("no longer maps the retired 'order' spelling", function()
        local cls, unmapped = Ledger.classify('order')
        assert.are.equal('unmapped', cls)
        assert.is_true(unmapped)
    end)

    -- endtoend D62, the accounting half. A tribute is pool-to-pool: the payer
    -- team books a move OUT and the payee team a move IN. Counters are per
    -- team, so that is one movement recorded once on each side — and crucially
    -- the payer's half must not land in `burn`, which is what happened while
    -- ChargeOrder had no `reason` parameter and reused the order class.
    it("books both halves of a tribute as move, on their own teams", function()
        Ledger.tagCharge(state, 1, 100, 'tribute')   -- payer team
        Ledger.tagAward(state, 2, 100, 'tribute')    -- payee team

        local payer = Ledger.counters(state, 1)
        assert.are.equal(0, payer.burn)
        assert.are.equal(100, payer.move)
        assert.are.equal(0, payer.mint)

        local payee = Ledger.counters(state, 2)
        assert.are.equal(100, payee.move)
        assert.are.equal(0, payee.mint)
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
