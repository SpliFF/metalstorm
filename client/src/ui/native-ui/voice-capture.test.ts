/**
 * voice-capture.test.ts — push-to-talk, with the speech backend mocked
 * (PLAN-metalstorm-command-language.md §4, milestone M6)
 *
 * Four claims, and they are the four the plan makes about voice:
 *
 *  1. **A spoken sentence is the typed sentence.** The final transcript runs
 *     through `runLocalUtterance` and produces byte-identical console lines and
 *     an identical compiled command to the same words typed. Not "similar" —
 *     identical, because the whole design is that voice sets the input field and
 *     calls the same `submit()`.
 *  2. **Cancel discards.** Esc during a hold submits nothing, and a final that
 *     lands after the cancel (which it can — `stop()` doesn't un-queue a result
 *     already in flight) is discarded rather than executed.
 *  3. **The mic is never open unheld.** `start()` happens on press and nowhere
 *     else; release, cancel, error and dispose all `stop()`.
 *  4. **No API ⇒ no mic, no error.** Feature detection is a plain answer, and
 *     the port constructor returns null rather than throwing.
 *
 * The whole file runs in the node suite: `createPushToTalk` takes its port and
 * its timers as deps and touches no DOM, which is why the cancel semantics are
 * testable at all rather than only observable in a browser.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    createPushToTalk, createWebSpeechVoicePort, createSpeechOutPort,
    isVoiceCaptureAvailable, isSpeakEnabled, readPushToTalkCode, isTextEntryTarget,
    describeSpeechError,
    DEFAULT_PTT_CODE, PTT_KEY_STORAGE,
    type VoicePort, type VoiceError, type PushToTalkState,
} from './voice-capture.js';
import { runLocalUtterance } from './nl-client.js';
import type { NLConsoleLine, NLSentCommand } from './nl-executor.js';
import { buildFixtureWorld } from './nl-fixtures/fixture-world.js';
import { loadContexts, loadVocabulary } from './nl-fixtures/load-fixtures.test-support.js';

// ───────────────────────── the mocked backend ─────────────────────────

/**
 * A `VoicePort` the test drives by hand. It records start/stop the way the real
 * one would open and close a microphone, so "never listening when the key is not
 * held" is checkable as a call sequence rather than as an assertion about audio.
 */
function mockPort() {
    const interim = new Set<(t: string) => void>();
    const final = new Set<(t: string) => void>();
    const errors = new Set<(e: VoiceError) => void>();
    const calls: string[] = [];
    let open = false;

    const port: VoicePort = {
        backend: 'web-speech',
        start() { calls.push('start'); open = true; },
        stop() { calls.push('stop'); open = false; },
        onInterim(cb) { interim.add(cb); return () => interim.delete(cb); },
        onFinal(cb) { final.add(cb); return () => final.delete(cb); },
        onError(cb) { errors.add(cb); return () => errors.delete(cb); },
        dispose() { calls.push('dispose'); open = false; },
    };

    return {
        port,
        calls,
        get open() { return open; },
        /** The backend produced a partial transcript. */
        say(text: string) { for (const cb of [...interim]) cb(text); },
        /** The backend settled a segment. */
        settle(text: string) { for (const cb of [...final]) cb(text); },
        fail(err: VoiceError) { for (const cb of [...errors]) cb(err); },
    };
}

/** A push-to-talk with hand-driven timers, so the settle window is exercised
 *  deterministically instead of by sleeping. */
function harness(overrides: Partial<Parameters<typeof createPushToTalk>[0]> = {}) {
    const backend = mockPort();
    const submitted: string[] = [];
    const interims: string[] = [];
    const states: PushToTalkState[] = [];
    const cancels: number[] = [];
    const empties: number[] = [];
    const errors: VoiceError[] = [];
    let pendingTimer: (() => void) | null = null;

    const ptt = createPushToTalk({
        port: backend.port,
        onSubmit: (t) => submitted.push(t),
        onInterim: (t) => interims.push(t),
        onState: (s) => states.push(s),
        onCancel: () => cancels.push(1),
        onEmpty: () => empties.push(1),
        onError: (e) => errors.push(e),
        setTimer: (fn) => { pendingTimer = fn; return 1; },
        clearTimer: () => { pendingTimer = null; },
        ...overrides,
    });

    return {
        ptt, backend, submitted, interims, states, cancels, empties, errors,
        /** Fire the settle-window timeout. */
        elapse() { const fn = pendingTimer; pendingTimer = null; fn?.(); },
        get timerPending() { return pendingTimer !== null; },
    };
}

