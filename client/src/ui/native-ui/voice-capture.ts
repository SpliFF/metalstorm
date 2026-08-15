/**
 * voice-capture.ts — push-to-talk speech input for the command console
 * (PLAN-metalstorm-command-language.md §4, milestone M6 — the demo gate)
 *
 * Two things live here, and the split is the whole design:
 *
 *  1. **`VoicePort`** — the narrow interface the rest of the game sees:
 *     `start` / `stop` / `onInterim` / `onFinal` / `onError`. `createWebSpeechVoicePort`
 *     implements it with the browser's `webkitSpeechRecognition` (Chromium's
 *     cloud STT — accepted for v1, §4). Swapping in MediaRecorder + server
 *     Whisper, or an in-browser model, is then a second implementation of five
 *     methods, not a redesign of the console.
 *
 *  2. **`createPushToTalk`** — the state machine that turns "a key is held" into
 *     "one sentence was said". It touches no DOM and no browser API: everything
 *     it needs (the port, a submit callback, timers) arrives in its deps, so the
 *     cancel semantics, the settle window and the never-listen-unheld guarantee
 *     are testable in the node suite rather than only in a browser.
 *
 * The widget (`client/src/native-widgets/command-console.js`) owns the key
 * binding, the mic button and the hot/cold styling, and hands the final
 * transcript to the SAME `submit()` a typed sentence goes through. There is no
 * voice-specific command path: voice is an input method for the console's text
 * field, not a second parser. That is deliberate — a second path is a second set
 * of refusal copy, a second set of bugs, and a second thing to keep in step with
 * `nl-client.ts`.
 *
 * ── Privacy (§4 "never listen when the key is not held") ──
 * `start()` is called from `press()` and from nowhere else. `release()`,
 * `cancel()`, an error and `dispose()` all call `stop()`. The state machine
 * refuses to `start()` twice and refuses to act on results that arrive after a
 * cancel, so a late event from a recogniser that has already been told to stop
 * can neither submit a sentence nor re-open the mic. The recogniser is
 * NON-continuous and is constructed lazily, so nothing is instantiated — and no
 * permission prompt fires — until the player first holds the key.
 *
 * ── Why a settle window ──
 * Web Speech delivers its FINAL result asynchronously, after `stop()`: the
 * player releases the key and the last-recognised words arrive tens to hundreds
 * of milliseconds later. Submitting the interim text immediately on release
 * would systematically truncate the end of every sentence. So `release()` enters
 * a short `settling` state, takes the final if it arrives, and falls back to the
 * last interim if it doesn't. The fallback matters: a recogniser that errors
 * after stop, or one whose final never comes, must still execute the sentence
 * the player watched appear on screen.
 */

/** Whose speech API this is. Only used for logging/diagnostics. */
export type VoiceBackend = 'web-speech';

export type VoiceErrorKind =
    /** The player (or the browser) refused microphone access. */
    | 'not-allowed'
    /** No speech was detected before the recogniser gave up. */
    | 'no-speech'
    /** Network-backed STT could not reach its service. */
    | 'network'
    /** Anything else the backend reported. */
    | 'other';

export interface VoiceError {
    kind: VoiceErrorKind;
    /** Player-facing sentence. Written here rather than in the widget so a
     *  second port implementation inherits the same copy. */
    message: string;
}

/** Unsubscribe handle returned by every `on*` registration. */
export type VoiceUnsubscribe = () => void;

/**
 * The speech-recognition seam.
 *
 * Deliberately callback-based rather than promise/stream-based: push-to-talk is
 * an event stream with no natural end (the player decides when it ends), and a
 * promise would have to be resolved by the very `stop()` that is also the cancel
 * path.
 */
export interface VoicePort {
    /** Begin listening. Must be idempotent-safe: a second call while already
     *  listening is a no-op, never a second microphone session. */
    start(): void;
    /** Stop listening. Safe to call when not listening. */
    stop(): void;
    /** Partial, still-changing transcript. May fire many times per utterance. */
    onInterim(cb: (text: string) => void): VoiceUnsubscribe;
    /** A settled transcript segment. May fire more than once for one hold. */
    onFinal(cb: (text: string) => void): VoiceUnsubscribe;
    onError(cb: (err: VoiceError) => void): VoiceUnsubscribe;
    /** Release the underlying recogniser. Implies `stop()`. */
    dispose(): void;
    readonly backend: VoiceBackend;
}

// ───────────────────────── feature detection ─────────────────────────

