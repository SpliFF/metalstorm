/**
 * game-picker.profiles.test.ts — the AI seat's profile picker (review
 * 2026-09-10, item (e)).
 *
 * The defect: a slot holding a profile the hard-coded table did not know
 * rendered a `<select>` with no matching option, which the browser shows as
 * option 0 — "(default)" — so the roster lied about what the AI was. And an
 * AI id the game does not ship (any manifest can name one) rendered as a
 * normal row, when it is a room with one army.
 */

import { describe, it, expect } from 'vitest';
import {
    AI_ROLE_DESCRIPTIONS, STRATEGOS_PROFILE_FALLBACK, aiProfileOptions,
    aiProfilesFor, describeAISlot, type AIPickerEntry,
} from './game-picker';

const AIS: AIPickerEntry[] = [
    { id: 'null', displayName: 'Null AI', isEngineProvided: true, description: 'Issues no commands.' },
    { id: 'strategos', displayName: 'Metalstorm Strategos', isEngineProvided: false,
      description: 'Strategic army-level AI.' },
];

describe('aiProfilesFor', () => {
    it('falls back to the shipped strategos table, and to nothing for other plugins', () => {
        expect(aiProfilesFor('strategos', AIS)).toBe(STRATEGOS_PROFILE_FALLBACK);
        expect(aiProfilesFor('null', AIS)).toEqual([]);
        expect(aiProfilesFor('strategos')).toBe(STRATEGOS_PROFILE_FALLBACK);
    });

    it('prefers the route\'s own list once it publishes one', () => {
        const withProfiles: AIPickerEntry[] = [{
            ...AIS[1],
            profiles: [{ id: 'x', label: 'X', role: 'full_side', description: 'd' }],
        }];
        expect(aiProfilesFor('strategos', withProfiles).map(p => p.id)).toEqual(['x']);
    });

    it('every fallback profile mirrors a shipped file and a real role', () => {
        expect(STRATEGOS_PROFILE_FALLBACK.map(p => p.id))
            .toEqual(['default', 'aggressive', 'caretaker', 'mentor', 'npc_raider']);
        for (const p of STRATEGOS_PROFILE_FALLBACK) {
            expect(AI_ROLE_DESCRIPTIONS[p.role]).toBeTruthy();
            expect(p.description.length).toBeGreaterThan(20);
        }
    });
});

describe('aiProfileOptions', () => {
    it('puts the plugin default first and marks the selection', () => {
        const opts = aiProfileOptions(STRATEGOS_PROFILE_FALLBACK, 'caretaker');
        expect(opts[0]).toMatchObject({ id: '', selected: false, unknown: false });
        expect(opts.find(o => o.id === 'caretaker')).toMatchObject({ selected: true });
        expect(opts.filter(o => o.selected)).toHaveLength(1);
        expect(opts.find(o => o.id === 'mentor')!.title).toMatch(/Fights beside the humans/);
    });

    it('names a profile no table knows instead of showing option 0', () => {
        const opts = aiProfileOptions(STRATEGOS_PROFILE_FALLBACK, 'berserk');
        const last = opts[opts.length - 1];
        expect(last).toMatchObject({ id: 'berserk', selected: true, unknown: true });
        expect(last.label).toBe('berserk (unknown profile)');
        expect(opts[0].selected).toBe(false);
    });

    it('an empty profile selects the default and adds no trailing entry', () => {
        const opts = aiProfileOptions(STRATEGOS_PROFILE_FALLBACK, '');
        expect(opts[0].selected).toBe(true);
        expect(opts.some(o => o.unknown)).toBe(false);
    });
});

describe('describeAISlot', () => {
    it('says role and behaviour for a known profile', () => {
        expect(describeAISlot('strategos', 'aggressive', AIS))
            .toMatch(/^Aggressive · Commands a whole side/);
    });

    it('flags an AI the game does not ship', () => {
        expect(describeAISlot('brainiac', '', AIS)).toMatch(/Unknown AI “brainiac”/);
        // With no list yet (the fetch has not answered) nothing is claimed.
        expect(describeAISlot('brainiac', '', [])).toBe('');
    });

    it('flags an unknown profile on a known AI', () => {
        expect(describeAISlot('strategos', 'berserk', AIS)).toMatch(/Unknown profile “berserk”/);
    });

    it('falls back to the plugin description when there is no profile', () => {
        expect(describeAISlot('null', '', AIS)).toBe('Issues no commands.');
        expect(describeAISlot('strategos', '', AIS)).toBe('Strategic army-level AI.');
    });
});
