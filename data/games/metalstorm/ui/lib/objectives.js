// ui/lib/objectives.js — client mirror of the objective registry.
//
// NOTE (U1, battle-clarity): its only consumer, widgets/objectives-panel.js, is
// UNMOUNTED — the objective board is now a drill-down HUD in the client bundle
// (client/src/ui/native-ui/objective-model.ts), which parses the same
// `objective_<id>_*` contract in TypeScript because the drill-down primitives it
// renders through are engine modules a game-dir widget cannot import. Both
// readers implement the SAME published contract; if PUBLISHED_FIELDS ever
// changes, change both. This file stays until U3 re-homes the panel's bounty
// form and outcome log at rung 4, and its spec (lib/objectives.test.js) stays
// green in the meantime.
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

const NUMERIC_FIELDS = new Set([
  'reward', 'team', 'team2', 'progress', 'phase', 'expire', 'x', 'z', 'r', 'suggested', 'completed_by',
]);

/**
 * The three states an objective can leave 'active' for (game_objectives.lua
 * resolveObjective — 'complete', the type predicate's own win; 'failed', lost
 * or scripted-aborted; 'expired', mooted by a linked partner or swept by war
 * end). The server keeps a resolved objective's params for
 * RESOLVE_RETENTION_FRAMES (30 s) precisely so the UI can show the outcome —
 * see takeResolutions() for why that window went unused until now.
 */
export const RESOLVED_STATES = new Set(['complete', 'failed', 'expired']);

/** True once an objective has left 'active' and before its params are cleared. */
export function isResolved(o) {
  return RESOLVED_STATES.has(o.state);
}

/**
 * Eligibility test, shared by the list filter and the resolution notices so a
 * player is never told about an outcome they were never shown the objective
 * for. team === -1 (or absent) means "open to anyone", matching the sim's own
 * `o.forTeam or -1` publish convention.
 *
 * `team2` is the CO-ELIGIBLE team (PLAN-metalstorm-interaction.md §1
 * `joint_objective`): game_parley.lua's accept path calls
 * GG.Objectives.WidenEligibility, which sets `forTeam2` and republishes.
 * The sim enforces it (objectives/control.lua's eligibility gate is
 * `forTeam or forTeam2`), so a widened objective is genuinely completable by
 * that team — omitting it here hid the objective from the only team the
 * widening exists for (PLAN-endtoend.md D59).
 */
export function visibleTo(o, teamId) {
  return o.team === -1 || o.team === undefined || o.team === teamId
    || (o.team2 !== undefined && o.team2 === teamId);
}

/**
 * True when `o` is a joint objective — two teams are eligible for one reward
 * that only pays whoever completes it (game_objectives.lua awardObjective
 * pays `completingTeam`; parley's `terms.split` is published but NOT enforced
 * by the award path). Both sides need to be told, because to the original
 * owner the objective silently became a race and to the widened-to team it is
 * indistinguishable from one of its own.
 */
export function isJoint(o) {
  return o.team2 !== undefined && o.team !== undefined && o.team !== -1;
}

// Mirrors game_objectives.lua's PUBLISHED_FIELDS exactly — pull() polls this
// fixed field list per id rather than reacting to a batch (see pull() doc).
// `suggested` (a playerID) is PLAN-metalstorm-teams.md §3.3's joiner-onboarding
// hint, set via GG.Objectives.SuggestFor — objectives-panel.js renders it as
// "yours to take" for the matching identity.playerId.
// `completed_by` is the team that actually finished it, which `team` (the
// ELIGIBILITY field, `o.forTeam or -1`) cannot carry: an open race publishes
// team -1 to both sides, so without this key the loser of a race sees only
// "complete" and cannot tell it was not theirs (see the publish() comment in
// game_objectives.lua).
// `team2` is the co-eligible team set by GG.Objectives.WidenEligibility — see
// visibleTo() and isJoint(). It is published only while a widening is in
// force, so its absence is the normal case and must not be read as "team -1".
const PUBLISHED_FIELDS = [
  'type', 'scope', 'state', 'reward', 'team', 'team2', 'progress',
  'phase', 'stage', 'expire', 'region', 'x', 'z', 'r', 'suggested', 'completed_by',
];

function coerce(field, rawValue) {
  if (!NUMERIC_FIELDS.has(field)) return rawValue;
  const n = Number(rawValue);
  return Number.isNaN(n) ? rawValue : n;
}

// A war-end sweep (GG.Objectives.ExpireAllActive) resolves every remaining
// objective on one frame, so the queue is bounded — a caller that renders one
// line per drained resolution must not be handed an unbounded burst.
const RESOLUTION_QUEUE_MAX = 32;

export function createObjectiveIndex() {
  const byId = new Map();
  const seenState = new Map();   // id -> the state we last ingested, for transition detection
  let resolutions = [];          // observed active -> terminal transitions, drained by takeResolutions()
  let count = 0;

  /**
   * Record active -> terminal transitions since the previous ingest. Called at
   * the end of applyParams()/pull() so a caller sees the same records the
   * render it is about to do will see.
   *
   * Only a transition we OBSERVED from 'active' counts. An objective first
   * seen already-resolved (a widget mounting mid-retention-window, or a store
   * that was populated before we subscribed) queues nothing — replaying
   * history as notifications at mount is the bug authority-bar.js's
   * first-read sync exists to avoid.
   */
  function sweepTransitions() {
    for (const [id, o] of byId) {
      const now = o.state;
      if (now === undefined) {
        // Retention expired; the server cleared every field for this id.
        seenState.delete(id);
        continue;
      }
      if (now === seenState.get(id)) continue;
      if (seenState.get(id) === 'active' && RESOLVED_STATES.has(now)) {
        // Snapshot, not the live record: the fields are cleared out from
        // under it 30 s later, and a resolution notice must still be able to
        // name the type and the reward that was won or lost.
        if (resolutions.length < RESOLUTION_QUEUE_MAX) resolutions.push({ ...o });
      }
      seenState.set(id, now);
    }
  }

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

      sweepTransitions();
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

      sweepTransitions();
      return changed;
    },

    /**
     * Drain the objectives that have left 'active' since the last call, as
     * snapshots taken at the moment they resolved (PLAN-endtoend.md D46 — a
     * failed objective used to leave the panel's `active` filter and simply
     * vanish, so a player could lose a reward with nothing on screen ever
     * naming it). Each resolution is returned exactly once; the caller
     * decides what is worth announcing to whom.
     */
    takeResolutions() {
      const out = resolutions;
      resolutions = [];
      return out;
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
        return visibleTo(o, teamId);
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
