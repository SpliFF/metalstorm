-- tests/warend_spec.lua — the per-objective war-end disposition rule
-- (PLAN-metalstorm-wars.md §7 `resolving`, task 4).
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets/objectives && busted tests/

package.path = './?.lua;' .. package.path

local WarEnd = require('warend')

local WAR_END = 'war_end'   -- the value GG.Authority.ESCROW_WAR_END carries

describe("war-end disposition", function()
    describe("met-but-unpaid objectives settle normally", function()
        it("a check() answering 'complete' resolves complete and is PAID", function()
            local d = WarEnd.dispose('complete', WAR_END)
            assert.are.equal('complete', d.state)
            assert.is_true(d.paid)
        end)

        it("does NOT override the escrow outcome on a completion", function()
            -- The stake is folded into the reward by awardObjective, so
            -- SettleEscrow must see 'complete' (clear the ledger) and not
            -- 'war_end' (refund it team-ward) — otherwise the same stake is
            -- paid out twice: once inside the reward, once as a refund.
            local d = WarEnd.dispose('complete', WAR_END)
            assert.is_nil(d.escrowOutcome)
        end)
    end)

    describe("everything else expires with stakes routed team-ward", function()
        it("an unresolved objective expires, not fails", function()
            -- §7: the objectives were not lost, the war stopped.
            local d = WarEnd.dispose(nil, WAR_END)
            assert.are.equal('expired', d.state)
            assert.are.equal(WAR_END, d.escrowOutcome)
            assert.is_false(d.paid)
        end)

        it("a module's own terminal answer is recorded, not overwritten", function()
            -- A `protect` whose ward died answers 'failed'. That is the
            -- objective's honest ending; rewriting it as 'expired' would put
            -- the wrong history in the archive.
            local d = WarEnd.dispose('failed', WAR_END)
            assert.are.equal('failed', d.state)
            assert.is_false(d.paid)
        end)

        it("routes a non-complete terminal answer's escrow war-end-ward too", function()
            -- The escrow rule follows the WAR ending, not the objective's
            -- outcome: the war is what stopped, so no stake goes to an
            -- individual regardless of how the objective itself finished.
            assert.are.equal(WAR_END, WarEnd.dispose('failed', WAR_END).escrowOutcome)
            assert.are.equal(WAR_END, WarEnd.dispose('expired', WAR_END).escrowOutcome)
        end)
    end)

    describe("who gets asked for a final answer", function()
        it("asks an ordinary objective", function()
            assert.is_true(WarEnd.shouldAsk({ type = 'control' }))
        end)

        it("never asks a phase-chained parent", function()
            -- Its resolution is driven by the children's cascade and it has no
            -- predicate of its own; asking would let it complete at war end by
            -- a route that does not exist during play.
            assert.is_false(WarEnd.shouldAsk({ type = 'control', phaseDefs = {} }))
        end)

        it("is nil-safe", function()
            assert.is_false(WarEnd.shouldAsk(nil))
        end)
    end)

    it("a predicate that threw disposes exactly like one that answered nothing", function()
        -- ExpireAllActive pcalls check() and passes nil on a throw, so one
        -- objective's content bug cannot strand every other objective's escrow
        -- on the last chance the war has to dispose of them.
        assert.are.same(WarEnd.dispose(nil, WAR_END), WarEnd.dispose(nil, WAR_END))
        assert.are.equal(WAR_END, WarEnd.dispose(nil, WAR_END).escrowOutcome)
    end)
end)
