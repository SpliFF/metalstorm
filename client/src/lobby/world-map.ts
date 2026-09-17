/**
 * world-map.ts — the World screen's geometry and drawing, with no DOM in it.
 *
 * PLAN-worldsim.md W2. The world layer is a map of EARTH with playable regions
 * as POIs and strategic movement along a POI graph
 * (PLAN-metalstorm-worldbuilding.md Capture 10), so the screen is a basemap
 * with a graph painted over it — a 2D canvas, deliberately not a Babylon
 * scene: the lobby has no engine and a strategic map does not need one.
 *
 * ── Why the projection is a constant and not a choice ──────────────────────
 * The basemap is equirectangular and exactly 2:1 (see public/world/SOURCE.md),
 * which makes `lat/lon → map point` two divisions with no trigonometry
 * anywhere. That is the whole reason the plan locked plate carrée for v1: a
 * projection with a real inverse would put a numerical routine between "the
 * server said 48.8°N" and "this pixel", and every hit-test, tooltip and drag
 * in this file would have to agree with it. Here they agree by construction,
 * because they all go through `mapFromLatLon` / `latLonFromMap`.
 *
 * ── The one coordinate system ──────────────────────────────────────────────
 * MAP SPACE is the unit-height plate carrée rectangle: x ∈ [0, MAP_WIDTH],
 * y ∈ [0, MAP_HEIGHT], with MAP_WIDTH exactly 2× MAP_HEIGHT. It is
 * resolution-free on purpose — the view survives a canvas resize and a
 * basemap swap, and a POI's map point never changes when either happens.
 * SCREEN SPACE is canvas pixels. A `MapView` is the only bridge:
 *
 *     screen = offset + map * scale
 *
 * Everything else (zoom at the cursor, drag, clamping, hit-testing) is that
 * one line solved for a different unknown, which is why they cannot drift
 * apart.
 *
 * ── Layers (review sweep 2026-09-10) ───────────────────────────────────────
 * The strategic map is drawn bottom-up: basemap → territory halos → transit
 * edges → markers (glyph by kind, fill by owner/state, rings by war state,
 * pennants for claims, a star for the viewer's commanders) → labels. Each
 * layer is a boolean in `WorldLayers` so the screen can thin the picture
 * (drill-down: summary first) without this module knowing why. The DOM half
 * — pointer/keyboard handling, the hover chip, the legend, animated focus —
 * is `world-map-controller.ts`; nothing here touches the DOM.
 */

import {
    assignFactionColours, withAlpha,
} from './world-map-palette.js';
import {
    glyphKindFor, glyphRadiusScale, traceGlyph, traceClaimFlag, traceCommanderStar,
    type GlyphKind,
} from './world-map-glyphs.js';

/// Map space. Height 1, width 2 — the aspect the basemap must have.
export const MAP_HEIGHT = 1;
export const MAP_WIDTH = 2;

/// How far past "the whole world fits" a player may zoom in. 16× on a
/// 1920px-wide basemap is roughly one basemap pixel per ~8 screen pixels at
/// full zoom, i.e. blurry but still recognisable — past that the image adds
/// nothing and the POI graph is the only thing left worth looking at.
export const MAX_ZOOM_FACTOR = 16;

/// The drawable layers. Every one defaults ON except `graticule` (the grid
/// is the no-basemap fallback, not decoration over a photograph) and
/// `safeColours` (which REPLACES faction-chosen colours with the
/// colour-blind-safe palette — an accessibility switch, not a default).
export interface WorldLayers {
    basemap: boolean;
    graticule: boolean;
    territory: boolean;
    edges: boolean;
    /// Thickness/brightness cue from transit time (short = bold). Off, every
    /// edge is one weight.
    edgeWeights: boolean;
    markers: boolean;
    labels: boolean;
    /// The expanding rings on staging/active POIs. Needs `timeMs` in
    /// `DrawOptions` to animate; without it the static ring still draws.
    pulses: boolean;
    claims: boolean;
    viewer: boolean;
    safeColours: boolean;
}

export const DEFAULT_LAYERS: Readonly<WorldLayers> = Object.freeze({
    basemap: true, graticule: false, territory: true, edges: true, edgeWeights: true,
    markers: true, labels: true, pulses: true, claims: true, viewer: true, safeColours: false,
});

export function resolveLayers(partial?: Partial<WorldLayers> | null): WorldLayers {
    return { ...DEFAULT_LAYERS, ...(partial ?? {}) };
}

/// Who is looking at the map: their world faction (from `/api/world/me`'s
/// `membership.factionId` / `rank.factionId`) and where their commanders
/// stand. Both optional — a spectator sees a map with no "you" on it.
export interface WorldViewer {
    factionId: string | null;
    commanderPoiIds: string[];
}

/// One open conquest claim, as `GET /api/world/claims` carries it
/// (WorldConquest::ClaimJson). Only OPEN claims are ever drawn — a resolved
/// claim is history, and the POI's `owner` already says how it ended.
export interface WorldClaim {
    claimId: number;
    poiId: string;
    factionId: string;
    state: string;
    filedAtWorldMs: number;
}

/// One node of the world graph, as `GET /api/world/pois` carries it
/// (WorldDirector::WorldPoisJson).
export interface WorldPoi {
    id: string;
    name: string;
    lat: number;
    lon: number;
    kind: string;
    /// The battle map this POI stages, or null for a world-only POI. The
    /// server sends null rather than "" precisely so this stays a branch on
    /// "is this place enterable" (W5 turns it into a click-through).
    mapId: string | null;
    /// PLAN-worldsim.md W5: the live-war marker state, from
    /// `AttachBattleStatus` (rts/Server/WorldWarLinkage.h). Always "quiet" for
    /// a POI with no `mapId` — the world layer never invents a battle for a
    /// world-only region.
    battleStatus: 'quiet' | 'staging' | 'active';
    /// The room a click-through joins, or null when `battleStatus` is
    /// "quiet". Read-only: W5 does not write anything back through it.
    warRoomId: number | null;
    /// PLAN-worldsim.md W7: the world faction holding this place, or null for
    /// unowned. An id, not a colour — the colour comes from `WorldGraph.
    /// factions` so that a faction recolouring itself repaints every POI it
    /// holds without the map having to reconcile two copies of the value.
    owner: string | null;
    /// PLAN-worldsim.md W10: the forces gathering against this place, newest
    /// window last. Empty on a quiet POI and on a lobby built before W10 —
    /// which is why `battleStatus` stays the thing the marker branches on: the
    /// server has already upgraded it to "staging" for any POI with an entry
    /// here, so a client that ignores this array still draws the right ring.
    staging: WorldStagingEntry[];
    tags: string[];
    config: Record<string, unknown>;
}

/// One force gathering against a POI, as `GET /api/world/pois` carries it
/// (WorldStaging::StagingJson, PLAN-worldsim.md W10). Only OPEN windows are
/// ever sent — a materialised or cancelled row is history the map does not
/// draw.
export interface WorldStagingEntry {
    stagingId: number;
    /// The world faction that committed the force. An id; the name and colour
    /// come from `WorldGraph.factions`, for the same reason `WorldPoi.owner`
    /// is an id.
    attackerFaction: string;
    originPoiId: string | null;
    transports: number;
    squads: number;
    /// WORLD milliseconds left before the window closes and this becomes a
    /// battle. Served rather than computed from `endsAtWorldMs` locally: the
    /// client ticks its own copy of the world clock between fetches, and two
    /// clocks disagreeing about "3 hours left" is the one confusion a warning
    /// mechanic cannot afford.
    remainingWorldMs: number;
    endsAtWorldMs: number;
}

