-- tests/wire_spec.lua — defensive-parse fuzz fixtures for
-- parley/wire.lua (PLAN-security-hardening.md §S-B/G17). This is the
-- codec's OWN contract, independent of any gadget: M.decode must never
-- error and must never let a malformed wire string produce a field the
-- caller didn't ask for. Pure module, no Spring mock needed (see
-- wire.lua's header) — run from the plugin root:
--   cd data/games/metalstorm/LuaRules/Gadgets && busted tests/

package.path = './?.lua;' .. package.path

local Wire = require('parley.wire')

describe("M.decode — malformed input never errors", function()
    it("nil message -> no cmd, no fields", function()
        local cmd, fields = Wire.decode(nil)
        assert.is_nil(cmd)
        assert.are.same({}, fields)
    end)

    it("empty message -> no cmd, no fields", function()
        local cmd, fields = Wire.decode('')
        assert.is_nil(cmd)
        assert.are.same({}, fields)
    end)

    it("oversized message (64KB, well past LUA_MSG_MAX_BYTES) decodes without error", function()
        local huge = 'cmd=parley.propose&' .. string.rep('regionKeys=' .. string.rep('x', 200) .. '&', 300)
        local cmd, fields
        assert.has_no.errors(function() cmd, fields = Wire.decode(huge) end)
        assert.are.equal('parley.propose', cmd)
    end)

    it("a single oversized token with no '=' at all is dropped, not errored", function()
        local msg = string.rep('a', 1000000)   -- one giant key, no delimiter
        local cmd, fields
        assert.has_no.errors(function() cmd, fields = Wire.decode(msg) end)
        assert.is_nil(cmd)
        assert.are.same({}, fields)
    end)

    it("unterminated key (no '=value') is dropped, not errored", function()
        local cmd, fields = Wire.decode('cmd=parley.propose&duration')
        assert.are.equal('parley.propose', cmd)
        assert.is_nil(fields.duration)
    end)

    it("duplicated key=value pairs: last write wins, no error", function()
        local cmd, fields = Wire.decode('cmd=parley.propose&duration=1800&duration=900')
        assert.are.equal('parley.propose', cmd)
        assert.are.equal('900', fields.duration)
    end)

    it("duplicated cmd= itself: last write wins", function()
        local cmd = Wire.decode('cmd=a&cmd=b')
        assert.are.equal('b', cmd)
    end)

    it("missing cmd entirely -> nil cmd, other fields still parsed", function()
        local cmd, fields = Wire.decode('duration=1800&kind=ceasefire')
        assert.is_nil(cmd)
        assert.are.equal('1800', fields.duration)
    end)

    it("empty cmd value ('cmd=') decodes to an empty string, not nil", function()
        -- Callers check `if not cmd then return end` — an empty string is
        -- truthy in Lua, so this must not be conflated with "no cmd".
        local cmd = Wire.decode('cmd=')
        assert.are.equal('', cmd)
    end)

    it("bare '&' separators and empty segments produce no fields", function()
        local cmd, fields = Wire.decode('&&&cmd=x&&&')
        assert.are.equal('x', cmd)
        assert.are.same({}, fields)
    end)

    it("a bare '=' with empty key/value is dropped", function()
        local cmd, fields = Wire.decode('cmd=x&=&k=v')
        assert.are.equal('x', cmd)
        assert.are.equal('v', fields.k)
    end)

    it("embedded literal &/=/%% inside a value, percent-escaped, round-trips", function()
        local wire = Wire.encode('parley.propose', { regionKey = 'a&b=c%d,e' })
        local cmd, fields = Wire.decode(wire)
        assert.are.equal('parley.propose', cmd)
        assert.are.equal('a&b=c%d,e', fields.regionKey)
    end)

    it("broken percent-escape (non-hex digits) is left as literal text, not errored", function()
        local cmd, fields
        assert.has_no.errors(function()
            cmd, fields = Wire.decode('cmd=x&regionKey=%zz')
        end)
        assert.are.equal('%zz', fields.regionKey)
    end)

    it("trailing bare '%' with no digits at all is left as literal text", function()
        local cmd, fields
        assert.has_no.errors(function()
            cmd, fields = Wire.decode('cmd=x&regionKey=abc%')
        end)
        assert.are.equal('abc%', fields.regionKey)
    end)

    it("raw non-UTF8 / non-ASCII bytes in a value do not error", function()
        local raw = string.char(0xFF, 0xFE, 0x00, 0x80, 0x01)
        local cmd, fields
        assert.has_no.errors(function()
            cmd, fields = Wire.decode('cmd=x&blob=' .. raw)
        end)
        assert.are.equal('x', cmd)
        assert.are.equal(raw, fields.blob)
    end)

    it("unknown cmd values decode fine — validity is the gadget's job, not the codec's", function()
        local cmd, fields = Wire.decode('cmd=totally.unknown.verb&x=1')
        assert.are.equal('totally.unknown.verb', cmd)
        assert.are.equal('1', fields.x)
    end)
end)

describe("M.num — numeric fields arriving as garbage", function()
    it("nil -> nil", function()
        assert.is_nil(Wire.num(nil))
    end)
    it("empty string -> nil", function()
        assert.is_nil(Wire.num(''))
    end)
    it("non-numeric string -> nil, not an error", function()
        assert.is_nil(Wire.num('notanumber'))
    end)
    it("a number with trailing garbage -> nil (not silently truncated)", function()
        assert.is_nil(Wire.num('1800abc'))
    end)
    it("a well-formed number string -> the number", function()
        assert.are.equal(1800, Wire.num('1800'))
    end)
    it("hex-looking garbage that tonumber would accept stays a plain number", function()
        assert.are.equal(0, Wire.num('0x0'))
    end)
end)

describe("M.list — malformed comma lists", function()
    it("nil -> {} (never nil, callers #-iterate unconditionally)", function()
        assert.are.same({}, Wire.list(nil))
    end)
    it("empty string -> {}", function()
        assert.are.same({}, Wire.list(''))
    end)
    it("doubled/trailing commas do not produce empty entries or error", function()
        assert.are.same({ 'a', 'b' }, Wire.list('a,,b,'))
    end)
    it("a huge list decodes without error", function()
        local parts = {}
        for i = 1, 5000 do parts[i] = 'k' .. i end
        local joined = table.concat(parts, ',')
        local out
        assert.has_no.errors(function() out = Wire.list(joined) end)
        assert.are.equal(5000, #out)
    end)
end)
