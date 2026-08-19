-- tests/game_scenario_neutral_spec.lua — the scenario loader's
-- `team = 'neutral'` path (PLAN-metalstorm-scenariogen.md §8, task 4).
--
-- WHY THIS EXISTS. A generated scenario places clusters of existing buildings
-- (towns, outposts, extraction sites) that belong to nobody. "Nobody" is the
-- Gaia team, whose id is `playerTeamCount` — it depends on how many slots the
-- launch seated, and so is NOT knowable when the scenario file is written. A
-- generated file that hard-coded a number would put its neutral towns on
-- whichever player team happened to land on that index. So the file says
-- 'neutral' and the loader resolves it at stage time.
--
-- The failure this guards is silent in both directions: an unresolved
-- 'neutral' is skipped by stageUnits' live-team guard with a warning that reads
-- exactly like the legitimate "the launch seated no NPC slot" case, and every
-- neutral building in the scenario quietly disappears.
--
-- Run from the GAME root (same as game_scenario_ai_spec.lua, and for the same
-- reason — the gadget is loaded by a game-root-relative path):
--   cd data/games/metalstorm && busted LuaRules/Gadgets/tests/game_scenario_neutral_spec.lua

local GADGET = './LuaRules/Gadgets/game_scenario.lua'

local GAIA = 99

