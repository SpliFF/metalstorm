/**
 * nl-local-patterns.test.ts — the sentences that work with no LLM
 * (PLAN-metalstorm-command-language.md M3 "hard-coded local patterns")
 *
 * The property that matters most here is the NEGATIVE one: these patterns must
 * not widen what the local path accepts. Everything they don't match falls
 * through to the slot-filler and then to its transparent refusal — so a test that
 * only proved the happy phrasings work would miss the way this file could do
 * damage, which is by claiming sentences that are orders.
 */

import { describe, it, expect } from 'vitest';
import { matchLocalPattern, type LocalPatternDeps } from './nl-local-patterns.js';
import { ClassVocabulary, type ClassVocabularyData } from './class-vocabulary.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const vocabulary = ClassVocabulary.fromData(JSON.parse(readFileSync(
    join(HERE, '..', '..', '..', '..', 'data', 'games', 'metalstorm', 'ui', 'class-vocabulary.json'),
    'utf8')) as ClassVocabularyData);

/** The Metalstorm panel set, keyed the way the registry would resolve it. */
const PANELS: Record<string, string> = {
    minimap: 'minimap',
    'mini map': 'minimap',
    'diplomacy panel': 'parley-panel',
    diplomacy: 'parley-panel',
    parley: 'parley-panel',
    scoreboard: 'scoreboard-panel',
    objectives: 'objectives-panel',
};

const deps: LocalPatternDeps = {
    vocabulary,
    resolvePanel: (name) => PANELS[name.toLowerCase().replace(/^the\s+/, '')] ?? null,
};

const match = (utterance: string) => matchLocalPattern(utterance, deps);
const action = (utterance: string) => match(utterance)?.action ?? null;

describe('camera', () => {
    it('"zoom to <name>" emits a focus with the player\'s own words', () => {
        expect(action('zoom to Northgate')).toEqual({
            kind: 'camera', camera: { op: 'focus', targetRef: 'Northgate' },
        });
    });

    it('accepts the phrasings a player actually uses', () => {
        for (const utterance of [
            'zoom to Sector B9', 'go to Sector B9', 'take me to Sector B9',
            'look at Sector B9', 'focus on Sector B9', 'centre on Sector B9',
            'jump to Sector B9',
        ]) {
            expect(action(utterance), utterance).toEqual({
                kind: 'camera', camera: { op: 'focus', targetRef: 'Sector B9' },
            });
        }
    });

    it('emits the NAME, never a resolved position — the resolver still judges it', () => {
        // Pillar 4: the local path resolves nothing itself, so an ambiguous name
        // reaches the resolver as the player said it and gets asked about.
        const a = action('zoom to Rand');
        expect(a).toMatchObject({ camera: { targetRef: 'Rand' } });
    });

    it('"show me the whole map" is fitMap, not a panel called "the whole map"', () => {
        for (const utterance of [
            'show me the whole map', 'show the entire map', 'view the full map', 'fit the whole map',
        ]) {
            expect(action(utterance), utterance).toEqual({ kind: 'camera', camera: { op: 'fitMap' } });
        }
    });

    it('bare "zoom in" / "zoom out" are steps, not targets', () => {
        expect(action('zoom in')).toEqual({ kind: 'camera', camera: { op: 'zoom', dir: 'in' } });
        expect(action('zoom out a bit')).toEqual({ kind: 'camera', camera: { op: 'zoom', dir: 'out' } });
    });

    it('follow, in its several phrasings', () => {
        for (const utterance of [
            'follow Hammerfall', 'track Hammerfall', 'keep the camera on Hammerfall', 'stay with Hammerfall',
        ]) {
            expect(action(utterance), utterance).toEqual({
                kind: 'camera', camera: { op: 'follow', targetRef: 'Hammerfall' },
            });
        }
    });

    it('"stop following" hands the camera back visibly rather than inventing an op', () => {
        // There is no camera.stopFollow in the envelope, and adding one would put
        // a shape in the schema the model could emit for a follow that isn't
        // running. fitMap cancels the follow (any camera action does) AND is
        // visibly something happening.
        expect(action('stop following')).toEqual({ kind: 'camera', camera: { op: 'fitMap' } });
        expect(match('stop following')?.say).toContain('released');
    });
});

describe('panels', () => {
    it('opens a panel by alias', () => {
        expect(action('open the diplomacy panel')).toEqual({
            kind: 'ui', ui: { op: 'open', panelId: 'parley-panel' },
        });
    });

    it('emits the registry ID, not the phrasing — the envelope validates against ids', () => {
        expect(action('show me the diplomacy')).toMatchObject({ ui: { panelId: 'parley-panel' } });
    });

    it('"full screen" is matched BEFORE the plain show pattern', () => {
        // Word order is load-bearing: the plain pattern would swallow ", full
        // screen" as part of the name and give a rail-sized minimap for a
        // sentence that asked for the opposite.
        for (const utterance of [
            'show me the minimap, full screen',
            'show the minimap full screen',
            'show me the minimap fullscreen',
            'open the minimap maximised',
        ]) {
            expect(action(utterance), utterance).toEqual({
                kind: 'ui', ui: { op: 'fullscreen', panelId: 'minimap' },
            });
        }
    });

    it('close and toggle', () => {
        expect(action('close the scoreboard')).toEqual({
            kind: 'ui', ui: { op: 'close', panelId: 'scoreboard-panel' },
        });
        expect(action('toggle objectives')).toEqual({
            kind: 'ui', ui: { op: 'toggle', panelId: 'objectives-panel' },
        });
    });

    it('"show me <a place>" is NOT a panel — an unregistered name falls through', () => {
        // Without the registry gate this would emit `ui.open` for a panel called
        // Northgate and refuse, instead of leaving the sentence to the rest of
        // the pipeline.
        expect(action('show me Northgate')).toBeNull();
    });
});

