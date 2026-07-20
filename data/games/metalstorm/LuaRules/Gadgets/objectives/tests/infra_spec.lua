-- tests/infra_spec.lua — infrastructure objective, timed + open-ended variants (§4.6).
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets/objectives && busted tests/

package.path = './?.lua;' .. package.path

local infra = require('infra')

local function fakeCtx(frame, running)
    return {
        frame = frame,
        unitAlive = function(id) return running[id] ~= nil end,
        isOperational = function(id) return running[id] == true end,
        unitPos = function(id) return running[id] and 100 or nil, 0, 200 end,
        unitsInArea = function() return {} end,
        evalPeriodFrames = 90,
    }
end

describe("infra.init", function()
    it("fails Create when nothing is running", function()
        local o = { params = { buildingUnitIDs = { 1 } } }
        local ok = infra.init(o, fakeCtx(0, {}))
        assert.is_false(ok)
    end)

    it("defaults quorum to all buildings", function()
        local o = { params = { buildingUnitIDs = { 1, 2 } } }
        infra.init(o, fakeCtx(0, { [1] = true, [2] = true }))
        assert.are.equal(2, o.data.quorum)
    end)
end)

describe("timed infra (protect-like)", function()
    it("fails once quorum of running buildings breaks", function()
        local o = { params = { buildingUnitIDs = { 1, 2 } }, expiresAtFrame = 1000 }
        infra.init(o, fakeCtx(0, { [1] = true, [2] = true }))
        local state = infra.onUnitDestroyed(o, 1, 9, fakeCtx(500, { [2] = true }))
        assert.are.equal('failed', state)
    end)

    it("completes at expiry if still running", function()
        local o = { params = { buildingUnitIDs = { 1 } }, expiresAtFrame = 1000, forTeam = 5 }
        infra.init(o, fakeCtx(0, { [1] = true }))
        local state, team = infra.onExpire(o, fakeCtx(1000, { [1] = true }))
        assert.are.equal('complete', state)
        assert.are.equal(5, team)
    end)

    it("never pays income (timed variant has no income)", function()
        local o = { params = { buildingUnitIDs = { 1 }, rewardPerMinute = 10 }, expiresAtFrame = 1000 }
        infra.init(o, fakeCtx(0, { [1] = true }))
        assert.is_nil(infra.income(o, fakeCtx(90, { [1] = true })))
    end)
end)

describe("open-ended infra income", function()
    it("pays rewardPerMinute scaled to the eval period while running", function()
        local o = { params = { buildingUnitIDs = { 1 }, rewardPerMinute = 60 } }
        infra.init(o, fakeCtx(0, { [1] = true }))
        local amount = infra.income(o, fakeCtx(90, { [1] = true }))
        -- 60/min * (90 frames / 1800 frames-per-min) = 3
        assert.are.equal(3, amount)
    end)

    it("pays nothing once the building stops running", function()
        local o = { params = { buildingUnitIDs = { 1 }, rewardPerMinute = 60 } }
        infra.init(o, fakeCtx(0, { [1] = true }))
        assert.is_nil(infra.income(o, fakeCtx(90, {})))
    end)

    it("pays nothing with no rewardPerMinute configured", function()
        local o = { params = { buildingUnitIDs = { 1 } } }
        infra.init(o, fakeCtx(0, { [1] = true }))
        assert.is_nil(infra.income(o, fakeCtx(90, { [1] = true })))
    end)
end)
