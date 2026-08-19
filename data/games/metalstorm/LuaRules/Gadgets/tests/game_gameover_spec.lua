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
--- `unoccupied` is the set of teams the engine MATERIALISED but nobody plays
--- (leader -1). Seating two sides on teams 0 and 4 allocates 1-3 as filler,
--- so this is the ordinary live shape, not an edge case.
--- @param startRegions  the scenario's `world.regions` block (wars §7's
---   foothold census reads it: each entry is a side's declared landing zone).
local function load(sides, victoryCount, teams, unoccupied, startRegions)
    local world = {
        frame = 0,
        gameRulesParams = {},
        completeHooks = {},
        gameOverCalls = {},     -- each entry is the winners list as passed
        expireCalls = 0,
        sweepResult = { 1, 2 },   -- completed, expired
        echoes = {},
        -- Gaia is the last team index, exactly as the engine allocates it.
        teams = teams or { 0, 1, 2, 3, 4, 5, 6, 7, 8 },
        unoccupied = unoccupied or {},
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
        -- Leader is the 2nd return, a FLOAT like every other id the engine
        -- hands back. An unoccupied team reports leader -1 — that is how a
        -- materialised-but-empty filler team is told apart from a played one,
        -- and it is the only signal that distinguishes them (both are live,
        -- both are valid allyteams). world.unoccupied lists such teams.
        GetTeamInfo = function(teamID)
            local leader = world.unoccupied[teamID] and -1.0 or 0.0
            return teamID + 0.0, leader, false
        end,
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
            -- Returns `completed, expired` (wars §7 task 4): the war-end sweep
            -- pays out anything whose criteria were MET inside the last eval
            -- window and writes off the rest. `world.sweepResult` lets a case
            -- choose the split; the default is the mixed one, because the two
            -- numbers being carried separately all the way to the archive is
            -- the property under test.
            ExpireAllActive = function()
                world.expireCalls = world.expireCalls + 1
                -- Assert ordering at the moment of the call: escrow must
                -- settle BEFORE the game is declared over, never after.
                assert.are.equal(0, #world.gameOverCalls)
                assert.are.equal('resolving', world.gameRulesParams['war_state'])
                return world.sweepResult[1], world.sweepResult[2]
            end,
            VictoryObjectiveCount = function()
                return victoryCount == nil and 1 or victoryCount
            end,
        },
        Scenario = sides and {
            name = 'meridian_basin',
            data = { sides = sides, world = { regions = startRegions } },
        } or nil,
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

    -- §7 `resolving`: "Record the final scoreboard into the archive." The sim
    -- cannot write the archive (no DB callout from synced Lua), so what it owns
    -- is FREEZING the numbers at the instant the war ended and stamping them,
    -- for the server's heartbeat scraper to carry lobby-ward.
    it("publishes the settlement split for the archive", function()
        local world = load(MERIDIAN_SIDES)
        world.sweepResult = { 2, 5 }
        world.complete(VICTORY_OBJ, 4)
        world.runTo(WINDING_DOWN_FRAMES)
        assert.are.equal(2, world.gameRulesParams['war_settled_complete'])
        assert.are.equal(5, world.gameRulesParams['war_settled_expired'])
    end)

    it("stamps the frame the war actually ended on", function()
        -- Without it the archive races game_teams' 30 s scoreboard cadence and
        -- the sim freeze: a war ending 29 s into a cadence would archive a
        -- scoreboard half a minute out of date.
        local world = load(MERIDIAN_SIDES)
        world.complete(VICTORY_OBJ, 4)
        world.runTo(WINDING_DOWN_FRAMES)
        assert.are.equal(WINDING_DOWN_FRAMES, world.gameRulesParams['war_final_frame'])
    end)

    it("tolerates a sweep that reports only a total (no split)", function()
        -- An older objectives gadget returns one value. The counts degrade to
        -- (n, 0) rather than to nil arithmetic, because a gameover that throws
        -- here would leave the war permanently in 'resolving'.
        local world = load(MERIDIAN_SIDES)
        world.sweepResult = { 3 }
        world.complete(VICTORY_OBJ, 4)
        world.runTo(WINDING_DOWN_FRAMES)
        assert.are.equal(3, world.gameRulesParams['war_settled_complete'])
        assert.are.equal(0, world.gameRulesParams['war_settled_expired'])
        assert.are.equal(1, #world.gameOverCalls)
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

    -- PLAN-endtoend.md D18, the mirror case — the one that got through.
    -- Post-D19 a room seats the two sides on teams 0 and 4, and the engine
    -- MATERIALISES 1-3 as unoccupied filler. They are live, they are valid
    -- allyteams, and Spring.GameOver accepts every one of them, so the
    -- "teams the room never created" test above cannot see them: they were
    -- created. Only leader == -1 tells them apart. Measured live at frame
    -- 18660 (fire 7, room 43): the player won and was told "Ally team 0,
    -- Ally team 1, Ally team 2 & Ally team 3 share victory."
    it("ignores materialised-but-unoccupied filler teams", function()
        local world = load(MERIDIAN_SIDES, nil, { 0, 1, 2, 3, 4, 5 },
                           { [1] = true, [2] = true, [3] = true })
        world.complete(VICTORY_OBJ, 0)
        world.runTo(WINDING_DOWN_FRAMES)
        assert.are.same({ 0 }, world.gameOverCalls[1])
        assert.are.equal('0', world.gameRulesParams['war_winner_ally_teams'])
    end)

    it("still names a real teammate on the same side", function()
        -- The inverse guard: the leader test must not swallow a side member
        -- somebody is actually playing.
        local world = load(MERIDIAN_SIDES, nil, { 0, 1, 2, 3, 4, 5 },
                           { [2] = true, [3] = true })
        world.complete(VICTORY_OBJ, 0)
        world.runTo(WINDING_DOWN_FRAMES)
        assert.are.same({ 0, 1 }, world.gameOverCalls[1])
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

-- ───────── Snapshot Save/Load (PLAN-persistence task 1d, §7.1d) ─────────
--
-- The engine hands `Save` a table and `Load` the table it wrote (gadgetHandler
-- keys one subtable per gadget). What is being tested here is the *decision*
-- content of that table: the terminal-condition machine is a latch plus an
-- absolute frame stamp plus the winner list, and every one of those is authored
-- rather than derivable, so a restore that recomputes any of them can disagree
-- with what the players were already shown.
describe("snapshot Save/Load", function()
    local function echoesMatching(world, needle)
        local hits = 0
        for _, msg in ipairs(world.echoes) do
            if msg:find(needle, 1, true) then hits = hits + 1 end
        end
        return hits
    end

    it("carries the whole terminal-condition machine across a restore", function()
        local a = load(MERIDIAN_SIDES)
        a.complete(VICTORY_OBJ, 4)
        local state = {}
        _G.gadget.Save(_G.gadget, state)

        assert.are.equal('winding_down', state.warState)
        assert.are.equal(4, state.winningTeam)
        assert.are.equal(WINDING_DOWN_FRAMES, state.resolveAtFrame)
        assert.are.same({ 4, 5, 6, 7 }, state.winners)

        -- A fresh process: same world, nothing has happened in it yet.
        local b, g = load(MERIDIAN_SIDES)
        g:Load(state, true)
        assert.are.equal('winding_down', b.gameRulesParams['war_state'])
        assert.are.equal('winding_down', GG.WarState)

        -- ...and the clock still expires on the ORIGINAL frame, which is the
        -- point of carrying an absolute stamp: the wind-down does not restart
        -- (the victory clock is restartable if you re-derive it, and a rollback
        -- that grants a second grace period is a different war).
        b.runTo(WINDING_DOWN_FRAMES)
        assert.are.equal(1, #b.gameOverCalls)
        assert.are.same({ 4, 5, 6, 7 }, b.gameOverCalls[1])
    end)

    it("restores the winner list rather than recomputing it", function()
        -- The same win, restored into a room whose roster has since changed:
        -- teams 6 and 7 are now unoccupied. winnersFor() would answer {4,5}
        -- here, so a Load that recomputed would quietly shrink a declared win.
        local a = load(MERIDIAN_SIDES)
        a.complete(VICTORY_OBJ, 4)
        local state = {}
        _G.gadget.Save(_G.gadget, state)

        local b, g = load(MERIDIAN_SIDES, 1, nil, { [6] = true, [7] = true })
        g:Load(state, true)
        b.runTo(WINDING_DOWN_FRAMES)
        assert.are.same({ 4, 5, 6, 7 }, b.gameOverCalls[1])
    end)

    it("clears the latch when the snapshot predates the win", function()
        -- A rollback to before the victory. The gadget must NOT keep the live
        -- process's latch: the objective that won has been rolled back with
        -- everything else, so a stuck 'winding_down' would resolve a war that
        -- has not been won, and nothing would ever declare it again.
        local a = load(MERIDIAN_SIDES)
        local early = {}
        _G.gadget.Save(_G.gadget, early)
        a.complete(VICTORY_OBJ, 4)
        assert.are.equal('winding_down', a.gameRulesParams['war_state'])

        _G.gadget.Load(_G.gadget, early, true)
        assert.are.equal('active', a.gameRulesParams['war_state'])
        assert.are.equal('active', GG.WarState)
        a.runTo(WINDING_DOWN_FRAMES * 2)
        assert.are.equal(0, #a.gameOverCalls)
    end)

    it("does not re-announce the endless warning after a restore", function()
        -- endlessChecked is a one-shot warn. A restore that resets it tells a
        -- client that has been playing for an hour that the war cannot end.
        local a = load(MERIDIAN_SIDES, 0)
        a.runTo(60)
        assert.are.equal(1, echoesMatching(a, 'NO victory objective'))
        local state = {}
        _G.gadget.Save(_G.gadget, state)
        assert.is_true(state.endlessChecked)

        local b, g = load(MERIDIAN_SIDES, 0)
        g:Load(state, true)
        b.runTo(120)
        assert.are.equal(0, echoesMatching(b, 'NO victory objective'))
    end)

    it("declares Save and Load as a pair, so the coverage ledger sees it", function()
        -- §7.1d decision 3: a Save without a Load is a GAP, not a partial —
        -- it captures bytes nothing restores while looking covered.
        load(MERIDIAN_SIDES)
        assert.are.equal('function', type(_G.gadget.Save))
        assert.are.equal('function', type(_G.gadget.Load))
    end)
end)

-- ── The foothold census (wars §7 faction elimination, task 4) ──────────────
--
-- The sim COUNTS, the Director DECIDES. These cases pin the counting half:
-- what "a foothold" is, and — the one that matters most — that an absent or
-- unusable census reports "cannot tell" rather than "everybody is eliminated".
describe("foothold census", function()
    local HOMES = {
        { key = 'amber_row', team = 0 },
        { key = 'iron_bend', team = 4 },
    }
    local PERIOD = 150

    it("counts a side's own start regions that it still owns", function()
        local world = load(MERIDIAN_SIDES, nil, nil, nil, HOMES)
        world.gameRulesParams['region_amber_row_team'] = 0
        world.gameRulesParams['region_iron_bend_team'] = 4
        world.runTo(PERIOD)
        assert.are.equal(1, world.gameRulesParams['war_footholds_known'])
        assert.are.equal(1, world.gameRulesParams['war_footholds_0'])
        assert.are.equal(1, world.gameRulesParams['war_footholds_4'])
    end)

    it("reports zero for a side pushed off its own ground", function()
        local world = load(MERIDIAN_SIDES, nil, nil, nil, HOMES)
        world.gameRulesParams['region_amber_row_team'] = 4   -- taken
        world.gameRulesParams['region_iron_bend_team'] = 4
        world.runTo(PERIOD)
        assert.are.equal(0, world.gameRulesParams['war_footholds_0'])
        -- Team 4 took amber_row, but amber_row is team 0's declared home and
        -- not one of team 4's, so team 4's own count is still just iron_bend.
        assert.are.equal(1, world.gameRulesParams['war_footholds_4'])
    end)

    it("does not count a region captured ELSEWHERE as a foothold", function()
        -- §7 is "all its start regions gone", so a faction sitting on someone
        -- else's ground with none of its own is eliminated. Counting captures
        -- would make the condition unreachable in practice.
        local world = load(MERIDIAN_SIDES, nil, nil, nil, HOMES)
        world.gameRulesParams['region_amber_row_team'] = 4
        world.gameRulesParams['region_iron_bend_team'] = 4
        world.gameRulesParams['region_raven_basin_team'] = 0   -- team 0's conquest
        world.runTo(PERIOD)
        assert.are.equal(0, world.gameRulesParams['war_footholds_0'])
    end)

    it("an unowned start region is not held", function()
        local world = load(MERIDIAN_SIDES, nil, nil, nil, HOMES)
        world.gameRulesParams['region_amber_row_team'] = -1
        world.runTo(PERIOD)
        assert.are.equal(0, world.gameRulesParams['war_footholds_0'])
    end)

    it("says 'cannot tell' when the scenario declares no start regions", function()
        local world = load(MERIDIAN_SIDES, nil, nil, nil, nil)
        world.runTo(PERIOD)
        assert.are.equal(0, world.gameRulesParams['war_footholds_known'])
        assert.is_nil(world.gameRulesParams['war_footholds_0'])
    end)

    it("says 'cannot tell' when there is no scenario at all", function()
        local world = load(nil)
        world.runTo(PERIOD)
        assert.are.equal(0, world.gameRulesParams['war_footholds_known'])
    end)

    it("keeps counting through wind-down, so the archive gets the last push", function()
        local world = load(MERIDIAN_SIDES, nil, nil, nil, HOMES)
        world.gameRulesParams['region_amber_row_team'] = 0
        world.runTo(PERIOD)
        assert.are.equal(1, world.gameRulesParams['war_footholds_0'])
        world.complete(VICTORY_OBJ, 4)
        world.gameRulesParams['region_amber_row_team'] = 4   -- lost during the grace
        world.runTo(PERIOD * 2)
        assert.are.equal(0, world.gameRulesParams['war_footholds_0'])
    end)
end)