// ───────────────────────── 1. voice === typed ─────────────────────────

const vocabulary = loadVocabulary();
const contexts = loadContexts();

/** One sentence through the real local path, exactly as the console runs it. */
function runThroughNlClient(utterance: string) {
    const world = buildFixtureWorld(contexts.basin, vocabulary);
    const sent: NLSentCommand[] = [];
    const lines: NLConsoleLine[] = [];
    const result = runLocalUtterance(utterance, {
        index: world.index,
        vocabulary,
        selectionGroupId: world.deps.selectionGroupId ?? null,
        groupLabel: (id: number) => world.groups.find((g) => g.groupId === id)?.name ?? `Group ${id}`,
        ports: {
            sendCommand: (cmd: unknown) => sent.push(cmd as NLSentCommand),
            resolver: world.resolver,
            console: { say: (line: NLConsoleLine) => lines.push(line) },
        },
    });
    return { sent, lines, response: result.response, report: result.report };
}

describe('a spoken sentence takes the typed sentence\'s path', () => {
    const utterances = [
        'Chimera Squad defend Northgate',
        'attack Slag Forge urgent',
        'defend Northgate when under attack',
    ];

    for (const utterance of utterances) {
        it(`"${utterance}" — the released transcript reaches nl-client identically to typed input`, () => {
            const h = harness();

            // The spoken half: hold, speak, release. What the state machine
            // hands over is the ONLY thing voice contributes.
            h.ptt.press();
            h.backend.say(utterance.slice(0, 8));
            h.backend.settle(utterance);
            h.ptt.release();

            expect(h.submitted).toEqual([utterance]);

            // …and that string, run through the console's actual path, is
            // indistinguishable from the same words typed.
            const spoken = runThroughNlClient(h.submitted[0]!);
            const typed = runThroughNlClient(utterance);

            expect(spoken.response).toEqual(typed.response);
            expect(spoken.sent).toEqual(typed.sent);
            expect(spoken.lines).toEqual(typed.lines);
            // Not vacuous: the sentence really did execute.
            expect(typed.sent.length).toBeGreaterThan(0);
        });
    }

    it('submits the settled segments, not the interim that was still changing', () => {
        const h = harness();
        h.ptt.press();
        h.backend.say('defend north');
        h.backend.settle('defend Northgate');
        h.ptt.release();
        expect(h.submitted).toEqual(['defend Northgate']);
    });

    it('joins multiple settled segments from one hold into one sentence', () => {
        const h = harness();
        h.ptt.press();
        h.backend.settle('Chimera Squad defend Northgate');
        h.backend.settle('when under attack');
        h.ptt.release();
        expect(h.submitted).toEqual(['Chimera Squad defend Northgate when under attack']);
    });

    it('waits out the settle window for a final that arrives after release', () => {
        const h = harness();
        h.ptt.press();
        h.backend.say('defend Northgate');
        h.ptt.release();

        // Nothing submitted yet — the backend has not settled.
        expect(h.submitted).toEqual([]);
        expect(h.ptt.state).toBe('settling');

        h.backend.settle('defend Northgate');
        expect(h.submitted).toEqual(['defend Northgate']);
        // The pending timeout must not fire a second submit behind it.
        h.elapse();
        expect(h.submitted).toEqual(['defend Northgate']);
    });

    it('falls back to the last interim when no final ever arrives', () => {
        // The truncation guard: the words the player watched appear are the
        // words that execute, even from a backend that never settles.
        const h = harness();
        h.ptt.press();
        h.backend.say('defend');
        h.backend.say('defend Northgate');
        h.ptt.release();
        h.elapse();
        expect(h.submitted).toEqual(['defend Northgate']);
    });

    it('reports an empty hold instead of submitting an empty utterance', () => {
        const h = harness();
        h.ptt.press();
        h.ptt.release();
        h.elapse();
        expect(h.submitted).toEqual([]);
        expect(h.empties).toEqual([1]);
    });
});

// ───────────────────────── 2. cancel discards ─────────────────────────

