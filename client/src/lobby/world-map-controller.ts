/**
 * world-map-controller.ts — the World map's DOM half, as one object.
 *
 * `WorldMap` owns a canvas: pointer + wheel + pinch + keyboard input, the
 * pan/zoom `MapView`, animated camera travel, the hover chip, the collapsed
 * legend, the tool buttons, and a screen-reader announcer. Everything it
 * draws goes through `drawWorld` (world-map.ts), which has no DOM in it and
 * is where the geometry tests live; this file is where the events are.
 *
 * ── Why this exists beside world-screen.ts ─────────────────────────────────
 * `WorldScreen` (lane 2) is the whole screen: panels, fetches, the staging
 * form, the clock. The MAP inside it was ~60 lines of mouse handling with no
 * keyboard, no touch, no pulse loop and no way for a panel to say "show me
 * this POI". This class is that map, with an API a panel can drive:
 *
 *     const map = new WorldMap(canvas);
 *     map.setGraph(graph);
 *     map.on('select', poiId => panel.show(poiId));
 *     map.focus('paris', { animate: true });
 *     map.setLayers({ territory: false });
 *
 * It also dispatches `poi-selected` / `poi-activated` CustomEvents on the
 * canvas (bubbling), so a panel that never holds the instance can listen on
 * the document. `WorldScreen` keeps working unchanged — nothing here is
 * imported by it yet; the call-site edit is described in the lane report.
 *
 * ── Drill-down (user directive 2026-08-29) ─────────────────────────────────
 * The map is the summary. Hover shows a chip with the name, the owner, the
 * state and ONE number; click selects (and emits); double-click / Enter
 * ACTIVATES (the drill: the panel's job, this class only travels the
 * camera). The legend is a button, collapsed by default. No always-on data.
 *
 * ── Redraw discipline ──────────────────────────────────────────────────────
 * A repaint is requested (`invalidate`), never done inline, and collapses
 * into one rAF. The only continuous loop is the pulse, and it runs ONLY
 * while a staging/active POI is on the graph, the tab is visible and the
 * pulses layer is on — a quiet world costs zero frames per second.
 */

import {
    drawWorld, fitView, clampView, panView, zoomView, wheelZoomFactor, hitTestPoi,
    focusView, interpolateView, easeInOut, poiSummary, resolveLayers, factionColour,
    mapFromLatLon, viewCentredOn, poiToScreen,
    type MapView, type Viewport, type WorldGraph, type WorldPoi, type WorldLayers,
    type WorldViewer, type WorldClaim, type PoiSummary,
} from './world-map.js';
import {
    GLYPH_KINDS, GLYPH_LABELS, glyphKindFor, glyphSvg, stateRingSvg, claimFlagSvg, commanderStarSvg,
} from './world-map-glyphs.js';
import { contrastText } from './world-map-palette.js';
import worldMapCss from './world-map.css?raw';

/// The default basemap, the same file `world-screen.ts` names. Duplicated
/// rather than imported so this module never depends on the screen.
export const WORLD_MAP_BASEMAP_URL = '/world/earth-equirect-1920.jpg';

export interface WorldMapOptions {
    /// Basemap URL, or null for the graticule only. Default: the shipped Earth.
    basemapUrl?: string | null;
    /// Where the chip, legend and tools mount. Default: the canvas's parent
    /// (which the lobby's markup makes `position: relative`).
    overlayRoot?: HTMLElement | null;
    layers?: Partial<WorldLayers>;
    /// Hit radius in CSS px. Default 12; touch input widens it to 20.
    hitRadius?: number;
    /// Mount the legend/tool buttons. Default true.
    tools?: boolean;
    /// Mount the hover chip. Default true.
    chip?: boolean;
    /// Camera travel duration in ms. Default 420. 0 disables animation.
    travelMs?: number;
    /// Zoom (× fit) `focus()` travels to. Default 4.
    focusZoom?: number;
}

export interface WorldMapEvents {
    /// Selection changed (click, keyboard, `select()`). Null on deselect.
    select: (poiId: string | null, poi: WorldPoi | null) => void;
    /// Hover changed. Null when the pointer leaves every marker.
    hover: (poiId: string | null, poi: WorldPoi | null) => void;
    /// The drill: double-click / Enter on a POI. The panel decides what
    /// "open" means (join the war, show the staging form…).
    activate: (poiId: string, poi: WorldPoi) => void;
    /// The view moved (pan, zoom, travel, resize).
    view: (view: MapView) => void;
    /// A layer toggle changed (from `setLayers` or the legend).
    layers: (layers: WorldLayers) => void;
}

