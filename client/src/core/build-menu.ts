/**
 * BuildMenu — Chili-styled bottom-screen panel listing the buildable units
 * for the currently-selected builder/factory units.
 *
 * Each entry renders the unit's `buildPic` thumbnail (served from
 * `/api/games/data/<gameId>/unitpics/<buildPic>`) with a small cost overlay,
 * matching the visual feel of ZK's chili Integral Menu — dark slotted frame,
 * pixel-icon thumbs, hover highlight, M/E cost ribbon.
 *
 * Data sources:
 *   - selection      → list of unit IDs (from InputManager)
 *   - entity meta    → defId + team per entity (from EntityRenderer)
 *   - cmd-desc cache → per-unit available build commands (from server,
 *                      streamed via UnitCmdDescsUpdate at ~1Hz)
 *   - def cache      → unit-def metadata for labels, costs, build pics
 *
 * The available list is the union of buildoptions across all selected own-team
 * builders. Clicking an icon hands off to BuildPlacementController to enter
 * ghost-placement mode; the actual command emission lives there.
 */
import type { UnitCmdDescsInfo } from './connection.js';
import type { DefCache } from './def-cache.js';
import type { EntityRenderer } from './entity-renderer.js';

export interface BuildMenuCallbacks {
    /** Fired when the player picks a build button. `shift` is true if the
     *  player held shift during the click — for factories this becomes
     *  Spring's 5x build-count multiplier; for builders it queues the build
     *  behind existing commands and keeps placement mode open. */
    onPick: (defId: number, shift: boolean) => void;
}

export interface BuildMenuOptions {
    /** Lobby HTTP base, e.g. `http://localhost:8011`. */
    lobbyHttpUrl: string;
    /** Game id, e.g. `zk` — used to resolve buildPic asset URLs. */
    gameId: string;
}

