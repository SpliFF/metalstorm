-- tests/game_authority_cost_scale_spec.lua — the authority_cost_scale
-- rulesParam mirror (picture.lua readEconomy gap closure). The modoption is
-- an Initialize()-time read straight into a gadget local; the client cost
-- preview and the strategos AI's cost predictor both rerun the §1 formula,
-- so the gadget must republish the effective scale as a PUBLIC game
-- rulesParam or every mirror silently predicts with 1.0.
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets && busted tests/

package.path = './?.lua;' .. package.path

local mock = require('tests.authority_charge_mock')

describe("authority_cost_scale game rulesParam mirror", function()
    it("publishes the modoption value on Initialize", function()
        local world, gadgetObj = mock.new()
        world.modOptions.authority_cost_scale = 0.5
        gadgetObj:Initialize()
        assert.are.equal(0.5, world.gameRulesParams.authority_cost_scale)
    end)

    it("publishes the 1.0 default when the modoption is absent", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()
        assert.are.equal(1.0, world.gameRulesParams.authority_cost_scale)
    end)

    it("re-publishes the GameStart re-read (live launch wins over a stale Initialize)", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()
        assert.are.equal(1.0, world.gameRulesParams.authority_cost_scale)
        world.modOptions.authority_cost_scale = 2.0
        gadgetObj:GameStart()
        assert.are.equal(2.0, world.gameRulesParams.authority_cost_scale)
    end)

    it("publishes scale 0 (the §6 free-mode guarantee) rather than dropping it", function()
        local world, gadgetObj = mock.new()
        world.modOptions.authority_cost_scale = 0
        gadgetObj:Initialize()
        assert.are.equal(0, world.gameRulesParams.authority_cost_scale)
    end)
end)
