-- civilians/routines.lua — ambient behaviour (wander / flee).
-- Plain library module (NOT a gadget). Included by game_civilians.lua.
local routines = {}

local CMD_MOVE = CMD.MOVE

--- Helper: find the nearest site to a position
local function findNearestSite(civ, x, z, excludeSite)
    local minDist = math.huge
    local nearest = nil

    -- Gather all sites from civilian population (buildings have .site field)
    local sites = {}
    for unitID, data in pairs(civ.population) do
        if data.site and data.site ~= excludeSite then
            local sx, _, sz = Spring.GetUnitPosition(unitID)
            if sx then
                local siteKey = data.site
                if not sites[siteKey] then
                    sites[siteKey] = { x = sx, z = sz, key = siteKey }
                end
            end
        end
    end

    -- Find nearest
    for _, site in pairs(sites) do
        local dx = site.x - x
        local dz = site.z - z
        local dist = math.sqrt(dx * dx + dz * dz)
        if dist < minDist then
            minDist = dist
            nearest = site
        end
    end

    return nearest
end

--- Helper: is a region safe for civilians? Unsafe only while CONTESTED (active
--- fighting) — matches estate.lua's credible-threat model (PLAN-metalstorm-
--- interaction.md §3: a threat is enemy presence, not mere non-gaia
--- ownership). A team peacefully holding its home district (the common case:
--- every scenario's districts are pre-owned by a faction from GameStart) is
--- not itself a threat to bystanders — only live combat is.
local function isRegionSafe(regionKey, gaiaTeam)
    local owner = GG.Regions.ControllingTeam(regionKey)
    if owner == nil or owner == gaiaTeam then
        return true
    end

    local contested = GG.Regions.GetContested()
    for _, key in ipairs(contested) do
        if key == regionKey then
            return false
        end
    end

    return true
end

--- Helper: find the nearest safe region from current position
local function findNearestSafeRegion(x, z, gaiaTeam)
    local currentKey = GG.Regions.KeyAt(x, z)
    if isRegionSafe(currentKey, gaiaTeam) then
        return nil -- already safe
    end

    -- Check all neighboring regions for safety
    local neighbors = GG.Regions.Neighbors(currentKey)
    local bestNeighbor = nil

    for _, neighborKey in ipairs(neighbors) do
        if isRegionSafe(neighborKey, gaiaTeam) then
            bestNeighbor = neighborKey
            break
        end
    end

    -- If no safe neighbor found, try to move to gaia-controlled regions
    if not bestNeighbor then
        local allKeys = GG.Regions.Keys()
        for _, key in ipairs(allKeys) do
            if isRegionSafe(key, gaiaTeam) then
                bestNeighbor = key
                break
            end
        end
    end

    return bestNeighbor
end

--- Tick ambient civilians: idle wander between sites, flee combat regions.
function routines.tick(civ, frame)
    local gaiaTeam = civ.gaiaTeam

    for unitID, data in pairs(civ.population) do
        -- Only manage 'ambient' role civilians (not convoy or payload)
        if data.role ~= 'ambient' then
            goto continue
        end

        local x, y, z = Spring.GetUnitPosition(unitID)
        if not x then
            goto continue
        end

        -- Check if in a threatened region
        local regionKey = GG.Regions.KeyAt(x, z)
        local isSafe = isRegionSafe(regionKey, gaiaTeam)

        if not isSafe then
            -- FLEE: region is contested or enemy-controlled
            local safeRegion = findNearestSafeRegion(x, z, gaiaTeam)
            if safeRegion then
                -- Move toward home site if we have one, otherwise toward nearest safe site
                if data.homePos then
                    local fx, fz = data.homePos.x, data.homePos.z
                    local fy = Spring.GetGroundHeight(fx, fz)
                    Spring.GiveOrderToUnit(unitID, CMD_MOVE, { fx, fy, fz }, {})
                else
                    -- Find any safe site
                    local site = findNearestSite(civ, x, z, nil)
                    if site then
                        local sy = Spring.GetGroundHeight(site.x, site.z)
                        Spring.GiveOrderToUnit(unitID, CMD_MOVE, { site.x, sy, site.z }, {})
                    end
                end
            end
        else
            -- WANDER: safe region, do ambient movement
            -- Check if unit is idle
            local commands = Spring.GetUnitCommands(unitID, 1)
            if not commands or #commands == 0 then
                -- Unit is idle, give it a wander order
                -- 50% chance to wander, to avoid constant movement
                if math.random() < 0.5 then
                    local site = findNearestSite(civ, x, z, data.site)
                    if site then
                        -- Move to a random point near the site (not exactly at it)
                        local angle = math.random() * 2 * math.pi
                        local radius = 50 + math.random() * 100
                        local tx = site.x + radius * math.cos(angle)
                        local tz = site.z + radius * math.sin(angle)
                        local ty = Spring.GetGroundHeight(tx, tz)
                        Spring.GiveOrderToUnit(unitID, CMD_MOVE, { tx, ty, tz }, {})
                    end
                end
            end
        end

        ::continue::
    end
end

return routines
