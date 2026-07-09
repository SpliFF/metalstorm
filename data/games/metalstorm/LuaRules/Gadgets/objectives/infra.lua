-- objectives/infra.lua — resource/infrastructure objective type (PLAN-metalstorm-objectives.md). STUB.
-- Library module included by game_objectives.lua. Protect/capture civilian
-- district; keep transit hub running (region + civilian interplay).
local infra = {}

function infra.init(obj, o)   end   -- TODO bind district/building set
function infra.tick(obj, o)   end
function infra.describe(o)    return 'Infrastructure' end

return infra
