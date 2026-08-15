-- tests/game_scenario_briefing_spec.lua — the sim ignores `briefing`.
--
-- WHY THIS EXISTS (PLAN-test-automation S2). A scenario file now carries its
-- own narrative: a top-level `briefing` table with the story, the field advice
-- and a banner, parsed by the LOBBY (ScenarioDiscovery::ReadBriefing) for the
-- loading splash. The sim must never see it — one file, two readers, and only
-- one of them has any business with prose.
--
-- The contract is asserted rather than assumed because it rests on an absence:
-- game_scenario.lua's validate() walks only the sections it knows and has no
-- unknown-top-level-key sweep, so `briefing` is inert *by omission*. If someone
-- later adds a strict-key pass — an entirely reasonable thing to want — every
-- shipped scenario would start failing validation at GameStart with an error
-- about a key that is not the sim's business. This spec is the tripwire.
--
-- Run from the GAME root (like its siblings — the gadget is loaded by a
-- game-root-relative path):
--   cd data/games/metalstorm && busted LuaRules/Gadgets/tests/game_scenario_briefing_spec.lua
-- From LuaRules/Gadgets/ it reports "cannot open ./LuaRules/Gadgets/
-- game_scenario.lua", which is a wrong cwd, not a real failure.

local GADGET = './LuaRules/Gadgets/game_scenario.lua'

local GAIA = 99

--- Fresh mock world + a fresh game_scenario.lua bound to it. Trimmed from
--- game_scenario_neutral_spec.lua's harness to what GameStart touches here.
local function newWorld(scn)
    local world = {
        createdUnits = {},
        gameRulesParams = {},
        echoes = {},
        scenario = scn,
    }

    _G.Spring = {
        GetModOptions = function() return { scenario = 'briefing_test' } end,
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
            world.createdUnits[#world.createdUnits + 1] =
                { def = def, team = team, x = x, z = z }
            return #world.createdUnits
        end,
        GiveOrderToUnit = function() end,
        SetUnitNeutral = function() end,
        SetTeamRulesParam = function() end,
        SetGameRulesParam = function(key, value) world.gameRulesParams[key] = value end,
        Echo = function(msg) world.echoes[#world.echoes + 1] = tostring(msg) end,
    }

    _G.CMD = { FIGHT = 16, MOVE = 10, GUARD = 25 }
    _G.gadgetHandler = { IsSyncedCode = function() return true end }
    _G.gadget = {}

    _G.UnitDefs = {}
    for i, d in ipairs({
        { name = 'ms_tanks_s2', speed = 66.3 },
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

--- A minimal war, optionally carrying a briefing.
local function scenario(briefing)
    return {
        -- Deliberately does NOT contain the word this spec greps for: the
        -- staging echo quotes the scenario name back, and a name like
        -- "Briefing test" would match the very needle below.
        version = 1, name = 'Minimal war',
        world = { regions = {} },
        sides = { { faction = 'compact', team = 0 }, { faction = 'union', team = 1 } },
        units = {
            { def = 'ms_tanks_s2', team = 0, x = 1000, z = 1000, facing = 'south' },
            { def = 'ms_tanks_s2', team = 1, x = 7000, z = 7000, facing = 'south' },
        },
        objectives = {
            { type = 'control', scope = 'strategic', region = 'mid',
              reward = 300, victory = true, notBefore = 0, holdFrames = 5400 },
        },
        briefing = briefing,
    }
end

local FULL_BRIEFING = {
    title      = 'The Standoff',
    subtitle   = 'Scorched Crossing',
    story      = 'Two armies. One crossing.\n\nYou will meet in the middle.',
    tips       = { 'Hold the middle.', 'Artillery outranges tanks.' },
    image      = 'scenarios/img/war.jpg',
    parTimeSec = 900,
}

local function echoMatching(world, needle)
    for _, e in ipairs(world.echoes) do
        if e:find(needle, 1, true) then return e end
    end
    return nil
end

--=============================================================================
describe("game_scenario and the display-only `briefing` block (S2)", function()

    it("stages a war carrying a full briefing without a validation error", function()
        -- validate() collects errors and GameStart error()s on any of them, so
        -- has_no.errors is exactly "briefing produced no validation complaint".
        local world, g = newWorld(scenario(FULL_BRIEFING))
        assert.has_no.errors(function() g:GameStart() end)
        assert.are.equal(2, #world.createdUnits)
    end)

    it("says nothing about it — no warning, no echo naming the key", function()
        -- The `orders` precedent (game_scenario.lua:1115) warns about a
        -- top-level key it will not honour. Briefing must not be that: it is
        -- honoured, just not here, and a per-load warning about correctly
        -- authored content is noise every shipped war would emit.
        local world, g = newWorld(scenario(FULL_BRIEFING))
        g:GameStart()
        assert.is_nil(echoMatching(world, 'briefing'))
        assert.is_nil(echoMatching(world, 'Briefing'))
    end)

    it("stages identically with and without one", function()
        -- The strongest form of "the sim ignores it": same units, same rules
        -- params, briefing or no briefing.
        local plain, gp = newWorld(scenario(nil))
        gp:GameStart()
        local briefed, gb = newWorld(scenario(FULL_BRIEFING))
        gb:GameStart()

        assert.are.equal(#plain.createdUnits, #briefed.createdUnits)
        for i, u in ipairs(plain.createdUnits) do
            assert.are.equal(u.def, briefed.createdUnits[i].def)
            assert.are.equal(u.team, briefed.createdUnits[i].team)
        end
        for k, v in pairs(plain.gameRulesParams) do
            assert.are.equal(v, briefed.gameRulesParams[k])
        end
    end)

    it("does not publish the briefing into gameRulesParams", function()
        -- A briefing that leaked into the rules-param mirror would ship the
        -- whole story to every client on every snapshot, forever.
        local world, g = newWorld(scenario(FULL_BRIEFING))
        g:GameStart()
        for k, v in pairs(world.gameRulesParams) do
            assert.is_nil(tostring(k):find('briefing'))
            if type(v) == 'string' then
                assert.is_nil(v:find('You will meet in the middle', 1, true))
            end
        end
    end)

    it("tolerates a malformed briefing — the sim never reads it", function()
        -- BAR's format puts a string at this key. The lobby ignores that
        -- shape; the sim must not even notice it.
        local _, g = newWorld(scenario('a wall of text'))
        assert.has_no.errors(function() g:GameStart() end)
    end)
end)
