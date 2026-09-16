-- graph.lua — region-graph traversal (PLAN-metalstorm-ai.md §2).  PURE.
--
-- "The AI's map is the region graph, no terrain analysis, no pathfinding;
-- adjacency IS strategic distance." Everything in the brain that needs a
-- notion of "how far" measures it in HOPS over `region.neighbors`, never in
-- elmos — so the one traversal both the LOD proxy (lod.lua) and the NPC
-- scripted slate (scripted.lua) need lives here rather than being written
-- twice with two subtly different tie-breaks.
--
-- SPLIT REACHABILITY (PLAN-maps.md §2k, mapinfo `metalstorm.reachability`).
-- A map may DECLARE that armour cannot reach every start from every other
-- while infantry can (meridian_basin: split for VEH/HEAVY, connected for
-- INFANTRY). regions.json carries ONE reference class's adjacency plus per-
-- region tags, so the only class-aware signal a plugin has is the tags. The
-- optional `passable(fromKey, toKey, regions)` predicate on `hops` is how a
-- caller says "this force cannot enter that ground": `Graph.passableFor(kind,
-- config)` builds the predicate from the tag lists in config.lua. A BFS that
-- ignored this would march an armour package at a goal across a ridge it
-- cannot climb and report a 2-hop trip; the planner treats a nil hop count as
-- UNREACHABLE and refuses the pairing (planner.lua travelFor).
--
-- Cost: one multi-source BFS over a ~24-50 region graph — O(regions + edges),
-- a few dozen table ops, comfortably inside the §6 2 ms strategic-tick budget.

local Graph = {}

--- Multi-source breadth-first hop distances.
-- `regions` is the Picture's region table (key -> { neighbors = {key,...} }).
-- `sources` is a SET (key -> truthy). Returns { [key] = hops } covering every
-- region reachable from any source, with each source itself at 0. Keys that
-- name a region absent from the graph are ignored (a scenario may name a
-- region the loaded map doesn't have — honest skip, the caller reports it).
-- `passable(fromKey, toKey, regions)` (optional) vetoes an edge; a source is
-- always enterable (the force is already standing there).
function Graph.hops(regions, sources, passable)
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
        local r = regions[key]
        for _, nkey in ipairs((r and r.neighbors) or {}) do
            if regions[nkey] and dist[nkey] == nil
               and (passable == nil or passable(key, nkey, regions)) then
                dist[nkey] = d
                queue[#queue + 1] = nkey
            end
        end
    end
    return dist
end

--- Minimum hop count from any `sources` region to any `targets` region.
-- Returns nil when either set is empty of graph-resolvable keys, or when no
-- target is reachable — "no contact" / "unreachable", which callers treat as
-- maximum strategic distance rather than as an error.
function Graph.minHops(regions, sources, targets, passable)
    if not targets or next(targets) == nil then return nil end
    local dist = Graph.hops(regions, sources, passable)
    local best = nil
    for key in pairs(targets) do
        local d = dist[key]
        if d ~= nil and (best == nil or d < best) then best = d end
    end
    return best
end

--- Connected components under `passable`. Returns
-- `{ byKey = { [key] = componentIndex }, count = n }`. Component indices are
-- assigned in sorted key order so the result is deterministic across VMs
-- (`pairs` order over string keys is NOT — Lua seeds its string hash per
-- process).
function Graph.components(regions, passable)
    local byKey, count = {}, 0
    if not regions then return { byKey = byKey, count = 0 } end
    local keys = {}
    for key in pairs(regions) do keys[#keys + 1] = key end
    table.sort(keys)
    for _, key in ipairs(keys) do
        if byKey[key] == nil then
            count = count + 1
            local dist = Graph.hops(regions, { [key] = true }, passable)
            for k in pairs(dist) do byKey[k] = count end
        end
    end
    return { byKey = byKey, count = count }
end

--- True when `a` and `b` are the same region or share a component.
function Graph.reachable(regions, a, b, passable)
    if a == b then return regions[a] ~= nil end
    local dist = Graph.hops(regions, { [a] = true }, passable)
    return dist[b] ~= nil
end

--- Does the region carry any tag in `set` (a tag -> true table)?
local function hasTagIn(region, set)
    if not set then return false end
    for _, tag in ipairs((region and region.tags) or {}) do
        if set[tag] then return true end
    end
    return false
end
Graph.hasTagIn = hasTagIn

--- Build a `passable` predicate for a force kind ('ground' | 'armour').
-- Ground force may not ENTER a region tagged in config.GROUND_BLOCKED_TAGS
-- (water); armour additionally may not enter config.ARMOUR_BLOCKED_TAGS
-- (infantry-only ridges, fords). Leaving a region is never gated — the force
-- is already there. Returns nil for an unknown kind (= unrestricted), which
-- is the honest default for a package whose composition is unclassed.
function Graph.passableFor(kind, config)
    if not config then return nil end
    local blocked = nil
    if kind == 'ground' then
        blocked = config.GROUND_BLOCKED_TAGS
    elseif kind == 'armour' then
        blocked = {}
        for tag in pairs(config.GROUND_BLOCKED_TAGS or {}) do blocked[tag] = true end
        for tag in pairs(config.ARMOUR_BLOCKED_TAGS or {}) do blocked[tag] = true end
    end
    if not blocked or next(blocked) == nil then return nil end
    return function(_, toKey, regions)
        return not hasTagIn(regions[toKey], blocked)
    end
end

--- Region containing world point (x, z), by bounding-box filter then ray-cast
-- point-in-polygon over `region.polygon` ({ {x=,z=}, ... }). Returns the key
-- or nil. Same test as picture.lua's regionOf / ui/lib/regions.js, without
-- the lookup grid: this is a per-goal call on a ~16-50 region graph, not a
-- per-unit one, so the grid's setup cost would never pay back here. Keys are
-- tried in sorted order so an overlapping edge resolves deterministically.
function Graph.regionAt(regions, x, z)
    if not regions or x == nil or z == nil then return nil end
    local keys = {}
    for key, r in pairs(regions) do
        if r.polygon and #r.polygon >= 3 then keys[#keys + 1] = key end
    end
    table.sort(keys)
    for _, key in ipairs(keys) do
        local poly = regions[key].polygon
        local minx, maxx, minz, maxz = math.huge, -math.huge, math.huge, -math.huge
        for _, p in ipairs(poly) do
            if p.x < minx then minx = p.x end
            if p.x > maxx then maxx = p.x end
            if p.z < minz then minz = p.z end
            if p.z > maxz then maxz = p.z end
        end
        if x >= minx and x <= maxx and z >= minz and z <= maxz then
            local inside = false
            local n = #poly
            local j = n
            for i = 1, n do
                local pi, pj = poly[i], poly[j]
                if ((pi.z > z) ~= (pj.z > z)) and
                   (x < (pj.x - pi.x) * (z - pi.z) / (pj.z - pi.z) + pi.x) then
                    inside = not inside
                end
                j = i
            end
            if inside then return key end
        end
    end
    return nil
end

return Graph
