/**
 * world-screen.ts — the lobby's World screen (PLAN-worldsim.md W2).
 *
 * The DOM half of the world map: the canvas, the pointer handling, the
 * tooltip and the detail panel. All of the geometry lives in `world-map.ts`,
 * which has no DOM in it and is where the tests are; this file's job is to
 * turn events into `MapView`s and to paint.
 *
 * ── Why this is a lobby screen ─────────────────────────────────────────────
 * The world is a lobby-side object — SQLite rows, a low-frequency tick and
 * HTTP, never sim state (PLAN-worldsim.md hard boundary 3) — and an in-game
 * client has no room SSE to hear about it on anyway. So the World screen is an
 * overlay over the lobby's browser screen, opened from the header beside
 * Replays and Friends. It covers the lobby rather than replacing it because
 * the room list underneath is still live: a player who opened the map to see
 * where a war is should not have to leave the map to join it once W5 links
 * the two.
 *
 * ── The button is hidden until the routes answer ───────────────────────────
 * Same rule the replay panel follows: a lobby built before W1 404s
 * `/api/world`, and an empty "World" panel reads as a broken feature rather
 * than an absent one.
 */

import {
    drawWorld, fitView, clampView, panView, zoomView, wheelZoomFactor,
    hitTestPoi, parseWorldGraph, edgesFor, formatWorldDuration, formatLatLon,
    screenToLatLon, parseWorldClock, tickWorldClock, formatWorldClock,
    type MapView, type Viewport, type WorldGraph, type WorldPoi, type WorldClock,
} from './world-map.js';

/// How often the World screen re-fetches `/api/world` while it is open, to
/// resync the locally-ticked clock (an admin pause elsewhere, a server
/// restart, or ordinary clock drift all show up here rather than only on the
/// next `open()`).
const CLOCK_RESYNC_MS = 30_000;

/// The equirectangular basemap (public/world/SOURCE.md). Absolute from the
/// site root, like every other file the client serves out of `public/`.
export const DEFAULT_BASEMAP_URL = '/world/earth-equirect-1920.jpg';

export interface WorldScreenDeps {
    /// The lobby's own GET helper — `LobbyUI.lobbyGet`, which answers null on
    /// a non-200 rather than throwing.
    get(path: string): Promise<any>;
    basemapUrl?: string;
}

