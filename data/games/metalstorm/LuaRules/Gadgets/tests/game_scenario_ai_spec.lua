-- tests/game_scenario_ai_spec.lua — the scenario loader's `ai` section
-- (PLAN-metalstorm-ai.md §5 NPC column, §10 task 4a). Drives the REAL
-- game_scenario.lua gadget through GameStart/GameFrame against a mocked
-- Spring/GG, including one case that stages the SHIPPED
-- scenarios/meridian_basin.lua so the Basin Reavers block is verified as
-- authored, not as a hand-copied fixture.
--
-- Run from the GAME root (like meridian_basin_scenario_spec.lua, and for the
-- same reason — it reads scenarios/ by a game-root-relative path):
--   cd data/games/metalstorm && busted LuaRules/Gadgets/tests/game_scenario_ai_spec.lua
-- From LuaRules/Gadgets/ it reports "cannot open ./LuaRules/Gadgets/
-- game_scenario.lua", which is a wrong cwd, not a real failure.

local GADGET = './LuaRules/Gadgets/game_scenario.lua'

--- Fresh mock world + a fresh game_scenario.lua instance bound to it.
local function newWorld(opts)
    opts = opts or {}
    local world = {
        teamRulesParams = {},   -- teamID -> key -> value
        gameRulesParams = {},
        createdUnits = {},      -- { def, team }
        awards = {},            -- { player, amount, reason }
        echoes = {},
        teams = opts.teams or { 0, 4, 8 },
        aiPlayers = opts.aiPlayers or { [8] = { 3 } },   -- teamID -> playerIDs
        regionKeys = opts.regionKeys,                    -- nil = no graph loaded
        scenario = opts.scenario,                        -- a table, or nil to use `name`
        name = opts.name or 'test_scenario',
    }

    function world.trp(teamID, key)
        local t = world.teamRulesParams[teamID]
        return t and t[key]
    end

    _G.Spring = {
        GetModOptions = function() return { scenario = world.name } end,
        GetTeamList = function() return world.teams end,
        GetGaiaTeamID = function() return 99 end,
        -- The war-health checks that run from GameFrame filter on GetTeamInfo's
        -- leader (>= 0 means somebody occupies the team; the engine materialises
        -- unoccupied filler teams with -1). Without this the stipend test below
        -- errored out of GameFrame before reaching its assertion, so it was
        -- reporting a mock gap rather than the behaviour it names.
        GetTeamInfo = function(teamID)
            for _, t in ipairs(world.teams) do
                if t == teamID then return nil, 1 end
            end
            return nil, -1
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
        GetUnitDefID = function() return 1 end,
        ValidUnitID = function() return true end,
        CreateUnit = function(def, x, y, z, facing, team)
            world.createdUnits[#world.createdUnits + 1] = { def = def, team = team }
            return #world.createdUnits
        end,
        GiveOrderToUnit = function() end,
        -- Errors on an unknown team, exactly as the engine does
        -- ("SetTeamRulesParam(): Bad teamID: 8"). A permissive mock here hid
        -- PLAN-endtoend.md D10's second half for two lanes: staging a slate
        -- for a team the launch didn't supply aborted gadget:GameStart part
        -- way through, leaving GG.Scenario.name/.data unset — and only ever
        -- on the player path, since every direct manifest declared all 8
        -- Meridian teams. Keep this strict.
        SetTeamRulesParam = function(teamID, key, value)
            local live = false
            for _, t in ipairs(world.teams) do if t == teamID then live = true end end
            if not live then
                error('SetTeamRulesParam(): Bad teamID: ' .. tostring(teamID))
            end
            world.teamRulesParams[teamID] = world.teamRulesParams[teamID] or {}
            world.teamRulesParams[teamID][key] = value
        end,
        SetGameRulesParam = function(key, value) world.gameRulesParams[key] = value end,
        GetGameRulesParam = function(key) return world.gameRulesParams[key] end,
        Echo = function(msg) world.echoes[#world.echoes + 1] = tostring(msg) end,
    }

    _G.CMD = { FIGHT = 16, MOVE = 10, GUARD = 25 }
    _G.gadgetHandler = { IsSyncedCode = function() return true end }
    _G.gadget = {}

    -- Every def any scenario under test names must be "known" or validation
    -- rejects it; the real shipped scenario names several.
    _G.UnitDefs = {}
    for i, name in ipairs({ 'ms_tanks_s1', 'ms_tanks_s2', 'ms_soldiers_s1',
                            'ms_engineers_s1', 'ms_radar_s1', 'ms_civilians' }) do
        _G.UnitDefs[i] = { name = name, customParams = { is_civilian = 'true' } }
    end

    _G.GG = {
        Regions = {
            KeyAt = function() return '0:0' end,
            SetControllingTeam = function() end,
            Keys = world.regionKeys and function() return world.regionKeys end or nil,
        },
        Objectives = { Create = function() return 1 end },
        Civilians = { Spawn = function() return 5000 end, Register = function() end,
                      GetRole = function() return 'ambient' end },
        Teams = {
            AIPlayers = function(teamID) return world.aiPlayers[teamID] or {} end,
        },
        Authority = {
            Award = function(target, amount, reason)
                world.awards[#world.awards + 1] =
                    { player = target.player, amount = amount, reason = reason }
            end,
        },
        Scenario = {},
    }

    _G.VFS = {
        Include = function(path)
            if world.scenario then return world.scenario end
            return dofile('scenarios/' .. world.name .. '.lua')
        end,
    }

    dofile(GADGET)
    return world, _G.gadget
end

local function baseScenario(over)
    local scn = {
        version = 1, name = 'AI staging test',
        world = { regions = {} }, units = {}, objectives = {},
        ai = {
            {
                team = 8, profile = 'npc_raider',
                slate = { kinds = { 'garrison', 'raid', 'toll' },
                          home = 'east_pass',
                          targets = { 'north_market', 'south_market' },
                          route = { 'still_mere' }, reach = 2 },
                stipend = { amount = 35, periodSec = 60 },
            },
        },
    }
    for k, v in pairs(over or {}) do scn[k] = v end
    return scn
end

--=============================================================================
describe("game_scenario `ai` staging (§5)", function()
    it("publishes the profile + slate as team rulesParams the AI VM reads", function()
        local world, g = newWorld({ scenario = baseScenario() })
        g:GameStart()

        -- Keys are the contract with ai/strategos/picture.lua readProfileHint /
        -- readScript — comma lists, exactly as splitList() expects.
        assert.are.equal('npc_raider', world.trp(8, 'ai_profile'))
        assert.are.equal('garrison,raid,toll', world.trp(8, 'ai_slate_kinds'))
        assert.are.equal('east_pass', world.trp(8, 'ai_slate_home'))
        assert.are.equal('north_market,south_market', world.trp(8, 'ai_slate_targets'))
        assert.are.equal('still_mere', world.trp(8, 'ai_slate_route'))
        assert.are.equal(2, world.trp(8, 'ai_slate_reach'))
    end)

    it("leaves optional slate fields unpublished rather than defaulting them", function()
        local scn = baseScenario({ ai = { { team = 8, profile = 'npc_raider',
            slate = { kinds = { 'garrison' }, home = 'east_pass' } } } })
        local world, g = newWorld({ scenario = scn })
        g:GameStart()
        assert.is_nil(world.trp(8, 'ai_slate_targets'))
        assert.is_nil(world.trp(8, 'ai_slate_route'))
        assert.is_nil(world.trp(8, 'ai_slate_reach'))
    end)

    it("warns when the scenario declares an AI the launch supplied no slot for", function()
        local world, g = newWorld({ scenario = baseScenario(), aiPlayers = {} })
        g:GameStart()
        local warned = false
        for _, e in ipairs(world.echoes) do
            if e:match('no AI player is on that team') then warned = true end
        end
        assert.is_true(warned)
    end)
end)

--=============================================================================
describe("scripted stipends (§5 NPC column)", function()
    it("pays the AI's OWN pool on the declared period, not the team pool", function()
        local world, g = newWorld({ scenario = baseScenario() })
        g:GameStart()

        g:GameFrame(1799)
        assert.are.equal(0, #world.awards)      -- 60 s = 1800 frames

        g:GameFrame(1800)
        assert.are.equal(1, #world.awards)
        -- { player = ... }, never { team = ... }: an NPC's role sets
        -- teamAuthorityFallback=false, so money in the team pool is invisible
        -- to its budget governor.
        assert.are.equal(3, world.awards[1].player)
        assert.are.equal(35, world.awards[1].amount)
        assert.are.equal('stipend', world.awards[1].reason)   -- an existing ledger REASON_CLASS entry

        g:GameFrame(3599)
        assert.are.equal(1, #world.awards)
        g:GameFrame(3600)
        assert.are.equal(2, #world.awards)
    end)

    it("pays nothing when the declared AI team has no AI player", function()
        local world, g = newWorld({ scenario = baseScenario(), aiPlayers = {} })
        g:GameStart()
        g:GameFrame(1800)
        assert.are.equal(0, #world.awards)
    end)

    it("costs nothing for a scenario that declares no stipends", function()
        local scn = baseScenario({ ai = { { team = 8, profile = 'npc_raider' } } })
        local world, g = newWorld({ scenario = scn })
        g:GameStart()
        g:GameFrame(1800)
        assert.are.equal(0, #world.awards)
    end)
end)

--=============================================================================
describe("`ai` validation — an authoring typo must fail LOUD at load", function()
    local function expectLoadError(scn, pattern, worldOpts)
        local opts = worldOpts or {}
        opts.scenario = scn
        local _, g = newWorld(opts)
        local ok, err = pcall(function() g:GameStart() end)
        assert.is_false(ok)
        assert.is_truthy(tostring(err):match(pattern))
    end

    it("rejects an unknown slate kind", function()
        expectLoadError(baseScenario({ ai = { { team = 8,
            slate = { kinds = { 'garrison', 'conquer' } } } } }),
            'unknown slate kind')
    end)

    it("rejects an AI entry with no team", function()
        expectLoadError(baseScenario({ ai = { { profile = 'npc_raider' } } }),
            'needs a numeric "team"')
    end)

    it("rejects a stipend with no amount", function()
        expectLoadError(baseScenario({ ai = { { team = 8, stipend = {} } } }),
            'stipend')
    end)

    it("rejects slate region keys the live graph does not have", function()
        expectLoadError(baseScenario({ ai = { { team = 8,
            slate = { kinds = { 'garrison' }, home = 'atlantis' } } } }),
            'unknown region "atlantis"',
            { regionKeys = { 'east_pass', 'still_mere' } })
    end)

    it("skips the region check when no graph provider is loaded", function()
        -- regionKeys nil -> GG.Regions.Keys absent. A grid-addressed map has no
        -- key list to check against; silently accepting is correct there, and
        -- the AI's own scripted.lua skips unresolvable keys at runtime.
        local _, g = newWorld({ scenario = baseScenario({ ai = { { team = 8,
            slate = { kinds = { 'garrison' }, home = 'anything' } } } }) })
        assert.has_no.errors(function() g:GameStart() end)
    end)
end)

--=============================================================================
describe("units for a team the launch did not supply", function()
    it("are skipped with a warning instead of erroring the whole load", function()
        local scn = baseScenario({ units = {
            { def = 'ms_soldiers_s1', team = 0, x = 100, z = 100, count = 1 },
            { def = 'ms_soldiers_s1', team = 8, x = 200, z = 200, count = 2 },
        } })
        local world, g = newWorld({ scenario = scn, teams = { 0, 4 } })   -- no team 8
        g:GameStart()

        assert.are.equal(1, #world.createdUnits)
        assert.are.equal(0, world.createdUnits[1].team)
        local warned = false
        for _, e in ipairs(world.echoes) do
            if e:match('which this game does not have') then warned = true end
        end
        assert.is_true(warned)
    end)
end)

--=============================================================================
describe("the SHIPPED meridian_basin Basin Reavers", function()
    it("validates and stages end-to-end against the real region graph", function()
        local world, g = newWorld({
            name = 'meridian_basin',
            teams = { 0, 1, 2, 3, 4, 5, 6, 7, 8 },
            aiPlayers = { [8] = { 9 } },
            regionKeys = {
                'heron_ait', 'cinder_forge', 'northgate', 'northwatch', 'ash_habitat',
                'granary_vale', 'north_market', 'west_scarp_n', 'hollow_overlook_n',
                'east_bluffs_n', 'west_narrows', 'west_pass', 'meridian_basin',
                'east_pass', 'still_mere', 'west_scarp_s', 'gulch_overlook_s',
                'east_bluffs_s', 'shale_habitat', 'sorghum_vale', 'south_market',
                'southgate', 'southwatch', 'slag_forge',
            },
        })
        assert.has_no.errors(function() g:GameStart() end)

        assert.are.equal('npc_raider', world.trp(8, 'ai_profile'))
        assert.are.equal('garrison,raid,toll', world.trp(8, 'ai_slate_kinds'))
        assert.are.equal('east_pass', world.trp(8, 'ai_slate_home'))
        assert.are.equal('north_market,south_market', world.trp(8, 'ai_slate_targets'))

        -- The Reaver band actually spawned on team 8.
        local reavers = 0
        for _, u in ipairs(world.createdUnits) do
            if u.team == 8 then reavers = reavers + 1 end
        end
        assert.are.equal(9, reavers)   -- 6 soldiers + 3 tanks

        -- And the stipend runs.
        g:GameFrame(1800)
        assert.are.equal(1, #world.awards)
        assert.are.equal(9, world.awards[1].player)
    end)

    it("drops the Reavers cleanly when the launch has no team 8", function()
        local world, g = newWorld({
            name = 'meridian_basin',
            teams = { 0, 1, 2, 3, 4, 5, 6, 7 },
            aiPlayers = {},
        })
        assert.has_no.errors(function() g:GameStart() end)
        for _, u in ipairs(world.createdUnits) do
            assert.are_not.equal(8, u.team)
        end
    end)
end)

-- PLAN-endtoend.md D10 — a room created through the Create Game dialog has
-- only the slots the host filled (two, typically), while Meridian Basin
-- declares eight teams plus the team-8 Reaver NPC. stageAI must survive that
-- shape, because everything after it in gadget:GameStart is load-bearing:
-- GG.Scenario.data.sides is where game_gameover derives the winning
-- allyteams from, so an abort here makes the war unwinnable even when the
-- victory objective staged correctly.
describe("a launch with fewer teams than the scenario declares", function()
    local function echoesMatching(world, needle)
        local n = 0
        for _, m in ipairs(world.echoes) do
            if m:find(needle, 1, true) then n = n + 1 end
        end
        return n
    end

    it("stages the shipped Meridian war in a two-team lobby room", function()
        local world, g = newWorld({
            name = 'meridian_basin',
            teams = { 0, 1 },     -- host + one AI, what the dialog produces
            aiPlayers = { [1] = { 2 } },
        })
        assert.has_no.errors(function() g:GameStart() end)

        -- Reached the end of GameStart: these are set on the last lines, so
        -- they are the proof that nothing aborted partway.
        assert.are.equal('meridian_basin', GG.Scenario.name)
        assert.is_table(GG.Scenario.data)
        assert.is_table(GG.Scenario.data.sides)
        assert.are.equal('meridian_basin', world.gameRulesParams['scenario_name'])
    end)

    it("skips the missing team's slate with a warning, not an error", function()
        local world, g = newWorld({
            name = 'meridian_basin',
            teams = { 0, 1 },
            aiPlayers = { [1] = { 2 } },
        })
        g:GameStart()
        assert.are.equal(1, echoesMatching(world, 'AI slate for team 8'))
        assert.is_nil(world.trp(8, 'ai_profile'))
    end)

    it("still stages a slate for a team the launch DOES have", function()
        local world, g = newWorld({
            scenario = baseScenario({ ai = {
                { team = 0, profile = 'default', slate = { kinds = { 'garrison' }, home = 'a' } },
                { team = 8, profile = 'npc_raider', slate = { kinds = { 'raid' }, home = 'b' } },
            } }),
            teams = { 0, 1 },
            aiPlayers = { [0] = { 1 } },
        })
        assert.has_no.errors(function() g:GameStart() end)
        assert.are.equal('default', world.trp(0, 'ai_profile'))
        assert.is_nil(world.trp(8, 'ai_profile'))
    end)

    it("pays no stipend to a team that was skipped", function()
        local world, g = newWorld({
            scenario = baseScenario(),   -- team 8 only
            teams = { 0, 1 },
            aiPlayers = {},
        })
        g:GameStart()
        g:GameFrame(1800)
        assert.are.equal(0, #world.awards)
    end)
end)

-- PLAN-endtoend.md D10 — objectives scoped to a team the launch didn't supply.
-- Not a cosmetic skip: when such an objective resolves or expires,
-- game_objectives pays its reward through GG.Authority, which calls
-- Spring.GetTeamRulesParam on that team and throws "Bad teamID". The error
-- leaves the Objectives gadget's callin, gadgetHandler removes the gadget,
-- and every objective — the victory objective included — stops being
-- evaluated for the rest of the match.
describe("objectives scoped to a team the launch does not have", function()
    local function scenarioWithObjectives()
        return {
            version = 1, name = 'objective scoping test',
            world = { regions = {} }, units = {}, ai = {},
            objectives = {
                { type = 'control', scope = 'strategic', forTeam = nil,
                  region = 'meridian_basin', victory = true },
                { type = 'control', scope = 'tactical', forTeam = 0, region = 'west_pass' },
                { type = 'control', scope = 'tactical', forTeam = 4, region = 'east_pass' },
            },
        }
    end

    local function created(world, g)
        local made = {}
        GG.Objectives.Create = function(def)
            made[#made + 1] = def
            return #made
        end
        g:GameStart()
        return made
    end

    it("keeps the open-race victory objective and the live team's", function()
        local world, g = newWorld({ scenario = scenarioWithObjectives(), teams = { 0, 1 } })
        local made = created(world, g)
        assert.are.equal(2, #made)
        assert.is_true(made[1].victory)
        assert.is_nil(made[1].forTeam)
        assert.are.equal(0, made[2].forTeam)
    end)

    it("skips the missing team's objective with a warning", function()
        local world, g = newWorld({ scenario = scenarioWithObjectives(), teams = { 0, 1 } })
        created(world, g)
        local warned = 0
        for _, e in ipairs(world.echoes) do
            if e:find('scopes objectives to team 4', 1, true) then warned = warned + 1 end
        end
        assert.are.equal(1, warned)
    end)

    it("stages every objective when the launch has all the teams", function()
        local world, g = newWorld({ scenario = scenarioWithObjectives(), teams = { 0, 1, 4 } })
        local made = created(world, g)
        assert.are.equal(3, #made)
    end)
end)
