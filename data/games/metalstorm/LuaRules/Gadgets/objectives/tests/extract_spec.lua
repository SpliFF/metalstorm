-- tests/extract_spec.lua — extract objective two-phase state machine (§4.5).
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets/objectives && busted tests/

package.path = './?.lua;' .. package.path

local extract = require('extract')

local function params()
    return {
        payloadUnitIDs = { 1 },
        pickupArea = { x = 0, z = 0, r = 200 },
        extractArea = { x = 2000, z = 0, r = 100 },
        holdFrames = 100,
        threshold = 50,
    }
end

local function fakeCtx(opts)
    opts = opts or {}
    local moved = {}
    return {
        frame = opts.frame or 0,
        unitAlive = opts.unitAlive or function(id) return id == 1 end,
        unitPos = opts.unitPos or function() return 0, 0, 0 end,
        teamStrengthInArea = opts.teamStrengthInArea or function() return 0 end,
        issueMove = function(ids, x, z) moved.ids, moved.x, moved.z = ids, x, z end,
        _moved = moved,
    }
end

describe("extract.validateParams", function()
    it("requires both areas and positive holdFrames/threshold", function()
        assert.is_true(extract.validateParams(params()))
        local p = params(); p.pickupArea = nil
        assert.is_false(extract.validateParams(p))
        p = params(); p.holdFrames = 0
        assert.is_false(extract.validateParams(p))
    end)
end)

describe("extract phase 1 (secure)", function()
    it("stays in secure phase while strength is below threshold", function()
        local o = { params = params() }
        extract.init(o, fakeCtx())
        local ctx = fakeCtx({ teamStrengthInArea = function() return 10 end })
        extract.check(o, ctx)
        assert.are.equal('secure', o.data.phase)
    end)

    it("transitions to evac after holdFrames sustained above threshold, issuing move orders", function()
        local o = { params = params(), forTeam = 3 }
        extract.init(o, fakeCtx())
        local strongCtx = function(frame)
            return fakeCtx({ frame = frame, teamStrengthInArea = function() return 100 end })
        end
        extract.check(o, strongCtx(0))
        assert.are.equal('secure', o.data.phase)
        local ctx = strongCtx(100)
        extract.check(o, ctx)
        assert.are.equal('evac', o.data.phase)
        assert.are.same({ 1 }, ctx._moved.ids)
        assert.are.equal(2000, ctx._moved.x)
    end)

    it("resets secureSince if strength drops below threshold before holdFrames elapses", function()
        local o = { params = params() }
        extract.init(o, fakeCtx())
        extract.check(o, fakeCtx({ frame = 0, teamStrengthInArea = function() return 100 end }))
        extract.check(o, fakeCtx({ frame = 50, teamStrengthInArea = function() return 10 end }))
        extract.check(o, fakeCtx({ frame = 60, teamStrengthInArea = function() return 100 end }))
        -- Only 60 frames elapsed since the strength came back — should still be secure.
        assert.are.equal('secure', o.data.phase)
    end)
end)

describe("extract phase 2 (evac)", function()
    local function evacObjective()
        local o = { params = params(), forTeam = 3, data = { phase = 'evac', quorum = 1 } }
        return o
    end

    it("stays active while payload is short of the extractArea", function()
        local o = evacObjective()
        local state = extract.check(o, fakeCtx({ unitPos = function() return 1000, 0, 0 end }))
        assert.is_nil(state)
    end)

    it("completes once >= quorum payload reach extractArea", function()
        local o = evacObjective()
        local state, team = extract.check(o, fakeCtx({ unitPos = function() return 2000, 0, 0 end }))
        assert.are.equal('complete', state)
        assert.are.equal(3, team)
    end)

    it("fails if the payload dies mid-evac", function()
        local o = evacObjective()
        local state = extract.check(o, fakeCtx({ unitAlive = function() return false end }))
        assert.are.equal('failed', state)
    end)
end)

describe("extract.onUnitDestroyed", function()
    it("fails once the whole payload is dead, in either phase", function()
        local o = { params = params(), data = { phase = 'evac', quorum = 1 } }
        local state = extract.onUnitDestroyed(o, 1, 9, fakeCtx({ unitAlive = function() return false end }))
        assert.are.equal('failed', state)
    end)

    it("ignores deaths of units not in the payload", function()
        local o = { params = params(), data = { phase = 'secure' } }
        assert.is_nil(extract.onUnitDestroyed(o, 999, 9, fakeCtx()))
    end)
end)