describe('cancel discards', () => {
    it('Esc during a hold submits nothing and closes the mic', () => {
        const h = harness();
        h.ptt.press();
        h.backend.say('move 2 tank squads to Northgate');

        h.ptt.cancel();

        expect(h.submitted).toEqual([]);
        expect(h.cancels).toEqual([1]);
        expect(h.ptt.state).toBe('off');
        expect(h.backend.open).toBe(false);
        expect(h.backend.calls).toEqual(['start', 'stop']);
    });

    it('a final that lands AFTER the cancel is discarded, not executed', () => {
        // The race this whole generation counter exists for: `stop()` cannot
        // un-queue a result the backend already dispatched.
        const h = harness();
        h.ptt.press();
        h.backend.say('attack Slag Forge');
        h.ptt.cancel();

        h.backend.settle('attack Slag Forge');

        expect(h.submitted).toEqual([]);
        expect(h.ptt.state).toBe('off');
    });

    it('a cancel during the settle window discards the words already captured', () => {
        const h = harness();
        h.ptt.press();
        h.backend.say('attack Slag Forge');
        h.ptt.release();
        expect(h.ptt.state).toBe('settling');

        h.ptt.cancel();
        h.elapse();

        expect(h.submitted).toEqual([]);
        expect(h.cancels).toEqual([1]);
    });

    it('cancel with nothing held does nothing at all', () => {
        const h = harness();
        h.ptt.cancel();
        expect(h.cancels).toEqual([]);
        expect(h.backend.calls).toEqual([]);
    });

    it('the next hold starts from empty — a cancelled sentence never leaks forward', () => {
        const h = harness();
        h.ptt.press();
        h.backend.say('attack Slag Forge');
        h.ptt.cancel();

        h.ptt.press();
        h.backend.settle('defend Northgate');
        h.ptt.release();

        expect(h.submitted).toEqual(['defend Northgate']);
    });
});

// ───────────────────────── 3. never listening unheld ─────────────────────────

describe('the microphone is open only while the key is held', () => {
    it('start() happens on press and nowhere else', () => {
        const h = harness();
        // Constructing the machine subscribes; it must not open anything.
        expect(h.backend.calls).toEqual([]);
        expect(h.backend.open).toBe(false);

        h.ptt.press();
        expect(h.backend.calls).toEqual(['start']);
        expect(h.backend.open).toBe(true);
    });

    it('a second press while already listening does not open a second session', () => {
        const h = harness();
        h.ptt.press();
        h.ptt.press();
        h.ptt.press();
        expect(h.backend.calls).toEqual(['start']);
    });

    it('release closes the port immediately — the settle window is not live audio', () => {
        const h = harness();
        h.ptt.press();
        h.ptt.release();
        expect(h.backend.open).toBe(false);
        expect(h.backend.calls).toEqual(['start', 'stop']);
        // …and the state is not `listening`, so the widget cannot render a hot
        // mic over a closed microphone.
        expect(h.ptt.state).toBe('settling');
    });

    it('interim results arriving after release are ignored', () => {
        const h = harness();
        h.ptt.press();
        h.backend.say('defend Northgate');
        h.ptt.release();
        h.backend.say('defend Northgate and attack everything');
        h.elapse();
        expect(h.submitted).toEqual(['defend Northgate']);
    });

    it('a backend error ends the hold and closes the port', () => {
        const h = harness();
        h.ptt.press();
        h.backend.fail({ kind: 'not-allowed', message: 'The browser blocked the microphone.' });

        expect(h.ptt.state).toBe('off');
        expect(h.backend.open).toBe(false);
        expect(h.errors).toHaveLength(1);
        expect(h.errors[0]!.kind).toBe('not-allowed');
        expect(h.submitted).toEqual([]);
    });

    it('an error during the settle window keeps the sentence the player saw', () => {
        // Chromium reports an error for some stop paths; the words were already
        // captured and shown, so losing them would be the console lying about
        // what it heard.
        const h = harness();
        h.ptt.press();
        h.backend.say('defend Northgate');
        h.ptt.release();
        h.backend.fail({ kind: 'other', message: 'Speech input failed (aborted).' });

        expect(h.submitted).toEqual(['defend Northgate']);
        expect(h.errors).toEqual([]);
    });

    it('dispose cancels a live hold and disposes the port', () => {
        const h = harness();
        h.ptt.press();
        h.ptt.dispose();
        expect(h.backend.calls).toEqual(['start', 'stop', 'dispose']);
        expect(h.submitted).toEqual([]);
        // A disposed machine cannot be re-opened by a stray key event.
        h.ptt.press();
        expect(h.backend.calls).toEqual(['start', 'stop', 'dispose']);
    });

    it('reports `listening` exactly once per hold, and never after release', () => {
        const h = harness();
        h.ptt.press();
        h.backend.settle('defend Northgate');
        h.ptt.release();
        expect(h.states.filter((s) => s === 'listening')).toHaveLength(1);
        expect(h.states[h.states.length - 1]).toBe('off');
    });
});