describe('queries', () => {
    it('"how many <class>" counts on our side', () => {
        expect(action('how many tanks do we have')).toEqual({
            kind: 'query', query: { op: 'count', class: 'tanks', side: 'own' },
        });
    });

    it('handles the trailing filler a player adds', () => {
        for (const utterance of [
            'how many tanks do we have', 'how many tanks do we have left',
            'how many tanks are there', 'how many tanks?', 'how many tanks remaining',
        ]) {
            expect(action(utterance), utterance).toMatchObject({
                query: { op: 'count', class: 'tanks' },
            });
        }
    });

    it('a scale phrase pins the scale', () => {
        expect(action('how many heavy tanks do we have left?')).toEqual({
            kind: 'query', query: { op: 'count', class: 'heavy tanks', side: 'own', scale: 3 },
        });
    });

    it('side words set the side and leave the class phrase clean', () => {
        expect(action('how many enemy tanks are there')).toEqual({
            kind: 'query', query: { op: 'count', class: 'tanks', side: 'enemy' },
        });
    });

    it('"how many <not a class>" falls through instead of asking about nonsense', () => {
        expect(action('how many battlemechs do we have')).toBeNull();
        expect(action('how many times have I lost')).toBeNull();
    });

    it('locate, in its several phrasings', () => {
        for (const utterance of ['where is Hammerfall', "where's Hammerfall", 'locate Hammerfall', 'find Hammerfall']) {
            expect(action(utterance), utterance).toEqual({
                kind: 'query', query: { op: 'locate', targetRef: 'Hammerfall', side: 'own' },
            });
        }
    });

    it('an enemy locate carries the enemy side', () => {
        expect(action('locate the enemy commander')).toEqual({
            kind: 'query', query: { op: 'locate', targetRef: 'enemy commander', side: 'enemy' },
        });
    });

    it('resources and objectives', () => {
        expect(action('how much authority do we have')).toEqual({
            kind: 'query', query: { op: 'resources' },
        });
        expect(action('what are we supposed to be doing')).toEqual({
            kind: 'query', query: { op: 'objectives' },
        });
        expect(action('objectives')).toEqual({ kind: 'query', query: { op: 'objectives' } });
    });
});

describe('a counted class of squads (M5)', () => {
    it('claims the plan\'s own example utterance', () => {
        expect(action('move 2 tank squads to Randtown')).toEqual({
            kind: 'command',
            intent: {
                verb: 'secure',
                subject: { type: 'class-count', class: 'tank', count: 2 },
                target: { type: 'entity-ref', name: 'Randtown' },
            },
        });
    });

    it('reads spelled-out counts, a leading verb and a trailing priority', () => {
        expect(action('send three infantry platoons to Osprey Fen urgent')).toEqual({
            kind: 'command',
            intent: {
                verb: 'secure',
                subject: { type: 'class-count', class: 'infantry', count: 3 },
                target: { type: 'entity-ref', name: 'Osprey Fen' },
                priority: 'urgent',
            },
        });
        expect(action('attack Slag Forge')).toBeNull();      // no count — slot-filler's
    });

    it('maps the verb the same way the slot-filler does', () => {
        const defend = action('defend Northgate with 2 tank squads');
        expect(defend).toBeNull();                            // not this shape
        expect((action('hold 2 tank squads at Northgate') as
            { intent: { verb: string } }).intent.verb).toBe('hold');
    });

    it('refuses to invent a class the shipped vocabulary does not ship', () => {
        // Falls through to the slot-filler, which refuses with its own copy —
        // this pattern never gets to name a class the sim has never heard of.
        expect(match('send 2 doom squads to Randtown')).toBeNull();
    });
});

describe('what it must NOT claim', () => {
    it('leaves every army-moving sentence to the slot-filler', () => {
        for (const utterance of [
            'defend Northgate',
            'Chimera Squad attack Slag Forge high',
            'idle heavy tanks hold Sector B9',
            'name this group Hammerfall',
            'rename Chimera Platoon to Hammerfall',
            'prioritise metal collection',
            'our main base needs more air defense',
        ]) {
            expect(match(utterance), utterance).toBeNull();
        }
    });

    it('claims nothing from an empty or nonsense utterance', () => {
        for (const utterance of ['', '   ', 'flurgle the wombat sideways', '?']) {
            expect(match(utterance), JSON.stringify(utterance)).toBeNull();
        }
    });
});
