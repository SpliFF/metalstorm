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
 * From U4 the widget also owns an open/closed state — it is SUMMONED with `/`
 * and puts nothing in the DOM until it is — so the summon behaviour is
 * exercised for real under happy-dom below. The interpretation it shows once
 * open belongs to `ui/native-ui/nl-interpretation.test.ts`; what only this file
 * can check is that the resting HUD is empty and that one key changes that.
 */

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
        // NO title, from U4 (DESIGN-DRILLDOWN.md §7). A title is what makes the
        // loader wrap a widget in panel chrome, and a permanent "Command ▾"
        // header at bottom-centre is precisely the resident panel this step was
        // asked to remove. It is summoned instead.
        expect(entry.title).toBeUndefined();
    });

    it('exposes the summonable contract the loader registers', async () => {
        // `open`/`close`/`isOpen` are how an untitled widget stays addressable
        // by name ("open the command console") without a second alias table in
        // the client — see widget-loader `registerSummonActions`.
        const widget = (await import('./command-console.js')).default;
        expect(typeof widget.open).toBe('function');
        expect(typeof widget.close).toBe('function');
        expect(typeof widget.isOpen).toBe('function');

        const loader = readFileSync(
            join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'native-ui', 'widget-loader.ts'),
            'utf8',
        );
        expect(loader).toContain('registerSummonActions');
    });

    it('registers window.test.nl on init and removes it on dispose', async () => {
        // The spring-debug `nl_command` tool PARSES an utterance into an
        // envelope but cannot run one; this hook is the execute half, and it
        // must be the console's own path (same envelope, same executor) rather
        // than a second entry point that could drift from it.
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const harness: Record<string, unknown> = {};
        (window as unknown as { test?: unknown }).test = harness;
        const mount = document.createElement('div');
        document.body.append(mount);
        const widget = (await import('./command-console.js')).default as {
            init: (ctx: unknown) => void; dispose: () => void;
        };
        try {
            widget.init({
                store: {
                    getSelection: () => ({ unitIds: [] }), getOrgGroups: () => [],
                    getDirectives: () => [], subscribe: () => () => {},
                },
                mount, identity: { playerId: 0, teamId: 0, accountId: 0 },
                sendCommand: () => {},
            });
            expect(typeof harness.nl).toBe('function');
            // The hook is a plain forward: it hands back `runUtteranceText`'s
            // own promise (which the console path resolves with nothing), so
            // awaiting the hook awaits the sentence.
            await expect((harness.nl as (u: string) => Promise<unknown>)('scout north'))
                .resolves.toBeUndefined();
        } finally {
            widget.dispose();
            mount.remove();
            delete (window as unknown as { test?: unknown }).test;
        }
        expect(harness.nl).toBeUndefined();
    });

    it('RETIRES the command composer — the last resident bottom-centre panel', () => {
        // DESIGN-DRILLDOWN §7 files `[VERB][SUBJECT][TARGET][WHEN]` + a
        // priority slider under RETIRE: it is the spreadsheet the directive
        // rejects, and this step is what replaces it. Nothing else would catch
        // it coming back.
        const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
        const ids = manifest.widgets.map((w: { id: string }) => w.id);
        expect(ids).not.toContain('command-composer');

        // ... and the command line is the ONLY thing that may mount at the
        // bottom, since it is absent from the DOM until summoned.
        const bottom = manifest.widgets
            .filter((w: { mount: string }) => w.mount.startsWith('bottom'))
            .map((w: { id: string }) => w.id);
        expect(bottom).toEqual(['command-console']);
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
     * U4: the resting HUD, and the one key that changes it.
     *
     * Run against a real DOM because the claim is about the DOM: "nothing is
     * mounted" is not something a source grep can establish, and it is the
     * whole verdict §7 gives this widget.
     */
    describe('summoning', () => {
        let mount: HTMLElement;
        let widget: {
            init: (ctx: unknown) => void; dispose: () => void;
            open?: () => void; close?: () => void; isOpen?: () => boolean;
        };

        const ctx = () => ({
            store: {
                getSelection: () => ({ unitIds: [] }),
                getOrgGroups: () => [],
                getDirectives: () => [],
                subscribe: () => () => {},
            },
            mount,
            identity: { playerId: 0, teamId: 0, accountId: 0 },
            sendCommand: () => {},
        });

        const press = (code: string, key = code) => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                code, key, bubbles: true, cancelable: true,
            }));
            window.dispatchEvent(new KeyboardEvent('keydown', {
                code, key, bubbles: true, cancelable: true,
            }));
        };

        beforeEach(async () => {
            vi.spyOn(console, 'log').mockImplementation(() => {});
            mount = document.createElement('div');
            document.body.append(mount);
            widget = (await import('./command-console.js')).default as typeof widget;
            widget.init(ctx());
        });

        afterEach(() => {
            widget.dispose();
            mount.remove();
            vi.restoreAllMocks();
        });

        it('mounts NOTHING — the resting HUD has no command line in it', () => {
            expect(mount.childElementCount).toBe(0);
            expect(widget.isOpen!()).toBe(false);
        });

        it.each(['Slash', 'NumpadDivide'])(
            '`/` (%s) builds it, focuses the field and greets once', (code) => {
            press(code, '/');
            const console_ = mount.querySelector('.command-console');
            expect(console_).not.toBeNull();
            expect(widget.isOpen!()).toBe(true);
            expect(document.activeElement).toBe(mount.querySelector('#cc-input'));
            expect(mount.querySelectorAll('.cc-line--system')).toHaveLength(1);
        });

        it('Esc dismisses it and the transcript survives', () => {
            press('Slash', '/');
            press('Escape', 'Escape');
            expect(widget.isOpen!()).toBe(false);
            expect(mount.querySelector('.command-console')!.classList)
                .toContain('command-console--hidden');

            // Summoning again picks the conversation back up rather than
            // starting a new one — the greeting is not repeated.
            press('Slash', '/');
            expect(mount.querySelectorAll('.cc-line--system')).toHaveLength(1);
        });

        it('does not steal `/` from a text field', () => {
            press('Slash', '/');
            const input = mount.querySelector('#cc-input') as HTMLInputElement;
            input.dispatchEvent(new KeyboardEvent('keydown', {
                code: 'Slash', key: '/', bubbles: true, cancelable: true,
            }));
            // Typing a slash into an order must type a slash.
            expect(widget.isOpen!()).toBe(true);
        });

        it('leaves Escape alone while closed, so Esc still means quit', () => {
            const event = new KeyboardEvent('keydown', {
                code: 'Escape', key: 'Escape', bubbles: true, cancelable: true,
            });
            window.dispatchEvent(event);
            // Not consumed: main.ts's quit-to-lobby handler is downstream of
            // this one, and a command line that is not open has no business
            // swallowing the key (drilldown.ts and global-surface.ts make the
            // same promise).
            expect(event.defaultPrevented).toBe(false);
        });

        it('teardown removes the DOM and the key binding', () => {
            press('Slash', '/');
            widget.dispose();
            expect(mount.childElementCount).toBe(0);
            press('Slash', '/');
            expect(mount.childElementCount).toBe(0);
        });
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
            // where unavailable"). Two guards now, because U4 moved the BUTTON
            // into the summoned DOM while the KEY stays bound at init: the
            // detect gates `state.voice`, and `state.voice` gates the button.
            expect(source).toContain('if (!isVoiceCaptureAvailable()) return;');
            expect(source).toContain('if (!state.voice || state.voice.mic) return;');
        });

        it('a hold SUMMONS the command line, so dictation is visible', () => {
            // Words being recognised into a hidden field are words the player
            // cannot correct before they execute — the same argument the
            // confirm gate makes one layer up.
            const hold = source.slice(source.indexOf('function beginHold()'));
            expect(hold.slice(0, hold.indexOf('}'))).toContain('summon(');
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
