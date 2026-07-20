-- tests/control_spec.lua — control objective state machine (§4.1).
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets/objectives && busted tests/

package.path = './?.lua;' .. package.path

local control = require('control')

local function fakeCtx(frame, owner, regionExists)
    return {
        frame = frame,
        regionOwner = function(key) return owner end,
        regionExists = function(key) return regionExists ~= false end,
        unitsInRegion = function(key) return {} end,
        unitTeam = function(id) return nil end,
    }
end

describe("control.validateParams", function()
    it("requires a string regionKey and positive holdFrames", function()
        assert.is_true(control.validateParams({ regionKey = 'r1', holdFrames = 100 }))
        assert.is_false(control.validateParams({ regionKey = '', holdFrames = 100 }))
        assert.is_false(control.validateParams({ regionKey = 'r1', holdFrames = 0 }))
        assert.is_false(control.validateParams({ regionKey = 'r1' }))
    end)
end)

describe("control.init", function()
    it("fails on an unknown region (E1)", function()
        local o = { params = { regionKey = 'ghost', holdFrames = 100 } }
        local ok, err = control.init(o, fakeCtx(0, nil, false))
        assert.is_false(ok)
        assert.is_string(err)
    end)

    it("succeeds and sets up heldSince for a real region", function()
        local o = { params = { regionKey = 'r1', holdFrames = 100 } }
        local ok = control.init(o, fakeCtx(0, nil, true))
        assert.is_true(ok)
        assert.are.same({}, o.data.heldSince)
    end)
end)

describe("control.check", function()
    it("does not complete before holdFrames elapse", function()
        local o = { params = { regionKey = 'r1', holdFrames = 100 } }
        control.init(o, fakeCtx(0, nil, true))
        local state = control.check(o, fakeCtx(0, 5, true))
        assert.is_nil(state)
        state = control.check(o, fakeCtx(50, 5, true))
        assert.is_nil(state)
    end)

    it("completes once the current owner holds for holdFrames, returning the winning team", function()
        local o = { params = { regionKey = 'r1', holdFrames = 100 } }
        control.init(o, fakeCtx(0, nil, true))
        control.check(o, fakeCtx(0, 5, true))    -- team 5 takes it at frame 0
        local state, team = control.check(o, fakeCtx(100, 5, true))
        assert.are.equal('complete', state)
        assert.are.equal(5, team)
    end)

    it("resets the clock on a region flip (loser's clock cleared)", function()
        local o = { params = { regionKey = 'r1', holdFrames = 100 } }
        control.init(o, fakeCtx(0, nil, true))
        control.check(o, fakeCtx(0, 5, true))     -- team 5 takes it
        control.check(o, fakeCtx(80, 6, true))    -- flips to team 6 before team 5 finishes
        local state = control.check(o, fakeCtx(100, 6, true))  -- only 20 frames as team 6
        assert.is_nil(state)
        state = control.check(o, fakeCtx(180, 6, true))        -- now 100 frames as team 6
        assert.are.equal('complete', state)
    end)

    it("never completes for an ineligible team when forTeam is set (open race narrowed)", function()
        local o = { params = { regionKey = 'r1', holdFrames = 100 }, forTeam = 7 }
        control.init(o, fakeCtx(0, nil, true))
        for f = 0, 200, 20 do
            local state = control.check(o, fakeCtx(f, 5, true))
            assert.is_nil(state)
        end
    end)

    it("does nothing while the region is unowned", function()
        local o = { params = { regionKey = 'r1', holdFrames = 100 } }
        control.init(o, fakeCtx(0, nil, true))
        local state = control.check(o, fakeCtx(500, nil, true))
        assert.is_nil(state)
    end)

    it("completes for a widened forTeam2 (PLAN-metalstorm-interaction.md §1 joint_objective)", function()
        local o = { params = { regionKey = 'r1', holdFrames = 100 }, forTeam = 7, forTeam2 = 8 }
        control.init(o, fakeCtx(0, nil, true))
        for f = 0, 200, 20 do
            local state = control.check(o, fakeCtx(f, 5, true))   -- team 5: still ineligible
            assert.is_nil(state)
        end
        control.init(o, fakeCtx(0, nil, true))   -- fresh heldSince for the widened-team run
        control.check(o, fakeCtx(0, 8, true))
        local state, team = control.check(o, fakeCtx(100, 8, true))
        assert.are.equal('complete', state)
        assert.are.equal(8, team)   -- the WIDENED team, not the original forTeam
    end)
end)

describe("control.progress", function()
    it("is 0 before any team owns the region", function()
        local o = { params = { regionKey = 'r1', holdFrames = 100 } }
        control.init(o, fakeCtx(0, nil, true))
        assert.are.equal(0, control.progress(o, fakeCtx(0, nil, true)))
    end)

    it("scales linearly and clamps at 1", function()
        local o = { params = { regionKey = 'r1', holdFrames = 100 } }
        control.init(o, fakeCtx(0, nil, true))
        control.check(o, fakeCtx(0, 5, true))
        assert.are.equal(0.5, control.progress(o, fakeCtx(50, 5, true)))
        assert.are.equal(1, control.progress(o, fakeCtx(500, 5, true)))
    end)
end)

describe("control.participants", function()
    it("credits only the currently-accumulating team's units", function()
        local o = { params = { regionKey = 'r1', holdFrames = 100 } }
        control.init(o, fakeCtx(0, nil, true))
        local ctx = fakeCtx(0, 5, true)
        ctx.unitsInRegion = function() return { 1, 2, 3 } end
        ctx.unitTeam = function(id) return (id == 3) and 6 or 5 end
        control.check(o, ctx)
        local ps = control.participants(o, ctx)
        table.sort(ps)
        assert.are.same({ 1, 2 }, ps)
    end)
end)
