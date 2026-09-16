/**
 * world-map.test.ts — PLAN-worldsim.md W2.
 *
 * The screenshot check proves the World screen LOOKS like a world map. It
 * cannot prove that Paris is where Paris is: a POI drawn 200px from its true
 * position still renders as a convincing dot on a convincing Earth. So the
 * projection, the view algebra and the hit-test are pinned here, numerically,
 * against hand-computed positions rather than against the code's own output.
 */

import { describe, it, expect } from 'vitest';
import {
    MAP_WIDTH, MAP_HEIGHT, MAX_ZOOM_FACTOR,
    mapFromLatLon, latLonFromMap, mapToScreen, screenToMap, poiToScreen, screenToLatLon,
    fitScale, fitView, clampView, panView, zoomView, wheelZoomFactor,
    parseWorldGraph, hitTestPoi, edgesFor, formatWorldDuration, formatLatLon,
    parseWorldClock, tickWorldClock, formatWorldClock, worldCalendarFromMs,
    drawWorld, WORLD_COLORS, poiOwnerColour,
    parseWorldPlayerStats, formatRealDuration, formatStat,
    viewCentredOn, focusView, interpolateView, easeInOut,
    parseWorldClaims, graphIndex, factionColours, factionColour, edgeSegments, edgeWeightCue,
    labelsVisible, placeLabels, pulsePhase, poiSummary, resolveLayers, DEFAULT_LAYERS,
    haloRadius, markerRadius, LABEL_ZOOM_FACTOR, PULSE_PERIOD_MS,
    type MapView, type Viewport, type WorldPoi, type WorldCtx, type WorldGraph,
} from './world-map';
import { assignFactionColours, SAFE_PALETTE } from './world-map-palette';

const VIEWPORT: Viewport = { width: 960, height: 480 };   // exactly 2:1
const TALL: Viewport = { width: 800, height: 600 };       // letterboxes

describe('plate carrée projection', () => {
    it('puts the four corners and the origin where the map says', () => {
        expect(mapFromLatLon(90, -180)).toEqual({ x: 0, y: 0 });
        expect(mapFromLatLon(-90, -180)).toEqual({ x: 0, y: MAP_HEIGHT });
        expect(mapFromLatLon(90, 180)).toEqual({ x: 0, y: 0 });   // 180E wraps to 180W
        expect(mapFromLatLon(0, 0)).toEqual({ x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 });
    });

    it('places a known city where an atlas does', () => {
        // Paris, 48.86N 2.35E: just right of the vertical centre line, and
        // (90-48.86)/180 ≈ 0.2286 of the way down. Hand-computed, so a sign
        // flip in the source cannot make this test agree with it.
        const p = mapFromLatLon(48.86, 2.35);
        expect(p.x).toBeCloseTo((182.35 / 360) * MAP_WIDTH, 10);
        expect(p.y).toBeCloseTo((41.14 / 180) * MAP_HEIGHT, 10);
        expect(p.x).toBeGreaterThan(MAP_WIDTH / 2);   // east of Greenwich
        expect(p.y).toBeLessThan(MAP_HEIGHT / 2);     // north of the equator
    });

    it('wraps longitude and clamps latitude', () => {
        expect(mapFromLatLon(0, 190).x).toBeCloseTo(mapFromLatLon(0, -170).x, 10);
        expect(mapFromLatLon(0, -540).x).toBeCloseTo(mapFromLatLon(0, 180).x, 10);
        expect(mapFromLatLon(120, 0).y).toBe(mapFromLatLon(90, 0).y);
        expect(mapFromLatLon(-120, 0).y).toBe(mapFromLatLon(-90, 0).y);
    });

    it('inverts exactly', () => {
        for (const [lat, lon] of [[0, 0], [48.86, 2.35], [-33.87, 151.21], [71.0, -8.0]]) {
            const back = latLonFromMap(mapFromLatLon(lat, lon));
            expect(back.lat).toBeCloseTo(lat, 10);
            expect(back.lon).toBeCloseTo(lon, 10);
        }
    });
});

describe('lat/lon → screen', () => {
    it('spans the canvas at fit zoom', () => {
        const view = fitView(VIEWPORT);
        expect(poiToScreen({ lat: 90, lon: -180 }, view)).toEqual({ x: 0, y: 0 });
        const br = poiToScreen({ lat: -90, lon: 179.999999 }, view);
        expect(br.x).toBeCloseTo(VIEWPORT.width, 2);
        expect(br.y).toBeCloseTo(VIEWPORT.height, 2);
        const mid = poiToScreen({ lat: 0, lon: 0 }, view);
        expect(mid).toEqual({ x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 });
    });

    it('round-trips through the screen at any view', () => {
        const view: MapView = { scale: 3000, offsetX: -1200, offsetY: -700 };
        const back = screenToLatLon(...Object.values(poiToScreen({ lat: -33.87, lon: 151.21 }, view)) as [number, number], view);
        expect(back.lat).toBeCloseTo(-33.87, 8);
        expect(back.lon).toBeCloseTo(151.21, 8);
    });

    it('agrees with the raw map transform', () => {
        const view: MapView = { scale: 500, offsetX: 17, offsetY: -3 };
        const p = mapFromLatLon(10, 20);
        expect(mapToScreen(p, view)).toEqual(poiToScreen({ lat: 10, lon: 20 }, view));
        const m = screenToMap(123, 45, view);
        expect(mapToScreen(m, view).x).toBeCloseTo(123, 10);
        expect(mapToScreen(m, view).y).toBeCloseTo(45, 10);
    });
});

describe('the view is clamped', () => {
    it('fits the whole world at minimum zoom', () => {
        expect(fitScale(VIEWPORT)).toBe(480);              // height-bound == width-bound
        expect(fitScale(TALL)).toBe(400);                  // width-bound (800/2)
        expect(fitScale({ width: 0, height: 0 })).toBe(1);  // never divides by zero
    });

    it('centres the map on the axis with spare room instead of jamming it left', () => {
        // The letterbox case: 800×600 fits a 800×400 world, leaving 200px of
        // vertical slack. Clamping "to cover" there is unsatisfiable, and the
        // naive clamp pins the map to the top edge.
        const v = fitView(TALL);
        expect(v.offsetX).toBe(0);
        expect(v.offsetY).toBe(100);
    });

    it('never shows empty space beside a zoomed-in map', () => {
        const zoomed = clampView({ scale: 2000, offsetX: 5000, offsetY: 5000 }, VIEWPORT);
        expect(zoomed.offsetX).toBe(0);
        expect(zoomed.offsetY).toBe(0);
        const far = clampView({ scale: 2000, offsetX: -99999, offsetY: -99999 }, VIEWPORT);
        expect(far.offsetX).toBe(VIEWPORT.width - MAP_WIDTH * 2000);
        expect(far.offsetY).toBe(VIEWPORT.height - MAP_HEIGHT * 2000);
    });

    it('holds the zoom floor and ceiling', () => {
        expect(clampView({ scale: 1, offsetX: 0, offsetY: 0 }, VIEWPORT).scale).toBe(fitScale(VIEWPORT));
        expect(clampView({ scale: 1e9, offsetX: 0, offsetY: 0 }, VIEWPORT).scale)
            .toBe(fitScale(VIEWPORT) * MAX_ZOOM_FACTOR);
    });

    it('keeps a drag inside the world', () => {
        const start = zoomView(fitView(VIEWPORT), VIEWPORT, 4, 480, 240);
        const flick = panView(start, 100000, 100000, VIEWPORT);
        expect(flick.offsetX).toBe(0);
        expect(flick.offsetY).toBe(0);
        // ...and an ordinary drag actually moves.
        const nudge = panView(start, 30, -20, VIEWPORT);
        expect(nudge.offsetX).toBe(start.offsetX + 30);
        expect(nudge.offsetY).toBe(start.offsetY - 20);
    });
});