/// Escape for the detail panel. POI names come from a seeder today and from
/// player-facing content tomorrow; neither is a reason to build innerHTML out
/// of them unescaped.
function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class WorldScreen {
    private graph: WorldGraph = { worldId: '', pois: [], edges: [] };
    private view: MapView = { scale: 1, offsetX: 0, offsetY: 0 };
    private basemap: HTMLImageElement | null = null;
    private hovered: WorldPoi | null = null;
    private selected: WorldPoi | null = null;
    private dragging = false;
    private dragMoved = 0;
    private lastPointer: { x: number; y: number } | null = null;
    private frame = 0;
    private resizeObserver: ResizeObserver | null = null;
    /// The last clock reading fetched from `/api/world`. Ticked locally once a
    /// second between fetches (PLAN-worldsim.md W4) rather than polled every
    /// second — the server comment on `WorldStatusJson`'s ratio fields exists
    /// for exactly this.
    private clock: WorldClock | null = null;
    private clockTickTimer: ReturnType<typeof setInterval> | null = null;
    private clockResyncTimer: ReturnType<typeof setInterval> | null = null;
    /// The canvas the handlers are attached to. Identity, not a boolean: the
    /// browser screen replaces its whole `innerHTML` on every room-list
    /// re-render (i.e. on every SSE tick), so "already wired" against a
    /// DIFFERENT canvas is exactly the state that leaves the map dead.
    private wiredCanvas: HTMLCanvasElement | null = null;
    /// Whether the player has the map open, kept here rather than read off the
    /// DOM for the same reason: the re-render hands back a hidden panel, and
    /// the map must come back up rather than blink out from under them.
    private openState = false;

    constructor(private readonly deps: WorldScreenDeps) {}

    private get panel(): HTMLElement | null { return document.getElementById('world-panel'); }
    private get canvas(): HTMLCanvasElement | null {
        return document.getElementById('world-canvas') as HTMLCanvasElement | null;
    }

    /// True once the world routes have answered at least once — the lobby uses
    /// it to decide whether the World button exists at all.
    async probe(): Promise<boolean> {
        const world = await this.deps.get('/api/world').catch(() => null);
        if (!world || typeof world.worldId !== 'string' || world.error) return false;
        const title = document.getElementById('world-title');
        if (title) title.textContent = String(world.name || world.worldId);
        return true;
    }

    isOpen(): boolean { return this.openState; }

    open(): void {
        const panel = this.panel;
        if (!panel) return;
        this.openState = true;
        panel.style.display = '';
        this.wire();
        this.loadBasemap();
        void this.refresh();
        void this.fetchClock();
        this.startClockTimers();
        // Layout has to have happened before `fitView` can know the canvas
        // size; a panel unhidden in this same tick still measures 0×0 in some
        // browsers, and a fit computed against 0 gives scale 1 and an empty
        // blue rectangle.
        requestAnimationFrame(() => { this.resize(); this.view = fitView(this.viewport()); this.paint(); });
    }

    close(): void {
        this.openState = false;
        const panel = this.panel;
        if (panel) panel.style.display = 'none';
        this.dragging = false;
        this.hideTooltip();
        this.stopClockTimers();
    }

    toggle(): void { this.isOpen() ? this.close() : this.open(); }

    /// Called after the lobby rebuilds the browser markup. Re-attaches to the
    /// new elements and restores the map if it was open, so an SSE room update
    /// does not shut the world map the player is reading.
    remount(): void {
        if (this.openState) this.open();
        else this.renderDetail();
    }

    /// Fetch the POI graph. Keeps whatever is already drawn on a failed fetch:
    /// a transient 503 should not blank a map the player is reading.
    async refresh(): Promise<void> {
        const json = await this.deps.get('/api/world/pois').catch(() => null);
        const graph = parseWorldGraph(json);
        if (!graph) { this.setStatus('The world map is unavailable.'); return; }
        this.graph = graph;
        if (this.selected && !graph.pois.some(p => p.id === this.selected!.id)) this.selected = null;
        this.setStatus(graph.pois.length === 0
            ? 'This world has no points of interest yet — W3 seeds them from the shipped battle maps.'
            : '');
        this.renderDetail();
        this.paint();
    }

    /// Select a POI by id, as a click would. Public because the map is a
    /// place the rest of the lobby will want to point at — W5's "show me the
    /// war standing on this POI" is this call — and because it is how the
    /// preview harness stages a screenshot with the detail panel populated.
    selectPoi(poiId: string | null): boolean {
        const poi = poiId ? this.graph.pois.find(p => p.id === poiId) ?? null : null;
        this.selected = poi;
        this.renderDetail();
        this.paint();
        return !!poi || poiId === null;
    }

    /// Fetch the clock straight from `/api/world`'s body (probe() only reads
    /// the title). `Date.now()` is stamped here, at receipt — the instant the
    /// client will measure elapsed wall time from.
    private async fetchClock(): Promise<void> {
        const json = await this.deps.get('/api/world').catch(() => null);
        const clock = parseWorldClock(json, Date.now());
        if (clock) this.clock = clock;
        this.renderClock();
    }

    private renderClock(): void {
        const el = document.getElementById('world-clock');
        if (!el) return;
        if (!this.clock) { el.textContent = ''; return; }
        const c = tickWorldClock(this.clock, Date.now());
        el.textContent = formatWorldClock(c) + (c.paused ? ' · PAUSED' : '');
        el.classList.toggle('paused', c.paused);
    }

    /// Re-render every second (a locally-ticked clock, no network) and re-fetch
    /// every `CLOCK_RESYNC_MS` (to pick up an admin pause/resume or ordinary
    /// drift). Guarded against double-starting: `remount()` calls `open()`
    /// again for an already-open panel on every SSE room-list re-render.
    private startClockTimers(): void {
        this.stopClockTimers();
        this.clockTickTimer = setInterval(() => this.renderClock(), 1000);
        this.clockResyncTimer = setInterval(() => void this.fetchClock(), CLOCK_RESYNC_MS);
    }

    private stopClockTimers(): void {
        if (this.clockTickTimer !== null) { clearInterval(this.clockTickTimer); this.clockTickTimer = null; }
        if (this.clockResyncTimer !== null) { clearInterval(this.clockResyncTimer); this.clockResyncTimer = null; }
    }

    private setStatus(text: string): void {
        const el = document.getElementById('world-status');
        if (!el) return;
        el.textContent = text;
        el.style.display = text ? '' : 'none';
    }

    private viewport(): Viewport {
        const c = this.canvas;
        if (!c) return { width: 0, height: 0 };
        return { width: c.clientWidth, height: c.clientHeight };
    }

    private loadBasemap(): void {
        if (this.basemap) return;
        const img = new Image();
        // A missing basemap is not an error state: `drawWorld` falls back to a
        // drawn graticule, which is also what the first frame of every session
        // looks like while this decodes.
        img.onload = () => { this.basemap = img; this.paint(); };
        img.onerror = () => { this.basemap = null; };
        img.src = this.deps.basemapUrl ?? DEFAULT_BASEMAP_URL;
    }

    /// Match the backing store to the CSS box and the device pixel ratio. A
    /// canvas left at its default 300×150 and stretched by CSS is the classic
    /// "why is the map blurry and why is the hit-test off" pair — both come
    /// from the same mismatch, which is why the pointer maths below works in
    /// CSS pixels only.
    private resize(): void {
        const c = this.canvas;
        if (!c) return;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(c.clientWidth * dpr));
        const h = Math.max(1, Math.round(c.clientHeight * dpr));
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        // Re-clamp: a window that got wider can leave the view outside the
        // rules it was clamped to at the old size.
        this.view = clampView(this.view, this.viewport());
    }

    private paint(): void {
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            const c = this.canvas;
            const ctx = c?.getContext('2d');
            if (!c || !ctx) return;
            const dpr = window.devicePixelRatio || 1;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            drawWorld(ctx, {
                graph: this.graph,
                view: this.view,
                viewport: this.viewport(),
                basemap: this.basemap,
                hoveredId: this.hovered?.id ?? null,
                selectedId: this.selected?.id ?? null,
            });
        });
    }

    private pointerPos(e: MouseEvent): { x: number; y: number } {
        const rect = this.canvas!.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    private wire(): void {
        const c = this.canvas;
        const panel = this.panel;
        if (!c || !panel || this.wiredCanvas === c) return;
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.wiredCanvas = c;

        document.getElementById('world-close-btn')?.addEventListener('click', () => this.close());
        document.getElementById('world-reset-btn')?.addEventListener('click', () => {
            this.view = fitView(this.viewport());
            this.paint();
        });

        c.addEventListener('wheel', (e: WheelEvent) => {
            e.preventDefault();
            const p = this.pointerPos(e);
            this.view = zoomView(this.view, this.viewport(), wheelZoomFactor(e.deltaY), p.x, p.y);
            this.paint();
        }, { passive: false });

        c.addEventListener('mousedown', (e: MouseEvent) => {
            this.dragging = true;
            this.dragMoved = 0;
            this.lastPointer = this.pointerPos(e);
        });

        c.addEventListener('mousemove', (e: MouseEvent) => {
            const p = this.pointerPos(e);
            if (this.dragging && this.lastPointer) {
                const dx = p.x - this.lastPointer.x, dy = p.y - this.lastPointer.y;
                this.dragMoved += Math.abs(dx) + Math.abs(dy);
                this.view = panView(this.view, dx, dy, this.viewport());
                this.lastPointer = p;
                this.hideTooltip();
                this.paint();
                return;
            }
            const hit = hitTestPoi(this.graph.pois, this.view, p.x, p.y);
            if (hit !== this.hovered) { this.hovered = hit; this.paint(); }
            c.style.cursor = hit ? 'pointer' : 'grab';
            if (hit) this.showTooltip(hit, p);
            else this.showCoords(p);
        });

        const endDrag = () => { this.dragging = false; this.lastPointer = null; };
        c.addEventListener('mouseup', endDrag);
        c.addEventListener('mouseleave', () => { endDrag(); this.hovered = null; this.hideTooltip(); this.paint(); });

        c.addEventListener('click', (e: MouseEvent) => {
            // A drag that ended over a marker is not a click on it. Without
            // this, panning the map by grabbing near a city selects that city
            // every time.
            if (this.dragMoved > 4) return;
            const p = this.pointerPos(e);
            this.selected = hitTestPoi(this.graph.pois, this.view, p.x, p.y);
            this.renderDetail();
            this.paint();
        });

        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => { this.resize(); this.paint(); });
            this.resizeObserver.observe(c);
        }
    }

    private showTooltip(poi: WorldPoi, at: { x: number; y: number }): void {
        const el = document.getElementById('world-tooltip');
        if (!el) return;
        const where = formatLatLon(poi.lat, poi.lon);
        const what = poi.mapId ? 'battle map' : 'world only';
        el.innerHTML = `<strong>${esc(poi.name)}</strong><span>${esc(where)} · ${what}</span>`;
        el.style.display = '';
        el.style.left = `${at.x + 14}px`;
        el.style.top = `${at.y + 14}px`;
    }

    /// With nothing under the cursor the tooltip shows where the cursor IS.
    /// It costs nothing and it is the only thing in the running UI that
    /// demonstrates the projection inverts — a map whose readout disagrees
    /// with its own markers is visibly wrong instead of subtly wrong.
    private showCoords(at: { x: number; y: number }): void {
        const el = document.getElementById('world-tooltip');
        if (!el) return;
        const { lat, lon } = screenToLatLon(at.x, at.y, this.view);
        el.innerHTML = `<span>${esc(formatLatLon(lat, lon))}</span>`;
        el.style.display = '';
        el.style.left = `${at.x + 14}px`;
        el.style.top = `${at.y + 14}px`;
    }

    private hideTooltip(): void {
        const el = document.getElementById('world-tooltip');
        if (el) el.style.display = 'none';
    }

    private renderDetail(): void {
        const el = document.getElementById('world-detail');
        if (!el) return;
        const poi = this.selected;
        if (!poi) {
            el.innerHTML = '<div class="world-detail-empty">Select a point of interest.</div>';
            return;
        }
        const names = new Map(this.graph.pois.map(p => [p.id, p.name]));
        const links = edgesFor(this.graph.edges, poi.id).map(({ edge, other }) => {
            const dir = edge.bidirectional ? '↔' : (edge.from === poi.id ? '→' : '←');
            const kind = edge.kind ? ` <span class="world-edge-kind">${esc(edge.kind)}</span>` : '';
            return `<li>${dir} ${esc(names.get(other) ?? other)}${kind}` +
                `<span class="world-edge-time">${esc(formatWorldDuration(edge.transitWorldMs))}</span></li>`;
        }).join('');
        const tags = poi.tags.map(t => `<span class="world-tag">${esc(t)}</span>`).join('');
        // The map link is deliberately NOT a join button: W5 owns the
        // click-through to a room, and a dead-looking button now would promise
        // something this milestone cannot do.
        const map = poi.mapId
            ? `<div class="world-detail-map">Battle map: <code>${esc(poi.mapId)}</code></div>`
            : '<div class="world-detail-map world-detail-dim">No battle map — world only.</div>';
        el.innerHTML =
            `<h4>${esc(poi.name)}</h4>` +
            `<div class="world-detail-sub">${esc(poi.kind || 'point of interest')} · ` +
            `${esc(formatLatLon(poi.lat, poi.lon))}</div>` +
            (tags ? `<div class="world-tags">${tags}</div>` : '') +
            map +
            (links
                ? `<div class="world-detail-head">Transit (world time)</div><ul class="world-links">${links}</ul>`
                : '<div class="world-detail-head world-detail-dim">No transit links.</div>');
    }

    destroy(): void {
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        if (this.frame) cancelAnimationFrame(this.frame);
        this.frame = 0;
        this.wiredCanvas = null;
        this.stopClockTimers();
    }
}
