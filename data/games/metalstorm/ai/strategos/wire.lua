-- ai/strategos/wire.lua — VERBATIM COPY of
-- `LuaRules/Gadgets/parley/wire.lua`, which is the original and the one place
-- to change the encoding. It is duplicated here because the AI4 sandbox
-- (`AIScriptContext::l_require`) refuses any module name that escapes the
-- plugin folder, so the AI VM physically cannot reach into `LuaRules/` — and
-- the AI's `ai.intent` message (PLAN-ai-synced-write.md §2.5) must be encoded
-- with the SAME codec the guidance gadget decodes it with.
--
-- ⚠ If you change the encoding, change BOTH files: the decoder lives in the
-- gadget and this copy is the encoder for one sender. `tests/wire_copy_spec.lua`
-- asserts the two files are byte-identical below this header, so a one-sided
-- edit fails the strategos suite rather than silently producing a payload the
-- gadget cannot parse.
--
-- Original header follows.
--
-- parley/wire.lua — RecvLuaMsg command codec (PLAN-metalstorm-interaction.md
-- §1 "no new wire" — proposals/guidance ride the EXISTING
-- Spring.SendLuaRulesMsg / gadget:RecvLuaMsg pair, unlike bounties/markers
-- which the native-ui widgets still stand in behind an unwired
-- `ctx.sendCommand` — see objectives-panel.js's header for that gap).
--
-- FIRST-MOVER NOTE: no gadget in this codebase has parsed a RecvLuaMsg
-- payload before (grepped clean — every other gadget is driven purely by
-- engine callins + GG.* calls). There is therefore no established encoding
-- to reuse. This module defines one: a flat `cmd=name&key=value&...`
-- query-string shape (percent-escaped, comma-joins tables), simple enough
-- to hand-construct from a client widget with no JSON dependency, and pure/
-- busted-testable with no Spring mock needed. Revisit if PLAN-messages.md's
-- pub-sub migration wants a richer shape (interaction §1 already flags that
-- migration as "an optimisation, not a gate").
local M = {}

local function escape(v)
    return (tostring(v):gsub('[%%&=,]', function(c)
        return string.format('%%%02X', c:byte())
    end))
end

local function unescape(s)
    return (s:gsub('%%(%x%x)', function(h) return string.char(tonumber(h, 16)) end))
end

--- Encode a command + flat field table into a wire string. Table-valued
--- fields (e.g. a corridor region-key list) are comma-joined; nil-valued
--- fields are omitted.
function M.encode(cmd, fields)
    local parts = { 'cmd=' .. escape(cmd) }
    for k, v in pairs(fields or {}) do
        if v ~= nil then
            if type(v) == 'table' then
                local items = {}
                for _, item in ipairs(v) do items[#items + 1] = escape(tostring(item)) end
                v = table.concat(items, ',')
            else
                v = escape(tostring(v))
            end
            parts[#parts + 1] = escape(k) .. '=' .. v
        end
    end
    return table.concat(parts, '&')
end

--- Decode a wire string into (cmd, fields). Every field value arrives as a
--- STRING (callers coerce numbers/lists themselves — this module has no
--- schema knowledge of which command expects what shape).
function M.decode(msg)
    local fields = {}
    for kv in tostring(msg or ''):gmatch('[^&]+') do
        local k, v = kv:match('^([^=]+)=(.*)$')
        if k then fields[unescape(k)] = unescape(v) end
    end
    local cmd = fields.cmd
    fields.cmd = nil
    return cmd, fields
end

--- Split a comma-joined list field back into a plain array. Returns {} for
--- nil/empty input (never nil — callers can #-iterate unconditionally).
function M.list(v)
    local out = {}
    if not v or v == '' then return out end
    for item in tostring(v):gmatch('[^,]+') do out[#out + 1] = item end
    return out
end

--- Coerce a decoded string field to a number, or nil if absent/non-numeric.
function M.num(v)
    if v == nil then return nil end
    return tonumber(v)
end

return M
