-- lib/regions.lua — region-graph utilities.  PURE (no engine access).
--
-- The AI's map IS the region graph: adjacency is strategic distance, a
-- directive targets a region, and a unit is "in" whichever polygon contains
-- it. This module owns the geometry half of that contract:
--
--   Regions.load(mapDataTable)          regions.json → { key → region }
--   Regions.overlay(regions, getParam)  live owner/contested from rulesParams
--   Regions.regionOf(x, z, regions)     point → key ('wilds' if uncovered, nil if blind)
--   Regions.anchor(region)              centroid + bounding radius (directive geometry)
--   Regions.hops / minHops              multi-source BFS in graph hops
--   Regions.nearestEdgePoint(x, z, w, h) the transports gadget's default departure zone
--
-- regionOf mirrors ui/lib/regions.js `graphKeyAt` and ai/strategos/picture.lua
-- EXACTLY (same 256-elmo lookup cell, bbox filter, ray-cast confirm, 'wilds'
-- fallback): the sim, the client cost preview and every AI must agree on
-- which region a point is in, or authority predictions silently diverge.

local Regions = {}

Regions.LOOKUP_CELL = 256
Regions.WILDS = 'wilds'

--- Build the static graph from a decoded regions.json table (the same file
-- the client fetches from /api/maps/data/<id>/regions.json). Returns {} for
-- anything that is not a graph export — an honest "blind" graph.
function Regions.load(data)
    local out = {}
    if type(data) ~= 'table' or type(data.regions) ~= 'table' then return out end
    for _, r in ipairs(data.regions) do
        if r.key then
            out[r.key] = {
                key       = r.key,
                name      = r.name or r.key,
                value     = tonumber(r.value) or 0,
                tags      = r.tags or {},
                neighbors = r.neighbors or {},
                polygon   = r.polygon,
                owner     = nil,
                contested = false,
            }
        end
    end
    return out
end

--- Overlay live ownership onto a loaded graph IN PLACE. `getParam(key)` reads
-- a public game rulesParam (Metalstorm publishes `region_<key>_team` as
-- -1..N and `region_<key>_contested` as 0/1 — game_regions.lua). Resets to
-- unknown first so a param that vanished does not leave a stale owner.
function Regions.overlay(regions, getParam)
    for key, region in pairs(regions) do
        region.owner, region.contested = nil, false
        if getParam then
            local owner = tonumber(getParam('region_' .. key .. '_team'))
            if owner ~= nil then region.owner = owner end
            local c = getParam('region_' .. key .. '_contested')
            if c ~= nil then region.contested = (c == 1 or c == true or c == '1') end
        end
    end
    return regions
end

--- Is `region` neutral (unowned)? Metalstorm publishes -1 for "nobody".
function Regions.isNeutral(region)
    return region == nil or region.owner == nil or region.owner == -1
end

--- Ray-casting point-in-polygon (same edge formula as ui/lib/regions.js).
local function pointInPolygon(x, z, polygon)
    local inside = false
    local n = #polygon
    local j = n
    for i = 1, n do
        local pi, pj = polygon[i], polygon[j]
        if ((pi.z > z) ~= (pj.z > z)) and
           (x < (pj.x - pi.x) * (z - pi.z) / (pj.z - pi.z) + pi.x) then
            inside = not inside
        end
        j = i
    end
    return inside
end
Regions.pointInPolygon = pointInPolygon