describe('wheel zoom holds the point under the cursor', () => {
    it('keeps the anchored lat/lon under the cursor', () => {
        const view = zoomView(fitView(VIEWPORT), VIEWPORT, 4, 480, 240);  // room to move
        const anchorX = 300, anchorY = 180;
        const before = screenToLatLon(anchorX, anchorY, view);
        const after = zoomView(view, VIEWPORT, 1.5, anchorX, anchorY);
        const now = screenToLatLon(anchorX, anchorY, after);
        expect(now.lat).toBeCloseTo(before.lat, 8);
        expect(now.lon).toBeCloseTo(before.lon, 8);
        expect(after.scale).toBeCloseTo(view.scale * 1.5, 8);
    });

    it('zooms out to fit rather than past it', () => {
        const out = zoomView(fitView(VIEWPORT), VIEWPORT, 0.1, 0, 0);
        expect(out).toEqual(fitView(VIEWPORT));
    });

    it('turns a trackpad and a mouse wheel into comparable steps', () => {
        expect(wheelZoomFactor(-100)).toBeGreaterThan(1);   // scroll up = zoom in
        expect(wheelZoomFactor(100)).toBeLessThan(1);
        expect(wheelZoomFactor(0)).toBe(1);
        // Four small trackpad deltas == one big mouse delta, which is the
        // whole point of making it exponential.
        expect(wheelZoomFactor(-25) ** 4).toBeCloseTo(wheelZoomFactor(-100), 10);
    });
});

const POIS_JSON = {
    worldId: 'earth',
    pois: [
        { id: 'a', name: 'Randtown', lat: 48.86, lon: 2.35, kind: 'settlement', mapId: 'meridian_basin', tags: ['temperate'], config: {} },
        { id: 'b', name: 'Skerry', lat: -33.87, lon: 151.21, kind: 'outpost', mapId: null, tags: [], config: {} },
        // A third POI carrying a live war, for the W5 parse/draw assertions —
        // kept separate from 'a' so the existing quiet-vs-playable assertion
        // above is untouched by W5's addition.
        { id: 'c', name: 'Skerry Reach', lat: 10, lon: 10, kind: 'settlement', mapId: 'skerry_reach', battleStatus: 'active', warRoomId: 7, tags: [], config: {} },
        { id: 'bad', name: 'Nowhere', lat: 999, lon: 0, kind: '', mapId: null, tags: [], config: {} },
        { id: 'nan', name: 'NaN', lat: null, lon: 3, kind: '', mapId: null, tags: [], config: {} },
    ],
    edges: [
        { from: 'a', to: 'b', transitWorldMs: 3600000 * 30, kind: 'sea', bidirectional: true, config: {} },
        { from: 'a', to: 'bad', transitWorldMs: 1, kind: 'road', bidirectional: true, config: {} },
        { from: 'b', to: 'a', transitWorldMs: 60000 * 90, kind: 'air', bidirectional: false, config: {} },
    ],
};

describe('parsing GET /api/world/pois', () => {
    it('keeps the good rows and drops the unplottable ones', () => {
        const g = parseWorldGraph(POIS_JSON)!;
        expect(g.worldId).toBe('earth');
        expect(g.pois.map(p => p.id)).toEqual(['a', 'b', 'c']);
        // An out-of-range POI is not merely ugly: drawn, it is a dot on Earth
        // indistinguishable from a real place.
        expect(g.pois.find(p => p.id === 'bad')).toBeUndefined();
    });

    it('drops an edge whose endpoint was dropped', () => {
        const g = parseWorldGraph(POIS_JSON)!;
        expect(g.edges).toHaveLength(2);
        expect(g.edges.every(e => e.from !== 'bad' && e.to !== 'bad')).toBe(true);
    });

    it('keeps mapId null-vs-string, because it is a branch', () => {
        const g = parseWorldGraph(POIS_JSON)!;
        expect(g.pois.find(p => p.id === 'a')!.mapId).toBe('meridian_basin');
        expect(g.pois.find(p => p.id === 'b')!.mapId).toBeNull();
        expect(parseWorldGraph({ pois: [{ id: 'x', lat: 0, lon: 0, mapId: '' }] })!.pois[0].mapId).toBeNull();
    });

    it('W5: carries battleStatus and warRoomId, defaulting to quiet/null', () => {
        const g = parseWorldGraph(POIS_JSON)!;
        expect(g.pois.find(p => p.id === 'c')!.battleStatus).toBe('active');
        expect(g.pois.find(p => p.id === 'c')!.warRoomId).toBe(7);
        expect(g.pois.find(p => p.id === 'a')!.battleStatus).toBe('quiet');
        expect(g.pois.find(p => p.id === 'a')!.warRoomId).toBeNull();
    });

    it('W5: rejects an unrecognised battleStatus rather than trusting it', () => {
        const g = parseWorldGraph({
            pois: [{ id: 'x', lat: 0, lon: 0, battleStatus: 'winning', warRoomId: 'nope' }],
        })!;
        expect(g.pois[0].battleStatus).toBe('quiet');
        expect(g.pois[0].warRoomId).toBeNull();
    });

    it('answers null for a body that is not a POI listing', () => {
        expect(parseWorldGraph(null)).toBeNull();
        expect(parseWorldGraph({ error: 'world_not_found' })).toBeNull();
        expect(parseWorldGraph('{}')).toBeNull();
    });

    it('survives an empty world', () => {
        const g = parseWorldGraph({ worldId: 'earth', pois: [], edges: [] })!;
        expect(g.pois).toEqual([]);
        expect(g.edges).toEqual([]);
    });

    it('collapses a bidirectional edge seeded as one row per direction', () => {
        const g = parseWorldGraph({
            pois: [{ id: 'a', lat: 0, lon: 0 }, { id: 'b', lat: 1, lon: 1 }],
            edges: [
                { from: 'a', to: 'b', kind: 'transit', bidirectional: true, transitWorldMs: 100 },
                { from: 'b', to: 'a', kind: 'transit', bidirectional: true, transitWorldMs: 100 },
            ],
        })!;
        expect(g.edges).toHaveLength(1);
        expect(edgesFor(g.edges, 'a')).toHaveLength(1);
        expect(edgesFor(g.edges, 'b')).toHaveLength(1);
    });
});

