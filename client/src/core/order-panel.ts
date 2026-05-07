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
