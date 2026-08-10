import { describe, it, expect } from 'vitest';
import {
    defaultAIId, defaultGameId, gameOptionLabel, gameOptionState,
    type AIPickerEntry, type GamePickerEntry,
} from './game-picker.js';

// PLAN-endtoend.md D26. Every case here is about a DEFAULT — what the player
// gets without touching the control — which is the class of behaviour the
// rest of the suite never exercises, because a test that cares about the
// value sets it first.

/// The list this tree's lobby actually serves, in the order
/// `GameDiscovery::Discover` sorts it (alphabetical by folder name). `bar`
/// sorting first is the whole mechanism behind D26, so the fixture keeps it.
const TREE: GamePickerEntry[] = [
    {
        id: 'bar', displayName: 'Beyond All Reason', version: '$VERSION',
        archived: true,
        archivedReason: 'The Beyond All Reason port is archived and '
            + 'unmaintained — it will not start.',
    },
    {
        id: 'metalstorm', displayName: 'Metalstorm', version: '0.1',
        archived: false, archivedReason: '',
    },
    {
        id: 'papertanks', displayName: 'Paper Tanks', version: '0.1',
        archived: false, archivedReason: '',
    },
    {
        id: 'zk', displayName: 'Zero-K', version: '$VERSION',
        archived: true,
        archivedReason: 'The Zero-K port is archived and unmaintained — it '
            + 'will not start.',
    },
];

describe('defaultGameId', () => {
    it('skips the archived game that sorts first', () => {
        // The defect verbatim: games[0] is `bar`, and `bar` cannot start.
        expect(TREE[0].id).toBe('bar');
        expect(defaultGameId(TREE)).toBe('metalstorm');
    });

    it('still takes the first entry when nothing is archived', () => {
        const live = TREE.map(g => ({ ...g, archived: false }));
        expect(defaultGameId(live)).toBe('bar');
    });

    it('returns null rather than defaulting to a game that cannot start', () => {
        const allArchived = TREE.map(g => ({ ...g, archived: true }));
        expect(defaultGameId(allArchived)).toBeNull();
    });

    it('returns null for an empty list', () => {
        expect(defaultGameId([])).toBeNull();
    });
});

describe('gameOptionLabel', () => {
    it('marks an archived game without hiding its name', () => {
        const label = gameOptionLabel(TREE[0]);
        expect(label).toContain('Beyond All Reason');
        expect(label).toContain('archived');
    });

    it('leaves a playable game unmarked', () => {
        expect(gameOptionLabel(TREE[1])).toBe('Metalstorm (0.1)');
    });
});

describe('gameOptionState', () => {
    it('disables an archived game and says why', () => {
        const state = gameOptionState(TREE[3]);
        expect(state.disabled).toBe(true);
        expect(state.title).toContain('Zero-K');
    });

    it('never disables without a reason to show', () => {
        const noReason = { ...TREE[0], archivedReason: '' };
        const state = gameOptionState(noReason);
        expect(state.disabled).toBe(true);
        expect(state.title.length).toBeGreaterThan(0);
    });

    it('leaves a playable game enabled with no tooltip', () => {
        expect(gameOptionState(TREE[1])).toEqual({ disabled: false, title: '' });
    });
});

/// The order AIDiscovery emits for Metalstorm: engine roots are scanned
/// first so a game AI sharing an id can override one by being appended
/// after. That ordering is deliberate and is not what this fixes — the
/// default is.
const METALSTORM_AIS: AIPickerEntry[] = [
    { id: 'null', displayName: 'Null AI', isEngineProvided: true },
    { id: 'strategos', displayName: 'Metalstorm Strategos', isEngineProvided: false },
];

describe('defaultAIId', () => {
    it('prefers the game AI over the engine AI listed before it', () => {
        expect(METALSTORM_AIS[0].id).toBe('null');
        expect(defaultAIId(METALSTORM_AIS)).toBe('strategos');
    });

    it('falls back to the engine AI for a game that ships none', () => {
        // Paper Tanks. "Null AI" really is the only answer there, so the
        // rule is prefer-the-game's, never refuse-the-engine's.
        expect(defaultAIId([METALSTORM_AIS[0]])).toBe('null');
    });

    it('returns null for an empty list', () => {
        expect(defaultAIId([])).toBeNull();
    });
});
