// ui/lib/authority-cost.js — client mirror of the order-cost formula. STUB.
//
// Pure functions, no DOM, no imports — shared by the authority-bar widget,
// the order cursor (hover cost / red-cursor refusal), and the command
// composer's cost preview. See PLAN-metalstorm-authority.md §4.
//
// SOURCE OF TRUTH: LuaRules/Configs/authority_cost.lua, build-exported as
// authority_cost.json (versioned; def-hash cached — PLAN-metalstorm-wire.md).
// This module must NEVER hardcode constants: it loads the JSON and evaluates
// the same formula the synced gadget does. A `version` mismatch between the
// JSON and streamed game state disables prediction (fail-safe: show "?").

/** Load the exported spec. @param {object} json parsed authority_cost.json */
export function createCostModel(json) {
  return {
    version: json?.version ?? 0,
    /**
     * Predict the authority cost of an order. Mirrors
     * GG.Authority.OrderCost — keep in lockstep with the Lua.
     * @param {object} p { baseCost, orderClass, regionMod }
     * @returns {number|null} predicted cost, or null if unpredictable
     */
    predict(p) {
      // TODO (PLAN-metalstorm-authority §4): base × order_class × regionMod
      //                                       × modoption authority_cost_scale
      return null;
    },
  };
}
