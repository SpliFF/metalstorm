-- tests/ownership_spec.lua — ownership hysteresis state machine tests.
-- Run from the plugin root:  cd data/games/metalstorm/LuaRules/Gadgets/regions && busted tests/

package.path = './?.lua;' .. package.path

local Ownership = require('ownership')

local function scoresOf(regionKey, byTeam)
    return { [regionKey] = byTeam }
end

describe("ownership state machine", function()
    it("stays neutral until a team dominates for FLIP_TICKS", function()
        local state = Ownership.newState()
        local scores = scoresOf('r', { [0] = 300, [1] = 100 })  -- 3x dominance
        for i = 1, Ownership.FLIP_TICKS - 1 do
            state = Ownership.step(state, scores)
            assert.is_nil(state.r.owner)
        end
        state = Ownership.step(state, scores)
        assert.are.equal(0, state.r.owner)
    end)

    it("does NOT flip on a raw leader-per-tick flicker (the stub's known bug)", function()
        local state = Ownership.newState()
        -- Team 0 leads one tick, team 1 leads the next, alternating —
        -- never sustains FLIP_TICKS consecutive dominant ticks.
        for i = 1, 10 do
            local scores
            if i % 2 == 0 then
                scores = scoresOf('r', { [0] = 300, [1] = 100 })
            else
                scores = scoresOf('r', { [0] = 100, [1] = 300 })
            end
            state = Ownership.step(state, scores)
        end
        assert.is_nil(state.r.owner)
    end)

    it("requires DOMINANCE margin, not just any lead", function()
        local state = Ownership.newState()
        -- Team 0 leads but only 1.1x — below the 1.5x DOMINANCE bar.
        local scores = scoresOf('r', { [0] = 110, [1] = 100 })
        for i = 1, Ownership.FLIP_TICKS + 2 do
            state = Ownership.step(state, scores)
        end
        assert.is_nil(state.r.owner)
    end)

    it("flips from one owner to the other once the challenger dominates for FLIP_TICKS", function()
        local state = Ownership.newState()
        local homeScores = scoresOf('r', { [0] = 300, [1] = 0 })
        for i = 1, Ownership.FLIP_TICKS do
            state = Ownership.step(state, homeScores)
        end
        assert.are.equal(0, state.r.owner)

        local challengeScores = scoresOf('r', { [0] = 0, [1] = 300 })
        for i = 1, Ownership.FLIP_TICKS do
            state = Ownership.step(state, challengeScores)
        end
        assert.are.equal(1, state.r.owner)
    end)

    it("is empty-sticky: an owned region with no presence keeps its owner", function()
        local state = Ownership.newState()
        local homeScores = scoresOf('r', { [0] = 300, [1] = 0 })
        for i = 1, Ownership.FLIP_TICKS do
            state = Ownership.step(state, homeScores)
        end
        assert.are.equal(0, state.r.owner)

        state = Ownership.step(state, { r = nil })
        assert.are.equal(0, state.r.owner)
    end)

    it("decays a sticky owner to neutral after DECAY_TICKS empty", function()
        local state = Ownership.newState()
        local homeScores = scoresOf('r', { [0] = 300, [1] = 0 })
        for i = 1, Ownership.FLIP_TICKS do
            state = Ownership.step(state, homeScores)
        end
        for i = 1, Ownership.DECAY_TICKS - 1 do
            state = Ownership.step(state, { r = nil })
        end
        assert.are.equal(0, state.r.owner)   -- not yet decayed
        state = Ownership.step(state, { r = nil })
        assert.is_nil(state.r.owner)          -- decayed to neutral
    end)

    it("flags contested independent of owner when >=2 teams clear CONTEST_FLOOR", function()
        local state = Ownership.newState()
        -- Both teams present above CONTEST_FLOOR, but not dominant enough to flip.
        local scores = scoresOf('r', { [0] = 250, [1] = 240 })
        state = Ownership.step(state, scores)
        assert.is_true(state.r.contested)
        assert.is_nil(state.r.owner)
    end)

    it("a contested region keeps its owner until flipped (contested is a flag, not a state)", function()
        local state = Ownership.newState()
        local homeScores = scoresOf('r', { [0] = 300, [1] = 0 })
        for i = 1, Ownership.FLIP_TICKS do
            state = Ownership.step(state, homeScores)
        end
        assert.are.equal(0, state.r.owner)

        -- Enemy shows up in force but hasn't out-dominated yet — contested,
        -- but team 0 still owns.
        state = Ownership.step(state, scoresOf('r', { [0] = 300, [1] = 250 }))
        assert.is_true(state.r.contested)
        assert.are.equal(0, state.r.owner)
    end)

    it("eliminated/dead-team ownership persists until decay or flip (E4)", function()
        local state = Ownership.newState()
        local homeScores = scoresOf('r', { [7] = 300 })
        for i = 1, Ownership.FLIP_TICKS do
            state = Ownership.step(state, homeScores)
        end
        assert.are.equal(7, state.r.owner)
        -- Team 7 is "dead" now (no more units anywhere) — region stays theirs.
        state = Ownership.step(state, { r = nil })
        assert.are.equal(7, state.r.owner)
    end)

    it("publish-on-change: step() reports only regions whose owner/contested changed", function()
        local state = Ownership.newState()
        local scores = { a = { [0] = 300 }, b = { [0] = 300 } }
        local _, changedFirst = Ownership.step(state, scores)
        table.sort(changedFirst)
        -- Neither flips yet (only 1 of FLIP_TICKS=3), so nothing changed.
        assert.are.equal(0, #changedFirst)

        for i = 1, Ownership.FLIP_TICKS - 1 do
            state, changedFirst = Ownership.step(state, scores)
        end
        table.sort(changedFirst)
        assert.are.same({ 'a', 'b' }, changedFirst)

        -- A quiet tick with the same scores changes nothing further.
        local _, changedQuiet = Ownership.step(state, scores)
        assert.are.equal(0, #changedQuiet)
    end)
end)
