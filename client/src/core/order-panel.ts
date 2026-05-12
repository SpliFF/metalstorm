/**
 * OrderPanel — bottom-left command grid for the currently-selected units.
 *
 * Shows the standard Spring orders (move / stop / attack / patrol / fight /
 * guard / wait / reclaim / repair / resurrect / capture / manualfire /
 * load_units / unload_units) plus the stateful toggles (fire-state,
 * move-state, on/off, repeat, trajectory, cloak, idlemode). Buttons are
 * filtered against each unit's `cmdDescs` snapshot (streamed from the
 * server every ~1Hz via UnitCmdDescsUpdate) so a unit only ever sees
 * commands it can actually execute.
 *
 * Click behaviour mirrors `InputManager`'s keyboard hotkeys:
 *   - Instant cmds (stop, wait, fire-state, move-state, on/off, repeat,
 *     trajectory, cloak, idlemode) fire immediately.
 *   - Modal cmds (move, fight, patrol, guard, repair, reclaim, resurrect,
 *     capture, dgun, load, unload) arm a pending modal — the next
 *     right-click on the world resolves it.
 *
 * The panel doesn't try to replicate ZK's chili Integral Menu; it's a
 * minimal native UI that exposes engine-side commands while LuaUI / chili
 * is still being stabilised. ZK's own command widgets will eventually
 * supersede it via the Lua widget worker.
 */
import { CMD } from './command-buffer.js';
import type { UnitCmdDescsInfo } from './connection.js';
import type { EntityRenderer } from './entity-renderer.js';
import type { InputManager } from './input-manager.js';

/** A single order button definition. */
interface OrderButton {
    cmdId: number;
    label: string;
    /** One-letter glyph rendered on the tile. */
    glyph: string;
    /** Hover tooltip — first line is the human name + hotkey. */
    tooltip: string;
    /** What happens when the player clicks the tile. */
    action: 'instant' | 'modal-ground' | 'modal-unit' | 'modal-either';
    /** Params passed to issueImmediateCommand for instant actions. */
    params?: number[];
}

/// Standard Spring command buttons in display order. Click semantics are
/// authoritative — the keyboard handler in InputManager is the mirror copy.
const ORDER_BUTTONS: OrderButton[] = [
    { cmdId: CMD.MOVE,        label: 'Move',     glyph: 'M', tooltip: 'Move (M)',                       action: 'modal-ground' },
    { cmdId: CMD.STOP,        label: 'Stop',     glyph: 'S', tooltip: 'Stop (S)',                       action: 'instant', params: [] },
    { cmdId: CMD.ATTACK,      label: 'Attack',   glyph: 'A', tooltip: 'Attack target (A) — right-click target', action: 'modal-either' },
    { cmdId: CMD.AREA_ATTACK, label: 'AreaAtk',  glyph: 'A⌖',tooltip: 'Area attack — left-drag to set centre + radius', action: 'modal-ground' },
    { cmdId: CMD.FIGHT,       label: 'Fight',    glyph: 'F', tooltip: 'Attack-move / Fight (F)',         action: 'modal-ground' },
    { cmdId: CMD.PATROL,      label: 'Patrol',   glyph: 'P', tooltip: 'Patrol (P) — shift to chain waypoints', action: 'modal-ground' },
    { cmdId: CMD.GUARD,       label: 'Guard',    glyph: 'G', tooltip: 'Guard (G) — escort a friendly unit', action: 'modal-unit' },
    { cmdId: CMD.WAIT,        label: 'Wait',     glyph: 'W', tooltip: 'Wait (W) — pause queue',          action: 'instant', params: [] },
    { cmdId: CMD.REPAIR,      label: 'Repair',   glyph: 'R', tooltip: 'Repair (R) — friendly unit',      action: 'modal-unit' },
    { cmdId: CMD.RECLAIM,     label: 'Reclaim',  glyph: 'E', tooltip: 'Reclaim (E) — feature/wreck/unit', action: 'modal-either' },
    { cmdId: CMD.RESURRECT,   label: 'Resurrect',glyph: 'X', tooltip: 'Resurrect (X) — corpse',          action: 'modal-either' },
    { cmdId: CMD.CAPTURE,     label: 'Capture',  glyph: 'C', tooltip: 'Capture (C) — enemy unit',        action: 'modal-unit' },
    { cmdId: CMD.MANUALFIRE,  label: 'D-Gun',    glyph: 'D', tooltip: 'Manual fire / D-Gun (D)',         action: 'modal-either' },
    { cmdId: CMD.LOAD_UNITS,  label: 'Load',     glyph: 'L', tooltip: 'Load units (L) — friendly unit',  action: 'modal-unit' },
    { cmdId: CMD.UNLOAD_UNITS,label: 'Unload',   glyph: 'U', tooltip: 'Unload units (U) — ground point', action: 'modal-ground' },
    // Toggles. The server clamps the value modulo the unit's allowed range.
    { cmdId: CMD.FIRE_STATE,  label: 'FireState',glyph: 'F!', tooltip: 'Cycle fire state (Q)',           action: 'instant', params: [-1] },
    { cmdId: CMD.MOVE_STATE,  label: 'MoveState',glyph: 'M!', tooltip: 'Cycle move state',               action: 'instant', params: [-1] },
    { cmdId: CMD.ONOFF,       label: 'On/Off',   glyph: 'O', tooltip: 'Toggle on/off',                   action: 'instant', params: [-1] },
    { cmdId: CMD.REPEAT,      label: 'Repeat',   glyph: '↻', tooltip: 'Toggle repeat',                  action: 'instant', params: [-1] },
    { cmdId: CMD.TRAJECTORY,  label: 'Trajectory',glyph: '⤴', tooltip: 'Toggle high/low trajectory',     action: 'instant', params: [-1] },
    { cmdId: CMD.CLOAK,       label: 'Cloak',    glyph: '◇', tooltip: 'Toggle cloak',                    action: 'instant', params: [-1] },
    { cmdId: CMD.IDLEMODE,    label: 'IdleMode', glyph: '⌂', tooltip: 'Toggle idle mode (I)',           action: 'instant', params: [-1] },
    { cmdId: CMD.STOCKPILE,   label: 'Stockpile',glyph: '⊞', tooltip: 'Stockpile a missile',            action: 'instant', params: [] },
    { cmdId: CMD.SELFD,       label: 'Self-D',   glyph: '☠', tooltip: 'Self-destruct (Ctrl+D)',          action: 'instant', params: [] },
];

