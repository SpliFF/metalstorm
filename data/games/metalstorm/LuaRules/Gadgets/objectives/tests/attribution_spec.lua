-- tests/attribution_spec.lua — reward-attribution split math (§5).
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets/objectives && busted tests/

package.path = './?.lua;' .. package.path

local Attribution = require('attribution')

describe("participation credit", function()
    it("accumulates weight per player across multiple credits", function()
        local p = Attribution.newParticipation()
        Attribution.credit(p, 7, 1.0)
        Attribution.credit(p, 7, 1.0)
        Attribution.credit(p, 8, 2.0)
        assert.are.equal(2.0, p[7])
        assert.are.equal(2.0, p[8])
    end)

    it("ignores a nil playerID (unstamped last_commander)", function()
        local p = Attribution.newParticipation()
        Attribution.credit(p, nil, 1.0)
        assert.are.equal(0, (next(p) and 1) or 0)
    end)

    it("ignores non-positive weight", function()
        local p = Attribution.newParticipation()
        Attribution.credit(p, 1, 0)
        Attribution.credit(p, 1, -5)
        assert.is_nil(p[1])
    end)
end)

describe("isEmpty", function()
    it("is true for a fresh table", function()
        assert.is_true(Attribution.isEmpty(Attribution.newParticipation()))
    end)

    it("is false once any positive weight is credited", function()
        local p = Attribution.newParticipation()
        Attribution.credit(p, 1, 1.0)
        assert.is_false(Attribution.isEmpty(p))
    end)

    it("is true when all entries are zero/negative (defensive)", function()
        local p = { [1] = 0, [2] = -1 }
        assert.is_true(Attribution.isEmpty(p))
    end)
end)

describe("splitWeights", function()
    it("routes active players into weights, inactive into teamWeight", function()
        local p = { [1] = 3.0, [2] = 1.0, [3] = 2.0 }
        local isActive = function(pid) return pid ~= 2 end   -- player 2 left
        local weights, teamWeight = Attribution.splitWeights(p, isActive)
        assert.are.equal(3.0, weights[1])
        assert.are.equal(2.0, weights[3])
        assert.is_nil(weights[2])
        assert.are.equal(1.0, teamWeight)
    end)

    it("returns teamWeight 0 when everyone is active", function()
        local p = { [1] = 1.0, [2] = 1.0 }
        local weights, teamWeight = Attribution.splitWeights(p, function() return true end)
        assert.are.equal(0, teamWeight)
        assert.are.equal(1.0, weights[1])
        assert.are.equal(1.0, weights[2])
    end)

    it("routes everyone team-ward when all are inactive", function()
        local p = { [1] = 1.0, [2] = 2.0 }
        local weights, teamWeight = Attribution.splitWeights(p, function() return false end)
        assert.are.equal(3.0, teamWeight)
        assert.is_nil(next(weights))
    end)

    it("skips non-positive entries entirely", function()
        local p = { [1] = 1.0, [2] = 0, [3] = -1 }
        local weights, teamWeight = Attribution.splitWeights(p, function() return true end)
        assert.are.equal(1.0, weights[1])
        assert.is_nil(weights[2])
        assert.is_nil(weights[3])
        assert.are.equal(0, teamWeight)
    end)
end)