// ───────────────────────── 4. no API ⇒ no mic ─────────────────────────

describe('a browser with no speech API', () => {
    it('reports the feature as unavailable', () => {
        expect(isVoiceCaptureAvailable({})).toBe(false);
        expect(isVoiceCaptureAvailable(undefined)).toBe(false);
    });

    it('returns no port rather than throwing — the widget renders no mic', () => {
        expect(() => createWebSpeechVoicePort({ win: {} })).not.toThrow();
        expect(createWebSpeechVoicePort({ win: {} })).toBeNull();
    });

    it('detects either spelling of the API', () => {
        const Ctor = function () { } as unknown as new () => never;
        expect(isVoiceCaptureAvailable({ webkitSpeechRecognition: Ctor })).toBe(true);
        expect(isVoiceCaptureAvailable({ SpeechRecognition: Ctor })).toBe(true);
    });
});

describe('the Web Speech port', () => {
    /** The minimum of Chromium's SpeechRecognition the port actually uses. */
    function fakeRecognition() {
        const rec = {
            lang: '', continuous: false, interimResults: false, maxAlternatives: 0,
            started: 0, stopped: 0, aborted: 0,
            onresult: null as ((e: unknown) => void) | null,
            onerror: null as ((e: unknown) => void) | null,
            onend: null as (() => void) | null,
            onstart: null as (() => void) | null,
            start() { this.started++; this.onstart?.(); },
            stop() { this.stopped++; },
            abort() { this.aborted++; this.onend?.(); },
        };
        return rec;
    }

    function portWith(rec: ReturnType<typeof fakeRecognition>) {
        let built = 0;
        const win = { webkitSpeechRecognition: function () { built++; return rec; } as unknown as new () => never };
        return { port: createWebSpeechVoicePort({ win, lang: 'en-GB' })!, get built() { return built; } };
    }

    /** Chromium's cumulative `results` list, as one event delivers it. */
    function resultEvent(index: number, entries: { text: string; isFinal: boolean }[]) {
        const results: Record<number, unknown> & { length: number } = { length: entries.length };
        entries.forEach((e, i) => { results[i] = { isFinal: e.isFinal, length: 1, 0: { transcript: e.text } }; });
        return { resultIndex: index, results };
    }

    it('constructs nothing — and so prompts for no permission — until start()', () => {
        const rec = fakeRecognition();
        const p = portWith(rec);
        expect(p.built).toBe(0);
        p.port.start();
        expect(p.built).toBe(1);
        expect(rec.started).toBe(1);
        // Continuous + interim: one hold is one session, streamed.
        expect(rec.continuous).toBe(true);
        expect(rec.interimResults).toBe(true);
        expect(rec.lang).toBe('en-GB');
    });

    it('splits an event into interim and final callbacks', () => {
        const rec = fakeRecognition();
        const p = portWith(rec);
        const interim: string[] = [];
        const final: string[] = [];
        p.port.onInterim((t) => interim.push(t));
        p.port.onFinal((t) => final.push(t));
        p.port.start();

        rec.onresult!(resultEvent(0, [{ text: 'defend north', isFinal: false }]));
        rec.onresult!(resultEvent(0, [{ text: 'defend Northgate', isFinal: true }]));

        expect(interim).toEqual(['defend north']);
        expect(final).toEqual(['defend Northgate']);
    });

    it('emits only the segments an event introduced', () => {
        // `results` is cumulative; re-emitting settled entries would make the
        // interim line stutter backwards over words already accepted.
        const rec = fakeRecognition();
        const p = portWith(rec);
        const final: string[] = [];
        p.port.onFinal((t) => final.push(t));
        p.port.start();

        rec.onresult!(resultEvent(0, [{ text: 'defend Northgate', isFinal: true }]));
        rec.onresult!(resultEvent(1, [
            { text: 'defend Northgate', isFinal: true },
            { text: 'when under attack', isFinal: true },
        ]));

        expect(final).toEqual(['defend Northgate', 'when under attack']);
    });

    it('stop() aborts, so the microphone closes now rather than after the service replies', () => {
        const rec = fakeRecognition();
        const p = portWith(rec);
        p.port.start();
        p.port.stop();
        expect(rec.aborted).toBe(1);
    });

    it('does not report our own abort as a failure', () => {
        const rec = fakeRecognition();
        const p = portWith(rec);
        const errors: VoiceError[] = [];
        p.port.onError((e) => errors.push(e));
        p.port.start();

        rec.onerror!({ error: 'aborted' });
        expect(errors).toEqual([]);

        rec.onerror!({ error: 'not-allowed' });
        expect(errors).toHaveLength(1);
        expect(errors[0]!.kind).toBe('not-allowed');
    });

    it('a start() that throws becomes a stated refusal, not an exception', () => {
        const rec = fakeRecognition();
        rec.start = () => { throw new Error('recognition already started'); };
        const p = portWith(rec);
        const errors: VoiceError[] = [];
        p.port.onError((e) => errors.push(e));

        expect(() => p.port.start()).not.toThrow();
        expect(errors).toHaveLength(1);
        expect(errors[0]!.message).toMatch(/already started/);
    });

    it('a second start() while listening does not open a second session', () => {
        const rec = fakeRecognition();
        const p = portWith(rec);
        p.port.start();
        p.port.start();
        expect(rec.started).toBe(1);
    });
});

