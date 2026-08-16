/**
 * command-console.js — the natural-language command console
 * (PLAN-metalstorm-command-language.md §4, milestone M0)
 *
 * The front door to the command language: a scrolling `you:` / `game:`
 * transcript and one text field. Type a sentence, the sentence executes.
 *
 * This runs the LOCAL path only — no LLM, no voice — but it runs it through the
 * M1 ENVELOPE, which is the path the proxy will use:
 *
 *     utterance → acceleratorFill (closed-vocab slot-filler, fed by the
 *     shipped class-vocabulary.json) → planUtterance (console-exchange.ts)
 *     → NLResponse (nl-client.ts adapter) → validateNLResponse
 *     → executeNLResponse → ctx.sendCommand
 *
 * Routing the offline parser through the same envelope, validator and executor
 * the LLM will use means every typed order in the game exercises that contract
 * from M1 — if the schema or the resolver is wrong, it shows up now, not when
 * the proxy lands. From the player's seat nothing changed: same sentences, same
 * transcript, same refusal copy.
 *
 * M4 adds the server proxy as a second producer of the SAME envelope, and M6
 * adds push-to-talk into this same input; neither changes this widget.
 *
 * M6 (voice) held to that: holding the push-to-talk key streams the interim
 * transcript into `#cc-input` and the release calls `submit()` — the same
 * function the Send button calls, reading the same field. There is no
 * voice-specific command path, so a spoken order and a typed one cannot diverge
 * in what they mean, what they cost, or what they say back.
 *
 * This widget is deliberately DUMB. It owns DOM, scroll position and event
 * wiring; it owns no parsing, no verb table and no decision about what a
 * sentence means. All of that lives in `ui/native-ui/` (console-exchange.ts,
 * free-text-accelerator.ts, compile-table.ts, class-vocabulary.ts) where it is
 * testable without a browser — a widget that parses is a widget that drifts
 * from the composer, which is the failure this whole milestone exists to fix.
 *
 * Nothing here bypasses the normal command path: `ctx.sendCommand` is the
 * single choke-point (integration.ts `createSendCommand`), so authority
 * charging and spectator gating apply exactly as they do for the composer.
 * The manifest also carries `hideForSpectator`, so a spectator never gets the
 * panel at all.
 */

import { namedEntityIndex } from '../ui/native-ui/named-entity-index.js';
import { classVocabulary } from '../ui/native-ui/class-vocabulary.js';
import { runUtterance } from '../ui/native-ui/nl-client.js';
import { buildNLContext } from '../ui/native-ui/nl-context.js';
import { browserTokenStore, getAccessToken } from '../lobby/auth-tokens.js';
import { NLResolver } from '../ui/native-ui/nl-resolver.js';
import { matchSelectionToGroup } from '../ui/native-ui/cost-preview.js';
import { cameraPortHolder, createNLCameraPort } from '../ui/native-ui/camera-port.js';
import { uiActionRegistry, createNLUiActionPort } from '../ui/native-ui/ui-action-registry.js';
import { QueryEngine, censusCacheHolder } from '../ui/native-ui/query-engine.js';
import { answerLocally, isCancel, resubmissionText } from '../ui/native-ui/nl-clarify.js';
import { validateNLResponse } from '../ui/native-ui/nl-envelope.js';
import { executeNLResponse } from '../ui/native-ui/nl-executor.js';
import {
    isVoiceCaptureAvailable, createWebSpeechVoicePort, createPushToTalk,
    createSpeechOutPort, readPushToTalkCode, isTextEntryTarget,
} from '../ui/native-ui/voice-capture.js';
import { injectStyle } from '../ui/ui.js';
import consoleCss from './command-console.css?raw';

/** Transcript cap. Old exchanges are dropped from the top — the console is a
 *  running conversation, not a log file, and an unbounded DOM list under the
 *  play area is a slow leak in a long match. */
const MAX_LOG_LINES = 120;

const state = {
    ctx: null,
    container: null,
    logEl: null,
    inputEl: null,
    /** [{ who, kind, text, notes, options?, pick?, chosen?, dead? }] */
    log: [],
    unsubs: [],
    /**
     * The last ≤2 exchanges, oldest first, alternating you/game — the `history`
     * the proxy accepts (§3, `kMaxHistoryEntries = 4`). Carried by chip
     * resubmissions AND by free-typed follow-ups, which is what makes "the
     * second one" resolve.
     */
    history: [],
    /**
     * The question currently on screen, as `nl-clarify.ts`'s
     * `PendingClarification` plus the chips already ticked. Null when there is
     * nothing outstanding.
     */
    pending: null,
    /** M6 voice. All null when the browser has no speech API — the mic button
     *  is then never created (see `setupVoice`). */
    voice: null,
    /** Speaks `game:` lines when the flag is on. Always present; a disabled one
     *  is a no-op, so no caller has to branch. */
    speaker: null,
    /** What was in the input field when the hold started, restored on cancel —
     *  a half-typed order must survive an accidental key press. */
    typedBeforeHold: '',
};