describe('hit test', () => {
    const pois = parseWorldGraph(POIS_JSON)!.pois;
    const view = fitView(VIEWPORT);

    it('finds the POI under the pointer and nothing in the ocean', () => {
        const s = poiToScreen(pois[0], view);
        expect(hitTestPoi(pois, view, s.x + 3, s.y - 2)!.id).toBe('a');
        expect(hitTestPoi(pois, view, s.x + 60, s.y)).toBeNull();
    });

    it('picks the nearest, not the first in database order', () => {
        // Two POIs within one marker of each other — the ordinary state of a
        // world map at fit zoom. First-hit would answer 'a' for both.
        const close: WorldPoi[] = [
            { ...pois[0], id: 'a', lat: 0, lon: 0 },
            { ...pois[0], id: 'b', lat: 0, lon: 2 },
        ];
        const sB = poiToScreen(close[1], view);
        expect(hitTestPoi(close, view, sB.x, sB.y, 40)!.id).toBe('b');
    });
});

describe('POI detail', () => {
    const g = parseWorldGraph(POIS_JSON)!;

    it('lists every edge touching a POI, including inbound one-ways', () => {
        const a = edgesFor(g.edges, 'a');
        expect(a.map(e => e.other).sort()).toEqual(['b', 'b']);
        expect(edgesFor(g.edges, 'b')).toHaveLength(2);
        expect(edgesFor(g.edges, 'nobody')).toEqual([]);
    });

    it('formats transit in WORLD time', () => {
        expect(formatWorldDuration(3600000 * 30)).toBe('1d 6h');
        expect(formatWorldDuration(3600000 * 6)).toBe('6h');
        expect(formatWorldDuration(60000 * 90)).toBe('1h 30m');
        expect(formatWorldDuration(0)).toBe('0m');
        expect(formatWorldDuration(NaN)).toBe('—');
        expect(formatWorldDuration(-1)).toBe('—');
    });

    it('writes hemispheres as letters', () => {
        expect(formatLatLon(48.86, 2.35)).toBe('48.9°N 2.4°E');
        expect(formatLatLon(-33.87, -70.67)).toBe('33.9°S 70.7°W');
    });
});

// PLAN-worldsim.md W4: the client-side clock widget's pure half.
describe('the world clock (W4)', () => {
    it('parses the clock object off a GET /api/world body', () => {
        const c = parseWorldClock({ clock: { worldMs: 90000, paused: false, ratioNum: 24, ratioDen: 1, day: 2, hour: 1, minute: 30 } }, 1000);
        expect(c).toEqual({ worldMs: 90000, paused: false, ratioNum: 24, ratioDen: 1, day: 2, hour: 1, minute: 30, fetchedAtMs: 1000 });
        expect(parseWorldClock({}, 1000)).toBeNull();
        expect(parseWorldClock(null, 1000)).toBeNull();
    });

    it('derives day/hour/minute from world-ms the same way the server does', () => {
        // Day 1 is worldMs in [0, 86400000) — a fresh world starts on day 1,
        // not day 0, matching WorldClock.h's WorldCalendarFromMs.
        expect(worldCalendarFromMs(0)).toEqual({ day: 1, hour: 0, minute: 0 });
        expect(worldCalendarFromMs(3600000 * 25 + 60000 * 31)).toEqual({ day: 2, hour: 1, minute: 31 });
    });

    it('ticks forward between polls at the served ratio, and never while paused', () => {
        const base = parseWorldClock({ clock: { worldMs: 0, paused: false, ratioNum: 24, ratioDen: 1, day: 1, hour: 0, minute: 0 } }, 0)!;
        // 1 real hour at 24× is 1 world day.
        const ticked = tickWorldClock(base, 3600000);
        expect(ticked.worldMs).toBe(24 * 3600000);
        expect(ticked.day).toBe(2);

        const paused = { ...base, paused: true };
        expect(tickWorldClock(paused, 3600000)).toBe(paused);
    });

    it('formats "Day N, HH:MM" exactly like FormatWorldCalendar', () => {
        const c = parseWorldClock({ clock: { worldMs: 0, paused: false, ratioNum: 24, ratioDen: 1, day: 12, hour: 7, minute: 5 } }, 0)!;
        expect(formatWorldClock(c)).toBe('Day 12, 07:05');
    });
});

/// A recording stand-in for CanvasRenderingContext2D. Enough to assert that
/// drawWorld reaches the calls it must — the screenshot is what proves it
/// looks right.
function recordingCtx() {
    const calls: { op: string; args: unknown[]; fill: string; stroke: string }[] = [];
    const ctx: Record<string, unknown> = {
        fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
        textAlign: 'left', textBaseline: 'middle', shadowColor: '', shadowBlur: 0,
    };
    for (const op of ['save', 'restore', 'beginPath', 'moveTo', 'lineTo', 'arc', 'fill',
        'stroke', 'fillRect', 'fillText', 'drawImage', 'setLineDash', 'closePath']) {
        ctx[op] = (...args: unknown[]) => calls.push({
            op, args,
            fill: String(ctx.fillStyle), stroke: String(ctx.strokeStyle),
        });
    }
    return { ctx: ctx as unknown as WorldCtx, calls };
}

