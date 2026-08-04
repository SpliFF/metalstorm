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
    getAcceptedTargetShapes,
    PRIORITY_BANDS,
} from '../ui/native-ui/compile-table.js';
import { mapGestureBridge } from '../ui/native-ui/map-gesture.js';
import { previewDirectiveCost, matchSelectionToGroup } from '../ui/native-ui/cost-preview.js';
import { listCommandPresets, saveCommandPreset, deleteCommandPreset } from '../ui/native-ui/command-presets.js';
import { acceleratorFill } from '../ui/native-ui/free-text-accelerator.js';
import { injectStyle } from '../ui/ui.js';
import composerCss from './command-composer.css?raw';

/**
 * The cost-mirror + region-index modules (PLAN-metalstorm-authority.md §4/§5)
 * are game-authored files served over HTTP from the game's own `ui/lib/`
 * directory — same as every other game-dir widget the loader fetches — not
 * part of the client bundle. This widget is registered `builtin: true`
 * (it needs the bundled compile-table/named-entity-index), so it reaches
 * them the same way the loader reaches a game-dir widget: a runtime
 * `import()` of their HTTP URL. The path is hardcoded to Metalstorm because
 * this widget already is — compile-table.ts's DirectiveType/StandingOrderType
 * enums mirror Metalstorm's protocol.fbs, not a generic game contract.
 */
const AUTHORITY_COST_LIB_URL = '/api/games/data/metalstorm/ui/lib/authority-cost.js';
const AUTHORITY_COST_SPEC_URL = '/api/games/data/metalstorm/authority_cost.json';

/** Idle-filter subject classes offered by the Subject picker. A closed
 *  vocabulary (mirrors free-text-accelerator.ts's IDLE_FILTER_CLASSES) — the
 *  composer builds valid-by-construction intents, so it only offers filter
 *  classes the sim understands rather than a free-text box. */
const IDLE_FILTER_CLASSES = ['armour', 'infantry', 'air', 'artillery'];

/** Entity types the Target picker searches — the "where to act" vocabulary
 *  (regions/objectives/landmarks), never Subjects (groups). Mirrors
 *  free-text-accelerator.ts's TARGET_ENTITY_TYPES. */
const TARGET_ENTITY_TYPES = ['region', 'district', 'city', 'objective', 'landmark', 'enemy-force'];

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
    targetSearchRefresh: null, // () => void while the Target name-search menu is open; re-runs its result list on a live index change
    mapArmActive: false,    // Whether a map-arm gesture is in flight (task 4)
    subjectAutoFilled: false, // True while Subject came from selection sync, not a manual pick

    // Cost preview (task 5)
    costModel: null,        // authority-cost.js cost model, once loaded (null = not ready/unavailable)

    // Presets (task 6): a filled, re-parameterisable template, not logic —
    // re-loading one just re-fills the slots; re-issuing it re-runs the
    // normal compile. `presetsCache` mirrors the server list so the menu
    // doesn't refetch on every open; refreshed on mount and after
    // save/delete. `staleNotice` surfaces "player must re-pick" (§9) —
    // never a silent retarget.
    presetsCache: null,     // CommandPreset[] | null (null = not loaded yet)
    staleNotice: null,      // string | null

    // Free-text accelerator (task 7): OPTIONAL, gated behind its own toggle
    // (hidden by default — the structured builder is the source of truth,
    // this is a power-user shortcut, not the primary UI). `accelValue`
    // persists the typed text across re-renders; `accelNotice` is a
    // transparency readout of what the last Fill matched vs ignored, never
    // an error state.
    accelVisible: false,    // Whether the text-field row is shown
    accelValue: '',         // Current text-field contents
    accelNotice: null,      // string | null

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

    // Subscribe to index changes so an open Target name-search refreshes its
    // result list live as the producer streams in regions/objectives. The
    // shape-option target menu doesn't depend on the index, so there's nothing
    // to refresh unless the search sub-view is open.
    const unsubIndex = namedEntityIndex.onChange(() => {
        if (state.targetSearchRefresh) state.targetSearchRefresh();
    });
    state.unsubs.push(unsubIndex);

    // PLAN-metalstorm-scripting.md task 4: "selecting a group on the map
    // pre-fills the Subject" — driven by the world selection + org-group
    // roster, both mirrored into the store by main.ts (gp:sceneState /
    // gp:orgGroups). Also recomputes the cost preview since it depends on
    // the resolved Subject's group.
    const unsubSelection = ctx.store.subscribe(['selection', 'orgGroups'], onSelectionOrGroupsChanged);
    state.unsubs.push(unsubSelection);

    // Pool balance changes (award/charge) shift the cost preview's
    // affordability verdict even with the same target armed.
    const unsubPools = ctx.store.subscribe(['teamRulesParams'], () => {
        if (state.verb && state.subject && state.target) updateCommitButton();
    });
    state.unsubs.push(unsubPools);

    // Map-arm gesture result (task 4).
    const unsubGesture = mapGestureBridge.onResult(handleMapGestureResult);
    state.unsubs.push(unsubGesture);

    // Cost model loads asynchronously; the preview/commit gate degrades to
    // "unpredictable" (never blocks) until it's ready — never a hard
    // dependency for the composer to be usable.
    loadCostModel();

    // Presets (task 6): best-effort prefetch so the first menu-open isn't a
    // blank flash; refreshPresetsCache() re-fetches after save/delete.
    refreshPresetsCache();

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

    if (state.mapArmActive) {
        mapGestureBridge.cancel();
        state.mapArmActive = false;
    }

    // Remove DOM
    if (state.container) {
        state.container.remove();
        state.container = null;
    }
    document.getElementById('command-composer-style')?.remove();

    console.log('[command-composer] Disposed');
}

