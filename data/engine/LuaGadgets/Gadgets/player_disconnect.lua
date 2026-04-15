--------------------------------------------------------------------------------
--
--  file:    player_disconnect.lua
--  brief:   handles player disconnect events
--
--  Default engine gadget that fires when a player's WebSocket closes.
--  Game-specific gadgets can override this by shipping their own
--  player_disconnect.lua with a higher layer number — or simply
--  define a gadget:PlayerRemoved() callin in any gadget.
--
--  Available actions a game script can take in PlayerRemoved:
--    Spring.KillTeam(teamId)                 -- kill all units on team
--    Spring.GameOver({winningAllyTeams})      -- end the game
--    Spring.DestroyUnit(unitId, false, false) -- destroy a specific unit
--    Spring.TransferUnit(unitId, newTeam)     -- hand unit to another team
--    Spring.AssignPlayerToTeam(pid, teamId)   -- reassign player
--
--  The engine's game_end.lua gadget already polls player status each
--  GameFrame and calls KillTeam on leaderless teams. This gadget adds
--  an immediate response path for games that want to react faster or
--  take different actions (pause, hand to AI, notify chat, etc.).
--
--------------------------------------------------------------------------------

function gadget:GetInfo()
    return {
        name    = "Player Disconnect Handler",
        desc    = "Default engine handler for player disconnect events",
        author  = "Spring RTS Web",
        layer   = -1,    -- run before game_end.lua (layer 0)
        enabled = true,
    }
end

-- synced only
if (not gadgetHandler:IsSyncedCode()) then
    return false
end

function gadget:PlayerRemoved(playerId, reason)
    local reasonStr = "unknown"
    if reason == 0 then reasonStr = "quit"
    elseif reason == 1 then reasonStr = "kicked"
    elseif reason == 2 then reasonStr = "timeout"
    end

    Spring.Log("PlayerDisconnect", "info",
        string.format("Player %d removed (reason: %s)", playerId, reasonStr))

    -- Count remaining active human players. If none are left and the
    -- game has been running for at least a few seconds (frame > 90),
    -- end the game so the server process doesn't run forever.
    local frame = Spring.GetGameFrame()
    if frame < 90 then return end

    local hasHuman = false
    for _, pid in ipairs(Spring.GetPlayerList()) do
        local _, active, spectator = Spring.GetPlayerInfo(pid)
        if active and not spectator then
            hasHuman = true
            break
        end
    end

    if not hasHuman then
        Spring.Log("PlayerDisconnect", "info",
            "No active human players remain — ending game")
        -- Pass empty winners list so game_end.lua can still determine
        -- the actual winner from unit counts. If all humans left but
        -- AI teams are still fighting, this ends the game immediately
        -- rather than letting it run headless forever.
        Spring.GameOver({})
    end
end