type Handler<K extends keyof WorldMapEvents> = WorldMapEvents[K];

const STYLE_ID = 'world-map-style';

/// Keyboard pan step in CSS px and zoom step per keypress.
const KEY_PAN_PX = 60;
const KEY_ZOOM = 1.5;

export class WorldMap {
    private graph: WorldGraph = { worldId: '', pois: [], edges: [], factions: {} };
    private view: MapView = { scale: 1, offsetX: 0, offsetY: 0 };
    private viewFitted = false;
    private layers: WorldLayers;
    private viewer: WorldViewer | null = null;
    private claims: WorldClaim[] = [];
    private basemap: HTMLImageElement | null = null;
    private hoveredId: string | null = null;
    private selectedId: string | null = null;
    private frame = 0;
    private pulseRunning = false;
    private travel: { from: MapView; to: MapView; startMs: number; ms: number } | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private handlers: { [K in keyof WorldMapEvents]: Set<Handler<K>> } = {
        select: new Set(), hover: new Set(), activate: new Set(), view: new Set(), layers: new Set(),
    };
    private readonly unbind: (() => void)[] = [];
    // Pointer state. A Map so a second finger (pinch) is a second entry.
    private pointers = new Map<number, { x: number; y: number }>();
    private dragMoved = 0;
    private lastPinchDist = 0;
    private lastPointer: { x: number; y: number } | null = null;
    private chipEl: HTMLElement | null = null;
    private chipFor: string | null = null;
    private legendEl: HTMLElement | null = null;
    private legendBtn: HTMLButtonElement | null = null;
    private announceEl: HTMLElement | null = null;
    private destroyed = false;
    private readonly opts: Required<Pick<WorldMapOptions, 'hitRadius' | 'tools' | 'chip' | 'travelMs' | 'focusZoom'>>
        & { basemapUrl: string | null; overlayRoot: HTMLElement | null };

    constructor(readonly canvas: HTMLCanvasElement, options: WorldMapOptions = {}) {
        this.opts = {
            basemapUrl: options.basemapUrl === undefined ? WORLD_MAP_BASEMAP_URL : options.basemapUrl,
            overlayRoot: options.overlayRoot ?? canvas.parentElement,
            hitRadius: options.hitRadius ?? 12,
            tools: options.tools ?? true,
            chip: options.chip ?? true,
            travelMs: options.travelMs ?? 420,
            focusZoom: options.focusZoom ?? 4,
        };
        this.layers = resolveLayers(options.layers);
        injectStyle();
        this.mountChrome();
        this.wireCanvas();
        this.loadBasemap();
        this.resize();
    }

    // ───────────────────────────── data ─────────────────────────────

    setGraph(graph: WorldGraph): void {
        this.graph = graph;
        // Re-point the selection/hover at the fresh nodes; a POI that left
        // the world deselects.
        if (this.selectedId && !graph.pois.some(p => p.id === this.selectedId)) this.select(null);
        if (this.hoveredId && !graph.pois.some(p => p.id === this.hoveredId)) this.setHover(null);
        this.renderLegend();
        this.invalidate();
        this.syncPulse();
    }

    getGraph(): WorldGraph { return this.graph; }

    setViewer(viewer: WorldViewer | null): void {
        this.viewer = viewer;
        this.invalidate();
    }

    setClaims(claims: readonly WorldClaim[]): void {
        this.claims = Array.from(claims);
        this.invalidate();
    }

    setLayers(partial: Partial<WorldLayers>): void {
        const next = { ...this.layers, ...partial };
        let changed = false;
        for (const k of Object.keys(next) as (keyof WorldLayers)[]) {
            if (next[k] !== this.layers[k]) { changed = true; break; }
        }
        if (!changed) return;
        this.layers = next;
        this.renderLegend();
        this.invalidate();
        this.syncPulse();
        this.emit('layers', this.layers);
    }

    getLayers(): WorldLayers { return { ...this.layers }; }

