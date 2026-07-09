-- civilians/convoy.lua — civilian vehicle convoys. STUB.
-- Plain library module (NOT a gadget). Included by game_civilians.lua.
-- Convoys are the natural payload for escort/extraction objectives.
local convoy = {}

--- Tick convoy schedules: run civtrucks/buses between depots/transit hubs.
function convoy.tick(civ, frame)
    -- TODO: maintain depot→depot routes; when an escort/extract objective
    -- targets a convoy unit, register it via GG.Civilians.Register(id,'payload')
    -- so game_objectives.lua tracks arrival/destruction.
end

return convoy
