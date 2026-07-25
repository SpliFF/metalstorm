-- civilians/convoy.lua — civilian vehicle convoys.
-- Plain library module (NOT a gadget). Included by game_civilians.lua.
-- Convoys are the natural payload for escort/extraction objectives.
local convoy = {}

-- Active convoys: route_id → { unitID, waypointIndex, ... }
local activeConvoys = {}

-- Next spawn time for each route: route_id → frame
local nextSpawn = {}

--- Spawn a new convoy vehicle for a route
local function spawnConvoyVehicle(civ, route)
    if not route.waypoints or #route.waypoints == 0 then
        return nil
    end

    -- Map legacy def names to actual defs
    local defName = route.defName
    if defName == 'civ_truck' then
        defName = 'ms_civtruck'
    elseif defName == 'civ_bus' then
        defName = 'ms_civbus'
    end

    local wp1 = route.waypoints[1]
    local y = Spring.GetGroundHeight(wp1.x, wp1.z)
    local unitID = Spring.CreateUnit(defName, wp1.x, y, wp1.z, 'south', civ.gaiaTeam)

    if unitID then
        civ.population[unitID] = { role = 'convoy', route = route.id }
        activeConvoys[route.id] = activeConvoys[route.id] or {}
        table.insert(activeConvoys[route.id], {
            unitID = unitID,
            waypointIndex = 2,  -- Start heading to waypoint 2 (spawned at waypoint 1)
        })
        Spring.Log("Civilians", LOG.INFO, "Spawned convoy vehicle " .. unitID .. " for route " .. route.id)

        -- Let a scenario-staged escort objective for this route claim the
        -- vehicle as its payload (game_scenario.lua, deferred since no
        -- convoy unit exists at scenario-load time). Defensive nil-check:
        -- convoy.lua has no scenario dependency when none is loaded.
        if GG and GG.Scenario and GG.Scenario.NotifyConvoySpawn then
            GG.Scenario.NotifyConvoySpawn(route.id, unitID)
        end

        return unitID
    end

    return nil
end

--- Give move orders for a convoy unit along its waypoints
local function updateConvoyMovement(civ, route, convoyData)
    local unitID = convoyData.unitID

    -- Check if unit still exists
    if not Spring.ValidUnitID(unitID) then
        return false
    end

    -- Check if we've reached current waypoint (within 100 elmos)
    local ux, _, uz = Spring.GetUnitPosition(unitID)
    if not ux then return false end

    local wp = route.waypoints[convoyData.waypointIndex]
    if wp then
        local dx, dz = ux - wp.x, uz - wp.z
        local dist = math.sqrt(dx * dx + dz * dz)

        if dist < 100 then
            -- Reached waypoint, advance to next
            convoyData.waypointIndex = convoyData.waypointIndex + 1

            if convoyData.waypointIndex > #route.waypoints then
                -- Completed route, destroy vehicle and return false to remove from active list
                Spring.DestroyUnit(unitID, false, false)
                return false
            end
        end
    end

    -- Give move order to current waypoint
    wp = route.waypoints[convoyData.waypointIndex]
    if wp then
        Spring.GiveOrderToUnit(unitID, CMD.MOVE, { wp.x, Spring.GetGroundHeight(wp.x, wp.z), wp.z }, {})
    end

    return true
end

--- Tick convoy schedules: run civtrucks/buses between depots/transit hubs.
function convoy.tick(civ, frame)
    if not civ.convoyRoutes or #civ.convoyRoutes == 0 then
        return
    end

    -- Process each convoy route
    for _, route in ipairs(civ.convoyRoutes) do
        -- Initialize spawn timer for this route on first tick
        if not nextSpawn[route.id] then
            -- Schedule first spawn with a random stagger (0-60 seconds)
            nextSpawn[route.id] = frame + math.random(0, 1800)
        end

        -- Spawn new convoy if it's time
        if frame >= nextSpawn[route.id] then
            spawnConvoyVehicle(civ, route)
            -- Schedule next spawn (intervalSec is in seconds, convert to frames at 30 Hz)
            local intervalFrames = (route.intervalSec or 180) * 30
            nextSpawn[route.id] = frame + intervalFrames
        end

        -- Update movement for all active convoys on this route
        if activeConvoys[route.id] then
            local stillActive = {}
            for _, convoyData in ipairs(activeConvoys[route.id]) do
                if updateConvoyMovement(civ, route, convoyData) then
                    table.insert(stillActive, convoyData)
                end
            end
            activeConvoys[route.id] = stillActive
        end
    end
end

return convoy