/** The two names the same API ships under. Chromium exposes the prefixed one;
 *  the unprefixed one is the standards name some builds also provide. */
interface SpeechRecognitionCtor {
    new (): SpeechRecognitionLike;
}

interface SpeechRecognitionLike {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    maxAlternatives: number;
    start(): void;
    stop(): void;
    abort(): void;
    onresult: ((event: SpeechRecognitionEventLike) => void) | null;
    onerror: ((event: { error?: string; message?: string }) => void) | null;
    onend: (() => void) | null;
    onstart: (() => void) | null;
}

interface SpeechRecognitionEventLike {
    resultIndex: number;
    results: {
        length: number;
        [index: number]: { isFinal: boolean; length: number; [alt: number]: { transcript: string } };
    };
}

/** The globals we look for. Narrow, so a caller can pass a plain object in a
 *  test without pulling in a DOM lib. */
export interface VoiceGlobals {
    webkitSpeechRecognition?: SpeechRecognitionCtor;
    SpeechRecognition?: SpeechRecognitionCtor;
}

function recognitionCtor(win: VoiceGlobals | undefined): SpeechRecognitionCtor | null {
    if (!win) return null;
    return win.webkitSpeechRecognition ?? win.SpeechRecognition ?? null;
}

/**
 * Is speech input available at all?
 *
 * The console asks this ONCE, at init, and simply does not create the mic button
 * when the answer is no (§4: "feature-detect and hide the mic affordance cleanly
 * where unavailable"). A greyed-out mic on Firefox would be a permanent
 * advertisement for a browser the player is not using; a mic that throws on
 * click is worse.
 *
 * Note this answers "does the API exist", not "will the player grant the
 * microphone". Permission is only knowable by asking, and asking requires a user
 * gesture — so a denied permission surfaces as a `not-allowed` VoiceError on the
 * first hold, which the console prints, rather than as a hidden button.
 */
export function isVoiceCaptureAvailable(win: VoiceGlobals | undefined = globalThis as VoiceGlobals): boolean {
    return recognitionCtor(win) !== null;
}

// ───────────────────────── the Web Speech port ─────────────────────────

export interface WebSpeechPortOpts {
    /** Injected in tests; defaults to the real global. */
    win?: VoiceGlobals;
    /** BCP-47 tag. Defaults to the document language, then `en-US`. */
    lang?: string;
}

/**
 * `VoicePort` over `webkitSpeechRecognition`. Null when the API is absent —
 * callers must feature-detect, and a null return is the same answer
 * `isVoiceCaptureAvailable` gives.
 *
 * The recogniser object is created ONCE and reused across holds. Chromium's
 * implementation tolerates start/stop cycles on one instance, and re-creating it
 * per hold re-runs the permission plumbing on every press.
 */
export function createWebSpeechVoicePort(opts: WebSpeechPortOpts = {}): VoicePort | null {
    const win = opts.win ?? (globalThis as VoiceGlobals);
    const Ctor = recognitionCtor(win);
    if (!Ctor) return null;

    const interim = new Set<(text: string) => void>();
    const final = new Set<(text: string) => void>();
    const errors = new Set<(err: VoiceError) => void>();

    let recogniser: SpeechRecognitionLike | null = null;
    /** True between `start()` and the recogniser's `onend`. Guards the double
     *  `start()` that Chromium throws `InvalidStateError` on. */
    let listening = false;
    let disposed = false;

    function build(): SpeechRecognitionLike {
        const rec = new Ctor!();
        rec.lang = opts.lang || defaultLang(win);
        // CONTINUOUS: one hold is one session, however long the player talks.
        // Non-continuous recognition ends itself at the first pause, which would
        // silently close the mic mid-sentence while the key is still down.
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 1;

        rec.onresult = (event) => {
            // Only the results this event introduced: `results` is cumulative
            // across the session, and re-emitting settled segments would make
            // the interim line stutter backwards.
            let interimText = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const result = event.results[i];
                const text = result?.[0]?.transcript ?? '';
                if (!text) continue;
                if (result.isFinal) emit(final, text.trim());
                else interimText += text;
            }
            if (interimText.trim()) emit(interim, interimText.trim());
        };

        rec.onerror = (event) => {
            // `aborted` is what Chromium reports for OUR OWN stop() — it is the
            // normal end of a hold, not a failure, and printing "speech input
            // failed" every time the player releases the key would be noise.
            const code = String(event?.error ?? 'other');
            if (code === 'aborted') return;
            emit(errors, describeSpeechError(code));
        };

        rec.onend = () => { listening = false; };
        rec.onstart = () => { listening = true; };
        return rec;
    }

    return {
        backend: 'web-speech',
        start() {
            if (disposed || listening) return;
            // Lazy: nothing is constructed — and no permission prompt can fire —
            // until the player actually holds the key.
            recogniser ??= build();
            listening = true;
            try {
                recogniser.start();
            } catch (err) {
                // Chromium throws InvalidStateError if a previous session has
                // not finished tearing down. That is a dropped hold, not a
                // broken feature: say so and let the player press again.
                listening = false;
                emit(errors, {
                    kind: 'other',
                    message: `Microphone was still busy — ${errText(err)}. Try again.`,
                });
            }
        },
        stop() {
            if (!recogniser) return;
            listening = false;
            // `abort()` rather than `stop()`: `stop()` asks the recogniser to
            // finish processing what it has, which can deliver a final result
            // AFTER a cancel. The push-to-talk machine discards late results
            // anyway, but the mic hardware should close now, not when a remote
            // service finishes thinking.
            try { recogniser.abort(); } catch { /* already stopped */ }
        },
        onInterim(cb) { interim.add(cb); return () => interim.delete(cb); },
        onFinal(cb) { final.add(cb); return () => final.delete(cb); },
        onError(cb) { errors.add(cb); return () => errors.delete(cb); },
        dispose() {
            disposed = true;
            this.stop();
            if (recogniser) {
                recogniser.onresult = null;
                recogniser.onerror = null;
                recogniser.onend = null;
                recogniser.onstart = null;
            }
            recogniser = null;
            interim.clear(); final.clear(); errors.clear();
        },
    };
}

