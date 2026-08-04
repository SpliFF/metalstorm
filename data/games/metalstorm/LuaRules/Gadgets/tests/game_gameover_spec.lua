-- tests/game_gameover_spec.lua — the war's terminal condition
-- (PLAN-metalstorm-wars.md §7.1; closes PLAN-endtoend.md D1).
--
-- Drives the REAL game_gameover.lua against a fake GG.Objectives — the thing
-- under test is the gadget's own wiring (victory-flag gating, side→allyteam
-- derivation, the winding_down grace, escrow sweep ordering, idempotency), not
-- the objectives registry, which has its own specs under objectives/tests/.
-- Same deliberate exception as authority_charge_mock.lua: narrowly built for
-- this file, not a shared framework.
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets && busted tests/

package.path = './?.lua;' .. package.path

local WINDING_DOWN_FRAMES = 300   -- must match the gadget's constant

--- Fresh mock world + a fresh game_gameover.lua instance loaded against it.
--- `sides` is the scenario's sides table (nil = no scenario at all).
--- `victoryCount` is what GG.Objectives.VictoryObjectiveCount() reports —
--- how many `victory = true` objectives the war staged. Defaults to 1 (a
--- normal, endable war); pass 0 for the endless case (PLAN-endtoend.md D10).
--- `teams` is the list of teams the ROOM actually staffed, Gaia last. It
--- defaults to a fully staffed 8-team Meridian room + Gaia, because that is
--- the war as authored; pass a shorter list for a downsized room (D14), which
--- is the common live case and the one that produced D18.
local function load(sides, victoryCount, teams)
    local world = {
        frame = 0,
        gameRulesParams = {},
        completeHooks = {},
        gameOverCalls = {},     -- each entry is the winners list as passed
        expireCalls = 0,
        echoes = {},
        -- Gaia is the last team index, exactly as the engine allocates it.
        teams = teams or { 0, 1, 2, 3, 4, 5, 6, 7, 8 },
    }
    world.gaia = world.teams[#world.teams]

    _G.Spring = {
        GetGameFrame = function() return world.frame end,
        SetGameRulesParam = function(key, value) world.gameRulesParams[key] = value end,
        GetGameRulesParam = function(key) return world.gameRulesParams[key] end,
        -- Matches rts/Server/Simulation.cpp:507 — every team is its own
        -- allyteam. The gadget must not assume otherwise.
        --
        -- Returns a FLOAT, as the live engine does (verified in-sim: team 0 ->
        -- ally 0.0). This caught a real drift — the published
        -- war_winner_ally_teams param read "0.0,1.0,2.0,3.0" in a live match
        -- while an integer-returning mock made the spec pass on "0,1,2,3".
        -- Keep the float: it is what the gadget actually receives.
        GetTeamAllyTeamID = function(teamID) return teamID + 0.0 end,
        -- Floats again, as the live engine returns them (a live 2-slot room
        -- reported teams 0.0, 1.0, 2.0 with Gaia at 2).
        GetTeamList = function()
            local out = {}
            for i, t in ipairs(world.teams) do out[i] = t + 0.0 end
            return out
        end,
        GetGaiaTeamID = function() return world.gaia + 0.0 end,
        -- The real Spring.GameOver validates every id against ValidAllyTeam
        -- and returns how many it accepted (LuaSyncedCtrl.cpp). Model both:
        -- an id belonging to no staffed team is silently dropped, which is
        -- exactly the mechanism behind D18.
        GameOver = function(winners)
            world.gameOverCalls[#world.gameOverCalls + 1] = winners
            local accepted = 0
            for _, a in ipairs(winners) do
                for _, t in ipairs(world.teams) do
                    if t == a then accepted = accepted + 1 break end
                end
            end
            return accepted
        end,
        Echo = function(msg) world.echoes[#world.echoes + 1] = msg end,
    }

    _G.gadgetHandler = { IsSyncedCode = function() return true end }
    _G.gadget = {}
    _G.GG = {
        Objectives = {
            OnComplete = function(fn) world.completeHooks[#world.completeHooks + 1] = fn end,
            ExpireAllActive = function()
                world.expireCalls = world.expireCalls + 1
                -- Assert ordering at the moment of the call: escrow must
                -- settle BEFORE the game is declared over, never after.
                assert.are.equal(0, #world.gameOverCalls)
                assert.are.equal('resolving', world.gameRulesParams['war_state'])
                return 3
            end,
            VictoryObjectiveCount = function()
                return victoryCount == nil and 1 or victoryCount
            end,
        },
        Scenario = sides and { name = 'meridian_basin', data = { sides = sides } } or nil,
    }

    dofile('./game_gameover.lua')
    local g = _G.gadget
    g:Initialize()

    --- Complete an objective through the registered hook.
    function world.complete(o, completingTeam)
        for _, fn in ipairs(world.completeHooks) do fn(o, completingTeam) end
    end

    --- Advance the sim to `frame`, firing GameFrame on the way.
    function world.runTo(frame)
        for f = world.frame + 1, frame do
            world.frame = f
            g:GameFrame(f)
        end
    end

    return world, g
end

-- Meridian Basin's layout: 4 teams per faction (scenarios/meridian_basin.lua).
local MERIDIAN_SIDES = {
    { faction = 'compact', team = 0 }, { faction = 'compact', team = 1 },
    { faction = 'compact', team = 2 }, { faction = 'compact', team = 3 },
    { faction = 'union',   team = 4 }, { faction = 'union',   team = 5 },
    { faction = 'union',   team = 6 }, { faction = 'union',   team = 7 },
}

local VICTORY_OBJ = { id = 1, type = 'control', victory = true, forTeam = nil }
local ORDINARY_OBJ = { id = 2, type = 'control', forTeam = nil }

describe("war state", function()
    it("publishes 'active' at initialize, with no winner yet", function()
        local world = load(MERIDIAN_SIDES)
        assert.are.equal('active', world.gameRulesParams['war_state'])
        assert.is_nil(world.gameRulesParams['war_winner_team'])
    end)

    it("ignores a non-victory objective completing", function()
        local world = load(MERIDIAN_SIDES)
        world.complete(ORDINARY_OBJ, 4)
        world.runTo(WINDING_DOWN_FRAMES * 2)
        assert.are.equal('active', world.gameRulesParams['war_state'])
        assert.are.equal(0, #world.gameOverCalls)
    end)

    -- GG.WarState is the in-sim mirror of the rulesParam, and it is load-
    -- bearing: game_objectives.lua reads it to stop the systemic generator
    -- once the war leaves 'active'. Without it the generator kept spawning
    -- missions into a war that was ending (a live Meridian board grew 9 → 34
    -- objectives past the declared win, 2026-08-03). A gadget cannot read the
    -- param back cheaply, so drift between the two would silently un-gate the
    -- generator — hence asserted at every state, not just at init.
    it("mirrors the war state to GG.WarState at every transition", function()
        local world = load(MERIDIAN_SIDES)
        assert.are.equal('active', GG.WarState)

        world.complete(VICTORY_OBJ, 4)
        assert.are.equal('winding_down', GG.WarState)
        assert.are.equal(world.gameRulesParams['war_state'], GG.WarState)

        world.runTo(WINDING_DOWN_FRAMES)
        assert.are.equal('over', GG.WarState)
        assert.are.equal(world.gameRulesParams['war_state'], GG.WarState)
    end)
end)

describe("victory objective completing", function()
    it("enters winding_down immediately and does NOT declare game over yet", function()
        local world = load(MERIDIAN_SIDES)
        world.complete(VICTORY_OBJ, 4)

        assert.are.equal('winding_down', world.gameRulesParams['war_state'])
        assert.are.equal(4, world.gameRulesParams['war_winner_team'])
        assert.are.equal(0, #world.gameOverCalls)
    end)

    it("holds the grace period, then resolves and declares", function()
        local world = load(MERIDIAN_SIDES)
        world.complete(VICTORY_OBJ, 4)

        world.runTo(WINDING_DOWN_FRAMES - 1)
        assert.are.equal('winding_down', world.gameRulesParams['war_state'])
        assert.are.equal(0, #world.gameOverCalls)

        world.runTo(WINDING_DOWN_FRAMES)
        assert.are.equal('over', world.gameRulesParams['war_state'])
        assert.are.equal(1, #world.gameOverCalls)
    end)

    it("settles unresolved escrow before declaring (§7 resolving)", function()
        -- The ordering assertion itself lives inside the ExpireAllActive mock
        -- above, which runs at the moment of the call.
        local world = load(MERIDIAN_SIDES)
        world.complete(VICTORY_OBJ, 4)
        world.runTo(WINDING_DOWN_FRAMES)
        assert.are.equal(1, world.expireCalls)
    end)

    it("declares game over exactly once, not once per frame", function()
        local world = load(MERIDIAN_SIDES)
        world.complete(VICTORY_OBJ, 4)
        world.runTo(WINDING_DOWN_FRAMES * 3)
        assert.are.equal(1, #world.gameOverCalls)
        assert.are.equal(1, world.expireCalls)
    end)
end)

describe("winner derivation (wars §1: a side is a faction, not one team)", function()
    it("wins for every allyteam of the completing team's faction", function()
        local world = load(MERIDIAN_SIDES)
        world.complete(VICTORY_OBJ, 4)          -- union
        world.runTo(WINDING_DOWN_FRAMES)
        -- Not {4}: teams 5/6/7 are the same side and must not read as losers.
        assert.are.same({ 4, 5, 6, 7 }, world.gameOverCalls[1])
        assert.are.equal('4,5,6,7', world.gameRulesParams['war_winner_ally_teams'])
    end)

    it("wins for the other faction when it takes the objective", function()
        local world = load(MERIDIAN_SIDES)
        world.complete(VICTORY_OBJ, 0)          -- compact
        world.runTo(WINDING_DOWN_FRAMES)
        assert.are.same({ 0, 1, 2, 3 }, world.gameOverCalls[1])
    end)

    it("falls back to the completing team alone with no scenario sides", function()
        local world = load(nil)
        world.complete(VICTORY_OBJ, 4)
        world.runTo(WINDING_DOWN_FRAMES)
        assert.are.same({ 4 }, world.gameOverCalls[1])
    end)

    it("falls back for a team the sides table doesn't list", function()
        local world = load(MERIDIAN_SIDES)
        world.complete(VICTORY_OBJ, 11)
        world.runTo(WINDING_DOWN_FRAMES)
        assert.are.same({ 11 }, world.gameOverCalls[1])
    end)

    -- PLAN-endtoend.md D18. A room sized by its slots rather than by its war
    -- (D14) staffs only part of the scenario's sides table, so the side→
    -- allyteam mapping must not claim teams the room never created.
    it("claims only the side teams the room actually staffed", function()
        -- 2-slot Meridian: human team 0, AI team 1, Gaia at 2. The `compact`
        -- side lists 0-3; teams 2 and 3 are not this room's compact players.
        local world = load(MERIDIAN_SIDES, nil, { 0, 1, 2 })
        world.complete(VICTORY_OBJ, 0)
        world.runTo(WINDING_DOWN_FRAMES)
        -- Not {0,1,2,3}: 3 exists nowhere and 2 is Gaia.
        assert.are.same({ 0, 1 }, world.gameOverCalls[1])
        assert.are.equal('0,1', world.gameRulesParams['war_winner_ally_teams'])
    end)

    it("never declares Gaia a winner", function()
        local world = load(MERIDIAN_SIDES, nil, { 0, 1, 2 })
        world.complete(VICTORY_OBJ, 0)
        world.runTo(WINDING_DOWN_FRAMES)
        for _, a in ipairs(world.gameOverCalls[1]) do
            assert.are_not.equal(world.gaia, a)
        end
    end)

    it("declares nothing the engine will silently drop", function()
        -- The log lines the humans read must agree: every id handed to
        -- Spring.GameOver is accepted, so no WARNING is emitted.
        local world = load(MERIDIAN_SIDES, nil, { 0, 1, 2 })
        world.complete(VICTORY_OBJ, 0)
        world.runTo(WINDING_DOWN_FRAMES)
        for _, msg in ipairs(world.echoes) do
            assert.is_nil(msg:match('WARNING: declared'))
        end
    end)

    it("narrows to the lone staffed member of a side", function()
        -- A 1-slot union room: teams 5-7 of the `union` side were never
        -- created, so the winner is team 4 by itself rather than the
        -- scenario's full four.
        local world = load(MERIDIAN_SIDES, nil, { 4, 5 })  -- 5 is Gaia here
        world.complete(VICTORY_OBJ, 4)
        world.runTo(WINDING_DOWN_FRAMES)
        assert.are.same({ 4 }, world.gameOverCalls[1])
    end)
end)

describe("edges", function()
    it("takes forTeam when the hook reports no completing team", function()
        local world = load(MERIDIAN_SIDES)
        world.complete({ id = 3, type = 'protect', victory = true, forTeam = 0 }, nil)
        world.runTo(WINDING_DOWN_FRAMES)
        assert.are.same({ 0, 1, 2, 3 }, world.gameOverCalls[1])
    end)

    it("refuses to end the war when no winner can be named", function()
        -- Declaring a winner we can't identify is worse than not ending:
        -- everyone would get the neutral overlay off a real victory.
        local world = load(MERIDIAN_SIDES)
        world.complete({ id = 4, type = 'control', victory = true, forTeam = nil }, nil)
        world.runTo(WINDING_DOWN_FRAMES * 2)
        assert.are.equal('active', world.gameRulesParams['war_state'])
        assert.are.equal(0, #world.gameOverCalls)
    end)

    it("latches the first result — a later victory can't overwrite the winner", function()
        local world = load(MERIDIAN_SIDES)
        world.complete(VICTORY_OBJ, 4)
        world.runTo(100)
        world.complete({ id = 5, type = 'control', victory = true }, 0)   -- other faction
        world.runTo(WINDING_DOWN_FRAMES)

        assert.are.equal(1, #world.gameOverCalls)
        assert.are.same({ 4, 5, 6, 7 }, world.gameOverCalls[1])
    end)
end)

-- PLAN-endtoend.md D10 — "a war created through the lobby has no scenario, so
-- it can never end". The lobby now defaults a scenario per map, but this is
-- the check no boot path can bypass: it reads the staged board, not how the
-- board was asked for.
describe("endless-war check", function()
    local function echoesMatching(world, needle)
        local hits = 0
        for _, msg in ipairs(world.echoes) do
            if msg:find(needle, 1, true) then hits = hits + 1 end
        end
        return hits
    end

    it("publishes war_can_end = 1 when a victory objective exists", function()
        local world = load(MERIDIAN_SIDES, 1)
        world.runTo(60)
        assert.are.equal(1, world.gameRulesParams['war_can_end'])
        assert.are.equal(0, echoesMatching(world, 'NO victory objective'))
    end)

    it("warns loudly and publishes war_can_end = 0 when none exists", function()
        local world = load(MERIDIAN_SIDES, 0)
        world.runTo(60)
        assert.are.equal(0, world.gameRulesParams['war_can_end'])
        assert.are.equal(1, echoesMatching(world, 'NO victory objective'))
    end)

    it("names the scenario that declared no victory objective", function()
        local world = load(MERIDIAN_SIDES, 0)
        world.runTo(60)
        assert.are.equal(1, echoesMatching(world, 'scenario "meridian_basin" declares none'))
    end)

    it("names the unset modoption when no scenario was staged at all", function()
        -- This is the exact D10 shape: a lobby-created room, `scenario`
        -- modoption never written, game_scenario.lua returned early.
        local world = load(nil, 0)
        world.runTo(60)
        assert.are.equal(1, echoesMatching(world, 'the `scenario` modoption is unset'))
    end)

    it("warns once, not every frame", function()
        local world = load(MERIDIAN_SIDES, 0)
        world.runTo(WINDING_DOWN_FRAMES * 2)
        assert.are.equal(1, echoesMatching(world, 'NO victory objective'))
    end)

    it("does not check before frame 60 — objectives are still staging", function()
        local world = load(MERIDIAN_SIDES, 0)
        world.runTo(59)
        assert.is_nil(world.gameRulesParams['war_can_end'])
        assert.are.equal(0, echoesMatching(world, 'NO victory objective'))
    end)

    it("survives a GG.Objectives with no VictoryObjectiveCount", function()
        -- Forward-compat: an older game_objectives.lua in the same archive
        -- must degrade to the warning, not to a Lua error that takes the
        -- whole gadget down.
        local world = load(MERIDIAN_SIDES, 1)
        _G.GG.Objectives.VictoryObjectiveCount = nil
        world.runTo(60)
        assert.are.equal(0, world.gameRulesParams['war_can_end'])
        assert.are.equal(1, echoesMatching(world, 'NO victory objective'))
    end)
end)