const BUTTON_BY_CMD = new Map<number, OrderButton>(ORDER_BUTTONS.map(b => [b.cmdId, b]));

/// Spring `SCommandDescription::type == CMDTYPE_ICON_MODE` — a cycling
/// stateful command. params[0] holds the current index (as a decimal
/// string); params[1..] are the human-readable labels.
const CMDTYPE_ICON_MODE = 5;

/// Per-cmd colour ramps for state pips. Fire/move-state use the
/// well-known traffic-light semantics (hold → red, return → yellow,
/// roam/fire-at-will → green). Everything else cycles a single bright
/// pip across slots so the player can see the count + which one's live.
const PIP_PALETTES: Map<number, readonly string[]> = new Map([
    [CMD.FIRE_STATE, ['#e25c5c', '#e6c244', '#5ed46a']],
    [CMD.MOVE_STATE, ['#e25c5c', '#e6c244', '#5ed46a']],
]);
const PIP_DEFAULT_ACTIVE = '#6aa9ff';
const PIP_INACTIVE       = '#2d3340';
const PIP_MIXED          = '#777';

/** Per-cmd state snapshot built from the cmdDescs streamed across the
 *  current selection. `state == null` means the selected units disagree
 *  on the current state index (Spring shows a "—" placeholder there). */
interface CmdStateSnapshot {
    cmdId: number;
    /** Number of selectable values for the toggle (length of the label list). */
    slotCount: number;
    /** Current state index. null when the selection has mixed values. */
    state: number | null;
}

export class OrderPanel {
    private root: HTMLDivElement;
    private grid: HTMLDivElement;
    private entityRenderer: EntityRenderer;
    private inputManager: InputManager;
    private myTeam: number;

    private cmdDescs = new Map<number, UnitCmdDescsInfo>();
    private selection: readonly number[] = [];

    constructor(entityRenderer: EntityRenderer, inputManager: InputManager, myTeam: number) {
        this.entityRenderer = entityRenderer;
        this.inputManager = inputManager;
        this.myTeam = myTeam;

        this.root = document.createElement('div');
        this.root.id = 'order-panel';
        this.root.style.display = 'none';

        this.grid = document.createElement('div');
        this.grid.className = 'order-panel-grid';
        this.root.appendChild(this.grid);

        document.body.appendChild(this.root);
        this.injectStyles();
    }

    setSelection(ids: readonly number[]): void {
        this.selection = ids;
        this.render();
    }

