// objectives-panel.js — Metalstorm native JS widget.
//
// Lists active objectives (strategic + tactical) with type/reward/progress/
// phase, a bounty-post flow, and map markers via the strategic-map hook
// (PLAN-metalstorm-objectives.md §6, task 8). Reads the rulesParams mirror
// game_objectives.lua publishes (objective_<id>_*) through ui/lib/
// objectives.js's poll-style pull() — same contract as authority-bar.js
// (init(ctx)/dispose(), ctx.store.gameRulesParam(key) singular getter; there
// is no bulk batch read, see that file's header for the full contract).
//
// NOT wired here (blocked on infrastructure this widget doesn't own — same
// pre-loader state as every other native-ui widget, see authority-bar.js):
//   - live rulesParams data at all: the server->client wire producer for
//     Set{Game,Team,Player,Unit}RulesParam doesn't exist yet (dead consumer
//     in client/src/core/lua-ui-host.ts) — this widget is correct against
//     the documented rulesParams contract but unverifiable live until that
//     lands (PLAN-metalstorm-authority.md field notes has the full writeup).
//   - bounty target picking: "target pick -> type inferred -> stake slider"
//     (§3.3) needs a map-click/selection API this widget doesn't have
//     access to yet (no native-ui loader, no shared picking hook) — the
//     bounty form takes a unit ID directly instead of a map pick, and lets
//     the player choose the type explicitly rather than inferring it from a
//     picked target's allegiance/role.
//   - posting the bounty command: there is no validated command-send API
//     for native-ui widgets yet (ai-command-panel.js and command-composer.js
//     are in the same state) — postBounty() calls the documented
//     `ctx.sendCommand` stand-in and warns once (not silently) if it's
//     absent, per AGENTS.md's no-silent-stand-ins contract.
//   - map markers: PLAN-macro-map.md's strategic-map overlay doesn't exist
//     yet either — publishMarkers() calls the documented `ctx.strategicMap`
//     stand-in and warns once if it's absent. Region-hinted objectives
//     (control/liveness) additionally need ui/lib/regions.js to expose a
//     region centroid, which it doesn't yet (see objectives.js
//     markerPosition() doc) — those markers stay unavailable even once the
//     hook lands, until that follow-up ships.

import { createObjectiveIndex, isResolved, visibleTo } from '../lib/objectives.js';
import { formatAuthority } from '../lib/authority-format.js';

const TYPE_ICONS = {
  control: '⬢', kill: '✕', escort: '➜', protect: '🛡', extract: '⤴', infra: '⚙',
};

const STAGE_LABEL = { secure: 'SECURING', evac: 'EVACUATING' };

// PLAN-endtoend.md D46. How many resolutions the outcome log keeps. The
// server's 30 s retention window is what the *list* can show; this log
// outlives it, because "you lost a 100-authority reward at 47 %" is the kind
// of thing a player looks up after the fact, not within half a minute of it
// happening.
const OUTCOME_LOG_MAX = 5;

const OUTCOME_LABEL = { complete: 'COMPLETE', failed: 'FAILED', expired: 'EXPIRED' };

const BOUNTY_TYPES = ['kill', 'protect', 'escort', 'extract', 'infra'];
const BOUNTY_STAKE_MIN = 10;
const BOUNTY_STAKE_MAX = 500;
const BOUNTY_STAKE_STEP = 10;
const BOUNTY_STAKE_DEFAULT = 50;

let warnedNoSendCommand = false;
let warnedNoStrategicMap = false;

