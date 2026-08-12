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
import { runLocalUtterance } from '../ui/native-ui/nl-client.js';
import { NLResolver } from '../ui/native-ui/nl-resolver.js';
import { matchSelectionToGroup } from '../ui/native-ui/cost-preview.js';
import { cameraPortHolder, createNLCameraPort } from '../ui/native-ui/camera-port.js';
import { uiActionRegistry, createNLUiActionPort } from '../ui/native-ui/ui-action-registry.js';
import { QueryEngine, censusCacheHolder } from '../ui/native-ui/query-engine.js';
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
        // Fire-and-forget: submit() awaits one census round-trip and reports
        // everything through the transcript, so there is nothing here to await
        // and nothing a rejection could usefully tell the player — but an
        // unhandled rejection would still be a console error, so it is caught.
        void submit().catch((err) => {
            console.error('[command-console] submit failed:', err);
            say('refused', 'Something went wrong handling that — nothing sent.');
        });
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
    runLocalUtterance(utterance, {
        index: namedEntityIndex,
        vocabulary: classVocabulary.current,
        selectionGroupId: selectedGroupId(),
        groupLabel,
        panelIds: uiActionRegistry.ids(),
        patterns: {
            vocabulary: classVocabulary.current,
            resolvePanel: (name) => uiActionRegistry.get(name)?.id ?? null,
        },
        ports: {
            sendCommand: state.ctx.sendCommand,
            resolver,
            console: { say: renderLine },
            ...buildLocalPorts(resolver),
        },
    });
}

/**
 * One executor line → one transcript line. The executor decides WHAT is said;
 * this only decides how it looks, which is the same division of labour the rest
 * of the widget follows.
 *
 * A question's candidate list rides in as a dim note. Clickable chips that
 * resubmit are M5's job (plan §4) — rendering the options as text now means the
 * player can always see what they are choosing between, without this widget
 * growing a resubmission flow it would have to hand over later.
 */
function renderLine(line) {
    const notes = [...(line.notes ?? [])];
    if (line.options?.length) notes.push(`options: ${line.options.join(' · ')}`);
    say(line.kind, line.text, notes);
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
