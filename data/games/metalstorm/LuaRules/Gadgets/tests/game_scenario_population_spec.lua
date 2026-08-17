-- tests/game_scenario_population_spec.lua — the general population marker
-- (`_populateUnitsFrom`, objective-population 2026-08-18) that resolves
-- ORDINARY units into an objective's params at the frame-30 sweep.
--
-- Run from the GAME root (same as game_scenario_objectives_spec.lua, and for
-- the same reason — the gadget is loaded by a game-root-relative path):
--   cd data/games/metalstorm && busted LuaRules/Gadgets/tests/game_scenario_population_spec.lua
--
-- WHY THIS EXISTS. The loader's two original markers both resolved through the
-- CIVILIAN registry, so no static scenario file could author a `kill`
-- (params.targetUnitID — one runtime id, SINGULAR) or an `infra`
-- (params.buildingUnitIDs — buildings are never civilians) at all.
-- `_populateUnitsFrom` closes that, and the cases here pin its three sharp
-- edges: the def/team filters, the singular nearest-match resolution, and the
-- skip-on-empty contract — an unresolved objective fails its type module's
-- init, and a failed init on a scoped team is the "Bad teamID" gadget-removal
-- blast radius stageObjectives documents.

local GADGET = './LuaRules/Gadgets/game_scenario.lua'

local GAIA = 99

