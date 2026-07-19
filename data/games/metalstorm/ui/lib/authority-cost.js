// ui/lib/authority-cost.js — client mirror of the order-cost formula.
//
// Pure functions, no DOM, no imports — shared by the authority-bar widget,
// the order cursor (hover cost / red-cursor refusal), and the command
// composer's cost preview. See PLAN-metalstorm-authority.md §4.
//
// SOURCE OF TRUTH: LuaRules/Configs/authority_cost.lua, build-exported as
// authority_cost.json (versioned; A3 — see tools/scripts/lua-to-json.lua
// and the Makefile's `export-metalstorm-specs` target). This module must
// NEVER hardcode the order_class multipliers: it loads the JSON and
// evaluates the same formula the synced gadget does
// (authority/formula.lua). A `version` mismatch between the JSON and the
// live game state disables prediction (fail-safe: predict() returns null).
//
// classifyOrder() DOES hardcode cmdIDs — same tradeoff as the Lua mirror
// (authority/classify.lua): these are fixed Spring protocol constants
// (rts/Lua/LuaConstCMD.cpp), not tunable spec data, so there is nothing to
// export. Keep the two lists in lockstep by hand if either changes.

// Free-command list (§3.2) — must match authority/classify.lua FREE_CMDS.
const FREE_CMDS = new Set([
  0,   // CMD.STOP
  65,  // CMD.SELFD
]);

// Posture/state-toggle commands (§3.3) — must match
// authority/classify.lua POSTURE_CMDS.
const POSTURE_CMDS = new Set([
  45,   // CMD.FIRE_STATE
  50,   // CMD.MOVE_STATE
  85,   // CMD.ONOFF
  95,   // CMD.CLOAK
  115,  // CMD.REPEAT
  120,  // CMD.TRAJECTORY
  135,  // CMD.AUTOREPAIRLEVEL
  145,  // CMD.IDLEMODE
]);

/** Is this cmdID always free, regardless of pools/origin (§3.2)? */
export function isFreeCommand(cmdID) {
  return FREE_CMDS.has(cmdID);
}

/**
 * Order-class key into authority_cost.json's `order_class` table. Mirrors
 * authority/classify.lua orderClass() exactly (negative cmdID = build
 * order, the Spring convention).
 */
export function classifyOrder(cmdID) {
  if (cmdID < 0) return 'build';
  if (POSTURE_CMDS.has(cmdID)) return 'posture';
  return 'micro';
}

/** Load the exported spec. @param {object} json parsed authority_cost.json */
export function createCostModel(json) {
  const version = json?.version ?? 0;
  const baseK = json?.base_k ?? 1.0;
  const orderClass = json?.order_class ?? {};

  return {
    version,

    /**
     * Predict the authority cost of an order. Mirrors
     * GG.Authority.OrderCost / authority/formula.lua's cost() exactly —
     * keep in lockstep with the Lua.
     * @param {object} p { baseCost, orderClassKey, regionMod, costScale }
     * @returns {number|null} predicted cost, or null if unpredictable
     *   (no spec loaded, or an order class the client doesn't recognise —
     *   fail-safe: never predict a cheaper order than the sim might charge)
     */
    predict(p) {
      if (!json || version === 0) return null;
      const classMod = orderClass[p.orderClassKey];
      if (classMod === undefined) return null;
      const costScale = p.costScale ?? 1.0;
      if (costScale <= 0) return 0;
      return Math.ceil(baseK * p.baseCost * p.regionMod * classMod * costScale);
    },

    /**
     * Red-cursor refusal prediction (§4 UI contract): can the combined
     * player + team pool currently afford `cost`?
     */
    canAfford(cost, playerPool, teamPool) {
      return (playerPool ?? 0) + (teamPool ?? 0) >= (cost ?? 0);
    },
  };
}

/** Fetch authority_cost.json for a game and build a cost model (task 5). */
export async function loadCostModel(gameDataUrl) {
  const res = await fetch(`${gameDataUrl}/authority_cost.json`);
  if (!res.ok) throw new Error(`authority_cost.json: ${res.status}`);
  const json = await res.json();
  return createCostModel(json);
}