local function buildLookupGrid(regions, cellSize)
    local cells, bbox = {}, {}
    for key, r in pairs(regions) do
        local polygon = r.polygon
        if type(polygon) == 'table' and #polygon > 0 then
            local minX, maxX, minZ, maxZ = math.huge, -math.huge, math.huge, -math.huge
            for _, pt in ipairs(polygon) do
                if pt.x < minX then minX = pt.x end
                if pt.x > maxX then maxX = pt.x end
                if pt.z < minZ then minZ = pt.z end
                if pt.z > maxZ then maxZ = pt.z end
            end
            bbox[key] = { minX, maxX, minZ, maxZ }
            for cz = math.floor(minZ / cellSize), math.floor(maxZ / cellSize) do
                for cx = math.floor(minX / cellSize), math.floor(maxX / cellSize) do
                    local ck = cx .. ':' .. cz
                    local list = cells[ck]
                    if not list then list = {}; cells[ck] = list end
                    list[#list + 1] = key
                end
            end
        end
    end
    return { cellSize = cellSize, cells = cells, bbox = bbox }
end

-- Grid cache keyed by the identity of the regions table (the graph geometry
-- is static for a game; only owner/contested change, in place).
local cachedFor, cachedGrid = nil, nil

--- Region key at (x, z). nil when no graph is loaded (blind); 'wilds' when
-- the graph covers nothing there.
function Regions.regionOf(x, z, regions)
    if not regions or next(regions) == nil then return nil end
    if cachedFor ~= regions then
        cachedGrid = buildLookupGrid(regions, Regions.LOOKUP_CELL)
        cachedFor = regions
    end
    local g = cachedGrid
    local candidates = g.cells[math.floor(x / g.cellSize) .. ':' .. math.floor(z / g.cellSize)]
    if candidates then
        for _, key in ipairs(candidates) do
            local r = regions[key]
            local bb = r and g.bbox[key]
            if bb and x >= bb[1] and x <= bb[2] and z >= bb[3] and z <= bb[4]
                    and r.polygon and pointInPolygon(x, z, r.polygon) then
                return key
            end
        end
    end
    return Regions.WILDS
end

--- Centroid + bounding radius of a region polygon: cx, cz, radius. nil when
-- the region has no usable polygon (a directive cannot be placed there).
function Regions.anchor(region)
    local poly = region and region.polygon
    if type(poly) ~= 'table' or #poly == 0 then return nil end
    local sx, sz, n = 0, 0, 0
    for _, p in ipairs(poly) do
        if p.x and p.z then sx, sz, n = sx + p.x, sz + p.z, n + 1 end
    end
    if n == 0 then return nil end
    local cx, cz = sx / n, sz / n
    local r = 0
    for _, p in ipairs(poly) do
        if p.x and p.z then
            local dx, dz = p.x - cx, p.z - cz
            local d = math.sqrt(dx * dx + dz * dz)
            if d > r then r = d end
        end
    end
    return cx, cz, r
end

--- Multi-source BFS hop distances: { [key] = hops } for every reachable
-- region; sources at 0. Unknown keys are skipped (a scenario may name a
-- region this map lacks).
function Regions.hops(regions, sources)
    local dist, queue, head = {}, {}, 1
    if not regions or not sources then return dist end
    for key in pairs(sources) do
        if regions[key] and dist[key] == nil then
            dist[key] = 0
            queue[#queue + 1] = key
        end
    end
    while head <= #queue do
        local key = queue[head]; head = head + 1
        local d = dist[key] + 1
        for _, nkey in ipairs((regions[key] and regions[key].neighbors) or {}) do
            if regions[nkey] and dist[nkey] == nil then
                dist[nkey] = d
                queue[#queue + 1] = nkey
            end
        end
    end
    return dist
end

--- Minimum hops from any source to any target; nil = unreachable / no contact.
function Regions.minHops(regions, sources, targets)
    if not targets or next(targets) == nil then return nil end
    local dist = Regions.hops(regions, sources)
    local best = nil
    for key in pairs(targets) do
        local d = dist[key]
        if d ~= nil and (best == nil or d < best) then best = d end
    end
    return best
end

--- Keys of regions adjacent to `key` (empty for unknown keys).
function Regions.neighbors(regions, key)
    local r = regions and regions[key]
    return (r and r.neighbors) or {}
end

--- Set of region keys owned by `teamId`.
function Regions.ownedBy(regions, teamId)
    local out = {}
    for key, r in pairs(regions or {}) do
        if r.owner == teamId then out[key] = true end
    end
    return out
end

--- Nearest point on the map edge to (x, z) — the departure zone the
-- transports gadget assigns a side that declares none ("you leave the way
-- you came", game_transports.lua nearestEdgePoint). Same tie-break order:
-- west, east, north, south.
function Regions.nearestEdgePoint(x, z, w, h)
    if not w or not h or w <= 0 or h <= 0 then return x, z end
    local best, bx, bz = x, 0, z
    if w - x < best then best, bx, bz = w - x, w, z end
    if z < best then best, bx, bz = z, x, 0 end
    if h - z < best then best, bx, bz = h - z, x, h end
    return bx, bz
end

--- Count entries of a plain table (regions tables are keyed, not arrays).
function Regions.count(t)
    local n = 0
    for _ in pairs(t or {}) do n = n + 1 end
    return n
end

return Regions
