-- Null AI — owns a team but never issues commands.
--
-- Used when a team slot needs an owner (so units are assigned to a
-- real team on game start) but the game designer doesn't want any
-- automated behaviour: useful for benchmarking, for asymmetric
-- practice scenarios, or just as a placeholder while a real AI is
-- being developed.
--
-- The AI runtime calls onUpdate() periodically with the current game
-- frame. Returning without issuing any AI.issueCommand() calls means
-- the AI's units will sit at their spawn points. The basic callin
-- stubs below document the interface so authors writing a new AI
-- can copy this folder and start editing.

function onUpdate(frame)
    -- Intentionally empty. Units owned by this AI will not receive
    -- any orders from the AI side; they'll only move/fight if the
    -- game logic (gadgets, standing orders, player commands) tells
    -- them to.
end

function onUnitCreated(unitID, unitDefID, teamID)
    -- No-op. A real AI would record the unit and decide its role.
end

function onUnitDestroyed(unitID, attackerID)
    -- No-op.
end
