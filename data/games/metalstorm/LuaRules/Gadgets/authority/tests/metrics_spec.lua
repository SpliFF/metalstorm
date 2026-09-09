-- tests/metrics_spec.lua — economy health metrics (PLAN-metalstorm-economy.md §2).
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets/authority && busted tests/
--
-- The velocity cases pin the defect the 2026-09-10 review found: the first
-- cut sampled burn/mint only on MINT frames (where burn is ~always zero) and
-- ignored burn-only frames entirely, so the number could only ever fall to 0.

package.path = './?.lua;' .. package.path

local Metrics = require('metrics')

local WARMUP = Metrics.VELOCITY_WARMUP_FRAMES

--- Drive `frames` frames of a repeating pattern: every `period` frames mint
--- `mint` on one frame and burn `burn` on the NEXT frame — never the same
--- frame, which is how real play looks (an award lands, orders follow).
local function drive(state, team, frames, period, mint, burn)
    for f = 1, frames do
        local m = (f % period == 1) and mint or 0
        local b = (f % period == 2) and burn or 0
        Metrics.updateVelocity(state, team, m, b)
    end
end

describe("velocity", function()
    it("reads the neutral 1.0 for a team the ledger has never seen", function()
        assert.are.equal(1.0, Metrics.velocity(Metrics.newState(), 7))
    end)

    it("reads 1.0 through the warm-up window even with data flowing", function()
        local state = Metrics.newState()
        drive(state, 1, WARMUP - 1, 100, 50, 10)
        assert.are.equal(1.0, Metrics.velocity(state, 1))
    end)

    it("measures burn/mint when the two land on DIFFERENT frames", function()
        local state = Metrics.newState()
        -- Balanced flows: 50 in, 50 out, per 100 frames.
        drive(state, 1, 40000, 100, 50, 50)
        local v = Metrics.velocity(state, 1)
        assert.is_true(v > 0.9 and v < 1.1, 'velocity ' .. v .. ' should be ~1.0')
    end)

    it("reads below 1 for a team minting more than it burns (inflation)", function()
        local state = Metrics.newState()
        drive(state, 1, 40000, 100, 100, 25)
        local v = Metrics.velocity(state, 1)
        assert.is_true(v > 0.2 and v < 0.3, 'velocity ' .. v .. ' should be ~0.25')
    end)

    it("reads above 1 for a team burning more than it mints (starvation)", function()
        local state = Metrics.newState()
        drive(state, 1, 40000, 100, 20, 60)
        local v = Metrics.velocity(state, 1)
        assert.is_true(v > 2.7 and v < 3.3, 'velocity ' .. v .. ' should be ~3.0')
    end)

    it("caps a burn with no income at all instead of dividing by zero", function()
        local state = Metrics.newState()
        drive(state, 1, 40000, 100, 0, 60)
        assert.are.equal(10.0, Metrics.velocity(state, 1))
    end)

    it("accepts a coarse sampler: one call per 90 frames equals 90 per-frame calls", function()
        local fine, coarse = Metrics.newState(), Metrics.newState()
        for f = 1, 27000 do
            Metrics.updateVelocity(fine, 1, (f % 90 == 1) and 45 or 0, (f % 90 == 46) and 30 or 0)
        end
        for t = 1, 300 do
            Metrics.updateVelocity(coarse, 1, 45, 30, 90)
        end
        local vf, vc = Metrics.velocity(fine, 1), Metrics.velocity(coarse, 1)
        assert.is_true(math.abs(vf - vc) < 0.02, ('fine %.3f vs coarse %.3f'):format(vf, vc))
        local mf, bf = Metrics.rates(fine, 1)
        local mc, bc = Metrics.rates(coarse, 1)
        assert.is_true(math.abs(mf - mc) / mf < 0.02)
        assert.is_true(math.abs(bf - bc) / bf < 0.02)
    end)

    it("exposes the per-minute rate EMAs for telemetry", function()
        local state = Metrics.newState()
        drive(state, 1, 60000, 100, 50, 25)
        local mint, burn = Metrics.rates(state, 1)
        -- 50 per 100 frames = 900/min; the EMA has converged most of the way
        -- after ~1.1 half-lives.
        assert.is_true(mint > 400 and mint < 900, 'mint rate ' .. mint)
        assert.is_true(burn > 200 and burn < 450, 'burn rate ' .. burn)
    end)

    it("honours a pre-split snapshot that carries only velocity_ema", function()
        local state = Metrics.newState()
        state.teams[3] = { velocity_ema = 0.7, dead_frames = 0 }
        assert.are.equal(0.7, Metrics.velocity(state, 3))
    end)
end)

describe("dead-team time and the rest", function()
    it("counts frames a team cannot afford its cheapest order", function()
        local state = Metrics.newState()
        for _ = 1, 3600 do Metrics.recordDeadFrame(state, 2, 5, 10) end
        for _ = 1, 3600 do Metrics.recordDeadFrame(state, 2, 50, 10) end
        assert.are.equal(2, Metrics.deadTimeMinutes(state, 2))
    end)

    it("pool ratio and gini behave at the edges", function()
        assert.are.equal(0, Metrics.poolRatio(500, 0))
        assert.are.equal(2, Metrics.poolRatio(2000, 1000))
        assert.are.equal(0, Metrics.gini({}))
        assert.are.equal(0, Metrics.gini({ 100, 100, 100 }))
        assert.is_true(Metrics.gini({ 0, 0, 300 }) > 0.6)
    end)
end)
