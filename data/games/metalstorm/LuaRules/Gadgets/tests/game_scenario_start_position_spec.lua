-- tests/game_scenario_start_position_spec.lua — stageUnits sets each staged
-- team's start position to the centroid of what it actually spawned (D10,
-- beta E2E1).
--
-- WHY THIS EXISTS. The engine only ever sets a team's start position from the
-- MAP's own default slot layout (GameStartCoordinator.cpp BuildTeamStartInfoMsg
-- reads team->GetStartPos()), and the client's opening-camera framing
-- (game-processor.ts gpTryFrameStartCamera) frames the very first frame on
-- exactly that value. No metalstorm scenario calls Spring.SetTeamStartPosition
-- itself — a scenario's `units` table is a pure data literal (see
-- scenarios/tutorial_01.lua's own header) and cannot compute anything — so
-- without this, a scenario that spawns its column away from the map's start
-- corner (every custom-spawn scenario) opens the camera on empty map instead
-- of on the player's own units. Measured live on tutorial_01: the opening
-- frame was ~60% off-map grey void (docs/reviews/beta/e2e/14-solo-coach-step1.png).
--
-- Run from the GAME root (same as game_scenario_neutral_spec.lua, and for the
-- same reason — the gadget is loaded by a game-root-relative path):
--   cd data/games/metalstorm && busted LuaRules/Gadgets/tests/game_scenario_start_position_spec.lua

local GADGET = './LuaRules/Gadgets/game_scenario.lua'

local GAIA = 99

