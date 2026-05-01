/**
 * BuildMenu — bottom-of-screen panel listing the buildable units for the
 * currently-selected builder/factory units.
 *
 * Data sources:
 *   - selection      → list of unit IDs (from InputManager)
 *   - entity meta    → defId + team per entity (from EntityRenderer)
 *   - cmd-desc cache → per-unit available build commands (from server,
 *                      streamed via UnitCmdDescsUpdate at ~1Hz)
 *   - def cache      → unit-def metadata for labels, costs, build pics
 *
 * The available list is the union of buildoptions across all selected own-team
 * builders. Clicking a button hands off to BuildPlacementController to enter
 * ghost-placement mode; the actual command emission lives there.
 */
import type { UnitCmdDescsInfo } from './connection.js';
import type { DefCache } from './def-cache.js';
import type { EntityRenderer } from './entity-renderer.js';

export interface BuildMenuCallbacks {
    /** Fired when the player picks a build button. defId is the unit-def id. */
    onPick: (defId: number) => void;
}

export class BuildMenu {
    private root: HTMLDivElement;
    private grid: HTMLDivElement;
    private defCache: DefCache;
    private entityRenderer: EntityRenderer;
    private callbacks: BuildMenuCallbacks;
    private myTeam: number;

    /// unitId → list of cmds (negative ids are build commands).
    private cmdDescs = new Map<number, UnitCmdDescsInfo>();

    /// Currently-selected unit IDs (passed in from InputManager). Stored so
    /// we can re-render after a cmd-descs update arrives without waiting for
    /// the next selection change.
    private selection: readonly number[] = [];

    /// The set currently rendered in the grid. We render def-id buttons
    /// keyed on this so the BuildPlacementController can validate that a
    /// pick is still available between the click and the actual command.
    private currentBuildables = new Set<number>();

    constructor(
        defCache: DefCache,
        entityRenderer: EntityRenderer,
        myTeam: number,
        callbacks: BuildMenuCallbacks,
    ) {
        this.defCache = defCache;
        this.entityRenderer = entityRenderer;
        this.myTeam = myTeam;
        this.callbacks = callbacks;

        this.root = document.createElement('div');
        this.root.id = 'build-menu';
        this.root.style.display = 'none';

        this.grid = document.createElement('div');
        this.grid.className = 'build-menu-grid';
        this.root.appendChild(this.grid);

        document.body.appendChild(this.root);
        this.injectStyles();

        // New defs may resolve names/labels for buttons we already rendered;
        // re-render whenever the def cache picks up a new batch.
        defCache.onUnitDefs(() => this.render());
    }

    setSelection(ids: readonly number[]): void {
        this.selection = ids;
        this.render();
    }

    setCmdDescs(units: UnitCmdDescsInfo[]): void {
        // Replace the cache: each snapshot is a complete view of own-team
        // unit cmd descs at one tick. Units omitted from the snapshot are
        // either gone or have no build cmds, so they should drop out.
        this.cmdDescs.clear();
        for (const u of units) this.cmdDescs.set(u.unitId, u);
        this.render();
    }

    /** True if a defId button is currently in the menu. */
    isBuildable(defId: number): boolean {
        return this.currentBuildables.has(defId);
    }

    /** Probe used by InputManager to swallow clicks landing on the panel. */
    isCursorOver(x: number, y: number): boolean {
        if (this.root.style.display === 'none') return false;
        const r = this.root.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }

    private render(): void {
        // Build the union of available build commands across all own-team
        // selected units. Spring does the same — when multiple builders are
        // selected, the panel shows what any of them can build, and the
        // command goes out only to those that match.
        const buildable = new Set<number>();
        for (const unitId of this.selection) {
            const meta = this.entityRenderer.getEntityMeta(unitId);
            if (!meta || meta.team !== this.myTeam) continue;
            const descs = this.cmdDescs.get(unitId);
            if (!descs) continue;
            for (const c of descs.cmds) {
                if (c.disabled) continue;
                if (c.cmdId >= 0) continue;
                buildable.add(-c.cmdId);
            }
        }

        this.currentBuildables = buildable;

        // Hide the panel when nothing's buildable.
        if (buildable.size === 0) {
            this.root.style.display = 'none';
            this.grid.replaceChildren();
            return;
        }

        // Render a button per def, sorted by def id for stable ordering.
        const sorted = [...buildable].sort((a, b) => a - b);
        const buttons: HTMLButtonElement[] = [];
        for (const defId of sorted) {
            const def = this.defCache.getUnitDef(defId);
            const label = def?.name ?? `def ${defId}`;
            const btn = document.createElement('button');
            btn.className = 'build-menu-btn';
            btn.textContent = label;
            btn.title = def
                ? `${def.name}\nMetal ${Math.round(def.cost ?? 0)}`
                : `def ${defId}`;
            btn.dataset.defId = String(defId);
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.callbacks.onPick(defId);
            });
            buttons.push(btn);
        }
        this.grid.replaceChildren(...buttons);
        this.root.style.display = 'block';
    }

    private injectStyles(): void {
        if (document.getElementById('build-menu-style')) return;
        const css = `
#build-menu {
    position: fixed;
    bottom: 8px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 20;
    background: rgba(0, 0, 0, 0.78);
    border: 1px solid #444;
    border-radius: 4px;
    padding: 6px;
    pointer-events: auto;
    max-width: 80vw;
    max-height: 28vh;
    overflow-y: auto;
}
.build-menu-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: 4px;
    min-width: 320px;
}
.build-menu-btn {
    background: #2a2f3a;
    color: #e0e0e0;
    border: 1px solid #555;
    border-radius: 3px;
    padding: 6px 4px;
    font: 11px/1.2 system-ui, sans-serif;
    cursor: pointer;
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.build-menu-btn:hover {
    background: #3a4150;
    border-color: #888;
}
.build-menu-btn:active {
    background: #1a1f2a;
}
`;
        const style = document.createElement('style');
        style.id = 'build-menu-style';
        style.textContent = css;
        document.head.appendChild(style);
    }

    dispose(): void {
        this.root.remove();
        document.getElementById('build-menu-style')?.remove();
        this.cmdDescs.clear();
    }
}
