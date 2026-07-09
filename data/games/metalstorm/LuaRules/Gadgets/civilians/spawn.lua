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
function spawn.seed(civ)
    -- TODO: read map-authored civilian sites (habitats/districts/depots) and
    -- populate them at modoption objective_density. For now: no-op.
end

return spawn
