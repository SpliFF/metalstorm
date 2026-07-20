// client/damage-states.js — health-threshold cosmetic damage states.
//
// LOCATION NOTE: deliberately OUTSIDE client/squads/ — the scale-4 plan
// (PLAN-metalstorm-squad-scale4.md §4) scopes this to multi-piece units AND
// buildings, which are not squads. It shares only low-level utils with the
// squad system (thin-instance batching, wreck pooling), never member/
// steering/casualty logic (scale4 §5 rejects renderer unification —
// review A15). Pure logic, no imports — consumed by entity-renderer.ts once
// the piece-state binding lands (Stage 7-gated, like the rest of the
// worker-render adapter work).
//
// Thresholds → cosmetic tiers (smoke, blacken, disable secondary turrets).
// MONOTONIC CLAMP-DOWN (review §B [fixed]): a health wobble must never
// un-smoke a super-heavy — state only ever worsens until the unit dies
// (mirrors the squad no-heal invariant, PLAN-metalstorm-squads §4).

export const DAMAGE_TIERS = ['intact', 'scarred', 'burning', 'crippled'];

// Health-fraction upper bound at/below which each non-'intact' tier applies
// (a unit sits in the WORST tier whose bound it has fallen to or under).
const DEFAULT_THRESHOLDS = { scarred: 0.66, burning: 0.33, crippled: 0.12 };

function tierIndexForFraction(f, thresholds) {
  if (f <= thresholds.crippled) return 3;
  if (f <= thresholds.burning) return 2;
  if (f <= thresholds.scarred) return 1;
  return 0;
}

export function createDamageStates(config = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...config.thresholds };
  const highest = new Map(); // entityId -> highest tier index reached so far

  return {
    /**
     * @param {number} entityId
     * @param {number} f health fraction [0,1]
     * @returns {string} 'intact' | 'scarred' | 'burning' | 'crippled'
     *          (clamped: never improves for a given entityId)
     */
    stateFor(entityId, f) {
      const computed = tierIndexForFraction(f, thresholds);
      const prev = highest.get(entityId) ?? 0;
      const tier = Math.max(prev, computed);
      highest.set(entityId, tier);
      return DAMAGE_TIERS[tier];
    },

    /** Drop tracking for an entity (destroyed/despawned) so a reused id
     *  (object-pool reuse, reconnect) starts fresh at 'intact' rather than
     *  inheriting a previous occupant's damage tier. */
    release(entityId) {
      highest.delete(entityId);
    },
  };
}
