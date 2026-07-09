-- objectives/protect.lua — protection objective type (PLAN-metalstorm-objectives.md). STUB.
-- Library module included by game_objectives.lua. Keep target alive for a
-- duration (strategic + tactical scales).
local protect = {}

function protect.init(obj, o)             end   -- TODO bind protected set + timer
function protect.tick(obj, o)             end
function protect.onUnitDestroyed(obj, o, unitID) end
function protect.describe(o)              return 'Protect' end

return protect
