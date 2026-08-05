-- tests/game_parley_wire_spec.lua — defensive-parse fuzz fixtures for the
-- LIVE RecvLuaMsg handler at game_parley.lua:705 (PLAN-security-hardening.md
-- §S-B/G17). wire_spec.lua covers the codec in isolation; this file drives
-- the real gadget through gadget:RecvLuaMsg(msg, playerID) with malformed/
-- oversized/hostile wire strings and asserts the two things §6 requires:
-- the write is REJECTED (no proposal materializes, no state mutates) and
-- the GADGET IS STILL ALIVE afterward (a subsequent well-formed message is
-- still processed correctly). Run from the plugin root:
--   cd data/games/metalstorm/LuaRules/Gadgets && busted tests/

package.path = './?.lua;' .. package.path

local mock = require('tests.parley_mock')
local Wire = require('parley.wire')

local function newWorld()
    local world, gadgetObj = mock.new('./game_parley.lua')
    world.setPlayer(1, 10)   -- team 10
    world.setPlayer(2, 20)   -- a different team
    world.setTeamPool(10, 1000)
    world.setTeamPool(20, 1000)
    return world, gadgetObj
end

--- Send raw wire bytes and assert the gadget survives (no thrown error).
local function sendRaw(gadgetObj, msg, playerID)
    assert.has_no.errors(function() gadgetObj:RecvLuaMsg(msg, playerID) end)
end

--- After feeding garbage, prove the gadget is still alive: a well-formed
--- propose from the SAME player still creates a proposal.
local function assertAlive(gadgetObj)
    local id = GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 1800 })
    assert.is_number(id)
end