/**
 * Lazily load the authority cost-mirror module + spec (task 5). Failure is
 * logged, not fatal — the preview simply stays unavailable (predict()-null
 * behaviour, same as a missing/unversioned spec — see authority-cost.js).
 */
async function loadCostModel() {
    try {
        const [{ createCostModel }, specRes] = await Promise.all([
            import(/* @vite-ignore */ AUTHORITY_COST_LIB_URL),
            fetch(AUTHORITY_COST_SPEC_URL),
        ]);
        if (!specRes.ok) throw new Error(`authority_cost.json: ${specRes.status}`);
        const spec = await specRes.json();
        state.costModel = createCostModel(spec);
        if (state.verb && state.subject && state.target) updateCommitButton();
    } catch (e) {
        console.warn('[command-composer] cost model unavailable — preview disabled:', e);
    }
}

/**
 * Render the entire widget
 */
function render() {
    if (!state.container) return;

    // A full re-render discards every open menu (they live inside the
    // container's innerHTML), so any live Target-search refresh hook is now
    // dangling — drop it before it fires against detached DOM.
    state.targetSearchRefresh = null;

    // Two rows: the command sentence (with the priority slider tucked to its
    // right) and the echo + commit controls. The [WHEN] chip sits inline with
    // the other slots rather than on its own row — it's part of the same
    // sentence, and a separate row cost 40px of play area for one optional
    // token.
    const html = `
        ${state.staleNotice ? `<div class="composer-row composer-stale-notice">⚠ ${state.staleNotice}</div>` : ''}

        <div class="composer-row composer-sentence">
            ${renderSlotChip('verb', state.verb, '[VERB]')}
            ${renderSlotChip('subject', state.subject ? formatSubject(state.subject) : null, '[SUBJECT]')}
            ${renderSlotChip('target', targetChipLabel(), '[TARGET]')}
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
            <div class="composer-cost" id="composer-cost"></div>
            <button id="accel-toggle-btn" class="nui-btn${state.accelVisible ? ' is-active' : ''}"
                title="Type a command in plain keywords (optional accelerator — the chips above stay in charge)"
                aria-pressed="${state.accelVisible}">⌨</button>
            <button id="save-preset-btn" class="nui-btn" title="Save this command as a reusable preset">💾</button>
            <button id="presets-btn" class="nui-btn" title="Load or delete a saved preset">📁</button>
            <button id="commit-btn" class="nui-btn nui-btn--primary">Commit</button>
            <button id="clear-btn" class="nui-btn nui-btn--danger">Clear</button>
        </div>

        ${state.accelVisible ? `
        <div class="composer-row composer-accel">
            <input type="text" id="accel-input" class="composer-accel-input"
                placeholder='Try: &quot;attack meridian high when contested&quot;'
                value="${escapeHtml(state.accelValue)}" />
            <button id="accel-fill-btn" class="nui-btn nui-btn--primary">Fill slots</button>
        </div>
        ${state.accelNotice ? `<div class="composer-row composer-accel-notice">${escapeHtml(state.accelNotice)}</div>` : ''}
        ` : ''}

        <div id="autocomplete-panel" class="nui-menu" hidden></div>
        <div id="verb-menu" class="nui-menu" hidden></div>
        <div id="subject-menu" class="nui-menu" hidden></div>
        <div id="when-menu" class="nui-menu" hidden></div>
        <div id="presets-menu" class="nui-menu" hidden></div>
    `;

    state.container.innerHTML = html;

    // Wire up event handlers
    wireEventHandlers();
    updateCostPreviewDisplay();
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

/** Target chip label — shows the drawing-in-progress state while a map-arm
 *  gesture (task 4) is armed, otherwise the resolved target (or nothing). */
function targetChipLabel() {
    if (state.mapArmActive) return 'Drawing… (click to cancel)';
    return state.target ? formatTarget(state.target) : null;
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
    const chip = state.container.querySelector(`.slot-chip[data-slot="${slotName}"]`);
    if (!chip) return;
    openMenuNear(menu, chip);
}

/** Position-and-show `menu` against an arbitrary anchor element (a slot chip
 *  or a toolbar button, e.g. the presets button — task 6). Factored out of
 *  `openMenu` so non-slot triggers can reuse the same viewport-space
 *  placement math instead of needing a fake `data-slot`. */
function openMenuNear(menu, anchorEl) {
    menu.hidden = false;

    const anchor = anchorEl.getBoundingClientRect();
    const gap = 6;
    const height = menu.offsetHeight;

    const fitsAbove = anchor.top - gap - height >= 0;
    menu.style.top = fitsAbove
        ? `${anchor.top - gap - height}px`
        : `${anchor.bottom + gap}px`;
    // Keep the menu on screen when the anchor sits near the right edge.
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
            // Clicking the Target chip while a gesture is armed cancels it —
            // there is no separate "map mode" to step out of otherwise.
            if (slotName === 'target' && state.mapArmActive) {
                mapGestureBridge.cancel();
                return;
            }
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

    // Presets (task 6)
    const saveBtn = state.container.querySelector('#save-preset-btn');
    if (saveBtn) saveBtn.addEventListener('click', handleSavePreset);

    const presetsBtn = state.container.querySelector('#presets-btn');
    if (presetsBtn) presetsBtn.addEventListener('click', () => renderPresetsMenu(presetsBtn));

    // Free-text accelerator (task 7)
    const accelToggleBtn = state.container.querySelector('#accel-toggle-btn');
    if (accelToggleBtn) {
        accelToggleBtn.addEventListener('click', () => {
            state.accelVisible = !state.accelVisible;
            render();
            if (state.accelVisible) state.container.querySelector('#accel-input')?.focus();
        });
    }

    const accelInput = state.container.querySelector('#accel-input');
    if (accelInput) {
        accelInput.addEventListener('input', (e) => { state.accelValue = e.target.value; });
        accelInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') handleAccelFill();
        });
    }

    const accelFillBtn = state.container.querySelector('#accel-fill-btn');
    if (accelFillBtn) accelFillBtn.addEventListener('click', handleAccelFill);
}