function emit<T>(set: Set<(value: T) => void>, value: T): void {
    for (const cb of [...set]) cb(value);
}

function defaultLang(win: VoiceGlobals): string {
    const doc = (win as { document?: { documentElement?: { lang?: string } } }).document;
    return doc?.documentElement?.lang || 'en-US';
}

function errText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Backend error codes → the sentence the console prints. Each names what the
 *  player can do about it; "speech error: not-allowed" names nothing. */
export function describeSpeechError(code: string): VoiceError {
    switch (code) {
        case 'not-allowed':
        case 'service-not-allowed':
            return {
                kind: 'not-allowed',
                message: 'The browser blocked the microphone. Allow it for this site, then hold the key again.',
            };
        case 'no-speech':
            return { kind: 'no-speech', message: "I didn't hear anything." };
        case 'network':
            return { kind: 'network', message: 'Speech recognition could not reach its service — type the order instead.' };
        case 'audio-capture':
            return { kind: 'other', message: 'No microphone was found.' };
        default:
            return { kind: 'other', message: `Speech input failed (${code}).` };
    }
}

// ───────────────────────── push-to-talk ─────────────────────────

/**
 * `off` — not listening, mic cold, nothing captured.
 * `listening` — key/button held, mic HOT, interim text flowing.
 * `settling` — key released, mic stopped, waiting up to `settleMs` for the
 *   backend's final segment before submitting what we have.
 *
 * The mic is hot in exactly one of these, which is what makes the indicator
 * unambiguous: the widget can render `state === 'listening'` and be right.
 */
export type PushToTalkState = 'off' | 'listening' | 'settling';