local function newWorld(opts)
    opts = opts or {}
    local world = {
        createdUnits = {},        -- { def, team, x, z }
        startPositions = {},      -- teamID -> { x, y, z }
        echoes = {},
        gameRulesParams = {},
        teams = opts.teams or { 0, 1, GAIA },
        scenario = opts.scenario,
    }

    _G.Spring = {
        GetModOptions = function() return { scenario = 'start_position_test' } end,
        GetTeamList = function() return world.teams end,
        GetGaiaTeamID = function() return GAIA end,
        GetTeamInfo = function(teamID)
            return nil, (teamID == 0 or teamID == 1) and 1 or -1
        end,
        GetTeamUnits = function() return {} end,
        GetGroundHeight = function(x, z) return 0 end,
        GetUnitsInCylinder = function() return {} end,
        ValidUnitID = function() return true end,
        CreateUnit = function(def, x, y, z, facing, team)
            world.createdUnits[#world.createdUnits + 1] =
                { def = def, team = team, x = x, z = z }
            return #world.createdUnits
        end,
        GiveOrderToUnit = function() end,
        SetUnitNeutral = function() end,
        SetTeamRulesParam = function() end,
        SetGameRulesParam = function(key, value) world.gameRulesParams[key] = value end,
        GetGameRulesParam = function(key) return world.gameRulesParams[key] end,
        SetTeamStartPosition = function(teamID, x, y, z)
            world.startPositions[teamID] = { x = x, y = y, z = z }
        end,
        Echo = function(msg) world.echoes[#world.echoes + 1] = tostring(msg) end,
    }

    _G.CMD = { FIGHT = 16, MOVE = 10, GUARD = 25 }
    _G.gadgetHandler = { IsSyncedCode = function() return true end }
    _G.gadget = {}

    _G.UnitDefs = {}
    for i, d in ipairs({
        { name = 'ms_habitat',     speed = 0 },
        { name = 'ms_engineers_s1', speed = 48 },
        { name = 'ms_soldiers_s1', speed = 54 },
        { name = 'ms_tanks_s2',    speed = 66.3 },
    }) do
        _G.UnitDefs[i] = { name = d.name, speed = d.speed, customParams = {} }
    end

    _G.GG = {
        Regions = { KeyAt = function() return '0:0' end,
                    SetControllingTeam = function() end },
        Objectives = { Create = function() return 1 end },
        Civilians = { Spawn = function() return 5000 end, Register = function() end },
        Teams = { AIPlayers = function() return {} end },
        Authority = { Award = function() end },
        Scenario = {},
    }
    _G.VFS = { Include = function() return world.scenario end, FileExists = function() return true end }

    dofile(GADGET)
    return world, _G.gadget
end

local function scenario(units, over)
    local scn = {
        version = 1, name = 'Start position test',
        world = { regions = {} },
        sides = { { faction = 'compact', team = 0 }, { faction = 'union', team = 1 } },
        units = units,
        objectives = {
            { type = 'control', scope = 'strategic', forTeam = nil,
              region = 'mid', reward = 300, victory = true,
              notBefore = 0, holdFrames = 5400 },
        },
    }
    for k, v in pairs(over or {}) do scn[k] = v end
    return scn
end

--=============================================================================
describe("game_scenario stageUnits' start-position centroid (D10, beta E2E1)", function()

    it("sets a team's start position to the centroid of the units it actually staged", function()
        -- Three single-unit entries (count defaults to 1, so gridOffsets adds
        -- no spread) at (0,0), (300,0) and (150,300) — centroid (150,100).
        local world, g = newWorld({ scenario = scenario({
            { def = 'ms_soldiers_s1', team = 0, x = 0,   z = 0,   facing = 'north' },
            { def = 'ms_soldiers_s1', team = 0, x = 300, z = 0,   facing = 'north' },
            { def = 'ms_soldiers_s1', team = 0, x = 150, z = 300, facing = 'north' },
        }) })
        g:GameStart()
        assert.are.same({ x = 150, y = 0, z = 100 }, world.startPositions[0])
    end)

    it("counts EVERY unit, not just mobile ones — an engineer-only/turret-only team still gets a start", function()
        -- game_scenario's own §7.5 mobility filter (stagedForceByTeam) is right
        -- for contestability checks but wrong here: a team whose whole roster is
        -- immobile still needs a camera to open on it.
        local world, g = newWorld({ scenario = scenario({
            { def = 'ms_habitat', team = 0, x = 1000, z = 2000, facing = 'north' },
        }) })
        g:GameStart()
        assert.are.same({ x = 1000, y = 0, z = 2000 }, world.startPositions[0])
    end)

    it("keeps each team's centroid independent", function()
        local world, g = newWorld({ scenario = scenario({
            { def = 'ms_soldiers_s1', team = 0, x = 0,    z = 0,    facing = 'north' },
            { def = 'ms_soldiers_s1', team = 0, x = 200,  z = 0,    facing = 'north' },
            { def = 'ms_tanks_s2',    team = 1, x = 9000, z = 9000, facing = 'south' },
        }) })
        g:GameStart()
        assert.are.same({ x = 100, y = 0, z = 0 }, world.startPositions[0])
        assert.are.same({ x = 9000, y = 0, z = 9000 }, world.startPositions[1])
    end)

    it("excludes a unit the engine refused to create from the centroid", function()
        -- CreateUnit returning nil for occupied ground must not shift the
        -- centroid toward a unit that never actually landed.
        local calls = 0
        local world, g = newWorld({ scenario = scenario({
            { def = 'ms_soldiers_s1', team = 0, x = 0,   z = 0, facing = 'north' },
            { def = 'ms_soldiers_s1', team = 0, x = 400, z = 0, facing = 'north' },
        }) })
        local realCreateUnit = _G.Spring.CreateUnit
        _G.Spring.CreateUnit = function(def, x, y, z, facing, team)
            calls = calls + 1
            if calls == 2 then return nil end
            return realCreateUnit(def, x, y, z, facing, team)
        end
        g:GameStart()
        assert.are.same({ x = 0, y = 0, z = 0 }, world.startPositions[0])
    end)

    it("does not set a start position for a team that staged nothing", function()
        local world, g = newWorld({ scenario = scenario({
            { def = 'ms_soldiers_s1', team = 0, x = 0, z = 0, facing = 'north' },
        }) })
        g:GameStart()
        assert.is_nil(world.startPositions[1])
    end)
end)
