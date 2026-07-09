-- objectives/extract.lua — extraction objective type (PLAN-metalstorm-objectives.md). STUB.
-- Library module included by game_objectives.lua. Reach point, hold, evacuate
-- unit/civilians (transport interplay: PLAN-metalstorm-squad-transport.md).
local extract = {}

function extract.init(obj, o)   end   -- TODO phases: reach → hold → evacuate
function extract.tick(obj, o)   end
function extract.describe(o)    return 'Extract' end

return extract