describe('drawWorld', () => {
    const graph = parseWorldGraph(POIS_JSON)!;
    const view = fitView(VIEWPORT);

    it('draws the basemap when it has one, and a graticule when it does not', () => {
        const withMap = recordingCtx();
        drawWorld(withMap.ctx, {
            graph, view, viewport: VIEWPORT,
            basemap: { width: 1920, height: 960 } as unknown as CanvasImageSource,
        });
        const img = withMap.calls.find(c => c.op === 'drawImage')!;
        expect(img).toBeTruthy();
        // Stretched across the whole map rectangle — this is what makes the
        // image and the POIs share one transform.
        expect(img.args.slice(1)).toEqual([view.offsetX, view.offsetY, MAP_WIDTH * view.scale, MAP_HEIGHT * view.scale]);

        const noMap = recordingCtx();
        drawWorld(noMap.ctx, { graph, view, viewport: VIEWPORT, basemap: null });
        expect(noMap.calls.some(c => c.op === 'drawImage')).toBe(false);
        // 13 meridians + 7 parallels of the fallback graticule.
        const strokes = noMap.calls.filter(c => c.op === 'stroke' &&
            (c.stroke === WORLD_COLORS.graticule || c.stroke === WORLD_COLORS.graticuleMajor));
        expect(strokes).toHaveLength(20);
    });

    it('marks a playable POI differently from a world-only one', () => {
        const r = recordingCtx();
        drawWorld(r.ctx, { graph, view, viewport: VIEWPORT, basemap: null });
        // Recorded on `fill`, not `arc`: a kind with a polygon glyph (b is an
        // outpost, a triangle) never calls arc for its body.
        const fills = r.calls.filter(c => c.op === 'fill').map(c => c.fill);
        expect(fills).toContain(WORLD_COLORS.poiPlayable);   // 'a' has a map
        expect(fills).toContain(WORLD_COLORS.poi);           // 'b' does not
    });

    it('W5: draws an active-battle POI red with a ring, independent of hover/select', () => {
        const r = recordingCtx();
        drawWorld(r.ctx, { graph, view, viewport: VIEWPORT, basemap: null });
        const fills = r.calls.filter(c => c.op === 'fill').map(c => c.fill);
        expect(fills).toContain(WORLD_COLORS.poiActive);
        const strokes = r.calls.filter(c => c.op === 'stroke').map(c => c.stroke);
        expect(strokes).toContain(WORLD_COLORS.poiActiveRing);
    });

    it('labels only the selected/hovered POI at world zoom', () => {
        const plain = recordingCtx();
        drawWorld(plain.ctx, { graph, view, viewport: VIEWPORT, basemap: null });
        expect(plain.calls.filter(c => c.op === 'fillText')).toHaveLength(0);

        const picked = recordingCtx();
        drawWorld(picked.ctx, { graph, view, viewport: VIEWPORT, basemap: null, selectedId: 'a' });
        const labels = picked.calls.filter(c => c.op === 'fillText').map(c => c.args[0]);
        expect(labels).toEqual(['Randtown']);
    });

    it('dashes a one-way edge and leaves the dash off afterwards', () => {
        const r = recordingCtx();
        drawWorld(r.ctx, { graph, view, viewport: VIEWPORT, basemap: null });
        const dashes = r.calls.filter(c => c.op === 'setLineDash').map(c => JSON.stringify(c.args[0]));
        expect(dashes).toContain('[6,4]');   // b→a is one-way
        expect(dashes).toContain('[]');
        // A leaked dash would put dots through every subsequent stroke in the
        // lobby's canvas, not just this map's.
        expect(dashes[dashes.length - 1]).toBe('[]');
    });
});

// ─────────────────────── PLAN-worldsim.md W7 ───────────────────────────────

const OWNED_JSON = {
    worldId: 'earth',
    pois: [
        { id: 'a', name: 'Randtown', lat: 48.86, lon: 2.35, kind: 'settlement', mapId: 'meridian_basin', owner: 'third-armoured', tags: [], config: {} },
        { id: 'b', name: 'Skerry', lat: -33.87, lon: 151.21, kind: 'outpost', mapId: null, owner: null, tags: [], config: {} },
        // Held by a faction the `factions` map has never heard of — a faction
        // dissolved between the two halves of one response.
        { id: 'c', name: 'Ashfall', lat: 10, lon: 10, kind: 'ruin', mapId: null, owner: 'ghosts', tags: [], config: {} },
        // Held AND on fire: the two facts must both survive.
        { id: 'd', name: 'Skerry Reach', lat: -10, lon: -10, kind: 'settlement', mapId: 'skerry_reach', owner: 'third-armoured', battleStatus: 'active', warRoomId: 7, tags: [], config: {} },
    ],
    edges: [],
    factions: {
        'third-armoured': { name: 'Third Armoured', colour: '#5b9bd5', archetype: 'order', state: 'active' },
        'house-verendi': { name: 'House Verendi', colour: 'red; background:url(x)', archetype: 'dynasty', state: 'active' },
    },
};

describe('W7: faction ownership', () => {
    it('parses owners and the faction badge map', () => {
        const g = parseWorldGraph(OWNED_JSON)!;
        expect(g.pois.find(p => p.id === 'a')!.owner).toBe('third-armoured');
        expect(g.pois.find(p => p.id === 'b')!.owner).toBeNull();
        expect(g.factions['third-armoured'].name).toBe('Third Armoured');
        expect(g.factions['third-armoured'].colour).toBe('#5b9bd5');
    });

    it('drops a colour that is not exactly #rrggbb rather than handing it to fillStyle', () => {
        const g = parseWorldGraph(OWNED_JSON)!;
        expect(g.factions['house-verendi'].colour).toBe('');
    });

    it('answers an empty faction map for a lobby built before W7', () => {
        const g = parseWorldGraph(POIS_JSON)!;
        expect(g.factions).toEqual({});
        expect(g.pois[0].owner).toBeNull();
    });

    it('falls back to a palette colour for an owner it has no badge for', () => {
        const g = parseWorldGraph(OWNED_JSON)!;
        const byId = (id: string) => g.pois.find(p => p.id === id)!;
        expect(poiOwnerColour(byId('a'), g)).toBe('#5b9bd5');
        // Unowned is null — the caller falls back to playable/world-only.
        expect(poiOwnerColour(byId('b'), g)).toBeNull();
        // Owned by an unknown faction is still OWNED: the id is proof, and
        // the colour is derived from it — the same one on every client.
        const ghosts = poiOwnerColour(byId('c'), g)!;
        expect(SAFE_PALETTE).toContain(ghosts);
        expect(poiOwnerColour(byId('c'), parseWorldGraph(OWNED_JSON)!)).toBe(ghosts);
        // ...and distinct from the badge-less faction that failed validation.
        expect(factionColour('house-verendi', g)).not.toBe(ghosts);
        expect(SAFE_PALETTE).toContain(factionColour('house-verendi', g));
    });

    it("paints an owned POI in its owner's colour, over the playable colour", () => {
        const g = parseWorldGraph(OWNED_JSON)!;
        const r = recordingCtx();
        drawWorld(r.ctx, { graph: g, view: fitView(VIEWPORT), viewport: VIEWPORT, basemap: null });
        const fills = r.calls.filter(c => c.op === 'fill').map(c => c.fill);
        expect(fills).toContain('#5b9bd5');
        expect(fills).toContain(factionColour('ghosts', g));
        // 'a' is playable AND owned, and no other POI here is playable-and-
        // unowned, so the playable colour must be gone entirely.
        expect(fills).not.toContain(WORLD_COLORS.poiPlayable);
        // 'b' is unowned and world-only.
        expect(fills).toContain(WORLD_COLORS.poi);
    });

    it('keeps a battle red and gives the owner an outer band', () => {
        const g = parseWorldGraph(OWNED_JSON)!;
        const r = recordingCtx();
        drawWorld(r.ctx, { graph: g, view: fitView(VIEWPORT), viewport: VIEWPORT, basemap: null });
        const fills = r.calls.filter(c => c.op === 'fill').map(c => c.fill);
        expect(fills).toContain(WORLD_COLORS.poiActive);
        const strokes = r.calls.filter(c => c.op === 'stroke').map(c => c.stroke);
        expect(strokes).toContain(WORLD_COLORS.poiActiveRing);
        expect(strokes).toContain('#5b9bd5');
    });
});

