-- tests/kill_spec.lua — kill objective state machine (§4.2).
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets/objectives && busted tests/

package.path = './?.lua;' .. package.path

local kill = require('kill')

local function fakeCtx(opts)
    opts = opts or {}
    return {
        frame = opts.frame or 0,
        unitAlive = opts.unitAlive or function() return true end,
        unitPos = opts.unitPos or function() return 100, 0, 200 end,
        unitsInArea = opts.unitsInArea or function() return {} end,
    }
end

describe("kill.validateParams", function()
    it("requires a numeric targetUnitID", function()
        assert.is_true(kill.validateParams({ targetUnitID = 42 }))
        assert.is_false(kill.validateParams({}))
        assert.is_false(kill.validateParams({ targetUnitID = 'x' }))
    end)
end)

describe("kill.init", function()
    it("fails when the target is already dead (E1)", function()
        local o = { params = { targetUnitID = 42 } }
        local ok = kill.init(o, fakeCtx({ unitAlive = function() return false end }))
        assert.is_false(ok)
    end)

    it("succeeds when the target is alive", function()
        local o = { params = { targetUnitID = 42 } }
        assert.is_true(kill.init(o, fakeCtx()))
    end)
end)

describe("kill.check", function()
    it("never resolves on its own (periodic check is a no-op)", function()
        local o = { params = { targetUnitID = 42 } }
        assert.is_nil(kill.check(o, fakeCtx()))
    end)
end)

describe("kill.onUnitDestroyed", function()
    it("ignores deaths of units other than the target", function()
        local o = { params = { targetUnitID = 42 } }
        assert.is_nil(kill.onUnitDestroyed(o, 7, 1, fakeCtx()))
    end)

    it("completes, crediting the attacker's team, when the target dies to an attacker", function()
        local o = { params = { targetUnitID = 42 } }
        local state, team = kill.onUnitDestroyed(o, 42, 3, fakeCtx())
        assert.are.equal('complete', state)
        assert.are.equal(3, team)
    end)

    it("expires (no reward) when the target dies with no attacker (gaia/decay/self-d)", function()
        local o = { params = { targetUnitID = 42 } }
        local state, team = kill.onUnitDestroyed(o, 42, nil, fakeCtx())
        assert.are.equal('expired', state)
        assert.is_nil(team)
    end)
end)

describe("kill.participants", function()
    it("returns units near the target's current position", function()
        local o = { params = { targetUnitID = 42 } }
        local seen
        local ctx = fakeCtx({
            unitPos = function() return 500, 0, 600 end,
            unitsInArea = function(x, z, r) seen = { x, z, r }; return { 9, 10 } end,
        })
        local ps = kill.participants(o, ctx)
        assert.are.same({ 9, 10 }, ps)
        assert.are.same({ 500, 600, 800 }, seen)
    end)

    it("returns nothing if the target's position can't be resolved", function()
        local o = { params = { targetUnitID = 42 } }
        local ctx = fakeCtx({ unitPos = function() return nil end })
        assert.are.same({}, kill.participants(o, ctx))
    end)
end)