/// One world faction's map identity, as `GET /api/world/pois` carries it
/// (WorldFactions::AttachFactions). The full sheet — parameters, governance,
/// roster — is `GET /api/world/factions`; this is only what the canvas needs.
export interface WorldFactionBadge {
    name: string;
    colour: string;
    archetype: string;
    state: string;
}

/// One transit edge. `transitWorldMs` is WORLD milliseconds — the world clock
/// runs 24× real time, so this number is never a real duration and must not
/// be formatted as one.
export interface WorldEdge {
    from: string;
    to: string;
    transitWorldMs: number;
    kind: string;
    bidirectional: boolean;
    config: Record<string, unknown>;
}

export interface WorldGraph {
    worldId: string;
    pois: WorldPoi[];
    edges: WorldEdge[];
    /// id → badge, for every faction in this world. Empty on a world with no
    /// factions yet, and on a lobby built before W7 — which is exactly why the
    /// owner colour falls back rather than being required.
    factions: Record<string, WorldFactionBadge>;
}

/// A point in map space.
export interface MapPoint { x: number; y: number }

/// The pan/zoom state. `scale` is screen pixels per map unit; `offsetX/Y` is
/// where map (0,0) lands on the canvas.
export interface MapView { scale: number; offsetX: number; offsetY: number }

/// Canvas size in CSS pixels.
export interface Viewport { width: number; height: number }

// ─────────────────────────── projection ───────────────────────────

/// Plate carrée forward. Longitude wraps (a POI at 190°E is at 170°W, which
/// is a real thing to receive from a seeder doing great-circle arithmetic);
/// latitude clamps, because ±90 is the edge of the map and not a wrap.
export function mapFromLatLon(lat: number, lon: number): MapPoint {
    const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
    const clampedLat = Math.max(-90, Math.min(90, lat));
    return {
        x: ((wrapped + 180) / 360) * MAP_WIDTH,
        y: ((90 - clampedLat) / 180) * MAP_HEIGHT,
    };
}

/// Plate carrée inverse. Exact for every point `mapFromLatLon` can produce.
export function latLonFromMap(p: MapPoint): { lat: number; lon: number } {
    return {
        lat: 90 - (p.y / MAP_HEIGHT) * 180,
        lon: (p.x / MAP_WIDTH) * 360 - 180,
    };
}

export function mapToScreen(p: MapPoint, view: MapView): { x: number; y: number } {
    return { x: view.offsetX + p.x * view.scale, y: view.offsetY + p.y * view.scale };
}

export function screenToMap(x: number, y: number, view: MapView): MapPoint {
    return { x: (x - view.offsetX) / view.scale, y: (y - view.offsetY) / view.scale };
}

/// Where a POI sits on the canvas right now.
export function poiToScreen(poi: { lat: number; lon: number }, view: MapView): { x: number; y: number } {
    return mapToScreen(mapFromLatLon(poi.lat, poi.lon), view);
}

/// What the player is pointing at, in degrees. The tooltip's second line and
/// the only thing that proves the transform is invertible in the live UI.
export function screenToLatLon(x: number, y: number, view: MapView): { lat: number; lon: number } {
    return latLonFromMap(screenToMap(x, y, view));
}

// ─────────────────────────── the view ───────────────────────────

/// The scale at which the whole world is visible — the zoom floor. Whichever
/// axis runs out first wins, so a tall canvas letterboxes rather than cropping
/// Antarctica off the bottom.
export function fitScale(viewport: Viewport): number {
    if (viewport.width <= 0 || viewport.height <= 0) return 1;
    return Math.min(viewport.width / MAP_WIDTH, viewport.height / MAP_HEIGHT);
}

/// The whole world, centred. The screen's initial state and its "reset".
export function fitView(viewport: Viewport): MapView {
    const scale = fitScale(viewport);
    return clampView({ scale, offsetX: 0, offsetY: 0 }, viewport);
}

/**
 * Push a view back inside the rules: scale within [fit, fit × MAX_ZOOM], and
 * no empty space beside the map.
 *
 * The two axes are NOT symmetric with each other in the way they look. When
 * the map is larger than the canvas the offset is clamped so the canvas stays
 * covered; when it is smaller (which happens on the axis that lost the `fit`
 * minimum) the map is CENTRED instead. Clamping a smaller-than-canvas map to
 * "cover" is unsatisfiable, and the naive clamp jams it against one edge — the
 * bug reads as a world map that clings to the left of a wide window.
 */
export function clampView(view: MapView, viewport: Viewport): MapView {
    const min = fitScale(viewport);
    const scale = Math.max(min, Math.min(min * MAX_ZOOM_FACTOR, view.scale));
    const axis = (offset: number, mapPx: number, screenPx: number): number => {
        if (mapPx <= screenPx) return (screenPx - mapPx) / 2;
        return Math.max(screenPx - mapPx, Math.min(0, offset));
    };
    return {
        scale,
        offsetX: axis(view.offsetX, MAP_WIDTH * scale, viewport.width),
        offsetY: axis(view.offsetY, MAP_HEIGHT * scale, viewport.height),
    };
}

/// Drag. Clamped, so a fast flick stops at the edge instead of losing the map.
export function panView(view: MapView, dx: number, dy: number, viewport: Viewport): MapView {
    return clampView({ ...view, offsetX: view.offsetX + dx, offsetY: view.offsetY + dy }, viewport);
}

/**
 * Wheel zoom about a screen anchor: the map point under the cursor stays under
 * the cursor. That is the invariant the test pins, and it is what makes a
 * wheel feel like a zoom rather than a jump — solve `screen = offset + map ×
 * scale` for the new offset with `map` and `screen` both held fixed.
 *
 * The clamp afterwards can still move that point (at the zoom floor the map is
 * centred and no anchor can survive), which is correct: the alternative is
 * honouring the anchor by leaving the map off its own edge.
 */
export function zoomView(
    view: MapView, viewport: Viewport, factor: number, anchorX: number, anchorY: number,
): MapView {
    const min = fitScale(viewport);
    const scale = Math.max(min, Math.min(min * MAX_ZOOM_FACTOR, view.scale * factor));
    const anchor = screenToMap(anchorX, anchorY, view);
    return clampView({
        scale,
        offsetX: anchorX - anchor.x * scale,
        offsetY: anchorY - anchor.y * scale,
    }, viewport);
}

/// The zoom factor for one wheel notch. Exponential in the delta so a trackpad
/// (many small deltas) and a mouse (one large one) travel the same distance
/// per unit of scroll rather than the trackpad being 40× faster.
export function wheelZoomFactor(deltaY: number): number {
    return Math.exp(-deltaY / 400);
}

/// The view that puts map point `p` at the centre of the canvas at `scale`,
/// clamped. `focus()` and keyboard navigation are both this.
export function viewCentredOn(p: MapPoint, scale: number, viewport: Viewport): MapView {
    return clampView({
        scale,
        offsetX: viewport.width / 2 - p.x * scale,
        offsetY: viewport.height / 2 - p.y * scale,
    }, viewport);
}

/// Where a click on a POI travels to: the POI centred, `zoomFactor` × the
/// fit scale (clamped to the zoom rules). Four times fit is "a continent",
/// which is the right amount of context for one place — the marker is big
/// enough to read and its neighbours are still on screen.
export function focusView(
    poi: { lat: number; lon: number }, viewport: Viewport, zoomFactor = 4,
): MapView {
    const scale = fitScale(viewport) * Math.max(1, Math.min(MAX_ZOOM_FACTOR, zoomFactor));
    return viewCentredOn(mapFromLatLon(poi.lat, poi.lon), scale, viewport);
}

/// Smooth-step easing for camera travel. Symmetric, so a reversed flight
/// looks like the same flight played backwards.
export function easeInOut(t: number): number {
    const x = Math.max(0, Math.min(1, t));
    return x * x * (3 - 2 * x);
}

