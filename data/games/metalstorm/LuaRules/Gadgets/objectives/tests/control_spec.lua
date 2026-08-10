-- tests/control_spec.lua — control objective state machine (§4.1).
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets/objectives && busted tests/

package.path = './?.lua;' .. package.path

local control = require('control')

-- D57: the clock accrues only while the owner OCCUPIES the region, so a ctx
-- has to say who is standing in it. Default: the owner is present (one unit),
-- which is what every pre-D57 case implicitly assumed. Pass `occupantTeams`
-- (a list of team ids, possibly empty) to model an absent or foreign garrison.
local function fakeCtx(frame, owner, regionExists, occupantTeams)
    if occupantTeams == nil then
        occupantTeams = owner and { owner } or {}
    end
    local units, teamOf = {}, {}
    for i, team in ipairs(occupantTeams) do
        units[i] = i
        teamOf[i] = team
    end
    return {
        frame = frame,
        regionOwner = function(key) return owner end,
        regionExists = function(key) return regionExists ~= false end,
        unitsInRegion = function(key) return units end,
        unitTeam = function(id) return teamOf[id] end,
    }
end

describe("control.validateParams", function()
    it("requires a string regionKey and positive holdFrames", function()
        assert.is_true(control.validateParams({ regionKey = 'r1', holdFrames = 100 }))
        assert.is_false(control.validateParams({ regionKey = '', holdFrames = 100 }))
        assert.is_false(control.validateParams({ regionKey = 'r1', holdFrames = 0 }))
        assert.is_false(control.validateParams({ regionKey = 'r1' }))
    end)

    it("accepts an optional non-negative notBefore and rejects a bad one", function()
        assert.is_true(control.validateParams({ regionKey = 'r1', holdFrames = 100, notBefore = 0 }))
        assert.is_true(control.validateParams({ regionKey = 'r1', holdFrames = 100, notBefore = 3600 }))
        assert.is_false(control.validateParams({ regionKey = 'r1', holdFrames = 100, notBefore = -1 }))
        assert.is_false(control.validateParams({ regionKey = 'r1', holdFrames = 100, notBefore = 'soon' }))
    end)
end)

-- PLAN-metalstorm-wars.md §7.5a / endtoend D20: a terminal objective must not
-- be winnable before the sides can reach it.
describe("control open-race delay (notBefore)", function()
    it("cannot complete before notBefore + holdFrames, however early the region was taken", function()
        local o = { params = { regionKey = 'r1', holdFrames = 100, notBefore = 1000 } }
        control.init(o, fakeCtx(0, nil, true))
        control.check(o, fakeCtx(0, 5, true))          -- team 5 walks in at frame 0
        assert.is_nil(control.check(o, fakeCtx(100, 5, true)))    -- holdFrames elapsed, race shut
        assert.is_nil(control.check(o, fakeCtx(1000, 5, true)))   -- race opens: clock starts NOW
        assert.is_nil(control.check(o, fakeCtx(1099, 5, true)))
        local state, team = control.check(o, fakeCtx(1100, 5, true))
        assert.are.equal('complete', state)
        assert.are.equal(5, team)
    end)

    it("does not delay a team that takes the region after the race opened", function()
        local o = { params = { regionKey = 'r1', holdFrames = 100, notBefore = 1000 } }
        control.init(o, fakeCtx(0, nil, true))
        control.check(o, fakeCtx(2000, 5, true))
        assert.are.equal('complete', (control.check(o, fakeCtx(2100, 5, true))))
    end)

    it("reports 0 progress while holding a region the race has not opened on", function()
        local o = { params = { regionKey = 'r1', holdFrames = 100, notBefore = 1000 } }
        control.init(o, fakeCtx(0, nil, true))
        control.check(o, fakeCtx(0, 5, true))
        assert.are.equal(0, control.progress(o, fakeCtx(500, 5, true)))
        assert.are.equal(0, control.progress(o, fakeCtx(1000, 5, true)))
        assert.are.equal(0.5, control.progress(o, fakeCtx(1050, 5, true)))
    end)

    it("behaves exactly as before when notBefore is absent (no regression)", function()
        local o = { params = { regionKey = 'r1', holdFrames = 100 } }
        control.init(o, fakeCtx(0, nil, true))
        control.check(o, fakeCtx(0, 5, true))
        assert.are.equal('complete', (control.check(o, fakeCtx(100, 5, true))))
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

-- endtoend D57: ownership is sticky for DECAY_TICKS (9 000 frames) by design,
-- so reading only the published owner let an absent army win the war.
describe("control requires occupation, not just ownership (D57)", function()
    it("does not accrue while the owning team has no unit in the region", function()
        local o = { params = { regionKey = 'r1', holdFrames = 100 } }
        control.init(o, fakeCtx(0, nil, true))
        control.check(o, fakeCtx(0, 5, true))                    -- team 5 walks in
        for f = 20, 400, 20 do                                   -- ...and walks out
            assert.is_nil(control.check(o, fakeCtx(f, 5, true, {})))
        end
        assert.are.equal(0, control.progress(o, fakeCtx(400, 5, true, {})))
    end)

    it("pauses rather than resets: an absence keeps what was already banked", function()
        local o = { params = { regionKey = 'r1', holdFrames = 100 } }
        control.init(o, fakeCtx(0, nil, true))
        control.check(o, fakeCtx(0, 5, true))
        control.check(o, fakeCtx(60, 5, true))                    -- 60 banked
        control.check(o, fakeCtx(1000, 5, true, {}))              -- away for 940
        assert.are.equal(0.6, control.progress(o, fakeCtx(1000, 5, true, {})))
        control.check(o, fakeCtx(1020, 5, true))                  -- back: reopens
        local state, team = control.check(o, fakeCtx(1060, 5, true))  -- +40 = 100
        assert.are.equal('complete', state)
        assert.are.equal(5, team)
    end)

    it("does not count an enemy garrison as the owner's occupation", function()
        local o = { params = { regionKey = 'r1', holdFrames = 100 } }
        control.init(o, fakeCtx(0, nil, true))
        control.check(o, fakeCtx(0, 5, true))
        for f = 20, 400, 20 do
            assert.is_nil(control.check(o, fakeCtx(f, 5, true, { 6, 6 })))
        end
    end)

    it("still refuses to accrue an occupied region before notBefore", function()
        local o = { params = { regionKey = 'r1', holdFrames = 100, notBefore = 1000 } }
        control.init(o, fakeCtx(0, nil, true))
        control.check(o, fakeCtx(0, 5, true))
        assert.is_nil(control.check(o, fakeCtx(900, 5, true)))
        assert.is_nil(control.check(o, fakeCtx(1000, 5, true)))
        assert.are.equal('complete', (control.check(o, fakeCtx(1100, 5, true))))
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
