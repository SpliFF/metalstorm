-- tests/defs_reconciled_spec.lua — what happens to an objective whose subject
-- was deleted from the game between two sessions of a war
-- (PLAN-def-reconciliation.md task 4, §6 "objective on removed def expires with
-- digest note").
--
-- THE CASE THESE COVER, said plainly: a unit whose def was removed never
-- reached the restored world at all. It was dropped from the payload during
-- staging, so there was no death and no UnitDestroyed — every callback this
-- registry resolves through is silent, and an objective naming that unit would
-- stay active for the rest of the war waiting for something that cannot happen.
-- `delta.droppedUnits` is the only notice the gadget gets.
--
-- Run from the plugin root:
--   cd data/games/metalstorm/LuaRules/Gadgets/objectives && busted tests/

package.path = './?.lua;' .. package.path

local mock = require('tests.spring_mock')

--- The mock world plus a WarLog recorder — the digest note §6 asks for is
--- emitted by resolveObjective, so it is observable without a second gadget.
local function world()
    local w, g = mock.new()
    w.warlog = {}
    GG.WarLog = {
        Emit = function(kind, subject, detail, team)
            w.warlog[#w.warlog + 1] = {
                kind = kind, subject = subject, detail = detail, team = team,
            }
        end,
    }
    return w, g
end

--- Only the field the handler reads; the rest of the delta's shape is pinned by
--- the C++ doctests and by tests/defs_reconciled_spec.lua one directory up.
local function droppedDelta(ids)
    return { droppedUnits = ids, counts = { unitsDropped = #ids } }
end

describe("an objective whose subject left with its def", function()
    it("expires a kill objective, with a digest note", function()
        local w, g = world()
        w.setUnit(40, { x = 0, z = 0, team = 2 })
        local id = GG.Objectives.Create({
            type = 'kill', forTeam = 1, reward = 50,
            params = { targetUnitID = 40 },
        })
        assert.are.equal('active', w.rp(id, 'state'))

        -- The unit is NOT killed: it simply is not in the restored world.
        w.units[40] = nil
        g:DefsReconciled(droppedDelta({ 40 }))

        assert.are.equal('expired', w.rp(id, 'state'))
        assert.are.equal(1, #w.warlog)
        assert.are.equal('objective', w.warlog[1].kind)
        assert.are.equal('kill', w.warlog[1].subject)
        assert.are.equal('expired', w.warlog[1].detail)
    end)

    it("expires rather than FAILS it, because nobody lost it", function()
        -- `failed` is a verdict on a team and it is what the war's record shows.
        -- A balance patch dissolved the subject; blaming a player for a content
        -- edit is the one disposition that is actively wrong. Both refund the
        -- escrow, so `failed` would buy nothing but the blame.
        local w, g = world()
        w.setUnit(41, { x = 0, z = 0, team = 2 })
        local id = GG.Objectives.Create({
            type = 'kill', forTeam = 1, reward = 50,
            params = { targetUnitID = 41 },
        })
        w.units[41] = nil
        g:DefsReconciled(droppedDelta({ 41 }))

        assert.are.equal('expired', w.rp(id, 'state'))
        assert.are.equal(0, #w.awards)                  -- nobody is paid the reward
        assert.are.equal(1, #w.escrowSettles)
        assert.are.equal('expired', w.escrowSettles[1].outcome)
    end)

    it("expires a protect objective on PARTIAL removal", function()
        -- Its quorum was authored against a roster that no longer exists, so an
        -- objective that keeps going is measuring something nobody agreed to.
        local w, g = world()
        w.setUnit(50, { x = 0, z = 0, team = 1 })
        w.setUnit(51, { x = 10, z = 0, team = 1 })
        w.setUnit(52, { x = 20, z = 0, team = 1 })
        local id = GG.Objectives.Create({
            type = 'protect', forTeam = 1, reward = 40,
            expiresAtFrame = 9000,
            params = { targetUnitIDs = { 50, 51, 52 } },
        })
        assert.are.equal('active', w.rp(id, 'state'))

        w.units[51] = nil
        g:DefsReconciled(droppedDelta({ 51 }))
        assert.are.equal('expired', w.rp(id, 'state'))
    end)

    it("leaves an objective whose units all survived exactly alone", function()
        -- The other half of the contract: a patch that removed a def this
        -- objective does not name must not touch it. The delta always carries
        -- the war's WHOLE dropped-unit list, not one objective's slice of it.
        local w, g = world()
        w.setUnit(60, { x = 0, z = 0, team = 2 })
        w.setUnit(61, { x = 0, z = 0, team = 2 })
        local id = GG.Objectives.Create({
            type = 'kill', forTeam = 1, reward = 50,
            params = { targetUnitID = 60 },
        })
        w.units[61] = nil
        g:DefsReconciled(droppedDelta({ 61 }))

        assert.are.equal('active', w.rp(id, 'state'))
        assert.are.equal(0, #w.warlog)
    end)

    it("does nothing at all when the patch dropped no units", function()
        -- A tuning-only patch is the common case (§3) and fires this call-in
        -- with an empty list. Every objective in the war has to survive it.
        local w, g = world()
        w.setUnit(70, { x = 0, z = 0, team = 2 })
        local id = GG.Objectives.Create({
            type = 'kill', forTeam = 1, reward = 50,
            params = { targetUnitID = 70 },
        })
        g:DefsReconciled(droppedDelta({}))
        assert.are.equal('active', w.rp(id, 'state'))
        g:DefsReconciled(nil)
        assert.are.equal('active', w.rp(id, 'state'))
    end)

    it("expires an escort whose payload was dropped, and a control objective is untouched", function()
        -- control names no units at all — it is the type with no unitRefs — so
        -- this is the assertion that a missing unitRefs is a "nothing to check"
        -- rather than an error.
        local w, g = world()
        w.regionOwner.r1 = 1
        w.keyAt = function() return 'r1' end
        w.setUnit(80, { x = 0, z = 0, team = 1 })
        w.setUnit(81, { x = 5, z = 0, team = 1 })
        local escortId = GG.Objectives.Create({
            type = 'escort', forTeam = 1, reward = 60,
            params = { payloadUnitIDs = { 80 }, destArea = { x = 900, z = 900, r = 100 } },
        })
        local controlId = GG.Objectives.Create({
            type = 'control', forTeam = 1, reward = 50,
            params = { regionKey = 'r1', holdFrames = 1800 },
        })
        assert.is_number(escortId)
        assert.is_number(controlId)

        w.units[80] = nil
        g:DefsReconciled(droppedDelta({ 80 }))

        assert.are.equal('expired', w.rp(escortId, 'state'))
        assert.are.equal('active', w.rp(controlId, 'state'))
    end)
end)