/** Exchanges (you+game pairs) the proxy accepts. */
const MAX_HISTORY_EXCHANGES = 2;

function init(ctx) {
    state.ctx = ctx;
    state.log = [];

    injectStyle('command-console-style', consoleCss);

    const container = document.createElement('div');
    container.className = 'command-console';
    container.innerHTML = `
        <div class="cc-log" id="cc-log" role="log" aria-live="polite" aria-label="Command transcript"></div>
        <form class="cc-input-row" id="cc-form">
            <input type="text" id="cc-input" class="cc-input" autocomplete="off"
                aria-label="Type a command"
                placeholder='Type an order: "defend Northgate", "idle tanks hold Slag Forge high"' />
            <button type="submit" class="nui-btn nui-btn--primary" id="cc-send">Send</button>
        </form>
    `;
    // The mic is APPENDED by setupVoice when — and only when — the browser has a
    // speech API. Building it into the markup above and hiding it later would
    // leave a hidden control in the tab order on every non-Chromium browser.

    state.container = container;
    state.logEl = container.querySelector('#cc-log');
    state.inputEl = container.querySelector('#cc-input');

    ctx.mount.appendChild(container);

    const form = container.querySelector('#cc-form');
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        // Fire-and-forget: submit() awaits one census round-trip and reports
        // everything through the transcript, so there is nothing here to await
        // and nothing a rejection could usefully tell the player — but an
        // unhandled rejection would still be a console error, so it is caught.
        void submit().catch((err) => {
            console.error('[command-console] submit failed:', err);
            say('refused', 'Something went wrong handling that — nothing sent.');
        });
    });

    // One delegated listener for every chip, now and forever: `renderLog`
    // replaces the log's innerHTML on each line, so per-button listeners would
    // be re-bound (and leaked) on every transcript update.
    state.logEl.addEventListener('click', (e) => {
        const chip = e.target.closest?.('.cc-chip');
        if (!chip || chip.disabled) return;
        e.preventDefault();
        void onChip(chip).catch((err) => {
            console.error('[command-console] chip failed:', err);
            say('refused', 'Something went wrong handling that answer — nothing sent.');
        });
    });

    // The game binds camera/hotkeys on window keydown; those handlers already
    // skip INPUT targets, but stop the propagation anyway so a future binding
    // can't start eating letters the player is typing into an order.
    state.inputEl.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') state.inputEl.blur();
    });

    setupVoice(container);

    say('system', state.voice
        ? `Type an order in plain words, or hold ${state.voice.keyLabel} and say it. Try "defend <region>" — or "help".`
        : 'Type an order in plain words. Try "defend <region>" — or "help".');

    console.log('[command-console] Initialized');
}

// ───────────────────────────── voice (M6) ─────────────────────────────

/**
 * Push-to-talk, or nothing at all.
 *
 * `isVoiceCaptureAvailable` is asked once. When it says no (Firefox, Safari,
 * any headless build without the API) this function returns having created no
 * button, bound no key and printed no warning: a mic the browser cannot honour
 * is an affordance that lies, and a console message about it is addressed to
 * nobody who can act on it. `state.voice` stays null and every voice path below
 * is unreachable.
 *
 * Nothing here opens the microphone. `port.start()` is called from
 * `PushToTalk.press()` only, which is reachable only from a real key-down or
 * pointer-down — a user gesture, which is also what the browser requires before
 * it will prompt for permission at all.
 */
