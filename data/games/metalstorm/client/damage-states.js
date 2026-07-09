// client/damage-states.js — health-threshold cosmetic damage states. STUB.
//
// LOCATION NOTE: deliberately OUTSIDE client/squads/ — the scale-4 plan
// (PLAN-metalstorm-squad-scale4.md §4) scopes this to multi-piece units AND
// buildings, which are not squads. It shares only low-level utils with the
// squad system (thin-instance batching, wreck pooling), never member/
// steering/casualty logic (scale4 §5 rejects renderer unification —
// review A15).
//
// Thresholds → cosmetic tiers (smoke, blacken, disable secondary turrets).
// MONOTONIC CLAMP-DOWN (review §B [fixed]): a health wobble must never
// un-smoke a super-heavy — state only ever worsens until the unit dies
// (mirrors the squad no-heal invariant, PLAN-metalstorm-squads §4).

export function createDamageStates(config) {
  return {
    /**
     * @param {number} f health fraction [0,1]
     * @returns {string} 'intact' | 'scarred' | 'burning' | 'crippled'
     *          (clamped: never improves)
     */
    stateFor(entityId, f) { return 'intact'; },
    release(entityId) {},
  };
}