/**
 * Open slot editor (verb menu, autocomplete, etc.)
 */
function openSlotEditor(slotName) {
    state.activeSlot = slotName;
    // Any manual re-pick is the player acting on a stale-preset notice
    // (§9) or refining an accelerator-filled sentence — clear both rather
    // than leaving either stuck on screen.
    state.staleNotice = null;
    state.accelNotice = null;

    if (slotName === 'verb') {
        renderVerbMenu();
    } else if (slotName === 'subject') {
        renderSubjectMenu();
    } else if (slotName === 'target') {
        renderTargetMenu();
    } else if (slotName === 'when') {
        renderWhenMenu();
    }
}

/**
 * Render the Subject picker (task 4): the live org-group roster from the store
 * (`gp:orgGroups`, own team), plus the closed-vocabulary idle-filter classes
 * and the AI. Replaces the old `prompt('Subject type…')` / `prompt('Group ID?')`
 * chain — a player picks a real group by name, never types a raw id.
 *
 * The menu is a `.nui-menu` positioned by `openMenu` (viewport-space,
 * position:fixed) so it escapes the composer panel's clip and the
 * transformed-mount containing-block trap (native-ui.css §mounts).
 */
function renderSubjectMenu() {
    const menu = state.container.querySelector('#subject-menu');
    if (!menu) return;

    const groups = state.ctx?.store.getOrgGroups() ?? [];
    const groupItems = groups
        .map((g) => `<div class="nui-menu__item subject-group-option" data-group-id="${g.groupId}">${escapeHtml(g.name || `Group ${g.groupId}`)} <span class="composer-menu-hint">${g.echelon}</span></div>`)
        .join('');

    const idleItems = IDLE_FILTER_CLASSES
        .map((c) => `<div class="nui-menu__item subject-idle-option" data-class="${c}">Idle ${c}</div>`)
        .join('');

    menu.innerHTML = `
        ${groups.length
            ? groupItems
            : `<div class="nui-menu__item nui-menu__item--disabled">No groups yet — select units on the map</div>`}
        <div class="nui-menu__sep"></div>
        ${idleItems}
        <div class="nui-menu__sep"></div>
        <div class="nui-menu__item subject-ai-option">the AI</div>
    `;

    openMenu(menu, 'subject');

    const setSubject = (subject) => {
        state.subject = subject;
        // A manual pick overrides whatever selection sync had set (task 4).
        state.subjectAutoFilled = false;
        menu.hidden = true;
        render();
    };

    for (const el of menu.querySelectorAll('.subject-group-option')) {
        el.addEventListener('click', () =>
            setSubject({ type: 'group', groupId: parseInt(el.getAttribute('data-group-id'), 10) }));
    }
    for (const el of menu.querySelectorAll('.subject-idle-option')) {
        el.addEventListener('click', () =>
            setSubject({ type: 'idle-filter', filterClass: el.getAttribute('data-class') }));
    }
    const aiOption = menu.querySelector('.subject-ai-option');
    if (aiOption) aiOption.addEventListener('click', () => setSubject({ type: 'ai' }));
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
            // The target shapes a verb accepts can change (or a previously
            // valid map-drawn target can become invalid for the new verb) —
            // clearing keeps the composer valid-by-construction rather than
            // holding a stale verb:shape pair the compile table would reject.
            state.target = null;
            menu.hidden = true;
            render();
        });
    }
}

