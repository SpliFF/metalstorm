-- civilians/spawn.lua — placement + spawning. STUB.
-- Plain library module (NOT a gadget). Included by game_civilians.lua.
local spawn = {}

--- Spawn one civilian group/vehicle on the Gaia team. Returns unitID.
function spawn.one(civ, defName, x, z, facing)
    local y = Spring.GetGroundHeight(x, z)
    local unitID = Spring.CreateUnit(defName, x, y, z, facing or 'south', civ.gaiaTeam)
    if unitID then civ.population[unitID] = { role = 'ambient' } end
    return unitID
end

--- Seed the starting population from map/scenario placement. STUB.
-- Input format (when implemented): the map's mapdata/civilians.lua —
-- `{ version=1, sites={ {key, region, kind="habitat"|"depot", pos={x,z},
-- population, defPool={defName,...}}, ... }, convoys={ {id, side, from, to,
-- via={region,...}, waypoints={{x,z},...}, defName, intervalSec}, ... } }`.
-- See content/maps/meridian_basin/mapdata/civilians.lua for a worked
-- example (PLAN-metalstorm-beta-map.md task 3).
function spawn.seed(civ)
    -- TODO: read map-authored civilian sites (habitats/districts/depots) and
    -- populate them at modoption objective_density. For now: no-op.
end

return spawn
