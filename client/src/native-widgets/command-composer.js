/**
 * command-composer.js — Command composer widget (PLAN-metalstorm-scripting.md §3, task 1)
 *
 * A native JS widget that composes commands from [VERB][SUBJECT][TARGET] . priority [slider] . [WHEN]?
 * Rendered as clickable slot-chips with inline controls.
 *
 * This is a NATIVE JS WIDGET loaded via the widget-loader (PLAN-native-ui.md §3).
 * It exports a default object with init() and dispose() methods.
 *
 * Widget lifecycle:
 *   - init(context) — mount the UI, subscribe to store
 *   - dispose() — clean up
 *
 * revealOn: First group exists (from store)
 */

import { namedEntityIndex } from '../ui/native-ui/named-entity-index.js';
import {
    compileIntent,
    validateIntent,
    getPriorityBand,
    PRIORITY_BANDS,
} from '../ui/native-ui/compile-table.js';
import { injectStyle } from '../ui/ui.js';
import composerCss from './command-composer.css?raw';

/**
 * Widget state
 */
const state = {
    // Slot values
    verb: null,             // CommandVerb or null
    subject: null,          // CommandSubject or null
    target: null,           // CommandTarget or null
    priority: 50,           // 0-100
    when: null,             // WhenCondition or null

    // UI state
    activeSlot: null,       // Which slot is being edited
    searchQuery: '',        // Autocomplete search query
    mapArmActive: false,    // Whether map-click is armed

    // Context (set on init)
    ctx: null,
    unsubs: [],             // Unsubscribe functions
    container: null,        // DOM container
};

/**
 * Widget init — called by widget-loader
 */
function init(ctx) {
    state.ctx = ctx;

    // Frame, header and collapse toggle come from the widget-loader's panel
    // chrome (metalstorm.ui.json declares the title) — the widget owns only
    // its own content, and takes its look from the design system.
    injectStyle('command-composer-style', composerCss);

    const container = document.createElement('div');
    container.className = 'command-composer';

    state.container = container;

    // Render initial UI
    render();

    // Mount to context.mount
    ctx.mount.appendChild(container);

    // Subscribe to index changes for autocomplete updates
    const unsub = namedEntityIndex.onChange(() => {
        if (state.activeSlot === 'target') {
            renderAutocomplete();
        }
    });
    state.unsubs.push(unsub);

    console.log('[command-composer] Initialized');
}

/**
 * Widget dispose — clean up
 */
function dispose() {
    // Unsubscribe
    for (const unsub of state.unsubs) {
        unsub();
    }
    state.unsubs = [];

    // Remove DOM
    if (state.container) {
        state.container.remove();
        state.container = null;
    }
    document.getElementById('command-composer-style')?.remove();

    console.log('[command-composer] Disposed');
}

/**
 * Render the entire widget
 */
function render() {
    if (!state.container) return;

    // Two rows: the command sentence (with the priority slider tucked to its
    // right) and the echo + commit controls. The [WHEN] chip sits inline with
    // the other slots rather than on its own row — it's part of the same
    // sentence, and a separate row cost 40px of play area for one optional
    // token.
    const html = `
        <div class="composer-row composer-sentence">
            ${renderSlotChip('verb', state.verb, '[VERB]')}
            ${renderSlotChip('subject', state.subject ? formatSubject(state.subject) : null, '[SUBJECT]')}
            ${renderSlotChip('target', state.target ? formatTarget(state.target) : null, '[TARGET]')}
            ${renderSlotChip('when', state.when ? formatWhen(state.when) : null, '[WHEN]?', true)}
            <div class="composer-priority">
                <span class="composer-priority-label">
                    Priority <b id="priority-label">${getPriorityBand(state.priority)}</b>
                </span>
                <input type="range" id="priority-slider" min="0" max="100" value="${state.priority}" />
                <span class="composer-priority-value" id="priority-value">${state.priority}</span>
            </div>
        </div>

        <div class="composer-row composer-controls">
            <div class="composer-echo${state.verb && state.subject && state.target ? ' is-ready' : ''}">${renderEcho()}</div>
            <button id="commit-btn" class="nui-btn nui-btn--primary">Commit</button>
            <button id="clear-btn" class="nui-btn nui-btn--danger">Clear</button>
        </div>

        <div id="autocomplete-panel" class="nui-menu" hidden></div>
        <div id="verb-menu" class="nui-menu" hidden></div>
        <div id="when-menu" class="nui-menu" hidden></div>
    `;

    state.container.innerHTML = html;

    // Wire up event handlers
    wireEventHandlers();
}

/**
 * Render a slot chip.
 *
 * The three states (required-and-empty, optional-and-empty, filled) are
 * design-system chip modifiers rather than inline colours + onmouseover
 * handlers, so hover/focus behaviour matches every other control in the HUD.
 */
function renderSlotChip(slotName, value, placeholder, optional = false) {
    const modifier = value
        ? 'nui-chip--filled'
        : optional
        ? 'nui-chip--optional'
        : 'nui-chip--required';

    return `<button type="button" class="nui-chip slot-chip ${modifier}" data-slot="${slotName}">${value || placeholder}</button>`;
}

