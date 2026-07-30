-- tools/scripts/lua-to-json.lua — minimal Lua-table -> JSON exporter for
-- Metalstorm's shared spec files (PLAN-metalstorm-authority.md task 5, A3:
-- "Export LuaRules/Configs/authority_cost.lua -> JSON alongside the def
-- export"). No external deps: a hand-rolled encoder, sufficient for
-- plain-data config tables (strings/numbers/booleans/nested tables) — NOT
-- a general Lua-VM serializer (no functions, no cycles, no userdata).
--
-- Why a standalone script rather than a C++ engine addition: the game's
-- static data (data/games/metalstorm/**) is served as-is by the static-data
-- pipeline (client/vite-static-data-plugin.ts dev, nginx/CDN prod — see
-- AGENTS.md "Resolved Design Decisions" / production deployment notes) at
-- `/api/games/data/<gameId>/...`. Writing `authority_cost.json` straight
-- into `data/games/metalstorm/` makes it servable with zero server code —
-- the "same pattern as defs -> JSON" the plan calls for, using the
-- lightest mechanism that already exists rather than adding a new C++
-- export path. Keys are sorted for a deterministic, diffable output
-- (canonical form, matching LuaDefsSerializer's convention).
--
-- Usage: lua tools/scripts/lua-to-json.lua <input.lua> <output.json>

local inPath, outPath = arg[1], arg[2]
if not inPath or not outPath then
    io.stderr:write("usage: lua-to-json.lua <input.lua> <output.json>\n")
    os.exit(1)
end

local chunk, loadErr = loadfile(inPath)
if not chunk then
    io.stderr:write("lua-to-json: failed to load " .. inPath .. ": " .. tostring(loadErr) .. "\n")
    os.exit(1)
end
local data = chunk()

local function isArray(t)
    local n = 0
    for _ in pairs(t) do n = n + 1 end
    if n == 0 then return false end -- empty table -> object {}
    for i = 1, n do
        if t[i] == nil then return false end
    end
    return true
end

local encodeValue

local function encodeString(s)
    local out = s:gsub('[%c"\\]', function(c)
        if c == '"' then return '\\"' end
        if c == '\\' then return '\\\\' end
        if c == '\n' then return '\\n' end
        if c == '\t' then return '\\t' end
        if c == '\r' then return '\\r' end
        return string.format('\\u%04x', c:byte())
    end)
    return '"' .. out .. '"'
end

local function encodeArray(t)
    local parts = {}
    for i = 1, #t do parts[i] = encodeValue(t[i]) end
    return '[' .. table.concat(parts, ',') .. ']'
end

local function encodeObject(t)
    local keys = {}
    for k in pairs(t) do keys[#keys + 1] = k end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    local parts = {}
    for _, k in ipairs(keys) do
        parts[#parts + 1] = encodeString(tostring(k)) .. ':' .. encodeValue(t[k])
    end
    return '{' .. table.concat(parts, ',') .. '}'
end

encodeValue = function(v)
    local ty = type(v)
    if ty == 'string' then
        return encodeString(v)
    elseif ty == 'number' then
        return tostring(v)
    elseif ty == 'boolean' then
        return tostring(v)
    elseif ty == 'table' then
        if isArray(v) then return encodeArray(v) else return encodeObject(v) end
    else
        error('lua-to-json: cannot encode value of type ' .. ty)
    end
end

local f = assert(io.open(outPath, 'w'))
f:write(encodeValue(data))
f:write('\n')
f:close()
