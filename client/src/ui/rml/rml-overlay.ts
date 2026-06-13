/**
 * rml-overlay.ts — the main-thread RML DOM overlay manager (PLAN-rml.md §5).
 *
 * RmlUi is an HTML/CSS UI library, and the browser *is* an HTML/CSS engine — so
 * RML's rendering plane becomes a real DOM overlay `<div id="rml-root">` stacked
 * over `#game-canvas`, not the GL context. The worker-side `RmlUi` proxy
 * (rml-bridge.ts) records DOM operations and ships them once per frame as
 * `rml:ops`; this manager replays them against real DOM nodes, translating RML→
 * HTML and RCSS→CSS, resolving VFS asset URLs, and routing native events back.
 *
 * Z-order: canvas (world + chili GL UI) < `#rml-root` < main-thread HUD overlays
 * (quit confirm, drag box). `pointer-events` defaults to `none` on the root so
 * the canvas keeps receiving camera/selection input everywhere RML isn't
 * interactive; individual RML elements opt into `auto` via their RCSS.
 *
 * Phase status: R0 mounts the root and accepts (but ignores) the op stream so
 * BAR's RML widgets boot against a live bridge without rendering anything yet.
 * R1 implements `applyOps` (translate + mount documents); R2 data binding; R3
 * imperative DOM + events; R4 resize/cursors/dispose polish.
 */

import type { RmlOp } from './rml-protocol.js';

/** Z-index for the overlay root: above the canvas, below HUD overlays
 *  (drag-select uses 50; quit-confirm/game-over sit higher). */
const RML_ROOT_Z = 40;

export interface RmlOverlayOptions {
    /** Element id of the game canvas the overlay is positioned over. */
    canvasId: string;
    /** Base URL for VFS asset resolution, e.g. `/api/games/data/<gameId>`.
     *  R1 uses this to fetch `.rml`/`.rcss`/fonts/images referenced by docs. */
    assetBaseUrl: string;
}

export class RmlOverlayManager {
    private root: HTMLDivElement;
    private readonly canvasId: string;
    /** Reserved for R1 asset resolution (fonts/images/.rml/.rcss). */
    readonly assetBaseUrl: string;
    private reposition: () => void;
    /** R0 diagnostic: how many ops we've received but not yet rendered. */
    private ignoredOps = 0;
    /** `!!key` → translated string for the active locale (PLAN-rml.md §5.3).
     *  Populated from i18nClear/i18nAdd ops even in R0 (cheap; R1 resolves
     *  `!!key` text nodes against it). */
    private readonly i18n = new Map<string, string>();

    constructor(opts: RmlOverlayOptions) {
        this.canvasId = opts.canvasId;
        this.assetBaseUrl = opts.assetBaseUrl.replace(/\/$/, '');

        const div = document.createElement('div');
        div.id = 'rml-root';
        div.style.position = 'fixed';
        div.style.pointerEvents = 'none';   // children opt into 'auto' via RCSS
        div.style.zIndex = String(RML_ROOT_Z);
        div.style.overflow = 'hidden';
        document.body.appendChild(div);
        this.root = div;

        // Track the canvas geometry so the overlay stays glued over it (mirrors
        // the drag-select-overlay sizing in main.ts).
        this.reposition = () => this.syncToCanvas();
        this.syncToCanvas();
        window.addEventListener('resize', this.reposition);
    }

    /** Position/size `#rml-root` to exactly cover the game canvas. */
    private syncToCanvas(): void {
        const rect = document.getElementById(this.canvasId)?.getBoundingClientRect();
        if (!rect) return;
        this.root.style.left = `${rect.left}px`;
        this.root.style.top = `${rect.top}px`;
        this.root.style.width = `${rect.width}px`;
        this.root.style.height = `${rect.height}px`;
    }

    /**
     * Apply a batch of DOM ops from the worker. R0: accepted and ignored (the
     * bridge boots BAR's RML widgets but nothing renders yet). R1+ replaces this
     * with the real DOM mutation switch (see PLAN-rml.md §5.1 `applyOps`).
     */
    applyOps(ops: RmlOp[]): void {
        // R0: still not rendering DOM (that lands in R1), but capture the i18n
        // dictionary now — it's cheap and the `!!key` resolution in R1 needs it.
        // BAR feeds the full active-locale string set on every setLanguage.
        for (const op of ops) {
            if (op.op === 'i18nClear') {
                this.i18n.clear();
            } else if (op.op === 'i18nAdd') {
                this.i18n.set(op.key, op.value);
            } else {
                this.ignoredOps++;
            }
        }
    }

    /** Tear down: remove the root + listeners. Called from quitToLobby(). */
    dispose(): void {
        window.removeEventListener('resize', this.reposition);
        this.root.remove();
    }
}
