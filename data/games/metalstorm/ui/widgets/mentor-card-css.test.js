// @vitest-environment happy-dom
// mentor-card-css.test.js — every class the mentor card renders resolves to
// a rule in metalstorm.ui.css. mentor-card.test.js already proves the
// widget's TEXT is correct; that is blind to whether any of it is styled
// (the D61 lesson — client/src/lobby/lobby-css-coverage.test.ts is the same
// check for the lobby). This file is the CSS-coverage half.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mentorCard from './mentor-card.js';

const CSS = readFileSync(join(__dirname, '..', 'metalstorm.ui.css'), 'utf8');

/** The declaration block of the first rule whose selector list names `cls`
 *  (the class alone, nothing nested after it — mirrors lobby-css-coverage's
 *  `ruleFor`). */
function ruleFor(cls) {
  for (const m of CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (selectors.some((s) => new RegExp(`\\.${cls}$`).test(s))) return m[2];
  }
  return '';
}

/** Same fixture shape as mentor-card.test.js's fakeStore. */
function fakeStore({ game = {}, team = {}, me = 7 } = {}) {
  const tierName = (t) => ['Recruit', 'Regular', 'Veteran', 'Officer', 'Commander'][t] ?? 'Recruit';
  return {
    mentorOf: (pid) => (game[`mentor_${pid}`] === undefined ? undefined : Number(game[`mentor_${pid}`])),
    callsignOf: (pid) => String(game[`callsign_${pid}`] ?? `player ${pid}`),
    rankOf: (pid) => Number(game[`rank_${pid}`] ?? 0),
    getMyAssignments: () => Object.entries(team)
      .filter(([k, v]) => /^assign_\d+$/.test(k) && Number(v) === me)
      .map(([k]) => Number(k.slice('assign_'.length))).sort((a, b) => a - b),
    assignedBy(unitId) {
      const raw = team[`assign_${unitId}_by`];
      if (raw === undefined) return null;
      const pid = Number(raw);
      return { playerId: pid, callsign: this.callsignOf(pid), tier: this.rankOf(pid),
        line: `order from ${this.callsignOf(pid)} (${tierName(this.rankOf(pid))})` };
    },
    getShowEverything: () => false,
    setShowEverything: () => {},
    subscribe: () => () => {},
  };
}

function mount(store) {
  const el = document.createElement('div');
  document.body.append(el);
  mentorCard.init({
    mount: el, store, identity: { playerId: 7, teamId: 1 },
    api: { lobbyBase: '', fetch: async () => ({ ok: true, status: 200 }) },
  });
  return el;
}

/** Every class any element under `root` (root included) is rendered with. */
function renderedClasses(root) {
  const out = new Set();
  for (const node of [root, ...root.querySelectorAll('[class]')]) {
    for (const cls of node.className.split(/\s+/)) if (cls) out.add(cls);
  }
  return out;
}

describe('metalstorm.ui.css covers what mentor-card.js renders', () => {
  it('resolves a rule for the who/scope/order treatment', () => {
    const store = fakeStore({
      game: { mentor_7: 2, callsign_2: 'Vega', rank_2: 3 },
      team: { assign_11: 7, assign_12: 7, assign_13: 4, assign_11_by: 2 },
    });
    const el = mount(store);
    const card = el.querySelector('.ms-mentor-card');
    expect(card).not.toBeNull();

    const classes = renderedClasses(card);
    // A guard on the guard, same as lobby-css-coverage: if the markup ever
    // stops emitting these classes this test would pass by finding nothing.
    for (const cls of ['ms-mentor-card__who', 'ms-mentor-card__scope', 'ms-mentor-card__order']) {
      expect(classes.has(cls), `mentor-card.js stopped rendering .${cls}`).toBe(true);
    }

    for (const cls of classes) {
      if (cls === 'nui-btn') continue; // design-system primitive, styled in native-ui.css
      expect(ruleFor(cls), `no rule for .${cls} in metalstorm.ui.css`).not.toBe('');
    }

    // The specific idiom, not just "a rule exists": matte plate panel, a
    // muted mono readout for scope, and the phosphor-on-glass order line
    // with its hazard-yellow rule (DIRECTION.md / docs/ui-style.md).
    expect(ruleFor('ms-mentor-card')).toMatch(/background-color:\s*var\(--nui-plate-color\)/);
    expect(ruleFor('ms-mentor-card')).toMatch(/background-image:\s*var\(--nui-plate\)/);
    expect(ruleFor('ms-mentor-card')).toMatch(/border-radius:\s*var\(--nui-radius\)/);
    expect(ruleFor('ms-mentor-card__scope')).toMatch(/color:\s*var\(--nui-text-faint\)/);
    expect(ruleFor('ms-mentor-card__order')).toMatch(/color:\s*var\(--nui-accent\)/);
    expect(ruleFor('ms-mentor-card__order')).toMatch(/border-left:.*var\(--nui-gold\)/);
    expect(ruleFor('ms-mentor-card__order')).toMatch(/background:\s*var\(--nui-bg-sunken\)/);

    // No hex anywhere in the block this file owns — tokens only.
    for (const cls of ['ms-mentor-card', 'ms-mentor-card__who', 'ms-mentor-card__scope',
      'ms-mentor-card__order', 'ms-mentor-card__note']) {
      expect(ruleFor(cls), `.${cls} names a raw colour`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }

    mentorCard.dispose();
  });

  it('resolves a rule for .ms-mentor-card__note, only rendered on an error', () => {
    const el = mount(fakeStore());
    mentorCard.offerAi = true;
    mentorCard.error = 'Could not reach the server.';
    mentorCard._render();

    expect(el.querySelector('.ms-mentor-card__note')).not.toBeNull();
    expect(ruleFor('ms-mentor-card__note'), 'no rule for .ms-mentor-card__note').not.toBe('');
    expect(ruleFor('ms-mentor-card__note')).toMatch(/color:/);

    mentorCard.dispose();
  });
});
