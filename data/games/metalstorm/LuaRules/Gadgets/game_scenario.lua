-- game_scenario.lua — scenario world loader (PLAN-persistence.md §5).
--
-- Loads a declarative scenario file from scenarios/ at GameStart when the
-- room manifest names one (quickstart --direct manifest's top-level
-- "scenario" field, threaded through as the `scenario` modoption — see
-- rts/lobby_main.cpp runDirectStart): pre-set units, region ownership,
-- initial objectives, civilian population, NPC faction AI slots. No engine
-- change — everything below is existing Lua surface
-- (Spring.CreateUnit/GiveOrderToUnit/SetTeamRulesParam, the backbone gadgets'
-- GG.* APIs).
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
-- FILE-SCOPE NOTE (2026-07-25, updated): game_regions.lua's named
-- map-authored region graph rewrite (PLAN-metalstorm-regions.md, commit
-- 0838b8066b) has LANDED, with a setter (GG.Regions.SetControllingTeam) that
-- world.regions below calls directly by key — no format assumption baked in
-- here. A map auto-selects the graph provider when it ships mapdata/
-- regions.lua (named keys, e.g. "cinder_forge"); otherwise game_regions.lua
-- falls back to the original fixed 2048-elmo grid ("gridX:gridZ", via
-- GG.Regions.KeyAt). Each scenario's world.regions/objectives region keys
-- must match whichever provider its map actually uses — see
-- scenarios/meridian_basin.lua (named graph) vs scenarios/
-- scenario_smoke_test.lua (green_flat_x34_v3 ships no mapdata/regions.lua,
-- so it still addresses the grid).

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
local ALLIED_LOS = { allied = true }   -- same visibility as every other team param

