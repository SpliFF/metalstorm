-- tests/wire_copy_spec.lua — `ai/strategos/wire.lua` is a COPY of
-- `LuaRules/Gadgets/parley/wire.lua` (PLAN-ai-synced-write.md task 3: the AI4
-- sandbox refuses any module name escaping the plugin folder, so the AI VM
-- cannot require the original). A copy is a drift hazard with no natural
-- witness: the encoder here and the decoder in the gadget would disagree
-- silently, and the only symptom would be an `ai.intent` message the guidance
-- gadget parses into nothing — no error, just a veto loop that never closes
-- again. This spec is that witness.
--
-- Unlike its sibling specs this one is cwd-INDEPENDENT: it locates both files
-- from its own source path, because a spec whose whole subject is two files
-- disagreeing must not itself report "cannot open" as the answer. (The other
-- strategos specs `require` their subject and so still need `busted tests/`
-- from the plugin root; the full-tree `busted .` run errors on all of them.)

local HERE = (debug.getinfo(1, 'S').source:match('^@(.*)/[^/]+$') or '.') .. '/..'

local COPY     = HERE .. '/wire.lua'
local ORIGINAL = HERE .. '/../../LuaRules/Gadgets/parley/wire.lua'

-- Everything from this line on must be byte-identical to the original; above it
-- is the copy's own header explaining why it exists.
local SPLIT = '-- parley/wire.lua — RecvLuaMsg command codec'

local function slurp(path)
    local f = io.open(path, 'rb')
    if not f then return nil end
    local s = f:read('*a')
    f:close()
    return s
end

describe("wire.lua copy (PLAN-ai-synced-write task 3)", function()
    it("is byte-identical to the parley original below its header", function()
        local copy = slurp(COPY)
        local original = slurp(ORIGINAL)
        assert.is_truthy(copy, 'cannot read ' .. COPY)
        assert.is_truthy(original, 'cannot read ' .. ORIGINAL)

        local at = copy:find(SPLIT, 1, true)
        assert.is_truthy(at, 'the copy no longer carries the original header line')
        assert.are.equal(original, copy:sub(at))
    end)

    it("round-trips an ai.intent payload through the gadget's own decoder", function()
        -- Encoder from the COPY, decoder from the ORIGINAL, so this asserts
        -- the two halves of the real path agree rather than either against
        -- itself. Loaded by path, not `require`, so the spec stays cwd-free.
        local Encode = assert(loadfile(COPY))()
        local Decode = assert(loadfile(ORIGINAL))()

        local msg = Encode.encode('ai.intent',
            { goalId = 'obj:12', dt = 9, region = 'north basin & ridge' })
        local cmd, fields = Decode.decode(msg)
        assert.are.equal('ai.intent', cmd)
        assert.are.equal('obj:12', fields.goalId)   -- string ids survive intact
        assert.are.equal('9', fields.dt)
        assert.are.equal('north basin & ridge', fields.region)  -- `&` escaped/unescaped
    end)
end)