/**
 * The view `t` of the way from `a` to `b`. Scale interpolates geometrically
 * (a zoom is a ratio, and a linear blend of 480 and 7680 spends most of the
 * flight nearly arrived), the CENTRE map point interpolates linearly, and
 * the offset is solved from those two — so at t = 1 this is exactly `b`
 * and at no intermediate frame does the map jump.
 */
export function interpolateView(a: MapView, b: MapView, t: number, viewport: Viewport): MapView {
    const x = Math.max(0, Math.min(1, t));
    if (x <= 0) return a;
    if (x >= 1) return b;
    const scale = a.scale * Math.pow(b.scale / a.scale, x);
    const cx = viewport.width / 2, cy = viewport.height / 2;
    const ca = screenToMap(cx, cy, a), cb = screenToMap(cx, cy, b);
    const c = { x: ca.x + (cb.x - ca.x) * x, y: ca.y + (cb.y - ca.y) * x };
    return clampView({ scale, offsetX: cx - c.x * scale, offsetY: cy - c.y * scale }, viewport);
}

// ─────────────────────────── the graph ───────────────────────────

/// Parse `GET /api/world/pois`, dropping anything unusable rather than
/// throwing. A POI with a non-finite or out-of-range lat/lon would land
/// somewhere arbitrary on the canvas and be indistinguishable from a real
/// place, which is worse than not drawing it; an edge whose endpoints are not
/// both present has nothing to draw between.
/// W10's `staging` array, defensively. A malformed entry is DROPPED rather
/// than defaulted: a commitment drawn with the wrong force count is a lie
/// about how big the incoming attack is, and the panel is better showing one
/// fewer stack than a wrong one.
function parseStagingEntries(raw: unknown): WorldStagingEntry[] {
    if (!Array.isArray(raw)) return [];
    const out: WorldStagingEntry[] = [];
    for (const item of raw as Record<string, unknown>[]) {
        if (!item || typeof item !== 'object') continue;
        if (typeof item.attackerFaction !== 'string' || !item.attackerFaction) continue;
        const id = Number(item.stagingId);
        if (!Number.isFinite(id) || id <= 0) continue;
        const remaining = Number(item.remainingWorldMs);
        out.push({
            stagingId: id,
            attackerFaction: item.attackerFaction,
            originPoiId: typeof item.originPoiId === 'string' && item.originPoiId
                ? item.originPoiId : null,
            transports: Number.isFinite(Number(item.transports)) ? Number(item.transports) : 0,
            squads: Number.isFinite(Number(item.squads)) ? Number(item.squads) : 0,
            // Never negative: an overdue window is materialising, i.e. zero
            // left, and a negative countdown would render as a battle that
            // started in the past and never happened.
            remainingWorldMs: Number.isFinite(remaining) ? Math.max(0, remaining) : 0,
            endsAtWorldMs: Number.isFinite(Number(item.endsAtWorldMs)) ? Number(item.endsAtWorldMs) : 0,
        });
    }
    return out;
}

export function parseWorldGraph(json: unknown): WorldGraph | null {
    if (!json || typeof json !== 'object') return null;
    const raw = json as Record<string, unknown>;
    if (!Array.isArray(raw.pois)) return null;
    const pois: WorldPoi[] = [];
    for (const item of raw.pois as Record<string, unknown>[]) {
        if (!item || typeof item.id !== 'string' || !item.id) continue;
        // `Number()` is not the guard here: `Number(null)` is 0, a perfectly
        // finite point in the Gulf of Guinea, so a null coordinate would be
        // drawn as a real place at 0°N 0°E rather than dropped.
        if (typeof item.lat !== 'number' || typeof item.lon !== 'number') continue;
        const lat = item.lat, lon = item.lon;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
        pois.push({
            id: item.id,
            name: typeof item.name === 'string' && item.name ? item.name : item.id,
            lat, lon,
            kind: typeof item.kind === 'string' ? item.kind : '',
            mapId: typeof item.mapId === 'string' && item.mapId ? item.mapId : null,
            battleStatus: item.battleStatus === 'staging' || item.battleStatus === 'active'
                ? item.battleStatus : 'quiet',
            warRoomId: typeof item.warRoomId === 'number' && Number.isFinite(item.warRoomId)
                ? item.warRoomId : null,
            owner: typeof item.owner === 'string' && item.owner ? item.owner : null,
            staging: parseStagingEntries(item.staging),
            tags: Array.isArray(item.tags) ? item.tags.filter(t => typeof t === 'string') as string[] : [],
            config: (item.config && typeof item.config === 'object')
                ? item.config as Record<string, unknown> : {},
        });
    }
    const known = new Set(pois.map(p => p.id));
    const edges: WorldEdge[] = [];
    // The world seeder emits a bidirectional edge as one row per direction
    // (both rows carry bidirectional:true) — collapse each undirected pair
    // to one edge so a POI's transit list and the map line aren't doubled.
    const seenPairs = new Set<string>();
    for (const item of (Array.isArray(raw.edges) ? raw.edges : []) as Record<string, unknown>[]) {
        if (!item || typeof item.from !== 'string' || typeof item.to !== 'string') continue;
        if (!known.has(item.from) || !known.has(item.to)) continue;
        const bidirectional = item.bidirectional !== false;
        const kind = typeof item.kind === 'string' ? item.kind : '';
        if (bidirectional) {
            const pairKey = [item.from, item.to].sort().join('\0') + '\0' + kind;
            if (seenPairs.has(pairKey)) continue;
            seenPairs.add(pairKey);
        }
        edges.push({
            from: item.from,
            to: item.to,
            transitWorldMs: Number.isFinite(Number(item.transitWorldMs)) ? Number(item.transitWorldMs) : 0,
            kind,
            bidirectional,
            config: (item.config && typeof item.config === 'object')
                ? item.config as Record<string, unknown> : {},
        });
    }
    const factions: Record<string, WorldFactionBadge> = {};
    if (raw.factions && typeof raw.factions === 'object' && !Array.isArray(raw.factions)) {
        for (const [id, value] of Object.entries(raw.factions as Record<string, unknown>)) {
            if (!value || typeof value !== 'object') continue;
            const f = value as Record<string, unknown>;
            // A colour that is not exactly #rrggbb is dropped rather than
            // passed to fillStyle: the server validates it too, and a value
            // that survived both is one the canvas can be handed safely.
            const colour = typeof f.colour === 'string' && /^#[0-9a-fA-F]{6}$/.test(f.colour)
                ? f.colour : '';
            factions[id] = {
                name: typeof f.name === 'string' && f.name ? f.name : id,
                colour,
                archetype: typeof f.archetype === 'string' ? f.archetype : '',
                state: typeof f.state === 'string' ? f.state : 'active',
            };
        }
    }
    return {
        worldId: typeof raw.worldId === 'string' ? raw.worldId : '',
        pois, edges, factions,
    };
}

/// Parse `GET /api/world/claims`, keeping only OPEN claims with a usable id,
/// POI and faction. Same posture as `parseWorldGraph`: a malformed row is
/// dropped, never defaulted — a pennant on the wrong POI is a lie about who
/// is about to take it.
export function parseWorldClaims(json: unknown): WorldClaim[] {
    if (!json || typeof json !== 'object') return [];
    const raw = (json as Record<string, unknown>).claims;
    if (!Array.isArray(raw)) return [];
    const out: WorldClaim[] = [];
    for (const item of raw as Record<string, unknown>[]) {
        if (!item || typeof item !== 'object') continue;
        if (item.state !== 'open') continue;
        const id = Number(item.claimId);
        if (!Number.isFinite(id) || id <= 0) continue;
        if (typeof item.poi !== 'string' || !item.poi) continue;
        if (typeof item.faction !== 'string' || !item.faction) continue;
        out.push({
            claimId: id,
            poiId: item.poi,
            factionId: item.faction,
            state: 'open',
            filedAtWorldMs: typeof item.filedAtWorldMs === 'number' && Number.isFinite(item.filedAtWorldMs)
                ? item.filedAtWorldMs : 0,
        });
    }
    return out;
}