/**
 * Show a slot-picker menu, positioned in VIEWPORT space against its chip.
 *
 * The menu is `position: fixed` (see command-composer.css) so it escapes the
 * panel frame's clipping. That means nothing positions it for us — we place it
 * above the chip, since the composer docks at the bottom edge, and flip below
 * only if there genuinely isn't room above.
 */
function openMenu(menu, slotName) {
    menu.hidden = false;

    const chip = state.container.querySelector(`.slot-chip[data-slot="${slotName}"]`);
    if (!chip) return;

    const anchor = chip.getBoundingClientRect();
    const gap = 6;
    const height = menu.offsetHeight;

    const fitsAbove = anchor.top - gap - height >= 0;
    menu.style.top = fitsAbove
        ? `${anchor.top - gap - height}px`
        : `${anchor.bottom + gap}px`;
    // Keep the menu on screen when the chip sits near the right edge.
    menu.style.left = `${Math.max(gap, Math.min(anchor.left, window.innerWidth - menu.offsetWidth - gap))}px`;
}

/**
 * Wire up event handlers after render
 */
function wireEventHandlers() {
    if (!state.container) return;

    // Slot chip clicks
    const chips = state.container.querySelectorAll('.slot-chip');
    for (const chip of chips) {
        chip.addEventListener('click', () => {
            const slotName = chip.getAttribute('data-slot');
            openSlotEditor(slotName);
        });
    }

    // Priority slider
    const slider = state.container.querySelector('#priority-slider');
    if (slider) {
        slider.addEventListener('input', (e) => {
            state.priority = parseInt(e.target.value, 10);
            updatePriorityLabel();
            updateEcho();
        });
    }

    // Commit button
    const commitBtn = state.container.querySelector('#commit-btn');
    if (commitBtn) {
        commitBtn.addEventListener('click', handleCommit);
        updateCommitButton();
    }

    // Clear button
    const clearBtn = state.container.querySelector('#clear-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', handleClear);
    }
}

/**
 * Open slot editor (verb menu, autocomplete, etc.)
 */
function openSlotEditor(slotName) {
    state.activeSlot = slotName;

    if (slotName === 'verb') {
        renderVerbMenu();
    } else if (slotName === 'subject') {
        // For now, simple prompt (TODO: autocomplete org groups)
        const type = prompt('Subject type: group, idle-filter, or ai?', 'group');
        if (!type) return;

        if (type === 'group') {
            const groupId = parseInt(prompt('Group ID?', '1'), 10);
            state.subject = { type: 'group', groupId };
        } else if (type === 'idle-filter') {
            const filterClass = prompt('Filter class (e.g., armour, infantry)?', 'armour');
            state.subject = { type: 'idle-filter', filterClass };
        } else if (type === 'ai') {
            state.subject = { type: 'ai' };
        }

        render();
    } else if (slotName === 'target') {
        renderAutocomplete();
    } else if (slotName === 'when') {
        renderWhenMenu();
    }
}

/**
 * Render verb menu
 */
function renderVerbMenu() {
    const verbs = [
        'attack', 'secure', 'defend', 'hold', 'patrol',
        'screen', 'scout', 'escort', 'withdraw', 'reinforce', 'build'
    ];

    const menu = state.container.querySelector('#verb-menu');
    if (!menu) return;

    menu.innerHTML = verbs
        .map((v) => `<div class="nui-menu__item verb-option" data-verb="${v}">${v}</div>`)
        .join('');

    openMenu(menu, 'verb');

    // Wire handlers
    const options = menu.querySelectorAll('.verb-option');
    for (const option of options) {
        option.addEventListener('click', () => {
            state.verb = option.getAttribute('data-verb');
            menu.hidden = true;
            render();
        });
    }
}

/**
 * Render autocomplete for target
 */
function renderAutocomplete() {
    const panel = state.container.querySelector('#autocomplete-panel');
    if (!panel) return;

    // Simple search for now
    const query = prompt('Search for target (region, objective, landmark, etc.)?', '');
    if (!query) return;

    const results = namedEntityIndex.search(query, undefined, 10);

    if (results.length === 0) {
        alert('No results found');
        return;
    }

    // For simplicity, take first result
    // TODO: Show list and let user pick
    const entity = results[0];
    state.target = {
        shape: 'entity',
        entity,
    };

    render();
}

/**
 * Render when-condition menu
 */
function renderWhenMenu() {
    const menu = state.container.querySelector('#when-menu');
    if (!menu) return;

    const conditions = [
        { label: 'Now (default)', value: null },
        { label: 'When region contested', value: { type: 'region-contested', regionId: 'north' } },
        { label: 'When under attack', value: { type: 'under-attack' } },
        { label: 'After objective complete', value: { type: 'objective-complete', objectiveId: 1 } },
        { label: 'If strength below 50%', value: { type: 'strength-below', percent: 50 } },
    ];

    menu.innerHTML = conditions
        .map((c, i) => `<div class="nui-menu__item when-option" data-index="${i}">${c.label}</div>`)
        .join('');

    openMenu(menu, 'when');

    // Wire handlers
    const options = menu.querySelectorAll('.when-option');
    for (const option of options) {
        option.addEventListener('click', () => {
            const index = parseInt(option.getAttribute('data-index'), 10);
            state.when = conditions[index].value;
            menu.hidden = true;
            render();
        });
    }
}

