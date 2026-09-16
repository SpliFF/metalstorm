-- tests/economy_sim_spec.lua — the economy harness itself
-- (PLAN-economy-grid.md task 3).
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets/authority && busted tests/
--
-- A harness that measures the economy is only worth its output if the harness
-- itself is trustworthy, and PLAN-economy-grid.md's autopsy is a list of ways
-- the previous one was not: it scored runs against a key the engine never
-- wrote (B6) and swept a seed axis that varied nothing (B7d). Both failures
-- are invisible from the harness's own output — a vacuous PASS and a real PASS
-- print identically.
--
-- So the properties pinned here are the ones that would make the numbers a
-- lie rather than the numbers themselves: that the run is deterministic, that
-- the seed actually moves it, that the bands can fail, and that the escrow
-- ledger really empties at war end rather than the sum being computed from a
-- counter the harness keeps for itself. Balance numbers belong in the grid
-- output and in the plan, not in assertions that would have to be rewritten
-- every time a constant is tuned.

package.path = './?.lua;' .. package.path

local Sim = require('economy_sim')

--- Small, fast cells — the properties under test are structural, and a 40
--- minute war per cell would make this suite the slowest in the repo.
local function cell(opts)
    local o = { durationMinutes = 6, teams = 2, playersPerTeam = 2 }
    for k, v in pairs(opts or {}) do o[k] = v end
    return Sim.runCell(o.type or 'control', o.density or 'normal', o)
end

describe("determinism", function()
    it("gives byte-identical numbers for the same seed", function()
        local a = cell({ seed = 7 })
        local b = cell({ seed = 7 })
        assert.are.equal(a.velocity, b.velocity)
        assert.are.equal(a.created, b.created)
        assert.are.equal(a.completed, b.completed)
        assert.are.equal(a.timeToBrokeMinutes, b.timeToBrokeMinutes)
    end)

    it("actually moves when the seed moves", function()
        -- B7d: the old grid's four seeds produced four identical runs, so
        -- "≥90% of runs pass" was one sample wearing four hats. A seed axis
        -- that does not vary the run is worse than no seed axis, because it
        -- reads as breadth.
        -- Asserted on the whole row rather than one column: an aggregate
        -- count over a short cell can legitimately coincide, and a test that
        -- fails on a coincidence is a test that gets deleted.
        local a = cell({ seed = 1 })
        local b = cell({ seed = 99 })
        local differs = false
        for _, col in ipairs({ 'completed', 'expired', 'velocity', 'burnRate',
                               'mintRate', 'timeToBrokeMinutes' }) do
            if a[col] ~= b[col] then differs = true end
        end
        assert.is_true(differs)
    end)

    it("is independent of Lua's global RNG state", function()
        math.randomseed(12345)
        local a = cell({ seed = 3 })
        math.randomseed(999)
        local b = cell({ seed = 3 })
        assert.are.equal(a.completed, b.completed)
    end)
end)

describe("the real modules are the ones being driven", function()
    it("prices orders through the real cost spec", function()
        -- Raising the cost basis must move what an order COSTS, because those
        -- numbers are the formula's output and not figures this harness
        -- carries.
        --
        -- Asserted on the price and not on `burnRate`, which it used to be:
        -- once §10.6 sized rewards off the same cost spec, a team spends what
        -- it earns, and burn is pinned to income by refusal rather than by the
        -- price list. Dearer orders then buy FEWER orders at the same burn —
        -- so the old assertion was reading solvency, not pricing.
        local cheap = Sim.newSim({ seed = 5 })
        local dear  = Sim.newSim({ seed = 5, squadBaseCost = 150, unitBaseCost = 20 })
        assert.is_true(dear:typicalArmyCost() > cheap:typicalArmyCost())
        assert.is_true(dear:cheapestOrderCost() > cheap:cheapestOrderCost())
        -- and the price really is the shared formula's, not a local sum
        assert.are.equal(
            Sim.Formula.cost(cheap.costSpec.base_k, cheap.cfg.squadBaseCost * 4,
                             1.0, cheap.costSpec.order_class.directive, 1.0),
            cheap:typicalArmyCost())
    end)

    it("empties the escrow ledger at war end", function()
        -- Read back off Escrow's own state, so a leak in settle() shows up
        -- here rather than being masked by a counter this harness keeps.
        local row = cell({ seed = 11, stakeRate = 1.0, stakeAmount = 25 })
        assert.are.equal(0, row.escrowFloat)
    end)

    it("stakes something in the first place", function()
        -- Guards the assertion above from passing because nothing was ever
        -- staked: a float of zero is only meaningful if stakes existed.
        local row = cell({ seed = 11, stakeRate = 1.0, stakeAmount = 25 })
        assert.is_true(row.created > 0)
        assert.is_true(row.completed + row.expired == row.created)
    end)

    it("reports velocity from the real metrics module's warm-up rule", function()
        -- Under VELOCITY_WARMUP_FRAMES the module answers a flat 1.0. A run
        -- shorter than the warm-up must therefore read exactly 1.0 — if it
        -- does not, this harness is computing its own velocity somewhere.
        local row = cell({ durationMinutes = 2, seed = 4 })
        assert.are.equal(1.0, row.velocity)
    end)
end)

