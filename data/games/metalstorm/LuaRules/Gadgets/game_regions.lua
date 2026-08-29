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

--- The region's extent as a circle: `x, z, r`, or nil for a key the active
--- provider cannot place (an unknown key, or the graph provider's synthetic
--- "wilds", which has no polygon).
---
--- Added for battle-clarity U2: an objective that names a region has to be
--- findable by LOOKING, and a ring needs a radius. `region_<key>_x/_z` were
--- already published but carried no extent, so an objective on a region could
--- only ever be drawn as a point. The approximation each provider makes — and
--- why they differ — is documented on `partition.lua`'s `regionCircle`.
function GG.Regions.Area(key)
    if not provider or not provider.area then return nil end
    return provider.area(key)
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

--- Publish each region's static descriptor — display name + centre point —
--- ONCE at setup. Names and geometry don't change during a game, so this is a
--- one-shot write, not part of the per-change publish() path.
---
--- BOTH providers publish, through the identical `region_<key>_name/_x/_z`
--- shape (PLAN-metalstorm-command-language.md §5):
---
---   * graph — the AUTHORED name and the region's own `centre` when it ships
---     one (M9m), else the polygon's vertex-average centroid.
---     Enough for a locate-ping and an "attack <region>" target, never a
---     point-in-region fill test (regions.js owns the exact partition geometry
---     from the map export).
---   * grid  — a DERIVED name ("Sector B9", partition.lua) and the clipped
---     cell centre. Grid cells carry no authored metadata (byKey is empty), so
---     until this landed a grid map contributed zero named places and "zoom to
---     sector B9" was impossible on every map without a hand-written
---     mapdata/regions.lua. Authored names stay primary: a map that ships a
---     valid graph never reaches the grid branch at all.
---
--- The client needs no change for either — entity-index-producer.ts already
--- parses this shape, so the names reach the command console, the AI and the
--- authority layer by the path that was already there.
local function publishRegionStatics()
    if provider.sectors then
        for _, s in ipairs(provider.sectors()) do
            Spring.SetGameRulesParam('region_' .. s.key .. '_name', s.name, PUBLIC)
            Spring.SetGameRulesParam('region_' .. s.key .. '_x', s.x, PUBLIC)
            Spring.SetGameRulesParam('region_' .. s.key .. '_z', s.z, PUBLIC)
        end
        return
    end

    if not provider.byKey then return end
    for _, key in ipairs(provider.keys and provider.keys() or {}) do
        if key ~= "wilds" then
            local meta = provider.byKey[key]
            if meta and type(meta.polygon) == "table" and #meta.polygon > 0 then
                local cx, cz
                local centre = meta.centre
                if type(centre) == "table" and type(centre.x) == "number"
                        and type(centre.z) == "number" then
                    -- An AUTHORED centre wins. Since M9m a generated region's
                    -- polygon is its component's coastline rather than a
                    -- rectangle, and the vertex average of a coastline lands
                    -- wherever the vertices are dense — routinely outside the
                    -- region and often at sea. The generator knows a point that
                    -- is inside and on the region's own passable ground, so it
                    -- ships one; this is the locate-ping and the "attack
                    -- <region>" target, so it has to be somewhere an order can
                    -- actually be sent.
                    cx, cz = centre.x, centre.z
                else
                    local sx, sz = 0, 0
                    for _, v in ipairs(meta.polygon) do sx = sx + v.x; sz = sz + v.z end
                    cx, cz = sx / #meta.polygon, sz / #meta.polygon
                end
                Spring.SetGameRulesParam('region_' .. key .. '_name', meta.name or key, PUBLIC)
                Spring.SetGameRulesParam('region_' .. key .. '_x', cx, PUBLIC)
                Spring.SetGameRulesParam('region_' .. key .. '_z', cz, PUBLIC)
            end
        end
    end
end

-- Owner as of the last publish, per key. Only the digest reads it (below):
-- `changedKeys` is the hysteresis machine's "something about this key moved"
-- list and includes contest flips, which are not a change of hands and must
-- not read as one in a week-long war's history.
local lastLoggedOwner = {}

--- The authored display name of a region, or the raw key on a grid map (which
--- is synthetic and nameless). Read from the provider rather than from the
--- published `_name` param so it works before publishRegionStatics has run.
local function regionLabel(key)
    local meta = provider.byKey and provider.byKey[key]
    return (meta and meta.name) or key
end

local function publish(changedKeys)
    if #changedKeys == 0 then return end
    for _, key in ipairs(changedKeys) do
        local rs = ownershipState[key]
        Spring.SetGameRulesParam('region_' .. key .. '_team', rs.owner or -1, PUBLIC)
        Spring.SetGameRulesParam('region_' .. key .. '_contested', rs.contested and 1 or 0, PUBLIC)
        -- The while-you-were-away digest (PLAN-persistence task 4b). A region
        -- changing hands is the coarsest true statement about how a war moved
        -- while nobody was watching, so it is the digest's backbone.
        if lastLoggedOwner[key] ~= rs.owner then
            if GG.WarLog then
                GG.WarLog.Emit('region', regionLabel(key),
                               rs.owner and 'captured' or 'lost', rs.owner or -1)
            end
            lastLoggedOwner[key] = rs.owner
        end
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