/**
 * Render the target slot's menu (task 4): map-arm options for whichever
 * shapes the current verb accepts, plus the existing name search. No
 * separate "map mode" — this is the same inline menu the target chip
 * always opens.
 */
function renderTargetMenu() {
    const menu = state.container.querySelector('#autocomplete-panel');
    if (!menu) return;

    // Showing the shape-option view — the name-search sub-view (and its
    // live-refresh hook) is not active here.
    state.targetSearchRefresh = null;

    if (!state.verb) {
        menu.innerHTML = `<div class="nui-menu__item nui-menu__item--disabled">Choose a verb first</div>`;
        openMenu(menu, 'target');
        return;
    }

    const mapShapes = getAcceptedTargetShapes(state.verb).filter((s) => s !== 'entity');
    const mapItems = mapShapes
        .map((s) => `<div class="nui-menu__item target-map-option" data-shape="${s}">${mapShapeLabel(s)}</div>`)
        .join('');

    menu.innerHTML = `
        ${mapItems}
        <div class="nui-menu__item target-search-option">🔍 Search by name…</div>
    `;
    openMenu(menu, 'target');

    for (const el of menu.querySelectorAll('.target-map-option')) {
        el.addEventListener('click', () => {
            menu.hidden = true;
            armMapTarget(el.getAttribute('data-shape'));
        });
    }
    const searchOpt = menu.querySelector('.target-search-option');
    if (searchOpt) {
        searchOpt.addEventListener('click', () => {
            menu.hidden = true;
            runEntitySearch();
        });
    }
}