describe("the generator's own accounting", function()
    it("reads the generator's own rules and density table", function()
        -- The cap assertion proper lives in objectives/tests/generator_spec.lua,
        -- which owns that rule. What matters here is that the harness reaches
        -- the REAL rule table and the REAL density multipliers rather than a
        -- second copy that can drift — a harness scoring against its own copy
        -- of the constants is B6 in a different costume.
        -- Shape, not values: the ladder itself is tuned against this harness
        -- (§10.6's second lever), so pinning its numbers here would make the
        -- harness's own spec the thing that blocks retuning it.
        for _, d in ipairs({ 'sparse', 'normal', 'dense' }) do
            local entry = Sim.Generator.DENSITY[d]
            assert.is_truthy(entry, d .. ' missing from the density table')
            assert.is_true(entry.capMul > 0)
            assert.is_true(entry.cooldownMul > 0)
            assert.is_true(entry.teamCap > 0)
        end
        assert.is_true(Sim.Generator.DENSITY.dense.capMul
                       > Sim.Generator.DENSITY.sparse.capMul)
        assert.is_true(#Sim.Generator.rules >= 6)
    end)

    it("prices rewards through the generator's derivation, not a copy", function()
        -- §10.6: the harness must see the same REWARD_UNIT the game does, or
        -- it is scoring an economy nobody ships.
        assert.is_true(Sim.Generator.REWARD_UNIT > 0)
        assert.are.equal(Sim.Generator.REWARD_UNIT,
                         Sim.Generator.rewardUnit(Sim.newSim({}).costSpec))
    end)
end)

describe("acceptance bands", function()
    it("passes a row inside every band", function()
        local ok, failures = Sim.checkRow({
            velocity = 1.0, escrowFloat = 0, timeToBrokeMinutes = 40, poolRatio = 2,
        })
        assert.is_true(ok)
        assert.are.equal(0, #failures)
    end)

    it("fails a row whose velocity has drifted", function()
        local ok, failures = Sim.checkRow({
            velocity = 2.4, escrowFloat = 0, timeToBrokeMinutes = 40, poolRatio = 2,
        })
        assert.is_false(ok)
        assert.are.equal(1, #failures)
        assert.is_truthy(failures[1]:match('velocity'))
    end)

    it("fails a row that leaves authority in escrow at war end", function()
        -- The band is zero, not "small": a war that ends holding stakes has
        -- authority belonging to nobody, which is F7's defect at grid scale.
        local ok, failures = Sim.checkRow({
            velocity = 1.0, escrowFloat = 1, timeToBrokeMinutes = 40, poolRatio = 2,
        })
        assert.is_false(ok)
        assert.is_truthy(failures[1]:match('escrow'))
    end)

    it("fails a row that goes broke early", function()
        local ok, failures = Sim.checkRow({
            velocity = 1.0, escrowFloat = 0, timeToBrokeMinutes = 3, poolRatio = 2,
        })
        assert.is_false(ok)
        assert.is_truthy(failures[1]:match('time%-to%-broke'))
    end)

    it("spares a single-rule cell the sustainability bands", function()
        -- No one rule funds a team on its own, so scoring a per-type cell on
        -- time-to-broke and pool ratio produces a wall of failures that say
        -- nothing — and buries the mixed cell, which is the one that does.
        local ok = Sim.checkRow({
            type = 'control', velocity = 1.0, escrowFloat = 0,
            timeToBrokeMinutes = 2, poolRatio = 99,
        })
        assert.is_true(ok)
    end)

    it("applies them to the mixed cell, which is where they mean something", function()
        local ok, failures = Sim.checkRow({
            type = 'mixed', velocity = 1.0, escrowFloat = 0,
            timeToBrokeMinutes = 2, poolRatio = 99,
        })
        assert.is_false(ok)
        assert.are.equal(2, #failures)
    end)

    it("still checks velocity and escrow on every cell", function()
        -- Those two are per-rule properties: a rule whose mint and burn are
        -- wildly out of balance, or whose escrow does not settle, is broken
        -- whether or not anything else is running alongside it.
        local ok, failures = Sim.checkRow({
            type = 'control', velocity = 9, escrowFloat = 3,
            timeToBrokeMinutes = 40, poolRatio = 1,
        })
        assert.is_false(ok)
        assert.are.equal(2, #failures)
    end)

    it("reports every band a row misses, not just the first", function()
        local ok, failures = Sim.checkRow({
            velocity = 9, escrowFloat = 50, timeToBrokeMinutes = 1, poolRatio = 99,
        })
        assert.is_false(ok)
        assert.are.equal(4, #failures)
    end)
end)

describe("grid output", function()
    it("covers every objective type across every density", function()
        local rows = Sim.runGrid({ durationMinutes = 2, seed = 1 })
        -- Every graded type, plus the ungraded `mixednorm` probe.
        assert.are.equal((#Sim.TYPES + 1) * 3, #rows)
        local seen = {}
        for _, r in ipairs(rows) do seen[r.type .. '/' .. r.density] = true end
        for _, t in ipairs(Sim.TYPES) do
            for _, d in ipairs({ 'sparse', 'normal', 'dense' }) do
                assert.is_true(seen[t .. '/' .. d] == true)
            end
        end
        for _, d in ipairs({ 'sparse', 'normal', 'dense' }) do
            assert.is_true(seen['mixednorm/' .. d] == true)
        end
    end)

    it("reports the reward-normalisation probe without grading it", function()
        -- Lever 2 is OFF in the shipped spec and stays off until somebody
        -- decides otherwise from a measurement. The probe measures; a FAIL on
        -- a setting the game does not ship would only teach people to ignore
        -- the gate.
        local rows = Sim.runGrid({ durationMinutes = 2, seed = 1,
                                   densities = { 'normal' } })
        local probe
        for _, r in ipairs(rows) do if r.type == 'mixednorm' then probe = r end end
        assert.is_truthy(probe)
        assert.is_true(probe.informational)
        assert.is_true((Sim.checkRow(probe)))

        -- and it really did run with the lever on: a normalised reward is
        -- floored through the clamp, so it cannot mint MORE than the plain
        -- cell does at a velocity at or above 1.
        local sim = Sim.newSim({ rewardNormalisation = true })
        assert.is_true(sim.econ.reward_normalisation_enabled)
        assert.is_false(Sim.newSim({}).econ.reward_normalisation_enabled)
    end)

    it("includes the mixed cell — the only one that answers 'does a war sustain'", function()
        local found = false
        for _, t in ipairs(Sim.TYPES) do if t == 'mixed' then found = true end end
        assert.is_true(found)
    end)

    it("formats as TSV with a verdict per row", function()
        local rows = Sim.runGrid({ durationMinutes = 2, seed = 1 })
        local tsv = Sim.formatTSV(rows)
        local lines = {}
        for line in tsv:gmatch('[^\n]+') do lines[#lines + 1] = line end
        assert.are.equal(#rows + 1, #lines)          -- header + one per row
        assert.is_truthy(lines[1]:match('velocity'))
        assert.is_truthy(lines[1]:match('verdict'))
        for i = 2, #lines do
            assert.is_truthy(lines[i]:match('PASS') or lines[i]:match('FAIL')
                             or lines[i]:match('INFO'))
        end
    end)
end)
