-- parley/tests/wire_spec.lua — RecvLuaMsg codec. Run from LuaRules/Gadgets/parley:
--   busted tests/
package.path = './?.lua;' .. package.path

local Wire = require('wire')

describe("Wire.encode/decode round trip", function()
    it("round-trips a simple command with scalar fields", function()
        local msg = Wire.encode('parley.propose', { kind = 'ceasefire', toTeam = 2, duration = 1800 })
        local cmd, fields = Wire.decode(msg)
        assert.are.equal('parley.propose', cmd)
        assert.are.equal('ceasefire', fields.kind)
        assert.are.equal('2', fields.toTeam)
        assert.are.equal('1800', fields.duration)
    end)

    it("comma-joins a table field and Wire.list splits it back", function()
        local msg = Wire.encode('parley.propose', { kind = 'safe_passage', corridor = { 'basin_a', 'basin_b' } })
        local cmd, fields = Wire.decode(msg)
        assert.are.equal('parley.propose', cmd)
        assert.are.same({ 'basin_a', 'basin_b' }, Wire.list(fields.corridor))
    end)

    it("percent-escapes reserved characters (&, =, %, ,)", function()
        local msg = Wire.encode('cmd', { orElse = 'pay & obey, or=else' })
        local _, fields = Wire.decode(msg)
        assert.are.equal('pay & obey, or=else', fields.orElse)
    end)

    it("omits nil-valued fields entirely", function()
        local msg = Wire.encode('cmd', { present = 1, absent = nil })
        local _, fields = Wire.decode(msg)
        assert.are.equal('1', fields.present)
        assert.is_nil(fields.absent)
    end)

    it("Wire.list returns an empty array for a nil/empty field", function()
        assert.are.same({}, Wire.list(nil))
        assert.are.same({}, Wire.list(''))
    end)

    it("Wire.num coerces numeric strings and passes through nil", function()
        assert.are.equal(42, Wire.num('42'))
        assert.is_nil(Wire.num(nil))
        assert.is_nil(Wire.num('not_a_number'))
    end)

    it("decode of an empty/garbage string yields a nil cmd", function()
        local cmd = Wire.decode('')
        assert.is_nil(cmd)
    end)
end)
