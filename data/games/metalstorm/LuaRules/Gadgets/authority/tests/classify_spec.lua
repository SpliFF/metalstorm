-- tests/classify_spec.lua — command charge classification.
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets/authority && busted tests/

package.path = './?.lua;' .. package.path

local Classify = require('classify')

describe("free-command list", function()
    it("marks STOP (0) and SELFD (65) free", function()
        assert.is_true(Classify.FREE_CMDS[0])
        assert.is_true(Classify.FREE_CMDS[65])
    end)

    it("does not mark MOVE (10) or ATTACK (20) free", function()
        assert.is_nil(Classify.FREE_CMDS[10])
        assert.is_nil(Classify.FREE_CMDS[20])
    end)
end)

describe("orderClass", function()
    it("classifies negative cmdIDs as build orders", function()
        assert.are.equal('build', Classify.orderClass(-1))
        assert.are.equal('build', Classify.orderClass(-1234))
    end)

    it("classifies posture/state toggles", function()
        assert.are.equal('posture', Classify.orderClass(45))   -- FIRE_STATE
        assert.are.equal('posture', Classify.orderClass(50))   -- MOVE_STATE
        assert.are.equal('posture', Classify.orderClass(95))   -- CLOAK
    end)

    it("classifies everything else as micro (the baseline)", function()
        assert.are.equal('micro', Classify.orderClass(10))     -- MOVE
        assert.are.equal('micro', Classify.orderClass(20))     -- ATTACK
        assert.are.equal('micro', Classify.orderClass(25))     -- GUARD
    end)
end)

describe("isChargeable", function()
    it("charges plain network player commands", function()
        assert.is_true(Classify.isChargeable(false, false))
    end)

    it("exempts fromLua (directive decomposition already charged)", function()
        assert.is_false(Classify.isChargeable(false, true))
    end)

    it("exempts fromSynced (engine-internal re-issue)", function()
        assert.is_false(Classify.isChargeable(true, false))
    end)

    it("exempts when both flags set", function()
        assert.is_false(Classify.isChargeable(true, true))
    end)
end)