--- A world with POSITIONED units: GetUnitsInCylinder really filters by
--- distance, because the singular (`into = 'targetUnitID'`) resolution is
--- specified as nearest-to-marker-centre and a mock that returns everything
--- everywhere cannot falsify that.
--- `opts.units`: unitID -> { def = <name>, team = <id>, x = , z = }.
local function newWorld(opts)
    opts = opts or {}
    local world = {
        created = {},
        echoes = {},
        gameRulesParams = {},
        units = opts.units or {},
        civilians = opts.civilians or {},   -- unitID -> role
        teams = { 0, 1, 2, GAIA },
        scenario = opts.scenario,
        frame = 0,
    }

    local defIDs = {}       -- name -> UnitDefs index
    _G.UnitDefs = {}
    for i, def in ipairs({
        { name = 'ms_civilians', customParams = { civilian = '1' } },
        { name = 'ms_command_post', customParams = {} },
        { name = 'ms_habitat', customParams = {} },
        { name = 'ms_depot', customParams = {} },
    }) do
        _G.UnitDefs[i] = def
        defIDs[def.name] = i
    end

    _G.Spring = {
        GetModOptions = function() return { scenario = 'population_test' } end,
        GetTeamList = function() return world.teams end,
        GetGaiaTeamID = function() return GAIA end,
        GetTeamInfo = function(teamID)
            return nil, (teamID ~= GAIA) and 1 or -1
        end,
        GetTeamUnits = function() return {} end,
        GetGameFrame = function() return world.frame end,
        GetGroundHeight = function() return 0 end,
        GetUnitsInCylinder = function(x, z, r)
            local out = {}
            for unitID, u in pairs(world.units) do
                if (u.x - x) ^ 2 + (u.z - z) ^ 2 <= r ^ 2 then
                    out[#out + 1] = unitID
                end
            end
            table.sort(out)
            return out
        end,
        GetUnitDefID = function(unitID)
            local u = world.units[unitID]
            return u and defIDs[u.def]
        end,
        GetUnitTeam = function(unitID)
            local u = world.units[unitID]
            return u and u.team
        end,
        GetUnitPosition = function(unitID)
            local u = world.units[unitID]
            if not u then return nil end
            return u.x, 0, u.z
        end,
        GetGameRulesParam = function(key) return world.gameRulesParams[key] end,
        ValidUnitID = function() return true end,
        CreateUnit = function() return 1 end,
        GiveOrderToUnit = function() end,
        SetUnitNeutral = function() end,
        SetTeamRulesParam = function() end,
        SetGameRulesParam = function(key, value) world.gameRulesParams[key] = value end,
        Echo = function(msg) world.echoes[#world.echoes + 1] = tostring(msg) end,
    }

    _G.CMD = { FIGHT = 16, MOVE = 10, GUARD = 25 }
    _G.gadgetHandler = { IsSyncedCode = function() return true end }
    _G.gadget = {}

    local nextId = 100
    _G.GG = {
        Regions = {
            KeyAt = function() return '0:0' end,
            SetControllingTeam = function() end,
            SetName = function() end,
        },
        Objectives = {
            Create = function(def)
                nextId = nextId + 1
                world.created[#world.created + 1] = def
                return nextId
            end,
        },
        Civilians = {
            Spawn = function() return 5000 end,
            Register = function() end,
            IsCivilian = function(unitID) return world.civilians[unitID] ~= nil end,
            GetRole = function(unitID) return world.civilians[unitID] end,
        },
        Teams = { AIPlayers = function() return {} end },
        Authority = { Award = function() end },
        Scenario = {},
    }
    _G.VFS = { Include = function() return world.scenario end }

    dofile(GADGET)
    return world, _G.gadget
end

local function scenario(objectives)
    return {
        version = 1, name = 'Population marker test',
        world = { regions = { { key = 'home_north', team = 0 } } },
        sides = { { faction = 'compact', team = 0 }, { faction = 'union', team = 1 } },
        objectives = objectives,
    }
end

local function echoMatching(world, pattern)
    for _, e in ipairs(world.echoes) do
        if e:find(pattern, 1, true) then return e end
    end
    return nil
end

local function runToSweep(world, gadgetObj)
    gadgetObj:GameStart()
    world.frame = 30
    gadgetObj:GameFrame(30)
end

--=============================================================================
describe("game_scenario _populateUnitsFrom (objective population)", function()

    describe("kill — the singular `into = 'targetUnitID'`", function()
        local killObjective = {
            type = 'kill', scope = 'tactical', forTeam = nil, reward = 160,
            _populateUnitsFrom = { x = 1000, z = 1000, r = 500,
                                   defs = { 'ms_command_post' }, team = 2,
                                   into = 'targetUnitID' },
        }

        it("defers at GameStart and resolves ONE runtime id at frame 30", function()
            local world, g = newWorld({
                scenario = scenario({ killObjective }),
                units = { [7] = { def = 'ms_command_post', team = 2, x = 1010, z = 1000 } },
            })
            g:GameStart()
            assert.are.equal(0, #world.created)
            assert.is_not_nil(echoMatching(world, 'deferred'))
            world.frame = 30
            g:GameFrame(30)
            assert.are.equal(1, #world.created)
            assert.are.equal('kill', world.created[1].type)
            assert.are.equal(7, world.created[1].params.targetUnitID)
        end)

        it("resolves the match NEAREST the marker centre, not iteration order", function()
            -- id 5 sorts first out of the cylinder, but id 9 is closer.
            local world, g = newWorld({
                scenario = scenario({ killObjective }),
                units = {
                    [5] = { def = 'ms_command_post', team = 2, x = 1400, z = 1000 },
                    [9] = { def = 'ms_command_post', team = 2, x = 1050, z = 1000 },
                },
            })
            runToSweep(world, g)
            assert.are.equal(9, world.created[1].params.targetUnitID)
        end)

        it("filters by def AND team — a same-def building on another team is not a target", function()
            local world, g = newWorld({
                scenario = scenario({ killObjective }),
                units = {
                    [5] = { def = 'ms_command_post', team = 0, x = 1010, z = 1000 },
                    [9] = { def = 'ms_command_post', team = 2, x = 1200, z = 1000 },
                },
            })
            runToSweep(world, g)
            assert.are.equal(9, world.created[1].params.targetUnitID)
        end)

        it("SKIPS the objective when nothing matches (never creates a def that fails init)", function()
            local world, g = newWorld({
                scenario = scenario({ killObjective }),
                units = { [5] = { def = 'ms_habitat', team = 2, x = 1010, z = 1000 } },
            })
            runToSweep(world, g)
            assert.are.equal(0, #world.created)
            assert.is_not_nil(echoMatching(world, 'skipped'))
        end)
    end)

    describe("infra — plural `into = 'buildingUnitIDs'`", function()
        local infraObjective = {
            type = 'infra', scope = 'tactical', forTeam = 0, reward = 0,
            params = { buildingUnitIDs = {}, quorum = 1, rewardPerMinute = 5 },
            _populateUnitsFrom = { x = 1000, z = 1000, r = 500,
                                   defs = { 'ms_habitat', 'ms_depot' },
                                   team = 'neutral',
                                   into = 'buildingUnitIDs' },
        }

        it("collects every def match on the resolved team, 'neutral' = Gaia", function()
            local world, g = newWorld({
                scenario = scenario({ infraObjective }),
                units = {
                    [11] = { def = 'ms_habitat', team = GAIA, x = 1000, z = 1100 },
                    [12] = { def = 'ms_depot', team = GAIA, x = 900, z = 1000 },
                    [13] = { def = 'ms_habitat', team = 1, x = 1000, z = 1000 },    -- wrong team
                    [14] = { def = 'ms_command_post', team = GAIA, x = 1000, z = 1000 }, -- wrong def
                    [15] = { def = 'ms_habitat', team = GAIA, x = 9000, z = 9000 }, -- out of area
                },
            })
            runToSweep(world, g)
            assert.are.equal(1, #world.created)
            assert.are.same({ 11, 12 }, world.created[1].params.buildingUnitIDs)
            -- The authored params ride along untouched.
            assert.are.equal(1, world.created[1].params.quorum)
            assert.are.equal(5, world.created[1].params.rewardPerMinute)
        end)

        it("SKIPS on an empty resolution rather than creating an empty-array def", function()
            local world, g = newWorld({
                scenario = scenario({ infraObjective }),
                units = { [13] = { def = 'ms_habitat', team = 1, x = 1000, z = 1000 } },
            })
            runToSweep(world, g)
            assert.are.equal(0, #world.created)
            assert.is_not_nil(echoMatching(world, 'skipped'))
        end)
    end)

    describe("the civilian markers are a special case of the same query", function()
        it("_populateTargetsFrom still resolves registry civilians by role", function()
            -- The regression guard for the refactor: populateCiviliansInArea
            -- is now populateUnitsInArea { civilian = true, role = role } and
            -- must behave exactly as before.
            local world, g = newWorld({
                scenario = scenario({ {
                    type = 'protect', forTeam = 0, params = {},
                    expiresAtFrame = 9000,
                    _populateTargetsFrom = { x = 1000, z = 1000, r = 500, role = 'ambient' },
                } }),
                units = {
                    [21] = { def = 'ms_civilians', team = GAIA, x = 1000, z = 1000 },
                    [22] = { def = 'ms_civilians', team = GAIA, x = 1010, z = 1000 },
                    [23] = { def = 'ms_habitat', team = GAIA, x = 1020, z = 1000 },
                },
                civilians = { [21] = 'ambient', [22] = 'convoy' },
            })
            runToSweep(world, g)
            assert.are.equal(1, #world.created)
            assert.are.same({ 21 }, world.created[1].params.targetUnitIDs)
        end)
    end)

    describe("validation — a malformed marker must fail LOUD at load", function()
        local function expectLoadError(objective, pattern)
            local _, g = newWorld({ scenario = scenario({ objective }) })
            local ok, err = pcall(function() g:GameStart() end)
            assert.is_false(ok)
            assert.is_truthy(tostring(err):find(pattern, 1, true),
                             'expected "' .. pattern .. '" in: ' .. tostring(err))
        end

        local function killWith(marker)
            return { type = 'kill', forTeam = nil, reward = 1,
                     _populateUnitsFrom = marker }
        end

        it("accepts the authorable kill and infra markers", function()
            local _, g = newWorld({ scenario = scenario({
                killWith({ x = 1, z = 1, r = 10, defs = { 'ms_command_post' },
                           team = 2, into = 'targetUnitID' }),
                { type = 'infra', forTeam = 0, reward = 0,
                  params = { buildingUnitIDs = {}, quorum = 1 },
                  _populateUnitsFrom = { x = 1, z = 1, r = 10,
                                         defs = { 'ms_habitat' }, team = 'neutral',
                                         into = 'buildingUnitIDs' } },
            }) })
            assert.has_no.errors(function() g:GameStart() end)
        end)

        it("rejects a non-table marker", function()
            expectLoadError(killWith('everything nearby'), 'must be a table')
        end)

        it("rejects a marker with a missing coordinate", function()
            expectLoadError(killWith({ x = 1, z = 1, into = 'targetUnitID' }),
                'needs numeric "x", "z" and "r"')
        end)

        it("rejects an `into` naming no params field", function()
            expectLoadError(killWith({ x = 1, z = 1, r = 10, into = 'victimIDs' }),
                'unknown "into" field')
        end)

        it("rejects a kill marker resolving into a plural field", function()
            expectLoadError(killWith({ x = 1, z = 1, r = 10, into = 'targetUnitIDs' }),
                'a kill objective needs')
        end)

        it("rejects the singular field on any other type", function()
            expectLoadError({ type = 'infra', forTeam = 0,
                              _populateUnitsFrom = { x = 1, z = 1, r = 10,
                                                     into = 'targetUnitID' } },
                'kill-only')
        end)

        it("rejects an unknown def name in `defs`", function()
            expectLoadError(killWith({ x = 1, z = 1, r = 10,
                                       defs = { 'ms_comand_post' },
                                       into = 'targetUnitID' }),
                'unknown unit def')
        end)

        it("rejects an empty `defs` array", function()
            expectLoadError(killWith({ x = 1, z = 1, r = 10, defs = {},
                                       into = 'targetUnitID' }),
                '"defs" must be a non-empty array')
        end)

        it("rejects a team that is neither a number nor 'neutral'", function()
            expectLoadError(killWith({ x = 1, z = 1, r = 10, team = 'gaia',
                                       into = 'targetUnitID' }),
                '"team" must be a number or "neutral"')
        end)

        it("rejects a malformed civilian marker too (the old silent no-op)", function()
            expectLoadError({ type = 'protect', forTeam = 0, expiresAtFrame = 100,
                              _populateTargetsFrom = { x = 1, z = 1 } },
                'needs numeric "x", "z" and "r"')
        end)

        it("rejects a payload route that is not a string", function()
            expectLoadError({ type = 'escort', forTeam = 0,
                              _populatePayloadFrom = { route = 42 } },
                '"route" must be a string convoy route id')
        end)
    end)
end)
