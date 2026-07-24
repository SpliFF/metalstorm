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

    // Create container
    const container = document.createElement('div');
    container.className = 'command-composer';
    container.style.cssText = `
        background: rgba(20, 20, 30, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 8px;
        padding: 16px;
        min-width: 500px;
        max-width: 700px;
        color: #fff;
        font-family: monospace;
        font-size: 14px;
    `;

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

    console.log('[command-composer] Disposed');
}

/**
 * Render the entire widget
 */
function render() {
    if (!state.container) return;

    const html = `
        <div class="composer-header">
            <h3 style="margin: 0 0 12px 0;">Compose Command</h3>
        </div>

        <div class="composer-sentence" style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px;">
            ${renderSlotChip('verb', state.verb, '[VERB]')}
            ${renderSlotChip('subject', state.subject ? formatSubject(state.subject) : null, '[SUBJECT]')}
            ${renderSlotChip('target', state.target ? formatTarget(state.target) : null, '[TARGET]')}
        </div>

        <div class="composer-priority" style="margin-bottom: 16px;">
            <label style="display: block; margin-bottom: 8px;">
                Priority: <span id="priority-label">${getPriorityBand(state.priority)}</span> (${state.priority})
            </label>
            <input
                type="range"
                id="priority-slider"
                min="0"
                max="100"
                value="${state.priority}"
                style="width: 100%;"
            />
        </div>

        <div class="composer-when" style="margin-bottom: 16px;">
            ${renderSlotChip('when', state.when ? formatWhen(state.when) : null, '[WHEN]?', true)}
        </div>

        <div class="composer-echo" style="
            background: rgba(50, 50, 70, 0.5);
            padding: 12px;
            border-radius: 4px;
            margin-bottom: 16px;
            min-height: 40px;
            font-style: italic;
            color: #aaa;
        ">
            ${renderEcho()}
        </div>

        <div class="composer-controls" style="display: flex; gap: 8px;">
            <button id="commit-btn" style="
                flex: 1;
                padding: 10px;
                background: #4a9eff;
                border: none;
                border-radius: 4px;
                color: white;
                font-weight: bold;
                cursor: pointer;
            ">
                Commit Command
            </button>
            <button id="clear-btn" style="
                padding: 10px 20px;
                background: rgba(150, 50, 50, 0.8);
                border: none;
                border-radius: 4px;
                color: white;
                cursor: pointer;
            ">
                Clear
            </button>
        </div>

        <div id="autocomplete-panel" style="display: none;">
            <!-- Autocomplete results go here -->
        </div>

        <div id="verb-menu" style="display: none;">
            <!-- Verb menu goes here -->
        </div>

        <div id="when-menu" style="display: none;">
            <!-- When condition menu goes here -->
        </div>
    `;

    state.container.innerHTML = html;

    // Wire up event handlers
    wireEventHandlers();
}

/**
 * Render a slot chip
 */
function renderSlotChip(slotName, value, placeholder, optional = false) {
    const isEmpty = !value;
    const isRequired = !optional && isEmpty;

    const bgColor = isRequired
        ? 'rgba(200, 80, 80, 0.3)' // Red highlight for required empty slots
        : isEmpty
        ? 'rgba(80, 80, 100, 0.5)'
        : 'rgba(80, 120, 180, 0.7)';

    const displayText = value || placeholder;

    return `
        <button
            class="slot-chip"
            data-slot="${slotName}"
            style="
                background: ${bgColor};
                border: 1px solid rgba(255, 255, 255, 0.3);
                border-radius: 4px;
                padding: 6px 12px;
                color: white;
                cursor: pointer;
                font-size: 14px;
                transition: background 0.2s;
            "
            onmouseover="this.style.background='rgba(100, 140, 200, 0.8)'"
            onmouseout="this.style.background='${bgColor}'"
        >
            ${displayText}
        </button>
    `;
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

    menu.innerHTML = `
        <div style="
            position: absolute;
            background: rgba(30, 30, 40, 0.98);
            border: 1px solid rgba(255, 255, 255, 0.3);
            border-radius: 4px;
            padding: 8px;
            max-height: 200px;
            overflow-y: auto;
            z-index: 1000;
        ">
            ${verbs.map(v => `
                <div
                    class="verb-option"
                    data-verb="${v}"
                    style="
                        padding: 8px;
                        cursor: pointer;
                        border-radius: 4px;
                    "
                    onmouseover="this.style.background='rgba(80, 120, 180, 0.5)'"
                    onmouseout="this.style.background='transparent'"
                >
                    ${v}
                </div>
            `).join('')}
        </div>
    `;

    menu.style.display = 'block';

    // Wire handlers
    const options = menu.querySelectorAll('.verb-option');
    for (const option of options) {
        option.addEventListener('click', () => {
            state.verb = option.getAttribute('data-verb');
            menu.style.display = 'none';
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

    menu.innerHTML = `
        <div style="
            position: absolute;
            background: rgba(30, 30, 40, 0.98);
            border: 1px solid rgba(255, 255, 255, 0.3);
            border-radius: 4px;
            padding: 8px;
            max-height: 250px;
            overflow-y: auto;
            z-index: 1000;
        ">
            ${conditions.map((c, i) => `
                <div
                    class="when-option"
                    data-index="${i}"
                    style="
                        padding: 8px;
                        cursor: pointer;
                        border-radius: 4px;
                    "
                    onmouseover="this.style.background='rgba(80, 120, 180, 0.5)'"
                    onmouseout="this.style.background='transparent'"
                >
                    ${c.label}
                </div>
            `).join('')}
        </div>
    `;

    menu.style.display = 'block';

    // Wire handlers
    const options = menu.querySelectorAll('.when-option');
    for (const option of options) {
        option.addEventListener('click', () => {
            const index = parseInt(option.getAttribute('data-index'), 10);
            state.when = conditions[index].value;
            menu.style.display = 'none';
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
    }
}

/**
 * Update priority label
 */
function updatePriorityLabel() {
    const label = state.container.querySelector('#priority-label');
    if (label) {
        label.textContent = getPriorityBand(state.priority);
    }
}

/**
 * Update commit button state
 */
function updateCommitButton() {
    const btn = state.container.querySelector('#commit-btn');
    if (!btn) return;

    const intent = buildIntent();
    const error = intent ? validateIntent(intent) : 'Missing required slots';

    if (error) {
        btn.disabled = true;
        btn.style.background = '#555';
        btn.style.cursor = 'not-allowed';
        btn.title = error;
    } else {
        btn.disabled = false;
        btn.style.background = '#4a9eff';
        btn.style.cursor = 'pointer';
        btn.title = 'Click to commit this command';
    }
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