/// Per-graph derived data, computed once per graph object rather than per
/// frame: the id index, the transit-time range for the weight cue, and the
/// two colour maps. Keyed weakly on the graph, so a fresh fetch (a new
/// object) recomputes and the old one is collected with its graph.
interface GraphIndex {
    byId: Map<string, WorldPoi>;
    edgeMinMs: number;
    edgeMaxMs: number;
    colours: Record<string, string>;
    safeColours: Record<string, string>;
}

const INDEX = new WeakMap<WorldGraph, GraphIndex>();

export function graphIndex(graph: WorldGraph): GraphIndex {
    let idx = INDEX.get(graph);
    if (idx) return idx;
    const byId = new Map(graph.pois.map(p => [p.id, p]));
    let edgeMinMs = Infinity, edgeMaxMs = -Infinity;
    for (const e of graph.edges) {
        if (e.transitWorldMs > 0) {
            edgeMinMs = Math.min(edgeMinMs, e.transitWorldMs);
            edgeMaxMs = Math.max(edgeMaxMs, e.transitWorldMs);
        }
    }
    if (!Number.isFinite(edgeMinMs)) { edgeMinMs = 0; edgeMaxMs = 0; }
    idx = {
        byId, edgeMinMs, edgeMaxMs,
        colours: factionColours(graph, false),
        safeColours: factionColours(graph, true),
    };
    INDEX.set(graph, idx);
    return idx;
}

/// Every faction id the map can be asked to colour: the badge list, plus
/// any owner or attacker the badges have never heard of.
function factionIdsIn(graph: WorldGraph): Set<string> {
    const ids = new Set<string>(Object.keys(graph.factions));
    for (const p of graph.pois) {
        if (p.owner) ids.add(p.owner);
        for (const s of p.staging) ids.add(s.attackerFaction);
    }
    return ids;
}

/**
 * id → `#rrggbb` for every faction the graph mentions. With `safe` false a
 * faction's own validated badge colour wins and only the colourless (no
 * badge, or a badge that failed validation) draw from the palette; with
 * `safe` true everybody draws from the palette, so two factions that both
 * chose red are told apart. Palette slots are assigned over the WHOLE set
 * either way, so a palette colour never collides with another palette
 * colour on the same map (it can still resemble a badge colour — the halo,
 * glyph and name carry the rest).
 */
export function factionColours(graph: WorldGraph, safe = false): Record<string, string> {
    const ids = factionIdsIn(graph);
    const assigned = assignFactionColours(ids);
    const out: Record<string, string> = {};
    for (const id of ids) {
        const badge = graph.factions[id]?.colour;
        out[id] = (!safe && badge) ? badge : assigned[id];
    }
    return out;
}

/// The colour for a faction id on this graph, honouring the safe-colours
/// switch. Unknown ids (a claim by a faction the graph does not list) hash
/// into the palette on their own.
export function factionColour(id: string, graph: WorldGraph, safe = false): string {
    const idx = graphIndex(graph);
    const map = safe ? idx.safeColours : idx.colours;
    return map[id] ?? assignFactionColours([id])[id];
}

/**
 * The screen-space segments of one edge, given both endpoints in MAP space.
 * Usually one segment. When the two ends are more than half the world apart
 * the short way round crosses the antimeridian, and a plate carrée has no
 * wrap — so the edge is drawn as two pieces, one leaving each side of the
 * map at the same latitude it re-enters on the other. Without this a route
 * Honolulu→Tokyo is painted the long way round through Africa, which on a
 * strategic map is a wrong fact about transit, not a cosmetic slip.
 */
export function edgeSegments(a: MapPoint, b: MapPoint): [MapPoint, MapPoint][] {
    const dx = b.x - a.x;
    if (Math.abs(dx) <= MAP_WIDTH / 2) return [[a, b]];
    // Order so `left` is the west endpoint; the short path goes left off
    // x=0 from `left` and right off x=MAP_WIDTH from `right`.
    const [left, right] = a.x < b.x ? [a, b] : [b, a];
    const virtualRight = { x: right.x - MAP_WIDTH, y: right.y };   // right, shifted one world west
    const span = left.x - virtualRight.x;                           // > 0, < MAP_WIDTH / 2
    const t = span > 0 ? left.x / span : 0;                         // where the line hits x = 0
    const yc = left.y + (virtualRight.y - left.y) * t;
    return [
        [left, { x: 0, y: yc }],
        [{ x: MAP_WIDTH, y: yc }, right],
    ];
}

/// Line width and alpha for an edge from its transit time, on a log scale
/// between the graph's fastest and slowest link: the fastest route is the
/// boldest. A graph with one edge weight (or none) draws everything at the
/// middle weight rather than at an extreme.
export function edgeWeightCue(
    transitWorldMs: number, minMs: number, maxMs: number,
): { width: number; alpha: number } {
    if (!(transitWorldMs > 0) || !(maxMs > minMs) || !(minMs > 0)) return { width: 1.5, alpha: 0.5 };
    const lo = Math.log(minMs), hi = Math.log(maxMs);
    const u = Math.max(0, Math.min(1, (Math.log(transitWorldMs) - lo) / (hi - lo)));   // 0 fast … 1 slow
    return { width: 2.5 - 1.5 * u, alpha: 0.75 - 0.45 * u };
}

/// Zoom factor (× fit) above which every POI carries its label. Relative to
/// fit rather than an absolute pixels-per-map-unit: on a 4K canvas the fit
/// scale alone passes any absolute threshold and the whole world labels at
/// once, which is the wall of text the threshold exists to prevent.
export const LABEL_ZOOM_FACTOR = 2;

export function labelsVisible(view: MapView, viewport: Viewport): boolean {
    return view.scale >= fitScale(viewport) * LABEL_ZOOM_FACTOR;
}

/// A candidate label box in screen pixels. `priority` is higher for the
/// labels that must survive (selected, hovered, at war).
export interface LabelBox { x: number; y: number; w: number; h: number; priority: number }

/// Greedy placement: highest priority first, and a box that overlaps one
/// already placed is dropped. Returns the indices into `boxes` to draw, in
/// placement order. O(n²) over tens of POIs, which is nothing.
export function placeLabels(boxes: readonly LabelBox[]): number[] {
    const order = boxes.map((_, i) => i).sort((i, j) =>
        boxes[j].priority - boxes[i].priority || i - j);
    const placed: number[] = [];
    for (const i of order) {
        const b = boxes[i];
        let clear = true;
        for (const j of placed) {
            const o = boxes[j];
            if (b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y) {
                clear = false;
                break;
            }
        }
        if (clear) placed.push(i);
    }
    return placed;
}

/// 0 → 1 → 0-again phase of a pulse with period `periodMs`. Pure in
/// `timeMs`, so two markers with the same status beat together and a test
/// can pick the frame.
export function pulsePhase(timeMs: number, periodMs: number): number {
    if (!(periodMs > 0) || !Number.isFinite(timeMs)) return 0;
    const t = ((timeMs % periodMs) + periodMs) % periodMs;
    return t / periodMs;
}

/// The hover chip's contents: name, owner, state, and ONE number — the one
/// that matters for the POI's state. Pure so the chip's text can be tested
/// without a DOM, and so a panel can show the same line the chip does.
export interface PoiSummary {
    id: string;
    name: string;
    kind: GlyphKind;
    kindLabel: string;
    owner: { id: string; name: string; colour: string } | null;
    state: WorldPoi['battleStatus'];
    stateLabel: string;
    stat: { label: string; value: string };
    /// Held by the viewer's faction.
    mine: boolean;
    /// One of the viewer's commanders stands here.
    hasCommander: boolean;
    /// Open claims on this POI.
    claims: number;
}

