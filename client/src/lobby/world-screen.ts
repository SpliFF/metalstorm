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
    screenToLatLon, parseWorldClock, tickWorldClock, formatWorldClock, poiOwnerColour,
    parseWorldPlayerStats, formatRealDuration, formatStat,
    type MapView, type Viewport, type WorldGraph, type WorldPoi, type WorldClock,
    type WorldStagingEntry,
    type WorldPlayerStats,
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
    /// The lobby's POST helper (`LobbyUI.lobbyPost`), which is how a
    /// token-authenticated route is reached at all: the dispatch gate only sees
    /// headers on a POST, so `/api/world/me` is a POST (see its handler in
    /// rts/lobby_main.cpp). Optional — without a session there is no player
    /// panel to draw, and the map itself is public.
    post?(path: string, body?: Record<string, unknown>): Promise<any>;
    basemapUrl?: string;
    /// PLAN-worldsim.md W5's click-through: join the room a POI's live war is
    /// playing in. Optional so a caller that has not wired the lobby's own
    /// `joinRoom` yet still gets a working map — the detail panel just omits
    /// the button when this is unset, same as `showTooltip` omits the "battle
    /// map" line for a world-only POI.
    onJoinRoom?(roomId: number): void;
}

/// Escape for the detail panel. POI names come from a seeder today and from
/// player-facing content tomorrow; neither is a reason to build innerHTML out
/// of them unescaped.
function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/// The route's machine tokens, as sentences. A player who committed force and
/// got "no_transport" back is owed the rule, not the token — and the mapping
/// lives here rather than in the server body so that a lobby answering a token
/// this client has never heard of degrades to the token instead of to nothing.
export function commitErrorText(token: string): string {
    switch (token) {
        case 'no_transport':   return 'A commitment needs at least one transport.';
        case 'no_squads':      return 'Those transports are carrying nothing.';
        case 'already_held':   return 'Your faction already holds this place.';
        case 'no_battle_map':  return 'Nothing can be fought over here — this POI has no battle map.';
        case 'not_in_a_faction': return 'Join a faction before committing force.';
        case 'not_your_commitment': return 'Only the committing faction can withdraw.';
        case 'no_poi':         return 'That place is no longer on the map.';
        case 'no_faction':     return 'Your faction is no longer in this world.';
        case 'no_staging':     return 'That commitment has already resolved.';
        case 'failed':         return 'The world could not accept that commitment.';
        default:               return token;
    }
}

