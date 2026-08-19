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

-- ============================================================
-- The TRANSPORT form (§10.3): the primary shape of the type. Needs no map
-- content — the point of the amendment.
-- ============================================================
local function transportCtx(positions, withdrawn)
    local ctx = fakeCtx(positions)
    ctx.withdrawnTransports = function() return withdrawn or 0 end
    return ctx
end

describe("escort (transport form)", function()
    local ZONE = { x = 1000, z = 0, r = 200 }

    it("accepts transportUnitIDs + extractArea, with no convoy content anywhere", function()
        assert.is_true(escort.validateParams({
            transportUnitIDs = { 7 }, extractArea = ZONE,
        }))
    end)

    it("rejects an unknown direction", function()
        local ok = escort.validateParams({
            transportUnitIDs = { 7 }, extractArea = ZONE, direction = 'sideways',
        })
        assert.is_false(ok)
    end)

    it("completes when the carrier reaches the extract area", function()
        local o = { forTeam = 4, params = { transportUnitIDs = { 7 }, extractArea = ZONE } }
        escort.init(o, transportCtx({ [7] = { 0, 0 } }, 0))
        assert.is_nil(escort.check(o, transportCtx({ [7] = { 500, 0 } }, 0)))
        local state, team = escort.check(o, transportCtx({ [7] = { 1000, 0 } }, 0))
        assert.are.equal('complete', state)
        assert.are.equal(4, team)
    end)

    -- The reason this form is not the convoy form with a different noun: an
    -- outbound escort WINS by its payload ceasing to exist. game_transports
    -- destroys the carrier at the departure zone, and the two subsystems poll
    -- on different cadences, so the position window is missable.
    it("completes on a departure the position poll never saw", function()
        local o = { forTeam = 4, params = { transportUnitIDs = { 7 }, extractArea = ZONE } }
        escort.init(o, transportCtx({ [7] = { 0, 0 } }, 0))
        local state = escort.check(o, transportCtx({}, 1))   -- gone, and the ledger says why
        assert.are.equal('complete', state)
    end)

    it("still fails when the carrier dies without departing", function()
        local o = { forTeam = 4, params = { transportUnitIDs = { 7 }, extractArea = ZONE } }
        escort.init(o, transportCtx({ [7] = { 0, 0 } }, 0))
        local state = escort.onUnitDestroyed(o, 7, 1, transportCtx({}, 0))
        assert.are.equal('failed', state)
    end)

    -- A side that had already withdrawn a transport before this objective was
    -- created must not be handed a free completion by the standing counter.
    it("baselines the ledger at init, so an earlier departure does not count", function()
        local o = { forTeam = 4, params = { transportUnitIDs = { 7 }, extractArea = ZONE } }
        escort.init(o, transportCtx({ [7] = { 0, 0 } }, 3))
        assert.is_nil(escort.check(o, transportCtx({ [7] = { 0, 0 } }, 3)))
        assert.are.equal('complete', escort.check(o, transportCtx({ [7] = { 0, 0 } }, 4)))
    end)

    it("does not credit the ledger to an inbound escort", function()
        -- Inbound is "get this wave down alive"; nothing departs, and another
        -- transport leaving elsewhere on the map is not this objective's win.
        local o = { forTeam = 4, params = {
            transportUnitIDs = { 7 }, extractArea = ZONE, direction = 'inbound' } }
        escort.init(o, transportCtx({ [7] = { 0, 0 } }, 0))
        assert.is_nil(escort.check(o, transportCtx({ [7] = { 0, 0 } }, 9)))
        assert.are.equal('complete', escort.check(o, transportCtx({ [7] = { 1000, 0 } }, 9)))
    end)

    it("reads progress as 1 once the carrier has left", function()
        local o = { forTeam = 4, params = { transportUnitIDs = { 7 }, extractArea = ZONE } }
        escort.init(o, transportCtx({ [7] = { 0, 0 } }, 0))
        assert.are.equal(1, escort.progress(o, transportCtx({}, 1)))
    end)

    it("describes itself by direction", function()
        local out = { forTeam = 4, params = { transportUnitIDs = { 7 }, extractArea = ZONE } }
        escort.init(out, transportCtx({ [7] = { 0, 0 } }, 0))
        assert.are.equal('Escort the transport out', escort.describe(out))
        local inb = { forTeam = 4, params = {
            transportUnitIDs = { 7 }, extractArea = ZONE, direction = 'inbound' } }
        escort.init(inb, transportCtx({ [7] = { 0, 0 } }, 0))
        assert.are.equal('Escort the inbound transport to its drop zone', escort.describe(inb))
    end)

    it("keeps the convoy form working unchanged (§10.3: flavour, not deleted)", function()
        local o = { forTeam = 4, params = {
            payloadUnitIDs = { 1, 2 }, destArea = { x = 1000, z = 0, r = 50 }, quorum = 2 } }
        escort.init(o, fakeCtx({ [1] = { 0, 0 }, [2] = { 0, 0 } }))
        assert.is_nil(escort.check(o, fakeCtx({ [1] = { 1000, 0 }, [2] = { 0, 0 } })))
        local state = escort.check(o, fakeCtx({ [1] = { 1000, 0 }, [2] = { 1000, 0 } }))
        assert.are.equal('complete', state)
        assert.are.equal('Escort convoy to destination', escort.describe(o))
    end)

    it("works with no ctx.withdrawnTransports at all (older callers)", function()
        local o = { forTeam = 4, params = { transportUnitIDs = { 7 }, extractArea = ZONE } }
        escort.init(o, fakeCtx({ [7] = { 0, 0 } }))
        assert.is_nil(escort.check(o, fakeCtx({ [7] = { 0, 0 } })))
        assert.are.equal('failed', escort.check(o, fakeCtx({})))
    end)
end)
