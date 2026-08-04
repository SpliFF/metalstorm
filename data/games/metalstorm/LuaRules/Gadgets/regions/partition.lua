-- regions/partition.lua — point→region partitioning (PLAN-metalstorm-regions.md §1).
--
-- Pure Lua, no Spring API calls — takes plain coordinates/tables in, returns
-- plain tables/closures out. Loaded via VFS.Include by game_regions.lua at
-- runtime; loaded via plain `dofile`/`require` by busted specs (regions/tests/).
--
-- Two providers behind one interface: `provider.at(x, z)` → region key.
--   - grid:  always available, O(1) floor-divide, full coverage (no wilds).
--   - graph: map-authored polygons; lookup-grid narrows to a handful of
--            candidates per cell (bounding-box overlap), each confirmed via
--            point-in-polygon — a cell's candidate list is a filter, not a
--            verdict, since a lone candidate's polygon edge can still cut
--            through the cell. Points outside every polygon resolve to the
--            synthetic "wilds" region.

local M = {}

local MIN_REGIONS_PER_AXIS = 2      -- E5: degenerate-grid clamp on tiny maps
local DEFAULT_GRID_REGION_SIZE = 2048
local DEFAULT_LOOKUP_CELL = 256

-- ============================================================
-- Grid provider
-- ============================================================

--- Resolve the grid region size, clamped so each axis has at least
--- MIN_REGIONS_PER_AXIS cells (E5 — tiny maps must not produce a
--- degenerate 0- or 1-cell grid).
function M.gridRegionSize(mapWidth, mapHeight, desiredSize)
    desiredSize = desiredSize or DEFAULT_GRID_REGION_SIZE
    local maxSize = math.min(mapWidth, mapHeight) / MIN_REGIONS_PER_AXIS
    if desiredSize > maxSize then
        return maxSize
    end
    return desiredSize
end

-- ------------------------------------------------------------
-- Sector naming (PLAN-metalstorm-command-language.md §5)
-- ------------------------------------------------------------
--
-- Grid regions are synthetic and carry no authored metadata, so until now
-- their keys ("3:5") were the only handle anyone had on them — and a bare
-- "3:5" is not something a player says out loud. "Zoom to sector B9" was
-- therefore impossible on every map without a hand-authored
-- mapdata/regions.lua. These two pure functions give each cell a spoken name;
-- game_regions.lua publishes them through the SAME region_<key>_name
-- rulesParam the graph provider already uses, so the client needs no change.

--- Spreadsheet-style column label: 0 → "A", 25 → "Z", 26 → "AA", 27 → "AB".
---
--- The alphabet caps at 26 letters and the default 2048-elmo region size only
--- reaches column Z on a ~53 km map, so the second letter is an edge case, not
--- the norm. It exists anyway because the alternative — wrapping back to "A" —
--- would give two sectors the same name, and two identically-named places is
--- precisely the failure the named-entity index exists to prevent: the
--- resolver would have to guess which one the player meant.
function M.columnLabel(ix)
    if type(ix) ~= 'number' or ix < 0 then return nil end
    local label, n = '', math.floor(ix)
    repeat
        label = string.char(65 + (n % 26)) .. label
        n = math.floor(n / 26) - 1
    until n < 0
    return label
end

--- Grid key → display name: "3:5" → "Sector D6". Columns are letters, rows are
--- 1-BASED numbers, so the top-left cell of any map is "Sector A1" rather than
--- "Sector A0" — the grid is addressed the way a map legend is, not the way an
--- array is.
---
--- Returns nil for anything that isn't a grid key. The graph provider's keys
--- are authored slugs ("west_scarp_n") whose authored names stay primary; this
--- function must never rename one.
function M.gridSectorName(key)
    if type(key) ~= 'string' then return nil end
    local col, row = key:match('^(%d+):(%d+)$')
    if not col then return nil end
    return 'Sector ' .. M.columnLabel(tonumber(col)) .. tostring(tonumber(row) + 1)
end

