-- objectives/escort.lua — escort objective type (PLAN-metalstorm-objectives.md). STUB.
-- Library module included by game_objectives.lua. Convoy reaches destination
-- intact; payload units registered via GG.Civilians (convoy role).
local escort = {}

function escort.init(obj, o)             end   -- TODO bind convoy payload set
function escort.tick(obj, o)             end   -- TODO arrival check
function escort.onUnitDestroyed(obj, o, unitID) end -- payload loss → fail/degrade
function escort.describe(o)              return 'Escort' end

return escort
