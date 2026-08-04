-- tests/control_spec.lua — control score bucketing tests.
-- Run from the plugin root:  cd data/games/metalstorm/LuaRules/Gadgets/regions && busted tests/

package.path = './?.lua;' .. package.path

local Partition = require('partition')
local Control = require('control')

local GAIA = 255

local function gridProvider()
    return Partition.newGridProvider(8192, 8192, 2048)
end

describe("control score v2", function()
    it("sums plain unit strength per region per team", function()
        local units = {
            { x = 100, z = 100, team = 0, hp = 100 },
            { x = 200, z = 200, team = 0, hp = 50 },
            { x = 100, z = 100, team = 1, hp = 300 },
        }
        local scores = Control.computeScores(units, gridProvider(), GAIA)
        assert.are.equal(150, scores['0:0'][0])
        assert.are.equal(300, scores['0:0'][1])
    end)

    it("excludes the Gaia team entirely", function()
        local units = {
            { x = 100, z = 100, team = GAIA, hp = 99999 },
            { x = 100, z = 100, team = 0, hp = 10 },
        }
        local scores = Control.computeScores(units, gridProvider(), GAIA)
        assert.is_nil(scores['0:0'][GAIA])
        assert.are.equal(10, scores['0:0'][0])
    end)

    it("weights buildings x3 (structures anchor)", function()
        local units = {
            { x = 100, z = 100, team = 0, hp = 100, isBuilding = true },
        }
        local scores = Control.computeScores(units, gridProvider(), GAIA)
        assert.are.equal(300, scores['0:0'][0])
    end)

    it("weights air units at half (tunable move-class table)", function()
        local units = {
            { x = 100, z = 100, team = 0, hp = 100, moveClass = 'air' },
        }
        local scores = Control.computeScores(units, gridProvider(), GAIA)
        assert.are.equal(50, scores['0:0'][0])
    end)

    it("compounds building + air weights", function()
        local units = {
            { x = 100, z = 100, team = 0, hp = 100, isBuilding = true, moveClass = 'air' },
        }
        local scores = Control.computeScores(units, gridProvider(), GAIA)
        assert.are.equal(150, scores['0:0'][0])  -- 100 * 3 * 0.5
    end)

    it("does one single bucketing pass regardless of region count", function()
        -- Not a perf-timing test (flaky); asserts the contract instead: every
        -- unit contributes exactly once, to exactly one region bucket.
        local units = {}
        for i = 1, 50 do
            units[i] = { x = i * 100, z = i * 100, team = 0, hp = 1 }
        end
        local scores = Control.computeScores(units, gridProvider(), GAIA)
        local total = 0
        for _, byTeam in pairs(scores) do
            total = total + (byTeam[0] or 0)
        end
        assert.are.equal(50, total)
    end)

    it("ignores dead units (hp <= 0)", function()
        local units = {
            { x = 100, z = 100, team = 0, hp = 0 },
        }
        local scores = Control.computeScores(units, gridProvider(), GAIA)
        assert.is_nil(scores['0:0'])
    end)
end)
