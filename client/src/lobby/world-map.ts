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
 */

/// Map space. Height 1, width 2 — the aspect the basemap must have.
export const MAP_HEIGHT = 1;
export const MAP_WIDTH = 2;

/// How far past "the whole world fits" a player may zoom in. 16× on a
/// 1920px-wide basemap is roughly one basemap pixel per ~8 screen pixels at
/// full zoom, i.e. blurry but still recognisable — past that the image adds
/// nothing and the POI graph is the only thing left worth looking at.
export const MAX_ZOOM_FACTOR = 16;

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
    tags: string[];
    config: Record<string, unknown>;
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

// ─────────────────────────── the graph ───────────────────────────

/// Parse `GET /api/world/pois`, dropping anything unusable rather than
/// throwing. A POI with a non-finite or out-of-range lat/lon would land
/// somewhere arbitrary on the canvas and be indistinguishable from a real
/// place, which is worse than not drawing it; an edge whose endpoints are not
/// both present has nothing to draw between.
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
            tags: Array.isArray(item.tags) ? item.tags.filter(t => typeof t === 'string') as string[] : [],
            config: (item.config && typeof item.config === 'object')
                ? item.config as Record<string, unknown> : {},
        });
    }
    const known = new Set(pois.map(p => p.id));
    const edges: WorldEdge[] = [];
    for (const item of (Array.isArray(raw.edges) ? raw.edges : []) as Record<string, unknown>[]) {
        if (!item || typeof item.from !== 'string' || typeof item.to !== 'string') continue;
        if (!known.has(item.from) || !known.has(item.to)) continue;
        edges.push({
            from: item.from,
            to: item.to,
            transitWorldMs: Number.isFinite(Number(item.transitWorldMs)) ? Number(item.transitWorldMs) : 0,
            kind: typeof item.kind === 'string' ? item.kind : '',
            bidirectional: item.bidirectional !== false,
            config: (item.config && typeof item.config === 'object')
                ? item.config as Record<string, unknown> : {},
        });
    }
    return { worldId: typeof raw.worldId === 'string' ? raw.worldId : '', pois, edges };
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
    poi: '#8ad2ff',
    poiPlayable: '#ffd479',
    poiHover: '#ffffff',
    poiSelected: '#ffffff',
    poiLabel: 'rgba(233, 242, 250, 0.92)',
    poiLabelShadow: 'rgba(0, 0, 0, 0.85)',
} as const;

/// The subset of CanvasRenderingContext2D this module uses. Stated as an
/// interface so the drawing can be exercised against a recording double in
/// vitest without a real canvas — the screenshot proves it LOOKS right, this
/// proves it is called at all.
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
}

/// Repaint the whole canvas. Cheap enough to do on every pointer move: a world
/// is tens of POIs, not the thousands of units the battle renderer deals with,
/// so there is no dirty-rect machinery here and should not be.
export function drawWorld(ctx: WorldCtx, opts: DrawOptions): void {
    const { view, viewport, graph } = opts;
    ctx.save();
    ctx.fillStyle = WORLD_COLORS.ocean;
    ctx.fillRect(0, 0, viewport.width, viewport.height);

    const w = MAP_WIDTH * view.scale;
    const h = MAP_HEIGHT * view.scale;
    if (opts.basemap) {
        ctx.drawImage(opts.basemap, view.offsetX, view.offsetY, w, h);
    } else {
        drawGraticule(ctx, view);
    }

    drawEdges(ctx, graph, view);
    drawPois(ctx, graph, view, opts.hoveredId ?? null, opts.selectedId ?? null);
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

function drawEdges(ctx: WorldCtx, graph: WorldGraph, view: MapView): void {
    const byId = new Map(graph.pois.map(p => [p.id, p]));
    for (const e of graph.edges) {
        const a = byId.get(e.from), b = byId.get(e.to);
        if (!a || !b) continue;
        const pa = poiToScreen(a, view), pb = poiToScreen(b, view);
        ctx.strokeStyle = e.bidirectional ? WORLD_COLORS.edge : WORLD_COLORS.edgeOneWay;
        ctx.lineWidth = 1.5;
        // A one-way edge is dashed rather than arrow-headed: at world zoom an
        // arrowhead is three pixels and reads as noise on the line.
        ctx.setLineDash(e.bidirectional ? [] : [6, 4]);
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
    }
    ctx.setLineDash([]);
}

function drawPois(
    ctx: WorldCtx, graph: WorldGraph, view: MapView,
    hoveredId: string | null, selectedId: string | null,
): void {
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const poi of graph.pois) {
        const s = poiToScreen(poi, view);
        const selected = poi.id === selectedId;
        const hovered = poi.id === hoveredId;
        const r = selected ? 7 : hovered ? 6 : 4.5;
        // A POI that stages a battle map is a place you can be sent to; one
        // that does not is scenery with a name. Two colours, because that
        // distinction is the first question a player asks of a marker.
        ctx.fillStyle = poi.mapId ? WORLD_COLORS.poiPlayable : WORLD_COLORS.poi;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (selected || hovered) {
            ctx.strokeStyle = selected ? WORLD_COLORS.poiSelected : WORLD_COLORS.poiHover;
            ctx.lineWidth = selected ? 2 : 1.5;
            ctx.beginPath();
            ctx.arc(s.x, s.y, r + 3, 0, Math.PI * 2);
            ctx.stroke();
        }
        // Labels only once there is room for them. Every POI labelled at world
        // zoom is a wall of overlapping text; the hovered/selected one is
        // always labelled because that is the one being asked about.
        if (view.scale > fitScaleLabelThreshold || selected || hovered) {
            ctx.shadowColor = WORLD_COLORS.poiLabelShadow;
            ctx.shadowBlur = 4;
            ctx.fillStyle = WORLD_COLORS.poiLabel;
            ctx.fillText(poi.name, s.x + r + 5, s.y);
            ctx.shadowBlur = 0;
            ctx.shadowColor = 'transparent';
        }
    }
}

/// Above this scale (pixels per map unit) every POI carries its label. Chosen
/// against the basemap's own width: 1400px per map unit ≈ a 2800px-wide world,
/// i.e. the player has zoomed past "whole Earth" on any ordinary window.
export const fitScaleLabelThreshold = 1400;