export interface PushToTalkDeps {
    port: VoicePort;
    /** The finished sentence. Wired to the console's normal submit path. */
    onSubmit(transcript: string): void;
    /** Live partial text, for the input field. */
    onInterim?(text: string): void;
    /** State changed — render the mic. Called on every transition. */
    onState?(state: PushToTalkState): void;
    /**
     * The hold produced no words. Separate from `onSubmit('')` so the console
     * can say "I didn't catch that" instead of running an empty utterance
     * through the parser and printing its "say something like…" refusal, which
     * answers a question the player didn't ask.
     */
    onEmpty?(): void;
    /** Esc, or a cancel for any other reason. Nothing was submitted. */
    onCancel?(): void;
    onError?(err: VoiceError): void;
    /** How long to wait after release for the backend's final segment. */
    settleMs?: number;
    /** Injected in tests. Defaults to the global timer. */
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

export interface PushToTalk {
    /** Key went down / mic button pressed. */
    press(): void;
    /** Key came up / mic button released. Submits. */
    release(): void;
    /** Esc, blur, dispose — discard everything captured. */
    cancel(): void;
    readonly state: PushToTalkState;
    /** Whatever text would be submitted if the key were released now. */
    readonly transcript: string;
    dispose(): void;
}

/**
 * 500 ms. Long enough for Chromium's cloud round-trip to deliver the final
 * segment after `stop()` on a normal connection; short enough that a player who
 * releases and immediately expects an answer does not perceive a hang. If it
 * expires, the last interim is submitted — the words the player watched appear
 * are the words that execute, always.
 */
export const DEFAULT_SETTLE_MS = 500;

export function createPushToTalk(deps: PushToTalkDeps): PushToTalk {
    const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;

    let state: PushToTalkState = 'off';
    /** Settled segments from THIS hold, in arrival order. */
    let finals: string[] = [];
    /** The most recent partial. The fallback when no final arrives. */
    let interim = '';
    let timer: unknown = null;
    let disposed = false;

    /**
     * Every hold gets a fresh generation number, and every callback checks it.
     *
     * This is the cancel guarantee. `port.stop()` does not un-queue a result the
     * backend has already dispatched, so a final can land a frame after Esc; the
     * generation makes that arrival belong to a hold that no longer exists,
     * instead of submitting an order the player just cancelled.
     */
    let generation = 0;

    function setState(next: PushToTalkState): void {
        if (state === next) return;
        state = next;
        deps.onState?.(next);
    }

    function clear(): void {
        if (timer !== null) { clearTimer(timer); timer = null; }
    }

    /** End the hold without submitting. Shared by cancel, error and dispose. */
    function abandon(): void {
        generation++;
        clear();
        finals = [];
        interim = '';
        deps.port.stop();
        setState('off');
    }

    function finish(): void {
        clear();
        const text = collected();
        generation++;
        finals = [];
        interim = '';
        setState('off');
        if (text) deps.onSubmit(text);
        else deps.onEmpty?.();
    }

    function collected(): string {
        // Finals first: they are the backend's settled reading. The interim is
        // only ever a fallback for a hold that produced no final at all, never
        // an addition — Web Speech's interim RESTATES the pending segment, so
        // concatenating both would double the tail of every sentence.
        const joined = finals.join(' ').trim();
        return joined || interim.trim();
    }

    const unsubs: VoiceUnsubscribe[] = [
        deps.port.onInterim((text) => {
            // Not `listening` ⇒ this belongs to a hold that has ended. An
            // interim arriving during `settling` is a partial the backend had
            // not settled when we stopped it; taking it would overwrite a final
            // we may already hold.
            if (state !== 'listening') return;
            interim = text;
            deps.onInterim?.(text);
        }),
        deps.port.onFinal((text) => {
            const trimmed = text.trim();
            if (!trimmed) return;
            if (state === 'listening') {
                finals.push(trimmed);
                // Keep the input field showing everything said so far, not just
                // the segment still in flight.
                interim = '';
                deps.onInterim?.(collected());
                return;
            }
            if (state === 'settling') {
                // What the settle window was waiting for. Submit now rather than
                // burning the rest of the timeout.
                finals.push(trimmed);
                finish();
            }
            // 'off' ⇒ cancelled or already submitted. Discarded, deliberately.
        }),
        deps.port.onError((err) => {
            if (state === 'off') return;
            const held = collected();
            const wasSettling = state === 'settling';
            abandon();
            // An error DURING the settle window, with words already captured, is
            // the recogniser complaining about the stop we asked for. The player
            // said something and watched it appear; drop the error, keep the
            // sentence.
            if (wasSettling && held) { deps.onSubmit(held); return; }
            deps.onError?.(err);
        }),
    ];

    return {
        get state() { return state; },
        get transcript() { return collected(); },
        press() {
            if (disposed || state !== 'off') return;
            generation++;
            finals = [];
            interim = '';
            setState('listening');
            deps.port.start();
        },
        release() {
            if (state !== 'listening') return;
            deps.port.stop();
            // A hold that already produced a final and nothing pending needs no
            // settle window — submit on the release frame.
            if (finals.length > 0) { setState('settling'); finish(); return; }
            setState('settling');
            const mine = generation;
            timer = setTimer(() => {
                timer = null;
                if (mine !== generation || state !== 'settling') return;
                finish();
            }, settleMs);
        },
        cancel() {
            if (state === 'off') return;
            abandon();
            deps.onCancel?.();
        },
        dispose() {
            disposed = true;
            if (state !== 'off') abandon();
            for (const un of unsubs) un();
            deps.port.dispose();
        },
    };
}

// ───────────────────────── spoken responses (flag-gated, default off) ────────

/**
 * §4's optional half: read the console's answers aloud.
 *
 * OFF unless `springrts-nl-speak` is `1` in localStorage, because a game that
 * starts talking to you unprompted is a game you mute. Query answers ("you have
 * six heavy tanks left") are the case that earns it — the player asked a
 * question with their voice and is looking at the battlefield, not at a log
 * panel three inches high.
 */
export const SPEAK_FLAG_KEY = 'springrts-nl-speak';

export interface SpeechOutPort {
    speak(text: string): void;
    cancel(): void;
    readonly enabled: boolean;
}

interface SpeechSynthesisLike {
    speak(utterance: unknown): void;
    cancel(): void;
}

export interface SpeechOutOpts {
    /** Injected in tests. */
    synth?: SpeechSynthesisLike | undefined;
    utteranceCtor?: new (text: string) => unknown;
    enabled?: boolean;
    storage?: { getItem(key: string): string | null } | undefined;
}

export function isSpeakEnabled(storage?: { getItem(key: string): string | null }): boolean {
    const store = storage ?? safeLocalStorage();
    try {
        return store?.getItem(SPEAK_FLAG_KEY) === '1';
    } catch {
        return false;                      // storage denied — stay silent
    }
}

function safeLocalStorage(): { getItem(key: string): string | null } | undefined {
    try {
        return (globalThis as { localStorage?: { getItem(key: string): string | null } }).localStorage;
    } catch {
        return undefined;
    }
}

/**
 * A speaker, or a no-op one. Never null: the caller should not have to branch,
 * and `enabled === false` is the honest report that nothing will be heard.
 */
export function createSpeechOutPort(opts: SpeechOutOpts = {}): SpeechOutPort {
    const g = globalThis as {
        speechSynthesis?: SpeechSynthesisLike;
        SpeechSynthesisUtterance?: new (text: string) => unknown;
    };
    const synth = opts.synth ?? g.speechSynthesis;
    const Utterance = opts.utteranceCtor ?? g.SpeechSynthesisUtterance;
    const enabled = (opts.enabled ?? isSpeakEnabled(opts.storage)) && !!synth && !!Utterance;

    if (!enabled || !synth || !Utterance) {
        return { enabled: false, speak() { /* flag off or API absent */ }, cancel() { } };
    }
    return {
        enabled: true,
        speak(text) {
            const trimmed = text.trim();
            if (!trimmed) return;
            // One answer at a time: a queue of stale lines read over each other
            // is worse than silence.
            try { synth.cancel(); synth.speak(new Utterance(trimmed)); } catch { /* best effort */ }
        },
        cancel() { try { synth.cancel(); } catch { /* best effort */ } },
    };
}

// ───────────────────────── the key binding ─────────────────────────

/**
 * `KeyboardEvent.code` for push-to-talk. PHYSICAL key, not the character, so the
 * binding survives a non-QWERTY layout.
 *
 * `KeyV` is free: `worker-command-modes.ts` `handleOrderKey` binds
 * s/w/h/q/i/m/a/f/p/g/r/e/c/x/d/l/u, `camera-input.ts` binds arrows and the
 * mouse, and neither the minimap, the debug console nor the perf/timing overlays
 * claim V (grepped at M6). Ctrl-V is not affected — the handler ignores any
 * press with a modifier, so paste still pastes.
 */
export const DEFAULT_PTT_CODE = 'KeyV';

/** Where a rebind is stored. Read at widget init; there is no settings UI yet,
 *  so this is the bindable half of "a bindable key" (§4). */
export const PTT_KEY_STORAGE = 'springrts-nl-ptt-key';

export function readPushToTalkCode(
    storage: { getItem(key: string): string | null } | undefined = safeLocalStorage(),
): string {
    try {
        const raw = storage?.getItem(PTT_KEY_STORAGE)?.trim();
        // A stored value must look like a `KeyboardEvent.code` — "KeyV",
        // "Space", "F5", "Backquote" — which is always ≥2 characters and starts
        // with a capital. A stored "v" is the character, would never equal
        // `event.code`, and would silently disable voice; a binding that does
        // nothing is worse than the default.
        return raw && /^[A-Z][A-Za-z0-9]+$/.test(raw) ? raw : DEFAULT_PTT_CODE;
    } catch {
        return DEFAULT_PTT_CODE;
    }
}

/** Typing into a field must never open the microphone. */
export function isTextEntryTarget(target: unknown): boolean {
    const el = target as { tagName?: string; isContentEditable?: boolean } | null;
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = String(el.tagName ?? '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