/**
 * Format subject for display
 */
function formatSubject(subject) {
    if (subject.type === 'group') {
        return `Group ${subject.groupId}`;
    } else if (subject.type === 'idle-filter') {
        return `Idle ${subject.filterClass}`;
    } else if (subject.type === 'ai') {
        return 'the AI';
    }
    return 'Unknown';
}

/**
 * Format target for display
 */
function formatTarget(target) {
    if (target.entity) {
        return target.entity.name;
    } else if (target.point) {
        return `(${Math.round(target.point.x)}, ${Math.round(target.point.z)})`;
    } else if (target.area) {
        return `Area at (${Math.round(target.area.x)}, ${Math.round(target.area.z)})`;
    }
    return 'Unknown';
}

/**
 * Format when-condition for display
 */
function formatWhen(when) {
    if (!when) return null;

    switch (when.type) {
        case 'now':
            return 'now';
        case 'region-contested':
            return `when ${when.regionId} contested`;
        case 'under-attack':
            return 'when under attack';
        case 'objective-complete':
            return `after objective ${when.objectiveId}`;
        case 'strength-below':
            return `if strength <${when.percent}%`;
        default:
            return 'unknown';
    }
}

/**
 * Render plain-language echo
 */
function renderEcho() {
    if (!state.verb || !state.subject || !state.target) {
        return 'Fill all required slots to see the command preview...';
    }

    const subjectText = formatSubject(state.subject);
    const targetText = formatTarget(state.target);
    const priorityText = getPriorityBand(state.priority);
    const whenText = state.when ? ` — ${formatWhen(state.when)}` : '';

    return `"${subjectText} — ${state.verb} ${targetText} — ${priorityText} priority${whenText}"`;
}

/**
 * Update echo in place (for priority slider changes)
 */
function updateEcho() {
    const echoDiv = state.container.querySelector('.composer-echo');
    if (echoDiv) {
        echoDiv.innerHTML = renderEcho();
        // A complete sentence reads as real text; the placeholder stays dim
        // and italic so the difference is visible at a glance.
        echoDiv.classList.toggle('is-ready', Boolean(state.verb && state.subject && state.target));
    }
}

/**
 * Update the priority readout.
 *
 * Both halves matter: the band is what the echo sentence says, the exact
 * integer is what actually goes on the wire in the compiled directive — two
 * commands can read "high" and carry 61 vs 99, so the number stays visible.
 */
function updatePriorityLabel() {
    const label = state.container.querySelector('#priority-label');
    if (label) {
        label.textContent = getPriorityBand(state.priority);
    }
    const value = state.container.querySelector('#priority-value');
    if (value) {
        value.textContent = String(state.priority);
    }
}

/**
 * Update commit button state.
 *
 * Disabled styling is the design system's :disabled rule — the button keeps
 * its primary class throughout so it doesn't change identity when it becomes
 * committable.
 */
function updateCommitButton() {
    const btn = state.container.querySelector('#commit-btn');
    if (!btn) return;

    const intent = buildIntent();
    const error = intent ? validateIntent(intent) : 'Missing required slots';

    btn.disabled = Boolean(error);
    btn.title = error || 'Click to commit this command';
}

/**
 * Build CommandIntent from current state
 */
function buildIntent() {
    if (!state.verb || !state.subject || !state.target) {
        return null;
    }

    return {
        verb: state.verb,
        subject: state.subject,
        target: state.target,
        priority: state.priority,
        when: state.when || undefined,
    };
}

/**
 * Handle commit button click
 */
function handleCommit() {
    const intent = buildIntent();
    if (!intent) {
        alert('Cannot commit: missing required slots');
        return;
    }

    const error = validateIntent(intent);
    if (error) {
        alert(`Invalid command: ${error}`);
        return;
    }

    const compiled = compileIntent(intent);
    if (!compiled) {
        alert('Failed to compile command');
        return;
    }

    console.log('[command-composer] Compiled command:', compiled);

    // TODO: Send via ctx.sendCommand()
    if (state.ctx && state.ctx.sendCommand) {
        state.ctx.sendCommand(compiled);
        alert('Command sent! (Check console for payload)');
    } else {
        alert('sendCommand not wired yet (see console for compiled payload)');
    }

    // Clear after commit
    handleClear();
}

/**
 * Handle clear button click
 */
function handleClear() {
    state.verb = null;
    state.subject = null;
    state.target = null;
    state.priority = 50;
    state.when = null;
    state.activeSlot = null;
    state.searchQuery = '';
    state.mapArmActive = false;

    render();
}

/**
 * Export widget interface
 */
export default {
    id: 'command-composer',
    init,
    dispose,
};