    // ─────────────────────────── selection ───────────────────────────

    select(poiId: string | null, opts: { emit?: boolean } = {}): boolean {
        const poi = poiId ? this.poiById(poiId) : null;
        const id = poi ? poi.id : null;
        const changed = id !== this.selectedId;
        this.selectedId = id;
        if (changed) {
            this.invalidate();
            if (opts.emit !== false) {
                this.emit('select', id, poi);
                this.canvas.dispatchEvent(new CustomEvent('poi-selected', {
                    bubbles: true, detail: { poiId: id, poi },
                }));
            }
            this.announce(poi ? this.describe(poi) : 'Selection cleared');
        }
        return !!poi || poiId === null;
    }

    getSelected(): string | null { return this.selectedId; }
    getHovered(): string | null { return this.hoveredId; }

    /// The drill: what a double-click / Enter does.
    activate(poiId: string): boolean {
        const poi = this.poiById(poiId);
        if (!poi) return false;
        this.emit('activate', poi.id, poi);
        this.canvas.dispatchEvent(new CustomEvent('poi-activated', {
            bubbles: true, detail: { poiId: poi.id, poi },
        }));
        return true;
    }

    // ───────────────────────────── camera ─────────────────────────────

    getView(): MapView { return { ...this.view }; }

    setView(view: MapView): void {
        this.travel = null;
        this.applyView(clampView(view, this.viewport()));
    }

    /// Travel to a POI: centred, at `focusZoom` × fit (or `zoom`). Never
    /// zooms OUT past the current view when already closer — a click on a
    /// marker at 8× should not pull back to 4×.
    focus(poiId: string, opts: { animate?: boolean; zoom?: number; select?: boolean } = {}): boolean {
        const poi = this.poiById(poiId);
        if (!poi) return false;
        const vp = this.viewport();
        const fit = fitView(vp).scale;
        const wanted = fit * (opts.zoom ?? this.opts.focusZoom);
        const target = this.view.scale > wanted && opts.zoom === undefined
            ? viewCentredOn(mapFromLatLon(poi.lat, poi.lon), this.view.scale, vp)
            : focusView(poi, vp, (opts.zoom ?? this.opts.focusZoom));
        if (opts.select) this.select(poi.id);
        this.travelTo(target, opts.animate ?? true);
        return true;
    }

    /// The whole world, centred. The "reset".
    home(opts: { animate?: boolean } = {}): void {
        this.travelTo(fitView(this.viewport()), opts.animate ?? true);
    }

    zoomBy(factor: number, anchor?: { x: number; y: number }): void {
        const vp = this.viewport();
        const a = anchor ?? { x: vp.width / 2, y: vp.height / 2 };
        this.travel = null;
        this.applyView(zoomView(this.view, vp, factor, a.x, a.y));
    }

    panBy(dx: number, dy: number): void {
        this.travel = null;
        this.applyView(panView(this.view, dx, dy, this.viewport()));
    }

    /// Match the backing store to the CSS box × DPR and re-clamp. Called by
    /// the ResizeObserver; public so a host without one (or one that
    /// unhides the canvas) can poke it.
    resize(): void {
        const c = this.canvas;
        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
        const w = Math.max(1, Math.round(c.clientWidth * dpr));
        const h = Math.max(1, Math.round(c.clientHeight * dpr));
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        const vp = this.viewport();
        if (!this.viewFitted && vp.width > 0 && vp.height > 0) {
            this.view = fitView(vp);
            this.viewFitted = true;
        } else {
            this.view = clampView(this.view, vp);
        }
        this.invalidate();
    }

    /// Force a repaint on the next frame.
    redraw(): void { this.invalidate(); }

    // ───────────────────────────── events ─────────────────────────────

    on<K extends keyof WorldMapEvents>(event: K, handler: Handler<K>): () => void {
        (this.handlers[event] as Set<Handler<K>>).add(handler);
        return () => { (this.handlers[event] as Set<Handler<K>>).delete(handler); };
    }

    private emit<K extends keyof WorldMapEvents>(event: K, ...args: Parameters<Handler<K>>): void {
        for (const h of this.handlers[event] as Set<Handler<K>>) {
            try { (h as (...a: Parameters<Handler<K>>) => void)(...args); }
            catch (err) { console.error('[world-map] handler failed', err); }
        }
    }

