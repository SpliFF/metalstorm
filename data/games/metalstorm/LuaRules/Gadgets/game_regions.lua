-- game_regions.lua — map region control (PLAN-metalstorm-regions.md).
--
-- The region-control system every other backbone piece consumes:
-- partitioning (grid + map-authored graph), the control score with
-- hysteresis, and the GG.Regions API for order costs, objectives, the
-- strategic-map overlay, and civilian behaviour.
--
-- STRUCTURE: this gadget is intentionally THIN — the actual logic is pure
-- Lua in the `regions/` library folder (invisible to the non-recursive
-- gadget scanner, same convention as `civilians/`), which makes it testable
-- with busted and NO Spring/GG mocking (see regions/tests/).
--
-- Control is published to rulesParams (region_<key>_team / _contested) for
-- client reads, batched under a `regions_rev` change counter (§5) — writes
-- happen only when a region's owner or contested flag actually changes.

function gadget:GetInfo()
    return {
        name    = "Region Control",
        desc    = "Region grid + map-authored graph, control score with hysteresis, order-cost modifiers",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = -90,
        enabled = true,
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

local Partition = VFS.Include("LuaRules/Gadgets/regions/partition.lua")
local Control   = VFS.Include("LuaRules/Gadgets/regions/control.lua")
local Ownership = VFS.Include("LuaRules/Gadgets/regions/ownership.lua")

GG.Regions = GG.Regions or {}

local EVAL_PERIOD = 150            -- frames (5 s)

-- Cost modifiers (PLAN-metalstorm.md §4): friendly cheap, enemy expensive.
local MOD_FRIENDLY = 0.5
local MOD_NEUTRAL  = 1.0
local MOD_ENEMY    = 2.0

local provider              -- partition provider in use (grid or graph)
local providerKind          -- "grid" | "graph" — mirrors client's regions.json provider field
local ownershipState = Ownership.newState()
local regionsRev = 0
local gaiaTeam

-- ============================================================
-- Partition setup — map-authored graph if present & valid, else grid (E2).
-- ============================================================

local function loadMapRegions()
    if not VFS.FileExists("mapdata/regions.lua", VFS.MAP) then
        return nil
    end
    local ok, dataOrErr = pcall(VFS.Include, "mapdata/regions.lua", nil, VFS.MAP)
    if not ok then
        Spring.Echo("[RegionControl] mapdata/regions.lua failed to load: " .. tostring(dataOrErr))
        return nil
    end
    if type(dataOrErr) ~= "table" or type(dataOrErr.regions) ~= "table" then
        Spring.Echo("[RegionControl] mapdata/regions.lua did not return { regions = {...} }")
        return nil
    end
    return dataOrErr.regions
end

local function setupPartition()
    local mapWidth, mapHeight = Game.mapSizeX, Game.mapSizeZ
    local graphRegions = loadMapRegions()

    if graphRegions then
        local graphProvider, errors = Partition.newGraphProvider(graphRegions, mapWidth, mapHeight)
        if graphProvider then
            Spring.Echo(string.format("[RegionControl] loaded map graph (%d regions)", #graphRegions))
            provider, providerKind = graphProvider, "graph"
            return
        end
        Spring.Echo("[RegionControl] mapdata/regions.lua failed validation, falling back to grid:")
        for _, e in ipairs(errors or {}) do
            Spring.Echo("[RegionControl]   " .. e)
        end
    end

    provider, providerKind = Partition.newGridProvider(mapWidth, mapHeight), "grid"
end

-- ============================================================
-- GG.Regions API (§4 — the consumer contract)
-- ============================================================

local function regionMeta(key)
    return provider.byKey and provider.byKey[key]
end

function GG.Regions.ControllingTeam(key)
    local rs = ownershipState[key]
    return rs and rs.owner or nil
end

function GG.Regions.OwnerAt(x, z)
    return GG.Regions.ControllingTeam(provider.at(x, z))
end

function GG.Regions.GetContested()
    local out = {}
    for key, rs in pairs(ownershipState) do
        if rs.contested then out[#out + 1] = key end
    end
    return out
end

function GG.Regions.Value(key)
    local meta = regionMeta(key)
    return (meta and meta.value) or 0
end

function GG.Regions.Tags(key)
    local meta = regionMeta(key)
    return (meta and meta.tags) or {}
end

function GG.Regions.Neighbors(key)
    local meta = regionMeta(key)
    return (meta and meta.neighbors) or {}
end

--- Order-cost modifier for the region a unit stands in.
function GG.Regions.CostModifierAt(unitID)
    local x, _, z = Spring.GetUnitPosition(unitID)
    if not x then return MOD_NEUTRAL end
    local team = GG.Regions.OwnerAt(x, z)
    if team == nil then return MOD_NEUTRAL end
    local unitTeam = Spring.GetUnitTeam(unitID)
    if not unitTeam then return MOD_NEUTRAL end
    if Spring.AreTeamsAllied(team, unitTeam) then return MOD_FRIENDLY end
    return MOD_ENEMY
end

-- ============================================================
-- Eval tick — one bucketing pass, ownership step, publish-on-change (§6)
-- ============================================================

local function gatherUnits()
    local units = {}
    for _, unitID in ipairs(Spring.GetAllUnits()) do
        local team = Spring.GetUnitTeam(unitID)
        if team then
            local x, _, z = Spring.GetUnitPosition(unitID)
            local hp = Spring.GetUnitHealth(unitID)
            if x and hp then
                local udid = Spring.GetUnitDefID(unitID)
                local ud = udid and UnitDefs[udid]
                units[#units + 1] = {
                    x = x, z = z, team = team, hp = hp,
                    isBuilding = ud and ud.isBuilding or false,
                    moveClass  = (ud and ud.isAirUnit) and 'air' or nil,
                }
            end
        end
    end
    return units
end

local function publish(changedKeys)
    if #changedKeys == 0 then return end
    for _, key in ipairs(changedKeys) do
        local rs = ownershipState[key]
        Spring.SetGameRulesParam('region_' .. key .. '_team', rs.owner or -1)
        Spring.SetGameRulesParam('region_' .. key .. '_contested', rs.contested and 1 or 0)
    end
    regionsRev = regionsRev + 1
    Spring.SetGameRulesParam('regions_rev', regionsRev)
end

function gadget:GameStart()
    gaiaTeam = Spring.GetGaiaTeamID()
    setupPartition()
end

function gadget:GameFrame(frame)
    if frame % EVAL_PERIOD ~= 0 then return end
    local units = gatherUnits()
    local scores = Control.computeScores(units, provider, gaiaTeam)
    local _, changedKeys = Ownership.step(ownershipState, scores)
    publish(changedKeys)
end
