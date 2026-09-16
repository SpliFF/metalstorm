/**
 * tokens.test.ts — one colour register, and only one.
 *
 * The art direction (data/games/metalstorm/art/DIRECTION.md) is only of
 * record if nothing can quietly name a colour beside it. `tokens.css` holds
 * the whole palette; every other stylesheet in the design system spends
 * `--nui-*` tokens. A hex literal anywhere else is drift, and drift is
 * exactly how the pre-2026-09-17 HUD ended up with four different blues.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CLIENT = resolve(__dirname, '../../..');
const REPO = resolve(CLIENT, '..');

const GUARDED = [
    resolve(CLIENT, 'src/ui/native-ui/native-ui.css'),
    resolve(CLIENT, 'src/ui/hud/hud.css'),
    resolve(CLIENT, 'src/native-widgets/command-composer.css'),
    resolve(CLIENT, 'src/native-widgets/command-console.css'),
    resolve(REPO, 'data/games/metalstorm/ui/metalstorm.ui.css'),
    resolve(CLIENT, 'src/ui/lobby/lobby.css'),
    resolve(CLIENT, 'src/lobby/world-map.css'),
    resolve(CLIENT, 'src/lobby/world-screen.css'),
    resolve(CLIENT, 'src/ui/briefing/briefing.css'),
    resolve(CLIENT, 'src/ui/game-over/game-over.css'),
];

/** Strip /* ... *​/ comments: a hex quoted in prose is documentation. */
function stripComments(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

describe('design tokens', () => {
    it.each(GUARDED)('names no colour of its own: %s', (file) => {
        const found = stripComments(readFileSync(file, 'utf8')).match(HEX) ?? [];
        expect(found).toEqual([]);
    });

    it('tokens.css defines the whole --nui-* vocabulary the others spend', () => {
        const tokensSrc = readFileSync(resolve(CLIENT, 'src/ui/native-ui/tokens.css'), 'utf8');
        const defined = new Set(
            [...tokensSrc.matchAll(/^\s*(--(?:nui|ms)-[\w-]+)\s*:/gm)].map((m) => m[1]),
        );
        // Geometry/occlusion tokens stay with the files that own that geometry
        // (native-ui.css's rails, hud.css's bottom reserve) — see tokens.css.
        const elsewhere = /^\s*(--[\w-]+)\s*:/gm;
        for (const file of GUARDED) {
            for (const m of readFileSync(file, 'utf8').matchAll(elsewhere)) defined.add(m[1]);
        }
        // moment-hud.ts sets this one inline, per pointer.
        defined.add('--nui-edge-angle');
        // world-map-controller.ts sets this one inline, per claim marker; the
        // CSS side always carries a --nui-accent fallback.
        defined.add('--wm-accent');

        const missing = new Set<string>();
        for (const file of [...GUARDED, resolve(CLIENT, 'src/ui/native-ui/tokens.css')]) {
            const src = stripComments(readFileSync(file, 'utf8'));
            for (const m of src.matchAll(/var\(\s*(--[\w-]+)/g)) {
                if (!defined.has(m[1]) && !m[1].startsWith('--hud-')) missing.add(m[1]);
            }
        }
        expect([...missing]).toEqual([]);
    });
});