    destroy(): void {
        this.destroyed = true;
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        for (const off of this.unbind) off();
        this.unbind.length = 0;
        if (this.frame) cancelAnimationFrame(this.frame);
        this.frame = 0;
        this.pulseRunning = false;
        this.travel = null;
        this.chipEl?.remove();
        this.legendEl?.parentElement?.remove();
        this.announceEl?.remove();
        this.canvas.classList.remove('wm-canvas', 'wm-dragging', 'wm-over-poi');
        for (const k of Object.keys(this.handlers) as (keyof WorldMapEvents)[]) this.handlers[k].clear();
    }

    // ───────────────────────────── internals ─────────────────────────────

    private poiById(id: string): WorldPoi | null {
        return this.graph.pois.find(p => p.id === id) ?? null;
    }

    private viewport(): Viewport {
        return { width: this.canvas.clientWidth, height: this.canvas.clientHeight };
    }

    private applyView(view: MapView): void {
        this.view = view;
        this.invalidate();
        this.emit('view', this.view);
        if (this.chipFor) this.placeChipAtPoi(this.chipFor);
    }

    private travelTo(target: MapView, animate: boolean): void {
        if (!animate || this.opts.travelMs <= 0 || typeof requestAnimationFrame === 'undefined') {
            this.travel = null;
            this.applyView(target);
            return;
        }
        this.travel = { from: this.view, to: target, startMs: now(), ms: this.opts.travelMs };
        this.invalidate();
    }

    private invalidate(): void {
        if (this.frame || this.destroyed) return;
        if (typeof requestAnimationFrame === 'undefined') { this.paint(now()); return; }
        this.frame = requestAnimationFrame(t => { this.frame = 0; this.paint(t); });
    }

    private paint(timeMs: number): void {
        if (this.destroyed) return;
        // Camera travel: one eased step per frame, then the exact target.
        if (this.travel) {
            const t = this.travel;
            const u = easeInOut((timeMs - t.startMs) / t.ms);
            const vp = this.viewport();
            if (u >= 1) { this.travel = null; this.applyViewSilently(t.to); }
            else { this.applyViewSilently(interpolateView(t.from, t.to, u, vp)); this.invalidate(); }
            this.emit('view', this.view);
            if (this.chipFor) this.placeChipAtPoi(this.chipFor);
        }
        const ctx = this.canvas.getContext('2d');
        if (ctx) {
            const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            drawWorld(ctx, {
                graph: this.graph,
                view: this.view,
                viewport: this.viewport(),
                basemap: this.basemap,
                hoveredId: this.hoveredId,
                selectedId: this.selectedId,
                layers: this.layers,
                timeMs: this.pulseRunning ? timeMs : undefined,
                viewer: this.viewer,
                claims: this.claims,
            });
        }
        if (this.pulseRunning && !this.travel) this.invalidate();
    }

    private applyViewSilently(view: MapView): void { this.view = view; }

    /// Whether anything on the map beats. Starts/stops the loop.
    private syncPulse(): void {
        const wants = this.layers.pulses && this.layers.markers &&
            this.graph.pois.some(p => p.battleStatus !== 'quiet') &&
            (typeof document === 'undefined' || document.visibilityState !== 'hidden');
        if (wants === this.pulseRunning) return;
        this.pulseRunning = wants;
        if (wants) this.invalidate();
    }

    private loadBasemap(): void {
        if (!this.opts.basemapUrl || typeof Image === 'undefined') return;
        const img = new Image();
        img.onload = () => { if (!this.destroyed) { this.basemap = img; this.invalidate(); } };
        img.onerror = () => { this.basemap = null; };
        img.src = this.opts.basemapUrl;
    }

    // ───────────────────────────── input ─────────────────────────────

