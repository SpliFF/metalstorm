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
--- `false, errors` (a list of strings) on failure. Checks: vertices within
--- map bounds, non-self-intersecting polygons, unique keys, symmetric
--- neighbor references. Full coverage is NOT required (gaps become "wilds").
function M.validateGraph(regionsData, mapWidth, mapHeight)
    local errors = {}
    local seenKeys = {}
    local byKey = {}
    for _, r in ipairs(regionsData) do byKey[r.key] = r end

    for _, r in ipairs(regionsData) do
        if not r.key or r.key == "" then
            errors[#errors + 1] = "region with empty/missing key"
        elseif seenKeys[r.key] then
            errors[#errors + 1] = "duplicate key: " .. r.key
        end
        seenKeys[r.key] = true

        local poly = r.polygon or {}
        for _, pt in ipairs(poly) do
            if pt.x < 0 or pt.x > mapWidth or pt.z < 0 or pt.z > mapHeight then
                errors[#errors + 1] = (r.key or "?") .. ": vertex out of map bounds"
                break
            end
        end
        if M.isSelfIntersecting(poly) then
            errors[#errors + 1] = (r.key or "?") .. ": self-intersecting polygon"
        end

        for _, nb in ipairs(r.neighbors or {}) do
            local other = byKey[nb]
            if not other then
                errors[#errors + 1] = r.key .. ": neighbor '" .. nb .. "' does not exist"
            else
                local found = false
                for _, back in ipairs(other.neighbors or {}) do
                    if back == r.key then found = true break end
                end
                if not found then
                    errors[#errors + 1] = r.key .. ": asymmetric neighbor '" .. nb .. "'"
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
