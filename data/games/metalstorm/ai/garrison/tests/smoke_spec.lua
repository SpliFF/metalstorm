-- garrison/tests/smoke_spec.lua — boots main.lua against the fake AI VM and
-- drives three situations end to end. Run from the plugin root
-- (data/games/metalstorm/ai/garrison):  busted tests/
package.path = './?.lua;' .. package.path

local FE  = require('lib.testing.fake_engine')
local Fix = require('lib.tests.fixtures.graph')

local function stage()
    local fe = FE.new({ teamId = 0, playerId = 7, regions = Fix.regionsJson(),
                        power = Fix.powerJson(), pool = 50 }):install()
    fe:setRulesParam('game', 'region_north_ridge_team', 0)
    fe:setOwnUnits(Fix.tanks(3, false))
    for _, m in ipairs({ 'brain', 'profiles.sentinel' }) do package.loaded[m] = nil end
    dofile('main.lua')
    return fe
end

describe("garrison main against the fake engine", function()
    after_each(function() FE.uninstall() end)

    it("boots, holds home, braces on adjacent contact, withdraws when outmatched, never micros", function()
        local fe = stage()
        fe:step(160, onUpdate)
        assert.is_nil(AI_GARRISON_BOOT_ERROR)
        assert.is_true(#fe:directives() >= 1, 'a HOLD on home ground')
        assert.are.equal(10, fe:directives()[1].type)              -- Defend
        fe:setEnemies({ { id = 9, defId = 101, x = 1500, z = 500, health = 1.0 } })
        fe:step(160, onUpdate)
        local n = #fe:directives()
        assert.are.equal(10, fe:directives()[n].type)              -- Defend (brace)
        local many = {}
        for i = 1, 5 do many[i] = { id = 20 + i, defId = 103, x = 300 + i * 10, z = 300, health = 1.0 } end
        fe:setEnemies(many)
        fe:step(160, onUpdate)
        local last = fe:directives()[#fe:directives()]
        assert.are.equal(12, last.type)                            -- Withdraw
        assert.are.equal(0, last.params[1], 'through the nearest map edge (west)')
        assert.are.equal(0, #fe.violations)
        assert.are.equal(0, #(fe.errors or {}))
        assert.is_true(fe.spent > 0)
    end)
end)