// ───────────── the player stat panel (PLAN-worldsim.md W8) ─────────────

const ME_JSON = {
    worldId: 'earth',
    accountId: 7,
    authority: 50,
    canFound: false,
    membership: { factionId: 'iron-order', role: 'founder', rank: 0 },
    commanders: [
        {
            commanderId: 'vex-1', name: 'Vex', factionId: 'iron-order', poiId: 'paris',
            state: 'active', authority: 12.5, authorityStored: 14, loaned: false,
        },
        {
            commanderId: 'vex-2', name: 'Rell', factionId: 'iron-order', poiId: '',
            state: 'active', authority: 3, authorityStored: 3, loaned: true, loanedTo: 9,
        },
    ],
    capacity: { max: 40, spent: 10, available: 30, rechargedAt: 1000, nextRechargeInMs: 3_600_000, rechargeHours: 24 },
    rank: {
        factionId: 'iron-order', total: 47.5, commanderCount: 1, poiCount: 1, loanedCount: 1,
        terms: { commanders: 10, commanderAuthority: 12.5, regions: 25, money: 0 },
    },
};

describe('parsing the W8 player stats off POST /api/world/me', () => {
    it('reads the three stats and keeps them apart', () => {
        const s = parseWorldPlayerStats(ME_JSON)!;
        // World authority (W7's founding-gate number) is NOT a commander's
        // Authority — Capture 23 makes them separate stats and the panel must
        // not merge them.
        expect(s.worldAuthority).toBe(50);
        expect(s.commanders.map(c => c.authority)).toEqual([12.5, 3]);
        expect(s.capacity!.available).toBe(30);
        expect(s.rank!.total).toBe(47.5);
        expect(s.rank!.factionId).toBe('iron-order');
    });

    it('carries the loan flag and the decayed/stored pair', () => {
        const s = parseWorldPlayerStats(ME_JSON)!;
        expect(s.commanders[1].loaned).toBe(true);
        // C27's exclusion is the server's to apply; the client only has to be
        // able to SAY why the rank does not count it.
        expect(s.rank!.loanedCount).toBe(1);
        expect(s.commanders[0].authorityStored).toBe(14);
    });

    it('is null on a body that has no stats at all', () => {
        // A lobby built before W8 answers /api/world/me without any of it. The
        // panel must read that as absent, not as a player with zero of
        // everything.
        expect(parseWorldPlayerStats({ worldId: 'earth', authority: 50 })).toBeNull();
        expect(parseWorldPlayerStats(null)).toBeNull();
    });

    it('drops unusable numbers rather than rendering NaN', () => {
        const s = parseWorldPlayerStats({
            authority: null,
            commanders: [{ commanderId: 'a', authority: 'lots' }, { name: 'no id' }],
            capacity: { max: 'wide', available: 5 },
            rank: { total: undefined, terms: { good: 3, bad: 'no' } },
        })!;
        expect(s.worldAuthority).toBe(0);
        expect(s.commanders.map(c => c.id)).toEqual(['a']);
        expect(s.commanders[0].authority).toBe(0);
        expect(s.capacity!.max).toBe(0);
        expect(s.capacity!.rechargeHours).toBe(24);   // a stat with a real default
        expect(s.rank!.total).toBe(0);
        expect(s.rank!.terms).toEqual({ good: 3 });
    });
});

describe('stat formatting', () => {
    it('formats a REAL wait, not a world-clock one', () => {
        // The capacity recharge is real hours (Capture 12 protects the
        // player's day), so formatting it with the world-duration formatter
        // would promise "4 days" for a four-hour wait.
        expect(formatRealDuration(4 * 3_600_000)).toBe('4h');
        expect(formatRealDuration(90 * 60_000)).toBe('1h 30m');
        expect(formatRealDuration(0)).toBe('now');
        expect(formatRealDuration(-5)).toBe('now');
        expect(formatWorldDuration(4 * 3_600_000)).toBe('4h');
    });

    it('shows a decimal where it matters and none where it does not', () => {
        expect(formatStat(12.44)).toBe('12.4');
        expect(formatStat(1284.3)).toBe('1284');
        expect(formatStat(0)).toBe('0');
        expect(formatStat(NaN)).toBe('—');
    });
});

// ─────────────── review sweep 2026-09-10: the strategic-map helpers ───────────────

describe('camera travel', () => {
    it('centres a map point at a scale, clamped', () => {
        const v = viewCentredOn({ x: 1, y: 0.5 }, 960, VIEWPORT);
        // Map (1, 0.5) is the origin; at 2× fit it lands on the canvas centre.
        expect(screenToMap(480, 240, v)).toEqual({ x: 1, y: 0.5 });
        // A point at the map's corner cannot be centred at fit — the clamp wins.
        expect(viewCentredOn({ x: 0, y: 0 }, fitScale(VIEWPORT), VIEWPORT)).toEqual(fitView(VIEWPORT));
    });

    it('focus puts the POI at the centre at 4× fit', () => {
        const v = focusView({ lat: 48.86, lon: 2.35 }, VIEWPORT);
        expect(v.scale).toBe(fitScale(VIEWPORT) * 4);
        const back = screenToLatLon(480, 240, v);
        expect(back.lat).toBeCloseTo(48.86, 8);
        expect(back.lon).toBeCloseTo(2.35, 8);
        expect(focusView({ lat: 0, lon: 0 }, VIEWPORT, 1e9).scale).toBe(fitScale(VIEWPORT) * MAX_ZOOM_FACTOR);
    });

    it('interpolates from a to exactly b, keeping the centre on the line between them', () => {
        const a = fitView(VIEWPORT);
        const b = focusView({ lat: -33.87, lon: 151.21 }, VIEWPORT);
        expect(interpolateView(a, b, 0, VIEWPORT)).toEqual(a);
        expect(interpolateView(a, b, 1, VIEWPORT)).toEqual(b);
        const mid = interpolateView(a, b, 0.5, VIEWPORT);
        expect(mid.scale).toBeCloseTo(Math.sqrt(a.scale * b.scale), 8);   // geometric, not linear
        const ca = screenToMap(480, 240, a), cb = screenToMap(480, 240, b), cm = screenToMap(480, 240, mid);
        // The centre is on the segment ca→cb (the clamp does not move it
        // here: the midpoint scale is 2× fit, and Sydney's neighbourhood is
        // well inside the map at that zoom).
        expect(cm.x).toBeCloseTo((ca.x + cb.x) / 2, 6);
        expect(cm.y).toBeCloseTo((ca.y + cb.y) / 2, 6);
    });

    it('eases symmetrically', () => {
        expect(easeInOut(0)).toBe(0);
        expect(easeInOut(1)).toBe(1);
        expect(easeInOut(0.5)).toBe(0.5);
        expect(easeInOut(0.25) + easeInOut(0.75)).toBeCloseTo(1, 10);
        expect(easeInOut(-3)).toBe(0);
        expect(easeInOut(7)).toBe(1);
    });
});

