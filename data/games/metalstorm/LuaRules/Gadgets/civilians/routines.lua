-- civilians/routines.lua — ambient behaviour (wander / flee). STUB.
-- Plain library module (NOT a gadget). Included by game_civilians.lua.
local routines = {}

--- Tick ambient civilians: idle wander between sites, flee combat regions.
function routines.tick(civ, frame)
    -- TODO: for each 'ambient' unit, if idle pick a nearby site and move;
    -- if its region is contested (GG.Regions control != gaia/friendly), flee
    -- toward the nearest safe region. Low frequency — ambience, not pressure.
end

return routines
