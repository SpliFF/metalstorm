-- tests/game_features_spec.lua — Metalstorm's feature system, end to end
-- (PLAN-metalstorm-model-integration §M3).
--
-- Run from the plugin root, like its neighbours:
--   cd data/games/metalstorm/LuaRules/Gadgets && busted tests/game_features_spec.lua
-- (meridian_basin_scenario_spec.lua is the odd one out here — it runs from the
-- game root. This one does not.)
--
-- §M3's acceptance is three claims, and this spec is built to make each one
-- FAILABLE rather than merely stated:
--
--   "a test scenario spawns every feature via Spring.CreateFeature"
--       -> drives the REAL game_scenario.lua against the REAL
--          scenarios/scenario_smoke_test.lua with a recording CreateFeature,
--          then checks the recorded set against the REAL features/*.lua
--          roster. Add a def and forget the scenario: this fails.
--
--   "wreck features block and are reclaimable"
--       -> asserts on the ENGINE-SHAPED def (tests/feature_mock.lua ports
--          CreateFeatureDef), not on the raw file, so a def cannot pass here
--          and behave differently in game.
--
--   "bridge segments chain without z-fighting"
--       -> the geometric half is checked here: N segments, exactly one
--          chain_pitch apart, along the placement heading, no two coincident.
--          The RENDERING half cannot be asserted in Lua and was settled by
--          measuring the shipped glTF instead — see features/bridges.lua's
--          header (single-sided antiparallel end caps) and
--          .tasks/notes/model-integration.md.

package.path = './?.lua;' .. package.path

local featureMock = require('tests.feature_mock')

local SCENARIO = 'scenario_smoke_test'
local FEATURES_DIR = '../../features/'
local MODELS_DIR = '../../models/'

-- The unit defs scenario_smoke_test.lua stages. game_scenario.lua validates
-- every `units[].def` against UnitDefs before staging anything, so the mock has
-- to know them or the whole load aborts before it reaches the features.
local SCENARIO_UNIT_DEFS = {
    'ms_tanks_s2', 'ms_engineers_s2', 'ms_soldiers_s1', 'ms_radar_s1', 'ms_civilians',
}

--- A fresh mock world + a fresh game_scenario.lua loaded against it. Globals
--- are process-wide in plain Lua, so every `it` gets its own.
local function freshWorld()
    local world = {
        features = {},     -- recorded Spring.CreateFeature calls, in order
        units = {},        -- recorded Spring.CreateUnit calls, in order
        echoes = {},
        -- Deliberately not 0: the scenario places bridge decks at an explicit
        -- y = 0, so a non-zero ground is what makes "the deck ignored the
        -- terrain" and "the wreck sampled the terrain" two distinguishable
        -- outcomes instead of the same number twice.
        groundHeight = 137,
        -- #features at the moment the first unit was created — the ordering
        -- contract's only observable (see the placement spec).
        featuresBeforeFirstUnit = nil,
    }

    world.featureDefs = featureMock.loadFeatureDefs(FEATURES_DIR)
    world.featureDefsByName = featureMock.byName(world.featureDefs)

    _G.UnitDefs = {}
    for i, name in ipairs(SCENARIO_UNIT_DEFS) do
        _G.UnitDefs[i] = { name = name, customParams = {} }
    end
    _G.FeatureDefs = world.featureDefs

    _G.CMD = { MOVE = 10, FIGHT = 16, GUARD = 25 }
    _G.LOG = { INFO = 1, WARNING = 2 }

    _G.Spring = {
        GetModOptions = function() return { scenario = SCENARIO } end,
        GetTeamList   = function() return { 0, 1 } end,
        GetGaiaTeamID = function() return 2 end,
        GetGroundHeight = function() return world.groundHeight end,
        GetGameFrame  = function() return 0 end,

        CreateUnit = function(def, x, y, z, facing, team)
            world.featuresBeforeFirstUnit = world.featuresBeforeFirstUnit or #world.features
            world.units[#world.units + 1] =
                { def = def, x = x, y = y, z = z, facing = facing, team = team }
            return 1000 + #world.units
        end,

        -- The seam under test. Mirrors the real contract: returns a feature id
        -- on success, and NOTHING (not an error) for an unknown def —
        -- LuaSyncedCtrl.cpp:4344 "do not error (featureDefs are dynamic)".
        CreateFeature = function(def, x, y, z, heading, team)
            if not world.featureDefsByName[def] then return nil end
            world.features[#world.features + 1] =
                { def = def, x = x, y = y, z = z, heading = heading, team = team }
            return 2000 + #world.features
        end,

        GiveOrderToUnit    = function() end,
        SetGameRulesParam  = function() end,
        SetTeamRulesParam  = function() end,
        Echo = function(msg) world.echoes[#world.echoes + 1] = tostring(msg) end,
        Log  = function() end,
    }

    _G.VFS = {
        Include = function(path)
            local scn = path:match('scenarios/([%w_]+)%.lua$')
            if scn then return dofile('../../scenarios/' .. scn .. '.lua') end
            error('no such file: ' .. tostring(path))
        end,
    }

    _G.GG = {
        Regions = {
            KeyAt = function() return '0:0' end,
            SetControllingTeam = function() end,
            Keys = function() return { '2:2', '4:4', '6:6' } end,
            ControllingTeam = function() return nil end,
        },
        Civilians = {
            Spawn    = function() return 5000 end,
            Register = function() end,
            GetRole  = function() return 'ambient' end,
        },
        Objectives = { Create = function() return 1 end },
        Teams      = { AIPlayers = function() return { 1 } end },
        Authority  = { Award = function() end },
    }

    _G.gadgetHandler = {
        IsSyncedCode  = function() return true end,
        RegisterCMDID = function() end,
    }
    _G.gadget = {}

    dofile('./game_scenario.lua')
    return world, _G.gadget
end

--- Recorded placements for one def name, in call order.
local function placedAs(world, defName)
    local out = {}
    for _, f in ipairs(world.features) do
        if f.def == defName then out[#out + 1] = f end
    end
    return out
end

local function fileExists(path)
    local fh = io.open(path, 'r')
    if fh then fh:close() return true end
    return false
end

-- ============================================================
describe("featuredef authoring", function()
    local defs, byName

    setup(function()
        defs = featureMock.loadFeatureDefs(FEATURES_DIR)
        byName = featureMock.byName(defs)
    end)

    it("covers every def file this game ships", function()
        -- Guards the one thing feature_mock.lua's explicit DEF_FILES list
        -- cannot: a NEW features/*.lua that nobody added to it would silently
        -- go untested by every assertion below. `ls` rather than a Lua
        -- directory walk because busted ships no portable one; if popen is
        -- unavailable the check reports that instead of passing vacuously.
        local pipe = io.popen('ls ' .. FEATURES_DIR .. '*.lua 2>/dev/null')
        assert.is_not_nil(pipe, 'io.popen unavailable — cannot verify def-file coverage')
        local onDisk = {}
        for line in pipe:lines() do
            onDisk[line:match('([%w_]+)%.lua$')] = true
        end
        pipe:close()
        assert.is_true(next(onDisk) ~= nil,
            'found no features/*.lua at ' .. FEATURES_DIR .. ' — wrong cwd? ' ..
            'run from data/games/metalstorm/LuaRules/Gadgets')

        local listed = {}
        for _, f in ipairs(featureMock.DEF_FILES) do listed[f] = true end
        for stem in pairs(onDisk) do
            assert.is_true(listed[stem] == true,
                'features/' .. stem .. '.lua is not in feature_mock.DEF_FILES — ' ..
                'it is loaded by the engine but tested by nothing')
        end
    end)

    it("gives every def a shipped model", function()
        for _, def in pairs(defs) do
            assert.is_true(def.modelName ~= '', def.name .. ' declares no `object`')
            -- SolidObjectDef::LoadModel strips any extension and resolves
            -- `<stem>.gltf` in the mod VFS; LuaDefsSerializer resolves the
            -- client's model_url the same way. A typo here is a feature that
            -- loads, spawns, blocks, and renders as a placeholder cube.
            local gltf = MODELS_DIR .. def.modelName:gsub('%.%w+$', '') .. '.gltf'
            assert.is_true(fileExists(gltf),
                def.name .. ': object "' .. def.modelName .. '" has no ' .. gltf)
        end
    end)

    it("gives every def an explicit footprint", function()
        for _, def in pairs(defs) do
            -- A def that omits footprintX/Z falls to the engine's floor of
            -- exactly SPRING_FOOTPRINT_SCALE (FeatureDefHandler.cpp:141-142) —
            -- a 2x2 stamp under a model that is metres across. Nothing in this
            -- roster is that small (the narrowest is the rail bridge at
            -- footprintx 2 -> xsize 4), so landing on 2 means it was forgotten.
            assert.is_true(def.xsize > 2, def.name .. ': footprintX missing (xsize fell to the engine floor)')
            assert.is_true(def.zsize > 2, def.name .. ': footprintZ missing (zsize fell to the engine floor)')
        end
    end)

    it("tags every def with an ms_feature_kind", function()
        local kinds = { wreck = true, bridge = true, ancient = true }
        for _, def in pairs(defs) do
            local kind = def.customParams.ms_feature_kind
            assert.is_true(kinds[kind] == true,
                def.name .. ': ms_feature_kind "' .. tostring(kind) .. '" is not one of wreck/bridge/ancient')
        end
    end)

    describe("wrecks", function()
        local WRECKS = { 'ms_colossus_wreck', 'ms_tank_wreck', 'ms_train_wreck' }

        it("block movement", function()
            -- §M3 acceptance. `collidable` is what CFeature::Block() gates on
            -- (Feature.cpp:236-237) — the def-file spelling is `blocking`.
            for _, name in ipairs(WRECKS) do
                assert.is_not_nil(byName[name], 'missing featuredef ' .. name)
                assert.is_true(byName[name].collidable, name .. ' does not block')
            end
        end)

        it("are reclaimable, and yield metal when reclaimed", function()
            -- §M3 acceptance. Both halves matter: `reclaimable` alone with
            -- metal = 0 is a wreck you can spend 30 s deleting for nothing.
            for _, name in ipairs(WRECKS) do
                local def = byName[name]
                assert.is_true(def.reclaimable, name .. ' is not reclaimable')
                assert.is_true(def.metal > 0, name .. ' yields no metal')
                assert.is_true(def.reclaimTime > 0, name .. ' has no reclaim time')
            end
        end)

        it("scales salvage with the donor unit's mass", function()
            -- The placeholder rule features/wrecks.lua commits to: metal is
            -- half the donor's mass. Pinned so that whoever designs the real
            -- salvage economy changes the numbers deliberately, as a set,
            -- rather than one wreck drifting off the scale unnoticed.
            for _, name in ipairs(WRECKS) do
                local def = byName[name]
                assert.equals(def.mass / 2, def.metal, name .. ': metal should be mass/2')
                assert.equals('1', def.customParams.salvage_placeholder,
                    name .. ': salvage values are unbalanced by design and must say so')
            end
        end)

        it("can be destroyed, so a wreck in a chokepoint can be cleared", function()
            for _, name in ipairs(WRECKS) do
                assert.is_true(byName[name].destructable, name .. ' is indestructible')
                assert.is_true(byName[name].health > 0.1, name .. ' has placeholder health')
            end
        end)
    end)

    describe("bridges", function()
        local BRIDGES = { 'ms_road_bridge', 'ms_rail_bridge' }

        it("publish the measured 24 m chain pitch", function()
            -- The number placement code reads. Measured off the shipped glTF
            -- (road bridge Z spans exactly -12..+12); see bridges.lua's header
            -- for why a pitch that is NOT exactly 24 would z-fight.
            for _, name in ipairs(BRIDGES) do
                assert.is_not_nil(byName[name], 'missing featuredef ' .. name)
                assert.equals('24', byName[name].customParams.chain_pitch, name)
                assert.equals('z', byName[name].customParams.chain_axis, name)
            end
        end)

        it("do not block, pending the deck-pathing engine ask", function()
            -- NOT an oversight — see features/bridges.lua's header and the
            -- 2026-08-06 note in .tasks/notes/model-integration.md. Spring
            -- pathing is single-layer, so a blocking bridge is a wall across
            -- the crossing it exists to open. This assertion is the tripwire
            -- for the flip: when deck pathing lands, this test changes with it.
            for _, name in ipairs(BRIDGES) do
                assert.is_false(byName[name].collidable,
                    name .. ' blocks — a blocking bridge is a wall across its own crossing')
                assert.equals('1', byName[name].customParams.cosmetic_span, name)
            end
        end)

        it("are indestructible and therefore unsalvageable", function()
            for _, name in ipairs(BRIDGES) do
                local def = byName[name]
                assert.is_false(def.destructable, name .. ' can be destroyed')
                -- Engine default: reclaimable follows destructable
                -- (FeatureDefHandler.cpp:105). Asserted, not assumed.
                assert.is_false(def.reclaimable, name .. ' is reclaimable')
                assert.equals(0, def.metal, name .. ' yields metal')
            end
        end)
    end)

    describe("ancient tech", function()
        local RELICS = { 'ms_vault_door', 'ms_monolith_spire', 'ms_dig_site' }

        it("blocks, and is permanent and unsalvageable", function()
            for _, name in ipairs(RELICS) do
                local def = byName[name]
                assert.is_not_nil(def, 'missing featuredef ' .. name)
                assert.is_true(def.collidable, name .. ' does not block')
                assert.is_false(def.destructable, name .. ' can be destroyed')
                assert.is_false(def.reclaimable,
                    name .. ' is reclaimable — an objective must be able to trust it is still there')
                assert.equals(0, def.metal, name .. ' yields metal')
            end
        end)

        it("records the clips features cannot play", function()
            -- Features have no animation path at all (FeatureRenderer
            -- thin-instances one mesh per def). §M3 permits static v1; this
            -- pins the two models whose authored `idle` is going unplayed, so
            -- the escape hatch in ancient.lua's header stays findable.
            for _, name in ipairs({ 'ms_monolith_spire', 'ms_dig_site' }) do
                assert.equals('idle', byName[name].customParams.static_clip_unplayed, name)
            end
        end)
    end)
end)

-- ============================================================
describe("scenario feature placement", function()
    it("spawns every shipped feature via Spring.CreateFeature", function()
        -- THE §M3 ACCEPTANCE TEST. Drives the real gadget against the real
        -- scenario; the pass condition is roster completeness, computed from
        -- the def files rather than from a list written here, so it cannot go
        -- stale as the roster grows.
        local world, gadgetObj = freshWorld()
        gadgetObj:GameStart()

        local spawned = {}
        for _, f in ipairs(world.features) do spawned[f.def] = (spawned[f.def] or 0) + 1 end

        for _, def in pairs(world.featureDefs) do
            assert.is_true((spawned[def.name] or 0) > 0,
                def.name .. ' is never spawned by scenarios/' .. SCENARIO .. '.lua — ' ..
                'add it to world.features')
        end
    end)

    it("places features before units, so a wreck owns its squares first", function()
        -- Ordering contract from game_scenario.lua's GameStart: CreateUnit onto
        -- a square a later CreateFeature would claim leaves the unit stuck
        -- inside it. The mock snapshots the feature count at the first
        -- CreateUnit, so a reordered stage shows up as a count below the total.
        local world, gadgetObj = freshWorld()
        gadgetObj:GameStart()
        assert.is_true(#world.features > 0)
        assert.is_true(#world.units > 0)
        assert.equals(#world.features, world.featuresBeforeFirstUnit,
            'units were staged before all features were placed')
    end)

    it("defaults features to the neutral team", function()
        local world, gadgetObj = freshWorld()
        gadgetObj:GameStart()
        for _, f in ipairs(world.features) do
            assert.equals(-1, f.team, f.def .. ' is not neutral')
        end
    end)

    it("publishes the created feature ids on GG.Scenario", function()
        local world, gadgetObj = freshWorld()
        gadgetObj:GameStart()
        assert.is_table(GG.Scenario.features)
        assert.equals(#world.features, #GG.Scenario.features)
    end)

    describe("bridge chaining", function()
        local world, road

        before_each(function()
            local gadgetObj
            world, gadgetObj = freshWorld()
            gadgetObj:GameStart()
            road = placedAs(world, 'ms_road_bridge')
        end)

        it("places the whole chain the scenario asked for", function()
            assert.equals(4, #road)   -- scenario_smoke_test: chain = 4
        end)

        it("spaces segments at exactly one chain pitch", function()
            -- §M3 acceptance, geometric half. The scenario faces these north,
            -- and heading 0 is -Z in this RH game (SpringMath.inl), so the run
            -- is along Z with X held constant.
            for i = 2, #road do
                local dx = road[i].x - road[i - 1].x
                local dz = road[i].z - road[i - 1].z
                local gap = math.sqrt(dx * dx + dz * dz)
                assert.is_true(math.abs(gap - 24) < 1e-6,
                    'segments ' .. (i - 1) .. '->' .. i .. ' are ' .. gap .. ' apart, not 24')
            end
        end)

        it("runs along -Z at heading 0, not along X", function()
            for i = 2, #road do
                assert.is_true(math.abs(road[i].x - road[1].x) < 1e-6,
                    'chain drifted in X — heading 0 should be pure -Z')
                assert.is_true(road[i].z < road[i - 1].z,
                    'chain should advance toward -Z at heading 0')
            end
        end)

        it("centres the chain on the scenario's crossing point", function()
            -- (x, z) is the MIDPOINT of the run, which is how an author picks a
            -- crossing. 4 segments at 24 => the run is 72 long end centre to
            -- end centre, so the midpoint sits 36 from each end.
            local first, last = road[1], road[#road]
            assert.is_true(math.abs((first.z + last.z) / 2 - 7000) < 1e-6)
            assert.is_true(math.abs(first.x - 7000) < 1e-6)
        end)

        it("leaves no two segments coincident", function()
            -- The failure mode a zero/missing pitch would produce: N spans
            -- stacked on one spot, which IS the z-fighting §M3 rules out.
            local seen = {}
            for _, f in ipairs(road) do
                local key = string.format('%.3f:%.3f', f.x, f.z)
                assert.is_nil(seen[key], 'two road bridge segments at ' .. key)
                seen[key] = true
            end
        end)

        it("spawns every segment at the scenario's y, not at per-segment ground", function()
            -- Half of what keeps a deck level. A chained bridge must not
            -- RESAMPLE ground per segment, or the spawn heights alone already
            -- stair-step. The scenario sets y = 0 while the mock's ground sits
            -- at 137 throughout, so a resample would show up as 137s here.
            --
            -- This asserts the CreateFeature ARGUMENT, which is all a Lua spec
            -- can reach. It is not the whole story: the engine then applies
            -- gravity and clamps to ground (Feature.cpp:565-571), so the y
            -- below only survives because features/bridges.lua sets `floating`
            -- — see the next test, and the live measurements in
            -- .tasks/notes/model-integration.md.
            for _, f in ipairs(road) do
                assert.equals(0, f.y, 'deck segment took ground height instead of the scenario y')
            end
        end)

        it("floats, which is the other half of a level deck", function()
            -- Load-bearing, not decorative. Live-measured 2026-08-06 on
            -- skerry_reach: with `floating`, four road spans placed at y = 0
            -- over a channel came to rest at 0.00 / 0.00 / 0.00 / 0.00; the
            -- same four WITHOUT it settled to -31.0 / -34.5 / -45.9 / -57.6.
            -- Dropping the flag turns a bridge into a staircase down the
            -- seabed, and nothing else in this spec would notice.
            for _, name in ipairs({ 'ms_road_bridge', 'ms_rail_bridge' }) do
                assert.is_true(world.featureDefsByName[name].floating,
                    name .. ' is not floating — its chain will settle to the seabed')
            end
        end)

        it("samples ground height when the scenario gives no y", function()
            local wreck = placedAs(world, 'ms_tank_wreck')[1]
            assert.equals(world.groundHeight, wreck.y)
        end)
    end)

    describe("validation", function()
        local function loadWith(features)
            local world, gadgetObj = freshWorld()
            _G.VFS.Include = function(path)
                if path:match('scenarios/') then
                    return { version = 1, name = 'fixture', world = { features = features } }
                end
                error('no such file: ' .. tostring(path))
            end
            return world, gadgetObj
        end

        it("refuses a scenario naming an unknown feature def", function()
            -- Spring.CreateFeature returns nothing rather than erroring for an
            -- unknown def, so without this the scenario boots clean and is
            -- silently missing the terrain the fight was designed around.
            local _, gadgetObj = loadWith({ { def = 'ms_no_such_wreck', x = 100, z = 100 } })
            assert.has_error(function() gadgetObj:GameStart() end)
        end)

        it("refuses a feature with no position", function()
            local _, gadgetObj = loadWith({ { def = 'ms_tank_wreck', z = 100 } })
            assert.has_error(function() gadgetObj:GameStart() end)
        end)

        it("refuses an unknown facing label", function()
            local _, gadgetObj = loadWith({
                { def = 'ms_tank_wreck', x = 100, z = 100, facing = 'northeast' },
            })
            assert.has_error(function() gadgetObj:GameStart() end)
        end)

        it("refuses chaining a def that declares no pitch", function()
            -- Wrecks carry no chain_pitch. Chaining one would stack every copy
            -- on a single point — refuse rather than draw it.
            local _, gadgetObj = loadWith({
                { def = 'ms_tank_wreck', x = 100, z = 100, chain = 3 },
            })
            assert.has_error(function() gadgetObj:GameStart() end)
        end)

        it("accepts a chain when the scenario supplies its own pitch", function()
            local world, gadgetObj = loadWith({
                { def = 'ms_tank_wreck', x = 100, z = 100, chain = 3, pitch = 40 },
            })
            gadgetObj:GameStart()
            assert.equals(3, #placedAs(world, 'ms_tank_wreck'))
        end)
    end)
end)
