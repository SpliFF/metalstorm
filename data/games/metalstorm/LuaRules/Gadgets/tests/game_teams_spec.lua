-- tests/game_teams_spec.lua — lifecycle orchestration behaviour against a
-- mocked Spring/GG (see spring_mock.lua header). PLAN-metalstorm-teams.md §11.
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets && busted tests/

package.path = './?.lua;' .. package.path

local mock = require('tests.spring_mock')

describe("joiner path (§3)", function()
    it("sets tenure and suggests the team's lowest-participation tactical objective", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()
        world.frame = 100
        world.setPlayer(1, 1, true)
        world.lowestParticipationByTeam[1] = 42

        gadgetObj:PlayerAdded(1)

        assert.are.equal(1, #world.suggestCalls)
        assert.are.equal(42, world.suggestCalls[1].id)
        assert.are.equal(1, world.suggestCalls[1].playerID)
    end)

    it("does not suggest anything when the team has no eligible objective", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()
        world.setPlayer(1, 1, true)
        -- lowestParticipationByTeam[1] left unset -> nil

        gadgetObj:PlayerAdded(1)

        assert.are.equal(0, #world.suggestCalls)
    end)

    it("is a no-op for a spectator (E2)", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()
        world.setPlayer(1, nil, true, true)   -- spectator: no team
        world.lowestParticipationByTeam[1] = 42

        gadgetObj:PlayerAdded(1)

        assert.are.equal(0, #world.suggestCalls)
        assert.is_nil(world.trp(1, 'team_leader'))
    end)

    it("preserves original tenure across a reconnect (same playerID re-added)", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()
        world.setPlayer(1, 1, true)
        world.setPlayer(2, 1, true)
        world.frame = 0
        gadgetObj:PlayerAdded(1)   -- player 1 joins first (tenure = frame 0)
        world.frame = 500
        gadgetObj:PlayerAdded(2)   -- player 2 joins later (tenure = frame 500)
        assert.are.equal(1, world.trp(1, 'team_leader'))   -- earliest tenure leads

        -- Player 1 disconnects and reconnects much later; a reset tenure
        -- would make player 2 look longer-tenured and steal leadership.
        world.setPlayer(1, 1, false)
        gadgetObj:PlayerRemoved(1, 'timeout')
        assert.are.equal(2, world.trp(1, 'team_leader'))   -- reassigned while 1 is away

        world.setPlayer(1, 1, true)
        world.frame = 999
        gadgetObj:PlayerAdded(1)   -- reconnect
        assert.are.equal(2, world.trp(1, 'team_leader'))   -- leader present (2), no-op reassign
    end)
end)

describe("leader policy (§5)", function()
    it("the first present player on a team becomes leader", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()
        world.setPlayer(5, 3, true)

        gadgetObj:PlayerAdded(5)

        assert.are.equal(5, world.trp(3, 'team_leader'))
    end)

    it("reassigns to the longest-tenured present player on leader leave", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()
        world.setPlayer(1, 1, true)
        world.setPlayer(2, 1, true)
        world.setPlayer(3, 1, true)
        world.frame = 0;   gadgetObj:PlayerAdded(1)
        world.frame = 100; gadgetObj:PlayerAdded(2)
        world.frame = 200; gadgetObj:PlayerAdded(3)
        assert.are.equal(1, world.trp(1, 'team_leader'))

        world.setPlayer(1, 1, false)
        gadgetObj:PlayerRemoved(1, 'quit')

        assert.are.equal(2, world.trp(1, 'team_leader'))   -- next-earliest present player
    end)

    it("breaks a tenure tie by the lowest playerID (deterministic)", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()
        world.setPlayer(9, 1, true)
        world.setPlayer(4, 1, true)
        -- Both observed the same frame -> tied tenure.
        gadgetObj:PlayerAdded(9)
        gadgetObj:PlayerAdded(4)
        assert.are.equal(4, world.trp(1, 'team_leader'))   -- lower playerID wins the tie
    end)

    it("leaves the leader stale when the whole team empties (no players to pick from)", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()
        world.setPlayer(1, 1, true)
        gadgetObj:PlayerAdded(1)
        assert.are.equal(1, world.trp(1, 'team_leader'))

        world.setPlayer(1, 1, false)
        gadgetObj:PlayerRemoved(1, 'quit')

        -- Stale (unchanged) rather than cleared -- §5 "leader stays stale,
        -- harmless, nothing reads it except our own UI".
        assert.are.equal(1, world.trp(1, 'team_leader'))
    end)

    it("is idempotent under interleaved join/leave in the same window (E1)", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()
        world.setPlayer(1, 1, true)
        world.setPlayer(2, 1, true)
        gadgetObj:PlayerAdded(1)
        gadgetObj:PlayerAdded(2)
        assert.are.equal(1, world.trp(1, 'team_leader'))

        -- Leader leaves and a third player joins in close succession; running
        -- the sequence twice must not change the outcome or error.
        world.setPlayer(1, 1, false)
        gadgetObj:PlayerRemoved(1, 'quit')
        gadgetObj:PlayerRemoved(1, 'quit')   -- duplicate callin, must stay a no-op
        world.setPlayer(3, 1, true)
        gadgetObj:PlayerAdded(3)
        gadgetObj:PlayerAdded(3)             -- duplicate callin

        assert.are.equal(2, world.trp(1, 'team_leader'))   -- 2 was present first, unaffected by 3 joining
    end)
end)

describe("leaver path (§4) + caretaker activation", function()
    it("does not activate a caretaker while a teammate remains", function()
        local world, gadgetObj = mock.new()
        world.modOptions.ai_caretaker = '1'
        gadgetObj:Initialize()
        world.installCaretakerAI()
        world.setPlayer(1, 1, true)
        world.setPlayer(2, 1, true)
        gadgetObj:PlayerAdded(1)
        gadgetObj:PlayerAdded(2)

        world.setPlayer(1, 1, false)
        gadgetObj:PlayerRemoved(1, 'quit')

        assert.are.equal(0, #world.caretakerActivations)
    end)

    it("activates the caretaker hook once the whole side empties, when the modoption is on", function()
        local world, gadgetObj = mock.new()
        world.modOptions.ai_caretaker = '1'
        gadgetObj:Initialize()
        world.installCaretakerAI()
        world.setPlayer(1, 1, true)
        gadgetObj:PlayerAdded(1)

        world.setPlayer(1, 1, false)
        gadgetObj:PlayerRemoved(1, 'quit')

        assert.are.equal(1, #world.caretakerActivations)
        assert.are.equal(1, world.caretakerActivations[1])
    end)

    it("never activates when the ai_caretaker modoption is off (default)", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()   -- modOptions.ai_caretaker unset -> off
        world.installCaretakerAI()
        world.setPlayer(1, 1, true)
        gadgetObj:PlayerAdded(1)

        world.setPlayer(1, 1, false)
        gadgetObj:PlayerRemoved(1, 'quit')

        assert.are.equal(0, #world.caretakerActivations)
    end)

    it("does not error when GG.AI doesn't exist yet (no AI runtime, documented no-op)", function()
        local world, gadgetObj = mock.new()
        world.modOptions.ai_caretaker = '1'
        gadgetObj:Initialize()
        -- world.installCaretakerAI() deliberately NOT called.
        world.setPlayer(1, 1, true)
        gadgetObj:PlayerAdded(1)
        world.setPlayer(1, 1, false)

        assert.has_no.errors(function() gadgetObj:PlayerRemoved(1, 'quit') end)
    end)

    it("is a no-op for a spectator (E2)", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()
        world.setPlayer(1, nil, false, true)
        assert.has_no.errors(function() gadgetObj:PlayerRemoved(1, 'quit') end)
    end)
end)

describe("mass disconnect (E5)", function()
    it("runs every side's leave sequence without error when all players leave at once", function()
        local world, gadgetObj = mock.new()
        world.modOptions.ai_caretaker = '1'
        gadgetObj:Initialize()
        world.installCaretakerAI()
        world.setPlayer(1, 1, true)
        world.setPlayer(2, 1, true)
        world.setPlayer(3, 2, true)
        gadgetObj:PlayerAdded(1)
        gadgetObj:PlayerAdded(2)
        gadgetObj:PlayerAdded(3)

        assert.has_no.errors(function()
            for _, playerID in ipairs({ 1, 2, 3 }) do
                world.players[playerID].active = false
                gadgetObj:PlayerRemoved(playerID, 'disconnect')
            end
        end)

        -- Both sides fully emptied -> caretaker fired for each.
        assert.are.equal(2, #world.caretakerActivations)
    end)
end)

describe("scoreboard (§6)", function()
    it("accumulates earned/spent through the GG.Authority hooks", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()
        world.setPlayer(7, 1, true)

        world.fireAward(7, 1, 100)   -- join grant / objective reward
        world.fireAward(7, 1, 25)
        world.fireCharge(7, 1, 40)   -- an order charged against the player's own pool
        world.fireAward(nil, 1, 50)  -- team-pool award, no single player earned it

        world.frame = 900
        gadgetObj:GameFrame(900)

        assert.are.equal(125, world.rp('score_7_earned'))
        assert.are.equal(40, world.rp('score_7_spent'))
    end)

    it("counts an objective as done only for participants at/above the threshold, on the completing team", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()
        world.setPlayer(7, 1, true)
        world.setPlayer(8, 1, true)
        world.setPlayer(9, 2, true)   -- enemy commander who wandered nearby

        world.fireComplete({ participation = { [7] = 3.0, [8] = 0.5, [9] = 5.0 } }, 1)

        world.frame = 900
        gadgetObj:GameFrame(900)

        assert.are.equal(1, world.rp('score_7_objectives'))   -- >= threshold, own team
        assert.are.equal(0, world.rp('score_8_objectives'))   -- below threshold
        assert.are.equal(0, world.rp('score_9_objectives'))   -- not on the completing team
    end)

    it("publishes on the slow cadence only, not every frame", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()
        world.setPlayer(7, 1, true)
        world.fireAward(7, 1, 100)

        world.frame = 899
        gadgetObj:GameFrame(899)
        assert.is_nil(world.rp('score_7_earned'))

        world.frame = 900
        gadgetObj:GameFrame(900)
        assert.are.equal(100, world.rp('score_7_earned'))
    end)
end)

describe("co-commander coordinator (§5/§5.1)", function()
    it("flags an AI sharing a team with a human as own-pool-only", function()
        local world, g = mock.new()
        world.setPlayer(3, 1, true)                  -- human on team 1
        world.setPlayer(7, 1, true, false, true)     -- AI virtual player on team 1
        g:PlayerAdded(7)
        assert.are.equal(1, world.trp(1, 'team_active_humans'))
        assert.is_true(world.ownPoolOnly[7])         -- co-commander: own pool only
    end)

    it("a full-side AI on a human-less team is NOT own-pool-only (may use team fallback)", function()
        local world, g = mock.new()
        world.setPlayer(7, 1, true, false, true)     -- AI alone on team 1
        g:PlayerAdded(7)
        assert.are.equal(0, world.trp(1, 'team_active_humans'))
        assert.is_false(world.ownPoolOnly[7])
    end)

    it("does NOT count an AI teammate as a human (two AIs, no human, are full-side)", function()
        local world, g = mock.new()
        world.setPlayer(7, 1, true, false, true)
        world.setPlayer(8, 1, true, false, true)
        g:PlayerAdded(7)
        assert.are.equal(0, world.trp(1, 'team_active_humans'))
        assert.is_false(world.ownPoolOnly[7])
        assert.is_false(world.ownPoolOnly[8])
    end)

    it("upgrades the AI to caretaker (clears own-pool-only) when the last human leaves", function()
        local world, g = mock.new()
        world.setPlayer(3, 1, true)
        world.setPlayer(7, 1, true, false, true)
        g:PlayerAdded(7)
        assert.is_true(world.ownPoolOnly[7])
        world.setPlayer(3, 1, false)                 -- human goes inactive
        g:PlayerRemoved(3)
        assert.are.equal(0, world.trp(1, 'team_active_humans'))
        assert.is_false(world.ownPoolOnly[7])        -- caretaker: team fallback restored
    end)

    it("downgrades the AI back to co-commander when a human rejoins", function()
        local world, g = mock.new()
        world.setPlayer(7, 1, true, false, true)
        g:PlayerAdded(7)
        assert.is_false(world.ownPoolOnly[7])
        world.setPlayer(3, 1, true)                  -- human joins
        g:PlayerAdded(3)
        assert.are.equal(1, world.trp(1, 'team_active_humans'))
        assert.is_true(world.ownPoolOnly[7])
    end)

    it("leaves a human teammate's own-pool-only untouched (only AIs are flagged)", function()
        local world, g = mock.new()
        world.setPlayer(3, 1, true)
        world.setPlayer(7, 1, true, false, true)
        g:PlayerAdded(7)
        -- only playerID 7 (the AI) was ever passed to SetOwnPoolOnly
        for _, call in ipairs(world.ownPoolOnlyCalls) do
            assert.are.equal(7, call.playerID)
        end
    end)
end)

describe("GG.Teams.AIPlayers (§5 — the shared isAI test)", function()
    -- Exported so game_scenario.lua's `ai` staging can find the virtual player
    -- behind a scenario-declared NPC slot without re-deriving the subtle
    -- opts.isAI == '1' check (an 11th GetPlayerInfo return, string-valued).
    it("lists only present AI players on the team, in playerID order", function()
        local world = mock.new()
        world.setPlayer(3, 1, true)                  -- human
        world.setPlayer(9, 1, true, false, true)     -- AI
        world.setPlayer(7, 1, true, false, true)     -- AI
        world.setPlayer(5, 2, true, false, true)     -- AI, different team
        assert.are.same({ 7, 9 }, GG.Teams.AIPlayers(1))
        assert.are.same({ 5 }, GG.Teams.AIPlayers(2))
    end)

    it("is empty for a team with no AI — the 'declared but no slot' case", function()
        local world = mock.new()
        world.setPlayer(3, 1, true)
        assert.are.same({}, GG.Teams.AIPlayers(1))
        assert.are.same({}, GG.Teams.AIPlayers(8))
    end)

    it("excludes a disconnected AI", function()
        local world = mock.new()
        world.setPlayer(7, 1, false, false, true)
        assert.are.same({}, GG.Teams.AIPlayers(1))
    end)
end)
