-- tests/guidance_wire_spec.lua — the TS↔Lua codec contract, and the client's
-- guidance messages driven through the REAL gadget
-- (PLAN-metalstorm-command-language.md §6.1, §8 "codec cross-test").
--
-- Run from the plugin root:
--   cd data/games/metalstorm/LuaRules/Gadgets && busted tests/
--
-- Every wire string here comes out of `parley/tests/wire-fixtures.tsv`, the SAME
-- file client/src/ui/native-ui/guidance-wire.test.ts reads. The TS side proves it
-- encodes those exact bytes; this side proves Lua decodes them and that
-- game_ai_guidance.lua actually moves its store when it receives them. A change
-- to either encoder that isn't matched on the other side turns one of the two
-- suites red.
--
-- Why a TSV and not JSON: this spec has no JSON decoder in scope (busted runs
-- with `package.path = './?.lua'` inside the plugin), and vendoring one to share
-- test data would be a worse dependency than a two-rule text format. The format
-- is documented at the top of the fixture file.

package.path = './?.lua;' .. package.path

local mock = require('tests.parley_mock')
local Wire = require('parley.wire')

local FIXTURE_PATH = 'parley/tests/wire-fixtures.tsv'

--- Split one TSV line into columns. A trailing tab is appended so the last
--- column is matched like every other one.
local function columns(line)
    local cols = {}
    for col in (line .. '\t'):gmatch('([^\t]*)\t') do cols[#cols + 1] = col end
    return cols
end

--- Split a comma-joined list literal from the fixture file.
local function splitList(value)
    local out = {}
    for item in tostring(value):gmatch('[^,]+') do out[#out + 1] = item end
    return out
end

--- Load the shared fixtures: { cmd, wire, fields = {k -> v}, lists = {k -> {v}} }.
--- `fields` holds what DECODE must produce (list fields stay comma-joined, which
--- is exactly what the codec puts on the wire); `lists` is the split form, for
--- asserting Wire.list.
local function loadFixtures()
    local file = io.open(FIXTURE_PATH, 'r')
    assert(file, 'cannot open ' .. FIXTURE_PATH .. ' — run busted from LuaRules/Gadgets/')
    local fixtures = {}
    for line in file:lines() do
        if line ~= '' and line:sub(1, 1) ~= '#' then
            local cols = columns(line)
            local fixture = { cmd = cols[1], wire = cols[2], fields = {}, lists = {} }
            for i = 3, #cols do
                -- Split on the FIRST '=' only: one fixture value contains an '='.
                local key, value = cols[i]:match('^([^=]*)=(.*)$')
                assert(key, 'malformed field column: ' .. tostring(cols[i]))
                if key:sub(-2) == '[]' then
                    key = key:sub(1, -3)
                    fixture.lists[key] = splitList(value)
                end
                fixture.fields[key] = value
            end
            fixtures[#fixtures + 1] = fixture
        end
    end
    file:close()
    assert(#fixtures > 0, 'no fixtures loaded from ' .. FIXTURE_PATH)
    return fixtures
end

local FIXTURES = loadFixtures()

describe("wire codec: the shared TS/Lua fixtures", function()
    it("loaded the shared fixture file", function()
        assert.is_true(#FIXTURES >= 20)
    end)

    for _, fixture in ipairs(FIXTURES) do
        it("decodes " .. fixture.wire, function()
            local cmd, fields = Wire.decode(fixture.wire)
            assert.are.equal(fixture.cmd, cmd)
            for key, expected in pairs(fixture.fields) do
                assert.are.equal(expected, fields[key],
                    ("field %q of %q"):format(key, fixture.wire))
            end
            -- Nothing EXTRA: a decoder that invented a field would still pass
            -- the loop above.
            local count = 0
            for _ in pairs(fields) do count = count + 1 end
            local expectedCount = 0
            for _ in pairs(fixture.fields) do expectedCount = expectedCount + 1 end
            assert.are.equal(expectedCount, count, 'field count for ' .. fixture.wire)
        end)

        it("round-trips " .. fixture.wire .. " through Lua's own encoder", function()
            -- Lua's pairs() order is unspecified, so the encoded STRING can't be
            -- compared byte-for-byte (that is what the TS side, which sorts,
            -- checks). What must hold here is that Lua's encoder and decoder
            -- agree with the fixture's field values.
            local encodeFields = {}
            for key, value in pairs(fixture.fields) do
                encodeFields[key] = fixture.lists[key] or value
            end
            local _, fields = Wire.decode(Wire.encode(fixture.cmd, encodeFields))
            for key, expected in pairs(fixture.fields) do
                assert.are.equal(expected, fields[key])
            end
        end)
    end

    it("splits the list field back into an array", function()
        for _, fixture in ipairs(FIXTURES) do
            for key, expected in pairs(fixture.lists) do
                local _, fields = Wire.decode(fixture.wire)
                assert.are.same(expected, Wire.list(fields[key]))
            end
        end
    end)

    it("covers all four escaped characters", function()
        -- The fixture set is only a contract if it actually exercises the
        -- escaping; a set of plain alphanumeric values would pass any encoder.
        local seen = {}
        for _, fixture in ipairs(FIXTURES) do
            for _, value in pairs(fixture.fields) do
                for char in value:gmatch('[%%&=,]') do seen[char] = true end
            end
        end
        for _, char in ipairs({ '%', '&', '=', ',' }) do
            assert.is_true(seen[char] == true, 'no fixture value contains ' .. char)
        end
    end)
end)

describe("the client's guidance messages, through the real gadget", function()
    local world, gadgetObj

    before_each(function()
        world, gadgetObj = mock.new('./game_ai_guidance.lua')
        world.setPlayer(1, 10)
        world.setPlayerPool(1, 1000)
        world.setTeamPool(10, 1000)
    end)

    --- Feed every fixture for one `guidance.*` command to the gadget in order,
    --- and hand each one's decoded fields to `check`.
    local function each(cmd, check)
        for _, fixture in ipairs(FIXTURES) do
            if fixture.cmd == cmd then
                world, gadgetObj = mock.new('./game_ai_guidance.lua')
                world.setPlayer(1, 10)
                world.setPlayerPool(1, 1000)
                world.setTeamPool(10, 1000)
                gadgetObj:RecvLuaMsg(fixture.wire, 1)
                check(fixture.fields, fixture.wire)
            end
        end
    end

    it("guidance.stance sets the stance the client encoded", function()
        each('guidance.stance', function(fields, wire)
            assert.are.equal(fields.value, GG.AIGuidance.Get(10).stance, wire)
        end)
    end)

    it("guidance.paint paints the region KEY, and 'normal' clears it", function()
        each('guidance.paint', function(fields, wire)
            local painted = GG.AIGuidance.Get(10).region_paint[fields.regionKey]
            if fields.value == 'normal' then
                assert.is_nil(painted, wire)
            else
                assert.are.equal(fields.value, painted, wire)
            end
        end)
    end)

    it("guidance.lock toggles the asset lock from locked=1/0", function()
        each('guidance.lock', function(fields, wire)
            local locked = GG.AIGuidance.Get(10).asset_locks[tonumber(fields.groupId)]
            if fields.locked == '1' then
                assert.is_true(locked, wire)
            else
                assert.is_nil(locked, wire)
            end
        end)
    end)

    it("guidance.delegate toggles delegation from delegated=1/0", function()
        each('guidance.delegate', function(fields, wire)
            local delegated = GG.AIGuidance.Get(10).delegated[tonumber(fields.objectiveId)]
            if fields.delegated == '1' then
                assert.is_true(delegated, wire)
            else
                assert.is_nil(delegated, wire)
            end
        end)
    end)

    it("guidance.roe sets the rules of engagement", function()
        each('guidance.roe', function(fields, wire)
            assert.are.equal(fields.value, GG.AIGuidance.Get(10).roe, wire)
        end)
    end)

    it("guidance.veto blacklists the goal id", function()
        each('guidance.veto', function(fields, wire)
            assert.is_number(GG.AIGuidance.Get(10).veto[tonumber(fields.goalId)], wire)
        end)
    end)

    it("guidance.fund applies the rate cap and charges the one-shot amount", function()
        each('guidance.fund', function(fields, wire)
            local funding = GG.AIGuidance.Get(10).funding
            if fields.rateCap then
                assert.are.equal(tonumber(fields.rateCap), funding.rateCap, wire)
            end
            if fields.amount then
                -- setFunding charges the player then awards the team pool; the
                -- charge log is the observable proof it went through Authority
                -- rather than minting authority out of nothing.
                assert.are.equal(1, #world.chargeLog, wire)
                assert.are.equal(tonumber(fields.amount), world.chargeLog[1].cost, wire)
            end
        end)
    end)

    it("ignores a command it doesn't know, leaving the store at its defaults", function()
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.nonsense', { value = 'aggressive' }), 1)
        assert.are.equal('balanced', GG.AIGuidance.Get(10).stance)
    end)
end)
