-- lib/tests/fixtures/graph.lua — a small "graph"-shaped regions.json export
-- (the same format MapProcessor.cpp produces) as a Lua table, plus a matching
-- power table. Three regions in a row on a 2048×2048 map:
--
--   north_ridge (0..1024 x, 0..1024 z) — central_basin (1024..2048 x, 0..1024 z)
--   south_marsh (0..2048 x, 1024..2048 z), adjacent to central_basin only.
--
-- Returned as fresh tables each call so specs never share mutable state.

local M = {}

function M.regionsJson()
    return {
        provider = 'graph', mapWidth = 2048, mapHeight = 2048,
        regions = {
            { key = 'north_ridge', name = 'North Ridge', value = 2, tags = { 'high_ground' },
              neighbors = { 'central_basin' },
              polygon = { {x=0,z=0}, {x=1024,z=0}, {x=1024,z=1024}, {x=0,z=1024} } },
            { key = 'central_basin', name = 'Central Basin', value = 3, tags = {},
              neighbors = { 'north_ridge', 'south_marsh' },
              polygon = { {x=1024,z=0}, {x=2048,z=0}, {x=2048,z=1024}, {x=1024,z=1024} } },
            { key = 'south_marsh', name = 'South Marsh', value = 1, tags = { 'swamp' },
              neighbors = { 'central_basin' },
              polygon = { {x=0,z=1024}, {x=2048,z=1024}, {x=2048,z=2048}, {x=0,z=2048} } },
        },
    }
end

function M.powerJson()
    return { defs = {
        ['101'] = { name = 'ms_tank_s1', dps = 40, hp = 1200, class = 'tanks', scale = 1 },
        ['102'] = { name = 'ms_scout',   dps = 10, hp = 400,  class = 'recon', scale = 1 },
        ['103'] = { name = 'ms_heavy',   dps = 90, hp = 3000, class = 'tanks', scale = 3 },
    } }
end

--- n own tanks parked in north_ridge (idle unless `busy`).
function M.tanks(n, busy, x, z)
    local out = {}
    for i = 1, n do
        out[i] = { id = i, defId = 101, x = (x or 300) + i * 5, z = (z or 300) + i * 5,
                   health = 1.0, hasCommands = busy and true or false }
    end
    return out
end

return M
