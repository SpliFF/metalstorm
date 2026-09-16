/**
 * world-screen.ts — the lobby's World screen (PLAN-worldsim.md W2 → phase 3).
 *
 * The DOM half of the world map: the canvas, the pointer handling, the
 * tooltip, and the DRAWER that hosts every panel. All of the geometry lives
 * in `world-map.ts` (no DOM, the map lane's) and every rule the panels state
 * lives in `world-staging.ts` / `world-claims.ts` / `world-ledger.ts` (no
 * DOM, this lane's); this file's job is to turn events into fetches and
 * fetches into markup.
 *
 * ── The drill-down rule (user directive 2026-08-29) ────────────────────────
 * The default state is QUIET: the map, the clock chip, your faction chip and
 * an alerts badge. Nothing else is open. Every other surface is a panel in
 * ONE drawer that opens on a click and closes on a click:
 *
 *   click a marker   → POI panel (owner, state, gathering forces, transit
 *                      from your holdings, stage / claim / withdraw)
 *   faction chip     → faction panel (found / join, treasury, holdings,
 *                      members, your standing, season standing, leave)
 *   Ledger chip      → the ONE access point for global data: seasons,
 *                      economy, staging windows, claims — as tabs
 *   Alerts badge     → the notification list (mark read, prune)
 *
 * One drawer, one panel at a time, none open by default. A panel never
 * re-renders under a field the player is typing in: passive refreshes
 * (the resync beat) defer until the field loses focus.
 *
 * ── Why this is a lobby screen ─────────────────────────────────────────────
 * The world is a lobby-side object — SQLite rows, a low-frequency tick and
 * HTTP, never sim state (PLAN-worldsim.md hard boundary 3) — and an in-game
 * client has no room SSE to hear about it on anyway. So the World screen is an
 * overlay over the lobby's browser screen, opened from the header beside
 * Replays and Friends. It covers the lobby rather than replacing it because
 * the room list underneath is still live.
 *
 * ── The markup is this file's ──────────────────────────────────────────────
 * The browser template ships an empty `#world-panel` shell (older builds ship
 * the W2 markup inside it). Either way `mount()` replaces the shell's
 * contents with `WORLD_PANEL_HTML` and injects `world-screen.css`, so the
 * screen owns its own structure and the lobby template only has to provide
 * the hook. The browser screen replaces its whole `innerHTML` on every
 * room-list re-render (every SSE tick), which is why `remount()` exists and
 * why every element is looked up by id at render time rather than cached.
 *
 * ── The button is hidden until the routes answer ───────────────────────────
 * Same rule the replay panel follows: a lobby built before W1 404s
 * `/api/world`, and an empty "World" panel reads as a broken feature rather
 * than an absent one.
 */

import worldCss from './world-screen.css?raw';
import {
    drawWorld, fitView, clampView, panView, zoomView, wheelZoomFactor,
    hitTestPoi, parseWorldGraph, edgesFor, formatWorldDuration, formatLatLon,
    screenToLatLon, parseWorldClock, tickWorldClock, formatWorldClock, poiOwnerColour,
    parseWorldPlayerStats, formatRealDuration, formatStat, mapFromLatLon,
    type MapView, type Viewport, type WorldGraph, type WorldPoi, type WorldClock,
    type WorldPlayerStats,
} from './world-map.js';
import {
    pushNotice, stagingNoticeClass, markRead, pruneNotices, clearRead, unreadCount, formatAgo,
    type WorldStagingNotice, type WorldStagingNoticeEvent,
} from './world-notifications.js';
import {
    parseStagingRules, predictStagingWindow, stagingControlState, remainingAfter,
    cleanForceField, commitErrorText, DEFAULT_STAGING_RULES,
    type StagingRules,
} from './world-staging.js';
import {
    parseClaims, claimEligibility, claimIneligibleText, claimQueue, claimExpiresIn,
    claimStateLabel, claimErrorText,
    type WorldClaims, type WorldClaim,
} from './world-claims.js';
import {
    parseSeasonStatus, parseSeasonsIndex, parseSeasonArchive, parseWorldStats,
    parseFactionCatalogue, parseMembership, joinSideConflict, factionErrorText,
    parsePauseAnswer, formatDigestLine, formatSigned,
    type SeasonStatus, type SeasonRow, type SeasonArchive, type WorldStatsBody,
    type FactionCatalogue, type WorldMembership,
} from './world-ledger.js';

export { commitErrorText } from './world-staging.js';

/// How often the World screen re-fetches while it is open, to resync the
/// locally-ticked clock (an admin pause elsewhere, a server restart, or
/// ordinary clock drift), the POI graph (a window opened by somebody else)
/// and the player's standing (authority accrues on a settlement).
export const CLOCK_RESYNC_MS = 30_000;

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
    /// rts/lobby_main.cpp). It answers the parsed body for ANY status — a 4xx
    /// arrives as `{ok:false, error}` — and throws only on a non-JSON body.
    /// Optional — without a session there is no standing to draw, and the
    /// map itself is public.
    post?(path: string, body?: Record<string, unknown>): Promise<any>;
    basemapUrl?: string;
    /// PLAN-worldsim.md W5's click-through: join the room a POI's live war is
    /// playing in. Optional so a caller that has not wired the lobby's own
    /// `joinRoom` yet still gets a working map — the POI panel just omits
    /// the button when this is unset.
    onJoinRoom?(roomId: number): void;
    /// Whether this session may call `/api/world/pause` (RouteAuth::AdminOnly).
    /// The pause control is only OFFERED when this answers true — the rule
    /// is never to show a button the server would refuse.
    isAdmin?(): boolean;
    /// The map lane's map object, if the caller has one. Feature-detected:
    /// `on('select', cb)` and `focus(poiId)` are used when present, nothing
    /// is required. See `attachMap`.
    map?: unknown;
    /// Wall clock, injectable for tests.
    now?(): number;
}

export type WorldPanelKind = 'poi' | 'faction' | 'ledger' | 'alerts';
export type WorldLedgerTab = 'seasons' | 'economy' | 'staging' | 'claims';

/// The screen's own markup, rendered into `#world-panel` by `mount()`. Every
/// id here is looked up at render time; none is cached across a re-render.
export const WORLD_PANEL_HTML =
    `<div class="world-head">` +
    `<h3>World · <span id="world-title"></span></h3>` +
    `<span id="world-clock" class="world-chip world-clock" title="World clock"></span>` +
    `<button type="button" id="world-pause-btn" class="world-btn" hidden></button>` +
    `<span class="world-head-spacer"></span>` +
    `<button type="button" id="world-faction-chip" class="world-chip" aria-pressed="false"></button>` +
    `<button type="button" id="world-ledger-btn" class="world-chip" aria-pressed="false">Ledger</button>` +
    `<button type="button" id="world-alerts-btn" class="world-chip" aria-pressed="false">Alerts ` +
    `<span id="world-alerts-badge" class="world-badge" hidden>0</span></button>` +
    `<button type="button" id="world-reset-btn" class="world-btn" title="Fit the whole world">Fit</button>` +
    `<button type="button" id="world-close-btn" class="world-btn">Close</button>` +
    `</div>` +
    `<div class="world-body">` +
    `<div class="world-canvas-wrap">` +
    `<canvas id="world-canvas" class="world-canvas"></canvas>` +
    `<div id="world-tooltip" class="world-tooltip" style="display:none"></div>` +
    `<div id="world-status" class="world-status" style="display:none"></div>` +
    `</div>` +
    `<aside id="world-drawer" class="world-drawer" hidden>` +
    `<div class="world-drawer-head"><h4 id="world-drawer-title"></h4>` +
    `<button type="button" id="world-drawer-close" class="world-btn world-btn-quiet" aria-label="Close panel">×</button></div>` +
    `<div id="world-drawer-body" class="world-drawer-body"></div>` +
    `</aside>` +
    `</div>` +
    `<div class="world-hint">Drag to pan · scroll to zoom · click a marker for detail</div>`;

