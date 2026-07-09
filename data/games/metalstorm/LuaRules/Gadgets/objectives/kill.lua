-- objectives/kill.lua — kill objective type (PLAN-metalstorm-objectives.md). STUB.
-- Library module included by game_objectives.lua. Destroy a specific named
-- unit/building; completes on UnitDestroyed of the target, fails on expiry.
local kill = {}

function kill.init(obj, o)             end   -- TODO validate target unitID
function kill.onUnitDestroyed(obj, o, unitID) end
function kill.describe(o)              return 'Kill' end

return kill
