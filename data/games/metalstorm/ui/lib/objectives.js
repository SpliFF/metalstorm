// ui/lib/objectives.js — client mirror of the objective registry.
//
// Pure logic, no DOM — parses the `objective_<id>_*` rulesParams batch
// game_objectives.lua publishes (PLAN-metalstorm-objectives.md §1, "Publishing
// v2") into a per-id record, shared by objectives-panel.js (list/progress/
// phase rendering) and — once it exists — the strategic-map marker layer.
//
// Contract mirrors §1 exactly:
//   - `objective_count` is a HIGH-WATER MARK, not a live count: ids 1..count
//     may be missing (resolved-and-retention-expired, or an id burned by a
//     rejected Create — §1 "id is burned... never reused"). list() skips them.
//   - A resolved objective keeps its fields for a 30s retention window (server-
//     side; this module doesn't run its own timer), then the server clears
//     every per-id field by publishing `null` for it — applyParams treats an
//     explicit `null` value as "delete this field", not "no update".
//   - Position hints are exactly one of: `region` (a regionKey — resolve via
//     ui/lib/regions.js, which has no centroid lookup yet, see note below) or
//     `x`/`z`(/`r`) (world coordinates). Never both.
const FIELD_KEY = /^objective_(\d+)_(\w+)$/;

const NUMERIC_FIELDS = new Set(['reward', 'team', 'progress', 'phase', 'expire', 'x', 'z', 'r', 'suggested']);

// Mirrors game_objectives.lua's PUBLISHED_FIELDS exactly — pull() polls this
// fixed field list per id rather than reacting to a batch (see pull() doc).
// `suggested` (a playerID) is PLAN-metalstorm-teams.md §3.3's joiner-onboarding
// hint, set via GG.Objectives.SuggestFor — objectives-panel.js renders it as
// "yours to take" for the matching identity.playerId.
const PUBLISHED_FIELDS = [
  'type', 'scope', 'state', 'reward', 'team', 'progress',
  'phase', 'stage', 'expire', 'region', 'x', 'z', 'r', 'suggested',
];

function coerce(field, rawValue) {
  if (!NUMERIC_FIELDS.has(field)) return rawValue;
  const n = Number(rawValue);
  return Number.isNaN(n) ? rawValue : n;
}

export function createObjectiveIndex() {
  const byId = new Map();
  let count = 0;

  function ensure(id) {
    let o = byId.get(id);
    if (!o) {
      o = { id };
      byId.set(id, o);
    }
    return o;
  }

  return {
    get count() {
      return count;
    },

    /**
     * Apply one batch of gameRulesParams. Returns true if anything actually
     * changed (so callers can skip a re-render on a no-op batch).
     */
    applyParams(params) {
      let changed = false;

      if (params.objective_count !== undefined && params.objective_count !== null) {
        const c = Number(params.objective_count);
        if (c !== count) {
          count = c;
          changed = true;
        }
      }

      for (const key in params) {
        const m = FIELD_KEY.exec(key);
        if (!m) continue;
        const id = Number(m[1]);
        const field = m[2];
        const raw = params[key];
        const o = ensure(id);

        if (raw === null) {
          // Explicit clear (resolve-retention expiry, §1).
          if (field in o) {
            delete o[field];
            changed = true;
          }
          continue;
        }

        const value = coerce(field, raw);
        if (o[field] !== value) {
          o[field] = value;
          changed = true;
        }
      }

      return changed;
    },

    /**
     * Poll-style ingestion matching the REAL store contract widgets have
     * today (`ctx.store.gameRulesParam(key)`, a singular per-key getter —
     * see authority-bar.js; there is no bulk gameRulesParams() batch read).
     * Re-reads `objective_count` and every published field for ids 1..count
     * each call; a getter returning undefined/null for a field is treated
     * as "not currently set" (equivalent to applyParams' explicit-null
     * clear — a poll has no separate "unchanged, omitted" state to
     * distinguish from "cleared"). Returns true if anything changed.
     */
    pull(getParam) {
      let changed = false;

      const rawCount = getParam('objective_count');
      if (rawCount !== undefined && rawCount !== null) {
        const c = Number(rawCount);
        if (c !== count) {
          count = c;
          changed = true;
        }
      }

      for (let id = 1; id <= count; id++) {
        const o = ensure(id);
        for (const field of PUBLISHED_FIELDS) {
          const raw = getParam(`objective_${id}_${field}`);
          if (raw === undefined || raw === null) {
            if (field in o) {
              delete o[field];
              changed = true;
            }
            continue;
          }
          const value = coerce(field, raw);
          if (o[field] !== value) {
            o[field] = value;
            changed = true;
          }
        }
      }

      return changed;
    },

    /** Raw record for one id, or undefined if never seen / cleared. */
    get(id) {
      return byId.get(id);
    },

    /** Every id 1..count with live params, in id order (skips gaps — §1). */
    list() {
      const out = [];
      for (let id = 1; id <= count; id++) {
        const o = byId.get(id);
        if (o && o.type !== undefined) out.push(o);
      }
      return out;
    },

    /**
     * Objectives visible to `teamId` — team === -1 (or absent) means "open
     * to anyone" (open race / no forTeam), matching the sim's own
     * `o.forTeam or -1` publish convention. `state`, if given, filters to
     * that state (e.g. 'active'); omit to get every retained state.
     */
    forTeam(teamId, state) {
      return this.list().filter((o) => {
        if (state !== undefined && o.state !== state) return false;
        return o.team === -1 || o.team === undefined || o.team === teamId;
      });
    },

    /**
     * World-space position hint for a map marker, or null if none is
     * resolvable. `region` hints (control/liveness objectives) need a
     * regionIndex with a centroid — ui/lib/regions.js does not expose one
     * yet (it only resolves point -> key, not key -> a representative
     * point), so region-hinted markers are unavailable until that lands;
     * this returns null for them rather than guessing a position.
     */
    markerPosition(o, regionIndex) {
      if (o.x !== undefined && o.z !== undefined) {
        return { x: o.x, z: o.z, r: o.r };
      }
      if (o.region !== undefined && regionIndex && typeof regionIndex.centroid === 'function') {
        return regionIndex.centroid(o.region);
      }
      return null;
    },
  };
}