describe('edges across the antimeridian', () => {
    it('draws a short edge as one segment', () => {
        const a = mapFromLatLon(48.86, 2.35), b = mapFromLatLon(30.04, 31.24);
        expect(edgeSegments(a, b)).toEqual([[a, b]]);
    });

    it('splits Honolulu→Tokyo at the dateline rather than routing through Africa', () => {
        const hon = mapFromLatLon(21.31, -157.86), tok = mapFromLatLon(35.68, 139.69);
        const segs = edgeSegments(hon, tok);
        expect(segs).toHaveLength(2);
        // One piece leaves the west edge from Honolulu, the other enters from
        // the east edge to Tokyo, at the SAME latitude.
        const [[p0, p1], [q0, q1]] = segs;
        expect(p0).toEqual(hon);
        expect(p1.x).toBe(0);
        expect(q0.x).toBe(MAP_WIDTH);
        expect(q1).toEqual(tok);
        expect(p1.y).toBeCloseTo(q0.y, 10);
        // The crossing latitude is between the two endpoints' latitudes.
        expect(p1.y).toBeGreaterThan(Math.min(hon.y, tok.y));
        expect(p1.y).toBeLessThan(Math.max(hon.y, tok.y));
        // Direction does not matter.
        expect(edgeSegments(tok, hon)).toEqual(segs);
    });

    it('splits exactly at half the world only when the wrap is strictly shorter', () => {
        const a = { x: 0.2, y: 0.5 }, b = { x: 1.2, y: 0.5 };   // exactly half
        expect(edgeSegments(a, b)).toHaveLength(1);
        expect(edgeSegments(a, { x: 1.21, y: 0.5 })).toHaveLength(2);
    });
});

describe('edge weight cue', () => {
    it('makes the fastest link boldest and the slowest faintest, on a log scale', () => {
        const fast = edgeWeightCue(1_000, 1_000, 1_000_000);
        const slow = edgeWeightCue(1_000_000, 1_000, 1_000_000);
        const mid = edgeWeightCue(31_623, 1_000, 1_000_000);   // geometric middle
        expect(fast.width).toBeGreaterThan(mid.width);
        expect(mid.width).toBeGreaterThan(slow.width);
        expect(fast.alpha).toBeGreaterThan(slow.alpha);
        expect(mid.width).toBeCloseTo((fast.width + slow.width) / 2, 2);
    });

    it('draws one weight when there is no range to cue', () => {
        expect(edgeWeightCue(5, 5, 5)).toEqual({ width: 1.5, alpha: 0.5 });
        expect(edgeWeightCue(0, 1, 2)).toEqual({ width: 1.5, alpha: 0.5 });
        expect(edgeWeightCue(NaN, 1, 2)).toEqual({ width: 1.5, alpha: 0.5 });
    });

    it('indexes a graph once and reads the transit range off it', () => {
        const g = parseWorldGraph(POIS_JSON)!;
        const idx = graphIndex(g);
        expect(graphIndex(g)).toBe(idx);                     // cached per graph object
        expect(idx.byId.get('a')!.name).toBe('Randtown');
        expect(idx.edgeMinMs).toBe(60000 * 90);
        expect(idx.edgeMaxMs).toBe(3600000 * 30);
        expect(graphIndex(parseWorldGraph({ pois: [], edges: [] })!).edgeMaxMs).toBe(0);
    });
});

describe('labels', () => {
    it('show for every POI only past twice the fit zoom, on any canvas size', () => {
        for (const vp of [VIEWPORT, TALL, { width: 3840, height: 2160 }, { width: 320, height: 200 }]) {
            const fit = fitView(vp);
            expect(labelsVisible(fit, vp)).toBe(false);
            expect(labelsVisible({ ...fit, scale: fit.scale * LABEL_ZOOM_FACTOR }, vp)).toBe(true);
            expect(labelsVisible({ ...fit, scale: fit.scale * LABEL_ZOOM_FACTOR * 0.99 }, vp)).toBe(false);
        }
    });

    it('drop the lower-priority label of an overlapping pair', () => {
        const kept = placeLabels([
            { x: 0, y: 0, w: 50, h: 14, priority: 10 },
            { x: 20, y: 5, w: 50, h: 14, priority: 90 },   // overlaps the first, wins
            { x: 200, y: 0, w: 50, h: 14, priority: 1 },   // clear of both
        ]);
        expect(kept.sort()).toEqual([1, 2]);
        expect(placeLabels([])).toEqual([]);
    });

    it('label every POI at 2× fit and none at fit, and never two on top of each other', () => {
        const g = parseWorldGraph(POIS_JSON)!;
        const zoomed = { ...fitView(VIEWPORT), scale: fitScale(VIEWPORT) * 2 };
        const r = recordingCtx();
        drawWorld(r.ctx, { graph: g, view: clampView(zoomed, VIEWPORT), viewport: VIEWPORT, basemap: null });
        const labels = r.calls.filter(c => c.op === 'fillText').map(c => c.args[0]);
        expect(labels.sort()).toEqual(['Randtown', 'Skerry', 'Skerry Reach']);

        // Two POIs on the same pixel: only one label survives, the higher
        // priority one (the live battle).
        const stacked = parseWorldGraph({ pois: [
            { id: 'x', name: 'Under', lat: 10, lon: 10, mapId: 'm' },
            { id: 'y', name: 'Over', lat: 10, lon: 10, mapId: 'm', battleStatus: 'active', warRoomId: 1 },
        ] })!;
        const s = recordingCtx();
        drawWorld(s.ctx, { graph: stacked, view: clampView(zoomed, VIEWPORT), viewport: VIEWPORT, basemap: null });
        expect(s.calls.filter(c => c.op === 'fillText').map(c => c.args[0])).toEqual(['Over']);
    });
});

