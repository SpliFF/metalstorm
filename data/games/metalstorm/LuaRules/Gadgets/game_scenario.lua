-- game_scenario.lua — scenario world loader (PLAN-persistence.md §5).
--
-- Loads a declarative scenario file from scenarios/ at GameStart when the
-- room manifest names one (quickstart --direct manifest's top-level
-- "scenario" field, threaded through as the `scenario` modoption — see
-- rts/lobby_main.cpp runDirectStart): pre-set units, region ownership,
-- initial objectives, civilian population, NPC faction AI slots, and
-- `world.features` — wrecks, bridge spans and ancient-tech sites placed via
-- Spring.CreateFeature (PLAN-metalstorm-model-integration §M3; the defs live
-- in data/games/metalstorm/features/, see that directory's README). A `units`
-- or `world.features` entry carrying a `name` is additionally published as a
-- LANDMARK the command language can address (§M4 — see landmarkNameProblem
-- below). No engine change — everything below is existing Lua surface
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
local PUBLIC_LOS = { public = true }   -- geography: the same for every team

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

-- PLAN-metalstorm-wars.md §7.5b. A `victory = true` control objective ENDS THE
-- WAR, so it is sized against the map rather than against a tactical reward:
-- the question is "can an enemy who sees the region flip reach it before the
-- hold completes". 30 s cannot be that on any map worth fighting over — on
-- Meridian a home row → basin crossing is ~2500-3000 frames, so the terminal
-- hold at 900 was decided by whoever walked in first (endtoend D20: an
-- unopposed three-unit patrol won the war 45 s after arriving). Tactical
-- control objectives keep 900; they are rewards, not endings. Scenario authors
-- override either via o.holdFrames.
local DEFAULT_VICTORY_HOLD_FRAMES = 5400  -- 3 min

-- The params fields a `_populateUnitsFrom` marker may resolve into — one per
-- objective type that is defined in terms of runtime unit ids (kill's is the
-- one SINGULAR field; the type modules spell out why in kill.lua's unitRefs).
-- Shared by validate() and resolveDeferredObjectives so the two cannot drift.
local POPULATE_INTO = {
    targetUnitID    = 'singular',   -- kill
    targetUnitIDs   = 'plural',     -- protect
    payloadUnitIDs  = 'plural',     -- extract / escort
    buildingUnitIDs = 'plural',     -- infra
}

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

--- name -> FeatureDefs entry, for every featuredef the loaded content ships
--- (data/games/metalstorm/features/*.lua — see features/README.md). Same
--- shape and same reason as buildKnownDefNames: `FeatureDefs` is ID-indexed.
--- The def itself is kept, not just `true`, because stageFeatures reads
--- `customParams.chain_pitch` off it.
local function buildKnownFeatureDefs()
    local known = {}
    for _, def in pairs(FeatureDefs or {}) do
        known[def.name] = def
    end
    return known
end

-- ============================================================
-- Landmarks (PLAN-metalstorm-model-integration §M4, worldbuilding directive 2)
-- ============================================================
--
-- Any `units` or `world.features` entry may carry a `name`: the thing a player
-- would point at and say out loud — "the Weatherall silos", "the drowned
-- span". A named entry is published as
--
--     landmark_<name>_x   landmark_<name>_z
--
-- which is a shape the client has parsed since the named-entity index landed
-- (client/src/ui/native-ui/named-entity-index.ts parseLandmarksFromRulesParams)
-- and which, until now, NOTHING wrote — the header of entity-index-producer.ts
-- literally says "no publisher yet". This is that publisher. It is what makes
-- "defend the grain silo" resolvable by the command language
-- (PLAN-metalstorm-command-language.md §6.5), and it is why scenariogen's site
-- layer bothers to mint names at all rather than dropping anonymous buildings.
--
-- The NAME IS INSIDE THE KEY (the client's regex is
-- /^landmark_(.+)_(x|z)$/), so two entries sharing a name would silently
-- overwrite each other's position and one landmark would simply vanish from the
-- index. validate() rejects that rather than letting it happen — same reasoning
-- as the `team = 'nuetral'` typo guard below: a name collision is invisible
-- from the outside and unfalsifiable in a screenshot.
local function landmarkNameProblem(name)
    if type(name) ~= 'string' then
        return 'must be a string, got ' .. type(name)
    end
    if name == '' then
        return 'must not be empty'
    end
    -- The suffix is anchored at end-of-string with a greedy name capture, so a
    -- name ENDING in _x or _z would be split at the wrong underscore and the
    -- landmark would parse under a truncated name with a missing coordinate.
    if name:match('_[xz]$') then
        return 'must not end in "_x" or "_z" — the client splits ' ..
               'landmark_<name>_x at the LAST underscore, so this name would ' ..
               'parse as "' .. name:sub(1, -3) .. '" with a missing coordinate'
    end
    return nil
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

-- Feature placement (PLAN-metalstorm-model-integration §M3). A scenario's
-- `world.features` is the ONLY thing in Metalstorm that calls
-- Spring.CreateFeature — wrecks, bridges and ancient-tech sites are placed
-- history, never spawned by gameplay, so they belong to the world pre-set
-- next to `world.regions` rather than to any runtime gadget.
--
-- Heading is an opaque u16 rotation index; these are the four cardinal labels
-- from GetHeadingFromFacing (rts/System/SpringMath.inl). Metalstorm is
-- RH/glTF-native (modinfo.lua `legacyCoordSystem = false`), so heading 0 is
-- FACING_NORTH and a feature's local forward at heading 0 is -Z.
local FEATURE_FACING_HEADINGS = {
    north =      0,
    east  =  16384,
    south =  32767,
    west  = -16384,
}

--- Unit direction a feature at `heading` points along, in world XZ.
-- Derived from GetVectorFromHeading (LH: sin/cos) with the RH Z flip that
-- LuaCoordAdapt applies for non-legacy games — verify against SpringMath.inl's
-- diagram: heading 0 -> (0, -1) = -Z = FACING_NORTH, heading 16384 -> (1, 0)
-- = +X = FACING_EAST. Computed here rather than via
-- Spring.GetVectorFromHeading so the chaining arithmetic is exercised by the
-- spec instead of by a mock's stand-in for it.
local function headingToDir(heading)
    local theta = (heading or 0) * (2 * math.pi / 65536)
    return math.sin(theta), -math.cos(theta)
end

--- Resolve a feature entry's rotation to a heading short. Accepts a cardinal
--- name ('north'/'east'/'south'/'west') or a raw numeric heading; nil = 0.
local function featureHeading(f)
    if type(f.heading) == 'number' then return f.heading end
    if type(f.facing) == 'string' then
        return FEATURE_FACING_HEADINGS[f.facing:lower()]
    end
    if type(f.facing) == 'number' then return f.facing end
    return 0
end

--- Segment spacing for a chained feature, in world units. Authoritative source
--- is the def's own `customParams.chain_pitch` (features/bridges.lua publishes
--- the measured 24 m tile length there), so a scenario never restates a number
--- that belongs to the model. A scenario may override per placement.
local function featureChainPitch(f, fd)
    if type(f.pitch) == 'number' then return f.pitch end
    local cp = fd and fd.customParams and fd.customParams.chain_pitch
    return tonumber(cp) or 0
end

local function validate(scn, knownDefs, knownFeatureDefs)
    local errors = {}

    -- Landmark names are global across BOTH sections: a site and a bridge that
    -- both call themselves "Ferry Crossing" collide in the rulesParam key space
    -- exactly as two sites would.
    local seenNames = {}
    local function checkName(name, ctx)
        if name == nil then return end
        local problem = landmarkNameProblem(name)
        if problem then
            errors[#errors + 1] = ctx .. ': "name" ' .. problem
            return
        end
        if seenNames[name] then
            errors[#errors + 1] = ctx .. ': duplicate name "' .. name ..
                '" (already used by ' .. seenNames[name] .. ') — landmark ' ..
                'names are the rulesParam key, so one would overwrite the other'
            return
        end
        seenNames[name] = ctx
    end

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
        checkName(u.name, 'units[' .. i .. ']')
        -- 'neutral' (the Gaia team, see resolveTeam) is the only string a
        -- `team` may be. Checked hard rather than left to stageUnits' live-team
        -- guard, because a typo would otherwise be reported as "team 'nuetral'
        -- which this game does not have" and skipped — indistinguishable from
        -- the legitimate "the launch seated no NPC slot" case, and silently
        -- dropping every neutral town in the scenario.
        if u.team ~= nil and type(u.team) ~= 'number' and u.team ~= 'neutral' then
            errors[#errors + 1] = 'units[' .. i .. ']: "team" must be a number or ' ..
                                  '"neutral", got "' .. tostring(u.team) .. '"'
        end
    end

    for i, c in ipairs((scn.civilians or {}).units or {}) do
        checkDef(c.def, 'civilians.units[' .. i .. ']')
    end

    -- Towns (town-planner T4). Validated hard for the same reason the AI slate
    -- is: every one of these mistakes produces a town that loads cleanly and is
    -- then quietly not a place. A civilian whose `town` names no declared town
    -- gets no district, so the estate never counts it and a protect objective
    -- over that district finds nobody; a hall whose def is misspelt resolves to
    -- no unit, and the town negotiates exactly as if its hall had been
    -- destroyed. Neither says anything at load time on its own.
    local declaredTowns = {}
    for i, t in ipairs(scn.towns or {}) do
        local ctx = 'towns[' .. i .. ']'
        if type(t.key) ~= 'string' or t.key == '' then
            errors[#errors + 1] = ctx .. ': needs a string "key"'
        elseif declaredTowns[t.key] then
            errors[#errors + 1] = ctx .. ': duplicate town key "' .. t.key .. '"'
        else
            declaredTowns[t.key] = true
        end
        if t.x ~= nil and type(t.x) ~= 'number' then
            errors[#errors + 1] = ctx .. ': "x" must be a number'
        end
        if t.hall ~= nil then
            if type(t.hall) ~= 'table' then
                errors[#errors + 1] = ctx .. ': "hall" must be a table'
            else
                checkDef(t.hall.def, ctx .. '.hall')
                if type(t.hall.x) ~= 'number' or type(t.hall.z) ~= 'number' then
                    errors[#errors + 1] = ctx .. '.hall: needs numeric "x"/"z"'
                end
            end
        end
    end
    for i, c in ipairs((scn.civilians or {}).units or {}) do
        if c.town ~= nil and not declaredTowns[c.town] then
            errors[#errors + 1] = 'civilians.units[' .. i .. ']: "town" names ' ..
                '"' .. tostring(c.town) .. '", which no `towns` entry declares'
        end
    end

    for i, r in ipairs((scn.world or {}).regions or {}) do
        if r.key == nil and (r.x == nil or r.z == nil) then
            errors[#errors + 1] = 'world.regions[' .. i .. ']: needs either "key" or "x"/"z"'
        end
    end

    -- Features are validated as hard as AI slates and for the same reason:
    -- Spring.CreateFeature returns nothing for an unknown def and does NOT
    -- error ("do not error (featureDefs are dynamic)", LuaSyncedCtrl.cpp:4344),
    -- so a typo'd wreck name would stage a scenario that boots clean and is
    -- silently missing the terrain the fight was designed around.
    for i, f in ipairs((scn.world or {}).features or {}) do
        local ctx = 'world.features[' .. i .. ']'
        checkName(f.name, ctx)
        if type(f.def) ~= 'string' or not knownFeatureDefs[f.def] then
            errors[#errors + 1] = ctx .. ': unknown feature def "' .. tostring(f.def) .. '"'
        end
        if type(f.x) ~= 'number' or type(f.z) ~= 'number' then
            errors[#errors + 1] = ctx .. ': needs numeric "x" and "z"'
        end
        if f.facing ~= nil and f.heading == nil and featureHeading(f) == nil then
            errors[#errors + 1] = ctx .. ': unknown facing "' .. tostring(f.facing) ..
                '" (expected north/east/south/west or a numeric heading)'
        end
        if f.chain ~= nil then
            if type(f.chain) ~= 'number' or f.chain < 1 or f.chain % 1 ~= 0 then
                errors[#errors + 1] = ctx .. ': "chain" must be a positive integer'
            elseif f.chain > 1 and featureChainPitch(f, knownFeatureDefs[f.def]) <= 0 then
                -- Chaining a def with no pitch would stack every segment on one
                -- spot — a pile of coincident geometry, i.e. exactly the
                -- z-fighting §M3 asks us to avoid. Refuse rather than draw it.
                errors[#errors + 1] = ctx .. ': "chain" > 1 but def "' .. tostring(f.def) ..
                    '" declares no customParams.chain_pitch and the entry sets no "pitch"'
            end
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

    -- Objective chaining (§4.7). Checked hard for the same reason the AI slate
    -- is: every wrong shape here fails SILENTLY. A `phases` value that isn't an
    -- array of arrays is skipped by GG.Objectives.Create's `#def.phases > 0`
    -- guard and the parent becomes an ordinary objective with no chain; a
    -- non-numeric parentId names no parent and the child never reports home.
    for i, o in ipairs(scn.objectives or {}) do
        local ctx = 'objectives[' .. i .. ']'
        if o.phases ~= nil then
            if type(o.phases) ~= 'table' or #o.phases == 0 then
                errors[#errors + 1] = ctx .. ': "phases" must be a non-empty array of phases'
            else
                for pi, children in ipairs(o.phases) do
                    local pctx = ctx .. '.phases[' .. pi .. ']'
                    if type(children) ~= 'table' or #children == 0 then
                        errors[#errors + 1] = pctx ..
                            ': each phase must be a non-empty array of child objectives'
                    else
                        for ci, c in ipairs(children) do
                            local cctx = pctx .. '[' .. ci .. ']'
                            if type(c) ~= 'table' then
                                errors[#errors + 1] = cctx .. ': child must be a table'
                            else
                                if type(c.type) ~= 'string' then
                                    errors[#errors + 1] = cctx .. ': child needs a string "type"'
                                end
                                if c.phases ~= nil then
                                    errors[#errors + 1] = cctx ..
                                        ': nested phases are not supported (one level of chaining only)'
                                end
                            end
                        end
                    end
                end
            end
        end
        for _, field in ipairs({ 'parentId', 'linkedId' }) do
            if o[field] ~= nil and type(o[field]) ~= 'number' then
                errors[#errors + 1] = ctx .. ': "' .. field ..
                    '" must be a numeric runtime objective id'
            end
        end
        if o.phase ~= nil and type(o.phase) ~= 'number' then
            errors[#errors + 1] = ctx .. ': "phase" must be a number'
        end

        -- Population markers. Checked hard for the same reason `phases` is:
        -- every wrong shape here fails SILENTLY, or worse — a marker with a
        -- nil coordinate errors inside the frame-30 sweep, and an `into` that
        -- names no params field creates an objective whose type module refuses
        -- init after the war has already booted clean.
        local function checkArea(m, mctx, allowRoute)
            if type(m) ~= 'table' then
                errors[#errors + 1] = mctx .. ': must be a table'
                return false
            end
            if allowRoute and m.route ~= nil then
                if type(m.route) ~= 'string' then
                    errors[#errors + 1] = mctx .. ': "route" must be a string convoy route id'
                end
                return false        -- route form carries no area
            end
            if type(m.x) ~= 'number' or type(m.z) ~= 'number' or
               type(m.r) ~= 'number' then
                errors[#errors + 1] = mctx .. ': needs numeric "x", "z" and "r"' ..
                    (allowRoute and ' (or a string "route")' or '')
                return false
            end
            return true
        end
        if o._populateTargetsFrom ~= nil then
            checkArea(o._populateTargetsFrom, ctx .. '._populateTargetsFrom', false)
        end
        if o._populatePayloadFrom ~= nil then
            checkArea(o._populatePayloadFrom, ctx .. '._populatePayloadFrom', true)
        end
        if o._populateUnitsFrom ~= nil then
            local m = o._populateUnitsFrom
            local mctx = ctx .. '._populateUnitsFrom'
            if checkArea(m, mctx, false) then
                local into = m.into or 'targetUnitIDs'
                if POPULATE_INTO[into] == nil then
                    local allowed = {}
                    for k in pairs(POPULATE_INTO) do allowed[#allowed + 1] = k end
                    table.sort(allowed)
                    errors[#errors + 1] = mctx .. ': unknown "into" field "' ..
                        tostring(into) .. '" (expected one of ' ..
                        table.concat(allowed, ', ') .. ')'
                end
                if m.defs ~= nil then
                    if type(m.defs) ~= 'table' or #m.defs == 0 then
                        errors[#errors + 1] = mctx ..
                            ': "defs" must be a non-empty array of unit def names'
                    else
                        for di, d in ipairs(m.defs) do
                            checkDef(d, mctx .. '.defs[' .. di .. ']')
                        end
                    end
                end
                if m.team ~= nil and type(m.team) ~= 'number' and m.team ~= 'neutral' then
                    errors[#errors + 1] = mctx .. ': "team" must be a number or ' ..
                        '"neutral", got "' .. tostring(m.team) .. '"'
                end
                -- kill is defined in terms of ONE runtime id (params.
                -- targetUnitID) and is the only type that is. A kill marker
                -- resolving into a plural field — or any other type resolving
                -- into the singular one — authors an objective whose type
                -- module refuses init every time, silently.
                if o.type == 'kill' and POPULATE_INTO[into] ~= 'singular' then
                    errors[#errors + 1] = mctx .. ': a kill objective needs ' ..
                        '`into = "targetUnitID"` (the one singular field)'
                elseif o.type ~= 'kill' and POPULATE_INTO[into] == 'singular' then
                    errors[#errors + 1] = mctx .. ': `into = "targetUnitID"` is ' ..
                        'kill-only; every other type reads a plural field'
                end
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
        -- A NAME-ONLY entry sets no ownership. A generated scenario emits one
        -- per region it planted a town in (tools/mapgen/scenariogen.py), to
        -- rename the region after the settlement and move its published centre
        -- onto it — `region_<key>_name/_x/_z` is the path the client's
        -- named-entity index reads, so this is what makes a town addressable by
        -- name in a typed or spoken order.
        --
        -- Guarded on `r.team ~= nil` rather than run unconditionally, because
        -- SetControllingTeam(key, nil) is not a no-op: it CLEARS the region to
        -- uncontrolled and publishes team = -1. A scenario that named a region
        -- an earlier entry had already given to a side would silently take it
        -- back off them.
        if type(r.name) == 'string' and GG.Regions.SetName then
            GG.Regions.SetName(key, r.name, r.x, r.z)
        end
        if r.team ~= nil or r.name == nil then
            local team = r.team
            if team == 'contested' or team == 'neutral' then team = nil end
            GG.Regions.SetControllingTeam(key, team)
        end
    end
end

--- Place `world.features` (PLAN-metalstorm-model-integration §M3). Returns the
--- list of created feature IDs so callers (and the smoke spec) can assert on
--- what actually landed.
---
--- Entry shape:
---   { def = 'ms_tank_wreck', x = , z = ,
---     y       = <optional>  spawn Y (see below); default = ground height at
---                           each segment
---     facing  = <optional>  'north'|'east'|'south'|'west', or heading = <short>
---     chain   = <optional>  segment count, laid along the facing direction
---     pitch   = <optional>  metres between segments; default = the def's
---                           customParams.chain_pitch (bridges publish 24)
---     team    = <optional>  default -1 = Gaia/neutral, which is what every
---                           wreck, span and relic wants }
---
--- CHAINING is CENTRED on (x, z): a `chain = 4` bridge spans 96 m with its
--- midpoint at the author's crossing point, which is how someone picks a
--- crossing (they know where the gap is, not where its upstream end is).
---
--- Y IS A SPAWN HEIGHT, NOT A PLACEMENT. Say this out loud because the
--- opposite is the natural assumption: `Spring.CreateFeature`'s y is where the
--- feature APPEARS, not where it stays. `CFeature::UpdatePosition` applies
--- gravity every tick and then clamps to
--- `max(CGround::GetHeightReal(x, z), pos.y)` (Feature.cpp:565-571), so a
--- feature settles onto the terrain under it within a second or so.
---
--- What that means per family, live-measured on skerry_reach 2026-08-06:
---   * wrecks / relics — pass no `y`; the ground sample is both the spawn point
---     and the resting point, so nothing moves. Half-buried models
---     (ms_vault_door, ms_dig_site, ms_colossus_wreck, ms_train_wreck all have
---     negative glTF mins.y) get NO lift: their berms and pits are authored
---     geometry, see features/README.md.
---   * bridges — pass `y` AND rely on `floating = true` in features/bridges.lua.
---     Floating zeroes the gravity term in water, so a span spawned at the
---     waterline stays there and the chain reads level: four road spans at
---     y = 0 over a channel measured 0.00 / 0.00 / 0.00 / 0.00. Without
---     floating the same four settled to -31.0 / -34.5 / -45.9 / -57.6.
---     Over DRY ground the clamp still wins and a chain steps with the terrain
---     (the rail run measured 26.1 -> 40.8) — a level deck over a dry ravine
---     needs terrain shaped to carry it, or the deck-height engine work noted
---     in features/bridges.lua. Passing `y` is still right: it is used verbatim
---     for every segment rather than resampled per segment, which is what keeps
---     the water case level.
local function stageFeatures(features, knownFeatureDefs, landmarks)
    local created = {}
    knownFeatureDefs = knownFeatureDefs or buildKnownFeatureDefs()
    for _, f in ipairs(features or {}) do
        -- A named span/wreck/relic is a landmark at the CHAIN CENTRE, not at
        -- its first segment: chaining is centred on (x, z) precisely because
        -- that is the point an author (or a player) means by "the crossing".
        if f.name and landmarks then
            landmarks[#landmarks + 1] = { name = f.name, x = f.x, z = f.z }
        end
        local fd = knownFeatureDefs[f.def]
        local heading = featureHeading(f) or 0
        local count = f.chain or 1
        local pitch = featureChainPitch(f, fd)
        local dirX, dirZ = headingToDir(heading)
        local team = f.team or -1
        for i = 0, count - 1 do
            local step = (i - (count - 1) / 2) * pitch
            local fx, fz = f.x + dirX * step, f.z + dirZ * step
            local fy = f.y or Spring.GetGroundHeight(fx, fz)
            local featureID = Spring.CreateFeature(f.def, fx, fy, fz, heading, team)
            if featureID then
                created[#created + 1] = featureID
            else
                -- CreateFeature returns nothing rather than erroring; validate()
                -- already rejected unknown defs, so reaching here means the
                -- placement itself was refused (out of bounds, bad team).
                Spring.Echo('[game_scenario] WARNING: could not place feature "' ..
                            tostring(f.def) .. '" at ' .. math.floor(fx) .. ',' ..
                            math.floor(fz) .. ' — skipped')
            end
        end
    end
    return created
end

--- Hand the scenario's `towns` to the civilian gadget's registry (GG.Towns,
--- civilians/town.lua). Called BEFORE stageUnits: registration is bookkeeping,
--- and the hall each town declares is resolved to a live unitID later, by
--- civilians/town.lua's own GameStart — this gadget is layer -90 and that one
--- is -40, so the buildings exist by then and not before.
---
--- Skipped with one line rather than erroring when GG.Towns is absent: a game
--- built without the civilians gadget is a game with no estate to negotiate
--- with, which is a smaller scenario, not a broken one.
local function stageTowns(towns)
    if not towns or #towns == 0 then return end
    if not (GG.Towns and GG.Towns.Register) then
        Spring.Echo('[game_scenario] WARNING: scenario declares ' .. #towns ..
                    ' town(s) but GG.Towns is absent (no civilians gadget) — ' ..
                    'their buildings still stage, but nothing names them, ' ..
                    'binds their population to a district, or holds a parley ' ..
                    'at their meeting hall')
        return
    end
    for _, t in ipairs(towns) do
        GG.Towns.Register(t)
    end
    Spring.Echo('[game_scenario] registered ' .. #towns .. ' town(s)')
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

--- Resolve a `units` entry's `team` to a real team id, or nil for "no team".
---
--- `team = 'neutral'` means the Gaia team, and it is a STRING for a mechanical
--- reason rather than a stylistic one: Gaia's id is `playerTeamCount`
--- (Simulation.cpp's team setup), so it depends on how many slots the launch
--- seated and is simply not knowable when a scenario file is written. A
--- generated scenario that hard-coded a number would put its neutral towns on
--- whichever player team happened to land on that index.
---
--- Gaia is the right home for them because it is already the neutral
--- environment team — its own ally team, no allies, always present regardless
--- of roster — which is exactly "a town that belongs to nobody and fights
--- nobody". This mirrors the string handling stageRegions already does for
--- 'contested'/'neutral'.
---
--- Note this is NOT the `civilians` block, deliberately: that routes through
--- GG.Civilians.Spawn, which registers everything role='ambient', and
--- civilians/routines.lua then issues a CMD_MOVE at every ambient entry every
--- tick — which would enroll immobile buildings in a move order they can never
--- satisfy.
local function resolveTeam(team)
    if team == 'neutral' then
        return Spring.GetGaiaTeamID and Spring.GetGaiaTeamID() or nil
    end
    return team
end

local function stageUnits(units, landmarks)
    local liveTeams = buildLiveTeams()
    local warned = {}
    local skipped = {}
    local created = 0
    for _, entry in ipairs(units or {}) do
        local staged = 0
        local u = entry
        if u.team == 'neutral' then
            local gaia = resolveTeam('neutral')
            if gaia == nil then
                Spring.Echo('[game_scenario] WARNING: scenario stages units on ' ..
                            'team "neutral" but this engine exposes no Gaia team — skipped')
                goto continue
            end
            -- Shallow copy: GG.Scenario.data is published for the war-health
            -- checks and game_gameover to read back, so rewriting the authored
            -- table in place would make it disagree with the file on disk.
            u = { def = entry.def, team = gaia, x = entry.x, z = entry.z,
                  facing = entry.facing, count = entry.count,
                  spacing = entry.spacing, orders = entry.orders }
        end
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
            if unitID == nil then
                -- The engine refuses a unit whose ground is already occupied and
                -- says so ONLY by returning nil — no error, no log line, nothing.
                -- The staged war is then quietly smaller than the file that
                -- describes it, which is unfalsifiable from the outside: found
                -- by counting units in a headless boot of a generated scenario
                -- and getting 77 where the file said 78.
                --
                -- It matters most for generated scenarios, whose placement is
                -- checked against the heightmap and against other scenario
                -- entries but cannot model every reservation the engine makes
                -- (map features, other gadgets' spawns, footprint rounding). So
                -- the loader reports what it could not place; the position is
                -- included because that is the only thing that makes it fixable.
                skipped[#skipped + 1] = string.format('%s at (%d,%d)',
                                                      tostring(u.def), ux, uz)
            else
                created = created + 1
                staged = staged + 1
                -- Gaia set dressing is NEUTRAL, not merely unallied. Gaia is its
                -- own ally team with no allies, which is this engine's definition
                -- of hostile: a FIGHT-ordered column auto-acquires a village and
                -- stops to level it. Measured on `crossing_standoff` (endtoend
                -- D53): the union army spent frames 2307-4104 destroying the Ash
                -- Verge settlement 200 elmos off its own approach and reached the
                -- prize 2700 frames after the compact army, which is most of why
                -- the same side won every recorded war on that map. Neutrality is
                -- the engine's own answer — CWeapon::AutoTarget skips a neutral
                -- unless fireState >= FIRESTATE_FIREATNEUTRAL and MobileCAI will
                -- not chase one — and it leaves a deliberate attack order working,
                -- so a town is still burnable, just never by accident.
                if entry.team == 'neutral' then
                    Spring.SetUnitNeutral(unitID, true)
                end
                if u.orders then
                for _, o in ipairs(u.orders) do
                    Spring.GiveOrderToUnit(unitID, resolveCmd(o.cmd), o.params or {}, o.options or {})
                end
                end
            end
        end
        -- Only a landmark that actually LANDED is published. A name is a
        -- promise the player can point at something; publishing one for an
        -- entry the engine refused (occupied ground, missing team) would put a
        -- silo in the command language's target list that does not exist on the
        -- map, and the locate-ping would fly to bare terrain.
        if entry.name and landmarks and staged > 0 then
            landmarks[#landmarks + 1] = { name = entry.name, x = u.x, z = u.z }
        end
        ::continue::
    end

    -- The staged count is the one number that makes "the war is smaller than
    -- the file" checkable at a glance, and it is what a generated scenario's
    -- boot verification compares against.
    Spring.Echo('[game_scenario] staged ' .. created .. ' unit(s) from ' ..
                #(units or {}) .. ' entries')

    if #skipped > 0 then
        Spring.Echo('[game_scenario] WARNING: the engine refused to create ' ..
                    #skipped .. ' staged unit(s) — the ground was already ' ..
                    'occupied, so the war is short of what the scenario ' ..
                    'declares: ' .. table.concat(skipped, ', '))
    end
end

--- Publish every collected landmark as `landmark_<name>_x/_z`, PUBLIC.
---
--- Public rather than allied because a landmark is geography: the grain silo
--- is where it is for everyone, and the whole point is that either side can
--- say "hit the grain silo". Region names (game_regions.lua:229) are published
--- the same way for the same reason.
---
--- Coordinates are the AUTHORED x/z, not a live unit position. That is
--- deliberate: these entries are buildings, wrecks and relics — they do not
--- move — and reading positions back would make the publisher depend on unit
--- ids it would then have to keep watching.
local function publishLandmarks(landmarks)
    for _, lm in ipairs(landmarks or {}) do
        Spring.SetGameRulesParam('landmark_' .. lm.name .. '_x', lm.x, PUBLIC_LOS)
        Spring.SetGameRulesParam('landmark_' .. lm.name .. '_z', lm.z, PUBLIC_LOS)
    end
    if #(landmarks or {}) > 0 then
        Spring.Echo('[game_scenario] published ' .. #landmarks ..
                    ' landmark(s) the command language can address')
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
    local liveTeams = buildLiveTeams()
    local warned = {}
    for _, a in ipairs(entries or {}) do
        local team = a.team
        -- Same guard stageUnits already had, and for the same reason: a
        -- scenario declares more sides than a given launch supplies, and
        -- SetTeamRulesParam on a team the game doesn't have is a hard engine
        -- error. Unguarded it aborted gadget:GameStart partway, which left
        -- GG.Scenario.name/.data unset — and game_gameover derives the
        -- winning allyteams from GG.Scenario.data.sides, so the war became
        -- unwinnable again for a *second* reason (PLAN-endtoend.md D10).
        -- Only reachable from the player path: every direct manifest that
        -- verified this chain declared all 8 Meridian teams.
        if team ~= nil and not liveTeams[team] then
            if not warned[team] then
                warned[team] = true
                Spring.Echo('[game_scenario] WARNING: scenario declares an AI slate for team ' ..
                            tostring(team) .. ' which this game does not have — skipped ' ..
                            '(add a player/AI slot for it in the room manifest)')
            end
            goto continue
        end
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
        ::continue::
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

--- Spawn the scenario's civilians and bind each one to its district.
---
--- `c.town` is the town-planner's addition to this block and it is what makes
--- the estate's district machinery live: civilians/estate.lua groups the
--- population by `info.districtId` to answer
--- game_objectives.lua's civilianDistrictsUnderThreat, and before towns existed
--- NO spawn path in this game ever set one — so that function has always
--- returned an empty list from a mechanism that was otherwise complete
--- (estate.lua's own header says exactly this).
---
--- `homePos` is derived here rather than authored, and it is the civilian's OWN
--- placed position rather than the town's centre. routines.lua both wanders and
--- flees toward it, so it has to mean "where this person lives" — a whole
--- district homed on one point would mill about the town square and leave every
--- street it was carefully placed on empty.
local function stageCivilians(civilians)
    local staged, unregistered = 0, 0
    for _, c in ipairs((civilians or {}).units or {}) do
        local unitID = GG.Civilians.Spawn(c.def, c.x, c.z, c.facing or 'south')
        if unitID == nil then
            -- Same silent refusal stageUnits guards: the engine answers "that
            -- ground is taken" by returning nil and logging nothing, and the
            -- district is then quietly smaller than the file that describes it.
            unregistered = unregistered + 1
        else
            staged = staged + 1
            -- Same reasoning as the `team = 'neutral'` set dressing in
            -- stageUnits (endtoend D53): ambient population standing beside a
            -- settlement is scenery, and an army that walks past must not stop
            -- to shoot it. Only the SCENARIO's ambient entries are marked here
            -- — convoy payloads keep spawning hostile-to-the-other-side, which
            -- is what makes an escort objective a real risk.
            Spring.SetUnitNeutral(unitID, true)
            if c.role or c.town then
                GG.Civilians.Register(unitID, c.role, {
                    town = c.town,
                    homePos = { x = c.x, z = c.z },
                })
            end
        end
    end
    if staged > 0 or unregistered > 0 then
        Spring.Echo('[game_scenario] staged ' .. staged .. ' civilian(s)')
    end
    if unregistered > 0 then
        Spring.Echo('[game_scenario] WARNING: the engine refused to create ' ..
                    unregistered .. ' civilian(s) — the ground was already ' ..
                    'occupied')
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

--- ONE area query for every population marker. `filter` fields, all optional:
---   civilian — unit must be a civilian: in the GG.Civilians registry (the
---              source of truth — roles like 'ambient'/'convoy'/'payload' live
---              only there, not on unitdefs), with a def-level fallback
---              (customParams.civilian, which the real civilian defs carry)
---              for any civilian not routed through the registry.
---   role     — GG.Civilians registry role must match. Registry-only, so a
---              role filter excludes every non-registered unit.
---   defs     — set (name -> true) the unit's DEF NAME must be in.
---   team     — unit's team must equal resolveTeam(team) ('neutral' = Gaia).
local function populateUnitsInArea(x, z, r, filter)
    filter = filter or {}
    local result = {}
    local units = Spring.GetUnitsInCylinder(x, z, r)
    local Civ = GG.Civilians
    local team = filter.team ~= nil and resolveTeam(filter.team) or nil
    for _, unitID in ipairs(units) do
        local ok = true
        if filter.civilian then
            local isCiv = Civ and Civ.IsCivilian and Civ.IsCivilian(unitID)
            if not isCiv then
                local udid = Spring.GetUnitDefID(unitID)
                local ud = udid and UnitDefs[udid]
                local cp = ud and ud.customParams
                isCiv = cp and (cp.civilian or cp.is_civilian) ~= nil
            end
            if not isCiv then ok = false end
        end
        if ok and filter.role ~= nil then
            local unitRole = Civ and Civ.GetRole and Civ.GetRole(unitID)
            if unitRole ~= filter.role then ok = false end
        end
        if ok and filter.defs ~= nil then
            local udid = Spring.GetUnitDefID(unitID)
            local ud = udid and UnitDefs[udid]
            if not (ud and filter.defs[ud.name]) then ok = false end
        end
        if ok and team ~= nil and Spring.GetUnitTeam(unitID) ~= team then
            ok = false
        end
        if ok then result[#result + 1] = unitID end
    end
    return result
end

local function populateCiviliansInArea(x, z, r, role)
    return populateUnitsInArea(x, z, r, { civilian = true, role = role })
end

--- `_populateUnitsFrom.defs` is authored as an array of def names (the shape
--- everything else in a scenario file uses); the filter wants a set.
local function defNameSet(list)
    if list == nil then return nil end
    local set = {}
    for _, name in ipairs(list) do set[name] = true end
    return set
end

--- Fold an objective's authoring-convenience flat fields (region,
--- targetUnitID, duration, notBefore, and the control hold default) into the
--- `params` sub-table GG.Objectives.Create's evaluators actually read, and
--- return it. Returns a COPY: the caller decides whether to write it back, so
--- the same def can be folded twice (phase children are folded here and again
--- by nothing else) without accumulating.
---
--- NOTE: 'region' folds into params.regionKey — that's the field name
--- objectives/control.lua's validateParams/init/positionHint read (params.region
--- was a dead alias nothing consumed).
local function foldParams(o)
    local params = {}
    for k, v in pairs(o.params or {}) do params[k] = v end
    if o.region and params.regionKey == nil then params.regionKey = o.region end
    if o.targetUnitID and params.targetUnitID == nil then params.targetUnitID = o.targetUnitID end
    if o.duration and params.duration == nil then params.duration = o.duration end
    if o.type == 'control' and params.holdFrames == nil then
        params.holdFrames = o.holdFrames or
            (o.victory and DEFAULT_VICTORY_HOLD_FRAMES or DEFAULT_CONTROL_HOLD_FRAMES)
    end
    -- wars §7.5a: the open-race delay. Authored flat on the objective for
    -- the same reason `region`/`duration` are — the scenario states when
    -- its prize becomes winnable, the evaluator reads it out of `params`.
    if o.notBefore and params.notBefore == nil then params.notBefore = o.notBefore end
    return params
end

--- Deep-copy a `phases` array-of-arrays of child defs, applying the same flat
--- field folding top-level objectives get — phase children are authored in the
--- same dialect as their parent (§4.7). Nested `phases` inside a child are
--- dropped here and rejected by validate(); one level of chaining is the whole
--- supported shape.
local function foldPhases(phases)
    if phases == nil then return nil end
    local out = {}
    for pi, children in ipairs(phases) do
        local phase = {}
        for ci, c in ipairs(children) do
            local child = {}
            for k, v in pairs(c) do child[k] = v end
            child.params = foldParams(c)
            child.phases = nil
            phase[ci] = child
        end
        out[pi] = phase
    end
    return out
end

--- Build the GG.Objectives.Create def + fire it, echoing the outcome. Shared
--- by the frame-30 civilian sweep and the convoy-spawn event path below.
---
--- Keep the def shape here in lockstep with stageObjectives' immediate-create
--- call: these are the TWO create sites, and a chaining field added to only
--- one of them is silently dropped on the other path (which is how `bounty`
--- came to work on immediate objectives and nowhere else).
local function createPopulatedObjective(o, params, label)
    local def = {
        type = o.type,
        scope = o.scope,
        forTeam = o.forTeam,
        reward = o.reward,
        bounty = o.bounty,
        expiresAtFrame = o.expiresAtFrame,
        victory = o.victory,
        params = params,
        -- chaining (§4.7) — see stageObjectives. A deferred parent's children
        -- are all minted at frame 30, so they can never reference a frame-0
        -- objective's runtime id.
        phases = foldPhases(o.phases),
        parentId = o.parentId,
        phase = o.phase,
        linkedId = o.linkedId,
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

        -- Populate ORDINARY units (kill/infra, or anything else that wants a
        -- non-civilian resolution) from the general area query. validate() has
        -- already vetted the marker's shape, defs and `into`.
        local emptySingular = false
        if o._populateUnitsFrom then
            local m = o._populateUnitsFrom
            local ids = populateUnitsInArea(m.x, m.z, m.r, {
                civilian = m.civilian, role = m.role,
                defs = defNameSet(m.defs), team = m.team,
            })
            local into = m.into or 'targetUnitIDs'
            if POPULATE_INTO[into] == 'singular' then
                -- kill wants ONE runtime id. Nearest match to the marker
                -- centre, so two candidates in radius resolve the same way
                -- every run rather than by engine iteration order.
                local best, bestDist
                for _, unitID in ipairs(ids) do
                    local ux, _, uz = Spring.GetUnitPosition(unitID)
                    local d = ux and ((ux - m.x) ^ 2 + (uz - m.z) ^ 2) or math.huge
                    if best == nil or d < bestDist then best, bestDist = unitID, d end
                end
                params[into] = best
                emptySingular = best == nil
            else
                params[into] = ids
            end
            Spring.Echo('[game_scenario] populated ' .. #ids .. ' unit(s) into ' ..
                       into .. ' for ' .. (o.type or 'unknown') .. ' objective')
        end

        -- Only create if every populated field resolved somebody: an empty
        -- array (or a nil targetUnitID) fails the type module's init, Create
        -- returns nil, and — worse — a def that fails init on a scoped team is
        -- the "Bad teamID" blast radius stageObjectives documents. Skipping is
        -- the contract: a marker that finds nobody is a war without that
        -- objective, never a broken one.
        if (not params.targetUnitIDs or #params.targetUnitIDs > 0) and
           (not params.payloadUnitIDs or #params.payloadUnitIDs > 0) and
           (not params.buildingUnitIDs or #params.buildingUnitIDs > 0) and
           not emptySingular then
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
    local liveTeams = buildLiveTeams()
    local warned = {}
    for _, o in ipairs(objectives or {}) do
        -- Third and last place the "scenario declares more teams than the
        -- launch supplied" mismatch bites (PLAN-endtoend.md D10; stageUnits
        -- and stageAI guard the other two). An objective scoped to a missing
        -- team is not merely useless — nobody can complete it, and when it
        -- expires or resolves, game_objectives pays its reward through
        -- GG.Authority, whose getTeamPool does Spring.GetTeamRulesParam on
        -- that team and throws "Bad teamID". That error propagates out of the
        -- Objectives gadget's callin, so gadgetHandler REMOVES the gadget —
        -- and with the objective evaluator gone, the war's victory objective
        -- can never progress. Observed live: "Removed gadget: Objectives" at
        -- frame 5669 of a two-team lobby room on Meridian Basin.
        --
        -- Open-race objectives (forTeam nil) are unaffected, which is why the
        -- victory objective itself survives either way.
        if o.forTeam ~= nil and not liveTeams[o.forTeam] then
            if not warned[o.forTeam] then
                warned[o.forTeam] = true
                Spring.Echo('[game_scenario] WARNING: scenario scopes objectives to team ' ..
                            tostring(o.forTeam) .. ' which this game does not have — skipped ' ..
                            '(add a player/AI slot for it in the room manifest)')
            end
            goto continue
        end
        -- Authoring convenience: flat type-specific fields fold into
        -- GG.Objectives.Create's `params` sub-table — the shape
        -- game_objectives.lua's evaluators read. Written back onto the def so
        -- the DEFERRED path (which re-reads o.params at frame 30) inherits the
        -- same folding; without the write-back an objective authored with flat
        -- fields and no `params` table lost them the moment it was deferred.
        local params = foldParams(o)
        o.params = params

        -- Check if this objective needs runtime unit population
        -- (empty targetUnitIDs/payloadUnitIDs + a _populateFrom marker)
        local needsTargets = o._populateTargetsFrom ~= nil or
                             o._populateUnitsFrom ~= nil
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
                -- Chaining (§4.7). `phases` is the authorable chain: the
                -- parent is a real objective whose progress is its children,
                -- so it must itself be valid for its declared type.
                -- `parentId`/`linkedId` are RUNTIME ids — meaningful only to
                -- programmatic callers re-staging through this helper, since a
                -- scenario file cannot know an id that Create has not minted
                -- yet. `phase` is a published label; the phase machinery
                -- overwrites it on parents as phases advance.
                phases = foldPhases(o.phases),
                parentId = o.parentId, phase = o.phase, linkedId = o.linkedId,
                -- wars §7.1: the scenario's terminal objective (game_gameover.lua).
                victory = o.victory,
            })
        end
        ::continue::
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

    local knownFeatureDefs = buildKnownFeatureDefs()
    local errors = validate(scn, buildKnownDefNames(), knownFeatureDefs)
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
    -- Before units: features are terrain-that-blocks, so a wreck must own its
    -- squares before anything is placed near it (CreateUnit onto a square a
    -- later CreateFeature would claim leaves the unit stuck inside it).
    local landmarks = {}
    GG.Scenario.features = stageFeatures((scn.world or {}).features,
                                         knownFeatureDefs, landmarks)
    -- Towns before units, and units before civilians: a town must be
    -- registered before its residents ask GG.Towns for their home, and its
    -- buildings must be on the ground before civilians/town.lua (at its own,
    -- later GameStart) can resolve a meeting hall to a live unit.
    stageTowns(scn.towns)
    stageUnits(scn.units, landmarks)
    stageCivilians(scn.civilians)
    stageObjectives(scn.objectives)
    stageAI(scn.ai)
    publishLandmarks(landmarks)

    GG.Scenario.name = name
    GG.Scenario.data = scn
    GG.Scenario.landmarks = landmarks
    Spring.SetGameRulesParam('scenario_name', name)

    Spring.Echo('[game_scenario] staged "' .. (scn.name or name) .. '"')
end

-- ============================================================
-- "Can this war be FOUGHT?" — the sibling of game_gameover's
-- "can this war END?" (PLAN-metalstorm-wars.md §7.4, endtoend D19).
--
-- stageUnits already warns about the scenario's half of the mismatch: a
-- scenario team the room does not have. The half that actually ends the match
-- before it starts is the inverse — a LIVE team nothing was staged for. A war
-- created through the Create Game dialog spent three minutes in exactly that
-- state (team 0 = 13 units, team 1 = 0 units, no opponent on the board) and
-- the only trace was one skipped-team line nobody read.
--
-- So it is now as loud as an endless war, published the same way, and checked
-- against the staged board rather than against the request — it does not care
-- how the room was created, so no boot path can bypass it.
local UNSTAGED_CHECK_FRAME = 60
local unstagedChecked = false

local function checkEveryTeamHasAnArmy()
    local gaia = Spring.GetGaiaTeamID and Spring.GetGaiaTeamID() or nil
    local empty = {}
    for _, teamID in ipairs(Spring.GetTeamList() or {}) do
        -- Only teams somebody actually occupies. The engine materialises every
        -- index up to the highest one the launch named, so a room seating its
        -- two sides on teams 0 and 4 also gets teams 1-3 — real, live, and
        -- nobody's. Those are filler, not a missing army; GetTeamInfo's leader
        -- is -1 for them and >= 0 for a team with a player or an AI.
        local _, leader = Spring.GetTeamInfo(teamID)
        if teamID ~= gaia and leader ~= nil and leader >= 0 then
            local units = Spring.GetTeamUnits(teamID)
            if units == nil or #units == 0 then
                -- '%d', not the raw number: Spring hands team ids back as Lua
                -- floats, so a bare concat says "team(s) 1.0" (the same trap
                -- game_gameover's joinIds exists for).
                empty[#empty + 1] = string.format('%d', teamID)
            end
        end
    end

    Spring.SetGameRulesParam('war_teams_unstaged', #empty, { public = true })
    if #empty == 0 then return end

    Spring.Echo('[game_scenario] WARNING: team(s) ' .. commaList(empty) ..
                ' are in this war with NO units — nothing was staged for ' ..
                'them, so those sides cannot fight and cannot be fought. ' ..
                (GG.Scenario and GG.Scenario.name
                    and ('Scenario "' .. GG.Scenario.name ..
                         '" stages a starting force for its own teams only; ' ..
                         'check the room seated its slots on the sides the ' ..
                         'scenario declares')
                    or 'No scenario was staged (the `scenario` modoption is ' ..
                       'unset)') ..
                '. See PLAN-metalstorm-wars.md §7.4.')
end

-- ============================================================
-- "Can this war be CONTESTED?" — the third sibling (wars §7.5, endtoend D20).
--
-- §7.4 above made "a side with no army" loud. D20 is the next one down: two
-- armies exist, and the war still ends without a shot, because one side was
-- staged and never told to go anywhere while the other's terminal objective
-- was winnable before anybody could cross the map. Both halves are properties
-- of the SCENARIO — they are read back off `GG.Scenario.data`, not off live
-- command queues, so an AI that has not issued its first directive by frame 60
-- cannot false-positive them.
-- ============================================================

--- name -> movement speed (elmos/sec; 0 for buildings) for every shipped def.
local function buildDefSpeeds()
    local speeds = {}
    for _, def in pairs(UnitDefs) do speeds[def.name] = def.speed or 0 end
    return speeds
end

--- Staged mobile force per team: { [team] = { n, ordered, speedMin, x, z } }.
--- Centroid is count-weighted (a `count = 4` entry is four units), matching
--- how stageUnits actually puts them on the board.
---
--- A `team = 'neutral'` entry (Gaia — see resolveTeam) buckets under the string
--- key, which no live team id can equal, so both §7.5 checks below skip it via
--- their `live[teamID]` guard. That is the wanted behaviour: a neutral town's
--- civilians are not an army, and neither "they have no opening orders" nor
--- "they cannot reach the objective" is a defect in the war.
local function stagedForceByTeam(scn, speeds)
    local byTeam = {}
    for _, u in ipairs((scn and scn.units) or {}) do
        local speed = speeds[u.def] or 0
        if speed > 0 and u.team ~= nil then
            local n = math.max(1, tonumber(u.count) or 1)
            local f = byTeam[u.team]
            if not f then
                f = { n = 0, ordered = 0, speedMin = math.huge, sx = 0, sz = 0 }
                byTeam[u.team] = f
            end
            f.n = f.n + n
            if u.orders and #u.orders > 0 then f.ordered = f.ordered + n end
            if speed < f.speedMin then f.speedMin = speed end
            f.sx = f.sx + (u.x or 0) * n
            f.sz = f.sz + (u.z or 0) * n
        end
    end
    for _, f in pairs(byTeam) do
        f.x, f.z = f.sx / f.n, f.sz / f.n
    end
    return byTeam
end

--- Live, occupied, non-Gaia teams (same filter §7.4's check uses: the engine
--- materialises filler teams between the two sides, and their leader is -1).
local function liveOccupiedTeams()
    local gaia = Spring.GetGaiaTeamID and Spring.GetGaiaTeamID() or nil
    local live = {}
    for _, teamID in ipairs(Spring.GetTeamList() or {}) do
        local _, leader = Spring.GetTeamInfo(teamID)
        if teamID ~= gaia and leader ~= nil and leader >= 0 then live[teamID] = true end
    end
    return live
end

--- §7.5 check 1 — `war_units_unordered`. A side whose whole staged force sits
--- on its spawn tile is not an army, it is scenery: measured on Meridian, nine
--- of the player's thirteen units were at their exact spawn coordinates at the
--- frame the war ended.
local function checkStagedForcesHaveOrders(byTeam, live)
    local silent = {}
    for teamID, f in pairs(byTeam) do
        if live[teamID] and f.n > 0 and f.ordered == 0 then
            silent[#silent + 1] = string.format('%d', teamID)
        end
    end
    table.sort(silent)
    Spring.SetGameRulesParam('war_units_unordered', #silent, { public = true })
    if #silent == 0 then return end
    Spring.Echo('[game_scenario] WARNING: team(s) ' .. commaList(silent) ..
                ' have a staged army with NO opening orders — every unit will ' ..
                'sit on its spawn until a player or AI moves it, so this side ' ..
                'cannot contest anything on its own. See ' ..
                'PLAN-metalstorm-wars.md §7.5.')
end

--- §7.5 check 2 — `war_victory_unreachable`. The terminal objective may not be
--- winnable before the sides can reach it. Distance is straight-line and speed
--- is the side's slowest staged unit, so the estimate UNDERSTATES travel time
--- (real routes detour around the ridge) — the check therefore only fires when
--- the war is certainly decidable before contact, never on a marginal one.
local function checkVictoryIsContestable(scn, byTeam, live)
    local victory
    for _, o in ipairs((scn and scn.objectives) or {}) do
        if o.victory and o.type == 'control' then victory = o end
    end
    if not victory then
        Spring.SetGameRulesParam('war_victory_unreachable', 0, { public = true })
        return   -- no terminal control objective: §7.1's "ends by detach" case
    end

    local key = victory.region or (victory.params and victory.params.regionKey)
    local rx = key and Spring.GetGameRulesParam('region_' .. key .. '_x')
    local rz = key and Spring.GetGameRulesParam('region_' .. key .. '_z')
    if not rx or not rz then
        Spring.SetGameRulesParam('war_victory_unreachable', 0, { public = true })
        return   -- region graph has no geometry for it; nothing honest to check
    end

    local earliest = (victory.notBefore or 0) +
                     (victory.holdFrames or DEFAULT_VICTORY_HOLD_FRAMES)
    local worstFrames, worstTeam = 0, nil
    for teamID, f in pairs(byTeam) do
        if live[teamID] and f.n > 0 and f.speedMin > 0 then
            local dx, dz = rx - f.x, rz - f.z
            local frames = math.sqrt(dx * dx + dz * dz) / (f.speedMin / 30)
            if frames > worstFrames then worstFrames, worstTeam = frames, teamID end
        end
    end

    local unreachable = (worstTeam ~= nil and earliest < worstFrames)
    Spring.SetGameRulesParam('war_victory_unreachable', unreachable and 1 or 0,
                             { public = true })
    if not unreachable then return end
    Spring.Echo(string.format(
        '[game_scenario] WARNING: the victory objective (control %s) can ' ..
        'complete at frame %.0f, but team %d needs at least %.0f frames to ' ..
        'reach it — this war can be won before the sides can meet. Raise ' ..
        'notBefore/holdFrames on it, or stage that side closer. See ' ..
        'PLAN-metalstorm-wars.md §7.5.',
        tostring(key), earliest, worstTeam, worstFrames))
end

local function checkWarCanBeContested()
    local scn = GG.Scenario and GG.Scenario.data
    if not scn then return end   -- no scenario: §7.3's warnIfWarCannotEnd owns that
    local byTeam = stagedForceByTeam(scn, buildDefSpeeds())
    local live = liveOccupiedTeams()
    checkStagedForcesHaveOrders(byTeam, live)
    checkVictoryIsContestable(scn, byTeam, live)
end

-- ─────────────── Snapshot state (PLAN-persistence task 1d-b, §7.1d) ───────────────
--
-- This gadget is mostly a STAGER: it reads a scenario file at GameStart and
-- turns it into units, features, objectives and team params, all of which are
-- sim state that rides the units/features/teams sections. What survives past
-- staging is small, and every piece of it is a schedule or a latch.
--
-- CAPTURED — `aiStipends`. Each entry carries `nextFrame`, an ABSOLUTE frame
-- stamp, and `payStipends` pays whenever `frame >= nextFrame`. The list itself
-- is re-derivable from the scenario file, but its cursors are not: restore
-- forward with the staged copy and every NPC is paid on the first frame after
-- the restore; restore backward and it is paid twice for the same minute.
-- Captured whole rather than merged, so the pair (schedule, cursor) cannot
-- disagree.
--
-- CAPTURED — `unstagedChecked`. A one-shot latch for the frame-60 "does every
-- side actually have an army" audit. It is the same shape as game_gameover's
-- `endlessChecked` and captured for the same reason: a restore that clears it
-- re-runs the audit and re-announces its warnings against a mid-war board the
-- check was never written for (it asks whether a side was ever STAGED, and by
-- frame 20 000 a side may legitimately have lost every unit it had).
--
-- CAPTURED — `pendingConvoyObjectives`. Escort objectives waiting on a convoy
-- that spawns on a staggered 0-60 s timer. They are keyed by route id and
-- released by NotifyConvoySpawn; dropping them means a scenario-authored
-- objective silently never appears, with nothing to say it was owed.
--
-- NOT CAPTURED — `deferredObjectives`. It is drained at frame 30 and only at
-- frame 30 (`if frame == 30`), so past that frame it is empty by construction
-- and a snapshot of it would always be the empty list. Named here rather than
-- omitted silently: if that drain ever moves off a fixed frame, this becomes a
-- capture.
--
-- RE-DERIVED, not captured — `GG.Scenario.name` / `.data` / `.landmarks` /
-- `.features`. They are the parsed scenario file, staged from the `scenario`
-- modoption at GameStart; the file is content and the modoption is the launch's,
-- so both are identical either side of a restore of the same war, and the LIVE
-- launch must win if they ever are not.
--
-- NOT REPUBLISHED — `war_teams_unstaged` / `war_units_unordered` /
-- `war_victory_unreachable` / `scenario_name` / `landmark_*` are game rules
-- params and ride the `gameRules` section; the per-team ai_slate params are
-- team rules params and ride `teams`.
function gadget:Save(state)
    state.aiStipends = aiStipends
    state.unstagedChecked = unstagedChecked
    state.pendingConvoyObjectives = pendingConvoyObjectives
end

function gadget:Load(state)
    aiStipends = state.aiStipends or {}
    unstagedChecked = state.unstagedChecked == true
    pendingConvoyObjectives = state.pendingConvoyObjectives or {}
end

function gadget:GameFrame(frame)
    if not unstagedChecked and frame >= UNSTAGED_CHECK_FRAME then
        unstagedChecked = true
        checkEveryTeamHasAnArmy()
        checkWarCanBeContested()
    end

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