function renderItem(o, playerId, delegated) {
  const icon = TYPE_ICONS[o.type] ?? '•';
  const pct = Math.max(0, Math.min(100, Math.round((o.progress ?? 0) * 100)));
  const bits = [];
  if (o.phase) bits.push(`phase ${o.phase}`);
  if (o.stage) bits.push(STAGE_LABEL[o.stage] ?? o.stage);
  const subLabel = bits.length ? ` <span class="ms-obj-sub">(${bits.join(' · ')})</span>` : '';
  // PLAN-metalstorm-teams.md §3.3: game_teams.lua's joiner-onboarding hint
  // ("point the joiner at real team work") — badge it "yours to take"
  // rather than silently relying on the player to notice the reward number.
  const suggested = playerId !== undefined && o.suggested === playerId;
  const suggestedBadge = suggested ? '<span class="nui-badge nui-badge--accent">yours to take</span>' : '';
  // PLAN-metalstorm-interaction.md §6.2 "Assign to AI" — writes
  // guidance_<team>_delegated_keys via game_ai_guidance.lua; the planner
  // scores a delegated goal ×5 (ai/strategos/planner.lua sourceWeight()).
  const delegatedBadge = delegated ? '<span class="nui-badge">AI</span>' : '';
  // Toggle verb only — the panel is 236px wide, so "Unassign from AI" would
  // wrap; the badge above already says which state we're in.
  const assignLabel = delegated ? 'Unassign' : 'Assign AI';
  return (
    `<li class="ms-obj ms-obj--${o.scope ?? 'tactical'}${suggested ? ' is-suggested' : ''}" data-id="${o.id}">` +
    `<div class="ms-obj__line">` +
    `<span class="ms-obj__icon">${icon}</span>` +
    `<span class="ms-obj__type">${o.type}${subLabel}</span>` +
    `<span class="nui-badge nui-badge--gold ms-obj__reward">⬡ ${formatAuthority(o.reward)}</span>` +
    `</div>` +
    `<div class="nui-meter"><div class="nui-meter__fill" style="width:${pct}%"></div></div>` +
    `<div class="ms-obj__line ms-obj__actions">` +
    suggestedBadge + delegatedBadge +
    `<button type="button" class="nui-btn nui-btn--sm ms-obj-assign-ai" data-id="${o.id}" data-delegated="${delegated ? '1' : '0'}">${assignLabel}</button>` +
    `</div>` +
    `</li>`
  );
}

/**
 * One resolved objective, for both the retained-row section of the live list
 * and the session outcome log (same shape, so an outcome reads identically
 * whether the server is still publishing it or we are the only record left).
 *
 * `teamId` is ours: an open race (`team === -1`) that another team completed
 * is a LOSS to us, and `completed_by` is the only field that can say so — the
 * eligibility field publishes -1 to both sides deliberately.
 */
function renderOutcome(o, teamId) {
  const icon = TYPE_ICONS[o.type] ?? '•';
  const wonByUs = o.completed_by === undefined || o.completed_by === teamId;
  const state = o.state === 'complete' && !wonByUs ? 'lost-race' : o.state;
  // Same formatter as the active rows above: an outcome row and the live row
  // it replaces must not spell the same reward two different ways (D49).
  const reward = formatAuthority(o.reward);
  const pct = Math.round((o.progress ?? 0) * 100);

  let note;
  let award;
  if (state === 'complete') {
    note = 'complete';
    award = `<span class="nui-badge nui-badge--gold ms-obj__reward">⬡ +${reward}</span>`;
  } else if (state === 'lost-race') {
    note = 'completed by another team';
    award = `<span class="nui-badge ms-obj__reward">⬡ ${reward} lost</span>`;
  } else if (o.state === 'failed') {
    // The progress it died at is the closest thing to a reason the sim
    // publishes, and it is exactly what D46's player could not see.
    note = `failed at ${pct}%`;
    award = `<span class="nui-badge ms-obj__reward">⬡ ${reward} lost</span>`;
  } else {
    note = 'expired';
    award = `<span class="nui-badge ms-obj__reward">⬡ ${reward} lost</span>`;
  }

  return (
    `<li class="ms-obj ms-obj--outcome is-${state}" data-id="${o.id}">` +
    `<div class="ms-obj__line">` +
    `<span class="ms-obj__icon">${icon}</span>` +
    `<span class="ms-obj__type">${o.type} <span class="ms-obj-sub">(${note})</span></span>` +
    award +
    `</div>` +
    `<div class="ms-obj__line ms-obj__outcome-tag">${OUTCOME_LABEL[o.state] ?? o.state}</div>` +
    `</li>`
  );
}

