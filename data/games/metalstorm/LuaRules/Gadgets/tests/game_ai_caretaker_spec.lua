-- tests/game_ai_caretaker_spec.lua — the caretaker-spawn hook
-- (PLAN-metalstorm-ai.md §10 task 4(b)).
--
-- Drives the real gadget file against a hand-rolled Spring/GG mock. Its own
-- mock rather than tests/spring_mock.lua's, deliberately: that one exists to
-- drive game_teams.lua's callin sequencing and installs a *stub*
-- GG.AI.ActivateCaretaker — the very function under test here. Sharing it
-- would mean the caller's test and the callee's test asserting against two
-- different implementations of the same name.
--
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets && busted tests/

package.path = './?.lua;' .. package.path

--- Fresh world + a fresh gadget instance (globals are process-wide in Lua).
local function newWorld(opts)
    opts = opts or {}
    local world = {
        spawnCalls = {},        -- recorded Spring.SpawnAIPlayer(teamID, aiId)
        teamRulesParams = {},   -- teamID -> key -> value
        logs = {},              -- { section, level, text }
        aiPlayersByTeam = {},   -- teamID -> { playerID, ... }
        spawnAccepts = true,    -- what the engine relay answers
    }

    function world.trp(teamID, key)
        local t = world.teamRulesParams[teamID]
        return t and t[key]
    end

    _G.LOG = { INFO = 1, NOTICE = 2, WARNING = 3, ERROR = 4 }

    _G.Spring = {
        SetTeamRulesParam = function(teamID, key, value, _los)
            world.teamRulesParams[teamID] = world.teamRulesParams[teamID] or {}
            world.teamRulesParams[teamID][key] = value
        end,
        Log = function(section, level, text)
            world.logs[#world.logs + 1] = { section = section, level = level, text = text }
        end,
    }
    -- An engine build without the spawn surface is a real state (an older
    -- server binary), and the gadget must name it rather than no-op quietly.
    if not opts.noEngineSupport then
        _G.Spring.SpawnAIPlayer = function(teamID, aiId)
            world.spawnCalls[#world.spawnCalls + 1] = { teamID = teamID, aiId = aiId }
            return world.spawnAccepts
        end
    end

    _G.GG = {
        Teams = {
            AIPlayers = function(teamID) return world.aiPlayersByTeam[teamID] or {} end,
        },
    }
    _G.gadgetHandler = { IsSyncedCode = function() return true end }
    _G.gadget = {}

    dofile('./game_ai_caretaker.lua')
    return world, _G.gadget
end

describe("caretaker spawn (§4.5 / task 4(b))", function()
    it("requests a caretaker for a side with no AI left on it", function()
        local world = newWorld()

        assert.is_true(GG.AI.ActivateCaretaker(1))

        assert.are.equal(1, #world.spawnCalls)
        assert.are.equal(1, world.spawnCalls[1].teamID)
        assert.are.equal('strategos', world.spawnCalls[1].aiId)
    end)

    it("publishes the caretaker profile BEFORE requesting the spawn", function()
        -- The AI VM reads ai_profile on its first tick, which is the tick after
        -- the server drains the request — so the write must already be there.
        local world = newWorld()
        local profileAtRequest
        _G.Spring.SpawnAIPlayer = function(teamID, aiId)
            profileAtRequest = world.trp(teamID, 'ai_profile')
            world.spawnCalls[#world.spawnCalls + 1] = { teamID = teamID, aiId = aiId }
            return true
        end

        GG.AI.ActivateCaretaker(2)

        assert.are.equal('caretaker', profileAtRequest)
        assert.are.equal('caretaker', world.trp(2, 'ai_profile'))
    end)

    it("does NOT spawn when the side already has an AI (it upgrades in place)", function()
        -- The case that always worked: an AI on the team becomes the full-side
        -- brain when the humans go. A second one would contend with it for one
        -- authority pool and one set of org groups.
        local world = newWorld()
        world.aiPlayersByTeam[3] = { 7 }

        assert.is_false(GG.AI.ActivateCaretaker(3))

        assert.are.equal(0, #world.spawnCalls)
        assert.is_nil(world.trp(3, 'ai_profile'))
    end)

    it("requests once for a side that empties one player at a time", function()
        -- PlayerRemoved fires per leaver, so a three-human side calls the hook
        -- three times in one frame; the engine's own has-an-AI check cannot see
        -- a request it has not drained yet.
        local world = newWorld()

        assert.is_true(GG.AI.ActivateCaretaker(4))
        assert.is_false(GG.AI.ActivateCaretaker(4))
        assert.is_false(GG.AI.ActivateCaretaker(4))

        assert.are.equal(1, #world.spawnCalls)
    end)

    it("stays retryable when the engine refuses the declaration", function()
        local world = newWorld()
        world.spawnAccepts = false

        assert.is_false(GG.AI.ActivateCaretaker(5))
        assert.are.equal(1, #world.spawnCalls)

        world.spawnAccepts = true
        assert.is_true(GG.AI.ActivateCaretaker(5))
        assert.are.equal(2, #world.spawnCalls)
    end)

    it("warns once, and does not pretend, on an engine with no spawn surface", function()
        local world = newWorld({ noEngineSupport = true })

        assert.is_false(GG.AI.ActivateCaretaker(6))
        assert.is_false(GG.AI.ActivateCaretaker(6))

        local warns = 0
        for _, l in ipairs(world.logs) do
            if l.level == LOG.WARNING and l.text:find('SpawnAIPlayer') then warns = warns + 1 end
        end
        assert.are.equal(1, warns)
        -- and nothing was published either — a profile with no brain behind it
        -- reads to the next reader as "a caretaker is running".
        assert.is_nil(world.trp(6, 'ai_profile'))
    end)

    it("normalises a float teamID (engine callins hand back floats)", function()
        local world = newWorld()

        assert.is_true(GG.AI.ActivateCaretaker(7.0))
        -- Same side, second leaver: must be recognised as already requested
        -- rather than keyed under a second, float-shaped table key.
        assert.is_false(GG.AI.ActivateCaretaker(7))
        assert.are.equal(1, #world.spawnCalls)
    end)

    it("carries the requested fuse across a snapshot round trip", function()
        local world, gadgetObj = newWorld()
        GG.AI.ActivateCaretaker(8)

        local state = {}
        gadgetObj:Save(state)
        gadgetObj:Load(state)

        assert.is_false(GG.AI.ActivateCaretaker(8))
        assert.are.equal(1, #world.spawnCalls)
    end)
end)
