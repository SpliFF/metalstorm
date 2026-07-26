-- civilians/spawn.lua — placement + spawning. STUB.
-- Plain library module (NOT a gadget). Included by game_civilians.lua.
local spawn = {}

-- Extra clearance (elmos) added on top of a building's footprint corner
-- radius when scattering population around it, to cover the spawned unit's
-- own footprint plus a small pathfinding margin.
local SCATTER_MARGIN = 40

--- The circular radius (elmos) that fully clears a building's footprint at
--- every angle, not just along its axes. A footprint is a rectangle, so its
--- corner (half-diagonal) reaches farther than its edges — a scatter radius
--- only checked against the edge distance can still land on a diagonal
--- corner of the blocked yardmap. Data-driven from the def's actual
--- xsize/zsize (rather than a flat guess) since site buildings vary
--- (habitat/depot/transit_hub have different footprints).
local function footprintClearRadius(buildingDefName)
    local bdef = buildingDefName and UnitDefNames[buildingDefName]
    if not bdef then return 0 end
    -- xsize/zsize are full footprint width in elmos = value * 4 for the half-extent
    -- (Spring convention: xsize/zsize already encode footprint*2, and
    -- SQUARE_SIZE=8, so half-width elmos = xsize/2 * 8 = xsize * 4).
    local halfX = (bdef.xsize or 0) * 4
    local halfZ = (bdef.zsize or 0) * 4
    return math.sqrt(halfX * halfX + halfZ * halfZ) + SCATTER_MARGIN
end

--- Spawn one civilian group/vehicle on the Gaia team. Returns unitID.
function spawn.one(civ, defName, x, z, facing)
    local y = Spring.GetGroundHeight(x, z)
    local unitID = Spring.CreateUnit(defName, x, y, z, facing or 'south', civ.gaiaTeam)
    if unitID then civ.population[unitID] = { role = 'ambient' } end
    return unitID
end

--- Seed the starting population from map/scenario placement.
-- Input format: the map's mapdata/civilians.lua —
-- `{ version=1, sites={ {key, region, kind="habitat"|"depot", pos={x,z},
-- population, defPool={defName,...}}, ... }, convoys={ {id, side, from, to,
-- via={region,...}, waypoints={{x,z},...}, defName, intervalSec}, ... } }`.
-- See content/maps/meridian_basin/mapdata/civilians.lua for a worked
-- example (PLAN-metalstorm-beta-map.md task 3).
function spawn.seed(civ)
    -- Load map-authored civilian placement data (optional — some maps won't have it).
    local ok, dataOrErr = pcall(VFS.Include, "mapdata/civilians.lua", nil, VFS.MAP)
    if not ok then
        Spring.Log("Civilians", LOG.INFO, "No civilian placement data (mapdata/civilians.lua): " .. tostring(dataOrErr))
        return
    end
    local data = dataOrErr

    if data.version ~= 1 then
        Spring.Log("Civilians", LOG.WARNING, "Unsupported civilians.lua version: " .. tostring(data.version))
        return
    end

    -- Stash convoy routes for convoy.lua to use
    civ.convoyRoutes = data.convoys or {}

    -- Populate sites (habitats/districts)
    if not data.sites then
        Spring.Log("Civilians", LOG.INFO, "No civilian sites in mapdata/civilians.lua")
        return
    end

    for _, site in ipairs(data.sites) do
        -- Spawn civilian buildings first (habitats, depots, transit hubs)
        local buildingDef = nil
        if site.kind == 'habitat' then
            buildingDef = 'ms_habitat'
        elseif site.kind == 'depot' then
            buildingDef = 'ms_depot'
        elseif site.kind == 'transit_hub' then
            buildingDef = 'ms_transit_hub'
        end

        if buildingDef then
            local buildingID = spawn.one(civ, buildingDef, site.pos.x, site.pos.z, 'north')
            if buildingID then
                civ.population[buildingID].site = site.key
                civ.population[buildingID].kind = site.kind
                Spring.Log("Civilians", LOG.INFO, "Spawned " .. buildingDef .. " at site " .. site.key)
            end
        end

        -- Spawn civilian population around the site
        if site.population and site.population > 0 and site.defPool then
            local spawnCount = site.population
            local defPool = site.defPool
            -- Minimum scatter radius that clears the site building's footprint
            -- at every angle (falls back to the old flat 100 if there's no
            -- building, e.g. an unrecognised site.kind).
            local minRadius = math.max(100, footprintClearRadius(buildingDef))

            for i = 1, spawnCount do
                -- Pick a def from the pool (round-robin for even distribution)
                local defName = defPool[((i - 1) % #defPool) + 1]

                -- Map legacy def names to actual unit defs
                local actualDef = defName
                if defName == 'civ_person' then
                    actualDef = 'ms_civilians'
                elseif defName == 'civ_vehicle' then
                    actualDef = 'ms_civtruck'
                end

                -- Scatter around the site position, clear of the building
                local angle = math.random() * 2 * math.pi
                local radius = minRadius + math.random() * 50
                local x = site.pos.x + radius * math.cos(angle)
                local z = site.pos.z + radius * math.sin(angle)

                local unitID = spawn.one(civ, actualDef, x, z)
                if unitID then
                    civ.population[unitID].site = site.key
                    civ.population[unitID].homePos = { x = site.pos.x, z = site.pos.z }
                end
            end

            Spring.Log("Civilians", LOG.INFO, "Spawned " .. spawnCount .. " civilians at site " .. site.key)
        end
    end
end

return spawn
