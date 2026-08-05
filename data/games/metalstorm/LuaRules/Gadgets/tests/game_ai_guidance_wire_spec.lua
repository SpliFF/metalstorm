-- tests/game_ai_guidance_wire_spec.lua — defensive-parse fuzz fixtures for
-- the LIVE RecvLuaMsg handler at game_ai_guidance.lua:329
-- (PLAN-security-hardening.md §S-B/G17). game_ai_guidance_spec.lua already
-- covers valid writes and the ONE semantically-invalid case (bogus stance
-- value) plus the ownership guarantee (acting team always derives from
-- playerID, never a wire field — see its "spoofed team" test); this file
-- adds the missing structurally-broken-wire coverage: malformed/oversized/
-- hostile strings fed straight into gadget:RecvLuaMsg. The assertion is
-- always the same two things §6 requires: the write is REJECTED (no store
-- mutation) and the gadget is still alive (a subsequent well-formed message
-- still lands). Run from the plugin root:
--   cd data/games/metalstorm/LuaRules/Gadgets && busted tests/

package.path = './?.lua;' .. package.path

local mock = require('tests.parley_mock')
local Wire = require('parley.wire')

local function newWorld()
    local world, gadgetObj = mock.new('./game_ai_guidance.lua')
    world.setPlayer(1, 10)   -- team member of 10
    world.setPlayer(2, 20)   -- a different team
    return world, gadgetObj
end

local function sendRaw(gadgetObj, msg, playerID)
    assert.has_no.errors(function() gadgetObj:RecvLuaMsg(msg, playerID) end)
end

--- After feeding garbage, prove the gadget is still alive: a well-formed
--- stance change from the same player still lands.
local function assertAlive(gadgetObj)
    gadgetObj:RecvLuaMsg(Wire.encode('guidance.stance', { value = 'aggressive' }), 1)
    assert.are.equal('aggressive', GG.AIGuidance.Get(10).stance)
end

