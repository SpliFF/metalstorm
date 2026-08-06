-- game_scenario.lua — scenario world loader (PLAN-persistence.md §5).
--
-- Loads a declarative scenario file from scenarios/ at GameStart when the
-- room manifest names one (quickstart --direct manifest's top-level
-- "scenario" field, threaded through as the `scenario` modoption — see
-- rts/lobby_main.cpp runDirectStart): pre-set units, region ownership,
-- initial objectives, civilian population, NPC faction AI slots, and
-- `world.features` — wrecks, bridge spans and ancient-tech sites placed via
-- Spring.CreateFeature (PLAN-metalstorm-model-integration §M3; the defs live
-- in data/games/metalstorm/features/, see that directory's README). No engine
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

    -- Features are validated as hard as AI slates and for the same reason:
    -- Spring.CreateFeature returns nothing for an unknown def and does NOT
    -- error ("do not error (featureDefs are dynamic)", LuaSyncedCtrl.cpp:4344),
    -- so a typo'd wreck name would stage a scenario that boots clean and is
    -- silently missing the terrain the fight was designed around.
    for i, f in ipairs((scn.world or {}).features or {}) do
        local ctx = 'world.features[' .. i .. ']'
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
local function stageFeatures(features, knownFeatureDefs)
    local created = {}
    knownFeatureDefs = knownFeatureDefs or buildKnownFeatureDefs()
    for _, f in ipairs(features or {}) do
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
            params.holdFrames = o.holdFrames or
                (o.victory and DEFAULT_VICTORY_HOLD_FRAMES or DEFAULT_CONTROL_HOLD_FRAMES)
        end
        -- wars §7.5a: the open-race delay. Authored flat on the objective for
        -- the same reason `region`/`duration` are — the scenario states when
        -- its prize becomes winnable, the evaluator reads it out of `params`.
        if o.notBefore and params.notBefore == nil then params.notBefore = o.notBefore end

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
    GG.Scenario.features = stageFeatures((scn.world or {}).features, knownFeatureDefs)
    stageUnits(scn.units)
    stageCivilians(scn.civilians)
    stageObjectives(scn.objectives)
    stageAI(scn.ai)

    GG.Scenario.name = name
    GG.Scenario.data = scn
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