    private listen<K extends keyof HTMLElementEventMap>(
        target: HTMLElement, type: K,
        fn: (e: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions,
    ): void {
        target.addEventListener(type, fn as EventListener, options);
        this.unbind.push(() => target.removeEventListener(type, fn as EventListener, options));
    }

    private pointerPos(e: { clientX: number; clientY: number }): { x: number; y: number } {
        const rect = this.canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    private hitAt(p: { x: number; y: number }, touch = false): WorldPoi | null {
        return hitTestPoi(this.graph.pois, this.view, p.x, p.y, touch ? Math.max(20, this.opts.hitRadius) : this.opts.hitRadius);
    }

    private wireCanvas(): void {
        const c = this.canvas;
        c.classList.add('wm-canvas');
        if (!c.hasAttribute('tabindex')) c.tabIndex = 0;
        c.setAttribute('role', 'application');
        if (!c.getAttribute('aria-label')) c.setAttribute('aria-label', 'World map. Arrow keys pan, plus and minus zoom, N and P step through places, Enter opens the selected place, Home fits the world.');

        this.listen(c, 'wheel', (e: WheelEvent) => {
            e.preventDefault();
            const p = this.pointerPos(e);
            this.zoomBy(wheelZoomFactor(e.deltaY), p);
        }, { passive: false });

        this.listen(c, 'pointerdown', (e: PointerEvent) => {
            if (e.button !== undefined && e.button !== 0) return;
            const p = this.pointerPos(e);
            this.pointers.set(e.pointerId, p);
            c.setPointerCapture?.(e.pointerId);
            if (this.pointers.size === 1) {
                this.dragMoved = 0;
                this.lastPointer = p;
                this.travel = null;
            } else if (this.pointers.size === 2) {
                this.lastPinchDist = this.pinchDist();
            }
            c.classList.add('wm-dragging');
            this.hideChip();
        });

        this.listen(c, 'pointermove', (e: PointerEvent) => {
            const p = this.pointerPos(e);
            if (this.pointers.has(e.pointerId)) {
                this.pointers.set(e.pointerId, p);
                if (this.pointers.size >= 2) {
                    const d = this.pinchDist();
                    if (this.lastPinchDist > 0 && d > 0) {
                        const mid = this.pinchMid();
                        this.zoomBy(d / this.lastPinchDist, mid);
                    }
                    this.lastPinchDist = d;
                    this.dragMoved += 10;
                    return;
                }
                if (this.lastPointer) {
                    const dx = p.x - this.lastPointer.x, dy = p.y - this.lastPointer.y;
                    this.dragMoved += Math.abs(dx) + Math.abs(dy);
                    this.panBy(dx, dy);
                    this.lastPointer = p;
                }
                return;
            }
            if (e.pointerType === 'touch') return;
            const hit = this.hitAt(p);
            this.setHover(hit ? hit.id : null);
            c.classList.toggle('wm-over-poi', !!hit);
            if (hit) this.showChip(hit, p); else this.hideChip();
        });

        const release = (e: PointerEvent) => {
            if (!this.pointers.has(e.pointerId)) return;
            this.pointers.delete(e.pointerId);
            c.releasePointerCapture?.(e.pointerId);
            if (this.pointers.size === 0) {
                c.classList.remove('wm-dragging');
                this.lastPointer = null;
                this.lastPinchDist = 0;
            } else if (this.pointers.size === 1) {
                this.lastPointer = Array.from(this.pointers.values())[0];
                this.lastPinchDist = 0;
            }
        };
        this.listen(c, 'pointerup', release);
        this.listen(c, 'pointercancel', release);
        this.listen(c, 'pointerleave', (e: PointerEvent) => {
            if (this.pointers.size === 0) {
                this.setHover(null);
                c.classList.remove('wm-over-poi');
                this.hideChip();
            }
            void e;
        });

        this.listen(c, 'click', (e: MouseEvent) => {
            // A drag that ended over a marker is not a click on it. Without
            // this, panning the map by grabbing near a city selects that
            // city every time.
            if (this.dragMoved > 4) { this.dragMoved = 0; return; }
            const p = this.pointerPos(e);
            const hit = this.hitAt(p, (e as PointerEvent).pointerType === 'touch');
            this.select(hit ? hit.id : null);
            // Click travels: the marker comes to the centre at a readable
            // zoom (drill-down's "camera travel on click").
            if (hit) this.focus(hit.id, { animate: true });
        });

        this.listen(c, 'dblclick', (e: MouseEvent) => {
            e.preventDefault();
            const hit = this.hitAt(this.pointerPos(e));
            if (hit) this.activate(hit.id);
        });

        this.listen(c, 'keydown', (e: KeyboardEvent) => this.onKey(e));

        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.resize());
            this.resizeObserver.observe(c);
        }
        if (typeof document !== 'undefined') {
            const onVis = () => this.syncPulse();
            document.addEventListener('visibilitychange', onVis);
            this.unbind.push(() => document.removeEventListener('visibilitychange', onVis));
        }
    }

