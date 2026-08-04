// ui/lib/parley.js — client mirror of the parley/pact registry.
//
// Pure logic, no DOM — parses the `parley_<id>_*` rulesParams batch
// game_parley.lua publishes (PLAN-metalstorm-interaction.md §1) into a
// per-id record, shared by parley-panel.js (board/composer) and the pact
// map overlay. Mirrors ui/lib/objectives.js's contract exactly:
//   - `parley_count` is a HIGH-WATER MARK, not a live count — ids may be
//     missing (resolve-retention expired, or a cap/fee rejection that never
//     created one). list() skips gaps.
//   - A resolved proposal (rejected/expired/fulfilled/breached) keeps its
//     fields for a 30s retention window, then the server clears them —
//     pull() treats a missing/null field as "not currently set".
//   - trust_<a>_<b> is NOT per-proposal — read it via trustBetween(), keyed
//     by the SAME canonical (lo, hi) team ordering game_parley.lua's
//     parley/trust.lua uses (so trustBetween(get, a, b) === trustBetween(get, b, a)).
const FIELD_KEY = /^parley_(\d+)_(\w+)$/;

const NUMERIC_FIELDS = new Set([
  'from', 'to', 'deadline', 'counterOf', 'escrow', 'duration', 'amount',
  'perMinute', 'objectiveId', 'split',
]);

// Mirrors game_parley.lua's PUBLISHED_FIELDS exactly.
const PUBLISHED_FIELDS = [
  'kind', 'from', 'to', 'state', 'deadline', 'counterOf', 'escrow',
  'duration', 'regionKey', 'amount', 'perMinute', 'payer', 'corridor',
  'unitClass', 'objectiveId', 'split', 'innerKind', 'orElse', 'regionKeys',
  'intelRegions', 'intelStrengths',
];

function coerce(field, rawValue) {
  if (!NUMERIC_FIELDS.has(field)) return rawValue;
  const n = Number(rawValue);
  return Number.isNaN(n) ? rawValue : n;
}

/** Same canonical ordering as parley/trust.lua's M.orderedPair. */
export function trustKey(a, b) {
  return a <= b ? `trust_${a}_${b}` : `trust_${b}_${a}`;
}

/** Read the shared trust score between two teams (0 = neutral, unset). */
export function trustBetween(getParam, a, b) {
  const raw = getParam(trustKey(a, b));
  const n = Number(raw);
  return raw === undefined || raw === null || Number.isNaN(n) ? 0 : n;
}

export function createParleyIndex() {
  const byId = new Map();
  let count = 0;

  function ensure(id) {
    let p = byId.get(id);
    if (!p) {
      p = { id };
      byId.set(id, p);
    }
    return p;
  }

  return {
    get count() {
      return count;
    },

    /**
     * Poll-style ingestion (`ctx.store.gameRulesParam(key)` singular getter —
     * same real contract every other native-ui widget uses today, see
     * authority-bar.js/objectives.js). Returns true if anything changed.
     */
    pull(getParam) {
      let changed = false;

      const rawCount = getParam('parley_count');
      if (rawCount !== undefined && rawCount !== null) {
        const c = Number(rawCount);
        if (c !== count) {
          count = c;
          changed = true;
        }
      }

      for (let id = 1; id <= count; id++) {
        const p = ensure(id);
        for (const field of PUBLISHED_FIELDS) {
          const raw = getParam(`parley_${id}_${field}`);
          if (raw === undefined || raw === null) {
            if (field in p) {
              delete p[field];
              changed = true;
            }
            continue;
          }
          const value = coerce(field, raw);
          if (p[field] !== value) {
            p[field] = value;
            changed = true;
          }
        }
      }

      return changed;
    },

    get(id) {
      return byId.get(id);
    },

    /** Every id 1..count with live params, in id order (skips gaps). */
    list() {
      const out = [];
      for (let id = 1; id <= count; id++) {
        const p = byId.get(id);
        if (p && p.kind !== undefined) out.push(p);
      }
      return out;
    },

    /** Proposals where `teamId` is the counterparty, awaiting a response. */
    incoming(teamId) {
      return this.list().filter((p) => p.to === teamId && (p.state === 'offered' || p.state === 'countered'));
    },

    /** Proposals `teamId` originated, awaiting the other side's response. */
    outgoing(teamId) {
      return this.list().filter((p) => p.from === teamId && (p.state === 'offered' || p.state === 'countered'));
    },

    /** Live pacts (ceasefire/tribute/etc past acceptance) involving `teamId`. */
    active(teamId) {
      return this.list().filter((p) => p.state === 'active' && (p.from === teamId || p.to === teamId));
    },
  };
}
