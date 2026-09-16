-- lib/vendor/formula.lua — VERBATIM COPY of LuaRules/Gadgets/authority/formula.lua.
--
-- The AI VM sandbox (AIScriptContext::l_require) refuses any module name that
-- escapes the plugin folder, and the AI4 file API reads only flat JSON from the
-- map-data / def-cache roots, so an AI physically cannot require the synced
-- original. lib/authority.lua feature-detects a JSON export first (engine ask
-- A3, see docs/ai-players.md) and falls back to this copy. The copy is not a
-- fork: lib/tests/vendor_drift_spec.lua asserts it is byte-identical to the
-- original below the SPLIT line, so a one-sided edit fails the suite.
--
-- Original follows.
--
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