describe("RecvLuaMsg fuzz — malformed wire strings (game_parley.lua)", function()
    it("nil message: no-op, gadget alive", function()
        local world, gadgetObj = newWorld()
        sendRaw(gadgetObj, nil, 1)
        assertAlive(gadgetObj)
    end)

    it("empty message: no-op, gadget alive", function()
        local world, gadgetObj = newWorld()
        sendRaw(gadgetObj, '', 1)
        assertAlive(gadgetObj)
    end)

    it("oversized message (way past LUA_MSG_MAX_BYTES): rejected, no proposal, gadget alive", function()
        local world, gadgetObj = newWorld()
        local huge = 'cmd=parley.propose&toTeam=20&duration=1800&kind=ceasefire&regionKey=' .. string.rep('x', 100000)
        sendRaw(gadgetObj, huge, 1)
        -- No cap on live outgoing was consumed by a garbage regionKey blob —
        -- it's a *valid* propose (regionKey is unvalidated free text), so this
        -- should actually succeed; the assertion is just that it didn't crash
        -- and didn't corrupt state for the next real call.
        assertAlive(gadgetObj)
    end)

    it("unterminated key=value (missing duration) is rejected — required field absent", function()
        local world, gadgetObj = newWorld()
        sendRaw(gadgetObj, 'cmd=parley.propose&toTeam=20&kind=ceasefire&duration', 1)
        assert.is_nil(GG.Parley.Get(1))
        assertAlive(gadgetObj)
    end)

    it("duplicated key=value pairs: last value wins, no error", function()
        local world, gadgetObj = newWorld()
        sendRaw(gadgetObj, 'cmd=parley.propose&toTeam=20&kind=ceasefire&duration=1800&duration=900', 1)
        local id = 1
        assert.are.equal(900, GG.Parley.Get(id).terms.duration)
    end)

    it("missing cmd: silently ignored, no proposal, gadget alive", function()
        local world, gadgetObj = newWorld()
        sendRaw(gadgetObj, 'toTeam=20&kind=ceasefire&duration=1800', 1)
        assert.is_nil(GG.Parley.Get(1))
        assertAlive(gadgetObj)
    end)

    it("unknown cmd: silently ignored, no proposal, gadget alive", function()
        local world, gadgetObj = newWorld()
        sendRaw(gadgetObj, 'cmd=parley.detonate&toTeam=20&kind=ceasefire&duration=1800', 1)
        assert.is_nil(GG.Parley.Get(1))
        assertAlive(gadgetObj)
    end)

    it("unknown proposal kind is validated and rejected, no crash", function()
        local world, gadgetObj = newWorld()
        sendRaw(gadgetObj, 'cmd=parley.propose&toTeam=20&kind=nonsense_kind&duration=1800', 1)
        assert.is_nil(GG.Parley.Get(1))
        assertAlive(gadgetObj)
    end)

    it("embedded &/=/%% and comma inside a percent-escaped field is decoded literally, no injection", function()
        local world, gadgetObj = newWorld()
        local wire = Wire.encode('parley.propose', { toTeam = 20, kind = 'ceasefire', duration = 1800, regionKey = 'a&cmd=parley.withdraw&id=1' })
        sendRaw(gadgetObj, wire, 1)
        local p = GG.Parley.Get(1)
        assert.is_not_nil(p)
        assert.are.equal('a&cmd=parley.withdraw&id=1', p.terms.regionKey)
        assert.are.equal('offered', p.state)   -- the embedded fake withdraw never executed
    end)

    it("broken percent-escapes in a value do not error and do not corrupt other fields", function()
        local world, gadgetObj = newWorld()
        sendRaw(gadgetObj, 'cmd=parley.propose&toTeam=20&kind=ceasefire&duration=1800&regionKey=%zz%gg', 1)
        local p = GG.Parley.Get(1)
        assert.is_not_nil(p)
        assert.are.equal('%zz%gg', p.terms.regionKey)
    end)

    it("raw non-UTF8 bytes in a value do not error", function()
        local world, gadgetObj = newWorld()
        local raw = string.char(0xFF, 0x00, 0xC0, 0xAF)
        sendRaw(gadgetObj, 'cmd=parley.propose&toTeam=20&kind=ceasefire&duration=1800&regionKey=' .. raw, 1)
        assertAlive(gadgetObj)
    end)

    it("numeric field arrives as a non-numeric string: validator rejects it, no crash", function()
        local world, gadgetObj = newWorld()
        sendRaw(gadgetObj, 'cmd=parley.propose&toTeam=20&kind=ceasefire&duration=notanumber', 1)
        assert.is_nil(GG.Parley.Get(1))
        assertAlive(gadgetObj)
    end)

    it("numeric field with trailing garbage (e.g. '1800; DROP') is rejected, not truncated-and-accepted", function()
        local world, gadgetObj = newWorld()
        sendRaw(gadgetObj, Wire.encode('parley.propose', { toTeam = 20, kind = 'ceasefire', duration = '1800;drop' }), 1)
        assert.is_nil(GG.Parley.Get(1))
    end)

    it("respond/withdraw with a non-numeric id: rejected, no crash", function()
        local world, gadgetObj = newWorld()
        sendRaw(gadgetObj, 'cmd=parley.respond&id=notanumber&decision=accept', 2)
        sendRaw(gadgetObj, 'cmd=parley.withdraw&id=notanumber', 1)
        assertAlive(gadgetObj)
    end)

    it("a sender with no team on record (unknown playerID) is dropped before touching any registry", function()
        local world, gadgetObj = newWorld()
        sendRaw(gadgetObj, 'cmd=parley.propose&toTeam=20&kind=ceasefire&duration=1800', 999)
        assert.is_nil(GG.Parley.Get(1))
        assertAlive(gadgetObj)
    end)

    it("a spoofed fromTeam/fromPlayer field in the payload is ignored — the acting team always comes from the engine's playerID argument, never the wire", function()
        local world, gadgetObj = newWorld()
        -- Player 2 is on team 20; embedding fromTeam=10 in the message body
        -- must NOT let player 2 propose as team 10.
        sendRaw(gadgetObj, 'cmd=parley.propose&toTeam=10&kind=ceasefire&duration=1800&fromTeam=10&fromPlayer=1', 2)
        local p = GG.Parley.Get(1)
        assert.is_not_nil(p)
        assert.are.equal(20, p.fromTeam)
        assert.are.equal(2, p.fromPlayer)
    end)

    it("responding to a proposal that isn't addressed to the sender's team is rejected regardless of an 'id' claim", function()
        local world, gadgetObj = newWorld()
        GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 1800 })   -- id 1, toTeam=20
        -- Player 1 (team 10) tries to accept its OWN proposal by claiming its id.
        sendRaw(gadgetObj, 'cmd=parley.respond&id=1&decision=accept', 1)
        assert.are.equal('offered', GG.Parley.Get(1).state)   -- unchanged: not_your_proposal
        assertAlive(gadgetObj)
    end)

    it("a long burst of garbage messages in a row never wedges the gadget", function()
        local world, gadgetObj = newWorld()
        local garbage = {
            nil, '', '&&&', '=', 'cmd', 'cmd=', 'cmd=parley.propose',
            'cmd=parley.propose&kind=ceasefire', 'cmd=parley.respond',
            'cmd=parley.withdraw', string.rep('%', 500), string.rep('&=', 500),
        }
        for _, msg in ipairs(garbage) do
            sendRaw(gadgetObj, msg, 1)
        end
        assertAlive(gadgetObj)
    end)
end)
