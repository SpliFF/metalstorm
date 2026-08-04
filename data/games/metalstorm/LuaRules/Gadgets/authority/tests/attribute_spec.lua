-- tests/attribute_spec.lua — player-pool-first, team-fallback charge
-- attribution (§3.2).
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets/authority && busted tests/

package.path = './?.lua;' .. package.path

local Attribute = require('attribute')

describe("charge attribution", function()
    it("charges entirely from the player pool when it covers the cost", function()
        local allowed, fromPlayer, fromTeam = Attribute.attribute(100, 500, 40)
        assert.is_true(allowed)
        assert.are.equal(40, fromPlayer)
        assert.are.equal(0, fromTeam)
    end)

    it("drains the player pool then falls back to the team pool for the remainder", function()
        local allowed, fromPlayer, fromTeam = Attribute.attribute(10, 500, 40)
        assert.is_true(allowed)
        assert.are.equal(10, fromPlayer)
        assert.are.equal(30, fromTeam)
    end)

    it("refuses when neither pool combination covers the cost", function()
        local allowed, fromPlayer, fromTeam = Attribute.attribute(10, 20, 40)
        assert.is_false(allowed)
        assert.are.equal(0, fromPlayer)
        assert.are.equal(0, fromTeam)
    end)

    it("charges nothing (but allows) a zero or negative cost", function()
        local allowed, fromPlayer, fromTeam = Attribute.attribute(0, 0, 0)
        assert.is_true(allowed)
        assert.are.equal(0, fromPlayer)
        assert.are.equal(0, fromTeam)
    end)

    it("allows a fully broke player when the team pool alone covers it", function()
        local allowed, fromPlayer, fromTeam = Attribute.attribute(0, 500, 40)
        assert.is_true(allowed)
        assert.are.equal(0, fromPlayer)
        assert.are.equal(40, fromTeam)
    end)

    it("is exact at the boundary (cost == combined pools)", function()
        local allowed, fromPlayer, fromTeam = Attribute.attribute(10, 30, 40)
        assert.is_true(allowed)
        assert.are.equal(10, fromPlayer)
        assert.are.equal(30, fromTeam)
    end)
end)