describe('pulses', () => {
    it('phase runs 0→1 over a period and wraps', () => {
        expect(pulsePhase(0, 1000)).toBe(0);
        expect(pulsePhase(250, 1000)).toBe(0.25);
        expect(pulsePhase(1250, 1000)).toBe(0.25);
        expect(pulsePhase(-250, 1000)).toBe(0.75);
        expect(pulsePhase(5, 0)).toBe(0);
        expect(pulsePhase(NaN, 1000)).toBe(0);
    });

    it('draw an extra fading ring only when given a clock', () => {
        const g = parseWorldGraph(POIS_JSON)!;
        const view = fitView(VIEWPORT);
        const still = recordingCtx();
        drawWorld(still.ctx, { graph: g, view, viewport: VIEWPORT, basemap: null });
        const moving = recordingCtx();
        drawWorld(moving.ctx, { graph: g, view, viewport: VIEWPORT, basemap: null, timeMs: PULSE_PERIOD_MS.active / 4 });
        const rings = (r: ReturnType<typeof recordingCtx>) => r.calls.filter(c => c.op === 'arc').length;
        expect(rings(moving)).toBe(rings(still) + 1);   // one active POI → one pulse ring
        const pulse = moving.calls.filter(c => c.op === 'stroke').map(c => c.stroke)
            .find(s => s.startsWith('rgba(255, 92, 92, 0.6'));
        expect(pulse).toBeTruthy();   // (1 − 0.25) × 0.8
        // And not when the layer is off.
        const off = recordingCtx();
        drawWorld(off.ctx, { graph: g, view, viewport: VIEWPORT, basemap: null, timeMs: 300, layers: { pulses: false } });
        expect(rings(off)).toBe(rings(still));
    });
});

describe('layers', () => {
    it('default on, except the graticule overlay and safe colours', () => {
        expect(resolveLayers()).toEqual(DEFAULT_LAYERS);
        expect(DEFAULT_LAYERS.graticule).toBe(false);
        expect(DEFAULT_LAYERS.safeColours).toBe(false);
        expect(resolveLayers({ edges: false }).edges).toBe(false);
        expect(resolveLayers({ edges: false }).markers).toBe(true);
    });

    it('turning a layer off removes its drawing and nothing else', () => {
        const g = parseWorldGraph(OWNED_JSON)!;
        const view = fitView(VIEWPORT);
        const full = recordingCtx();
        drawWorld(full.ctx, { graph: g, view, viewport: VIEWPORT, basemap: null });
        const noMarkers = recordingCtx();
        drawWorld(noMarkers.ctx, { graph: g, view, viewport: VIEWPORT, basemap: null, layers: { markers: false } });
        expect(noMarkers.calls.filter(c => c.op === 'fillText')).toHaveLength(0);
        expect(noMarkers.calls.filter(c => c.op === 'fill' && c.fill === '#5b9bd5')).toHaveLength(0);
        // Territory halos are translucent owner colour and survive.
        expect(noMarkers.calls.some(c => c.op === 'fill' && c.fill === 'rgba(91, 155, 213, 0.16)')).toBe(true);
        const noTerritory = recordingCtx();
        drawWorld(noTerritory.ctx, { graph: g, view, viewport: VIEWPORT, basemap: null, layers: { territory: false } });
        expect(noTerritory.calls.some(c => c.op === 'fill' && c.fill === 'rgba(91, 155, 213, 0.16)')).toBe(false);
        expect(noTerritory.calls.some(c => c.op === 'fill' && c.fill === '#5b9bd5')).toBe(true);
    });

    it('graticule over the basemap only when asked', () => {
        const g = parseWorldGraph(POIS_JSON)!;
        const img = { width: 2, height: 1 } as unknown as CanvasImageSource;
        const plain = recordingCtx();
        drawWorld(plain.ctx, { graph: g, view: fitView(VIEWPORT), viewport: VIEWPORT, basemap: img });
        expect(plain.calls.filter(c => c.op === 'stroke' && c.stroke === WORLD_COLORS.graticule)).toHaveLength(0);
        const over = recordingCtx();
        drawWorld(over.ctx, { graph: g, view: fitView(VIEWPORT), viewport: VIEWPORT, basemap: img, layers: { graticule: true } });
        expect(over.calls.filter(c => c.op === 'stroke' && c.stroke === WORLD_COLORS.graticule).length).toBeGreaterThan(0);
        // basemap:false hides the image and falls back to the graticule.
        const hidden = recordingCtx();
        drawWorld(hidden.ctx, { graph: g, view: fitView(VIEWPORT), viewport: VIEWPORT, basemap: img, layers: { basemap: false } });
        expect(hidden.calls.some(c => c.op === 'drawImage')).toBe(false);
        expect(hidden.calls.filter(c => c.op === 'stroke' && c.stroke === WORLD_COLORS.graticule).length).toBeGreaterThan(0);
    });

    it('safe colours replace every badge with the palette, distinctly', () => {
        const g = parseWorldGraph(OWNED_JSON)!;
        const safe = factionColours(g, true);
        expect(SAFE_PALETTE).toContain(safe['third-armoured']);
        expect(new Set(Object.values(safe)).size).toBe(Object.keys(safe).length);
        expect(factionColour('third-armoured', g, true)).toBe(safe['third-armoured']);
        expect(factionColour('third-armoured', g, false)).toBe('#5b9bd5');
        // Deterministic: the same ids give the same colours on another machine.
        expect(assignFactionColours(['b', 'a'])).toEqual(assignFactionColours(['a', 'b']));
        const r = recordingCtx();
        drawWorld(r.ctx, { graph: g, view: fitView(VIEWPORT), viewport: VIEWPORT, basemap: null, layers: { safeColours: true } });
        const fills = r.calls.filter(c => c.op === 'fill').map(c => c.fill);
        expect(fills).not.toContain('#5b9bd5');
        expect(fills).toContain(safe['third-armoured']);
    });

    it('halo radius grows with the root of the zoom and is clamped', () => {
        const fit = fitView(VIEWPORT);
        expect(haloRadius(fit, VIEWPORT)).toBe(14);
        expect(haloRadius({ ...fit, scale: fit.scale * 4 }, VIEWPORT)).toBe(28);
        expect(haloRadius({ ...fit, scale: fit.scale * 1e6 }, VIEWPORT)).toBe(60);
        expect(markerRadius(true, true)).toBeGreaterThan(markerRadius(false, true));
        expect(markerRadius(false, true)).toBeGreaterThan(markerRadius(false, false));
    });
});