-- Scripted-slate kinds the shipped AI plugin implements
-- (data/games/metalstorm/ai/strategos/scripted.lua's Builders). Kept here as a
-- literal rather than read from the plugin because the plugin lives in a
-- SEPARATE Lua state (the AI VM) that synced gadgets cannot reach — so the two
-- lists are a documented pair: add a builder there, add its name here.
local AI_SLATE_KINDS = { garrison = true, raid = true, toll = true }
local DEFAULT_CONTROL_HOLD_FRAMES = 900   -- 30s hold to complete — mirrors
                                            -- objectives/generator.lua's
                                            -- CONTROL_HOLD_FRAMES; scenario
                                            -- authors override via o.holdFrames

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

    -- AI slots (PLAN-metalstorm-ai.md §5). Validated hard: a typo'd slate kind
    -- or region key would otherwise produce an AI that boots fine and then
    -- silently never does anything, which is the worst possible failure mode
    -- for a faction whose whole purpose is to act.
    for i, a in ipairs(scn.ai or {}) do
        local ctx = 'ai[' .. i .. ']'
        if type(a.team) ~= 'number' then
            errors[#errors + 1] = ctx .. ': needs a numeric "team"'
        end
        if a.profile ~= nil and type(a.profile) ~= 'string' then
            errors[#errors + 1] = ctx .. ': "profile" must be a string'
        end
        local slate = a.slate
        if slate ~= nil then
            if type(slate) ~= 'table' then
                errors[#errors + 1] = ctx .. ': "slate" must be a table'
            else
                for _, kind in ipairs(slate.kinds or {}) do
                    if not AI_SLATE_KINDS[kind] then
                        errors[#errors + 1] = ctx .. ': unknown slate kind "' ..
                            tostring(kind) .. '"'
                    end
                end
                if slate.kinds and #slate.kinds == 0 then
                    errors[#errors + 1] = ctx .. ': "slate.kinds" is empty'
                end
                -- Region keys are checked against the LIVE graph when one is
                -- available (GG.Regions.Keys()), so a scenario written against
                -- a different map's graph fails at load, not at first tick.
                local known = GG.Regions and GG.Regions.Keys and GG.Regions.Keys()
                if known then
                    local set = {}
                    for _, k in ipairs(known) do set[k] = true end
                    local function checkRegion(key, field)
                        if key ~= nil and not set[key] then
                            errors[#errors + 1] = ctx .. '.slate.' .. field ..
                                ': unknown region "' .. tostring(key) .. '"'
                        end
                    end
                    checkRegion(slate.home, 'home')
                    for _, k in ipairs(slate.targets or {}) do checkRegion(k, 'targets') end
                    for _, k in ipairs(slate.route or {}) do checkRegion(k, 'route') end
                end
            end
        end
        if a.stipend ~= nil then
            if type(a.stipend) ~= 'table' or type(a.stipend.amount) ~= 'number' then
                errors[#errors + 1] = ctx .. ': "stipend" needs a numeric "amount"'
            end
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

--- teamID -> true for every team this game actually has. A scenario may declare
--- more sides than the launch supplied (an optional NPC faction is the common
--- case): spawning for a team that doesn't exist is a hard engine error, so
--- those entries are skipped with a warning instead.
local function buildLiveTeams()
    local live = {}
    for _, teamID in ipairs(Spring.GetTeamList() or {}) do live[teamID] = true end
    return live
end

local function stageUnits(units)
    local liveTeams = buildLiveTeams()
    local warned = {}
    for _, u in ipairs(units or {}) do
        if u.team ~= nil and not liveTeams[u.team] then
            if not warned[u.team] then
                warned[u.team] = true
                Spring.Echo('[game_scenario] WARNING: scenario spawns units for team ' ..
                            tostring(u.team) .. ' which this game does not have — skipped ' ..
                            '(add a player/AI slot for it in the room manifest)')
            end
            goto continue
        end
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
        ::continue::
    end
end

-- ============================================================
-- AI slots (PLAN-metalstorm-ai.md §5) — scenario-authored faction brains
-- ============================================================
-- A scenario declares WHAT an AI slot should be; the launch (room manifest /
-- `--ai <plugin>:<team>:<pos>`) decides WHETHER an AI is actually there, the
-- same split `sides` already uses for players. Staging publishes the config as
-- team rulesParams that the AI VM reads back over AI1
-- (AI.getRulesParam('team', ...) — see ai/strategos/picture.lua readScript /
-- readProfileHint). rulesParams rather than a file because this is per-team
-- game state, not static map data: the AI4 file API is for the latter.
--
-- Keys published (the contract with picture.lua):
--   ai_profile              which profiles/*.lua the slot wears
--   ai_slate_kinds          comma list: garrison,raid,toll
--   ai_slate_home           region key to hold
--   ai_slate_targets        comma list of raid-target region keys
--   ai_slate_route          comma list of region keys to deny/toll
--   ai_slate_reach          raid radius in region-graph hops
--
-- Stipends (§5 NPC column: "small scripted stipend, scenario-granted, not
-- objective income") are granted on a timer from GameFrame below — an NPC has
-- no objective income by design, so without one it would issue a handful of
-- opening directives and then be permanently broke.
local aiStipends = {}    -- { { team, amount, periodFrames, nextFrame }, ... }

local function commaList(list)
    if type(list) ~= 'table' or #list == 0 then return nil end
    return table.concat(list, ',')
end

local function stageAI(entries)
    aiStipends = {}
    for _, a in ipairs(entries or {}) do
        local team = a.team
        local function set(key, value)
            if value ~= nil then
                Spring.SetTeamRulesParam(team, key, value, ALLIED_LOS)
            end
        end

        set('ai_profile', a.profile)

        local slate = a.slate
        if slate then
            set('ai_slate_kinds',   commaList(slate.kinds))
            set('ai_slate_home',    slate.home)
            set('ai_slate_targets', commaList(slate.targets))
            set('ai_slate_route',   commaList(slate.route))
            set('ai_slate_reach',   slate.reach)
        end

        if a.stipend then
            local periodSec = a.stipend.periodSec or 60
            aiStipends[#aiStipends + 1] = {
                team = team,
                amount = a.stipend.amount,
                periodFrames = math.max(1, math.floor(periodSec * 30)),
                nextFrame = math.max(1, math.floor(periodSec * 30)),
            }
        end

        -- Loud when the declaration has no brain behind it: the scenario asked
        -- for a faction and the launch didn't supply one, so its units will sit
        -- there doing nothing. A documented warning, never a silent no-op.
        local ais = GG.Teams and GG.Teams.AIPlayers and GG.Teams.AIPlayers(team)
        if ais and #ais == 0 then
            Spring.Echo('[game_scenario] WARNING: scenario declares an AI on team ' ..
                        tostring(team) .. ' (profile "' .. tostring(a.profile) ..
                        '") but no AI player is on that team — add an --ai slot ' ..
                        'for it or its forces will idle')
        else
            Spring.Echo('[game_scenario] staged AI team=' .. tostring(team) ..
                        ' profile=' .. tostring(a.profile) ..
                        ' slate=' .. tostring(slate and commaList(slate.kinds)))
        end
    end
end

--- Pay every due scripted stipend into the AI player's OWN pool. Own pool, not
--- the team pool: an NPC's roles.lua entry sets teamAuthorityFallback=false, so
--- the planner's governor only ever sees `authority_player_<id>` — money in the
--- team pool would be invisible to it (§5 NPC column + §3.3 budget governor).
local function payStipends(frame)
    for _, s in ipairs(aiStipends) do
        if frame >= s.nextFrame then
            s.nextFrame = frame + s.periodFrames
            local ais = GG.Teams and GG.Teams.AIPlayers and GG.Teams.AIPlayers(s.team) or {}
            for _, playerID in ipairs(ais) do
                if GG.Authority and GG.Authority.Award then
                    -- Reason 'stipend' is already in authority/ledger.lua's
                    -- REASON_CLASS (mint); a new string would land in the
                    -- 'unmapped' bucket and warn.
                    GG.Authority.Award({ player = playerID }, s.amount, 'stipend')
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

-- Escort objectives whose _populatePayloadFrom names a convoy `route` (not
-- an area) can't resolve at the frame-30 sweep below — the payload vehicle
-- doesn't exist until civilians/convoy.lua's spawn timer fires, which is
-- staggered 0-60s past GameStart by design. These wait, keyed by route id,
-- for GG.Scenario.NotifyConvoySpawn (called from the convoy spawn path)
-- instead of a fixed frame.
local pendingConvoyObjectives = {}   -- route id -> list of scenario objective defs

local function populateCiviliansInArea(x, z, r, role)
    -- Find all civilian units in the specified area with the given role.
    -- Civilian identity + role come from the GG.Civilians registry (the source
    -- of truth — roles like 'ambient'/'convoy'/'payload' live only there, not
    -- on unitdefs). A def-level fallback (customParams.civilian, which the real
    -- civilian defs carry) covers any civilian not routed through the registry.
    local result = {}
    local units = Spring.GetUnitsInCylinder(x, z, r)
    local Civ = GG.Civilians
    for _, unitID in ipairs(units) do
        local isCiv = Civ and Civ.IsCivilian and Civ.IsCivilian(unitID)
        if not isCiv then
            local udid = Spring.GetUnitDefID(unitID)
            local ud = udid and UnitDefs[udid]
            local cp = ud and ud.customParams
            isCiv = cp and (cp.civilian or cp.is_civilian) ~= nil
        end
        if isCiv then
            -- Check role if specified (role is registry-only).
            local unitRole = Civ and Civ.GetRole and Civ.GetRole(unitID)
            if not role or unitRole == role then
                result[#result + 1] = unitID
            end
        end
    end
    return result
end

--- Build the GG.Objectives.Create def + fire it, echoing the outcome. Shared
--- by the frame-30 civilian sweep and the convoy-spawn event path below.
local function createPopulatedObjective(o, params, label)
    local def = {
        type = o.type,
        scope = o.scope,
        forTeam = o.forTeam,
        reward = o.reward,
        expiresAtFrame = o.expiresAtFrame,
        victory = o.victory,
        params = params,
    }
    local id = GG.Objectives.Create(def)
    if id then
        Spring.Echo('[game_scenario] created ' .. label .. ' objective ' .. id ..
                   ' (' .. o.type .. ')')
    else
        Spring.Echo('[game_scenario] WARNING: failed to create ' .. label ..
                   ' ' .. o.type .. ' objective')
    end
    return id
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
            createPopulatedObjective(o, params, 'deferred')
        else
            Spring.Echo('[game_scenario] skipped ' .. o.type ..
                       ' objective (no units found or empty payload)')
        end
    end
    deferredObjectives = {}
end

--- Called from civilians/convoy.lua's spawn path (via GG.Scenario, checked
--- defensively since load order between gadgets isn't guaranteed) whenever
--- a convoy vehicle is created. Fires the first still-pending escort
--- objective queued for this route with payloadUnitIDs = {unitID} — one-shot
--- per route, matching "the opening convoy run is the escort mission", not
--- every respawn of a recurring route.
local function notifyConvoySpawn(routeId, unitID)
    local pending = pendingConvoyObjectives[routeId]
    if not pending or #pending == 0 then return end

    local o = table.remove(pending, 1)
    local params = o.params or {}
    params.payloadUnitIDs = { unitID }
    createPopulatedObjective(o, params, 'convoy-spawned')
end

local function stageObjectives(objectives)
    for _, o in ipairs(objectives or {}) do
        -- Authoring convenience: flat type-specific fields (region,
        -- targetUnitID, duration) fold into GG.Objectives.Create's `params`
        -- sub-table — the shape game_objectives.lua's evaluators read.
        -- NOTE: 'region' folds into params.regionKey — that's the field name
        -- objectives/control.lua's validateParams/init/positionHint actually
        -- read (params.region was a dead alias nothing consumed).
        local params = o.params or {}
        if o.region and params.regionKey == nil then params.regionKey = o.region end
        if o.targetUnitID and params.targetUnitID == nil then params.targetUnitID = o.targetUnitID end
        if o.duration and params.duration == nil then params.duration = o.duration end
        if o.type == 'control' and params.holdFrames == nil then
            params.holdFrames = o.holdFrames or DEFAULT_CONTROL_HOLD_FRAMES
        end

        -- Check if this objective needs runtime unit population
        -- (empty targetUnitIDs/payloadUnitIDs + a _populateFrom marker)
        local needsTargets = o._populateTargetsFrom ~= nil
        local payloadFrom = o._populatePayloadFrom

        if payloadFrom and payloadFrom.route then
            -- Convoy-linked payload: wait for the route's spawn event, not
            -- the frame-30 sweep (no vehicle exists that early).
            local route = payloadFrom.route
            pendingConvoyObjectives[route] = pendingConvoyObjectives[route] or {}
            table.insert(pendingConvoyObjectives[route], o)
            Spring.Echo('[game_scenario] queued ' .. (o.type or 'unknown') ..
                       ' objective (will populate payload when convoy route "' ..
                       route .. '" next spawns)')
        elseif needsTargets or payloadFrom then
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
                -- wars §7.1: the scenario's terminal objective (game_gameover.lua).
                victory = o.victory,
            })
        end
    end
end

-- ============================================================

GG.Scenario = GG.Scenario or {}

--- civilians/convoy.lua calls this after creating a convoy vehicle so any
--- escort objective staged with `_populatePayloadFrom = { route = <id> }`
--- can populate its payload and go live (see notifyConvoySpawn above).
function GG.Scenario.NotifyConvoySpawn(routeId, unitID)
    notifyConvoySpawn(routeId, unitID)
end

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
    stageAI(scn.ai)

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

    -- Scripted AI stipends (§5 NPC column). Cheap: the list is empty for every
    -- scenario that declares none, which is all of them but the NPC ones.
    if #aiStipends > 0 then payStipends(frame) end
end