function setupVoice(container) {
    state.speaker = createSpeechOutPort();

    if (!isVoiceCaptureAvailable()) return;
    const port = createWebSpeechVoicePort();
    if (!port) return;

    const code = readPushToTalkCode();
    const keyLabel = code.startsWith('Key') ? code.slice(3) : code;

    const mic = document.createElement('button');
    mic.type = 'button';
    mic.id = 'cc-mic';
    mic.className = 'cc-mic';
    mic.setAttribute('aria-pressed', 'false');
    mic.setAttribute('aria-label', `Hold to talk (${keyLabel})`);
    mic.title = `Hold to talk — or hold ${keyLabel}. Esc while holding cancels.`;
    mic.innerHTML = '<span class="cc-mic__dot" aria-hidden="true"></span><span class="cc-mic__glyph" aria-hidden="true">🎙</span>';
    container.querySelector('#cc-form').insertBefore(mic, container.querySelector('#cc-send'));

    const ptt = createPushToTalk({
        port,
        onState: (s) => renderMicState(s),
        onInterim: (text) => {
            // The interim goes in the INPUT FIELD, not the transcript: it is not
            // yet anything the game was told, and a log line per partial would
            // bury the last exchange under a stutter of half-sentences.
            if (state.inputEl) state.inputEl.value = text;
        },
        onSubmit: (transcript) => {
            if (state.inputEl) state.inputEl.value = transcript;
            // The SAME function the Send button calls, reading the same field.
            // This one line is the whole "voice is an input method, not a second
            // parser" claim, and it is why voice inherits clarification chips,
            // history, the offline fallback and every refusal wording for free.
            void submit().catch((err) => {
                console.error('[command-console] voice submit failed:', err);
                say('refused', 'Something went wrong handling that — nothing sent.');
            });
        },
        onEmpty: () => {
            restoreTyped();
            say('system', "I didn't catch that — hold the key and speak, or type it.");
        },
        onCancel: () => {
            restoreTyped();
            say('system', 'voice cancelled — nothing sent.');
        },
        onError: (err) => {
            restoreTyped();
            say('refused', err.message);
        },
    });

    state.voice = { port, ptt, mic, code, keyLabel };

    // ── mic button: press and hold ──
    mic.addEventListener('pointerdown', (e) => {
        e.preventDefault();                 // don't steal focus from the input
        // Capture the pointer so the release is seen even if the cursor has
        // wandered off the button by then — otherwise a drag off the mic leaves
        // it hot with nobody listening for the key-up.
        try { mic.setPointerCapture(e.pointerId); } catch { /* not supported */ }
        beginHold();
    });
    const endPointer = (e) => {
        if (state.voice?.ptt.state === 'off') return;
        try { mic.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        ptt.release();
    };
    mic.addEventListener('pointerup', endPointer);
    mic.addEventListener('pointercancel', () => ptt.cancel());

    // ── the bindable key ──
    // CAPTURE phase: main.ts's global Escape handler (quit-to-lobby) and the
    // worker's order hotkeys both listen on window in the bubble phase, so
    // getting here first is what lets Esc mean "cancel the hold" while a hold is
    // in flight, and mean "quit dialog" at every other moment.
    const onKeyDown = (e) => {
        if (e.key === 'Escape' && state.voice.ptt.state !== 'off') {
            ptt.cancel();
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (e.code !== state.voice.code) return;
        // Modifiers are somebody else's binding (Ctrl-V is paste), and `repeat`
        // is the OS auto-repeating a key that is already held.
        if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
        // Typing into any field — including this console's own input — must
        // never open the mic.
        if (isTextEntryTarget(e.target)) return;
        e.preventDefault();
        beginHold();
    };
    const onKeyUp = (e) => {
        if (e.code !== state.voice.code) return;
        if (state.voice.ptt.state === 'off') return;
        e.preventDefault();
        ptt.release();
    };
    // A key held while the tab loses focus never delivers its key-up. Without
    // this the mic would stay hot behind another window, which is precisely the
    // thing §4 promises cannot happen.
    const onBlur = () => { if (state.voice?.ptt.state !== 'off') ptt.cancel(); };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    state.unsubs.push(() => {
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('keyup', onKeyUp, true);
        window.removeEventListener('blur', onBlur);
        ptt.dispose();
    });
}

function beginHold() {
    if (!state.voice || state.voice.ptt.state !== 'off') return;
    state.typedBeforeHold = state.inputEl?.value ?? '';
    state.voice.ptt.press();
}

/** Put back whatever was half-typed when the hold started. A cancelled or empty
 *  hold must not eat an order the player was in the middle of writing. */
function restoreTyped() {
    if (state.inputEl) state.inputEl.value = state.typedBeforeHold;
}

/**
 * The mic is HOT or it is OFF, and it looks like exactly one of those (§4
 * "mic state must be unambiguous").
 *
 * `listening` is the only hot state: `settling` has already called `stop()` on
 * the port, so the microphone is closed and showing it as live would be a lie in
 * the direction that matters. It gets its own dim "thinking" look instead.
 */
function renderMicState(s) {
    const mic = state.voice?.mic;
    if (!mic) return;
    mic.classList.toggle('cc-mic--hot', s === 'listening');
    mic.classList.toggle('cc-mic--settling', s === 'settling');
    mic.setAttribute('aria-pressed', s === 'listening' ? 'true' : 'false');
    state.container?.classList.toggle('command-console--listening', s === 'listening');
    if (state.inputEl) {
        state.inputEl.placeholder = s === 'listening'
            ? 'Listening — release to send, Esc to cancel'
            : 'Type an order: "defend Northgate", "idle tanks hold Slag Forge high"';
    }
}

function dispose() {
    // Runs FIRST, and before anything else is torn down: the voice unsub
    // cancels any hold in flight and disposes the port, so the microphone can
    // never outlive the panel that opened it.
    for (const unsub of state.unsubs) unsub();
    state.unsubs = [];
    state.voice = null;
    state.speaker?.cancel();
    state.speaker = null;

    if (state.container) {
        state.container.remove();
        state.container = null;
    }
    state.logEl = null;
    state.inputEl = null;
    state.log = [];
    document.getElementById('command-console-style')?.remove();

    console.log('[command-console] Disposed');
}

/** Append one transcript line (+ optional dim transparency notes) and scroll. */
function say(kind, text, notes = [], extra = {}) {
    const who = kind === 'you' ? 'you' : kind === 'system' ? '' : 'game';
    state.log.push({ who, kind, text, notes, chosen: [], ...extra });
    if (state.log.length > MAX_LOG_LINES) state.log.splice(0, state.log.length - MAX_LOG_LINES);
    renderLog();
    return state.log[state.log.length - 1];
}

function renderLog() {
    if (!state.logEl) return;
    state.logEl.innerHTML = state.log
        .map((entry, i) => `
            <div class="cc-line cc-line--${entry.kind}">
                <span class="cc-line__who">${entry.who ? `${entry.who}:` : ''}</span>
                <span class="cc-line__text">${escapeHtml(entry.text)}</span>
            </div>
            ${entry.notes.map((n) => `<div class="cc-note">${escapeHtml(n)}</div>`).join('')}
            ${renderChips(entry, i)}
        `)
        .join('');
    // Newest line always visible — the answer to what you just typed must not
    // require a scroll.
    state.logEl.scrollTop = state.logEl.scrollHeight;
}

/**
 * The clarification chips (§4 "clarification chips (click = resubmit with the
 * option appended)").
 *
 * A question that needs several picks (`pick > 1`) renders as toggles plus a
 * confirm button, because asking once per squad would turn a two-tap answer
 * into four taps and two more model calls. One pick fires immediately — a
 * confirm step on a single choice is a click that says nothing.
 *
 * `dead` chips are the ones belonging to a question that has been answered or
 * superseded. They stay on screen, disabled, with the chosen one marked: the
 * transcript is a record of what was asked and what was picked, and silently
 * removing the question would leave an answer with nothing above it.
 */
function renderChips(entry, index) {
    if (!entry.options?.length) return '';
    const pick = entry.pick ?? 1;
    const chips = entry.options.map((option, j) => {
        const on = entry.chosen.includes(option);
        const classes = ['cc-chip'];
        if (on) classes.push('cc-chip--on');
        if (entry.dead) classes.push('cc-chip--dead');
        return `<button type="button" class="${classes.join(' ')}"
            ${entry.dead ? 'disabled' : ''}
            data-line="${index}" data-option="${j}">${escapeHtml(option)}</button>`;
    }).join('');
    const confirm = pick > 1 && !entry.dead
        ? `<button type="button" class="cc-chip cc-chip--go"
             ${entry.chosen.length === pick ? '' : 'disabled'}
             data-line="${index}" data-confirm="1">send ${entry.chosen.length}/${pick}</button>`
        : '';
    return `<div class="cc-chips">${chips}${confirm}</div>`;
}

/**
 * The org group the current selection resolves to, or null — the same
 * selection→Subject rule the composer uses (PLAN-metalstorm-scripting task 4),
 * so "defend Northgate" means the same thing in both surfaces.
 */
function selectedGroupId() {
    if (!state.ctx) return null;
    const selection = state.ctx.store.getSelection();
    const groups = state.ctx.store.getOrgGroups();
    return matchSelectionToGroup(selection.unitIds, groups);
}

function groupLabel(groupId) {
    const groups = state.ctx?.store.getOrgGroups() ?? [];
    const group = groups.find((g) => g.groupId === groupId);
    return group?.name || `Group ${groupId}`;
}

/**
 * unit id → `{className, scale}` from the LOS-filtered census (M3).
 *
 * This is the port `NLResolver` documented as absent through M1/M2 — "which of
 * your squads are the tank squads" was genuinely unknowable on this thread,
 * because main holds no defs mirror. The census answers it (the join happens
 * worker-side, where the def cache is), so `2 tank squads` now resolves instead
 * of refusing. Returns undefined per-unit when no snapshot has arrived, which is
 * exactly the state the resolver's honest refusal was written for.
 */
function unitClassLookup() {
    const census = censusCacheHolder.current?.snapshot();
    if (!census) return undefined;
    const byId = new Map();
    for (const u of census.units) {
        if (u.className) byId.set(u.unitId, { className: u.className, scale: u.scale });
    }
    return (unitId) => byId.get(unitId);
}

/**
 * Centroid of a group's members from the census — read LIVE, on every call.
 *
 * The first build captured the snapshot (and the group list) when the lookup was
 * created, which was fine for ranking squads inside one sentence and wrong for
 * `follow`: the camera snapped once and then sat still while the squad drove off,
 * because the "live centroid" it re-read every 400 ms was a photograph. Both
 * callers now see whatever the cache holds at the moment they ask.
 *
 * Undefined when no snapshot exists or nothing of the group is in the mirror —
 * never a guessed position (that would rank squads by a coordinate nobody holds,
 * and point the camera at the map corner).
 */
function groupPosition(groupId) {
    const census = censusCacheHolder.current?.snapshot();
    if (!census) return undefined;
    const group = (state.ctx?.store.getOrgGroups() ?? []).find((g) => g.groupId === groupId);
    if (!group) return undefined;
    const members = new Set(group.memberIds);
    let x = 0, z = 0, n = 0;
    for (const u of census.units) {
        if (!members.has(u.unitId)) continue;
        x += u.x; z += u.z; n++;
    }
    return n ? { x: x / n, z: z / n } : undefined;
}

/**
 * The resolver for THIS session: the live name index, the shipped vocabulary,
 * the store's own-team org groups, whatever is selected, and (from M3) the
 * census-backed class + position lookups.
 *
 * Built fresh per utterance so it always sees the current store snapshot AND the
 * census the submit path just refreshed.
 */
function buildResolver() {
    const unitClass = unitClassLookup();
    return new NLResolver({
        index: namedEntityIndex,
        vocabulary: classVocabulary.current,
        groups: state.ctx?.store.getOrgGroups() ?? [],
        selectionGroupId: selectedGroupId(),
        ...(unitClass ? { unitClass } : {}),
        groupPosition,
    });
}

/**
 * The M3 ports, or nothing.
 *
 * Each is omitted when its provider isn't installed, and the executor then
 * refuses that action kind BY NAME ("camera control isn't wired up yet"). That is
 * the whole reason the ports are optional: a stubbed camera that swallowed calls
 * would print "camera on Northgate" for a camera that never moved.
 */
function buildLocalPorts(resolver) {
    const ports = {};

    const camera = cameraPortHolder.current;
    if (camera) {
        ports.camera = createNLCameraPort({
            port: camera,
            resolver,
            groupPosition: (groupId) => groupPosition(groupId) ?? null,
        });
        // Tell the player when a follow ends, and why. A camera that silently
        // stops tracking looks broken; one that says "released Hammerfall (you
        // moved the camera)" is obviously working as designed.
        camera.setFollowEndHandler((reason, label) => {
            if (reason === 'camera-action') return;      // superseded — the new action speaks
            const why = reason === 'user-input' ? 'you moved the camera'
                : reason === 'target-lost' ? "I can't see them any more"
                : 'stopped';
            say('system', `camera released from ${label} — ${why}`);
        });
    }

    if (uiActionRegistry.ids().length > 0) {
        ports.uiActions = createNLUiActionPort(uiActionRegistry);
    }

    if (censusCacheHolder.current) {
        ports.queryEngine = new QueryEngine({
            census: censusCacheHolder.current,
            index: namedEntityIndex,
            vocabulary: classVocabulary.current,
            resolveEntity: (name, opts) => resolver.resolveEntity(name, opts),
            groups: state.ctx?.store.getOrgGroups() ?? [],
            directives: state.ctx?.store.getDirectives() ?? [],
            gameRulesParam: (key) => state.ctx?.store.gameRulesParam(key),
            teamRulesParam: (key) => state.ctx?.store.teamRulesParam(state.ctx.identity.teamId, key),
            playerId: state.ctx?.identity.playerId ?? 0,
            ...(camera ? { focusCamera: (x, z) => camera.focusOn(x, z) } : {}),
        });
    }

    return ports;
}

// ───────────────────────── clarification chips ─────────────────────────

/**
 * A chip was tapped.
 *
 * Three outcomes, in the order they are checked:
 *   1. `cancel` — the question is closed and nothing is sent. A player who has
 *      changed their mind must not have to answer a question to escape it.
 *   2. still collecting (`pick > 1` and fewer ticked than needed) — the chip
 *      toggles and nothing else happens.
 *   3. answered — `nl-clarify.ts` decides whether the answer can be applied to
 *      the envelope we already hold, or has to go back to the model.
 */
async function onChip(chip) {
    // The silent returns in this function are audited (§7 "no silent drops"):
    // each one is a tap that ASKED for nothing to happen — a frozen chip, a
    // toggle that is still collecting picks. The moment a tap means "do it",
    // every path below prints something.
    const entry = state.log[Number(chip.dataset.line)];
    if (!entry || entry.dead) return;

    const pick = entry.pick ?? 1;

    if (!chip.dataset.confirm) {
        const option = entry.options[Number(chip.dataset.option)];
        if (option === undefined) return;

        if (isCancel(option)) {
            closeQuestion(entry, [option]);
            say('system', 'cancelled — nothing sent.');
            return;
        }

        if (pick > 1) {
            // Toggle. `cancel` is never part of a multi-pick answer, so ticking
            // a real option clears it and vice versa.
            entry.chosen = entry.chosen.includes(option)
                ? entry.chosen.filter((o) => o !== option)
                : [...entry.chosen.filter((o) => !isCancel(o)), option].slice(-pick);
            renderLog();
            return;
        }
        entry.chosen = [option];
    }

    if (entry.chosen.length !== pick) return;

    const chosen = [...entry.chosen];
    const pending = state.pending;
    closeQuestion(entry, chosen);

    if (!pending) {
        // The question scrolled out of the live state (a new sentence was typed
        // in the meantime, which supersedes it). Say so rather than acting on a
        // premise that has moved.
        say('refused', 'That question is out of date now — say it again.');
        return;
    }

    await answerQuestion(pending, chosen);
}

/** Mark a question answered: chips freeze, the choice is recorded. */
function closeQuestion(entry, chosen) {
    entry.chosen = chosen;
    entry.dead = true;
    state.pending = null;
    renderLog();
}

/**
 * Answer the outstanding question, locally if we can and through the model if
 * we can't (see `nl-clarify.ts` for which is which).
 *
 * The local path is the one that matters for the common case: the question came
 * from the resolver, out of an envelope this client already validated, so
 * putting the chosen callsigns back in and re-running costs nothing, takes no
 * round trip, and works with the proxy disabled — which is the only reason the
 * flow is usable at all when `SPRING_NL_API_KEY` is unset.
 */
async function answerQuestion(pending, chosen) {
    say('you', chosen.join(' and '));

    const patched = answerLocally(pending, chosen);
    if (patched) {
        await runEnvelope(patched, pending.utterance);
        return;
    }
    await runUtteranceText(resubmissionText(pending.utterance, chosen));
}

/**
 * Execute an envelope we built ourselves — the answered-locally path.
 *
 * It still goes through `validateNLResponse`, for the same reason the local
 * parser's own envelopes do: a patcher that produced a shape the contract
 * rejects should say so here, not have the executor discover it three layers
 * down. Nothing here can reach `sendCommand` except through the executor.
 */
async function runEnvelope(response, utterance) {
    if (!state.ctx?.sendCommand) {
        say('refused', 'Not connected to the game — nothing sent.');
        return;
    }
    await censusCacheHolder.current?.refresh();

    const resolver = buildResolver();
    const validation = validateNLResponse(response, {
        vocabulary: classVocabulary.current,
        panelIds: uiActionRegistry.ids(),
    });
    if (!validation.ok) {
        say('refused',
            `I couldn't put that answer in a form the game accepts: ${validation.errors[0]}.`,
            validation.errors.slice(1, 4));
        return;
    }

    const report = executeNLResponse(validation.value, {
        sendCommand: state.ctx.sendCommand,
        resolver,
        console: { say: renderLine },
        ...buildLocalPorts(resolver),
    });
    rememberExchange(utterance, { report });
}

/**
 * Async only at this boundary.
 *
 * The census is a worker round-trip, and the whole envelope path below is
 * synchronous by design (see nl-executor.ts). Refreshing HERE, once, before the
 * sentence runs is what keeps it that way: every query and every class-count
 * subject in this utterance then reads one snapshot taken moments ago, instead of
 * each of them awaiting its own and disagreeing about the board.
 */
async function submit() {
    const utterance = state.inputEl.value.trim();
    if (!utterance) return;

    state.inputEl.value = '';
    say('you', utterance);

    if (utterance.toLowerCase() === 'help') {
        showHelp();
        return;
    }

    // A new sentence supersedes an outstanding question: its chips freeze
    // unanswered rather than staying live behind the new exchange, where a
    // later tap would act on a board two orders old.
    if (state.pending) {
        const asked = state.log.find((l) => l.options?.length && !l.dead);
        if (asked) { asked.dead = true; renderLog(); }
        state.pending = null;
    }

    await runUtteranceText(utterance);
}

/** One sentence through the whole path. Shared by the input field and by a chip
 *  resubmission, so a follow-up carries exactly the same context and history a
 *  typed sentence would. */
async function runUtteranceText(utterance) {
    if (!state.ctx?.sendCommand) {
        // Never report an order as issued when there was nothing to issue it
        // through — the connection isn't wired (or was torn down). Checked
        // BEFORE the run rather than after, so no "ok" line is ever printed for
        // a send that had nowhere to go.
        say('refused', 'Not connected to the game — nothing sent.');
        return;
    }

    await censusCacheHolder.current?.refresh();

    const resolver = buildResolver();
    const result = await runUtterance(utterance, {
        index: namedEntityIndex,
        vocabulary: classVocabulary.current,
        selectionGroupId: selectedGroupId(),
        groupLabel,
        panelIds: uiActionRegistry.ids(),
        patterns: {
            vocabulary: classVocabulary.current,
            resolvePanel: (name) => uiActionRegistry.get(name)?.id ?? null,
        },
        // Absent ⇒ local-only. That is the honest state when the player has no
        // session token (a dev harness, a torn-down session): the proxy route
        // is TokenRequired and would 401 every time, so there is nothing to
        // gain from trying and a round trip to lose on every sentence.
        proxy: buildProxyDeps(),
        ports: {
            sendCommand: state.ctx.sendCommand,
            resolver,
            console: { say: renderLine },
            ...buildLocalPorts(resolver),
        },
    });

    rememberExchange(utterance, result);
    rememberQuestion(utterance, result);
}

/**
 * Hold on to an unanswered question so a chip tap knows what it is answering.
 *
 * `response` and `clarifyContext` come from the run that just stopped — with
 * them, `nl-clarify.ts` can put the chosen name back where the question came
 * from and re-run locally. Without them (a question the MODEL asked) the answer
 * has to be resubmitted, and both cases end up here identically so the console
 * never has to know which is which.
 */
function rememberQuestion(utterance, result) {
    const clarify = result?.report?.clarification;
    if (!clarify?.options?.length) { state.pending = null; return; }
    state.pending = {
        utterance,
        response: result.response,
        context: result.report.clarifyContext,
        options: clarify.options,
        pick: clarify.pick ?? 1,
    };
}

/**
 * The proxy half of the run, or null when we have no token to send.
 *
 * The context payload is rebuilt per utterance rather than cached, because it
 * IS the board: a payload from thirty seconds ago names groups that have since
 * died and misses the ones just formed, and the model has no way to tell.
 */
function buildProxyDeps() {
    const token = getAccessToken(browserTokenStore);
    const endpoint = gameServerOrigin();
    if (!token || !endpoint || !state.ctx) return undefined;

    const context = buildNLContext({
        index: namedEntityIndex,
        census: censusCacheHolder.current ?? { snapshot: () => null },
        vocabulary: classVocabulary.current,
        groups: state.ctx.store.getOrgGroups(),
        directives: state.ctx.store.getDirectives(),
        panelIds: uiActionRegistry.ids(),
        selectionCount: state.ctx.store.getSelection().unitIds.length,
        mapName: state.ctx.mapName ?? '',
        authority: numericRulesParam(`authority_player_${state.ctx.identity.playerId}`),
    });

    return {
        endpoint,
        token,
        context,
        history: state.history,
    };
}

/**
 * The GAME server's origin — where `/api/nl/command` lives.
 *
 * Emphatically not `CONFIG.httpUrl`, which is the LOBBY (port 8011 in dev).
 * The proxy route is registered by `RegisterGameHttpRoutes` on the per-match
 * `NetworkServer`, deliberately: the lobby's HTTP loop is single-threaded and
 * global, so a 1–3 s Claude call there would stall login for everyone on the
 * instance (§3). Posting a player's utterance at the lobby would 404 every
 * time and, worse, would send the sentence to a process that has no business
 * seeing it.
 *
 * `springrts-game-port` is the handle the lobby writes on room entry and that
 * `viewport.ts` and `main.ts` already read for exactly this purpose — reusing
 * it rather than threading a new field through `WidgetContext` keeps one
 * answer to "which game server am I in".
 *
 * Absent ⇒ no game ⇒ no proxy, and `runUtterance` stays local-only.
 */
function gameServerOrigin() {
    let port = '';
    try {
        port = localStorage.getItem('springrts-game-port') ?? '';
    } catch {
        return '';                       // storage denied — degrade, don't throw
    }
    if (!port) return '';
    const host = globalThis.location?.hostname || 'localhost';
    return `http://${host}:${port}`;
}

function numericRulesParam(key) {
    const raw = state.ctx?.store.teamRulesParam(state.ctx.identity.teamId, key);
    const n = typeof raw === 'string' ? Number(raw) : raw;
    return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * Keep the last two exchanges so a follow-up ("the second one", "and the
 * infantry too") has something to attach to.
 *
 * Two, not more: that is what the proxy accepts (§3, `kMaxHistoryEntries = 4` =
 * 2 user + 2 assistant) and it is what a clarification round-trip needs — the
 * question the game asked, and the sentence that provoked it. Older turns
 * describe a board that has since moved, and every one of them is paid for on
 * every request.
 *
 * The game's side of an exchange is the first line that ASSERTS something — a
 * question, a refusal or an outcome. The `say` acknowledgement is skipped
 * because it restates the order rather than its result, and history that says
 * "Moving Chimera to Randtown" for a move that was then refused would teach the
 * model the opposite of what happened.
 */
function rememberExchange(utterance, result) {
    const spoken = result?.report?.lines?.find((l) => l.kind !== 'system')?.text;
    if (!spoken) { state.history = []; return; }
    state.history = [...state.history, utterance, spoken].slice(-MAX_HISTORY_EXCHANGES * 2);
}

/**
 * One executor line → one transcript line. The executor decides WHAT is said;
 * this only decides how it looks, which is the same division of labour the rest
 * of the widget follows.
 *
 * A question's candidate list becomes tappable chips (M5). The options ride on
 * the log entry rather than being flattened into the text, because a chip has to
 * remember which option it is when the whole log re-renders.
 */
function renderLine(line) {
    say(line.kind, line.text, [...(line.notes ?? [])], line.options?.length
        ? { options: [...line.options], pick: line.pick ?? 1 }
        : {});
    // Optional spoken response (§4), off unless `springrts-nl-speak` is set. A
    // disabled speaker is a no-op, so there is nothing to branch on here.
    // `system` lines are skipped: they are housekeeping ("voice cancelled"),
    // and the flag was earned by ANSWERS — a query result the player asked for
    // out loud while looking at the battlefield rather than at the log.
    if (line.kind !== 'system') state.speaker?.speak(line.text);
}

/** The closed vocabulary, read out of the shipped data rather than restated
 *  here — the console must not become a second place the word list lives. */
function showHelp() {
    const vocabulary = classVocabulary.current;
    const classes = vocabulary.describeClasses();
    say('system',
        'Sentence shape: [group] VERB [place] [priority] [when]. ' +
        'Verbs: attack, secure, defend, hold, patrol, screen, scout, escort, withdraw, reinforce, build. ' +
        'Priority: low, normal, high, urgent. When: "under attack", "contested".');
    say('system',
        'Naming: "name this group Hammerfall" renames what you have selected; ' +
        '"rename Chimera Platoon to Hammerfall" names one by its current callsign.');
    say('system',
        classes
            ? `Unit classes for an "idle <class>" subject: ${classes}.`
            : 'Unit-class vocabulary is not loaded — "idle <class>" subjects are unavailable.');
    // The camera / panel / query sentences (M3). Read out of the live registry
    // rather than listed here, so a game that ships different panels documents
    // itself — the same rule the class list above follows.
    say('system',
        'Camera: "zoom to <place>", "follow <squad>", "show me the whole map", "zoom in/out". ' +
        'Questions: "how many <class> do we have", "where is <name>", "how much authority", "objectives".');
    const panels = uiActionRegistry.names();
    say('system', panels.length
        ? `Panels you can open, close or toggle: ${panels.join(', ')} — add ", full screen" where it applies.`
        : 'No panels are registered, so panel commands are unavailable.');
}

function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

export default {
    id: 'command-console',
    init,
    dispose,
};