    setCmdDescs(units: UnitCmdDescsInfo[]): void {
        this.cmdDescs.clear();
        for (const u of units) this.cmdDescs.set(u.unitId, u);
        this.render();
    }

    setMyTeam(team: number): void {
        this.myTeam = team;
        this.render();
    }

    /** Probe used by InputManager to swallow clicks landing on the panel. */
    isCursorOver(x: number, y: number): boolean {
        if (this.root.style.display === 'none') return false;
        const r = this.root.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }

    private render(): void {
        // Build the union of available real (non-build) commands across the
        // selected own-team units. Spring shows what any selected unit can
        // do; clicking issues to the matching subset.
        const available = new Set<number>();
        // Per-cmd state snapshot for stateful toggle pips. Keyed by cmdId.
        // We merge across selected units: matching state indices stay numeric;
        // disagreements collapse to null ("mixed", rendered as a gray bar).
        const stateInfo = new Map<number, CmdStateSnapshot>();
        let hasOwnUnit = false;
        for (const unitId of this.selection) {
            const meta = this.entityRenderer.getEntityMeta(unitId);
            if (!meta || meta.team !== this.myTeam) continue;
            hasOwnUnit = true;
            const descs = this.cmdDescs.get(unitId);
            if (!descs) continue;
            for (const c of descs.cmds) {
                if (c.disabled) continue;
                if (c.cmdId < 0) continue;       // skip build commands (BuildMenu owns those)
                if (BUTTON_BY_CMD.has(c.cmdId)) available.add(c.cmdId);

                // Stateful toggle? CMDTYPE_ICON_MODE (5) means params[0] is
                // the current index as a decimal string and params[1..] are
                // the labels. Some servers leave `type` at 0 for engine
                // state commands but still ship params; treat any
                // already-buttoned cmd with multi-entry params as stateful
                // (build cmds are already filtered above).
                const hasParams = Array.isArray(c.params) && c.params.length > 1;
                if (!hasParams) continue;
                if (c.type !== CMDTYPE_ICON_MODE && !PIP_PALETTES.has(c.cmdId) && !BUTTON_BY_CMD.has(c.cmdId)) continue;
                const slotCount = c.params.length - 1;
                const idx = Number.parseInt(c.params[0] ?? '', 10);
                const thisState = Number.isFinite(idx) ? idx : null;
                const prev = stateInfo.get(c.cmdId);
                if (!prev) {
                    stateInfo.set(c.cmdId, { cmdId: c.cmdId, slotCount, state: thisState });
                } else if (prev.state !== thisState) {
                    // Mixed selection → state collapses to null. We still
                    // keep the slot count from the first contributor; if it
                    // disagrees too, prefer the larger so every pip shows up.
                    prev.state = null;
                    if (slotCount > prev.slotCount) prev.slotCount = slotCount;
                }
            }
        }

        // Even with no cmdDescs streamed yet, show a baseline of "always
        // available" orders so the panel isn't empty for the first second
        // after selecting a unit. The server still validates each command,
        // so issuing one a unit can't perform is harmless.
        if (hasOwnUnit && available.size === 0) {
            available.add(CMD.MOVE); available.add(CMD.STOP);
            available.add(CMD.ATTACK); available.add(CMD.FIGHT);
            available.add(CMD.PATROL); available.add(CMD.GUARD);
            available.add(CMD.WAIT);
        }

        if (available.size === 0) {
            this.root.style.display = 'none';
            this.grid.replaceChildren();
            return;
        }

        const tiles: HTMLButtonElement[] = [];
        for (const btn of ORDER_BUTTONS) {
            if (!available.has(btn.cmdId)) continue;
            const tile = document.createElement('button');
            tile.className = 'order-panel-tile';
            tile.dataset.cmdId = String(btn.cmdId);
            tile.title = btn.tooltip;

            const glyph = document.createElement('span');
            glyph.className = 'order-panel-glyph';
            glyph.textContent = btn.glyph;
            tile.appendChild(glyph);

            const cap = document.createElement('span');
            cap.className = 'order-panel-caption';
            cap.textContent = btn.label;
            tile.appendChild(cap);

            // State-light pips for stateful toggles. Drawn as a horizontal
            // strip along the bottom edge so the glyph + caption above
            // stay readable. Mixed-state selections collapse to a single
            // gray bar — Spring's exact behaviour.
            const snap = stateInfo.get(btn.cmdId);
            if (snap && snap.slotCount > 0) {
                tile.appendChild(this.buildPipStrip(snap));
            }

            tile.addEventListener('click', (e) => {
                e.stopPropagation();
                this.handleClick(btn);
            });
            tile.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
            tiles.push(tile);
        }
        this.grid.replaceChildren(...tiles);
        this.root.style.display = 'block';
    }

