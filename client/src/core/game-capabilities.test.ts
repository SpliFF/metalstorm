import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hasResourceEconomy } from './game-capabilities.js';

// PLAN-endtoend.md D9. The rule under test is asymmetric on purpose: only an
// explicit `resourceEconomy: false` from the game's own discovery entry
// removes the legacy metal/energy HUD. Everything else — an old lobby that
// does not send the field, a game id that is not in the list, a failed fetch
// that leaves us with nothing — keeps it, because blanking a surface a game
// needs is the worse failure and reads as a client bug rather than as the
// discovery hiccup it would be.

const GAMES = [
    { id: 'metalstorm', displayName: 'Metalstorm', resourceEconomy: false },
    { id: 'zk', displayName: 'Zero-K', resourceEconomy: true },
    { id: 'papertanks', displayName: 'Paper Tanks', resourceEconomy: true },
];

describe('hasResourceEconomy', () => {
    it('is false for a game that disclaims the metal/energy economy', () => {
        expect(hasResourceEconomy(GAMES, 'metalstorm')).toBe(false);
    });

    it('is true for a game that declares one', () => {
        expect(hasResourceEconomy(GAMES, 'zk')).toBe(true);
    });

    it('is true when the field is missing (older lobby)', () => {
        const legacy = GAMES.map(({ id, displayName }) => ({ id, displayName }));
        expect(hasResourceEconomy(legacy, 'metalstorm')).toBe(true);
    });

    it('is true for an id discovery does not list', () => {
        expect(hasResourceEconomy(GAMES, 'nosuchgame')).toBe(true);
    });

    it('is true when the fetch produced nothing usable', () => {
        expect(hasResourceEconomy(null, 'metalstorm')).toBe(true);
        expect(hasResourceEconomy(undefined, 'metalstorm')).toBe(true);
        expect(hasResourceEconomy({ error: 'boom' }, 'metalstorm')).toBe(true);
        expect(hasResourceEconomy(GAMES, '')).toBe(true);
    });

    it('does not treat a falsy-but-not-false value as a disclaimer', () => {
        // A string "false" or a 0 is a serialisation bug upstream, not a
        // declaration. Keep the HUD and let the bug be visible.
        const odd = [{ id: 'metalstorm', resourceEconomy: 'false' },
                     { id: 'zk', resourceEconomy: 0 }];
        expect(hasResourceEconomy(odd, 'metalstorm')).toBe(true);
        expect(hasResourceEconomy(odd, 'zk')).toBe(true);
    });

    it('survives a null hole in the array', () => {
        expect(hasResourceEconomy([null, ...GAMES], 'metalstorm')).toBe(false);
    });
});

// The rule above is only worth anything if the one call site obeys it, and
// that call site lives in `main.ts` — a module no test can import (it boots a
// worker on load). So guard the seam the way fire 41's
// `lobby-css-coverage.test.ts` guards markup-vs-CSS: read the source and
// require the construction to be inside the flag's `if`. Cheap, and it fails
// if a second, unguarded `new EconomyBar(` is ever added.
describe('main.ts economy-bar wiring', () => {
    const MAIN = readFileSync(
        fileURLToPath(new URL('../main.ts', import.meta.url)), 'utf8');

    it('constructs the economy bar exactly once', () => {
        expect(MAIN.match(/new EconomyBar\(/g) ?? []).toHaveLength(1);
    });

    it('constructs it only under the resource-economy flag', () => {
        const at = MAIN.indexOf('new EconomyBar(');
        expect(at).toBeGreaterThan(-1);
        // The guard must be the innermost open block above the call: no `}`
        // may close between the `if` and the construction.
        const before = MAIN.slice(0, at);
        const guard = before.lastIndexOf('if (gameHasResourceEconomy) {');
        expect(guard).toBeGreaterThan(-1);
        expect(before.slice(guard)).not.toContain('}');
    });
});