    private pinchDist(): number {
        const [a, b] = Array.from(this.pointers.values());
        if (!a || !b) return 0;
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    private pinchMid(): { x: number; y: number } {
        const [a, b] = Array.from(this.pointers.values());
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }

    private onKey(e: KeyboardEvent): void {
        const vp = this.viewport();
        const centre = { x: vp.width / 2, y: vp.height / 2 };
        let handled = true;
        switch (e.key) {
            case 'ArrowLeft': this.panBy(KEY_PAN_PX, 0); break;
            case 'ArrowRight': this.panBy(-KEY_PAN_PX, 0); break;
            case 'ArrowUp': this.panBy(0, KEY_PAN_PX); break;
            case 'ArrowDown': this.panBy(0, -KEY_PAN_PX); break;
            case '+': case '=': this.zoomBy(KEY_ZOOM, centre); break;
            case '-': case '_': this.zoomBy(1 / KEY_ZOOM, centre); break;
            case 'Home': case '0': this.home(); break;
            case 'n': case 'N': this.step(+1); break;
            case 'p': case 'P': this.step(-1); break;
            case 'Enter': case ' ':
                if (this.selectedId) this.activate(this.selectedId); else handled = false;
                break;
            case 'Escape':
                if (this.selectedId) this.select(null);
                else if (this.legendEl && !this.legendEl.hidden) this.toggleLegend(false);
                else handled = false;
                break;
            case 'l': case 'L': this.toggleLegend(); break;
            default: handled = false;
        }
        if (handled) e.preventDefault();
    }

    /// Keyboard traversal: next/previous POI in west→east order (a stable,
    /// geographic order the player can predict), selecting and travelling.
    private step(dir: 1 | -1): void {
        const pois = [...this.graph.pois].sort((a, b) => a.lon - b.lon || a.lat - b.lat || a.id.localeCompare(b.id));
        if (!pois.length) return;
        const i = this.selectedId ? pois.findIndex(p => p.id === this.selectedId) : -1;
        const next = pois[(i + dir + pois.length) % pois.length];
        this.select(next.id);
        this.focus(next.id, { animate: true });
        this.showChipForPoi(next.id);
    }

    private setHover(id: string | null): void {
        if (id === this.hoveredId) return;
        this.hoveredId = id;
        this.invalidate();
        this.emit('hover', id, id ? this.poiById(id) : null);
    }

    // ───────────────────────────── chrome ─────────────────────────────

    private mountChrome(): void {
        const root = this.opts.overlayRoot;
        if (!root || typeof document === 'undefined') return;
        if (this.opts.chip) {
            const chip = document.createElement('div');
            chip.className = 'wm-chip';
            chip.hidden = true;
            chip.setAttribute('role', 'status');
            root.appendChild(chip);
            this.chipEl = chip;
        }
        const live = document.createElement('div');
        live.className = 'wm-announce';
        live.setAttribute('aria-live', 'polite');
        root.appendChild(live);
        this.announceEl = live;

        if (this.opts.tools) {
            const tools = document.createElement('div');
            tools.className = 'wm-tools';
            const legend = document.createElement('div');
            legend.className = 'wm-legend';
            legend.id = uniqueId('wm-legend');
            legend.hidden = true;
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.gap = '6px';
            const home = document.createElement('button');
            home.type = 'button';
            home.className = 'wm-home';
            home.textContent = '⌂ Fit';
            home.title = 'Fit the whole world (Home)';
            home.addEventListener('click', () => this.home());
            const lbtn = document.createElement('button');
            lbtn.type = 'button';
            lbtn.className = 'wm-legend-btn';
            lbtn.textContent = 'Legend';
            lbtn.title = 'Show what the markers mean (L)';
            lbtn.setAttribute('aria-expanded', 'false');
            lbtn.setAttribute('aria-controls', legend.id);
            lbtn.addEventListener('click', () => this.toggleLegend());
            row.append(home, lbtn);
            tools.append(legend, row);
            root.appendChild(tools);
            this.legendEl = legend;
            this.legendBtn = lbtn;
            this.renderLegend();
        }
    }

    toggleLegend(open?: boolean): void {
        if (!this.legendEl || !this.legendBtn) return;
        const show = open ?? this.legendEl.hidden;
        this.legendEl.hidden = !show;
        this.legendBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
    }

    isLegendOpen(): boolean { return !!this.legendEl && !this.legendEl.hidden; }

    /// The legend, rebuilt when the graph or the layers change. Glyphs are
    /// the same point table the canvas traces (world-map-glyphs.ts).
    private renderLegend(): void {
        const el = this.legendEl;
        if (!el) return;
        const kindsPresent = new Set(this.graph.pois.map(p => glyphKindFor(p)));
        const kinds = GLYPH_KINDS.filter(k => kindsPresent.has(k) || k === 'battleground' || k === 'region');
        const factionIds = Object.keys(this.graph.factions).sort((a, b) =>
            (this.graph.factions[a].name).localeCompare(this.graph.factions[b].name));
        const layerRows: [keyof WorldLayers, string][] = [
            ['territory', 'Territory halos'],
            ['edges', 'Transit routes'],
            ['labels', 'Names'],
            ['claims', 'Claims'],
            ['pulses', 'Mission pulses'],
            ['safeColours', 'Colour-blind-safe faction colours'],
        ];
        const html: string[] = [];
        html.push('<h5>Places</h5><ul>');
        for (const k of kinds) html.push(`<li>${glyphSvg(k, '#ffd479')} ${esc(GLYPH_LABELS[k])}</li>`);
        html.push('</ul><h5>State</h5><ul>');
        html.push(`<li>${stateRingSvg('quiet', '')} Quiet</li>`);
        html.push(`<li>${stateRingSvg('staging', '#ffd479')} Mission staging — force in transit</li>`);
        html.push(`<li>${stateRingSvg('active', '#ff5c5c')} Battle in progress</li>`);
        html.push(`<li>${claimFlagSvg('#e69f00')} Open claim (earliest claimant's colour)</li>`);
        html.push(`<li>${commanderStarSvg('#ffffff')} Your commander</li>`);
        html.push('</ul>');
        if (factionIds.length) {
            html.push('<h5>Factions</h5><ul>');
            for (const id of factionIds) {
                const colour = factionColour(id, this.graph, this.layers.safeColours);
                html.push(`<li><span class="wm-chip-swatch" style="background:${esc(colour)}"></span> ${esc(this.graph.factions[id].name)}</li>`);
            }
            html.push('</ul>');
        }
        html.push('<h5>Layers</h5><div class="wm-legend-layers">');
        for (const [key, label] of layerRows) {
            html.push(`<label><input type="checkbox" data-layer="${key}"${this.layers[key] ? ' checked' : ''}> ${esc(label)}</label>`);
        }
        html.push('</div>');
        html.push('<div class="wm-legend-keys"><kbd>←↑→↓</kbd> pan · <kbd>+</kbd><kbd>−</kbd> zoom · <kbd>N</kbd>/<kbd>P</kbd> next/previous place · <kbd>Enter</kbd> open · <kbd>Home</kbd> fit · <kbd>L</kbd> legend</div>');
        el.innerHTML = html.join('');
        for (const input of Array.from(el.querySelectorAll<HTMLInputElement>('input[data-layer]'))) {
            input.addEventListener('change', () => {
                const key = input.dataset.layer as keyof WorldLayers;
                this.setLayers({ [key]: input.checked } as Partial<WorldLayers>);
            });
        }
    }

    /// Build the chip's DOM from a `PoiSummary`. Text goes in through
    /// textContent; the only markup is the glyph SVG, whose one attribute
    /// (the colour) is escaped by `glyphSvg`.
    private renderChip(s: PoiSummary): void {
        const el = this.chipEl;
        if (!el) return;
        el.innerHTML = '';
        el.style.setProperty('--wm-accent', s.state === 'active' ? '#ff5c5c'
            : s.state === 'staging' ? '#ffd479' : (s.owner?.colour ?? '#8ad2ff'));
        const name = document.createElement('div');
        name.className = 'wm-chip-name';
        name.innerHTML = glyphSvg(s.kind, s.state === 'active' ? '#ff5c5c' : (s.owner?.colour ?? '#ffd479'), 13);
        name.append(document.createTextNode(s.name));
        el.append(name);
        const owner = document.createElement('div');
        owner.className = 'wm-chip-owner';
        if (s.owner) {
            const sw = document.createElement('span');
            sw.className = 'wm-chip-swatch';
            sw.style.background = s.owner.colour;
            sw.style.color = contrastText(s.owner.colour);
            owner.append(sw, document.createTextNode(s.owner.name + (s.mine ? ' (yours)' : '')));
        } else {
            owner.textContent = 'Unclaimed';
        }
        el.append(owner);
        const state = document.createElement('div');
        state.className = `wm-chip-state wm-state-${s.state}`;
        state.textContent = s.stateLabel + (s.claims ? ` · ${s.claims} claim${s.claims === 1 ? '' : 's'}` : '');
        el.append(state);
        const stat = document.createElement('div');
        stat.className = 'wm-chip-stat';
        const label = document.createElement('span');
        label.textContent = s.stat.label;
        const value = document.createElement('b');
        value.textContent = s.stat.value;
        stat.append(label, value);
        el.append(stat);
        if (s.hasCommander) {
            const you = document.createElement('div');
            you.className = 'wm-chip-you';
            you.textContent = 'Your commander is here';
            el.append(you);
        }
        const hint = document.createElement('div');
        hint.className = 'wm-chip-hint';
        hint.textContent = 'Click to select · double-click to open';
        el.append(hint);
    }

    private showChip(poi: WorldPoi, at: { x: number; y: number }): void {
        const el = this.chipEl;
        if (!el) return;
        if (this.chipFor !== poi.id) {
            this.renderChip(poiSummary(poi, this.graph, this.viewer, this.claims, this.layers.safeColours));
            this.chipFor = poi.id;
        }
        el.hidden = false;
        this.placeChip(at);
    }

    /// The keyboard path: the chip sits beside the POI itself.
    private showChipForPoi(poiId: string): void {
        const poi = this.poiById(poiId);
        if (!poi || !this.chipEl) return;
        this.showChip(poi, poiToScreen(poi, this.view));
    }

    private placeChipAtPoi(poiId: string): void {
        if (!this.chipEl || this.chipEl.hidden || this.pointers.size) return;
        const poi = this.poiById(poiId);
        if (poi && !this.hoveredId) this.placeChip(poiToScreen(poi, this.view));
    }

    private placeChip(at: { x: number; y: number }): void {
        const el = this.chipEl;
        if (!el) return;
        const vp = this.viewport();
        // Flip to the left/top of the cursor near the right/bottom edge so
        // the chip never runs off the canvas.
        const w = el.offsetWidth || 180, h = el.offsetHeight || 80;
        const x = at.x + 14 + w > vp.width && vp.width > 0 ? at.x - 14 - w : at.x + 14;
        const y = at.y + 14 + h > vp.height && vp.height > 0 ? at.y - 14 - h : at.y + 14;
        el.style.left = `${Math.max(0, x)}px`;
        el.style.top = `${Math.max(0, y)}px`;
    }

    private hideChip(): void {
        if (this.chipEl) this.chipEl.hidden = true;
        this.chipFor = null;
    }

    isChipVisible(): boolean { return !!this.chipEl && !this.chipEl.hidden; }

    private describe(poi: WorldPoi): string {
        const s = poiSummary(poi, this.graph, this.viewer, this.claims);
        return `${s.name}, ${s.owner ? 'held by ' + s.owner.name : 'unclaimed'}, ${s.stateLabel.toLowerCase()}, ${s.stat.label.toLowerCase()} ${s.stat.value}`;
    }

    private announce(text: string): void {
        if (this.announceEl) this.announceEl.textContent = text;
    }
}

// ───────────────────────────── helpers ─────────────────────────────

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let idSeq = 0;
function uniqueId(prefix: string): string { return `${prefix}-${++idSeq}`; }

function now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/// Inject the stylesheet once per document. Idempotent so the preview
/// harness and the lobby can both construct maps freely.
function injectStyle(): void {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = worldMapCss;
    document.head.appendChild(style);
}