describe('claims and the viewer', () => {
    const CLAIMS_JSON = {
        worldId: 'earth',
        rules: { claimPoiCost: 25 },
        claims: [
            { claimId: 3, poi: 'a', faction: 'house-verendi', state: 'open', filedAtWorldMs: 5000 },
            { claimId: 1, poi: 'a', faction: 'ghosts', state: 'open', filedAtWorldMs: 9000 },
            { claimId: 2, poi: 'b', faction: 'third-armoured', state: 'won', filedAtWorldMs: 1 },
            { claimId: 'x', poi: 'b', faction: 'third-armoured', state: 'open' },
            { claimId: 4, poi: '', faction: 'third-armoured', state: 'open' },
            null,
        ],
    };

    it('parses only the open, well-formed claims', () => {
        const claims = parseWorldClaims(CLAIMS_JSON);
        expect(claims.map(c => c.claimId)).toEqual([3, 1]);
        expect(claims[0]).toEqual({ claimId: 3, poiId: 'a', factionId: 'house-verendi', state: 'open', filedAtWorldMs: 5000 });
        expect(parseWorldClaims(null)).toEqual([]);
        expect(parseWorldClaims({ claims: 'no' })).toEqual([]);
    });

    it('plants one pennant per claimed POI, in the earliest claimant\'s colour', () => {
        const g = parseWorldGraph(OWNED_JSON)!;
        const claims = parseWorldClaims(CLAIMS_JSON);
        const r = recordingCtx();
        drawWorld(r.ctx, { graph: g, view: fitView(VIEWPORT), viewport: VIEWPORT, basemap: null, claims });
        // house-verendi (filed at 5000) beats ghosts (9000) on POI 'a', so
        // its colour is filled once (the pennant) and ghosts' only for its
        // own holding 'c'.
        const verendi = factionColour('house-verendi', g);
        const ghosts = factionColour('ghosts', g);
        expect(r.calls.filter(c => c.op === 'fill' && c.fill === verendi)).toHaveLength(1);
        expect(r.calls.filter(c => c.op === 'fill' && c.fill === ghosts)).toHaveLength(1);
        const off = recordingCtx();
        drawWorld(off.ctx, { graph: g, view: fitView(VIEWPORT), viewport: VIEWPORT, basemap: null, claims, layers: { claims: false } });
        expect(off.calls.some(c => c.op === 'fill' && c.fill === verendi)).toBe(false);
    });

    it('marks the viewer\'s holdings and commanders, and not a spectator\'s', () => {
        const g = parseWorldGraph(OWNED_JSON)!;
        const viewer = { factionId: 'third-armoured', commanderPoiIds: ['b'] };
        const r = recordingCtx();
        drawWorld(r.ctx, { graph: g, view: fitView(VIEWPORT), viewport: VIEWPORT, basemap: null, viewer });
        const whiteFills = r.calls.filter(c => c.op === 'fill' && c.fill === WORLD_COLORS.viewer);
        // 'a' is held by the viewer (inner dot); 'd' is held but ACTIVE (no
        // dot — the red fill is the fact); 'b' has the commander star.
        expect(whiteFills).toHaveLength(2);
        const none = recordingCtx();
        drawWorld(none.ctx, { graph: g, view: fitView(VIEWPORT), viewport: VIEWPORT, basemap: null, viewer: null });
        expect(none.calls.filter(c => c.op === 'fill' && c.fill === WORLD_COLORS.viewer)).toHaveLength(0);
        const off = recordingCtx();
        drawWorld(off.ctx, { graph: g, view: fitView(VIEWPORT), viewport: VIEWPORT, basemap: null, viewer, layers: { viewer: false } });
        expect(off.calls.filter(c => c.op === 'fill' && c.fill === WORLD_COLORS.viewer)).toHaveLength(0);
    });
});

describe('the hover chip summary', () => {
    const g: WorldGraph = parseWorldGraph({
        worldId: 'earth',
        pois: [
            { id: 'a', name: 'Randtown', lat: 48.86, lon: 2.35, kind: 'settlement', mapId: 'meridian_basin', owner: 'third-armoured', tags: [], config: {} },
            { id: 'b', name: 'Skerry', lat: -33.87, lon: 151.21, kind: 'outpost', mapId: null, tags: [], config: {} },
            { id: 'c', name: 'Dune', lat: 30, lon: 31, kind: 'depot', mapId: 'dune', battleStatus: 'staging', warRoomId: 12,
              staging: [
                  { stagingId: 1, attackerFaction: 'ghosts', transports: 2, squads: 4, remainingWorldMs: 3600000 * 30, endsAtWorldMs: 1 },
                  { stagingId: 2, attackerFaction: 'third-armoured', transports: 1, squads: 1, remainingWorldMs: 3600000 * 6, endsAtWorldMs: 1 },
              ] },
            { id: 'd', name: 'Fire', lat: -10, lon: -10, kind: 'settlement', mapId: 'fire', owner: 'third-armoured', battleStatus: 'active', warRoomId: 7, tags: [], config: {} },
        ],
        edges: [
            { from: 'a', to: 'b', transitWorldMs: 1, kind: '', bidirectional: true, config: {} },
            { from: 'c', to: 'a', transitWorldMs: 1, kind: '', bidirectional: false, config: {} },
        ],
        factions: { 'third-armoured': { name: 'Third Armoured', colour: '#5b9bd5', archetype: 'order', state: 'active' } },
    })!;

    it('names the owner, the state and the one number that matters', () => {
        const a = poiSummary(g.pois[0], g);
        expect(a.owner).toEqual({ id: 'third-armoured', name: 'Third Armoured', colour: '#5b9bd5' });
        expect(a.stateLabel).toBe('Quiet');
        expect(a.stat).toEqual({ label: 'Transit links', value: '2' });
        expect(a.kind).toBe('battleground');

        const b = poiSummary(g.pois[1], g);
        expect(b.owner).toBeNull();
        expect(b.stateLabel).toBe('World only');
        expect(b.kind).toBe('outpost');

        const c = poiSummary(g.pois[2], g);
        expect(c.stateLabel).toBe('War staging');
        expect(c.stat).toEqual({ label: 'Lands in', value: '6h' });   // the SOONEST window

        const d = poiSummary(g.pois[3], g);
        expect(d.stateLabel).toBe('Battle in progress');
        expect(d.stat).toEqual({ label: 'Battle room', value: '#7' });
    });

    it('knows what is yours', () => {
        const viewer = { factionId: 'third-armoured', commanderPoiIds: ['b'] };
        expect(poiSummary(g.pois[0], g, viewer).mine).toBe(true);
        expect(poiSummary(g.pois[0], g, viewer).hasCommander).toBe(false);
        expect(poiSummary(g.pois[1], g, viewer).hasCommander).toBe(true);
        expect(poiSummary(g.pois[1], g, viewer).mine).toBe(false);
        expect(poiSummary(g.pois[0], g, null).mine).toBe(false);
        const claims = [{ claimId: 1, poiId: 'a', factionId: 'ghosts', state: 'open', filedAtWorldMs: 0 }];
        expect(poiSummary(g.pois[0], g, viewer, claims).claims).toBe(1);
        expect(poiSummary(g.pois[1], g, viewer, claims).claims).toBe(0);
    });
});