export default {
  id: 'objectives-panel',

  init(ctx) {
    this.ctx = ctx;
    this.index = createObjectiveIndex();
    // Newest first, capped at OUTCOME_LOG_MAX. Session-scoped by design —
    // there is no persistence contract for widget state, and an outcome from
    // a previous war is not this war's news.
    this.outcomes = [];

    // No <h3> — the loader's panel chrome supplies the header (see
    // metalstorm.ui.json); a widget-drawn heading would double it up.
    this.el = document.createElement('div');
    this.el.className = 'ms-objectives-panel';
    this.el.innerHTML =
      '<ul class="nui-list ms-obj-list"></ul>' +
      '<div class="nui-group ms-obj-outcomes" hidden>' +
      '<p class="nui-group__title">Recent outcomes</p>' +
      '<ul class="nui-list ms-obj-outcome-list"></ul>' +
      '</div>' +
      '<div class="nui-group ms-obj-bounty">' +
      '<button class="nui-btn nui-btn--block ms-obj-bounty-toggle" type="button">+ Post bounty</button>' +
      '<form class="ms-obj-bounty-form" hidden>' +
      '<label class="nui-field"><span>Target unit ID</span>' +
      '<input class="ms-obj-bounty-target" type="number" min="0" required></label>' +
      '<label class="nui-field"><span>Type</span><select class="ms-obj-bounty-type">' +
      BOUNTY_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('') +
      '</select></label>' +
      '<label class="nui-field"><span>Stake ' +
      `<b class="ms-obj-bounty-stake-value">${BOUNTY_STAKE_DEFAULT}</b></span>` +
      `<input class="ms-obj-bounty-stake" type="range" min="${BOUNTY_STAKE_MIN}" max="${BOUNTY_STAKE_MAX}" ` +
      `step="${BOUNTY_STAKE_STEP}" value="${BOUNTY_STAKE_DEFAULT}"></label>` +
      '<button type="submit" class="nui-btn nui-btn--primary nui-btn--block">Post bounty</button>' +
      '</form>' +
      '</div>';
    ctx.mount.appendChild(this.el);

    this._wireBountyForm();
    this._wireAssignAi();

    const pull = () => this.index.pull((key) => ctx.store.gameRulesParam(key));
    this.unsub = ctx.store.subscribe(['gameRulesParams'], () => {
      if (pull()) this._render();
    });
    // PLAN-metalstorm-interaction.md §6.2 delegated set — team-scoped, so a
    // separate subscription (gameRulesParams alone won't fire on it).
    this.unsubTeam = ctx.store.subscribe(['teamRulesParams'], () => this._render());
    pull();
    this._render();
  },

  /** Current `delegated` objectiveId set for our own team, read from
   * game_ai_guidance.lua's guidance_<team>_delegated_keys. */
  _delegatedSet() {
    const teamId = this.ctx.identity?.teamId;
    const raw = this.ctx.store.teamRulesParam(teamId, `guidance_${teamId}_delegated_keys`);
    const set = new Set();
    if (raw) for (const id of String(raw).split(',')) if (id) set.add(Number(id));
    return set;
  },

  _wireAssignAi() {
    this.el.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.ms-obj-assign-ai');
      if (!btn) return;
      const objectiveId = Number(btn.dataset.id);
      const delegated = btn.dataset.delegated === '1';
      if (typeof this.ctx.sendCommand !== 'function') {
        if (!warnedNoSendCommand) {
          warnedNoSendCommand = true;
          console.warn(
            '[objectives-panel] ctx.sendCommand is not wired yet — Assign to AI is a no-op ' +
            '(FIDELITY-STANDIN: no validated command-send API for native-ui widgets, see file header).'
          );
        }
        return;
      }
      this.ctx.sendCommand('guidance.delegate', { objectiveId, delegated: delegated ? '0' : '1' });
    });
  },

  _wireBountyForm() {
    const toggle = this.el.querySelector('.ms-obj-bounty-toggle');
    const form = this.el.querySelector('.ms-obj-bounty-form');
    const stakeInput = this.el.querySelector('.ms-obj-bounty-stake');
    const stakeValue = this.el.querySelector('.ms-obj-bounty-stake-value');

    toggle.addEventListener('click', () => {
      form.hidden = !form.hidden;
    });
    stakeInput.addEventListener('input', () => {
      stakeValue.textContent = stakeInput.value;
    });
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const targetUnitID = Number(this.el.querySelector('.ms-obj-bounty-target').value);
      const type = this.el.querySelector('.ms-obj-bounty-type').value;
      const stake = Number(stakeInput.value);
      if (!Number.isFinite(targetUnitID)) return;
      this._postBounty(type, targetUnitID, stake);
      form.hidden = true;
      form.reset();
      stakeValue.textContent = String(BOUNTY_STAKE_DEFAULT);
    });
  },

  /**
   * Shape a bounty def for GG.Objectives.CreateBounty and hand it to the
   * (not-yet-existing) command-send API. See the header note — this is a
   * documented stand-in, not a working submit path yet.
   */
  _postBounty(type, targetUnitID, stake) {
    const params = type === 'kill' || type === 'protect'
      ? { targetUnitID }
      : { targetUnitIDs: [targetUnitID] };
    const def = { type, params };

    if (typeof this.ctx.sendCommand !== 'function') {
      if (!warnedNoSendCommand) {
        warnedNoSendCommand = true;
        console.warn(
          '[objectives-panel] ctx.sendCommand is not wired yet — bounty post is a no-op ' +
          '(FIDELITY-STANDIN: no validated command-send API for native-ui widgets, see file header).'
        );
      }
      return;
    }
    this.ctx.sendCommand('objectives.createBounty', { def, stake });
  },

  /**
   * Fold every objective that has left 'active' since the last render into
   * the session outcome log (PLAN-endtoend.md D46).
   *
   * Team-filtered with the same predicate the list uses: a player is told
   * about the outcome of exactly the objectives they were shown.
   */
  _collectOutcomes(teamId) {
    for (const o of this.index.takeResolutions()) {
      if (!visibleTo(o, teamId)) continue;
      this.outcomes.unshift(o);
    }
    if (this.outcomes.length > OUTCOME_LOG_MAX) this.outcomes.length = OUTCOME_LOG_MAX;
  },

  _render() {
    const identity = this.ctx.identity ?? {};
    const delegated = this._delegatedSet();
    const list = this.el.querySelector('.ms-obj-list');
    const mine = this.index.forTeam(identity.teamId);
    const active = mine.filter((o) => o.state === 'active');
    // Resolved objectives stay in the live list for the server's 30 s
    // retention window — which game_objectives.lua has always published for
    // exactly this and nothing ever read. Rendering only `active` is what
    // made a failure look like a disappearance (D46).
    const retained = mine.filter(isResolved);

    this._collectOutcomes(identity.teamId);

    const items = active.map((o) => renderItem(o, identity.playerId, delegated.has(o.id)))
      .concat(retained.map((o) => renderOutcome(o, identity.teamId)));
    list.innerHTML = items.join('') || '<li class="nui-empty">No active objectives</li>';

    const log = this.el.querySelector('.ms-obj-outcomes');
    log.hidden = this.outcomes.length === 0;
    this.el.querySelector('.ms-obj-outcome-list').innerHTML =
      this.outcomes.map((o) => renderOutcome(o, identity.teamId)).join('');

    // Header count stays readable while the panel is collapsed — and so does
    // a loss, which is the one thing a collapsed panel must still be able to
    // report. Self-clearing: the mark rides the retention window rather than
    // an acknowledgement the widget has no way to observe (collapse state
    // lives in the loader, not here).
    const lost = retained.some((o) => o.state !== 'complete'
      || (o.completed_by !== undefined && o.completed_by !== identity.teamId));
    const badge = active.length || null;
    this.ctx.setBadge?.(lost ? `${active.length} ⚠` : badge);
    this._publishMarkers();
  },

  /**
   * Push map markers through the (not-yet-existing) strategic-map hook —
   * see the header note. Region-hinted objectives resolve to null today
   * (ui/lib/regions.js has no centroid lookup) and are silently skipped,
   * same as any objective with neither an x/z nor a resolvable region hint.
   */
  _publishMarkers() {
    if (!this.ctx.strategicMap || typeof this.ctx.strategicMap.setMarkers !== 'function') {
      if (!warnedNoStrategicMap) {
        warnedNoStrategicMap = true;
        console.warn(
          '[objectives-panel] ctx.strategicMap is not wired yet — objective map markers are a no-op ' +
          '(FIDELITY-STANDIN: PLAN-macro-map.md overlay doesn\'t exist yet, see file header).'
        );
      }
      return;
    }
    const markers = [];
    for (const o of this.index.list()) {
      if (o.state !== 'active') continue;
      const pos = this.index.markerPosition(o, this.ctx.regionIndex);
      if (!pos) continue;
      markers.push({ id: o.id, kind: 'objective', type: o.type, ...pos });
    }
    this.ctx.strategicMap.setMarkers('objectives', markers);
  },

  dispose() {
    this.unsub?.();
    this.unsubTeam?.();
    this.el?.remove();
  },
};