function mapShapeLabel(targetShape) {
    if (targetShape === 'point') return '📍 Point on map';
    if (targetShape === 'area') return '⭕ Paint area on map';
    if (targetShape === 'route') return '➰ Draw route on map';
    return targetShape;
}

/** Arm the shared gesture capture for `targetShape` (task 4). The result
 *  lands in `handleMapGestureResult` via the mapGestureBridge subscription. */
function armMapTarget(targetShape) {
    const gestureShape = targetShape === 'point' ? 'Point' : targetShape === 'area' ? 'Circle' : 'Polyline';
    state.mapArmActive = true;
    render();
    mapGestureBridge.arm({ shape: gestureShape });
}

/** Map-arm gesture finished (committed or cancelled) — task 4. */
function handleMapGestureResult(result) {
    state.mapArmActive = false;
    if (result.committed && result.shape && result.params) {
        state.target = shapeResultToTarget(result.shape, result.params);
    }
    render();
}

/** Convert a `ShapeGestureCapture` result (shape-gesture-capture.ts params
 *  layout) into a `CommandTarget` (compile-table.ts). */
function shapeResultToTarget(shape, params) {
    if (shape === 'Point') {
        return { shape: 'point', point: { x: params[0], z: params[2] } };
    }
    if (shape === 'Circle') {
        return { shape: 'area', area: { x: params[0], z: params[2], radius: params[3] } };
    }
    if (shape === 'Polyline') {
        // params = [frontage, x1,y1,z1, x2,y2,z2, ...]
        const route = [];
        for (let i = 1; i < params.length; i += 3) {
            route.push({ x: params[i], z: params[i + 2] });
        }
        return { shape: 'route', route };
    }
    return null;
}

/**
 * Search for a named-entity target (task 3): an inline search field + live
 * result list rendered into the target menu, fed by the live namedEntityIndex
 * (regions / objectives / landmarks — the producer's output). Replaces the old
 * `prompt()` + silent "take results[0]" with a real picker: the player types,
 * sees matching places, and clicks the one they mean.
 *
 * Reuses the `#autocomplete-panel` menu the map-shape target options open into,
 * so it inherits the same position:fixed / clip-escaping placement.
 */
