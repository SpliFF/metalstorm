-- tests/game_landmarks_spec.lua — the scenario loader's landmark publisher
-- (PLAN-metalstorm-model-integration §M4, PLAN-metalstorm-worldbuilding
-- directive 2).
--
-- WHY THIS EXISTS. `landmark_<name>_x/_z` is a rulesParam shape the CLIENT has
-- parsed since the named-entity index landed — `parseLandmarksFromRulesParams`
-- in client/src/ui/native-ui/named-entity-index.ts — and which had no producer
-- at all; the header of entity-index-producer.ts said so in as many words ("no
-- publisher yet"). §M4 makes the scenario loader that producer, so that the
-- named resource sites scenariogen places are things the command language can
-- actually be told about ("hold the Granary Vale silos",
-- PLAN-metalstorm-command-language.md §6.5).
--
-- Every failure this guards is INVISIBLE from inside the game. A landmark that
-- is not published is not an error, it is a name the player can see on the map
-- and cannot say. A DUPLICATE name is worse: the name is the rulesParam key, so
-- the second entry silently overwrites the first's position and one landmark
-- disappears from the index while the scenario still lists two.
--
-- Run from the GAME root (same as game_scenario_neutral_spec.lua, and for the
-- same reason — the gadget is loaded by a game-root-relative path):
--   cd data/games/metalstorm && busted LuaRules/Gadgets/tests/game_landmarks_spec.lua

local GADGET = './LuaRules/Gadgets/game_scenario.lua'

local GAIA = 99

local function newWorld(scn)
    local world = {
        createdUnits = {},
        createdFeatures = {},
        echoes = {},
        gameRulesParams = {},
        rulesParamLos = {},
        refuse = {},            -- def name -> true: CreateUnit returns nil
        scenario = scn,
    }

    _G.Spring = {
        GetModOptions = function() return { scenario = 'landmark_test' } end,
        GetTeamList = function() return { 0, 1, GAIA } end,
        GetGaiaTeamID = function() return GAIA end,
        GetTeamInfo = function(teamID)
            return nil, (teamID == 0 or teamID == 1) and 1 or -1
        end,
        GetTeamUnits = function() return {} end,
        GetGroundHeight = function() return 0 end,
        GetUnitsInCylinder = function() return {} end,
        GetGameRulesParam = function(key) return world.gameRulesParams[key] end,
        ValidUnitID = function() return true end,
        CreateUnit = function(def, x, y, z, facing, team)
            if world.refuse[def] then return nil end
            world.createdUnits[#world.createdUnits + 1] =
                { def = def, team = team, x = x, z = z }
            return #world.createdUnits
        end,
        CreateFeature = function(def, x, y, z, heading, team)
            world.createdFeatures[#world.createdFeatures + 1] =
                { def = def, x = x, y = y, z = z, heading = heading, team = team }
            return #world.createdFeatures
        end,
        GiveOrderToUnit = function() end,
        SetTeamRulesParam = function() end,
        SetGameRulesParam = function(key, value, los)
            world.gameRulesParams[key] = value
            world.rulesParamLos[key] = los
        end,
        Echo = function(msg) world.echoes[#world.echoes + 1] = tostring(msg) end,
    }

    _G.CMD = { FIGHT = 16, MOVE = 10, GUARD = 25 }
    _G.gadgetHandler = { IsSyncedCode = function() return true end }
    _G.gadget = {}

    _G.UnitDefs = {}
    for i, d in ipairs({
        { name = 'ms_tanks_s2',   speed = 66.3 },
        { name = 'ms_grain_silo', speed = 0 },
        { name = 'ms_metal_pit',  speed = 0 },
    }) do
        _G.UnitDefs[i] = { name = d.name, speed = d.speed, customParams = {} }
    end

    -- Feature defs, shaped as CFeatureDefHandler exposes them. chain_pitch is
    -- the road span's real published value (features/bridges.lua), because the
    -- chaining arithmetic reads it off the def rather than from the scenario.
    _G.FeatureDefs = {
        [1] = { name = 'ms_road_bridge', customParams = { chain_pitch = '24' } },
        [2] = { name = 'ms_colossus_wreck', customParams = {} },
    }

    _G.GG = {
        Regions = { KeyAt = function() return '0:0' end,
                    SetControllingTeam = function() end },
        Objectives = { Create = function() return 1 end },
        Civilians = { Spawn = function() return 5000 end, Register = function() end },
        Teams = { AIPlayers = function() return {} end },
        Authority = { Award = function() end },
        Scenario = {},
    }
    _G.VFS = { Include = function() return world.scenario end }

    dofile(GADGET)
    return world, _G.gadget
end

--- A minimal war with one named site and one named feature.
local function scenario(over)
    local scn = {
        version = 1, name = 'Landmark test',
        world = {
            regions = {},
            features = {
                { def = 'ms_road_bridge', x = 5000, z = 4000, y = 0,
                  facing = 'east', chain = 4, name = 'Raven Basin Crossing' },
                -- Unnamed on purpose: a wreck is texture, not a place, and it
                -- must not put an anonymous entry into the index.
                { def = 'ms_colossus_wreck', x = 6000, z = 6000 },
            },
        },
        sides = { { faction = 'compact', team = 0 }, { faction = 'union', team = 1 } },
        units = {
            { def = 'ms_tanks_s2', team = 0, x = 1000, z = 1000, facing = 'south',
              count = 2, spacing = 150,
              orders = { { cmd = 'FIGHT', params = { 4000, 0, 4000 } } } },
            { def = 'ms_tanks_s2', team = 1, x = 7000, z = 7000, facing = 'south',
              count = 2, spacing = 150,
              orders = { { cmd = 'FIGHT', params = { 4000, 0, 4000 } } } },
            { def = 'ms_grain_silo', team = 'neutral', x = 4000, z = 3000,
              facing = 'south', name = 'Thorn Crossing Grain Silo' },
        },
        objectives = {
            { type = 'control', scope = 'strategic', forTeam = nil,
              region = 'mid', reward = 300, victory = true,
              notBefore = 0, holdFrames = 5400 },
        },
    }
    for k, v in pairs(over or {}) do scn[k] = v end
    return scn
end

local function loadFails(scn, pattern)
    local _world, g = newWorld(scn)
    local ok, err = pcall(function() g:GameStart() end)
    assert.is_false(ok, 'expected the scenario to be rejected')
    assert.is_truthy(tostring(err):find(pattern, 1, true),
                     'error did not mention "' .. pattern .. '": ' .. tostring(err))
end

--=============================================================================
describe('game_scenario landmark publisher (§M4)', function()

    it('publishes a named site at its authored position', function()
        local world, g = newWorld(scenario())
        g:GameStart()

        assert.are.equal(4000, world.gameRulesParams['landmark_Thorn Crossing Grain Silo_x'])
        assert.are.equal(3000, world.gameRulesParams['landmark_Thorn Crossing Grain Silo_z'])
    end)

    it('publishes a named feature at its CHAIN CENTRE, not its first segment', function()
        -- Chaining is centred on (x, z) — that is how an author picks a
        -- crossing, by where the gap is rather than where its upstream end is —
        -- so the landmark is the same point, not the first span the loader
        -- happens to create.
        local world, g = newWorld(scenario())
        g:GameStart()

        assert.are.equal(4, #world.createdFeatures - 1)   -- 4 spans + 1 wreck
        assert.are.equal(5000, world.gameRulesParams['landmark_Raven Basin Crossing_x'])
        assert.are.equal(4000, world.gameRulesParams['landmark_Raven Basin Crossing_z'])
    end)

    it('publishes PUBLIC, because a landmark is geography', function()
        -- The grain silo is where it is for everybody, and the whole point is
        -- that either side can say "hit the grain silo". Region names
        -- (game_regions.lua:229) are published the same way for the same
        -- reason; without PUBLIC the client's rulesParams mirror never sees it.
        local world, g = newWorld(scenario())
        g:GameStart()

        local los = world.rulesParamLos['landmark_Thorn Crossing Grain Silo_x']
        assert.is_table(los)
        assert.is_true(los.public)
    end)

    it('leaves unnamed entries out of the index entirely', function()
        local world, g = newWorld(scenario())
        g:GameStart()

        for key in pairs(world.gameRulesParams) do
            assert.is_falsy(key:find('colossus', 1, true),
                            'an unnamed wreck was published as a landmark')
        end
    end)

    it('says how many landmarks it published', function()
        local world, g = newWorld(scenario())
        g:GameStart()

        local found = false
        for _, e in ipairs(world.echoes) do
            if e:find('published 2 landmark', 1, true) then found = true end
        end
        assert.is_true(found, 'the loader published landmarks silently')
    end)

    it('does not publish a landmark the engine refused to create', function()
        -- A name is a promise the player can point at something. Publishing one
        -- for an entry CreateUnit refused (occupied ground — which it reports
        -- ONLY by returning nil) would put a silo in the command language's
        -- target list that is not on the map, and the locate-ping would fly to
        -- bare terrain.
        local world, g = newWorld(scenario())
        world.refuse['ms_grain_silo'] = true
        g:GameStart()

        assert.is_nil(world.gameRulesParams['landmark_Thorn Crossing Grain Silo_x'])
        -- The feature landmark is unaffected: features are placed by a
        -- different call that did not fail.
        assert.are.equal(5000, world.gameRulesParams['landmark_Raven Basin Crossing_x'])
    end)

    it('rejects two entries sharing a name', function()
        -- The name IS the key, so the second would overwrite the first and one
        -- landmark would vanish from the index while the file still lists two.
        local scn = scenario()
        scn.units[#scn.units + 1] = {
            def = 'ms_metal_pit', team = 'neutral', x = 9000, z = 9000,
            facing = 'south', name = 'Thorn Crossing Grain Silo',
        }
        loadFails(scn, 'duplicate name')
    end)

    it('rejects a name colliding across units and features', function()
        local scn = scenario()
        scn.world.features[2].name = 'Thorn Crossing Grain Silo'
        loadFails(scn, 'duplicate name')
    end)

    it('rejects a name ending in the coordinate suffix', function()
        -- The client splits landmark_<name>_x with a greedy name capture
        -- anchored at end-of-string, so "Pier_x" parses as landmark "Pier"
        -- with a missing coordinate and is dropped without a word.
        local scn = scenario()
        scn.units[#scn.units].name = 'Pier_x'
        loadFails(scn, 'must not end in')
    end)

    it('rejects a non-string name rather than concatenating it into a key', function()
        local scn = scenario()
        scn.units[#scn.units].name = 42
        loadFails(scn, 'must be a string')
    end)

    it('is inert for a scenario that names nothing', function()
        -- Every scenario that predates §M4 must behave exactly as before.
        local scn = scenario()
        scn.units[#scn.units].name = nil
        scn.world.features[1].name = nil
        local world, g = newWorld(scn)
        g:GameStart()

        for key in pairs(world.gameRulesParams) do
            assert.is_falsy(key:find('landmark_', 1, true), key)
        end
    end)
end)