--- Rename a region, and optionally move the centre it publishes.
---
--- The one thing that changes a region's STATIC descriptor after
--- `publishRegionStatics` has run, and it exists for exactly one caller: a
--- scenario that plants a town in a region (tools/mapgen/town_planner.py, via
--- game_scenario.lua's `world.regions[].name`). A region is kilometres of
--- ground; when a settlement is the only part of it a player can point at, the
--- name and the locate-ping should both be the settlement's.
---
--- `x`/`z` are optional and are omitted rather than defaulted, so a rename
--- alone leaves the polygon centroid `publishRegionStatics` computed in place.
--- Both go out PUBLIC on the same keys the one-shot publish uses — the client's
--- named-entity index re-reads `region_<key>_name/_x/_z` off its rulesParams
--- mirror, so a later write simply wins; there is no separate rename channel to
--- keep in step.
---
--- Note this does NOT touch `region_<key>_team`/`_contested` or bump
--- `regions_rev`: that counter means "control changed", and a scenario naming
--- its towns at GameStart has changed no control.
function GG.Regions.SetName(key, name, x, z)
    if type(key) ~= 'string' or type(name) ~= 'string' then return end
    Spring.SetGameRulesParam('region_' .. key .. '_name', name, PUBLIC)
    if type(x) == 'number' and type(z) == 'number' then
        Spring.SetGameRulesParam('region_' .. key .. '_x', x, PUBLIC)
        Spring.SetGameRulesParam('region_' .. key .. '_z', z, PUBLIC)
    end
end

--- Explicit ownership override (scenario preset at GameStart, GM tools).
--- teamID = nil clears to uncontrolled; the periodic evaluator (GameFrame)
--- may still flip a key on its next EVAL_PERIOD tick once units are present
--- — this only seeds the starting state, it doesn't freeze it.
function GG.Regions.SetControllingTeam(key, teamID)
    Ownership.setOwner(ownershipState, key, teamID)
    Spring.SetGameRulesParam('region_' .. key .. '_team', teamID or -1, PUBLIC)
    -- Deliberately NOT a digest event, and the cursor is moved so the next
    -- publish() does not report it as one: a scenario preset is the war's
    -- starting position, not something that happened during it, and a GM
    -- override is an operator action the audit trail already records.
    lastLoggedOwner[key] = teamID
end

-- ─────────────── Snapshot state (PLAN-persistence task 1d-b, §7.1d) ───────────────
--
-- CAPTURED — `ownershipState`. It is the hysteresis machine itself, and every
-- field of it is authored by ticks that already happened: `owner` (which a
-- scenario or a GM may also have set outright, so it is not a function of the
-- current board), the per-team `leadTicks` streaks, `contested`, and
-- `emptyTicks`. Recomputing it from the restored world would be wrong in the
-- direction that matters most: a region three ticks into a flip reverts to
-- zero progress, and a sticky owner 59 ticks into its 60-tick decay is handed
-- another five minutes of ownership.
--
-- CAPTURED — `regionsRev`. It is a generation counter clients diff against;
-- restoring the world without it lets a client that has seen rev 400 read the
-- restored rev 12 and conclude nothing has changed since.
--
-- CAPTURED — the eval gate's phase (see tick.lua's own snapshot note).
--
-- RE-DERIVED, not captured — `provider`/`providerKind` (rebuilt by Initialize
-- from `mapdata/regions.lua`, which is map content and cannot differ between
-- capture and restore of the same war) and `gaiaTeam`.
--
-- NOT REPUBLISHED — the `region_*` rulesParams. They are game rules params and
-- ride the snapshot's own `gameRules` section, which is applied immediately
-- before this call: republishing here could only write the same values, and
-- publish() is change-driven (it would write nothing at all, since it takes a
-- changed-key list).
function gadget:Save(state)
    state.ownership = ownershipState
    state.regionsRev = regionsRev
    state.evalGate = Tick.save(evalGate)
end

function gadget:Load(state)
    -- Defaults spelled out rather than "keep what this process has": a restore
    -- to before a region was ever contested must CLEAR it, and an absent key
    -- means the empty state machine, never the live one.
    ownershipState = state.ownership or Ownership.newState()
    regionsRev = tonumber(state.regionsRev) or 0
    Tick.load(evalGate, state.evalGate)
    -- RE-DERIVED, not captured. The digest cursor is a function of the state
    -- that WAS captured, and re-deriving it is the only reading that is right
    -- on both paths: nothing changed hands between the checkpoint and the
    -- resume, so a resumed war must not open by reporting every region it
    -- already held as freshly captured.
    lastLoggedOwner = {}
    for key, rs in pairs(ownershipState) do
        if type(rs) == 'table' then lastLoggedOwner[key] = rs.owner end
    end
end

function gadget:GameFrame(frame)
    if not Tick.due(evalGate, frame) then return end
    local units = gatherUnits()
    local scores = Control.computeScores(units, provider, gaiaTeam)
    local _, changedKeys = Ownership.step(ownershipState, scores)
    publish(changedKeys)
end
