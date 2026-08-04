/**
 * command-console.js — the natural-language command console
 * (PLAN-metalstorm-command-language.md §4, milestone M0)
 *
 * The front door to the command language: a scrolling `you:` / `game:`
 * transcript and one text field. Type a sentence, the sentence executes.
 *
 * V0 (this file) runs the LOCAL path only — no LLM, no voice:
 *
 *     utterance → acceleratorFill (closed-vocab slot-filler, fed by the
 *     shipped class-vocabulary.json) → planUtterance (console-exchange.ts)
 *     → compileIntent → ctx.sendCommand
 *
 * M4 adds the server proxy in front of the slot-filler and M6 adds
 * push-to-talk into this same input; both land as new `planUtterance`-shaped
 * producers, so the transcript, the refusal copy and this widget don't change.
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
import { planUtterance } from '../ui/native-ui/console-exchange.js';
import { matchSelectionToGroup } from '../ui/native-ui/cost-preview.js';
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
    /** [{ who: 'you'|'game', kind: 'you'|'ok'|'refused'|'system', text, notes }] */
    log: [],
    unsubs: [],
};

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

    state.container = container;
    state.logEl = container.querySelector('#cc-log');
    state.inputEl = container.querySelector('#cc-input');

    ctx.mount.appendChild(container);

    const form = container.querySelector('#cc-form');
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        submit();
    });

    // The game binds camera/hotkeys on window keydown; those handlers already
    // skip INPUT targets, but stop the propagation anyway so a future binding
    // can't start eating letters the player is typing into an order.
    state.inputEl.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') state.inputEl.blur();
    });

    say('system', 'Type an order in plain words. Try "defend <region>" — or "help".');

    console.log('[command-console] Initialized');
}

function dispose() {
    for (const unsub of state.unsubs) unsub();
    state.unsubs = [];

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
function say(kind, text, notes = []) {
    const who = kind === 'you' ? 'you' : kind === 'system' ? '' : 'game';
    state.log.push({ who, kind, text, notes });
    if (state.log.length > MAX_LOG_LINES) state.log.splice(0, state.log.length - MAX_LOG_LINES);
    renderLog();
}

function renderLog() {
    if (!state.logEl) return;
    state.logEl.innerHTML = state.log
        .map((entry) => `
            <div class="cc-line cc-line--${entry.kind}">
                <span class="cc-line__who">${entry.who ? `${entry.who}:` : ''}</span>
                <span class="cc-line__text">${escapeHtml(entry.text)}</span>
            </div>
            ${entry.notes.map((n) => `<div class="cc-note">${escapeHtml(n)}</div>`).join('')}
        `)
        .join('');
    // Newest line always visible — the answer to what you just typed must not
    // require a scroll.
    state.logEl.scrollTop = state.logEl.scrollHeight;
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

function submit() {
    const utterance = state.inputEl.value.trim();
    if (!utterance) return;

    state.inputEl.value = '';
    say('you', utterance);

    if (utterance.toLowerCase() === 'help') {
        showHelp();
        return;
    }

    const outcome = planUtterance(utterance, {
        index: namedEntityIndex,
        vocabulary: classVocabulary.current,
        selectionGroupId: selectedGroupId(),
        groupLabel,
    });

    if (outcome.kind === 'refused') {
        say('refused', outcome.text, outcome.notes);
        return;
    }

    if (!state.ctx?.sendCommand) {
        // Never report an order as issued when there was nothing to issue it
        // through — the connection isn't wired (or was torn down).
        say('refused', 'Not connected to the game — nothing sent.', outcome.notes);
        return;
    }

    state.ctx.sendCommand(outcome.command);
    say('ok', outcome.text, outcome.notes);
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
        classes
            ? `Unit classes for an "idle <class>" subject: ${classes}.`
            : 'Unit-class vocabulary is not loaded — "idle <class>" subjects are unavailable.');
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