/// Escape for panel markup. POI and faction names come from a seeder today
/// and from player-facing content tomorrow; neither is a reason to build
/// innerHTML out of them unescaped.
function esc(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/// The `/api/world/me` answer's session state. 'anon' is a session the route
/// refused (401), which is a different fact from "no `post` helper at all"
/// and from "still loading" — the panels say which.
type SessionState = 'none' | 'loading' | 'anon' | 'ok';

interface ActionResult { ok: boolean; error: string | null; body: any }

export class WorldScreen {
    private graph: WorldGraph = { worldId: '', pois: [], edges: [], factions: {} };
    /// Wall time the graph was fetched, and the WORLD time the ticked clock
    /// read at that moment — the base every served `remainingWorldMs` is
    /// advanced from between fetches. Null until a clock is known.
    private graphAt = 0;
    private graphWorldMs: number | null = null;
    private graphLoaded = false;
    private view: MapView = { scale: 1, offsetX: 0, offsetY: 0 };
    private basemap: HTMLImageElement | null = null;
    private hovered: WorldPoi | null = null;
    private selected: WorldPoi | null = null;
    private dragging = false;
    private dragMoved = 0;
    private lastPointer: { x: number; y: number } | null = null;
    private frame = 0;
    private resizeObserver: ResizeObserver | null = null;

    /// The last clock reading fetched from `/api/world`, ticked locally once
    /// a second between fetches (PLAN-worldsim.md W4).
    private clock: WorldClock | null = null;
    private worldAt = 0;
    private worldName = '';
    private season: SeasonStatus | null = null;
    private stagingRules: StagingRules = DEFAULT_STAGING_RULES;

    /// PLAN-worldsim.md W8: this account's Authority / Capacity / Rank, and
    /// W7's membership. Null hides the numbers rather than drawing zeroes —
    /// a zero rank and an absent one are different facts.
    private stats: WorldPlayerStats | null = null;
    private me: WorldMembership | null = null;
    private meAt = 0;
    private session: SessionState = 'none';

    private claims: WorldClaims | null = null;
    private claimsAt = 0;
    private claimsLoading = false;
    private catalogue: FactionCatalogue | null = null;
    private catalogueLoading = false;
    private worldStats: WorldStatsBody | null = null;
    private worldStatsAt = 0;
    private worldStatsLoading = false;
    private seasons: SeasonRow[] | null = null;
    private seasonsLoading = false;
    private archives = new Map<number, SeasonArchive | null>();
    private archiveLoading = new Set<number>();
    /// The season the ledger's seasons tab has drilled into, or null (index).
    private seasonView: number | null = null;

    /// PLAN-worldsim.md W11: alerts this session has received, newest first,
    /// with read-state. Kept here rather than in `LobbyUI` so the list
    /// survives a browser re-render the same way `selected` does.
    private notices: WorldStagingNotice[] = [];
    private noticeNextId = 1;

    private panel: WorldPanelKind | null = null;
    private ledgerTab: WorldLedgerTab = 'seasons';
    /// An action awaiting its second click, by key ("commit", "claim",
    /// "withdraw-claim:12", "leave", …). One at a time; any other click
    /// clears it.
    private confirming: string | null = null;
    /// The action in flight, by the same key. Guards double-submits: a
    /// second commitment would JOIN the window server-side (§7.2) rather
    /// than be rejected, so the guard has to be here.
    private busy: string | null = null;
    /// The last action's refusal, as a sentence, scoped to the panel it
    /// belongs to so an error about Randtown is not still showing after the
    /// player clicks somewhere else.
    private error: { panel: WorldPanelKind; key: string; text: string } | null = null;
    private notice: { panel: WorldPanelKind; key: string; text: string } | null = null;
    /// The staging form's values, carried across the confirm re-render.
    private commitDraft: { transports: number; squads: number } = { transports: 1, squads: 1 };

    private clockTickTimer: ReturnType<typeof setInterval> | null = null;
    private clockResyncTimer: ReturnType<typeof setInterval> | null = null;
    /// A passive re-render that found a field focused, waiting for the field
    /// to be left.
    private renderPending = false;

    /// Out-of-order guards: a slow earlier response must not overwrite a
    /// newer one (a pause/resume flip inverted by a late reply is the
    /// concrete case for the clock).
    private worldSeq = 0;
    private graphSeq = 0;
    private meSeq = 0;

    /// The canvas the handlers are attached to. Identity, not a boolean: the
    /// browser screen replaces its whole `innerHTML` on every room-list
    /// re-render, so "already wired" against a DIFFERENT canvas is exactly
    /// the state that leaves the map dead.
    private wiredCanvas: HTMLCanvasElement | null = null;
    private openState = false;
    private docListener: ((e: Event) => void) | null = null;
    private selectListeners = new Set<(poiId: string | null) => void>();
    private mapObject: any = null;

    constructor(private readonly deps: WorldScreenDeps) {
        if (deps.map) this.attachMap(deps.map);
    }

    private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }
    private get panelEl(): HTMLElement | null { return document.getElementById('world-panel'); }
    private get canvas(): HTMLCanvasElement | null {
        return document.getElementById('world-canvas') as HTMLCanvasElement | null;
    }
    private el(id: string): HTMLElement | null { return document.getElementById(id); }

    // ───────────────────────── lifecycle ─────────────────────────

    /// True once the world routes have answered at least once — the lobby uses
    /// it to decide whether the World button exists at all.
    async probe(): Promise<boolean> {
        const world = await this.deps.get('/api/world').catch(() => null);
        if (!world || typeof world.worldId !== 'string' || world.error) return false;
        this.applyWorld(world);
        this.renderHead();
        return true;
    }

    isOpen(): boolean { return this.openState; }

    /// Put the screen's own markup and stylesheet in place. Idempotent per
    /// panel element: a re-rendered shell gets the markup again, an intact one
    /// is left alone (and its drawer state with it).
    mount(): boolean {
        const panel = this.panelEl;
        if (!panel) return false;
        if (!panel.querySelector('#world-drawer')) panel.innerHTML = WORLD_PANEL_HTML;
        let style = document.getElementById('world-screen-styles');
        if (!style) {
            style = document.createElement('style');
            style.id = 'world-screen-styles';
            style.textContent = worldCss;
        }
        // Always LAST in <head>: the lobby re-appends `#lobby-styles` on a
        // template hot-swap, and the older W2 block in it must not win ties.
        document.head.appendChild(style);
        return true;
    }

    open(): void {
        if (!this.mount()) return;
        const panel = this.panelEl!;
        this.openState = true;
        panel.style.display = '';
        this.wire();
        this.loadBasemap();
        this.refreshIfStale();
        this.startClockTimers();
        this.renderAll();
        // Layout has to have happened before `fitView` can know the canvas
        // size; a panel unhidden in this same tick still measures 0×0 in some
        // browsers, and a fit computed against 0 gives scale 1 and an empty
        // blue rectangle.
        requestAnimationFrame(() => {
            this.resize();
            if (this.view.scale === 1 && this.view.offsetX === 0) this.view = fitView(this.viewport());
            this.paint();
        });
    }

    close(): void {
        this.openState = false;
        const panel = this.panelEl;
        if (panel) panel.style.display = 'none';
        this.dragging = false;
        this.hideTooltip();
        this.stopClockTimers();
    }

    toggle(): void { this.isOpen() ? this.close() : this.open(); }

    /// Called after the lobby rebuilds the browser markup. Re-attaches to the
    /// new elements and restores the screen if it was open, so an SSE room
    /// update does not shut the world map the player is reading — and does
    /// NOT re-fetch anything a fresh cache already answers, because the room
    /// list can tick several times a minute.
    remount(): void {
        if (!this.openState) return;
        this.open();
    }

    /// Fetch whatever is missing or older than a resync beat. `open()` and
    /// `remount()` share this so a re-render is free and a reopen is fresh.
    private refreshIfStale(): void {
        const now = this.now();
        if (!this.graphLoaded || now - this.graphAt > CLOCK_RESYNC_MS) void this.refresh();
        if (!this.clock || now - this.worldAt > CLOCK_RESYNC_MS) void this.fetchWorld();
        if (this.deps.post && (this.session === 'none' || now - this.meAt > CLOCK_RESYNC_MS)) void this.refreshStats();
        if (this.panel === 'poi' || (this.panel === 'ledger' && this.ledgerTab === 'claims')) this.ensureClaims();
    }

    destroy(): void {
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        if (this.frame) cancelAnimationFrame(this.frame);
        this.frame = 0;
        this.wiredCanvas = null;
        this.stopClockTimers();
        if (this.docListener) { document.removeEventListener('poi-selected', this.docListener); this.docListener = null; }
        this.selectListeners.clear();
    }

    // ───────────────────────── the event surface ─────────────────────────

    /// Subscribe to selection changes (null on deselect). Returns the
    /// unsubscribe. The map lane's `WorldMap.on('select')` is the mirror of
    /// this; either side may drive the other through `attachMap`.
    on(event: 'select', cb: (poiId: string | null) => void): () => void {
        if (event !== 'select') return () => {};
        this.selectListeners.add(cb);
        return () => { this.selectListeners.delete(cb); };
    }

    /// Plug in a map object. Feature-detected — `on('select', cb)` is
    /// subscribed to if it exists, `focus(poiId)` is called if it exists; a
    /// map with neither is simply held. Safe to call with anything.
    attachMap(map: unknown): void {
        this.mapObject = map && typeof map === 'object' ? map : null;
        const m = this.mapObject;
        if (m && typeof m.on === 'function') {
            try {
                m.on('select', (id: unknown) => {
                    const poiId = typeof id === 'string' ? id : (id && typeof (id as any).id === 'string' ? (id as any).id : null);
                    if (poiId !== (this.selected?.id ?? null)) this.selectPoi(poiId, /*fromMap=*/true);
                });
            } catch { /* a map that refuses the subscription is a map without one */ }
        }
    }

    /// Select AND travel: centre the view on the POI (or hand the travel to
    /// the map object if it offers `focus`). The drill-down's "click to
    /// drill, including camera travel", and what an alert row does.
    focus(poiId: string): boolean {
        const poi = this.graph.pois.find(p => p.id === poiId);
        if (!poi) return false;
        const m = this.mapObject;
        if (m && typeof m.focus === 'function') {
            try { m.focus(poiId); } catch { this.centreOn(poi); }
        } else {
            this.centreOn(poi);
        }
        return this.selectPoi(poiId);
    }

    private centreOn(poi: WorldPoi): void {
        const vp = this.viewport();
        if (vp.width === 0 || vp.height === 0) return;
        const p = mapFromLatLon(poi.lat, poi.lon);
        this.view = clampView({
            scale: this.view.scale,
            offsetX: vp.width / 2 - p.x * this.view.scale,
            offsetY: vp.height / 2 - p.y * this.view.scale,
        }, vp);
        this.paint();
    }

    private emitSelect(poiId: string | null, fromMap: boolean): void {
        for (const cb of Array.from(this.selectListeners)) {
            try { cb(poiId); } catch { /* a listener's failure is its own */ }
        }
        if (fromMap) return;
        const m = this.mapObject;
        if (poiId && m && typeof m.focus === 'function') {
            try { m.focus(poiId); } catch { /* optional */ }
        }
        this.panelEl?.dispatchEvent(new CustomEvent('poi-selected', {
            bubbles: true, detail: { poiId, source: 'world-screen' },
        }));
    }

    // ───────────────────────── data ─────────────────────────

    /// Fetch the POI graph. Keeps whatever is already drawn on a failed fetch:
    /// a transient 503 should not blank a map the player is reading.
    async refresh(): Promise<void> {
        const seq = ++this.graphSeq;
        const json = await this.deps.get('/api/world/pois').catch(() => null);
        if (seq !== this.graphSeq) return;
        const graph = parseWorldGraph(json);
        if (!graph) {
            this.setStatus(this.graphLoaded ? '' : 'The world map is unavailable.');
            return;
        }
        this.graph = graph;
        this.graphLoaded = true;
        this.graphAt = this.now();
        this.graphWorldMs = this.clock ? tickWorldClock(this.clock, this.graphAt).worldMs : null;
        // Re-point the selection at the FRESHLY fetched node: the node carries
        // a live countdown and a live staging list, so holding the old object
        // would leave the panel showing the world as it was when the player
        // clicked. A POI that vanished from the world deselects.
        if (this.selected) {
            const fresh = graph.pois.find(p => p.id === this.selected!.id) ?? null;
            this.selected = fresh;
            if (!fresh && this.panel === 'poi') this.panel = null;
        }
        this.setStatus(graph.pois.length === 0
            ? 'This world has no points of interest yet — W3 seeds them from the shipped battle maps.'
            : '');
        this.renderAll();
        this.paint();
    }

    /// `/api/world`: the clock (stamped with `Date.now()` at receipt — the
    /// instant the client measures elapsed wall time from), the season fold,
    /// the world's name and its staging rules.
    private async fetchWorld(): Promise<void> {
        const seq = ++this.worldSeq;
        const json = await this.deps.get('/api/world').catch(() => null);
        if (seq !== this.worldSeq) return;
        if (json && !json.error) this.applyWorld(json);
        this.renderHead();
    }

    private applyWorld(json: any): void {
        const clock = parseWorldClock(json, this.now());
        if (clock) {
            this.clock = clock; this.worldAt = clock.fetchedAtMs;
            // A graph fetched before any clock was known: date it now, backed
            // off by the wall time since, so its countdowns can tick.
            if (this.graphLoaded && this.graphWorldMs === null)
                this.graphWorldMs = clock.worldMs - Math.max(0, clock.fetchedAtMs - this.graphAt) * (clock.ratioNum / clock.ratioDen);
        }
        if (typeof json.name === 'string' || typeof json.worldId === 'string')
            this.worldName = String(json.name || json.worldId);
        this.season = parseSeasonStatus(json) ?? this.season;
        this.stagingRules = parseStagingRules(json);
    }

    /// Fetch the player's standing (PLAN-worldsim.md W8) and membership (W7)
    /// off `/api/world/me`. Keeps whatever is already drawn on a failed
    /// fetch, same rule as `refresh()`: a transient failure during a token
    /// refresh must not blank a panel the player is reading — but a 401 IS
    /// an answer (no session), and the panels say so.
    async refreshStats(): Promise<void> {
        if (!this.deps.post) { this.session = 'none'; return; }
        const seq = ++this.meSeq;
        if (this.session === 'none') this.session = 'loading';
        const json = await this.deps.post('/api/world/me').catch(() => null);
        if (seq !== this.meSeq) return;
        this.meAt = this.now();
        if (json && json.error === 'unauthorized') {
            this.session = 'anon';
            this.stats = null;
            this.me = null;
        } else {
            const stats = parseWorldPlayerStats(json);
            const me = parseMembership(json);
            if (stats) this.stats = stats;
            if (me) this.me = me;
            if (stats || me) this.session = 'ok';
            else if (this.session === 'loading') this.session = 'anon';
        }
        this.renderAll();
    }

    private ensureClaims(force = false): void {
        if (this.claimsLoading) return;
        if (!force && this.claims && this.now() - this.claimsAt < CLOCK_RESYNC_MS) return;
        this.claimsLoading = true;
        this.renderDrawer(true);
        void this.deps.get('/api/world/claims').catch(() => null).then(json => {
            this.claimsLoading = false;
            const parsed = parseClaims(json);
            if (parsed) { this.claims = parsed; this.claimsAt = this.now(); }
            this.renderDrawer();
        });
    }

    private ensureCatalogue(force = false): void {
        if (this.catalogueLoading || (!force && this.catalogue)) return;
        this.catalogueLoading = true;
        void this.deps.get('/api/world/factions').catch(() => null).then(json => {
            this.catalogueLoading = false;
            const parsed = parseFactionCatalogue(json);
            if (parsed) this.catalogue = parsed;
            this.renderDrawer();
        });
    }

    private ensureWorldStats(force = false): void {
        if (this.worldStatsLoading) return;
        if (!force && this.worldStats && this.now() - this.worldStatsAt < CLOCK_RESYNC_MS) return;
        this.worldStatsLoading = true;
        void this.deps.get('/api/world/stats').catch(() => null).then(json => {
            this.worldStatsLoading = false;
            const parsed = parseWorldStats(json);
            if (parsed) { this.worldStats = parsed; this.worldStatsAt = this.now(); }
            this.renderDrawer();
        });
    }

    private ensureSeasons(force = false): void {
        if (this.seasonsLoading || (!force && this.seasons)) return;
        this.seasonsLoading = true;
        void this.deps.get('/api/world/seasons').catch(() => null).then(json => {
            this.seasonsLoading = false;
            const parsed = parseSeasonsIndex(json);
            if (parsed) this.seasons = parsed;
            this.renderDrawer();
        });
    }

    private ensureArchive(n: number): void {
        if (this.archives.has(n) || this.archiveLoading.has(n)) return;
        this.archiveLoading.add(n);
        void this.deps.get(`/api/world/seasons/${n}`).catch(() => null).then(json => {
            this.archiveLoading.delete(n);
            this.archives.set(n, parseSeasonArchive(json));
            this.renderDrawer();
        });
    }

    /// A POST's answer, normalised. `lobbyPost` hands back the parsed body
    /// for any status, so a refusal arrives as `{ok:false, error}`; a
    /// non-JSON body (a crashed lobby's HTML) throws and becomes 'failed'.
    private async act(key: string, path: string, body: Record<string, unknown>): Promise<ActionResult> {
        if (!this.deps.post) return { ok: false, error: 'unauthorized', body: null };
        this.busy = key;
        this.confirming = null;
        this.renderDrawer(true);
        let res: any = null;
        try {
            res = await this.deps.post(path, body).catch(() => null);
        } finally {
            this.busy = null;
        }
        if (!res || typeof res !== 'object') return { ok: false, error: 'failed', body: null };
        if (res.ok === true) return { ok: true, error: null, body: res };
        return { ok: false, error: typeof res.error === 'string' ? res.error : 'failed', body: res };
    }

    // ───────────────────────── selection ─────────────────────────

    /// Select a POI by id, as a click would, and open its panel. Public
    /// because the map is a place the rest of the lobby will want to point
    /// at, and because it is how the preview harness stages a screenshot with
    /// the panel populated. `null` deselects and closes the POI panel.
    selectPoi(poiId: string | null, fromMap = false): boolean {
        const poi = poiId ? this.graph.pois.find(p => p.id === poiId) ?? null : null;
        const changed = (poi?.id ?? null) !== (this.selected?.id ?? null);
        this.selected = poi;
        this.confirming = null;
        if (poi) { this.panel = 'poi'; this.ensureClaims(); }
        else if (this.panel === 'poi') this.panel = null;
        this.renderAll(true);
        this.paint();
        if (changed) this.emitSelect(poi?.id ?? null, fromMap);
        return !!poi || poiId === null;
    }

    /// Open one panel (closing whichever was open), or close it when it is
    /// the one open — the chips toggle.
    openPanel(kind: WorldPanelKind | null): void {
        this.panel = this.panel === kind ? null : kind;
        this.confirming = null;
        if (this.panel === 'faction') {
            this.ensureCatalogue();
            this.ensureWorldStats();
            this.ensureSeasons();
            if (this.deps.post && this.session !== 'loading') void this.refreshStats();
        } else if (this.panel === 'ledger') {
            this.openLedgerTab(this.ledgerTab, /*render=*/false);
        } else if (this.panel === 'alerts') {
            this.notices = pruneNotices(this.notices, this.now());
        }
        this.renderAll(true);
    }

    getPanel(): WorldPanelKind | null { return this.panel; }

    openLedgerTab(tab: WorldLedgerTab, render = true): void {
        this.ledgerTab = tab;
        this.panel = 'ledger';
        if (tab === 'seasons') this.ensureSeasons();
        else if (tab === 'economy') this.ensureWorldStats();
        else if (tab === 'claims') this.ensureClaims();
        if (render) this.renderAll(true);
    }

    // ───────────────────────── notifications ─────────────────────────

    /// PLAN-worldsim.md W11: a `world-staging` / `world-poi` / `world-season`
    /// event landed. `lobby-ui.ts` calls this after (optionally) toasting it
    /// — the list is this screen's half of the alert, the toast is
    /// `lobby-ui.ts`'s, and both read the same parsed event so they can
    /// never disagree about what happened. An event about the world also
    /// means the map is stale (a window opened, a POI changed hands), so the
    /// graph is re-read while the screen is open.
    pushStagingNotice(ev: WorldStagingNoticeEvent): void {
        this.notices = pruneNotices(pushNotice(this.notices, ev, this.noticeNextId++, this.now()), this.now());
        if (this.openState) {
            if (ev.kind === 'season') void this.fetchWorld();
            else void this.refresh();
        }
        this.renderHead();
        if (this.panel === 'alerts') this.renderDrawer();
    }

    getNotices(): readonly WorldStagingNotice[] { return this.notices; }

    // ───────────────────────── timers ─────────────────────────

    /// Re-render every second (a locally-ticked clock and countdowns, no
    /// network) and re-fetch every `CLOCK_RESYNC_MS`. Guarded against
    /// double-starting: `remount()` calls `open()` again for an already-open
    /// panel on every SSE room-list re-render.
    private startClockTimers(): void {
        this.stopClockTimers();
        this.clockTickTimer = setInterval(() => this.tick(), 1000);
        this.clockResyncTimer = setInterval(() => {
            void this.fetchWorld();
            void this.refreshStats();
            void this.refresh();
            if (this.panel === 'poi' || (this.panel === 'ledger' && this.ledgerTab === 'claims')) this.ensureClaims(true);
            if (this.panel === 'faction' || (this.panel === 'ledger' && this.ledgerTab === 'economy')) this.ensureWorldStats(true);
        }, CLOCK_RESYNC_MS);
    }

    private stopClockTimers(): void {
        if (this.clockTickTimer !== null) { clearInterval(this.clockTickTimer); this.clockTickTimer = null; }
        if (this.clockResyncTimer !== null) { clearInterval(this.clockResyncTimer); this.clockResyncTimer = null; }
    }

    /// The once-a-second beat: the clock chip, every countdown span, and a
    /// deferred passive render once the field it waited on is left.
    tick(): void {
        this.renderClock();
        this.tickCountdowns();
        if (this.renderPending && !this.fieldFocused()) this.renderDrawer();
    }

    private fieldFocused(): boolean {
        const a = document.activeElement;
        if (!a) return false;
        const drawer = this.el('world-drawer');
        if (!drawer || !drawer.contains(a)) return false;
        return a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA';
    }

    /// The world time now, per the ticked clock; null without a clock.
    private worldNow(): number | null {
        return this.clock ? tickWorldClock(this.clock, this.now()).worldMs : null;
    }

    /// World ms elapsed since the graph was fetched — what every served
    /// countdown is advanced by. Zero without a clock (the countdown then
    /// holds at its served value until the next fetch, which is honest).
    private graphElapsedWorldMs(): number {
        const now = this.worldNow();
        if (now === null || this.graphWorldMs === null) return 0;
        return Math.max(0, now - this.graphWorldMs);
    }

    private tickCountdowns(): void {
        const elapsed = this.graphElapsedWorldMs();
        const spans = document.querySelectorAll<HTMLElement>('[data-remaining-world-ms]');
        for (const s of Array.from(spans)) {
            const served = Number(s.dataset.remainingWorldMs);
            s.textContent = formatWorldDuration(remainingAfter(served, elapsed));
        }
    }

    // ───────────────────────── rendering: head ─────────────────────────

    private renderAll(force = false): void {
        this.renderHead();
        this.renderDrawer(force);
    }

    private renderHead(): void {
        const title = this.el('world-title');
        if (title) title.textContent = this.worldName;
        this.renderClock();
        this.renderPauseControl();
        this.renderFactionChip();
        this.renderAlertsBadge();
        for (const [id, kind] of [['world-faction-chip', 'faction'], ['world-ledger-btn', 'ledger'], ['world-alerts-btn', 'alerts']] as const) {
            const b = this.el(id);
            if (b) b.setAttribute('aria-pressed', this.panel === kind ? 'true' : 'false');
        }
    }

    private renderClock(): void {
        const el = this.el('world-clock');
        if (!el) return;
        if (!this.clock) { el.textContent = ''; el.style.display = 'none'; return; }
        el.style.display = '';
        const c = tickWorldClock(this.clock, this.now());
        let text = formatWorldClock(c) + (c.paused ? ' · PAUSED' : '');
        if (this.season) {
            const left = remainingAfter(this.season.remainingWorldMs,
                Math.max(0, c.worldMs - this.clock.worldMs));
            text += ` · S${this.season.number}, ${formatWorldDuration(left)} left`;
        }
        el.textContent = text;
        el.classList.toggle('paused', c.paused);
        el.title = c.paused
            ? 'The world clock is paused by an admin — accrual, seasons, staging windows and claim expiry are frozen.'
            : `World clock, ${formatStat(c.ratioNum / c.ratioDen)}× real time`;
    }

    /// The admin pause (PLAN-worldsim.md W4, Capture 11). Offered only to a
    /// session the lobby says is an admin; a `changed:false` answer is a
    /// no-op, not an error, and the clock is taken straight from the reply.
    private renderPauseControl(): void {
        const btn = this.el('world-pause-btn') as HTMLButtonElement | null;
        if (!btn) return;
        const admin = !!this.deps.post && !!this.deps.isAdmin && this.deps.isAdmin() === true && !!this.clock;
        btn.hidden = !admin;
        if (!admin) return;
        const paused = tickWorldClock(this.clock!, this.now()).paused;
        btn.textContent = paused ? 'Resume world' : 'Pause world';
        btn.disabled = this.busy === 'pause';
        btn.onclick = () => { void this.togglePause(paused); };
    }

    private async togglePause(paused: boolean): Promise<void> {
        const res = await this.act('pause', '/api/world/pause', { action: paused ? 'resume' : 'pause' });
        const ans = parsePauseAnswer(res.body ?? { error: res.error });
        if (ans.ok && res.body?.clock) {
            const clock = parseWorldClock({ clock: res.body.clock }, this.now());
            if (clock) { this.clock = clock; this.worldAt = clock.fetchedAtMs; }
        }
        // Whatever the answer, the truth is the route's: re-read it so a
        // refused pause does not leave a chip that claims otherwise.
        await this.fetchWorld();
        this.renderHead();
    }

    private renderFactionChip(): void {
        const chip = this.el('world-faction-chip') as HTMLButtonElement | null;
        if (!chip) return;
        const m = this.me?.membership ?? null;
        if (m) {
            chip.innerHTML = `<span class="world-faction-swatch" style="background:${esc(m.colour || '#556')}"></span>${esc(m.name)}`;
            chip.title = 'Your faction';
        } else if (!this.deps.post || this.session === 'anon') {
            chip.innerHTML = `<span class="world-chip-label">Sign in</span> for a faction`;
            chip.title = 'Factions need a session';
        } else if (this.session === 'loading') {
            chip.innerHTML = `<span class="world-chip-label">Faction</span> …`;
        } else {
            chip.innerHTML = `<span class="world-chip-label">No faction</span> · found or join`;
            chip.title = 'Found or join a faction';
        }
        chip.onclick = () => this.openPanel('faction');
        const ledger = this.el('world-ledger-btn');
        if (ledger) ledger.onclick = () => this.openPanel('ledger');
        const alerts = this.el('world-alerts-btn');
        if (alerts) alerts.onclick = () => this.openPanel('alerts');
    }

    private renderAlertsBadge(): void {
        const badge = this.el('world-alerts-badge');
        if (!badge) return;
        const n = unreadCount(this.notices);
        badge.hidden = n === 0;
        badge.textContent = String(n);
    }

    private setStatus(text: string): void {
        const el = this.el('world-status');
        if (!el) return;
        el.textContent = text;
        el.style.display = text ? '' : 'none';
    }

    // ───────────────────────── rendering: the drawer ─────────────────────────

    /// Render whichever panel is open. A PASSIVE render (a resync landing)
    /// that finds a field focused defers until the field is left, so a
    /// refresh never resets a number the player is typing.
    private renderDrawer(force = false): void {
        const drawer = this.el('world-drawer');
        const body = this.el('world-drawer-body');
        const title = this.el('world-drawer-title');
        if (!drawer || !body || !title) return;
        if (!this.panel) {
            drawer.hidden = true;
            body.innerHTML = '';
            this.renderPending = false;
            return;
        }
        if (!force && this.fieldFocused()) { this.renderPending = true; return; }
        this.renderPending = false;
        drawer.hidden = false;
        const close = this.el('world-drawer-close');
        if (close) close.onclick = () => { if (this.panel === 'poi') this.selectPoi(null); else this.openPanel(null); };
        switch (this.panel) {
            case 'poi':     title.textContent = this.selected?.name ?? ''; body.innerHTML = this.poiHtml(); break;
            case 'faction': title.textContent = this.me?.membership?.name ?? 'Faction'; body.innerHTML = this.factionHtml(); break;
            case 'ledger':  title.textContent = 'World ledger'; body.innerHTML = this.ledgerHtml(); break;
            case 'alerts':  title.textContent = 'Alerts'; body.innerHTML = this.alertsHtml(); break;
        }
        this.wireDrawer(body);
        this.tickCountdowns();
    }

    private messageHtml(panel: WorldPanelKind, key?: string): string {
        let out = '';
        if (this.error && this.error.panel === panel && (!key || this.error.key === key))
            out += `<div class="world-error">${esc(this.error.text)}</div>`;
        if (this.notice && this.notice.panel === panel && (!key || this.notice.key === key))
            out += `<div class="world-ok">${esc(this.notice.text)}</div>`;
        return out;
    }

    private setError(panel: WorldPanelKind, key: string, text: string | null): void {
        this.error = text ? { panel, key, text } : null;
        if (text) this.notice = null;
    }

    private setNotice(panel: WorldPanelKind, key: string, text: string | null): void {
        this.notice = text ? { panel, key, text } : null;
        if (text) this.error = null;
    }

    /// Every button in the drawer carries `data-act` and, optionally,
    /// `data-arg`; one dispatcher reads them. A rebuilt panel is rewired by
    /// the next render, never by remembering elements.
    private wireDrawer(body: HTMLElement): void {
        for (const btn of Array.from(body.querySelectorAll<HTMLButtonElement>('button[data-act]'))) {
            btn.onclick = () => { void this.dispatch(btn.dataset.act!, btn.dataset.arg ?? ''); };
        }
        for (const row of Array.from(body.querySelectorAll<HTMLElement>('[data-notice-id]'))) {
            row.onclick = () => this.onNoticeClick(Number(row.dataset.noticeId));
        }
        for (const tab of Array.from(body.querySelectorAll<HTMLButtonElement>('button[data-tab]'))) {
            tab.onclick = () => this.openLedgerTab(tab.dataset.tab as WorldLedgerTab);
        }
    }

    private async dispatch(act: string, arg: string): Promise<void> {
        const poi = this.selected;
        switch (act) {
            case 'cancel-confirm': this.confirming = null; this.renderDrawer(true); return;
            case 'join-room': if (this.deps.onJoinRoom) this.deps.onJoinRoom(Number(arg)); return;
            case 'focus': this.focus(arg); return;
            case 'commit': if (poi) this.beginCommit(poi); return;
            case 'commit-confirm': if (poi) await this.commitForce(poi); return;
            case 'withdraw-staging': this.confirm(`withdraw-staging:${arg}`); return;
            case 'withdraw-staging-confirm': if (poi) await this.cancelStaging(poi, Number(arg)); return;
            case 'claim': this.confirm('claim'); return;
            case 'claim-confirm': if (poi) await this.fileClaim(poi); return;
            case 'withdraw-claim': this.confirm(`withdraw-claim:${arg}`); return;
            case 'withdraw-claim-confirm': await this.withdrawClaim(Number(arg)); return;
            case 'found': await this.foundFaction(); return;
            case 'join': this.confirm(`join:${arg}`); return;
            case 'join-confirm': await this.joinFaction(arg); return;
            case 'leave': this.confirm('leave'); return;
            case 'leave-confirm': await this.leaveFaction(); return;
            case 'season': this.seasonView = arg ? Number(arg) : null; if (arg) this.ensureArchive(Number(arg)); this.renderDrawer(true); return;
            case 'alerts-read-all': this.notices = markRead(this.notices, null); this.renderAll(true); return;
            case 'alerts-clear-read': this.notices = clearRead(this.notices); this.renderAll(true); return;
            case 'refresh-claims': this.ensureClaims(true); return;
            case 'refresh-stats': this.ensureWorldStats(true); return;
        }
    }

    private confirm(key: string): void {
        this.confirming = key;
        this.error = null;
        this.notice = null;
        this.renderDrawer(true);
    }

    private confirmHtml(key: string, text: string, confirmAct: string, arg = '', label = 'Confirm'): string {
        if (this.confirming !== key) return '';
        return `<div class="world-confirm">${text}` +
            `<div class="world-actions">` +
            `<button type="button" class="world-btn world-btn-primary" data-act="${esc(confirmAct)}" data-arg="${esc(arg)}"${this.busy ? ' disabled' : ''}>${esc(label)}</button>` +
            `<button type="button" class="world-btn" data-act="cancel-confirm">Cancel</button>` +
            `</div></div>`;
    }

    // ───────────────────────── the POI panel ─────────────────────────

    /// This account's world faction, or null. Membership (W7) first, the
    /// W8 rank's faction as the fallback for a lobby that answers one and
    /// not the other; never a second fetch — a second source of "which
    /// faction am I" is a second thing to go stale.
    private get myFactionId(): string | null {
        return this.me?.membership?.factionId ?? this.stats?.rank?.factionId ?? null;
    }

    private factionName(id: string): string {
        const badge = this.graph.factions[id]?.name;
        if (badge) return badge;
        const m = this.me?.membership;
        if (m && m.factionId === id) return m.name;
        return this.catalogue?.factions.find(f => f.id === id)?.name ?? id;
    }

    private factionColour(id: string): string {
        return this.graph.factions[id]?.colour || this.catalogue?.factions.find(f => f.id === id)?.colour || '';
    }

    private poiName(id: string): string {
        return this.graph.pois.find(p => p.id === id)?.name ?? id;
    }

    private swatch(colour: string): string {
        return colour ? `<span class="world-faction-swatch" style="background:${esc(colour)}"></span>` : '';
    }

    private poiHtml(): string {
        const poi = this.selected;
        if (!poi) return '<div class="world-detail-dim">Select a point of interest.</div>';
        const mine = this.myFactionId;
        const names = new Map(this.graph.pois.map(p => [p.id, p.name]));
        const tags = poi.tags.map(t => `<span class="world-tag">${esc(t)}</span>`).join('');

        // Who holds it (W7). The swatch is an inline style because the colour
        // is per-faction data; it is the same validated `#rrggbb` the canvas
        // is handed, so there is nothing here for a faction name to inject.
        const ownerColour = poiOwnerColour(poi, this.graph);
        const owner = poi.owner
            ? `<div class="world-detail-owner">${this.swatch(ownerColour ?? '')}` +
              `Held by ${esc(this.factionName(poi.owner))}${poi.owner === mine ? ' — yours' : ''}</div>`
            : '<div class="world-detail-owner world-detail-dim">Unclaimed.</div>';

        // State (W5): the live marker, and the click-through.
        const state = poi.warRoomId !== null
            ? `<div class="world-detail-map world-detail-map-${esc(poi.battleStatus)}">` +
              `${poi.battleStatus === 'active' ? 'Battle in progress' : 'War staging'} on <code>${esc(poi.mapId ?? '')}</code></div>` +
              (this.deps.onJoinRoom
                  ? `<div class="world-actions"><button type="button" class="world-btn world-btn-primary" data-act="join-room" data-arg="${poi.warRoomId}">` +
                    `${poi.battleStatus === 'active' ? 'Watch / join battle' : 'Go to staging room'}</button></div>`
                  : '')
            : poi.mapId
            ? `<div class="world-detail-map">Quiet · battle map <code>${esc(poi.mapId)}</code></div>`
            : '<div class="world-detail-map world-detail-dim">No battle map — world only.</div>';

        // Garrison summary (W8): the commanders this account has stationed
        // here. The world serves no other faction's garrison — that would be
        // intelligence the design prices — so "yours here" is the summary.
        const garrison = (this.stats?.commanders ?? []).filter(c => c.poiId === poi.id);
        const garrisonHtml = garrison.length
            ? `<div class="world-detail-head">Your garrison</div><ul class="world-list">` +
              garrison.map(c => `<li><span>${esc(c.name)}</span>${c.loaned ? '<span class="world-muted">on loan</span>' : ''}` +
                  `<span class="world-right">${formatStat(c.authority)}</span></li>`).join('') + `</ul>`
            : '';

        // Transit from your holdings — priced exactly as the server prices a
        // window, so the number here is the number the commit will open.
        let transitHtml = '';
        if (mine !== null && poi.owner !== mine && poi.mapId) {
            const pred = predictStagingWindow(this.graph, mine, poi.id, this.stagingRules);
            transitHtml = `<div class="world-detail-head">From your holdings</div>` +
                (pred.priced === 'edge'
                    ? `<div class="world-row"><span class="world-row-label">March from ${esc(names.get(pred.originId!) ?? pred.originId!)}</span>` +
                      `<span class="world-row-value">${esc(formatWorldDuration(pred.transitWorldMs))}</span></div>` +
                      `<div class="world-sub">A commitment opens a ${esc(formatWorldDuration(pred.windowWorldMs))} staging window (world time).</div>`
                    : `<div class="world-sub">No direct route from a place you hold — a commitment gets the world's default ` +
                      `${esc(formatWorldDuration(pred.windowWorldMs))} window.</div>`);
        }

        const links = edgesFor(this.graph.edges, poi.id).map(({ edge, other }) => {
            const dir = edge.bidirectional ? '↔' : (edge.from === poi.id ? '→' : '←');
            const kind = edge.kind ? ` <span class="world-edge-kind">${esc(edge.kind)}</span>` : '';
            return `<li>${dir} <button type="button" class="world-link" data-act="focus" data-arg="${esc(other)}">${esc(names.get(other) ?? other)}</button>${kind}` +
                `<span class="world-edge-time">${esc(formatWorldDuration(edge.transitWorldMs))}</span></li>`;
        }).join('');
        const linksHtml = links
            ? `<div class="world-detail-head">Transit (world time)</div><ul class="world-list">${links}</ul>`
            : '<div class="world-detail-head world-detail-dim">No transit links.</div>';

        return `<div class="world-detail-sub">${esc(poi.kind || 'point of interest')} · ${esc(formatLatLon(poi.lat, poi.lon))}</div>` +
            (tags ? `<div class="world-tags">${tags}</div>` : '') +
            owner + state + garrisonHtml +
            this.stagingHtml(poi) +
            this.claimsHtml(poi) +
            transitHtml + linksHtml;
    }

    // ── PLAN-worldsim.md W10: commitment, on the POI panel ──────────
    //
    // Capture 28's "a battle exists as a world event before it starts", made
    // clickable. Two halves: the forces already gathering here (public — the
    // warning IS the mechanic, so everyone sees the countdown), and the form
    // that commits your own faction's force (yours alone).

    /// The gathering forces, and the commit/withdraw control. Never a button
    /// the server would refuse: §7.1's rule is restated as which controls
    /// EXIST, so the player is not offered an act the world will reject.
    private stagingHtml(poi: WorldPoi): string {
        const mine = this.myFactionId;
        const list = poi.staging.map(s => {
            const own = mine !== null && s.attackerFaction === mine;
            return `<li class="world-staging-row${own ? ' world-staging-own' : ''}">` +
                this.swatch(this.factionColour(s.attackerFaction)) +
                `<span class="world-staging-who">${esc(this.factionName(s.attackerFaction))}</span>` +
                `<span class="world-muted">${s.transports}× transport · ${s.squads} squad${s.squads === 1 ? '' : 's'}</span>` +
                `<span class="world-right world-staging-eta" data-remaining-world-ms="${s.remainingWorldMs}">${esc(formatWorldDuration(s.remainingWorldMs))}</span>` +
                (own
                    ? `<button type="button" class="world-btn world-btn-danger world-staging-cancel" data-act="withdraw-staging" data-arg="${s.stagingId}"${this.busy ? ' disabled' : ''}>Withdraw</button>` +
                      this.confirmHtml(`withdraw-staging:${s.stagingId}`,
                          'Withdraw this commitment? The force returns to your pool; the window closes if it was the only one.',
                          'withdraw-staging-confirm', String(s.stagingId), 'Withdraw')
                    : '') +
                `</li>`;
        }).join('');
        const head = poi.staging.length
            ? `<div class="world-detail-head">Forces gathering</div><ul class="world-list world-staging">${list}</ul>`
            : '';

        let form = '';
        const hasSession = this.session === 'ok';
        const control = stagingControlState(poi, mine, hasSession);
        if (this.session === 'loading') {
            form = '<div class="world-loading">Loading your standing…</div>';
        } else if (control === 'no-session') {
            form = poi.mapId ? '<div class="world-sub">Sign in and join a faction to commit force here.</div>' : '';
        } else if (control === 'no-faction') {
            form = poi.mapId ? '<div class="world-sub">Join a faction to commit force here.</div>' : '';
        } else if (control === 'world-only') {
            form = '<div class="world-sub">World-only — no battle can be staged here.</div>';
        } else if (control === 'held') {
            form = '<div class="world-sub">Your faction holds this place.</div>';
        } else {
            const d = this.commitDraft;
            form =
                `<div class="world-detail-head">Stage an attack</div>` +
                `<div class="world-form">` +
                `<label>Transports <input type="number" id="world-commit-transports" min="1" max="99" value="${d.transports}"></label>` +
                `<label>Squads <input type="number" id="world-commit-squads" min="1" max="99" value="${d.squads}"></label>` +
                `</div><div class="world-actions">` +
                `<button type="button" class="world-btn world-btn-primary" id="world-commit-btn" data-act="commit"${this.busy ? ' disabled' : ''}>Commit force…</button>` +
                `</div>` +
                this.confirmHtml('commit', this.commitConfirmText(poi), 'commit-confirm', '', 'Commit') +
                // The whole point of the mechanic, stated where the click is:
                // this does not start a battle now, it starts the clock the
                // defender is warned by.
                `<div class="world-sub">Opens a staging window sized by transit time — the defenders are warned for as long as your force is in transit. Costs no authority; the force goes into escrow.</div>`;
        }
        return head + form + this.messageHtml('poi', 'commit');
    }

    private commitConfirmText(poi: WorldPoi): string {
        const d = this.commitDraft;
        const pred = predictStagingWindow(this.graph, this.myFactionId, poi.id, this.stagingRules);
        const joining = poi.staging.some(s => s.attackerFaction === this.myFactionId);
        return `Commit <strong>${d.transports}× transport, ${d.squads} squad${d.squads === 1 ? '' : 's'}</strong> against ${esc(poi.name)}` +
            (poi.owner ? ` (held by ${esc(this.factionName(poi.owner))})` : '') + '.' +
            (joining
                ? ' Your faction already has a window open here — this joins it.'
                : ` Expected window: ${esc(formatWorldDuration(pred.windowWorldMs))} world time` +
                  (pred.priced === 'edge' ? ` from ${esc(this.poiName(pred.originId!))}.` : ' (default — no direct route).'));
    }

    private beginCommit(_poi: WorldPoi): void {
        // Read the force BEFORE anything re-renders: the confirm box is a
        // rebuild of the panel, and the inputs it hands back carry whatever
        // the draft says, not what the player typed.
        const read = (id: string): number => cleanForceField((this.el(id) as HTMLInputElement | null)?.value);
        this.commitDraft = { transports: read('world-commit-transports'), squads: read('world-commit-squads') };
        this.confirm('commit');
    }

    /// Commit, then re-fetch. The re-fetch is not a nicety: the window's
    /// length is priced SERVER-side from the POI graph, so the only honest way
    /// to show the countdown that was actually opened is to read it back.
    private async commitForce(poi: WorldPoi): Promise<void> {
        if (this.busy) return;
        const body = { poi: poi.id, transports: this.commitDraft.transports, squads: this.commitDraft.squads };
        const res = await this.act('commit', '/api/world/staging/commit', body);
        if (res.ok) {
            this.setNotice('poi', 'commit', res.body?.joined === true
                ? 'Joined the open window — your force is in escrow.'
                : 'Staging window opened — your force is in escrow.');
        } else {
            this.setError('poi', 'commit', commitErrorText(res.error ?? 'failed'));
        }
        await this.refresh();
    }

    private async cancelStaging(poi: WorldPoi, stagingId: number): Promise<void> {
        if (this.busy || !Number.isFinite(stagingId)) return;
        const res = await this.act(`withdraw-staging:${stagingId}`, '/api/world/staging/cancel', { stagingId });
        if (res.ok) this.setNotice('poi', 'commit', res.body?.cancelled === false
            ? 'That window had already closed.' : 'Commitment withdrawn — the escrow is refunded.');
        else this.setError('poi', 'commit', commitErrorText(res.error ?? 'failed'));
        void poi;
        await this.refresh();
    }

    // ── Conquest: the explicit claim act ──────────

    private claimsHtml(poi: WorldPoi): string {
        if (!poi.mapId) return '';
        const mine = this.myFactionId;
        const rules = this.claims?.rules ?? { claimPoiCost: 25, claimRefundFraction: 0.5, claimExpiryWorldMs: 0 };
        const all = this.claims?.claims ?? [];
        const queue = claimQueue(all, poi.id);
        const nowWorld = this.worldNow();
        const rows = queue.map((c, i) => {
            const own = c.faction === mine;
            const expires = nowWorld !== null ? claimExpiresIn(c, rules, nowWorld) : null;
            return `<li${own ? ' class="world-staging-own"' : ''}>` +
                `<span class="world-muted">#${i + 1}</span>` + this.swatch(this.factionColour(c.faction)) +
                `<span>${esc(this.factionName(c.faction))}${own ? ' (yours)' : ''}</span>` +
                (expires !== null ? `<span class="world-right world-muted">expires in ${esc(formatWorldDuration(expires))}</span>` : '') +
                (own
                    ? `<button type="button" class="world-btn world-btn-danger" data-act="withdraw-claim" data-arg="${c.claimId}"${this.busy ? ' disabled' : ''}>Withdraw</button>` +
                      this.confirmHtml(`withdraw-claim:${c.claimId}`,
                          `Withdraw the claim? ${Math.round(rules.claimRefundFraction * 100)}% of the ${formatStat(c.cost)} authority paid comes back.`,
                          'withdraw-claim-confirm', String(c.claimId), 'Withdraw claim')
                    : '') +
                `</li>`;
        }).join('');
        let head = `<div class="world-detail-head">Claims</div>`;
        if (this.claimsLoading && !this.claims) head += '<div class="world-loading">Loading claims…</div>';
        else if (!this.claims) head += '<div class="world-sub">Claims are unavailable on this lobby.</div>';
        else head += queue.length
            ? `<ul class="world-list">${rows}</ul>`
            : '<div class="world-sub">No open claims here.</div>';

        let control = '';
        if (this.claims && this.session !== 'loading') {
            const e = claimEligibility({
                poiOwner: poi.owner, myFactionId: mine, hasSession: this.session === 'ok',
                worldAuthority: this.me?.authority ?? this.stats?.worldAuthority ?? 0,
                claims: all, poiId: poi.id, rules,
            });
            if (e.ok) {
                control = `<div class="world-actions"><button type="button" class="world-btn world-btn-primary" id="world-claim-btn" data-act="claim"${this.busy ? ' disabled' : ''}>` +
                    `File claim · ${formatStat(e.cost)} authority</button></div>` +
                    this.confirmHtml('claim',
                        `File a claim on ${esc(poi.name)} for <strong>${formatStat(e.cost)} world authority</strong> (you have ${formatStat(e.have)})? ` +
                        `It wins the place only if your side wins a battle here before it expires; ` +
                        `losing or withdrawing refunds ${Math.round(e.refundFraction * 100)}%.` +
                        (poi.owner && poi.owner !== mine ? ` The defender's shield: if ${esc(this.factionName(poi.owner))} holds the field, no claim transfers it.` : ''),
                        'claim-confirm', '', `File claim (${formatStat(e.cost)})`);
            } else if (e.reason && e.reason !== 'no-session' && e.reason !== 'no-faction') {
                control = `<div class="world-sub">${esc(claimIneligibleText(e.reason, e))}</div>`;
            }
        }
        const rule = '<div class="world-sub">Ownership moves at war end only to a winning-side faction with a claim filed before the war ended; the earliest claim wins, and a defended place never changes hands.</div>';
        return head + control + this.messageHtml('poi', 'claim') + rule;
    }

    private async fileClaim(poi: WorldPoi): Promise<void> {
        if (this.busy) return;
        const res = await this.act('claim', '/api/world/claims/file', { poi: poi.id });
        if (res.ok) this.setNotice('poi', 'claim', `Claim filed on ${poi.name}.`);
        else this.setError('poi', 'claim', claimErrorText(res.error ?? 'failed', res.body ?? undefined));
        // A filed claim charged authority: the standing changed too.
        this.ensureClaims(true);
        await this.refreshStats();
    }

    private async withdrawClaim(claimId: number): Promise<void> {
        if (this.busy || !Number.isFinite(claimId)) return;
        const res = await this.act(`withdraw-claim:${claimId}`, '/api/world/claims/withdraw', { claimId });
        if (res.ok) this.setNotice('poi', 'claim', res.body?.withdrawn === false
            ? 'That claim had already resolved.' : 'Claim withdrawn.');
        else this.setError('poi', 'claim', claimErrorText(res.error ?? 'failed'));
        this.ensureClaims(true);
        await this.refreshStats();
    }

    // ───────────────────────── the faction panel ─────────────────────────

    private factionHtml(): string {
        if (!this.deps.post || this.session === 'anon')
            return '<div class="world-sub">Sign in to found or join a faction.</div>' + this.messageHtml('faction');
        if (this.session === 'loading' || this.session === 'none')
            return '<div class="world-loading">Loading your standing…</div>';
        const m = this.me?.membership ?? null;
        return (m ? this.memberFactionHtml(m.factionId) : this.noFactionHtml()) + this.standingHtml();
    }

    /// The player panel (W8): Capacity (the budget they spend), Rank (the
    /// standing their votes carry), world authority (the founding gate's and
    /// the claim's number — NOT a commander's Authority) and their commanders.
    private standingHtml(): string {
        const s = this.stats;
        const authority = this.me?.authority ?? s?.worldAuthority ?? 0;
        let out = `<div class="world-detail-head">Your standing</div>` +
            `<div class="world-row"><span class="world-row-label">World authority</span><span class="world-row-value">${formatStat(authority)}</span></div>`;
        if (!s) return out + '<div class="world-sub">No stats yet.</div>';
        const cap = s.capacity;
        if (cap) {
            out += `<div class="world-row"><span class="world-row-label">Capacity</span>` +
                `<span class="world-row-value">${formatStat(cap.available)} / ${formatStat(cap.max)}</span></div>` +
                `<div class="world-capacity-bar"><div class="world-capacity-fill" style="width:${cap.max > 0 ? Math.round(100 * Math.min(1, cap.available / cap.max)) : 0}%"></div></div>` +
                `<div class="world-sub">Full again in ${esc(formatRealDuration(cap.nextRechargeInMs))} · every ${formatStat(cap.rechargeHours)}h real time</div>`;
        }
        const rank = s.rank;
        if (rank) {
            out += `<div class="world-row"><span class="world-row-label">Rank</span><span class="world-row-value">${formatStat(rank.total)}</span></div>` +
                `<div class="world-sub">` +
                (rank.factionId
                    ? `${rank.commanderCount} commander${rank.commanderCount === 1 ? '' : 's'} · ${rank.poiCount} region${rank.poiCount === 1 ? '' : 's'}` +
                      (rank.loanedCount > 0 ? ` · ${rank.loanedCount} on loan (excluded)` : '')
                    : 'No faction — rank is standing inside one.') +
                `</div>`;
        }
        out += s.commanders.length
            ? `<div class="world-detail-head">Commanders</div><ul class="world-list">` +
              s.commanders.map(c => {
                  const where = c.poiId ? this.poiName(c.poiId) : 'unstationed';
                  return `<li><span>${esc(c.name)}</span>` +
                      (c.poiId ? `<button type="button" class="world-link world-muted" data-act="focus" data-arg="${esc(c.poiId)}">${esc(where)}</button>` : `<span class="world-muted">${esc(where)}</span>`) +
                      (c.loaned ? `<span class="world-muted">on loan</span>` : '') +
                      `<span class="world-right">${formatStat(c.authority)}</span></li>`;
              }).join('') + `</ul>`
            : `<div class="world-sub">No commanders yet — authority earns you one.</div>`;
        return out;
    }

    private memberFactionHtml(factionId: string): string {
        const m = this.me!.membership!;
        const cat = this.catalogue?.factions.find(f => f.id === factionId) ?? null;
        const arch = cat ? this.catalogue?.archetypes.find(a => a.key === cat.archetype) : null;
        const econ = this.worldStats?.economy?.factions.find(f => f.factionId === factionId) ?? null;
        const roster = this.worldStats?.factions.find(f => f.factionId === factionId) ?? null;
        const holdings = this.graph.pois.filter(p => p.owner === factionId);
        let out = `<div class="world-detail-sub">${this.swatch(m.colour)} ${esc(arch?.name ?? cat?.archetype ?? 'faction')}` +
            (cat?.governance ? ` · ${esc(cat.governance)}` : '') + ` · you are ${esc(m.role)}</div>`;

        out += `<div class="world-row"><span class="world-row-label">Treasury</span><span class="world-row-value">` +
            (econ ? formatStat(econ.treasury) : (this.worldStatsLoading ? '…' : '—')) + `</span></div>`;
        if (this.worldStats?.economy) {
            const r = this.worldStats.economy.rates;
            out += `<div class="world-sub">${formatSigned(r.poiIncomePerWorldDay)} per region per world day` +
                (r.treasuryDecayPerWorldDay ? `, decay ${formatSigned(-Math.abs(r.treasuryDecayPerWorldDay))}/day` : '') + `</div>`;
        }
        out += `<div class="world-row"><span class="world-row-label">Faction rank</span><span class="world-row-value">${roster ? formatStat(roster.rankTotal) : '—'}</span></div>`;

        out += `<div class="world-detail-head">Holdings (${holdings.length})</div>`;
        out += holdings.length
            ? `<ul class="world-list">` + holdings.map(p =>
                `<li><button type="button" class="world-link" data-act="focus" data-arg="${esc(p.id)}">${esc(p.name)}</button>` +
                (p.battleStatus !== 'quiet' ? `<span class="world-muted world-detail-map-${esc(p.battleStatus)}">${p.battleStatus === 'active' ? 'battle' : 'staging'}</span>` : '') +
                `</li>`).join('') + `</ul>`
            : '<div class="world-sub">No regions held yet.</div>';

        out += `<div class="world-detail-head">Members${roster ? ` (${roster.members.length})` : ''}</div>`;
        if (roster) {
            out += `<ul class="world-list">` + roster.members.map(mm =>
                `<li><span>${esc(mm.username)}</span><span class="world-muted">${esc(mm.role)}</span>` +
                `<span class="world-right">${formatStat(mm.rankTotal)}</span></li>`).join('') + `</ul>`;
        } else {
            out += this.worldStatsLoading ? '<div class="world-loading">Loading roster…</div>'
                : `<div class="world-sub">${cat ? `${cat.memberCount} member${cat.memberCount === 1 ? '' : 's'}` : 'Roster unavailable.'}</div>`;
        }

        out += `<div class="world-detail-head">Season standing</div>`;
        if (this.season) {
            out += `<div class="world-row"><span class="world-row-label">Season ${this.season.number}</span>` +
                `<span class="world-row-value" data-remaining-world-ms="${this.season.remainingWorldMs}">${esc(formatWorldDuration(this.season.remainingWorldMs))}</span></div>` +
                `<div class="world-sub">left until rollover · ${holdings.length} region${holdings.length === 1 ? '' : 's'} accruing</div>`;
        }
        const lastArchived = (this.seasons ?? []).find(s => s.state !== 'active');
        if (lastArchived) {
            this.ensureArchive(lastArchived.number);
            const arc = this.archives.get(lastArchived.number);
            const d = arc?.digests.find(x => x.factionId === factionId);
            out += d
                ? `<div class="world-sub">Last season (${lastArchived.number}): ${d.settlementsWon} settlement${d.settlementsWon === 1 ? '' : 's'} won, ` +
                  `income ${formatSigned(d.poiIncomeTotal)}, treasury ${Math.round(d.treasuryAtRollover)} at rollover` +
                  ` · #${(arc!.digests.indexOf(d) + 1)} of ${arc!.digests.length}</div>`
                : (arc === undefined ? '<div class="world-loading">Loading last season…</div>'
                    : `<div class="world-sub">No digest for your faction in season ${lastArchived.number}.</div>`);
        }

        out += `<div class="world-actions"><button type="button" class="world-btn world-btn-danger" data-act="leave"${this.busy ? ' disabled' : ''}>Leave faction</button></div>` +
            this.confirmHtml('leave', `Leave ${esc(m.name)}? Your commanders and standing stay yours; your registered battle side is not changed.`, 'leave-confirm', '', 'Leave') +
            this.messageHtml('faction');
        return out;
    }

    private noFactionHtml(): string {
        const me = this.me;
        const cat = this.catalogue;
        const authority = me?.authority ?? this.stats?.worldAuthority ?? 0;
        let out = '<div class="world-detail-sub">You are not in a faction.</div>';
        // Found.
        out += `<div class="world-detail-head">Found a faction</div>`;
        if (!cat) {
            out += this.catalogueLoading ? '<div class="world-loading">Loading archetypes…</div>'
                : '<div class="world-sub">The faction catalogue is unavailable.</div>';
        } else if (me && !me.canFound) {
            out += `<div class="world-sub">Founding needs ${formatStat(cat.rules.foundFactionAuthority)} world authority — you have ${formatStat(authority)}.` +
                (cat.rules.foundFactionCost ? ` It costs ${formatStat(cat.rules.foundFactionCost)}.` : '') + `</div>`;
        } else {
            const opts = cat.archetypes.map(a => `<option value="${esc(a.key)}">${esc(a.name)}</option>`).join('');
            out += `<div class="world-form">` +
                `<label>Name <input type="text" id="world-found-name" minlength="${cat.rules.nameMinLen}" maxlength="${cat.rules.nameMaxLen}" placeholder="${cat.rules.nameMinLen}–${cat.rules.nameMaxLen} characters"></label>` +
                `<label>Archetype <select id="world-found-archetype">${opts}</select></label>` +
                `<label>Colour <input type="color" id="world-found-colour" value="${esc(cat.archetypes[0]?.colour || '#5b9bd5')}"></label>` +
                `</div>` +
                (cat.archetypes.length ? `<div class="world-sub" id="world-found-desc">${esc(cat.archetypes[0]?.description ?? '')}</div>` : '') +
                `<div class="world-actions"><button type="button" class="world-btn world-btn-primary" id="world-found-btn" data-act="found"${this.busy ? ' disabled' : ''}>` +
                `Found${cat.rules.foundFactionCost ? ` · ${formatStat(cat.rules.foundFactionCost)} authority` : ''}</button></div>` +
                `<div class="world-sub">Needs ${formatStat(cat.rules.foundFactionAuthority)} world authority (you have ${formatStat(authority)}). Your registered battle side becomes the faction's.</div>`;
        }
        out += this.messageHtml('faction', 'found');
        // Join.
        out += `<div class="world-detail-head">Join a faction</div>`;
        if (!cat) {
            out += this.catalogueLoading ? '' : '<div class="world-sub">The roster is unavailable.</div>';
        } else if (!cat.factions.length) {
            out += '<div class="world-sub">No factions in this world yet — found the first.</div>';
        } else {
            out += `<ul class="world-list">` + cat.factions.map(f => {
                const conflict = joinSideConflict(me?.sideKey ?? null, f.sideKey);
                return `<li>${this.swatch(f.colour)}<span>${esc(f.name)}</span>` +
                    `<span class="world-muted">${esc(f.archetype)} · ${f.memberCount} member${f.memberCount === 1 ? '' : 's'}</span>` +
                    (conflict
                        ? `<span class="world-muted" title="Your account is registered to side ${esc(me?.sideKey ?? '')}; this faction fields ${esc(f.sideKey ?? '')}">other side</span>`
                        : `<button type="button" class="world-btn" data-act="join" data-arg="${esc(f.id)}"${this.busy ? ' disabled' : ''}>Join</button>`) +
                    this.confirmHtml(`join:${f.id}`,
                        `Join ${esc(f.name)}?` + (!me?.sideKey && f.sideKey ? ` Your account adopts its battle side (${esc(f.sideKey)}).` : ''),
                        'join-confirm', f.id, 'Join') +
                    `</li>`;
            }).join('') + `</ul>`;
        }
        out += this.messageHtml('faction', 'join');
        return out;
    }

    private async foundFaction(): Promise<void> {
        if (this.busy) return;
        const name = ((this.el('world-found-name') as HTMLInputElement | null)?.value ?? '').trim();
        const archetype = (this.el('world-found-archetype') as HTMLSelectElement | null)?.value ?? '';
        const colour = (this.el('world-found-colour') as HTMLInputElement | null)?.value ?? '';
        const min = this.catalogue?.rules.nameMinLen ?? 3;
        if (name.length < min) {
            this.setError('faction', 'found', `A faction name needs at least ${min} characters.`);
            this.renderDrawer(true);
            return;
        }
        const body: Record<string, unknown> = { name, archetype };
        if (/^#[0-9a-fA-F]{6}$/.test(colour)) body.colour = colour;
        const res = await this.act('found', '/api/world/factions/found', body);
        if (res.ok) this.setNotice('faction', 'found', `${name} is founded.`);
        else this.setError('faction', 'found', factionErrorText(res.error ?? 'failed', res.body ?? undefined));
        await this.afterMembershipChange();
    }

    private async joinFaction(factionId: string): Promise<void> {
        if (this.busy || !factionId) return;
        const res = await this.act(`join:${factionId}`, '/api/world/factions/join', { factionId });
        if (res.ok) this.setNotice('faction', 'join', res.body?.sideKeyAdopted === true
            ? 'Joined — your account adopted the faction\'s battle side.' : 'Joined.');
        else this.setError('faction', 'join', factionErrorText(res.error ?? 'failed', res.body ?? undefined));
        await this.afterMembershipChange();
    }

    private async leaveFaction(): Promise<void> {
        if (this.busy) return;
        const res = await this.act('leave', '/api/world/factions/leave', {});
        if (res.ok) this.setNotice('faction', 'leave', res.body?.left === false ? 'You were not in a faction.' : 'You left the faction.');
        else this.setError('faction', 'leave', factionErrorText(res.error ?? 'failed', res.body ?? undefined));
        await this.afterMembershipChange();
    }

    /// Membership moved: the standing, the catalogue's member counts, the
    /// roster and (a founding seat) the map all changed.
    private async afterMembershipChange(): Promise<void> {
        this.ensureCatalogue(true);
        this.ensureWorldStats(true);
        await Promise.all([this.refreshStats(), this.refresh()]);
        this.renderAll(true);
    }

    // ───────────────────────── the ledger drawer ─────────────────────────

    private ledgerHtml(): string {
        const tabs: [WorldLedgerTab, string][] = [['seasons', 'Seasons'], ['economy', 'Economy'], ['staging', 'Staging'], ['claims', 'Claims']];
        const bar = `<div class="world-tabs" role="tablist">` + tabs.map(([k, label]) =>
            `<button type="button" class="world-tab" role="tab" data-tab="${k}" aria-selected="${this.ledgerTab === k ? 'true' : 'false'}">${label}</button>`).join('') + `</div>`;
        let body = '';
        switch (this.ledgerTab) {
            case 'seasons': body = this.seasonsTabHtml(); break;
            case 'economy': body = this.economyTabHtml(); break;
            case 'staging': body = this.stagingTabHtml(); break;
            case 'claims':  body = this.claimsTabHtml(); break;
        }
        return bar + body;
    }

    private seasonsTabHtml(): string {
        let out = '';
        if (this.season) {
            out += `<div class="world-row"><span class="world-row-label">Season ${this.season.number} (active)</span>` +
                `<span class="world-row-value" data-remaining-world-ms="${this.season.remainingWorldMs}">${esc(formatWorldDuration(this.season.remainingWorldMs))}</span></div>` +
                `<div class="world-sub">left of ${esc(formatWorldDuration(this.season.lengthWorldMs))} · the digest is archived at rollover</div>`;
        }
        if (this.seasonView !== null) {
            const arc = this.archives.get(this.seasonView);
            out += `<div class="world-actions"><button type="button" class="world-btn world-btn-quiet" data-act="season" data-arg="">← All seasons</button></div>` +
                `<div class="world-detail-head">Season ${this.seasonView} digest</div>`;
            if (arc === undefined) out += '<div class="world-loading">Loading digest…</div>';
            else if (arc === null) out += '<div class="world-sub">No such season.</div>';
            else if (!arc.digests.length) out += '<div class="world-sub">Not archived yet — an active season has no digest.</div>';
            else out += `<ul class="world-list">` + arc.digests.map((d, i) =>
                `<li><span class="world-muted">#${i + 1}</span>${this.swatch(this.factionColour(d.factionId))}<span>${esc(formatDigestLine(d, id => this.factionName(id)))}</span></li>`).join('') + `</ul>`;
            return out;
        }
        out += `<div class="world-detail-head">Archive</div>`;
        if (!this.seasons) out += this.seasonsLoading ? '<div class="world-loading">Loading seasons…</div>' : '<div class="world-sub">The season archive is unavailable.</div>';
        else if (!this.seasons.length) out += '<div class="world-sub">No seasons recorded yet.</div>';
        else out += `<ul class="world-list">` + this.seasons.map(s =>
            `<li><button type="button" class="world-link" data-act="season" data-arg="${s.number}">Season ${s.number}</button>` +
            `<span class="world-muted">${esc(s.state)}</span>` +
            `<span class="world-right world-muted">${s.endedWorldMs > s.startedWorldMs ? esc(formatWorldDuration(s.endedWorldMs - s.startedWorldMs)) : 'running'}</span></li>`).join('') + `</ul>`;
        return out;
    }

    private economyTabHtml(): string {
        const ws = this.worldStats;
        if (!ws) return this.worldStatsLoading ? '<div class="world-loading">Loading the economy…</div>' : '<div class="world-sub">The economy ledger is unavailable.</div>';
        if (!ws.economy) return '<div class="world-sub">This lobby serves no economy ledger.</div>';
        const r = ws.economy.rates;
        let out = `<div class="world-sub">${formatSigned(r.poiIncomePerWorldDay)} treasury per region per world day` +
            (r.treasuryDecayPerWorldDay ? `; decay ${formatSigned(-Math.abs(r.treasuryDecayPerWorldDay))} per day` : '') +
            (r.treasuryFloor ? `; floor ${formatStat(r.treasuryFloor)}` : '') + `. Accrues in absentia; a world pause freezes it.</div>`;
        out += `<div class="world-detail-head">Treasuries</div>`;
        out += ws.economy.factions.length
            ? `<ul class="world-list">` + ws.economy.factions.map(f =>
                `<li>${this.swatch(this.factionColour(f.factionId))}<span>${esc(this.factionName(f.factionId))}</span>` +
                `<span class="world-muted">${f.poisHeld} region${f.poisHeld === 1 ? '' : 's'}</span>` +
                `<span class="world-right">${formatStat(f.treasury)}</span></li>`).join('') + `</ul>`
            : '<div class="world-sub">No factions yet.</div>';
        out += `<div class="world-actions"><button type="button" class="world-btn world-btn-quiet" data-act="refresh-stats">Refresh</button></div>`;
        return out;
    }

    private stagingTabHtml(): string {
        const rows: string[] = [];
        for (const p of this.graph.pois) {
            for (const s of p.staging) {
                rows.push(`<li>${this.swatch(this.factionColour(s.attackerFaction))}` +
                    `<span>${esc(this.factionName(s.attackerFaction))} → <button type="button" class="world-link" data-act="focus" data-arg="${esc(p.id)}">${esc(p.name)}</button></span>` +
                    `<span class="world-muted">${s.transports}× transport · ${s.squads} squad${s.squads === 1 ? '' : 's'}</span>` +
                    `<span class="world-right world-staging-eta" data-remaining-world-ms="${s.remainingWorldMs}">${esc(formatWorldDuration(s.remainingWorldMs))}</span></li>`);
            }
        }
        const battles = this.graph.pois.filter(p => p.battleStatus === 'active');
        let out = `<div class="world-detail-head">Open windows (${rows.length})</div>`;
        out += rows.length ? `<ul class="world-list">${rows.join('')}</ul>` : '<div class="world-sub">No force is gathering anywhere.</div>';
        out += `<div class="world-detail-head">Battles in progress (${battles.length})</div>`;
        out += battles.length
            ? `<ul class="world-list">` + battles.map(p =>
                `<li><button type="button" class="world-link" data-act="focus" data-arg="${esc(p.id)}">${esc(p.name)}</button>` +
                `<span class="world-muted">${p.owner ? esc(this.factionName(p.owner)) : 'unclaimed'}</span></li>`).join('') + `</ul>`
            : '<div class="world-sub">None.</div>';
        out += '<div class="world-sub">Resolved windows are not served by this lobby; the world only lists what is still gathering.</div>';
        return out;
    }

    private claimsTabHtml(): string {
        if (!this.claims) return this.claimsLoading ? '<div class="world-loading">Loading claims…</div>' : '<div class="world-sub">Claims are unavailable on this lobby.</div>';
        const rules = this.claims.rules;
        const claims = [...this.claims.claims].sort((a, b) =>
            (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) || b.filedAtWorldMs - a.filedAtWorldMs || b.claimId - a.claimId);
        const nowWorld = this.worldNow();
        let out = `<div class="world-sub">Filing costs ${formatStat(rules.claimPoiCost)} world authority; any outcome but a win refunds ${Math.round(rules.claimRefundFraction * 100)}%` +
            (rules.claimExpiryWorldMs > 0 ? `; a claim expires after ${esc(formatWorldDuration(rules.claimExpiryWorldMs))} world time` : '') + `.</div>`;
        out += `<div class="world-detail-head">Claims (${claims.length})</div>`;
        out += claims.length
            ? `<ul class="world-list">` + claims.map((c: WorldClaim) => {
                const expires = c.state === 'open' && nowWorld !== null ? claimExpiresIn(c, rules, nowWorld) : null;
                return `<li>${this.swatch(this.factionColour(c.faction))}` +
                    `<span>${esc(this.factionName(c.faction))} on <button type="button" class="world-link" data-act="focus" data-arg="${esc(c.poi)}">${esc(this.poiName(c.poi))}</button></span>` +
                    `<span class="world-muted">${esc(claimStateLabel(c.state))}${c.refund ? ` · refunded ${formatStat(c.refund)}` : ''}</span>` +
                    `<span class="world-right world-muted">${expires !== null ? `expires in ${esc(formatWorldDuration(expires))}` : formatStat(c.cost)}</span></li>`;
            }).join('') + `</ul>`
            : '<div class="world-sub">No claims have been filed in this world.</div>';
        out += `<div class="world-actions"><button type="button" class="world-btn world-btn-quiet" data-act="refresh-claims">Refresh</button></div>`;
        return out;
    }

    // ───────────────────────── the alerts drawer ─────────────────────────

    private alertsHtml(): string {
        const now = this.now();
        const n = unreadCount(this.notices);
        let out = `<div class="world-actions">` +
            `<button type="button" class="world-btn" data-act="alerts-read-all"${n ? '' : ' disabled'}>Mark all read</button>` +
            `<button type="button" class="world-btn world-btn-quiet" data-act="alerts-clear-read"${this.notices.length > n ? '' : ' disabled'}>Clear read</button>` +
            `</div>`;
        if (!this.notices.length) return out + '<div class="world-sub">No alerts yet. Staging windows, battles and ownership changes at places you hold or attack land here.</div>';
        out += `<ul class="world-notice-list">` + this.notices.map(x =>
            `<li class="world-notice-row world-notice-${stagingNoticeClass(x.kind)}${x.read ? '' : ' world-notice-unread'}" data-notice-id="${x.id}" title="${x.kind === 'season' ? '' : 'Show on the map'}">` +
            `<span>${esc(x.headline || x.poiName)}</span>` +
            `<span class="world-notice-when">${esc(formatAgo(x.receivedAt, now))}${x.read ? '' : ' · unread'}</span></li>`).join('') + `</ul>`;
        return out;
    }

    private onNoticeClick(id: number): void {
        const n = this.notices.find(x => x.id === id);
        this.notices = markRead(this.notices, id);
        if (n && n.kind !== 'season' && this.graph.pois.some(p => p.id === n.poi)) this.focus(n.poi);
        else this.renderAll(true);
    }

    // ───────────────────────── the canvas ─────────────────────────

    private viewport(): Viewport {
        const c = this.canvas;
        if (!c) return { width: 0, height: 0 };
        return { width: c.clientWidth, height: c.clientHeight };
    }

    private loadBasemap(): void {
        if (this.basemap || typeof Image === 'undefined') return;
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
        this.view = clampView(this.view, this.viewport());
    }

    private paint(): void {
        if (this.frame || typeof requestAnimationFrame === 'undefined') return;
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
        const panel = this.panelEl;
        if (!c || !panel || this.wiredCanvas === c) return;
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.wiredCanvas = c;

        this.el('world-close-btn')?.addEventListener('click', () => this.close());
        this.el('world-reset-btn')?.addEventListener('click', () => {
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
            const hit = hitTestPoi(this.graph.pois, this.view, p.x, p.y);
            this.selectPoi(hit?.id ?? null);
        });

        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => { this.resize(); this.paint(); });
            this.resizeObserver.observe(c);
        }

        // The event half of the map seam: a `poi-selected` event dispatched by
        // anything else (the map lane's canvas, a room card) selects here.
        // Our own dispatches carry `source:'world-screen'` and are ignored.
        if (!this.docListener) {
            this.docListener = (e: Event) => {
                const d = (e as CustomEvent).detail;
                if (!d || d.source === 'world-screen') return;
                const id = typeof d.poiId === 'string' ? d.poiId : (d.poiId === null ? null : undefined);
                if (id !== undefined && id !== (this.selected?.id ?? null)) this.selectPoi(id, true);
            };
            document.addEventListener('poi-selected', this.docListener);
        }
    }

    private showTooltip(poi: WorldPoi, at: { x: number; y: number }): void {
        const el = this.el('world-tooltip');
        if (!el) return;
        const where = formatLatLon(poi.lat, poi.lon);
        const what = poi.battleStatus === 'active' ? 'battle in progress'
            : poi.battleStatus === 'staging' ? 'war staging'
            : poi.mapId ? 'battle map' : 'world only';
        const held = poi.owner ? ` · ${this.factionName(poi.owner)}` : '';
        el.innerHTML = `<strong>${esc(poi.name)}</strong><span>${esc(where)} · ${what}${esc(held)}</span>`;
        el.style.display = '';
        el.style.left = `${at.x + 14}px`;
        el.style.top = `${at.y + 14}px`;
    }

    /// With nothing under the cursor the tooltip shows where the cursor IS.
    /// It costs nothing and it is the only thing in the running UI that
    /// demonstrates the projection inverts.
    private showCoords(at: { x: number; y: number }): void {
        const el = this.el('world-tooltip');
        if (!el) return;
        const { lat, lon } = screenToLatLon(at.x, at.y, this.view);
        el.innerHTML = `<span>${esc(formatLatLon(lat, lon))}</span>`;
        el.style.display = '';
        el.style.left = `${at.x + 14}px`;
        el.style.top = `${at.y + 14}px`;
    }

    private hideTooltip(): void {
        const el = this.el('world-tooltip');
        if (el) el.style.display = 'none';
    }
}
