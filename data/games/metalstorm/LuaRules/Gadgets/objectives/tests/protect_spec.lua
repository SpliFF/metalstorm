-- tests/protect_spec.lua — protect objective state machine (§4.4).
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets/objectives && busted tests/

package.path = './?.lua;' .. package.path

local protect = require('protect')

local function fakeCtx(frame, alive)
    return {
        frame = frame,
        unitAlive = function(id) return alive[id] == true end,
        unitPos = function(id) return alive[id] and 100 or nil, 0, 200 end,
        unitsInArea = function() return {} end,
    }
end

describe("protect.init", function()
    it("requires expiresAtFrame", function()
        local o = { params = { targetUnitIDs = { 1 } } }
        local ok, err = protect.init(o, fakeCtx(0, { [1] = true }))
        assert.is_false(ok)
        assert.is_string(err)
    end)

    it("fails Create when all targets are already dead", function()
        local o = { params = { targetUnitIDs = { 1 } }, expiresAtFrame = 1000 }
        local ok = protect.init(o, fakeCtx(0, {}))
        assert.is_false(ok)
    end)

    it("defaults quorum to all-surviving", function()
        local o = { params = { targetUnitIDs = { 1, 2 } }, expiresAtFrame = 1000 }
        protect.init(o, fakeCtx(0, { [1] = true, [2] = true }))
        assert.are.equal(2, o.data.quorum)
    end)
end)

describe("protect.check / onUnitDestroyed", function()
    it("stays active while quorum holds", function()
        local o = { params = { targetUnitIDs = { 1, 2 } }, expiresAtFrame = 1000 }
        protect.init(o, fakeCtx(0, { [1] = true, [2] = true }))
        assert.is_nil(protect.check(o, fakeCtx(500, { [1] = true, [2] = true })))
    end)

    it("fails immediately once quorum breaks", function()
        local o = { params = { targetUnitIDs = { 1, 2 } }, expiresAtFrame = 1000 }
        protect.init(o, fakeCtx(0, { [1] = true, [2] = true }))
        local state = protect.onUnitDestroyed(o, 1, 9, fakeCtx(500, { [2] = true }))
        assert.are.equal('failed', state)
    end)

    it("onUnitDestroyed ignores unrelated deaths", function()
        local o = { params = { targetUnitIDs = { 1 } }, expiresAtFrame = 1000 }
        protect.init(o, fakeCtx(0, { [1] = true }))
        assert.is_nil(protect.onUnitDestroyed(o, 99, 9, fakeCtx(500, { [1] = true })))
    end)
end)

describe("protect.onExpire", function()
    it("completes (expiry-as-success) when quorum survived, crediting forTeam", function()
        local o = { params = { targetUnitIDs = { 1 } }, expiresAtFrame = 1000, forTeam = 2 }
        protect.init(o, fakeCtx(0, { [1] = true }))
        local state, team = protect.onExpire(o, fakeCtx(1000, { [1] = true }))
        assert.are.equal('complete', state)
        assert.are.equal(2, team)
    end)

    it("fails at expiry if quorum was already broken (safety net)", function()
        local o = { params = { targetUnitIDs = { 1 } }, expiresAtFrame = 1000 }
        protect.init(o, fakeCtx(0, { [1] = true }))
        local state = protect.onExpire(o, fakeCtx(1000, {}))
        assert.are.equal('failed', state)
    end)
end)

describe("protect.progress", function()
    it("tracks elapsed/duration", function()
        local o = { params = { targetUnitIDs = { 1 } }, expiresAtFrame = 1000 }
        protect.init(o, fakeCtx(0, { [1] = true }))
        assert.are.equal(0.5, protect.progress(o, fakeCtx(500, { [1] = true })))
    end)
end)