describe("RecvLuaMsg fuzz — malformed wire strings (game_ai_guidance.lua)", function()
    it("nil message: no-op, gadget alive", function()
        local world, gadgetObj = newWorld()
        sendRaw(gadgetObj, nil, 1)
        assert.are.equal('balanced', GG.AIGuidance.Get(10).stance)
        assertAlive(gadgetObj)
    end)

    it("empty message: no-op, gadget alive", function()
        local world, gadgetObj = newWorld()
        sendRaw(gadgetObj, '', 1)
        assert.are.equal('balanced', GG.AIGuidance.Get(10).stance)
        assertAlive(gadgetObj)
    end)

    it("oversized message (way past LUA_MSG_MAX_BYTES) does not error and does not corrupt state", function()
        local world, gadgetObj = newWorld()
        local huge = 'cmd=guidance.paint&regionKey=' .. string.rep('x', 200000) .. '&value=priority'
        sendRaw(gadgetObj, huge, 1)
        assertAlive(gadgetObj)
    end)

    it("unterminated key=value (missing value) is rejected — nil value fails validation", function()
        local world, gadgetObj = newWorld()
        sendRaw(gadgetObj, 'cmd=guidance.stance&value', 1)
        assert.are.equal('balanced', GG.AIGuidance.Get(10).stance)
        assertAlive(gadgetObj)
    end)

    it("duplicated key=value pairs: last value wins, no error", function()
        local world, gadgetObj = newWorld()
        sendRaw(gadgetObj, 'cmd=guidance.stance&value=defensive&value=aggressive', 1)
        assert.are.equal('aggressive', GG.AIGuidance.Get(10).stance)
    end)

    it("missing cmd: silently ignored, no mutation, gadget alive", function()
        local world, gadgetObj = newWorld()
        sendRaw(gadgetObj, 'value=aggressive', 1)
        assert.are.equal('balanced', GG.AIGuidance.Get(10).stance)
        assertAlive(gadgetObj)
    end)

    it("unknown cmd: silently ignored, no mutation, gadget alive", function()
        local world, gadgetObj = newWorld()
        sendRaw(gadgetObj, 'cmd=guidance.detonate&value=aggressive', 1)
        assert.are.equal('balanced', GG.AIGuidance.Get(10).stance)
        assertAlive(gadgetObj)
    end)

    it("bogus stance value structurally well-formed but semantically invalid is rejected", function()
        local world, gadgetObj = newWorld()
        sendRaw(gadgetObj, 'cmd=guidance.stance&value=%00%01%02', 1)
        assert.are.equal('balanced', GG.AIGuidance.Get(10).stance)
        assertAlive(gadgetObj)
    end)

    it("embedded &/=/%% and comma inside a percent-escaped region key round-trips without breaking the parser", function()
        local world, gadgetObj = newWorld()
        local wire = Wire.encode('guidance.paint', { regionKey = 'a&cmd=guidance.veto&goalId=1', value = 'priority' })
        sendRaw(gadgetObj, wire, 1)
        assert.are.equal('priority', GG.AIGuidance.Get(10).region_paint['a&cmd=guidance.veto&goalId=1'])
        assert.are.same({}, GG.AIGuidance.Get(10).veto)   -- the embedded fake veto never executed
    end)

    it("broken percent-escapes in a value do not error and do not corrupt other fields", function()
        local world, gadgetObj = newWorld()
        sendRaw(gadgetObj, 'cmd=guidance.paint&regionKey=basin_a&value=%zz%gg', 1)
        assertAlive(gadgetObj)
    end)

    it("raw non-UTF8 bytes in a value do not error", function()
        local world, gadgetObj = newWorld()
        local raw = string.char(0xFF, 0x00, 0xC0, 0xAF)
        sendRaw(gadgetObj, 'cmd=guidance.paint&regionKey=' .. raw .. '&value=priority', 1)
        assertAlive(gadgetObj)
    end)

    it("numeric field arrives as a non-numeric string: coerced to nil, requireMember/nil-goalId guards reject it", function()
        local world, gadgetObj = newWorld()
        sendRaw(gadgetObj, 'cmd=guidance.lock&groupId=notanumber&locked=1', 1)
        assert.are.same({}, GG.AIGuidance.Get(10).asset_locks)
        assertAlive(gadgetObj)
    end)

    it("guidance.fund with a non-numeric amount does not charge or crash", function()
        local world, gadgetObj = newWorld()
        sendRaw(gadgetObj, 'cmd=guidance.fund&amount=not_a_number&rateCap=also_not_a_number', 1)
        -- Wire.num coerces both to nil: no charge attempted, rateCap left untouched.
        assert.is_nil(GG.AIGuidance.Get(10).funding.rateCap)
        assertAlive(gadgetObj)
    end)

    it("a spoofed teamID-shaped field in the payload is ignored — the acting team always comes from the engine's playerID argument, never the wire", function()
        local world, gadgetObj = newWorld()
        -- Player 2 is on team 20; embedding a teamID=10 field must NOT let
        -- player 2's write land on team 10's store.
        sendRaw(gadgetObj, 'cmd=guidance.stance&teamID=10&value=aggressive', 2)
        assert.are.equal('balanced', GG.AIGuidance.Get(10).stance)   -- unaffected
        assert.are.equal('aggressive', GG.AIGuidance.Get(20).stance)
    end)

    it("a long burst of garbage messages in a row never wedges the gadget", function()
        local world, gadgetObj = newWorld()
        local garbage = {
            nil, '', '&&&', '=', 'cmd', 'cmd=', 'cmd=guidance.stance',
            'cmd=guidance.paint', 'cmd=guidance.lock', 'cmd=guidance.fund',
            string.rep('%', 500), string.rep('&=', 500),
        }
        for _, msg in ipairs(garbage) do
            sendRaw(gadgetObj, msg, 1)
        end
        assertAlive(gadgetObj)
    end)
end)
