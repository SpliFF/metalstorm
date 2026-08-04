-- parley/tests/trust_spec.lua — trust ledger arithmetic (§2, §11 "trust
-- arithmetic + decay"). Run from the plugin root:
--   cd data/games/metalstorm/LuaRules/Gadgets/parley && busted tests/
package.path = './?.lua;' .. package.path

local Trust = require('trust')

describe("canonical pair ordering", function()
    it("orders (a,b) and (b,a) identically", function()
        local lo1, hi1 = Trust.orderedPair(3, 7)
        local lo2, hi2 = Trust.orderedPair(7, 3)
        assert.are.equal(lo1, lo2)
        assert.are.equal(hi1, hi2)
    end)

    it("produces the same rulesParam key regardless of argument order", function()
        assert.are.equal(Trust.rulesParamKey(1, 2), Trust.rulesParamKey(2, 1))
        assert.are.equal('trust_1_2', Trust.rulesParamKey(1, 2))
    end)
end)

describe("adjust", function()
    it("applies fulfilled (+1) and breached (-3) deltas", function()
        assert.are.equal(1, Trust.adjust(0, Trust.FULFILLED_DELTA))
        assert.are.equal(-3, Trust.adjust(0, Trust.BREACHED_DELTA))
    end)

    it("defaults a nil current value to NEUTRAL before applying the delta", function()
        assert.are.equal(1, Trust.adjust(nil, Trust.FULFILLED_DELTA))
    end)

    it("stacks across repeated adjustments (unbounded, no artificial clamp)", function()
        local v = 0
        for _ = 1, 3 do v = Trust.adjust(v, Trust.BREACHED_DELTA) end
        assert.are.equal(-9, v)
    end)
end)

describe("decay", function()
    it("is a no-op for zero/nil elapsed periods", function()
        assert.are.equal(10, Trust.decay(10, 0))
        assert.are.equal(10, Trust.decay(10, nil))
    end)

    it("pulls a positive value down toward neutral", function()
        local decayed = Trust.decay(10, 1)
        assert.is_true(decayed < 10)
        assert.is_true(decayed > 0)
    end)

    it("pulls a negative value up toward neutral", function()
        local decayed = Trust.decay(-10, 1)
        assert.is_true(decayed > -10)
        assert.is_true(decayed < 0)
    end)

    it("converges toward NEUTRAL over many periods", function()
        local decayed = Trust.decay(100, 60)
        assert.is_true(math.abs(decayed - Trust.NEUTRAL) < 5)
    end)

    it("never overshoots past NEUTRAL", function()
        local decayed = Trust.decay(10, 1000)
        assert.is_true(decayed >= 0)
    end)
end)
