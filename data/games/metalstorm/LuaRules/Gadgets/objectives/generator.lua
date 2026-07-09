-- objectives/generator.lua — systemic objective generation (PLAN-metalstorm-objectives.md). STUB.
-- Plain library module (NOT a gadget — this subfolder is invisible to the
-- non-recursive gadget scanner, same convention as civilians/). Included by
-- game_objectives.lua.
--
-- Generates objectives from world state: region contested → control
-- objective, convoy scheduled → escort, named target exposed → kill/bounty.
-- Density from modoption objective_density; liveness guarantee (every team
-- always has ≥1 reachable objective).
--
-- Cross-plan: region value → reward formula is owned by objectives §3.2
-- (constants recorded in PLAN-metalstorm-wars.md Appendix); economy §(lever 2)
-- trims generator rewards by 1/velocity when the pool overheats.
local generator = {}

--- Periodic scan; posts objectives through the shared `obj` context.
function generator.tick(obj, frame)
    -- TODO: systemic generation from GG.Regions / GG.Civilians state.
end

return generator
