-- json.lua — encode-only JSON, trimmed from tools/ai-eval/json.lua.
--
-- A copy, not a require of the original: AIScriptContext's plugin-scoped
-- `require` resolves only inside this plugin's own folder (the same reason
-- garrison keeps a `lib` symlink instead of reaching out of its tree — see
-- docs/ai-players.md F3/P3), and the AI VM's Lua only opens
-- base/table/string/math/utf8, so nothing here may touch `io`. Encode-only:
-- this plugin never needs to decode anything.

local json = {}

local ARRAY_MT = { __jsonarray = true }

function json.array(t)
    return setmetatable(t or {}, ARRAY_MT)
end

local function isArray(t)
    if getmetatable(t) == ARRAY_MT then return true end
    return next(t) ~= nil and #t > 0
end

local ESCAPES = {
    ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f',
    ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t',
}

local function encodeString(s)
    return '"' .. s:gsub('[%z\1-\31\\"]', function(c)
        return ESCAPES[c] or string.format('\\u%04x', c:byte())
    end) .. '"'
end

local function encodeNumber(n)
    if n ~= n or n == math.huge or n == -math.huge then return 'null' end
    if math.type and math.type(n) == 'integer' then return string.format('%d', n) end
    if n == math.floor(n) and math.abs(n) < 1e15 then return string.format('%d', n) end
    return (string.format('%.6g', n))
end

local function encodeValue(v)
    local t = type(v)
    if v == nil then return 'null' end
    if t == 'boolean' then return tostring(v) end
    if t == 'number' then return encodeNumber(v) end
    if t == 'string' then return encodeString(v) end
    if t ~= 'table' then return encodeString(tostring(v)) end

    if isArray(v) then
        if #v == 0 then return '[]' end
        local parts = {}
        for i = 1, #v do parts[i] = encodeValue(v[i]) end
        return '[' .. table.concat(parts, ',') .. ']'
    end
    local keys = {}
    for k in pairs(v) do if type(k) == 'string' or type(k) == 'number' then keys[#keys + 1] = k end end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    if #keys == 0 then return '{}' end
    local parts = {}
    for i, k in ipairs(keys) do
        parts[i] = encodeString(tostring(k)) .. ':' .. encodeValue(v[k])
    end
    return '{' .. table.concat(parts, ',') .. '}'
end

--- encode(value) -> a single-line JSON string (deterministic key order, so
-- two captures of the same tick diff cleanly).
function json.encode(v)
    return encodeValue(v)
end

return json