function M.newGridProvider(mapWidth, mapHeight, desiredSize)
    local regionSize = M.gridRegionSize(mapWidth, mapHeight, desiredSize)
    local gridW = math.max(MIN_REGIONS_PER_AXIS, math.ceil(mapWidth / regionSize))
    local gridH = math.max(MIN_REGIONS_PER_AXIS, math.ceil(mapHeight / regionSize))

    local function clampIndex(i, n)
        if i < 0 then return 0 end
        if i >= n then return n - 1 end
        return i
    end

    return {
        kind = "grid",
        regionSize = regionSize,
        gridW = gridW,
        gridH = gridH,

        at = function(x, z)
            local ix = clampIndex(math.floor(x / regionSize), gridW)
            local iz = clampIndex(math.floor(z / regionSize), gridH)
            return ix .. ':' .. iz
        end,

        keys = function()
            local out = {}
            for ix = 0, gridW - 1 do
                for iz = 0, gridH - 1 do
                    out[#out + 1] = ix .. ':' .. iz
                end
            end
            return out
        end,

        --- Static descriptor for every cell — the grid's answer to the graph
        --- provider's authored name + polygon centroid. The centre is the
        --- centre of the cell CLIPPED to the map: gridW/gridH are ceil()'d, so
        --- the last column and row hang off the edge, and a sector name is only
        --- worth having if the point underneath it is somewhere an order can
        --- actually be sent.
        sectors = function()
            local out = {}
            for ix = 0, gridW - 1 do
                for iz = 0, gridH - 1 do
                    local x0, x1 = ix * regionSize, math.min((ix + 1) * regionSize, mapWidth)
                    local z0, z1 = iz * regionSize, math.min((iz + 1) * regionSize, mapHeight)
                    local key = ix .. ':' .. iz
                    out[#out + 1] = {
                        key  = key,
                        name = M.gridSectorName(key),
                        x    = (x0 + x1) / 2,
                        z    = (z0 + z1) / 2,
                    }
                end
            end
            return out
        end,

        -- Grid regions have no authored metadata.
        byKey = {},
    }
end

-- ============================================================
-- Point-in-polygon / self-intersection (graph provider + validator)
-- ============================================================

--- Ray-casting point-in-polygon test. `poly` is a list of {x=,z=} points,
--- CCW, closed implicitly (last point connects back to the first).
function M.pointInPolygon(x, z, poly)
    local inside = false
    local n = #poly
    local j = n
    for i = 1, n do
        local xi, zi = poly[i].x, poly[i].z
        local xj, zj = poly[j].x, poly[j].z
        if ((zi > z) ~= (zj > z)) and
           (x < (xj - xi) * (z - zi) / (zj - zi) + xi) then
            inside = not inside
        end
        j = i
    end
    return inside
end

local function cross(ox, oz, ax, az, bx, bz)
    return (ax - ox) * (bz - oz) - (az - oz) * (bx - ox)
end

local function segmentsIntersect(p1, p2, p3, p4)
    local d1 = cross(p3.x, p3.z, p4.x, p4.z, p1.x, p1.z)
    local d2 = cross(p3.x, p3.z, p4.x, p4.z, p2.x, p2.z)
    local d3 = cross(p1.x, p1.z, p2.x, p2.z, p3.x, p3.z)
    local d4 = cross(p1.x, p1.z, p2.x, p2.z, p4.x, p4.z)
    return ((d1 > 0 and d2 < 0) or (d1 < 0 and d2 > 0)) and
           ((d3 > 0 and d4 < 0) or (d3 < 0 and d4 > 0))
end

--- True if the polygon's non-adjacent edges cross (a self-intersection).
--- Degenerate (< 3 vertices) counts as self-intersecting.
function M.isSelfIntersecting(poly)
    local n = #poly
    if n < 3 then return true end
    for i = 1, n do
        local a1, a2 = poly[i], poly[i % n + 1]
        for j = i + 2, n do
            -- Skip edges adjacent to edge i (share a vertex, not a crossing):
            -- edge i is (i, i+1); edge j is (j, j+1 mod n). Adjacent when
            -- j == i (same edge) or j+1 == i (wraps to share vertex i).
            if not (i == 1 and j == n) then
                local b1, b2 = poly[j], poly[j % n + 1]
                if segmentsIntersect(a1, a2, b1, b2) then
                    return true
                end
            end
        end
    end
    return false
end

-- ============================================================
-- Graph validation (loud errors; caller falls back to grid on failure)
-- ============================================================

--- Validate a map-authored region graph. Returns `true, nil` on success or
--- `false, errors` (a list of strings) on failure. Checks: non-empty list,
--- well-formed entries, vertices within map bounds, non-self-intersecting
--- polygons, unique keys, `"wilds"` reserved, symmetric neighbor references.
--- Full coverage is NOT required (gaps become "wilds").
---
--- Defensive by contract (E2): malformed authored data — a non-table entry,
--- a missing/empty key, a bad vertex — must yield a loud error string and let
--- the caller fall back to grid, NEVER a raw Lua error that would take the
--- gadget down. Empty list = INVALID → grid (mirrors C++ ExtractRegions
--- `haveGraph = !empty`); an empty graph is not "everything is wilds".
function M.validateGraph(regionsData, mapWidth, mapHeight)
    if type(regionsData) ~= "table" then
        return false, { "regions is not a list" }
    end
    if #regionsData == 0 then
        return false, { "empty region list" }
    end

    local errors = {}
    local seenKeys = {}
    local byKey = {}
    -- Key index, built defensively — a malformed entry must not raise here.
    for _, r in ipairs(regionsData) do
        if type(r) == "table" and type(r.key) == "string" and r.key ~= "" then
            byKey[r.key] = r
        end
    end

    for i, r in ipairs(regionsData) do
        if type(r) ~= "table" then
            errors[#errors + 1] = "region #" .. i .. " is not a table"
        else
            local key = r.key
            local label = (type(key) == "string" and key ~= "") and key or ("#" .. i)
            if type(key) ~= "string" or key == "" then
                errors[#errors + 1] = "region #" .. i .. " with empty/missing key"
            elseif key == "wilds" then
                errors[#errors + 1] = "region uses reserved key 'wilds'"
            elseif seenKeys[key] then
                errors[#errors + 1] = "duplicate key: " .. key
            end
            if type(key) == "string" then seenKeys[key] = true end

            local poly = r.polygon
            if type(poly) ~= "table" then poly = {} end
            local vertsOk = true
            for _, pt in ipairs(poly) do
                if type(pt) ~= "table" or type(pt.x) ~= "number" or type(pt.z) ~= "number" then
                    errors[#errors + 1] = label .. ": malformed vertex"
                    vertsOk = false
                    break
                elseif pt.x < 0 or pt.x > mapWidth or pt.z < 0 or pt.z > mapHeight then
                    errors[#errors + 1] = label .. ": vertex out of map bounds"
                    break
                end
            end
            if vertsOk and M.isSelfIntersecting(poly) then
                errors[#errors + 1] = label .. ": self-intersecting polygon"
            end

            for _, nb in ipairs(r.neighbors or {}) do
                local other = byKey[nb]
                if not other then
                    errors[#errors + 1] = label .. ": neighbor '" .. tostring(nb) .. "' does not exist"
                else
                    local found = false
                    for _, back in ipairs(other.neighbors or {}) do
                        if back == key then found = true break end
                    end
                    if not found then
                        errors[#errors + 1] = label .. ": asymmetric neighbor '" .. tostring(nb) .. "'"
                    end
                end
            end
        end
    end

    if #errors > 0 then return false, errors end
    return true, nil
end

-- ============================================================
-- Lookup grid (shared by graph provider + client mirror, §1.2)
-- ============================================================

--- Precompute a lookup grid: cell (cellSize elmos, default 256) → list of
--- region keys whose bounding box overlaps that cell, in declaration order
--- (first-declared-wins on overlaps, §1.1). Most cells hold exactly one
--- region; boundary cells are confirmed with a point-in-polygon test.
function M.buildLookupGrid(regionsData, mapWidth, mapHeight, cellSize)
    cellSize = cellSize or DEFAULT_LOOKUP_CELL
    local gw = math.max(1, math.ceil(mapWidth / cellSize))
    local gh = math.max(1, math.ceil(mapHeight / cellSize))
    local grid = {}   -- grid[cz][cx] = { region keys }

    for _, r in ipairs(regionsData) do
        local minX, maxX, minZ, maxZ = math.huge, -math.huge, math.huge, -math.huge
        for _, pt in ipairs(r.polygon) do
            if pt.x < minX then minX = pt.x end
            if pt.x > maxX then maxX = pt.x end
            if pt.z < minZ then minZ = pt.z end
            if pt.z > maxZ then maxZ = pt.z end
        end
        local cx0 = math.max(0, math.floor(minX / cellSize))
        local cx1 = math.min(gw - 1, math.floor(maxX / cellSize))
        local cz0 = math.max(0, math.floor(minZ / cellSize))
        local cz1 = math.min(gh - 1, math.floor(maxZ / cellSize))
        for cz = cz0, cz1 do
            grid[cz] = grid[cz] or {}
            for cx = cx0, cx1 do
                grid[cz][cx] = grid[cz][cx] or {}
                local cell = grid[cz][cx]
                cell[#cell + 1] = r.key
            end
        end
    end

    return { grid = grid, cellSize = cellSize, gridW = gw, gridH = gh }
end

-- ============================================================
-- Graph provider
-- ============================================================

--- Build a graph provider from validated `regionsData`. Returns
--- `provider, nil` on success or `nil, errors` if validation fails — the
--- caller (game_regions.lua) falls back to the grid provider (E2).
function M.newGraphProvider(regionsData, mapWidth, mapHeight)
    local ok, errors = M.validateGraph(regionsData, mapWidth, mapHeight)
    if not ok then
        return nil, errors
    end

    local byKey = {}
    for _, r in ipairs(regionsData) do byKey[r.key] = r end
    byKey.wilds = byKey.wilds or { key = "wilds", name = "Wilds", value = 0, tags = {}, neighbors = {} }

    local lookup = M.buildLookupGrid(regionsData, mapWidth, mapHeight)

    local function at(x, z)
        local cx = math.floor(x / lookup.cellSize)
        local cz = math.floor(z / lookup.cellSize)
        local cellRegions = lookup.grid[cz] and lookup.grid[cz][cx]
        if not cellRegions then return "wilds" end
        -- Always confirm via point-in-polygon, even for a single candidate:
        -- a cell whose bounding-box overlap list has exactly one region is
        -- NOT necessarily fully covered by it — an isolated polygon's edge
        -- can still cut through a cell with no other region nearby.
        for _, key in ipairs(cellRegions) do
            if M.pointInPolygon(x, z, byKey[key].polygon) then
                return key
            end
        end
        return "wilds"
    end

    local keys = { "wilds" }
    for _, r in ipairs(regionsData) do keys[#keys + 1] = r.key end

    return {
        kind = "graph",
        at = at,
        byKey = byKey,
        keys = function() return keys end,
        lookupGrid = lookup,
    }
end

return M
