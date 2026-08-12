/**
 * ui-action-registry.test.ts — the panels a sentence can name
 * (PLAN-metalstorm-command-language.md §6.3, milestone M3)
 */

import { describe, it, expect, vi } from 'vitest';
import { UiActionRegistry, createNLUiActionPort, normalisePanelName } from './ui-action-registry.js';

interface Fake {
    registry: UiActionRegistry;
    calls: string[];
    open: boolean;
    full: boolean;
}

function withPanels(opts: { fullscreen?: boolean } = {}): Fake {
    const calls: string[] = [];
    const state = { open: false, full: false };
    const registry = new UiActionRegistry();

    registry.register({
        id: 'parley-panel',
        label: 'Parley',
        aliases: ['diplomacy panel', 'diplomacy', 'talks'],
        open: () => { calls.push('open'); state.open = true; },
        close: () => { calls.push('close'); state.open = false; },
        toggle: () => { calls.push('toggle'); state.open = !state.open; },
        isOpen: () => state.open,
        ...(opts.fullscreen ? {
            fullscreen: (on?: boolean) => {
                calls.push('fullscreen');
                state.full = on ?? !state.full;
                return state.full;
            },
        } : {}),
    });

    return {
        registry, calls,
        get open() { return state.open; },
        get full() { return state.full; },
    };
}

describe('normalisePanelName', () => {
    it('collapses everything a player varies without meaning anything by it', () => {
        for (const spoken of [
            'Parley', 'parley', 'the parley panel', 'Parley Panel', 'parley window',
            'PARLEY!', 'a parley view',
        ]) {
            expect(normalisePanelName(spoken)).toBe('parley');
        }
    });

    it('matches a hyphenated manifest id against the words a player says', () => {
        expect(normalisePanelName('parley-panel')).toBe('parley');
        expect(normalisePanelName('ai-command-panel')).toBe('ai command');
    });
});

describe('lookup', () => {
    it('finds a panel by id, label or alias', () => {
        const f = withPanels();
        for (const name of ['parley-panel', 'Parley', 'diplomacy panel', 'the diplomacy', 'talks']) {
            expect(f.registry.get(name)?.id, name).toBe('parley-panel');
        }
    });

    it('does NOT fuzzy-match — a word the player didn\'t say opens nothing', () => {
        const f = withPanels();
        // "parl" is a prefix of the real name and still must miss: opening the
        // nearest-sounding panel is worse than admitting the miss.
        expect(f.registry.get('parl')).toBeUndefined();
        expect(f.registry.get('pineapple')).toBeUndefined();
        expect(f.registry.apply('open', 'pineapple')).toEqual({
            ok: false, reason: 'I don\'t have a panel called "pineapple".',
        });
        expect(f.calls).toEqual([]);
    });

    it('unregistering removes every name it claimed', () => {
        const f = withPanels();
        f.registry.unregister('parley-panel');
        expect(f.registry.get('diplomacy panel')).toBeUndefined();
        expect(f.registry.ids()).toEqual([]);
    });

    it('warns and keeps the first claim when two panels want one phrase', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const f = withPanels();
        f.registry.register({
            id: 'other-panel', label: 'Other', aliases: ['diplomacy'],
            open: () => {}, close: () => {}, toggle: () => {},
        });
        expect(f.registry.get('diplomacy')?.id).toBe('parley-panel');
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe('apply', () => {
    it('open / close report the state in words', () => {
        const f = withPanels();
        expect(f.registry.apply('open', 'diplomacy')).toEqual({ ok: true, text: 'Parley open' });
        expect(f.open).toBe(true);
        expect(f.registry.apply('close', 'diplomacy')).toEqual({ ok: true, text: 'Parley closed' });
        expect(f.open).toBe(false);
    });

    it('toggle reports which way it went, not just that it toggled', () => {
        const f = withPanels();
        expect(f.registry.apply('toggle', 'parley-panel')).toEqual({ ok: true, text: 'Parley open' });
        expect(f.registry.apply('toggle', 'parley-panel')).toEqual({ ok: true, text: 'Parley closed' });
    });

    it('a panel that cannot report its state says "toggled" rather than guessing', () => {
        const registry = new UiActionRegistry();
        registry.register({
            id: 'mystery', label: 'Mystery', open: () => {}, close: () => {}, toggle: () => {},
        });
        expect(registry.apply('toggle', 'mystery')).toEqual({ ok: true, text: 'Mystery toggled' });
    });

    it('fullscreen on a panel without the mode REFUSES — it does not fall back to open', () => {
        const f = withPanels();                      // no fullscreen capability
        const result = f.registry.apply('fullscreen', 'diplomacy');
        expect(result).toEqual({
            ok: false, reason: 'Parley has no full-screen mode — I can only open or close it.',
        });
        expect(f.calls).toEqual([]);                 // and nothing happened
    });

    it('fullscreen on a panel WITH the mode echoes the state it settled in', () => {
        const f = withPanels({ fullscreen: true });
        expect(f.registry.apply('fullscreen', 'diplomacy')).toEqual({
            ok: true, text: 'Parley full screen',
        });
        expect(f.full).toBe(true);
        expect(f.registry.apply('fullscreen', 'diplomacy')).toEqual({
            ok: true, text: 'Parley back to normal size',
        });
    });
});

describe('the NL port adapter', () => {
    it('translates the registry result into the executor\'s Resolution', () => {
        const f = withPanels();
        const port = createNLUiActionPort(f.registry);
        expect(port.apply({ op: 'open', panelId: 'parley-panel' }))
            .toEqual({ kind: 'ok', value: 'Parley open' });
        expect(port.apply({ op: 'open', panelId: 'nope' }).kind).toBe('refuse');
    });
});

describe('names()', () => {
    it('lists every phrase that resolves, for the help line and the LLM context', () => {
        const f = withPanels();
        expect(f.registry.names()).toEqual(['diplomacy', 'parley', 'talks']);
    });
});