    /** Render an inline pip strip showing the current state index of a
     *  stateful command. Mixed selections render as a single neutral
     *  band. Active pip uses the cmd's palette if defined, otherwise a
     *  generic accent colour. */
    private buildPipStrip(snap: CmdStateSnapshot): HTMLElement {
        const strip = document.createElement('span');
        strip.className = 'order-panel-pips';
        if (snap.state === null) {
            // Spring shows a "—" for mixed selection. We draw a single
            // gray bar spanning the strip so the player sees "stateful,
            // but the units don't agree".
            const mixed = document.createElement('span');
            mixed.className = 'order-panel-pip order-panel-pip-mixed';
            mixed.style.background = PIP_MIXED;
            strip.appendChild(mixed);
            return strip;
        }
        const palette = PIP_PALETTES.get(snap.cmdId);
        for (let i = 0; i < snap.slotCount; i++) {
            const pip = document.createElement('span');
            pip.className = 'order-panel-pip';
            if (i === snap.state) {
                pip.style.background = palette?.[i] ?? PIP_DEFAULT_ACTIVE;
            } else {
                pip.style.background = PIP_INACTIVE;
            }
            strip.appendChild(pip);
        }
        return strip;
    }

    private handleClick(btn: OrderButton): void {
        switch (btn.action) {
            case 'instant':
                this.inputManager.issueImmediateCommand(btn.cmdId, btn.params ?? []);
                break;
            case 'modal-ground':
                this.inputManager.armPendingCommand(btn.cmdId, 'ground');
                break;
            case 'modal-unit':
                this.inputManager.armPendingCommand(btn.cmdId, 'unit');
                break;
            case 'modal-either':
                this.inputManager.armPendingCommand(btn.cmdId, 'either');
                break;
        }
    }

    private injectStyles(): void {
        if (document.getElementById('order-panel-style')) return;
        const css = `
#order-panel {
    position: fixed;
    bottom: 8px;
    left: 8px;
    z-index: 21;
    background: linear-gradient(180deg, #1a1d22 0%, #0f1114 100%);
    border: 1px solid #2a2f38;
    border-top-color: #3a4150;
    border-radius: 4px;
    padding: 6px;
    pointer-events: auto;
    box-shadow: 0 0 0 1px #000, 0 4px 14px rgba(0, 0, 0, 0.6);
    max-width: 36vw;
}
.order-panel-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, 56px);
    gap: 3px;
}
.order-panel-tile {
    position: relative;
    width: 56px;
    height: 56px;
    padding: 0;
    background: #161a20;
    border: 1px solid #000;
    border-top-color: #2c323d;
    border-left-color: #232831;
    border-radius: 2px;
    cursor: pointer;
    overflow: hidden;
    color: #e0e0e0;
    font: 10px/1.1 system-ui, sans-serif;
    transition: border-color 80ms linear, transform 60ms linear;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
}
.order-panel-tile:hover {
    border-color: #6aa9ff;
    border-top-color: #9bc4ff;
}
.order-panel-tile:active {
    transform: translateY(1px);
}
.order-panel-glyph {
    font: 600 20px/1 system-ui, sans-serif;
    color: #d8d4b0;
    text-shadow: 0 1px 0 #000;
    pointer-events: none;
}
.order-panel-caption {
    margin-top: 2px;
    font: 9px/1.1 system-ui, sans-serif;
    color: #f0f0f0;
    text-shadow: 0 1px 0 #000;
    pointer-events: none;
}
.order-panel-pips {
    position: absolute;
    left: 4px;
    right: 4px;
    bottom: 3px;
    height: 4px;
    display: flex;
    gap: 2px;
    pointer-events: none;
}
.order-panel-pip {
    flex: 1 1 0;
    min-width: 0;
    height: 100%;
    border-radius: 1px;
    box-shadow: inset 0 0 0 1px rgba(0,0,0,0.55), 0 0 2px rgba(0,0,0,0.7);
}
.order-panel-pip-mixed {
    border-radius: 2px;
}
`;
        const style = document.createElement('style');
        style.id = 'order-panel-style';
        style.textContent = css;
        document.head.appendChild(style);
    }

    dispose(): void {
        this.root.remove();
        document.getElementById('order-panel-style')?.remove();
        this.cmdDescs.clear();
    }
}
