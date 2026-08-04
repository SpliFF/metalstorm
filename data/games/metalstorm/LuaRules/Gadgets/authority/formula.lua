-- authority/formula.lua — the order-cost formula (PLAN-metalstorm-authority.md §3.1).
--
-- Pure arithmetic, no Spring/GG API: cost(unit, cmd, player) =
--   ceil(base_k × baseCost × regionMod × orderClassMod × costScale).
-- The ONE place the formula is implemented on the sim side; the client
-- mirror (ui/lib/authority-cost.js `predict()`) must stay in lockstep.

local M = {}

--- @param baseK          LuaRules/Configs/authority_cost.lua `base_k`
--- @param baseCost       unit def customparams.authority_cost_base
--- @param regionMod      GG.Regions.CostModifierAt(unitID) (0.5/1.0/2.0)
--- @param orderClassMod  authority_cost.lua order_class[class]
--- @param costScale      modoption authority_cost_scale (0 = free-orders test path)
function M.cost(baseK, baseCost, regionMod, orderClassMod, costScale)
    if costScale <= 0 then return 0 end
    return math.ceil(baseK * baseCost * regionMod * orderClassMod * costScale)
end

return M
