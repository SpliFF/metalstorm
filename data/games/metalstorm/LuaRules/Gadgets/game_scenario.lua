-- game_scenario.lua — scenario world loader (PLAN-persistence.md §5).
--
-- Loads a declarative scenario file from scenarios/ at GameStart when the
-- room manifest names one (quickstart --direct manifest's top-level
-- "scenario" field, threaded through as the `scenario` modoption — see
-- rts/lobby_main.cpp runDirectStart): pre-set units, region ownership,
-- initial objectives, civilian population. No engine change — everything
-- below is existing Lua surface (Spring.CreateUnit/GiveOrderToUnit, the
-- backbone gadgets' GG.* APIs).
--
-- Consumers of the format:
--   * scenarios/tutorial_01.lua    — PLAN-metalstorm-onboarding §2
--   * scenarios/meridian_basin.lua — PLAN-metalstorm-beta-map §3 (default
--                                    beta opening)
--   * war templates               — PLAN-metalstorm-wars.md ("a scenario
--                                    file IS a war template")
--
-- LOAD ORDER CONTRACT: layer -90 — after authority/teams (pools exist),
-- before objectives/regions consumers seed from scenario state.
--
-- FILE-SCOPE NOTE (2026-07-19): game_regions.lua is being rewritten in the
-- concurrent `metalstorm-backbone` lane (commit 0838b8066b, unmerged as of
-- this writing) to a named map-authored region graph (PLAN-metalstorm-
-- regions.md) — but that rewrite is *also* read-only (ControllingTeam/
-- OwnerAt/CostModifierAt, no setter). world.regions below addresses by the
-- CURRENT grid model's key format ("gridX:gridZ", via GG.Regions.KeyAt) —
-- the only one this loader can act on today. Once the backbone rewrite
-- lands, both GG.Regions' setter and this loader's region addressing need
-- to move to named graph keys together; do not let one drift ahead alone.

function gadget:GetInfo()
    return {
        name    = "Scenario Loader",
        desc    = "Declarative world pre-set: units, region ownership, civilians, objectives from scenarios/",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = -90,             -- after authority (-100) / teams (-95)
        enabled = true,
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

local SUPPORTED_VERSION = 1
local DEFAULT_SPACING = 150        -- elmos between grid-spread squad instances

-- ============================================================
-- Helpers
-- ============================================================

--- name -> true for every unit def the loaded content actually ships.
-- `UnitDefs` is ID-indexed only (no name-keyed global exists in this
-- engine's Lua bindings), so this is a one-time linear pass at GameStart.
local function buildKnownDefNames()
    local known = {}
    for _, def in pairs(UnitDefs) do
        known[def.name] = true
    end
    return known
end

--- A scenario order names a command by its CMD.* constant name (e.g.
-- "FIGHT", "MOVE", "GUARD") or gives the numeric id directly. Returns nil
-- for anything else so callers can validate before acting.
local function resolveCmd(cmd)
    if type(cmd) == 'number' then return cmd end
    if type(cmd) == 'string' then
        local id = CMD[cmd]
        if type(id) == 'number' then return id end
    end
    return nil
end

--- Deterministic spread for `count` copies of one unit entry: a square-ish
-- grid centred on (x, z), `spacing` elmos apart. count=1 returns the
-- original point untouched.
local function gridOffsets(count, spacing)
    count = count or 1
    spacing = spacing or DEFAULT_SPACING
    local cols = math.ceil(math.sqrt(count))
    local offsets = {}
    for i = 0, count - 1 do
        local row = math.floor(i / cols)
        local col = i % cols
        offsets[#offsets + 1] = {
            (col - (cols - 1) / 2) * spacing,
            (row - (cols - 1) / 2) * spacing,
        }
    end
    return offsets
end

-- ============================================================
-- Validation (E6) — check everything before spawning anything
-- ============================================================

local function validate(scn, knownDefs)
    local errors = {}

    local function checkDef(def, ctx)
        if type(def) ~= 'string' or not knownDefs[def] then
            errors[#errors + 1] = ctx .. ': unknown unit def "' .. tostring(def) .. '"'
        end
    end

    local function checkOrders(orders, ctx)
        for i, o in ipairs(orders or {}) do
            if resolveCmd(o.cmd) == nil then
                errors[#errors + 1] = ctx .. ' orders[' .. i .. ']: unknown cmd "' .. tostring(o.cmd) .. '"'
            end
        end
    end

    for i, u in ipairs(scn.units or {}) do
        checkDef(u.def, 'units[' .. i .. ']')
        checkOrders(u.orders, 'units[' .. i .. ']')
    end

    for i, c in ipairs((scn.civilians or {}).units or {}) do
        checkDef(c.def, 'civilians.units[' .. i .. ']')
    end

    for i, r in ipairs((scn.world or {}).regions or {}) do
        if r.key == nil and (r.x == nil or r.z == nil) then
            errors[#errors + 1] = 'world.regions[' .. i .. ']: needs either "key" or "x"/"z"'
        end
    end

    return errors
end

-- ============================================================
-- Staging — one function per schema section, called only once validation
-- passes clean.
-- ============================================================

local function stageRegions(regions)
    for _, r in ipairs(regions or {}) do
        local key = r.key or GG.Regions.KeyAt(r.x, r.z)
        local team = r.team
        if team == 'contested' or team == 'neutral' then team = nil end
        GG.Regions.SetControllingTeam(key, team)
    end
end

local function stageUnits(units)
    for _, u in ipairs(units or {}) do
        for _, off in ipairs(gridOffsets(u.count, u.spacing)) do
            local ux, uz = u.x + off[1], u.z + off[2]
            local uy = Spring.GetGroundHeight(ux, uz)
            local unitID = Spring.CreateUnit(u.def, ux, uy, uz, u.facing or 'south', u.team)
            if unitID and u.orders then
                for _, o in ipairs(u.orders) do
                    Spring.GiveOrderToUnit(unitID, resolveCmd(o.cmd), o.params or {}, o.options or {})
                end
            end
        end
    end
end

local function stageCivilians(civilians)
    for _, c in ipairs((civilians or {}).units or {}) do
        local unitID = GG.Civilians.Spawn(c.def, c.x, c.z, c.facing or 'south')
        if unitID and c.role then
            GG.Civilians.Register(unitID, c.role)
        end
    end
end

-- ============================================================
-- Deferred objective population for runtime-spawned units (civilians/convoys)
-- ============================================================
local deferredObjectives = {}

local function populateCiviliansInArea(x, z, r, role)
    -- Find all civilian units in the specified area with the given role
    local result = {}
    local units = Spring.GetUnitsInCylinder(x, z, r)
    for _, unitID in ipairs(units) do
        local udid = Spring.GetUnitDefID(unitID)
        local ud = udid and UnitDefs[udid]
        if ud and ud.customParams and ud.customParams.is_civilian then
            -- Check role if specified
            if not role or (GG.Civilians.GetRole and GG.Civilians.GetRole(unitID) == role) then
                result[#result + 1] = unitID
            end
        end
    end
    return result
end

local function resolveDeferredObjectives()
    for _, o in ipairs(deferredObjectives) do
        local params = o.params or {}

        -- Populate targetUnitIDs from area query if specified
        if o._populateTargetsFrom then
            local area = o._populateTargetsFrom
            params.targetUnitIDs = populateCiviliansInArea(area.x, area.z, area.r, area.role)
            Spring.Echo('[game_scenario] populated ' .. #params.targetUnitIDs ..
                       ' civilian targets for ' .. (o.type or 'unknown') .. ' objective')
        end

        -- Populate payloadUnitIDs from area query if specified
        if o._populatePayloadFrom then
            local area = o._populatePayloadFrom
            params.payloadUnitIDs = populateCiviliansInArea(area.x, area.z, area.r, area.role)
            Spring.Echo('[game_scenario] populated ' .. #params.payloadUnitIDs ..
                       ' civilian payload for ' .. (o.type or 'unknown') .. ' objective')
        end

        -- Only create if we have units (empty arrays fail init validation)
        if (not params.targetUnitIDs or #params.targetUnitIDs > 0) and
           (not params.payloadUnitIDs or #params.payloadUnitIDs > 0) then
            local def = {
                type = o.type,
                scope = o.scope,
                forTeam = o.forTeam,
                reward = o.reward,
                expiresAtFrame = o.expiresAtFrame,
                params = params,
            }
            local id = GG.Objectives.Create(def)
            if id then
                Spring.Echo('[game_scenario] created deferred objective ' .. id ..
                           ' (' .. o.type .. ')')
            else
                Spring.Echo('[game_scenario] WARNING: failed to create deferred ' ..
                           o.type .. ' objective')
            end
        else
            Spring.Echo('[game_scenario] skipped ' .. o.type ..
                       ' objective (no units found or empty payload)')
        end
    end
    deferredObjectives = {}
end

local function stageObjectives(objectives)
    for _, o in ipairs(objectives or {}) do
        -- Authoring convenience: flat type-specific fields (region,
        -- targetUnitID, duration) fold into GG.Objectives.Create's `params`
        -- sub-table — the shape game_objectives.lua's evaluators read.
        local params = o.params or {}
        if o.region and params.region == nil then params.region = o.region end
        if o.targetUnitID and params.targetUnitID == nil then params.targetUnitID = o.targetUnitID end
        if o.duration and params.duration == nil then params.duration = o.duration end

        -- Check if this objective needs runtime unit population
        -- (empty targetUnitIDs/payloadUnitIDs + a _populateFrom marker)
        local needsTargets = o._populateTargetsFrom ~= nil
        local needsPayload = o._populatePayloadFrom ~= nil

        if needsTargets or needsPayload then
            -- Defer creation until after civilians spawn
            deferredObjectives[#deferredObjectives + 1] = o
            Spring.Echo('[game_scenario] deferred ' .. (o.type or 'unknown') ..
                       ' objective (will populate units at frame 30)')
        else
            -- Create immediately
            GG.Objectives.Create({
                type = o.type, scope = o.scope, forTeam = o.forTeam,
                reward = o.reward, bounty = o.bounty, params = params,
                expiresAtFrame = o.expiresAtFrame,
            })
        end
    end
end

-- ============================================================

GG.Scenario = GG.Scenario or {}

function gadget:GameStart()
    local name = Spring.GetModOptions().scenario
    if name == nil or name == '' then
        return  -- no scenario declared — game_start.lua's default force applies
    end

    local scn = VFS.Include('scenarios/' .. name .. '.lua')
    if type(scn) ~= 'table' then
        error('[game_scenario] scenarios/' .. name .. '.lua did not return a table')
    end
    if scn.version ~= SUPPORTED_VERSION then
        error('[game_scenario] scenarios/' .. name .. '.lua: unsupported version ' .. tostring(scn.version) ..
              ' (loader supports ' .. SUPPORTED_VERSION .. ')')
    end

    local errors = validate(scn, buildKnownDefNames())
    if #errors > 0 then
        error('[game_scenario] scenarios/' .. name .. '.lua failed validation:\n  ' ..
              table.concat(errors, '\n  '))
    end

    if scn.orders and #scn.orders > 0 then
        -- Standalone standing orders / macro-directives have no mechanism
        -- yet (PLAN-metalstorm-macro, gated on Q-D-d) — loud, not silent.
        Spring.Echo('[game_scenario] WARNING: scenario "' .. name .. '" declares ' ..
                    #scn.orders .. ' standalone order(s) — no standing-order ' ..
                    'system exists yet; ignored. Use per-unit `orders` instead.')
    end

    stageRegions((scn.world or {}).regions)
    stageUnits(scn.units)
    stageCivilians(scn.civilians)
    stageObjectives(scn.objectives)

    GG.Scenario.name = name
    GG.Scenario.data = scn
    Spring.SetGameRulesParam('scenario_name', name)

    Spring.Echo('[game_scenario] staged "' .. (scn.name or name) .. '"')
end

function gadget:GameFrame(frame)
    -- Resolve deferred objectives after civilians have had a chance to spawn
    -- (civilians spawn at GameStart via stageCivilians, so frame 30 = 1 second
    -- after game start gives them time to settle)
    if frame == 30 and #deferredObjectives > 0 then
        Spring.Echo('[game_scenario] resolving ' .. #deferredObjectives ..
                   ' deferred objectives at frame 30')
        resolveDeferredObjectives()
    end
end
