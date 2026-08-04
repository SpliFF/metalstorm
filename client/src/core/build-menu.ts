/**
 * BuildMenu — Chili-styled bottom-screen panel listing the buildable units
 * for the currently-selected builder/factory units.
 *
 * Each entry renders the unit's `buildPic` thumbnail (served from
 * `/api/games/data/<gameId>/unitpics/<buildPic>`) with a small cost overlay,
 * matching the visual feel of ZK's chili Integral Menu — dark slotted frame,
 * pixel-icon thumbs, hover highlight, M/E cost ribbon.
 *
 * Post-GW4 (PLAN-playable.md G3a): the selection set, entity meta, cmd-descs,
 * and def cache all live in the game-processor worker now — main has no
 * instances. The worker computes the buildable-tile set (union of build cmds
 * across own-team selected units, resolved against its def cache) and pushes it
 * over `gp:sceneState.buildOptions`; this panel is a pure renderer fed via
 * `setBuildOptions`. Clicking a tile posts `gp:startBuildPlacement` to the
 * worker (wired by main.ts's `onPick`), which owns ghost placement + the actual
 * command emission (WorkerBuildPlacement).
 */
import type { BuildMenuTile } from './game-worker-protocol.js';

export interface BuildMenuCallbacks {
    /** Fired when the player picks a build button. The modifier flags carry
     *  through to the Command options bitmask. For factories these select
     *  Spring/Recoil's batch-build multiplier from the FactoryCAI table:
     *  shift=×5, ctrl=×20, shift+ctrl=×100 (see FactoryCAI.cpp
     *  GetCountMultiplierFromOptions — origin is OTA). For builders, shift
     *  queues the build behind existing commands and keeps placement mode
     *  open for chain-building. */
    onPick: (defId: number, mods: { shift: boolean; ctrl: boolean }) => void;
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
    private callbacks: BuildMenuCallbacks;
    /// Player's team id. The worker now owns team-filtering of the buildable
    /// set, so this is currently informational only (kept for API stability /
    /// future per-team tile styling).
    private myTeam: number;
    private buildPicBase: string;

    /// Resolved tiles for the current selection, pushed from the worker via
    /// gp:sceneState.buildOptions. The worker already did the buildable-set
    /// union + own-team filter + metal-cost sort; this panel just renders.
    private buildTiles: BuildMenuTile[] = [];

    constructor(
        myTeam: number,
        opts: BuildMenuOptions,
        callbacks: BuildMenuCallbacks,
    ) {
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
    }

    /** Feed the worker-resolved build tiles (gp:sceneState.buildOptions). */
    setBuildOptions(tiles: BuildMenuTile[]): void {
        this.buildTiles = tiles;
        this.render();
    }

    /** Probe used to swallow clicks landing on the panel (cursor-over-UI). */
    isCursorOver(x: number, y: number): boolean {
        if (this.root.style.display === 'none') return false;
        const r = this.root.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }

    private render(): void {
        // Hide the panel when nothing's buildable. The worker sends the tiles
        // already own-team-filtered and metal-cost-sorted (see
        // gpRecomputeBuildTiles), so this is a straight render.
        if (this.buildTiles.length === 0) {
            this.root.style.display = 'none';
            this.grid.replaceChildren();
            return;
        }

        const tiles: HTMLButtonElement[] = [];
        for (const bt of this.buildTiles) {
            const defId = bt.defId;
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
            img.alt = bt.humanName || bt.name || `def ${defId}`;
            const pic = bt.buildPic;
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
            if (bt.metalCost > 0) {
                const cost = document.createElement('span');
                cost.className = 'build-menu-cost';
                cost.textContent = formatCost(bt.metalCost);
                tile.appendChild(cost);
            }

            // PLAN-latency L4.2 — queue chip. How many of this def the current
            // selection has queued, counted over the worker's *merged*
            // command-queue view, so it appears on the click rather than on the
            // next 1 Hz snapshot. While the order is still unconfirmed the chip
            // is drawn unsettled (dimmed + outlined) so the player can tell
            // "we've asked for this" from "the server has it".
            if (bt.queued > 0) {
                const chip = document.createElement('span');
                chip.className = 'build-menu-queued';
                chip.textContent = String(bt.queued);
                if (bt.queuedPending > 0) chip.classList.add('build-menu-queued-pending');
                tile.appendChild(chip);
            }

            // Caption — short name strip across the bottom. Falls back to
            // the internal name (e.g. "armcom") if the human name hasn't
            // arrived yet, so the player at least sees something.
            const cap = document.createElement('span');
            cap.className = 'build-menu-caption';
            cap.textContent = bt.humanName || bt.name || `def ${defId}`;
            tile.appendChild(cap);

            tile.title = (bt.humanName || bt.name)
                ? `${bt.humanName || bt.name}\nM ${Math.round(bt.metalCost)}  E ${Math.round(bt.energyCost)}  T ${Math.round(bt.buildTime)}${bt.tooltip ? '\n\n' + bt.tooltip : ''}`
                : `def ${defId}`;
            tile.addEventListener('click', (e) => {
                e.stopPropagation();
                this.callbacks.onPick(defId, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
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
.build-menu-queued {
    position: absolute;
    top: 2px;
    left: 2px;
    min-width: 14px;
    padding: 1px 3px;
    background: #2f6fd0;
    border: 1px solid #79b0ff;
    border-radius: 7px;
    color: #f2f7ff;
    font: 10px/1.1 ui-monospace, Menlo, monospace;
    text-align: center;
    pointer-events: none;
    text-shadow: 0 1px 0 rgba(0, 0, 0, 0.6);
}
/* Still unconfirmed by the server — hollow rather than solid, so an
   optimistic count never masquerades as an authoritative one. */
.build-menu-queued-pending {
    background: rgba(47, 111, 208, 0.25);
    border-style: dashed;
    color: #b9d5ff;
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
        this.buildTiles = [];
    }
}

/** Compact cost like 1.2k / 250. Keeps the ribbon to ~3 chars. */
function formatCost(metal: number): string {
    if (metal >= 10000) return `${Math.round(metal / 1000)}k`;
    if (metal >= 1000) return `${(metal / 1000).toFixed(1)}k`;
    return String(Math.round(metal));
}
