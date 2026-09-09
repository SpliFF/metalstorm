-- tools/scripts/dump_defs.lua — evaluate a game's def files outside the engine
-- and print them as JSON. The engine-side half of check_unit_defs.py.
--
--   lua tools/scripts/dump_defs.lua data/games/metalstorm > defs.json
--
-- Loads every units/*.lua (except _builder.lua), weapons/*.lua,
-- features/*.lua and gamedata/sounds.lua through a minimal VFS shim
-- (VFS.Include = dofile relative to the game root — the only VFS call the def
-- files make). Output shape:
--   { units = {file -> {defname -> def}}, weapons = {file -> {name -> def}},
--     features = {file -> {name -> def}}, sounds = {key -> item}, errors = [...] }
--
-- Keys are emitted as authored (NOT lowercased) so a checker can also flag
-- case drift; the engine itself lowercases every table key it reads.
-- No dkjson/cjson dependency — a tiny encoder is inlined below.

local root = arg[1]
if not root then
    io.stderr:write('usage: lua dump_defs.lua <game root>\n')
    os.exit(2)
end
root = root:gsub('/+$', '')

-- ── VFS shim ────────────────────────────────────────────────────────────────
VFS = {
    Include = function(path)
        local chunk, err = loadfile(root .. '/' .. path)
        if not chunk then error(err) end
        return chunk()
    end,
    RAW = 'r', ZIP = 'z', GAME = 'g', RAW_FIRST = 'rf', ZIP_FIRST = 'zf',
}
Spring = setmetatable({}, { __index = function(_, k)
    return function() return nil end
end })

-- ── directory listing (portable: `ls`, no lfs) ──────────────────────────────
local function listLua(dir)
    local out = {}
    local p = io.popen('ls "' .. root .. '/' .. dir .. '" 2>/dev/null')
    if not p then return out end
    for name in p:lines() do
        if name:match('%.lua$') then out[#out + 1] = name end
    end
    p:close()
    table.sort(out)
    return out
end

-- ── JSON encoder (strings, numbers, booleans, arrays, objects) ─────────────
local function isArray(t)
    local n = 0
    for k in pairs(t) do
        if type(k) ~= 'number' or k <= 0 or math.floor(k) ~= k then return false end
        n = n + 1
    end
    for i = 1, n do if t[i] == nil then return false end end
    return true
end

local encode
local function encodeString(s)
    s = s:gsub('[%c"\\]', function(c)
        if c == '"' then return '\\"' end
        if c == '\\' then return '\\\\' end
        if c == '\n' then return '\\n' end
        if c == '\t' then return '\\t' end
        if c == '\r' then return '\\r' end
        return string.format('\\u%04x', c:byte())
    end)
    return '"' .. s .. '"'
end

function encode(v, seen)
    local tv = type(v)
    if tv == 'nil' then return 'null' end
    if tv == 'boolean' then return v and 'true' or 'false' end
    if tv == 'number' then
        if v ~= v or v == math.huge or v == -math.huge then return 'null' end
        if math.floor(v) == v and math.abs(v) < 2^53 then
            return string.format('%d', v)
        end
        return string.format('%.10g', v)
    end
    if tv == 'string' then return encodeString(v) end
    if tv == 'table' then
        seen = seen or {}
        if seen[v] then return '"<cycle>"' end
        seen[v] = true
        local parts = {}
        if isArray(v) then
            for i = 1, #v do parts[i] = encode(v[i], seen) end
            seen[v] = nil
            return '[' .. table.concat(parts, ',') .. ']'
        end
        local keys = {}
        for k in pairs(v) do keys[#keys + 1] = tostring(k) end
        table.sort(keys)
        for _, k in ipairs(keys) do
            local val = v[k]
            if val == nil then val = v[tonumber(k)] end
            parts[#parts + 1] = encodeString(k) .. ':' .. encode(val, seen)
        end
        seen[v] = nil
        return '{' .. table.concat(parts, ',') .. '}'
    end
    return encodeString('<' .. tv .. '>')
end

-- ── load everything ─────────────────────────────────────────────────────────
local out = { units = {}, weapons = {}, features = {}, sounds = {}, errors = {} }

local function loadDir(dir, into, skip)
    for _, name in ipairs(listLua(dir)) do
        if name ~= skip then
            local ok, res = pcall(VFS.Include, dir .. '/' .. name)
            if not ok then
                out.errors[#out.errors + 1] = dir .. '/' .. name .. ': ' .. tostring(res)
            elseif type(res) ~= 'table' then
                out.errors[#out.errors + 1] = dir .. '/' .. name .. ': did not return a table'
            else
                into[name] = res
            end
        end
    end
end

loadDir('units', out.units, '_builder.lua')
loadDir('weapons', out.weapons)
loadDir('features', out.features)

do
    local ok, res = pcall(VFS.Include, 'gamedata/sounds.lua')
    if ok and type(res) == 'table' and type(res.SoundItems) == 'table' then
        out.sounds = res.SoundItems
    else
        out.errors[#out.errors + 1] = 'gamedata/sounds.lua: ' .. tostring(res)
    end
end

io.write(encode(out), '\n')
