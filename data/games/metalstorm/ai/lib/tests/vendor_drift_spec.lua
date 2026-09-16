-- lib/tests/vendor_drift_spec.lua — the vendored copies under lib/vendor/ are
-- byte-identical to their synced originals below the "Original follows."
-- header line. A one-sided edit fails here rather than silently producing a
-- cost preview or a wire payload the sim disagrees with.
--
-- cwd-INDEPENDENT (locates files from its own source path), like strategos'
-- wire_copy_spec: a spec whose subject is two files disagreeing must not
-- itself report "cannot open" as the answer.

local HERE = (debug.getinfo(1, 'S').source:match('^@(.*)/[^/]+$') or '.')
local LIB  = HERE .. '/..'
local GAME = LIB .. '/../..'

local PAIRS = {
    { copy = LIB .. '/vendor/formula.lua',
      original = GAME .. '/LuaRules/Gadgets/authority/formula.lua' },
    { copy = LIB .. '/vendor/authority_cost.lua',
      original = GAME .. '/LuaRules/Configs/authority_cost.lua' },
    { copy = LIB .. '/vendor/wire.lua',
      original = GAME .. '/LuaRules/Gadgets/parley/wire.lua' },
}

local SPLIT = '-- Original follows.\n--\n'

local function slurp(path)
    local f = io.open(path, 'rb')
    if not f then return nil end
    local s = f:read('*a')
    f:close()
    return s
end

describe("lib/vendor copies", function()
    for _, pair in ipairs(PAIRS) do
        it(pair.copy:match('[^/]+$') .. " is byte-identical to its original below the header", function()
            local copy = slurp(pair.copy)
            local original = slurp(pair.original)
            assert.is_truthy(copy, 'cannot read ' .. pair.copy)
            assert.is_truthy(original, 'cannot read ' .. pair.original)
            local at, stop = copy:find(SPLIT, 1, true)
            assert.is_truthy(at, 'copy lacks the "Original follows." header')
            assert.are.equal(original, copy:sub(stop + 1),
                'vendored copy has drifted from ' .. pair.original .. ' — re-copy it')
        end)
    end
end)
