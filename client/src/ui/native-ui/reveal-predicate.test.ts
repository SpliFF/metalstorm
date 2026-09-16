/**
 * reveal-predicate.test.ts — `revealOn` grammar + evaluation
 * (PLAN-native-ui.md §3, PLAN-metalstorm-onboarding.md §8 "Vitest: revealOn gating").
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseRevealPredicate } from './reveal-predicate';
import { UIStore, type DirectiveSummary, type OrgGroupSummary } from './ui-store';

const ME = { playerId: 3, teamId: 1 };

function group(groupId: number): OrgGroupSummary {
    return {
        groupId, echelon: 'Platoon', ownerTeam: 1, parentId: 0,
        name: `G${groupId}`, memberIds: [groupId * 10],
        currentDirectiveId: 0, postureJson: '', baseCostSum: 0,
    };
}

function directive(directiveId: number): DirectiveSummary {
    return {
        directiveId, ownerTeam: 1, groupId: 1, type: 'Assault', priority: 0,
        shape: 'Point', params: [], requestedStrength: 100, assignedStrength: 40,
        assignedSquadCount: 2, active: true, createdAtFrame: directiveId, expiresAtFrame: 0,
    };
}

describe('parseRevealPredicate — grammar', () => {
    it('rejects malformed input so the loader can fail open', () => {
        for (const bad of ['', '   ', 'notAFlag', 'team:', '> 5', 'team:x >', 'team:x > abc',
                           'bogus:x > 1', 'selection.count', 'hasSelection && garbage']) {
            expect(parseRevealPredicate(bad), bad).toBeNull();
        }
    });

    it('reports only the store paths it actually reads', () => {
        expect(parseRevealPredicate('hasSelection')!.paths).toEqual(['selection']);
        expect(parseRevealPredicate('game:x > 1')!.paths).toEqual(['gameRulesParams']);
        expect(parseRevealPredicate('team:x > 1')!.paths).toEqual(['teamRulesParams']);
        expect(parseRevealPredicate('directives.count >= 1')!.paths).toEqual(['directives']);
    });

    it('deduplicates paths across conjuncts', () => {
        const p = parseRevealPredicate('team:a > 0 && team:b > 0 && hasOrgGroups')!;
        expect([...p.paths].sort()).toEqual(['orgGroups', 'teamRulesParams']);
    });

    it('does not let ">" shadow ">="', () => {
        const store = new UIStore();
        store.updateGameRulesParams({ n: 5 });
        expect(parseRevealPredicate('game:n >= 5')!.test(store, ME)).toBe(true);
        expect(parseRevealPredicate('game:n > 5')!.test(store, ME)).toBe(false);
        store.dispose();
    });
});

describe('parseRevealPredicate — evaluation', () => {
    let store: UIStore;
    beforeEach(() => { store = new UIStore(); });
    afterEach(() => { store.dispose(); });

    it('gates on selection', () => {
        const p = parseRevealPredicate('hasSelection')!;
        expect(p.test(store, ME)).toBe(false);
        store.updateSelection([42]);
        expect(p.test(store, ME)).toBe(true);
    });

    it('gates on a team rules param — the authority>0 case from PLAN-native-ui §3', () => {
        const p = parseRevealPredicate('team:authority_pool > 0')!;
        expect(p.test(store, ME)).toBe(false);
        store.updateTeamRulesParams(ME.teamId, { authority_pool: 25 });
        expect(p.test(store, ME)).toBe(true);
    });

    it('reads the local player\'s team, not another team\'s', () => {
        const p = parseRevealPredicate('team:authority_pool > 0')!;
        store.updateTeamRulesParams(2, { authority_pool: 999 });
        expect(p.test(store, ME)).toBe(false);
        store.updateTeamRulesParams(1, { authority_pool: 1 });
        expect(p.test(store, ME)).toBe(true);
    });

    it('gates on a game rules param — the objective:first-complete case', () => {
        const p = parseRevealPredicate('game:objectives_completed >= 1')!;
        expect(p.test(store, ME)).toBe(false);
        store.updateGameRulesParams({ objectives_completed: 1 });
        expect(p.test(store, ME)).toBe(true);
    });

    it('coerces numeric strings (rules params are number|string on the wire)', () => {
        store.updateTeamRulesParams(1, { parley_incoming: '2' });
        expect(parseRevealPredicate('team:parley_incoming >= 1')!.test(store, ME)).toBe(true);
    });

    it('treats a missing or non-numeric param as absent, never as 0', () => {
        // The trap: `<= 0` on an unset param would fire before the first
        // rules-param batch arrives and reveal everything it was gating.
        const p = parseRevealPredicate('team:authority_pool <= 0')!;
        expect(p.test(store, ME)).toBe(false);
        store.updateTeamRulesParams(1, { authority_pool: 'n/a' });
        expect(p.test(store, ME)).toBe(false);
        store.updateTeamRulesParams(1, { authority_pool: 0 });
        expect(p.test(store, ME)).toBe(true);
    });

    it('gates on org-group and directive counts', () => {
        const groups = parseRevealPredicate('hasOrgGroups')!;
        const directives = parseRevealPredicate('directives.count >= 2')!;
        expect(groups.test(store, ME)).toBe(false);
        store.updateOrgGroups([group(1)]);
        expect(groups.test(store, ME)).toBe(true);

        store.updateDirectives([directive(1)]);
        expect(directives.test(store, ME)).toBe(false);
        store.updateDirectives([directive(1), directive(2)]);
        expect(directives.test(store, ME)).toBe(true);
    });

    it('requires every conjunct of an && chain', () => {
        const p = parseRevealPredicate('hasOrgGroups && team:authority_pool > 0')!;
        store.updateOrgGroups([group(1)]);
        expect(p.test(store, ME)).toBe(false);
        store.updateTeamRulesParams(1, { authority_pool: 5 });
        expect(p.test(store, ME)).toBe(true);
    });

    it('supports every comparator', () => {
        store.updateGameRulesParams({ n: 5 });
        const t = (src: string) => parseRevealPredicate(src)!.test(store, ME);
        expect([t('game:n > 4'), t('game:n < 6'), t('game:n >= 5'),
                t('game:n <= 5'), t('game:n == 5'), t('game:n != 5')])
            .toEqual([true, true, true, true, true, false]);
    });
});

describe('parseRevealPredicate — me: (tier gating, PLAN-beta.md §(b))', () => {
    it('reads the local player\'s own rulesParam', () => {
        const store = new UIStore();
        const gate = parseRevealPredicate('me:rank >= 1')!;
        expect(gate.paths).toEqual(['gameRulesParams']);

        // Nothing published yet: absent reads as absent, never as 0 >= 1.
        expect(gate.test(store, ME)).toBe(false);

        store.updateGameRulesParams({ rank_0: 4, rank_3: 0 });
        expect(gate.test(store, ME)).toBe(false);          // ME is player 3
        store.updateGameRulesParams({ rank_3: 1 });
        expect(gate.test(store, ME)).toBe(true);
        expect(parseRevealPredicate('me:rank >= 3')!.test(store, ME)).toBe(false);
        store.dispose();
    });
});

describe("metalstorm's manifest gates", () => {
    const manifest = JSON.parse(readFileSync(join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../data/games/metalstorm/ui/metalstorm.ui.json',
    ), 'utf8')) as { widgets: { id: string; revealOn?: string }[] };

    it('parses every revealOn in the manifest', () => {
        // A predicate the parser rejects fails OPEN, so a typo here would show
        // a Recruit the whole HUD and nothing would say so at runtime.
        for (const w of manifest.widgets) {
            if (w.revealOn) expect(parseRevealPredicate(w.revealOn), w.id).not.toBeNull();
        }
    });

    it('gates the tier-1 and tier-3 panels (PLAN-beta.md)', () => {
        const gate = (id: string) => manifest.widgets.find((w) => w.id === id)?.revealOn;
        for (const id of ['scoreboard-panel', 'event-log', 'parley-panel']) {
            expect(gate(id), id).toBe('me:rank >= 1');
        }
        expect(gate('ai-command-panel')).toBe('me:rank >= 3');
        // The Recruit HUD: these arrive whole, whatever the standing.
        for (const id of ['focus-hud', 'objective-hud', 'moment-hud', 'mentor-card']) {
            expect(gate(id), id).toBeUndefined();
        }
    });
});