export function poiSummary(
    poi: WorldPoi, graph: WorldGraph, viewer?: WorldViewer | null,
    claims?: readonly WorldClaim[] | null, safeColours = false,
): PoiSummary {
    const kind = glyphKindFor(poi);
    const owner = poi.owner ? {
        id: poi.owner,
        name: graph.factions[poi.owner]?.name ?? poi.owner,
        colour: factionColour(poi.owner, graph, safeColours),
    } : null;
    let stat: PoiSummary['stat'];
    if (poi.battleStatus === 'active') {
        stat = { label: 'Battle mission', value: poi.warRoomId !== null ? `#${poi.warRoomId}` : '—' };
    } else if (poi.battleStatus === 'staging') {
        // The soonest window, in WORLD time: the number the defender is
        // counting down and the attacker is racing.
        const soonest = poi.staging.reduce((m, s) => Math.min(m, s.remainingWorldMs), Infinity);
        stat = { label: 'Lands in', value: Number.isFinite(soonest) ? formatWorldDuration(soonest) : '—' };
    } else {
        const links = edgesFor(graph.edges, poi.id).length;
        stat = { label: 'Transit links', value: String(links) };
    }
    const claimCount = claims ? claims.reduce((n, c) => n + (c.poiId === poi.id ? 1 : 0), 0) : 0;
    return {
        id: poi.id,
        name: poi.name,
        kind,
        kindLabel: poi.kind || (poi.mapId ? 'battleground' : 'region'),
        owner,
        state: poi.battleStatus,
        stateLabel: poi.battleStatus === 'active' ? 'Battle in progress'
            : poi.battleStatus === 'staging' ? 'Mission staging'
            : poi.mapId ? 'Quiet' : 'World only',
        stat,
        mine: !!viewer?.factionId && poi.owner === viewer.factionId,
        hasCommander: !!viewer && viewer.commanderPoiIds.includes(poi.id),
        claims: claimCount,
    };
}

/// The POI under the cursor, or null. Nearest-within-radius rather than
/// first-within-radius: two POIs closer together than a marker is wide is the
/// normal state of a world map at low zoom, and first-hit picks by array order
/// (i.e. by database rowid), which is not what the player is pointing at.
export function hitTestPoi(
    pois: WorldPoi[], view: MapView, x: number, y: number, radius = 12,
): WorldPoi | null {
    let best: WorldPoi | null = null;
    let bestDist = radius * radius;
    for (const poi of pois) {
        const s = poiToScreen(poi, view);
        const d = (s.x - x) * (s.x - x) + (s.y - y) * (s.y - y);
        if (d <= bestDist) { bestDist = d; best = poi; }
    }
    return best;
}

/// Every edge touching `poiId`, as (edge, the other end). A one-way edge
/// arriving at this POI is still shown — "you can get here from there" is a
/// fact about this place — with the direction left to the caller's label.
export function edgesFor(edges: WorldEdge[], poiId: string): { edge: WorldEdge; other: string }[] {
    const out: { edge: WorldEdge; other: string }[] = [];
    for (const e of edges) {
        if (e.from === poiId) out.push({ edge: e, other: e.to });
        else if (e.to === poiId) out.push({ edge: e, other: e.from });
    }
    return out;
}

/// Format a WORLD duration. Never call this on a real-time value: the world
/// clock runs 24× real time, so a 6-world-hour transit is 15 real minutes and
/// showing either number in the other's units is a lie the player cannot
/// detect.
export function formatWorldDuration(worldMs: number): string {
    if (!Number.isFinite(worldMs) || worldMs < 0) return '—';
    const totalMin = Math.round(worldMs / 60000);
    const d = Math.floor(totalMin / 1440);
    const h = Math.floor((totalMin % 1440) / 60);
    const m = totalMin % 60;
    if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
    if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
    return `${m}m`;
}

/// "48.9°N 2.4°E" — the conventional reading order, and hemispheres as
/// letters because a minus sign in front of a longitude is read as "west" by
/// about half of everybody and as "wrong" by the other half.
export function formatLatLon(lat: number, lon: number): string {
    const ns = lat >= 0 ? 'N' : 'S';
    const ew = lon >= 0 ? 'E' : 'W';
    return `${Math.abs(lat).toFixed(1)}°${ns} ${Math.abs(lon).toFixed(1)}°${ew}`;
}

// ─────────────────────── the world clock (PLAN-worldsim.md W4) ───────────────

/// Mirrors `GET /api/world`'s `clock` object (WorldDirector::WorldStatusJson).
/// `fetchedAtMs` is stamped by the client on receipt — the browser's own
/// clock, used only to measure elapsed wall time since the poll, never
/// compared against `realMs` (a different machine's clock, possibly skewed).
export interface WorldClock {
    worldMs: number;
    paused: boolean;
    ratioNum: number;
    ratioDen: number;
    day: number;
    hour: number;
    minute: number;
    fetchedAtMs: number;
}

/// Parse `clock` out of a `GET /api/world` body. `nowMs` is the caller's
/// wall-clock reading at the moment of the fetch (`Date.now()` in the real
/// client, injected here for tests).
export function parseWorldClock(json: unknown, nowMs: number): WorldClock | null {
    const c = (json as any)?.clock;
    if (!c || typeof c.worldMs !== 'number') return null;
    const ratioNum = typeof c.ratioNum === 'number' && c.ratioNum > 0 ? c.ratioNum : 24;
    const ratioDen = typeof c.ratioDen === 'number' && c.ratioDen > 0 ? c.ratioDen : 1;
    return {
        worldMs: c.worldMs,
        paused: !!c.paused,
        ratioNum, ratioDen,
        day: typeof c.day === 'number' ? c.day : 0,
        hour: typeof c.hour === 'number' ? c.hour : 0,
        minute: typeof c.minute === 'number' ? c.minute : 0,
        fetchedAtMs: nowMs,
    };
}

/// Mirrors `rts/Server/WorldClock.h`'s `WorldCalendarFromMs` — the day/hour
/// this world-ms falls on, ONE calendar the server and client must agree on
/// or a poll and a locally-ticked frame would show different days.
export function worldCalendarFromMs(worldMs: number): { day: number; hour: number; minute: number } {
    const sec = Math.floor(Math.max(0, worldMs) / 1000);
    return {
        day: Math.floor(sec / 86400) + 1,
        hour: Math.floor(sec / 3600) % 24,
        minute: Math.floor(sec / 60) % 60,
    };
}

/// Advance a polled clock reading by elapsed WALL time, at its ratio — the
/// ticking-between-polls the server's `clock` comment calls out
/// (WorldDirector.cpp: "so a client can advance the clock locally between
/// polls"). A paused clock never advances: the ledger, not this function, is
/// the source of truth for "is the world moving", and a client that kept
/// ticking through a pause would silently disagree with every other client.
export function tickWorldClock(clock: WorldClock, nowMs: number): WorldClock {
    if (clock.paused) return clock;
    const elapsedRealMs = nowMs - clock.fetchedAtMs;
    if (elapsedRealMs <= 0) return clock;
    const worldMs = clock.worldMs + elapsedRealMs * (clock.ratioNum / clock.ratioDen);
    return { ...clock, worldMs, ...worldCalendarFromMs(worldMs), fetchedAtMs: nowMs };
}

/// "Day 12, 07:31" — matches `WorldClock.h`'s `FormatWorldCalendar` exactly,
/// so the label never disagrees with the one the server would have printed
/// for the same instant.
export function formatWorldClock(clock: WorldClock): string {
    const hh = String(clock.hour).padStart(2, '0');
    const mm = String(clock.minute).padStart(2, '0');
    return `Day ${clock.day}, ${hh}:${mm}`;
}