describe('error copy names what the player can do', () => {
    it.each([
        ['not-allowed', /Allow it for this site/],
        ['service-not-allowed', /Allow it for this site/],
        ['no-speech', /didn't hear anything/],
        ['network', /type the order instead/],
        ['audio-capture', /No microphone/],
        ['weird-new-code', /weird-new-code/],
    ])('%s', (code, expected) => {
        expect(describeSpeechError(code).message).toMatch(expected);
    });
});

// ───────────────────────── the binding + the flag ─────────────────────────

describe('the push-to-talk key', () => {
    it('defaults to KeyV — a physical key nothing else in the game binds', () => {
        expect(DEFAULT_PTT_CODE).toBe('KeyV');
        expect(readPushToTalkCode({ getItem: () => null })).toBe('KeyV');
    });

    it('honours a rebind', () => {
        expect(readPushToTalkCode({ getItem: (k) => (k === PTT_KEY_STORAGE ? 'KeyB' : null) })).toBe('KeyB');
    });

    it('ignores a stored value that is a character rather than a code', () => {
        // "v" would never equal `event.code` and would silently disable voice —
        // a binding that does nothing is worse than the default.
        expect(readPushToTalkCode({ getItem: () => 'v' })).toBe('KeyV');
        expect(readPushToTalkCode({ getItem: () => '' })).toBe('KeyV');
        expect(readPushToTalkCode({ getItem: () => { throw new Error('denied'); } })).toBe('KeyV');
    });

    it('never opens the mic from inside a text field', () => {
        expect(isTextEntryTarget({ tagName: 'INPUT' })).toBe(true);
        expect(isTextEntryTarget({ tagName: 'textarea' })).toBe(true);
        expect(isTextEntryTarget({ isContentEditable: true })).toBe(true);
        expect(isTextEntryTarget({ tagName: 'CANVAS' })).toBe(false);
        expect(isTextEntryTarget(null)).toBe(false);
    });
});

describe('spoken responses are off unless the flag is set', () => {
    it('reads the flag', () => {
        expect(isSpeakEnabled({ getItem: () => null })).toBe(false);
        expect(isSpeakEnabled({ getItem: () => '0' })).toBe(false);
        expect(isSpeakEnabled({ getItem: () => '1' })).toBe(true);
    });

    it('a disabled speaker is a silent no-op, not a branch every caller makes', () => {
        const speak = vi.fn();
        const port = createSpeechOutPort({
            synth: { speak, cancel: vi.fn() },
            utteranceCtor: class { constructor(public text: string) { } },
            storage: { getItem: () => null },
        });
        expect(port.enabled).toBe(false);
        port.speak('you have six heavy tanks left');
        expect(speak).not.toHaveBeenCalled();
    });

    it('an enabled speaker cancels the previous line before speaking the next', () => {
        const speak = vi.fn();
        const cancel = vi.fn();
        const port = createSpeechOutPort({
            synth: { speak, cancel },
            utteranceCtor: class { constructor(public text: string) { } },
            storage: { getItem: () => '1' },
        });
        expect(port.enabled).toBe(true);
        port.speak('you have six heavy tanks left');
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(speak).toHaveBeenCalledTimes(1);
        expect((speak.mock.calls[0]![0] as { text: string }).text).toBe('you have six heavy tanks left');

        port.speak('   ');                  // nothing to say
        expect(speak).toHaveBeenCalledTimes(1);
    });

    it('stays disabled when the flag is on but the browser has no synthesis', () => {
        const port = createSpeechOutPort({ synth: undefined, storage: { getItem: () => '1' } });
        expect(port.enabled).toBe(false);
        expect(() => port.speak('anything')).not.toThrow();
    });
});
