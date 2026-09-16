-- tools/ai-eval/json.lua — the smallest JSON codec that can carry an eval
-- fixture in and an eval run out.
--
-- Why not a library: the driver runs under whatever `lua` the developer has,
-- with no luarocks tree guaranteed (the strategos suite already carries its own
-- `tests/run.lua` for exactly that reason), and the AI VM itself has no JSON
-- library either — so a dependency here would be a dependency the harness has
-- and the thing it measures does not.
--
-- Decode: objects, arrays, strings (with \u escapes for the BMP), numbers,
-- true/false/null. `null` DROPS the key (an absent fixture field and a null
-- one mean the same thing to every reader in this harness).
-- Encode: deterministic — object keys are sorted, so two runs of the same
-- fixture produce byte-identical output and `diff` is a useful tool.

local json = {}

local ARRAY_MT = { __jsonarray = true }

--- Mark a table as an ARRAY, so an empty one encodes as `[]` and not `{}`.
function json.array(t)
    return setmetatable(t or {}, ARRAY_MT)
end

function json.isArray(t)
    if getmetatable(t) == ARRAY_MT then return true end
    return next(t) ~= nil and #t > 0
end

-- ── encode ───────────────────────────────────────────────────────────────

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

local function encodeValue(v, indent, level)
    local t = type(v)
    if v == nil then return 'null' end
    if t == 'boolean' then return tostring(v) end
    if t == 'number' then return encodeNumber(v) end
    if t == 'string' then return encodeString(v) end
    if t ~= 'table' then return encodeString(tostring(v)) end

    local nl, pad, pad2 = '', '', ''
    if indent then
        nl = '\n'
        pad = string.rep(indent, level + 1)
        pad2 = string.rep(indent, level)
    end
    if json.isArray(v) then
        if #v == 0 then return '[]' end
        local parts = {}
        for i = 1, #v do parts[i] = pad .. encodeValue(v[i], indent, level + 1) end
        return '[' .. nl .. table.concat(parts, ',' .. nl) .. nl .. pad2 .. ']'
    end
    local keys = {}
    for k in pairs(v) do if type(k) == 'string' or type(k) == 'number' then keys[#keys + 1] = k end end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    if #keys == 0 then return '{}' end
    local parts = {}
    for i, k in ipairs(keys) do
        parts[i] = pad .. encodeString(tostring(k)) .. ':' .. (indent and ' ' or '')
                .. encodeValue(v[k], indent, level + 1)
    end
    return '{' .. nl .. table.concat(parts, ',' .. nl) .. nl .. pad2 .. '}'
end

--- encode(value [, indent]) — `indent` is a string ('  ') for pretty output.
function json.encode(v, indent)
    return encodeValue(v, indent, 0)
end

-- ── decode ───────────────────────────────────────────────────────────────

local Parser = {}
Parser.__index = Parser

local function fail(p, msg)
    local line = 1
    for _ in p.s:sub(1, p.i):gmatch('\n') do line = line + 1 end
    error(string.format('%s:%d: %s', p.name or 'json', line, msg), 0)
end

function Parser:ws()
    local _, j = self.s:find('^[ \t\r\n]*', self.i)
    self.i = j + 1
end

function Parser:lit(word, value)
    if self.s:sub(self.i, self.i + #word - 1) == word then
        self.i = self.i + #word
        return true, value
    end
    return false
end

local STR_ESC = { ['"'] = '"', ['\\'] = '\\', ['/'] = '/', b = '\b', f = '\f',
                  n = '\n', r = '\r', t = '\t' }

function Parser:str()
    self.i = self.i + 1            -- opening quote
    local out = {}
    while true do
        local c = self.s:sub(self.i, self.i)
        if c == '' then fail(self, 'unterminated string') end
        if c == '"' then self.i = self.i + 1; break end
        if c == '\\' then
            local e = self.s:sub(self.i + 1, self.i + 1)
            if e == 'u' then
                local hex = self.s:sub(self.i + 2, self.i + 5)
                if not hex:match('^%x%x%x%x$') then fail(self, 'bad \\u escape') end
                out[#out + 1] = utf8.char(tonumber(hex, 16))
                self.i = self.i + 6
            elseif STR_ESC[e] then
                out[#out + 1] = STR_ESC[e]
                self.i = self.i + 2
            else
                fail(self, 'bad escape \\' .. e)
            end
        else
            local nextEsc = self.s:find('[\\"]', self.i)
            out[#out + 1] = self.s:sub(self.i, (nextEsc or #self.s + 1) - 1)
            self.i = nextEsc or (#self.s + 1)
        end
    end
    return table.concat(out)
end

function Parser:value()
    self:ws()
    local c = self.s:sub(self.i, self.i)
    if c == '' then fail(self, 'unexpected end of input') end
    if c == '{' then
        self.i = self.i + 1
        local obj = {}
        self:ws()
        if self.s:sub(self.i, self.i) == '}' then self.i = self.i + 1; return obj end
        while true do
            self:ws()
            if self.s:sub(self.i, self.i) ~= '"' then fail(self, 'object key expected') end
            local k = self:str()
            self:ws()
            if self.s:sub(self.i, self.i) ~= ':' then fail(self, "':' expected") end
            self.i = self.i + 1
            obj[k] = self:value()          -- null → nil → key simply absent
            self:ws()
            local d = self.s:sub(self.i, self.i)
            self.i = self.i + 1
            if d == '}' then return obj end
            if d ~= ',' then fail(self, "',' or '}' expected") end
        end
    elseif c == '[' then
        self.i = self.i + 1
        local arr = json.array({})
        self:ws()
        if self.s:sub(self.i, self.i) == ']' then self.i = self.i + 1; return arr end
        while true do
            arr[#arr + 1] = self:value()
            self:ws()
            local d = self.s:sub(self.i, self.i)
            self.i = self.i + 1
            if d == ']' then return arr end
            if d ~= ',' then fail(self, "',' or ']' expected") end
        end
    elseif c == '"' then
        return self:str()
    else
        local ok, v = self:lit('true', true)
        if ok then return v end
        ok, v = self:lit('false', false)
        if ok then return v end
        if self:lit('null', nil) then return nil end
        local num = self.s:match('^-?%d+%.?%d*[eE]?[-+]?%d*', self.i)
        if num and tonumber(num) then
            self.i = self.i + #num
            return tonumber(num)
        end
        fail(self, 'unexpected character ' .. string.format('%q', c))
    end
end

--- decode(text [, name]) → value. Raises with a line number on bad input.
function json.decode(text, name)
    local p = setmetatable({ s = text, i = 1, name = name }, Parser)
    local v = p:value()
    p:ws()
    if p.i <= #p.s then fail(p, 'trailing garbage') end
    return v
end

--- Read and decode a file, or raise.
function json.decodeFile(path)
    local f = assert(io.open(path, 'r'), 'cannot open ' .. tostring(path))
    local text = f:read('*a')
    f:close()
    return json.decode(text, path)
end

return json
