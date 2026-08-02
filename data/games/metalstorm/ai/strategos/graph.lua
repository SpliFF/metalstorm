-- graph.lua — region-graph traversal (PLAN-metalstorm-ai.md §2).  PURE.
--
-- "The AI's map is the region graph, no terrain analysis, no pathfinding;
-- adjacency IS strategic distance." Everything in the brain that needs a
-- notion of "how far" measures it in HOPS over `region.neighbors`, never in
-- elmos — so the one traversal both the LOD proxy (lod.lua) and the NPC
-- scripted slate (scripted.lua) need lives here rather than being written
-- twice with two subtly different tie-breaks.
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
function Graph.hops(regions, sources)
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
            if regions[nkey] and dist[nkey] == nil then
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
function Graph.minHops(regions, sources, targets)
    if not targets or next(targets) == nil then return nil end
    local dist = Graph.hops(regions, sources)
    local best = nil
    for key in pairs(targets) do
        local d = dist[key]
        if d ~= nil and (best == nil or d < best) then best = d end
    end
    return best
end

return Graph
