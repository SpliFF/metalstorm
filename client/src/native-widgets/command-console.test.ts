/**
 * command-console.test.ts — widget contract for the NL command console
 * (PLAN-metalstorm-command-language.md §4)
 *
 * The console's BEHAVIOUR is tested in `ui/native-ui/console-exchange.test.ts`
 * — that is the whole point of keeping the widget dumb. What is left to check
 * here is the loader contract (the widget-loader mounts `default.init(ctx)`
 * and tears down with `dispose()`), plus the manifest wiring that decides
 * whether it ever mounts at all: `builtin` (it imports bundled native-ui
 * modules and cannot be fetched as a standalone game-dir module) and
 * `hideForSpectator` (it issues orders).
 *
 * There is no DOM environment in this suite (no jsdom/happy-dom installed —
 * see command-composer.test.ts), so mount/render is verified live in the
 * browser rather than faked here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MANIFEST_PATH = join(
    dirname(fileURLToPath(import.meta.url)), '..', '..', '..',
    'data', 'games', 'metalstorm', 'ui', 'metalstorm.ui.json',
);

describe('command-console widget', () => {
    it('exports the widget interface the loader requires', async () => {
        const module = await import('./command-console.js');
        const widget = module.default;

        expect(widget).toBeDefined();
        expect(widget.id).toBe('command-console');
        expect(typeof widget.init).toBe('function');
        expect(typeof widget.dispose).toBe('function');
    });

    it('is declared in the Metalstorm manifest as a spectator-hidden built-in', () => {
        const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
        const entry = manifest.widgets.find((w: { id: string }) => w.id === 'command-console');

        expect(entry).toBeDefined();
        // Built-in: it statically imports bundled native-ui modules, so the
        // loader must take it from BUILTIN_WIDGETS, not fetch it from the
        // game dir.
        expect(entry.builtin).toBe(true);
        // Order-issuing panel ⇒ never mounted for a spectator session.
        expect(entry.hideForSpectator).toBe(true);
        expect(entry.mount).toBe('bottom-center');
        expect(entry.title).toBeTruthy();
    });

    it('is registered in BUILTIN_WIDGETS under its manifest id', async () => {
        // A `builtin: true` entry with no registry entry mounts nothing and
        // only logs — the two lists must agree.
        const source = readFileSync(
            join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'native-ui', 'widget-loader.ts'),
            'utf8',
        );
        expect(source).toContain("'command-console': () => import('../../native-widgets/command-console.js')");
    });

    /**
     * M6 voice. The state machine and the port are tested properly in
     * `ui/native-ui/voice-capture.test.ts`; what only this file can check is the
     * WIRING, and both facts below are ones a refactor could quietly break with
     * every other test still green.
     */
    describe('push-to-talk wiring', () => {
        const source = readFileSync(
            join(dirname(fileURLToPath(import.meta.url)), 'command-console.js'), 'utf8',
        );

        it('creates the mic only behind the feature detect', () => {
            // An unavailable API must produce NO button — not a disabled one, not
            // a hidden one in the tab order (§4 "hide the mic affordance cleanly
            // where unavailable"). The early return is the whole guarantee.
            expect(source).toContain('if (!isVoiceCaptureAvailable()) return;');
            const guardAt = source.indexOf('if (!isVoiceCaptureAvailable()) return;');
            const micAt = source.indexOf("document.createElement('button')");
            expect(guardAt).toBeGreaterThan(-1);
            expect(micAt).toBeGreaterThan(guardAt);
        });

        it('submits a spoken sentence through the typed sentence\'s function', () => {
            // The one line that makes voice an input method rather than a second
            // parser: it sets the same field and calls the same submit().
            const onSubmit = source.slice(source.indexOf('onSubmit: (transcript)'));
            expect(onSubmit).toContain('state.inputEl.value = transcript');
            expect(onSubmit.slice(0, onSubmit.indexOf('onEmpty'))).toContain('void submit()');
        });
    });
});