local function newWorld(opts)
    opts = opts or {}
    local world = {
        createdUnits = {},      -- { def, team, x, z }
        orders = {},            -- { unitID, cmd }
        neutralFlags = {},      -- unitID -> Spring.SetUnitNeutral flag
        echoes = {},
        gameRulesParams = {},
        teams = opts.teams or { 0, 1, 2, GAIA },
        scenario = opts.scenario,
        gaia = opts.gaia,       -- nil means "this engine exposes no Gaia"
    }
    if world.gaia == nil and opts.noGaia ~= true then world.gaia = GAIA end

    _G.Spring = {
        GetModOptions = function() return { scenario = 'neutral_test' } end,
        GetTeamList = function() return world.teams end,
        GetGaiaTeamID = opts.noGaia and function() return nil end
            or function() return world.gaia end,
        GetTeamInfo = function(teamID)
            -- leader >= 0 only for teams somebody occupies; the engine
            -- materialises unoccupied filler teams with leader == -1.
            return nil, (teamID == 0 or teamID == 1 or teamID == 2) and 1 or -1
        end,
        GetTeamUnits = function(teamID)
            local out = {}
            for i, u in ipairs(world.createdUnits) do
                if u.team == teamID then out[#out + 1] = i end
            end
            return out
        end,
        GetGroundHeight = function() return 0 end,
        GetUnitsInCylinder = function() return {} end,
        GetGameRulesParam = function(key) return world.gameRulesParams[key] end,
        ValidUnitID = function() return true end,
        CreateUnit = function(def, x, y, z, facing, team)
            world.createdUnits[#world.createdUnits + 1] =
                { def = def, team = team, x = x, z = z }
            return #world.createdUnits
        end,
        GiveOrderToUnit = function(unitID, cmd)
            world.orders[#world.orders + 1] = { unitID = unitID, cmd = cmd }
        end,
        SetUnitNeutral = function(unitID, flag)
            world.neutralFlags[unitID] = flag
        end,
        SetTeamRulesParam = function() end,
        SetGameRulesParam = function(key, value) world.gameRulesParams[key] = value end,
        Echo = function(msg) world.echoes[#world.echoes + 1] = tostring(msg) end,
    }

    _G.CMD = { FIGHT = 16, MOVE = 10, GUARD = 25 }
    _G.gadgetHandler = { IsSyncedCode = function() return true end }
    _G.gadget = {}

    _G.UnitDefs = {}
    for i, d in ipairs({
        { name = 'ms_habitat',     speed = 0 },
        { name = 'ms_depot',       speed = 0 },
        { name = 'ms_garrison',    speed = 0 },
        { name = 'ms_civilians',   speed = 42 },
        { name = 'ms_tanks_s2',    speed = 66.3 },
        { name = 'ms_soldiers_s1', speed = 54 },
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
    _G.VFS = { Include = function() return world.scenario end }

    dofile(GADGET)
    return world, _G.gadget
end

--- A scenario with one neutral town and two staged player armies.
local function scenario(over)
    local scn = {
        version = 1, name = 'Neutral staging test',
        world = { regions = {} },
        sides = { { faction = 'compact', team = 0 }, { faction = 'union', team = 1 } },
        units = {
            { def = 'ms_tanks_s2', team = 0, x = 1000, z = 1000, facing = 'south',
              count = 2, spacing = 150,
              orders = { { cmd = 'FIGHT', params = { 4000, 0, 4000 } } } },
            { def = 'ms_tanks_s2', team = 1, x = 7000, z = 7000, facing = 'south',
              count = 2, spacing = 150,
              orders = { { cmd = 'FIGHT', params = { 4000, 0, 4000 } } } },
            -- The neutral town.
            { def = 'ms_habitat',   team = 'neutral', x = 4000, z = 3000, facing = 'south' },
            { def = 'ms_depot',     team = 'neutral', x = 4300, z = 3000, facing = 'south' },
            { def = 'ms_civilians', team = 'neutral', x = 4000, z = 3400, facing = 'south' },
            -- A hostile NPC cluster on an ordinary team.
            { def = 'ms_garrison',  team = 2, x = 5000, z = 5000, facing = 'south' },
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

local function unitsOnTeam(world, team)
    local n = 0
    for _, u in ipairs(world.createdUnits) do
        if u.team == team then n = n + 1 end
    end
    return n
end

local function echoMatching(world, pattern)
    for _, e in ipairs(world.echoes) do
        if e:find(pattern, 1, true) then return e end
    end
    return nil
end

--=============================================================================
describe("game_scenario `team = 'neutral'` (scenariogen §8)", function()

    it("spawns neutral buildings on the Gaia team, not on a player team", function()
        local world, g = newWorld({ scenario = scenario() })
        g:GameStart()

        -- Three neutral entries: habitat, depot, civilians.
        assert.are.equal(3, unitsOnTeam(world, GAIA))
        -- And none of them leaked onto a player team.
        assert.are.equal(2, unitsOnTeam(world, 0))
        assert.are.equal(2, unitsOnTeam(world, 1))
        assert.are.equal(1, unitsOnTeam(world, 2))
    end)

    it("does not skip them as a team the game does not have", function()
        -- The regression: before resolveTeam, liveTeams['neutral'] was nil, so
        -- every neutral building was dropped with a warning indistinguishable
        -- from a genuinely missing NPC slot.
        local world, g = newWorld({ scenario = scenario() })
        g:GameStart()
        assert.is_nil(echoMatching(world, 'spawns units for team neutral'))
    end)

    it("leaves GG.Scenario.data's authored `team` untouched", function()
        -- The war-health checks and game_gameover read the scenario back off
        -- GG.Scenario.data; rewriting the authored table in place would make it
        -- disagree with the file on disk.
        local world, g = newWorld({ scenario = scenario() })
        g:GameStart()
        local staged = GG.Scenario.data
        assert.are.equal('neutral', staged.units[3].team)
        assert.are.equal('neutral', staged.units[4].team)
    end)

    it("warns and skips, rather than erroring, when there is no Gaia team", function()
        local world, g = newWorld({ scenario = scenario(), noGaia = true })
        g:GameStart()
        assert.are.equal(0, unitsOnTeam(world, GAIA))
        assert.is_not_nil(echoMatching(world, 'exposes no Gaia team'))
        -- The players' armies still staged: one unusable entry must not take
        -- the rest of the scenario down with it.
        assert.are.equal(2, unitsOnTeam(world, 0))
        assert.are.equal(2, unitsOnTeam(world, 1))
    end)

    it("rejects any OTHER string team at validation, not at spawn time", function()
        -- A typo'd 'nuetral' would otherwise be reported as "team nuetral which
        -- this game does not have" and silently skipped — which is exactly the
        -- message a legitimately absent NPC slot produces, so the mistake would
        -- read as normal.
        local scn = scenario()
        scn.units[3].team = 'nuetral'
        local _world, g = newWorld({ scenario = scn })
        assert.has_error(function() g:GameStart() end)
    end)

    it("does not let a neutral town count as a side with no opening orders", function()
        -- §7.5's war_units_unordered check buckets staged mobile units by
        -- `team`. ms_civilians is mobile and has no orders, so if 'neutral'
        -- were ever treated as a live team the check would report the war as
        -- broken on account of a town's residents.
        local world, g = newWorld({ scenario = scenario() })
        g:GameStart()
        g:GameFrame(60)
        assert.are.equal(0, world.gameRulesParams['war_units_unordered'])
        assert.are.equal(0, world.gameRulesParams['war_teams_unstaged'])
    end)

    it("marks Gaia set dressing NEUTRAL so a FIGHT column will not divert into it", function()
        -- endtoend D53. Gaia is its own ally team with no allies, which is this
        -- engine's definition of HOSTILE, so before this every neutral town was
        -- a legitimate auto-target: measured on `crossing_standoff`, the union
        -- army spent frames 2307-4104 levelling a settlement 202 elmos off its
        -- own approach and reached the prize 2976 frames after the other side.
        -- CWeapon::AutoTarget skips a neutral below FIRESTATE_FIREATNEUTRAL and
        -- MobileCAI will not chase one, so this is the whole fix.
        local world, g = newWorld({ scenario = scenario() })
        g:GameStart()
        local gaiaSeen = 0
        for unitID, u in ipairs(world.createdUnits) do
            if u.team == GAIA then
                gaiaSeen = gaiaSeen + 1
                assert.is_true(world.neutralFlags[unitID] == true)
            else
                -- A player's army must stay shootable.
                assert.is_nil(world.neutralFlags[unitID])
            end
        end
        assert.are.equal(3, gaiaSeen)
    end)

    it("marks the `civilians` block's ambient population neutral too", function()
        -- The ambient entries route through GG.Civilians.Spawn, not stageUnits,
        -- and they are the set dressing standing NEXT to the buildings — two of
        -- the five things the union army destroyed in the D53 measurement.
        local scn = scenario()
        scn.civilians = { units = {
            { def = 'ms_civilians', x = 4100, z = 3300, facing = 'south', role = 'ambient' },
        } }
        local world, g = newWorld({ scenario = scn })
        g:GameStart()
        -- The stubbed GG.Civilians.Spawn hands back unitID 5000.
        assert.is_true(world.neutralFlags[5000] == true)
    end)

    it("staged neutral buildings receive no orders", function()
        -- They are immobile. The `civilians` block is deliberately not used for
        -- them precisely because it would enroll them in a per-tick CMD_MOVE
        -- loop they can never satisfy.
        local world, g = newWorld({ scenario = scenario() })
        g:GameStart()
        for _, o in ipairs(world.orders) do
            local u = world.createdUnits[o.unitID]
            assert.are_not.equal(GAIA, u.team)
        end
    end)
end)
