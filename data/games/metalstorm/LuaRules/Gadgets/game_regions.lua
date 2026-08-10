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
local Cost      = VFS.Include("LuaRules/Gadgets/regions/cost.lua")
local Tick      = VFS.Include("LuaRules/Gadgets/tick.lua")

GG.Regions = GG.Regions or {}

local EVAL_PERIOD = 150            -- frames (5 s)
-- D15: skip-safe cadence (see tick.lua). Observation policy — ownership is
-- sampled from where units are standing *now*, so a stall that stepped over
-- several periods must yield one sample, not several copies of one. The
-- stickiness counters in regions/ownership.lua count ticks, so under sustained
-- overload FLIP_TICKS/DECAY_TICKS stretch in frame terms; that is the
-- conservative direction and is documented in tick.lua's header.
local evalGate = Tick.new(EVAL_PERIOD)

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

    -- Empty list = INVALID → grid (align to C++ ExtractRegions `haveGraph =
    -- !empty`; an empty graph is not "everything is wilds").
    if graphRegions and #graphRegions > 0 then
        -- pcall the whole provider build (not just VFS.Include): even with the
        -- defensive validateGraph, pathological authored data must fall back to
        -- grid rather than remove this gadget (and, downstream, game_authority)
        -- under SAFEWRAP — the E2 contract.
        local ok, graphProvider, errors = pcall(Partition.newGraphProvider, graphRegions, mapWidth, mapHeight)
        if ok and graphProvider then
            Spring.Echo(string.format("[RegionControl] loaded map graph (%d regions)", #graphRegions))
            provider, providerKind = graphProvider, "graph"
            return
        end
        Spring.Echo("[RegionControl] mapdata/regions.lua failed validation, falling back to grid:")
        if not ok then
            Spring.Echo("[RegionControl]   error building graph: " .. tostring(graphProvider))
        else
            for _, e in ipairs(errors or {}) do
                Spring.Echo("[RegionControl]   " .. e)
            end
        end
    end

    provider, providerKind = Partition.newGridProvider(mapWidth, mapHeight), "grid"
end

-- ============================================================
-- GG.Regions API (§4 — the consumer contract)
-- ============================================================
--
-- Change notification is POLL, not callback (ratified 2026-07-19): there is no
-- listener registry. Consumers re-read ControllingTeam/GetContested/OwnerAt as
-- needed; the `regions_rev` rulesParam (bumped on any owner/contested change,
-- see publish() below) is the cheap "did anything change since I last looked?"
-- signal for consumers that want to skip redundant work.

local function regionMeta(key)
    return provider.byKey and provider.byKey[key]
end

--- Shallow copy of an array — GG.Regions accessors that expose authored
--- metadata (Tags/Neighbors) hand back copies so a consumer mutating the
--- result can't corrupt the shared region graph.
local function copyList(t)
    local out = {}
    for i = 1, #t do out[i] = t[i] end
    return out
end

function GG.Regions.ControllingTeam(key)
    local rs = ownershipState[key]
    return rs and rs.owner or nil
end

--- Region key at a world position (position→key). The public entry point for
--- "which region is this unit in" — Value/Tags/Neighbors are keyed off it.
function GG.Regions.KeyAt(x, z)
    return provider.at(x, z)
end

--- Enumerate every region key the active provider knows (incl. the synthetic
--- "wilds" for the graph provider). Returns a fresh list — safe to mutate.
function GG.Regions.Keys()
    return provider.keys and copyList(provider.keys()) or {}
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
    return (meta and meta.tags) and copyList(meta.tags) or {}
end

function GG.Regions.Neighbors(key)
    local meta = regionMeta(key)
    return (meta and meta.neighbors) and copyList(meta.neighbors) or {}
end

--- Order-cost modifier for the region a unit stands in (§4). Alliance-aware:
--- friendly territory (owner allied to the unit's team) is cheap — the
--- decision itself lives in the pure regions/cost.lua so it's busted-testable.
function GG.Regions.CostModifierAt(unitID)
    local x, _, z = Spring.GetUnitPosition(unitID)
    if not x then return Cost.MOD_NEUTRAL end
    local team = GG.Regions.OwnerAt(x, z)
    if team == nil then return Cost.MOD_NEUTRAL end
    local unitTeam = Spring.GetUnitTeam(unitID)
    if not unitTeam then return Cost.MOD_NEUTRAL end
    return Cost.orderModifier(team, Spring.AreTeamsAllied(team, unitTeam))
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

-- Region control + geometry is the shared strategic board (same as
-- objectives): published PUBLIC so it streams to browser clients. Game rules
-- params default to RULESPARAMLOS_PRIVATE (synced-only) — that is why
-- game_objectives.lua publishes PUBLIC too. The command composer's Target
-- picker (named-entity-index) and the strategic-map overlay both read these
-- client-side; without PUBLIC the client's rulesParams mirror never sees them.
local PUBLIC = { public = true }

--- Publish each region's static descriptor — display name + polygon centroid —
--- ONCE at setup. Names and geometry don't change during a game, so this is a
--- one-shot write, not part of the per-change publish() path. Only the graph
--- provider carries authored metadata; grid regions are synthetic and nameless
--- (byKey empty), so a grid map contributes no named *places* to the composer —
--- objectives (which publish their own x/z) still populate the Target picker.
--- The centroid is the vertex average: enough for a locate-ping and an
--- "attack <region>" target, never a point-in-region fill test (regions.js
--- owns the exact partition geometry from the map export).
local function publishRegionStatics()
    if not provider.byKey then return end
    for _, key in ipairs(provider.keys and provider.keys() or {}) do
        if key ~= "wilds" then
            local meta = provider.byKey[key]
            if meta and type(meta.polygon) == "table" and #meta.polygon > 0 then
                local sx, sz = 0, 0
                for _, v in ipairs(meta.polygon) do sx = sx + v.x; sz = sz + v.z end
                local n = #meta.polygon
                Spring.SetGameRulesParam('region_' .. key .. '_name', meta.name or key, PUBLIC)
                Spring.SetGameRulesParam('region_' .. key .. '_x', sx / n, PUBLIC)
                Spring.SetGameRulesParam('region_' .. key .. '_z', sz / n, PUBLIC)
            end
        end
    end
end

local function publish(changedKeys)
    if #changedKeys == 0 then return end
    for _, key in ipairs(changedKeys) do
        local rs = ownershipState[key]
        Spring.SetGameRulesParam('region_' .. key .. '_team', rs.owner or -1, PUBLIC)
        Spring.SetGameRulesParam('region_' .. key .. '_contested', rs.contested and 1 or 0, PUBLIC)
    end
    regionsRev = regionsRev + 1
    Spring.SetGameRulesParam('regions_rev', regionsRev, PUBLIC)
end

-- Set up the partition in Initialize, not GameStart: this closes the window
-- where GG.Regions.* closures are registered but `provider` is still nil (a
-- pre-GameStart caller would otherwise index nil), and covers a mid-game
-- gadget reload — Initialize runs on both cold start and reload, GameStart
-- only on cold start.
function gadget:Initialize()
    gaiaTeam = Spring.GetGaiaTeamID()
    setupPartition()
    publishRegionStatics()
end

--- Explicit ownership override (scenario preset at GameStart, GM tools).
--- teamID = nil clears to uncontrolled; the periodic evaluator (GameFrame)
--- may still flip a key on its next EVAL_PERIOD tick once units are present
--- — this only seeds the starting state, it doesn't freeze it.
function GG.Regions.SetControllingTeam(key, teamID)
    Ownership.setOwner(ownershipState, key, teamID)
    Spring.SetGameRulesParam('region_' .. key .. '_team', teamID or -1, PUBLIC)
end

function gadget:GameFrame(frame)
    if not Tick.due(evalGate, frame) then return end
    local units = gatherUnits()
    local scores = Control.computeScores(units, provider, gaiaTeam)
    local _, changedKeys = Ownership.step(ownershipState, scores)
    publish(changedKeys)
end
