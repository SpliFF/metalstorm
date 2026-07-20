-- tests/escort_spec.lua — escort objective state machine (§4.3).
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets/objectives && busted tests/

package.path = './?.lua;' .. package.path

local escort = require('escort')

local function fakeCtx(positions, unitsInArea)
    return {
        unitAlive = function(id) return positions[id] ~= nil end,
        unitPos = function(id)
            local p = positions[id]
            if not p then return nil end
            return p[1], 0, p[2]
        end,
        unitsInArea = unitsInArea or function() return {} end,
    }
end

describe("escort.validateParams", function()
    it("requires payloadUnitIDs and a destArea", function()
        assert.is_true(escort.validateParams({
            payloadUnitIDs = { 1 }, destArea = { x = 0, z = 0, r = 100 },
        }))
        assert.is_false(escort.validateParams({ payloadUnitIDs = {} }))
        assert.is_false(escort.validateParams({ payloadUnitIDs = { 1 }, destArea = { x = 0 } }))
    end)
end)

describe("escort.init/check", function()
    it("fails Create if all payload are already dead", function()
        local o = { params = { payloadUnitIDs = { 1, 2 }, destArea = { x = 1000, z = 0, r = 50 } } }
        local ok = escort.init(o, fakeCtx({}))
        assert.is_false(ok)
    end)

    it("stays active while payload is en route", function()
        local o = { params = { payloadUnitIDs = { 1 }, destArea = { x = 1000, z = 0, r = 50 } } }
        escort.init(o, fakeCtx({ [1] = { 0, 0 } }))
        local state = escort.check(o, fakeCtx({ [1] = { 500, 0 } }))
        assert.is_nil(state)
    end)

    it("completes when >= quorum payload reach destArea", function()
        local o = { params = { payloadUnitIDs = { 1, 2 }, destArea = { x = 1000, z = 0, r = 50 }, quorum = 1 }, forTeam = 4 }
        escort.init(o, fakeCtx({ [1] = { 0, 0 }, [2] = { 0, 0 } }))
        local state, team = escort.check(o, fakeCtx({ [1] = { 1000, 0 }, [2] = { 0, 0 } }))
        assert.are.equal('complete', state)
        assert.are.equal(4, team)
    end)

    it("fails when the whole payload is dead", function()
        local o = { params = { payloadUnitIDs = { 1, 2 }, destArea = { x = 1000, z = 0, r = 50 } } }
        escort.init(o, fakeCtx({ [1] = { 0, 0 }, [2] = { 0, 0 } }))
        local state = escort.check(o, fakeCtx({}))
        assert.are.equal('failed', state)
    end)
end)

describe("escort.onUnitDestroyed", function()
    it("ignores non-payload deaths", function()
        local o = { params = { payloadUnitIDs = { 1 }, destArea = { x = 1000, z = 0, r = 50 } } }
        escort.init(o, fakeCtx({ [1] = { 0, 0 } }))
        assert.is_nil(escort.onUnitDestroyed(o, 99, 1, fakeCtx({ [1] = { 0, 0 } })))
    end)

    it("re-evaluates immediately on payload loss, failing when it was the last one", function()
        local o = { params = { payloadUnitIDs = { 1 }, destArea = { x = 1000, z = 0, r = 50 } } }
        escort.init(o, fakeCtx({ [1] = { 0, 0 } }))
        local state = escort.onUnitDestroyed(o, 1, 3, fakeCtx({}))
        assert.are.equal('failed', state)
    end)
end)

describe("escort.progress", function()
    it("goes from 0 at the start centroid to 1 on arrival", function()
        local o = { params = { payloadUnitIDs = { 1 }, destArea = { x = 1000, z = 0, r = 50 } } }
        escort.init(o, fakeCtx({ [1] = { 0, 0 } }))
        assert.are.equal(0, escort.progress(o, fakeCtx({ [1] = { 0, 0 } })))
        local halfway = escort.progress(o, fakeCtx({ [1] = { 500, 0 } }))
        assert.is_true(halfway > 0.4 and halfway < 0.6)
        assert.are.equal(1, escort.progress(o, fakeCtx({ [1] = { 1000, 0 } })))
    end)
end)
