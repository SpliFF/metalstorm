-- tests/formula_spec.lua — order-cost formula (§3.1).
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets/authority && busted tests/

package.path = './?.lua;' .. package.path

local Formula = require('formula')

describe("order-cost formula", function()
    it("multiplies all four inputs and ceils the result", function()
        -- 1.0 * 3 * 0.5 * 1.0 * 1.0 = 1.5 -> ceil 2
        assert.are.equal(2, Formula.cost(1.0, 3, 0.5, 1.0, 1.0))
    end)

    it("is exact when the product is already an integer", function()
        assert.are.equal(6, Formula.cost(1.0, 3, 1.0, 2.0, 1.0))
    end)

    it("scales with base_k", function()
        assert.are.equal(4, Formula.cost(2.0, 2, 1.0, 1.0, 1.0))
    end)

    it("short-circuits to 0 when costScale <= 0 (free-orders test path, §6)", function()
        assert.are.equal(0, Formula.cost(1.0, 100, 2.0, 3.0, 0))
        assert.are.equal(0, Formula.cost(1.0, 100, 2.0, 3.0, -1))
    end)

    it("region modifier moves cost as documented (friendly cheap, enemy dear)", function()
        local friendly = Formula.cost(1.0, 10, 0.5, 1.0, 1.0)
        local neutral  = Formula.cost(1.0, 10, 1.0, 1.0, 1.0)
        local enemy    = Formula.cost(1.0, 10, 2.0, 1.0, 1.0)
        assert.is_true(friendly < neutral)
        assert.is_true(neutral < enemy)
    end)
end)