// ─────────────────────────── drawing ───────────────────────────

/// Colours in one place so the canvas and the CSS panel can be kept in step by
/// eye — a canvas cannot inherit a stylesheet, which is exactly the seam that
/// makes a map look like it belongs to a different application.
export const WORLD_COLORS = {
    ocean: '#0b1a2b',
    graticule: 'rgba(120, 170, 220, 0.18)',
    graticuleMajor: 'rgba(120, 170, 220, 0.35)',
    edge: 'rgba(120, 200, 255, 0.45)',
    edgeOneWay: 'rgba(255, 190, 120, 0.55)',
    /// The edge hue the weight cue modulates, as [r, g, b].
    edgeRgb: [120, 200, 255] as const,
    edgeOneWayRgb: [255, 190, 120] as const,
    poi: '#8ad2ff',
    poiPlayable: '#ffd479',
    /// PLAN-worldsim.md W5's other two marker states. Staging keeps the
    /// playable amber family (a war is gathering, not yet a fight) but with
    /// a pulsing ring so it reads as "something is happening here" at a
    /// glance; active goes to red, the one colour nothing else on the map
    /// uses, so a live battle is never mistaken for a plain POI colour.
    poiStaging: '#ffd479',
    poiStagingRing: 'rgba(255, 212, 121, 0.85)',
    poiStagingRgb: [255, 212, 121] as const,
    poiActive: '#ff5c5c',
    poiActiveRing: 'rgba(255, 92, 92, 0.85)',
    poiActiveRgb: [255, 92, 92] as const,
    poiOutline: 'rgba(0, 0, 0, 0.55)',
    poiHover: '#ffffff',
    poiSelected: '#ffffff',
    poiLabel: 'rgba(233, 242, 250, 0.92)',
    poiLabelShadow: 'rgba(0, 0, 0, 0.85)',
    /// The viewer's own things: the commander star and the "yours" dot.
    viewer: '#ffffff',
    viewerOutline: 'rgba(0, 0, 0, 0.7)',
    claimOutline: 'rgba(0, 0, 0, 0.7)',
} as const;