function runEntitySearch() {
    const menu = state.container.querySelector('#autocomplete-panel');
    if (!menu) return;

    menu.innerHTML = `
        <div class="composer-target-search">
            <input type="text" id="target-search-input" class="composer-accel-input"
                placeholder="Search regions, objectives…" autocomplete="off" />
        </div>
        <div id="target-search-results"></div>
    `;
    openMenu(menu, 'target');

    const input = menu.querySelector('#target-search-input');
    const resultsEl = menu.querySelector('#target-search-results');

    const renderResults = () => {
        const query = input.value.trim();
        // Empty query: offer the full set (capped) so the picker is browsable,
        // not just searchable — a player who doesn't know an exact name can
        // still see what's on the board.
        const results = query
            ? namedEntityIndex.search(query, TARGET_ENTITY_TYPES, 12)
            : namedEntityIndex.getAll().filter((e) => TARGET_ENTITY_TYPES.includes(e.type)).slice(0, 12);

        if (results.length === 0) {
            resultsEl.innerHTML = `<div class="nui-menu__item nui-menu__item--disabled">${query ? 'No matches' : 'No named places on the board yet'}</div>`;
            return;
        }

        resultsEl.innerHTML = results
            .map((e, i) => `<div class="nui-menu__item target-result-option" data-index="${i}">${escapeHtml(e.name)} <span class="composer-menu-hint">${e.type}</span></div>`)
            .join('');

        for (const el of resultsEl.querySelectorAll('.target-result-option')) {
            el.addEventListener('click', () => {
                const entity = results[parseInt(el.getAttribute('data-index'), 10)];
                menu.hidden = true;
                state.target = { shape: 'entity', entity };
                render();
            });
        }
    };

    input.addEventListener('input', renderResults);
    // Keep the result list live while the producer streams entities in.
    state.targetSearchRefresh = renderResults;
    renderResults();
    input.focus();
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
        const label = `Group ${subject.groupId}`;
        return state.subjectAutoFilled ? `${label} (from selection)` : label;
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
    } else if (target.route) {
        return `Route (${target.route.length} pts)`;
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
    updateCostPreviewDisplay();
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
 * Resolve the org group backing the current Subject (group-typed only),
 * from the store's org-group snapshot (`gp:orgGroups` — task 4/5).
 */
function resolveSubjectGroup() {
    if (!state.subject || state.subject.type !== 'group' || !state.subject.groupId) return null;
    const groups = state.ctx?.store.getOrgGroups() ?? [];
    return groups.find((g) => g.groupId === state.subject.groupId) ?? null;
}

/**
 * Compute the current cost preview (task 5), or null if unpredictable
 * (no cost model yet, an AIGuidance target, or the cost spec has no entry
 * for the resolved order class — see cost-preview.ts for the full
 * breakdown). GroupDirective and StandingOrder targets both preview now —
 * the sim charges both at create time (game_authority.lua
 * ChargeDirective/ChargeStandingOrder).
 */
function computeCostPreview() {
    if (!state.costModel || !state.ctx) return null;
    const intent = buildIntent();
    if (!intent || validateIntent(intent)) return null;
    const compiled = compileIntent(intent);
    if (!compiled) return null;

    const group = resolveSubjectGroup();
    const teamId = state.ctx.identity.teamId;
    // Spring's sim playerNum — the id `authority_player_<id>` is keyed by
    // server-side. Not `identity.accountId`: reading that made the personal
    // pool a constant 0, so this preview refused every order the team pool
    // alone couldn't cover (PLAN-endtoend.md D3, PLAN-native-ui.md §3.3).
    const playerId = state.ctx.identity.playerId;
    const playerPool = Number(state.ctx.store.teamRulesParam(teamId, `authority_player_${playerId}`) ?? 0);
    const teamPool = Number(state.ctx.store.teamRulesParam(teamId, 'authority_pool') ?? 0);

    return previewDirectiveCost(compiled.type, group, state.costModel, playerPool, teamPool);
}

/** Render the cost-preview readout next to the commit button (task 5). */
function updateCostPreviewDisplay() {
    const el = state.container?.querySelector('#composer-cost');
    if (!el) return;

    if (!state.verb || !state.subject || !state.target) {
        el.textContent = '';
        el.classList.remove('is-refused');
        return;
    }

    const preview = computeCostPreview();
    if (!preview) {
        // Unpredictable (AIGuidance target, or no cost model yet) — shown
        // as neutral, not an error.
        el.textContent = 'Cost: n/a';
        el.classList.remove('is-refused');
        return;
    }

    el.classList.toggle('is-refused', !preview.affordable);
    el.textContent = preview.affordable
        ? `Cost: ${preview.cost} authority`
        : `Cost: ${preview.cost} authority — short by ${preview.shortfall}`;
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
    let error = intent ? validateIntent(intent) : 'Missing required slots';

    // Predicted-refusal: insufficient authority blocks the send, same as an
    // invalid intent (§4 UI contract — never a silent failure; the shortfall
    // is spelled out in the cost readout above the button).
    if (!error) {
        const preview = computeCostPreview();
        if (preview && !preview.affordable) {
            error = `Insufficient authority (short ${preview.shortfall})`;
        }
    }

    btn.disabled = Boolean(error);
    btn.title = error || 'Click to commit this command';
    updateCostPreviewDisplay();
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

    // Predicted-refusal gate (task 5): never send an order the player can
    // already see they can't afford — re-checked here (not just in
    // updateCommitButton's disabled state) so a stale pool snapshot never
    // lets a click through the disabled button's own title tooltip.
    const preview = computeCostPreview();
    if (preview && !preview.affordable) {
        alert(`Insufficient authority: needs ${preview.cost}, short by ${preview.shortfall}. Order not sent.`);
        return;
    }

    const compiled = compileIntent(intent);
    if (!compiled) {
        alert('Failed to compile command');
        return;
    }

    console.log('[command-composer] Compiled command:', compiled);

    if (state.ctx && state.ctx.sendCommand) {
        state.ctx.sendCommand(compiled);
        alert('Command sent!');
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
    if (state.mapArmActive) {
        mapGestureBridge.cancel();
    }
    state.verb = null;
    state.subject = null;
    state.target = null;
    state.priority = 50;
    state.when = null;
    state.activeSlot = null;
    state.searchQuery = '';
    state.mapArmActive = false;
    state.subjectAutoFilled = false;
    state.staleNotice = null;
    state.accelNotice = null;

    render();
}

/**
 * Preset save/load (PLAN-metalstorm-scripting.md task 6). A preset stores a
 * *filled* CommandIntent, never logic — loading one just re-fills the slots
 * exactly like a manual pick would, and committing re-runs the normal
 * compile. Nothing here bypasses validateIntent/compileIntent.
 */

/** Re-fetch the caller's saved presets and re-render the menu if it's open. */
async function refreshPresetsCache() {
    state.presetsCache = await listCommandPresets();
    const menu = state.container?.querySelector('#presets-menu');
    if (menu && !menu.hidden) renderPresetsMenu();
}

/** Save button: prompts for a name and stores the current filled intent.
 *  `prompt()` is intentional here — naming a preset is genuine free text, not a
 *  pick from a closed vocabulary (unlike the Subject/Target slots, which are
 *  now index-fed .nui menus). Disabled-by-content, not disabled-by-attribute. */
async function handleSavePreset() {
    const intent = buildIntent();
    if (!intent || validateIntent(intent)) {
        alert('Fill all required slots (verb, subject, target) before saving a preset.');
        return;
    }

    const name = prompt('Preset name? (e.g. "Assault North Basin — high")', '');
    if (!name) return;

    const error = await saveCommandPreset(name.trim(), intent);
    if (error) {
        alert(`Could not save preset: ${error}`);
        return;
    }

    await refreshPresetsCache();
}

/** Presets button: opens the saved-preset list. Each entry loads on click;
 *  a trailing × deletes it (with confirmation, since delete has no undo). */
function renderPresetsMenu(anchorEl) {
    const menu = state.container?.querySelector('#presets-menu');
    if (!menu) return;

    const button = anchorEl ?? state.container.querySelector('#presets-btn');

    if (state.presetsCache === null) {
        menu.innerHTML = `<div class="nui-menu__item nui-menu__item--disabled">Loading…</div>`;
        openMenuNear(menu, button);
        refreshPresetsCache();
        return;
    }

    if (state.presetsCache.length === 0) {
        menu.innerHTML = `<div class="nui-menu__item nui-menu__item--disabled">No saved presets yet</div>`;
        openMenuNear(menu, button);
        return;
    }

    menu.innerHTML = state.presetsCache
        .map((p, i) => `
            <div class="composer-preset-item" data-index="${i}">
                <span class="composer-preset-name">${escapeHtml(p.name)}</span>
                <button type="button" class="composer-preset-delete" data-index="${i}" title="Delete preset">×</button>
            </div>
        `)
        .join('');
    openMenuNear(menu, button);

    for (const nameEl of menu.querySelectorAll('.composer-preset-name')) {
        nameEl.addEventListener('click', () => {
            const index = parseInt(nameEl.closest('.composer-preset-item').getAttribute('data-index'), 10);
            menu.hidden = true;
            loadPreset(state.presetsCache[index]);
        });
    }
    for (const delEl of menu.querySelectorAll('.composer-preset-delete')) {
        delEl.addEventListener('click', async (e) => {
            e.stopPropagation();
            const index = parseInt(delEl.getAttribute('data-index'), 10);
            const preset = state.presetsCache[index];
            if (!preset || !confirm(`Delete preset "${preset.name}"?`)) return;
            await deleteCommandPreset(preset.name);
            await refreshPresetsCache();
        });
    }
}

function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

/**
 * Load a saved preset into the slots (task 6). A preset holds a `NamedEntity`
 * snapshot for an entity target and a bare `groupId` for a group subject —
 * both are re-validated against *live* state here, never trusted as-is:
 *
 *   - Subject (group): the groupId must still exist in the current org-group
 *     roster. If not, the Subject slot is left EMPTY and flagged — never
 *     silently rebound to a different group (§9 "never silently retarget").
 *   - Target (entity): re-resolved by (type, id) against the live
 *     `namedEntityIndex`, both to catch a deleted/completed entity AND to
 *     pick up a live rename (§9 "index keys on id; display text tracks
 *     renames live") rather than replaying the preset's stale name/position.
 *   - Target (point/area/route): raw coordinates, never stale — filled as-is.
 *   - Priority / When: always filled as-is (no entity reference to go stale).
 */
function loadPreset(preset) {
    if (!preset || !preset.intent) return;
    const intent = preset.intent;
    const staleParts = [];

    state.verb = intent.verb ?? null;
    state.priority = typeof intent.priority === 'number' ? intent.priority : 50;
    state.when = intent.when ?? null;
    state.subjectAutoFilled = false;

    // Subject
    if (intent.subject?.type === 'group') {
        const groups = state.ctx?.store.getOrgGroups() ?? [];
        const stillExists = groups.some((g) => g.groupId === intent.subject.groupId);
        if (stillExists) {
            state.subject = intent.subject;
        } else {
            state.subject = null;
            staleParts.push('the saved group no longer exists');
        }
    } else {
        // idle-filter / ai subjects reference no persistent id — never stale.
        state.subject = intent.subject ?? null;
    }

    // Target
    if (intent.target?.shape === 'entity' && intent.target.entity) {
        const live = namedEntityIndex.get(intent.target.entity.type, intent.target.entity.id);
        if (live) {
            state.target = { shape: 'entity', entity: live };
        } else {
            state.target = null;
            staleParts.push('the saved target no longer exists');
        }
    } else {
        state.target = intent.target ?? null;
    }

    state.staleNotice = staleParts.length
        ? `Preset "${preset.name}" — ${staleParts.join(' and ')}. Please re-pick before committing.`
        : null;

    render();
}

/**
 * Free-text accelerator (PLAN-metalstorm-scripting.md task 7): parses the
 * typed text with the closed-vocabulary keyword→slot dictionary and
 * REPLACES the current verb/subject/target/priority/when with whatever it
 * resolved (a slot it couldn't resolve is cleared, not left stale from
 * before) — same full-replace semantics as loading a preset. This is a
 * proposal, not a send: every chip stays individually clickable afterwards,
 * and Commit still runs the normal validate/compile path untouched.
 */
function handleAccelFill() {
    if (!state.accelValue.trim()) return;

    const result = acceleratorFill(state.accelValue, namedEntityIndex);

    state.verb = result.verb;
    state.subject = result.subject;
    state.target = result.target;
    if (result.priority !== null) state.priority = result.priority;
    state.when = result.when;
    state.subjectAutoFilled = false;
    state.staleNotice = null;

    const filled = [
        result.verb && 'verb', result.subject && 'subject', result.target && 'target',
        result.priority !== null && 'priority', result.when && 'when',
    ].filter(Boolean);

    state.accelNotice = result.unmatched.length
        ? `Filled: ${filled.length ? filled.join(', ') : 'nothing'}. Not recognised: ${result.unmatched.join(', ')}.`
        : filled.length
        ? `Filled: ${filled.join(', ')}.`
        : 'Nothing recognised — try the chips above instead.';

    render();
}

/**
 * Selection/org-group sync (task 4): "selecting a group on the map
 * pre-fills the Subject" — and if the Subject was auto-filled this way, a
 * further selection change keeps it in sync (true two-way: map selection
 * drives the composer, the composer's own manual Subject pick — a plain
 * click on the chip — breaks the auto-follow until Clear).
 */
function onSelectionOrGroupsChanged() {
    if (!state.ctx) return;
    const selection = state.ctx.store.getSelection();
    const groups = state.ctx.store.getOrgGroups();
    const groupId = matchSelectionToGroup(selection.unitIds, groups);

    if (groupId !== null) {
        const alreadySet = state.subject?.type === 'group' && state.subject.groupId === groupId;
        if (!alreadySet && (state.subjectAutoFilled || !state.subject)) {
            state.subject = { type: 'group', groupId };
            state.subjectAutoFilled = true;
            render();
            return;
        }
    } else if (state.subjectAutoFilled) {
        // Selection no longer resolves to any group — drop the auto-fill
        // rather than leaving a stale binding the player never chose.
        state.subject = null;
        state.subjectAutoFilled = false;
        render();
        return;
    }

    // Group roster/base-cost data may have changed even without a Subject
    // change (e.g. a member died) — refresh the cost readout either way.
    updateCostPreviewDisplay();
}

/**
 * Export widget interface
 */
export default {
    id: 'command-composer',
    init,
    dispose,
};