export class BuildMenu {
    private root: HTMLDivElement;
    private grid: HTMLDivElement;
    private defCache: DefCache;
    private entityRenderer: EntityRenderer;
    private callbacks: BuildMenuCallbacks;
    private myTeam: number;
    private buildPicBase: string;

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
        opts: BuildMenuOptions,
        callbacks: BuildMenuCallbacks,
    ) {
        this.defCache = defCache;
        this.entityRenderer = entityRenderer;
        this.myTeam = myTeam;
        this.callbacks = callbacks;
        this.buildPicBase = opts.gameId
            ? `${opts.lobbyHttpUrl}/api/games/data/${encodeURIComponent(opts.gameId)}/unitpics`
            : '';

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

        // Sort by metal cost for a usable browsing order — light units first,
        // T2/heavies later. Falls back to def id when costs aren't loaded yet.
        const sorted = [...buildable].sort((a, b) => {
            const da = this.defCache.getUnitDef(a);
            const db = this.defCache.getUnitDef(b);
            const ca = da?.metalCost ?? Number.MAX_SAFE_INTEGER;
            const cb = db?.metalCost ?? Number.MAX_SAFE_INTEGER;
            if (ca !== cb) return ca - cb;
            return a - b;
        });

        const tiles: HTMLButtonElement[] = [];
        for (const defId of sorted) {
            const def = this.defCache.getUnitDef(defId);
            const tile = document.createElement('button');
            tile.className = 'build-menu-tile';
            tile.dataset.defId = String(defId);

            // Build pic. ZK ships file names with mixed case (some
            // ALL_CAPS, some lowercase); the server preserves whatever
            // the unitdef's `buildPic` field said, and the http-static
            // route is case-sensitive. Try the original case first, fall
            // back to lowercased on 404 — covers oddball units like
            // AMPHBOMB.png whose def says lowercase.
            const img = document.createElement('img');
            img.className = 'build-menu-pic';
            img.draggable = false;
            img.alt = def?.humanName ?? def?.name ?? `def ${defId}`;
            const pic = def?.buildPic;
            if (pic && this.buildPicBase) {
                img.src = `${this.buildPicBase}/${pic}`;
                let triedLower = false;
                img.addEventListener('error', () => {
                    if (!triedLower && pic !== pic.toLowerCase()) {
                        triedLower = true;
                        img.src = `${this.buildPicBase}/${pic.toLowerCase()}`;
                    } else {
                        img.classList.add('build-menu-pic-missing');
                    }
                });
            } else {
                img.classList.add('build-menu-pic-missing');
            }
            tile.appendChild(img);

            // Cost ribbon. Only show metal cost — energy is rarely the
            // limiting factor at unit-pick time, and showing both makes
            // the tile noisy. Hover tooltip carries the full breakdown.
            if (def && def.metalCost > 0) {
                const cost = document.createElement('span');
                cost.className = 'build-menu-cost';
                cost.textContent = formatCost(def.metalCost);
                tile.appendChild(cost);
            }

            // Caption — short name strip across the bottom. Falls back to
            // the internal name (e.g. "armcom") if the human name hasn't
            // arrived yet, so the player at least sees something.
            const cap = document.createElement('span');
            cap.className = 'build-menu-caption';
            cap.textContent = def?.humanName || def?.name || `def ${defId}`;
            tile.appendChild(cap);

            tile.title = def
                ? `${def.humanName || def.name}\nM ${Math.round(def.metalCost)}  E ${Math.round(def.energyCost)}  T ${Math.round(def.buildTime)}${def.tooltip ? '\n\n' + def.tooltip : ''}`
                : `def ${defId}`;
            tile.addEventListener('click', (e) => {
                e.stopPropagation();
                this.callbacks.onPick(defId, e.shiftKey);
            });
            tile.addEventListener('contextmenu', (e) => {
                // Right-click swallows so the world doesn't see it. Future
                // hook for queue-build / repeat shortcuts.
                e.preventDefault();
                e.stopPropagation();
            });
            tiles.push(tile);
        }
        this.grid.replaceChildren(...tiles);
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
    background: linear-gradient(180deg, #1a1d22 0%, #0f1114 100%);
    border: 1px solid #2a2f38;
    border-top-color: #3a4150;
    border-radius: 4px;
    padding: 6px;
    pointer-events: auto;
    box-shadow: 0 0 0 1px #000, 0 4px 14px rgba(0, 0, 0, 0.6);
    max-width: 88vw;
    max-height: 32vh;
    overflow-y: auto;
}
.build-menu-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, 72px);
    gap: 3px;
    min-width: 320px;
    justify-content: start;
}
.build-menu-tile {
    position: relative;
    width: 72px;
    height: 72px;
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
}
.build-menu-tile:hover {
    border-color: #6aa9ff;
    border-top-color: #9bc4ff;
    z-index: 1;
}
.build-menu-tile:active {
    transform: translateY(1px);
}
.build-menu-pic {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    image-rendering: -webkit-optimize-contrast;
    background: #0a0c10;
    pointer-events: none;
    user-select: none;
}
.build-menu-pic-missing {
    background: repeating-linear-gradient(
        45deg,
        #1a1d22 0 6px,
        #14161a 6px 12px
    );
}
.build-menu-cost {
    position: absolute;
    top: 2px;
    right: 2px;
    padding: 1px 4px;
    background: rgba(0, 0, 0, 0.72);
    border-radius: 2px;
    color: #d8d4b0;
    font: 10px/1.1 ui-monospace, Menlo, monospace;
    pointer-events: none;
    text-shadow: 0 1px 0 #000;
}
.build-menu-caption {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 1px 3px 2px;
    background: linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.78) 50%);
    color: #f0f0f0;
    font: 10px/1.1 system-ui, sans-serif;
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    pointer-events: none;
    text-shadow: 0 1px 0 #000;
}
#build-menu::-webkit-scrollbar { width: 6px; }
#build-menu::-webkit-scrollbar-track { background: transparent; }
#build-menu::-webkit-scrollbar-thumb { background: #2a2f38; border-radius: 3px; }
#build-menu::-webkit-scrollbar-thumb:hover { background: #3a4150; }
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

/** Compact cost like 1.2k / 250. Keeps the ribbon to ~3 chars. */
function formatCost(metal: number): string {
    if (metal >= 10000) return `${Math.round(metal / 1000)}k`;
    if (metal >= 1000) return `${(metal / 1000).toFixed(1)}k`;
    return String(Math.round(metal));
}