/// The subset of CanvasRenderingContext2D this module uses. Stated as an
/// interface so the drawing can be exercised against a recording double in
/// vitest without a real canvas — the screenshot proves it LOOKS right, this
/// proves it is called at all. `measureText` and `createRadialGradient` are
/// optional: without them labels are placed on an estimated width and halos
/// are flat discs, which is what the recording double gets.
export type WorldCtx = Pick<CanvasRenderingContext2D,
    'save' | 'restore' | 'beginPath' | 'moveTo' | 'lineTo' | 'arc' | 'fill' | 'stroke' |
    'fillRect' | 'fillText' | 'drawImage' | 'setLineDash' | 'closePath'> & {
    fillStyle: string | CanvasGradient | CanvasPattern;
    strokeStyle: string | CanvasGradient | CanvasPattern;
    lineWidth: number;
    font: string;
    textAlign: CanvasTextAlign;
    textBaseline: CanvasTextBaseline;
    shadowColor: string;
    shadowBlur: number;
    measureText?(text: string): { width: number };
    createRadialGradient?(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradient;
};

export interface DrawOptions {
    graph: WorldGraph;
    view: MapView;
    viewport: Viewport;
    /// The basemap, or null while it loads / when the game ships none. The
    /// graticule fallback is not a placeholder for a missing feature: it is
    /// what the screen looks like for the first frame of every session.
    basemap: CanvasImageSource | null;
    hoveredId?: string | null;
    selectedId?: string | null;
    layers?: Partial<WorldLayers> | null;
    /// Animation clock for the pulses (any monotonic ms, e.g.
    /// `performance.now()`). Omit for a static frame.
    timeMs?: number;
    viewer?: WorldViewer | null;
    claims?: readonly WorldClaim[] | null;
}

/// Marker radius by state. Selected/hovered grow so the change is felt.
export function markerRadius(selected: boolean, hovered: boolean): number {
    return selected ? 7 : hovered ? 6 : 4.5;
}

/// Territory halo radius in screen px: grows with the square root of the
/// zoom so it reads as "an area" at every zoom without swallowing the
/// continent at fit or the marker at 16×.
export function haloRadius(view: MapView, viewport: Viewport): number {
    const zoom = Math.max(1, view.scale / fitScale(viewport));
    return Math.max(14, Math.min(60, 14 * Math.sqrt(zoom)));
}

/// Pulse periods. Active beats faster than staging: a fight in progress is
/// the more urgent fact.
export const PULSE_PERIOD_MS = { active: 1200, staging: 2000 } as const;

/// Repaint the whole canvas. Cheap enough to do on every pointer move: a world
/// is tens of POIs, not the thousands of units the battle renderer deals with,
/// so there is no dirty-rect machinery here and should not be.
export function drawWorld(ctx: WorldCtx, opts: DrawOptions): void {
    const { view, viewport, graph } = opts;
    const layers = resolveLayers(opts.layers);
    const idx = graphIndex(graph);
    const colours = layers.safeColours ? idx.safeColours : idx.colours;
    ctx.save();
    ctx.fillStyle = WORLD_COLORS.ocean;
    ctx.fillRect(0, 0, viewport.width, viewport.height);

    const w = MAP_WIDTH * view.scale;
    const h = MAP_HEIGHT * view.scale;
    if (opts.basemap && layers.basemap) {
        ctx.drawImage(opts.basemap, view.offsetX, view.offsetY, w, h);
        if (layers.graticule) drawGraticule(ctx, view);
    } else {
        drawGraticule(ctx, view);
    }

    if (layers.territory) drawTerritory(ctx, graph, view, viewport, colours);
    if (layers.edges) drawEdges(ctx, graph, idx, view, layers.edgeWeights);
    if (layers.markers) {
        drawPois(ctx, graph, view, viewport, layers, colours,
            opts.hoveredId ?? null, opts.selectedId ?? null,
            opts.timeMs, opts.viewer ?? null, opts.claims ?? null);
    }
    ctx.restore();
}

/// The no-basemap fallback: a 30° graticule with the equator and the prime
/// meridian picked out. Drawn through the same transform as the POIs, so if
/// the projection is ever wrong the grid is wrong in the same direction and
/// the error is visible instead of cancelling out.
function drawGraticule(ctx: WorldCtx, view: MapView): void {
    for (let lon = -180; lon <= 180; lon += 30) {
        const top = mapToScreen(mapFromLatLon(90, lon === 180 ? 179.999 : lon), view);
        const bot = mapToScreen(mapFromLatLon(-90, lon === 180 ? 179.999 : lon), view);
        ctx.strokeStyle = lon === 0 ? WORLD_COLORS.graticuleMajor : WORLD_COLORS.graticule;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(top.x, top.y);
        ctx.lineTo(bot.x, bot.y);
        ctx.stroke();
    }
    for (let lat = -90; lat <= 90; lat += 30) {
        const left = mapToScreen(mapFromLatLon(lat, -180), view);
        const right = mapToScreen(mapFromLatLon(lat, 179.999), view);
        ctx.strokeStyle = lat === 0 ? WORLD_COLORS.graticuleMajor : WORLD_COLORS.graticule;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(left.x, left.y);
        ctx.lineTo(right.x, right.y);
        ctx.stroke();
    }
}

/// Territory: a soft halo in the owner's colour under every held POI. A
/// gradient when the context can make one, a flat translucent disc when it
/// cannot. Drawn UNDER the edges so a route is never hidden by a holding.
function drawTerritory(
    ctx: WorldCtx, graph: WorldGraph, view: MapView, viewport: Viewport,
    colours: Record<string, string>,
): void {
    const r = haloRadius(view, viewport);
    for (const poi of graph.pois) {
        if (!poi.owner) continue;
        const colour = colours[poi.owner];
        if (!colour) continue;
        const s = poiToScreen(poi, view);
        if (ctx.createRadialGradient) {
            const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
            g.addColorStop(0, withAlpha(colour, 0.32));
            g.addColorStop(0.7, withAlpha(colour, 0.14));
            g.addColorStop(1, withAlpha(colour, 0));
            ctx.fillStyle = g;
        } else {
            ctx.fillStyle = withAlpha(colour, 0.16);
        }
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fill();
    }
}

function drawEdges(
    ctx: WorldCtx, graph: WorldGraph, idx: GraphIndex, view: MapView, weights: boolean,
): void {
    for (const e of graph.edges) {
        const a = idx.byId.get(e.from), b = idx.byId.get(e.to);
        if (!a || !b) continue;
        const rgb = e.bidirectional ? WORLD_COLORS.edgeRgb : WORLD_COLORS.edgeOneWayRgb;
        if (weights) {
            const cue = edgeWeightCue(e.transitWorldMs, idx.edgeMinMs, idx.edgeMaxMs);
            ctx.strokeStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${cue.alpha.toFixed(3)})`;
            ctx.lineWidth = cue.width;
        } else {
            ctx.strokeStyle = e.bidirectional ? WORLD_COLORS.edge : WORLD_COLORS.edgeOneWay;
            ctx.lineWidth = 1.5;
        }
        // A one-way edge is dashed rather than arrow-headed: at world zoom an
        // arrowhead is three pixels and reads as noise on the line.
        ctx.setLineDash(e.bidirectional ? [] : [6, 4]);
        ctx.beginPath();
        for (const [p, q] of edgeSegments(mapFromLatLon(a.lat, a.lon), mapFromLatLon(b.lat, b.lon))) {
            const pa = mapToScreen(p, view), pb = mapToScreen(q, view);
            ctx.moveTo(pa.x, pa.y);
            ctx.lineTo(pb.x, pb.y);
        }
        ctx.stroke();
    }
    ctx.setLineDash([]);
}

/// The colour a POI should be painted in on behalf of its owner, or null when
/// it is unowned. An owner id the `factions` map has never heard of (a faction
/// dissolved between the two halves of one response, or a lobby that predates
/// W7) still counts as OWNED — it gets a palette colour derived from its id
/// rather than rendering as unclaimed, because "somebody holds this" is the
/// fact the player is reading and the id is proof of it.
export function poiOwnerColour(poi: WorldPoi, graph: WorldGraph, safeColours = false): string | null {
    if (!poi.owner) return null;
    return factionColour(poi.owner, graph, safeColours);
}

/// Label priority: what survives when labels collide.
function labelPriority(poi: WorldPoi, selected: boolean, hovered: boolean): number {
    if (selected) return 100;
    if (hovered) return 90;
    if (poi.battleStatus === 'active') return 80;
    if (poi.battleStatus === 'staging') return 70;
    if (poi.owner) return 40;
    if (poi.mapId) return 30;
    return 10;
}

const LABEL_FONT_PX = 12;
const LABEL_FONT = `${LABEL_FONT_PX}px system-ui, sans-serif`;

function labelWidth(ctx: WorldCtx, text: string): number {
    if (ctx.measureText) return ctx.measureText(text).width;
    return text.length * LABEL_FONT_PX * 0.56;
}

function drawPois(
    ctx: WorldCtx, graph: WorldGraph, view: MapView, viewport: Viewport,
    layers: WorldLayers, colours: Record<string, string>,
    hoveredId: string | null, selectedId: string | null,
    timeMs: number | undefined, viewer: WorldViewer | null,
    claims: readonly WorldClaim[] | null,
): void {
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const allLabels = labelsVisible(view, viewport);
    const boxes: LabelBox[] = [];
    const labelPois: WorldPoi[] = [];
    const labelX: number[] = [];
    const labelY: number[] = [];
    const commanderAt = layers.viewer && viewer ? new Set(viewer.commanderPoiIds) : null;
    const mine = layers.viewer && viewer?.factionId ? viewer.factionId : null;

    for (const poi of graph.pois) {
        const s = poiToScreen(poi, view);
        const selected = poi.id === selectedId;
        const hovered = poi.id === hoveredId;
        const kind = glyphKindFor(poi);
        const r = markerRadius(selected, hovered) * glyphRadiusScale(kind);
        const ownerColour = poi.owner ? colours[poi.owner] ?? null : null;
        // A POI that stages a battle map is a place you can be sent to; one
        // that does not is scenery with a name. Two colours, because that
        // distinction is the first question a player asks of a marker — with
        // the owning faction's colour taking precedence over both (W7), since
        // "whose is this" outranks "can I fight here" the moment anyone holds
        // it. A live battle still wins over the owner: a fight in progress is
        // the more urgent fact, and it is the ring that carries the owner's
        // colour in that case (below).
        ctx.fillStyle = poi.battleStatus === 'active' ? WORLD_COLORS.poiActive
            : ownerColour ?? (poi.mapId ? WORLD_COLORS.poiPlayable : WORLD_COLORS.poi);
        traceGlyph(ctx, kind, s.x, s.y, r);
        ctx.fill();
        // A dark outline so a light marker survives a light basemap (ice,
        // desert) — and the hover outline replaces it in white.
        ctx.strokeStyle = hovered ? WORLD_COLORS.poiHover : WORLD_COLORS.poiOutline;
        ctx.lineWidth = hovered ? 1.5 : 1;
        ctx.stroke();

        // "Yours": a small inner dot on a POI the viewer's faction holds.
        if (mine && poi.owner === mine && poi.battleStatus !== 'active') {
            ctx.fillStyle = WORLD_COLORS.viewer;
            ctx.beginPath();
            ctx.arc(s.x, s.y, Math.max(1.2, r * 0.32), 0, Math.PI * 2);
            ctx.fill();
        }

        // A live or gathering war gets its own ring, independent of
        // hover/select — the battle marker must read at a glance without the
        // player's cursor anywhere near it.
        if (poi.battleStatus !== 'quiet') {
            const active = poi.battleStatus === 'active';
            ctx.strokeStyle = active ? WORLD_COLORS.poiActiveRing : WORLD_COLORS.poiStagingRing;
            ctx.lineWidth = 1.5;
            ctx.setLineDash(active ? [] : [4, 3]);
            ctx.beginPath();
            ctx.arc(s.x, s.y, r + 4, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
            // The pulse: an expanding, fading ring. Only with a clock — a
            // static frame (tests, a paused tab) draws the ring above alone.
            if (layers.pulses && timeMs !== undefined) {
                const phase = pulsePhase(timeMs, active ? PULSE_PERIOD_MS.active : PULSE_PERIOD_MS.staging);
                const rgb = active ? WORLD_COLORS.poiActiveRgb : WORLD_COLORS.poiStagingRgb;
                ctx.strokeStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${((1 - phase) * 0.8).toFixed(3)})`;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(s.x, s.y, r + 6 + phase * 12, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
        // An owned POI that is currently a battlefield keeps its red fill and
        // gets its owner's colour as an outer band, so the map never has to
        // choose between "who holds it" and "is it on fire".
        if (ownerColour && poi.battleStatus === 'active') {
            ctx.strokeStyle = ownerColour;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(s.x, s.y, r + 7, 0, Math.PI * 2);
            ctx.stroke();
        }
        if (selected) {
            ctx.strokeStyle = WORLD_COLORS.poiSelected;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(s.x, s.y, r + 2.5, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Open claims: one pennant per POI (the count is the chip's job),
        // in the EARLIEST claimant's colour — the one the tie-break favours.
        if (layers.claims && claims && claims.length) {
            let first: WorldClaim | null = null;
            for (const c of claims) {
                if (c.poiId !== poi.id) continue;
                if (!first || c.filedAtWorldMs < first.filedAtWorldMs ||
                    (c.filedAtWorldMs === first.filedAtWorldMs && c.claimId < first.claimId)) first = c;
            }
            if (first) {
                ctx.fillStyle = colours[first.factionId] ?? factionColour(first.factionId, graph, layers.safeColours);
                ctx.strokeStyle = WORLD_COLORS.claimOutline;
                ctx.lineWidth = 1;
                traceClaimFlag(ctx, s.x, s.y, Math.max(4, r));
                ctx.fill();
                ctx.stroke();
            }
        }

        // The viewer's commander(s): a star. Drawn last so nothing covers it.
        if (commanderAt && commanderAt.has(poi.id)) {
            ctx.fillStyle = WORLD_COLORS.viewer;
            ctx.strokeStyle = WORLD_COLORS.viewerOutline;
            ctx.lineWidth = 1;
            traceCommanderStar(ctx, s.x, s.y, Math.max(4, r));
            ctx.fill();
            ctx.stroke();
        }

        // Labels only once there is room for them. Every POI labelled at world
        // zoom is a wall of overlapping text; the hovered/selected one is
        // always labelled because that is the one being asked about.
        if (layers.labels && (allLabels || selected || hovered)) {
            const w = labelWidth(ctx, poi.name);
            boxes.push({
                x: s.x + r + 5, y: s.y - LABEL_FONT_PX / 2 - 1, w, h: LABEL_FONT_PX + 2,
                priority: labelPriority(poi, selected, hovered),
            });
            labelPois.push(poi);
            labelX.push(s.x + r + 5);
            labelY.push(s.y);
        }
    }

    if (boxes.length) {
        ctx.shadowColor = WORLD_COLORS.poiLabelShadow;
        ctx.shadowBlur = 4;
        ctx.fillStyle = WORLD_COLORS.poiLabel;
        for (const i of placeLabels(boxes)) ctx.fillText(labelPois[i].name, labelX[i], labelY[i]);
        ctx.shadowBlur = 0;
        ctx.shadowColor = 'transparent';
    }
}

/// @deprecated Absolute px-per-map-unit threshold, replaced by
/// `labelsVisible` (relative to the fit scale). Kept exported for callers.
export const fitScaleLabelThreshold = 1400;

// ─────────────── the player stat panel (PLAN-worldsim.md W8) ───────────────
//
// Authority is per COMMANDER, Capacity is per PLAYER and Rank is derived on
// read from holdings — the locked design of
// PLAN-metalstorm-worldbuilding.md Captures 23/24/27. The shapes below mirror
// `WorldStats::AttachMeStats`'s body exactly, and the parse drops anything
// unusable rather than throwing, for the same reason `parseWorldGraph` does: a
// lobby built before W8 answers `/api/world/me` without any of these keys, and
// that must render as "no stats yet" rather than as a broken panel.

/// One commander a player holds, as the panel shows it. A world ROW, not a
/// unit — the battle-side commander is a different thing entirely.
export interface WorldCommander {
    id: string;
    name: string;
    factionId: string;
    poiId: string;
    state: string;
    /// Decayed to now by the server. The number everything reads.
    authority: number;
    /// What the row stores, before decay — shown beside the live value so a
    /// player can SEE the decay rather than suspect the display.
    authorityStored: number;
    loaned: boolean;
}

/// The order budget (Capture 12's per-real-24h ceiling).
export interface WorldCapacity {
    max: number;
    spent: number;
    available: number;
    /// Real ms until the next recharge — real, not world: the ceiling protects
    /// the player's day, so a world pause does not move it.
    nextRechargeInMs: number;
    rechargeHours: number;
}

/// Rank: derived, per player per faction, and reported with its terms so the
/// number can be audited by the player it weights the votes of.
export interface WorldRank {
    factionId: string | null;
    total: number;
    commanderCount: number;
    poiCount: number;
    loanedCount: number;
    terms: Record<string, number>;
}

export interface WorldPlayerStats {
    /// W7's world authority — the founding gate's number, and NOT a
    /// commander's Authority. Two different stats with one name in the design;
    /// the panel labels them apart.
    worldAuthority: number;
    commanders: WorldCommander[];
    capacity: WorldCapacity | null;
    rank: WorldRank | null;
}

/// Parse the W8 half of `POST /api/world/me`. Null when the body carries none
/// of it (a pre-W8 lobby), which the panel renders as absent rather than empty.
export function parseWorldPlayerStats(json: unknown): WorldPlayerStats | null {
    if (!json || typeof json !== 'object') return null;
    const raw = json as Record<string, unknown>;
    const hasStats = Array.isArray(raw.commanders) || !!raw.capacity || !!raw.rank;
    if (!hasStats) return null;
    const commanders: WorldCommander[] = [];
    for (const item of (Array.isArray(raw.commanders) ? raw.commanders : []) as Record<string, unknown>[]) {
        if (!item || typeof item.commanderId !== 'string' || !item.commanderId) continue;
        commanders.push({
            id: item.commanderId,
            name: typeof item.name === 'string' && item.name ? item.name : item.commanderId,
            factionId: typeof item.factionId === 'string' ? item.factionId : '',
            poiId: typeof item.poiId === 'string' ? item.poiId : '',
            state: typeof item.state === 'string' ? item.state : 'active',
            authority: num(item.authority),
            authorityStored: num(item.authorityStored),
            loaned: item.loaned === true,
        });
    }
    let capacity: WorldCapacity | null = null;
    if (raw.capacity && typeof raw.capacity === 'object') {
        const c = raw.capacity as Record<string, unknown>;
        capacity = {
            max: num(c.max),
            spent: num(c.spent),
            available: num(c.available),
            nextRechargeInMs: num(c.nextRechargeInMs),
            rechargeHours: num(c.rechargeHours, 24),
        };
    }
    let rank: WorldRank | null = null;
    if (raw.rank && typeof raw.rank === 'object') {
        const r = raw.rank as Record<string, unknown>;
        const terms: Record<string, number> = {};
        if (r.terms && typeof r.terms === 'object') {
            for (const [k, v] of Object.entries(r.terms as Record<string, unknown>))
                if (typeof v === 'number' && Number.isFinite(v)) terms[k] = v;
        }
        rank = {
            factionId: typeof r.factionId === 'string' && r.factionId ? r.factionId : null,
            total: num(r.total),
            commanderCount: num(r.commanderCount),
            poiCount: num(r.poiCount),
            loanedCount: num(r.loanedCount),
            terms,
        };
    }
    return { worldAuthority: num(raw.authority), commanders, capacity, rank };
}

/// A number, or `fallback` — `Number(null)` is 0 and `Number(undefined)` is
/// NaN, and neither is a stat worth displaying.
function num(v: unknown, fallback = 0): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/// A REAL duration, for the capacity countdown. Deliberately not
/// `formatWorldDuration`: that one reads a world-clock interval, which runs 24×
/// faster, and formatting a real 4-hour wait with it would tell the player to
/// come back in "4 days".
export function formatRealDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return 'now';
    const totalMin = Math.ceil(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
    return `${m}m`;
}

/// Stats are display numbers, not currency: one decimal on anything small
/// enough for it to matter and none above 100, so an Authority of 12.4 reads
/// as 12.4 and a rank of 1284.3 reads as 1284.
export function formatStat(value: number): string {
    if (!Number.isFinite(value)) return '—';
    if (Math.abs(value) >= 100) return Math.round(value).toString();
    return (Math.round(value * 10) / 10).toString();
}
