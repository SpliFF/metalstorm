-- tests/cost_spec.lua — order-cost region modifier (alliance-aware, §4).
-- Run from the plugin root:  cd data/games/metalstorm/LuaRules/Gadgets/regions && busted tests/

package.path = './?.lua;' .. package.path

local Cost = require('cost')

describe("order-cost region modifier", function()
    it("is neutral (1.0) when the region is unowned, regardless of alliance", function()
        assert.are.equal(1.0, Cost.orderModifier(nil, false))
        assert.are.equal(1.0, Cost.orderModifier(nil, true))
    end)

    it("is friendly (0.5) when the owner is allied to the ordering team", function()
        assert.are.equal(0.5, Cost.orderModifier(5, true))
    end)

    it("is enemy (2.0) when the owner is present and not allied", function()
        assert.are.equal(2.0, Cost.orderModifier(5, false))
    end)

    it("charges friendly rates in an ALLIED owner's territory, not just the same team", function()
        -- The ratified ruling: alliance-aware, not exact-teamID. Owner team 2,
        -- ordering team 3, but Spring.AreTeamsAllied(2, 3) == true → 0.5.
        local allied = true   -- stands in for Spring.AreTeamsAllied(2, 3) on the sim
        assert.are.equal(0.5, Cost.orderModifier(2, allied))
    end)

    it("exposes the modifier constants for the gadget call site", function()
        assert.are.equal(0.5, Cost.MOD_FRIENDLY)
        assert.are.equal(1.0, Cost.MOD_NEUTRAL)
        assert.are.equal(2.0, Cost.MOD_ENEMY)
    end)
end)