export class WorldScreen {
    private graph: WorldGraph = { worldId: '', pois: [], edges: [], factions: {} };
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
    /// PLAN-worldsim.md W8: this account's Authority / Capacity / Rank, or null
    /// when there is no session, no `post` helper, or a lobby too old to answer
    /// with them. Null hides the panel rather than drawing zeroes — a zero
    /// rank and an absent one are different facts.
    private stats: WorldPlayerStats | null = null;
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
    /// PLAN-worldsim.md W10: the last commitment attempt's machine error, or
    /// null. Kept here rather than written straight into the panel because the
    /// panel is re-rendered from scratch on every selection and every refresh
    /// — an error painted into `innerHTML` would vanish on the next SSE tick,
    /// which is exactly when the player is still reading it.
    private commitError: string | null = null;
    /// The POI that error belongs to. An error about Randtown must not still
    /// be showing after the player clicks somewhere else.
    private commitErrorPoi: string | null = null;
    /// True while a commit/cancel POST is in flight, so a double-click cannot
    /// commit twice. A second commitment would JOIN the window server-side
    /// (§7.2) rather than be rejected, so the guard has to be here.
    private commitBusy = false;

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
        void this.refreshStats();
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
        else { this.renderDetail(); this.renderStats(); }
    }

    /// Fetch the POI graph. Keeps whatever is already drawn on a failed fetch:
    /// a transient 503 should not blank a map the player is reading.
    async refresh(): Promise<void> {
        const json = await this.deps.get('/api/world/pois').catch(() => null);
        const graph = parseWorldGraph(json);
        if (!graph) { this.setStatus('The world map is unavailable.'); return; }
        this.graph = graph;
        // Re-point the selection at the FRESHLY fetched node rather than
        // keeping the object the last fetch handed us. Before W10 the
        // difference was invisible (a POI's name and coordinates do not
        // change); now the node carries a live countdown and a live staging
        // list, so holding the old object would leave the panel showing the
        // world as it was when the player clicked. A POI that vanished from
        // the world deselects, as it always did.
        this.selected = this.selected
            ? graph.pois.find(p => p.id === this.selected!.id) ?? null
            : null;
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
        this.clockResyncTimer = setInterval(() => {
            void this.fetchClock();
            // The stats move on world events (a war settling accrues authority)
            // and on the real clock (capacity recharges), so they resync on the
            // same beat rather than on a timer of their own.
            void this.refreshStats();
        }, CLOCK_RESYNC_MS);
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
        const what = poi.battleStatus === 'active' ? 'battle in progress'
            : poi.battleStatus === 'staging' ? 'war staging'
            : poi.mapId ? 'battle map' : 'world only';
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

    /// Fetch the player panel's stats (PLAN-worldsim.md W8). Keeps whatever is
    /// already drawn on a failed fetch, same rule as `refresh()`: a transient
    /// 401 during a token refresh must not blank a panel the player is reading.
    async refreshStats(): Promise<void> {
        if (!this.deps.post) return;
        const json = await this.deps.post('/api/world/me').catch(() => null);
        const stats = parseWorldPlayerStats(json);
        if (stats) this.stats = stats;
        this.renderStats();
    }

    /// The player panel: Capacity (the budget they spend), Rank (the standing
    /// their votes carry) and their commanders with each one's Authority.
    ///
    /// The order is deliberate and matches the design's own division of the
    /// three: Capacity is what the player can DO today, Rank is what they are
    /// worth inside their faction, and Authority belongs to individual
    /// commanders — a per-commander number the panel must never present as a
    /// single player stat (Capture 23's whole point is that they are separate).
    private renderStats(): void {
        const el = document.getElementById('world-player');
        if (!el) return;
        const s = this.stats;
        if (!s) { el.style.display = 'none'; el.innerHTML = ''; return; }
        el.style.display = '';

        const cap = s.capacity;
        const capacity = cap
            ? `<div class="world-player-row"><span class="world-player-label">Capacity</span>` +
              `<span class="world-player-value">${formatStat(cap.available)} / ${formatStat(cap.max)}</span></div>` +
              `<div class="world-capacity-bar"><div class="world-capacity-fill" ` +
              `style="width:${cap.max > 0 ? Math.round(100 * Math.min(1, cap.available / cap.max)) : 0}%"></div></div>` +
              `<div class="world-player-sub">Full again in ${esc(formatRealDuration(cap.nextRechargeInMs))}` +
              ` · every ${formatStat(cap.rechargeHours)}h</div>`
            : '';

        const rank = s.rank;
        const rankLine = rank
            ? `<div class="world-player-row"><span class="world-player-label">Rank</span>` +
              `<span class="world-player-value">${formatStat(rank.total)}</span></div>` +
              `<div class="world-player-sub">` +
              (rank.factionId
                  ? `${rank.commanderCount} commander${rank.commanderCount === 1 ? '' : 's'} · ` +
                    `${rank.poiCount} region${rank.poiCount === 1 ? '' : 's'}` +
                    (rank.loanedCount > 0 ? ` · ${rank.loanedCount} on loan (excluded)` : '')
                  : 'No faction — rank is standing inside one.') +
              `</div>`
            : '';

        // W7's world authority, labelled as its own thing: it gates founding a
        // faction and it is NOT a commander's Authority.
        const worldAuthority =
            `<div class="world-player-row"><span class="world-player-label">World authority</span>` +
            `<span class="world-player-value">${formatStat(s.worldAuthority)}</span></div>`;

        const poiNames = new Map(this.graph.pois.map(p => [p.id, p.name]));
        const commanders = s.commanders.length
            ? `<div class="world-detail-head">Commanders</div><ul class="world-commanders">` +
              s.commanders.map(c => {
                  const where = c.poiId ? (poiNames.get(c.poiId) ?? c.poiId) : 'unstationed';
                  return `<li><span>${esc(c.name)}</span>` +
                      `<span class="world-commander-where">${esc(where)}</span>` +
                      (c.loaned ? `<span class="world-commander-loaned">loaned</span>` : '') +
                      `<span class="world-commander-authority">${formatStat(c.authority)}</span></li>`;
              }).join('') + `</ul>`
            : `<div class="world-player-sub">No commanders yet — authority earns you one.</div>`;

        el.innerHTML = `<h4>Your standing</h4>` + capacity + rankLine + worldAuthority + commanders;
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
        // PLAN-worldsim.md W5: the map line now reflects the live marker
        // state, and a POI with a live war gets a join button — the ONLY
        // write this milestone performs is the existing `/api/rooms/join`
        // call the room browser already makes; nothing world-scoped is
        // written back.
        const map = poi.warRoomId !== null
            ? `<div class="world-detail-map world-detail-map-${esc(poi.battleStatus)}">` +
              `${poi.battleStatus === 'active' ? 'Battle in progress' : 'War staging'} on ` +
              `<code>${esc(poi.mapId ?? '')}</code></div>` +
              (this.deps.onJoinRoom
                  ? `<button type="button" id="world-join-war-btn" data-room-id="${poi.warRoomId}">` +
                    `${poi.battleStatus === 'active' ? 'Watch / join battle' : 'Go to staging room'}</button>`
                  : '')
            : poi.mapId
            ? `<div class="world-detail-map">Battle map: <code>${esc(poi.mapId)}</code></div>`
            : '<div class="world-detail-map world-detail-dim">No battle map — world only.</div>';
        // PLAN-worldsim.md W7: who holds this place. The swatch is an inline
        // style because the colour is per-faction data, not a stylesheet
        // value; it is the same validated `#rrggbb` the canvas is handed
        // (parseWorldGraph drops anything else), so there is nothing here for
        // a faction name to inject through.
        const ownerColour = poiOwnerColour(poi, this.graph);
        const owner = poi.owner
            ? `<div class="world-detail-owner">` +
              `<span class="world-faction-swatch" style="background:${esc(ownerColour ?? '')}"></span>` +
              `Held by ${esc(this.graph.factions[poi.owner]?.name ?? poi.owner)}</div>`
            : '<div class="world-detail-owner world-detail-dim">Unclaimed.</div>';
        el.innerHTML =
            `<h4>${esc(poi.name)}</h4>` +
            `<div class="world-detail-sub">${esc(poi.kind || 'point of interest')} · ` +
            `${esc(formatLatLon(poi.lat, poi.lon))}</div>` +
            (tags ? `<div class="world-tags">${tags}</div>` : '') +
            owner +
            map +
            this.stagingHtml(poi) +
            (links
                ? `<div class="world-detail-head">Transit (world time)</div><ul class="world-links">${links}</ul>`
                : '<div class="world-detail-head world-detail-dim">No transit links.</div>');
        const joinBtn = document.getElementById('world-join-war-btn') as HTMLButtonElement | null;
        if (joinBtn && this.deps.onJoinRoom) {
            const roomId = Number(joinBtn.dataset.roomId);
            joinBtn.onclick = () => this.deps.onJoinRoom!(roomId);
        }
        this.wireStagingControls(poi);
    }

    // ── PLAN-worldsim.md W10: commitment, on the POI detail panel ──────────
    //
    // Capture 28's "a battle exists as a world event before it starts", made
    // clickable. Two halves: the forces already gathering here (public — the
    // warning IS the mechanic, so everyone sees the countdown), and the form
    // that commits your own faction's force (yours alone).

    /// This account's world faction, or null. Read off the W8 stat panel
    /// rather than fetched again: `/api/world/me` already answers with it, and
    /// a second source of "which faction am I" is a second thing to go stale.
    private get myFactionId(): string | null {
        return this.stats?.rank?.factionId ?? null;
    }

    private factionName(id: string): string {
        return this.graph.factions[id]?.name ?? id;
    }

    /// The gathering forces, and the commit/withdraw control. Never a button
    /// the server would refuse: §7.1's rule is restated here as which controls
    /// EXIST, so the player is not offered an act the world will reject.
    private stagingHtml(poi: WorldPoi): string {
        const mine = this.myFactionId;
        const list = poi.staging.map(s => {
            const swatch = this.graph.factions[s.attackerFaction]?.colour;
            const own = mine !== null && s.attackerFaction === mine;
            return `<li class="world-staging-row${own ? ' world-staging-own' : ''}">` +
                (swatch ? `<span class="world-faction-swatch" style="background:${esc(swatch)}"></span>` : '') +
                `<span class="world-staging-who">${esc(this.factionName(s.attackerFaction))}</span>` +
                `<span class="world-staging-force">${s.transports}× transport · ${s.squads} squad(s)</span>` +
                `<span class="world-staging-eta">${esc(formatWorldDuration(s.remainingWorldMs))}</span>` +
                (own
                    ? `<button type="button" class="world-staging-cancel" ` +
                      `data-staging-id="${s.stagingId}">Withdraw</button>`
                    : '') +
                `</li>`;
        }).join('');
        const head = poi.staging.length
            ? `<div class="world-detail-head">Forces gathering</div>` +
              `<ul class="world-staging">${list}</ul>`
            : '';

        // Why each control may be absent, in the order the player meets them:
        // no session or a lobby too old to answer `/api/world/me` (no `post`),
        // no faction to commit on behalf of, a place with no battle map to
        // fight over, and finally the place you already hold — §7.1's
        // "a POI it does not hold", which is not a refusal so much as
        // "there is nothing here to instigate".
        let form = '';
        if (!this.deps.post || mine === null) {
            form = poi.mapId
                ? '<div class="world-detail-dim world-staging-hint">Join a faction to commit force here.</div>'
                : '';
        } else if (!poi.mapId) {
            form = '<div class="world-detail-dim world-staging-hint">World-only — no battle can be staged here.</div>';
        } else if (poi.owner === mine) {
            form = '<div class="world-detail-dim world-staging-hint">Your faction holds this place.</div>';
        } else {
            form =
                `<div class="world-detail-head">Commit force</div>` +
                `<div class="world-staging-form">` +
                `<label>Transports <input type="number" id="world-commit-transports" ` +
                `min="1" max="99" value="1"></label>` +
                `<label>Squads <input type="number" id="world-commit-squads" ` +
                `min="1" max="99" value="1"></label>` +
                `<button type="button" id="world-commit-btn"${this.commitBusy ? ' disabled' : ''}>` +
                `Commit</button></div>` +
                // The whole point of the mechanic, stated where the click is:
                // this does not start a battle now, it starts the clock the
                // defender is warned by.
                `<div class="world-detail-dim world-staging-hint">` +
                `Opens a staging window sized by transit time — the defenders ` +
                `are warned for as long as your force is in transit.</div>`;
        }
        const err = this.commitError && this.commitErrorPoi === poi.id
            ? `<div class="world-staging-error">${esc(commitErrorText(this.commitError))}</div>`
            : '';
        return head + form + err;
    }

    private wireStagingControls(poi: WorldPoi): void {
        const commit = document.getElementById('world-commit-btn') as HTMLButtonElement | null;
        if (commit) commit.onclick = () => { void this.commitForce(poi); };
        for (const el of Array.from(
                document.querySelectorAll('.world-staging-cancel')) as HTMLButtonElement[]) {
            const id = Number(el.dataset.stagingId);
            el.onclick = () => { void this.cancelStaging(poi, id); };
        }
    }

    /// Commit, then re-fetch. The re-fetch is not a nicety: the window's
    /// length is priced SERVER-side from the POI graph, so the only honest way
    /// to show the countdown that was actually opened is to read it back.
    private async commitForce(poi: WorldPoi): Promise<void> {
        if (!this.deps.post || this.commitBusy) return;
        const num = (id: string): number => {
            const el = document.getElementById(id) as HTMLInputElement | null;
            const v = Math.floor(Number(el?.value));
            return Number.isFinite(v) && v > 0 ? v : 1;
        };
        // Read the force BEFORE anything re-renders. `renderDetail` rebuilds
        // the form from scratch — the inputs it hands back carry the default
        // 1, not what the player typed — so reading after the busy repaint
        // would silently commit one transport however many they asked for.
        const body = {
            poi: poi.id,
            transports: num('world-commit-transports'),
            squads: num('world-commit-squads'),
        };
        this.commitBusy = true;
        this.commitError = null;
        this.commitErrorPoi = poi.id;
        this.renderDetail();
        try {
            const res = await this.deps.post('/api/world/staging/commit', body)
                .catch(() => null);
            // `lobbyPost` answers null on a non-200 rather than throwing, so a
            // null here is a refusal with its reason already discarded — say
            // so plainly rather than claiming success.
            if (!res || res.ok !== true) {
                this.commitError = (res && typeof res.error === 'string') ? res.error : 'failed';
            }
        } finally {
            this.commitBusy = false;
        }
        await this.refresh();
    }

    private async cancelStaging(poi: WorldPoi, stagingId: number): Promise<void> {
        if (!this.deps.post || this.commitBusy || !Number.isFinite(stagingId)) return;
        this.commitBusy = true;
        this.commitErrorPoi = poi.id;
        this.commitError = null;
        try {
            const res = await this.deps.post('/api/world/staging/cancel', { stagingId })
                .catch(() => null);
            if (!res || res.ok !== true)
                this.commitError = (res && typeof res.error === 'string') ? res.error : 'failed';
        } finally {
            this.commitBusy = false;
        }
        await this.refresh();
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
